/**
 * The company-pack loader: checks a pack's raw parts once, at boot, and
 * hands back one frozen `CompanyPack`.
 *
 * A broken pack throws one `PackValidationError` that lists every problem it
 * found, like the tool registry does, so a pack is fixed in one pass rather
 * than one boot at a time. Each section (id, sop, company, persona, policy,
 * plans, help, world) is checked independently; a failing section never hides
 * another. Once the plans and the world both pass, every account's plan is
 * checked against the catalog, one issue per account.
 * Issue lines read `<section>.<path>: <message>`, numeric path segments in
 * brackets (`world.accounts[1].barangayId`).
 *
 * The limit, stated plainly: "every problem at once" holds across sections,
 * and within each section only as far as zod 4 allows. In the world section,
 * cross-reference errors (a barangay that does not exist) are reported
 * alongside failed checks (a regex, a `min`, an unknown key) but NOT alongside
 * wrong types or missing fields, because zod skips the refinement when the
 * value it would read is not there. See `systems/seed-world.ts`. There is
 * deliberately no second parse to work around it: fix the shape errors and the
 * references show up on the next run.
 *
 * The pack is deep-frozen. One loaded pack is shared by every call, and no
 * call may change what the next one starts from. Callers clone what they need
 * (`structuredClone` works on frozen objects).
 *
 * The SOP is compiled once here as a rehearsal, so a renderer bug fails at
 * boot rather than on the first call.
 */
import { z } from "zod";

import {
  compileSop,
  placeholdersIn,
  sopPlaceholders,
  strayBraces,
  type SopRenderers,
} from "../agent/sop";
import {
  SUPPORT_POLICY_RENDERERS,
  supportPolicySchema,
  type SupportPolicy,
} from "../policy/support-policy";
import { seedWorldSchema, type SeedWorld } from "../systems/seed-world";

import { helpArticlesSchema, type HelpArticle } from "./help-articles";
import { PLAN_CATALOG_RENDERERS, planCatalogSchema, type Plan } from "./plan-catalog";

const nonEmpty = z.string().min(1);

/** What a pack's SOP placeholders render from: its policy and its plan catalog. */
interface SopFacts {
  policy: SupportPolicy;
  plans: readonly Plan[];
}

/** Each of `renderers`, rendering from its own part of the facts. */
function renderingFrom<P>(
  renderers: SopRenderers<P>,
  part: (facts: SopFacts) => P,
): SopRenderers<SopFacts> {
  return Object.fromEntries(
    Object.entries(renderers).map(([name, render]) => [
      name,
      (facts: SopFacts) => render(part(facts)),
    ]),
  );
}

/** Every placeholder a pack's SOP may use: the policy's figures, then the plan catalog. */
const PACK_SOP_RENDERERS: SopRenderers<SopFacts> = {
  ...renderingFrom(SUPPORT_POLICY_RENDERERS, (facts) => facts.policy),
  ...renderingFrom(PLAN_CATALOG_RENDERERS, (facts) => facts.plans),
};

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function isValidLocale(tag: string): boolean {
  try {
    Intl.getCanonicalLocales(tag);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * An ISO 4217 code the runtime knows. `Intl.NumberFormat` alone accepts any
 * three capital letters ("XYZ"), so the list of supported codes is the check.
 */
function isCurrencyCode(code: string): boolean {
  return Intl.supportedValuesOf("currency").includes(code);
}

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The loader's own checks go through zod like every other section: a hand-rolled
// RegExp.test(undefined) tests the string "undefined", and a non-string body
// would throw a TypeError instead of being listed.
const idSchema = z.string().regex(ID_PATTERN, {
  error: (issue) =>
    `"${String(issue.input)}" is not a slug (lowercase letters, digits and single hyphens)`,
});

const sopSchema = z.object({
  version: z.string().regex(VERSION_PATTERN, {
    error: (issue) =>
      `"${String(issue.input)}" must start with a letter or digit and use only ` +
      `letters, digits, ".", "_" and "-"`,
  }),
  body: z.string().refine((body) => body.trim() !== "", { error: "the SOP body is blank" }),
});

export const companySchema = z
  .object({
    name: nonEmpty,
    timeZone: nonEmpty.refine(isValidTimeZone, {
      error: (issue) => `"${String(issue.input)}" is not an IANA time zone`,
    }),
    locale: nonEmpty.refine(isValidLocale, {
      error: (issue) => `"${String(issue.input)}" is not a BCP 47 language tag`,
    }),
    /** The currency amounts are spoken in, with `formatMoney` and the locale. */
    currency: z.string().refine(isCurrencyCode, {
      error: (issue) => `"${String(issue.input)}" is not an ISO 4217 currency code`,
    }),
  })
  .strict();
export type Company = z.infer<typeof companySchema>;

/**
 * The lines Tala says that no model writes, so none can be skipped:
 *
 * - `openingLine`: the AI and recording disclosure every call opens with.
 * - `fallbackLine`: the apology when a call ends any way but `end_call`.
 * - `fillerLine`: said when the model calls a tool with nothing said, so the
 *   caller does not wait in silence while it runs.
 * - `closingLine`: said when the model ends the call with `end_call` and
 *   nothing said, so no call ends without a goodbye.
 */
export const personaSchema = z
  .object({
    openingLine: nonEmpty,
    fallbackLine: nonEmpty,
    fillerLine: nonEmpty,
    closingLine: nonEmpty,
  })
  .strict();
export type Persona = z.infer<typeof personaSchema>;

export interface PackSource {
  id: string;
  sop: { version: string; body: string };
  company: unknown;
  persona: unknown;
  policy: unknown;
  plans: unknown;
  /** The help articles: each file's name and its markdown, in knowledge base order. */
  help: unknown;
  world: unknown;
}

export interface CompanyPack {
  id: string;
  sop: { version: string; body: string };
  company: Company;
  persona: Persona;
  policy: SupportPolicy;
  plans: Plan[];
  help: HelpArticle[];
  world: SeedWorld;
}

export class PackValidationError extends Error {
  readonly issues: string[];

  constructor(packId: string, issues: string[]) {
    super(
      `Company pack "${packId}" failed validation with ${issues.length} problem(s):\n` +
        issues.map((i) => `  - ${i}`).join("\n"),
    );
    this.name = "PackValidationError";
    this.issues = issues;
  }
}

export function compilePackSop(pack: CompanyPack): string {
  return compileSop({
    bodyMarkdown: pack.sop.body,
    facts: { policy: pack.policy, plans: pack.plans },
    renderers: PACK_SOP_RENDERERS,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** `world.accounts[1].barangayId`: numeric segments in brackets. */
function formatPath(section: string, path: readonly PropertyKey[]): string {
  let out = section;
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`;
  }
  return out;
}

/** Runs one section's schema; every zod issue becomes one line. */
function checkSection<S extends z.ZodType>(
  section: string,
  schema: S,
  raw: unknown,
  issues: string[],
): z.infer<S> | undefined {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const where = formatPath(section, issue.path);
    issues.push(`${where}: ${issue.message}`);
  }
  return undefined;
}

export function loadPack(source: PackSource): CompanyPack {
  const issues: string[] = [];

  const id = checkSection("id", idSchema, source.id, issues);
  const sop = checkSection("sop", sopSchema, source.sop, issues);

  const company = checkSection("company", companySchema, source.company, issues);
  const persona = checkSection("persona", personaSchema, source.persona, issues);
  const policy = checkSection("policy", supportPolicySchema, source.policy, issues);
  const plans = checkSection("plans", planCatalogSchema, source.plans, issues);
  const help = checkSection("help", helpArticlesSchema, source.help, issues);
  const world = checkSection("world", seedWorldSchema, source.world, issues);

  if (plans && world) {
    const names = new Set(plans.map((plan) => plan.name));
    world.accounts.forEach((account, index) => {
      if (names.has(account.planName)) return;
      const where = formatPath("world", ["accounts", index, "planName"]);
      issues.push(
        `${where}: account ${account.accountNumber} names unknown plan "${account.planName}"`,
      );
    });
  }

  const known = sopPlaceholders(PACK_SOP_RENDERERS);
  for (const name of sop ? placeholdersIn(sop.body) : []) {
    if (!known.includes(name)) {
      issues.push(
        `sop: unknown placeholder {{${name}}} (known: ${known.map((k) => `{{${k}}}`).join(", ")})`,
      );
    }
  }

  if (sop && strayBraces(sop.body)) {
    issues.push(
      'sop: stray "{{" or "}}" outside a placeholder; check for a malformed placeholder',
    );
  }

  if (
    issues.length > 0 ||
    id === undefined ||
    !sop ||
    !company ||
    !persona ||
    !policy ||
    !plans ||
    !help ||
    !world
  ) {
    throw new PackValidationError(typeof source.id === "string" ? source.id : "(no id)", issues);
  }

  const pack = deepFreeze<CompanyPack>({
    id,
    sop: { version: sop.version, body: sop.body },
    company,
    persona,
    policy,
    plans,
    help,
    world,
  });
  // Rehearse the compile once so a renderer bug fails at boot, not mid-call.
  compilePackSop(pack);
  return pack;
}
