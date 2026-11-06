/**
 * The business systems Tala works through, as adapter interfaces.
 *
 * Each interface is a seam a real company fills with its own system (DESIGN
 * §13): `CustomerAccounts` with its CRM, `NetworkOperations` with its OSS and
 * outage tooling, `Billing` with its billing and payment collection,
 * `Ticketing` with its ticketing system, `SmsGateway` with its SMS provider
 * and `FieldService` with its field-service system. The demo fills them with
 * an in-memory world built from the company pack's seed (`./in-memory`), a
 * fresh copy per call.
 *
 * Tool handlers reach the business only through `BusinessSystems`, so a unit
 * test needs a seed world, not a database. Every method is async because every
 * real implementation is a network call. Money is integer minor units
 * (centavos for PHP) everywhere, formatted only when spoken.
 *
 * #5 added accounts and outages; #10 added billing, tickets and SMS. #11 added
 * diagnosis and remote reboots to the network side, a ticket lookup, and the
 * field-service side, and changed one member: `createTicket` is told when the
 * ticket is opened, so a ticket can be checked as opened on the call. #16 adds
 * the plan-change side: quotes, and the plan changes made with them, and the
 * knowledge base: the company's help articles, searched.
 */
import type { HelpArticle } from "../pack/help-articles";

/** Where an account's line is: the unit outages are declared against. */
export interface ServiceArea {
  /** A stable slug, e.g. `batasan-hills`. */
  barangayId: string;
  /** For speech, e.g. `Batasan Hills`. */
  barangayName: string;
  /** e.g. `Quezon City`. */
  city: string;
}

export type AccountStatus = "active" | "suspended" | "disconnected";

export interface AccountRecord {
  /** Ten digits, normalized: no spaces or dashes. */
  accountNumber: string;
  holderName: string;
  /** E.164, e.g. `+639175550101`. Identity is checked against its last 4 digits. */
  registeredMobile: string;
  status: AccountStatus;
  /** The id of the account's plan in the company's plan catalog, e.g. `kidlat-300`. */
  planId: string;
  serviceArea: ServiceArea;
}

export interface OutageRecord {
  /** The reference a caller can quote back, e.g. `OUT-2026-0412`. */
  reference: string;
  /** For speech, e.g. `fiber cut along Batasan Road from road works`. */
  cause: string;
  barangayIds: string[];
  startedAt: Date;
  /** Null when the network team has not given one yet. */
  estimatedRestorationAt: Date | null;
}

/** The CRM side. */
export interface CustomerAccounts {
  /**
   * The account with exactly this number, or null.
   *
   * Takes a normalized number (`normalizeAccountNumber` in
   * `policy/identity`). Returns a copy: changing it changes nothing stored.
   */
  findAccount(accountNumber: string): Promise<AccountRecord | null>;
}

/**
 * How the network sees the modem at an account's home: `online` and working,
 * `degraded` (reachable, with a fault), or `offline`. The seed schema reads
 * this list.
 */
export const MODEM_STATUSES = ["online", "degraded", "offline"] as const;
export type ModemStatus = (typeof MODEM_STATUSES)[number];

/**
 * The network's own diagnosis of the connection at an account's home, as its
 * monitoring reads the modem. What it found is the system's, not Tala's: no
 * code turns a signal level into a verdict.
 */
export interface Diagnosis {
  modemStatus: ModemStatus;
  /** Optical power the modem receives, in dBm, e.g. `-19.5`. */
  receivedPowerDbm: number;
  /** When the network last heard from the modem. */
  lastSeenAt: Date;
  /** For speech, e.g. `high signal loss on the fiber line`. Null when the system found none. */
  fault: string | null;
  /** Whether the system says a remote reboot may clear the fault. */
  rebootMayClear: boolean;
}

/** The network operations side. */
export interface NetworkOperations {
  /** Ongoing outages that include this barangay, oldest first. Empty if none. */
  outagesAffecting(barangayId: string): Promise<OutageRecord[]>;
  /**
   * The diagnosis of this account's connection now, or null when no modem is
   * on record for it. Returns a copy.
   */
  diagnose(accountNumber: string): Promise<Diagnosis | null>;
  /**
   * Restarts this account's modem remotely. Resolves once the restart has
   * begun, with how long it takes in seconds, or null when no modem is on
   * record. A diagnosis once that time has passed reads the modem as it came
   * back.
   *
   * `requestedAt` is when the restart was asked for: the in-memory world has
   * no clock of its own, so it is told, and dates the modem's return from it.
   */
  rebootModem(accountNumber: string, requestedAt: Date): Promise<{ restartSeconds: number } | null>;
}

/**
 * The ways a payment can reach the company. The seed schema and
 * `verify_payment`'s description read this list, so a channel added here is
 * added to both.
 */
export const PAYMENT_CHANNELS = ["gcash", "maya", "bank", "seven_eleven", "bayad"] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/** What an account owes now. */
export interface BalanceRecord {
  /** In minor units. 0 when nothing is owed. */
  amountDueMinor: number;
  /** Null when nothing is due. */
  dueAt: Date | null;
  /** When service is to be cut for non-payment. Null when none is scheduled. */
  disconnectionAt: Date | null;
}

export interface BillRecord {
  /** e.g. `SOA-2610-5602`. */
  reference: string;
  amountMinor: number;
  issuedAt: Date;
}

export interface PaymentRecord {
  /** As the channel issued it, normalized: letters and digits only, upper case. */
  reference: string;
  channel: PaymentChannel;
  amountMinor: number;
  paidAt: Date;
  /** Whether it has been applied to the account. A payment can be received and not yet posted. */
  posted: boolean;
}

/** The billing and payment-collection side. */
export interface Billing {
  /** The account's balance, or null when the account has none on record. Returns a copy. */
  balanceOf(accountNumber: string): Promise<BalanceRecord | null>;
  /** The account's bills, newest first. Empty if none. */
  billsFor(accountNumber: string): Promise<BillRecord[]>;
  /** The account's payments, newest first. Empty if none. */
  paymentsFor(accountNumber: string): Promise<PaymentRecord[]>;
  /**
   * The payment with exactly this normalized reference, looked for among this
   * account's payments only, or null. Another account's payment is null too:
   * a caller can never learn about a payment by guessing its reference.
   */
  findPayment(accountNumber: string, reference: string): Promise<PaymentRecord | null>;
}

/** What a ticket is about. The ticket tool's input reads this list. */
export const TICKET_CATEGORIES = ["billing", "connection", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export interface NewTicket {
  /** Normalized. */
  accountNumber: string;
  category: TicketCategory;
  /** What the team working the ticket needs to know. */
  notes: string;
}

/** A ticket as the ticketing system holds it. */
export interface TicketRecord {
  reference: string;
  category: TicketCategory;
  notes: string;
  /** When it was opened. A ticket opened before a call started is not that call's. */
  openedAt: Date;
}

/** The ticketing side. */
export interface Ticketing {
  /**
   * Opens a ticket and returns the reference a caller can quote back, e.g.
   * `TKT-2026-00001`.
   *
   * `openedAt` is when it is opened: the in-memory world has no clock of its
   * own, so it is told, and `findTicket` gives it back.
   */
  createTicket(ticket: NewTicket, openedAt: Date): Promise<{ reference: string }>;
  /**
   * The ticket with exactly this reference, looked for among this account's
   * tickets only, or null. It may be from an earlier call: `openedAt` says
   * when it was opened. Returns a copy.
   */
  findTicket(accountNumber: string, reference: string): Promise<TicketRecord | null>;
}

/** A window in which a technician can visit a barangay. */
export interface TechnicianSlot {
  /** e.g. `san-antonio-1`. */
  slotId: string;
  barangayId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface NewVisit {
  /** Normalized. */
  accountNumber: string;
  slotId: string;
  /** The ticket the visit is for: a booking is always linked to one. */
  ticketReference: string;
}

/** The field-service side: the technicians' calendar and the visits booked on it. */
export interface FieldService {
  /** This barangay's slots that are not booked yet, soonest first. Empty if none. Copies. */
  availableSlots(barangayId: string): Promise<TechnicianSlot[]>;
  /**
   * Books a slot for a visit and returns the reference a caller can quote
   * back, e.g. `VIS-2026-00001`. Rejects when the slot does not exist or is
   * already booked: two visits never share a slot.
   */
  bookVisit(visit: NewVisit): Promise<{ reference: string }>;
  /**
   * The visit booked for this ticket, looked for among this account's visits
   * only, or null when the ticket has none.
   */
  visitForTicket(
    accountNumber: string,
    ticketReference: string,
  ): Promise<{ reference: string } | null>;
}

/** A plan change priced for an account, as the plan-change side is asked to keep it. */
export interface NewPlanQuote {
  /** Normalized. */
  accountNumber: string;
  /** The id of the plan the account was on when the change was priced. */
  currentPlanId: string;
  /** The id of the plan the change moves the account to. */
  newPlanId: string;
  /** The new plan's monthly price, in minor units. */
  newMonthlyPriceMinor: number;
  /** Added to the next bill, in minor units. */
  proratedAmountMinor: number;
  /** When the new plan starts. */
  effectiveAt: Date;
}

/** A quote as the plan-change side holds it. */
export interface PlanQuoteRecord extends NewPlanQuote {
  /** e.g. `QTE-2026-00001`. */
  reference: string;
  /** When it was made. A quote made before a call started is not that call's. */
  quotedAt: Date;
  /** Whether a plan change has been made with it. */
  used: boolean;
}

/** A plan change made on an account that takes effect later. */
export interface ScheduledPlanChange {
  /** The id of the plan the account moves to. */
  planId: string;
  /** When it moves. */
  effectiveAt: Date;
}

/** The plan-change side: quotes for plan changes, and the changes made with them. */
export interface PlanChanges {
  /**
   * Keeps a quote and returns the reference it goes by, e.g. `QTE-2026-00001`.
   *
   * `quotedAt` is when it was made: the in-memory world has no clock of its
   * own, so it is told, and `findQuote` gives it back.
   */
  createQuote(quote: NewPlanQuote, quotedAt: Date): Promise<{ reference: string }>;
  /**
   * The quote with exactly this reference, looked for among this account's
   * quotes only, or null. It may be from an earlier call (`quotedAt` says when
   * it was made) or used already. Returns a copy.
   */
  findQuote(accountNumber: string, reference: string): Promise<PlanQuoteRecord | null>;
  /**
   * Makes the change a quote priced, and marks the quote used.
   *
   * `appliedAt` is when it is made: the in-memory world has no clock of its
   * own, so it is told. A quote in effect by then moves the account to its new
   * plan at once, and drops any change scheduled for later. One that takes
   * effect later is scheduled instead, replacing any change already scheduled,
   * and the account stays on its plan until then. Rejects when this account
   * has no quote with this reference, or it is used: one quote changes a plan
   * once.
   */
  applyQuote(accountNumber: string, reference: string, appliedAt: Date): Promise<void>;
  /** The change scheduled for this account to take effect later, or null. Returns a copy. */
  scheduledChange(accountNumber: string): Promise<ScheduledPlanChange | null>;
}

/** How many articles a knowledge-base search gives at most. */
export const MAX_HELP_RESULTS = 3;

/** The knowledge base: the company's help articles, which hold nothing about any account. */
export interface KnowledgeBase {
  /**
   * The articles that best answer this question, best first, at most
   * `MAX_HELP_RESULTS`. Empty when none matches. Copies.
   */
  search(query: string): Promise<HelpArticle[]>;
}

export interface SmsMessage {
  /** E.164, e.g. `+639175550102`. */
  to: string;
  message: string;
}

/**
 * The SMS provider. It sends to the number it is given. The model never
 * chooses that number: `send_sms` passes only the verified account's
 * registered mobile.
 */
export interface SmsGateway {
  send(sms: SmsMessage): Promise<void>;
}

export interface BusinessSystems {
  accounts: CustomerAccounts;
  network: NetworkOperations;
  billing: Billing;
  tickets: Ticketing;
  sms: SmsGateway;
  fieldService: FieldService;
  plans: PlanChanges;
  knowledgeBase: KnowledgeBase;
}
