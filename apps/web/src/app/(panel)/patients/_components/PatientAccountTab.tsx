"use client";

// Patient 'Hesap' tab (spec p5 §6.3): patient-level figures from pp_patient_account. Remaining amounts are never
// offset across currencies; the TL estimate uses today's latest rates and says so.

import Link from "next/link";
import { useState } from "react";
import { formatDay, formatTimestamp, type FinanceError } from "@/lib/finance";
import {
  CURRENCY_LABELS,
  PLAN_STATUS_LABELS,
  formatMoney,
  formatRate,
  methodLabel,
  type PatientAccountJson,
  type PaymentJson,
} from "@/lib/payments";
import { VoidPaymentDialog } from "../../treatment-plans/_components/VoidPaymentDialog";
import { PaymentStatusBadge } from "../../treatment-plans/_components/payment-ui";

export function PatientAccountTab({
  account,
  loading,
  error,
  includeVoided,
  onIncludeVoided,
  onReload,
}: {
  account: PatientAccountJson | null;
  loading: boolean;
  error: FinanceError | null;
  includeVoided: boolean;
  onIncludeVoided: (v: boolean) => void;
  onReload: () => void;
}) {
  const [voiding, setVoiding] = useState<PaymentJson | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!account) {
    if (loading) return <p className="text-gray-500">Yükleniyor...</p>;
    return (
      <div>
        <p className="text-red-600">{error?.message ?? "Hesap bilgileri yüklenemedi."}</p>
        <button type="button" className="mt-2 text-sm text-blue-600 hover:underline" onClick={onReload}>
          Tekrar dene
        </button>
      </div>
    );
  }

  const est = account.remaining_try_estimate;
  const col = account.collected;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Hesap</h2>
        {loading && <span className="text-sm text-gray-500">Güncelleniyor...</span>}
      </div>
      {error && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{error.message}</div>}
      {message && <div className="p-3 rounded bg-green-50 text-green-800 text-sm">{message}</div>}

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {account.by_currency.map((c) => (
          <div key={c.currency} className="bg-white rounded-lg shadow p-4 text-sm">
            <div className="text-gray-500 mb-2">Planlar · {CURRENCY_LABELS[c.currency] ?? c.currency}</div>
            <Line label="Teklif" value={formatMoney(c.quoted_cents, c.currency)} />
            <Line label="Tahsil (plana yansıyan)" value={formatMoney(c.applied_cents, c.currency)} tone="green" />
            <Line
              label={c.remaining_cents < 0 ? "Fazla ödeme" : "Kalan"}
              value={formatMoney(Math.abs(c.remaining_cents), c.currency)}
              tone={c.remaining_cents > 0 ? "red" : c.remaining_cents < 0 ? "amber" : undefined}
              strong
            />
            {c.currency !== "TRY" && (
              <p className="text-xs text-gray-500 mt-1">Teklif TL (teklif kurlarıyla): {formatMoney(c.quoted_try_cents, "TRY")}</p>
            )}
          </div>
        ))}
        <div className="bg-white rounded-lg shadow p-4 text-sm">
          <div className="text-gray-500 mb-2">Toplam tahsilat (TL karşılığı)</div>
          <div className="text-xl font-bold text-green-700">{formatMoney(col.try_cents, "TRY")}</div>
          <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
            {col.by_currency.map((c) => (
              <li key={c.currency}>
                {formatMoney(c.amount_cents, c.currency)} · {c.count} ödeme
                {c.currency !== "TRY" ? ` · ${formatMoney(c.try_cents, "TRY")}` : ""}
              </li>
            ))}
          </ul>
          {col.cancelled_plans_try_cents > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              İptal edilen planlardaki tahsilat: {formatMoney(col.cancelled_plans_try_cents, "TRY")}
            </p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4 text-sm">
          <div className="text-gray-500 mb-2">Kalan TL (≈ güncel kurla)</div>
          <div className="text-xl font-bold">{est.cents === null ? "—" : `≈ ${formatMoney(est.cents, "TRY")}`}</div>
          {est.rates.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
              {est.rates.map((r) => (
                <li key={r.currency}>
                  1 {r.currency} = {formatRate(r.rate)} ₺ · {formatDay(r.rate_on)}
                </li>
              ))}
            </ul>
          )}
          {est.missing_rates.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">Kur eksik: {est.missing_rates.join(", ")}</p>
          )}
        </div>
      </div>

      {/* Plans */}
      <div>
        <h3 className="text-lg font-semibold mb-2">Planlar</h3>
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr>
                {["Plan", "Durum", "Para birimi", "Teklif", "Teklif TL (kur)", "Tahsil", "Kalan", "Son ödeme"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-800 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {account.plans.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    Tedavi planı bulunamadı
                  </td>
                </tr>
              ) : (
                account.plans.map((p) => (
                  <tr key={p.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3 font-semibold">
                      <Link href={`/treatment-plans/${p.id}`} className="hover:underline">
                        {p.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{PLAN_STATUS_LABELS[p.status] ?? p.status}</td>
                    <td className="px-4 py-3">{p.currency}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatMoney(p.total_cents, p.currency)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatMoney(p.quote_total_try_cents, "TRY")}
                      {p.currency !== "TRY" && <span className="text-xs text-gray-500"> ({formatRate(p.quote_fx_rate)})</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-green-700">{formatMoney(p.applied_cents, p.currency)}</td>
                    <td
                      className={`px-4 py-3 whitespace-nowrap font-semibold ${
                        p.status === "cancelled" ? "text-gray-400" : p.remaining_cents > 0 ? "text-red-600" : ""
                      }`}
                    >
                      {p.remaining_cents < 0
                        ? `Fazla ödeme ${formatMoney(-p.remaining_cents, p.currency)}`
                        : formatMoney(p.remaining_cents, p.currency)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDay(p.last_paid_on)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payments */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="text-lg font-semibold">Ödemeler</h3>
          {account.voided_count > 0 && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeVoided}
                disabled={loading}
                onChange={(e) => onIncludeVoided(e.target.checked)}
              />
              İptal edilenleri göster ({account.voided_count})
            </label>
          )}
        </div>
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr>
                {["Tarih", "Plan", "Tutar", "TL karşılığı", "Yöntem", "Kaydeden", "Durum", ""].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left font-semibold text-gray-800 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {account.payments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    Henüz ödeme kaydı yok.
                  </td>
                </tr>
              ) : (
                account.payments.map((p) => {
                  const voided = !!p.voided_at;
                  return (
                    <tr key={p.id} className="border-b align-top">
                      <td className="px-4 py-3 whitespace-nowrap">{formatDay(p.paid_on)}</td>
                      <td className="px-4 py-3">
                        <Link href={`/treatment-plans/${p.plan_id}`} className="hover:underline">
                          {p.plan_title || "Plan"}
                        </Link>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={voided ? "line-through text-gray-400" : "font-semibold"}>
                          {formatMoney(p.amount_cents, p.currency)}
                        </span>
                        {p.currency !== p.plan_currency && (
                          <div className="text-xs text-gray-500">
                            plana yansıyan {formatMoney(p.applied_plan_cents, p.plan_currency)}
                          </div>
                        )}
                        {p.note && <div className="text-xs text-gray-600 break-words max-w-xs">{p.note}</div>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={voided ? "line-through text-gray-400" : ""}>
                          {formatMoney(p.amount_try_cents, "TRY")}
                        </span>
                        {p.currency !== "TRY" && (
                          <div className="text-xs text-gray-500">
                            1 {p.currency} = {formatRate(p.fx_rate)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">{methodLabel(p.method, p.method_raw)}</td>
                      <td className="px-4 py-3">{p.received_by_name || "Bilinmiyor"}</td>
                      <td className="px-4 py-3">
                        <PaymentStatusBadge payment={p} />
                        {voided && (
                          <div className="text-xs text-red-700 mt-1 break-words max-w-xs">
                            İptal: {p.void_reason} · {p.voided_by_name || "Bilinmiyor"} · {formatTimestamp(p.voided_at)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {account.can_void && !voided && (
                          <button type="button" className="text-red-600 hover:underline" onClick={() => setVoiding(p)}>
                            İptal et
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {account.payments_truncated && (
          <p className="text-xs text-gray-500 mt-2">Yalnızca son 500 ödeme gösteriliyor; toplamlar tüm ödemeleri kapsar.</p>
        )}
      </div>

      {voiding && (
        <VoidPaymentDialog
          payment={voiding}
          onClose={() => setVoiding(null)}
          onVoided={(res) => {
            setVoiding(null);
            setMessage(res.already_saved ? "Bu ödeme zaten iptal edilmişti." : "Ödeme iptal edildi.");
            onReload();
          }}
        />
      )}
    </div>
  );
}

function Line({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "green" | "red" | "amber";
  strong?: boolean;
}) {
  const color =
    tone === "green" ? "text-green-700" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-700" : "text-gray-900";
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-gray-600">{label}</span>
      <span className={`whitespace-nowrap ${strong ? "font-semibold" : ""} ${color}`}>{value}</span>
    </div>
  );
}
