/**
 * Pricing a plan change, as a pure decision.
 *
 * An account's billing cycle runs from its latest bill's issue date to one
 * calendar month later, in the company's time zone. A cycle that starts on a
 * day the next month lacks, such as Jan 31, ends on that month's last day.
 *
 * An **upgrade** is a change to a plan with a higher monthly price, and a
 * **downgrade** a change to any other plan. When each takes effect is the
 * support policy's (`planChanges`), parsed here, at the point of decision:
 *
 * - A change that takes effect `now` is prorated: the difference in monthly
 *   price times the share of the cycle still to run, its size rounded half up
 *   to the minor unit, added to the next bill. For a downgrade the difference
 *   is negative, so the amount is a credit.
 * - A change that takes effect at the `next_cycle` starts when the latest
 *   bill's cycle ends, with no prorated amount.
 * - A change to the plan the account is already on is refused, and so is any
 *   change when the account has no bill on record or `now` is not inside the
 *   latest bill's cycle: with no current cycle there is nothing to prorate
 *   against.
 *
 * No clock, no I/O: `now` is passed in.
 */
import { instantOfWall, wallClock } from "../systems/local-time";
import { SECOND_MS } from "../systems/time-units";

import { parseSupportPolicy } from "./support-policy";

export type PlanChangeKind = "upgrade" | "downgrade";

/** A plan, as a change prices it. */
export interface PricedPlan {
  id: string;
  /** In minor units. */
  monthlyPriceMinor: number;
}

export interface PlanChangeRequest {
  current: PricedPlan;
  next: PricedPlan;
  /** When the account's latest bill was issued: its billing cycle starts then. Null when it has none. */
  latestBillIssuedAt: Date | null;
  now: Date;
  /** The company's, an IANA name such as `Asia/Manila`: the month is counted there. */
  timeZone: string;
  /** The support policy the call was pinned to; parsed here. */
  policy: unknown;
}

export type PlanChangePrice =
  | {
      allowed: true;
      kind: PlanChangeKind;
      /** Added to the next bill, in minor units: negative for a credit, 0 when not prorated. */
      proratedAmountMinor: number;
      /** When the new plan starts: `now`, or the next cycle's start. */
      effectiveAt: Date;
    }
  | { allowed: false; reason: "same_plan" | "no_current_cycle" };

export function pricePlanChange(request: PlanChangeRequest): PlanChangePrice {
  const { current, next, latestBillIssuedAt, now, timeZone } = request;
  const { planChanges } = parseSupportPolicy(request.policy);
  if (current.id === next.id) return { allowed: false, reason: "same_plan" };
  if (latestBillIssuedAt === null) return { allowed: false, reason: "no_current_cycle" };

  const startsAt = latestBillIssuedAt.getTime();
  const endsAt = oneMonthLater(latestBillIssuedAt, timeZone).getTime();
  const at = now.getTime();
  if (at < startsAt || at >= endsAt) return { allowed: false, reason: "no_current_cycle" };

  const kind: PlanChangeKind =
    next.monthlyPriceMinor > current.monthlyPriceMinor ? "upgrade" : "downgrade";
  if (planChanges[kind] === "next_cycle") {
    return { allowed: true, kind, proratedAmountMinor: 0, effectiveAt: new Date(endsAt) };
  }

  // In BigInt, so nothing is lost. Even under the catalog's price cap
  // (10^8 minor units), a price difference times the milliseconds
  // left in a month (up to about 2.7 x 10^9) passes 2^53. For a positive x / y,
  // floor((2x + y) / 2y) is x / y rounded half up. The size is rounded, and
  // the sign put back, so a credit rounds the same way as a charge.
  const difference = next.monthlyPriceMinor - current.monthlyPriceMinor;
  const size = BigInt(Math.abs(difference));
  const left = BigInt(endsAt - at);
  const length = BigInt(endsAt - startsAt);
  const prorated = Number((2n * size * left + length) / (2n * length));
  return {
    allowed: true,
    kind,
    proratedAmountMinor: difference < 0 ? -prorated : prorated,
    effectiveAt: new Date(at),
  };
}

/** Days in a month, 1 to 12, of a year. */
function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The same wall-clock time one calendar month later in the zone, on the
 * month's last day when it has no such day. Milliseconds carry over as they
 * were.
 */
function oneMonthLater(instant: Date, timeZone: string): Date {
  const wall = wallClock(instant, timeZone);
  const year = wall.month === 12 ? wall.year + 1 : wall.year;
  const month = wall.month === 12 ? 1 : wall.month + 1;
  const day = Math.min(wall.day, daysIn(year, month));
  const later = instantOfWall({ ...wall, year, month, day }, timeZone);
  return new Date(later.getTime() + (instant.getTime() % SECOND_MS));
}
