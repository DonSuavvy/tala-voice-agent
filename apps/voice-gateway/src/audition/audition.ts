/**
 * The voice audition (#3): the pure parts of `npm run audition`.
 *
 * Each candidate voice reads the same Taglish lines on ElevenLabs Flash v2.5,
 * and the run records time to first audio and credits per line, so Tala's
 * voice and the takeover voice are picked by ear and by measurement. The
 * runner in `scripts/voice-audition.ts` does the network and file I/O; this
 * module builds the requests and the report, so a typo in a URL or a dropped
 * body field fails `npm test` instead of a paid run.
 *
 * Local only: ElevenLabs is never called from cloud servers (CLAUDE.md).
 */

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

/** The `local` profile's speech model (DESIGN.md §7). */
export const FLASH_MODEL_ID = "eleven_flash_v2_5";

/**
 * Batch speech-to-text, used to measure what transcription costs. The live
 * path will use `scribe_v2_realtime`; `scribe_v1` is deprecated.
 */
export const STT_MODEL_ID = "scribe_v2";

/**
 * The code ElevenLabs' model list gives Filipino for Flash v2.5. The TTS
 * reference asks for ISO 639-1, which has no Filipino code, so the audition
 * renders every line both with this code and without one ("auto") and the
 * choice is made by ear. The API accepted `fil` on 2026-11-09 (HTTP 200).
 */
export const FILIPINO_LANGUAGE_CODE = "fil";

/** Flash bills half a credit a character: a 30-character line cost 15. */
export const FLASH_CREDITS_PER_CHAR = 0.5;

export const OUTPUT_FORMAT = "mp3_44100_128";

export type LanguageMode = "fil" | "auto";

export interface AuditionLine {
  id: "disclosure" | "greeting" | "outage-apology" | "payment-reference" | "filler";
  text: string;
  /**
   * `persona`: a fixed line Tala really says, taken from the pack word for
   * word. `written`: written for the audition. `placeholder`: stands in for
   * data the world does not hold yet.
   */
  source: "persona" | "written" | "placeholder";
}

export interface AuditionPersona {
  openingLine: string;
  fillerLine: string;
}

/**
 * The five lines #3 names, in its order. The filler is the persona's
 * "Sandali lang po, let me check.", not the ticket's "i-check ko": the
 * persona is what Tala actually says.
 */
export function auditionLines(persona: AuditionPersona): AuditionLine[] {
  return [
    { id: "disclosure", text: persona.openingLine, source: "persona" },
    {
      id: "greeting",
      text: "Opo, ma'am, salamat po sa paghihintay. Ano po ang maitutulong ko sa inyo ngayong hapon?",
      source: "written",
    },
    {
      id: "outage-apology",
      text:
        "Pasensya na po sa abala. May fiber cable cut po along Batasan Road dahil sa road works, " +
        "at inaasahan pong babalik ang service around 10 PM tonight.",
      source: "written",
    },
    {
      // world.json has no payments until #10; the format is GCash-like.
      id: "payment-reference",
      text: "Para po makasiguro, ang GCash reference number po ninyo ay 5012 345 678901. Tama po ba?",
      source: "placeholder",
    },
    { id: "filler", text: persona.fillerLine, source: "persona" },
  ];
}

export interface HttpRequest {
  url: string;
  init: RequestInit;
}

export function ttsStreamRequest(args: {
  apiKey: string;
  voiceId: string;
  text: string;
  language: LanguageMode;
}): HttpRequest {
  const body: Record<string, string> = { text: args.text, model_id: FLASH_MODEL_ID };
  if (args.language === "fil") body.language_code = FILIPINO_LANGUAGE_CODE;

  return {
    url:
      `${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(args.voiceId)}/stream` +
      `?output_format=${OUTPUT_FORMAT}`,
    init: {
      method: "POST",
      headers: { "xi-api-key": args.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

export function sttRequest(args: {
  apiKey: string;
  audio: Uint8Array<ArrayBuffer>;
  fileName: string;
}): HttpRequest {
  const form = new FormData();
  form.set("model_id", STT_MODEL_ID);
  form.set("file", new File([args.audio], args.fileName, { type: "audio/mpeg" }));

  return {
    url: `${ELEVENLABS_API}/speech-to-text`,
    // No Content-Type: fetch writes the multipart boundary itself.
    init: { method: "POST", headers: { "xi-api-key": args.apiKey }, body: form },
  };
}

/**
 * Time to first audio: from just before the request to the first read that
 * returned audio bytes. Headers arriving is not audio arriving.
 */
export function firstAudioMs(requestStartedMs: number, firstChunkMs: number): number {
  if (firstChunkMs < requestStartedMs) {
    throw new Error("first audio chunk timed before the request started");
  }
  return Math.round(firstChunkMs - requestStartedMs);
}

/**
 * What a line should cost on Flash. The account's counter lags by seconds,
 * so the runner checks the run's total against the sum of these rather than
 * reading the counter line by line.
 */
export function expectedTtsCredits(text: string): number {
  return Math.ceil(text.length * FLASH_CREDITS_PER_CHAR);
}

export type FailureKind =
  | "library_voice_needs_paid_plan"
  | "unusual_activity"
  | "missing_permission"
  | "out_of_credits"
  | "other";

export interface ApiFailure {
  status: number;
  kind: FailureKind;
  code: string;
  message: string;
}

interface ErrorDetail {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function errorDetail(bodyText: string): ErrorDetail | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null && "detail" in parsed) {
      const { detail } = parsed;
      if (typeof detail === "object" && detail !== null) return detail;
    }
  } catch {
    // Not JSON: the body itself is the message.
  }
  return null;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Names an ElevenLabs error, so the report says why a render failed. */
export function describeFailure(status: number, bodyText: string): ApiFailure {
  const detail = errorDetail(bodyText);
  if (!detail) return { status, kind: "other", code: "", message: bodyText };

  const code = asString(detail.code);
  const detailStatus = asString(detail.status);
  const message = asString(detail.message);

  const kind: FailureKind =
    code === "paid_plan_required"
      ? "library_voice_needs_paid_plan"
      : detailStatus === "detected_unusual_activity"
        ? "unusual_activity"
        : detailStatus === "missing_permissions"
          ? "missing_permission"
          : detailStatus === "quota_exceeded"
            ? "out_of_credits"
            : "other";

  return { status, kind, code, message };
}

export interface AuditionRow {
  voice: string;
  line: string;
  language: LanguageMode;
  chars: number;
  expectedCredits: number;
  firstAudioMs: number | null;
  file: string | null;
  failure: ApiFailure | null;
}

/** The results table #3 asks for, as Markdown. */
export function resultsTable(rows: readonly AuditionRow[]): string {
  const header = [
    "| Voice | Line | Language | Chars | Credits (expected) | First audio | File |",
    "|---|---|---|---:|---:|---:|---|",
  ];
  const body = rows.map((row) => {
    const timing = row.failure
      ? `failed: ${row.failure.kind} (${row.failure.status})`
      : `${row.firstAudioMs} ms`;
    return (
      `| ${row.voice} | ${row.line} | ${row.language} | ${row.chars} | ` +
      `${row.expectedCredits} | ${timing} | ${row.file ?? "none"} |`
    );
  });
  return [...header, ...body].join("\n");
}
