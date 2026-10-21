"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card, ErrorBox, Field, Loading, Modal, Pager, inputClass, buttonSecondary } from "@/components/finance/ui";
import {
  STATUS_LABELS,
  finImportBatch,
  finImportHistory,
  formatDay,
  formatMonth,
  formatTL,
  formatTimestamp,
  isMonth,
  toFinanceError,
  type FinanceError,
  type ImportBatchJson,
  type ImportBatchSourceJson,
  type ImportHistoryFilters,
  type Paged,
} from "@/lib/finance";

const PAGE_SIZE = 25;

const KIND_LABELS: Record<ImportBatchJson["kind"], string> = {
  rows: "Dosyadan aktarım",
  financing: "Hasta finansmanı",
};

const SOURCE_KIND_LABELS: Record<string, string> = {
  clinic_excel: "Klinik Excel",
  bank_known: "Banka dökümü",
  bank_table: "Banka tablosu (eşleştirme)",
  financing: "Hasta finansmanı",
  migration: "Eski sistemden",
};

/** fin_import_history + fin_import_batch: read-only for finance and finance_readonly. */
export function ImportHistory() {
  const [filters, setFilters] = useState<ImportHistoryFilters>({});
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<({ rows: ImportBatchJson[] } & Paged) | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<ImportBatchJson | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await finImportHistory(filters, { offset, limit: PAGE_SIZE }));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [filters, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (patch: Partial<ImportHistoryFilters>) => {
    setOffset(0);
    setFilters((f) => ({ ...f, ...patch }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="grid gap-4 md:grid-cols-4 items-end">
          <Field label="Tür">
            <select
              className={inputClass}
              value={filters.kind ?? ""}
              onChange={(e) => update({ kind: (e.target.value || undefined) as ImportHistoryFilters["kind"] })}
            >
              <option value="">Tümü</option>
              <option value="rows">Dosyadan aktarım</option>
              <option value="financing">Hasta finansmanı</option>
            </select>
          </Field>
          <Field label="Aktarım ayı">
            <input
              type="month"
              className={inputClass}
              value={filters.month ?? ""}
              onChange={(e) => update({ month: isMonth(e.target.value) ? e.target.value : undefined })}
            />
          </Field>
          <Field label="Kayıt tarihi (başlangıç)">
            <input
              type="date"
              className={inputClass}
              value={filters.date_from ?? ""}
              onChange={(e) => update({ date_from: e.target.value || undefined })}
            />
          </Field>
          <Field label="Kayıt tarihi (bitiş)">
            <input
              type="date"
              className={inputClass}
              value={filters.date_to ?? ""}
              onChange={(e) => update({ date_to: e.target.value || undefined })}
            />
          </Field>
        </div>
      </Card>

      <ErrorBox error={error} onReload={load} />
      {!data ? (
        loading ? <Loading /> : null
      ) : (
        <Card title="Aktarımlar">
          {loading && <p className="text-sm text-gray-500 mb-2">Güncelleniyor...</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b">
                <tr className="text-left text-gray-800">
                  <th className="px-3 py-2 font-semibold">Kayıt zamanı</th>
                  <th className="px-3 py-2 font-semibold">Tür / ay</th>
                  <th className="px-3 py-2 font-semibold">Dosyalar</th>
                  <th className="px-3 py-2 font-semibold text-right">Gönderilen</th>
                  <th className="px-3 py-2 font-semibold text-right">Eklenen</th>
                  <th className="px-3 py-2 font-semibold text-right">Borca işlenen</th>
                  <th className="px-3 py-2 font-semibold text-right">Atlanan</th>
                  <th className="px-3 py-2 font-semibold text-right">Uyarı onaylı</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-gray-500">
                      Henüz aktarım yok.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((b) => (
                    <tr key={b.id} className="border-b align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatTimestamp(b.created_at)}
                        <div className="text-xs text-gray-500">{b.created_by_name ?? "—"}</div>
                      </td>
                      <td className="px-3 py-2">
                        {KIND_LABELS[b.kind]}
                        {b.month && <div className="text-xs text-gray-500">{formatMonth(b.month)}</div>}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700 max-w-xs break-words">
                        {b.file_names.length ? b.file_names.join(", ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.rows_sent}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.inserted}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.matched}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.skipped}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.acknowledged}</td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setOpen(b)}>
                          Ayrıntı
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
        </Card>
      )}

      {open && <BatchDialog batch={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function BatchDialog({ batch, onClose }: { batch: ImportBatchJson; onClose: () => void }) {
  const [sources, setSources] = useState<ImportBatchSourceJson[] | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);

  useEffect(() => {
    let alive = true;
    finImportBatch(batch.id)
      .then((r) => alive && setSources(r.sources))
      .catch((err) => alive && setError(toFinanceError(err)));
    return () => {
      alive = false;
    };
  }, [batch.id]);

  return (
    <Modal title={`${KIND_LABELS[batch.kind]} · ${formatTimestamp(batch.created_at)}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-gray-700">
          {batch.inserted} kayıt eklendi; {batch.matched} ödeme mevcut borca işlendi; {batch.skipped} tekrar
          atlandı.
          {batch.acknowledged > 0 && ` ${batch.acknowledged} satır uyarı onaylanarak kaydedildi.`}
        </p>
        <ErrorBox error={error} />
        {!sources && !error && <Loading />}
        {sources && (
          <div className="max-h-[60vh] overflow-y-auto divide-y text-sm">
            {sources.length === 0 && <p className="text-gray-500 py-2">Bu aktarıma bağlı kaynak satırı yok.</p>}
            {sources.map((s) => (
              <div key={s.source_key} className="py-2">
                <div className="flex justify-between gap-4">
                  <div>
                    <Link href={`/finance/entries/${s.entry_id}`} className="text-blue-700 hover:underline font-medium">
                      {s.entry?.counterparty_name ?? "Kayıt"}
                    </Link>
                    <span className="text-gray-500">
                      {" "}
                      · {formatDay(s.txn_date)} · {SOURCE_KIND_LABELS[s.source_kind] ?? s.source_kind}
                      {s.link_kind === "payment_match" && " · mevcut borca ödeme"}
                    </span>
                    <div className="text-xs text-gray-500">
                      {s.file_name ?? "—"}
                      {s.entry && ` · ${s.entry.category_name} · ${STATUS_LABELS[s.entry.status]}`}
                      {s.payment_is_voided && <span className="text-red-600"> · ödeme iptal edildi</span>}
                      {s.rebind_count > 0 && ` · yeniden bağlandı (${s.rebind_count})`}
                    </div>
                  </div>
                  <div className="tabular-nums whitespace-nowrap">{formatTL(s.amount_cents)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <button type="button" className={buttonSecondary} onClick={onClose}>
          Kapat
        </button>
      </div>
    </Modal>
  );
}
