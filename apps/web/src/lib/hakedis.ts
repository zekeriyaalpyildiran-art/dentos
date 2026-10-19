// Hakediş (doctor earnings) v1 client helpers: labels, bp / percent and month helpers, typed RPC wrappers and a pure
// mirror of fin_hk__compute. Contract: hakediş spec §1 (fin_hk_* / hk_* RPCs, 0030_hakedis.sql) and §2, with the
// v1.1 additions: child patients by birth date (fin_settings.hk_child_age_limit, fin_hk_patient_marks.birth_date) and
// the reception's patient marking RPCs (hk_marks_*, hk_save_mark; no amounts), and v1.2 (0031_hakedis_payroll.sql):
// staff payroll (rule kind fixed_monthly = monthly net salary, monthly bonus / other adjustments in
// fin_hk_adjustments) and the 'hakedis_prepare' permission (fin_hk_* data entry without the ledger), and v1.3
// (0032_hakedis_bank_split.sql): rule kind bank_portion = the fixed part of a payee's monthly amount paid by bank
// (official salary). It is not a component and never changes a total; every payee carries bank_cents / cash_cents
// (cash = total − bank, both null without a bank part) and BANK_OVER_TOTAL warns when the bank part exceeds the total,
// and v1.4 (same 0032): the month's lab costs of a ciro_share doctor are deducted from that rule's ciro after the
// method deductions (floored at 0, LAB_OVER_CIRO / UNRULED_LAB), rule kind minimum_monthly = a monthly floor (the
// 'minimum_topup' component tops the payee's total up to it; the bank split uses the final total) and the doctor × lab
// summary of the month (lab_summary / lab_totals), and v2 (0033_hakedis_macro_import.sql): lines imported from the
// Macro reports (hakedis-macro.ts; fin_hk_import_macro) carry the Macro doctor, procedure, tooth and treatment day; the
// part of a treatment still unpaid at the end of its month is a line of method 'unpaid' deducted at the rule's
// deduct_unpaid_bp; lines of a Macro doctor mapped to the clinic or to an outside doctor have no doctor and count only
// in the clinic ciro (clinic_ciro_share); procedure groups (fin_hk_proc_groups: Macro operation names) and rule kind
// procedure_piece = a fixed amount per piece of one group for one doctor; imported pieces of the clinic wait for the
// performing doctor (fin_hk_assign_piece, UNASSIGNED_PIECES).
// Every rate and amount is data entered by the owner (basis points and integer cents); nothing here is hard-coded.
// Month arguments are sent as 'YYYY-MM-01' dates; month values read back may be 'YYYY-MM' or 'YYYY-MM-DD', so every
// helper compares them through monthKey().

import { formatTL, toFinanceError } from "./finance";
import type { Currency, PaymentMethod } from "./payments";
import { createClient } from "./supabase";

// ---------------------------------------------------------------------------
// Codes and labels (§2)
// ---------------------------------------------------------------------------

/** The payment methods of a line (and the rule deduction fields of the 0030 rules editor). */
export type HkMethod = PaymentMethod;
/**
 * The method of a revenue line (fin_hk_lines.method): a payment method, or (0033) 'unpaid' = the part of a treatment
 * still unpaid at the end of the treatment's month (Macro import), deducted at the rule's deduct_unpaid_bp.
 */
export type HkLineMethod = HkMethod | "unpaid";
export type HkCurrency = Currency;
/**
 * Rule kinds (fin_hk_rules.kind). fixed_monthly (0031): monthly net salary of any active user, in piece_cents.
 * bank_portion (0032): the fixed monthly amount of any active user paid by bank, in piece_cents; part of the payee's
 * total (hakediş or salary), never on top of it. minimum_monthly (0032, v1.4): the monthly floor of any active user, in
 * piece_cents; the payee's total is max(the other components, the floor). procedure_piece (0033): a doctor's fixed
 * amount (piece_cents) per piece of one procedure group (proc_group_id).
 */
export type HkKind =
  | "ciro_share"
  | "ortho_lab_first"
  | "implant_piece"
  | "procedure_piece"
  | "clinic_ciro_share"
  | "fixed_monthly"
  | "bank_portion"
  | "minimum_monthly";
/**
 * Rule kinds that become a component of their payee one to one (bank_portion only splits the total into bank and cash;
 * minimum_monthly adds a 'minimum_topup' component only when the floor applies).
 */
export type HkRuleComponentKind = Exclude<HkKind, "bank_portion" | "minimum_monthly">;
/**
 * Component kinds of a payee: one per active rule, plus one 'adjustments' component (no rule) for the month's bonuses,
 * plus one 'minimum_topup' component (0032) when the payee's minimum_monthly floor is above the rest.
 */
export type HkComponentKind = HkRuleComponentKind | "adjustments" | "minimum_topup";
/** fin_hk_adjustments.kind (0031): bonus, or anything else (negative = deduction). */
export type HkAdjustmentKind = "bonus" | "other";
export type HkSegment = "standard" | "child" | "own";
/** Lines: manual / import / burgan; pieces: manual / import / clinical (0030 CHECKs). */
export type HkSource = "manual" | "import" | "burgan" | "clinical";
export type HkMonthStatus = "open" | "closed";
/**
 * How the lines and pieces of a Macro doctor name are imported (fin_hk_ext_doctors.mode, 0033): 'doctor' = a DentOS
 * doctor (doctor_id); 'clinic' = the clinic's own revenue (no doctor; its pieces wait for the performing doctor);
 * 'outside' = an outside doctor without hakediş (no doctor; revenue in the clinic ciro, pieces not counted); 'ignore' =
 * not imported at all.
 */
export type HkExtDoctorMode = "doctor" | "clinic" | "outside" | "ignore";

/** Display order everywhere (tables, rules editor deduction fields). */
export const HK_METHODS: readonly HkMethod[] = ["cash", "card", "transfer", "financing"];
/** The line methods in display order (by_method columns from 0033): the payment methods, then 'unpaid'. */
export const HK_LINE_METHODS: readonly HkLineMethod[] = [...HK_METHODS, "unpaid"];
export const HK_SEGMENTS: readonly HkSegment[] = ["standard", "child", "own"];
/**
 * Rule kinds in display order; also the component order of a payee (then the 'adjustments' component, then the
 * 'minimum_topup' component; bank_portion and minimum_monthly are never components themselves).
 */
export const HK_KINDS: readonly HkKind[] = [
  "ciro_share",
  "ortho_lab_first",
  "implant_piece",
  "procedure_piece",
  "clinic_ciro_share",
  "fixed_monthly",
  "bank_portion",
  "minimum_monthly",
];
export const HK_ADJUSTMENT_KINDS: readonly HkAdjustmentKind[] = ["bonus", "other"];
export const HK_EXT_DOCTOR_MODES: readonly HkExtDoctorMode[] = ["doctor", "clinic", "outside", "ignore"];

export const METHOD_LABELS: Record<HkLineMethod, string> = {
  cash: "Nakit",
  card: "Kart",
  transfer: "Havale / EFT",
  financing: "Finansman (Burgan)",
  unpaid: "Ödenmemiş",
};

/** Rules editor titles of the deduction fields (0033: the unpaid one names the month-end cut-off). */
export const DEDUCT_LABELS: Record<HkLineMethod, string> = {
  ...METHOD_LABELS,
  unpaid: "Ödenmemiş (ay sonu)",
};

/** Rules editor hint of the unpaid deduction (ciro_share, 0033). */
export const UNPAID_DEDUCT_HINT =
  "Ay içinde yapılan tedavinin ay sonuna kadar ödenmemiş kısmı bu oranla kesilerek ciroya eklenir; " +
  "sonradan gelen ödemeler o ayı değiştirmez.";

export const EXT_DOCTOR_MODE_LABELS: Record<HkExtDoctorMode, string> = {
  doctor: "DentOS hekimi",
  clinic: "Klinik",
  outside: "Dışarıdan hekim (hakediş yok)",
  ignore: "Yok say",
};

/** Hints of the Macro doctor mapping choices (0033). */
export const EXT_DOCTOR_MODE_HINTS: Record<HkExtDoctorMode, string> = {
  doctor: "Satırları seçilen hekimin cirosuna girer.",
  clinic: "Ciro kliniğe aittir, hiçbir hekimin cirosuna girmez; işlemleri yapan hekimi siz seçersiniz.",
  outside: "Hakediş hesaplanmaz; ciro klinik toplamına girer, işlem ücretleri sayılmaz.",
  ignore: "Bu hekimin satırları aktarılmaz.",
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
  procedure_piece: "İşlem başı ücret",
  clinic_ciro_share: "Yönetim payı (klinik cirosu)",
  fixed_monthly: "Sabit aylık maaş",
  bank_portion: "Bankadan ödenen sabit tutar",
  minimum_monthly: "Taban maaş (hangisi yüksekse)",
};

/** Rules editor hint of the bank_portion kind. */
export const BANK_PORTION_HINT =
  "Hakedişin/maaşın bankadan ödenen kısmı; toplamı değiştirmez, ödemeyi bankadan ve elden diye böler.";

/** Rules editor hint of the minimum_monthly kind (0032). */
export const MINIMUM_MONTHLY_HINT = "Ayın hakedişi bu tutarın altında kalırsa bu tutar ödenir.";

/** Title of a payee's 'minimum_topup' component (floor − the other components, 0032). */
export const MINIMUM_TOPUP_COMPONENT_LABEL = "Taban maaş tamamlaması";

/** Titles of the lab figures (0032): month summary column, ciro_share component lines and the "Lab özeti" tab. */
export const LAB_LABELS = {
  tab: "Lab özeti",
  column: "Lab",
  cost: "Lab maliyeti",
  deducted: "Cirodan düşülen",
  excess: "Klinikte kalan",
  count: "Kayıt",
  lab: "Laboratuvar",
  total: "Laboratuvar toplamları",
} as const;

/** "Lab özeti" tab hint (0032). */
export const LAB_SUMMARY_HINT =
  "Her laboratuvarın aylık toplamını o laboratuvarın aylık ekstresiyle karşılaştırabilirsiniz. " +
  "Kliniğin laboratuvarlarla hesabı Finans → Cariler ekranındadır.";

/** Titles of a payee's bank / cash split (bank_cents / cash_cents, 0032). */
export const SPLIT_LABELS = { bank: "Bankadan", cash: "Elden" } as const;

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

/** Rules editor hint of the procedure_piece kind (0033). */
export const PROCEDURE_PIECE_HINT =
  "Seçilen işlem grubundaki her işlem için sabit tutar; işlemin fiyatı (0 TL olsa da) dikkate alınmaz.";

/**
 * Which form fields a rule kind uses (§1 fin_hk_rules checks); the others are sent as null / 0. deductions = the four
 * payment method deductions; unpaid (0033) = deduct_unpaid_bp; group (0033) = proc_group_id.
 */
export const RULE_FIELDS: Record<
  HkKind,
  {
    doctor: boolean;
    segment: boolean;
    share: boolean;
    piece: boolean;
    deductions: boolean;
    unpaid: boolean;
    group: boolean;
  }
> = {
  ciro_share: { doctor: true, segment: true, share: true, piece: false, deductions: true, unpaid: true, group: false },
  ortho_lab_first: {
    doctor: true,
    segment: false,
    share: true,
    piece: false,
    deductions: true,
    unpaid: false,
    group: false,
  },
  implant_piece: {
    doctor: true,
    segment: false,
    share: false,
    piece: true,
    deductions: false,
    unpaid: false,
    group: false,
  },
  // piece_cents holds the amount per piece of the rule's procedure group (0033).
  procedure_piece: {
    doctor: true,
    segment: false,
    share: false,
    piece: true,
    deductions: false,
    unpaid: false,
    group: true,
  },
  clinic_ciro_share: {
    doctor: false,
    segment: false,
    share: true,
    piece: false,
    deductions: false,
    unpaid: false,
    group: false,
  },
  // piece_cents holds the monthly net salary; the payee may be any active user of the clinic (staff or doctor).
  fixed_monthly: {
    doctor: false,
    segment: false,
    share: false,
    piece: true,
    deductions: false,
    unpaid: false,
    group: false,
  },
  // piece_cents holds the monthly amount paid by bank; the payee may be any active user of the clinic.
  bank_portion: {
    doctor: false,
    segment: false,
    share: false,
    piece: true,
    deductions: false,
    unpaid: false,
    group: false,
  },
  // piece_cents holds the monthly floor; the payee may be any active user of the clinic.
  minimum_monthly: {
    doctor: false,
    segment: false,
    share: false,
    piece: true,
    deductions: false,
    unpaid: false,
    group: false,
  },
};

/**
 * Kinds whose payee may be any active user of the clinic (no doctors row needed) and whose overlap check is per payee:
 * fixed_monthly (0031), bank_portion and minimum_monthly (0032).
 */
export function kindAllowsAnyUser(kind: HkKind): boolean {
  return kind === "fixed_monthly" || kind === "bank_portion" || kind === "minimum_monthly";
}

/** Label of the piece_cents field of a rule kind that uses it (rules editor). */
export function pieceFieldLabel(kind: HkKind): string {
  if (kind === "fixed_monthly") return "Aylık net maaş (TL)";
  if (kind === "bank_portion") return "Aylık bankadan ödenen tutar (TL)";
  if (kind === "minimum_monthly") return "Aylık taban tutar (TL)";
  if (kind === "procedure_piece") return "İşlem başı tutar (TL)";
  return "İmplant başı tutar (TL)";
}

type HkDeductField =
  | "deduct_cash_bp"
  | "deduct_card_bp"
  | "deduct_transfer_bp"
  | "deduct_financing_bp"
  | "deduct_unpaid_bp";

/** The fin_hk_rules deduction column of each line method (deduct_unpaid_bp from 0033). */
export const DEDUCT_FIELD: Record<HkLineMethod, HkDeductField> = {
  cash: "deduct_cash_bp",
  card: "deduct_card_bp",
  transfer: "deduct_transfer_bp",
  financing: "deduct_financing_bp",
  unpaid: "deduct_unpaid_bp",
};

/** A rule's deduction rate of a line method; deduct_unpaid_bp is 0 when the rule (from before 0033) has none. */
export function ruleDeductBp(
  rule: Pick<HkRuleJson, "deduct_cash_bp" | "deduct_card_bp" | "deduct_transfer_bp" | "deduct_financing_bp"> & {
    deduct_unpaid_bp?: number | null;
  },
  method: HkLineMethod
): number {
  return rule[DEDUCT_FIELD[method]] ?? 0;
}

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

/** Patient key prefix of the rows imported from Macro: 'macro:' + D. NO (0033). */
export const HK_MACRO_REF_PREFIX = "macro:";

/**
 * The patient mark of a line / lab cost (0033, fin__hk_eval_lines / fin__hk_eval_lab_costs): the mark of its own key;
 * a Macro key ('macro:' + file number) without one takes the mark keyed by the bare file number (a reception
 * "Hasta no"), else the mark of the normalized patient name (a mark entered by name before the import). Any other key
 * takes its own mark only.
 */
export function markFor<M>(
  marks: ReadonlyMap<string, M>,
  row: { patient_ref: string; patient_name?: string | null }
): M | undefined {
  const own = marks.get(row.patient_ref);
  if (own !== undefined || !row.patient_ref.startsWith(HK_MACRO_REF_PREFIX)) return own;
  return (
    marks.get(row.patient_ref.slice(HK_MACRO_REF_PREFIX.length)) ?? marks.get(normalizePatientRef(row.patient_name))
  );
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
 * payroll payee (fixed_monthly rule, bonus) and from 0032 have a bank_portion rule. doctor_id null = staff without a
 * doctors row.
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
  /**
   * implant_piece: amount per implant; procedure_piece: amount per piece of the group; fixed_monthly: monthly net
   * salary; bank_portion: monthly bank amount; minimum_monthly: monthly floor
   */
  piece_cents: number | null;
  /** 0 unless ciro_share / ortho_lab_first */
  deduct_cash_bp: number;
  deduct_card_bp: number;
  deduct_transfer_bp: number;
  deduct_financing_bp: number;
  /** 0033: the deduction of the 'unpaid' lines (ciro_share only, else 0); absent before 0033 */
  deduct_unpaid_bp?: number;
  /** 0033: procedure_piece only: the procedure group (fin_hk_proc_groups); null / absent otherwise */
  proc_group_id?: string | null;
  proc_group_name?: string | null;
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

/**
 * A procedure group (fin_hk_proc_groups, 0033): Macro operation names whose treatments rows are pieces of the group
 * (procedure_piece rules; is_implant groups also feed implant_piece rules). op_names are stored normalized
 * (fin__normalize_name), each unique across the clinic's groups.
 */
export interface HkProcGroupJson extends HkStamped {
  id: string;
  version: number;
  /** 1..80 characters, unique (normalized) in the clinic */
  name: string;
  is_implant: boolean;
  op_names: string[];
  is_active: boolean;
  note: string;
}

/** A Macro doctor name and how its rows are imported (fin_hk_ext_doctors, 0033). */
export interface HkExtDoctorJson extends HkStamped {
  id: string;
  version: number;
  /** normalized Macro doctor name (fin__normalize_name), unique in the clinic */
  ext_name: string;
  /** the name as typed / as in the report (spaces collapsed) */
  display_name: string;
  mode: HkExtDoctorMode;
  /** mode 'doctor' only */
  doctor_id: string | null;
  doctor_name: string | null;
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
  /** 0033: the clinic's procedure groups (inactive ones included); absent before 0033 */
  proc_groups?: HkProcGroupJson[];
  /** 0033: the Macro doctor mapping (by display name); absent before 0033 */
  ext_doctors?: HkExtDoctorJson[];
  /** 0033: the last 30 Macro imports, newest first (counts only); absent before 0033 */
  import_batches?: HkImportBatchJson[];
}

/** A Macro import of fin_hk_reference (0033): the range, the files and the counts of its summary. */
export interface HkImportBatchJson {
  id: string;
  version: number;
  from_day: string;
  to_day: string;
  file_names: string[];
  /** lines / pieces written by the import (the summary's counts) */
  lines: number | null;
  pieces: number | null;
  /** a later import of a range covering this one replaced it */
  replaced_by_batch: string | null;
  created_at: string;
  created_by_name: string | null;
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
  /** payment day; for a Macro production line (0033) the treatment day */
  day: string;
  /**
   * 0033: null only on an imported line of a Macro doctor mapped to the clinic or to an outside doctor (counted in the
   * clinic ciro only, never UNRULED)
   */
  doctor_id: string | null;
  doctor_name: string | null;
  patient_ref: string;
  patient_name: string;
  method: HkLineMethod;
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
  /**
   * 0033, Macro import: 'production' = a treatments-report line (day = treatment day), 'payment' = an orthodontist's
   * payments-report line (day = payment day); null on manual / Burgan lines
   */
  basis?: HkImportBasis | null;
  /** 0033, Macro import: the Macro doctor name as in the report */
  ext_doctor?: string | null;
  /** 0033, Macro import: the Macro operation name */
  procedure?: string | null;
  /** 0033, Macro import: tooth / teeth as in the report ("36", "31,32,33") */
  tooth?: string | null;
  /** 0033, Macro import: the treatment day (= day for a production line; earlier or later for a payment line) */
  treatment_day?: string | null;
  /** 0033: the procedure group of the operation, if any */
  proc_group_id?: string | null;
  proc_group_name?: string | null;
  /** 0033, Macro import: the patient file number (D. NO) */
  macro_patient_no?: string | null;
}

/** Pieces (implant_piece rules; from 0033 also procedure_piece rules, by procedure group). */
export interface HkPieceJson extends HkVoidable, HkStamped {
  id: string;
  version: number;
  source: HkSource;
  source_key: string | null;
  day: string;
  /**
   * 0033: null only on an imported piece of a Macro doctor mapped to the clinic (waiting for the performing doctor,
   * fin_hk_assign_piece) or marked "no hakediş" (assigned_none)
   */
  doctor_id: string | null;
  doctor_name: string | null;
  patient_ref: string;
  patient_name: string;
  /** negative = correction */
  qty: number;
  description: string;
  /** 0033: the import that wrote the piece (null on manual / clinical pieces) */
  batch_id?: string | null;
  /** 0033: the procedure group; null = a manual (implant) piece; an imported piece always has one */
  proc_group_id?: string | null;
  proc_group_name?: string | null;
  proc_group_is_implant?: boolean | null;
  /** 0033, Macro import */
  ext_doctor?: string | null;
  procedure?: string | null;
  tooth?: string | null;
  macro_patient_no?: string | null;
  /** 0033: the preparer marked the piece "Hakediş yok" (no doctor, not counted, no warning) */
  assigned_none?: boolean;
  /** 0033: no doctor and not "Hakediş yok": waiting for the performing doctor (UNASSIGNED_PIECES) */
  is_unassigned?: boolean;
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
   * the patient has payments (0032: or lab costs, which resolve their rule from the mark) in a closed month: own doctor
   * / birth date can be changed only by a finance writer (the server refuses others)
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
  /**
   * 0032: the engine's resolution of a live cost, like a revenue line of the patient on the cost's day: the doctor's
   * ortho_lab_first rule, else the ciro_share rule of the resolved segment, else the doctor's standard one; null = no
   * such rule (UNRULED_LAB) or voided. Absent before 0032.
   */
  rule_id?: string | null;
  resolved_segment?: HkSegment | null;
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

/**
 * The method buckets of a ciro_share / ortho_lab_first component. 'unpaid' (0033) is present only when the rule has a
 * deduct_unpaid_bp or 'unpaid' lines in the month, so a component without either keeps its 0032 keys.
 */
export type HkByMethodJson = Record<HkMethod, HkMethodBucketJson> & { unpaid?: HkMethodBucketJson };

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

/**
 * A component computed from one active rule (every kind but bank_portion and minimum_monthly, fixed_monthly included:
 * 13 keys in the SQL payload, plus lab_cents / lab_excess_cents on a ciro_share component with lab costs, 0032).
 */
export interface HkRuleComponentJson {
  rule_id: string;
  kind: HkRuleComponentKind;
  doctor_id: string | null;
  doctor_name: string | null;
  segment: HkSegment | null;
  share_bp: number | null;
  /** implant_piece: amount per implant; procedure_piece: amount per piece; fixed_monthly: the monthly net salary */
  piece_cents: number | null;
  /** ciro_share / ortho_lab_first only */
  by_method: HkByMethodJson | null;
  /**
   * matrah: Σ(eligible − deduction) for ciro / ortho (ciro_share from 0032: minus lab_cents), gross clinic ciro for
   * clinic_ciro_share; implant_piece: null in the SQL payload, 0 from computeMonth; procedure_piece and fixed_monthly:
   * null
   */
  base_cents: number | null;
  /** fixed_monthly: the salary (= piece_cents) */
  amount_cents: number;
  /** implant_piece / procedure_piece only: Σ qty */
  qty: number | null;
  /** fixed_monthly: 0 */
  lines_count: number;
  /** ortho_lab_first only (null / absent otherwise) */
  lab_patients?: HkLabPatientJson[] | null;
  /**
   * 0032, ciro_share only, present when live lab costs of the month resolve to the rule: the part of their sum L
   * deducted from the ciro after the method deductions C, i.e. min(L, max(C, 0)), so the base never goes below 0
   * because of lab costs (and a negative C stays as it is). A negative L (corrections) is deducted whole.
   */
  lab_cents?: number;
  /** 0032, with lab_cents: L − lab_cents, the lab cost left with the clinic (LAB_OVER_CIRO when > 0) */
  lab_excess_cents?: number;
  /** 0033, procedure_piece only: the rule's procedure group */
  proc_group_id?: string | null;
  proc_group_name?: string | null;
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
  lab_cents?: undefined;
  lab_excess_cents?: undefined;
  proc_group_id?: undefined;
  proc_group_name?: undefined;
}

/**
 * 0032: the top-up of a payee's minimum_monthly floor, after every other component: amount = floor − the sum of the
 * other components, only when that sum is below the floor (the payee's total is then the floor).
 */
export interface HkMinimumTopupComponentJson {
  kind: "minimum_topup";
  /** the minimum_monthly rule */
  rule_id: string;
  amount_cents: number;
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
  lab_cents?: undefined;
  lab_excess_cents?: undefined;
  proc_group_id?: undefined;
  proc_group_name?: undefined;
  items?: undefined;
}

/**
 * One component of a payee: one per active rule, plus one 'adjustments' component when the month has live rows, plus
 * one 'minimum_topup' component when a floor applies.
 */
export type HkComponentJson = HkRuleComponentJson | HkAdjustmentsComponentJson | HkMinimumTopupComponentJson;

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
  /**
   * 0032: the payee's bank_portion amount active in the month (paid by bank as part of total_cents), null without one.
   * Absent in payloads and statements from before 0032.
   */
  bank_cents?: number | null;
  /**
   * 0032: total_cents − bank_cents (paid in cash; negative when the bank part exceeds the total), null without one.
   * total_cents is the final total (after a minimum_topup).
   */
  cash_cents?: number | null;
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
    }
  | {
      /** 0032: the bank part is more than the month's total (the amounts are not changed; the close is not blocked) */
      code: "BANK_OVER_TOTAL";
      payee_user_id: string;
      payee_name: string;
      bank_cents: number;
      total_cents: number;
    }
  | {
      /**
       * 0032: the month's lab costs of a ciro_share rule exceed its ciro after the method deductions; the base was not
       * taken below 0 and excess_cents stays with the clinic (no carry-forward).
       */
      code: "LAB_OVER_CIRO";
      doctor_id: string;
      doctor_name: string;
      rule_id: string;
      segment: HkSegment | null;
      /** L: the month's lab costs resolved to the rule */
      lab_cents: number;
      /** C: Σ(eligible − deduction) of the rule before the lab costs */
      ciro_after_deductions_cents: number;
      /** L − the deducted part */
      excess_cents: number;
    }
  | {
      /**
       * 0032: the month's lab costs of a doctor without an ortho_lab_first or (matching / standard) ciro_share rule;
       * deducted nowhere. Reported when they do not net to zero.
       */
      code: "UNRULED_LAB";
      doctor_id: string;
      doctor_name: string;
      lab_cents: number;
    }
  | {
      /**
       * 0033: the month's live imported pieces of a procedure group without a doctor (a Macro doctor mapped to the
       * clinic) that the preparer has neither assigned to the performing doctor nor marked "Hakediş yok". Counted for
       * nobody until then; the close is not blocked.
       */
      code: "UNASSIGNED_PIECES";
      /** Σ qty */
      count: number;
      /** per group, by group name */
      groups: HkUnassignedGroupJson[];
    };

/** A procedure group of the UNASSIGNED_PIECES warning (0033). */
export interface HkUnassignedGroupJson {
  proc_group_id: string;
  name: string;
  /** Σ qty */
  count: number;
}

/** A doctor × lab row of the month's lab summary (0032, fin_hk_month lab_summary). */
export interface HkLabSummaryRowJson {
  doctor_id: string;
  doctor_name: string;
  lab_name: string;
  /** Σ the month's live lab costs of the doctor at this lab (0 when only an earlier cost was recovered this month) */
  cost_cents: number;
  /**
   * deducted from the doctor's figures this month: ciro_share = the lab's share of each rule's lab_cents; ortho = the
   * lab's share of the lab part recovered from this month's payments (per patient, by the patient's lab costs to
   * date); 0 for unruled costs. Shares are proportional, rounded cumulatively in COLLATE "C" lab name order
   * (allocateByWeight).
   */
  deducted_cents: number;
  /** live lab cost rows of the month */
  count: number;
}

/** Month totals per lab (0032, fin_hk_month lab_totals): to compare with each lab's single monthly statement. */
export interface HkLabTotalJson {
  lab_name: string;
  cost_cents: number;
  deducted_cents: number;
  count: number;
}

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
  /**
   * 0032: doctor × lab rows of the month (fin__hk_lab_alloc next to the compute; not in fin__hk_compute or in a
   * statement breakdown), by doctor name, doctor id, lab name. Kept for 'hakedis_prepare' callers. Absent before 0032.
   */
  lab_summary?: HkLabSummaryRowJson[];
  /** 0032: lab_summary summed per lab, by lab name. Absent before 0032. */
  lab_totals?: HkLabTotalJson[];
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
  /** 0032: the caller's bank part of the month (statement breakdown when closed), null without one */
  bank_cents?: number | null;
  /** 0032: total_cents − bank_cents, null without a bank part */
  cash_cents?: number | null;
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
  method: HkLineMethod;
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
  /** 0033, an imported line: the Macro operation and tooth */
  procedure?: string | null;
  tooth?: string | null;
}

export interface HkMyPieceJson {
  id?: string;
  day: string;
  patient_name: string;
  qty: number;
  description?: string;
  /** 0033, a grouped piece: its procedure group, the Macro operation and tooth */
  proc_group_name?: string | null;
  procedure?: string | null;
  tooth?: string | null;
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
  /** 0032: see HkPayeeJson.bank_cents / cash_cents */
  bank_cents?: number | null;
  cash_cents?: number | null;
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
  /**
   * lab cost rows of the caller's patients: to date for an ortho doctor (the patients of the caller's ortho
   * components), from 0032 also the month's rows counted under the caller's own ciro_share rules
   */
  lab_costs: HkMyLabCostJson[];
  /**
   * 0032: the caller's doctor × lab rows of the month (same shape as fin_hk_month's; deducted_cents from the caller's
   * own payee object, the frozen statement in a closed month). Absent before 0032.
   */
  lab_summary?: HkLabSummaryRowJson[];
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
  /** 0033: ciro_share only (0..10000), else 0; sent as 0 when left out */
  p_deduct_unpaid_bp?: number;
  /** 0033: procedure_piece only, else null; sent as null when left out */
  p_proc_group_id?: string | null;
}

/** Saves a rule; from 0033 p_deduct_unpaid_bp and p_proc_group_id are always sent (0 / null when left out). */
export function finHkSaveRule(args: HkSaveRuleArgs) {
  return rpc<HkWriteResult<HkRuleJson>>("fin_hk_save_rule", {
    ...args,
    p_from_month: monthStart(args.p_from_month),
    p_to_month: args.p_to_month ? monthStart(args.p_to_month) : null,
    p_deduct_unpaid_bp: args.p_deduct_unpaid_bp ?? 0,
    p_proc_group_id: args.p_proc_group_id ?? null,
  });
}

export interface HkSaveLineArgs {
  p_id: string;
  p_version: number;
  p_day: string;
  p_doctor_id: string;
  p_patient_name: string;
  /**
   * null → fin__normalize_name(p_patient_name); 0033: a new key of a patient already imported from Macro (an empty key
   * or a typed Macro file number) becomes the key of the patient's imported rows (fin__hk_resolve_ref)
   */
  p_patient_ref: string | null;
  p_method: HkLineMethod;
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
  /** as HkSaveLineArgs.p_patient_ref (0033: resolved against the Macro import) */
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

/**
 * 0033: the doctor of an imported piece (typically one of a Macro doctor mapped to the clinic): the performing doctor
 * (p_doctor_id), "Hakediş yok" (p_none true, p_doctor_id null) or neither (back to unassigned). Live pieces of open
 * months only; 'finance' or 'hakedis_prepare'.
 */
export function finHkAssignPiece(args: { p_id: string; p_version: number; p_doctor_id: string | null; p_none: boolean }) {
  return rpc<HkWriteResult<HkPieceJson>>("fin_hk_assign_piece", { ...args });
}

export interface HkSaveProcGroupArgs {
  p_id: string;
  /** 0 = create with the client-generated p_id */
  p_version: number;
  /** 1..80 characters, unique (normalized) in the clinic */
  p_name: string;
  p_is_implant: boolean;
  /** Macro operation names (1..200 characters each); normalized and de-duplicated by the server */
  p_op_names: string[];
  p_is_active: boolean;
  p_note: string;
}

/** 0033: creates / updates a procedure group ('finance' or 'hakedis_prepare'). */
export function finHkSaveProcGroup(args: HkSaveProcGroupArgs) {
  return rpc<HkWriteResult<HkProcGroupJson>>("fin_hk_save_proc_group", { ...args });
}

export interface HkSaveExtDoctorArgs {
  p_id: string;
  /** 0 = create with the client-generated p_id */
  p_version: number;
  /** the Macro doctor name (normalized by the server) */
  p_ext_name: string;
  p_mode: HkExtDoctorMode;
  /** mode 'doctor' only, else null */
  p_doctor_id: string | null;
}

/** 0033: maps a Macro doctor name ('finance' or 'hakedis_prepare'). */
export function finHkSaveExtDoctor(args: HkSaveExtDoctorArgs) {
  return rpc<HkWriteResult<HkExtDoctorJson>>("fin_hk_save_ext_doctor", { ...args });
}

/** Line basis of a Macro import line (0033). */
export type HkImportBasis = "production" | "payment";
/** Methods of a Macro import line: Macro İŞLEM (Nakit / POS / Banka), or the unpaid remainder of a treatment. */
export type HkImportMethod = "cash" | "card" | "transfer" | "unpaid";

/**
 * One element of fin_hk_import_macro p_lines (buildMacroImport, hakedis-macro.ts). Amounts are integer cents of
 * `currency`; the server converts them to TL with the clinic's fx_rates (latest rate on or before `day`), maps
 * ext_doctor through fin_hk_ext_doctors, assigns the procedure group from the operation name (active groups; implant
 * groups make the whole amount implant_cents) and sets patient_ref ('macro:' || patient_no, else the normalized name;
 * a payment line without a number takes the only key known for its name; a file number whose 'macro:' key is still
 * unused keeps the only other key its name has: a mark, lab cost or earlier line keyed by the name or by the bare
 * number). Every day must lie in [p_from, p_to].
 */
export interface HkImportLineArg {
  /** unique within the import (≤ 100 characters; only echoed in errors, never stored) */
  key: string;
  /** production = treatments report (day = treatment day); payment = payments report of an orthodontist */
  basis: HkImportBasis;
  /** 'YYYY-MM-DD': the treatment day (production) or the payment day (payment) */
  day: string;
  /** 'YYYY-MM-DD': the treatment day (= day for production lines) */
  treatment_day: string;
  /** the Macro doctor name as in the report */
  ext_doctor: string;
  patient_name: string;
  /** Macro D. NO, null when unknown */
  patient_no: string | null;
  procedure: string;
  tooth: string | null;
  method: HkImportMethod;
  currency: HkCurrency;
  /** > 0, except a correction (negative report row) */
  amount_cents: number;
}

/** One element of fin_hk_import_macro p_pieces: one per treatments row in the range (whatever its price). */
export interface HkImportPieceArg {
  key: string;
  /** the treatment day */
  day: string;
  ext_doctor: string;
  patient_name: string;
  patient_no: string | null;
  procedure: string;
  tooth: string | null;
  qty: number;
}

export interface HkImportMacroArgs {
  /** client-generated; a retry with the same id returns the saved summary (already_saved) */
  p_batch_id: string;
  /**
   * 'YYYY-MM-DD', inclusive, at most 366 days, p_to not after today; the range replaces the previous import of the
   * same days (lines by day, pieces by day) and may not touch a closed month or a month before a later closed one
   */
  p_from: string;
  p_to: string;
  p_lines: HkImportLineArg[];
  p_pieces: HkImportPieceArg[];
  /** the report file names (≤ 10, 1..200 characters each) */
  p_files: string[];
  /** true: validate and summarize, then roll back (preview) */
  p_dry_run?: boolean;
}

/** A Macro doctor of the payload in the import summary (0033); every amount in TL cents. */
export interface HkImportDoctorSummaryJson {
  /** the mapping's display name */
  ext_doctor: string;
  /** normalized (fin_hk_ext_doctors.ext_name) */
  ext_name: string;
  mode: HkExtDoctorMode;
  doctor_id: string | null;
  doctor_name: string | null;
  /** lines written (payment basis included) */
  lines: number;
  payment_lines: number;
  /** lines of an ignored Macro doctor (not written) */
  skipped_lines: number;
  gross_cents: number;
  gross_by_method: Record<HkImportMethod, number>;
  /** the lines of implant-group operations (implant_cents = the whole TL amount) */
  implant_cents: number;
  /** stored pieces (rows) and their Σ qty */
  pieces: number;
  pieces_qty: number;
  /** stored pieces per group (Σ qty), by group name */
  pieces_by_group: HkUnassignedGroupJson[];
  /** Σ qty of stored pieces without a doctor (clinic rows not yet assigned) */
  unassigned_pieces: number;
  /** rows of operations without an active group (not stored) */
  ungrouped_pieces: number;
  /** rows of an outside / ignored Macro doctor (not stored) */
  skipped_pieces: number;
}

/** An operation name of the payload in the import summary (0033): its active group, if any. */
export interface HkImportOperationJson {
  /** the first spelling (by text) */
  name: string;
  /** fin__normalize_name: what a group's op_names hold */
  normalized: string;
  proc_group_id: string | null;
  proc_group_name: string | null;
  is_implant: boolean | null;
  /** payload lines / pieces with this operation (ignored doctors included) */
  lines: number;
  pieces: number;
}

/** A foreign currency rate used by the import (0033): one row per (currency, rate, rate day). */
export interface HkImportFxJson {
  currency: HkCurrency;
  rate: number;
  rate_day: string;
  lines: number;
  first_day: string;
  last_day: string;
}

/** A foreign currency converted with a rate older than 7 days (0033). */
export interface HkImportFxWarningJson {
  currency: HkCurrency;
  /** the line's day */
  day: string;
  rate_day: string;
  rate: number;
  age_days: number;
}

/**
 * fin_hk_import_macro result (0033), also stored as the batch's stats. replaced_* are the live imported lines /
 * pieces of the range voided ('Yeniden yüklendi') and the earlier batches inside the range (a dry run reports what
 * would be replaced).
 */
export interface HkImportSummaryJson {
  batch_id: string;
  from: string;
  to: string;
  files: string[];
  lines: number;
  pieces: number;
  try_total_cents: number;
  implant_total_cents: number;
  skipped_lines: number;
  skipped_pieces: number;
  ungrouped_pieces: number;
  unassigned_pieces: number;
  /** "Hakediş yok" / doctor choices of replaced clinic pieces carried over to the same new rows */
  carried_assignments: number;
  replaced_lines?: number;
  replaced_pieces?: number;
  replaced_batches?: number;
  doctors: HkImportDoctorSummaryJson[];
  operations: HkImportOperationJson[];
  fx: HkImportFxJson[];
  fx_warnings: HkImportFxWarningJson[];
  /** a retry with a saved p_batch_id: the saved summary, nothing written */
  already_saved?: boolean;
  dry_run?: boolean;
}

/**
 * Why fin_hk_import_macro refused (0033), from the error's DETAIL (PostgREST 'details'): the Macro doctors without a
 * mapping, or the currencies without a rate on or before the first day that needs one. Null for other errors.
 */
export interface HkImportRefusal {
  unmapped_ext_doctors?: string[];
  missing_fx?: { currency: HkCurrency; day: string }[];
}

export function importRefusalOf(err: { details?: string | null } | null | undefined): HkImportRefusal | null {
  const raw = err?.details;
  if (!raw || raw[0] !== "{") return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const out: HkImportRefusal = {};
    if (Array.isArray(d.unmapped_ext_doctors)) {
      out.unmapped_ext_doctors = d.unmapped_ext_doctors.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(d.missing_fx)) {
      out.missing_fx = d.missing_fx
        .filter((x): x is { currency: HkCurrency; day: string } => !!x && typeof x === "object" && "currency" in x)
        .map((x) => ({ currency: x.currency, day: String(x.day ?? "") }));
    }
    return out.unmapped_ext_doctors || out.missing_fx ? out : null;
  } catch {
    return null;
  }
}

/**
 * 0033: imports the Macro reports of a day range ('finance' or 'hakedis_prepare'; refused when the range touches a
 * closed month, a Macro doctor is unmapped or a currency has no rate: importRefusalOf reads the DETAIL of the last two).
 * p_dry_run is always sent (false by default); a dry run returns the same summary and writes nothing.
 */
export function finHkImportMacro(args: HkImportMacroArgs) {
  return rpc<HkImportSummaryJson>("fin_hk_import_macro", { ...args, p_dry_run: args.p_dry_run ?? false });
}

export interface HkSaveMarkArgs {
  p_id: string;
  p_version: number;
  /** as HkSaveLineArgs.p_patient_ref (0033: resolved against the Macro import) */
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
  /** as HkSaveLineArgs.p_patient_ref (0033: resolved against the Macro import, the doctor's imported rows first) */
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
  /**
   * null → fin__normalize_name(p_patient_name); 0033: a new key of a patient already imported from Macro (empty, or
   * the Macro file number) becomes the key of the patient's imported rows
   */
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
  /** 0033: ciro_share only; absent = 0 */
  deduct_unpaid_bp?: number | null;
  /** 0033: procedure_piece only; absent = null */
  proc_group_id?: string | null;
  from_month: string;
  to_month: string | null;
}

/** Client-side mirror of the fin_hk_save_rule checks per kind; null when valid. Overlaps are checked by the server. */
export function validateRule(r: HkRuleInput): string | null {
  const f = RULE_FIELDS[r.kind];
  if (!f) return "Kural türünü seçin.";
  const salary = r.kind === "fixed_monthly";
  const bank = r.kind === "bank_portion";
  const minimum = r.kind === "minimum_monthly";
  if (!r.payee_user_id) {
    if (minimum) return "Taban maaş alacak kişiyi seçin.";
    return salary ? "Maaş alacak kişiyi seçin." : bank ? "Bankadan ödeme alacak kişiyi seçin." : "Hakediş sahibini seçin.";
  }
  if (f.doctor && !r.doctor_id) return "Hekimi seçin.";
  if (f.segment && !r.segment) return "Hasta grubunu seçin.";
  if (f.group && !r.proc_group_id) return "İşlem grubunu seçin.";
  if (!f.group && r.proc_group_id) return "İşlem grubu yalnızca işlem başı ücret kuralında seçilir.";
  if (f.share && (r.share_bp === null || !Number.isInteger(r.share_bp) || r.share_bp < 1 || r.share_bp > 10000)) {
    return "Pay oranı %0,01 ile %100 arasında olmalı.";
  }
  if (f.piece && (r.piece_cents === null || !Number.isInteger(r.piece_cents) || r.piece_cents <= 0)) {
    if (salary) return "Aylık net maaş 0'dan büyük olmalı.";
    if (minimum) return "Aylık taban tutar 0'dan büyük olmalı.";
    if (r.kind === "procedure_piece") return "İşlem başı tutar 0'dan büyük olmalı.";
    return bank ? "Aylık bankadan ödenen tutar 0'dan büyük olmalı." : "Adet başı tutar 0'dan büyük olmalı.";
  }
  for (const method of HK_LINE_METHODS) {
    const raw = r[DEDUCT_FIELD[method]];
    // deduct_unpaid_bp may be left out (a form from before 0033): 0.
    const bp = method === "unpaid" ? raw ?? 0 : raw;
    if (typeof bp !== "number" || !Number.isInteger(bp) || bp < 0 || bp > 10000) {
      return "Kesinti oranı %0 ile %100 arasında olmalı.";
    }
    const allowed = method === "unpaid" ? f.unpaid : f.deductions;
    if (!allowed && bp !== 0) return "Bu kural türünde kesinti girilemez.";
  }
  if (!MONTH_KEY_RE.test(r.from_month)) return "Başlangıç ayını seçin.";
  if (r.to_month) {
    if (!MONTH_KEY_RE.test(r.to_month)) return "Bitiş ayı geçersiz.";
    if (monthKey(r.to_month) < monthKey(r.from_month)) return "Bitiş ayı başlangıç ayından önce olamaz.";
  }
  return null;
}

/**
 * Rules that may not be active in the same month (fin_hk_save_rule overlap check): fixed_monthly, bank_portion and
 * minimum_monthly per (kind, payee), procedure_piece (0033) per (kind, doctor, procedure group), every other kind per
 * (kind, doctor, segment) regardless of the payee.
 */
export function ruleOverlapKey(
  r: Pick<HkRuleInput, "kind" | "payee_user_id" | "doctor_id" | "segment"> & { proc_group_id?: string | null }
): string {
  if (kindAllowsAnyUser(r.kind)) return `${r.kind}|${r.payee_user_id ?? ""}`;
  if (r.kind === "procedure_piece") return `${r.kind}|${r.doctor_id ?? ""}|${r.proc_group_id ?? ""}`;
  return `${r.kind}|${r.doctor_id ?? ""}|${r.segment ?? ""}`;
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

/**
 * 0033: the saved rule that would count the same implant pieces twice (fin_hk_save_rule refuses it): for a
 * procedure_piece rule of an implant group, the doctor's implant_piece rule active in a shared month; for an
 * implant_piece rule, the doctor's procedure_piece rules of implant groups. The earliest by from_month, then id.
 */
export function findImplantPieceConflict<T extends HkRuleInput & { id: string }>(
  rules: readonly T[],
  rule: HkRuleInput & { id?: string | null },
  groups: readonly Pick<HkProcGroupJson, "id" | "is_implant">[]
): T | undefined {
  const implantGroup = (id: string | null | undefined) => !!id && !!groups.find((g) => g.id === id)?.is_implant;
  let clashes: (r: T) => boolean;
  if (rule.kind === "procedure_piece" && implantGroup(rule.proc_group_id)) {
    clashes = (r) => r.kind === "implant_piece";
  } else if (rule.kind === "implant_piece") {
    clashes = (r) => r.kind === "procedure_piece" && implantGroup(r.proc_group_id);
  } else {
    return undefined;
  }
  return rules
    .filter((r) => r.id !== rule.id && r.doctor_id === rule.doctor_id && clashes(r) && monthRangesOverlap(r, rule))
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

/** The payee's bank_portion rule active in the month (bank amount in piece_cents), if any. */
export function bankRuleOf<T extends Pick<HkRuleJson, "kind" | "payee_user_id" | "from_month" | "to_month">>(
  rules: readonly T[],
  payeeUserId: string,
  month: string
): T | undefined {
  return rules.find((r) => r.kind === "bank_portion" && r.payee_user_id === payeeUserId && ruleActiveIn(r, month));
}

/** The payee's minimum_monthly rule active in the month (floor in piece_cents), if any. */
export function minimumRuleOf<T extends Pick<HkRuleJson, "kind" | "payee_user_id" | "from_month" | "to_month">>(
  rules: readonly T[],
  payeeUserId: string,
  month: string
): T | undefined {
  return rules.find((r) => r.kind === "minimum_monthly" && r.payee_user_id === payeeUserId && ruleActiveIn(r, month));
}

/** A payee's bank / cash split (0032); over_cents = how much the bank part exceeds the total (0 when it does not). */
export interface HkBankSplit {
  bank_cents: number;
  cash_cents: number;
  over_cents: number;
}

/**
 * The bank / cash split of a payee object (fin_hk_month, statement breakdown, hk_my_*), or null without a bank part
 * (bank_cents null or absent). cash_cents falls back to total − bank when the payload leaves it out.
 */
export function bankSplitOf(p: {
  total_cents: number;
  bank_cents?: number | null;
  cash_cents?: number | null;
}): HkBankSplit | null {
  if (typeof p.bank_cents !== "number") return null;
  const cash = typeof p.cash_cents === "number" ? p.cash_cents : p.total_cents - p.bank_cents;
  return { bank_cents: p.bank_cents, cash_cents: cash, over_cents: Math.max(p.bank_cents - p.total_cents, 0) };
}

/** BANK_OVER_TOTAL text without the payee's name: "Bankadan ödenen tutar bu ayın toplamını ₺X aşıyor." */
export function bankOverText(overCents: number): string {
  return `Bankadan ödenen tutar bu ayın toplamını ${formatTL(overCents)} aşıyor.`;
}

/** "Bankadan ₺1.234,00 · Elden ₺567,00"; "" without a bank part. */
export function bankSplitText(p: { total_cents: number; bank_cents?: number | null; cash_cents?: number | null }): string {
  const split = bankSplitOf(p);
  if (!split) return "";
  return `${SPLIT_LABELS.bank} ${formatTL(split.bank_cents)} · ${SPLIT_LABELS.cash} ${formatTL(split.cash_cents)}`;
}

// ---------------------------------------------------------------------------
// Procedure groups and the Macro doctor mapping (0033)
// ---------------------------------------------------------------------------

/** fin_hk_proc_groups.name and op_names limits (CHECKs, fin_hk_save_proc_group). */
export const HK_PROC_GROUP_NAME_MAX = 80;
export const HK_OP_NAME_MAX = 200;
export const HK_OP_NAMES_MAX = 500;
/** fin_hk_ext_doctors.display_name limit. */
export const HK_EXT_NAME_MAX = 120;

/** Operation names as fin_hk_save_proc_group stores them: normalized (fin__normalize_name), blanks dropped, unique. */
export function normalizeOpNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const n = normalizePatientRef(name);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export interface HkProcGroupInput {
  id?: string | null;
  name: string;
  op_names: readonly string[];
}

/**
 * Client-side mirror of the fin_hk_save_proc_group checks: a name (1..80), each operation name ≤ 200 characters and
 * unique across the clinic's groups (normalized), the group name unique too. Null when valid.
 */
export function validateProcGroup(
  g: HkProcGroupInput,
  others: readonly Pick<HkProcGroupJson, "id" | "name" | "op_names">[] = []
): string | null {
  const name = (g.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return "Grup adını girin.";
  if (name.length > HK_PROC_GROUP_NAME_MAX) return `Grup adı en fazla ${HK_PROC_GROUP_NAME_MAX} karakter olabilir.`;
  if (g.op_names.length > HK_OP_NAMES_MAX) return `Bir grupta en fazla ${HK_OP_NAMES_MAX} işlem adı olabilir.`;
  if (g.op_names.some((op) => op.trim().length > HK_OP_NAME_MAX)) {
    return `İşlem adı en fazla ${HK_OP_NAME_MAX} karakter olabilir.`;
  }
  const rest = others.filter((o) => o.id !== g.id);
  if (rest.some((o) => normalizePatientRef(o.name) === normalizePatientRef(name))) {
    return "Bu adla başka bir işlem grubu var.";
  }
  for (const op of normalizeOpNames(g.op_names)) {
    if (op.length > HK_OP_NAME_MAX) return `İşlem adı en fazla ${HK_OP_NAME_MAX} karakter olabilir.`;
    const owner = rest.find((o) => o.op_names.some((x) => normalizePatientRef(x) === op));
    if (owner) return `“${op}” işlemi zaten “${owner.name}” grubunda.`;
  }
  return null;
}

/**
 * The group saves (fin_hk_save_proc_group) that put a Macro operation name into the group `targetId` (null = into no
 * group): out of the group that holds it (any group, inactive ones too: a name belongs to at most one group of the
 * clinic), then into the target. Empty when it is already where it should be. op_names come back normalized.
 */
export function opNameMoves<T extends Pick<HkProcGroupJson, "id" | "op_names">>(
  groups: readonly T[],
  operation: string,
  targetId: string | null
): { group: T; op_names: string[] }[] {
  const op = normalizePatientRef(operation);
  if (!op) return [];
  const holder = groups.find((g) => g.op_names.some((x) => normalizePatientRef(x) === op));
  if ((holder?.id ?? null) === targetId) return [];
  const moves: { group: T; op_names: string[] }[] = [];
  if (holder) {
    moves.push({ group: holder, op_names: normalizeOpNames(holder.op_names).filter((x) => x !== op) });
  }
  const target = targetId ? groups.find((g) => g.id === targetId) : undefined;
  if (target) moves.push({ group: target, op_names: normalizeOpNames([...target.op_names, op]) });
  return moves;
}

/** The procedure group of a Macro operation name (normalized match), active groups only; undefined if none. */
export function procGroupOfOperation<T extends Pick<HkProcGroupJson, "op_names" | "is_active">>(
  groups: readonly T[],
  operation: string
): T | undefined {
  const op = normalizePatientRef(operation);
  if (!op) return undefined;
  return groups.find((g) => g.is_active && g.op_names.some((x) => normalizePatientRef(x) === op));
}

/** The mapping of a Macro doctor name (normalized match); undefined while unmapped. */
export function extDoctorOf<T extends Pick<HkExtDoctorJson, "ext_name">>(
  mapping: readonly T[],
  extName: string
): T | undefined {
  const key = normalizePatientRef(extName);
  return mapping.find((m) => normalizePatientRef(m.ext_name) === key);
}

/** Client-side mirror of the fin_hk_save_ext_doctor checks; null when valid. */
export function validateExtDoctor(m: { ext_name: string; mode: HkExtDoctorMode | null; doctor_id: string | null }): string | null {
  if (!normalizePatientRef(m.ext_name)) return "Macro hekim adı boş olamaz.";
  if (m.ext_name.trim().replace(/\s+/g, " ").length > HK_EXT_NAME_MAX) {
    return `Macro hekim adı en fazla ${HK_EXT_NAME_MAX} karakter olabilir.`;
  }
  if (!m.mode || !HK_EXT_DOCTOR_MODES.includes(m.mode)) return "Eşleştirme türünü seçin.";
  if (m.mode === "doctor" && !m.doctor_id) return "DentOS hekimini seçin.";
  if (m.mode !== "doctor" && m.doctor_id) return "Hekim yalnızca “DentOS hekimi” seçeneğinde seçilir.";
  return null;
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

/**
 * "Ciro payı · Çocuk hasta · Hekim A"; "İşlem başı ücret · Grup X · Hekim A"; "Sabit aylık maaş"; "Prim ve diğer";
 * "Taban maaş tamamlaması"
 */
export function componentTitle(
  c: Pick<HkComponentJson, "kind"> &
    Partial<Pick<HkComponentJson, "segment" | "doctor_name">> & { proc_group_name?: string | null }
): string {
  if (c.kind === "adjustments") return ADJUSTMENTS_COMPONENT_LABEL;
  if (c.kind === "minimum_topup") return MINIMUM_TOPUP_COMPONENT_LABEL;
  const parts = [KIND_LABELS[c.kind] ?? c.kind];
  if (c.kind === "ciro_share" && c.segment) parts.push(SEGMENT_LABELS[c.segment] ?? c.segment);
  if (c.kind === "procedure_piece" && c.proc_group_name) parts.push(c.proc_group_name);
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
    case "BANK_OVER_TOTAL":
      return `${w.payee_name || "Hakediş sahibi"}: ${bankOverText(w.bank_cents - w.total_cents)}`;
    case "LAB_OVER_CIRO": {
      const who = [w.doctor_name || "Hekim", w.segment ? SEGMENT_LABELS[w.segment] ?? w.segment : null]
        .filter(Boolean)
        .join(" · ");
      return `${who}: ayın lab maliyeti (${formatTL(w.lab_cents)}) kesintiler sonrası cirodan (${formatTL(w.ciro_after_deductions_cents)}) fazla; aşan ${formatTL(w.excess_cents)} hakedişten düşülmedi, klinikte kalır.`;
    }
    case "UNRULED_LAB":
      return `${w.doctor_name || "Hekim"}: ${formatTL(w.lab_cents)} lab maliyeti için ciro payı veya ortodonti kuralı yok; hakedişten düşülmedi.`;
    case "UNASSIGNED_PIECES": {
      const groups = (w.groups ?? []).map((g) => `${g.name} ${g.count}`).join(", ");
      return `Klinik adına aktarılan ${w.count} işlem için işlemi yapan hekim seçilmedi${groups ? ` (${groups})` : ""}; seçilene kadar hakedişe dahil edilmez.`;
    }
    default:
      return "Bilinmeyen uyarı.";
  }
}

/**
 * Payee table row (§2): ciro by method, implant part, lab, deductions, base, share, implants, management, total; from
 * 0031 also the fixed salary and the month's bonus / other rows; from 0032 the minimum top-up and the ciro_share lab
 * deduction; from 0033 the unpaid ciro (gross_by_method.unpaid) and the procedure piece fees.
 */
export interface HkPayeeSummary {
  gross_by_method: Record<HkLineMethod, number>;
  gross_cents: number;
  implant_cents: number;
  /**
   * lab costs deducted from the ciro / ortho figures: the ortho lab parts (by_method lab) plus, from 0032, the
   * ciro_share lab_cents. gross − implant − lab − deduction = base.
   */
  lab_cents: number;
  /** 0032: the ciro_share part of lab_cents (Σ lab_cents of the ciro_share components, after the method deductions) */
  ciro_lab_cents: number;
  /** 0032: Σ ciro_share lab_excess_cents (lab costs above the ciro, left with the clinic) */
  lab_excess_cents: number;
  deduction_cents: number;
  base_cents: number;
  share_cents: number;
  /** distinct share rates of the ciro / ortho components */
  share_bps: number[];
  implant_qty: number;
  implant_amount_cents: number;
  /** 0033: procedure_piece components (Σ qty, Σ amount) */
  procedure_qty: number;
  procedure_amount_cents: number;
  management_base_cents: number;
  management_cents: number;
  /** fixed_monthly components */
  salary_cents: number;
  /** 'adjustments' component: Σ bonus items, Σ other items, and the whole component */
  bonus_cents: number;
  other_cents: number;
  adjustments_cents: number;
  /** 0032: the 'minimum_topup' component (0 when the floor did not apply) */
  minimum_topup_cents: number;
  total_cents: number;
  /**
   * 0032: the payee's bank part and total − bank part (cash); both null without a bank part. In a totals row: the sums
   * over the payees that have one (null when none has).
   */
  bank_cents: number | null;
  cash_cents: number | null;
}

/** A summary with every figure 0 (and the given total), without a bank part. */
export function emptyPayeeSummary(totalCents = 0): HkPayeeSummary {
  return {
    gross_by_method: { cash: 0, card: 0, transfer: 0, financing: 0, unpaid: 0 },
    gross_cents: 0,
    implant_cents: 0,
    lab_cents: 0,
    ciro_lab_cents: 0,
    lab_excess_cents: 0,
    deduction_cents: 0,
    base_cents: 0,
    share_cents: 0,
    share_bps: [],
    implant_qty: 0,
    implant_amount_cents: 0,
    procedure_qty: 0,
    procedure_amount_cents: 0,
    management_base_cents: 0,
    management_cents: 0,
    salary_cents: 0,
    bonus_cents: 0,
    other_cents: 0,
    adjustments_cents: 0,
    minimum_topup_cents: 0,
    total_cents: totalCents,
    bank_cents: null,
    cash_cents: null,
  };
}

/**
 * Totals row of a payee table: every figure summed, share rates merged. management_base_cents stays 0: each
 * management share is computed on the same clinic ciro, so its bases do not add up. Bank / cash: summed over the
 * payees with a bank part, null when none has one.
 */
export function sumPayeeSummaries(rows: readonly HkPayeeSummary[]): HkPayeeSummary {
  const out = emptyPayeeSummary();
  for (const s of rows) {
    for (const m of HK_LINE_METHODS) out.gross_by_method[m] += s.gross_by_method[m] ?? 0;
    out.gross_cents += s.gross_cents;
    out.implant_cents += s.implant_cents;
    out.lab_cents += s.lab_cents;
    out.ciro_lab_cents += s.ciro_lab_cents;
    out.lab_excess_cents += s.lab_excess_cents;
    out.deduction_cents += s.deduction_cents;
    out.base_cents += s.base_cents;
    out.share_cents += s.share_cents;
    for (const bp of s.share_bps) if (!out.share_bps.includes(bp)) out.share_bps.push(bp);
    out.implant_qty += s.implant_qty;
    out.implant_amount_cents += s.implant_amount_cents;
    out.procedure_qty += s.procedure_qty;
    out.procedure_amount_cents += s.procedure_amount_cents;
    out.management_cents += s.management_cents;
    out.salary_cents += s.salary_cents;
    out.bonus_cents += s.bonus_cents;
    out.other_cents += s.other_cents;
    out.adjustments_cents += s.adjustments_cents;
    out.minimum_topup_cents += s.minimum_topup_cents;
    out.total_cents += s.total_cents;
    if (s.bank_cents !== null) out.bank_cents = (out.bank_cents ?? 0) + s.bank_cents;
    if (s.cash_cents !== null) out.cash_cents = (out.cash_cents ?? 0) + s.cash_cents;
  }
  return out;
}

/** A payee object of fin_hk_month (HkPayeeJson) or of hk_my_month (HkMyPayeeJson, trimmed management component). */
export function summarizePayee(p: {
  total_cents: number;
  components: readonly HkMyComponentJson[];
  bank_cents?: number | null;
  cash_cents?: number | null;
}): HkPayeeSummary {
  const s = emptyPayeeSummary(p.total_cents);
  const split = bankSplitOf(p);
  if (split) {
    s.bank_cents = split.bank_cents;
    s.cash_cents = split.cash_cents;
  }
  for (const c of p.components) {
    if (c.kind === "fixed_monthly") {
      s.salary_cents += c.amount_cents;
    } else if (c.kind === "minimum_topup") {
      s.minimum_topup_cents += c.amount_cents;
    } else if (c.kind === "adjustments") {
      s.adjustments_cents += c.amount_cents;
      for (const item of c.items ?? []) {
        if (item.kind === "bonus") s.bonus_cents += item.amount_cents;
        else s.other_cents += item.amount_cents;
      }
    } else if (c.kind === "implant_piece") {
      s.implant_qty += c.qty ?? 0;
      s.implant_amount_cents += c.amount_cents;
    } else if (c.kind === "procedure_piece") {
      s.procedure_qty += c.qty ?? 0;
      s.procedure_amount_cents += c.amount_cents;
    } else if (c.kind === "clinic_ciro_share") {
      s.management_base_cents += c.base_cents ?? 0;
      s.management_cents += c.amount_cents;
    } else {
      for (const method of HK_LINE_METHODS) {
        const b = c.by_method?.[method];
        if (!b) continue;
        s.gross_by_method[method] += b.gross;
        s.gross_cents += b.gross;
        s.implant_cents += b.implant;
        s.lab_cents += b.lab;
        s.deduction_cents += b.deduction;
      }
      s.lab_cents += c.lab_cents ?? 0;
      s.ciro_lab_cents += c.lab_cents ?? 0;
      s.lab_excess_cents += c.lab_excess_cents ?? 0;
      s.base_cents += c.base_cents ?? 0;
      s.share_cents += c.amount_cents;
      if (typeof c.share_bp === "number" && !s.share_bps.includes(c.share_bp)) s.share_bps.push(c.share_bp);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Lab summary helpers (0032)
// ---------------------------------------------------------------------------

/**
 * Splits `amount` over parts in proportion to `weights`, in the given order: part i = round(amount × W_i / W) −
 * round(amount × W_(i−1) / W) with W_i the running sum of the weights and W their total (round half away from zero,
 * exact), so the parts always add up to `amount`; a part equal to its weight whenever amount = W. Every part is 0 when
 * the amount or the total weight is 0. Used for the deducted_cents of the lab summary (parts in COLLATE "C" lab name
 * order, compareCodePoints, as fin__hk_lab_alloc).
 */
export function allocateByWeight(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (amount === 0 || total === 0) return weights.map(() => 0);
  const sign = total < 0 ? -1n : 1n;
  const den = BigInt(total) * sign;
  let running = 0n;
  let previous = 0n;
  return weights.map((w) => {
    running += BigInt(w);
    const upTo = roundHalfAwayDiv(BigInt(amount) * running * sign, den);
    const part = upTo - previous;
    previous = upTo;
    return Number(part);
  });
}

/**
 * Code point order of two strings: PostgreSQL's COLLATE "C" on UTF-8 text (byte order = code point order). Plain
 * `<` compares UTF-16 code units, which differs for characters beyond the Basic Multilingual Plane.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(i)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

function sumPerLab(rows: readonly { lab_name: string; amount_cents: number }[]) {
  const byLab = new Map<string, { lab_name: string; cost_cents: number; count: number }>();
  for (const r of rows) {
    const g = byLab.get(r.lab_name) ?? { lab_name: r.lab_name, cost_cents: 0, count: 0 };
    g.cost_cents += r.amount_cents;
    g.count += 1;
    byLab.set(r.lab_name, g);
  }
  return Array.from(byLab.values());
}

/** Lab cost rows (fin_hk_month lab_costs, hk_my_month lab_costs) summed per lab, by lab name (display order). */
export function groupLabCosts(
  rows: readonly { lab_name: string; amount_cents: number }[]
): { lab_name: string; cost_cents: number; count: number }[] {
  return sumPerLab(rows).sort((a, b) => byName(a.lab_name, b.lab_name) || byText(a.lab_name, b.lab_name));
}

/**
 * Lab cost rows summed per lab in the order fin__hk_lab_alloc shares a deduction over them: lab name COLLATE "C"
 * (compareCodePoints). The order decides which lab gets a rounding cent.
 */
function labWeightsForShare(rows: readonly { lab_name: string; amount_cents: number }[]) {
  return sumPerLab(rows).sort((a, b) => compareCodePoints(a.lab_name, b.lab_name));
}

/** A doctor's rows of the lab summary with their sums ("Lab özeti" table). */
export interface HkLabDoctorGroup {
  doctor_id: string;
  doctor_name: string;
  rows: HkLabSummaryRowJson[];
  cost_cents: number;
  deducted_cents: number;
  count: number;
}

/** lab_summary rows grouped per doctor, in the order of the rows (the payload's: doctor name, doctor id, lab name). */
export function labSummaryByDoctor(rows: readonly HkLabSummaryRowJson[]): HkLabDoctorGroup[] {
  const groups = new Map<string, HkLabDoctorGroup>();
  for (const r of rows) {
    let g = groups.get(r.doctor_id);
    if (!g) {
      g = { doctor_id: r.doctor_id, doctor_name: r.doctor_name, rows: [], cost_cents: 0, deducted_cents: 0, count: 0 };
      groups.set(r.doctor_id, g);
    }
    g.rows.push(r);
    g.cost_cents += r.cost_cents;
    g.deducted_cents += r.deducted_cents;
    g.count += r.count;
  }
  return Array.from(groups.values());
}

/** The lab warnings of 0032 (neither blocks the month close). */
export function isLabWarning(
  w: HkWarningJson
): w is Extract<HkWarningJson, { code: "LAB_OVER_CIRO" } | { code: "UNRULED_LAB" }> {
  return w.code === "LAB_OVER_CIRO" || w.code === "UNRULED_LAB";
}

/**
 * How lab costs reach the hakediş (0032), for the rules page, the lab cost list and the "Lab özeti" tab.
 */
export const LAB_DEDUCTION_TEXT =
  "Ciro payı kuralı olan hekimde ayın lab giderleri, ödeme şekli kesintilerinden sonra hastanın girdiği kuralın " +
  "cirosundan düşülür (hasta grubu tahsilattaki gibi belirlenir; grubun kuralı yoksa standart kural). Lab gideri " +
  "ciroyu aşarsa matrah 0 olur, aşan kısım klinikte kalır ve sonraki aya devretmez. “Ortodonti (önce lab)” kuralında " +
  "lab gideri hastanın ödemelerinden önce karşılanır. Kuralı olmayan hekimin lab gideri hakedişten düşülmez.";

/** The doctor × lab rows summed per lab, by lab name (lab_totals). */
export function labTotalsOf(rows: readonly HkLabSummaryRowJson[]): HkLabTotalJson[] {
  const byLab = new Map<string, HkLabTotalJson>();
  for (const r of rows) {
    const t = byLab.get(r.lab_name) ?? { lab_name: r.lab_name, cost_cents: 0, deducted_cents: 0, count: 0 };
    t.cost_cents += r.cost_cents;
    t.deducted_cents += r.deducted_cents;
    t.count += r.count;
    byLab.set(r.lab_name, t);
  }
  return Array.from(byLab.values()).sort((a, b) => byName(a.lab_name, b.lab_name) || byText(a.lab_name, b.lab_name));
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
> & {
  payee_name?: string | null;
  doctor_name?: string | null;
  /** 0033 (ciro_share): deduction of the 'unpaid' lines; absent = 0 */
  deduct_unpaid_bp?: number | null;
  /** 0033 (procedure_piece): the rule's procedure group */
  proc_group_id?: string | null;
};

export interface HkComputeLine {
  id: string;
  day: string;
  /** 0033: null = a line of a Macro doctor mapped to the clinic / an outside doctor (clinic ciro only) */
  doctor_id: string | null;
  patient_ref: string;
  patient_name?: string;
  method: HkLineMethod;
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
  /** 0033: null = an imported piece without a doctor (unassigned, or assigned_none) */
  doctor_id: string | null;
  qty: number;
  voided_at?: string | null;
  /**
   * 0033: the procedure group; absent / null = an implant piece (manual / clinical pieces; the import stores only
   * pieces of grouped operations)
   */
  proc_group_id?: string | null;
  source?: HkSource;
  /** 0033: marked "Hakediş yok" by the preparer (never UNASSIGNED_PIECES) */
  assigned_none?: boolean;
}

/** A procedure group as the engine needs it (0033). */
export interface HkComputeProcGroup {
  id: string;
  name: string;
  is_implant: boolean;
}

export interface HkComputeLabCost {
  id: string;
  day: string;
  doctor_id: string;
  /** used when `doctors` does not name the doctor (lab summary, lab warnings) */
  doctor_name?: string | null;
  patient_ref: string;
  patient_name?: string;
  /** lab summary key (fin_hk_lab_costs.lab_name); "" when left out */
  lab_name?: string;
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
  /** 0033: the clinic's procedure groups (pieces and procedure_piece rules refer to them) */
  proc_groups?: readonly HkComputeProcGroup[];
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

/** Per-cost resolution of the month's live lab costs (0032, fin_hk_month lab_costs: resolved_segment, rule_id). */
export interface HkLabCostResult {
  id: string;
  segment: HkSegment;
  /** the doctor's ortho_lab_first rule, else the segment's / standard ciro_share rule; null = UNRULED_LAB */
  rule_id: string | null;
}

export interface HkComputeOutput extends HkComputeResult {
  line_results: HkLineResult[];
  /** the month's live lab costs, in input order */
  lab_results: HkLabCostResult[];
  lab_summary: HkLabSummaryRowJson[];
  lab_totals: HkLabTotalJson[];
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
  line: Pick<HkComputeLine, "segment" | "day"> & { doctor_id: string | null },
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

const emptyBucket = (rule: HkComputeRule, method: HkLineMethod): HkMethodBucketJson => ({
  gross: 0,
  implant: 0,
  lab: 0,
  eligible: 0,
  deduct_bp: rule[DEDUCT_FIELD[method]] ?? 0,
  deduction: 0,
});

/** The four payment method buckets, plus 'unpaid' (0033) when the rule has a deduct_unpaid_bp. */
function emptyByMethod(rule: HkComputeRule): HkByMethodJson {
  const out = {} as HkByMethodJson;
  for (const method of HK_METHODS) out[method] = emptyBucket(rule, method);
  if ((rule.deduct_unpaid_bp ?? 0) !== 0) out.unpaid = emptyBucket(rule, "unpaid");
  return out;
}

/**
 * Active rules of one month as the SQL resolves a line or a lab cost to a rule (fin__hk_eval_lines /
 * fin__hk_eval_lab_costs): the doctor's ortho_lab_first rule, else the ciro_share rule of (doctor, segment), else the
 * doctor's standard one. The newest from_month wins if invalid data ever has two for the same key.
 */
function ruleIndexOf(rules: readonly HkComputeRule[], month: string) {
  const active = rules
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
  const ruleFor = (doctorId: string, segment: HkSegment): HkComputeRule | undefined =>
    orthoByDoctor.get(doctorId) ?? ciroByKey.get(`${doctorId}|${segment}`) ?? ciroByKey.get(`${doctorId}|standard`);
  return { active, orthoByDoctor, ruleFor };
}

/**
 * Lab-first walk of one ortho doctor up to the end of month M: lab part per line id, per-patient totals, and (0032)
 * the lab part recovered from M's payments per lab name: each patient's recovery of the month split over the
 * patient's labs by their lab costs to date (allocateByWeight in COLLATE "C" lab name order). `labCosts` comes without
 * the costs deducted from a ciro_share rule in their own month (0032, v1.4: fin__hk_ciro_lab_ids), so neither the lab
 * parts, the patients list nor the per-lab split count them again.
 */
function orthoWalk(
  doctorId: string,
  month: string,
  lines: readonly HkComputeLine[],
  labCosts: readonly HkComputeLabCost[]
): { labPart: Map<string, number>; patients: HkLabPatientJson[]; labInMonth: Map<string, number> } {
  const labPart = new Map<string, number>();
  const labInMonth = new Map<string, number>();
  const costsByPatient = new Map<string, HkComputeLabCost[]>();
  for (const c of labCosts) {
    if (c.doctor_id !== doctorId || !isLive(c) || monthKey(c.day) > month) continue;
    const list = costsByPatient.get(c.patient_ref) ?? [];
    list.push(c);
    costsByPatient.set(c.patient_ref, list);
  }
  const linesByPatient = new Map<string, HkComputeLine[]>();
  for (const l of lines) {
    if (!l.doctor_id || l.doctor_id !== doctorId) continue;
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
    if (inMonth !== 0) {
      const labs = labWeightsForShare(costs.map((c) => ({ lab_name: c.lab_name ?? "", amount_cents: c.amount_cents })));
      const parts = allocateByWeight(inMonth, labs.map((g) => g.cost_cents));
      labs.forEach((g, i) => labInMonth.set(g.lab_name, (labInMonth.get(g.lab_name) ?? 0) + parts[i]));
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
  return { labPart, patients, labInMonth };
}

/**
 * Pure TypeScript mirror of fin_hk__compute(clinic, month). Rounding is half away from zero on exact integers
 * (BigInt), applied once per method bucket (deduction) and once per component (share), exactly like the SQL.
 * Payroll (0031): a fixed_monthly rule pays its piece_cents as is; the payee's live adjustments of the month form one
 * 'adjustments' component after the rule components. A payee may have payroll components only (staff, or a payee with
 * a bonus and no rule).
 * Bank split (0032): a bank_portion rule is not a component and changes no total; every payee gets bank_cents (the
 * active bank_portion amount, else null) and cash_cents (total − bank, else null). A payee with only a bank_portion
 * rule is listed with total 0 and a negative cash part; BANK_OVER_TOTAL follows the other warnings (by payee name, then
 * payee id) when bank > total.
 * Lab costs (0032, v1.4): each live lab cost dated in the month resolves like a revenue line of its patient on its day
 * (no manual segment): the doctor's ortho_lab_first rule (lab-first walk, unchanged; nothing more is deducted), else
 * the segment's ciro_share rule, else the doctor's standard one, else none (UNRULED_LAB per doctor when the sum is not
 * 0). The ortho walk (lab parts, lab_patients, the per-lab split) leaves out every cost that resolved to a ciro_share
 * rule in its own month, with that month's rules: it was deducted there (a doctor moving from ciro_share to
 * ortho_lab_first); a cost unruled in its own month is still recovered. A ciro_share rule with costs L and ciro after deductions C deducts lab_cents = min(L, max(C, 0)):
 * base = C − lab_cents, lab_excess_cents = L − lab_cents (LAB_OVER_CIRO when > 0, the excess stays with the clinic).
 * Minimum (0032): the payee's active minimum_monthly floor F (the highest, should rows ever overlap): when the sum S of
 * the other components is below F, a 'minimum_topup' component of F − S comes last and the total is F; a payee with
 * only that rule is listed with the top-up. The bank split and every warning use the final total.
 * Warning order (SQL: kind, then name, payee id, doctor id, segment): UNRULED_LINES, UNRULED_PIECES (by doctor name,
 * doctor id), NO_COUNTERPARTY, BANK_OVER_TOTAL (by payee name, payee id), UNRULED_LAB (by doctor name, doctor id),
 * LAB_OVER_CIRO (by doctor name, doctor id, segment).
 * Lab summary (fin_hk_month lab_summary / lab_totals, built by fin__hk_lab_alloc next to the compute): shares are
 * rounded cumulatively in byte order of the lab names (COLLATE "C"), rows listed by doctor name / id, then lab name.
 * Macro import (0033): an 'unpaid' line goes to the 'unpaid' bucket, deducted at the rule's deduct_unpaid_bp (the
 * bucket exists when the rule has that rate or such lines, so other components keep their 0032 keys). A line without a
 * doctor (Macro doctor mapped to the clinic / an outside doctor) has no rule and no warning; like every live line it is
 * in clinic_total_cents (the clinic_ciro_share base). A procedure_piece rule pays piece_cents × Σ qty of the month's
 * live pieces of its doctor and group (component with qty, lines_count, proc_group_id / proc_group_name, base null),
 * ranked with implant_piece and after the doctor's implant_piece component, by group name. An implant_piece rule counts
 * its doctor's implant-type pieces: of an implant group, or without a group (manual / clinical; the import stores only
 * grouped pieces). UNRULED_PIECES covers only implant-type pieces when neither rule takes them; pieces of other groups
 * without a rule are ordinary treatments. UNASSIGNED_PIECES (last) sums the month's live pieces of a group that have no
 * doctor and are not marked "Hakediş yok", per group (by group name, then id).
 */
export function computeMonth(input: HkComputeInput): HkComputeOutput {
  const month = monthKey(input.month);
  const doctorNames = new Map((input.doctors ?? []).map((d) => [d.id, d.name]));
  const payeeNames = new Map((input.payees ?? []).map((p) => [p.user_id, p.name]));
  const marks = new Map((input.marks ?? []).map((m) => [m.patient_ref, m]));
  const childAgeLimit = childAgeLimitOf(input.settings);
  const doctorName = (id: string | null, fallback?: string | null) =>
    id ? doctorNames.get(id) ?? fallback ?? "" : fallback ?? null;
  const groups = new Map((input.proc_groups ?? []).map((g) => [g.id, g]));
  // 0033: an implant-type piece = a piece without a group (manual / clinical) or of an implant group (SQL:
  // coalesce(g.is_implant, true)).
  const isImplantPiece = (p: HkComputePiece) => (p.proc_group_id ? groups.get(p.proc_group_id)?.is_implant ?? true : true);
  // 0033: a doctor's procedure_piece components follow the implant_piece one by group name (SQL pgrp: every group of
  // the clinic by name, then id; 1-based, 0 when unknown).
  const groupRank = new Map(
    (input.proc_groups ?? [])
      .slice()
      .sort((a, b) => byName(a.name, b.name) || byText(a.id, b.id))
      .map((g, i) => [g.id, i + 1])
  );

  // Active rules; the newest from_month wins if invalid data ever has two for the same key.
  const index = ruleIndexOf(input.rules, month);
  const { active, orthoByDoctor, ruleFor } = index;
  // Rules that become components: every kind but bank_portion and minimum_monthly.
  const componentRules = active.filter(
    (r): r is HkComputeRule & { kind: HkRuleComponentKind } =>
      r.kind !== "bank_portion" && r.kind !== "minimum_monthly"
  );

  // A lab cost resolves like a revenue line of its patient on its day (no manual segment), with the rules of its own
  // month (0032, v1.4: fin__hk_eval_lab_costs).
  const indexes = new Map<string, ReturnType<typeof ruleIndexOf>>([[month, index]]);
  const labRule = (c: HkComputeLabCost) => {
    const costMonth = monthKey(c.day);
    let costIndex = indexes.get(costMonth);
    if (!costIndex) {
      costIndex = ruleIndexOf(input.rules, costMonth);
      indexes.set(costMonth, costIndex);
    }
    const segment = resolveSegment(
      { segment: null, doctor_id: c.doctor_id, day: c.day },
      markFor(marks, c),
      childAgeLimit
    );
    return { segment, rule: costIndex.ruleFor(c.doctor_id, segment) };
  };

  // Live lines up to the end of the month (earlier months feed the ortho walk only).
  const toDate = input.lines.filter((l) => isLive(l) && monthKey(l.day) <= month);
  const monthLines = toDate.filter((l) => monthKey(l.day) === month);
  const livePieces = (input.pieces ?? []).filter((p) => isLive(p) && monthKey(p.day) === month);

  // The ortho walk leaves out the costs that resolved to a ciro_share rule in their own month (deducted there; a doctor
  // moving from ciro_share to ortho_lab_first does not recover them again). Costs unruled in their month still count.
  const ciroLabIds = new Set(
    (input.lab_costs ?? [])
      .filter((c) => isLive(c) && monthKey(c.day) <= month && labRule(c).rule?.kind === "ciro_share")
      .map((c) => c.id)
  );
  const walkCosts = (input.lab_costs ?? []).filter((c) => !ciroLabIds.has(c.id));
  const walks = new Map<string, ReturnType<typeof orthoWalk>>();
  orthoByDoctor.forEach((rule, doctorId) => {
    walks.set(rule.id, orthoWalk(doctorId, month, toDate, walkCosts));
  });

  // Components, one per active rule.
  const components = new Map<string, HkRuleComponentJson>();
  const ruleOf = new Map<string, HkComputeRule>();
  for (const r of componentRules) {
    ruleOf.set(r.id, r);
    const piece = r.kind === "implant_piece" || r.kind === "procedure_piece";
    components.set(r.id, {
      rule_id: r.id,
      kind: r.kind,
      doctor_id: r.doctor_id,
      doctor_name: doctorName(r.doctor_id, r.doctor_name),
      segment: r.kind === "ciro_share" ? r.segment : null,
      share_bp: piece || r.kind === "fixed_monthly" ? null : r.share_bp,
      piece_cents: piece || r.kind === "fixed_monthly" ? r.piece_cents : null,
      by_method: r.kind === "ciro_share" || r.kind === "ortho_lab_first" ? emptyByMethod(r) : null,
      base_cents: r.kind === "fixed_monthly" || r.kind === "procedure_piece" ? null : 0,
      amount_cents: 0,
      qty: piece ? 0 : null,
      lines_count: 0,
      ...(r.kind === "ortho_lab_first" ? { lab_patients: walks.get(r.id)?.patients ?? [] } : {}),
      ...(r.kind === "procedure_piece"
        ? {
            proc_group_id: r.proc_group_id ?? null,
            proc_group_name: (r.proc_group_id && groups.get(r.proc_group_id)?.name) || null,
          }
        : {}),
    });
  }

  // Revenue lines → rule (ortho first, then the segment's ciro rule, then the standard one).
  const lineResults: HkLineResult[] = [];
  const unruled = new Map<string, { count: number; try_cents: number }>();
  for (const l of monthLines) {
    const segment = resolveSegment(l, markFor(marks, l), childAgeLimit);
    if (!l.doctor_id) {
      // 0033: clinic / outside doctor revenue: in the clinic ciro only, never unruled.
      lineResults.push({ id: l.id, segment, rule_id: null, lab_part: 0 });
      continue;
    }
    const rule = ruleFor(l.doctor_id, segment);
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
    const byMethod = c.by_method!;
    const b = (byMethod[l.method] ??= emptyBucket(rule, l.method));
    b.gross += l.try_cents;
    b.implant += l.implant_cents;
    b.lab += lab;
    b.eligible += l.try_cents - l.implant_cents - lab;
    c.lines_count += 1;
    lineResults.push({ id: l.id, segment, rule_id: rule.id, lab_part: lab });
  }

  // The month's live lab costs → rule, like a revenue line of the patient on the cost's day (0032). Costs of an ortho
  // doctor stay with the lab-first walk; costs of a ciro_share rule are deducted from its ciro below.
  const monthLabs = (input.lab_costs ?? []).filter((c) => isLive(c) && monthKey(c.day) === month);
  const labResults: HkLabCostResult[] = [];
  const labsOfRule = new Map<string, HkComputeLabCost[]>();
  const unruledLab = new Map<string, number>();
  for (const c of monthLabs) {
    const { segment, rule } = labRule(c);
    labResults.push({ id: c.id, segment, rule_id: rule?.id ?? null });
    if (!rule) {
      unruledLab.set(c.doctor_id, (unruledLab.get(c.doctor_id) ?? 0) + c.amount_cents);
    } else if (rule.kind === "ciro_share") {
      const list = labsOfRule.get(rule.id) ?? [];
      list.push(c);
      labsOfRule.set(rule.id, list);
    }
  }

  const clinicTotal = monthLines.reduce((sum, l) => sum + l.try_cents, 0);
  // Pieces counted by an implant_piece / procedure_piece component (0033: UNRULED_PIECES = implant pieces outside it).
  const pieceRuled = new Set<string>();
  const labOverCiro: Extract<HkWarningJson, { code: "LAB_OVER_CIRO" }>[] = [];

  components.forEach((c, ruleId) => {
    const rule = ruleOf.get(ruleId)!;
    if (c.by_method) {
      let base = 0;
      for (const method of HK_LINE_METHODS) {
        const b = c.by_method[method];
        if (!b) continue;
        b.deduction = applyBp(b.eligible, b.deduct_bp);
        base += b.eligible - b.deduction;
      }
      const labs = labsOfRule.get(ruleId);
      if (labs) {
        // Lab costs after the method deductions; never below a 0 base, the excess stays with the clinic.
        const labTotal = labs.reduce((sum, x) => sum + x.amount_cents, 0);
        const deducted = Math.min(labTotal, Math.max(base, 0));
        c.lab_cents = deducted;
        c.lab_excess_cents = labTotal - deducted;
        if (labTotal > deducted) {
          labOverCiro.push({
            code: "LAB_OVER_CIRO",
            doctor_id: rule.doctor_id ?? "",
            doctor_name: c.doctor_name ?? "",
            rule_id: rule.id,
            segment: c.segment,
            lab_cents: labTotal,
            ciro_after_deductions_cents: base,
            excess_cents: labTotal - deducted,
          });
        }
        base -= deducted;
      }
      c.base_cents = base;
      c.amount_cents = applyBp(base, rule.share_bp ?? 0);
    } else if (rule.kind === "implant_piece" || rule.kind === "procedure_piece") {
      const mine = livePieces.filter((p) =>
        !!p.doctor_id &&
        p.doctor_id === rule.doctor_id &&
        (rule.kind === "implant_piece" ? isImplantPiece(p) : !!p.proc_group_id && p.proc_group_id === rule.proc_group_id)
      );
      for (const p of mine) pieceRuled.add(p.id);
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
  // order, then the 'adjustments' component, then the 'minimum_topup' one. procedure_piece (0033) ranks with
  // implant_piece and sorts after it by group name (SQL kind_ord 3, seg_ord = the group's rank).
  const kindOrder = (k: HkComponentKind) =>
    k === "adjustments"
      ? HK_KINDS.length
      : k === "minimum_topup"
        ? HK_KINDS.length + 1
        : HK_KINDS.indexOf(k === "procedure_piece" ? "implant_piece" : k);
  const segmentOrder = (s: HkSegment | null | undefined) => (s ? HK_SEGMENTS.indexOf(s) : -1);
  const componentOrder = (c: HkComponentJson) =>
    c.kind === "procedure_piece" ? (c.proc_group_id ? groupRank.get(c.proc_group_id) ?? 0 : 0) : segmentOrder(c.segment);
  const payeeMap = new Map<string, HkPayeeJson>();
  const payeeOf = (userId: string, fallbackName: string | null | undefined): HkPayeeJson => {
    let p = payeeMap.get(userId);
    if (!p) {
      p = { payee_user_id: userId, payee_name: payeeNames.get(userId) ?? fallbackName ?? "", total_cents: 0, components: [] };
      payeeMap.set(userId, p);
    }
    return p;
  };
  for (const r of componentRules) {
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

  // Minimum (0032): one active minimum_monthly rule per payee (fin_hk_save_rule's overlap check); should rows ever
  // overlap, the highest floor, then the lowest id (SQL: DISTINCT ON payee ORDER BY piece_cents DESC, id). Topped up
  // after every other component.
  const minimumOf = new Map<string, HkComputeRule>();
  for (const r of active) {
    if (r.kind !== "minimum_monthly") continue;
    const seen = minimumOf.get(r.payee_user_id);
    const floor = r.piece_cents ?? 0;
    const seenFloor = seen?.piece_cents ?? 0;
    if (!seen || floor > seenFloor || (floor === seenFloor && byText(r.id, seen.id) < 0)) {
      minimumOf.set(r.payee_user_id, r);
    }
  }
  minimumOf.forEach((r, userId) => {
    const p = payeeOf(userId, r.payee_name);
    const floor = r.piece_cents ?? 0;
    if (p.total_cents >= floor) return;
    p.components.push({ kind: "minimum_topup", rule_id: r.id, amount_cents: floor - p.total_cents });
    p.total_cents = floor;
  });

  // Bank part (0032): one active bank_portion rule per payee (fin_hk_save_rule's overlap check); summed like the SQL
  // should rows ever overlap. A payee with only a bank_portion rule is listed with total 0 and no components.
  const bankOf = new Map<string, number>();
  for (const r of active) {
    if (r.kind !== "bank_portion") continue;
    bankOf.set(r.payee_user_id, (bankOf.get(r.payee_user_id) ?? 0) + (r.piece_cents ?? 0));
    payeeOf(r.payee_user_id, r.payee_name);
  }

  const payees = Array.from(payeeMap.values());
  for (const p of payees) {
    const bank = bankOf.get(p.payee_user_id);
    p.bank_cents = bank ?? null;
    p.cash_cents = bank === undefined ? null : p.total_cents - bank;
    p.components.sort(
      (a, b) =>
        kindOrder(a.kind) - kindOrder(b.kind) ||
        byName(a.doctor_name ?? "", b.doctor_name ?? "") ||
        componentOrder(a) - componentOrder(b) ||
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
    if (!p.doctor_id || pieceRuled.has(p.id) || !isImplantPiece(p)) continue;
    unruledPieces.set(p.doctor_id, (unruledPieces.get(p.doctor_id) ?? 0) + p.qty);
  }
  const pieceWarnings: HkWarningJson[] = [];
  unruledPieces.forEach((qty, doctorId) => {
    if (qty === 0) return; // SQL: pc.qty <> 0 (+1 and -1 cancel out)
    pieceWarnings.push({ code: "UNRULED_PIECES", doctor_id: doctorId, doctor_name: doctorNames.get(doctorId), qty });
  });
  // SQL: ORDER BY kind, name (tr), payee id, doctor id, segment.
  const warningName = (w: HkWarningJson) => ("doctor_name" in w ? w.doctor_name ?? "" : "");
  const warningDoctor = (w: HkWarningJson) => ("doctor_id" in w ? w.doctor_id : "");
  const byDoctorWarning = (a: HkWarningJson, b: HkWarningJson) =>
    byName(warningName(a), warningName(b)) || byText(warningDoctor(a), warningDoctor(b));
  warnings.push(...unruledLines.sort(byDoctorWarning));
  warnings.push(...pieceWarnings.sort(byDoctorWarning));
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
  for (const p of payees) {
    if (typeof p.bank_cents === "number" && p.bank_cents > p.total_cents) {
      warnings.push({
        code: "BANK_OVER_TOTAL",
        payee_user_id: p.payee_user_id,
        payee_name: p.payee_name,
        bank_cents: p.bank_cents,
        total_cents: p.total_cents,
      });
    }
  }
  const labDoctorName = (doctorId: string) =>
    doctorNames.get(doctorId) ?? monthLabs.find((c) => c.doctor_id === doctorId && c.doctor_name)?.doctor_name ?? "";
  const unruledLabWarnings: Extract<HkWarningJson, { code: "UNRULED_LAB" }>[] = [];
  unruledLab.forEach((cents, doctorId) => {
    if (cents === 0) return; // costs that net to zero lose nothing
    unruledLabWarnings.push({
      code: "UNRULED_LAB",
      doctor_id: doctorId,
      doctor_name: labDoctorName(doctorId),
      lab_cents: cents,
    });
  });
  warnings.push(...unruledLabWarnings.sort(byDoctorWarning));
  warnings.push(
    ...labOverCiro.sort(
      (a, b) =>
        byDoctorWarning(a, b) || segmentOrder(a.segment) - segmentOrder(b.segment) || byText(a.rule_id, b.rule_id)
    )
  );
  // 0033: imported pieces of a group still waiting for the performing doctor (one warning; a group whose pieces net to
  // zero stays listed, as in the SQL).
  const unassigned = new Map<string, HkUnassignedGroupJson>();
  for (const p of livePieces) {
    if (p.doctor_id || p.assigned_none || !p.proc_group_id) continue;
    const g = unassigned.get(p.proc_group_id) ?? {
      proc_group_id: p.proc_group_id,
      name: groups.get(p.proc_group_id)?.name ?? "",
      count: 0,
    };
    g.count += p.qty;
    unassigned.set(p.proc_group_id, g);
  }
  const unassignedGroups = Array.from(unassigned.values()).sort(
    (a, b) => byName(a.name, b.name) || byText(a.proc_group_id, b.proc_group_id)
  );
  if (unassignedGroups.length) {
    warnings.push({
      code: "UNASSIGNED_PIECES",
      count: unassignedGroups.reduce((sum, g) => sum + g.count, 0),
      groups: unassignedGroups,
    });
  }

  // Doctor × lab summary (0032): the month's live costs of every doctor, and what was deducted from each doctor's
  // figures this month per lab (ciro_share: each rule's lab_cents split over its labs; ortho: the walk's recovery).
  const summary = new Map<string, HkLabSummaryRowJson>();
  const summaryRow = (doctorId: string, labName: string): HkLabSummaryRowJson => {
    const key = `${doctorId}|${labName}`;
    let row = summary.get(key);
    if (!row) {
      row = {
        doctor_id: doctorId,
        doctor_name: labDoctorName(doctorId),
        lab_name: labName,
        cost_cents: 0,
        deducted_cents: 0,
        count: 0,
      };
      summary.set(key, row);
    }
    return row;
  };
  for (const c of monthLabs) {
    const row = summaryRow(c.doctor_id, c.lab_name ?? "");
    row.cost_cents += c.amount_cents;
    row.count += 1;
  }
  labsOfRule.forEach((labs, ruleId) => {
    const groups = labWeightsForShare(labs.map((x) => ({ lab_name: x.lab_name ?? "", amount_cents: x.amount_cents })));
    const parts = allocateByWeight(components.get(ruleId)?.lab_cents ?? 0, groups.map((g) => g.cost_cents));
    const doctorId = ruleOf.get(ruleId)?.doctor_id ?? "";
    groups.forEach((g, i) => {
      summaryRow(doctorId, g.lab_name).deducted_cents += parts[i];
    });
  });
  orthoByDoctor.forEach((rule, doctorId) => {
    walks.get(rule.id)?.labInMonth.forEach((cents, labName) => {
      if (cents === 0 && !summary.has(`${doctorId}|${labName}`)) return;
      const row = summaryRow(doctorId, labName);
      row.deducted_cents += cents;
      if (!row.doctor_name) row.doctor_name = doctorName(doctorId, rule.doctor_name) ?? "";
    });
  });
  const labSummary = Array.from(summary.values()).sort(
    (a, b) =>
      byName(a.doctor_name, b.doctor_name) ||
      byText(a.doctor_id, b.doctor_id) ||
      byName(a.lab_name, b.lab_name) ||
      byText(a.lab_name, b.lab_name)
  );

  return {
    month,
    payees,
    clinic_total_cents: clinicTotal,
    warnings,
    line_results: lineResults,
    lab_results: labResults,
    lab_summary: labSummary,
    lab_totals: labTotalsOf(labSummary),
  };
}
