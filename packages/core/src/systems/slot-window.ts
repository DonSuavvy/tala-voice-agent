/**
 * Where a seeded technician slot falls in time.
 *
 * The seed states a slot by the calendar (a day after the call's local date, a
 * local start hour and a length), so its window reads the same whatever time
 * the call starts. This turns that into two instants in the company's time
 * zone. The local date comes from the call's start; each instant uses the
 * offset in force on the slot's own date, so a zone that changes its clocks
 * between the call and the visit still gets the hour the seed says.
 *
 * Pure: the call's start is passed in, and the clock is never read.
 */

/** A slot as the seed states it. */
export interface SlotDays {
  /** 1 is the day after the call's local date. */
  daysAfterCall: number;
  /** Local hour the window starts, 0 to 23. */
  startHour: number;
  lengthHours: number;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

/** What a wall clock in the time zone reads at this instant. */
function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant the zone's wall clock reads `hour`:00 on this date. `day` and
 * `hour` may run past the end of their month or day; `Date.UTC` carries them.
 */
function instantOfLocal(date: LocalDate, hour: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour);
  // Guess with the offset at the wall time read as UTC, then correct with the
  // offset at the guess: right on both sides of a clock change.
  const guess = wallAsUtc - offsetAt(new Date(wallAsUtc), timeZone);
  return new Date(wallAsUtc - offsetAt(new Date(guess), timeZone));
}

/** The window of a seeded slot for a call that started at `callStartedAt`, in the company's time zone. */
export function slotWindow(
  slot: SlotDays,
  callStartedAt: Date,
  timeZone: string,
): { startsAt: Date; endsAt: Date } {
  const callDate = wallClock(callStartedAt, timeZone);
  const visitDate = { ...callDate, day: callDate.day + slot.daysAfterCall };
  const startsAt = instantOfLocal(visitDate, slot.startHour, timeZone);
  const endsAt = instantOfLocal(visitDate, slot.startHour + slot.lengthHours, timeZone);
  return { startsAt, endsAt };
}
