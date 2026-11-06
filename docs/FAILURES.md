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

## 1. An SOP placeholder could resolve to an Object method — 2026-11-06

**Severity: low (latent).** Inherited from OpsPilot's compiler. No shipped SOP
used the names, but nothing stopped one from doing so.

**Caught by:** reading the code while generalizing it for #4, then confirmed
with a probe before the fix.

`compileSop` looked a placeholder up with `RENDERERS[name]`. The renderers are
a plain object, so a name that `Object.prototype` supplies got past the "known
placeholder" check. Probed with the lookup OpsPilot shipped:

```
{{toString}}        renders "[object Undefined]"
{{constructor}}     renders "[object Object]"
{{valueOf}}         TypeError: Cannot convert undefined or null to object
{{hasOwnProperty}}  TypeError: Cannot convert undefined or null to object
{{__proto__}}       TypeError: r is not a function
```

**What made it dangerous:** the first two do not fail at all. They put text
into the system prompt that nobody wrote, the exact outcome the compiler's
"throw on an unknown placeholder" rule exists to prevent. The other three
throw the wrong error, so the message never names the bad placeholder.

**Fix:** `Object.hasOwn(renderers, name)` before the lookup. RED `c3e1056`,
GREEN `45b6dec`. The provider's model mapping got the same guard.

**Lesson:** this is OpsPilot's FAILURES #18 again, in a different function.
When a bug class is found once, grep for it everywhere a plain object is used
as a lookup table.

## 2. The eval scorer wrote "[object Object]" into failure messages — 2026-11-06

**Severity: low (latent).** Inherited from OpsPilot's scorer.

**Caught by:** typescript-eslint's `no-base-to-string`, the first time the
engine was linted with type information (see entry 4).

`score()` read the terminal tool's `action` and `reply` with `String(...)`. An
object-valued field became `"[object Object]"`, so the failure sentence a
reviewer reads said `got "[object Object]"`, and a phrase inside an object
reply could never be found.

**Fix:** `asText()`: strings as they are, missing as `""`, anything else as
JSON. RED `b567089`, GREEN `ca16f0b`.

**Lesson:** a failure message is product. Test what it says when the input is
the wrong shape, not only when it is the wrong value.

## 3. OpsPilot's prices did not fit the 5.5 models, and a reference disagreed with the source — 2026-11-06

**Severity: medium.** Would have mispriced every Opus 5.5 and Sonnet 5.5 cache
hit, and under-priced any Haiku 5.5 prompt over 100,000 tokens by 5x. The spend
guard reads those prices, so under-pricing is the direction that lets spend
through.

**Caught by:** checking the rate card against the live pricing page before
writing it, as CLAUDE.md requires, rather than from the claude-api skill alone.

Two assumptions in OpsPilot's `rateCard` did not survive the move to the 5.5
models:

- **Cache hits are 0.05x input on Opus 5.5 and Sonnet 5.5**, not 0.1x. OpsPilot
  derived every cache read as `input / 10`.
- **Haiku 5.5 has two rate cards.** A request whose prompt is over 100,000
  tokens pays $0.50/$2.50 instead of $0.10/$0.50. The prompt counts cache reads
  and writes, and output is billed at the higher rate too. OpsPilot's
  `costOf` had one card per model.

And one reference was wrong: the claude-api skill gives Sonnet 5.5 cache reads
as $0.20/MTok, while the live pricing page says $0.10/MTok (0.05x of $2). The
page is the source, so the card follows it.

**Fix:** `rateCard` takes a `cacheReadDivisor` and an optional long-prompt
card; `costOf` picks the card per request and reports `longPrompt`. Every
figure in the tests is a literal from the pricing page, not a multiple computed
in the test. Prices that do not land on whole nanos now throw instead of
becoming floats. RED `c2e3fdc`, GREEN `7865644`.

**Lesson:** a derivation rule ("cache hits are a tenth") is a claim about every
future model. Pin prices as literals from the source, per model.

## 4. OpsPilot's code had never been linted with type information — 2026-11-06

**Not a defect in itself:** a gap in what had been checked. One real bug was
inside it (entry 2).

**Caught by:** running Tala's `npm run lint` over the imported engine.

OpsPilot linted with `eslint-config-next`, which does not use type information.
Tala uses typescript-eslint's type-checked rules (#2). The imported engine had
49 errors, 44 in core and 5 in evals:

- 19 unnecessary type assertions (18 core, 1 evals), removed by `eslint --fix`
  with no type change
- 18 `require-await` errors in test fakes written as `async () => value`, now
  allowed in `*.test.ts` only
- 2 `unknown | null` unions, where `unknown` already includes `null`
- 5 unsafe-`any` errors from three untyped `JSON.parse` / `structuredClone`
  results in the loop tests
- 1 `any` returned from the array branch of `trace.ts`'s `stripNuls`
- 2 unsafe-`any` errors from `Object.values` over the diff's buckets, which
  TypeScript types as `any[]`
- 2 `no-base-to-string` errors, which were entry 2

**Fix:** `f8d2c0b` (core) and `002d172` (evals).

**Lesson:** "it passed lint" means as much as the lint config. Code imported
from another project has been checked by that project's rules, not yours.

## 5. Two slips in the mechanical renames, caught before commit — 2026-11-06

**Not committed.** Recorded because the way they were caught is the point.

1. A regex meant to set aside two new scorer tests also deleted the original
   test after them, "says so plainly when a completed run produced no
   outcome". Caught because the suite reported 319 tests where 320 were
   expected; the file was restored from a copy and the two tests removed by
   exact text instead.
2. A renamed fixture error message ("refund exceeds the policy window" became
   "credit exceeds the policy limit") left its assertion matching
   `/policy window/`. Caught by the test run.

The same pass also misstated two counts in commit messages: commit `f8d2c0b`
says 13 Bedrock provider tests were removed (it was 12, one test was
retargeted), and commit `2cc5ebc` calls the 148 removed `it` blocks "test
cases" (some are parameterized and expand to more). The ADR and the PR carry
the corrected figures; the commits are left as written.

**Lesson:** after any scripted edit to tests, compare the test count with the
number you expect before committing. A regex that deletes a test produces a
green suite.
