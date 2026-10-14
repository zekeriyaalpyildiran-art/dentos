// 'Ortaklar için kısa rapor · PDF' — one A4 page (legacy lib/finance-partner-pdf.ts, same sections and order).
// Every amount comes from fin_dashboard(p_month); the Burgan financing block follows in Phase 4.

import { A4, COLORS, createKit, drawRight, fit, wrap, type FontBytes } from "./common";
import { formatDay, formatMonth, type DashboardJson } from "../finance";
import {
  PARTNER_AFTER_ALL_LABEL,
  RESULT_FIGURES,
  exclusionWarning,
  expenseRows,
  incomingOfBucket,
} from "../finance-report-lines";

export interface PartnerPdfInput {
  dashboard: DashboardJson;
  brand: string;
  fonts: FontBytes;
}

const profit = RESULT_FIGURES.find((f) => f.key === "profit_cents")!;
const currentPeriod = RESULT_FIGURES.find((f) => f.key === "current_period_result_cents")!;

export async function createPartnerPdf({ dashboard: d, brand, fonts }: PartnerPdfInput): Promise<Uint8Array> {
  const monthLabel = formatMonth(d.month);
  const kit = await createKit(fonts, {
    title: `${brand} - Ortaklar için finans özeti ${d.month}`,
    author: brand,
    subject: `Finans özeti · ${monthLabel}`,
  });
  const { doc, font, bold, money, clean } = kit;
  const { ink, accent, muted, pale, warn } = COLORS;
  const page = doc.addPage(A4);
  const left = 42;
  const right = 553;
  const width = right - left;

  const text = (value: string, x: number, y: number, size = 10, color = ink, f = font) =>
    page.drawText(fit(f, clean(value), size, right - x), { x, y, size, font: f, color });
  const row = (label: string, cents: number | null, y: number, size = 9, color = ink, f = font) => {
    const v = money(cents);
    const vw = f.widthOfTextAtSize(v, size);
    page.drawText(fit(f, clean(label), size, width - vw - 12), { x: left, y, size, font: f, color });
    drawRight(page, f, v, right, y, size, color);
  };

  // Header: the brand exactly as stored (report_brand_name / clinics.name); the owner controls its casing.
  text(brand, left, 794, 18, accent, bold);
  text("ORTAKLAR İÇİN FİNANS ÖZETİ", left, 769, 12, ink, bold);
  text(`${monthLabel}  |  Hazırlanma: ${formatDay(d.today)}`, left, 748, 10, muted);

  // Three headline figures
  const ms = d.month_summary;
  const metrics: [string, number][] = [
    ["Brüt hasta tahsilatı", ms.receipts_cents],
    ["Toplam ödeme", ms.outflow_cents],
    [PARTNER_AFTER_ALL_LABEL, ms.after_all_payments_cents],
  ];
  metrics.forEach(([label, value], i) => {
    const x = left + i * 174;
    page.drawRectangle({ x, y: 665, width: 163, height: 64, color: pale });
    text(label, x + 10, 708, 9, muted);
    const v = money(value);
    const size = Math.min(15, 143 / bold.widthOfTextAtSize(v, 1));
    page.drawText(v, { x: x + 10, y: 681, size, font: bold, color: value < 0 ? COLORS.red : ink });
  });
  text(
    `Diğer faaliyet gelirleri: ${money(incomingOfBucket(d, "other_income"))}  |  Sermaye / borç girişleri: ${money(
      incomingOfBucket(d, "capital")
    )}`,
    left,
    647,
    9,
    muted
  );

  // Exclusion warning (replaces legacy's reconciliation warning). Like legacy, only when the selected month's
  // figures are actually affected; exclusions that touch other months do not put a warning on this page.
  const warning = d.exclusions.entry_count_in_month > 0 ? exclusionWarning(d, monthLabel, money) : null;
  if (warning) {
    const lines = wrap(font, clean("UYARI: " + warning), 8.5, width - 16).slice(0, 3);
    const h = lines.length * 11 + 8;
    page.drawRectangle({ x: left, y: 632 - h + 8, width, height: h, color: COLORS.warnPale });
    lines.forEach((l, i) => page.drawText(l, { x: left + 8, y: 628 - i * 11, size: 8.5, font, color: warn }));
  }

  // Monthly payment distribution
  text("AYLIK ÖDEME DAĞILIMI", left, 584, 12, accent, bold);
  let y = 566;
  for (const r of expenseRows(d)) {
    const indent = r.kind === "sub" ? "    " : "";
    const strong = r.kind === "total" || r.kind === "subtotal";
    row(indent + r.label, r.cents, y, 9, ink, strong ? bold : font);
    y -= 13;
  }
  page.drawLine({ start: { x: left, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.6, color: muted });
  row("Toplam gerçekleşen ödeme", ms.outflow_cents, y - 6, 10, accent, bold);
  row(profit.label, ms.profit_cents, y - 23, 10, accent, bold);
  row(currentPeriod.label, ms.current_period_result_cents, y - 40, 10, accent, bold);

  // Current liquidity and debts (independent of the month). Fixed positions keep the export one page.
  text("GÜNCEL LİKİT VE BORÇLAR", left, 274, 12, accent, bold);
  const snap = d.liquidity.snapshot;
  const bankDates = (snap?.sources ?? []).filter((s) => s.kind === "bank").map((s) => s.as_of).sort();
  const bankFrom = bankDates[0] ?? snap?.bank_as_of ?? snap?.day ?? null;
  const bankTo = bankDates[bankDates.length - 1] ?? bankFrom;
  const bankLabel =
    "Banka" + (bankFrom ? ` (${formatDay(bankFrom)}${bankTo && bankTo !== bankFrom ? " - " + formatDay(bankTo) : ""})` : "");
  const cashDay = (snap?.sources ?? []).find((s) => s.kind === "cash")?.as_of ?? snap?.cash_as_of ?? snap?.day ?? null;
  const days = d.settings.forecast_days;
  const rows: [string, number | null][] = [
    [bankLabel, snap ? snap.bank_cents : null],
    ["Kasa" + (cashDay ? ` (${formatDay(cashDay)})` : ""), snap ? snap.cash_cents : null],
    ["Toplam likit", d.liquidity.liquid_cents],
    ["Toplam açık borç", d.groups.payable_total_cents],
    ["Toplam açık alacak", d.groups.receivable_cents],
    [`Yaklaşan ${days} gün: ödemeler (gecikmiş dahil)`, d.forecast.expected_out_cents],
    [`Yaklaşan ${days} gün: beklenen tahsilatlar`, d.forecast.expected_in_cents],
    ["Ödemeler ve beklenen tahsilatlar sonrası tahmini likit", d.forecast.forecast_cents],
  ];
  rows.forEach(([label, v], i) => row(label, v, 251 - i * 16, 9.5));
  text(
    `${days} günlük dönem: ${formatDay(d.today)} - ${formatDay(d.forecast.window_end)}. Açık borçlar tüm dönemleri kapsar.` +
      (snap ? "" : " Banka ve kasa bakiyesi girilmedi."),
    left,
    116,
    8.5,
    muted
  );

  const notes = [
    "Sonuçlar blokeli tahsilatları içerir; kullanılabilir nakit veya muhasebe kârı değildir.",
    "Cari dönem sonucu, geçmiş dönem hekim borcu ödemesini geri ekler.",
    "Ödenmemiş giderler hariç; kredi anaparası faaliyet gideri değildir.",
  ];
  notes.forEach((n, i) => text(n, left, 94 - i * 13, 8.5, muted));

  text(`${brand}  |  Ortaklara özel`, left, 34, 8, muted);
  drawRight(page, font, "1 / 1", right, 34, 8, muted);

  return doc.save();
}
