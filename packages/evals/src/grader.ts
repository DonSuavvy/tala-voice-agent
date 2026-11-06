/**
 * The advisory grader (#9, DESIGN section 11): a Claude model scores how Tala
 * spoke on a call (tone, Taglish, politeness) from its transcript.
 *
 * **Advisory, never the gate.** The deterministic scorer decides pass or
 * fail; this grade is shown and saved beside it and cannot change either.
 * So grading never throws: a failed or refused call, a cut-off reply, or a
 * reply that does not parse becomes `grade: null` with a reason, and the run
 * goes on.
 *
 * **Structured output, still parsed.** The request asks for the grade as JSON
 * through `output_config.format`. Structured outputs reject numeric
 * constraints in that schema, so each score is an enum of whole numbers there;
 * the reply is then parsed with `gradeSchema`, which checks the range and the
 * closed shape again. The model proposes; the code disposes.
 *
 * **The company's style comes from its SOP.** What "good" sounds like is the
 * pack's own `## How you speak` section, taken from the SOP Tala was briefed
 * with and put in the grader's prompt. The rubric here is generic (three
 * scores, Tala's lines only, not the fixed opening); it keeps no copy of a
 * company's language rules, which would drift from the SOP. An SOP without
 * that section gives `grade: null` with the reason.
 *
 * Called through its own seam (`GradeCreator`), because a structured-output
 * request carries `output_config`, which Tala's `MessageCreator` does not. The
 * tests script it; `anthropicGradeCreator` is the live one.
 */
import { z } from "zod";

import {
  type AssistantTurn,
  type createClient,
  type LogicalModel,
  type MessageParam,
  type Provider,
} from "@tala/core";

import { errorText } from "./error-text";
import { priceUsage, type PricedUsage } from "./priced";
import type { TranscriptLine } from "./transcript";

/** The model that grades unless a run says otherwise (DESIGN section 11). */
export const DEFAULT_GRADER_MODEL: LogicalModel = "sonnet";

/**
 * The claude-api skill's default for a non-streaming request. The 5.5 models
 * think by default and thinking counts against this; the SDK refuses a
 * non-streaming request above about 21,000.
 */
const GRADER_MAX_TOKENS = 16_000;

const score = z.number().int().min(1).max(5);

/** What a grade is, checked on the reply whatever the API promised. */
export const gradeSchema = z
  .object({
    tone: score,
    taglish: score,
    politeness: score,
    notes: z.string(),
  })
  .strict();

export type Grade = z.infer<typeof gradeSchema>;

const SCORES = [1, 2, 3, 4, 5];

/** The same fields as `gradeSchema`, in the JSON Schema subset structured outputs accept. */
export const GRADE_JSON_SCHEMA = {
  type: "object",
  properties: {
    tone: {
      type: "integer",
      enum: SCORES,
      description: "Warm, calm and natural, from 1 (cold, curt or robotic) to 5.",
    },
    taglish: {
      type: "integer",
      enum: SCORES,
      description:
        "Her mix of English and Tagalog follows the company's style for this caller, " +
        "from 1 (wrong language or unnatural mixing) to 5.",
    },
    politeness: {
      type: "integer",
      enum: SCORES,
      description: "Courteous throughout, from 1 (rude or dismissive) to 5.",
    },
    notes: {
      type: "string",
      description: "One to three sentences on what most affected the scores.",
    },
  },
  required: ["tone", "taglish", "politeness", "notes"],
  additionalProperties: false,
} as const;

/** The SOP heading a company pack names its speaking style under. */
const STYLE_HEADING = "## How you speak";

/**
 * The SOP's `## How you speak` section: every line after that heading up to
 * the next heading of level one or two, `###` subsections included, trimmed.
 * Null when the SOP has no such section or it is empty.
 */
export function speakingStyleOf(sop: string): string | null {
  const eol = sop.includes("\r\n") ? "\r\n" : "\n";
  const lines = sop.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === STYLE_HEADING);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join(eol).trim();
  return section.length > 0 ? section : null;
}

/** The generic rubric around one company's style. */
function graderSystem(style: string): string {
  return [
    "You grade how Tala, an AI voice agent on a company's customer support hotline, " +
      "spoke on one call. You read the call's transcript and score Tala's lines only. " +
      "The caller is simulated, so do not grade the caller. Tala's first line is a " +
      "fixed disclosure the company wrote, so do not grade that line either.",
    "",
    "Grade her against the company's own style for how Tala speaks, from the standard " +
      "operating procedure she was briefed with:",
    "<style>",
    style,
    "</style>",
    "",
    "Score each from 1 (poor) to 5 (excellent), against that style:",
    "- tone: warm, calm and natural, the way the style asks. 1 is cold, curt or robotic.",
    "- taglish: her mix of English and Tagalog follows the style for this caller and " +
      "sounds natural. 1 is the wrong language for the caller, or mixing that sounds " +
      "unnatural.",
    "- politeness: courteous throughout, the way the style asks, and never dismissive. " +
      "1 is rude or dismissive.",
    "",
    "In notes, say in one to three sentences what most affected the scores.",
  ].join("\n");
}

/** A structured-output request: Tala's request shape plus `output_config`. */
export interface GradeRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: MessageParam[];
  output_config: { format: { type: "json_schema"; schema: { [key: string]: unknown } } };
}

export type GradeCreator = (request: GradeRequest) => Promise<AssistantTurn>;

export interface AdvisoryGrade extends PricedUsage {
  grade: Grade | null;
  /** Why there is no grade; null when there is one. */
  reason: string | null;
}

export interface GradeOptions {
  transcript: readonly TranscriptLine[];
  /** The SOP text Tala was briefed with; its `## How you speak` section is the style. */
  sop: string;
  /** Resolves the grader's model id and rate card. */
  provider: Provider;
  createMessage: GradeCreator;
  model?: LogicalModel;
}

function transcriptText(transcript: readonly TranscriptLine[]): string {
  const lines = transcript.map((line) => `${line.speaker === "tala" ? "Tala" : "Caller"}: ${line.text}`);
  return ["<transcript>", ...lines, "</transcript>"].join("\n");
}

/** A grade, or `grade: null` and the reason. Never throws. */
export async function gradeTranscript(options: GradeOptions): Promise<AdvisoryGrade> {
  const { transcript, provider, createMessage } = options;
  const model = options.model ?? DEFAULT_GRADER_MODEL;
  const unpriced: PricedUsage = { usage: null, costNanos: 0, estimated: false };
  const none = (reason: string, priced: PricedUsage = unpriced): AdvisoryGrade => ({
    grade: null,
    reason,
    ...priced,
  });

  if (!transcript.some((line) => line.speaker === "tala")) {
    return none("there is nothing Tala said to grade");
  }
  const style = speakingStyleOf(options.sop);
  if (style === null) {
    return none(`the SOP has no "${STYLE_HEADING}" section to grade the call against`);
  }

  let reply: AssistantTurn;
  try {
    reply = await createMessage({
      model: provider.modelId(model),
      max_tokens: GRADER_MAX_TOKENS,
      system: graderSystem(style),
      messages: [{ role: "user", content: transcriptText(transcript) }],
      output_config: { format: { type: "json_schema", schema: GRADE_JSON_SCHEMA } },
    });
  } catch (error) {
    return none(`the grader's model call failed: ${errorText(error)}`);
  }

  const priced = priceUsage(provider.rateCard(model), reply.usage);
  const noGrade = (reason: string) => none(reason, priced);

  // Before the content: the output may not match the schema on either.
  if (reply.stop_reason === "refusal") return noGrade("the grader's model refused");
  if (reply.stop_reason === "max_tokens") {
    return noGrade("the grader's reply was cut off before the grade was complete");
  }

  const text = reply.content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("");
  if (text.trim().length === 0) return noGrade("the grader returned no text");

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return noGrade(`the grader's reply was not JSON (${errorText(error)})`);
  }

  const parsed = gradeSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    return noGrade(`the grader's reply did not match the grade schema: ${problems}`);
  }

  return { grade: parsed.data, reason: null, ...priced };
}

type AnthropicClient = ReturnType<typeof createClient>;
type CreateParams = Parameters<AnthropicClient["messages"]["create"]>[0];

/**
 * The live grader: one non-streaming Messages call with `output_config`, on
 * a client from core's `createClient`. Typed against the SDK's own request
 * type, so a request the SDK would not accept fails `tsc` here. The cast on
 * the way back is the one core's creator makes: the SDK's message and the
 * loop's `AssistantTurn` describe the same JSON.
 */
export function anthropicGradeCreator(client: AnthropicClient): GradeCreator {
  return async (request) => {
    const message = await client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages as CreateParams["messages"],
      output_config: request.output_config,
    });
    return message as unknown as AssistantTurn;
  };
}
