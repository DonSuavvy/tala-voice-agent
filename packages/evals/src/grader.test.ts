import { describe, expect, it } from "vitest";

import { anthropicProvider, type AssistantTurn, type ContentBlock } from "@tala/core";

import {
  GRADE_JSON_SCHEMA,
  gradeSchema,
  gradeTranscript,
  speakingStyleOf,
  type GradeCreator,
  type GradeRequest,
} from "./grader";
import type { TranscriptLine } from "./transcript";

/**
 * The advisory grader: a Claude model scores Tala's tone, Taglish and
 * politeness from the transcript. It sits beside the deterministic gate and
 * never decides it, so it must never throw: any failure is `grade: null` with
 * a reason, and the run goes on.
 */

const TRANSCRIPT: TranscriptLine[] = [
  { speaker: "tala", text: "Hello po! I'm Tala, an AI assistant, and this call is recorded." },
  { speaker: "caller", text: "Wala po kaming internet since this morning." },
  { speaker: "tala", text: "Sandali lang po, let me check your area." },
  { speaker: "tala", text: "May fiber cut po along Batasan Road. Back around 4 PM po." },
];

const GRADE = { tone: 4, taglish: 5, politeness: 5, notes: "Warm and brief." };

/**
 * Not Kidlat's SOP: the grader must take the style from the SOP it is given.
 * Its language rule is deliberately unlike Kidlat's.
 */
const SOP = [
  "# Test ISP hotline",
  "",
  "You are Tala.",
  "",
  "## How you speak",
  "",
  '- Speak plain English, with an occasional "po".',
  "",
  "### Times",
  "",
  '- Say times aloud, like "around 4 PM".',
  "",
  "## Verifying the caller",
  "",
  "Ask for the account number before anything else.",
].join("\n");

const STYLE = [
  '- Speak plain English, with an occasional "po".',
  "",
  "### Times",
  "",
  '- Say times aloud, like "around 4 PM".',
].join("\n");

function usage(input = 10, output = 10) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function reply(content: ContentBlock[], over: Partial<AssistantTurn> = {}): AssistantTurn {
  return { content, stop_reason: "end_turn", stop_details: null, usage: usage(), ...over };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });

/** A scripted grader model that records what it was asked. */
function scripted(answer: AssistantTurn | Error) {
  const requests: GradeRequest[] = [];
  const create: GradeCreator = (request) => {
    requests.push(structuredClone(request));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { create, requests };
}

function grade(createMessage: GradeCreator, transcript = TRANSCRIPT) {
  return gradeTranscript({ transcript, sop: SOP, provider: anthropicProvider, createMessage });
}

/* -------------------------------------------------------------------------- */

/**
 * The company's speaking style is the SOP's own "## How you speak" section,
 * so the grade follows the SOP Tala was briefed with instead of a copy of its
 * rules that drifts.
 */
describe("speakingStyleOf", () => {
  it("is the section under the How you speak heading, subsections included", () => {
    expect(speakingStyleOf(SOP)).toBe(STYLE);
  });

  it("reads Windows line endings the same way", () => {
    expect(speakingStyleOf(SOP.replace(/\n/g, "\r\n"))).toBe(STYLE.replace(/\n/g, "\r\n"));
  });

  it("runs to the end of the SOP when it is the last section", () => {
    expect(speakingStyleOf("# SOP\n\n## How you speak\n\nBe brief.\n")).toBe("Be brief.");
  });

  it.each([
    ["no such section", "# SOP\n\n## Verifying the caller\n\nAsk first.\n"],
    ["only a deeper heading of that name", "# SOP\n\n### How you speak\n\nBe brief.\n"],
    ["an empty section", "# SOP\n\n## How you speak\n\n## Verifying the caller\n"],
  ])("is null for %s", (_label, sop) => {
    expect(speakingStyleOf(sop)).toBeNull();
  });
});

describe("gradeTranscript: a grade", () => {
  it("returns the grade the model gave, with no reason", async () => {
    const result = await grade(scripted(reply([text(JSON.stringify(GRADE))])).create);

    expect(result.grade).toEqual(GRADE);
    expect(result.reason).toBeNull();
  });

  it("reads the grade from the text, past any thinking", async () => {
    const thinking: ContentBlock = { type: "thinking", thinking: "", signature: "s" };
    const result = await grade(scripted(reply([thinking, text(JSON.stringify(GRADE))])).create);

    expect(result.grade).toEqual(GRADE);
  });

  /**
   * Priced with the grader model's own rate card. Sonnet 5.5 is $2 / $10 per
   * million tokens and Haiku 5.5 $0.10 / $0.50 (the pricing page), so 1,000
   * input and 200 output tokens are $0.004 and $0.0002.
   */
  it.each([
    ["sonnet", 4_000_000],
    ["haiku", 200_000],
  ] as const)("prices a %s grader call from its real usage", async (model, nanos) => {
    const result = await gradeTranscript({
      transcript: TRANSCRIPT,
      sop: SOP,
      provider: anthropicProvider,
      createMessage: scripted(reply([text(JSON.stringify(GRADE))], { usage: usage(1000, 200) }))
        .create,
      model,
    });

    expect(result).toMatchObject({
      usage: { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costNanos: nanos,
      estimated: false,
    });
  });
});

describe("gradeTranscript: the request", () => {
  it("asks Sonnet by default for the grade as structured output, with the transcript", async () => {
    const claude = scripted(reply([text(JSON.stringify(GRADE))]));
    await grade(claude.create);

    const [request] = claude.requests;
    expect(request.model).toBe(anthropicProvider.modelId("sonnet"));
    expect(request.output_config).toEqual({
      format: { type: "json_schema", schema: GRADE_JSON_SCHEMA },
    });
    expect(request.system).toMatch(/tone/i);
    expect(request.system).toMatch(/taglish/i);
    expect(request.system).toMatch(/politeness/i);
    expect(request.system).toContain(STYLE);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe("user");
    const content = request.messages[0].content as string;
    expect(content).toContain("Tala: Sandali lang po, let me check your area.");
    expect(content).toContain("Caller: Wala po kaming internet since this morning.");
  });

  /** Only the style: the rest of the SOP is not the grader's business, and it keeps no copy of the rules. */
  it("briefs the grader with the SOP's style and nothing else from it", async () => {
    const claude = scripted(reply([text(JSON.stringify(GRADE))]));
    await grade(claude.create);

    const { system } = claude.requests[0];
    expect(system).not.toContain("Ask for the account number");
    expect(system).not.toMatch(/English-led|Sandali lang|Salamat po/);
  });

  /**
   * Tone is graded against the style too. A tone of the grader's own, such as
   * "warm" with "curt" as the worst, would mark down a pack that asks for brisk.
   */
  it("grades tone against the style, with no tone of its own", async () => {
    const claude = scripted(reply([text(JSON.stringify(GRADE))]));
    await grade(claude.create);

    const ownTone = /warm|calm|curt|cold/i;
    expect(claude.requests[0].system).not.toMatch(ownTone);
    expect(GRADE_JSON_SCHEMA.properties.tone.description).not.toMatch(ownTone);
  });

  /** Nothing to grade against is a reason, not a throw and not a paid call. */
  it("gives an SOP without a How you speak section as the reason there is no grade", async () => {
    const claude = scripted(reply([text(JSON.stringify(GRADE))]));
    const result = await gradeTranscript({
      transcript: TRANSCRIPT,
      sop: "# SOP\n\n## Verifying the caller\n\nAsk first.\n",
      provider: anthropicProvider,
      createMessage: claude.create,
    });

    expect(claude.requests).toHaveLength(0);
    expect(result).toEqual({
      grade: null,
      reason: 'the SOP has no "## How you speak" section to grade the call against',
      usage: null,
      costNanos: 0,
      estimated: false,
    });
  });

  it("uses the grader model it is given", async () => {
    const claude = scripted(reply([text(JSON.stringify(GRADE))]));
    await gradeTranscript({
      transcript: TRANSCRIPT,
      sop: SOP,
      provider: anthropicProvider,
      createMessage: claude.create,
      model: "haiku",
    });

    expect(claude.requests[0].model).toBe(anthropicProvider.modelId("haiku"));
  });

  /**
   * Structured outputs reject numeric and length constraints in the schema,
   * so each score is an enum of whole numbers there, and the range is checked
   * again when the reply is parsed.
   */
  it("sends a schema with the same fields as the one it parses, and no constraint the API rejects", () => {
    const schema = GRADE_JSON_SCHEMA;

    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(gradeSchema.shape).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(gradeSchema.shape).sort());
    expect(schema.additionalProperties).toBe(false);
    for (const key of ["tone", "taglish", "politeness"] as const) {
      expect(schema.properties[key]).toMatchObject({ type: "integer", enum: [1, 2, 3, 4, 5] });
    }
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum|multipleOf|minLength|maxLength/);
  });

  /** A paid call would grade a call in which Tala said nothing. */
  it("does not call the model when Tala said nothing", async () => {
    const claude = scripted(reply([text(JSON.stringify(GRADE))]));
    const result = await grade(claude.create, [{ speaker: "caller", text: "Hello?" }]);

    expect(claude.requests).toHaveLength(0);
    expect(result).toEqual({
      grade: null,
      reason: "there is nothing Tala said to grade",
      usage: null,
      costNanos: 0,
      estimated: false,
    });
  });
});

describe("gradeTranscript: no grade, never a throw", () => {
  it("gives a failed model call as a reason", async () => {
    const result = await grade(scripted(new Error("overloaded")).create);

    expect(result).toEqual({
      grade: null,
      reason: "the grader's model call failed: overloaded",
      usage: null,
      costNanos: 0,
      estimated: false,
    });
  });

  it("gives a creator that throws instead of rejecting as a reason", async () => {
    const result = await grade(() => {
      throw new Error("no client");
    });

    expect(result.grade).toBeNull();
    expect(result.reason).toBe("the grader's model call failed: no client");
  });

  /** A refused or cut-off reply was still generated and billed, so its usage is kept. */
  it.each([
    ["refusal", "the grader's model refused"],
    ["max_tokens", "the grader's reply was cut off before the grade was complete"],
  ])("gives a %s as a reason, and keeps its cost", async (stop_reason, reason) => {
    const result = await grade(
      scripted(reply([text('{"tone": 4')], { stop_reason, usage: usage(1000, 200) })).create,
    );

    expect(result).toMatchObject({ grade: null, reason, costNanos: 4_000_000 });
  });

  it("gives a reply that is not JSON as a reason, with the parser's message", async () => {
    const result = await grade(scripted(reply([text("Here is the grade: {")])).create);

    expect(result.grade).toBeNull();
    expect(result.reason).toMatch(/^the grader's reply was not JSON \(.+\)$/);
  });

  it.each([
    [[], "the grader returned no text"],
    [
      [text(JSON.stringify({ ...GRADE, tone: 7 }))],
      "the grader's reply did not match the grade schema: tone: Too big: expected number to be <=5",
    ],
    [
      [text(JSON.stringify({ ...GRADE, overall: 5 }))],
      'the grader\'s reply did not match the grade schema: Unrecognized key: "overall"',
    ],
  ] as [ContentBlock[], string][])("gives a reply it cannot read as a reason: %j", async (content, reason) => {
    const result = await grade(scripted(reply(content)).create);

    expect(result.grade).toBeNull();
    expect(result.reason).toBe(reason);
  });
});
