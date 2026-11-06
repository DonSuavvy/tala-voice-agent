/**
 * Times and money as the model will say them: in the company's own time zone,
 * locale and currency.
 *
 * Tool results carry formatted local times rather than ISO instants because
 * the model reads them aloud, and converting UTC to Manila time in its head is
 * a calculation it can get wrong. Money is the same: integer minor units in,
 * the company's own currency text out. The code converts; the model only
 * speaks.
 */
import { formatMoney } from "../agent/sop";

/** U+202F (narrow no-break space) and U+00A0 (no-break space). */
const NO_BREAK_SPACES = /[\u202F\u00A0]/g;

/**
 * e.g. `Fri, Nov 6, 5:00 PM` for 2026-11-06T09:00:00Z in Asia/Manila, en-PH.
 *
 * Some ICU versions put a narrow no-break space before AM/PM. Both are turned
 * into a plain space, so the text-to-speech voice and the tests see one stable
 * string whichever ICU the runtime ships.
 */
export function formatLocalTime(date: Date, company: { timeZone: string; locale: string }): string {
  return new Intl.DateTimeFormat(company.locale, {
    timeZone: company.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .replace(NO_BREAK_SPACES, " ");
}

/**
 * e.g. `Tue, Oct 27` for 2026-10-27T05:00:00Z in Asia/Manila, en-PH: the
 * local date with no time, for things that fall on a day, such as a due date.
 */
export function formatLocalDate(date: Date, company: { timeZone: string; locale: string }): string {
  return new Intl.DateTimeFormat(company.locale, {
    timeZone: company.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * e.g. `Sat, Nov 7, 9:00 AM to 12:00 PM` for a window within one local day,
 * such as a technician's visit: the start as `formatLocalTime` says it, then
 * the end's time alone. No-break spaces become plain ones, as there.
 */
export function formatLocalWindow(
  startsAt: Date,
  endsAt: Date,
  company: { timeZone: string; locale: string },
): string {
  const end = new Intl.DateTimeFormat(company.locale, {
    timeZone: company.timeZone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(endsAt)
    .replace(NO_BREAK_SPACES, " ");
  return `${formatLocalTime(startsAt, company)} to ${end}`;
}

/**
 * An amount in the company's currency: 129900 minor units in PHP, en-PH, is
 * the peso sign followed by `1,299.00`.
 */
export function formatCompanyMoney(
  minorUnits: number,
  company: { locale: string; currency: string },
): string {
  return formatMoney(minorUnits, { code: company.currency, locale: company.locale });
}
