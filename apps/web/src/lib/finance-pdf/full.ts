// 'Finans raporunu PDF indir' — multi-page A4 report (legacy lib/finance-pdf.ts: same sections, same order).
// Month figures come from fin_dashboard(p_month); the record sections come from paged fin_list / fin_forecast /
// fin_counterparty_ledger / fin_balance_history and the fin_payments SELECT. Nothing is recomputed here.

import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import { A4, COLORS, createKit, drawRight, fit, wrap, type FontBytes } from "./common";
import {
  DIRECTION_LABELS,
  SUBCATEGORY_LABELS,
  formatDay,
  formatMonth,
  type DashboardJson,
  type EntryJson,
  type ReferenceData,
} from "../finance";
import type { FullReportExtra, RawPayment } from "../finance-report-data";
import {
  AFTER_ALL_FIGURE,
  OPERATING_RESULT_FIGURES,
  OTHER_PAYMENTS_LABEL,
  RESULT_FIGURES,
  RESULT_FOOTNOTE,
  exclusionWarning,
  expenseRows,
  reportLabelOf,
} from "../finance-report-lines";

export interface FullPdfInput {
  dashboard: DashboardJson;
  reference: ReferenceData | null;
  extra: FullReportExtra;
  brand: string;
  fonts: FontBytes;
  /** progress text while the record sections are laid out */
  onProgress?: (text: string) => void;
}

/** Lets the browser paint (progress text) between record batches of a long report. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const YIELD_EVERY = 100;

const LEFT = 48;
const RIGHT = 547;
const WIDTH = RIGHT - LEFT;
const TOP = 782;
const BOTTOM = 60;

export async function createFullPdf(input: FullPdfInput): Promise<Uint8Array> {
  const { dashboard: d, extra, brand, fonts } = input;
  const monthLabel = formatMonth(d.month);
  const kit = await createKit(fonts, {
    title: `${brand} - Finans ${d.month}`,
    author: brand,
    subject: `Finans raporu · ${monthLabel}`,
  });
  const { doc, font, bold, money, clean } = kit;
  const { ink, accent, muted } = COLORS;
  const accountName = new Map((input.reference?.accounts ?? []).map((a) => [a.id, a.name]));

  let page!: PDFPage;
  let y = 0;

  function newPage() {
    page = doc.addPage(A4);
    y = TOP;
    page.drawText(fit(bold, clean(`${brand}  /  FİNANS`), 12, WIDTH), {
      x: LEFT,
      y,
      size: 12,
      font: bold,
      color: accent,
    });
    y -= 22;
    page.drawText(
      fit(font, `Yalnızca finans yetkilileri için  |  Rapor tarihi: ${formatDay(d.today)}  |  Dönem: ${monthLabel}`, 9, WIDTH),
      { x: LEFT, y, size: 9, font, color: ink }
    );
    y -= 30;
  }

  function ensure(space: number) {
    if (y - space < BOTTOM) newPage();
  }

  function line(value: string, size = 10, color: RGB = ink, f: PDFFont = font, indent = 0) {
    ensure(size + 6);
    page.drawText(value, { x: LEFT + indent, y, size, font: f, color });
    y -= size + 6;
  }

  function text(value: string, size = 10, color: RGB = ink, f: PDFFont = font, indent = 0) {
    for (const l of wrap(f, clean(value), size, WIDTH - indent)) line(l, size, color, f, indent);
  }

  function section(title: string) {
    ensure(70);
    y -= 12;
    text(title, 14, accent, bold);
    y -= 4;
  }

  /** label left, amount right (legacy val()). */
  function val(label: string, cents: number | null | undefined, opts: { strong?: boolean; indent?: number } = {}) {
    const f = opts.strong ? bold : font;
    const v = money(cents);
    const indent = opts.indent ?? 0;
    ensure(16);
    const vw = f.widthOfTextAtSize(v, 10);
    page.drawText(fit(f, clean(label), 10, WIDTH - indent - vw - 12), { x: LEFT + indent, y, size: 10, font: f, color: ink });
    drawRight(page, f, v, RIGHT, y, 10, typeof cents === "number" && cents < 0 ? COLORS.red : ink);
    y -= 16;
  }

  function warningBox(message: string) {
    const lines = wrap(font, clean(message), 9.5, WIDTH - 16);
    const h = lines.length * 14 + 10;
    ensure(h + 6);
    page.drawRectangle({ x: LEFT, y: y - h + 14, width: WIDTH, height: h, color: COLORS.warnPale });
    lines.forEach((l, i) => page.drawText(l, { x: LEFT + 8, y: y - 2 - i * 14, size: 9.5, font, color: COLORS.warn }));
    y -= h + 6;
  }

  const ms = d.month_summary;
  const snap = d.liquidity.snapshot;
  newPage();

  // 1. Toplam likit
  section("Toplam likit");
  val("Banka", snap ? snap.bank_cents : null);
  val("Nakit kasa", snap ? snap.cash_cents : null);
  val("Toplam", d.liquidity.liquid_cents, { strong: true });
  text("Bakiye tarihi: " + (snap ? formatDay(snap.day) : "Bakiye girilmedi"));
  if (snap && !snap.is_today) {
    text(`Bakiye bugüne ait değil (${formatDay(snap.day)}); tahminler eski bakiyeye dayanıyor.`, 9, COLORS.warn);
  }

  // 2. Bakiye kaynakları
  if (snap && snap.sources.length) {
    section("Bakiye kaynakları");
    for (const s of snap.sources) {
      text(`${s.label} | ${formatDay(s.as_of)} | ${money(s.amount_cents)}${s.note ? " | " + s.note : ""}`);
    }
    text(
      (snap.bank_mode === "manual"
        ? "Banka toplamı manuel girildi. "
        : "Bakiye kaynakları farklı tarihlerden olabilir; dosyada olmayan hesapların önceki bakiyesi korunur. ") +
        "Ödeme / tahsilat hareketleri bu bakiyelere tekrar eklenmez.",
      9,
      muted
    );
  }

  // 3. Seçilen ay
  section("Seçilen ay: " + monthLabel);
  const warning = exclusionWarning(d, monthLabel, money);
  if (warning) warningBox("UYARI: " + warning);
  val("Brüt hasta tahsilatı (blokeli dahil)", ms.receipts_cents);
  val("Gerçekleşmiş tüm girişler", ms.inflow_cents);
  val("Toplam ödeme", ms.outflow_cents);
  val("Brüt giriş eksi ödeme (blokeli dahil)", ms.net_cents, { strong: true });

  // 4. Aylık gider dağılımı
  section("Aylık gider dağılımı");
  for (const r of expenseRows(d, { longPastLabel: true })) {
    val(r.label, r.cents, { indent: r.kind === "sub" ? 14 : 0, strong: r.kind === "total" });
  }
  val("Toplam gerçekleşmiş ödeme", ms.outflow_cents, { strong: true });

  // 5. Faaliyet sonuçları: the two operating results as cards (legacy; the after-all figure is in section 9)
  ensure(150);
  section("Faaliyet sonuçları");
  {
    const gap = 8;
    const cardW = (WIDTH - gap) / 2;
    const cardY = y - 54;
    OPERATING_RESULT_FIGURES.forEach((f, i) => {
      const x = LEFT + i * (cardW + gap);
      const cents = ms[f.key];
      page.drawRectangle({ x, y: cardY, width: cardW, height: 62, color: COLORS.pale });
      wrap(font, f.label, 8.5, cardW - 16)
        .slice(0, 2)
        .forEach((l, j) => page.drawText(l, { x: x + 8, y: cardY + 46 - j * 11, size: 8.5, font, color: ink }));
      const v = money(cents);
      const size = Math.min(14, (cardW - 16) / bold.widthOfTextAtSize(v, 1));
      page.drawText(v, { x: x + 8, y: cardY + 9, size, font: bold, color: cents < 0 ? COLORS.red : accent });
    });
    y = cardY - 18;
  }
  for (const f of OPERATING_RESULT_FIGURES) text(`${f.label}: ${f.explain}`, 9);
  text(
    RESULT_FOOTNOTE +
      " Kredi anaparası ve demirbaş faaliyet gideri değildir. Cari dönem sonucu muhasebe kârı veya kesin üretim tutarı değildir.",
    9,
    muted
  );

  // 6. Yaklaşan N gün
  section(`Yaklaşan ${d.settings.forecast_days} gün: ${formatDay(d.today)} - ${formatDay(d.forecast.window_end)}`);
  val("Ödemeler", d.forecast.expected_out_cents);
  val("Beklenen tahsilatlar", d.forecast.expected_in_cents);
  val("Ödeme sonrası likit", d.forecast.after_payments_cents);
  val("Tahsilatlarla birlikte tahmini likit", d.forecast.forecast_cents, { strong: true });
  text("Vadesi geçmiş açık kayıtlar dahil. Tahsilatların gerçekleşmesi varsayılır.", 9, muted);

  // 7. Tampon
  section("Tampon");
  val("Hedef", d.buffer.target_cents);
  val("Mevcut", d.buffer.liquid_cents);
  if (d.buffer.delta_cents === null) val("Fark", null);
  else if (d.buffer.delta_cents >= 0) val("Hedefin üzerinde", d.buffer.delta_cents, { strong: true });
  else val("Eksik", Math.abs(d.buffer.delta_cents), { strong: true });

  // 8. Alacaklar / borçlar (report groups replace legacy's hard-coded names)
  section("Alacaklar / borçlar");
  for (const g of d.groups.payable) {
    val(`${g.name}${g.is_active ? "" : " (pasif)"} · ${g.entry_count} açık kayıt`, g.outstanding_cents);
  }
  val("Toplam açık borç", d.groups.payable_total_cents, { strong: true });
  val(`Kliniğin alacakları · ${d.groups.receivable_entry_count} açık kayıt`, d.groups.receivable_cents, { strong: true });
  text("Tutarlar kliniğin bakış açısıyla gösterilir.", 9, muted);

  // 9. Aylık tahsilat ve tüm ödemeler
  section("Aylık tahsilat ve tüm ödemeler");
  val("Brüt hasta tahsilatı (blokeli dahil)", ms.receipts_cents);
  val("Faaliyet tahsilatları", ms.profit_income_cents);
  val("Toplam gerçekleşen ödeme", ms.outflow_cents);
  val("Faaliyet giderleri", ms.profit_expense_cents);
  val("Hekim hakedişi", d.expenses.by_bucket.doctor ?? 0);
  val("Cari dönem", d.expenses.current_doctor_cents, { indent: 14 });
  val("Geçmiş dönem borç ödemesi", d.expenses.past_doctor_cents, { indent: 14 });
  val("Kredi / borç anapara ödemeleri", ms.loan_payments_cents);
  val(OTHER_PAYMENTS_LABEL, ms.other_payments_cents);
  for (const f of RESULT_FIGURES) val(reportLabelOf(f), ms[f.key], { strong: true });
  text(`${reportLabelOf(AFTER_ALL_FIGURE)}: ${AFTER_ALL_FIGURE.explain}`, 9, muted);
  text(
    "Her ödeme bir kez sayılır. Ödenmemiş hakediş carilerde izlenir. Cari dönem sonucu, geçmiş dönem hekim borcu ödemesi hariç tutularak hesaplanır; muhasebe kârı veya banka bakiyesi değildir.",
    9,
    muted
  );
  if (d.settings.physician_fee_note) text("Hekim hakedişi notu: " + d.settings.physician_fee_note, 9, muted);
  text(
    "Banka ve kasa manuel girilmiş veya dosyadan onaylanmış son bakiyelerdir; ödeme kayıtları bu bakiyeleri otomatik değiştirmez. Hasta kartlarındaki tutarlar ve reklam giderleri bu rapora otomatik eklenmez. Tüm tutarlar TL’dir.",
    9,
    muted
  );

  // 10. Records
  function entry(e: EntryJson, details: boolean) {
    ensure(70);
    text(
      `${e.counterparty_name} | ${e.category_name}${e.subcategory ? " | " + SUBCATEGORY_LABELS[e.subcategory] : ""}`,
      11,
      ink,
      bold
    );
    if (e.excluded_from_totals) {
      text("Toplamların dışında" + (e.exclusion_reason ? ": " + e.exclusion_reason : "."), 9, COLORS.warn);
    }
    text(
      `${formatDay(e.due_date)} | ${DIRECTION_LABELS[e.direction]}${
        e.status === "cancelled" ? " | İptal" : e.is_overdue ? " | Vadesi geçti" : ""
      }${e.entitlement_month ? " | Hakediş ayı " + formatMonth(e.entitlement_month) : ""}`
    );
    text(`Tutar: ${money(e.amount_cents)} | Gerçekleşen: ${money(e.paid_cents)} | Kalan: ${money(e.outstanding_cents)}`);
    if (details) {
      if (e.description) text(e.description, 9, muted);
      if (e.cancel_reason) text("İptal nedeni: " + e.cancel_reason, 9, muted);
      for (const p of extra.paymentsByEntry.get(e.id) ?? []) payment(p);
    }
    y -= 8;
  }

  function payment(p: RawPayment) {
    const base = `${formatDay(p.paid_on)} | ${accountName.get(p.account_id) ?? "—"} | ${money(p.amount_cents)}`;
    if (p.voided_at) text(`İptal edilen hareket: ${base}${p.void_reason ? " | " + p.void_reason : ""}`, 9, muted, font, 12);
    else text("Hareket: " + base, 9, ink, font, 12);
  }

  section("Ödeme ve tahsilatlar - tüm kayıtlar");
  text("Bu bölüm tüm tarihleri ve durumları içerir; ekranın arama ve kategori filtrelerinden bağımsızdır.", 9, muted);
  if (!extra.entries.length) text("Kayıt yok.");
  for (let i = 0; i < extra.entries.length; i++) {
    if (i % YIELD_EVERY === 0) {
      input.onProgress?.(
        `PDF oluşturuluyor: ${i.toLocaleString("tr-TR")} / ${extra.entries.length.toLocaleString("tr-TR")} kayıt`
      );
      await yieldToBrowser();
    }
    entry(extra.entries[i], true);
  }

  section(`${extra.forecast.forecast_days || d.settings.forecast_days} günlük plan`);
  if (!extra.forecast.rows.length) text("Açık kayıt yok.");
  for (let i = 0; i < extra.forecast.rows.length; i++) {
    if (i % YIELD_EVERY === 0) await yieldToBrowser();
    entry(extra.forecast.rows[i], false);
  }

  section("Cariler - açık bakiyeler");
  if (!extra.ledger.length) text("Açık cari kayıt yok.");
  for (const a of extra.ledger) {
    ensure(50);
    text(a.name, 11, ink, bold);
    text(`Kliniğin alacağı: ${money(a.receivable_cents)} | Borcu: ${money(a.payable_cents)}`);
    val("Net alacak / borç", a.net_cents);
    y -= 4;
  }

  section("Bakiye geçmişi");
  if (!extra.balances.length) text("Bakiye girilmedi.");
  for (const b of extra.balances) {
    ensure(40);
    text(formatDay(b.day), 11, ink, bold);
    text(`Banka: ${money(b.bank_cents)} | Nakit: ${money(b.cash_cents)} | Toplam: ${money(b.liquid_cents)}`);
  }

  input.onProgress?.("PDF dosyası kaydediliyor…");
  await yieldToBrowser();
  const pages = doc.getPages();
  const footer = fit(font, clean(`${brand} | Özel finans raporu`), 9, WIDTH - 60);
  pages.forEach((p, i) => {
    p.drawText(footer, { x: LEFT, y: 30, size: 9, font, color: ink });
    drawRight(p, font, `${i + 1} / ${pages.length}`, RIGHT, 30, 9, ink);
  });

  return doc.save();
}
