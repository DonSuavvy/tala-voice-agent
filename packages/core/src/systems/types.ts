/**
 * The business systems Tala works through, as adapter interfaces.
 *
 * Each interface is a seam a real company fills with its own system (DESIGN
 * §13): `CustomerAccounts` with its CRM, `NetworkOperations` with its OSS and
 * outage tooling, `Billing` with its billing and payment collection,
 * `Ticketing` with its ticketing system and `SmsGateway` with its SMS
 * provider. The demo fills them with an in-memory world built from the company
 * pack's seed (`./in-memory`), a fresh copy per call.
 *
 * Tool handlers reach the business only through `BusinessSystems`, so a unit
 * test needs a seed world, not a database. Every method is async because every
 * real implementation is a network call. Money is integer minor units
 * (centavos for PHP) everywhere, formatted only when spoken.
 *
 * #5 added accounts and outages; #10 added billing, tickets and SMS. Later
 * tickets add diagnostics and technician slots (#11) and plans (#16). Each
 * adds its own interfaces; none changes the ones already here.
 */

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
  /** As the caller knows it, e.g. `Kidlat 300`. The plan catalog is #16. */
  planName: string;
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

/** The network operations side. */
export interface NetworkOperations {
  /** Ongoing outages that include this barangay, oldest first. Empty if none. */
  outagesAffecting(barangayId: string): Promise<OutageRecord[]>;
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

/** The ticketing side. */
export interface Ticketing {
  /** Opens a ticket and returns the reference a caller can quote back, e.g. `TKT-2026-00001`. */
  createTicket(ticket: NewTicket): Promise<{ reference: string }>;
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
}
