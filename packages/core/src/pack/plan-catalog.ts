/**
 * The plan catalog a company pack ships: the plans an account can be on, each
 * with its download speed and monthly price.
 *
 * The pack's JSON is checked against `planCatalogSchema` at boot, like the
 * rest of the pack. A seeded account names its plan by the plan's name, as
 * the caller knows it; `loadPack` checks that every account's plan is in the
 * catalog, and the in-memory world resolves each name to the plan's id once,
 * so plans are matched by id everywhere after. Money is whole minor units, as
 * everywhere.
 *
 * The SOP states the catalog through `{{planCatalog}}`, so the plans Tala can
 * name are the plans the pack ships, never typed text.
 */
import { z } from "zod";

import type { SopRenderers } from "../agent/sop";

/**
 * Absolute caps, because a well-formed catalog can still be absurd (ADR 1:
 * a pack's schema bounds every figure absolutely). A price is at most a
 * million pesos a month in minor units, and a speed at most 10,000 Mbps.
 */
const MAX_MONTHLY_PRICE_MINOR = 100_000_000;
const MAX_DOWNLOAD_MBPS = 10_000;

const planSchema = z
  .object({
    /** A stable slug, e.g. `kidlat-500`. */
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    /** As the caller knows it, e.g. `Kidlat 500`. Accounts name their plan by it. */
    name: z.string().min(1),
    /** The download speed, in Mbps. */
    downloadMbps: z.number().int().positive().max(MAX_DOWNLOAD_MBPS),
    /** The price of a month of service, in minor units (centavos for PHP). */
    monthlyPriceMinor: z.number().int().positive().max(MAX_MONTHLY_PRICE_MINOR),
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;

/**
 * At least one plan, ids and names unique. The first of two clashing plans is
 * the one kept; the later one is reported, so the path points at the line an
 * author should change.
 */
export const planCatalogSchema = z
  .array(planSchema)
  .min(1)
  .superRefine((plans, ctx) => {
    for (const field of ["id", "name"] as const) {
      const seen = new Set<string>();
      plans.forEach((plan, index) => {
        const value = plan[field];
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [index, field],
            message: `duplicate plan ${field} "${value}"`,
          });
        }
        seen.add(value);
      });
    }
  });

/**
 * The plan in the catalog with this id. Throws when there is none: a plan
 * id the business systems hold that the pack's catalog lacks cannot be named
 * or priced.
 */
export function planWithId(plans: readonly Plan[], id: string): Plan {
  const plan = plans.find((p) => p.id === id);
  if (!plan) throw new Error(`plan "${id}" is not in the plan catalog`);
  return plan;
}

/**
 * The catalog as the SOP states it: one line per plan, with its name, its
 * download speed and the id the tools take. No price: the amounts of a change
 * come from its quote.
 */
export const PLAN_CATALOG_RENDERERS: SopRenderers<readonly Plan[]> = {
  planCatalog: (plans) =>
    plans.map((plan) => `- ${plan.name}: ${plan.downloadMbps} Mbps, plan id ${plan.id}`).join("\n"),
};
