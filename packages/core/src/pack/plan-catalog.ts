/**
 * The plan catalog a company pack ships: the plans an account can be on, each
 * with its download speed and monthly price.
 *
 * The pack's JSON is checked against `planCatalogSchema` at boot, like the
 * rest of the pack. An account names its plan by the plan's name, as the
 * caller knows it; `loadPack` checks that every account's plan is in the
 * catalog. Money is whole minor units, as everywhere.
 *
 * The SOP states the catalog through `{{planCatalog}}`, so the plans Tala can
 * name are the plans the pack ships, never typed text.
 */
import { z } from "zod";

import type { SopRenderers } from "../agent/sop";

const planSchema = z
  .object({
    /** A stable slug, e.g. `kidlat-500`. */
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    /** As the caller knows it, e.g. `Kidlat 500`. Accounts name their plan by it. */
    name: z.string().min(1),
    /** The download speed, in Mbps. */
    downloadMbps: z.number().int().positive(),
    /** The price of a month of service, in minor units (centavos for PHP). */
    monthlyPriceMinor: z.number().int().positive(),
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
 * The catalog as the SOP states it: one line per plan, with its name, its
 * download speed and the id the tools take. No price: the amounts of a change
 * come from its quote.
 */
export const PLAN_CATALOG_RENDERERS: SopRenderers<readonly Plan[]> = {
  planCatalog: (plans) =>
    plans.map((plan) => `- ${plan.name}: ${plan.downloadMbps} Mbps, plan id ${plan.id}`).join("\n"),
};
