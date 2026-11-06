/**
 * The company-pack loader: checks a pack's raw parts once, at boot, and
 * hands back one frozen `CompanyPack`.
 *
 * A broken pack throws one `PackValidationError` that lists every problem it
 * found, like the tool registry does, so a pack is fixed in one pass rather
 * than one boot at a time. Each section (id, sop, company, persona, policy,
 * world) is checked independently; a failing section never hides another.
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

import { compileSop, placeholdersIn, sopPlaceholders } from "../agent/sop";
import {
  SUPPORT_POLICY_RENDERERS,
  supportPolicySchema,
  type SupportPolicy,
} from "../policy/support-policy";
import { seedWorldSchema, type SeedWorld } from "../systems/seed-world";

const nonEmpty = z.string().min(1);

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

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const companySchema = z
  .object({
    name: nonEmpty,
    timeZone: nonEmpty.refine(isValidTimeZone, {
      error: (issue) => `"${String(issue.input)}" is not an IANA time zone`,
    }),
    locale: nonEmpty.refine(isValidLocale, {
      error: (issue) => `"${String(issue.input)}" is not a BCP 47 language tag`,
    }),
  })
  .strict();
export type Company = z.infer<typeof companySchema>;

export const personaSchema = z
  .object({ agentName: nonEmpty, openingLine: nonEmpty, fallbackLine: nonEmpty })
  .strict();
export type Persona = z.infer<typeof personaSchema>;

export interface PackSource {
  id: string;
  sop: { version: string; body: string };
  company: unknown;
  persona: unknown;
  policy: unknown;
  world: unknown;
}

export interface CompanyPack {
  id: string;
  sop: { version: string; body: string };
  company: Company;
  persona: Persona;
  policy: SupportPolicy;
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
    policyConfig: pack.policy,
    renderers: SUPPORT_POLICY_RENDERERS,
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

  if (!ID_PATTERN.test(source.id)) {
    issues.push(`id: "${source.id}" is not a slug (lowercase letters, digits and single hyphens)`);
  }
  if (!VERSION_PATTERN.test(source.sop.version)) {
    issues.push(
      `sop.version: "${source.sop.version}" must start with a letter or digit and use only ` +
        `letters, digits, ".", "_" and "-"`,
    );
  }
  if (source.sop.body.trim() === "") {
    issues.push("sop.body: the SOP body is blank");
  }

  const company = checkSection("company", companySchema, source.company, issues);
  const persona = checkSection("persona", personaSchema, source.persona, issues);
  const policy = checkSection("policy", supportPolicySchema, source.policy, issues);
  const world = checkSection("world", seedWorldSchema, source.world, issues);

  const known = sopPlaceholders(SUPPORT_POLICY_RENDERERS);
  for (const name of placeholdersIn(source.sop.body)) {
    if (!known.includes(name)) {
      issues.push(
        `sop: unknown placeholder {{${name}}} (known: ${known.map((k) => `{{${k}}}`).join(", ")})`,
      );
    }
  }

  if (issues.length > 0 || !company || !persona || !policy || !world) {
    throw new PackValidationError(source.id, issues);
  }

  const pack = deepFreeze<CompanyPack>({
    id: source.id,
    sop: { version: source.sop.version, body: source.sop.body },
    company,
    persona,
    policy,
    world,
  });
  // Rehearse the compile once so a renderer bug fails at boot, not mid-call.
  compilePackSop(pack);
  return pack;
}
