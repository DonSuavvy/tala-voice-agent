import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/node_modules/**", "coverage/**", "**/.next/**", "**/dist/**", ".claude/**"]),
  js.configs.recommended,
  // Type-aware rules: a floating promise in the voice path is a dropped turn.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Test fakes stand in for async handlers and clients, so `async () => x`
    // is the idiomatic shape and has nothing to await.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
]);
