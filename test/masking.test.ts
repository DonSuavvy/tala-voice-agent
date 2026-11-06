import { describe, expect, it } from "vitest";

import {
  anthropicProvider,
  createCallSession,
  encodeSseEvent,
  spanToRow,
  type AssistantTurn,
  type CallEvent,
  type ContentBlock,
  type MessageCreator,
} from "@tala/core";
import {
  buildReport,
  caseRow,
  formatEvent,
  type EvalCase,
  type SimulatedCall,
} from "@tala/evals";
import { loadKidlatFiber } from "@tala/kidlat-fiber";

/**
 * The acceptance test for masking (#10, Q21): no unmasked account or phone
 * number reaches a stored span, the supervisor's event stream, a stored
 * transcript, an eval report or the runner's printed log.
 *
 * It drives a call through the real call session, with a scripted model and
 * the Kidlat Fiber pack's in-memory world, in which the caller gives their
 * account number and mobile in several spellings (commas, brackets, an en
 * dash, a line break) and Tala and a tool input repeat them. Then it collects everything that is stored or sent, the way
 * the runner and the console do, and looks for the seed's real numbers.
 * Repo-level, because it reaches core and evals together. Needs no key.
 */

const pack = loadKidlatFiber();

const AT = new Date("2026-11-06T05:00:00Z");
const usage = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function turn(content: ContentBlock[]): AssistantTurn {
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_details: null,
    usage,
  };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): ContentBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

const EN_DASH = String.fromCharCode(0x2013);
const NEWLINE = String.fromCharCode(10);

const digitsOf = (s: string) => s.replace(/[^0-9]/g, "");

/**
 * What a leak would have to contain, as digits only: every seed account
 * number, every registered mobile in its +63 form AND its local 09 form, and
 * every payment reference that is a long run of digits.
 */
const MOBILES = pack.world.accounts.map((a) => digitsOf(a.registeredMobile));
const SECRETS = [
  ...pack.world.accounts.map((a) => digitsOf(a.accountNumber)),
  ...MOBILES,
  ...MOBILES.map((international) => "0" + international.slice(-10)),
  ...pack.world.payments.map((p) => digitsOf(p.reference)).filter((d) => d.length >= 10),
];

/**
 * The seed numbers found in an artifact once EVERY non-digit is removed from
 * it. That is independent of the separators the masking knows about, so a
 * spelling it misses still shows up here.
 */
function leaks(stored: unknown): string[] {
  const haystack = digitsOf(JSON.stringify(stored));
  return SECRETS.filter((digits) => haystack.includes(digits));
}

/** Seven asterisks then 0101, and not eight: the local 09... form, masked. */
const LOCAL_MASKED = /(?<![*])[*]{7}0101/;
/** Eight asterisks then 0101: the +63 form, masked. */
const INTERNATIONAL_MASKED = /(?<![*])[*]{8}0101/;
/** A 13-digit payment reference, masked. */
const REFERENCE_MASKED = /(?<![*])[*]{9}0564/;

async function theCall(): Promise<CallEvent[]> {
  const turns = [
    turn([
      text("Kinukumpirma ko po: account 8012345601, tama po? Ref 5647382910564."),
      toolUse("toolu_1", "verify_identity", {
        account_number: "801-234-5601",
        mobile_last4: "0101",
      }),
    ]),
    turn([text("Salamat po, Maria. Naka-register po ang +63 917 555 0101 o 09175550101, ending in 0101.")]),
    turn([
      text("Walang anuman po."),
      toolUse("toolu_2", "end_call", {
        outcome: "resolved",
        topic: "account_access",
        summary: "Caller verified their account and asked nothing else.",
      }),
    ]),
  ];
  const createMessage: MessageCreator = () => {
    const next = turns.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("out of turns"));
  };

  const events: CallEvent[] = [];
  let tick = AT.getTime();
  const session = createCallSession({
    pack,
    model: "haiku",
    provider: anthropicProvider,
    createMessage,
    callId: "call_masking",
    clock: () => new Date((tick += 1000)),
    budget: {
      config: { dailyCapNanos: 1_000_000_000, killSwitch: false, runsPerMinute: 10 },
      spentTodayNanos: 0,
    },
    onEvent: (event) => events.push(event),
  });
  session.start();
  await session.callerSaid("Hello po. Account number ko ay 801, 234, 5601, mobile (0917) 555 0101.");
  await session.callerSaid(
    "Ito po ulit:" +
      NEWLINE +
      ["0917", "555", "0101"].join(EN_DASH) +
      ", o +639175550101, at 8012-345-601. Wala na po, salamat.",
  );
  return events;
}

describe("masking, end to end", () => {
  it("the call itself holds the real numbers, so the checks below mean something", async () => {
    const events = await theCall();

    expect(leaks(events)).toEqual(
      expect.arrayContaining(["8012345601", "639175550101", "09175550101", "5647382910564"]),
    );
  });

  it("stores no unmasked number in span rows", async () => {
    const events = await theCall();
    const rows = events.flatMap((e) =>
      e.type === "span" ? [spanToRow({ workspaceId: "ws_demo", runId: "run_1" }, e.span)] : [],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(leaks(rows)).toEqual([]);
    expect(JSON.stringify(rows)).toContain("******5601");
  });

  it("streams no unmasked number to the supervisor's console", async () => {
    const events = await theCall();
    const frames = events.map((e) => encodeSseEvent(e.type, e));

    expect(leaks(frames)).toEqual([]);
    expect(frames.join("")).toContain("******5601");
    expect(frames.join("")).toMatch(LOCAL_MASKED);
    expect(frames.join("")).toMatch(INTERNATIONAL_MASKED);
    expect(frames.join("")).toMatch(REFERENCE_MASKED);
  });

  it("writes no unmasked number into the eval report, and prints none", async () => {
    const events = await theCall();
    const call: SimulatedCall = {
      events,
      stoppedBy: "call_ended",
      callerError: null,
      callerTurns: 2,
      callerCalls: [],
    };
    const kase: EvalCase = {
      slug: "masking",
      title: "Masking",
      caller: { brief: "You are Maria Santos.", maxTurns: 6 },
      expect: { endedBy: "end_call" },
    };
    const row = caseRow({
      case: kase,
      call,
      world: pack.world,
      plans: pack.plans,
      grade: { grade: null, reason: "not graded", usage: null, costNanos: 0, estimated: false },
      callId: "call_masking",
      latencyMs: 1,
    });
    const report = buildReport({
      ranAt: AT,
      pin: events.flatMap((e) => (e.type === "call_started" ? [e.pin] : []))[0],
      gitSha: null,
      gitDirty: null,
      callerModel: "sonnet",
      graderModel: "sonnet",
      rows: [row],
    });
    const printed = events.flatMap((e) => formatEvent(e) ?? []);

    // The scorer read the real call: it passed.
    expect(row.passed).toBe(true);
    expect(report.cases[0].transcript.length).toBeGreaterThan(0);
    expect(leaks(report)).toEqual([]);
    const transcript = JSON.stringify(report.cases[0].transcript);
    expect(transcript).toMatch(LOCAL_MASKED);
    expect(transcript).toMatch(INTERNATIONAL_MASKED);
    expect(transcript).toMatch(REFERENCE_MASKED);
    expect(printed.length).toBeGreaterThan(0);
    expect(leaks(printed)).toEqual([]);
  });
});
