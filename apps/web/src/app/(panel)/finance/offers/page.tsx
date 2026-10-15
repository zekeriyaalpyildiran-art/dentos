"use client";

// /finance/offers: "Teklifler ve tahsilat" (spec p5 §6.4). fin_patient_offers needs finance or finance_readonly.
// Totals are the server's figures over the whole filter, never only the page. Read-only: nothing here writes.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { Card, ErrorBox, Field, Loading, Pager, buttonSecondary, inputClass } from "@/components/finance/ui";
import { formatDay, isMonth, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  CURRENCIES,
  CURRENCY_LABELS,
  PLAN_STATUS_LABELS,
  formatMoney,
  formatRate,
  finPatientOffers,
  type Currency,
  type OfferFilters,
  type OfferSort,
  type OfferStatusFilter,
  type OffersJson,
} from "@/lib/payments";

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: OfferStatusFilter; label: string }[] = [
  { value: "active", label: "Aktif planlar" },
  { value: "open", label: "Açık planlar" },
  { value: "cancelled", label: "İptal" },
  { value: "all", label: "Tümü" },
];

const SORT_OPTIONS: { value: OfferSort; label: string }[] = [
  { value: "created_desc", label: "Yeni planlar önce" },
  { value: "remaining_try_desc", label: "Kalan TL (büyükten küçüğe)" },
  { value: "last_payment_desc", label: "Son ödeme (yeniden eskiye)" },
];

export default function FinanceOffersPage() {
  return (
    <FinanceShell title="Teklifler ve tahsilat">
      <Offers />
    </FinanceShell>
  );
}

function Offers() {
  const [status, setStatus] = useState<OfferStatusFilter>("active");
  const [onlyRemaining, setOnlyRemaining] = useState(true);
  const [currency, setCurrency] = useState<Currency | "">("");
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");
  const [sort, setSort] = useState<OfferSort>("created_desc");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<OffersJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  // Search is sent after a short pause; the server matches with Turkish case folding. Kept out of the URL (names).
  useEffect(() => {
    const trimmed = queryInput.trim();
    if (trimmed === query) return;
    const t = setTimeout(() => {
      setOffset(0);
      setQuery(trimmed);
    }, 350);
    return () => clearTimeout(t);
  }, [queryInput, query]);

  const rangeError =
    fromMonth && toMonth && fromMonth > toMonth ? "Başlangıç ayı bitiş ayından sonra olamaz." : null;

  const load = useCallback(async () => {
    if (rangeError) return;
    setLoading(true);
    const filters: OfferFilters = {
      status,
      // A cancelled plan has no remaining amount (§3), so the checkbox does not apply to 'İptal'.
      only_remaining: status === "cancelled" ? false : onlyRemaining,
      currency: currency || undefined,
      query: query ? query.toLocaleLowerCase("tr-TR").slice(0, 100) : undefined,
      from_month: isMonth(fromMonth) ? fromMonth : undefined,
      to_month: isMonth(toMonth) ? toMonth : undefined,
      sort,
    };
    try {
      setData(await finPatientOffers(filters, { offset, limit: PAGE_SIZE }));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [status, onlyRemaining, currency, query, fromMonth, toMonth, sort, offset, rangeError]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = <T,>(setter: (v: T) => void) => (v: T) => {
    setOffset(0);
    setter(v);
  };

  const totals = data?.totals;
  const total = data?.total_count ?? totals?.count ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700">
        Hasta tedavi planlarının teklif tutarları ve DentOS&apos;ta kaydedilen hasta ödemeleri. Kalan tutarlar planın kendi
        para birimindedir; TL karşılıkları teklif ve ödeme günlerinin kurlarıyla, kalan TL ise güncel kurla yaklaşık
        hesaplanır. Bu ekran finans defterine kayıt yapmaz.
      </p>

      <div className="bg-white p-4 rounded-lg shadow">
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Ara" className="md:col-span-2">
            <input
              className={inputClass}
              placeholder="Hasta adı veya plan başlığı"
              value={queryInput}
              maxLength={100}
              onChange={(e) => setQueryInput(e.target.value)}
            />
          </Field>
          <Field label="Durum">
            <select
              className={inputClass}
              value={status}
              onChange={(e) => change(setStatus)(e.target.value as OfferStatusFilter)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Para birimi">
            <select
              className={inputClass}
              value={currency}
              onChange={(e) => change(setCurrency)(e.target.value as Currency | "")}
            >
              <option value="">Tümü</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sıralama" className="xl:col-span-2">
            <select className={inputClass} value={sort} onChange={(e) => change(setSort)(e.target.value as OfferSort)}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Plan ayı (başlangıç)">
            <input
              type="month"
              className={inputClass}
              value={fromMonth}
              onChange={(e) => change(setFromMonth)(e.target.value)}
            />
          </Field>
          <Field label="Plan ayı (bitiş)">
            <input type="month" className={inputClass} value={toMonth} onChange={(e) => change(setToMonth)(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-800 md:mt-6">
            <input
              type="checkbox"
              checked={status === "cancelled" ? false : onlyRemaining}
              disabled={status === "cancelled"}
              onChange={(e) => change(setOnlyRemaining)(e.target.checked)}
            />
            Yalnızca kalanı olanlar
          </label>
          <div className="flex items-end xl:col-span-3">
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                setOffset(0);
                setStatus("active");
                setOnlyRemaining(true);
                setCurrency("");
                setFromMonth("");
                setToMonth("");
                setSort("created_desc");
                setQueryInput("");
                setQuery("");
              }}
            >
              Filtreleri temizle
            </button>
          </div>
        </div>
      </div>

      {rangeError && <div className="p-4 rounded bg-red-50 text-red-700 text-sm">{rangeError}</div>}
      <ErrorBox error={error} />

      {!data && loading ? (
        <Loading />
      ) : data && totals ? (
        <>
          {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {totals.by_currency.map((c) => (
              <Card key={c.currency} title={`${CURRENCY_LABELS[c.currency] ?? c.currency} planlar`}>
                <SumLine label="Teklif" value={formatMoney(c.total_cents, c.currency)} />
                <SumLine label="Tahsil (plana yansıyan)" value={formatMoney(c.applied_cents, c.currency)} tone="green" />
                <SumLine
                  label={c.remaining_cents < 0 ? "Fazla ödeme" : "Kalan"}
                  value={formatMoney(Math.abs(c.remaining_cents), c.currency)}
                  tone={c.remaining_cents > 0 ? "red" : undefined}
                  strong
                />
              </Card>
            ))}
            <Card title="TL karşılıkları">
              <SumLine label="Teklif TL (teklif kurlarıyla)" value={formatMoney(totals.quote_try_cents, "TRY")} />
              <SumLine
                label="Tahsilat TL (ödeme kurlarıyla)"
                value={formatMoney(totals.collected_try_cents, "TRY")}
                tone="green"
              />
              <SumLine
                label="Kalan TL (≈ güncel kurla)"
                value={
                  totals.remaining_try_estimate_cents === null
                    ? "—"
                    : `≈ ${formatMoney(totals.remaining_try_estimate_cents, "TRY")}`
                }
                strong
              />
              {totals.rates.length > 0 && (
                <p className="text-xs text-gray-500 mt-2">
                  {totals.rates
                    .map((r) => `1 ${r.currency} = ${formatRate(r.rate)} ₺ (${formatDay(r.rate_on)})`)
                    .join(" · ")}
                </p>
              )}
              {totals.missing_rates.length > 0 && (
                <p className="text-xs text-amber-700 mt-1">Kur eksik: {totals.missing_rates.join(", ")}</p>
              )}
            </Card>
          </div>
          <p className="text-xs text-gray-500">
            Toplamlar filtreye uyan {totals.count.toLocaleString("tr-TR")} planın tamamını kapsar.
          </p>

          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b">
                <tr>
                  {[
                    "Hasta",
                    "Plan",
                    "Hekim",
                    "Durum",
                    "Tarih",
                    "Teklif",
                    "Teklif TL",
                    "Tahsil",
                    "Kalan",
                    "Kalan TL ≈",
                    "Son ödeme",
                  ].map((h) => (
                    <th key={h} className="px-3 py-3 text-left font-semibold text-gray-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-8 text-center text-gray-500">
                      Filtreye uyan plan yok.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.plan_id} className="border-b hover:bg-gray-50 align-top">
                      <td className="px-3 py-2">
                        <Link href={`/patients/${r.patient_id}?tab=account`} className="text-blue-600 hover:underline">
                          {r.patient_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/treatment-plans/${r.plan_id}`} className="hover:underline">
                          {r.plan_title}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{r.doctor_name || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{PLAN_STATUS_LABELS[r.status] ?? r.status}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDay(r.created_on)}</td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatMoney(r.total_cents, r.currency)}</td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {formatMoney(r.quote_total_try_cents, "TRY")}
                        {r.currency !== "TRY" && (
                          <div className="text-xs text-gray-500">kur {formatRate(r.quote_fx_rate)}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums text-green-700">
                        {formatMoney(r.applied_cents, r.currency)}
                        {r.currency !== "TRY" && (
                          <div className="text-xs text-gray-500">{formatMoney(r.collected_try_cents, "TRY")}</div>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${
                          r.remaining_cents > 0 ? "text-red-600" : r.remaining_cents < 0 ? "text-amber-700" : ""
                        }`}
                      >
                        {r.remaining_cents < 0
                          ? `Fazla ${formatMoney(-r.remaining_cents, r.currency)}`
                          : formatMoney(r.remaining_cents, r.currency)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {r.remaining_try_estimate_cents === null
                          ? r.currency === "TRY"
                            ? "—"
                            : "Kur eksik"
                          : `≈ ${formatMoney(r.remaining_try_estimate_cents, "TRY")}`}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDay(r.last_paid_on)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager
            offset={data.offset ?? offset}
            limit={data.limit ?? PAGE_SIZE}
            total={total}
            onChange={setOffset}
            disabled={loading}
          />
        </>
      ) : null}
    </div>
  );
}

function SumLine({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "green" | "red";
  strong?: boolean;
}) {
  const color = tone === "green" ? "text-green-700" : tone === "red" ? "text-red-600" : "text-gray-900";
  return (
    <div className="flex justify-between gap-4 py-2 border-b last:border-b-0">
      <span className={strong ? "font-semibold text-gray-900" : "text-gray-700"}>{label}</span>
      <span className={`text-right whitespace-nowrap tabular-nums ${strong ? "font-semibold" : ""} ${color}`}>{value}</span>
    </div>
  );
}
