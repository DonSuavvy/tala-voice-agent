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

None yet.
