import { describe, expect, it } from "vitest";

import { TEST_COMPANY, testPlans, testPolicy } from "../testing/fixtures";

import { pricePlanChange } from "./plan-change";

/**
 * Pricing a plan change, as a pure decision: the clock is passed in.
 *
 * The billing cycle runs from the account's latest bill to one calendar month
 * later in the company's time zone. Under the test policy an upgrade starts
 * now and adds the difference in monthly price for the rest of the cycle to
 * the next bill, and a downgrade starts with the next cycle and adds nothing.
 * Prices are the test catalog's: Kidlat 100 at 1,299 pesos, 300 at 1,699 and
 * 500 at 2,099. Every expected amount below is worked out by hand in its
 * comment, never recomputed here.
 */

const { timeZone } = TEST_COMPANY;

/** The test policy, with these plan-change rules. */
const withTimings = (upgrade: string, downgrade: string) => ({
  ...testPolicy(),
  planChanges: { upgrade, downgrade },
});
/** An upgrade at once, a downgrade with the next cycle. */
const POLICY = testPolicy();

/** A plan from the test catalog. */
function plan(id: string) {
  const found = testPlans().find((p) => p.id === id);
  if (!found) throw new Error(`no test plan "${id}"`);
  return found;
}
const K100 = plan("kidlat-100");
const K300 = plan("kidlat-300");
const K500 = plan("kidlat-500");

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
        policy: POLICY,
      }),
    ).toEqual({ allowed: true, kind: "upgrade", proratedAmountMinor: 7_742, effectiveAt: now });
  });

  /**
   * A February cycle (Feb 1 to Mar 1, 1:00 PM Manila) is 28 days, 40,320
   * minutes. 300 to 500 is 40,000 centavos a month more.
   * 63 minutes left: 40,000 x 63 / 40,320 = 62.5, which rounds up to 63.
   * 64 minutes left: 40,000 x 64 / 40,320 = 63.49, which rounds down to 63.
   */
  it("rounds half a centavo up, and less than half down", () => {
    const latestBillIssuedAt = new Date("2026-02-01T05:00:00Z");
    const price = (now: string) =>
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt,
        now: new Date(now),
        timeZone,
        policy: POLICY,
      });

    expect(price("2026-03-01T03:57:00Z")).toMatchObject({ proratedAmountMinor: 63 });
    expect(price("2026-03-01T03:56:00Z")).toMatchObject({ proratedAmountMinor: 63 });
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
        policy: POLICY,
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
        policy: POLICY,
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
        policy: POLICY,
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
        policy: POLICY,
      }),
    ).toMatchObject({ effectiveAt: new Date("2026-02-28T02:00:00Z") });
  });

  it("starts in the next year when the cycle crosses the new year", () => {
    expect(
      pricePlanChange({
        current: K500,
        next: K100,
        // Tue, Dec 15, 1:00 PM Manila to Fri, Jan 15, 1:00 PM.
        latestBillIssuedAt: new Date("2026-12-15T05:00:00Z"),
        now: new Date("2027-01-02T05:00:00Z"),
        timeZone,
        policy: POLICY,
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
        policy: POLICY,
      }),
    ).toMatchObject({ effectiveAt: new Date("2026-04-29T21:00:00Z") });
  });
});

/** When each kind of change takes effect is the policy's; the pricing follows it. */
describe("pricePlanChange — the policy's timings", () => {
  const OCT_BILL = new Date("2026-10-12T05:00:00Z");
  const NOV_6 = new Date("2026-11-06T05:00:00Z");

  it("starts an upgrade with the next cycle, with nothing prorated, when the policy says so", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt: OCT_BILL,
        now: NOV_6,
        timeZone,
        policy: withTimings("next_cycle", "next_cycle"),
      }),
    ).toEqual({
      allowed: true,
      kind: "upgrade",
      proratedAmountMinor: 0,
      effectiveAt: new Date("2026-11-12T05:00:00Z"),
    });
  });

  /**
   * A downgrade at once credits the difference for the rest of the cycle:
   * 300 to 100 is 400 pesos a month less, 6 of 31 days left:
   * -40,000 x 6 / 31 = -7,741.94 centavos, so -7,742.
   */
  it("starts a downgrade at once, crediting the rest of the cycle, when the policy says so", () => {
    expect(
      pricePlanChange({
        current: K300,
        next: K100,
        latestBillIssuedAt: OCT_BILL,
        now: NOV_6,
        timeZone,
        policy: withTimings("now", "now"),
      }),
    ).toEqual({ allowed: true, kind: "downgrade", proratedAmountMinor: -7_742, effectiveAt: NOV_6 });
  });

  /** Parsed at the point of decision: a malformed policy throws instead of failing open. */
  it("refuses to price with a policy that does not say when changes take effect", () => {
    expect(() =>
      pricePlanChange({
        current: K300,
        next: K500,
        latestBillIssuedAt: OCT_BILL,
        now: NOV_6,
        timeZone,
        policy: { identity: { maxFailedAttempts: 3 } },
      }),
    ).toThrow(/planChanges/);
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
        policy: POLICY,
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
          policy: POLICY,
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
          policy: POLICY,
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
        policy: POLICY,
      }),
      // The whole month: 40,000 x 31 / 31.
    ).toMatchObject({ allowed: true, proratedAmountMinor: 40_000 });
  });
});
