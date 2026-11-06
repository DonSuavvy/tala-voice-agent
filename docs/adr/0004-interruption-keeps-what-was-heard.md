# 4. An interruption keeps only what the caller heard

**Status:** accepted, 2026-11-06 (ticket #6).

When the caller cuts in, the call session stops Tala's model call and keeps in
the conversation only the part of her line the caller heard, so Claude's next
turn knows what was said and what was not. The voice transport reports what
was heard, since speech playback lags the text; by default it is every word
streamed before the interruption. An interruption always stops Tala: a heard
text that does not match what streamed falls back to that default, and the
mismatch is reported.

The rules that follow from it, and why:

- **Cut, then drop everything after the cut.** If the cut shortens a text
  block, every later block of that turn goes too, signed thinking blocks and
  tool calls included. The 5.5 models bind a thinking block's signature to
  everything before it (preserved thinking), so a signed block after edited
  text would be rejected. Trimming a turn before it is ever sent back is not
  an edit: the conversation stays append-only.
- **A tool already running finishes; the rest are answered "Not run".** Every
  tool call keeps a result, and a tool that may have acted (a verification
  now, a bill credit in #13) is never hidden from Claude. For the same reason,
  once a turn has reached its tools, a shorter heard text is reported but cuts
  nothing.
- **`end_call` already running completes.** The disposition is recorded, and
  the call does not stay open after it.
- **An interrupted model call costs at least the pre-flight estimate.** Its
  final usage never arrives, so it is booked at no less than the estimate and
  marked estimated. The spend guard never under-counts; it over-counts cheap
  models, about 50 times on Haiku 5.5, which #22 re-measures.

## Considered options

- **Keep everything that streamed.** Claude would believe the caller heard a
  restoration time or a reference number they never heard.
- **Cancel running tools.** A verification, or later a credit, could be left
  half done with Claude unaware of it.
- **Edit the previous turn when a late heard report arrives.** It breaks the
  append-only conversation the 5.5 models require.

## Consequences

Live on Haiku 5.5 and Sonnet 5.5, interrupted turns were accepted on the next
request, including one that kept a signed thinking block before partial text.
Every line Tala says goes out as streamed text first (the opening and fallback
lines as one piece each), so a voice transport speaks one kind of event and
the full line is the record.
