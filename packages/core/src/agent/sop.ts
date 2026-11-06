/**
 * The SOP compiler: the piece that makes "the SOP *is* the prompt" true.
 *
 * A company pack keeps two halves of one policy side by side: markdown that
 * the model reads, and a policy config that the tool handlers revalidate
 * against. If the markdown carried the figures as typed text, the two could
 * drift: change a limit in the config and the handler enforces the new number
 * while the prose still states the old one. The agent then refuses something
 * under a rule it was never told, which looks exactly like a working system
 * and demonstrates nothing. (OpsPilot shipped that bug once, with its refund
 * window: the seed had frozen the figures into the string.)
 *
 * So the markdown carries placeholders, and the figures are substituted here
 * from the same config, at compile time. One source of truth, no drift.
 *
 * The engine owns the mechanism. The vocabulary of placeholders, and how each
 * one renders, belongs to the company pack, passed in as `renderers`.
 */

/**
 * Every placeholder a pack's markdown may use, and how each renders.
 *
 * A closed vocabulary rather than arbitrary path lookup: an unknown token
 * fails at compile time instead of reaching the model, and a pack can check
 * its document against the list at boot. Values are pre-formatted for prose,
 * so no SOP author has to divide minor units correctly.
 */
export type SopRenderers<P> = Readonly<Record<string, (policy: P) => string>>;

/** The placeholders a set of renderers understands, in declaration order. */
export function sopPlaceholders<P>(renderers: SopRenderers<P>): readonly string[] {
  return Object.freeze(Object.keys(renderers));
}

/** A currency and the locale its amounts are written in. */
export interface Currency {
  /** ISO 4217, e.g. `PHP`. */
  code: string;
  /** BCP 47, e.g. `en-PH`. Always explicit; see `formatMoney`. */
  locale: string;
}

/**
 * Integer minor units (centavos, cents) to prose: `150000` PHP is `₱1,500.00`.
 *
 * Money is held as integer minor units everywhere, as the policy engine does,
 * and formatted only at the edge. The divisor comes from the currency itself,
 * so a currency with no minor unit (yen) is not silently divided by 100.
 *
 * The locale is required. `toLocaleString` with no locale reads the host
 * environment, which would make the compiled prompt, and therefore the
 * prompt-cache key, differ between a developer's laptop and the server.
 */
export function formatMoney(minorUnits: number, currency: Currency): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new RangeError(
      `formatMoney: amount must be a whole number of minor units, got ${String(minorUnits)}`,
    );
  }
  const format = new Intl.NumberFormat(currency.locale, {
    style: "currency",
    currency: currency.code,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minorUnits / 10 ** digits);
}

export class UnknownPlaceholderError extends Error {
  readonly placeholder: string;

  constructor(placeholder: string, known: readonly string[]) {
    super(
      `unknown SOP placeholder {{${placeholder}}} — known placeholders are ` +
        `${known.map((p) => `{{${p}}}`).join(", ")}`,
    );
    this.name = "UnknownPlaceholderError";
    this.placeholder = placeholder;
  }
}

/** `{{ anything.without.braces }}`, tolerant of surrounding whitespace. */
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/**
 * The distinct placeholder names a body uses, in first-appearance order.
 * Uses the same grammar as `compileSop`, so a boot check and the compiler can
 * never disagree about what counts as a placeholder.
 */
export function placeholdersIn(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}

export interface CompileSopInput<P> {
  bodyMarkdown: string;
  policyConfig: P;
  renderers: SopRenderers<P>;
}

/**
 * Render one SOP version into the system prompt the model receives.
 *
 * Pure and deterministic: no clock, no I/O. The policy engine takes `now` as
 * an argument for the same reason; here it matters twice over, because a
 * prompt that varies between two runs of the same SOP version also changes the
 * prompt-cache key and silently drops the hit rate to zero.
 */
export function compileSop<P>({
  bodyMarkdown,
  policyConfig,
  renderers,
}: CompileSopInput<P>): string {
  return bodyMarkdown.replace(PLACEHOLDER, (_match, name: string) => {
    // `Object.hasOwn`, not a plain lookup. `renderers["toString"]` finds
    // Object.prototype's method, which rendered "[object Undefined]" into the
    // prompt instead of failing. Tala FAILURES entry 1; the same bug class as
    // OpsPilot's FAILURES #18.
    if (!Object.hasOwn(renderers, name)) {
      throw new UnknownPlaceholderError(name, sopPlaceholders(renderers));
    }
    return renderers[name](policyConfig);
  });
}

/* The cache floor, prefix marking, and hit reporting live in `./cache`. */
