/**
 * Checking an SOP and its policy before they become the live prompt.
 *
 * The document carries both what the model is told and, through its policy,
 * what the tool handlers revalidate against. So this is the tool registry's
 * boot validation, applied to policy, and it has to run before the version is
 * used: a bad one would otherwise fail inside the agent loop, far from the
 * edit that caused it.
 *
 * A company pack runs it at boot on its shipped SOP. A future editor would run
 * it before saving. Everything here is pure.
 */
import { compileSop, type SopRenderers } from "./sop";

/** A draft that is structurally wrong. Placeholder errors keep their own type. */
export class SopDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SopDraftError";
  }
}

export interface SopDraft<P> {
  bodyMarkdown: string;
  policyConfig: P;
}

/** What the pack supplies: its policy parser and its placeholder vocabulary. */
export interface SopPack<P> {
  /**
   * Parses untrusted input into the pack's policy, or throws. Its schema
   * carries the absolute caps, so a well-formed but absurd figure is refused
   * here (OpsPilot review Round 4: a valid policy authorised $999,999.99).
   */
  parsePolicy: (raw: unknown) => P;
  renderers: SopRenderers<P>;
}

/**
 * Check a draft and return it parsed, or throw.
 *
 * Order matters. The policy is parsed first because its schema carries the
 * absolute caps, which the compile would happily render past. Then the
 * markdown is compiled against the *parsed* policy, so an unknown placeholder
 * surfaces here with the same error the request path would raise.
 *
 * The compile result is discarded on purpose: this is a rehearsal, not the
 * render. The document is kept unsubstituted, because substituting before
 * storing it is precisely the drift bug the compiler exists to remove.
 */
export function validateSopDraft<P>(
  input: { bodyMarkdown: string; policyConfig: unknown },
  pack: SopPack<P>,
): SopDraft<P> {
  if (input.bodyMarkdown.trim().length === 0) {
    throw new SopDraftError(
      "the SOP document is empty — an active version with no body would ship a blank system prompt",
    );
  }

  let policyConfig: P;
  try {
    policyConfig = pack.parsePolicy(input.policyConfig);
  } catch (error) {
    // Zod's message names the offending path, which is the useful half for
    // someone fixing it. Rewrapped so callers catch one type.
    throw new SopDraftError(
      `policy is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Rehearse the render. Throws UnknownPlaceholderError, which already names
  // the bad token and the known vocabulary.
  compileSop({
    bodyMarkdown: input.bodyMarkdown,
    facts: policyConfig,
    renderers: pack.renderers,
  });

  return { bodyMarkdown: input.bodyMarkdown, policyConfig };
}
