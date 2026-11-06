# Tala

[![CI](https://github.com/DonSuavvy/tala-voice-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/DonSuavvy/tala-voice-agent/actions/workflows/ci.yml)

A Taglish-first AI voice agent for tier-1 customer support at **Kidlat
Fiber**, a fictional Philippine fiber internet provider. Callers talk to Tala
in English, Tagalog or Taglish, and she does the work through tools: she
verifies identity, checks outages by barangay, confirms GCash/Maya payments,
runs modem diagnostics, books technicians and applies bill credits. A live
supervisor console lets a human watch each call, guide Tala privately, approve
credits and take over.

Tala's core is the agent engine from
[OpsPilot](https://github.com/DonSuavvy/opspilot), extended for real-time voice.

> **Status: scaffold.** The repo installs, typechecks, tests and lints, and CI
> runs on every pull request. No agent code yet. The full design is in
> [`docs/DESIGN.md`](docs/DESIGN.md), and the spec and tickets are in this
> repo's [Issues](https://github.com/DonSuavvy/tala-voice-agent/issues/1).

## Development

Needs Node 26 (see `.nvmrc`) and npm.

```bash
npm install
npm run typecheck
npm test
npm run lint
```

`npm test` needs no database and no API key. Copy `.env.example` to
`.env.local` only when a ticket needs a real service.

| Workspace | Package | Role |
|---|---|---|
| `packages/core` | `@tala/core` | The framework-free brain: OpsPilot's engine plus voice extensions |
| `packages/packs/kidlat-fiber` | `@tala/kidlat-fiber` | The Kidlat Fiber company pack |
| `packages/evals` | `@tala/evals` | Eval harness, simulated callers, advisory grader |
| `apps/agent` | `@tala/agent` | LiveKit Agents worker |
| `apps/web` | `@tala/web` | Caller page and supervisor console |
| `apps/voice-gateway` | `@tala/voice-gateway` | Hand-built voice path, local only |

How the repo is checked: [`docs/FAILURES.md`](docs/FAILURES.md) logs what
broke, [`docs/REVIEWS.md`](docs/REVIEWS.md) records review passes, and
[`docs/SECURITY.md`](docs/SECURITY.md) is the threat model.

## License

MIT, see [LICENSE](LICENSE).
