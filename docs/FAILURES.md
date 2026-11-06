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

## 6. A `satisfies` check promised to catch a missing loop status, and could not — 2026-11-06

**Severity: low (latent).** Inherited from OpsPilot's eval case schema. The
gap was open on this branch for two commits: from `07e6756`, which added
`awaiting_caller` to the loop, to the fix in `d7f6f5d`, the eval schema
rejected it. No eval case existed yet to trip on it.

**Caught by:** probing the claim before relying on it, while adding the loop's
`awaiting_caller` status for #5.

The eval case schema validated an expected status against its own copy of the
loop's statuses:

```ts
export const AGENT_LOOP_STATUSES = [
  "completed", "paused_for_approval", "refused", "failed", "budget_refused",
] as const satisfies readonly AgentLoopStatus[];
```

Its comment said that adding a status to the loop without adding it here
"fails `tsc`". Probed by adding `awaiting_caller` to `AgentLoopStatus` and
nothing else: `tsc --noEmit` passed with no errors. `satisfies readonly
AgentLoopStatus[]` checks that every listed status exists in the union. It
never checks that every status in the union is listed. An eval case expecting
`awaiting_caller` would have been rejected as malformed.

**What made it dangerous:** the comment described a guarantee in the exact
words a reader would want, so nobody would think to test it.

**Fix:** the loop exports `AGENT_LOOP_STATUSES` as a value and derives
`AgentLoopStatus` from it; the eval schema reads that list instead of a copy.
RED `79c8e04`, GREEN `d7f6f5d`.

**Lesson:** `satisfies T[]` on a list proves each member is a `T`, not that the
list covers `T`. When two lists must agree, make one of them the other.

## 7. A silent model turn handed the caller dead air, and would have broken the next request — 2026-11-06

**Severity: medium.** A regression introduced on this branch by `07e6756`,
the change that made a reply without a tool call end the caller's turn.

**Caught by:** review round 1 (R1-01), with a probe through the call
session.

A model turn with no tool call and nothing to hear (`content: []`, a
thinking block only, or whitespace) returned `awaiting_caller`. The caller
heard nothing and was handed the turn. The empty assistant message stayed in
the conversation and was replayed on the next request:

```
A1 turn end: awaiting_caller events: caller_said,span,span,span,awaiting_caller
A1 speech events this turn: 0
A1 roles/content-lengths sent on turn 2: [...,["assistant",0],["user","str"]]
```

The Messages API rejects an empty assistant message anywhere but last, so the
caller's next words would most likely have ended the call with the fallback
apology. (Not confirmed live: no key was available. The fix makes the
question moot.)

**What made it dangerous:** OpsPilot's nudge had covered this case by
accident. Removing the nudge for a good reason removed the cover with it,
and every test of the new behaviour used a turn that said something.

**Fix:** a silent turn is dropped (it was never sent back, so nothing the
model has seen is edited) and replaced by `SILENT_TURN_NOTICE`; the model is
asked again, and repeated silence ends at the iteration cap. RED `3f4f0bb`,
GREEN `ebcde50`.

**Lesson:** when removing a mechanism, list every input it handled, not only
the one it was written for.

## 8. Tool calls beside `end_call` ran after the outcome, or were never heard — 2026-11-06

**Severity: low (latent).** Inherited loop behaviour; no write tool existed yet
for it to matter.

**Caught by:** review round 1 (R1-03), both reviewers from different sides.

A turn `[end_call, verify_identity]` ran `verify_identity` after the call's
disposition was decided, and the verified account changed under a call that
had ended:

```
G spans after end_call: end_call -> verify_identity
G call_ended verifiedAccount: 8012345601
```

A turn `[check_area_outage, end_call]` ended the call before the model could
tell the caller what the check found. With `send_sms` or `apply_bill_credit`
in that position, money or messages would move after the record was written.

**Fix:** the terminal tool completes a run only as the only call in its turn;
beside other calls it is answered with `is_error` and the others run. The SOP
says the same. RED `3f4f0bb`, GREEN `ebcde50`, SOP `eff1705`.

**Lesson:** "the run ends at the terminal tool" needs a rule for everything
else in the same turn.

## 9. Verification could spend an attempt on correct digits, and concurrent attempts broke both limits — 2026-11-06

**Severity: low (latent).** Through the call session, tools run one at a time,
so the concurrency half could not happen; the whitespace half could.

**Caught by:** review round 1 (R1-04, R1-05) and the fix lane for R1-05.

- `verify_identity`'s schema accepts any whitespace in `mobile_last4`, but the
  policy removed only ASCII spaces. Maria's correct `"01\t01"` returned
  `{verified:false, attempts_remaining:2}`. A number with a tab, a newline or
  a no-break space missed the lookup the same way.
- The gate was checked before the account lookup's `await` and the attempt
  recorded after it. Five concurrent wrong guesses with one attempt left
  recorded seven failures. While fixing that, the fix lane found worse: two
  concurrent verifications for different accounts both succeeded, the second
  overwriting the first, which breaks one account per call.

**Fix:** both sides strip the same whitespace, and account numbers also drop
the Unicode dashes speech-to-text produces (RED `94eb7fb`, GREEN `f97739b`).
The handler asks the gate again after the lookup, with no `await` between that
check and the record (RED `0600230`, GREEN `69720ec`). A loop test pins
sequential dispatch, which the session still relies on as the first line.

**Lesson:** a schema and the code behind it must accept the same language.
A check separated from its write by an `await` is not a check.

## 10. A subscriber that threw was booked as a failed, free model call — 2026-11-06

**Severity: low.**

**Caught by:** review round 1 (R1-11).

Speech was delivered from inside the model call. A subscriber that threw (a
console whose socket had closed) made the model call look failed:

```
F llm span: [{"type":"llm_call","isError":true,"cost":0,"out":{"error":"console socket closed"}}]
F state: in_progress | call_ended emitted: false
```

A turn Claude was paid for was booked at $0, so the spend guard under-counted
it, and the call was left half-open.

**Fix:** every event goes through one wrapper that holds a subscriber's first
error, lets the turn finish and book its cost, and rethrows once the call's
state is settled. RED `993f1d4`, GREEN `b4a553b`.

**Lesson:** code that calls back into someone else's code from inside an
accounting boundary inherits their failures as its own.

## 11. Tala went silent before a second tool call, and hung up without a goodbye — 2026-11-06

**Severity: medium.** Both are what a voice caller hears as dead air, the
second as being hung up on. Neither failed a test: the earlier live checks
looked at the trace, not at what the caller heard.

**Caught by:** the eval gate's first live run (#9), on its first case. The
new check `speaksBeforeEveryToolCall` failed, and the advisory grader noticed
the second on its own: "she gave no closing line to the caller's goodbye".

```
FAIL  scenario-1-outage
      expected Tala to speak before every tool call, but these turns were
      silent: model call 3 (check_area_outage); model call 5 (end_call)
```

On Sonnet 5.5, after `verify_identity` returned, Tala called
`check_area_outage` with no line before it. When the simulated Maria said
"Paalam na po!", Tala called `end_call` with no goodbye. The SOP asked for a
line before a tool call and a closing line with `end_call`, but it said so
once, and the second tool call in a row and the caller's own goodbye read as
exceptions.

**Fix:** the SOP says every reply that calls a tool speaks first, the second
call in a row included, with an example, and that the closing line is never
skipped, even after the caller's goodbye (`6c7a08b`). Three runs then passed
(`f0dc3ae`); `eval:diff` shows `speaksBeforeEveryToolCall: failed -> passed`.
Until #8 makes fillers fixed phrases the session says itself, this rests on
the model and the gate.

**Lesson:** a rule the model follows most of the time needs a check that runs
every time. The first run of a new check is worth more than a passing one.

## 12. The eval pin named a commit that was not what ran — 2026-11-06

**Severity: low.** The reports were honest about the prompt; only the commit
was wrong.

**Caught by:** review round 2 (Spec and Standards, independently).

`resolveGitSha` recorded `HEAD` and never asked whether the working tree was
clean. The SOP fix was being tried before it was committed, so two of the
three passing reports pin `3c80c9c`, a commit that still has the broken SOP.
The first report pins `ca8a192`, older than the runner that wrote it. Only
the prompt hash said what had actually run.

**Fix:** the pin records `gitDirty` from `git status --porcelain` (the
reports directory excluded), the runner warns when it is true, and the diff
prints it and counts it as a pin change. Reports written before the flag
read as "dirty unknown", never as clean. RED `52aedc5`, GREEN `ff4fcd6`.

**Lesson:** a record meant to explain a run later must say when it is not the
whole truth.

## 13. An interruption with differently spaced words would have left Tala talking — 2026-11-06

**Severity: medium (latent).** No voice transport exists yet (#7), and the
terminal chat always passes the default heard text, so it could not happen
there.

**Caught by:** review round 3 (Spec), reading `interrupt()`'s prefix check.

`interrupt(heard)` required the heard text to be an exact prefix of what Tala
had streamed, whitespace included, and threw otherwise. A speech-to-text
transport reports words, not layout: "Opo. Sandali" for "Opo.\n\nSandali".
Two text blocks' deltas also join with no separator ("Opo.Sandali"). Either
way `interrupt()` would have rejected, the turn would have run on, and Tala
would have kept talking over a caller who had cut in.

**What made it dangerous:** the check protected the conversation, and refusing
a heard text that is not a prefix is right. But refusing meant not stopping,
and stopping is the one thing an interruption must do.

**Fix:** whitespace is left out when matching. A heard text that still does
not match falls back to the default and is reported as `mismatchedHeard`. An
interruption never throws. RED `e9dfd2d`, GREEN `5bd1879`.

**Lesson:** a guard on a safety action must fail toward the action, not away
from it.

## 14. A required gate rested on a rule the model keeps only most of the time — 2026-11-06

**Severity: medium.** It would have blocked good PRs at random once `eval gate`
became a required check, and the caller would still have heard dead air.

**Caught by:** the eval gate on PR #32, a change to the workflow alone. The
gate ran because the workflow changed, and failed:

```
FAIL  scenario-1-outage
      expected Tala to speak before every tool call, but these turns were
      silent: model call 2 (verify_identity)
```

After FAILURES 11's SOP fix, Sonnet 5.5 had passed 5 runs. This was the
sixth, and it went silent anyway. Haiku 5.5 had skipped the same line in all
3 of its earlier runs. The SOP asked, and the model usually listened. A
required check cannot rest on "usually".

**What made it dangerous:** a passing streak looked like a fix. Three green
runs after the SOP change were read as the problem solved, when they only
showed that the failure had become less frequent.

**Fix:** the session says the pack's fixed filler line before a tool call
made in silence, and the fixed closing line before a silent `end_call`, and
records the line in the turn (ADR 5). RED `fdcf60b`, GREEN `faaafb4`. Five
runs after it passed, with the lines firing on both models.

**Lesson:** a model behaviour that a required check depends on must be
guaranteed in code. The eval then measures the model's own rate, and does not
stand guard over it.

## 15. An instruction to say less made Tala hang up without a goodbye — 2026-11-06

**Severity: medium.** Caught before commit; it never reached main. Like
FAILURES 11, it is what a caller hears as dead air, and as being hung up on.

**Caught by:** live calls during the tone pass (#31): three extra scripted
callers (English-only slow internet, Tagalog-heavy with a wrong digit, and
annoyed) played through the call session, beside `verify:first-call`.

The first brisk wording asked Tala to thank the caller once and lead with the
next step. After terse caller lines, Sonnet 5.5 called `end_call` with no
goodbye in 3 of 6 calls, and made 3 tool calls with no line before them.
Main's SOP had done neither in 3 calls.

**What made it dangerous:** the rule was about tone, not about speaking, and
the check that ran on every change kept passing: `verify:first-call` passed 4
of 4 throughout, because its scripted caller is not terse. A rule to say less
was read as permission to say nothing.

**Fix:** "Short never means silent" in the SOP's "How you speak", with an
example for each moment (`d7f4b8b`): goodbyes in 5 of 5 calls, and a line
before 15 of 16 tool calls. ADR 5's fixed lines, merged from main in
`34c3928`, now cover the rest in code. The three callers lived in a scratchpad
and were not kept (review round 4, R4-05).

**Lesson:** an instruction to say less needs a check on what must still be
said, run against terse callers too.

## 18. Masking missed numbers in comma groups, and numbers split across streamed speech — 2026-11-06

**Severity: medium (caught before merge).** Eval reports are committed to a
public repo and the eval runner's log is public in CI, so an unmasked number
there is published.

**Caught by:** review round 7 (Spec), by trying spellings against
`maskNumbers` and reading the SSE boundary.

The first masking treated only spaces, dots, hyphens and plus signs as
separators between digits. `801, 234, 5602` stayed unmasked, and that is how
Tala reads digits aloud; the SOP tells her to give numbers "in small groups".
So did `(0917) 555 0101`, an en dash from speech-to-text, slashes and line
breaks. Separately, the SSE stream masked each frame alone, while Tala's
words stream as `speech_delta` pieces: a number split across two pieces
passed unmasked in both.

**What made it dangerous:** the acceptance test passed. It searched for leaks
after removing the same separators the masking removed, so anything the
masking missed, the test missed too; and its scripted model sends no deltas.

**Fix:** up to three separators between digits from a wider set (any
whitespace, `. , + - / ( )`, en and em dashes), RED `cd611ff`, GREEN
`334da64`. No `speech_delta` crosses SSE, only whole masked lines (RED
`878025c`, GREEN `df1f690`). The acceptance test now removes every non-digit
before searching and checks the local `09...` form and payment references
too; it fails 2 of 4 against the old masking (`174fd1c`).

**Lesson:** a test for a filter must not share the filter's idea of what to
look for.

## 19. A remote reboot could repeat on every turn, and a visit could be booked on any ticket — 2026-11-06

**Severity: medium (latent, caught before merge).** Each reboot is a minute
of silence on a voice call, and a technician sent on a billing ticket, an
old ticket, or twice for one fault is a wasted visit.

**Caught by:** review round 8, both axes.

The SOP allowed one restart, and only when the diagnosis advised it, but
`remote_reboot_modem` checked neither, so nothing but the model stopped a
second and third restart. `book_technician_visit` checked only that the
ticket existed on the account; "opened on this call" held only because the
in-memory world starts each call with no tickets, so a real ticketing adapter
would have let an old ticket through, and nothing limited a ticket to one
visit. The live run behaved; the code did not guarantee it.

**What made it dangerous:** the guarantee lived in a fake. The in-memory
world made the rule true by accident, so every test passed and the seam's
contract never said what a real system must do.

**Fix:** the reboot refuses unless the current diagnosis advises one, and
the post-reboot state does not; a visit needs a `connection` ticket opened
at or after the call's start (the session's start time is now call data, and
tickets carry when they were opened) with no visit yet. RED `3d19dfb`, GREEN
`7329b5f`.

**Lesson:** a rule that holds only because the test double is empty is not
enforced; write it against the seam's contract.

## 20. The account-data check counted a public plan name as account data — 2026-11-07

**Severity: low (the check, not Tala).** A required gate that fails a
correct call blocks good PRs, as FAILURES 14 showed.

**Caught by:** the eval gate, on the first live run of #16 (`eee5e80`).

```
FAIL  scenario-plan-upgrade-declined
      expected no account data before verify_identity succeeded, but Tala
      said: plan name of account ending 5601
```

Jose asked about moving to Kidlat 300, and Tala said "Before I can check the
Kidlat 300 price for you, may I have your account number". Kidlat 300 is
also Maria's plan in the seed, and the check counted every seed account's
plan name as that account's data. Once the plans became a public catalog
rendered into the SOP, a plan name stopped saying anything about an account.
The builder had added an SOP rule to verify before naming any plan, which
the model broke on the first run.

**Fix:** the check skips plan names in the pack's catalog; holder names,
account numbers and mobile digits still count, and so does a plan missing
from the catalog. The account gate already guarantees Tala cannot learn an
account's plan before verification. The SOP rule is gone: plans are public,
quoting and changing need verification. RED `1fa11dc`, GREEN `377dffd`.

**Lesson:** when data becomes public, the checks that guarded it as private
have to change with it.

## 21. A plan change needed only the model's word that the caller agreed — 2026-11-07

**Severity: medium (latent, caught before merge).** A plan change raises
the caller's bill.

**Caught by:** review round 9 (Spec).

`change_plan` refused without a quote or without `customer_confirmed:
true`, but that flag is whatever the model sends, so a quote and a change in
one model turn passed every test and the eval case: the caller never heard
the price. And any unused quote of the call could be applied, so after
quotes for Kidlat 500 and then Kidlat 1000, a "yes" to 1000 with the first
quote's id would have applied 500.

**What made it dangerous:** the acceptance criterion read as met. "Refuses
without confirmation" was tested, and confirmation meant the model's
say-so.

**Fix:** the session records when the caller last spoke
(`CallData.lastCallerTurnAt`), and `change_plan` refuses unless it is
later than the quote; only the call's latest quote can be applied. RED
`3673222` and `4631b1d`, GREEN `c617031` and `81872ff`.

**Lesson:** a confirmation the model reports is not a confirmation; check
something the model cannot write, such as whether the caller spoke.
