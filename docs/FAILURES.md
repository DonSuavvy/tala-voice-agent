# FAILURES.md

A dated log of what broke, how it was caught, and what changed.

The interesting question about a codebase isn't only whether it works. It's
what happened on the way to working, and whether anyone was looking. This file
follows the format of [OpsPilot's](https://github.com/DonSuavvy/opspilot/blob/main/docs/FAILURES.md),
where Tala's engine comes from.

Every entry is a real problem this repository had. Entries that are not defects
(an API trap caught during implementation, a gap in the evidence for a claim)
are labelled as such. An open defect stays listed as open until it is fixed.
A correction to an earlier entry is dated and marked in place, never edited
away.

## How this repo is checked

The core engineering principle is **never trust the model**. A limit is written
into the SOP so Tala can explain it, and enforced again in the tool handler so
the code guarantees it. The model proposes; the code disposes.

The same principle is applied one level up: don't trust the code either, and
don't trust your own review of it.

1. **Test-first for anything with logic.** Policies, tool handlers, eval
   scorers, the SOP compiler, cost accounting and the voice turn logic. The
   failing test is committed on its own (`test: … (RED)`), then the fix
   (`feat: … (GREEN)`), so the RED step is visible in `git log`.
2. **Gates are checked with fresh evidence, never "it passed earlier."**
   `npm test` needs no database and no API key. Checks that do live in
   `scripts/verify-*.ts` and run by hand.
3. **Independent review.** Work is reviewed by agents that did not write it,
   given deliberately skeptical prompts. Each pass is recorded in
   [`REVIEWS.md`](REVIEWS.md).
4. **Every finding is reproduced before it is fixed.** A reviewer saying
   something is broken is a hypothesis until a probe shows it.

## Entry format

```markdown
## N. <what broke, in one line> — YYYY-MM-DD

**Severity: critical | high | medium | low** (add "latent" if nothing
triggered it yet).

**Caught by:** a test, CI, a review pass (link the round in REVIEWS.md), a
voice call, or after the fact.

What happened, with the reproduction: the input, the output, and why it was
wrong.

**What made it dangerous:** optional. Why it could have gone unnoticed.

**Fix:** what changed, with commit hashes.

**Lesson:** the general rule, short enough to remember.
```

## Entries

None yet.
