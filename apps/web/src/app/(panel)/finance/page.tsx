"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { Card, ErrorBox, Loading, MoneyRow, buttonPrimary, buttonSecondary } from "@/components/finance/ui";
import {
  BUCKET_LABELS,
  DIRECTION_LABELS,
  finDashboard,
  formatDay,
  formatMonth,
  formatTL,
  isMonth,
  toFinanceError,
  type DashboardJson,
  type FinanceError,
  type ReportBucket,
} from "@/lib/finance";

export default function FinanceDashboardPage() {
  return (
    <FinanceShell title="Finans">
      <Dashboard />
    </FinanceShell>
  );
}

/** Expense report lines (legacy FP:71 'Aylık gider dağılımı'), keyed by bucket, never by name. */
const EXPENSE_LINES: { bucket: ReportBucket; label: string }[] = [
  { bucket: "lab", label: "Laboratuvar" },
  { bucket: "personnel", label: "Personel" },
  { bucket: "rent", label: "Kira" },
  { bucket: "supplies", label: "Sarf / tedarikçi" },
  { bucket: "tax", label: "Vergi / SGK" },
  { bucket: "other_expense", label: "Diğer faaliyet gideri" },
  { bucket: "fees", label: "Faiz / banka / POS masrafı" },
];

function Dashboard() {
  const canWrite = useCanWriteFinance();
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<DashboardJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (m: string | null) => {
    setLoading(true);
    try {
      setData(await finDashboard(m));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(month);
  }, [load, month]);

  if (!data) {
    return loading ? <Loading /> : <ErrorBox error={error} />;
  }

  const { liquidity, month_summary: ms, expenses, forecast, buffer, groups, settings } = data;
  const snapshot = liquidity.snapshot;
  const currentMonth = data.today.slice(0, 7);
  const monthTitle = data.is_current_month ? "Bu ay" : formatMonth(data.month);

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
            onChange={(e) => {
              const v = e.target.value;
              if (!v) setMonth(null);
              else if (isMonth(v) && v <= currentMonth) setMonth(v);
            }}
          />
        </label>
        {month && month !== currentMonth && (
          <button type="button" className={buttonSecondary} onClick={() => setMonth(null)}>
            Bu aya dön
          </button>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-2 ml-auto">
            <Link href="/finance/entries/new" className={buttonPrimary}>
              Ödeme / tahsilat ekle
            </Link>
            <Link href="/finance/balances" className={buttonSecondary}>
              Banka / kasa güncelle
            </Link>
          </div>
        )}
      </div>

      <ErrorBox error={error} />
      {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}

      {/* Four summary cards (legacy FP:57-60) */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Toplam likit">
          {snapshot ? (
            <>
              <MoneyRow label="Banka" cents={snapshot.bank_cents} />
              <MoneyRow label="Nakit kasa" cents={snapshot.cash_cents} />
              <MoneyRow label="Toplam" cents={liquidity.liquid_cents} strong />
              <p className="text-xs text-gray-500 mt-2">Bakiye tarihi: {formatDay(snapshot.day)}</p>
            </>
          ) : (
            <p className="text-sm text-gray-600">
              Başlamak için gerçek banka ve kasa bakiyelerini gir.{" "}
              <Link href="/finance/balances" className="text-blue-600 hover:underline">
                Bakiyeler
              </Link>
            </p>
          )}
        </Card>

        <Card title={monthTitle}>
          <MoneyRow label="Brüt hasta tahsilatı (blokeli dahil)" cents={ms.receipts_cents} />
          <MoneyRow label="Toplam ödeme" cents={ms.outflow_cents} />
          <MoneyRow label="Brüt giriş eksi ödeme (blokeli dahil)" cents={ms.net_cents} strong tone="auto" />
          <p className="text-xs text-gray-500 mt-2">
            Tüm gerçekleşen girişler: {formatTL(ms.inflow_cents)}. Bu tutar borç ve sermaye girişlerini de
            içerebilir.
          </p>
        </Card>

        <Card title={`Yaklaşan ${settings.forecast_days} gün`}>
          <MoneyRow label="Ödemeler" cents={forecast.expected_out_cents} />
          <MoneyRow label="Beklenen tahsilatlar" cents={forecast.expected_in_cents} />
          <MoneyRow label="Ödeme sonrası likit" cents={forecast.after_payments_cents} tone="auto" />
          <MoneyRow label="Tahsilatlarla birlikte tahmini likit" cents={forecast.forecast_cents} strong tone="auto" />
          <p className="text-xs text-gray-500 mt-2">
            {formatDay(forecast.window_end)} tarihine kadar. Vadesi geçmiş açık kayıtlar dahil; tahsilatların
            gerçekleşmesi varsayılır.{" "}
            <Link href="/finance/plan" className="text-blue-600 hover:underline">
              Planı aç
            </Link>
          </p>
        </Card>

        <Card title="Tampon">
          <MoneyRow label="Hedef" cents={buffer.target_cents} />
          <MoneyRow label="Mevcut" cents={buffer.liquid_cents} />
          {buffer.delta_cents === null ? (
            <MoneyRow label="Fark" cents={null} />
          ) : buffer.delta_cents >= 0 ? (
            <MoneyRow label="Hedefin üzerinde" cents={buffer.delta_cents} strong tone="green" />
          ) : (
            <MoneyRow label="Eksik" cents={Math.abs(buffer.delta_cents)} strong tone="red" />
          )}
          <p className="text-xs text-gray-500 mt-2">Gerçek banka ve kasa toplamına göre hesaplanır.</p>
        </Card>
      </div>

      {snapshot && !snapshot.is_today && (
        <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
          Bakiye bugüne ait değil ({formatDay(snapshot.day)}); tahminler eski bakiyeye dayanıyor.
        </div>
      )}

      {snapshot && (
        <Card title="Bakiye kaynakları ve tarihleri">
          <div className="divide-y">
            {snapshot.sources.map((s) => (
              <div key={s.id} className="flex justify-between gap-4 py-2 text-sm">
                <div>
                  <span className="font-medium">{s.label}</span>
                  <span className="text-gray-500">
                    {" "}
                    · {formatDay(s.as_of)}
                    {s.is_older_than_today && <span className="text-amber-700"> · Bugünden eski</span>}
                  </span>
                  {s.note && <div className="text-xs text-gray-500">{s.note}</div>}
                </div>
                <div className="tabular-nums whitespace-nowrap">{formatTL(s.amount_cents)}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {snapshot.bank_mode === "manual"
              ? "Banka toplamı manuel girildi. "
              : "Her hesap son okunan tarihiyle korunur. Eksik banka dökümü o hesabı sıfırlamaz. "}
            Ödeme / tahsilat hareketleri bu bakiyelere tekrar eklenmez.
          </p>
        </Card>
      )}

      {data.exclusions.entry_count > 0 && (
        <div className="p-4 rounded bg-orange-50 text-orange-800 text-sm">
          Toplam {data.exclusions.entry_count} kayıt toplamların dışında tutuluyor.{" "}
          {data.exclusions.entry_count_in_month > 0
            ? `${monthTitle} bunlardan ${data.exclusions.entry_count_in_month} kayda ait ${formatTL(data.exclusions.paid_cents_in_month)} tutarındaki ödemeler aylık rakamlara katılmadı.`
            : `${monthTitle} bu kayıtlara ait ödeme yok.`}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <Card title="Alacaklar / borçlar">
          {groups.payable.map((g) => (
            <MoneyRow
              key={g.report_group_id ?? "other"}
              label={
                <Link
                  href={`/finance/entries?report_group=${g.report_group_id ?? "other"}`}
                  className="hover:underline"
                >
                  {g.name}
                  {!g.is_active && <span className="text-xs text-gray-500"> (pasif)</span>}
                </Link>
              }
              hint={`${g.entry_count} açık kayıt`}
              cents={g.outstanding_cents}
            />
          ))}
          <MoneyRow label="Toplam açık borç" cents={groups.payable_total_cents} strong />
          <MoneyRow
            label={
              <Link href="/finance/entries?status=open&direction=in" className="hover:underline">
                Kliniğin alacakları
              </Link>
            }
            hint={`${groups.receivable_entry_count} açık kayıt`}
            cents={groups.receivable_cents}
            strong
          />
          <p className="text-xs text-gray-500 mt-2">Tutarlar kliniğin bakış açısıyla gösterilir.</p>
        </Card>

        <Card title={`Aylık sonuçlar · ${formatMonth(data.month)}`}>
          <div className="grid gap-3 mb-4">
            <ResultFigure
              label="Tahsilat esaslı faaliyet sonucu"
              cents={ms.profit_cents}
              explain="Hasta tahsilatları eksi faaliyet giderleri. Seçilen ayda ödenen geçmiş dönem hekim borçları gidere dahildir."
            />
            <ResultFigure
              label="Cari dönem operasyonel sonucu"
              cents={ms.current_period_result_cents}
              explain="Faaliyet sonucuna bu ay ödenen geçmiş dönem hekim hakedişi borçları geri eklenir; ay yalnızca kendi hekim maliyetini taşır."
            />
            <ResultFigure
              label="Tüm ödemeler sonrası kalan"
              cents={ms.after_all_payments_cents}
              explain="Faaliyet tahsilatları (hasta + diğer faaliyet geliri) eksi tüm gerçekleşen ödemeler (kredi anapara, ortak dağıtımı ve demirbaş dahil). Sermaye / borç girişleri sayılmaz."
            />
          </div>
          <MoneyRow label="Faaliyet tahsilatları" cents={ms.profit_income_cents} />
          <MoneyRow label="Faaliyet giderleri" cents={ms.profit_expense_cents} />
          <MoneyRow
            label="Hekim hakedişi"
            cents={expenses.by_bucket.doctor ?? 0}
            hint={`Cari dönem ${formatTL(expenses.current_doctor_cents)} · Geçmiş dönem ${formatTL(expenses.past_doctor_cents)}`}
          />
          <MoneyRow label="Kredi / borç anapara ödemeleri" cents={ms.loan_payments_cents} />
          <MoneyRow label="Diğer çıkışlar (ortak dağıtımı, demirbaş)" cents={ms.other_payments_cents} />
          <MoneyRow label="Toplam gerçekleşen ödeme" cents={ms.outflow_cents} strong />
          <p className="text-xs text-gray-500 mt-3">
            Üç rakam da nakit esaslıdır, tahakkuk esaslı kâr değildir. Blokeli hasta tahsilatları dahildir ve
            hemen kullanılabilir nakit değildir. Ödenmemiş tutarlar sayılmaz.
          </p>
          {settings.physician_fee_note && (
            <p className="text-xs text-gray-600 mt-2">Hekim hakedişi notu: {settings.physician_fee_note}</p>
          )}
        </Card>
      </div>

      <Card title={`Aylık gider dağılımı · ${formatMonth(data.month)}`}>
        <div className="grid gap-x-8 md:grid-cols-2">
          <MoneyRow
            label="Hekim hakedişi"
            cents={expenses.by_bucket.doctor ?? 0}
            hint={`Cari dönem ${formatTL(expenses.current_doctor_cents)} · Geçmiş dönem ${formatTL(expenses.past_doctor_cents)}`}
          />
          {EXPENSE_LINES.map((l) => (
            <MoneyRow key={l.bucket} label={l.label} cents={expenses.by_bucket[l.bucket] ?? 0} />
          ))}
          <MoneyRow label="Genel faaliyet giderleri (Vergi / SGK + Diğer)" cents={expenses.general_cents} />
          <MoneyRow label="Faaliyet giderleri toplamı" cents={expenses.operational_cents} strong />
          <MoneyRow label="Kredi anapara" cents={expenses.by_bucket.principal ?? 0} />
          <MoneyRow label="Demirbaş" cents={expenses.by_bucket.asset ?? 0} />
          <MoneyRow label="Diğer çıkışlar (ortak dağıtımı)" cents={expenses.by_bucket.distribution ?? 0} />
        </div>
      </Card>

      <Card title={`Kategori raporu · ${formatMonth(data.month)}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr className="text-left text-gray-800">
                <th className="px-3 py-2 font-semibold">Kategori</th>
                <th className="px-3 py-2 font-semibold">Yön</th>
                <th className="px-3 py-2 font-semibold text-right">Kayıt</th>
                <th className="px-3 py-2 font-semibold text-right">Ay içi giriş</th>
                <th className="px-3 py-2 font-semibold text-right">Ay içi çıkış</th>
                <th className="px-3 py-2 font-semibold text-right">Açık alacak</th>
                <th className="px-3 py-2 font-semibold text-right">Açık borç</th>
              </tr>
            </thead>
            <tbody>
              {data.category_report.map((r) => (
                <tr key={r.category_id} className="border-b">
                  <td className="px-3 py-2">
                    <Link href={`/finance/entries?category_id=${r.category_id}`} className="hover:underline">
                      {r.name}
                    </Link>
                    {!r.is_active && <span className="text-xs text-gray-500"> (pasif)</span>}
                    <div className="text-xs text-gray-500">{BUCKET_LABELS[r.report_bucket]}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{DIRECTION_LABELS[r.direction]}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.incoming_cents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.outgoing_cents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.open_incoming_cents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.open_outgoing_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Giriş ve çıkış sütunları yalnızca seçilen ayın ödemeleridir; kayıt sayısı ve açık tutarlar ay
          seçiminden bağımsızdır.
        </p>
      </Card>
    </div>
  );
}

function ResultFigure({ label, cents, explain }: { label: string; cents: number; explain: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-gray-600">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${cents < 0 ? "text-red-600" : "text-gray-900"}`}>
        {formatTL(cents)}
      </div>
      <div className="text-xs text-gray-500 mt-1">{explain}</div>
    </div>
  );
}
