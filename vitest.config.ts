import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests never touch a database, a network or an API key. Checks that
    // do live in scripts/verify-*.ts and run by hand.
    environment: "node",
    include: ["{packages,apps}/**/src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
