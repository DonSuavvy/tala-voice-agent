/**
 * The voice audition (#3): hear candidate voices read Tala's lines, and
 * measure them.
 *
 *   npm run audition -- --voice "Tala=<voice id>" --voice "Supervisor=<voice id>"
 *
 * Each voice reads the same five Taglish lines on ElevenLabs Flash v2.5, once
 * with the Filipino language code and once without, so the choice is made by
 * ear. Every clip is saved under voice-audition/<run>/ (gitignored), with a
 * results table of time to first audio and credits. One clip is then sent
 * through speech-to-text to measure what transcription costs.
 *
 * Needs ELEVENLABS_API_KEY in .env.local. Run it on your own machine only:
 * ElevenLabs is never called from cloud servers. On the free plan the API
 * serves only the built-in voices and voices you designed yourself; library
 * voices fail with library_voice_needs_paid_plan. Two voices cost about 1,000
 * credits of the free plan's 10,000 a month.
 *
 * Pass --no-stt to skip the transcription check, or --language fil (or auto)
 * to render one variant only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { loadKidlatFiber } from "@tala/kidlat-fiber";
import {
  auditionLines,
  describeFailure,
  expectedTtsCredits,
  firstAudioMs,
  resultsTable,
  sttRequest,
  ttsStreamRequest,
  type ApiFailure,
  type AuditionRow,
  type LanguageMode,
} from "@tala/voice-gateway";

const OUTPUT_ROOT = "voice-audition";
const SUBSCRIPTION_URL = "https://api.elevenlabs.io/v1/user/subscription";

/** The credit counter lags; how long to wait for it to catch up. */
const COUNTER_WAIT_MS = 30_000;
const COUNTER_POLL_MS = 2_000;

interface Voice {
  label: string;
  id: string;
}

interface Options {
  voices: Voice[];
  languages: LanguageMode[];
  stt: boolean;
}

function loadEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fine when the key is already exported; the check below says if not.
  }
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      voice: { type: "string", multiple: true, default: [] },
      language: { type: "string" },
      "no-stt": { type: "boolean", default: false },
    },
  });

  const voices = values.voice.map((spec): Voice => {
    const at = spec.indexOf("=");
    const label = spec.slice(0, at).trim();
    const id = spec.slice(at + 1).trim();
    if (at < 1 || !id) throw new Error(`--voice takes "Label=voiceId" (got "${spec}")`);
    return { label, id };
  });
  if (voices.length === 0) {
    throw new Error('Pass at least one --voice "Label=voiceId". Voice IDs are in ElevenLabs → Voices.');
  }

  const languages: LanguageMode[] =
    values.language === undefined
      ? ["fil", "auto"]
      : values.language === "fil" || values.language === "auto"
        ? [values.language]
        : (() => {
            throw new Error(`--language must be fil or auto (got "${values.language}")`);
          })();

  return { voices, languages, stt: !values["no-stt"] };
}

async function creditCount(apiKey: string): Promise<number> {
  const response = await fetch(SUBSCRIPTION_URL, { headers: { "xi-api-key": apiKey } });
  const text = await response.text();
  if (!response.ok) {
    const failure = describeFailure(response.status, text);
    throw new Error(`reading the credit counter failed: ${failure.kind} (${failure.status}) ${failure.message}`);
  }
  return (JSON.parse(text) as { character_count: number }).character_count;
}

/** Re-reads the lagging counter until it reaches `target` or stops moving. */
async function settledCount(apiKey: string, before: number, target: number): Promise<number> {
  const deadline = performance.now() + COUNTER_WAIT_MS;
  let count = await creditCount(apiKey);
  while (count < target && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, COUNTER_POLL_MS));
    count = await creditCount(apiKey);
  }
  return Math.max(count, before);
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface Render {
  firstAudioMs: number | null;
  audio: Uint8Array | null;
  failure: ApiFailure | null;
}

async function render(apiKey: string, voiceId: string, text: string, language: LanguageMode): Promise<Render> {
  const { url, init } = ttsStreamRequest({ apiKey, voiceId, text, language });
  const started = performance.now();
  const response = await fetch(url, init);

  if (!response.ok || !response.body) {
    const failure = describeFailure(response.status, await response.text());
    // Logged in full: this is the evidence for #3's unusual-activity check.
    console.log(`      ${response.status} ${JSON.stringify(failure)}`);
    return { firstAudioMs: null, audio: null, failure };
  }

  const chunks: Uint8Array[] = [];
  let firstChunkAt: number | null = null;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > 0) {
      firstChunkAt ??= performance.now();
      chunks.push(value);
    }
  }

  if (firstChunkAt === null) {
    return {
      firstAudioMs: null,
      audio: null,
      failure: { status: response.status, kind: "other", code: "", message: "empty audio stream" },
    };
  }
  return { firstAudioMs: firstAudioMs(started, firstChunkAt), audio: Buffer.concat(chunks), failure: null };
}

async function main(): Promise<void> {
  loadEnv();
  const options = parseOptions();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set. Add it to .env.local.");

  const lines = auditionLines(loadKidlatFiber().persona);
  const runDir = join(OUTPUT_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });

  const before = await creditCount(apiKey);
  console.log(`credits used this month before the run: ${before}`);

  const rows: AuditionRow[] = [];
  for (const voice of options.voices) {
    console.log(`\n${voice.label} (${voice.id})`);
    for (const line of lines) {
      for (const language of options.languages) {
        const result = await render(apiKey, voice.id, line.text, language);
        const file = result.audio ? `${slug(voice.label)}-${line.id}-${language}.mp3` : null;
        if (file && result.audio) writeFileSync(join(runDir, file), result.audio);

        rows.push({
          voice: voice.label,
          line: line.id,
          language,
          chars: line.text.length,
          expectedCredits: expectedTtsCredits(line.text),
          firstAudioMs: result.firstAudioMs,
          file,
          failure: result.failure,
        });
        const timing = result.failure ? `failed: ${result.failure.kind}` : `${result.firstAudioMs} ms`;
        console.log(`   ${line.id.padEnd(18)} ${language.padEnd(4)} ${timing}`);
      }
    }
  }

  const rendered = rows.filter((row) => !row.failure);
  const expected = rendered.reduce((sum, row) => sum + row.expectedCredits, 0);
  const afterTts = await settledCount(apiKey, before, before + expected);

  let stt: { file: string; credits: number; seconds: number | null; transcript: string } | null = null;
  const sample = rendered.find((row) => row.line === "disclosure") ?? rendered[0];
  if (options.stt && sample?.file) {
    const audio = readFileSync(join(runDir, sample.file));
    const { url, init } = sttRequest({ apiKey, audio, fileName: sample.file });
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.ok) {
      const result = JSON.parse(text) as { text: string; audio_duration_secs?: number };
      // Any movement means the charge landed; wait for at least one credit.
      const afterStt = await settledCount(apiKey, afterTts, afterTts + 1);
      stt = {
        file: sample.file,
        credits: afterStt - afterTts,
        seconds: result.audio_duration_secs ?? null,
        transcript: result.text,
      };
    } else {
      const failure = describeFailure(response.status, text);
      console.log(`\nspeech-to-text failed: ${response.status} ${JSON.stringify(failure)}`);
    }
  }

  const failures = rows.filter((row) => row.failure);
  const report = [
    `# Voice audition, ${new Date().toISOString()}`,
    "",
    resultsTable(rows),
    "",
    `Text to speech: ${afterTts - before} credits measured on the account, ${expected} expected ` +
      `from ${rendered.length} clips at half a credit a character.`,
    stt
      ? `Speech to text: ${stt.credits} credits for ${stt.seconds ?? "?"} s of audio (${stt.file}). ` +
        `Transcript: "${stt.transcript}"`
      : "Speech to text: not measured.",
    failures.length > 0
      ? `Failures: ${failures.length}. ${[...new Set(failures.map((row) => row.failure?.kind))].join(", ")}.`
      : "Failures: none. No unusual-activity flag on this connection.",
    "",
  ].join("\n");

  writeFileSync(join(runDir, "results.md"), report);
  writeFileSync(join(runDir, "results.json"), JSON.stringify({ rows, stt, before, afterTts }, null, 2));
  console.log(`\n${report}`);
  console.log(`clips and results are in ${runDir}/`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
