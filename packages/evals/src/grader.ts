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
 * Called through its own seam (`GradeCreator`), because a structured-output
 * request carries `output_config`, which Tala's `MessageCreator` does not. The
 * tests script it; `anthropicGradeCreator` is the live one.
 */
import { z } from "zod";

import {
  costOf,
  type AssistantTurn,
  type createClient,
  type LogicalModel,
  type MessageParam,
  type Provider,
  type TokenUsage,
} from "@tala/core";

import type { TranscriptLine } from "./transcript";

/** The model that grades unless a run says otherwise (DESIGN section 11). */
export const DEFAULT_GRADER_MODEL: LogicalModel = "sonnet";

/**
 * The skill's default for a non-streaming request. The 5.5 models think by
 * default and thinking counts against this; the SDK refuses a non-streaming
 * request above about 21,000.
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
        "English-led Taglish that fits the caller, from 1 (wrong language or unnatural mixing) to 5.",
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

const GRADER_SYSTEM = [
  "You grade how Tala, an AI voice agent on a Philippine internet provider's support " +
    "hotline, spoke on one call. You read the call's transcript and score Tala's lines " +
    "only. The caller is simulated, so do not grade the caller. Tala's first line is a " +
    "fixed disclosure the company wrote, so do not grade that line either.",
  "",
  "Tala is meant to sound like a warm, respectful Filipina customer service " +
    "representative. She speaks English-led Taglish, the way agents at Philippine call " +
    'centers do: mostly English, with "po" and "opo" and short Tagalog set phrases such ' +
    'as "Sandali lang po" or "Salamat po". A caller who speaks only English should get ' +
    'English with an occasional "po"; mostly Tagalog is right only for a caller who ' +
    "speaks no English or clearly does not follow it. She keeps each reply to one or two " +
    "short sentences.",
  "",
  "Score each from 1 (poor) to 5 (excellent):",
  "- tone: warm, calm and natural, like a good customer service representative. 1 is " +
    "cold, curt or robotic.",
  "- taglish: English-led Taglish that fits the caller, mixed naturally. 1 is the wrong " +
    "language for the caller, or mixing that sounds unnatural.",
  '- politeness: courteous throughout, with "po" and "opo" where they belong and nothing ' +
    "dismissive. 1 is rude or dismissive.",
  "",
  "In notes, say in one to three sentences what most affected the scores.",
].join("\n");

/** A structured-output request: Tala's request shape plus `output_config`. */
export interface GradeRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: MessageParam[];
  output_config: { format: { type: "json_schema"; schema: { [key: string]: unknown } } };
}

export type GradeCreator = (request: GradeRequest) => Promise<AssistantTurn>;

export interface AdvisoryGrade {
  grade: Grade | null;
  /** Why there is no grade; null when there is one. */
  reason: string | null;
  /** Null when no response came back. */
  usage: TokenUsage | null;
  costNanos: number;
  /** True when priced from a rate card with no verified date. */
  estimated: boolean;
}

export interface GradeOptions {
  transcript: readonly TranscriptLine[];
  /** Resolves the grader's model id and rate card. */
  provider: Provider;
  createMessage: GradeCreator;
  model?: LogicalModel;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transcriptText(transcript: readonly TranscriptLine[]): string {
  const lines = transcript.map((line) => `${line.speaker === "tala" ? "Tala" : "Caller"}: ${line.text}`);
  return ["<transcript>", ...lines, "</transcript>"].join("\n");
}

/** A grade, or `grade: null` and the reason. Never throws. */
export async function gradeTranscript(options: GradeOptions): Promise<AdvisoryGrade> {
  const { transcript, provider, createMessage } = options;
  const model = options.model ?? DEFAULT_GRADER_MODEL;
  const none = (reason: string, usage: TokenUsage | null = null, costNanos = 0, estimated = false) => ({
    grade: null,
    reason,
    usage,
    costNanos,
    estimated,
  });

  if (!transcript.some((line) => line.speaker === "tala")) {
    return none("there is nothing Tala said to grade");
  }

  let reply: AssistantTurn;
  try {
    reply = await createMessage({
      model: provider.modelId(model),
      max_tokens: GRADER_MAX_TOKENS,
      system: GRADER_SYSTEM,
      messages: [{ role: "user", content: transcriptText(transcript) }],
      output_config: { format: { type: "json_schema", schema: GRADE_JSON_SCHEMA } },
    });
  } catch (error) {
    return none(`the grader's model call failed: ${errorText(error)}`);
  }

  const usage: TokenUsage = {
    inputTokens: reply.usage.input_tokens,
    outputTokens: reply.usage.output_tokens,
    cacheCreationInputTokens: reply.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: reply.usage.cache_read_input_tokens ?? 0,
  };
  const cost = costOf(provider.rateCard(model), usage);
  const noGrade = (reason: string) => none(reason, usage, cost.totalNanos, cost.estimated);

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

  return { grade: parsed.data, reason: null, usage, costNanos: cost.totalNanos, estimated: cost.estimated };
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
