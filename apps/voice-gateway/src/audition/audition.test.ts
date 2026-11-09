import { describe, expect, it } from "vitest";

import {
  FILIPINO_LANGUAGE_CODE,
  FLASH_MODEL_ID,
  STT_MODEL_ID,
  auditionLines,
  describeFailure,
  expectedTtsCredits,
  firstAudioMs,
  resultsTable,
  sttRequest,
  ttsStreamRequest,
  type AuditionRow,
} from "./audition";

const PERSONA = {
  openingLine: "Thank you for calling Kidlat Fiber. This is Tala.",
  fillerLine: "Sandali lang po, let me check.",
};

describe("auditionLines", () => {
  it("gives the five lines #3 names, in order", () => {
    expect(auditionLines(PERSONA).map((line) => line.id)).toEqual([
      "disclosure",
      "greeting",
      "outage-apology",
      "payment-reference",
      "filler",
    ]);
  });

  it("takes the disclosure and the filler from the persona, word for word", () => {
    const lines = auditionLines(PERSONA);
    expect(lines.find((line) => line.id === "disclosure")).toMatchObject({
      text: PERSONA.openingLine,
      source: "persona",
    });
    expect(lines.find((line) => line.id === "filler")).toMatchObject({
      text: PERSONA.fillerLine,
      source: "persona",
    });
  });

  it("marks the payment reference as a placeholder until #10 adds payments to the world", () => {
    const line = auditionLines(PERSONA).find((l) => l.id === "payment-reference");
    expect(line?.source).toBe("placeholder");
    expect(line?.text).toMatch(/GCash/);
  });

  it("says po in the lines written for the audition", () => {
    for (const line of auditionLines(PERSONA).filter((l) => l.source !== "persona")) {
      expect(line.text).toMatch(/\bpo\b/);
    }
  });
});

describe("ttsStreamRequest", () => {
  const base = { apiKey: "k-123", voiceId: "voice/1", text: "Sandali lang po." };

  it("posts to the streaming endpoint for the voice, as MP3", () => {
    const { url, init } = ttsStreamRequest({ ...base, language: "fil" });
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/stream?output_format=mp3_44100_128",
    );
    expect(init.method).toBe("POST");
  });

  it("sends the key in xi-api-key and JSON content", () => {
    const { init } = ttsStreamRequest({ ...base, language: "fil" });
    expect(init.headers).toEqual({ "xi-api-key": "k-123", "Content-Type": "application/json" });
  });

  it("asks Flash v2.5 for the text, with the Filipino code when the language is fil", () => {
    const { init } = ttsStreamRequest({ ...base, language: "fil" });
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Sandali lang po.",
      model_id: "eleven_flash_v2_5",
      language_code: "fil",
    });
    expect(FLASH_MODEL_ID).toBe("eleven_flash_v2_5");
    expect(FILIPINO_LANGUAGE_CODE).toBe("fil");
  });

  it("leaves the language code out when the language is auto", () => {
    const { init } = ttsStreamRequest({ ...base, language: "auto" });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("language_code");
  });
});

describe("sttRequest", () => {
  it("posts the clip to speech-to-text as multipart, on Scribe v2", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const { url, init } = sttRequest({ apiKey: "k-123", audio, fileName: "clip.mp3" });

    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    // fetch sets the multipart boundary itself, so no Content-Type here.
    expect(init.headers).toEqual({ "xi-api-key": "k-123" });
    expect(STT_MODEL_ID).toBe("scribe_v2");

    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    const file = form.get("file") as File;
    expect(file.name).toBe("clip.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });
});

describe("firstAudioMs", () => {
  it("is the whole milliseconds from the request to the first audio bytes", () => {
    expect(firstAudioMs(1000.2, 1513.9)).toBe(514);
  });

  it("refuses a first chunk timed before the request", () => {
    expect(() => firstAudioMs(2000, 1999)).toThrow(/before the request/);
  });
});

describe("expectedTtsCredits", () => {
  it("is half a credit a character on Flash, rounded up", () => {
    // Measured 2026-11-09: a 30-character line moved the counter by 15.
    expect(expectedTtsCredits("Sandali lang po, let me check.")).toBe(15);
    expect(expectedTtsCredits("abc")).toBe(2);
  });
});

describe("describeFailure", () => {
  it("names the free plan refusing a library voice", () => {
    const body = JSON.stringify({
      detail: {
        type: "payment_required",
        code: "paid_plan_required",
        message: "Free users cannot use library voices via the API.",
        status: "payment_required",
      },
    });
    expect(describeFailure(402, body)).toEqual({
      status: 402,
      kind: "library_voice_needs_paid_plan",
      code: "paid_plan_required",
      message: "Free users cannot use library voices via the API.",
    });
  });

  it("names the unusual-activity flag #3 watches for", () => {
    const body = JSON.stringify({
      detail: { status: "detected_unusual_activity", message: "Unusual activity detected." },
    });
    expect(describeFailure(401, body).kind).toBe("unusual_activity");
  });

  it("names a key missing a permission", () => {
    const body = JSON.stringify({
      detail: { code: "unauthorized", status: "missing_permissions", message: "missing tts" },
    });
    expect(describeFailure(401, body).kind).toBe("missing_permission");
  });

  it("names running out of credits", () => {
    const body = JSON.stringify({ detail: { status: "quota_exceeded", message: "quota" } });
    expect(describeFailure(401, body).kind).toBe("out_of_credits");
  });

  it("keeps a body that is not JSON as the message", () => {
    expect(describeFailure(500, "upstream exploded")).toEqual({
      status: 500,
      kind: "other",
      code: "",
      message: "upstream exploded",
    });
  });
});

describe("resultsTable", () => {
  const ok: AuditionRow = {
    voice: "Tala",
    line: "filler",
    language: "fil",
    chars: 30,
    expectedCredits: 15,
    firstAudioMs: 412,
    file: "tala-filler-fil.mp3",
    failure: null,
  };

  it("has one row per render with time to first audio and credits", () => {
    const table = resultsTable([ok]);
    expect(table.split("\n")).toEqual([
      "| Voice | Line | Language | Chars | Credits (expected) | First audio | File |",
      "|---|---|---|---:|---:|---:|---|",
      "| Tala | filler | fil | 30 | 15 | 412 ms | tala-filler-fil.mp3 |",
    ]);
  });

  it("shows a failed render's kind and status instead of a time", () => {
    const failed: AuditionRow = {
      ...ok,
      firstAudioMs: null,
      file: null,
      failure: {
        status: 402,
        kind: "library_voice_needs_paid_plan",
        code: "paid_plan_required",
        message: "x",
      },
    };
    expect(resultsTable([failed]).split("\n")[2]).toBe(
      "| Tala | filler | fil | 30 | 15 | failed: library_voice_needs_paid_plan (402) | none |",
    );
  });
});
