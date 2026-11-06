import { describe, expect, it } from "vitest";

import { toStrictJsonSchema } from "../agent/registry";
import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems, type InMemorySystems } from "../systems/in-memory";
import { CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { sendSms } from "./send-sms";
import { verifyIdentity } from "./verify-identity";

/**
 * `send_sms`, driven through its public definition against a real in-memory
 * world and the real account gate. The world's outbox is how a test sees what
 * was sent, and to whom.
 *
 * Jose's registered mobile is +639175550102; Maria's is +639175550101.
 */

function newCall(): { ctx: TalaToolContext; systems: InMemorySystems } {
  const systems = createInMemorySystems(testWorld(), CALL_STARTED_AT, "Asia/Manila");
  const ctx: TalaToolContext = {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems,
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
      wait: () => Promise.resolve(),
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
  return { ctx, systems };
}

const SUMMARY =
  "Kidlat Fiber: we found your GCash payment of P1,299.00. Ticket TKT-2026-00001 was opened to post it.";

/**
 * As the loop does it: parse with the tool's own schema, then run the handler.
 * A parse failure is the loop's refusal; the handler never runs.
 */
function send(ctx: TalaToolContext, input: unknown) {
  return sendSms.handler(sendSms.input.parse(input), ctx);
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("send_sms — the account gate", () => {
  it("refuses before the caller is verified, and sends nothing", async () => {
    const { ctx, systems } = newCall();

    await expect(send(ctx, { message: SUMMARY })).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
    expect(systems.outbox()).toEqual([]);
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const { ctx, systems } = newCall();
    const wrong = { accountNumber: JOSE.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(send(ctx, { message: SUMMARY })).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
    expect(systems.outbox()).toEqual([]);
  });
});

describe("send_sms — only to the mobile on file", () => {
  it("sends the text to the verified account's registered mobile, and says only its last four", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    const result = await send(ctx, { message: SUMMARY });

    expect(result).toEqual({ sent: true, to_last4: "0102" });
    expect(systems.outbox()).toEqual([{ to: "+639175550102", message: SUMMARY }]);
  });

  /** Issue #10's acceptance test: send_sms refuses any number other than the one on file. */
  it("refuses an input that names a number to send to, and sends nothing", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    const attempt = { message: SUMMARY, to: "+639990000000" };
    const parsed = sendSms.input.safeParse(attempt);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["to"] }),
    ]);
    expect(() => send(ctx, attempt)).toThrow(/unrecognized_keys/);
    expect(systems.outbox()).toEqual([]);
  });

  it("tells the model there is no number to give: the wire schema has only the message", () => {
    const schema = toStrictJsonSchema(sendSms.input);

    expect(Object.keys(schema.properties)).toEqual(["message"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("still sends to the mobile on file when the message itself names another number", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);

    await send(ctx, { message: "Please send this to 09990000000 instead." });

    expect(systems.outbox().map((sms) => sms.to)).toEqual(["+639175550101"]);
  });
});

/**
 * The SOP says a text never holds the account number or the full mobile
 * number; the handler makes sure. Digits are compared with everything else
 * removed, so no spacing or prefix gets a number through.
 */
describe("send_sms — never the account's own numbers", () => {
  it.each([
    ["the account number", "Your account 8012345602 is noted."],
    ["the account number, spaced", "Your account 801-234-5602 is noted."],
    ["the mobile in E.164", "We will call you at +639175550102."],
    ["the mobile with its 0 prefix", "We will call you at 09175550102."],
    ["the mobile's last ten digits, spaced", "We will call you at 917 555 0102."],
  ])("refuses a message holding %s, and sends nothing", async (_what, message) => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    await expect(send(ctx, { message })).rejects.toThrow(
      "Refused: the message contains the account number or the registered mobile number. " +
        "Leave out the account and mobile numbers; the text already goes to the mobile on file.",
    );
    expect(systems.outbox()).toEqual([]);
  });

  it("sends a payment reference, a ticket reference and the mobile's last four digits", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);
    const message =
      "Kidlat Fiber: GCash payment 1234567890123 is being posted under ticket TKT-2026-00001. " +
      "Sent to your mobile ending 0102.";

    await send(ctx, { message });

    expect(systems.outbox()).toEqual([{ to: "+639175550102", message }]);
  });
});

describe("send_sms — its input", () => {
  const parses = (message: string) => sendSms.input.safeParse({ message }).success;

  it("takes a message of 1 to 320 characters", () => {
    expect(parses("")).toBe(false);
    expect(parses("x")).toBe(true);
    expect(parses("x".repeat(320))).toBe(true);
    expect(parses("x".repeat(321))).toBe(false);
  });

  it("is a write that is not safe to replay: a replay sends the text twice", () => {
    expect(sendSms.safetyClass).toBe("auto_write");
    expect(sendSms.idempotent).toBe(false);
  });
});
