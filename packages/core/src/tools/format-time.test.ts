import { afterEach, describe, expect, it } from "vitest";

import { formatLocalTime, roundUpToQuarterHour } from "./format-time";

/**
 * Times reach the model as words in the company's own time zone, because the
 * model says them aloud. One stable string matters to both the text-to-speech
 * voice and the tests, whatever ICU version the runtime ships.
 */

const MANILA = { timeZone: "Asia/Manila", locale: "en-PH" };

/**
 * `format` is a getter on the prototype at runtime, though TypeScript's lib
 * types it as a method, so it is replaced and restored by descriptor.
 */
const realFormat = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");

afterEach(() => {
  if (realFormat) Object.defineProperty(Intl.DateTimeFormat.prototype, "format", realFormat);
});

describe("formatLocalTime", () => {
  it("says a UTC instant as the company's local weekday, date and time", () => {
    expect(formatLocalTime(new Date("2026-11-06T09:00:00Z"), MANILA)).toBe("Fri, Nov 6, 5:00 PM");
    expect(formatLocalTime(new Date("2026-11-06T02:30:00Z"), MANILA)).toBe("Fri, Nov 6, 10:30 AM");
  });

  it("turns the no-break spaces some ICU versions emit into plain spaces", () => {
    // Some ICU versions put U+202F before AM/PM. This runtime's may not, so
    // the formatter returns what those versions would.
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
      configurable: true,
      get: () => () => "Fri,\u00A0Nov 6, 5:00\u202FPM",
    });

    expect(formatLocalTime(new Date("2026-11-06T09:00:00Z"), MANILA)).toBe("Fri, Nov 6, 5:00 PM");
  });
});

describe("roundUpToQuarterHour", () => {
  it("rounds an instant up to the next quarter hour, never down", () => {
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:41:00Z")).toISOString()).toBe(
      "2026-11-06T12:45:00.000Z",
    );
    expect(roundUpToQuarterHour(new Date("2026-11-06T14:47:00Z")).toISOString()).toBe(
      "2026-11-06T15:00:00.000Z",
    );
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:01:00Z")).toISOString()).toBe(
      "2026-11-06T12:15:00.000Z",
    );
  });

  it("leaves an instant exactly on a quarter hour alone", () => {
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:30:00.000Z")).toISOString()).toBe(
      "2026-11-06T12:30:00.000Z",
    );
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:00:00.000Z")).toISOString()).toBe(
      "2026-11-06T12:00:00.000Z",
    );
  });

  it("rounds up even by a single millisecond or second past a quarter hour", () => {
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:45:00.001Z")).toISOString()).toBe(
      "2026-11-06T13:00:00.000Z",
    );
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:44:59.999Z")).toISOString()).toBe(
      "2026-11-06T12:45:00.000Z",
    );
    expect(roundUpToQuarterHour(new Date("2026-11-06T12:30:01Z")).toISOString()).toBe(
      "2026-11-06T12:45:00.000Z",
    );
  });

  it("carries across midnight into the next day", () => {
    expect(roundUpToQuarterHour(new Date("2026-11-06T23:50:00Z")).toISOString()).toBe(
      "2026-11-07T00:00:00.000Z",
    );
  });
});
