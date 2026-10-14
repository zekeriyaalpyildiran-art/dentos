// Accountant CSV (Phase 3): semicolon separated, UTF-8 with BOM (Excel tr-TR opens it with Turkish characters
// intact), CRLF line ends, and formula-injection escaping. Amounts are the server's integer cents written as
// "1234,56" without grouping so spreadsheets read them as numbers.

import {
  ACCOUNT_KIND_LABELS,
  BUCKET_LABELS,
  DIRECTION_LABELS,
  STATUS_LABELS,
  SUBCATEGORY_LABELS,
  formatDay,
  formatMonth,
  formatTimestamp,
  type EntryJson,
  type ReferenceData,
} from "./finance";
import type { MonthExport, RawPayment } from "./finance-report-data";

const SEP = ";";
const BOM = "\uFEFF";

/**
 * One CSV cell. A value starting with = + - @ (or a tab / carriage return, which some spreadsheets strip before
 * evaluating) is prefixed with an apostrophe so it is never run as a formula; cells holding the separator, a quote
 * or a line break are quoted with doubled quotes.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[";\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(SEP));
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Integer cents → "1234,56" (no grouping, always two decimals). */
export function centsToCsv(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${negative ? "-" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

const yesNo = (v: boolean) => (v ? "Evet" : "Hayır");

/** Same rule as fin__payments_json 'physician_split' (p1 §1.5): decided per payment by its own month. */
function physicianSplit(entry: EntryJson | undefined, paidOn: string): string {
  if (!entry || entry.report_bucket !== "doctor") return "";
  const past =
    (entry.entitlement_month !== null && entry.entitlement_month < paidOn.slice(0, 7)) ||
    entry.subcategory === "past_physician_debt";
  return past ? "Geçmiş dönem" : "Cari dönem";
}

export function entriesCsv(data: MonthExport): string {
  const header = [
    "Kayıt no",
    "Vade / işlem tarihi",
    "Bu ay listede çünkü",
    "Yön",
    "Kategori",
    "Rapor türü",
    "Alt tür",
    "Kişi / kurum",
    "Açıklama",
    "Tutar (TL)",
    "Toplam ödenen (tüm tarihler, TL)",
    "Kalan (bugün itibarıyla, TL)",
    "Durum",
    "Vadesi geçti",
    "Hakediş ayı",
    "Toplam dışı",
    "Toplam dışı nedeni",
    "İptal nedeni",
    "Oluşturma",
  ];
  const rows = data.entries.map(({ entry: e, dueInMonth, paidInMonth }) => [
    e.id,
    formatDay(e.due_date),
    [dueInMonth ? "Vadesi bu ay" : "", paidInMonth ? "Bu ay ödeme hareketi var" : ""].filter(Boolean).join(" + "),
    DIRECTION_LABELS[e.direction],
    e.category_name,
    BUCKET_LABELS[e.report_bucket] ?? e.report_bucket,
    e.subcategory ? SUBCATEGORY_LABELS[e.subcategory] : "",
    e.counterparty_name,
    e.description,
    centsToCsv(e.amount_cents),
    centsToCsv(e.paid_cents),
    centsToCsv(e.outstanding_cents),
    STATUS_LABELS[e.status],
    yesNo(e.is_overdue),
    // 'Eylül 2026', not raw 'YYYY-MM' (Excel tr-TR turns that into a date such as 'Eyl.26').
    e.entitlement_month ? formatMonth(e.entitlement_month) : "",
    yesNo(e.excluded_from_totals),
    e.exclusion_reason ?? "",
    e.cancel_reason ?? "",
    formatTimestamp(e.created_at),
  ]);
  return buildCsv(header, rows);
}

export function paymentsCsv(data: MonthExport, reference: ReferenceData | null, today: string): string {
  const accounts = new Map((reference?.accounts ?? []).map((a) => [a.id, a]));
  const header = [
    "Ödeme no",
    "Ödeme tarihi",
    "Tutar (TL)",
    "Hesap",
    "Hesap türü",
    "Durum",
    "İptal nedeni",
    "Aylık rakamlara dahil",
    "Hekim dönemi",
    "Kayıt no",
    "Yön",
    "Kategori",
    "Rapor türü",
    "Alt tür",
    "Kişi / kurum",
    "Açıklama",
    "Kayıt vadesi",
    "Kayıt toplam dışı",
  ];
  const rows = data.payments.map((p: RawPayment) => {
    const e = data.entryById.get(p.entry_id);
    const account = accounts.get(p.account_id);
    // Mirrors fin__live_payments + NOT excluded_from_totals: what the month figures of the report count.
    const counted = !p.voided_at && p.paid_on <= today && !!e && !e.excluded_from_totals;
    return [
      p.id,
      formatDay(p.paid_on),
      centsToCsv(p.amount_cents),
      account?.name ?? "",
      account ? ACCOUNT_KIND_LABELS[account.kind] : "",
      p.voided_at ? "İptal edildi" : "Geçerli",
      p.void_reason ?? "",
      yesNo(counted),
      physicianSplit(e, p.paid_on),
      p.entry_id,
      e ? DIRECTION_LABELS[e.direction] : "",
      e?.category_name ?? "",
      e ? (BUCKET_LABELS[e.report_bucket] ?? e.report_bucket) : "",
      e?.subcategory ? SUBCATEGORY_LABELS[e.subcategory] : "",
      e?.counterparty_name ?? "",
      e?.description ?? "",
      e ? formatDay(e.due_date) : "",
      e ? yesNo(e.excluded_from_totals) : "",
    ];
  });
  return buildCsv(header, rows);
}
