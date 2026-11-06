import { afterEach, describe, expect, it } from "vitest";

import { formatLocalTime } from "./format-time";

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
