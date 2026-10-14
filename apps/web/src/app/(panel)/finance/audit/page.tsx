"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { AuditChanges } from "@/components/finance/AuditChanges";
import { ErrorBox, Field, Loading, Pager, buttonSecondary, inputClass } from "@/components/finance/ui";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  finAuditList,
  formatTimestamp,
  toFinanceError,
  type AuditEntityType,
  type AuditFilters,
  type AuditListJson,
  type FinanceError,
} from "@/lib/finance";

const PAGE_SIZE = 50;

export default function FinanceAuditPage() {
  return (
    <FinanceShell title="Finans geçmişi">
      <AuditList />
    </FinanceShell>
  );
}

/** p2 §3.6 fin_audit_list: every change to finance rows, newest first. Nothing in finance is ever deleted. */
function AuditList() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AuditListJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const rangeError =
    filters.date_from && filters.date_to && filters.date_from > filters.date_to
      ? "Başlangıç tarihi bitiş tarihinden sonra olamaz."
      : null;

  const load = useCallback(async () => {
    if (rangeError) return;
    setLoading(true);
    try {
      setData(await finAuditList(filters, { offset, limit: PAGE_SIZE }));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [filters, offset, rangeError]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (patch: Partial<AuditFilters>) => {
    setOffset(0);
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  const entryLink = (entityType: string, entityId: string, after: Record<string, unknown> | null) => {
    if (entityType === "fin_entries") return `/finance/entries/${entityId}`;
    if (entityType === "fin_payments" && typeof after?.entry_id === "string") return `/finance/entries/${after.entry_id}`;
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg shadow grid gap-4 md:grid-cols-4">
        <Field label="Kayıt türü">
          <select
            className={inputClass}
            value={filters.entity_type ?? ""}
            onChange={(e) => update({ entity_type: (e.target.value || undefined) as AuditEntityType | undefined })}
          >
            <option value="">Tümü</option>
            {Object.entries(AUDIT_ENTITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Başlangıç">
          <input type="date" className={inputClass} value={filters.date_from ?? ""} onChange={(e) => update({ date_from: e.target.value || undefined })} />
        </Field>
        <Field label="Bitiş">
          <input type="date" className={inputClass} value={filters.date_to ?? ""} onChange={(e) => update({ date_to: e.target.value || undefined })} />
        </Field>
        <div className="flex items-end">
          <button type="button" className={buttonSecondary} onClick={() => update({ entity_type: undefined, date_from: undefined, date_to: undefined })}>
            Filtreleri temizle
          </button>
        </div>
      </div>

      {rangeError && <div className="p-4 rounded bg-red-50 text-red-700 text-sm">{rangeError}</div>}
      <ErrorBox error={error} onReload={load} />

      {!data ? (
        loading ? <Loading /> : null
      ) : (
        <div className="bg-white rounded-lg shadow">
          {loading && <p className="text-sm text-gray-500 px-4 pt-3">Güncelleniyor...</p>}
          {data.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-gray-500">Kayıt yok.</p>
          ) : (
            <ul className="divide-y">
              {data.rows.map((r) => {
                const href = entryLink(r.entity_type, r.entity_id, r.after_data);
                return (
                  <li key={r.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-gray-900">
                      <span className="font-medium">{formatTimestamp(r.at)}</span>
                      <span>· {r.user_name ?? "Sistem"}</span>
                      <span>
                        · {AUDIT_ENTITY_LABELS[r.entity_type] ?? r.entity_type}{" "}
                        {(AUDIT_ACTION_LABELS[r.action] ?? r.action).toLocaleLowerCase("tr-TR")}
                      </span>
                      {href && (
                        <Link href={href} className="text-blue-600 hover:underline">
                          Kaydı aç
                        </Link>
                      )}
                    </div>
                    <AuditChanges action={r.action} changes={r.changes} before={r.before_data} after={r.after_data} />
                  </li>
                );
              })}
            </ul>
          )}
          <div className="px-4 pb-4">
            <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
          </div>
        </div>
      )}
    </div>
  );
}
