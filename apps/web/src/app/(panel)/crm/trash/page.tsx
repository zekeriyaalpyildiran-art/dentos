"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PhoneMatchesList } from "@/components/crm/PhoneMatches";
import {
  CrmErrorBox,
  CrmShell,
  EmptyState,
  Loading,
  Pager,
  StageBadge,
  SuccessBox,
  buttonSecondary,
} from "@/components/crm/ui";
import {
  crmRestoreLead,
  crmTrashList,
  formatDateTime,
  toCrmError,
  type CrmError,
  type PhoneMatchesJson,
  type TrashRow,
} from "@/lib/crm";

const PAGE = 50;

/** Trashed leads (TR:12-16). Restoring keeps history, calls and handoffs; a shared phone only warns. */
export default function CrmTrashPage() {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<CrmError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [matches, setMatches] = useState<PhoneMatchesJson | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await crmTrashList({ p_page: { offset, limit: PAGE } });
      setRows(r.rows);
      setTotal(r.total_count);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
      setRows([]);
    }
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = async (row: TrashRow) => {
    setBusyId(row.id);
    setError(null);
    try {
      const r = await crmRestoreLead({ p_lead_id: row.id, p_version: row.version });
      setMessage(`${row.full_name} çöp kutusundan geri getirildi.`);
      setMatches(r.phone_matches);
      await load();
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <CrmShell title="Çöp kutusu" subtitle="Çöp kutusundaki hastalar listelerde, raporlarda ve iş listesinde görünmez.">
      <div className="space-y-4">
        <SuccessBox text={message} />
        <PhoneMatchesList matches={matches} />
        <CrmErrorBox error={error} onReload={load} />
        {!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-lg shadow">
            <EmptyState>Çöp kutusu boş.</EmptyState>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 border-b">
                <tr className="text-left">
                  <th className="px-4 py-3">Ad soyad</th>
                  <th className="px-4 py-3">Telefon</th>
                  <th className="px-4 py-3">Aşama</th>
                  <th className="px-4 py-3">Silinme</th>
                  <th className="px-4 py-3 text-right">Arama</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-b-0">
                    <td className="px-4 py-3">
                      <Link href={`/crm/leads/${r.id}`} className="font-medium text-blue-700 hover:underline">
                        {r.full_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{r.phone}</td>
                    <td className="px-4 py-3">
                      <StageBadge stage={r.stage} />
                    </td>
                    <td className="px-4 py-3">
                      {formatDateTime(r.deleted_at)}
                      {r.deleted_by_name ? ` · ${r.deleted_by_name}` : ""}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.call_count}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className={buttonSecondary}
                        disabled={busyId === r.id}
                        onClick={() => restore(r)}
                      >
                        Geri getir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 pb-4">
              <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />
            </div>
          </div>
        )}
      </div>
    </CrmShell>
  );
}
