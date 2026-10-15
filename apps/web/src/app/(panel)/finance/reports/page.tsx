"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { CategoryReportCard, ResultFigure } from "@/components/finance/ReportBlocks";
import { useReferenceData } from "@/components/finance/useReferenceData";
import { Card, ErrorBox, Loading, MoneyRow, buttonPrimary, buttonSecondary } from "@/components/finance/ui";
import { useAuthStore } from "@/lib/store";
import {
  finDashboard,
  finFinancingSummary,
  formatMonth,
  formatTL,
  isMonth,
  toFinanceError,
  type DashboardJson,
  type FinanceError,
} from "@/lib/finance";
import {
  OTHER_PAYMENTS_LABEL,
  RESULT_FIGURES,
  RESULT_FOOTNOTE,
  exclusionWarning,
  expenseRows,
  reportLabelOf,
} from "@/lib/finance-report-lines";
import { countAllEntries, loadBrandName, loadFullReportExtra, loadMonthExport } from "@/lib/finance-report-data";
import { entriesCsv, paymentsCsv } from "@/lib/finance-csv";

export default function FinanceReportsPage() {
  return (
    <FinanceShell title="Finans raporu">
      <Reports />
    </FinanceShell>
  );
}

type Job = "partner" | "full" | "csv-entries" | "csv-payments";

function downloadBlob(parts: BlobPart[], type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Above this many records the full PDF asks before it starts (every record of every date is listed). */
const FULL_PDF_CONFIRM_ENTRIES = 2000;

/** Lets React paint the progress text before a long synchronous step. */
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function Reports() {
  const user = useAuthStore((state) => state.user);
  const { data: reference, error: refError, loading: refLoading, reload: reloadReference } = useReferenceData();
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<DashboardJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [brand, setBrand] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const busy = useRef(false);
  /** Only the latest fin_dashboard request may set state (quick month changes can resolve out of order). */
  const seq = useRef(0);

  const load = useCallback(async (m: string | null) => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const res = await finDashboard(m);
      if (id !== seq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (id === seq.current) setError(toFinanceError(err));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(month);
  }, [load, month]);

  useEffect(() => {
    if (!reference) return;
    let alive = true;
    loadBrandName(reference, user?.clinic_id).then((name) => {
      if (alive) setBrand(name);
    });
    return () => {
      alive = false;
    };
  }, [reference, user?.clinic_id]);

  /**
   * Runs one export at a time; the PDF code (pdf-lib, fontkit) is fetched only here, by dynamic import. The month
   * figures are re-read from fin_dashboard at click time, so the file (and the screen, which is updated with the
   * same result) matches the records read for it and carries today's date.
   */
  const run = async (kind: Job) => {
    if (!data || busy.current) return;
    const clinicId = user?.clinic_id;
    if (!clinicId) {
      setExportError("Klinik bilgisi bulunamadı. Lütfen sayfayı yenileyin.");
      return;
    }
    if (!reference) {
      setExportError("Finans ayarları yüklenemedi. Lütfen sayfayı yenileyin.");
      return;
    }
    busy.current = true;
    setJob(kind);
    setExportError(null);
    setProgress("Hazırlanıyor…");
    try {
      if (kind === "full") {
        const total = await countAllEntries();
        if (
          total > FULL_PDF_CONFIRM_ENTRIES &&
          !window.confirm(
            `Tam rapor ${total.toLocaleString("tr-TR")} kaydın tamamını listeler. Dosya çok sayfalı olur ve hazırlanması birkaç dakika sürebilir. Devam edilsin mi?`
          )
        ) {
          return;
        }
      }
      // Full PDF: read the record sections first, then the month figures, so both describe the same moment.
      const extra = kind === "full" ? await loadFullReportExtra(clinicId, setProgress) : null;
      const fresh = await finDashboard(data.month);
      // Invalidate any in-flight month load so it cannot overwrite the fresh figures.
      seq.current += 1;
      setData(fresh);
      setError(null);
      setLoading(false);
      const snapshot = fresh;
      const brandName = brand ?? (await loadBrandName(reference, clinicId));
      if (kind === "partner" || kind === "full") {
        // Patient-financing block (Phase 4); a missing RPC (migration not applied) just leaves it out.
        const financing = await finFinancingSummary(snapshot.month).catch(() => null);
        const common = await import("@/lib/finance-pdf/common");
        const fonts = await common.fetchFonts();
        let bytes: Uint8Array;
        if (kind === "partner") {
          const { createPartnerPdf } = await import("@/lib/finance-pdf/partner");
          bytes = await createPartnerPdf({ dashboard: snapshot, financing, brand: brandName, fonts });
        } else {
          if (!extra) throw new Error("Rapor kayıtları okunamadı.");
          const { createFullPdf } = await import("@/lib/finance-pdf/full");
          setProgress("PDF oluşturuluyor…");
          await nextFrame();
          bytes = await createFullPdf({
            dashboard: snapshot,
            financing,
            reference,
            extra,
            brand: brandName,
            fonts,
            onProgress: setProgress,
          });
        }
        const prefix = kind === "partner" ? "Ortaklar-Ozeti" : "Finans";
        downloadBlob(
          [new Uint8Array(bytes)],
          "application/pdf",
          `${common.fileSlug(brandName)}-${prefix}-${snapshot.month}-${snapshot.today}.pdf`
        );
      } else {
        const exp = await loadMonthExport(clinicId, snapshot.month, setProgress);
        if (kind === "csv-entries") {
          downloadBlob([entriesCsv(exp)], "text/csv;charset=utf-8", `finans-kayitlar-${snapshot.month}.csv`);
        } else {
          downloadBlob(
            [paymentsCsv(exp, reference, snapshot.today)],
            "text/csv;charset=utf-8",
            `finans-odemeler-${snapshot.month}.csv`
          );
        }
      }
    } catch (err) {
      const fe = toFinanceError(err);
      setExportError(
        kind === "partner" || kind === "full"
          ? `PDF hazırlanamadı. ${fe.message}`
          : `CSV hazırlanamadı. ${fe.message}`
      );
    } finally {
      busy.current = false;
      setJob(null);
      setProgress(null);
    }
  };

  if (!data) {
    return loading ? <Loading /> : <ErrorBox error={error} />;
  }

  const ms = data.month_summary;
  const currentMonth = data.today.slice(0, 7);
  const monthTitle = data.is_current_month ? "Bu ay" : formatMonth(data.month);
  const warning = exclusionWarning(data, monthTitle);
  // Exports need the reference data (brand, account names) and the figures of the month shown in the picker.
  const monthMismatch = month !== null && month !== data.month;
  const disabled = job !== null || loading || !!error || monthMismatch || !reference;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800">Rapor ayı</span>
          <input
            type="month"
            className="px-3 py-2 border rounded bg-white text-gray-900"
            value={month ?? data.month}
            max={currentMonth}
            disabled={job !== null}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) setMonth(null);
              else if (isMonth(v) && v <= currentMonth) setMonth(v);
            }}
          />
        </label>
        {month && month !== currentMonth && (
          <button type="button" className={buttonSecondary} disabled={job !== null} onClick={() => setMonth(null)}>
            Bu aya dön
          </button>
        )}
      </div>

      <Card title={`Raporu indir · ${formatMonth(data.month)}`}>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonPrimary} disabled={disabled} onClick={() => run("partner")}>
            {job === "partner" ? "Hazırlanıyor…" : "Ortaklar için kısa rapor · PDF"}
          </button>
          <button type="button" className={buttonSecondary} disabled={disabled} onClick={() => run("full")}>
            {job === "full" ? "Hazırlanıyor…" : "Finans raporunu PDF indir"}
          </button>
          <button type="button" className={buttonSecondary} disabled={disabled} onClick={() => run("csv-entries")}>
            {job === "csv-entries" ? "Hazırlanıyor…" : "Muhasebe · kayıtlar CSV"}
          </button>
          <button type="button" className={buttonSecondary} disabled={disabled} onClick={() => run("csv-payments")}>
            {job === "csv-payments" ? "Hazırlanıyor…" : "Muhasebe · ödemeler CSV"}
          </button>
        </div>
        {!reference && refLoading && <p className="text-sm text-gray-500 mt-3">Finans ayarları yükleniyor…</p>}
        {refError && (
          <div className="mt-3 space-y-2">
            <ErrorBox error={refError} />
            <button type="button" className={buttonSecondary} onClick={() => void reloadReference()}>
              Finans ayarlarını yeniden yükle
            </button>
          </div>
        )}
        {(error || monthMismatch) && !loading && (
          <p className="text-sm text-gray-600 mt-3">Seçilen ayın rakamları yüklenemedi; dosyalar indirilemez.</p>
        )}
        {progress && <p className="text-sm text-gray-600 mt-3">{progress}</p>}
        {exportError && <div className="mt-3 p-3 rounded bg-red-50 text-red-700 text-sm">{exportError}</div>}
        <p className="text-xs text-gray-500 mt-3">
          Kısa rapor tek sayfadır. Tam rapor aylık özetin yanında tüm kayıtları, yaklaşan planı, carileri ve bakiye
          geçmişini içerir. CSV dosyaları muhasebeci içindir: kayıtlar dosyası vadesi bu ay olan ve bu ay ödeme hareketi
          olan kayıtları, ödemeler dosyası ödeme tarihi bu ay olan tüm hareketleri (iptal edilenler işaretli) içerir.
          Dosyalar tarayıcıda hazırlanır.
          {brand && <> Rapor başlığı: {brand}.</>}
        </p>
      </Card>

      <ErrorBox error={error} />
      {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}

      <p className="text-sm text-gray-600">
        Seçilen ayın gerçekleşen hareketleri. Ödeme listesindeki kategori, durum ve arama filtrelerinden bağımsızdır.
      </p>

      {warning && <div className="p-4 rounded bg-orange-50 text-orange-800 text-sm">{warning}</div>}

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <Card title={`Aylık özet · ${formatMonth(data.month)}`}>
          <MoneyRow label="Brüt hasta tahsilatı (blokeli dahil)" cents={ms.receipts_cents} />
          <MoneyRow label="Toplam ödeme" cents={ms.outflow_cents} />
          <MoneyRow label="Brüt giriş eksi ödeme (blokeli dahil)" cents={ms.net_cents} tone="auto" />
          <MoneyRow label="Faaliyet tahsilatları" cents={ms.profit_income_cents} />
          <MoneyRow label="Faaliyet giderleri" cents={ms.profit_expense_cents} />
          <MoneyRow label="Kredi / borç anapara ödemeleri" cents={ms.loan_payments_cents} />
          <MoneyRow label={OTHER_PAYMENTS_LABEL} cents={ms.other_payments_cents} />
          <p className="text-xs text-gray-500 mt-2">
            Tüm gerçekleşen girişler: {formatTL(ms.inflow_cents)}. Bu tutar borç ve sermaye girişlerini de
            içerebilir.
          </p>
        </Card>

        <Card title={`Aylık gider dağılımı · ${formatMonth(data.month)}`}>
          {expenseRows(data, { withOperationalTotal: true }).map((r) => (
            <div key={r.label} className={r.kind === "sub" ? "pl-4 text-sm" : ""}>
              <MoneyRow label={r.label} cents={r.cents} strong={r.kind === "total"} />
            </div>
          ))}
          <MoneyRow label="Toplam gerçekleşen ödeme" cents={ms.outflow_cents} strong />
        </Card>
      </div>

      <Card title={`Faaliyet sonuçları · ${formatMonth(data.month)}`}>
        <div className="grid gap-3 md:grid-cols-3">
          {RESULT_FIGURES.map((f) => (
            <ResultFigure key={f.key} label={reportLabelOf(f)} cents={ms[f.key]} explain={f.explain} />
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-3">{RESULT_FOOTNOTE}</p>
        {data.settings.physician_fee_note && (
          <p className="text-xs text-gray-600 mt-2">Hekim hakedişi notu: {data.settings.physician_fee_note}</p>
        )}
      </Card>

      <Card title="Güncel borç ve likit durumu">
        <div className="grid gap-x-8 md:grid-cols-2">
          <MoneyRow label="Banka ve kasa (son kayıt)" cents={data.liquidity.liquid_cents} />
          <MoneyRow label="Toplam açık borç" cents={data.groups.payable_total_cents} />
          <MoneyRow label="Toplam açık alacak" cents={data.groups.receivable_cents} />
          <MoneyRow
            label={`${data.settings.forecast_days} gün içinde ödenecek (gecikmiş dahil)`}
            cents={data.forecast.expected_out_cents}
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Bu bölüm seçilen aydan bağımsız güncel açık kayıtları gösterir. PDF, aylık özeti ve tüm kayıt ayrıntılarını
          içerir.
        </p>
      </Card>

      <CategoryReportCard month={data.month} rows={data.category_report} />
    </div>
  );
}
