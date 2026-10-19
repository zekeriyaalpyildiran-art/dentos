// Hakediş v2 (0033): the Macro Dental (Boğaziçisoft) reports → fin_hk_import_macro. Two legacy .XLS reports, one sheet
// each, the first row a header, dates as Excel serial numbers:
//  - treatments ("işlem bazlı"): TARİH | DOKTOR | OPERASYON | DİŞ | D. NO | HASTA | … | TUTARI | … | PARA, one row per
//    performed procedure (tooth or jaw); TUTARI is the price (often 0: included / free);
//  - payments ("tedavi ödeme bazlı"): ÖDEME | TARİH | DOKTOR | HASTA | OPERASYON | DİŞ | … | ÖDENEN | Ö. ORANI | İŞLEM |
//    … | PARA | KORUMA, one row per (payment × treatment) allocation: ÖDEME = payment day, TARİH = treatment day, ÖDENEN =
//    the part of that payment applied to that treatment, İŞLEM = Nakit / POS / Banka. No patient number.
// Both reports may hold every doctor of the clinic (DOKTOR = the Macro doctor name, mapped once in fin_hk_ext_doctors).
//
// The parser is tolerant (header names matched without case, spaces, dots or Turkish letters; the header row may follow
// a few title rows) and strict on values (a row whose day, amount, currency or method cannot be read is reported, never
// guessed). buildMacroImport is pure: the owner's rules (hakediş spec v2 macro, decisions 1–3) turn the two reports
// into the lines and pieces of a day range. Nothing here knows a doctor, a rate or an exchange rate: the server maps
// the Macro doctors, assigns the procedure groups (and the implant parts) and converts foreign currencies.

import { FileReadError, fileTooLarge, loadXlsx, MAX_FILE_BYTES, SHEET_ROWS_PARSED } from "./finance-import/read-file";
import {
  normalizePatientRef,
  ruleActiveIn,
  type HkCurrency,
  type HkExtDoctorJson,
  type HkImportLineArg,
  type HkImportMethod,
  type HkImportPieceArg,
  type HkMonthStatus,
  type HkRuleJson,
} from "./hakedis";

// ---------------------------------------------------------------------------
// Report rows
// ---------------------------------------------------------------------------

export type MacroReportKind = "treatments" | "payments";
/** Macro İŞLEM: Nakit → cash, POS → card, Banka → transfer. */
export type MacroPayMethod = Exclude<HkImportMethod, "unpaid">;

export const MACRO_REPORT_LABELS: Record<MacroReportKind, string> = {
  treatments: "İşlem raporu (işlem bazlı)",
  payments: "Ödeme raporu (tedavi ödeme bazlı)",
};

/** One treatments-report row (a performed procedure). */
export interface MacroTreatmentRow {
  /** 1-based row number in the sheet */
  row: number;
  /** TARİH, 'YYYY-MM-DD' */
  day: string;
  /** DOKTOR as in the report (trimmed, spaces collapsed) */
  ext_doctor: string;
  /** OPERASYON */
  procedure: string;
  /** DİŞ: "36", "31,32,33" or null (jaw / none) */
  tooth: string | null;
  /** D. NO: the patient file number, null when empty */
  patient_no: string | null;
  /** HASTA */
  patient_name: string;
  /** PARA */
  currency: HkCurrency;
  /** TUTARI in cents of `currency` (round half away from zero) */
  amount_cents: number;
}

/** One payments-report row (the part of one payment applied to one treatment). */
export interface MacroPaymentRow {
  row: number;
  /** ÖDEME: the payment day */
  pay_day: string;
  /** TARİH: the day of the treatment paid */
  treatment_day: string;
  ext_doctor: string;
  patient_name: string;
  procedure: string;
  tooth: string | null;
  /** İŞLEM */
  method: MacroPayMethod;
  currency: HkCurrency;
  /** ÖDENEN in cents of `currency` (round half away from zero) */
  amount_cents: number;
}

/** A row that could not be read (the import should not go on until the file is fixed or re-exported). */
export interface MacroParseIssue {
  row: number;
  reason: string;
}

export type MacroParseResult =
  | { kind: "treatments"; file: string; rows: MacroTreatmentRow[]; issues: MacroParseIssue[] }
  | { kind: "payments"; file: string; rows: MacroPaymentRow[]; issues: MacroParseIssue[] };

/** The file is not a Macro report, or cannot be read at all (Turkish message). */
export class MacroParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroParseError";
  }
}

/** Invalid buildMacroImport arguments (Turkish message). */
export class MacroImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroImportError";
  }
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

/** Header text as a key: Turkish lower case, accents dropped, only letters and digits ("Ö. ORANI" → "oorani"). */
export function macroHeaderKey(value: unknown): string {
  return normalizePatientRef(typeof value === "string" ? value : value == null ? "" : String(value))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]/g, "");
}

type Column =
  | "tarih"
  | "odeme"
  | "doktor"
  | "operasyon"
  | "dis"
  | "dno"
  | "hasta"
  | "tutari"
  | "odenen"
  | "islem"
  | "para";

/** Accepted header keys per column (the Macro name first). */
const ALIASES: Record<Column, readonly string[]> = {
  tarih: ["tarih", "tedavitarihi", "islemtarihi"],
  odeme: ["odeme", "odemetarihi"],
  doktor: ["doktor", "hekim", "doktoradi", "hekimadi"],
  operasyon: ["operasyon", "islemadi", "tedaviadi"],
  dis: ["dis", "disno", "disler"],
  dno: ["dno", "dosyano", "hastano"],
  hasta: ["hasta", "hastaadi", "hastaadisoyadi", "adsoyad"],
  tutari: ["tutari", "tutar", "fiyat"],
  odenen: ["odenen", "odenentutar", "odenenmiktar"],
  islem: ["islem", "odemesekli", "odemetipi", "odemeturu"],
  para: ["para", "parabirimi", "doviz", "dovizcinsi"],
};

const REQUIRED: Record<MacroReportKind, readonly Column[]> = {
  treatments: ["tarih", "doktor", "operasyon", "hasta", "tutari"],
  payments: ["odeme", "tarih", "doktor", "hasta", "operasyon", "odenen", "islem"],
};

const COLUMN_TITLES: Record<Column, string> = {
  tarih: "TARİH",
  odeme: "ÖDEME",
  doktor: "DOKTOR",
  operasyon: "OPERASYON",
  dis: "DİŞ",
  dno: "D. NO",
  hasta: "HASTA",
  tutari: "TUTARI",
  odenen: "ÖDENEN",
  islem: "İŞLEM",
  para: "PARA",
};

function columnsOf(header: readonly unknown[]): Partial<Record<Column, number>> {
  const keys = header.map(macroHeaderKey);
  const out: Partial<Record<Column, number>> = {};
  for (const col of Object.keys(ALIASES) as Column[]) {
    for (const alias of ALIASES[col]) {
      const i = keys.indexOf(alias);
      if (i >= 0) {
        out[col] = i;
        break;
      }
    }
  }
  return out;
}

/**
 * The report a header row belongs to: payments when it has ÖDEME, ÖDENEN and İŞLEM; treatments when it has TARİH,
 * DOKTOR, OPERASYON and TUTARI (and not the payments columns); null otherwise.
 */
export function detectMacroReport(header: readonly unknown[]): MacroReportKind | null {
  const c = columnsOf(header);
  if (c.odeme !== undefined && c.odenen !== undefined && c.islem !== undefined) return "payments";
  if (c.tarih !== undefined && c.doktor !== undefined && c.operasyon !== undefined && c.tutari !== undefined) {
    return "treatments";
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y: number, m: number) =>
  m === 2 ? (isLeap(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;

function isoDay(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > monthDays(y, m)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

const DAY_MS = 86_400_000;

/**
 * Excel serial date → 'YYYY-MM-DD' (the time of day, if any, is dropped). 1900 date system: serial 1 = 1900-01-01,
 * serial 60 is Excel's non-existent 1900-02-29 (null), from 61 on days since 1899-12-30. 1904 system: serial 0 =
 * 1904-01-01. Null outside 1900..9999.
 */
export function excelSerialToDay(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial)) return null;
  let n = Math.floor(serial);
  if (date1904) n += 1462;
  if (n < 1 || n === 60) return null;
  if (n < 60) n += 1;
  const d = new Date(Date.UTC(1899, 11, 30) + n * DAY_MS);
  return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * A Macro day cell → 'YYYY-MM-DD': an Excel serial number, a Date (SheetJS cellDates, local midnight), or text
 * 'DD.MM.YYYY' / 'DD/MM/YYYY' / 'YYYY-MM-DD'. Null when it is none of these.
 */
export function macroDay(value: unknown, date1904 = false): string | null {
  if (typeof value === "number") return excelSerialToDay(value, date1904);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return isoDay(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s.*)?$/.exec(s);
  if (m) return isoDay(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/**
 * A Macro amount → integer cents, rounded half away from zero on the decimal value (1.005 → 101: the float is first
 * taken to 15 significant digits). Text amounts may use the Turkish format ('1.234,56'). Null when not a number.
 */
export function macroCents(value: unknown): number | null {
  let x: number;
  if (typeof value === "number") {
    x = value;
  } else if (typeof value === "string") {
    let s = value.trim().replace(/\s+/g, "").replace(/[₺$€£]|TL$/gi, "");
    if (s === "") return null;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    x = Number(s);
  } else {
    return null;
  }
  if (!Number.isFinite(x)) return null;
  const scaled = Number((x * 100).toPrecision(15));
  const cents = Math.sign(scaled) * Math.round(Math.abs(scaled));
  if (!Number.isSafeInteger(cents)) return null;
  return cents === 0 ? 0 : cents;
}

const CURRENCY_KEYS: Record<string, HkCurrency> = {
  tl: "TRY",
  try: "TRY",
  ytl: "TRY",
  turklirasi: "TRY",
  dolar: "USD",
  usd: "USD",
  amerikandolari: "USD",
  euro: "EUR",
  eur: "EUR",
  avro: "EUR",
  sterlin: "GBP",
  gbp: "GBP",
  ingilizsterlini: "GBP",
};
const CURRENCY_SYMBOLS: Record<string, HkCurrency> = { "₺": "TRY", $: "USD", "€": "EUR", "£": "GBP" };

/** Macro PARA → currency code (TL, DOLAR, EURO, STERLİN and their codes / symbols); empty → TRY; unknown → null. */
export function macroCurrency(value: unknown): HkCurrency | null {
  const raw = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  if (raw === "") return "TRY";
  if (CURRENCY_SYMBOLS[raw]) return CURRENCY_SYMBOLS[raw];
  return CURRENCY_KEYS[macroHeaderKey(raw)] ?? null;
}

const METHOD_KEYS: Record<string, MacroPayMethod> = {
  nakit: "cash",
  pos: "card",
  kart: "card",
  kredikarti: "card",
  kredikart: "card",
  banka: "transfer",
  havale: "transfer",
  eft: "transfer",
  havaleeft: "transfer",
};

/** Macro İŞLEM → method (Nakit, POS, Banka and close variants); unknown → null. */
export function macroMethod(value: unknown): MacroPayMethod | null {
  return METHOD_KEYS[macroHeaderKey(value)] ?? null;
}

/** Text cell: trimmed, inner whitespace collapsed; numbers as written ("36"); empty → "". */
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (value instanceof Date) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** Field limits of fin_hk_import_macro (fin__hk_macro_row): longer values are refused there. */
export const MACRO_LIMITS = {
  ext_doctor: 120,
  patient_name: 200,
  patient_no: 50,
  procedure: 200,
  tooth: 200,
  /** |amount| in cents (10.000.000.000 TL) */
  amount_cents: 1_000_000_000_000,
} as const;

/** The reasons a parsed row would be refused by the server's field limits (the file row is listed instead). */
function limitReasons(r: {
  ext_doctor: string;
  patient_name: string;
  patient_no?: string | null;
  procedure: string;
  tooth: string | null;
  amount_cents: number | null;
}): string[] {
  const out: string[] = [];
  if (r.ext_doctor.length > MACRO_LIMITS.ext_doctor) out.push(`Hekim adı en fazla ${MACRO_LIMITS.ext_doctor} karakter olabilir.`);
  if (r.patient_name.length > MACRO_LIMITS.patient_name) {
    out.push(`Hasta adı en fazla ${MACRO_LIMITS.patient_name} karakter olabilir.`);
  }
  if ((r.patient_no ?? "").length > MACRO_LIMITS.patient_no) {
    out.push(`Hasta dosya numarası en fazla ${MACRO_LIMITS.patient_no} karakter olabilir.`);
  }
  if (r.procedure.length > MACRO_LIMITS.procedure) out.push(`İşlem adı en fazla ${MACRO_LIMITS.procedure} karakter olabilir.`);
  if ((r.tooth ?? "").length > MACRO_LIMITS.tooth) out.push(`Diş bilgisi en fazla ${MACRO_LIMITS.tooth} karakter olabilir.`);
  if (r.amount_cents !== null && Math.abs(r.amount_cents) > MACRO_LIMITS.amount_cents) {
    out.push("Tutar en fazla 10.000.000.000 olabilir.");
  }
  return out;
}

/** D. NO: an integer number as digits, text trimmed; empty → null. */
function patientNo(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.trunc(value)) : null;
  const s = text(value);
  return s || null;
}

const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Rows searched for the header (title rows above it are skipped). */
const HEADER_SCAN_ROWS = 20;

export interface MacroSheetOptions {
  /** file name for messages */
  file?: string;
  /** the workbook uses the 1904 date system */
  date1904?: boolean;
  /** the sheet row number of rows[0] minus 1 (when the used range does not start at A1) */
  rowOffset?: number;
}

/**
 * Parses one sheet (`header: 1` arrays). Throws MacroParseError when no Macro header is found or a required column is
 * missing. Blank rows and total rows (no day, doctor or patient) are skipped; every other unreadable row is an issue.
 */
export function parseMacroSheet(rows: readonly (readonly unknown[] | null | undefined)[], opts: MacroSheetOptions = {}): MacroParseResult {
  const file = (opts.file ?? "").slice(0, 200);
  const offset = opts.rowOffset ?? 0;
  const date1904 = !!opts.date1904;
  let headerAt = -1;
  let kind: MacroReportKind | null = null;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    kind = detectMacroReport(rows[i] ?? []);
    if (kind) {
      headerAt = i;
      break;
    }
  }
  const prefix = file ? `${file}: ` : "";
  if (!kind) {
    throw new MacroParseError(
      `${prefix}Macro raporu tanınmadı. Macro'dan “işlem bazlı” veya “tedavi ödeme bazlı” raporu Excel olarak alın.`
    );
  }
  const cols = columnsOf(rows[headerAt] ?? []);
  const missing = REQUIRED[kind].filter((c) => cols[c] === undefined);
  if (missing.length) {
    throw new MacroParseError(`${prefix}${MACRO_REPORT_LABELS[kind]} için ${missing.map((c) => COLUMN_TITLES[c]).join(", ")} sütunu yok.`);
  }
  const cell = (r: readonly unknown[], c: Column) => (cols[c] === undefined ? null : r[cols[c]!]);
  const issues: MacroParseIssue[] = [];
  const treatments: MacroTreatmentRow[] = [];
  const payments: MacroPaymentRow[] = [];

  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = offset + i + 1;
    if (!r || r.every(isBlank)) continue;
    const doctor = text(cell(r, "doktor"));
    const patient = text(cell(r, "hasta"));
    const dayCell = cell(r, "tarih");
    // A total / footer row: no doctor, no patient and no treatment day.
    if (!doctor && !patient && isBlank(dayCell)) continue;
    const reasons: string[] = [];
    const day = macroDay(dayCell, date1904);
    if (!day) reasons.push("Tedavi tarihi okunamadı.");
    if (!doctor) reasons.push("Hekim adı boş.");
    if (!patient) reasons.push("Hasta adı boş.");
    const procedure = text(cell(r, "operasyon"));
    if (!procedure) reasons.push("İşlem adı boş.");
    const currency = macroCurrency(cell(r, "para"));
    if (!currency) reasons.push(`Para birimi tanınmadı: ${text(cell(r, "para"))}.`);
    const tooth = text(cell(r, "dis")) || null;

    if (kind === "treatments") {
      const amount = macroCents(cell(r, "tutari"));
      if (amount === null) reasons.push("Tutar okunamadı.");
      const no = patientNo(cell(r, "dno"));
      reasons.push(
        ...limitReasons({ ext_doctor: doctor, patient_name: patient, patient_no: no, procedure, tooth, amount_cents: amount })
      );
      if (reasons.length) {
        issues.push({ row: rowNo, reason: reasons.join(" ") });
        continue;
      }
      treatments.push({
        row: rowNo,
        day: day!,
        ext_doctor: doctor,
        procedure,
        tooth,
        patient_no: no,
        patient_name: patient,
        currency: currency!,
        amount_cents: amount!,
      });
    } else {
      const payDay = macroDay(cell(r, "odeme"), date1904);
      if (!payDay) reasons.push("Ödeme tarihi okunamadı.");
      const amount = macroCents(cell(r, "odenen"));
      if (amount === null) reasons.push("Ödenen tutar okunamadı.");
      const method = macroMethod(cell(r, "islem"));
      if (!method) reasons.push(`Ödeme şekli tanınmadı: ${text(cell(r, "islem"))}.`);
      reasons.push(...limitReasons({ ext_doctor: doctor, patient_name: patient, procedure, tooth, amount_cents: amount }));
      if (reasons.length) {
        issues.push({ row: rowNo, reason: reasons.join(" ") });
        continue;
      }
      payments.push({
        row: rowNo,
        pay_day: payDay!,
        treatment_day: day!,
        ext_doctor: doctor,
        patient_name: patient,
        procedure,
        tooth,
        method: method!,
        currency: currency!,
        amount_cents: amount!,
      });
    }
  }
  return kind === "treatments"
    ? { kind, file, rows: treatments, issues }
    : { kind, file, rows: payments, issues };
}

type Xlsx = typeof import("xlsx");

/**
 * Reads a Macro report file (.xls / .xlsx) in the browser: the first sheet with a Macro header. Dates are read as raw
 * serial numbers (cellDates off), so no time zone can move a day. Throws FileReadError (size) or MacroParseError.
 */
export async function readMacroFile(
  data: ArrayBuffer,
  fileName: string,
  xlsx?: Pick<Xlsx, "read" | "utils">
): Promise<MacroParseResult> {
  if (data.byteLength > MAX_FILE_BYTES) throw new FileReadError(fileTooLarge(fileName));
  const X = xlsx ?? (await loadXlsx());
  let book: ReturnType<Xlsx["read"]>;
  try {
    book = X.read(data, {
      type: "array",
      cellDates: false,
      cellStyles: false,
      cellFormula: false,
      sheetRows: SHEET_ROWS_PARSED,
      dense: true,
    });
  } catch {
    throw new MacroParseError(`${fileName}: dosya okunamadı. Macro'dan alınan Excel (.xls) dosyasını seçin.`);
  }
  const date1904 = !!book.Workbook?.WBProps?.date1904;
  let firstError: MacroParseError | null = null;
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const range = X.utils.decode_range(ws["!ref"]);
    const full = ws["!fullref"] ? X.utils.decode_range(ws["!fullref"]) : range;
    if (full.e.r - full.s.r + 1 >= SHEET_ROWS_PARSED) {
      throw new MacroParseError(`${fileName}: ${SHEET_ROWS_PARSED - 1} satırdan uzun; raporu daha kısa bir tarih aralığıyla alın.`);
    }
    const rows = X.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
    try {
      return parseMacroSheet(rows, { file: fileName, date1904, rowOffset: range.s.r });
    } catch (err) {
      if (!(err instanceof MacroParseError)) throw err;
      firstError ??= err;
    }
  }
  throw firstError ?? new MacroParseError(`${fileName}: dosyada okunacak sayfa yok.`);
}

// ---------------------------------------------------------------------------
// Keys and helpers
// ---------------------------------------------------------------------------

/** A Macro doctor / operation name as the server matches it (fin__normalize_name). */
export const macroNameKey = (name: string): string => normalizePatientRef(name);

/** Tooth key: spaces dropped, Turkish lower case ("31, 32" = "31,32"). */
const toothKey = (tooth: string | null): string => normalizePatientRef(tooth ?? "").replace(/\s+/g, "");

/** The key a payment row and its treatment row share (treatment day, patient, operation, tooth, currency). */
function matchKey(day: string, patient: string, procedure: string, tooth: string | null, currency: HkCurrency): string {
  return [day, normalizePatientRef(patient), normalizePatientRef(procedure), toothKey(tooth), currency].join("\u0000");
}

/** Last day of the month of a 'YYYY-MM-DD' day. */
export function monthEndOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return `${day.slice(0, 7)}-${pad2(monthDays(y, m))}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (day: string) => DAY_RE.test(day) && isoDay(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))) === day;

/** First and last treatment day of a treatments report (the import page's default range); null without rows. */
export function macroDayRange(rows: readonly { day: string }[]): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows) {
    if (from === null || r.day < from) from = r.day;
    if (to === null || r.day > to) to = r.day;
  }
  return from && to ? { from, to } : null;
}

const byTr = (a: string, b: string) => a.localeCompare(b, "tr");
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// The import (owner decisions 1–3)
// ---------------------------------------------------------------------------

export interface MacroImportInput {
  treatments: readonly MacroTreatmentRow[];
  payments: readonly MacroPaymentRow[];
  /** 'YYYY-MM-DD', inclusive */
  from: string;
  to: string;
  /** Macro doctor names (any spelling) whose month is payment based: the orthodontist(s) (an ortho_lab_first rule) */
  orthoExtDoctors: ReadonlySet<string>;
  /** Macro doctor names mapped to 'ignore': nothing of theirs is emitted */
  ignoreExtDoctors?: ReadonlySet<string>;
}

/** Cents per method of one currency. */
export type MacroMethodCents = Record<HkImportMethod, number>;

export interface MacroCurrencyTotals {
  currency: HkCurrency;
  /** Σ line amounts */
  gross_cents: number;
  by_method: MacroMethodCents;
}

/** A Macro doctor of the range (preview). */
export interface MacroDoctorStats {
  /** first spelling seen */
  ext_doctor: string;
  /** macroNameKey(ext_doctor) */
  key: string;
  /** payment = an orthodontist (payments report), production = everyone else (treatments report) */
  basis: "production" | "payment";
  ignored: boolean;
  /** treatments rows in the range */
  treatments: number;
  /** of which with price 0 */
  zero_price: number;
  /** payment basis: payments rows in the range (amount ≠ 0) */
  payments: number;
  lines: number;
  pieces: number;
  /** by currency (TRY first, then by code) */
  totals: MacroCurrencyTotals[];
}

/** A distinct operation name of the range's treatments rows (the group table of the import page). */
export interface MacroOperationStats {
  /** macroNameKey(name): what a procedure group stores */
  key: string;
  /** first spelling seen */
  name: string;
  /** treatments rows in the range (pieces) */
  rows: number;
  /** Macro doctors (first spellings), by name */
  ext_doctors: string[];
}

export interface MacroImportStats {
  from: string;
  to: string;
  doctors: MacroDoctorStats[];
  operations: MacroOperationStats[];
  /** foreign currencies of the emitted lines (the server converts them with the clinic's fx_rates) */
  currencies: HkCurrency[];
  /**
   * payments rows of production doctors whose treatment day is in the range but which match no treatments row (same
   * treatment day, patient, operation, tooth and currency): not counted anywhere; check that both reports cover the
   * same doctors and days.
   */
  unmatched_payments: MacroPaymentRow[];
  /** payment amounts above the matched treatments' prices (dropped: a treatment is never paid more than its price) */
  overpaid: { currency: HkCurrency; cents: number }[];
  /** treatments rows with a negative price (emitted as a negative 'unpaid' correction line) */
  negative_rows: number;
}

export interface MacroImport {
  lines: HkImportLineArg[];
  pieces: HkImportPieceArg[];
  stats: MacroImportStats;
}

interface Alloc {
  method: MacroPayMethod;
  pay_day: string;
  cents: number;
}

interface Slot {
  t: MacroTreatmentRow;
  /** the price; negative prices take no payment */
  cap: number;
  allocated: number;
  allocs: Alloc[];
}

const PAY_METHODS: readonly MacroPayMethod[] = ["cash", "card", "transfer"];
/** The import line methods in display order. */
export const MACRO_LINE_METHODS: readonly HkImportMethod[] = [...PAY_METHODS, "unpaid"];
const emptyMethodCents = (): MacroMethodCents => ({ cash: 0, card: 0, transfer: 0, unpaid: 0 });

/**
 * Builds the fin_hk_import_macro payload of [from, to] (owner decisions 2026-10-19):
 *  - production basis (every doctor but the orthodontists): per treatments row in the range with a price, the parts
 *    paid by the end of the treatment's month (payments rows with ÖDEME ≤ that month's last day, advances before the
 *    treatment included) by method, aggregated per method, and the rest as 'unpaid'; day = treatment day. Payments
 *    rows find their treatment by (treatment day, patient, operation, tooth, currency) with normalized names; payments
 *    of identical treatments rows fill those rows one after the other in file order, payments taken in (payment day,
 *    row) order; what exceeds the prices is dropped (overpaid). A negative payment row (refund) takes back from the
 *    latest filled rows; a refund paid back by another method reduces the other methods' parts of the month (the
 *    treatment's unpaid part grows). Later payments never change a month. A price-0 row gives no line; a negative price gives one
 *    negative 'unpaid' line.
 *  - payment basis (orthoExtDoctors): one line per payments row with ÖDEME in the range and amount ≠ 0 (day = payment
 *    day, method from İŞLEM); patient_no from the treatments report when the patient name has exactly one D. NO there.
 *  - pieces: one per treatments row in the range (every doctor, price 0 included); the server keeps the rows of
 *    grouped operations and decides the implant parts.
 * Rows of ignoreExtDoctors are left out. Amounts stay in their currency.
 */
export function buildMacroImport(input: MacroImportInput): MacroImport {
  const { from, to } = input;
  if (!validDay(from) || !validDay(to)) throw new MacroImportError("Tarih aralığını seçin.");
  if (from > to) throw new MacroImportError("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
  const ortho = new Set(Array.from(input.orthoExtDoctors, macroNameKey));
  const ignored = new Set(Array.from(input.ignoreExtDoctors ?? [], macroNameKey));
  const inRange = (day: string) => day >= from && day <= to;

  // Doctors and operations of the preview, first spelling wins.
  const doctors = new Map<string, MacroDoctorStats & { byCurrency: Map<HkCurrency, MacroCurrencyTotals> }>();
  const doctorOf = (name: string) => {
    const key = macroNameKey(name);
    let d = doctors.get(key);
    if (!d) {
      d = {
        ext_doctor: name,
        key,
        basis: ortho.has(key) ? "payment" : "production",
        ignored: ignored.has(key),
        treatments: 0,
        zero_price: 0,
        payments: 0,
        lines: 0,
        pieces: 0,
        totals: [],
        byCurrency: new Map(),
      };
      doctors.set(key, d);
    }
    return d;
  };
  const operations = new Map<string, MacroOperationStats>();
  const operationDoctors = new Map<string, Set<string>>();

  const lines: HkImportLineArg[] = [];
  const pieces: HkImportPieceArg[] = [];
  const currencies = new Set<HkCurrency>();
  const overpaid = new Map<HkCurrency, number>();
  let negativeRows = 0;

  const addLine = (line: HkImportLineArg) => {
    lines.push(line);
    const d = doctorOf(line.ext_doctor);
    d.lines += 1;
    let t = d.byCurrency.get(line.currency);
    if (!t) {
      t = { currency: line.currency, gross_cents: 0, by_method: emptyMethodCents() };
      d.byCurrency.set(line.currency, t);
    }
    t.gross_cents += line.amount_cents;
    t.by_method[line.method] += line.amount_cents;
    if (line.currency !== "TRY") currencies.add(line.currency);
  };

  // Treatments rows by match key, in file order (all rows: identical rows share their payments in this order).
  const slotsByKey = new Map<string, Slot[]>();
  const slots: Slot[] = [];
  for (const t of input.treatments) {
    const slot: Slot = { t, cap: Math.max(t.amount_cents, 0), allocated: 0, allocs: [] };
    slots.push(slot);
    const key = matchKey(t.day, t.patient_name, t.procedure, t.tooth, t.currency);
    const list = slotsByKey.get(key) ?? [];
    list.push(slot);
    slotsByKey.set(key, list);
  }

  // Payments → treatments, in payment day order (then file order).
  const unmatched: MacroPaymentRow[] = [];
  const orderedPayments = input.payments
    .map((p, i) => ({ p, i }))
    .sort((a, b) => byText(a.p.pay_day, b.p.pay_day) || a.i - b.i)
    .map((x) => x.p);
  for (const p of orderedPayments) {
    if (p.amount_cents === 0) continue;
    const key = macroNameKey(p.ext_doctor);
    if (ortho.has(key) || ignored.has(key)) continue;
    const group = slotsByKey.get(matchKey(p.treatment_day, p.patient_name, p.procedure, p.tooth, p.currency));
    if (!group) {
      if (inRange(p.treatment_day)) unmatched.push(p);
      continue;
    }
    if (p.amount_cents > 0) {
      let rest = p.amount_cents;
      for (const s of group) {
        const room = s.cap - s.allocated;
        if (rest === 0) break;
        if (room <= 0) continue;
        const take = Math.min(room, rest);
        s.allocs.push({ method: p.method, pay_day: p.pay_day, cents: take });
        s.allocated += take;
        rest -= take;
      }
      if (rest > 0) overpaid.set(p.currency, (overpaid.get(p.currency) ?? 0) + rest);
    } else {
      let back = -p.amount_cents;
      for (let i = group.length - 1; i >= 0 && back > 0; i--) {
        const s = group[i];
        const take = Math.min(s.allocated, back);
        if (take <= 0) continue;
        s.allocs.push({ method: p.method, pay_day: p.pay_day, cents: -take });
        s.allocated -= take;
        back -= take;
      }
    }
  }

  // Production lines and pieces of the range.
  for (const s of slots) {
    const t = s.t;
    if (!inRange(t.day)) continue;
    const key = macroNameKey(t.ext_doctor);
    if (ignored.has(key)) {
      doctorOf(t.ext_doctor).treatments += 1;
      continue;
    }
    const d = doctorOf(t.ext_doctor);
    d.treatments += 1;
    if (t.amount_cents === 0) d.zero_price += 1;

    pieces.push({
      key: `t${t.row}`,
      day: t.day,
      ext_doctor: t.ext_doctor,
      patient_name: t.patient_name,
      patient_no: t.patient_no,
      procedure: t.procedure,
      tooth: t.tooth,
      qty: 1,
    });
    d.pieces += 1;
    const opKey = macroNameKey(t.procedure);
    let op = operations.get(opKey);
    if (!op) {
      op = { key: opKey, name: t.procedure, rows: 0, ext_doctors: [] };
      operations.set(opKey, op);
    }
    op.rows += 1;
    const opDoctors = operationDoctors.get(opKey) ?? new Set<string>();
    if (!opDoctors.has(key)) {
      opDoctors.add(key);
      op.ext_doctors.push(d.ext_doctor);
    }
    operationDoctors.set(opKey, opDoctors);

    if (ortho.has(key) || t.amount_cents === 0) continue;
    const base = {
      basis: "production" as const,
      day: t.day,
      treatment_day: t.day,
      ext_doctor: t.ext_doctor,
      patient_name: t.patient_name,
      patient_no: t.patient_no,
      procedure: t.procedure,
      tooth: t.tooth,
      currency: t.currency,
    };
    if (t.amount_cents < 0) {
      negativeRows += 1;
      addLine({ key: `t${t.row}:unpaid`, ...base, method: "unpaid", amount_cents: t.amount_cents });
      continue;
    }
    const end = monthEndOf(t.day);
    const paid: Record<MacroPayMethod, number> = { cash: 0, card: 0, transfer: 0 };
    for (const a of s.allocs) if (a.pay_day <= end) paid[a.method] += a.cents;
    // A refund paid back by another method takes from the other methods' parts (cash, card, transfer order).
    // Allocations follow the payment days and a refund only takes back what was allocated before it, so the month's
    // net is never negative and the netting always closes.
    let back = 0;
    for (const m of PAY_METHODS) {
      if (paid[m] < 0) {
        back -= paid[m];
        paid[m] = 0;
      }
    }
    for (const m of PAY_METHODS) {
      const take = Math.min(paid[m], back);
      paid[m] -= take;
      back -= take;
    }
    let counted = 0;
    for (const m of PAY_METHODS) {
      if (paid[m] <= 0) continue;
      counted += paid[m];
      addLine({ key: `t${t.row}:${m}`, ...base, method: m, amount_cents: paid[m] });
    }
    if (t.amount_cents - counted > 0) {
      addLine({ key: `t${t.row}:unpaid`, ...base, method: "unpaid", amount_cents: t.amount_cents - counted });
    }
  }

  // Payment basis: the orthodontists' payments of the range.
  const numbersByName = new Map<string, Set<string>>();
  for (const t of input.treatments) {
    if (!t.patient_no) continue;
    const name = normalizePatientRef(t.patient_name);
    const set = numbersByName.get(name) ?? new Set<string>();
    set.add(t.patient_no);
    numbersByName.set(name, set);
  }
  const uniqueNo = (name: string) => {
    const set = numbersByName.get(normalizePatientRef(name));
    return set && set.size === 1 ? Array.from(set)[0] : null;
  };
  for (const p of input.payments) {
    const key = macroNameKey(p.ext_doctor);
    if (!ortho.has(key) || ignored.has(key) || p.amount_cents === 0 || !inRange(p.pay_day)) continue;
    doctorOf(p.ext_doctor).payments += 1;
    addLine({
      key: `p${p.row}`,
      basis: "payment",
      day: p.pay_day,
      treatment_day: p.treatment_day,
      ext_doctor: p.ext_doctor,
      patient_name: p.patient_name,
      patient_no: uniqueNo(p.patient_name),
      procedure: p.procedure,
      tooth: p.tooth,
      method: p.method,
      currency: p.currency,
      amount_cents: p.amount_cents,
    });
  }

  const currencyOrder = (c: HkCurrency) => (c === "TRY" ? "" : c);
  const doctorStats: MacroDoctorStats[] = Array.from(doctors.values())
    .map(({ byCurrency, ...d }) => ({
      ...d,
      totals: Array.from(byCurrency.values()).sort((a, b) => byText(currencyOrder(a.currency), currencyOrder(b.currency))),
    }))
    .sort((a, b) => byTr(a.ext_doctor, b.ext_doctor) || byText(a.key, b.key));
  const operationStats: MacroOperationStats[] = Array.from(operations.values())
    .map((op) => ({ ...op, ext_doctors: op.ext_doctors.slice().sort(byTr) }))
    .sort((a, b) => byTr(a.name, b.name) || byText(a.key, b.key));

  return {
    lines,
    pieces,
    stats: {
      from,
      to,
      doctors: doctorStats,
      operations: operationStats,
      currencies: Array.from(currencies).sort(),
      unmatched_payments: unmatched,
      overpaid: Array.from(overpaid, ([currency, cents]) => ({ currency, cents })).sort((a, b) =>
        byText(currencyOrder(a.currency), currencyOrder(b.currency))
      ),
      negative_rows: negativeRows,
    },
  };
}

/** Σ cents per line method of a doctor's totals in one currency (zeros when the doctor has none in it). */
export function macroMethodTotals(d: Pick<MacroDoctorStats, "totals">, currency: HkCurrency): MacroMethodCents {
  return { ...emptyMethodCents(), ...(d.totals.find((t) => t.currency === currency)?.by_method ?? {}) };
}

/** The Macro doctor names of both reports (first spelling per normalized name), by name: the mapping checklist. */
export function macroExtDoctors(
  treatments: readonly Pick<MacroTreatmentRow, "ext_doctor">[],
  payments: readonly Pick<MacroPaymentRow, "ext_doctor">[] = []
): { key: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of [...treatments, ...payments]) {
    const key = macroNameKey(r.ext_doctor);
    if (key && !seen.has(key)) seen.set(key, r.ext_doctor);
  }
  return Array.from(seen, ([key, name]) => ({ key, name })).sort((a, b) => byTr(a.name, b.name) || byText(a.key, b.key));
}

// ---------------------------------------------------------------------------
// The import page: range checks and the basis of each Macro doctor (fin_hk_import_macro's checks, client side)
// ---------------------------------------------------------------------------

/** Longest range of one import: fin_hk_import_macro refuses p_to − p_from > 365. */
export const MACRO_MAX_RANGE_DAYS = 366;
/** Most lines / pieces of one import (fin_hk_import_macro). */
export const MACRO_MAX_ROWS = 20000;

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;

/** The months ('YYYY-MM') of a day range, in order; [] when the range is not valid. */
export function monthsOfRange(from: string, to: string): string[] {
  if (!validDay(from) || !validDay(to) || from > to) return [];
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${pad2(m)}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const monthText = (month: string) => `${month.slice(5, 7)}.${month.slice(0, 4)}`;

/** The latest closed month ('YYYY-MM') of fin_hk_reference().months, or null. */
function latestClosed(months: readonly { month: string; status: HkMonthStatus }[]): string | null {
  let latest: string | null = null;
  for (const m of months) {
    const key = m.month.slice(0, 7);
    if (m.status === "closed" && (latest === null || key > latest)) latest = key;
  }
  return latest;
}

/** The first day an import may start on: the day after the latest closed month (null when no month is closed). */
export function macroFirstOpenDay(months: readonly { month: string; status: HkMonthStatus }[]): string | null {
  const latest = latestClosed(months);
  if (!latest) return null;
  const y = Number(latest.slice(0, 4));
  const m = Number(latest.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
}

/**
 * Client-side mirror of fin_hk_import_macro's range checks (null when valid): real days, from ≤ to, at most 366 days,
 * not after today, no closed month in the range and none after it (a write before a closed month would change it).
 */
export function validateMacroRange(
  from: string,
  to: string,
  today: string,
  months: readonly { month: string; status: HkMonthStatus }[]
): string | null {
  if (!validDay(from) || !validDay(to)) return "Tarih aralığını seçin.";
  if (from > to) return "Başlangıç tarihi bitiş tarihinden sonra olamaz.";
  if (from < "2000-01-01") return "Geçersiz tarih.";
  if (to > today.slice(0, 10)) return "Bitiş tarihi bugünden sonra olamaz.";
  if (dayNumber(to) - dayNumber(from) > MACRO_MAX_RANGE_DAYS - 1) {
    return `Bir yüklemede en fazla ${MACRO_MAX_RANGE_DAYS} günlük aralık seçilebilir.`;
  }
  const closed = months
    .filter((m) => m.status === "closed" && m.month.slice(0, 7) >= from.slice(0, 7))
    .map((m) => m.month.slice(0, 7))
    .sort()[0];
  if (closed && closed <= to.slice(0, 7)) {
    return `Seçilen aralıkta kapatılmış bir ay var (${monthText(closed)}). Macro yüklemesi yalnızca açık aylara yapılabilir.`;
  }
  if (closed) {
    return `Seçilen aralıktan sonraki bir ay kapatıldı (${monthText(closed)}). Kapatılmış aydan önceki günler artık yüklenemez.`;
  }
  return null;
}

/**
 * The import page's default range for a treatments report: the whole months its days fall in (reports are exported
 * per month, and an orthodontist's payments may fall on days without treatments), from no earlier than the first open
 * day to no later than today; null when nothing of it can be imported.
 */
export function macroDefaultRange(
  rows: readonly { day: string }[],
  today: string,
  months: readonly { month: string; status: HkMonthStatus }[]
): { from: string; to: string } | null {
  const span = macroDayRange(rows);
  if (!span) return null;
  const firstOpen = macroFirstOpenDay(months);
  const monthStart = `${span.from.slice(0, 7)}-01`;
  const from = firstOpen && monthStart < firstOpen ? firstOpen : monthStart;
  const monthEnd = monthEndOf(span.to);
  const to = monthEnd > today.slice(0, 10) ? today.slice(0, 10) : monthEnd;
  return from <= to ? { from, to } : null;
}

/**
 * Which mapped Macro doctors are payment based in [from, to] (owner decision 2: a DentOS doctor with an active
 * ortho_lab_first rule): `ortho` holds their normalized names (buildMacroImport's orthoExtDoctors) when the rule covers
 * every month of the range; `mixed` lists the display names of those whose rule covers only some months (the server
 * checks each line's month, so such a range has to be imported month by month). Other modes are never payment based.
 */
export function macroBasisOf(input: {
  rules: readonly Pick<HkRuleJson, "kind" | "doctor_id" | "from_month" | "to_month">[];
  mapping: readonly Pick<HkExtDoctorJson, "ext_name" | "display_name" | "mode" | "doctor_id">[];
  from: string;
  to: string;
}): { ortho: Set<string>; mixed: string[] } {
  const months = monthsOfRange(input.from, input.to);
  const ortho = new Set<string>();
  const mixed: string[] = [];
  if (months.length === 0) return { ortho, mixed };
  for (const m of input.mapping) {
    if (m.mode !== "doctor" || !m.doctor_id) continue;
    const covered = months.filter((month) =>
      input.rules.some((r) => r.kind === "ortho_lab_first" && r.doctor_id === m.doctor_id && ruleActiveIn(r, month))
    ).length;
    if (covered === months.length) ortho.add(macroNameKey(m.ext_name));
    else if (covered > 0) mixed.push(m.display_name || m.ext_name);
  }
  mixed.sort(byTr);
  return { ortho, mixed };
}

/**
 * The Macro doctors (normalized names) with rows that an import of [from, to] sends: treatments rows in the range,
 * and payments rows paid in the range or paying a treatment of the range. fin_hk_import_macro refuses the import
 * while any of them is unmapped.
 */
export function macroDoctorsInRange(
  treatments: readonly Pick<MacroTreatmentRow, "day" | "ext_doctor">[],
  payments: readonly Pick<MacroPaymentRow, "pay_day" | "treatment_day" | "ext_doctor">[],
  from: string,
  to: string
): Set<string> {
  const inRange = (day: string) => day >= from && day <= to;
  const out = new Set<string>();
  for (const t of treatments) if (inRange(t.day)) out.add(macroNameKey(t.ext_doctor));
  for (const p of payments) if (inRange(p.pay_day) || inRange(p.treatment_day)) out.add(macroNameKey(p.ext_doctor));
  return out;
}

/**
 * The row behind a fin_hk_import_macro row error ("Macro yüklemesi, <n>. satır (…)" / "<n>. işlem"): the server names
 * only the position and the day (never the patient, its messages reach the server log), so the page shows the patient
 * and the report row from the payload it sent. null when the message is not a row error or the row is unknown.
 */
export function macroRowOfError(
  message: string | null | undefined,
  imp: Pick<MacroImport, "lines" | "pieces"> | null | undefined
): string | null {
  const m = /Macro yüklemesi, (\d+)\. (satır|işlem)\b/.exec(message ?? "");
  if (!m || !imp) return null;
  const n = Number(m[1]);
  const row = (m[2] === "satır" ? imp.lines : imp.pieces)[n - 1];
  if (!row) return null;
  // Keys: 't<row>' / 't<row>:<method>' (treatments report), 'p<row>' (payments report).
  const at = /^([tp])(\d+)/.exec(row.key);
  const where = at ? ` · ${MACRO_REPORT_LABELS[at[1] === "t" ? "treatments" : "payments"]}, ${at[2]}. satır` : "";
  return `${m[1]}. ${m[2]}: ${row.patient_name}${where}`;
}
