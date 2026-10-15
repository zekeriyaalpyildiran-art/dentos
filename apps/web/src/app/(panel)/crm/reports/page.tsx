"use client";

import { useCallback, useEffect, useState } from "react";
import { AdSpendSection, formatMoney } from "@/components/crm/AdSpendSection";
import { Card, CrmErrorBox, CrmShell, EmptyState, Field, Loading, buttonSecondary, inputClass } from "@/components/crm/ui";
import { useAuthStore } from "@/lib/store";
import { canSeeFinance } from "@/lib/permissions";
import { crmSourceReport, formatTL, toCrmError, type CrmError, type SourceReportJson } from "@/lib/crm";
import { LOSS_REASON_LABELS, sourceLabel } from "@/lib/crm/codes";

/** R20: round(won * 100 / total) + '%', or '—'. */
function conversion(won: number, total: number): string {
  if (!total) return "—";
  return `%${Math.round((won * 100) / total)}`;
}

function multiplierLabel(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  return `${m.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
}

/**
 * Source performance and loss reasons (RP:11-19). Archived leads are excluded. Collections, ad spend and the
 * multiplier are shown only to finance / finance_readonly holders: the server omits those keys for everyone else.
 */
export default function CrmReportsPage() {
  const user = useAuthStore((s) => s.user);
  const financeReader = canSeeFinance(user);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<SourceReportJson | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (from && to && from > to) {
      setRangeError("Başlangıç ayı bitiş ayından sonra olamaz.");
      return;
    }
    setRangeError(null);
    try {
      setData(await crmSourceReport({ p_from_month: from || null, p_to_month: to || null }));
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const money = !!data?.money_visible;
  const maxLoss = Math.max(1, ...(data?.loss_reasons ?? []).map((l) => l.count));
  const totalLoss = (data?.loss_reasons ?? []).reduce((s, l) => s + l.count, 0);

  return (
    <CrmShell title="CRM raporları" subtitle="Başvuru kaynaklarının performansı ve olumsuz sonuç nedenleri.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Başlangıç ayı">
            <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} w-44`} />
          </Field>
          <Field label="Bitiş ayı">
            <input type="month" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputClass} w-44`} />
          </Field>
          {(from || to) && (
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              Tüm zamanlar
            </button>
          )}
        </div>
        {rangeError && <p className="text-sm text-red-600">{rangeError}</p>}
        <CrmErrorBox error={error} />
        {!data ? (
          !error && <Loading />
        ) : (
          <>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
              {[
                { label: "Başvuru", value: String(data.totals.leads) },
                { label: "Randevulu hasta", value: String(data.totals.booked) },
                { label: "Tedavi başladı", value: String(data.totals.won) },
                { label: "Olumsuz sonuç", value: String(data.totals.lost) },
                { label: "Tedaviye dönüşüm", value: conversion(data.totals.won, data.totals.leads) },
              ].map((c) => (
                <div key={c.label} className="bg-white rounded-lg shadow p-4">
                  <div className="text-sm text-gray-600">{c.label}</div>
                  <div className="text-2xl font-bold">{c.value}</div>
                </div>
              ))}
            </div>

            <Card title="Kaynak performansı">
              {data.by_source.length === 0 ? (
                <EmptyState>Bu dönemde başvuru yok.</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b text-gray-600">
                        <th className="py-2 pr-3">Kaynak</th>
                        <th className="py-2 pr-3 text-right">Başvuru</th>
                        <th className="py-2 pr-3 text-right">Randevulu</th>
                        <th className="py-2 pr-3 text-right">Tedavi başladı</th>
                        <th className="py-2 pr-3 text-right">Olumsuz</th>
                        <th className="py-2 pr-3 text-right">Dönüşüm</th>
                        {money && (
                          <>
                            <th className="py-2 pr-3 text-right">Tahsilat</th>
                            <th className="py-2 pr-3 text-right">Reklam harcaması</th>
                            <th className="py-2 text-right">Çarpan</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_source.map((r) => (
                        <tr key={r.source ?? "none"} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium">{sourceLabel(r.source)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.leads}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.booked}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.won}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.lost}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{conversion(r.won, r.leads)}</td>
                          {money && (
                            <>
                              <td className="py-2 pr-3 text-right tabular-nums">{formatTL(r.collections_cents ?? 0)}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">
                                {r.ad_spend && r.ad_spend.length
                                  ? r.ad_spend.map((s) => formatMoney(s.amount_cents, s.currency)).join(" + ")
                                  : "—"}
                              </td>
                              <td className="py-2 text-right tabular-nums">{multiplierLabel(r.multiplier)}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs text-gray-500">
                Arşivlenen adaylar hariçtir. Randevulu hasta: randevu alındı veya sonraki aşamalardaki adaylar.
                {money &&
                  " Tahsilat, bu adaylara bağlı hastaların bugüne kadarki tahsilatıdır; o ayın cirosu değildir. Çarpan yalnızca TL harcamaya göre hesaplanır ve kâr değildir; tedavi maliyetleri dahil değildir."}
              </p>
            </Card>

            <Card title="Olumsuz sonuç nedenleri">
              {data.loss_reasons.length === 0 ? (
                <EmptyState>Bu dönemde olumsuz sonuçlanan aday yok.</EmptyState>
              ) : (
                <ul className="space-y-2">
                  {data.loss_reasons.map((l) => (
                    <li key={l.loss_reason} className="text-sm">
                      <div className="flex justify-between">
                        <span>{LOSS_REASON_LABELS[l.loss_reason] ?? l.loss_reason}</span>
                        <span className="tabular-nums">
                          {l.count} · {conversion(l.count, totalLoss)}
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded">
                        <div className="h-2 bg-red-400 rounded" style={{ width: `${(l.count / maxLoss) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}

        {financeReader && <AdSpendSection onChanged={load} />}
      </div>
    </CrmShell>
  );
}
