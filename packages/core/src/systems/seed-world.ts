/**
 * The seed world a company pack ships: the data every call starts from.
 *
 * The pack's JSON is validated against `seedWorldSchema` at load, so a typo
 * fails at boot with a path, not mid-call. `./in-memory` then serves it as
 * `BusinessSystems`.
 *
 * Outage times are stored relative to the call's start, on purpose. A seed
 * with absolute dates would announce a restoration time that passed months ago
 * the first time anyone ran the demo. The in-memory world anchors the offsets
 * to the moment the call begins.
 *
 * Cross-references (unique ids, every barangay named is declared) are checked
 * in a refinement with one issue per broken reference, each with its own path.
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

const outageSchema = z
  .object({
    reference: nonEmpty,
    cause: nonEmpty,
    barangayIds: z.array(z.string()).min(1),
    startedMinutesBeforeCall: z.number().int().min(0),
    restorationMinutesAfterCall: z.number().int().positive().nullable(),
  })
  .strict();

export const seedWorldSchema = z
  .object({
    barangays: z.array(barangaySchema).min(1),
    accounts: z.array(accountSchema).min(1),
    outages: z.array(outageSchema),
  })
  .strict()
  .superRefine((world, ctx) => {
    // The first of two clashing entries is the one that is kept; the later one
    // is reported, so the path points at the line an author should change.
    const reportDuplicates = (
      collection: "barangays" | "accounts" | "outages",
      field: string,
      values: readonly string[],
    ) => {
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
  });
export type SeedWorld = z.infer<typeof seedWorldSchema>;
