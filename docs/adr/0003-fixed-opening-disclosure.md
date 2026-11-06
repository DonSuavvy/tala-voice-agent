# 3. The opening disclosure is a fixed line, said before Claude is called

**Status:** accepted, 2026-11-06 (ticket #5).

Every call opens with the company pack's fixed `openingLine`, which says Tala
is an AI assistant and that the call is recorded. The call session says it the
moment the call starts, before any model call, and records it in the
conversation as Tala's first turn, so Claude knows it was said.

The alternative was an SOP instruction to open with the disclosure, letting
Claude word it. It was rejected because the disclosure is a legal and trust
commitment (spec user story 2: "before anything else"), and a model-written
one can be skipped, reworded past recognition, or arrive after a caller has
already started sharing details. This is the "never trust the model" rule
applied to speech: the code guarantees it, and the SOP only tells Claude not
to repeat it.

**Consequences:** the line costs no tokens and plays with no model latency,
which the voice path (#7) can extend by pre-recording it once per voice (#8).
The conversation opens with a short synthetic user turn, "(The call has
connected. The caller has not spoken yet.)", because the API requires a user
turn first.
