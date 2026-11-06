/**
 * Times as the model will say them: in the company's own time zone and locale.
 *
 * Tool results carry formatted local times rather than ISO instants because
 * the model reads them aloud, and converting UTC to Manila time in its head is
 * a calculation it can get wrong. The code converts; the model only speaks.
 */

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
