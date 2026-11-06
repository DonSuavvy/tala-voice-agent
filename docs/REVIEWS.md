# REVIEWS.md

A record of every review pass run against this repository: how it was run,
what it covered, what it found, **what it rejected**, and what it could not
verify.

[`FAILURES.md`](FAILURES.md) answers *what broke*. This file answers *how do
you know you looked*. A defect log with no method behind it is a list of things
that happened to be noticed. A method with no defects found can't be checked.
Together they can: a reader can test the coverage claims against the commands,
and the rejections against the evidence.

The rejections are the part worth reading. Acting on every finding a reviewer
produces is dictation, not review. The judgement is in which findings survive
contact with the actual code.

The format follows [OpsPilot's](https://github.com/DonSuavvy/opspilot/blob/main/docs/REVIEWS.md).

## Round format

```markdown
## Round N — YYYY-MM-DD — <scope in a few words>

**Question asked:** what this pass was looking for that earlier ones weren't.

**Headline:** the most important result, and the suite size before → after.

**Method:** who reviewed (which agent, which prompt), what they were given,
and how each finding was reproduced before it was fixed.

### Findings ledger

| ID | Severity | Finding | Where | Status |
|---|---|---|---|---|
| RN-01 | High | … | `path/to/file.ts` | Fixed `abc1234` |
| RN-02 | — | … | … | **Rejected**: why |

### RN-01 — <title>

The finding, the reproduction, the fix.

### Rejected

Findings that did not survive reproduction, and the evidence.

### Not verified

What this pass could not check, and why.
```

## Rounds

## Round 1 — 2026-11-06 — ticket #5, the first text call

**Question asked:** before the branch for #5 goes up for review, can a caller
or the model get around the account gate, the verification limit, the
opening disclosure or `end_call`; does the call session's event stream and
conversation hold up against the real API's rules; and does what Claude reads
(the SOP, tool descriptions) and what the docs claim match what the code does?

**Headline:** no critical or high finding. Two medium: a silent model turn
handed the caller dead air and would have broken the next request (R1-01, a
regression this branch introduced), and the call's pin could not tell apart
calls run under different policies (R1-02). 20 findings fixed, 1 rejected.
The suite went from 479 to 524 tests.

**Method:** two independent agents that had not written the code, run in
parallel on `main...feat/first-text-call` at `1217553`.

- **Code and security** (Opus): hunt for gate bypasses, limit overruns,
  event-stream and history defects, loader holes, prototype-key lookups and
  tautological tests. Every finding had to come with a probe (a Vitest test or
  a tsx script, deleted afterwards) and its quoted output.
- **Prompts and docs** (Sonnet): check the SOP and the tool descriptions
  against the handlers, the persona lines for speech, and every claim in the
  README, ADRs, glossary, FAILURES and commit messages against the code.

The orchestrator did not act on a report as written. Each fix was built
test-first by a fix lane (three in parallel on disjoint files, plus two
lanes kept by the orchestrator). Every RED commit was proven to fail against
the implementation at `HEAD` before its GREEN commit landed.

### Findings ledger

| ID | Severity | Finding | Where | Status |
|---|---|---|---|---|
| R1-01 | Medium | A turn with nothing to hear ended the caller's turn in silence, and its empty assistant message was replayed | `agent/loop.ts` | Fixed `3f4f0bb` `ebcde50` (FAILURES 7) |
| R1-02 | Medium | The pin named pack, SOP version and logical model only: a policy edit left two different calls with identical pins | `call/session.ts` | Fixed `8c7b96d` `993f1d4` `b4a553b` |
| R1-03 | Low | Tool calls beside `end_call` ran after the outcome, or their result was never heard | `agent/loop.ts`, SOP | Fixed `3f4f0bb` `ebcde50` `eff1705` (FAILURES 8) |
| R1-04 | Low | Schema accepted any whitespace in the last 4 digits; the policy stripped only spaces, so correct digits spent an attempt | `policy/identity.ts` | Fixed `94eb7fb` `f97739b` (FAILURES 9) |
| R1-05 | Low | Concurrent `verify_identity` calls exceeded the limit; the fix lane found two accounts could both be verified | `tools/verify-identity.ts` | Fixed `0600230` `69720ec` (FAILURES 9) |
| R1-06 | Low | After the lock, `check_area_outage` told the model to verify again | `tools/check-area-outage.ts` | Fixed `ce64274` `38e407e` |
| R1-07 | Low | A malformed placeholder (`{{x}`, `{{ x y }}`) loaded and reached the model verbatim | `agent/sop.ts`, `pack/load-pack.ts` | Fixed `8f386b4` `2394275` |
| R1-08 | Low | One JSON syntax error in the Kidlat pack hid every other problem and named no file | `packs/kidlat-fiber/src/index.ts` | Fixed `2f9e2a2` `e0569d4` |
| R1-09 | Low | The loader's own id, version and body checks passed `undefined` and threw TypeErrors | `pack/load-pack.ts` | Fixed `8f386b4` `2394275` |
| R1-10 | Low | Unbounded outage offsets loaded, then failed mid-call with "Invalid time value" | `systems/seed-world.ts` | Fixed `95b055b` `eb91fb8` |
| R1-11 | Low | A throwing event subscriber was booked as a failed, $0 model call; no `call_ended` | `call/session.ts` | Fixed `993f1d4` `b4a553b` (FAILURES 10) |
| R1-12 | Low | The disposition summary accepted account and phone numbers it is told not to carry | `call/disposition.ts` | Fixed `34d590f` `0cfa1e5` |
| R1-13 | Low | The live check compared the raw tool input, so a dashed account number failed a success | `scripts/verify-first-call.ts` | Fixed `669c7db` |
| R1-14 | Low | The SOP's filler line, said without a tool call in the same reply, ended the turn | SOP v1 | Fixed `eff1705` |
| R1-15 | Low | No guidance for speaking an outage reference or a time with its day and date | SOP v1 | Fixed `eff1705` |
| R1-16 | Low | `account_status` returned with no instruction for a suspended or disconnected account | SOP v1 | Fixed `eff1705` |
| R1-17 | Low | `verify_identity`'s description did not say a repeat call skips the digit check | `tools/verify-identity.ts` | Fixed `0600230` `69720ec` |
| R1-18 | Low | `persona.agentName` was required and read by nothing | `pack/load-pack.ts` | Fixed `8f386b4` `2394275` |
| R1-19 | Low | FAILURES 6 overstated, ADR 2 said "only data", README placed the workspace table under "Talk to Tala" and claimed an unmeasured cost | docs | Fixed in the docs commit |
| R1-20 | Low | The glossary's "avoid" lists forbade words the code uses for the same concept (session, chat, area, customer) | `GLOSSARY.md` | Fixed in the docs commit |
| R1-21 | — | `check_area_outage` promises "ongoing" outages, but only the seed guarantees it | `tools/check-area-outage.ts` | **Rejected**: see below |

### Rejected

**R1-21.** "Ongoing outages that include this barangay" is the contract of
`NetworkOperations.outagesAffecting` (`systems/types.ts`), which every adapter
implements; the handler relies on its port, as every handler does. The
in-memory adapter satisfies it by construction: the seed schema requires
outages to start before the call and end after it, now bounded at 30 days
(R1-10). A real adapter that returned ended outages would be the adapter's
bug, caught by its own tests, not something to re-filter in every tool.

**Preferences, not findings** (recorded, deferred): the opening line ends on
"for quality" and is four sentences; the fallback line is Tagalog for an
English caller; spoken replies have no `max_tokens` cap below 8,192. The voice
audition (#3), streaming (#6) and the cached phrases (#8) are where these get
decided with audio.

### Not verified

- **No live API call has been made.** R1-01's 400 on an empty assistant
  message is from the API's documented rule, not observed; the fix prevents
  the message either way. Whether Opus 5.5 returns a one-sentence filler before
  a tool call as text or as a progress-update thinking block is open, and
  `npm run verify:first-call` prints each turn's block types to answer it.
- **Per-account lockout across calls** does not exist: a caller gets 3 tries
  per call, not per account. A design question for the demo's limits (#22).
- **Server-side refusal fallback** is not wired. It needs cost accounting by
  the model that actually served a turn, since a fallback turn is billed at
  another model's rates; no ticket owns it yet.


## Round 2 — 2026-11-06 — ticket #9, the eval harness and CI gate

**Question asked:** does the branch follow the repo's documented standards,
and does it do what #9 asks, criterion by criterion?

**Headline:**
- **Standards:** three hard violations, all fixed: a wire model id in a
  test, comments that overstated the cost cap and the CI upload, and no
  FAILURES entries.
- **Spec:** one item still open, by plan: the deliberately broken SOP PR,
  which also needs the gate as a required check. The worst defect: the pin
  named commits that were not what ran (R2-01, FAILURES 12).

17 findings: 14 fixed, 1 recorded, 2 open (the gate demo).

**Method:** the mattpocock `code-review` skill. Two independent Opus agents
that had not written the code, in parallel on `main...feat/eval-harness` at
`f0dc3ae`:

- **Standards:** CLAUDE.md, DESIGN §11, ADR 2, GLOSSARY, FAILURES 6, and a
  fixed list of Fowler smells.
- **Spec:** issue #9 line by line, the committed reports, and `eval:diff`
  run on them.

Fixes were built by the branch's builder, test-first where behaviour
changed, and committed after a fresh gate.

### Findings ledger

| ID | Axis | Finding | Status |
|---|---|---|---|
| R2-01 | Spec | No dirty check on the pin: two passing reports pin `3c80c9c`, which lacks the SOP fix that ran | Fixed `52aedc5` `ff4fcd6` (FAILURES 12) |
| R2-02 | Spec | The grader's spend budgeted later cases, so "can never fail a run" was not true by construction | Fixed `3e12109` `f697061` |
| R2-03 | Spec | The CI paths missed `core/src/systems/**`, which the tools act through | Fixed `2570436` (and `package-lock.json`) |
| R2-04 | Spec | The filter is wider than "only prompts, the SOP, policies or tools" | Fixed: the workflow header says why (`2570436`) |
| R2-05 | Spec | `51fd0e1` turned a limit of the account-data check into a product rule | Fixed: DESIGN §11 (`bec0295`) |
| R2-06 | Spec | The SOP version is a label, so an SOP edit does not change it | Fixed: DESIGN §11 (`bec0295`); the prompt hash tells runs apart |
| R2-07 | Spec | "Blocked" needs the eval gate as a required check | Open: a repository setting for the owner, with R2-08 |
| R2-08 | Spec | The deliberately broken SOP PR and its screenshot | Open: next, with the owner |
| R2-09 | Standards | `claude-sonnet-5-5` in `score.test.ts` | Fixed `84c020b` |
| R2-10 | Standards | Comments overstating: "capped at $1.00 per run", "this run's report only", an interrupted model call that does not exist on this base | Fixed `f697061` `2570436` `84c020b` |
| R2-11 | Standards | No FAILURES entries for what the gate caught | Fixed `6396a5c` (FAILURES 11, 12) |
| R2-12 | Standards | Pin fields and the model list copied by hand (the FAILURES 6 pattern) | Fixed `44b66a8` `84c020b`: two-way type guards |
| R2-13 | Standards | The grader's prompt copied the SOP's language rules | Fixed `ee7cc10` `bb9d60d`: it reads the pack's "How you speak" |
| R2-14 | Standards | A Kidlat case test inside `packages/evals` | Fixed `84c020b`: moved to `test/` |
| R2-15 | Standards | The SOP's goodbye example used scenario 1's caller name | Fixed `bec0295` |
| R2-16 | Standards | Duplicated error text and pricing; "utterance" and "holder name"; an unnamed skill | Fixed `84c020b` |
| R2-17 | Standards | `9ee821c` says "29 removed as listed in the RED commit"; the RED lists 15, and the other 14 were rewritten | Recorded here; commit messages are not rewritten |

### Left as they are

- **Possible Middle Man:** `parseCaseFiles` only calls `parseEntries`, but
  it is the public form that takes files in memory, which the tests use.
- **Possible Speculative Generality:** `pausesFor` cannot pass until in-call
  approvals arrive (#13); it is kept so #13's cases need no schema change.
- **`agentRunId` holds the call id.** It is OpsPilot's persisted row shape;
  renaming waits for the persistence layer (#18).
- **A new seam, `GradeCreator`:** structured output needs `output_config`,
  which the loop's `MessageCreator` does not carry.
- **A pricing test that let "price every grade as Sonnet" through** was
  caught by the builder's own mutation check before it was committed
  (`6c82583`), so it is noted here and not in FAILURES.

### Not verified

- **The workflow on GitHub:** the paths negation for committed reports, a
  failed step's output reaching the upload step, and the secret. This PR
  exercises them.
- **The commit a CI report pins:** on `pull_request` runs, `GITHUB_SHA` is
  GitHub's temporary merge commit, not the PR's head.
- **The deliberately broken SOP PR.**
