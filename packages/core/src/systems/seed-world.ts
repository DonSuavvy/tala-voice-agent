/**
 * The seed world a company pack ships: the data every call starts from.
 *
 * The pack's JSON is validated against `seedWorldSchema` at load, so a typo
 * fails at boot with a path, not mid-call. `./in-memory` then serves it as
 * `BusinessSystems`.
 *
 * Times (outages, due dates, disconnections, bills, payments, when a modem was
 * last seen) are stored relative to the call's start, on purpose. A seed with
 * absolute dates would announce a restoration time that passed months ago the
 * first time anyone ran the demo. The in-memory world anchors the offsets to
 * the moment the call begins. Each offset's name says its direction
 * (`...MinutesBeforeCall`, `...MinutesAfterCall`), so none is ever negative,
 * and each is bounded: outages and modems to 30 days, billing dates to 366.
 * Money is whole minor units.
 *
 * A modem entry is the network's own diagnosis of an account's connection and
 * what a remote reboot does to it, as data: no code turns a signal level into
 * a verdict.
 *
 * Cross-references (unique ids and references, every barangay and account
 * named is declared) are checked in a refinement with one issue per broken
 * reference, each with its own path.
 *
 * What zod 4 does when the shape is also wrong (pinned by tests, not assumed):
 * the refinement still runs after a failed *check* (a regex, a `min`, an
 * unknown key), so those errors and the broken references arrive together. It
 * is skipped after a wrong *type* or a missing field, because the refinement
 * cannot safely read a value that is not there. In that case only the shape
 * errors are reported, and the references show up on the next run once the
 * shapes are fixed. A loader gets "every problem in one pass" only up to that
 * limit; there is deliberately no second parse to work around it.
 */
import { z } from "zod";

import { MODEM_STATUSES, PAYMENT_CHANNELS } from "./types";

const nonEmpty = z.string().min(1);

const barangaySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: nonEmpty,
    city: nonEmpty,
  })
  .strict();

const accountSchema = z
  .object({
    accountNumber: z.string().regex(/^\d{10}$/),
    holderName: nonEmpty,
    registeredMobile: z.string().regex(/^\+639\d{9}$/),
    status: z.enum(["active", "suspended", "disconnected"]),
    planName: nonEmpty,
    barangayId: z.string(),
  })
  .strict();

/**
 * 30 days, in minutes: the bound on outage times. An unbounded offset loads
 * fine and then fails mid-call ("Invalid time value") once it is added to the
 * call's start; a bad config must fail at boot instead (spec user story 69).
 */
const MAX_OUTAGE_OFFSET_MINUTES = 43_200;

/**
 * 366 days, in minutes: the bound on billing dates (due dates, disconnections,
 * bills, payments). A billing history spans months, so it cannot live inside
 * the outages' 30 days, but it is bounded for the same reason: an unbounded
 * offset loads fine and then fails mid-call once it is added to the call's
 * start, and a bad config must fail at boot instead.
 */
const MAX_BILLING_OFFSET_MINUTES = 527_040;

/** At or before the call's start, by up to `max` minutes. */
const minutesBeforeCall = (max: number) => z.number().int().min(0).max(max);
/** After the call's start, by up to `max` minutes. */
const minutesAfterCall = (max: number) => z.number().int().positive().max(max);

const outageSchema = z
  .object({
    reference: nonEmpty,
    cause: nonEmpty,
    barangayIds: z.array(z.string()).min(1),
    startedMinutesBeforeCall: minutesBeforeCall(MAX_OUTAGE_OFFSET_MINUTES),
    restorationMinutesAfterCall: minutesAfterCall(MAX_OUTAGE_OFFSET_MINUTES).nullable(),
  })
  .strict();

/** Whole minor units (centavos for PHP), so no amount is ever a fraction. */
const minorUnits = z.number().int().min(0);

/** What an account owes as the call starts. At most one per account. */
const balanceSchema = z
  .object({
    accountNumber: z.string(),
    amountDueMinor: minorUnits,
    dueMinutesBeforeCall: minutesBeforeCall(MAX_BILLING_OFFSET_MINUTES).nullable(),
    disconnectionMinutesAfterCall: minutesAfterCall(MAX_BILLING_OFFSET_MINUTES).nullable(),
  })
  .strict();

const billSchema = z
  .object({
    reference: nonEmpty,
    accountNumber: z.string(),
    amountMinor: minorUnits.positive(),
    issuedMinutesBeforeCall: minutesBeforeCall(MAX_BILLING_OFFSET_MINUTES),
  })
  .strict();

const paymentSchema = z
  .object({
    /** Normalized as `verify_payment` normalizes what the caller says: no spaces or dashes, upper case. */
    reference: z.string().regex(/^[A-Z0-9]+$/),
    accountNumber: z.string(),
    channel: z.enum(PAYMENT_CHANNELS),
    amountMinor: minorUnits.positive(),
    paidMinutesBeforeCall: minutesBeforeCall(MAX_BILLING_OFFSET_MINUTES),
    posted: z.boolean(),
  })
  .strict();

/**
 * 30 days, in minutes, like the outages: the bound on when a modem was last
 * seen. A modem silent for longer is a disconnection matter, not a line check.
 */
const MAX_LAST_SEEN_MINUTES = 43_200;

/**
 * The longest remote restart a seed may state, in seconds. The caller waits on
 * the line through it, so it stays within a few minutes.
 */
const MAX_RESTART_SECONDS = 180;

/** What the network's monitoring reads from a modem. */
const modemReadingShape = {
  status: z.enum(MODEM_STATUSES),
  /** Optical power the modem receives, in dBm, as the network reports it. */
  receivedPowerDbm: z.number(),
  /** For speech, e.g. `high signal loss on the fiber line`. Null when the system found none. */
  fault: nonEmpty.nullable(),
  /** Whether the system says a remote reboot may clear the fault. */
  rebootMayClear: z.boolean(),
};

/**
 * The modem at an account's home, as the network diagnoses it when the call
 * starts, and as it reads once a remote reboot has finished. At most one per
 * account.
 */
const modemSchema = z
  .object({
    accountNumber: z.string(),
    ...modemReadingShape,
    lastSeenMinutesBeforeCall: minutesBeforeCall(MAX_LAST_SEEN_MINUTES),
    restartSeconds: z.number().int().positive().max(MAX_RESTART_SECONDS),
    afterReboot: z.object(modemReadingShape).strict(),
  })
  .strict();

const seedWorldShape = {
  barangays: z.array(barangaySchema).min(1),
  accounts: z.array(accountSchema).min(1),
  outages: z.array(outageSchema),
  balances: z.array(balanceSchema),
  bills: z.array(billSchema),
  payments: z.array(paymentSchema),
  modems: z.array(modemSchema),
};

/** A top-level list of the seed world, such as 'accounts': derived, so a new list is one too. */
type Collection = keyof typeof seedWorldShape;

export const seedWorldSchema = z
  .object(seedWorldShape)
  .strict()
  .superRefine((world, ctx) => {
    // The first of two clashing entries is the one that is kept; the later one
    // is reported, so the path points at the line an author should change.
    const reportDuplicates = (collection: Collection, field: string, values: readonly string[]) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [collection, index, field],
            message: `duplicate ${field} "${value}" in ${collection}`,
          });
        }
        seen.add(value);
      });
    };
    reportDuplicates("barangays", "id", world.barangays.map((b) => b.id));
    reportDuplicates("accounts", "accountNumber", world.accounts.map((a) => a.accountNumber));
    reportDuplicates("outages", "reference", world.outages.map((o) => o.reference));
    // A second balance for one account would leave the first one served and
    // the second silently ignored.
    reportDuplicates("balances", "accountNumber", world.balances.map((b) => b.accountNumber));
    reportDuplicates("bills", "reference", world.bills.map((b) => b.reference));
    // Unique across accounts, not per account: one reference, one payment.
    reportDuplicates("payments", "reference", world.payments.map((p) => p.reference));
    // One modem per account, for the same reason as one balance.
    reportDuplicates("modems", "accountNumber", world.modems.map((m) => m.accountNumber));

    const known = new Set(world.barangays.map((b) => b.id));
    world.accounts.forEach((account, index) => {
      if (!known.has(account.barangayId)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "barangayId"],
          message: `account ${account.accountNumber} names unknown barangay "${account.barangayId}"`,
        });
      }
    });
    world.outages.forEach((outage, index) => {
      outage.barangayIds.forEach((id, position) => {
        if (!known.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["outages", index, "barangayIds", position],
            message: `outage ${outage.reference} names unknown barangay "${id}"`,
          });
        }
      });
    });

    const accountNumbers = new Set(world.accounts.map((a) => a.accountNumber));
    const reportUnknownAccount = (
      collection: Collection,
      index: number,
      accountNumber: string,
      what: string,
    ) => {
      if (accountNumbers.has(accountNumber)) return;
      ctx.addIssue({
        code: "custom",
        path: [collection, index, "accountNumber"],
        message: `${what} names unknown account "${accountNumber}"`,
      });
    };
    world.balances.forEach((b, i) => reportUnknownAccount("balances", i, b.accountNumber, "balance"));
    world.bills.forEach((b, i) =>
      reportUnknownAccount("bills", i, b.accountNumber, `bill ${b.reference}`),
    );
    world.payments.forEach((p, i) =>
      reportUnknownAccount("payments", i, p.accountNumber, `payment ${p.reference}`),
    );
    world.modems.forEach((m, i) => reportUnknownAccount("modems", i, m.accountNumber, "modem"));
  });
export type SeedWorld = z.infer<typeof seedWorldSchema>;
