import { describe, expect, it } from "vitest";

import { compileSop, sopPlaceholders } from "../agent/sop";
import { testPlans } from "../testing/fixtures";

import { PLAN_CATALOG_RENDERERS } from "./plan-catalog";

/**
 * The plan catalog as the SOP states it. Tala names plans and speeds from
 * it, and passes a plan's id to the tools; prices are left out, because the
 * amounts of a change always come from a quote.
 */
describe("PLAN_CATALOG_RENDERERS", () => {
  it("offers one placeholder, the catalog", () => {
    expect(sopPlaceholders(PLAN_CATALOG_RENDERERS)).toEqual(["planCatalog"]);
  });

  it("renders one line per plan, in catalog order: its name, its speed and its id, no price", () => {
    expect(
      compileSop({
        bodyMarkdown: "Plans:\n{{planCatalog}}\nEnd.",
        policyConfig: testPlans(),
        renderers: PLAN_CATALOG_RENDERERS,
      }),
    ).toBe(
      "Plans:\n" +
        "- Kidlat 100: 100 Mbps, plan id kidlat-100\n" +
        "- Kidlat 300: 300 Mbps, plan id kidlat-300\n" +
        "- Kidlat 500: 500 Mbps, plan id kidlat-500\n" +
        "End.",
    );
  });
});
