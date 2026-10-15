"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card, ErrorBox, Field, Loading, MoneyRow, Pager, inputClass } from "@/components/finance/ui";
import {
  finFinancingList,
  formatDay,
  formatTL,
  isMonth,
  toFinanceError,
  type FinanceError,
  type FinancingFilters,
  type FinancingJson,
  type FinancingListJson,
  type FinancingStatusFilter,
} from "@/lib/finance";
import { CorrectDialog, LinkPatientDialog, ReleaseDialog, VoidDialog } from "./FinancingDialogs";

const PAGE_SIZE = 25;

const STATUS_FILTERS: { value: FinancingStatusFilter; label: string }[] = [
  { value: "all", label: "Tümü (iptaller hariç)" },
  { value: "blocked", label: "Blokede" },
  { value: "needs_check", label: "Bankadan kontrol gerekli" },
  { value: "released", label: "Çözüldü" },
  { value: "unblocked", label: "Blokesiz" },
  { value: "voided", label: "İptal" },
];

type Action = { kind: "release" | "correct" | "void" | "link"; row: FinancingJson };

export function FinancingList({ canWrite, refreshKey, onChanged }: { canWrite: boolean; refreshKey: number; onChanged: (text: string) => void }) {
  const [filters, setFilters] = useState<FinancingFilters>({ status: "all" });
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<FinancingListJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await finFinancingList(filters, { offset, limit: PAGE_SIZE }));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [filters, offset]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const update = (patch: Partial<FinancingFilters>) => {
    setOffset(0);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const done = async (text: string) => {
    setAction(null);
    onChanged(text);
    await load();
  };

  return (
    <Card title="Finansman kayıtları">
      <form
        className="grid gap-4 md:grid-cols-4 items-end mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          update({ query: query.trim() || undefined });
        }}
      >
        <Field label="Durum">
          <select className={inputClass} value={filters.status ?? "all"} onChange={(e) => update({ status: e.target.value as FinancingStatusFilter })}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="İşlem ayı">
          <input type="month" className={inputClass} value={filters.month ?? ""} onChange={(e) => update({ month: isMonth(e.target.value) ? e.target.value : undefined })} />
        </Field>
        <Field label="Hasta adı / referans" className="md:col-span-2">
          <input className={inputClass} value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} onBlur={() => update({ query: query.trim() || undefined })} />
        </Field>
      </form>

      <ErrorBox error={error} onReload={load} />
      {!data ? (
        loading ? <Loading /> : null
      ) : (
        <>
          {loading && <p className="text-sm text-gray-500 mb-2">Güncelleniyor...</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b">
                <tr className="text-left text-gray-800">
                  <th className="px-3 py-2 font-semibold">Hasta / tarih</th>
                  <th className="px-3 py-2 font-semibold text-right">Brüt</th>
                  <th className="px-3 py-2 font-semibold text-right">Kesintiler</th>
                  <th className="px-3 py-2 font-semibold text-right">Net</th>
                  <th className="px-3 py-2 font-semibold">Durum</th>
                  {canWrite && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={canWrite ? 6 : 5} className="px-3 py-6 text-center text-gray-500">
                      Kayıt yok.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.id} className={`border-b align-top ${r.status === "voided" ? "text-gray-400" : ""}`}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.patient_name_raw}</div>
                        <div className="text-xs text-gray-500">
                          {formatDay(r.txn_date)} · {r.reference}
                          {r.patient_name && <> · Hasta kartı: {r.patient_id ? <Link className="text-blue-600 hover:underline" href={`/patients/${r.patient_id}`}>{r.patient_name}</Link> : r.patient_name}</>}
                        </div>
                        {r.corrected_at && <div className="text-xs text-amber-700">Düzeltildi: {r.correction_reason}</div>}
                        {r.voided_at && <div className="text-xs">İptal: {r.void_reason}</div>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.gross_cents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <Link href={`/finance/entries/${r.entry_id}`} className="hover:underline">
                          {formatTL(r.fee_cents)}
                        </Link>
                        <div className="text-xs text-gray-500 whitespace-nowrap">
                          Kom. {formatTL(r.commission_cents)} · KKDF {formatTL(r.kkdf_cents)} · BSMV {formatTL(r.bsmv_cents)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.net_cents)}</td>
                      <td className="px-3 py-2">
                        <StatusCell row={r} />
                      </td>
                      {canWrite && (
                        <td className="px-3 py-2 text-right whitespace-nowrap space-y-1">
                          {r.status === "blocked" && !r.released_on && (
                            <button type="button" className="block ml-auto text-blue-600 hover:underline" onClick={() => setAction({ kind: "release", row: r })}>
                              Bloke çözülmesini doğrula
                            </button>
                          )}
                          {r.status !== "voided" && (
                            <>
                              <button type="button" className="block ml-auto text-blue-600 hover:underline" onClick={() => setAction({ kind: "correct", row: r })}>
                                Düzelt
                              </button>
                              <button type="button" className="block ml-auto text-red-600 hover:underline" onClick={() => setAction({ kind: "void", row: r })}>
                                İptal et
                              </button>
                            </>
                          )}
                          <button type="button" className="block ml-auto text-blue-600 hover:underline" onClick={() => setAction({ kind: "link", row: r })}>
                            Hasta kartına bağla
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
          <div className="mt-4 grid gap-x-8 md:grid-cols-3 bg-gray-50 border rounded p-3">
            <MoneyRow label="Listedeki brüt" cents={data.totals.gross_cents} />
            <MoneyRow label="Listedeki kesintiler" cents={data.totals.fee_cents} />
            <MoneyRow label="Listedeki net" cents={data.totals.net_cents} />
          </div>
        </>
      )}

      {action?.kind === "release" && data && (
        <ReleaseDialog row={action.row} today={data.today} onClose={() => setAction(null)} onDone={done} onReload={load} />
      )}
      {action?.kind === "correct" && data && (
        <CorrectDialog row={action.row} today={data.today} onClose={() => setAction(null)} onDone={done} onReload={load} />
      )}
      {action?.kind === "void" && <VoidDialog row={action.row} onClose={() => setAction(null)} onDone={done} onReload={load} />}
      {action?.kind === "link" && <LinkPatientDialog row={action.row} onClose={() => setAction(null)} onDone={done} onReload={load} />}
    </Card>
  );
}

function StatusCell({ row }: { row: FinancingJson }) {
  switch (row.status) {
    case "voided":
      return <span>İptal</span>;
    case "unblocked":
      return <span>Blokesiz</span>;
    case "released":
      return <span className="text-green-700">Çözüldü: {formatDay(row.released_on)}</span>;
    default:
      return (
        <div>
          <b>Blokede</b>
          <div className="text-xs text-gray-500">Tahmini: {formatDay(row.expected_release)}</div>
          {row.needs_check && <div className="text-xs font-semibold text-amber-700">Bankadan kontrol gerekli</div>}
        </div>
      );
  }
}
