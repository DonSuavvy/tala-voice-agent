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

## Round 3 — 2026-11-06 — ticket #6, streaming and interruption

**Question asked:** does the branch follow the repo's documented standards,
and does it do what #6 asks, criterion by criterion?

**Headline:** no hard violations and no missing requirements. One medium
finding: an interruption whose heard text differed in whitespace from what
streamed would have thrown and left Tala talking (R3-01, FAILURES 13). 11
findings fixed or recorded, 4 left as they are.

**Method:** the mattpocock `code-review` skill. Two independent Opus agents
that had not written the code, in parallel on `main...feat/streaming-interruption`
at `6b12403`:

- **Standards:** CLAUDE.md, DESIGN §11, GLOSSARY, the ADRs, and a fixed list
  of Fowler smells, each a judgement call.
- **Spec:** issue #6 line by line, re-running each RED commit's tests in
  scratch copies to confirm they fail.

Fixes were built test-first by the branch's builder and committed after a
fresh gate.

### Findings ledger

| ID | Axis | Finding | Status |
|---|---|---|---|
| R3-01 | Spec | `interrupt(heard)` needed exact whitespace; a mismatch threw and Tala kept talking | Fixed `e9dfd2d` `5bd1879` (FAILURES 13) |
| R3-02 | Spec | The exact-usage test could not tell final cache counts from early ones | Fixed `fcad0de`; two mutations show it bites |
| R3-03 | Spec | A shorter heard text once tools ran cuts nothing, against "the history keeps only the text Tala actually spoke" | Recorded as deliberate: ADR 4 (`f492215`) |
| R3-04 | Spec | The chat commit has no RED | Recorded: scripts are not on the test-first list; checked live |
| R3-05 | Standards | `claude-haiku-5-5` hard-coded in two session tests | Fixed `9195bec` |
| R3-06 | Standards | A new fake below the seam (the real SDK client over a fake `fetch`) not in DESIGN §11 | Fixed `f492215` |
| R3-07 | Standards | Comments promising more than the code: speech always after its deltas; every interrupted call booked at least the estimate | Fixed `9195bec` |
| R3-08 | Standards | "utterance", which the glossary avoids | Fixed `9195bec`; GLOSSARY gains Line |
| R3-09 | Standards | Stale "#6" notes in ADR 1 and DESIGN | Fixed `f492215` |
| R3-10 | Standards | Possible Duplicated Code: three copies of the spoken-text rule | Fixed `9195bec` |
| R3-11 | Standards | Possible Mysterious Name: `streaming`, `streamed`, `modelCalls` side by side | Fixed `9195bec` (one `currentModelCall` record) |

### Left as they are

- **Possible Shotgun Surgery:** what an interrupted turn keeps is decided in
  three places. The creator drops unfinished blocks, the session cuts at the
  heard text, and the loop keeps a turn only with spoken text or a finished
  tool call. Each layer knows only its own part (the SDK's stream, the
  caller, the conversation), and ADR 4 lists the rules in one place.
- **Possible Data Clumps:** `AgentLoopInput` takes `signal` and `onTextDelta`
  as two fields.
- **Possible Middle Man and Duplicated Code in `chat.ts`:** `untilTalaIsDone`,
  and two identical error prints. A script; not worth a type.
- **Round 1's three preferences** were left to streaming (#6), which did not
  decide them. The English-led change (`aaf4eed`) made the fallback line
  English and the opening three sentences. A `max_tokens` cap for spoken
  replies goes to the voice audition (#3) and cached phrases (#8).

### Not verified

- What a real voice transport reports as heard (#7).
- An interrupted turn with citations or server tools: Tala has neither.
- Interrupted calls are over-booked: the $0.02 estimate against about
  $0.0004 spent on Haiku 5.5. #22 re-measures the estimate.

## Round 4 — 2026-11-06 — PR #31, the tone pass

**Question asked:** does the tone pass follow the repo's documented standards,
and does it do what its task asked, no more and no less? It had no ticket: the
task was a side session's brief, and Sebastian's asks recorded there ("no
'Naku', no 'Walang anuman', Taglish mix as is, brisk and efficient, brisker
opening").

**Headline:** nothing blocking. The worst Standards finding: the advisory
grader still scored tone as "warm", so a brisk Tala could be marked "curt"
(R4-01). The worst Spec finding: "leave out details they did not ask for"
pulled against giving an outage's cause, which spec story 11 asks for
(R4-02). 13 findings: 5 fixed, 6 left as they are, 1 open, 1 rejected. Tests
739 → 740.

**Method:** the mattpocock `code-review` skill. Two independent Opus agents
that had not written the change, in parallel on `main...feat/tala-tone` at
`a6b1c18` (merge-base `afc366e`):

- **Standards:** CLAUDE.md, DESIGN §5 and §11, GLOSSARY, the ADRs, the
  FAILURES and REVIEWS formats, and a fixed list of Fowler smells, each a
  judgement call. Told to look at code that consumes the changed text.
- **Spec:** the side session's brief verbatim, Sebastian's recorded asks,
  spec #1 and #17, DESIGN §5 and §11, and the ADRs.

The orchestrator re-read each cited line on the branch before acting. Fixes
were made by the orchestrator, the grader test-first.

### Findings ledger

| ID | Axis | Finding | Status |
|---|---|---|---|
| R4-01 | Standards | The grader's rubric hard-codes tone as "warm, calm and natural", with "cold, curt or robotic" as the worst, against DESIGN §11's "against the company pack's own rules" | Fixed `d2a39e6` `24f2105` |
| R4-02 | Spec | "Leave out details they did not ask for" read as dropping the outage cause: the grade on `a6b1c18` called it "extra detail the caller didn't need" | Fixed `20cbf1c` |
| R4-03 | Spec | Rounding an estimated time up to the quarter hour: not asked for, bends "never invent times", and only the prose enforces it | Fixed `20cbf1c`: dropped. See "After the fixes" |
| R4-04 | Standards | No FAILURES entry for the regression tuning caught (the first brisk wording hung up silently in 3 of 6 calls) | Fixed `fa1e82c` (FAILURES 15) |
| R4-05 | Standards | The PR's evidence table rests on three scripted callers that were never committed | Left: a tuning aid; the spec's simulated callers (about 13) are where such callers belong |
| R4-06 | Standards | The rounding rule types a figure ("quarter hour") into the SOP and says "estimated time", not the glossary's term | Fixed with R4-03 |
| R4-07 | Standards | Possible Duplicated Code: the goodbye example appears word for word in "How you speak" and "Ending the call" | Left: FAILURES 11 repeats the rule in both places on purpose |
| R4-08 | Standards | `closingLine` keeps "Ingat po!" though the opening line dropped its exclamation mark | Left: a goodbye can be warmer than a disclosure |
| R4-09 | Standards | The merge's semantic clash, "Walang anuman" back in an SOP example, has no FAILURES entry | Left: caught and fixed in the merge itself (`34c3928`), and its message says so |
| R4-10 | Spec | Spec #1 story 4 still says "a warm tone" | Open: an edit to the spec issue, for the owner |
| R4-11 | Spec | "No line breaks" was not asked for | Left: harmless for speech, and the PR body explains it |
| R4-12 | Spec | The "brisker" opening is 25 words against 26: register, not length | Left: the owner chose it while tuning |
| R4-13 | Spec | The eval report is a file outside the task's three | **Rejected**: committing reports is the convention since #30 |

### After the fixes

`npm run eval` on `fa1e82c`, clean tree: gate PASS 1 of 1, advisory tone 5,
Taglish 5, politeness 5. The grader noted "she gave the outage cause and
restoration time without extras". `verify:first-call` passed 4 of 4, and Tala
said the tool's "10:47 PM" exactly.

In the eval, though, Tala said "around 10:45 tonight". The run started at
6:46:45 PM Manila time and the seed sets restoration 240 minutes after the
call starts, so the tool most likely said 10:46 or 10:47 PM: she rounded
earlier by a minute or two. With no rule, the model rounds on its own, and
downward is what the dropped rule was guarding against. Main's SOP behaves
the same. Rounding belongs in the tool's result, in code, if it is wanted.

### Not verified

- Whether Sebastian approved the rounding in the tone session: his answers
  there are not in the transcript that could be read.
- The tool's exact time in the eval run: reports do not keep tool results, so
  "10:46 or 10:47 PM" is inferred from the run's start and the seed.
- The PR's results with the three extra callers (R4-05).

## Round 7 — 2026-11-06 — ticket #10, the payment scenario

**Question asked:** does the branch follow the repo's documented standards,
and does it do what #10 asks, criterion by criterion: five tools, SMS only to
the number on file, masking of everything stored or logged, scenario 2?

**Headline:** no account tool runs before verification or for another
account, and `send_sms` has no field for a number. The worst findings were in
masking: numbers in comma groups (how Tala reads digits), brackets, dashes
and line breaks stayed unmasked, and streamed speech could carry a number
past the SSE masking in two pieces (FAILURES 18). The scenario 2 eval case
would also have passed a broken scenario 2. 16 findings: 12 fixed, 3 left,
1 recorded. Tests 740 → 911.

**Method:** the orchestrator replayed the builders' slices as RED/GREEN
commits, checking each RED fails, and ran `npm run eval` live (both
scenarios), then grepped the stored report and the runner's log for every
seed number with all separators removed. Then the mattpocock `code-review`
skill: two independent Opus agents that had not written the code, in
parallel on `main...feat/payment-scenario` at `911ada9`. Standards:
CLAUDE.md, ADRs 2, 3 and 5, DESIGN §6 and §11, GLOSSARY, earlier findings.
Spec: #10 line by line, spec #1, DESIGN §6 and §12, SECURITY.md, with the
live evidence given to it.

### Findings ledger

| ID | Axis | Finding | Status |
|---|---|---|---|
| R7-01 | Standards | "Never put an account or mobile number in a text" was in the SOP and a schema description only, not the handlers | Fixed `42841fe` `f98cf92`: both handlers refuse the verified account's numbers in any spacing |
| R7-02 | Standards | Comments that promised more than the code (`types.ts`, `in-memory.ts`, `seed-world.ts`) | Fixed `50a2e8c` |
| R7-03 | Standards | Glossary slips: "choosing that number is the caller's job"; "reflected", which Posted lists under Avoid | Fixed `50a2e8c` `6f968b0` |
| R7-04 | Standards | Possible Duplicated Code: four not-found throws, four `account_number` schemas, three money formattings | Fixed `50a2e8c`: the gate returns the account; one input; `formatCompanyMoney` |
| R7-05 | Standards | Hand-copied values: the report's masking note, `slice(-4)`, the seed's `Collection` union | Fixed `0710199` `50a2e8c` |
| R7-06 | Standards | An SOP example used scenario 2's GCash payment (R2-15) | Fixed `6f968b0`: a Maya payment |
| R7-07 | Standards | Possible Mysterious Name: `MAX_OFFSET_MINUTES` beside `MAX_BILLING_OFFSET_MINUTES` | Fixed `50a2e8c`: `MAX_OUTAGE_OFFSET_MINUTES` |
| R7-08 | Standards | Core tool descriptions repeat SOP rules | Left: the existing tools do the same |
| R7-09 | Standards | Philippine payment channels live in core (ADR 2) | Left: DESIGN §6 names them, like the `+639` mobile rule |
| R7-10 | Standards | Ten RED commit messages repeat the GREEN text and give no failure reason | Recorded here; commit messages are not rewritten |
| R7-11 | Spec | The masking acceptance test could not see a leaked local `09...` mobile, and searched with the masking's own separators | Fixed `174fd1c` |
| R7-12 | Spec | Masking missed commas, brackets, dashes, slashes and line breaks | Fixed `cd611ff` `334da64` (FAILURES 18) |
| R7-13 | Spec | The scenario 2 case passed with `verify_payment` finding nothing, a ticket in the wrong category, or the text sent first | Fixed `b670235` `6e499ed`: `toolsCalledInOrder` and `toolResults` |
| R7-14 | Spec | Every run of 10+ digits is masked, so a numeric date and time would be too | Left: intended; tools say dates in words |
| R7-15 | Spec | The SSE stream masked frame by frame, and speech deltas could split a number | Fixed `878025c` `df1f690` (FAILURES 18): no deltas over SSE |
| R7-16 | Spec | Tala said "I've noted the scheduled disconnection date in it", and the SOP never said what ticket notes hold | Fixed `6f968b0`: the SOP lists them and limits how she describes a ticket |

### Not verified

- What Tala wrote in a ticket's notes on a live call: reports do not keep
  tool inputs. The stricter case checks the category, not the notes.
- How a voice reads "₱1,299.00" and spoken dates (#3, #7).

## Round 8 — 2026-11-06 — ticket #11, the slow-internet scenario

**Question asked:** does the branch follow the repo's documented standards,
and does it do what #11 asks: four tools, a booking linked to its ticket,
slots from the area's calendar, the reboot's wait and re-check from the seed
with an injected clock, scenario 3?

**Headline:** the SOP's limits on the reboot and the booking were not in the
handlers, so a reboot could repeat and a visit could go on any ticket, and
"opened on this call" held only because the fake world starts empty
(FAILURES 19). The SOP also typed a figure the code disagreed with ("up to
three" against four), and the scenario 3 case could pass a run that skipped
the outage check or booked another slot. 16 findings: 14 fixed, 1 left, 1
recorded. Tests 911 → 1038.

**Method:** the orchestrator replayed the builder's slices as RED/GREEN
commits (the replayed tree matched the builder's), ran `npm run eval` live
(3 of 3; the reboot waited 60 real seconds), and checked masking on the
report and log. Then the mattpocock `code-review` skill: two independent
Opus agents that had not written the code, in parallel on
`feat/payment-scenario...feat/slow-internet` (the branch is stacked on #10).
Standards: CLAUDE.md, ADRs 2 and 4, DESIGN §6 and §11, GLOSSARY, rounds 5-7.
Spec: #11 line by line, spec stories 15-17, DESIGN §6 and §12, with the live
evidence given to it.

### Findings ledger

| ID | Axis | Finding | Status |
|---|---|---|---|
| R8-01 | Spec | The scenario 3 case passed a run that skipped the outage check or booked a slot the caller did not pick | Fixed `52e2773` `a8fdac3` |
| R8-02 | Spec | "Opened on this call" held only because the in-memory world starts empty; a billing ticket could carry a visit | Fixed `3d19dfb` `7329b5f` (FAILURES 19) |
| R8-03 | Spec, Standards | The reboot ran whatever the diagnosis advised, so it could repeat | Fixed `3d19dfb` `7329b5f` (FAILURES 19); consent stays in the SOP, the tool being auto-write |
| R8-04 | Spec | One ticket could get several visits | Fixed `3d19dfb` `7329b5f` |
| R8-05 | Spec | An SOP example named weekdays no tool returned, and nothing forbade promising a fix or an arrival time | Fixed `a8fdac3` |
| R8-06 | Standards | The SOP said "up to three" while the tool returned four; its guard caught only digits; the description typed "four" | Fixed `52e2773` `a8fdac3`: three, from `MAX_SLOTS`; no number in the SOP; number words guarded |
| R8-07 | Standards | References took the UTC year, not the call's year in the company's zone | Fixed `3d19dfb` `7329b5f` |
| R8-08 | Standards | Glossary drift: "line check", Fault and Outage overlapping, "dispatch" | Fixed `861d815` |
| R8-09 | Standards | Hand-copied bounds ("like the outages") and `SECOND_MS` twice | Fixed `861d815`: one network bound, one time-units module |
| R8-10 | Standards | Possible Duplicated Code: the no-modem error in two tools | Fixed `861d815` |
| R8-11 | Standards | Possible Shotgun Surgery: 33 `"Asia/Manila"` literals and repeated wait stubs across core tests | Fixed `861d815`: fixture helpers |
| R8-12 | Standards | Possible Feature Envy: one tool imported another's spoken diagnosis | Fixed `861d815`: a shared diagnosis module |
| R8-13 | Standards | A comment said bundling the re-check controls what the model says | Fixed `861d815` |
| R8-14 | Standards | `TicketRecord.category` was never read | Fixed `7329b5f`: the booking reads it |
| R8-15 | Standards | `TicketRecord.notes` is never read | Left: stored ticket data a real system uses |
| R8-16 | Standards | Two RED commits hold guards that already passed, and RED messages repeat the GREEN text | Recorded here (R6-14, R7-10) |

### Not verified

- Whether Tala ever reads the SOP's bracketed example aloud ("[the first
  window]"); the live run read the tool's windows.
- How a minute of silence during a reboot sounds on a voice call (#8 fillers).

## Round 9 — 2026-11-07 — ticket #16, plan changes and help articles

**Question asked:** does the branch follow the repo's documented standards,
and does it do what #16 asks: `change_plan` refusing without a matching
quote or confirmation, proration in pure code, ranked help articles, and
the three cases?

**Headline:** the first live run failed 2 of 6, both in the checks: the
account-data check treated public plan names as private (FAILURES 20), and
the help case required a word for a different situation. The reviewers then
found that "confirmation" was the model's word and an older quote could be
applied (FAILURES 21), that a downgrade switched the plan at once, and that
plan-change timing, the knowledge base and price caps were not where DESIGN
and ADR 1 put them. 20 findings: 19 fixed, 1 recorded. Tests 1038 → 1208.

**Method:** the orchestrator replayed the builder's slices as RED/GREEN
commits (both replays matched the builder's trees), ran `npm run eval`
live (4 of 6, committed as the record, then 6 of 6), and checked masking.
Then the mattpocock `code-review` skill: two independent Opus agents on
`feat/slow-internet...feat/plan-changes` at the failing report (the branch is
stacked on #11). Standards: CLAUDE.md, ADRs 1 and 2, DESIGN §6 and §11,
GLOSSARY, rounds 6-8. Spec: #16 line by line, spec #1, DESIGN §6, with the
live evidence; it ran a copy of the ranker on Taglish queries.

### Findings ledger

| ID | Axis | Finding | Status |
|---|---|---|---|
| R9-01 | Live | The account-data check counted a catalog plan name as Maria's data | Fixed `1fa11dc` `377dffd` (FAILURES 20) |
| R9-02 | Live | The help case required "bent", advice for a light that stays red | Fixed `a428e1c` `ce6a3de`: "loss of signal" and the article itself |
| R9-03 | Builder | A downgrade switched the plan at once, against the GLOSSARY and SOP | Fixed `3e40639` `5e117b1`: scheduled for the next cycle |
| R9-04 | Spec | A quote and a change in one turn passed: confirmation was the model's word | Fixed `3673222` `c617031` (FAILURES 21) |
| R9-05 | Spec | Any unused quote of the call could be applied | Fixed `4631b1d` `81872ff` (FAILURES 21) |
| R9-06 | Spec | The help case could not prove the article was used | Fixed `dd909ab` `bf4b16b`: arrays match as a prefix; the first article must be modem-lights |
| R9-07 | Spec | No knowledge-base adapter, against spec #1 | Fixed `7af43b1` `e85e5e3` |
| R9-08 | Spec | An SOP rule to verify before naming any plan, which nobody asked for | Fixed `ce6a3de` |
| R9-09 | Spec | Plan-change timing hard-coded, though DESIGN lists plan-change rules as policy | Fixed `7db0cf4` `d352411` |
| R9-10 | Standards | No absolute caps on plan prices and speeds (ADR 1) | Fixed `2f2fc2e` `84949e6`; BigInt stays, since a price difference times a month's milliseconds still passes 2^53 |
| R9-11 | Standards | A tool description's example mirrored the modem-lights case (R2-15) | Fixed `50de8e2` `feaaa2a` |
| R9-12 | Standards | The help articles' "no figure" test caught digits only | Fixed `50de8e2` `feaaa2a` |
| R9-13 | Standards | Possible Feature Envy: the handler made up the missing-bill refusal | Fixed `5bb7242` `4aab1b6` |
| R9-14 | Standards | Possible Primitive Obsession: plans matched by display name | Fixed `7a8a7f6` `23bba82` |
| R9-15 | Standards | Possible Mysterious Name: `policyConfig` carried the plan catalog | Fixed `602cd7d`: `facts` |
| R9-16 | Standards | "Catalog order" for help articles (the catalog is plans) | Fixed `602cd7d` |
| R9-17 | Standards | Hand-copied prices, channels and a minute | Fixed `602cd7d` |
| R9-18 | Standards | The downgrade's GLOSSARY entry disagreed with the code (R9-03) | Fixed `5e117b1` |
| R9-19 | Standards | The article parser was untested on a colon in a value and a byte-order mark | Fixed `36ebfd4` `9d2edd0` (the mark broke it) |
| R9-20 | Standards | A refactor's commit body copied another's; a GREEN edited a RED test for lint | Recorded here |

### Not verified

- The downgrade-now credit and upgrade-next-cycle paths are unit-tested only;
  Kidlat's policy uses neither.
- Whether Tala re-quotes when a caller goes back to an earlier price.
