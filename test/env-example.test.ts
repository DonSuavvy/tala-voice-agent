import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every setting the spec relies on (docs/DESIGN.md §7, §9, §11 and §14).
// A ticket that needs a new setting adds it here and to .env.example together.
const SPEC_KEYS = [
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "GOOGLE_API_KEY",
  "TALA_VOICE_PROFILE",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "DATABASE_URL",
  "TALA_DEMO_PASSCODE",
  "TALA_DAILY_BUDGET_USD",
  "TALA_MONTHLY_BUDGET_USD",
];

const path = new URL("../.env.example", import.meta.url);

function assignments(text: string): { key: string; value: string; line: string }[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return { key: line.slice(0, eq), value: line.slice(eq + 1), line };
    });
}

describe(".env.example", () => {
  it("exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  const entries = existsSync(path) ? assignments(readFileSync(path, "utf8")) : [];

  it("is only comments and KEY= lines", () => {
    for (const { key, line } of entries) {
      expect(key, line).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("lists every key the spec names, once", () => {
    const keys = entries.map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(SPEC_KEYS));
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The file is public. A value here is a secret one paste away from a commit.
  it("ships no values", () => {
    for (const { key, value } of entries) {
      expect(value, key).toBe("");
    }
  });
});
