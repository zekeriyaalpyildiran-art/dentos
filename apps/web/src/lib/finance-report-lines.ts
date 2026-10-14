// One source of truth for the report labels shown on the finance dashboard, the /finance/reports page and both
// PDFs (Phase 3). Every figure is read from fin_dashboard(p_month); nothing here does arithmetic beyond summing
// what the RPC already returns per bucket / per category.

import { formatTL, type DashboardJson, type ReportBucket } from "./finance";

/** The three monthly result figures (p3 §5.4), with the explanation shown under each. */
export interface ResultFigureDef {
  key: "profit_cents" | "current_period_result_cents" | "after_all_payments_cents";
  /** label on the dashboard's monthly card */
  label: string;
  /** label on /finance/reports and in the full PDF, when it differs (p3 §5.4 row 3) */
  reportLabel?: string;
  explain: string;
}

export const RESULT_FIGURES: readonly ResultFigureDef[] = [
  {
    key: "profit_cents",
    label: "Tahsilat esaslı faaliyet sonucu",
    explain:
      "Hasta tahsilatları eksi faaliyet giderleri. Seçilen ayda ödenen geçmiş dönem hekim borçları gidere dahildir.",
  },
  {
    key: "current_period_result_cents",
    label: "Cari dönem operasyonel sonucu",
    explain:
      "Faaliyet sonucuna bu ay ödenen geçmiş dönem hekim hakedişi borçları geri eklenir; ay yalnızca kendi hekim maliyetini taşır.",
  },
  {
    key: "after_all_payments_cents",
    label: "Tüm ödemeler sonrası kalan",
    reportLabel: "Tahsilatlar sonrası kalan",
    explain:
      "Faaliyet tahsilatları (hasta + diğer faaliyet geliri) eksi tüm gerçekleşen ödemeler (kredi anapara, ortak dağıtımı ve demirbaş dahil). Sermaye / borç girişleri sayılmaz.",
  },
];

/** Label used by the reports page and the full PDF. */
export const reportLabelOf = (f: ResultFigureDef) => f.reportLabel ?? f.label;

/** The two operating results (legacy 'Faaliyet sonuçları' cards; the Phase 3 plan's two KPIs). */
export const OPERATING_RESULT_FIGURES = RESULT_FIGURES.filter((f) => f.key !== "after_all_payments_cents");
export const AFTER_ALL_FIGURE = RESULT_FIGURES.find((f) => f.key === "after_all_payments_cents")!;

/** Headline tile of the partner PDF (legacy finance-partner-pdf.ts). */
export const PARTNER_AFTER_ALL_LABEL = "Ödemeler sonrası kalan";

/** Footnote under the three figures (dashboard 'Aylık sonuçlar' card). */
export const RESULT_FOOTNOTE =
  "Üç rakam da nakit esaslıdır, tahakkuk esaslı kâr değildir. Blokeli hasta tahsilatları dahildir ve hemen kullanılabilir nakit değildir. Ödenmemiş tutarlar sayılmaz.";

/**
 * Operating expense buckets between the physician line and the general subtotal (legacy FP:71 'Aylık gider
 * dağılımı', same order and wording), keyed by bucket.
 */
export const EXPENSE_LINES: readonly { bucket: ReportBucket; label: string }[] = [
  { bucket: "lab", label: "Laboratuvar" },
  { bucket: "personnel", label: "Personel" },
  { bucket: "rent", label: "Kira" },
  { bucket: "supplies", label: "Sarf / tedarikçi" },
  { bucket: "tax", label: "Vergi / SGK" },
  { bucket: "other_expense", label: "Diğer faaliyet gideri" },
];

/** Follows the general subtotal (legacy order). */
export const FEES_LINE: { bucket: ReportBucket; label: string } = {
  bucket: "fees",
  label: "Faiz / banka / POS giderleri",
};

export const PHYSICIAN_LABEL = "Hekim hakedişi";
export const PHYSICIAN_CURRENT_LABEL = "Cari dönem";
export const PHYSICIAN_PAST_LABEL = "Geçmiş dönem borç ödemesi";
/** Full PDF wording of the past-physician sub-row (legacy finance-pdf.ts). */
export const PHYSICIAN_PAST_LONG_LABEL = "Geçmiş dönem hekim borcu ödemesi";
export const GENERAL_EXPENSE_LABEL = "Genel faaliyet giderleri (vergi ve diğer)";
/** Screen-only row; no legacy PDF has it. */
export const OPERATIONAL_TOTAL_LABEL = "Faaliyet giderleri toplamı";

/**
 * Outflows that are not operating expenses. 'Ortak dağıtımı' is the distribution bucket alone; keep it distinct
 * from month_summary.other_payments_cents ('Diğer çıkışlar (ortak dağıtımı, demirbaş)').
 */
export const NON_OPERATING_LINES: readonly { bucket: ReportBucket; label: string }[] = [
  { bucket: "principal", label: "Kredi / borç anapara ödemeleri" },
  { bucket: "asset", label: "Demirbaş" },
  { bucket: "distribution", label: "Ortak dağıtımı" },
];

export const OTHER_PAYMENTS_LABEL = "Diğer çıkışlar (ortak dağıtımı, demirbaş)";

export type ExpenseRowKind = "main" | "sub" | "subtotal" | "total";

export interface ExpenseRow {
  label: string;
  cents: number;
  kind: ExpenseRowKind;
}

/**
 * The 'Aylık gider dağılımı' list in legacy display order. All values come straight from the RPC
 * (expenses.by_bucket, current/past physician split, general and operational totals). The operational total row
 * is for the screen only; the PDFs keep the legacy rows.
 */
export function expenseRows(
  d: DashboardJson,
  opts: { withOperationalTotal?: boolean; longPastLabel?: boolean } = {}
): ExpenseRow[] {
  const b = d.expenses.by_bucket;
  const line = (l: { bucket: ReportBucket; label: string }): ExpenseRow => ({
    label: l.label,
    cents: b[l.bucket] ?? 0,
    kind: "main",
  });
  return [
    { label: PHYSICIAN_LABEL, cents: b.doctor ?? 0, kind: "main" },
    { label: PHYSICIAN_CURRENT_LABEL, cents: d.expenses.current_doctor_cents, kind: "sub" },
    {
      label: opts.longPastLabel ? PHYSICIAN_PAST_LONG_LABEL : PHYSICIAN_PAST_LABEL,
      cents: d.expenses.past_doctor_cents,
      kind: "sub",
    },
    ...EXPENSE_LINES.map(line),
    { label: GENERAL_EXPENSE_LABEL, cents: d.expenses.general_cents, kind: "subtotal" },
    line(FEES_LINE),
    ...(opts.withOperationalTotal
      ? [{ label: OPERATIONAL_TOTAL_LABEL, cents: d.expenses.operational_cents, kind: "total" as const }]
      : []),
    ...NON_OPERATING_LINES.map(line),
  ];
}

/** Sum of the selected month's realized inflow of every category in one bucket (category_report rows). */
export function incomingOfBucket(d: DashboardJson, bucket: ReportBucket): number {
  return d.category_report
    .filter((r) => r.report_bucket === bucket)
    .reduce((sum, r) => sum + r.incoming_cents, 0);
}

/** Exclusion warning (dashboard orange box), or null when nothing is excluded from the totals. */
export function exclusionWarning(
  d: DashboardJson,
  monthTitle: string,
  money: (cents: number) => string = formatTL
): string | null {
  const x = d.exclusions;
  if (x.entry_count <= 0) return null;
  return x.entry_count_in_month > 0
    ? `Toplam ${x.entry_count} kayıt toplamların dışında tutuluyor. ${monthTitle} bunlardan ${x.entry_count_in_month} kayda ait ${money(x.paid_cents_in_month)} tutarındaki ödemeler aylık rakamlara katılmadı.`
    : `Toplam ${x.entry_count} kayıt toplamların dışında tutuluyor. ${monthTitle} bu kayıtlara ait ödeme yok.`;
}

