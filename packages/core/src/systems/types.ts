/**
 * The business systems Tala works through, as adapter interfaces.
 *
 * Each interface is a seam a real company fills with its own system (DESIGN
 * §13): `CustomerAccounts` with its CRM and billing, `NetworkOperations` with
 * its OSS and outage tooling. The demo fills them with an in-memory world
 * built from the company pack's seed (`./in-memory`), a fresh copy per call.
 *
 * Tool handlers reach the business only through `BusinessSystems`, so a unit
 * test needs a seed world, not a database. Every method is async because every
 * real implementation is a network call.
 *
 * Later tickets add billing history and payments (#10), diagnostics, tickets
 * and technician slots (#11), plans (#16) and SMS (#11). Each grows this file
 * by one interface; none changes the ones here.
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

/** The CRM and billing side. */
export interface CustomerAccounts {
  /**
   * The account with exactly this number, or null.
   *
   * Takes a normalized number (`normalizeAccountNumber` in
   * `policy/identity`). Returns a copy: changing it changes nothing stored.
   */
  findAccount(accountNumber: string): Promise<AccountRecord | null>;
}

/** The network operations side. */
export interface NetworkOperations {
  /** Ongoing outages that include this barangay, oldest first. Empty if none. */
  outagesAffecting(barangayId: string): Promise<OutageRecord[]>;
}

export interface BusinessSystems {
  accounts: CustomerAccounts;
  network: NetworkOperations;
}
