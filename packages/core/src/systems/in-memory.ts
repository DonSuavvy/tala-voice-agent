/**
 * The in-memory `BusinessSystems`: the world every demo call and unit test
 * runs on.
 *
 * Built from a seed world and the moment the call started. Two things matter
 * about it:
 *
 * - Each call gets a fresh copy of the seed (spec: "each call starts from a
 *   fresh copy of the seed world"). The seed is cloned on creation, so two
 *   calls never share state and nothing a call does can reach the seed. The
 *   tickets a call opens, the texts it sends and the modems it reboots live
 *   in that copy too.
 * - It never reads the wall clock. The seed stores times relative to the
 *   call's start (see `./seed-world`); `callStartedAt` turns those offsets
 *   into dates, and a reboot is told when it was asked for. That also makes
 *   tests deterministic.
 *
 * Everything handed out is a copy, so a caller that mutates a result changes
 * nothing stored.
 */
import type { SeedWorld } from "./seed-world";
import { slotWindow } from "./slot-window";
import type {
  AccountRecord,
  BalanceRecord,
  BillRecord,
  BusinessSystems,
  Diagnosis,
  NewTicket,
  NewVisit,
  OutageRecord,
  PaymentRecord,
  SmsMessage,
  TechnicianSlot,
  TicketRecord,
} from "./types";

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

export interface OpenedTicket extends NewTicket {
  reference: string;
}

export interface BookedVisit extends NewVisit {
  reference: string;
}

/**
 * The in-memory world, plus what a test reads back: the tickets this call
 * opened, the texts it sent and the visits it booked. A real company reads
 * those in its own ticketing system, SMS provider and dispatch; no tool can.
 */
export interface InMemorySystems extends BusinessSystems {
  /** Tickets opened on this call, oldest first. Copies. */
  openedTickets(): OpenedTicket[];
  /** Texts sent on this call, oldest first. Copies. */
  outbox(): SmsMessage[];
  /** Technician visits booked on this call, oldest first, each with its ticket. Copies. */
  bookedVisits(): BookedVisit[];
}

/**
 * `timeZone` is the company's (an IANA name such as `Asia/Manila`): technician
 * slots are stated by the call's local date, so the world needs it to place
 * them.
 */
export function createInMemorySystems(
  seed: SeedWorld,
  callStartedAt: Date,
  timeZone: string,
): InMemorySystems {
  const world = structuredClone(seed);
  const tickets: OpenedTicket[] = [];
  const outbox: SmsMessage[] = [];
  const visits: BookedVisit[] = [];
  const minutesFromStart = (minutes: number) =>
    new Date(callStartedAt.getTime() + minutes * MINUTE_MS);

  const findAccount = (accountNumber: string): AccountRecord | null => {
    const account = world.accounts.find((a) => a.accountNumber === accountNumber);
    if (!account) return null;
    // The schema guarantees the barangay exists; a seed that skipped the
    // schema and dangles fails loudly here rather than serving a half record.
    const barangay = world.barangays.find((b) => b.id === account.barangayId);
    if (!barangay) {
      throw new Error(
        `account ${account.accountNumber} names unknown barangay "${account.barangayId}"`,
      );
    }
    return {
      accountNumber: account.accountNumber,
      holderName: account.holderName,
      registeredMobile: account.registeredMobile,
      status: account.status,
      planName: account.planName,
      serviceArea: {
        barangayId: barangay.id,
        barangayName: barangay.name,
        city: barangay.city,
      },
    };
  };

  const outagesAffecting = (barangayId: string): OutageRecord[] =>
    // Array.prototype.sort is stable, so equal start times keep seed order.
    world.outages
      .filter((o) => o.barangayIds.includes(barangayId))
      .sort((a, b) => b.startedMinutesBeforeCall - a.startedMinutesBeforeCall)
      .map((o) => ({
        reference: o.reference,
        cause: o.cause,
        barangayIds: [...o.barangayIds],
        startedAt: minutesFromStart(-o.startedMinutesBeforeCall),
        estimatedRestorationAt:
          o.restorationMinutesAfterCall === null
            ? null
            : minutesFromStart(o.restorationMinutesAfterCall),
      }));

  const balanceOf = (accountNumber: string): BalanceRecord | null => {
    const balance = world.balances.find((b) => b.accountNumber === accountNumber);
    if (!balance) return null;
    return {
      amountDueMinor: balance.amountDueMinor,
      dueAt:
        balance.dueMinutesBeforeCall === null
          ? null
          : minutesFromStart(-balance.dueMinutesBeforeCall),
      disconnectionAt:
        balance.disconnectionMinutesAfterCall === null
          ? null
          : minutesFromStart(balance.disconnectionMinutesAfterCall),
    };
  };

  // Newest first is the smallest offset first; the sort is stable, so equal
  // times keep seed order.
  const billsFor = (accountNumber: string): BillRecord[] =>
    world.bills
      .filter((b) => b.accountNumber === accountNumber)
      .sort((a, b) => a.issuedMinutesBeforeCall - b.issuedMinutesBeforeCall)
      .map((b) => ({
        reference: b.reference,
        amountMinor: b.amountMinor,
        issuedAt: minutesFromStart(-b.issuedMinutesBeforeCall),
      }));

  const toPaymentRecord = (p: SeedWorld["payments"][number]): PaymentRecord => ({
    reference: p.reference,
    channel: p.channel,
    amountMinor: p.amountMinor,
    paidAt: minutesFromStart(-p.paidMinutesBeforeCall),
    posted: p.posted,
  });

  const paymentsFor = (accountNumber: string): PaymentRecord[] =>
    world.payments
      .filter((p) => p.accountNumber === accountNumber)
      .sort((a, b) => a.paidMinutesBeforeCall - b.paidMinutesBeforeCall)
      .map(toPaymentRecord);

  const findPayment = (accountNumber: string, reference: string): PaymentRecord | null => {
    const payment = world.payments.find(
      (p) => p.accountNumber === accountNumber && p.reference === reference,
    );
    return payment ? toPaymentRecord(payment) : null;
  };

  type ModemSeed = SeedWorld["modems"][number];
  const toDiagnosis = (
    reading: ModemSeed | ModemSeed["afterReboot"],
    lastSeenAt: Date,
  ): Diagnosis => ({
    modemStatus: reading.status,
    receivedPowerDbm: reading.receivedPowerDbm,
    lastSeenAt,
    fault: reading.fault,
    rebootMayClear: reading.rebootMayClear,
  });

  // Each account's modem as the network reads it now: the seed's diagnosis
  // until a reboot, then the seed's state after one, back when it finished.
  const modems = new Map<string, Diagnosis>(
    world.modems.map((m) => [
      m.accountNumber,
      toDiagnosis(m, minutesFromStart(-m.lastSeenMinutesBeforeCall)),
    ]),
  );

  const diagnose = (accountNumber: string): Diagnosis | null => {
    const diagnosis = modems.get(accountNumber);
    return diagnosis ? { ...diagnosis, lastSeenAt: new Date(diagnosis.lastSeenAt) } : null;
  };

  const rebootModem = (
    accountNumber: string,
    requestedAt: Date,
  ): { restartSeconds: number } | null => {
    const modem = world.modems.find((m) => m.accountNumber === accountNumber);
    if (!modem) return null;
    const backAt = new Date(requestedAt.getTime() + modem.restartSeconds * SECOND_MS);
    modems.set(accountNumber, toDiagnosis(modem.afterReboot, backAt));
    return { restartSeconds: modem.restartSeconds };
  };

  // Deterministic within a call: the call's first ticket is always 00001, and
  // its first visit too, in the year the call started (UTC).
  const nextReference = (prefix: string, count: number): string =>
    `${prefix}-${callStartedAt.getUTCFullYear()}-${String(count + 1).padStart(5, "0")}`;

  const createTicket = (ticket: NewTicket): { reference: string } => {
    const reference = nextReference("TKT", tickets.length);
    const { accountNumber, category, notes } = ticket;
    tickets.push({ reference, accountNumber, category, notes });
    return { reference };
  };

  // The world holds only the tickets this call opened, so a ticket found here
  // was opened on this call.
  const findTicket = (accountNumber: string, reference: string): TicketRecord | null => {
    const ticket = tickets.find(
      (t) => t.accountNumber === accountNumber && t.reference === reference,
    );
    if (!ticket) return null;
    return { reference: ticket.reference, category: ticket.category, notes: ticket.notes };
  };

  const isBooked = (slotId: string): boolean => visits.some((v) => v.slotId === slotId);

  // Soonest first; the sort is stable, so equal starts keep seed order.
  const availableSlots = (barangayId: string): TechnicianSlot[] =>
    world.technicianSlots
      .filter((s) => s.barangayId === barangayId && !isBooked(s.id))
      .map((s) => ({
        slotId: s.id,
        barangayId: s.barangayId,
        ...slotWindow(s, callStartedAt, timeZone),
      }))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const bookVisit = (visit: NewVisit): { reference: string } => {
    const slot = world.technicianSlots.find((s) => s.id === visit.slotId);
    if (!slot || isBooked(slot.id)) {
      throw new Error(`technician slot "${visit.slotId}" is not available`);
    }
    const reference = nextReference("VIS", visits.length);
    const { accountNumber, slotId, ticketReference } = visit;
    visits.push({ reference, accountNumber, slotId, ticketReference });
    return { reference };
  };

  // Every real implementation is a network call, so these are async. Wrapping
  // in a promise (rather than an async body) turns a throw into a rejection.
  const later = <T>(work: () => T): Promise<T> => Promise.resolve().then(work);

  return {
    accounts: { findAccount: (n) => later(() => findAccount(n)) },
    network: {
      outagesAffecting: (id) => later(() => outagesAffecting(id)),
      diagnose: (n) => later(() => diagnose(n)),
      rebootModem: (n, requestedAt) => later(() => rebootModem(n, requestedAt)),
    },
    billing: {
      balanceOf: (n) => later(() => balanceOf(n)),
      billsFor: (n) => later(() => billsFor(n)),
      paymentsFor: (n) => later(() => paymentsFor(n)),
      findPayment: (n, reference) => later(() => findPayment(n, reference)),
    },
    tickets: {
      createTicket: (ticket) => later(() => createTicket(ticket)),
      findTicket: (n, reference) => later(() => findTicket(n, reference)),
    },
    sms: {
      send: (sms) =>
        later(() => {
          outbox.push({ to: sms.to, message: sms.message });
        }),
    },
    fieldService: {
      availableSlots: (id) => later(() => availableSlots(id)),
      bookVisit: (visit) => later(() => bookVisit(visit)),
    },
    openedTickets: () => tickets.map((t) => ({ ...t })),
    outbox: () => outbox.map((m) => ({ ...m })),
    bookedVisits: () => visits.map((v) => ({ ...v })),
  };
}
