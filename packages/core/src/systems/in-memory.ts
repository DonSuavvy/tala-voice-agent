/**
 * The in-memory `BusinessSystems`: the world every demo call and unit test
 * runs on.
 *
 * Built from a seed world and the moment the call started. Two things matter
 * about it:
 *
 * - Each call gets a fresh copy of the seed (spec: "each call starts from a
 *   fresh copy of the seed world"). The seed is cloned on creation, so two
 *   calls never share state and nothing a call does can reach the seed.
 * - It never reads the wall clock. The seed stores outage times relative to the
 *   call's start (see `./seed-world`); `callStartedAt` is the only time source
 *   and turns those offsets into dates. That also makes tests deterministic.
 *
 * Everything handed out is a copy, so a caller that mutates a result changes
 * nothing stored.
 */
import type { SeedWorld } from "./seed-world";
import type { AccountRecord, BusinessSystems, OutageRecord } from "./types";

const MINUTE_MS = 60_000;

export function createInMemorySystems(seed: SeedWorld, callStartedAt: Date): BusinessSystems {
  const world = structuredClone(seed);
  const minutesFromStart = (minutes: number) =>
    new Date(callStartedAt.getTime() + minutes * MINUTE_MS);

  const findAccount = (accountNumber: string): AccountRecord | null => {
    const account = world.accounts.find((a) => a.accountNumber === accountNumber);
    if (!account) return null;
    // The schema guarantees the barangay exists; a seed that skipped the
    // schema and dangles fails loudly here rather than serving a half record.
    const barangay = world.barangays.find((b) => b.id === account.barangayId);
    if (!barangay) {
      throw new Error(
        `account ${account.accountNumber} names unknown barangay "${account.barangayId}"`,
      );
    }
    return {
      accountNumber: account.accountNumber,
      holderName: account.holderName,
      registeredMobile: account.registeredMobile,
      status: account.status,
      planName: account.planName,
      serviceArea: {
        barangayId: barangay.id,
        barangayName: barangay.name,
        city: barangay.city,
      },
    };
  };

  const outagesAffecting = (barangayId: string): OutageRecord[] =>
    // Array.prototype.sort is stable, so equal start times keep seed order.
    world.outages
      .filter((o) => o.barangayIds.includes(barangayId))
      .sort((a, b) => b.startedMinutesBeforeCall - a.startedMinutesBeforeCall)
      .map((o) => ({
        reference: o.reference,
        cause: o.cause,
        barangayIds: [...o.barangayIds],
        startedAt: minutesFromStart(-o.startedMinutesBeforeCall),
        estimatedRestorationAt:
          o.restorationMinutesAfterCall === null
            ? null
            : minutesFromStart(o.restorationMinutesAfterCall),
      }));

  // Every real implementation is a network call, so these are async. Wrapping
  // in a promise (rather than an async body) turns a throw into a rejection.
  return {
    accounts: { findAccount: (n) => Promise.resolve().then(() => findAccount(n)) },
    network: { outagesAffecting: (id) => Promise.resolve().then(() => outagesAffecting(id)) },
  };
}
