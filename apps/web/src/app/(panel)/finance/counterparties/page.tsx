"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { CounterpartyDialog } from "@/components/finance/CounterpartyDialog";
import { useReferenceData } from "@/components/finance/useReferenceData";
import { Card, ErrorBox, Loading, MoneyRow, Pager, SuccessBox, buttonPrimary, inputClass } from "@/components/finance/ui";
import {
  COUNTERPARTY_KIND_LABELS,
  finCounterpartyLedger,
  formatDay,
  formatTL,
  stashDrillText,
  toFinanceError,
  type CounterpartyJson,
  type FinanceError,
  type LedgerJson,
  type LedgerRowJson,
} from "@/lib/finance";

const PAGE_SIZE = 50;

export default function FinanceCounterpartiesPage() {
  return (
    <FinanceShell title="Cariler">
      <Ledger />
    </FinanceShell>
  );
}

type DialogState = { record: CounterpartyJson | null; initialName?: string };

/**
 * Ids may go in the URL; a free-text name never does. It is stashed (in memory / sessionStorage) at click time and
 * the URL only carries a random reference, so the name stays out of browser history and Vercel request logs.
 */
function drillDownHref(row: LedgerRowJson): string {
  if (row.counterparty_id) return `/finance/entries?counterparty_id=${row.counterparty_id}`;
  return `/finance/entries?cp_ref=${stashDrillText(row.counterparty_text ?? row.name)}`;
}

/** Legacy 'Cariler' tab (FM:78-82, FP:70) plus the master list (p2 §3.5 fin_counterparty_ledger). */
function Ledger() {
  const router = useRouter();
  const canWrite = useCanWriteFinance();
  const ref = useReferenceData();
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [includeSettled, setIncludeSettled] = useState(false);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<LedgerJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = queryInput.trim().toLocaleLowerCase("tr-TR");
      if (next !== query) {
        setOffset(0);
        setQuery(next);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [queryInput, query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await finCounterpartyLedger(query || null, includeSettled, offset, PAGE_SIZE));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [query, includeSettled, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = (row: LedgerRowJson) => {
    if (!ref.data) return;
    if (row.counterparty_id) {
      const record = ref.data.counterparties.find((c) => c.id === row.counterparty_id);
      if (record) setDialog({ record });
    } else {
      setDialog({ record: null, initialName: row.name });
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow flex flex-wrap items-end gap-4">
        <label className="block flex-1 min-w-[14rem]">
          <span className="block text-sm font-semibold mb-1 text-gray-800">Ara</span>
          <input
            className={inputClass}
            placeholder="Kişi / kurum adı"
            maxLength={100}
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-800 pb-2">
          <input
            type="checkbox"
            checked={includeSettled}
            onChange={(e) => {
              setOffset(0);
              setIncludeSettled(e.target.checked);
            }}
          />
          Açık tutarı olmayanları da göster
        </label>
        {canWrite && (
          <button type="button" className={buttonPrimary} disabled={!ref.data} onClick={() => setDialog({ record: null })}>
            Yeni kişi / kurum
          </button>
        )}
      </div>

      <SuccessBox text={message} />
      <ErrorBox error={error ?? ref.error} onReload={load} />

      {!data ? (
        loading ? <Loading /> : null
      ) : (
        <>
          <Card title="Toplam">
            <div className="grid gap-x-8 md:grid-cols-3">
              <MoneyRow label="Kliniğin alacağı" cents={data.totals.receivable_cents} />
              <MoneyRow label="Kliniğin borcu" cents={data.totals.payable_cents} />
              <MoneyRow label="Net alacak / borç" cents={data.totals.net_cents} tone="auto" strong />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Yalnızca açık (kalan) tutarlar. Kayıtlı kişi / kurumlar tek satırda birleşir; serbest metinle girilen
              adlar için aynı yazımı kullanın.
            </p>
          </Card>

          {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b">
                <tr className="text-left text-gray-800">
                  <th className="px-4 py-3 font-semibold">Kişi / kurum</th>
                  <th className="px-4 py-3 font-semibold text-right">Kliniğin alacağı</th>
                  <th className="px-4 py-3 font-semibold text-right">Kliniğin borcu</th>
                  <th className="px-4 py-3 font-semibold text-right">Net alacak / borç</th>
                  <th className="px-4 py-3 font-semibold text-right">Toplam ödenen / tahsil edilen</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      Kayıt yok.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row) => (
                    <tr key={row.counterparty_id ?? `text:${row.name}`} className="border-b align-top text-gray-900">
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {row.name}
                          {row.is_active === false && <span className="text-xs text-gray-500"> (pasif)</span>}
                        </div>
                        <div className="text-xs text-gray-500">
                          {row.counterparty_id
                            ? [
                                row.kind ? COUNTERPARTY_KIND_LABELS[row.kind] : null,
                                row.doctor_name ? `Hekim: ${row.doctor_name}` : null,
                                row.report_group_name ? `Grup: ${row.report_group_name}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : "Serbest metin (kayıtlı değil)"}
                        </div>
                        <div className="text-xs text-gray-500">
                          {row.open_entry_count} açık kayıt
                          {row.last_due_date ? ` · son vade ${formatDay(row.last_due_date)}` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatTL(row.receivable_cents)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatTL(row.payable_cents)}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-medium ${row.net_cents < 0 ? "text-red-600" : "text-green-700"}`}>
                        {formatTL(row.net_cents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-xs text-gray-600">
                        <div>Ödenen {formatTL(row.paid_out_cents)}</div>
                        <div>Tahsil edilen {formatTL(row.paid_in_cents)}</div>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {row.counterparty_id ? (
                          <Link href={drillDownHref(row)} className="text-blue-600 hover:underline mr-3">
                            Kayıtlar
                          </Link>
                        ) : (
                          <button
                            type="button"
                            className="text-blue-600 hover:underline mr-3"
                            onClick={() => router.push(drillDownHref(row))}
                          >
                            Kayıtlar
                          </button>
                        )}
                        {canWrite && (
                          <button type="button" className="text-blue-600 hover:underline" disabled={!ref.data} onClick={() => openEdit(row)}>
                            {row.counterparty_id ? "Düzenle" : "Kayıt olarak ekle"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
        </>
      )}

      {dialog && ref.data && (
        <CounterpartyDialog
          key={dialog.record?.id ?? `new:${dialog.initialName ?? ""}`}
          refData={ref.data}
          record={dialog.record}
          initialName={dialog.initialName}
          onClose={() => setDialog(null)}
          onReload={() => {
            setDialog(null);
            ref.reload();
          }}
          onOpenExisting={(existing) => setDialog({ record: existing })}
          onSaved={async (saved, alreadySaved) => {
            setDialog(null);
            // Free-text entries with the same name are counted under the new record right away (read-side
            // resolution by normalized name in the database), so the text row disappears from the list.
            setMessage(
              alreadySaved
                ? `${saved.name} zaten kayıtlıydı.`
                : `${saved.name} kaydedildi. Aynı adla yazılmış kayıtlar artık bu kişi / kurum altında görünür.`
            );
            await Promise.all([ref.reload(), load()]);
          }}
        />
      )}
    </div>
  );
}
