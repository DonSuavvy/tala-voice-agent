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

const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * The first quarter-hour mark at or after `instant`; one already on a quarter
 * hour (to the millisecond) is returned as it is.
 *
 * It works on the UTC instant. That is right in any time zone, because every
 * real UTC offset is a whole multiple of 15 minutes, so a quarter hour in UTC
 * is a quarter hour on the local clock too.
 */
export function roundUpToQuarterHour(instant: Date): Date {
  return new Date(Math.ceil(instant.getTime() / QUARTER_HOUR_MS) * QUARTER_HOUR_MS);
}
