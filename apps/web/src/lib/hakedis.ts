// Hakediş (doctor earnings) v1 client helpers: labels, bp / percent and month helpers, typed RPC wrappers and a pure
// mirror of fin_hk__compute. Contract: hakediş spec §1 (fin_hk_* / hk_* RPCs, 0030_hakedis.sql) and §2, with the
// v1.1 additions: child patients by birth date (fin_settings.hk_child_age_limit, fin_hk_patient_marks.birth_date) and
// the reception's patient marking RPCs (hk_marks_*, hk_save_mark; no amounts), and v1.2 (0031_hakedis_payroll.sql):
// staff payroll (rule kind fixed_monthly = monthly net salary, monthly bonus / other adjustments in
// fin_hk_adjustments) and the 'hakedis_prepare' permission (fin_hk_* data entry without the ledger).
// Every rate and amount is data entered by the owner (basis points and integer cents); nothing here is hard-coded.
// Month arguments are sent as 'YYYY-MM-01' dates; month values read back may be 'YYYY-MM' or 'YYYY-MM-DD', so every
// helper compares them through monthKey().

import { formatTL, toFinanceError } from "./finance";
import type { Currency, PaymentMethod } from "./payments";
import { createClient } from "./supabase";

// ---------------------------------------------------------------------------
// Codes and labels (§2)
// ---------------------------------------------------------------------------

export type HkMethod = PaymentMethod;
export type HkCurrency = Currency;
/** Rule kinds (fin_hk_rules.kind). fixed_monthly (0031): monthly net salary of any active user, in piece_cents. */
export type HkKind = "ciro_share" | "ortho_lab_first" | "implant_piece" | "clinic_ciro_share" | "fixed_monthly";
/** Component kinds of a payee: one per active rule, plus one 'adjustments' component (no rule) for the month's bonuses. */
export type HkComponentKind = HkKind | "adjustments";
/** fin_hk_adjustments.kind (0031): bonus, or anything else (negative = deduction). */
export type HkAdjustmentKind = "bonus" | "other";
export type HkSegment = "standard" | "child" | "own";
/** Lines: manual / import / burgan; pieces: manual / import / clinical (0030 CHECKs). */
export type HkSource = "manual" | "import" | "burgan" | "clinical";
export type HkMonthStatus = "open" | "closed";

/** Display order everywhere (tables, by_method columns). */
export const HK_METHODS: readonly HkMethod[] = ["cash", "card", "transfer", "financing"];
export const HK_SEGMENTS: readonly HkSegment[] = ["standard", "child", "own"];
/** Rule kinds in display order; also the component order of a payee (the 'adjustments' component comes last). */
export const HK_KINDS: readonly HkKind[] = [
  "ciro_share",
  "ortho_lab_first",
  "implant_piece",
  "clinic_ciro_share",
  "fixed_monthly",
];
export const HK_ADJUSTMENT_KINDS: readonly HkAdjustmentKind[] = ["bonus", "other"];

export const METHOD_LABELS: Record<HkMethod, string> = {
  cash: "Nakit",
  card: "Kart",
  transfer: "Havale / EFT",
  financing: "Finansman (Burgan)",
};

export const SEGMENT_LABELS: Record<HkSegment, string> = {
  standard: "Standart",
  child: "Çocuk hasta",
  own: "Hekimin kendi hastası",
};

export const KIND_LABELS: Record<HkKind, string> = {
  ciro_share: "Ciro payı",
  ortho_lab_first: "Ortodonti (önce lab)",
  implant_piece: "İmplant (adet başı)",
  clinic_ciro_share: "Yönetim payı (klinik cirosu)",
  fixed_monthly: "Sabit aylık maaş",
};

export const ADJUSTMENT_KIND_LABELS: Record<HkAdjustmentKind, string> = {
  bonus: "Prim",
  other: "Diğer",
};

/** Title of a payee's 'adjustments' component (the month's bonus / other rows together). */
export const ADJUSTMENTS_COMPONENT_LABEL = "Prim ve diğer";

export const MONTH_STATUS_LABELS: Record<HkMonthStatus, string> = {
  open: "Açık",
  closed: "Kapatıldı",
};

export const SOURCE_LABELS: Record<HkSource, string> = {
  manual: "Elle girildi",
  import: "Dosyadan aktarıldı",
  burgan: "Burgan aktarımı",
  clinical: "Klinik kayıtlarından",
};

/** Which form fields a rule kind uses (§1 fin_hk_rules checks); the others are sent as null / 0. */
export const RULE_FIELDS: Record<
  HkKind,
  { doctor: boolean; segment: boolean; share: boolean; piece: boolean; deductions: boolean }
> = {
  ciro_share: { doctor: true, segment: true, share: true, piece: false, deductions: true },
  ortho_lab_first: { doctor: true, segment: false, share: true, piece: false, deductions: true },
  implant_piece: { doctor: true, segment: false, share: false, piece: true, deductions: false },
  clinic_ciro_share: { doctor: false, segment: false, share: true, piece: false, deductions: false },
  // piece_cents holds the monthly net salary; the payee may be any active user of the clinic (staff or doctor).
  fixed_monthly: { doctor: false, segment: false, share: false, piece: true, deductions: false },
};

/** Label of the piece_cents field of a rule kind that uses it (rules editor). */
export function pieceFieldLabel(kind: HkKind): string {
  return kind === "fixed_monthly" ? "Aylık net maaş (TL)" : "İmplant başı tutar (TL)";
}

const DEDUCT_FIELD: Record<
  HkMethod,
  "deduct_cash_bp" | "deduct_card_bp" | "deduct_transfer_bp" | "deduct_financing_bp"
> = {
  cash: "deduct_cash_bp",
  card: "deduct_card_bp",
  transfer: "deduct_transfer_bp",
  financing: "deduct_financing_bp",
};

// ---------------------------------------------------------------------------
// Exact rounding: round half away from zero, the same as PostgreSQL round(numeric)
// ---------------------------------------------------------------------------

/** num / den rounded half away from zero, in BigInt (den > 0). Math.round would round -0.5 up to 0. */
export function roundHalfAwayDiv(num: bigint, den: bigint): bigint {
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = (abs * 2n + den) / (2n * den);
  return negative ? -q : q;
}

/** round_half_away(cents × bp / 10000); exact for any cents and bp. */
export function applyBp(cents: number, bp: number): number {
  return Number(roundHalfAwayDiv(BigInt(cents) * BigInt(bp), 10000n));
}

// ---------------------------------------------------------------------------
// Basis points <-> percent text ("%30", "%12,5")
// ---------------------------------------------------------------------------

/** 3000 → "30", 1250 → "12,5", 1205 → "12,05" (editable input value, parses back unchanged). */
export function bpToInput(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return "";
  const negative = bp < 0;
  const abs = Math.abs(Math.trunc(bp));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0").replace(/0$/, "");
  return `${negative ? "-" : ""}${whole}${frac && frac !== "0" ? "," + frac : ""}`;
}

/** 3000 → "%30", 1250 → "%12,5"; null → "—". */
export function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return "—";
  return `%${bpToInput(bp)}`;
}

export type PercentParse = { ok: true; bp: number } | { ok: false; error: string };

/**
 * "30", "12,5", "12.5", "%30" or "30%" → basis points (at most 2 decimals, 0..100). Shares need allowZero false
 * (1..10000 bp); deductions allow 0.
 */
export function parsePercent(raw: string, opts: { allowZero?: boolean } = {}): PercentParse {
  const s = (raw ?? "").replace(/\s+/g, "").replace(/^%/, "").replace(/%$/, "");
  if (s === "") return { ok: false, error: "Oran girin." };
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return { ok: false, error: "Geçersiz oran. Örnek: 30 veya 12,5" };
  const frac = m[2] ?? "";
  if (frac.length > 2) return { ok: false, error: "Oran en fazla 2 ondalık basamaklı olabilir." };
  const intPart = m[1].replace(/^0+(?=\d)/, "");
  if (intPart.length > 3) return { ok: false, error: "Oran %100'den büyük olamaz." };
  const bp = Number(intPart) * 100 + Number(frac.padEnd(2, "0"));
  if (bp > 10000) return { ok: false, error: "Oran %100'den büyük olamaz." };
  if (bp === 0 && !opts.allowZero) return { ok: false, error: "Oran %0'dan büyük olmalı." };
  return { ok: true, bp };
}

// ---------------------------------------------------------------------------
// Months and patient keys
// ---------------------------------------------------------------------------

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/;

/** 'YYYY-MM' of a month or day value ('YYYY-MM' / 'YYYY-MM-DD'); other text is returned unchanged. */
export function monthKey(value: string): string {
  return MONTH_KEY_RE.test(value) ? value.slice(0, 7) : value;
}

/** 'YYYY-MM-01': the wire format of every p_month / p_from_month / p_to_month argument (SQL date). */
export function monthStart(value: string): string {
  return `${monthKey(value)}-01`;
}

/** monthKey shifted by n months ('2026-11', -1 → '2026-10'). */
export function addMonths(value: string, n: number): string {
  const key = monthKey(value);
  const total = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + n;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** Status of a month from fin_hk_reference().months; a month without a row is open. */
export function monthStatus(months: readonly { month: string; status: HkMonthStatus }[], month: string): HkMonthStatus {
  const key = monthKey(month);
  return months.find((m) => monthKey(m.month) === key)?.status ?? "open";
}

/** §2 month picker default: the previous month while it is still open, else the current month ('YYYY-MM'). */
export function pickDefaultMonth(
  currentMonth: string,
  months: readonly { month: string; status: HkMonthStatus }[]
): string {
  const previous = addMonths(currentMonth, -1);
  return monthStatus(months, previous) === "open" ? previous : monthKey(currentMonth);
}

const TR_UPPER = "İIÇĞÖŞÜÂÎÛ";
const TR_LOWER = "iıçğöşüâîû";

/** Mirror of fin__normalize_name: Turkish lower case, whitespace collapsed, trimmed (manual patient_ref). */
export function normalizePatientRef(name: string | null | undefined): string {
  let s = "";
  for (const ch of name ?? "") {
    const i = TR_UPPER.indexOf(ch);
    s += i >= 0 ? TR_LOWER[i] : ch;
  }
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Child patients by age (v1.1 item 2): fin_settings.hk_child_age_limit and fin_hk_patient_marks.birth_date
// ---------------------------------------------------------------------------

/** fin_settings.hk_child_age_limit default and CHECK range (years). */
export const HK_DEFAULT_CHILD_AGE_LIMIT = 14;
export const HK_CHILD_AGE_LIMIT_MIN = 1;
export const HK_CHILD_AGE_LIMIT_MAX = 18;
/** fin_hk_patient_marks.birth_date lower bound (CHECK). */
export const HK_MIN_BIRTH_DATE = "1900-01-01";

/** The child age limit of a settings object; the column default when it is absent. */
export function childAgeLimitOf(settings: { child_age_limit?: number | null } | null | undefined): number {
  const v = settings?.child_age_limit;
  return typeof v === "number" && Number.isFinite(v) ? v : HK_DEFAULT_CHILD_AGE_LIMIT;
}

/** Client-side mirror of the fin_hk_save_settings check; null when valid. */
export function validateChildAgeLimit(value: number | null | undefined): string | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < HK_CHILD_AGE_LIMIT_MIN ||
    value > HK_CHILD_AGE_LIMIT_MAX
  ) {
    return `Çocuk hasta yaş sınırı ${HK_CHILD_AGE_LIMIT_MIN} ile ${HK_CHILD_AGE_LIMIT_MAX} arasında olmalı.`;
  }
  return null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number) =>
  m === 2 ? (isLeapYear(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;

/** [year, month, day] of a 'YYYY-MM-DD' value (a timestamp's date part too); null when it is not a real date. */
function parseDay(value: string | null | undefined): [number, number, number] | null {
  const m = DAY_RE.exec(value ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return [y, mo, d];
}

/** Whole years from `from` to `to` (from ≤ to): the year field of PostgreSQL age(to, from). */
function wholeYears(from: [number, number, number], to: [number, number, number]): number {
  const beforeAnniversary = to[1] < from[1] || (to[1] === from[1] && to[2] < from[2]);
  return to[0] - from[0] - (beforeAnniversary ? 1 : 0);
}

/**
 * Age in whole years on `day`: date_part('year', age(day, birth)) exactly. PostgreSQL's age() compares the month /
 * day fields, so a 29 February birthday is reached on 1 March in non-leap years (on 28 February the person is still
 * a year younger). A day before the birth date gives the negated age (0 within the first year), as age() does. Null
 * when either value is not a 'YYYY-MM-DD' date.
 */
export function ageOn(birth: string | null | undefined, day: string | null | undefined): number | null {
  const b = parseDay(birth);
  const d = parseDay(day);
  if (!b || !d) return null;
  const dayVsBirth = d[0] - b[0] || d[1] - b[1] || d[2] - b[2];
  if (dayVsBirth >= 0) return wholeYears(b, d);
  const years = wholeYears(d, b);
  return years === 0 ? 0 : -years;
}

/** Client-side mirror of the birth_date checks (a real date, 1900-01-01 … today); null when valid or empty. */
export function validateBirthDate(value: string | null | undefined, today: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !parseDay(v)) return "Doğum tarihi geçersiz.";
  if (v < HK_MIN_BIRTH_DATE) return "Doğum tarihi 1900'den önce olamaz.";
  if (parseDay(today) && v > today.slice(0, 10)) return "Doğum tarihi bugünden sonra olamaz.";
  return null;
}

// ---------------------------------------------------------------------------
// JSON shapes (§1 RPC list). Money is integer cents (TL unless a currency is named), rates basis points.
// ---------------------------------------------------------------------------

export interface HkDoctorRefJson {
  id: string;
  name: string;
  user_id: string;
  specialty: string | null;
  is_active: boolean;
}

/**
 * Possible payees: users of the clinic that have a doctors row, plus the owner; from 0031 any active user may be a
 * payroll payee (fixed_monthly rule, bonus). doctor_id null = staff without a doctors row.
 */
export interface HkPayeeRefJson {
  user_id: string;
  name: string;
  /** users.role ('owner' for the management share) */
  role: string;
  doctor_id: string | null;
  is_active: boolean;
}

export interface HkRuleJson {
  id: string;
  version: number;
  payee_user_id: string;
  payee_name: string;
  payee_is_active: boolean;
  doctor_id: string | null;
  doctor_name: string | null;
  kind: HkKind;
  /** ciro_share only */
  segment: HkSegment | null;
  /** ciro_share / ortho_lab_first / clinic_ciro_share: 1..10000 */
  share_bp: number | null;
  /** implant_piece: amount per implant; fixed_monthly: monthly net salary; null otherwise */
  piece_cents: number | null;
  /** 0 unless ciro_share / ortho_lab_first */
  deduct_cash_bp: number;
  deduct_card_bp: number;
  deduct_transfer_bp: number;
  deduct_financing_bp: number;
  /** 1st of month */
  from_month: string;
  /** 1st of month, inclusive; null = open-ended */
  to_month: string | null;
  note: string;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

export interface HkMonthRefJson {
  /** null while the month has no row (open, version 0) */
  month_id: string | null;
  month: string;
  status: HkMonthStatus;
  version: number;
  closed_at: string | null;
  closed_by_name: string | null;
  reopened_at: string | null;
  reopened_by_name: string | null;
}

/** Hakediş settings on fin_settings (v1.1): fin_hk_reference().settings and the fin_hk_save_settings record. */
export interface HkSettingsJson {
  /** fin_settings.version (p_version of fin_hk_save_settings) */
  version: number;
  /** fin_settings.hk_child_age_limit: a patient with a birth date is a child while younger than this (1..18) */
  child_age_limit: number;
}

export interface HkReferenceJson {
  today: string;
  current_month: string;
  /** 'finance': rules, settings, month close (write controls of the finance pages) */
  can_write: boolean;
  /** 'finance' or 'hakedis_prepare' (0031): lines, pieces, marks, lab costs and adjustments in open months */
  can_prepare: boolean;
  /** 'finance' or 'finance_readonly' (0031): ledger data (statement entries, paid / remaining) is in the month payload */
  ledger_visible: boolean;
  /** clinic owner (reopen) */
  is_owner: boolean;
  doctors: HkDoctorRefJson[];
  /** every user of the clinic (0031), inactive ones flagged; hakediş rules need a doctors row or the owner role */
  payees: HkPayeeRefJson[];
  rules: HkRuleJson[];
  months: HkMonthRefJson[];
  /** Lab name picker (datalist): active lab counterparties (Cariler) and names already used in lab costs. */
  lab_names: string[];
  settings: HkSettingsJson;
}

interface HkVoidable {
  is_voided?: boolean;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
}

interface HkStamped {
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

/** A revenue line of fin_hk_month (all fields + the engine's resolution). */
export interface HkLineJson extends HkVoidable, HkStamped {
  id: string;
  version: number;
  source: HkSource;
  source_key: string | null;
  batch_id: string | null;
  day: string;
  doctor_id: string;
  doctor_name: string;
  patient_ref: string;
  patient_name: string;
  method: HkMethod;
  currency: HkCurrency;
  /** original currency */
  amount_cents: number;
  /** TL value; negative = correction line */
  try_cents: number;
  /** implant part of try_cents (same sign or 0), never in the doctor's ciro */
  implant_cents: number;
  /** manual override; null = from the patient mark */
  segment: HkSegment | null;
  /** engine resolution; null on voided lines */
  resolved_segment: HkSegment | null;
  /** null = no rule (UNRULED_LINES) or voided */
  rule_id: string | null;
  rule_kind: HkKind | null;
  /** payee of the line's rule */
  payee_user_id: string | null;
  /** ortho lab-first part of this line (TL cents), 0 elsewhere; null on voided lines */
  lab_part: number | null;
  description: string;
}

/** Implants placed (implant_piece rules). */
export interface HkPieceJson extends HkVoidable, HkStamped {
  id: string;
  version: number;
  source: HkSource;
  source_key: string | null;
  day: string;
  doctor_id: string;
  doctor_name: string;
  patient_ref: string;
  patient_name: string;
  /** negative = correction */
  qty: number;
  description: string;
}

export interface HkMarkJson extends HkStamped {
  id: string;
  version: number;
  patient_ref: string;
  patient_name: string;
  /** this patient is that doctor's own-portfolio patient */
  own_doctor_id: string | null;
  own_doctor_name: string | null;
  /** 'YYYY-MM-DD'; when set, the child segment follows the age on the payment day and is_child is not used */
  birth_date: string | null;
  /** manual child mark: used only while birth_date is null */
  is_child: boolean;
  note: string;
}

// Reception patient marking (v1.1 item 3: hk_marks_*, hk_save_mark). Patients and doctor names only, never amounts
// or rates.

export interface HkMarkDoctorJson {
  id: string;
  name: string;
}

/** hk_marks_access(). */
export interface HkMarksAccessJson {
  /** active reception / admin / owner user or finance writer */
  can_mark: boolean;
  /** doctors with an active 'own' ciro_share rule in the current month (the "Hekimin kendi hastası" choices) */
  doctors: HkMarkDoctorJson[];
}

/** A row of hk_marks_list() and the hk_save_mark record. */
export interface HkMarkRowJson {
  id: string;
  version: number;
  patient_ref: string;
  patient_name: string;
  own_doctor_id: string | null;
  own_doctor_name: string | null;
  birth_date: string | null;
  /** finance-only field, shown read-only here */
  is_child: boolean;
  /**
   * the patient has payments in a closed month: own doctor / birth date can be changed only by a finance writer (the
   * server refuses others)
   */
  locked: boolean;
}

/** One lab invoice / charge for a patient (owner decision 2026-10-18). */
export interface HkLabCostJson extends HkVoidable, HkStamped {
  id: string;
  version: number;
  day: string;
  doctor_id: string;
  doctor_name: string;
  patient_ref: string;
  patient_name: string;
  lab_name: string;
  /** TL cents; negative = correction */
  amount_cents: number;
  description: string;
}

/** A monthly bonus / other row of a payee (fin_hk_adjustments, 0031). */
export interface HkAdjustmentJson extends HkVoidable, HkStamped {
  id: string;
  version: number;
  /** 1st of month */
  month: string;
  payee_user_id: string;
  payee_name: string;
  kind: HkAdjustmentKind;
  /** TL cents, never 0; negative = deduction */
  amount_cents: number;
  description: string;
}

/** A live adjustment inside a payee's 'adjustments' component. */
export interface HkAdjustmentItemJson {
  id: string;
  kind: HkAdjustmentKind;
  amount_cents: number;
  description: string;
}

/** by_method bucket of a ciro_share / ortho_lab_first component (all cents except deduct_bp). */
export interface HkMethodBucketJson {
  gross: number;
  implant: number;
  lab: number;
  /** gross − implant − lab */
  eligible: number;
  deduct_bp: number;
  /** round_half_away(eligible × deduct_bp / 10000) */
  deduction: number;
}

export type HkByMethodJson = Record<HkMethod, HkMethodBucketJson>;

/** Ortho lab-first totals of one patient, to the end of the month. */
export interface HkLabPatientJson {
  patient_ref: string;
  patient_name: string;
  /** lab costs dated up to the end of the month */
  lab_total_cents: number;
  /** recovered from payments up to the end of the month */
  recovered_cents: number;
  /** still to recover = lab_total − recovered */
  remaining_cents: number;
  /** recovered from this month's payments (computeMonth only; the SQL payload leaves it out) */
  recovered_in_month_cents?: number;
}

/** A component computed from one active rule (every kind, fixed_monthly included: 13 keys in the SQL payload). */
export interface HkRuleComponentJson {
  rule_id: string;
  kind: HkKind;
  doctor_id: string | null;
  doctor_name: string | null;
  segment: HkSegment | null;
  share_bp: number | null;
  /** implant_piece: amount per implant; fixed_monthly: the monthly net salary */
  piece_cents: number | null;
  /** ciro_share / ortho_lab_first only */
  by_method: HkByMethodJson | null;
  /**
   * matrah: Σ(eligible − deduction) for ciro / ortho, gross clinic ciro for clinic_ciro_share; implant_piece: null in
   * the SQL payload, 0 from computeMonth; fixed_monthly: null
   */
  base_cents: number | null;
  /** fixed_monthly: the salary (= piece_cents) */
  amount_cents: number;
  /** implant_piece only: Σ qty */
  qty: number | null;
  /** fixed_monthly: 0 */
  lines_count: number;
  /** ortho_lab_first only (null / absent otherwise) */
  lab_patients?: HkLabPatientJson[] | null;
  items?: undefined;
}

/**
 * The month's live bonus / other rows of a payee (0031), one component after the rule components. The SQL payload
 * carries exactly these three keys (no rule_id, no lines_count); computeMonth builds the same object.
 */
export interface HkAdjustmentsComponentJson {
  kind: "adjustments";
  /** Σ items (may be 0 when the rows cancel out) */
  amount_cents: number;
  /** oldest first (created_at, id) */
  items: HkAdjustmentItemJson[];
  rule_id?: undefined;
  doctor_id?: undefined;
  doctor_name?: undefined;
  segment?: undefined;
  share_bp?: undefined;
  piece_cents?: undefined;
  by_method?: undefined;
  base_cents?: undefined;
  qty?: undefined;
  lines_count?: undefined;
  lab_patients?: undefined;
}

/** One component of a payee: one per active rule, plus one 'adjustments' component when the month has live rows. */
export type HkComponentJson = HkRuleComponentJson | HkAdjustmentsComponentJson;

export interface HkPayeeJson {
  payee_user_id: string;
  payee_name: string;
  /** the payee's doctors row; null for staff (SQL payload; not in hk_my_month) */
  doctor_id?: string | null;
  /**
   * the payee's physician counterparty, or for staff (0031) the staff counterparty linked to the user (SQL payload;
   * left out when ledger_visible is false, and not in hk_my_month)
   */
  counterparty_id?: string | null;
  total_cents: number;
  components: HkComponentJson[];
}

export type HkWarningJson =
  | { code: "UNRULED_LINES"; doctor_id: string; doctor_name: string; count: number; try_cents: number }
  | { code: "UNRULED_PIECES"; doctor_id: string; doctor_name?: string; qty: number }
  | {
      code: "NO_COUNTERPARTY";
      payee_user_id: string;
      payee_name?: string;
      /** no doctors row / no physician counterparty yet / counterparty inactive */
      reason?: "no_doctor" | "missing" | "inactive";
    };

/** fin_hk__compute output. */
export interface HkComputeResult {
  month: string;
  payees: HkPayeeJson[];
  /** gross Σ try_cents of the month's live lines (all doctors, incl. implant parts) */
  clinic_total_cents: number;
  warnings: HkWarningJson[];
}

export interface HkStatementJson {
  id: string;
  month: string;
  payee_user_id: string;
  payee_name: string;
  total_cents: number;
  /** the payee object frozen at close */
  breakdown: HkPayeeJson;
  fin_entry_id: string | null;
  /**
   * the linked ledger entry now: the doctor's entitlement entry, or the staff payroll entry (0031, personnel bucket).
   * Null when the total was 0, and always null for callers without a finance permission ('hakedis_prepare' only).
   */
  entry: {
    id: string;
    version: number;
    amount_cents: number;
    paid_cents: number;
    outstanding_cents: number;
    is_cancelled: boolean;
  } | null;
  created_at: string;
  created_by_name: string | null;
  superseded_at: string | null;
}

/** fin_hk_month / fin_hk_close_month / fin_hk_reopen_month: live compute + month state + the month's records. */
export interface HkMonthPayload extends HkComputeResult {
  month_id: string | null;
  today: string;
  current_month: string;
  can_write: boolean;
  /** 'finance' or 'hakedis_prepare' (0031) */
  can_prepare: boolean;
  /**
   * 'finance' or 'finance_readonly' (0031). False ('hakedis_prepare' only): no counterparty ids, no NO_COUNTERPARTY
   * warnings, statement entries null (fin_entry_id stays).
   */
  ledger_visible: boolean;
  is_owner: boolean;
  /** the month is before the current month */
  is_closable: boolean;
  /** close / reopen only: the month already had that status */
  already_saved?: boolean;
  status: HkMonthStatus;
  /** fin_hk_months.version; 0 while the month has no row */
  version: number;
  closed_at: string | null;
  closed_by_name: string | null;
  reopened_at: string | null;
  reopened_by_name: string | null;
  /** active statements (closed months); [] when open */
  statements: HkStatementJson[];
  lines: HkLineJson[];
  pieces: HkPieceJson[];
  lab_costs: HkLabCostJson[];
  /** the month's bonus / other rows of every payee, voided ones included (0031) */
  adjustments: HkAdjustmentJson[];
}

/** Save / void result (fin_save_account pattern: a retry with the same id returns already_saved). */
export interface HkWriteResult<T> {
  already_saved: boolean;
  record: T;
}

// Self-service (hk_my_*): only the caller's own figures.

export interface HkMyMonthRowJson {
  month: string;
  status: HkMonthStatus;
  /** open month: live figure that changes until the month is closed */
  is_estimate: boolean;
  /** statement total when closed, live compute otherwise */
  total_cents: number;
  /** paid on the month's entitlement entry (0 without one) */
  paid_cents: number;
  /** closed months only; null while open */
  remaining_cents: number | null;
}

export interface HkMyMonthsJson {
  has_rules: boolean;
  today?: string;
  current_month?: string;
  /** newest first */
  months: HkMyMonthRowJson[];
}

export interface HkMyLineJson {
  id?: string;
  day: string;
  patient_name: string;
  method: HkMethod;
  currency: HkCurrency;
  amount_cents: number;
  try_cents: number;
  implant_cents: number;
  /** resolved segment */
  segment: HkSegment;
  lab_part: number;
  /**
   * true: counted under one of the caller's own rules; false: an unruled line of the caller's own doctors row. Lines
   * counted under another payee's rule are never returned.
   */
  counted: boolean;
}

export interface HkMyPieceJson {
  id?: string;
  day: string;
  patient_name: string;
  qty: number;
  description?: string;
}

export interface HkMyLabCostJson {
  id?: string;
  day: string;
  patient_name: string;
  lab_name: string;
  amount_cents: number;
}

/**
 * hk_my_month component: a clinic_ciro_share one carries only rule_id, kind, share_bp, base_cents, amount_cents; the
 * others (fixed_monthly and adjustments included, 0031) come whole.
 */
export type HkMyComponentJson = Pick<HkComponentJson, "rule_id" | "kind" | "amount_cents"> &
  Partial<Omit<HkComponentJson, "rule_id" | "kind" | "amount_cents">>;

export interface HkMyPayeeJson {
  payee_user_id: string;
  payee_name: string;
  total_cents: number;
  components: HkMyComponentJson[];
}

export interface HkMyMonthData {
  has_rules: true;
  today?: string;
  current_month?: string;
  month: string;
  status: HkMonthStatus;
  /** open month: live estimate; closed: the frozen statement breakdown */
  is_estimate: boolean;
  /** the caller's payee object(s) */
  payees: HkMyPayeeJson[];
  lines: HkMyLineJson[];
  pieces: HkMyPieceJson[];
  /** lab cost rows (to date) of the caller's ortho patients */
  lab_costs: HkMyLabCostJson[];
  /** closed months: the caller's active statement */
  statement: { total_cents: number; closed_at: string } | null;
  /**
   * the caller's ledger entry of the month, when one exists: the entitlement entry, or for a payee without a doctors
   * row the payroll entry (0031)
   */
  entitlement: { amount_cents: number; paid_cents: number; remaining_cents: number; is_cancelled: boolean } | null;
}

export type HkMyMonthJson = { has_rules: false; month?: string } | HkMyMonthData;

// ---------------------------------------------------------------------------
// RPC wrappers. Errors arrive as FinanceError with the server's Turkish text (PT409 conflict, PT404, 42501).
// ---------------------------------------------------------------------------

let client: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await sb().rpc(name, args) : await sb().rpc(name);
  } catch (err) {
    throw toFinanceError(err);
  }
  if (result.error) throw toFinanceError(result.error);
  return result.data as T;
}

// Readers: 'finance' or 'finance_readonly', and from 0031 'hakedis_prepare' (fin__hk_require_prep_read; without the
// ledger: no paid / remaining amounts, no entry details).

export function finHkReference() {
  return rpc<HkReferenceJson>("fin_hk_reference");
}

/** month: 'YYYY-MM' or 'YYYY-MM-DD'. */
export function finHkMonth(month: string) {
  return rpc<HkMonthPayload>("fin_hk_month", { p_month: monthStart(month) });
}

export async function finHkMarks(): Promise<HkMarkJson[]> {
  const data = await rpc<HkMarkJson[] | { marks?: HkMarkJson[] } | null>("fin_hk_marks");
  return Array.isArray(data) ? data : data?.marks ?? [];
}

// Writes. p_version 0 = create with the client-generated p_id. Lines, pieces, marks, lab costs and adjustments:
// 'finance' or 'hakedis_prepare' (0031, open months only); rules, settings, close: 'finance'; reopen: the owner.

export interface HkSaveRuleArgs {
  p_id: string;
  p_version: number;
  p_payee_user_id: string;
  p_doctor_id: string | null;
  p_kind: HkKind;
  p_segment: HkSegment | null;
  p_share_bp: number | null;
  p_piece_cents: number | null;
  p_deduct_cash_bp: number;
  p_deduct_card_bp: number;
  p_deduct_transfer_bp: number;
  p_deduct_financing_bp: number;
  /** 'YYYY-MM' or 'YYYY-MM-01' */
  p_from_month: string;
  p_to_month: string | null;
  p_note: string;
}

export function finHkSaveRule(args: HkSaveRuleArgs) {
  return rpc<HkWriteResult<HkRuleJson>>("fin_hk_save_rule", {
    ...args,
    p_from_month: monthStart(args.p_from_month),
    p_to_month: args.p_to_month ? monthStart(args.p_to_month) : null,
  });
}

export interface HkSaveLineArgs {
  p_id: string;
  p_version: number;
  p_day: string;
  p_doctor_id: string;
  p_patient_name: string;
  /** null → fin__normalize_name(p_patient_name) */
  p_patient_ref: string | null;
  p_method: HkMethod;
  p_currency: HkCurrency;
  p_amount_cents: number;
  p_try_cents: number;
  p_implant_cents: number;
  p_segment: HkSegment | null;
  p_description: string;
}

export function finHkSaveLine(args: HkSaveLineArgs) {
  return rpc<HkWriteResult<HkLineJson>>("fin_hk_save_line", { ...args });
}

export interface HkVoidArgs {
  p_id: string;
  p_version: number;
  p_reason: string;
}

export function finHkVoidLine(args: HkVoidArgs) {
  return rpc<HkWriteResult<HkLineJson>>("fin_hk_void_line", { ...args });
}

export interface HkSavePieceArgs {
  p_id: string;
  p_version: number;
  p_day: string;
  p_doctor_id: string;
  p_patient_name: string;
  p_patient_ref: string | null;
  p_qty: number;
  p_description: string;
}

export function finHkSavePiece(args: HkSavePieceArgs) {
  return rpc<HkWriteResult<HkPieceJson>>("fin_hk_save_piece", { ...args });
}

export function finHkVoidPiece(args: HkVoidArgs) {
  return rpc<HkWriteResult<HkPieceJson>>("fin_hk_void_piece", { ...args });
}

export interface HkSaveMarkArgs {
  p_id: string;
  p_version: number;
  p_patient_ref: string | null;
  p_patient_name: string;
  p_own_doctor_id: string | null;
  p_is_child: boolean;
  p_note: string;
  /** 'YYYY-MM-DD' or null; always sent so that an edit never drops a birth date entered at the reception */
  p_birth_date: string | null;
}

export function finHkSaveMark(args: HkSaveMarkArgs) {
  return rpc<HkWriteResult<HkMarkJson>>("fin_hk_save_mark", { ...args });
}

/** fin_settings.hk_child_age_limit (1..18); 0022 settings conventions: no-op → already_saved, then PT409. */
export function finHkSaveSettings(args: { p_version: number; p_child_age_limit: number }) {
  return rpc<HkWriteResult<HkSettingsJson>>("fin_hk_save_settings", { ...args });
}

export interface HkSaveLabCostArgs {
  p_id: string;
  p_version: number;
  p_day: string;
  p_doctor_id: string;
  p_patient_name: string;
  p_patient_ref: string | null;
  p_lab_name: string;
  p_amount_cents: number;
  p_description: string;
}

export function finHkSaveLabCost(args: HkSaveLabCostArgs) {
  return rpc<HkWriteResult<HkLabCostJson>>("fin_hk_save_lab_cost", { ...args });
}

export function finHkVoidLabCost(args: HkVoidArgs) {
  return rpc<HkWriteResult<HkLabCostJson>>("fin_hk_void_lab_cost", { ...args });
}

export interface HkSaveAdjustmentArgs {
  p_id: string;
  /** 0 = create with the client-generated p_id */
  p_version: number;
  /** 'YYYY-MM' or 'YYYY-MM-01'; a closed month (or one before a later closed month) is refused */
  p_month: string;
  p_payee_user_id: string;
  p_kind: HkAdjustmentKind;
  /** TL cents, never 0; negative = deduction */
  p_amount_cents: number;
  /** 1..500 characters */
  p_description: string;
}

/** Monthly bonus / other row of a payee (0031). */
export function finHkSaveAdjustment(args: HkSaveAdjustmentArgs) {
  return rpc<HkWriteResult<HkAdjustmentJson>>("fin_hk_save_adjustment", { ...args, p_month: monthStart(args.p_month) });
}

export function finHkVoidAdjustment(args: HkVoidArgs) {
  return rpc<HkWriteResult<HkAdjustmentJson>>("fin_hk_void_adjustment", { ...args });
}

/**
 * Closes a past open month; refuses UNRULED warnings unless p_accept_unruled. Creates / updates the doctors'
 * entitlement entries and (0031) one payroll entry per staff payee in the personnel category.
 */
export function finHkCloseMonth(args: { p_month: string; p_version: number; p_accept_unruled: boolean }) {
  return rpc<HkMonthPayload>("fin_hk_close_month", { ...args, p_month: monthStart(args.p_month) });
}

/** Owner only. Statements are superseded, ledger entries stay (the next close updates the amount). */
export function finHkReopenMonth(args: { p_month: string; p_version: number }) {
  return rpc<HkMonthPayload>("fin_hk_reopen_month", { ...args, p_month: monthStart(args.p_month) });
}

// Self-service (any active app user; only the caller's own figures).

export async function hkMyMonths(): Promise<HkMyMonthsJson> {
  const data = await rpc<HkMyMonthsJson | HkMyMonthRowJson[] | null>("hk_my_months");
  if (Array.isArray(data)) return { has_rules: data.length > 0, months: data };
  return {
    has_rules: !!data?.has_rules,
    today: data?.today,
    current_month: data?.current_month,
    months: data?.months ?? [],
  };
}

export function hkMyMonth(month: string) {
  return rpc<HkMyMonthJson>("hk_my_month", { p_month: monthStart(month) });
}

// Reception patient marking (reception, admin, owner or a finance writer; no finance permission needed).

export async function hkMarksAccess(): Promise<HkMarksAccessJson> {
  const data = await rpc<Partial<HkMarksAccessJson> | null>("hk_marks_access");
  return { can_mark: !!data?.can_mark, doctors: data?.doctors ?? [] };
}

/** Max rows of hk_marks_list (by patient name); a full page means the search should be narrowed. */
export const HK_MARKS_LIST_LIMIT = 200;

/** Marks whose patient name or patient key contains the query (blank = all), at most HK_MARKS_LIST_LIMIT. */
export async function hkMarksList(query: string): Promise<HkMarkRowJson[]> {
  const data = await rpc<HkMarkRowJson[] | null>("hk_marks_list", { p_query: query.trim() });
  return Array.isArray(data) ? data : [];
}

export interface HkReceptionSaveMarkArgs {
  p_id: string;
  /** 0 = create with the client-generated p_id */
  p_version: number;
  /** null → fin__normalize_name(p_patient_name) */
  p_patient_ref: string | null;
  p_patient_name: string;
  p_own_doctor_id: string | null;
  /** 'YYYY-MM-DD' or null */
  p_birth_date: string | null;
}

/** Creates / updates only the name, own doctor and birth date; is_child and note stay with fin_hk_save_mark. */
export function hkSaveMark(args: HkReceptionSaveMarkArgs) {
  return rpc<HkWriteResult<HkMarkRowJson>>("hk_save_mark", { ...args });
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

/** from_month ≤ M ≤ to_month (to_month inclusive, null = open-ended). */
export function ruleActiveIn(rule: { from_month: string; to_month: string | null }, month: string): boolean {
  const m = monthKey(month);
  return monthKey(rule.from_month) <= m && (!rule.to_month || monthKey(rule.to_month) >= m);
}

export interface HkRuleInput {
  payee_user_id: string | null;
  doctor_id: string | null;
  kind: HkKind;
  segment: HkSegment | null;
  share_bp: number | null;
  piece_cents: number | null;
  deduct_cash_bp: number;
  deduct_card_bp: number;
  deduct_transfer_bp: number;
  deduct_financing_bp: number;
  from_month: string;
  to_month: string | null;
}

/** Client-side mirror of the fin_hk_save_rule checks per kind; null when valid. Overlaps are checked by the server. */
export function validateRule(r: HkRuleInput): string | null {
  const f = RULE_FIELDS[r.kind];
  if (!f) return "Kural türünü seçin.";
  const salary = r.kind === "fixed_monthly";
  if (!r.payee_user_id) return salary ? "Maaş alacak kişiyi seçin." : "Hakediş sahibini seçin.";
  if (f.doctor && !r.doctor_id) return "Hekimi seçin.";
  if (f.segment && !r.segment) return "Hasta grubunu seçin.";
  if (f.share && (r.share_bp === null || !Number.isInteger(r.share_bp) || r.share_bp < 1 || r.share_bp > 10000)) {
    return "Pay oranı %0,01 ile %100 arasında olmalı.";
  }
  if (f.piece && (r.piece_cents === null || !Number.isInteger(r.piece_cents) || r.piece_cents <= 0)) {
    return salary ? "Aylık net maaş 0'dan büyük olmalı." : "Adet başı tutar 0'dan büyük olmalı.";
  }
  for (const method of HK_METHODS) {
    const bp = r[DEDUCT_FIELD[method]];
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000) return "Kesinti oranı %0 ile %100 arasında olmalı.";
    if (!f.deductions && bp !== 0) return "Bu kural türünde kesinti girilemez.";
  }
  if (!MONTH_KEY_RE.test(r.from_month)) return "Başlangıç ayını seçin.";
  if (r.to_month) {
    if (!MONTH_KEY_RE.test(r.to_month)) return "Bitiş ayı geçersiz.";
    if (monthKey(r.to_month) < monthKey(r.from_month)) return "Bitiş ayı başlangıç ayından önce olamaz.";
  }
  return null;
}

/**
 * Rules that may not be active in the same month (fin_hk_save_rule overlap check): fixed_monthly per (kind, payee),
 * every other kind per (kind, doctor, segment) regardless of the payee.
 */
export function ruleOverlapKey(r: Pick<HkRuleInput, "kind" | "payee_user_id" | "doctor_id" | "segment">): string {
  return r.kind === "fixed_monthly"
    ? `${r.kind}|${r.payee_user_id ?? ""}`
    : `${r.kind}|${r.doctor_id ?? ""}|${r.segment ?? ""}`;
}

/** Do two month ranges (from_month … to_month inclusive, null = open-ended) share a month? */
export function monthRangesOverlap(
  a: { from_month: string; to_month: string | null },
  b: { from_month: string; to_month: string | null }
): boolean {
  const aEndsBefore = !!a.to_month && monthKey(a.to_month) < monthKey(b.from_month);
  const bEndsBefore = !!b.to_month && monthKey(b.to_month) < monthKey(a.from_month);
  return !aEndsBefore && !bEndsBefore;
}

/**
 * The saved rule (other than `rule.id`) the server would name when refusing `rule` as overlapping (the earliest by
 * from_month, then id); undefined if none.
 */
export function findOverlappingRule<T extends HkRuleInput & { id: string }>(
  rules: readonly T[],
  rule: HkRuleInput & { id?: string | null }
): T | undefined {
  const key = ruleOverlapKey(rule);
  return rules
    .filter((r) => r.id !== rule.id && ruleOverlapKey(r) === key && monthRangesOverlap(r, rule))
    .sort((a, b) => byText(monthKey(a.from_month), monthKey(b.from_month)) || byText(a.id, b.id))[0];
}

/** The payee's fixed_monthly rule active in the month (salary in piece_cents), if any. */
export function salaryRuleOf<T extends Pick<HkRuleJson, "kind" | "payee_user_id" | "from_month" | "to_month">>(
  rules: readonly T[],
  payeeUserId: string,
  month: string
): T | undefined {
  return rules.find((r) => r.kind === "fixed_monthly" && r.payee_user_id === payeeUserId && ruleActiveIn(r, month));
}

/** fin_hk_adjustments.description length limit. */
export const HK_ADJUSTMENT_DESCRIPTION_MAX = 500;
/** |amount_cents| limit of fin_hk_save_adjustment (10.000.000.000 TL). */
export const HK_ADJUSTMENT_MAX_ABS_CENTS = 1_000_000_000_000;

export interface HkAdjustmentInput {
  month: string;
  payee_user_id: string | null;
  kind: HkAdjustmentKind | null;
  amount_cents: number | null;
  description: string;
}

/** Client-side mirror of the fin_hk_save_adjustment checks; null when valid. Month locks are checked by the server. */
export function validateAdjustment(a: HkAdjustmentInput): string | null {
  if (!MONTH_KEY_RE.test(a.month ?? "")) return "Ayı seçin.";
  if (!a.payee_user_id) return "Kişiyi seçin.";
  if (!a.kind || !HK_ADJUSTMENT_KINDS.includes(a.kind)) return "Türü seçin.";
  if (a.amount_cents === null || !Number.isSafeInteger(a.amount_cents) || a.amount_cents === 0) {
    return "Tutar 0 olamaz. Kesinti için eksi tutar girin.";
  }
  if (Math.abs(a.amount_cents) > HK_ADJUSTMENT_MAX_ABS_CENTS) {
    return "Tutar en fazla 10.000.000.000 TL olabilir.";
  }
  const description = (a.description ?? "").trim();
  if (!description) return "Açıklama girin.";
  if (description.length > HK_ADJUSTMENT_DESCRIPTION_MAX) {
    return `Açıklama en fazla ${HK_ADJUSTMENT_DESCRIPTION_MAX} karakter olabilir.`;
  }
  return null;
}

/** A stable list key of a payee's component: the rule id, or the kind for the rule-less 'adjustments' component. */
export function componentKey(c: Pick<HkComponentJson, "kind"> & { rule_id?: string | null }): string {
  return c.rule_id ?? c.kind;
}

/**
 * Data entry in open months (fin_hk_reference / fin_hk_month can_prepare, 0031). A payload without the flag (database
 * before 0031) falls back to can_write.
 */
export function hkCanPrepare(x: { can_prepare?: boolean | null; can_write: boolean }): boolean {
  return x.can_prepare ?? x.can_write;
}

/** Ledger data (statement entries, paid / remaining, finance entry links) is shown; true before 0031. */
export function hkLedgerVisible(x: { ledger_visible?: boolean | null }): boolean {
  return x.ledger_visible ?? true;
}

/** "Ciro payı · Çocuk hasta · Hekim A"; "Sabit aylık maaş"; "Prim ve diğer" */
export function componentTitle(
  c: Pick<HkComponentJson, "kind"> & Partial<Pick<HkComponentJson, "segment" | "doctor_name">>
): string {
  if (c.kind === "adjustments") return ADJUSTMENTS_COMPONENT_LABEL;
  const parts = [KIND_LABELS[c.kind] ?? c.kind];
  if (c.kind === "ciro_share" && c.segment) parts.push(SEGMENT_LABELS[c.segment] ?? c.segment);
  if (c.doctor_name) parts.push(c.doctor_name);
  return parts.join(" · ");
}

export function warningText(w: HkWarningJson): string {
  switch (w.code) {
    case "UNRULED_LINES":
      return `${w.doctor_name || "Hekim"}: ${w.count} tahsilat (${formatTL(w.try_cents)}) için tanımlı kural yok; hakedişe dahil edilmedi.`;
    case "UNRULED_PIECES":
      return `${w.doctor_name || "Hekim"}: ${w.qty} implant için tanımlı adet kuralı yok; hakedişe dahil edilmedi.`;
    case "NO_COUNTERPARTY":
      if (w.reason === "no_doctor") {
        return `${w.payee_name || "Hakediş sahibi"} için hekim kaydı yok; ay kapatılamaz. Önce Ekip ekranından hekim kaydını ekleyin.`;
      }
      if (w.reason === "inactive") {
        return `${w.payee_name || "Hakediş sahibi"} için cari kaydı pasif; ay kapatılmadan önce Cariler ekranından aktifleştirin.`;
      }
      return `${w.payee_name || "Hakediş sahibi"} için cari kaydı yok; ay kapatılınca otomatik oluşturulur.`;
    default:
      return "Bilinmeyen uyarı.";
  }
}

/**
 * Payee table row (§2): ciro by method, implant part, lab, deductions, base, share, implants, management, total; from
 * 0031 also the fixed salary and the month's bonus / other rows.
 */
export interface HkPayeeSummary {
  gross_by_method: Record<HkMethod, number>;
  gross_cents: number;
  implant_cents: number;
  lab_cents: number;
  deduction_cents: number;
  base_cents: number;
  share_cents: number;
  /** distinct share rates of the ciro / ortho components */
  share_bps: number[];
  implant_qty: number;
  implant_amount_cents: number;
  management_base_cents: number;
  management_cents: number;
  /** fixed_monthly components */
  salary_cents: number;
  /** 'adjustments' component: Σ bonus items, Σ other items, and the whole component */
  bonus_cents: number;
  other_cents: number;
  adjustments_cents: number;
  total_cents: number;
}

/** A summary with every figure 0 (and the given total). */
export function emptyPayeeSummary(totalCents = 0): HkPayeeSummary {
  return {
    gross_by_method: { cash: 0, card: 0, transfer: 0, financing: 0 },
    gross_cents: 0,
    implant_cents: 0,
    lab_cents: 0,
    deduction_cents: 0,
    base_cents: 0,
    share_cents: 0,
    share_bps: [],
    implant_qty: 0,
    implant_amount_cents: 0,
    management_base_cents: 0,
    management_cents: 0,
    salary_cents: 0,
    bonus_cents: 0,
    other_cents: 0,
    adjustments_cents: 0,
    total_cents: totalCents,
  };
}

/**
 * Totals row of a payee table: every figure summed, share rates merged. management_base_cents stays 0: each
 * management share is computed on the same clinic ciro, so its bases do not add up.
 */
export function sumPayeeSummaries(rows: readonly HkPayeeSummary[]): HkPayeeSummary {
  const out = emptyPayeeSummary();
  for (const s of rows) {
    for (const m of HK_METHODS) out.gross_by_method[m] += s.gross_by_method[m];
    out.gross_cents += s.gross_cents;
    out.implant_cents += s.implant_cents;
    out.lab_cents += s.lab_cents;
    out.deduction_cents += s.deduction_cents;
    out.base_cents += s.base_cents;
    out.share_cents += s.share_cents;
    for (const bp of s.share_bps) if (!out.share_bps.includes(bp)) out.share_bps.push(bp);
    out.implant_qty += s.implant_qty;
    out.implant_amount_cents += s.implant_amount_cents;
    out.management_cents += s.management_cents;
    out.salary_cents += s.salary_cents;
    out.bonus_cents += s.bonus_cents;
    out.other_cents += s.other_cents;
    out.adjustments_cents += s.adjustments_cents;
    out.total_cents += s.total_cents;
  }
  return out;
}

/** A payee object of fin_hk_month (HkPayeeJson) or of hk_my_month (HkMyPayeeJson, trimmed management component). */
export function summarizePayee(p: { total_cents: number; components: readonly HkMyComponentJson[] }): HkPayeeSummary {
  const s = emptyPayeeSummary(p.total_cents);
  for (const c of p.components) {
    if (c.kind === "fixed_monthly") {
      s.salary_cents += c.amount_cents;
    } else if (c.kind === "adjustments") {
      s.adjustments_cents += c.amount_cents;
      for (const item of c.items ?? []) {
        if (item.kind === "bonus") s.bonus_cents += item.amount_cents;
        else s.other_cents += item.amount_cents;
      }
    } else if (c.kind === "implant_piece") {
      s.implant_qty += c.qty ?? 0;
      s.implant_amount_cents += c.amount_cents;
    } else if (c.kind === "clinic_ciro_share") {
      s.management_base_cents += c.base_cents ?? 0;
      s.management_cents += c.amount_cents;
    } else {
      for (const method of HK_METHODS) {
        const b = c.by_method?.[method];
        if (!b) continue;
        s.gross_by_method[method] += b.gross;
        s.gross_cents += b.gross;
        s.implant_cents += b.implant;
        s.lab_cents += b.lab;
        s.deduction_cents += b.deduction;
      }
      s.base_cents += c.base_cents ?? 0;
      s.share_cents += c.amount_cents;
      if (typeof c.share_bp === "number" && !s.share_bps.includes(c.share_bp)) s.share_bps.push(c.share_bp);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Pure mirror of fin_hk__compute (§1 "Calculation"). Same inputs → same cents as the database.
// ---------------------------------------------------------------------------

export type HkComputeRule = Pick<
  HkRuleJson,
  | "id"
  | "payee_user_id"
  | "doctor_id"
  | "kind"
  | "segment"
  | "share_bp"
  | "piece_cents"
  | "deduct_cash_bp"
  | "deduct_card_bp"
  | "deduct_transfer_bp"
  | "deduct_financing_bp"
  | "from_month"
  | "to_month"
> & { payee_name?: string | null; doctor_name?: string | null };

export interface HkComputeLine {
  id: string;
  day: string;
  doctor_id: string;
  patient_ref: string;
  patient_name?: string;
  method: HkMethod;
  try_cents: number;
  implant_cents: number;
  segment: HkSegment | null;
  voided_at?: string | null;
  /** walk order tie-breaker of ortho lab-first: (day, created_at, id) */
  created_at?: string;
}

export interface HkComputePiece {
  id: string;
  day: string;
  doctor_id: string;
  qty: number;
  voided_at?: string | null;
}

export interface HkComputeLabCost {
  id: string;
  day: string;
  doctor_id: string;
  patient_ref: string;
  patient_name?: string;
  amount_cents: number;
  voided_at?: string | null;
  /** patient name tie-breaker: the latest (day, created_at, id) cost names the patient */
  created_at?: string;
}

export interface HkComputeMark {
  patient_ref: string;
  own_doctor_id: string | null;
  is_child: boolean;
  /** 'YYYY-MM-DD'; when set, the age on the line's day decides the child segment instead of is_child */
  birth_date?: string | null;
}

/** A bonus / other row (fin_hk_adjustments, 0031). */
export interface HkComputeAdjustment {
  id: string;
  /** 'YYYY-MM' or 'YYYY-MM-DD' (1st of month) */
  month: string;
  payee_user_id: string;
  /** used when `payees` does not name the payee */
  payee_name?: string | null;
  kind: HkAdjustmentKind;
  amount_cents: number;
  description: string;
  voided_at?: string | null;
  /** item order inside the component: (created_at, id) */
  created_at?: string;
}

export interface HkComputeInput {
  month: string;
  rules: readonly HkComputeRule[];
  /** lines of any month: voided ones and those after the month are ignored; earlier ones feed the ortho walk */
  lines: readonly HkComputeLine[];
  pieces?: readonly HkComputePiece[];
  lab_costs?: readonly HkComputeLabCost[];
  marks?: readonly HkComputeMark[];
  /** bonus / other rows of any month: voided ones and other months are ignored */
  adjustments?: readonly HkComputeAdjustment[];
  /** fin_settings hakediş fields; child_age_limit defaults to HK_DEFAULT_CHILD_AGE_LIMIT */
  settings?: { child_age_limit?: number | null } | null;
  doctors?: readonly { id: string; name: string }[];
  payees?: readonly { user_id: string; name: string }[];
  /** payees that have a physician counterparty; when given, NO_COUNTERPARTY is reported for the others (total ≠ 0) */
  counterparty_user_ids?: readonly string[];
}

/** Per-line resolution of the month's live lines (fin_hk_month lines: resolved_segment, rule_id, lab_part). */
export interface HkLineResult {
  id: string;
  segment: HkSegment;
  rule_id: string | null;
  lab_part: number;
}

export interface HkComputeOutput extends HkComputeResult {
  line_results: HkLineResult[];
}

/**
 * Is the marked patient a child on `day`? With a birth date: younger than the limit on that day (ageOn, whole years);
 * without one: the manual is_child mark. An unreadable birth date counts as none (the database only holds real dates).
 */
export function markIsChildOn(
  mark: Pick<HkComputeMark, "is_child" | "birth_date"> | null | undefined,
  day: string,
  childAgeLimit: number = HK_DEFAULT_CHILD_AGE_LIMIT
): boolean {
  if (!mark) return false;
  const age = mark.birth_date ? ageOn(mark.birth_date, day) : null;
  if (age !== null) return age < childAgeLimit;
  return !!mark.is_child;
}

/**
 * line.segment if set; else 'own' when the mark's own doctor is the line's doctor; else 'child' when the patient is a
 * child on the line's day (markIsChildOn); else standard. Same order as fin_hk__compute.
 */
export function resolveSegment(
  line: Pick<HkComputeLine, "segment" | "doctor_id" | "day">,
  mark: Pick<HkComputeMark, "own_doctor_id" | "is_child" | "birth_date"> | null | undefined,
  childAgeLimit: number = HK_DEFAULT_CHILD_AGE_LIMIT
): HkSegment {
  if (line.segment) return line.segment;
  if (mark?.own_doctor_id && mark.own_doctor_id === line.doctor_id) return "own";
  if (markIsChildOn(mark, line.day, childAgeLimit)) return "child";
  return "standard";
}

const isLive = (r: { voided_at?: string | null }) => !r.voided_at;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string) => a.localeCompare(b, "tr");

function emptyByMethod(rule: HkComputeRule): HkByMethodJson {
  const out = {} as HkByMethodJson;
  for (const method of HK_METHODS) {
    out[method] = { gross: 0, implant: 0, lab: 0, eligible: 0, deduct_bp: rule[DEDUCT_FIELD[method]] ?? 0, deduction: 0 };
  }
  return out;
}

/** Lab-first walk of one ortho doctor up to the end of month M: lab part per line id and per-patient totals. */
function orthoWalk(
  doctorId: string,
  month: string,
  lines: readonly HkComputeLine[],
  labCosts: readonly HkComputeLabCost[]
): { labPart: Map<string, number>; patients: HkLabPatientJson[] } {
  const labPart = new Map<string, number>();
  const costsByPatient = new Map<string, HkComputeLabCost[]>();
  for (const c of labCosts) {
    if (c.doctor_id !== doctorId || !isLive(c) || monthKey(c.day) > month) continue;
    const list = costsByPatient.get(c.patient_ref) ?? [];
    list.push(c);
    costsByPatient.set(c.patient_ref, list);
  }
  const linesByPatient = new Map<string, HkComputeLine[]>();
  for (const l of lines) {
    if (l.doctor_id !== doctorId) continue;
    const list = linesByPatient.get(l.patient_ref) ?? [];
    list.push(l);
    linesByPatient.set(l.patient_ref, list);
  }

  const patients: HkLabPatientJson[] = [];
  const refs = new Set([...Array.from(linesByPatient.keys()), ...Array.from(costsByPatient.keys())]);
  for (const ref of Array.from(refs)) {
    const costs = costsByPatient.get(ref) ?? [];
    const walk = (linesByPatient.get(ref) ?? [])
      .slice()
      .sort((a, b) => byText(a.day, b.day) || byText(a.created_at ?? "", b.created_at ?? "") || byText(a.id, b.id));
    let consumed = 0;
    let inMonth = 0;
    for (const l of walk) {
      const lineMonth = monthKey(l.day);
      // A cost dated later in the same month counts for that month's payments; a later month's cost never goes back.
      const costToDate = costs.reduce((sum, c) => (monthKey(c.day) <= lineMonth ? sum + c.amount_cents : sum), 0);
      const avail = costToDate - consumed;
      const e = l.try_cents - l.implant_cents;
      const part = Math.max(Math.min(e, avail), 0);
      consumed += part;
      labPart.set(l.id, part);
      if (lineMonth === month) inMonth += part;
    }
    // Patients whose lab costs net to zero are not listed (SQL: lab total <> 0).
    const total = costs.reduce((sum, c) => sum + c.amount_cents, 0);
    if (costs.length === 0 || total === 0) continue;
    const remaining = total - consumed;
    const hasMonthLine = walk.some((l) => monthKey(l.day) === month);
    const hasMonthCost = costs.some((c) => monthKey(c.day) === month);
    // Listed while relevant: something still to recover, or activity in the month.
    if (remaining === 0 && !hasMonthLine && !hasMonthCost) continue;
    // Named by the latest lab cost (SQL: patient_name ORDER BY day DESC, created_at DESC, id DESC).
    const latest = costs
      .slice()
      .sort((a, b) => byText(b.day, a.day) || byText(b.created_at ?? "", a.created_at ?? "") || byText(b.id, a.id))[0];
    patients.push({
      patient_ref: ref,
      patient_name: latest.patient_name || ref,
      lab_total_cents: total,
      recovered_cents: consumed,
      remaining_cents: remaining,
      recovered_in_month_cents: inMonth,
    });
  }
  patients.sort((a, b) => byName(a.patient_name, b.patient_name) || byText(a.patient_ref, b.patient_ref));
  return { labPart, patients };
}

/**
 * Pure TypeScript mirror of fin_hk__compute(clinic, month). Rounding is half away from zero on exact integers
 * (BigInt), applied once per method bucket (deduction) and once per component (share), exactly like the SQL.
 * Payroll (0031): a fixed_monthly rule pays its piece_cents as is; the payee's live adjustments of the month form one
 * 'adjustments' component after the rule components. A payee may have payroll components only (staff, or a payee with
 * a bonus and no rule).
 */
export function computeMonth(input: HkComputeInput): HkComputeOutput {
  const month = monthKey(input.month);
  const doctorNames = new Map((input.doctors ?? []).map((d) => [d.id, d.name]));
  const payeeNames = new Map((input.payees ?? []).map((p) => [p.user_id, p.name]));
  const marks = new Map((input.marks ?? []).map((m) => [m.patient_ref, m]));
  const childAgeLimit = childAgeLimitOf(input.settings);
  const doctorName = (id: string | null, fallback?: string | null) =>
    id ? doctorNames.get(id) ?? fallback ?? "" : fallback ?? null;

  // Active rules; the newest from_month wins if invalid data ever has two for the same key.
  const active = input.rules
    .filter((r) => ruleActiveIn(r, month))
    .slice()
    .sort((a, b) => byText(monthKey(b.from_month), monthKey(a.from_month)) || byText(a.id, b.id));
  const orthoByDoctor = new Map<string, HkComputeRule>();
  const ciroByKey = new Map<string, HkComputeRule>();
  for (const r of active) {
    if (!r.doctor_id) continue;
    if (r.kind === "ortho_lab_first" && !orthoByDoctor.has(r.doctor_id)) orthoByDoctor.set(r.doctor_id, r);
    const key = `${r.doctor_id}|${r.segment}`;
    if (r.kind === "ciro_share" && r.segment && !ciroByKey.has(key)) ciroByKey.set(key, r);
  }

  // Live lines up to the end of the month (earlier months feed the ortho walk only).
  const toDate = input.lines.filter((l) => isLive(l) && monthKey(l.day) <= month);
  const monthLines = toDate.filter((l) => monthKey(l.day) === month);
  const livePieces = (input.pieces ?? []).filter((p) => isLive(p) && monthKey(p.day) === month);

  const walks = new Map<string, ReturnType<typeof orthoWalk>>();
  orthoByDoctor.forEach((rule, doctorId) => {
    walks.set(rule.id, orthoWalk(doctorId, month, toDate, input.lab_costs ?? []));
  });

  // Components, one per active rule.
  const components = new Map<string, HkRuleComponentJson>();
  const ruleOf = new Map<string, HkComputeRule>();
  for (const r of active) {
    ruleOf.set(r.id, r);
    components.set(r.id, {
      rule_id: r.id,
      kind: r.kind,
      doctor_id: r.doctor_id,
      doctor_name: doctorName(r.doctor_id, r.doctor_name),
      segment: r.kind === "ciro_share" ? r.segment : null,
      share_bp: r.kind === "implant_piece" || r.kind === "fixed_monthly" ? null : r.share_bp,
      piece_cents: r.kind === "implant_piece" || r.kind === "fixed_monthly" ? r.piece_cents : null,
      by_method: r.kind === "ciro_share" || r.kind === "ortho_lab_first" ? emptyByMethod(r) : null,
      base_cents: r.kind === "fixed_monthly" ? null : 0,
      amount_cents: 0,
      qty: r.kind === "implant_piece" ? 0 : null,
      lines_count: 0,
      ...(r.kind === "ortho_lab_first" ? { lab_patients: walks.get(r.id)?.patients ?? [] } : {}),
    });
  }

  // Revenue lines → rule (ortho first, then the segment's ciro rule, then the standard one).
  const lineResults: HkLineResult[] = [];
  const unruled = new Map<string, { count: number; try_cents: number }>();
  for (const l of monthLines) {
    const segment = resolveSegment(l, marks.get(l.patient_ref), childAgeLimit);
    const rule =
      orthoByDoctor.get(l.doctor_id) ??
      ciroByKey.get(`${l.doctor_id}|${segment}`) ??
      ciroByKey.get(`${l.doctor_id}|standard`);
    if (!rule) {
      const u = unruled.get(l.doctor_id) ?? { count: 0, try_cents: 0 };
      u.count += 1;
      u.try_cents += l.try_cents;
      unruled.set(l.doctor_id, u);
      lineResults.push({ id: l.id, segment, rule_id: null, lab_part: 0 });
      continue;
    }
    const lab = rule.kind === "ortho_lab_first" ? walks.get(rule.id)?.labPart.get(l.id) ?? 0 : 0;
    const c = components.get(rule.id)!;
    const b = c.by_method![l.method];
    b.gross += l.try_cents;
    b.implant += l.implant_cents;
    b.lab += lab;
    b.eligible += l.try_cents - l.implant_cents - lab;
    c.lines_count += 1;
    lineResults.push({ id: l.id, segment, rule_id: rule.id, lab_part: lab });
  }

  const clinicTotal = monthLines.reduce((sum, l) => sum + l.try_cents, 0);
  const pieceDoctors = new Set<string>();

  components.forEach((c, ruleId) => {
    const rule = ruleOf.get(ruleId)!;
    if (c.by_method) {
      let base = 0;
      for (const method of HK_METHODS) {
        const b = c.by_method[method];
        b.deduction = applyBp(b.eligible, b.deduct_bp);
        base += b.eligible - b.deduction;
      }
      c.base_cents = base;
      c.amount_cents = applyBp(base, rule.share_bp ?? 0);
    } else if (rule.kind === "implant_piece") {
      pieceDoctors.add(rule.doctor_id ?? "");
      const mine = livePieces.filter((p) => p.doctor_id === rule.doctor_id);
      const qty = mine.reduce((sum, p) => sum + p.qty, 0);
      c.qty = qty;
      c.lines_count = mine.length;
      c.amount_cents = Number(BigInt(qty) * BigInt(rule.piece_cents ?? 0));
    } else if (rule.kind === "fixed_monthly") {
      c.amount_cents = rule.piece_cents ?? 0;
    } else {
      c.base_cents = clinicTotal;
      c.lines_count = monthLines.length;
      c.amount_cents = applyBp(clinicTotal, rule.share_bp ?? 0);
    }
  });

  // Payees: every payee with an active rule or a live adjustment in the month; components in kind / doctor / segment
  // order, the 'adjustments' component last.
  const kindOrder = (k: HkComponentKind) => (k === "adjustments" ? HK_KINDS.length : HK_KINDS.indexOf(k));
  const segmentOrder = (s: HkSegment | null | undefined) => (s ? HK_SEGMENTS.indexOf(s) : -1);
  const payeeMap = new Map<string, HkPayeeJson>();
  const payeeOf = (userId: string, fallbackName: string | null | undefined): HkPayeeJson => {
    let p = payeeMap.get(userId);
    if (!p) {
      p = { payee_user_id: userId, payee_name: payeeNames.get(userId) ?? fallbackName ?? "", total_cents: 0, components: [] };
      payeeMap.set(userId, p);
    }
    return p;
  };
  for (const r of active) {
    const p = payeeOf(r.payee_user_id, r.payee_name);
    const c = components.get(r.id)!;
    p.components.push(c);
    p.total_cents += c.amount_cents;
  }

  const adjustmentsOf = new Map<string, HkComputeAdjustment[]>();
  for (const a of input.adjustments ?? []) {
    if (!isLive(a) || monthKey(a.month) !== month) continue;
    const list = adjustmentsOf.get(a.payee_user_id) ?? [];
    list.push(a);
    adjustmentsOf.set(a.payee_user_id, list);
  }
  adjustmentsOf.forEach((list, userId) => {
    const items = list
      .slice()
      .sort((a, b) => byText(a.created_at ?? "", b.created_at ?? "") || byText(a.id, b.id))
      .map((a) => ({ id: a.id, kind: a.kind, amount_cents: a.amount_cents, description: a.description }));
    const amount = items.reduce((sum, a) => sum + a.amount_cents, 0);
    const p = payeeOf(userId, list.find((a) => a.payee_name)?.payee_name);
    // Same three keys as the SQL component (no rule, no line count).
    p.components.push({ kind: "adjustments", amount_cents: amount, items });
    p.total_cents += amount;
  });

  const payees = Array.from(payeeMap.values());
  for (const p of payees) {
    p.components.sort(
      (a, b) =>
        kindOrder(a.kind) - kindOrder(b.kind) ||
        byName(a.doctor_name ?? "", b.doctor_name ?? "") ||
        segmentOrder(a.segment) - segmentOrder(b.segment) ||
        byText(a.rule_id ?? "", b.rule_id ?? "")
    );
  }
  payees.sort((a, b) => byName(a.payee_name, b.payee_name) || byText(a.payee_user_id, b.payee_user_id));

  // Warnings.
  const warnings: HkWarningJson[] = [];
  const unruledLines: HkWarningJson[] = [];
  unruled.forEach((u, doctorId) => {
    unruledLines.push({
      code: "UNRULED_LINES",
      doctor_id: doctorId,
      doctor_name: doctorNames.get(doctorId) ?? "",
      count: u.count,
      try_cents: u.try_cents,
    });
  });
  const unruledPieces = new Map<string, number>();
  for (const p of livePieces) {
    if (pieceDoctors.has(p.doctor_id)) continue;
    unruledPieces.set(p.doctor_id, (unruledPieces.get(p.doctor_id) ?? 0) + p.qty);
  }
  const pieceWarnings: HkWarningJson[] = [];
  unruledPieces.forEach((qty, doctorId) => {
    if (qty === 0) return; // SQL: pc.qty <> 0 (+1 and -1 cancel out)
    pieceWarnings.push({ code: "UNRULED_PIECES", doctor_id: doctorId, doctor_name: doctorNames.get(doctorId), qty });
  });
  const warningName = (w: HkWarningJson) => ("doctor_name" in w ? w.doctor_name ?? "" : "");
  warnings.push(...unruledLines.sort((a, b) => byName(warningName(a), warningName(b))));
  warnings.push(...pieceWarnings.sort((a, b) => byName(warningName(a), warningName(b))));
  if (input.counterparty_user_ids) {
    const linked = new Set(input.counterparty_user_ids);
    for (const p of payees) {
      if (p.total_cents !== 0 && !linked.has(p.payee_user_id)) {
        warnings.push({
          code: "NO_COUNTERPARTY",
          payee_user_id: p.payee_user_id,
          payee_name: p.payee_name,
          reason: "missing",
        });
      }
    }
  }

  return { month, payees, clinic_total_cents: clinicTotal, warnings, line_results: lineResults };
}
