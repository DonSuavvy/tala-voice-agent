import { describe, expect, it } from "vitest";

import { slotWindow } from "./slot-window";

/**
 * A technician slot is stated by the calendar: a day after the call's local
 * date, a local start hour and a length. These pin how that becomes two
 * instants, in the company's own time zone, whatever time the call starts.
 *
 * Manila is UTC+8 all year; New York changes its clocks, which is how a test
 * can tell the slot's own date's offset from the call's.
 */

const MANILA = "Asia/Manila";
const MORNING_SLOT = { daysAfterCall: 1, startHour: 9, lengthHours: 3 };

describe("slotWindow", () => {
  it("puts day 1, 9:00 for 3 hours on the morning after a 1:00 PM Manila call", () => {
    expect(slotWindow(MORNING_SLOT, new Date("2026-11-06T05:00:00Z"), MANILA)).toEqual({
      startsAt: new Date("2026-11-07T01:00:00Z"),
      endsAt: new Date("2026-11-07T04:00:00Z"),
    });
  });

  it("gives the same window whatever time of the local day the call starts", () => {
    const early = slotWindow(MORNING_SLOT, new Date("2026-11-05T22:30:00Z"), MANILA); // 6:30 AM
    const late = slotWindow(MORNING_SLOT, new Date("2026-11-06T13:45:00Z"), MANILA); // 9:45 PM

    expect(early).toEqual(late);
    expect(early.startsAt).toEqual(new Date("2026-11-07T01:00:00Z"));
  });

  describe("across the local day boundary", () => {
    it("counts from the call's local date a minute before midnight", () => {
      // 11:59 PM, Fri, Nov 6 in Manila: the next day is Sat, Nov 7.
      expect(slotWindow(MORNING_SLOT, new Date("2026-11-06T15:59:00Z"), MANILA).startsAt).toEqual(
        new Date("2026-11-07T01:00:00Z"),
      );
    });

    it("counts from the new local date a minute after midnight", () => {
      // 12:01 AM, Sat, Nov 7 in Manila, still Fri, Nov 6 in UTC: the next day is Sun, Nov 8.
      expect(slotWindow(MORNING_SLOT, new Date("2026-11-06T16:01:00Z"), MANILA).startsAt).toEqual(
        new Date("2026-11-08T01:00:00Z"),
      );
    });
  });

  it("carries the days over a month's end", () => {
    const slot = { daysAfterCall: 2, startHour: 13, lengthHours: 4 };

    expect(slotWindow(slot, new Date("2026-11-30T05:00:00Z"), MANILA)).toEqual({
      startsAt: new Date("2026-12-02T05:00:00Z"),
      endsAt: new Date("2026-12-02T09:00:00Z"),
    });
  });

  it("ends a window that runs to midnight at the start of the next local day", () => {
    const slot = { daysAfterCall: 1, startHour: 21, lengthHours: 3 };

    expect(slotWindow(slot, new Date("2026-11-06T05:00:00Z"), MANILA).endsAt).toEqual(
      new Date("2026-11-07T16:00:00Z"),
    );
  });

  it("uses the slot's own date's offset where the clocks change between the call and the slot", () => {
    // Noon on Sat, Oct 31, 2026 in New York is daylight time (UTC-4); the
    // clocks go back on Sun, Nov 1, so 9:00 AM on Mon, Nov 2 is UTC-5.
    const slot = { daysAfterCall: 2, startHour: 9, lengthHours: 3 };

    expect(slotWindow(slot, new Date("2026-10-31T16:00:00Z"), "America/New_York")).toEqual({
      startsAt: new Date("2026-11-02T14:00:00Z"),
      endsAt: new Date("2026-11-02T17:00:00Z"),
    });
  });
});
