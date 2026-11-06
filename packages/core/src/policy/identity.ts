/**
 * The account gate and identity verification, as pure decisions.
 *
 * A caller proves who they are with an account number and the last 4 digits
 * of the mobile registered to it. Until then no account tool may run, and
 * afterwards only for that one account. The tool handlers call these
 * functions; the model only proposes.
 *
 * No clock, no I/O, no model. Every function normalizes account numbers on
 * both sides of a comparison, so a caller that forgets to normalize cannot
 * get past one.
 */
import { parseSupportPolicy } from "./support-policy";

export interface IdentityState {
  /** The one account this call may reach, once verified. Normalized. Null until then. */
  verifiedAccount: string | null;
  failedAttempts: number;
}

/** A fresh object each call, so two calls never share a state. */
export function initialIdentityState(): IdentityState {
  return { verifiedAccount: null, failedAttempts: 0 };
}

/**
 * Removes separators, and nothing else: `801-234 5678` becomes `8012345678`.
 *
 * The separators are all whitespace (JavaScript's `\s`: spaces, tabs,
 * newlines, U+00A0 and the other Unicode spaces), dots, the hyphen-minus, and
 * the Unicode dashes U+2010 to U+2015 (speech-to-text and models often write
 * an account number with en dashes). It does not validate. Anything else
 * stays, so a malformed number misses the lookup instead of being repaired
 * into someone's account.
 */
export function normalizeAccountNumber(raw: string): string {
  return raw.replace(/[\s.\-\u2010-\u2015]/g, "");
}

/**
 * How many trailing digits of the registered mobile verification asks for,
 * and the most of that number Tala ever says.
 */
export const MOBILE_LAST_DIGITS = 4;

const LAST_DIGITS = new RegExp(`^[0-9]{${MOBILE_LAST_DIGITS}}$`);

/**
 * True only when `last4`, once all whitespace is removed, is exactly 4 digits
 * and equals the last 4 digits of the registered mobile. Anything shorter is
 * refused outright: "101" is a suffix of the mobile, but it is not the secret.
 *
 * "All whitespace" is JavaScript's `\s`: tabs, newlines and the Unicode
 * spaces such as U+00A0. It is the same set `verify_identity`'s schema lets
 * between the digits, so digits the schema accepts are never miscounted here.
 */
export function mobileLast4Matches(registeredMobile: string, last4: string): boolean {
  const given = last4.replace(/\s/g, "");
  if (!LAST_DIGITS.test(given)) return false;
  return registeredMobile.replace(/[^0-9]/g, "").slice(-MOBILE_LAST_DIGITS) === given;
}

export type VerificationGate =
  | { allowed: true; alreadyVerified: boolean }
  | { allowed: false; reason: "other_account_verified" | "locked" };

/**
 * May this call attempt to verify `requestedAccount` now?
 *
 * The policy is parsed first, on every path, so a malformed one throws
 * instead of failing open. Then, in order: the account already verified is
 * allowed without consuming an attempt; any other account is refused once one
 * is verified (one account per call); and the lock applies only after that.
 */
export function checkVerificationAttempt(
  state: IdentityState,
  requestedAccount: string,
  policy: unknown,
): VerificationGate {
  const { maxFailedAttempts } = parseSupportPolicy(policy).identity;
  const requested = normalizeAccountNumber(requestedAccount);
  // `verifiedAccount` is three-state for this comparison: null, this account,
  // or another. Checked for null first so "not this one" never means "none"
  // (OpsPilot FAILURES #5, #13).
  if (state.verifiedAccount !== null) {
    if (normalizeAccountNumber(state.verifiedAccount) === requested) {
      return { allowed: true, alreadyVerified: true };
    }
    return { allowed: false, reason: "other_account_verified" };
  }
  if (state.failedAttempts >= maxFailedAttempts) {
    return { allowed: false, reason: "locked" };
  }
  return { allowed: true, alreadyVerified: false };
}

/** The state after one verification attempt. Returns a new object; never mutates `state`. */
export function recordVerification(
  state: IdentityState,
  requestedAccount: string,
  matched: boolean,
): IdentityState {
  if (matched) {
    return { ...state, verifiedAccount: normalizeAccountNumber(requestedAccount) };
  }
  return { ...state, failedAttempts: state.failedAttempts + 1 };
}

/** How many failed attempts this call has left before it locks. Never negative. */
export function attemptsRemaining(state: IdentityState, policy: unknown): number {
  const { maxFailedAttempts } = parseSupportPolicy(policy).identity;
  return Math.max(0, maxFailedAttempts - state.failedAttempts);
}

export type AccountAccess =
  | { allowed: true }
  | { allowed: false; reason: "not_verified" | "other_account" };

/** The account gate: may an account tool act on `requestedAccount` in this call? */
export function checkAccountAccess(state: IdentityState, requestedAccount: string): AccountAccess {
  // Null first: see the three-state note in `checkVerificationAttempt`.
  if (state.verifiedAccount === null) {
    return { allowed: false, reason: "not_verified" };
  }
  if (
    normalizeAccountNumber(state.verifiedAccount) !== normalizeAccountNumber(requestedAccount)
  ) {
    return { allowed: false, reason: "other_account" };
  }
  return { allowed: true };
}
