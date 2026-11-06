# 1. Tala's core is OpsPilot's engine, imported once and made company-agnostic

**Status:** accepted, 2026-11-06 (ticket #4). Design decisions Q32–Q35.

## Context

[OpsPilot](https://github.com/DonSuavvy/opspilot) is a support-ticket agent by
the same author, for a fictional SaaS company, Beacon Analytics. Its engine had
already been built test-first and through four independent review rounds. It
includes a hand-rolled agent loop with pause/resume, a tool registry validated
at boot, a pure policy engine, an SOP compiler, a reserving spend guard,
nano-dollar cost accounting, spans, a prompt-injection pre-scan and a
deterministic eval scorer. Tala needs every one of those, for voice calls at a
Philippine ISP instead of tickets at a SaaS company.

## Decision

Copy the engine from OpsPilot at commit
`83b54142b76cec0bcedc42f5127d08186ac7a5c2` (MIT, same author) in one commit
(`2937161`), byte-for-byte. Then adapt it in separate, reviewable commits.
There is no shared package and no fork to keep in sync: Tala owns its copy.

Where each piece went:

| OpsPilot | Tala |
|---|---|
| `src/agent/*` (loop, registry, budget, cost, cache, provider, streaming, SOP compiler and draft check, injection scan, guardrails, trace) | `packages/core/src/agent/` |
| `src/evals/` case schema, scorer, pinning, diff | `packages/evals/src/` |
| `src/db`, `src/app`, `src/components`, `src/lib`, `scripts`, `src/evals/suite*` | not imported (Postgres, Next.js or UI) |

What was removed, because it belonged to Beacon rather than the engine:

- Beacon's nine tools, its `OpsData` data seam, its refund and escalation
  policy, the ticket-shaped opening message, its eight golden eval cases, the
  eval runner that drove a ticket, and the write recorder over `OpsData`.
- The Amazon Bedrock provider. OpsPilot ran on an AWS account shared with a
  live production workload; Tala must never call it, so there is no code path
  that could.
- The scorer's two money expectations (a refund amount, and the amount a
  paused refund carried).

That removed 148 OpsPilot test blocks with their files (some parameterized,
so more cases than that), 12 Bedrock provider tests, 8 scorer money tests,
7 tests of Beacon's shipped SOP document, 3 guardrail tests of ticket notice
wording and 2 sop-draft tests of Beacon's policy schema. Each removal is
named with its reason in its commit message.

What was generalized:

| Was | Now |
|---|---|
| `ToolContext` with Beacon's `OpsData` and `PolicyConfig`, keyed by `ticketId` | `ToolContext<TData, TPolicy>`, keyed by `callId`; registry and loop generic over it |
| `compileSop` with four Beacon placeholders and a USD-only formatter | `compileSop({ bodyMarkdown, policyConfig, renderers })`; `formatMoney(minorUnits, { code, locale })` |
| `validateSopDraft` against Beacon's policy schema | takes the pack's `parsePolicy` and `renderers` |
| `prepareTicketRun` (scan a ticket, narrow tools, build the message) | `guardInput({ registry, text, now })`; the notice wording moves to #15 |
| `scanForInjection({ subject, body })` | `scanForInjection(text)` |
| Rate cards for Haiku 4.5, Sonnet 5, Opus 5, cache hits at 0.1x everywhere | Haiku 5.5, Sonnet 5.5, Opus 5.5 from the live pricing page; cache hits 0.05x on Opus and Sonnet 5.5; Haiku 5.5's long-prompt card |

### The policy-engine pattern, without a policy

OpsPilot's policy engine was one concrete policy (`policy/refund.ts`). Tala's
first policy, bill credits, is #13, so no policy code survives the import.
The pattern does, and #13 follows it:

- **Pure.** It takes `now` as an argument and never reads the clock, a
  database or a model.
- **Parsed at the point of decision.** The config is parsed with zod inside
  the function that decides, not trusted from a TypeScript type. A malformed
  policy throws instead of failing open (OpsPilot FAILURES #9).
- **Absolute caps in the schema.** A well-formed policy can still be
  harmful. OpsPilot's authorised a $999,999.99 refund with zero violations
  (FAILURES #15), so a pack's schema bounds every figure absolutely, not only
  relative to the others.
- **Nullable inputs are three-state.** `!== X` is not "is not X" when the
  value can be null (FAILURES #5, #13).
- **Enforced twice.** Once in the tool's `preflight`, before a human is ever
  asked to approve, and again in the handler after approval.

### SDK and models

`@anthropic-ai/sdk` ^1.6.0 instead of OpsPilot's ^0.116. 1.x defaults to API
version 2026-10-21. None of that version's breaking changes touch the engine:
it sends no sampling parameters, no documents in assistant turns, no citations
in user turns, no Admin API calls, no Text Completions and no custom auth
headers.

Logical model names stay `haiku`, `sonnet`, `opus`. Only `provider.ts` knows
they are `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`.
`streaming.ts` sends no `thinking` or `effort` yet. On the 5.5 models,
omitting `thinking` runs adaptive thinking, the only setting Opus 5.5 accepts.
Effort and streamed text deltas are #6.

## Consequences

- Every engine test that still applies runs in Tala: 338 tests across core,
  evals and the repo, with no database and no API key.
- `git diff 2937161 HEAD -- packages/core packages/evals` shows every change
  Tala made to OpsPilot's code.
- The import surfaced five problems. Two were latent OpsPilot bugs: a
  prototype lookup in the SOP compiler, and `[object Object]` in scorer
  messages. Two were pricing assumptions the 5.5 models broke, plus a figure
  in the claude-api skill that disagreed with the live pricing page. The
  fifth was lint debt: OpsPilot's lint never checked types. All are logged
  in `docs/FAILURES.md`.
- Comments that described OpsPilot's Bedrock account, its routes and its
  tables now say they are OpsPilot's, so nothing describes code Tala lacks
  in the present tense.
- Fixes made here do not flow back to OpsPilot automatically. The two latent
  bugs are worth reporting there.
- Unmeasured and carried forward: whether the first-party API accepts Tala's
  seventeen tools under `strict` decoding (OpsPilot's limit was a Bedrock one),
  and what a Tala call costs to reserve up front (OpsPilot's $0.02 estimate
  was for tickets; re-measured in #22).
