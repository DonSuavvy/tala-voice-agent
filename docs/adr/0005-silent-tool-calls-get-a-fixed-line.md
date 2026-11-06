# 5. A tool call made in silence gets a fixed line from the session

**Status:** accepted, 2026-11-06 (ticket #6, pulling a piece of #8 forward).

When a model turn calls a tool without saying anything, the call session says
the company pack's fixed filler line first ("Sandali lang po, let me check.").
When the turn ends the call that way, it says the fixed closing line instead.
The line is recorded in that turn, just before the tool call, so Claude knows
it was said and does not repeat it. This is ADR 3's rule applied to dead air:
what the caller must hear is guaranteed by the code, and the SOP only asks
Claude for something better.

The SOP already asked for a line before every tool call and a goodbye with
`end_call`. The eval gate showed how often that was not enough. Sonnet 5.5
went silent before a tool call in about 1 run in 6 after the SOP fix, and
before `end_call` in 2 runs of 3 later on. Haiku 5.5 skipped the line before
verification in every run before this change. A required gate that rests on
behaviour like that blocks good PRs at random.

## Considered options

- **Re-run a failing case and pass on 2 of 3.** It keeps the check on the
  model, but a failing case costs up to three times as much, and it would pass
  a rule the model follows 70% of the time.
- **Take the check out of the gate until #8.** The caller would still hear
  dead air, and nothing would stop it getting worse.

## Consequences

- `speaksBeforeEveryToolCall` now checks the session's guarantee, so it no
  longer measures how often the model keeps the rule by itself. Counting the
  fixed lines in each eval report would bring that measure back.
- #8 can replace these lines with pre-recorded phrases without changing the
  rule.
- The line is inserted after any signed thinking block in the turn.
  Preserved thinking binds a block to what precedes it, so the block's
  binding is unchanged. This shape has not been seen live: no silent tool
  turn with a thinking block turned up in eight tries.
