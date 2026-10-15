// Finance import: source keys, fingerprints and deterministic ids (spec p2i_parsers_rules §9,
// p2i_db_contract §3). Everything here runs in TypeScript (browser) and must never be
// re-implemented in SQL: jsonb reorders keys and PostgreSQL formats numbers differently (C10).

import type { ReportBucket, Subcategory } from "../finance";
import type { LegacyAccount } from "./types";

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 over the UTF-8 bytes of `s`, lower-case hex. Web Crypto, with a node fallback for tests. */
export async function sha256hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const subtle = typeof globalThis.crypto !== "undefined" ? globalThis.crypto.subtle : undefined;
  if (subtle) return hex(await subtle.digest("SHA-256", data));
  // Browsers expose crypto.subtle only on secure origins (HTTPS or localhost).
  if (typeof process === "undefined" || !process.versions?.node)
    throw new Error("Bu bağlantıda güvenli şifreleme yok; finans aktarımı için sayfayı HTTPS üzerinden açın.");
  // Node without a global Web Crypto (tests only). The specifier is hidden from bundlers.
  const specifier = "node:crypto";
  const nodeCrypto = (await import(/* webpackIgnore: true */ specifier)) as {
    createHash: (alg: string) => { update: (d: Uint8Array) => { digest: (enc: "hex") => string } };
  };
  return nodeCrypto.createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Key templates (§9.1). Template literals use ECMAScript Number::toString on purpose.
// ---------------------------------------------------------------------------

export const workbookReceiptsKey = (date: string): string => `clinic:${date}:receipts`;
/** `index` is the 0-based array index in sheet_to_json output (FI:64 uses i+1). */
export const workbookExpenseKey = (date: string, index: number): string => `clinic:${date}:expense:${index + 1}`;
/** FI:23-24. `bankAccount` = '<Bank>:<account>'; `amountTl` is the signed JS float in TL. */
export const knownBankKey = (bankAccount: string, date: string, amountTl: number, balance: string, reference = ""): string =>
  `bank:${bankAccount}:${date}:${amountTl}:${balance}:${reference}`;
/** BT:48 + BM:13: the stored generic-table key. */
export async function bankTableKey(identity: string, occurrence: number): Promise<string> {
  return "bank-table:" + (await sha256hex(bankTablePreKey(identity, occurrence)));
}
export const bankTablePreKey = (identity: string, occurrence: number): string =>
  "bank-table:" + encodeURIComponent(identity) + ":" + occurrence;
/** RT:61 (`provider` = 'burgan' for the legacy reader). */
export const financingKey = (reference: string, date: string, provider = "burgan"): string =>
  `${provider}-finance:${reference}:${date}`;
/** Phase 5 daily receipts from DentOS payments (critique 13). */
export const dentosReceiptsKey = (date: string): string => `dentos:${date}:receipts`;

// ---------------------------------------------------------------------------
// Deterministic ids (p2i_db_contract §3.2)
// ---------------------------------------------------------------------------

/** IR:26 uuid shape of a sha256 hex digest. */
export const uuidShape = (h: string): string =>
  h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);

/** Imported entry id (= its single payment id); also the financing fee entry id. */
export async function importedEntryId(clinicId: string, key: string): Promise<string> {
  return uuidShape(await sha256hex(clinicId + "|" + key));
}
export async function financingRowId(clinicId: string, key: string): Promise<string> {
  return uuidShape(await sha256hex(clinicId + "|financing|" + key));
}

// ---------------------------------------------------------------------------
// Fingerprint (§9.3; IR:26-28 with the zod key order and trims of FM:26)
// ---------------------------------------------------------------------------

/** Legacy category label per report bucket (FM:4-18; 0020 seed names). */
export const LEGACY_CATEGORY: Record<ReportBucket, string> = {
  patient_receipts: "Hasta tahsilatı",
  other_income: "Diğer faaliyet geliri",
  rent: "Kira",
  doctor: "Hekim hakedişi",
  lab: "Laboratuvar",
  supplies: "Sarf / tedarikçi",
  personnel: "Personel",
  tax: "Vergi / SGK",
  other_expense: "Diğer faaliyet gideri",
  distribution: "Ortak dağıtımı",
  capital: "Sermaye / borç girişi",
  principal: "Kredi / borç anapara ödemesi",
  fees: "Faiz / banka masrafı",
  asset: "Demirbaş alımı",
};

export const LEGACY_SUB: Record<Subcategory, string> = {
  current_physician: "Cari dönem hekim hakedişi",
  past_physician_debt: "Geçmiş dönem hekim hakedişi borç ödemesi",
  official_fee: "Resmi harç",
};

/** Legacy official-fee test (IP:54): raw text, non-unicode /i, so 'TEFTİŞ DEFTERİ' (dotted capital) does not match. */
const OFFICIAL_FEE = /teftiş defteri/i;

/**
 * The subcategory a parsed row starts with: legacy's (IP:54) only. A rule's subcategory is informational
 * (spec §10.2), so rule matches never change a fingerprint; doctor rows are decided at save time.
 */
export function legacySubcategory(bucket: ReportBucket | null, description: string): Subcategory | null {
  return bucket === "other_expense" && OFFICIAL_FEE.test(description) ? "official_fee" : null;
}

/**
 * Subcategory as legacy sent it (IP:54), after review edits:
 * doctor → past when the entitlement month is before the row month, else current;
 * other_expense → official fee for 'teftiş defteri', or when the user picked 'Resmi harç' in the review table
 * (`chosen`; rows start with legacySubcategory, so an untouched row hashes exactly as legacy); else none.
 */
export function importSubcategory(
  bucket: ReportBucket | null,
  description: string,
  date: string,
  entitlementMonth: string | null,
  chosen: Subcategory | null = null,
): Subcategory | null {
  if (bucket === "doctor") return entitlementMonth && entitlementMonth < date.slice(0, 7) ? "past_physician_debt" : "current_physician";
  if (bucket === "other_expense" && (chosen === "official_fee" || OFFICIAL_FEE.test(description))) return "official_fee";
  return null;
}

/**
 * Counterparty text as legacy built it (IP:54): a chosen master's name (entitlement rows);
 * otherwise any patient_receipts row gets the layout's receipts text ('Günlük toplam');
 * otherwise the first 200 characters of the description. Trimmed by the fingerprint.
 */
export function importCounterparty(input: {
  bucket: ReportBucket | null;
  description: string;
  counterpartyName?: string | null;
  receiptsCounterpartyText: string;
}): string {
  if (input.counterpartyName) return input.counterpartyName;
  if (input.bucket === "patient_receipts") return input.receiptsCounterpartyText;
  return input.description.slice(0, 200);
}

export type FingerprintInput = {
  bucket: ReportBucket;
  /** Name of the DentOS category (used only when it is not a system category). */
  categoryName: string;
  isSystem: boolean;
  subcategory: Subcategory | null;
  counterparty: string;
  description: string;
  date: string;
  amount: number;
  entitlementMonth: string | null;
  legacyAccount: LegacyAccount;
};

/** The exact JSON string legacy hashed (exported for tests: key order must be asserted as a string). */
export function fingerprintPayload(r: FingerprintInput): string {
  const details: Record<string, unknown> = { category: r.isSystem ? LEGACY_CATEGORY[r.bucket] : r.categoryName };
  if (r.subcategory) details.subcategory = LEGACY_SUB[r.subcategory];
  details.counterparty = r.counterparty.trim();
  details.description = r.description.trim();
  details.dueDate = r.date;
  details.amountCents = r.amount;
  if (r.entitlementMonth) details.entitlementMonth = r.entitlementMonth;
  return JSON.stringify({ details, paid: r.amount, paymentDate: r.date, account: r.legacyAccount });
}

export async function importFingerprint(r: FingerprintInput): Promise<string> {
  return sha256hex(fingerprintPayload(r));
}
