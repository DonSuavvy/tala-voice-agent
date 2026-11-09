# 6. Tala's voices are designed in ElevenLabs and spoken on Flash v2.5 with `fil`

**Status:** accepted, 2026-11-09 (ticket #3, ElevenLabs half; the Gemini voices are deferred).

The `local` voice profile speaks with two voices made in ElevenLabs Voice
Design, on Flash v2.5, with `language_code: "fil"`:

| Role | Voice ID |
|---|---|
| Tala | `Gl1N7znGJkm9SBuNef2X` |
| Takeover supervisor | `nzIvEymMnqfBtlc62bV4` |

Both were picked by ear from `npm run audition`, which has each voice read
Tala's five Taglish lines with and without the Filipino code. The owner chose
the `fil` renders. Voice IDs are not secrets; #7 reads them from the `local`
profile's config.

Every number of four or more digits is spoken through `spokenDigits` first
(`5012 345 678901` becomes `5-0-1-2, 3-4-5, 6-7-8-9-0-1`). Flash read the
block as "5T12 345 678 901". Of four renderings compared by ear and by
transcript, hyphens between digits and commas between groups read cleanest.

## Measured

From the run of 2026-11-09 on the owner's home connection, free plan:

- **Time to first audio:** about 200 ms per line once warm (187 to 333 ms).
  Each voice's first request took 2.4 to 2.6 s. #7 should send a short warm-up
  request when a call starts.
- **Credits:** 965 measured for 20 clips against 964 expected, so Flash costs
  half a credit a character. The free plan's 10,000 a month is about 20,000
  characters of speech.
- **Speech to text:** Scribe v2 transcribed an 8.4 s clip word for word in
  1.6 s, for about 9 credits. The charge landed more than 30 s after the call,
  so the figure is approximate.
- **Unusual-activity flag:** none in 24 renders with the designed voices and
  5 transcriptions.

## Considered options

- **Library voices (Camille, Rhonn, Maria).** Real Filipino voice actors and
  the owner's first pick. The API refuses every library voice on the free plan
  (`402 paid_plan_required`), even ones the library marks as allowed for free
  users: that flag covers the website only. Starter, about $5 a month, would
  allow them. Rejected for now to keep the project on free tiers.
- **Instant voice clone.** Paid only, and it needs a consenting speaker's
  recording. Cloning a library voice actor's previews would copy their voice
  without permission.
- **Built-in voices.** Served on the free plan, but American, British or
  Australian. Wrong for a Manila support line.
- **No language code (`auto`).** Accepted by the API and close in sound. The
  owner preferred `fil`.

## Consequences

- Voice Design voices are generated, so the accent can drift between lines in
  a way a recorded actor's would not. Re-run the audition when the SOP's
  phrasing changes a lot.
- Two of the free plan's three voice slots are used.
- The Gemini half of #3 (the `public` profile's voices) is still open and is
  needed before #21.
