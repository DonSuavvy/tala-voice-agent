/**
 * What an eval run is pinned to.
 *
 * As in OpsPilot, every run carries (SOP version, prompt version, model, git SHA), so
 * any two runs can be diffed and the difference attributed. The SOP version and
 * the model are ids the caller already holds; the other two are computed here.
 *
 * **Prompt version is a hash of the compiled text, not of the SOP row.** The
 * SOP version id already records which document ran. What it cannot record is
 * that `compileSop` rendered it differently — a placeholder added, a renderer
 * changed, a policy figure substituted from a different config. Those move the
 * bytes the model reads while leaving `sop_version_id` identical, which is
 * exactly the class of change that produces an unexplained regression.
 *
 * `promptVersion` lives in core since #5, so a live call and an eval run
 * label the same prompt the same way. It is re-exported here for the eval
 * code and tests that already import it from this module.
 */
export { promptVersion } from "@tala/core";

/** Runs `git rev-parse HEAD` and returns stdout. May throw; may return junk. */
export type GitShaExec = () => string;

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The commit this run's code came from, or null.
 *
 * CI first, because in CI the checked-out working tree can be a merge commit
 * that exists nowhere else while `GITHUB_SHA` names the commit under review.
 * Then Vercel's equivalent, for a run triggered from a deployment. The shell
 * is last and is the local-development answer.
 *
 * **Null is a legitimate result, so this never throws.** A missing SHA costs a
 * label on a diff; a throw here would take down an eval run that was otherwise
 * about to produce eight perfectly good results. The `exec` is injected for
 * the same reason `now` is everywhere else in this codebase — so the fallback
 * chain is testable without a git repository or a subprocess.
 */
export function resolveGitSha(
  env: Record<string, string | undefined>,
  exec?: GitShaExec,
): string | null {
  const fromEnv = nonEmpty(env.GITHUB_SHA) ?? nonEmpty(env.VERCEL_GIT_COMMIT_SHA);
  if (fromEnv) return fromEnv;

  if (!exec) return null;

  try {
    return nonEmpty(exec());
  } catch {
    return null;
  }
}

/** Runs `git status --porcelain` and returns stdout. May throw. */
export type GitStatusExec = () => string;

/**
 * Whether the working tree held changes its commit does not, or null.
 *
 * A SHA alone cannot say what ran: a run with an uncommitted SOP fix pins the
 * commit before the fix. So the pin also records whether `git status` listed
 * anything. Which paths count is the caller's choice (the runner leaves out
 * the reports directory, which every run writes to). Null, never a throw, for
 * the same reason as `resolveGitSha`: a missing answer costs a label.
 */
export function resolveGitDirty(exec?: GitStatusExec): boolean | null {
  if (!exec) return null;

  try {
    return exec().trim().length > 0;
  } catch {
    return null;
  }
}
