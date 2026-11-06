/**
 * The verified account's own numbers never leave the call in what Tala writes.
 *
 * A text message and a ticket's notes are written by the model, and the SOP
 * tells it to leave out the account number and the full mobile number. The
 * write tools check it here as well: the model proposes, the code disposes.
 *
 * Pure: no clock, no I/O.
 */

/** A Philippine mobile without its country code or leading 0: `9175550101`. */
const MOBILE_NATIONAL_DIGITS = 10;

/**
 * True when `text`, with every non-digit removed, holds the account number or
 * the registered mobile's last 10 digits. Removing everything else means no
 * spacing, dash or prefix gets a number through: `801-234-5601`,
 * `+639175550101`, `09175550101` and `917 555 0101` all count.
 *
 * Other numbers are left alone, so a payment reference, which billing needs to
 * post a payment, or the mobile's last four digits stay allowed.
 */
export function holdsAccountNumbers(
  text: string,
  account: { accountNumber: string; registeredMobile: string },
): boolean {
  const digits = text.replace(/\D/g, "");
  const mobile = account.registeredMobile.replace(/\D/g, "").slice(-MOBILE_NATIONAL_DIGITS);
  return digits.includes(account.accountNumber) || digits.includes(mobile);
}
