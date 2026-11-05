# Tala

A Taglish-first AI voice agent for tier-1 customer support at Kidlat Fiber, a
fictional Philippine fiber internet provider, with a live supervisor console.
Tala's core is the agent engine from
[OpsPilot](https://github.com/DonSuavvy/opspilot), extended for real-time voice.

Portfolio project: a public, readable example of a voice agent built the way a
company would deploy it.

## Source of truth

- **The spec issue** on GitHub (label `ready-for-agent`, the parent of every
  ticket) says what to build.
- **`docs/DESIGN.md`** is the long-form design record: every decision from the
  design interview (Q1–Q39) and why. Read it before planning work.
- **Tickets** are sub-issues of the spec, each with its "blocked by" edges.
  Work the frontier: a ticket whose blockers are all closed.

When a decision isn't covered by any of these, make the boring choice and move on.

## Conventions

These match OpsPilot's on purpose (Q33).

### Test-first, visibly

Policies, tool handlers, eval scorers, the SOP compiler, cost accounting and the
voice turn logic are written **test-first**: write the test, run it, watch it
fail, then implement. Commit the failing test on its own (`test: <x> (RED)`),
then the implementation (`feat: <x> (GREEN)`), so the RED step is visible in
`git log`.

### Verification before completion

Never claim something works without fresh evidence from this session. Run the
command, read the output, quote it.

`npm test` must never need a database or an API key. Checks that do live in
`scripts/verify-*.ts` and run manually.

### Never trust the model

Limits are enforced twice: in the SOP so Tala can explain them, and in the tool
handlers so the code guarantees them. The model proposes; the code disposes.
Policy code is pure and takes `now` as an argument, never `Date.now()`.

### Models and providers

- Models are named **logically** (`haiku` / `sonnet` / `opus`) everywhere
  except the provider file.
- Tala uses the **first-party Anthropic API only**. Never point it at the
  covara Bedrock account: that account is shared with a live production
  workload.
- Before writing any Anthropic API code, load the `claude-api` skill. API
  shapes changed in 2025–26; do not code from memory.
- ElevenLabs is called only from a developer's own machine, never from cloud
  servers (free-plan accounts get flagged). The public demo uses Gemini's free
  tier for speech.

### Written-down mistakes

`docs/FAILURES.md` logs what broke, how it was caught and what changed.
`docs/REVIEWS.md` records independent review passes and what they found.

## Agent skills

### Issue tracker

Issues, the spec and tickets live in this repo's GitHub Issues
(`DonSuavvy/tala-voice-agent`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created as
terms and decisions get settled. See `docs/agents/domain.md`.
