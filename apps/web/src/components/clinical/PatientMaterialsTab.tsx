"use client";

// Patient "Sarf" tab (spec p9_clinical §7.5): materials issued to the patient from stock_movements.patient_id,
// net of returns and corrections. Read-only for everyone.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clinPatientMaterials,
  toClinicalError,
  type ClinicalError,
  type MaterialRow,
  type MaterialTotal,
} from "@/lib/clinical/rpc";
import { formatDecimalTr, formatTl } from "@/lib/clinical/numbers";
import { MaterialTable, hasCostKeys } from "./MaterialTable";
import { ClinicalNotice, EmptyState, Loading, MoreButton } from "./ui";

const PAGE_SIZE = 50;

export function PatientMaterialsTab({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<MaterialRow[]>([]);
  const [totals, setTotals] = useState<MaterialTotal[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    const r = ++req.current;
    setLoading(true);
    try {
      const res = await clinPatientMaterials(patientId, { offset: 0, limit: PAGE_SIZE });
      if (r !== req.current) return;
      setRows(res.rows || []);
      setTotals(res.totals || []);
      setTotal(res.total ?? 0);
      setError(null);
    } catch (err) {
      if (r === req.current) setError(toClinicalError(err));
    } finally {
      if (r === req.current) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    setMoreBusy(true);
    try {
      const res = await clinPatientMaterials(patientId, { offset: rows.length, limit: PAGE_SIZE });
      setRows((prev) => [...prev, ...(res.rows || [])]);
      setTotal(res.total ?? total);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setMoreBusy(false);
    }
  };

  const showCost = hasCostKeys(totals) || hasCostKeys(rows);

  return (
    <div className="space-y-4 text-gray-900">
      <h2 className="text-xl font-semibold">Kullanılan malzemeler</h2>
      <ClinicalNotice error={error} />
      {loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 && !error ? (
        <EmptyState title="Bu hastaya stoktan malzeme kullanımı kaydedilmemiş." />
      ) : (
        <>
          {totals.length > 0 && (
            <div className="bg-white rounded-lg shadow overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-left text-gray-800">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Ürün</th>
                    <th className="px-4 py-2 font-semibold text-right">Net miktar</th>
                    {showCost && <th className="px-4 py-2 font-semibold text-right">Maliyet</th>}
                  </tr>
                </thead>
                <tbody>
                  {totals.map((t) => (
                    <tr key={t.stock_item_id} className="border-b last:border-b-0">
                      <td className="px-4 py-2">{t.item_name}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                        {formatDecimalTr(t.net_qty)} {t.usage_unit}
                      </td>
                      {showCost && (
                        <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                          {t.cost_cents !== undefined && t.cost_cents !== null ? formatTl(t.cost_cents) : "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <MaterialTable rows={rows} />
          <MoreButton shown={rows.length} total={total} busy={moreBusy} onMore={() => void loadMore()} />
        </>
      )}
      <p className="text-xs text-gray-500">Bu liste stok hareketlerinden gelir. Düzeltme ve iadeler net miktara yansır.</p>
    </div>
  );
}
