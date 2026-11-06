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
import { instantOfWall, wallClock } from "./local-time";

/** A slot as the seed states it. */
export interface SlotDays {
  /** 1 is the day after the call's local date. */
  daysAfterCall: number;
  /** Local hour the window starts, 0 to 23. */
  startHour: number;
  lengthHours: number;
}

/** The window of a seeded slot for a call that started at `callStartedAt`, in the company's time zone. */
export function slotWindow(
  slot: SlotDays,
  callStartedAt: Date,
  timeZone: string,
): { startsAt: Date; endsAt: Date } {
  const callDate = wallClock(callStartedAt, timeZone);
  const visitDate = { ...callDate, day: callDate.day + slot.daysAfterCall };
  const startsAt = instantOfWall({ ...visitDate, hour: slot.startHour, minute: 0, second: 0 }, timeZone);
  const endsAt = instantOfWall(
    { ...visitDate, hour: slot.startHour + slot.lengthHours, minute: 0, second: 0 },
    timeZone,
  );
  return { startsAt, endsAt };
}
