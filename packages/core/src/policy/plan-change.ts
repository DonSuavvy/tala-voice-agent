/**
 * Pricing a plan change, as a pure decision.
 *
 * An account's billing cycle runs from its latest bill's issue date to one
 * calendar month later, in the company's time zone. A cycle that starts on a
 * day the next month lacks, such as Jan 31, ends on that month's last day.
 *
 * - An **upgrade**, to a plan with a higher monthly price, takes effect now.
 *   Its prorated amount is the difference in monthly price times the share of
 *   the cycle still to run, rounded half up to the minor unit, and is added to
 *   the next bill.
 * - A **downgrade**, to any other plan, takes effect when the next cycle
 *   starts, with no prorated amount.
 * - A change to the plan the account is already on is refused, and so is any
 *   change when `now` is not inside the latest bill's cycle: with no current
 *   cycle there is nothing to prorate against.
 *
 * No clock, no I/O: `now` is passed in.
 */

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
  /** When the account's latest bill was issued: its billing cycle starts then. */
  latestBillIssuedAt: Date;
  now: Date;
  /** The company's, an IANA name such as `Asia/Manila`: the month is counted there. */
  timeZone: string;
}

export type PlanChangePrice =
  | {
      allowed: true;
      kind: PlanChangeKind;
      /** Added to the next bill, in minor units. 0 for a downgrade. */
      proratedAmountMinor: number;
      /** When the new plan starts: now for an upgrade, the next cycle's start for a downgrade. */
      effectiveAt: Date;
    }
  | { allowed: false; reason: "same_plan" | "outside_billing_cycle" };

export function pricePlanChange(request: PlanChangeRequest): PlanChangePrice {
  const { current, next, latestBillIssuedAt, now, timeZone } = request;
  if (current.id === next.id) return { allowed: false, reason: "same_plan" };

  const startsAt = latestBillIssuedAt.getTime();
  const endsAt = oneMonthLater(latestBillIssuedAt, timeZone).getTime();
  const at = now.getTime();
  if (at < startsAt || at >= endsAt) return { allowed: false, reason: "outside_billing_cycle" };

  if (next.monthlyPriceMinor <= current.monthlyPriceMinor) {
    return {
      allowed: true,
      kind: "downgrade",
      proratedAmountMinor: 0,
      effectiveAt: new Date(endsAt),
    };
  }

  // In BigInt, so nothing is lost: a price difference times the milliseconds
  // left in a month can pass 2^53. For a positive x / y, floor((2x + y) / 2y)
  // is x / y rounded half up.
  const difference = BigInt(next.monthlyPriceMinor - current.monthlyPriceMinor);
  const left = BigInt(endsAt - at);
  const length = BigInt(endsAt - startsAt);
  const prorated = (2n * difference * left + length) / (2n * length);
  return {
    allowed: true,
    kind: "upgrade",
    proratedAmountMinor: Number(prorated),
    effectiveAt: new Date(at),
  };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const SECOND_MS = 1_000;

/** What a wall clock in the time zone reads at this instant, to the second. */
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

function wallAsUtc(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const whole = Math.floor(instant.getTime() / SECOND_MS) * SECOND_MS;
  return wallAsUtc(wallClock(instant, timeZone)) - whole;
}

/** The instant the zone's wall clock reads `wall`. */
function instantOfWall(wall: WallClock, timeZone: string): Date {
  const asUtc = wallAsUtc(wall);
  // Guess with the offset at the wall time read as UTC, then correct with the
  // offset at the guess: right on both sides of a clock change.
  const guess = asUtc - offsetAt(new Date(asUtc), timeZone);
  return new Date(asUtc - offsetAt(new Date(guess), timeZone));
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
  const milliseconds = instant.getTime() - Math.floor(instant.getTime() / SECOND_MS) * SECOND_MS;
  return new Date(later.getTime() + milliseconds);
}
