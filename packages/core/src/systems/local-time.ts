/**
 * Wall-clock time in a time zone, for the code that states times by the
 * calendar: technician slots (`./slot-window`) and billing cycles
 * (`../policy/plan-change`).
 *
 * Pure: instants and zones are passed in, and the clock is never read.
 */
import { SECOND_MS } from "./time-units";

/** What a wall clock reads: a local date and time, to the second. Months are 1 to 12. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What a wall clock in the time zone reads at this instant. */
export function wallClock(instant: Date, timeZone: string): WallClock {
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

function wallAsUtc(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const wholeSeconds = Math.floor(instant.getTime() / SECOND_MS) * SECOND_MS;
  return wallAsUtc(wallClock(instant, timeZone)) - wholeSeconds;
}

/**
 * The instant the zone's wall clock reads `wall`. A field may run past the
 * end of its range (day 32, hour 25); `Date.UTC` carries it into the next.
 */
export function instantOfWall(wall: WallClock, timeZone: string): Date {
  const asUtc = wallAsUtc(wall);
  // Guess with the offset at the wall time read as UTC, then correct with the
  // offset at the guess: right on both sides of a clock change.
  const guess = asUtc - offsetAt(new Date(asUtc), timeZone);
  return new Date(asUtc - offsetAt(new Date(guess), timeZone));
}
