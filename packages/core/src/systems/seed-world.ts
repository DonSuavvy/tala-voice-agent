/**
 * The seed world a company pack ships: the data every call starts from.
 *
 * The pack's JSON is validated against `seedWorldSchema` at load, so a typo
 * fails at boot with a path, not mid-call. `./in-memory` then serves it as
 * `BusinessSystems`.
 *
 * Times (outages, due dates, disconnections, bills, payments) are stored
 * relative to the call's start, on purpose. A seed with absolute dates would
 * announce a restoration time that passed months ago the first time anyone ran
 * the demo. The in-memory world anchors the offsets to the moment the call
 * begins. Each offset's name says its direction (`...MinutesBeforeCall`,
 * `...MinutesAfterCall`), so none is ever negative. Money is whole minor units.
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

import { PAYMENT_CHANNELS } from "./types";

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
 * 30 days, in minutes. An unbounded offset loads fine and then fails mid-call
 * ("Invalid time value") once it is added to the call's start; a bad config
 * must fail at boot instead (spec user story 69).
 */
const MAX_OFFSET_MINUTES = 43_200;

/** At or before the call's start, by up to 30 days. */
const minutesBeforeCall = z.number().int().min(0).max(MAX_OFFSET_MINUTES);
/** After the call's start, by up to 30 days. */
const minutesAfterCall = z.number().int().positive().max(MAX_OFFSET_MINUTES);

const outageSchema = z
  .object({
    reference: nonEmpty,
    cause: nonEmpty,
    barangayIds: z.array(z.string()).min(1),
    startedMinutesBeforeCall: minutesBeforeCall,
    restorationMinutesAfterCall: minutesAfterCall.nullable(),
  })
  .strict();

/** Whole minor units (centavos for PHP), as the policy holds money. */
const minorUnits = z.number().int().min(0);

/** What an account owes as the call starts. At most one per account. */
const balanceSchema = z
  .object({
    accountNumber: z.string(),
    amountDueMinor: minorUnits,
    dueMinutesBeforeCall: minutesBeforeCall.nullable(),
    disconnectionMinutesAfterCall: minutesAfterCall.nullable(),
  })
  .strict();

const billSchema = z
  .object({
    reference: nonEmpty,
    accountNumber: z.string(),
    amountMinor: minorUnits.positive(),
    issuedMinutesBeforeCall: minutesBeforeCall,
  })
  .strict();

const paymentSchema = z
  .object({
    /** Normalized as `verify_payment` normalizes what the caller says: no spaces or dashes, upper case. */
    reference: z.string().regex(/^[A-Z0-9]+$/),
    accountNumber: z.string(),
    channel: z.enum(PAYMENT_CHANNELS),
    amountMinor: minorUnits.positive(),
    paidMinutesBeforeCall: minutesBeforeCall,
    posted: z.boolean(),
  })
  .strict();

type Collection = "barangays" | "accounts" | "outages" | "balances" | "bills" | "payments";

export const seedWorldSchema = z
  .object({
    barangays: z.array(barangaySchema).min(1),
    accounts: z.array(accountSchema).min(1),
    outages: z.array(outageSchema),
    balances: z.array(balanceSchema),
    bills: z.array(billSchema),
    payments: z.array(paymentSchema),
  })
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
      collection: "balances" | "bills" | "payments",
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
  });
export type SeedWorld = z.infer<typeof seedWorldSchema>;
