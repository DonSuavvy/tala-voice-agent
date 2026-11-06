import { describe, expect, it } from "vitest";

import { TEST_COMPANY } from "../testing/fixtures";

import { pricePlanChange } from "./plan-change";

/**
 * Pricing a plan change, as a pure decision: the clock is passed in.
 *
 * The billing cycle runs from the account's latest bill to one calendar month
 * later in the company's time zone. An upgrade starts now and adds the
 * difference in monthly price for the rest of the cycle to the next bill; a
 * downgrade starts with the next cycle and adds nothing. Every expected
 * amount below is worked out by hand in its comment, never recomputed here.
 */

const { timeZone } = TEST_COMPANY;

const K100 = { id: "kidlat-100", monthlyPriceMinor: 129_900 };
const K300 = { id: "kidlat-300", monthlyPriceMinor: 169_900 };
const K500 = { id: "kidlat-500", monthlyPriceMinor: 209_900 };
const K1000 = { id: "kidlat-1000", monthlyPriceMinor: 299_900 };

describe("pricePlanChange — an upgrade", () => {
  /**
   * The bill was issued Mon, Oct 12, 1:00 PM Manila, so the cycle runs to
   * Thu, Nov 12, 1:00 PM: 31 days, across the end of October. At 1:00 PM on
   * Nov 6, 6 days are left. 300 to 500 is 400 pesos a month more:
   * 40,000 x 6 / 31 = 7,741.94 centavos, so 7,742.
   */
  it("starts now and adds the difference for the rest of the cycle, rounded to the centavo", () => {
    const now = new Date("2026-11-06T05:00:00Z");

    expect(
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt: new Date("2026-10-12T05:00:00Z"),
        now,
        timeZone,
      }),
    ).toEqual({ allowed: true, kind: "upgrade", proratedAmountMinor: 7_742, effectiveAt: now });
  });

  /**
   * A 30-day cycle (Nov 12 to Dec 12, 1:00 PM Manila) is 43,200 minutes.
   * 500 to 1000 is 900 pesos a month more, 90,000 centavos.
   * Six minutes left: 90,000 x 6 / 43,200 = 12.5, which rounds up to 13.
   * Five minutes left: 90,000 x 5 / 43,200 = 10.42, which rounds down to 10.
   */
  it("rounds half a centavo up, and less than half down", () => {
    const latestBillIssuedAt = new Date("2026-11-12T05:00:00Z");
    const price = (now: string) =>
      pricePlanChange({ current: K500, next: K1000, latestBillIssuedAt, now: new Date(now), timeZone });

    expect(price("2026-12-12T04:54:00Z")).toMatchObject({ proratedAmountMinor: 13 });
    expect(price("2026-12-12T04:55:00Z")).toMatchObject({ proratedAmountMinor: 10 });
  });

  /**
   * Issued Sat, Jan 31, 10:00 AM Manila: February has no 31st, so the cycle
   * ends on its last day, Sat, Feb 28, 10:00 AM: 28 days. At 10:00 AM on
   * Feb 14, 14 days are left: 40,000 x 14 / 28 = 20,000.
   */
  it("ends a cycle that starts on the 31st on the last day of a shorter month", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt: new Date("2026-01-31T02:00:00Z"),
        now: new Date("2026-02-14T02:00:00Z"),
        timeZone,
      }),
    ).toMatchObject({ allowed: true, kind: "upgrade", proratedAmountMinor: 20_000 });
  });

  /**
   * Issued Tue, Mar 31, 5:00 AM Manila, which is still Mar 30 in UTC. In
   * Manila the cycle ends Thu, Apr 30, 5:00 AM (Apr 29, 21:00 UTC): 30 days.
   * At Apr 16, 5:00 AM Manila, 14 days are left: 40,000 x 14 / 30 =
   * 18,666.67, so 18,667. Read in UTC, the cycle would run 31 days to
   * Apr 30, 21:00 UTC and give 19,355.
   */
  it("counts the month in the company's time zone, not in UTC", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt: new Date("2026-03-30T21:00:00Z"),
        now: new Date("2026-04-15T21:00:00Z"),
        timeZone,
      }),
    ).toMatchObject({ proratedAmountMinor: 18_667 });
  });
});

describe("pricePlanChange — a downgrade", () => {
  it("starts with the next cycle and adds nothing to the bill", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: K100,
        latestBillIssuedAt: new Date("2026-10-12T05:00:00Z"),
        now: new Date("2026-11-06T05:00:00Z"),
        timeZone,
      }),
    ).toEqual({
      allowed: true,
      kind: "downgrade",
      proratedAmountMinor: 0,
      // Thu, Nov 12, 1:00 PM Manila: one calendar month after the bill.
      effectiveAt: new Date("2026-11-12T05:00:00Z"),
    });
  });

  it("starts on the last day of a shorter month when the cycle began on the 31st", () => {
    expect(
      pricePlanChange({
        current: K500,
        next: K300,
        latestBillIssuedAt: new Date("2026-01-31T02:00:00Z"),
        now: new Date("2026-02-14T02:00:00Z"),
        timeZone,
      }),
    ).toMatchObject({ effectiveAt: new Date("2026-02-28T02:00:00Z") });
  });

  it("starts in the next year when the cycle crosses the new year", () => {
    expect(
      pricePlanChange({
        current: K1000,
        next: K100,
        // Tue, Dec 15, 1:00 PM Manila to Fri, Jan 15, 1:00 PM.
        latestBillIssuedAt: new Date("2026-12-15T05:00:00Z"),
        now: new Date("2027-01-02T05:00:00Z"),
        timeZone,
      }),
    ).toMatchObject({ effectiveAt: new Date("2027-01-15T05:00:00Z") });
  });

  it("is in the company's time zone too: Mar 31 in Manila runs to Apr 30 in Manila", () => {
    expect(
      pricePlanChange({
        current: K500,
        next: K300,
        latestBillIssuedAt: new Date("2026-03-30T21:00:00Z"),
        now: new Date("2026-04-15T21:00:00Z"),
        timeZone,
      }),
    ).toMatchObject({ effectiveAt: new Date("2026-04-29T21:00:00Z") });
  });
});

describe("pricePlanChange — refusals", () => {
  it("refuses a change to the plan the account is already on", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: { ...K300 },
        latestBillIssuedAt: new Date("2026-10-12T05:00:00Z"),
        now: new Date("2026-11-06T05:00:00Z"),
        timeZone,
      }),
    ).toEqual({ allowed: false, reason: "same_plan" });
  });

  /** The cycle is [bill, bill + one month): its end is the next cycle's start. */
  it.each([
    ["at the moment the cycle ends", "2026-11-12T05:00:00Z"],
    ["weeks after the cycle ended", "2026-12-01T05:00:00Z"],
    ["before the bill was issued", "2026-10-12T04:59:59Z"],
  ])("refuses to price a change %s, when the latest bill's cycle is not the current one", (_when, now) => {
    for (const next of [K500, K100]) {
      expect(
        pricePlanChange({
          current: K300,
          next,
          latestBillIssuedAt: new Date("2026-10-12T05:00:00Z"),
          now: new Date(now),
          timeZone,
        }),
      ).toEqual({ allowed: false, reason: "no_current_cycle" });
    }
  });

  /** With no bill on record there is no cycle to prorate against: the policy decides it. */
  it("refuses to price a change for an account with no bill on record", () => {
    for (const next of [K500, K100]) {
      expect(
        pricePlanChange({
          current: K300,
          next,
          latestBillIssuedAt: null,
          now: new Date("2026-11-06T05:00:00Z"),
          timeZone,
        }),
      ).toEqual({ allowed: false, reason: "no_current_cycle" });
    }
  });

  it("prices a change at the moment the cycle starts", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt: new Date("2026-10-12T05:00:00Z"),
        now: new Date("2026-10-12T05:00:00Z"),
        timeZone,
      }),
      // The whole month: 40,000 x 31 / 31.
    ).toMatchObject({ allowed: true, proratedAmountMinor: 40_000 });
  });
});
