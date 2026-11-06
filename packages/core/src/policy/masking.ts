/**
 * Masking of account and phone numbers (#10, Q21).
 *
 * An account or phone number is a run of 10 or more digits once the spaces,
 * dots, hyphens and plus signs between digits are removed: a 10-digit account
 * number or a PH mobile in any common spacing. Shorter numbers pass, so the
 * last four digits Tala says, amounts such as "1,299.00" and outage references
 * such as "OUT-2026-0412" stay readable. Longer runs, such as a payment
 * reference, are masked as well.
 *
 * This is the one definition of that rule. The disposition schema uses it to
 * keep numbers out of a summary, and the storage and logging boundaries use
 * `maskNumbers` and `maskDeep`. Everything stays unmasked in memory: the loop,
 * the tools and the scorer need the real values.
 */

/**
 * A run of digits. Between two digits may stand up to 3 separators: any
 * whitespace, and the characters . , + - / ( ) and the en and em dashes (U+2013,
 * U+2014). That covers "801, 234, 5602" (Tala reads digits in groups), "(0917) 555 0101",
 * dashes of every length, slashes and line breaks. The run may start with a
 * bracket or a plus. The dashes are escapes, never literal characters.
 */
const DIGIT_RUN = /[(+]{0,2}\d(?:[\s.,+\-\u2013\u2014/()]{1,3}\d|\d)*/g;

/** Fewest digits that make an account or phone number. */
export const MASK_MIN_DIGITS = 10;
/** Digits kept readable at the end of a masked number. */
export const MASK_KEPT_DIGITS = 4;

function digitsOf(run: string): string {
  return run.replace(/\D/g, "");
}

/** True when the text holds an account or phone number. */
export function hasAccountOrPhoneNumber(text: string): boolean {
  return (text.match(DIGIT_RUN) ?? []).some((run) => digitsOf(run).length >= MASK_MIN_DIGITS);
}

/**
 * Replaces each account or phone number with asterisks for all its digits but
 * the last 4, dropping its separators and plus sign.
 */
export function maskNumbers(text: string): string {
  return text.replace(DIGIT_RUN, (run) => {
    const digits = digitsOf(run);
    if (digits.length < MASK_MIN_DIGITS) return run;
    return "*".repeat(digits.length - MASK_KEPT_DIGITS) + digits.slice(-MASK_KEPT_DIGITS);
  });
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * `maskNumbers` on every string in plain objects and arrays, as a new value.
 * Anything else (numbers, booleans, null, dates) is returned as it is.
 */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskNumbers(value) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => maskDeep(v)) as T;
  if (value !== null && typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
    return out as T;
  }
  return value;
}
