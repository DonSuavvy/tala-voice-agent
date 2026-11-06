/**
 * Short, stable labels for what a call or an eval run ran with.
 *
 * Moved here from the eval package (#5) so a call and an eval run label the
 * same prompt with the same version: a call record and an eval report can
 * then be lined up by eye.
 *
 * **Prompt version is a hash of the compiled text, not of the SOP's version
 * id.** The id records which document ran. It cannot record that `compileSop`
 * rendered it differently: a placeholder added, a renderer changed, a policy
 * figure substituted from a different config. Those move the bytes the model
 * reads while the SOP version stays the same, which is exactly the class of
 * change that produces an unexplained regression. (OpsPilot's reasoning, kept.)
 */
import { createHash } from "node:crypto";

import type { SystemBlock } from "../agent/cache";

/**
 * Twelve hex characters, 48 bits.
 *
 * Long enough that a collision across the handful of variants a project ever
 * has is not a real risk, short enough to read in a table header and quote in
 * a commit message. It is an identity label, not a security digest.
 */
const PIN_LENGTH = 12;

/** The label for any text: the first twelve hex characters of its SHA-256. */
export function versionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, PIN_LENGTH);
}

/**
 * The text a `system` argument actually sends.
 *
 * Blocks are concatenated and their `cache_control` ignored, so a prompt pins
 * the same whether or not caching is switched on. Caching changes what the
 * provider does with the prefix, not what the model reads.
 */
function systemText(system: string | SystemBlock[]): string {
  return typeof system === "string" ? system : system.map((block) => block.text).join("");
}

export function promptVersion(system: string | SystemBlock[]): string {
  return versionOf(systemText(system));
}
