"use client";

// Patient "İmplantlar" tab (spec p9_clinical §7.5): mini tooth chart coloured by status and the patient's implants.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  NO_FLAGS,
  clinImplantList,
  toClinicalError,
  type ClinicalError,
  type ClinicalFlags,
  type ImplantJson,
} from "@/lib/clinical/rpc";
import { IMPLANT_STATUSES, IMPLANT_STATUS_LABELS, IMPLANT_STATUS_STYLES } from "@/lib/clinical/codes";
import { istanbulToday } from "@/lib/clinical/dates";
import { ImplantTable } from "./ImplantTable";
import { ToothPicker } from "./ToothPicker";
import { useImplantDialogs } from "./useImplantDialogs";
import { ClinicalNotice, EmptyState, ErrorBox, Loading, MoreButton, clinPrimary } from "./ui";

const PAGE_SIZE = 50;

export function PatientImplantsTab({ patientId, patientName }: { patientId: string; patientName: string }) {
  const [rows, setRows] = useState<ImplantJson[]>([]);
  const [total, setTotal] = useState(0);
  const [flags, setFlags] = useState<ClinicalFlags>(NO_FLAGS);
  const [today, setToday] = useState(istanbulToday());
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    const r = ++req.current;
    setLoading(true);
    try {
      const res = await clinImplantList({ patient_id: patientId }, { offset: 0, limit: PAGE_SIZE });
      if (r !== req.current) return;
      setRows(res.rows || []);
      setTotal(res.total ?? 0);
      setFlags(res.flags ?? NO_FLAGS);
      if (res.today) setToday(res.today);
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
      const res = await clinImplantList({ patient_id: patientId }, { offset: rows.length, limit: PAGE_SIZE });
      setRows((prev) => [...prev, ...(res.rows || [])]);
      setTotal(res.total ?? total);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setMoreBusy(false);
    }
  };

  const dialogs = useImplantDialogs({ flags, today, onChanged: () => void load() });
  const fixedPatient = { id: patientId, full_name: patientName };
  // Failed implants are kept in the list but do not occupy the tooth on the chart.
  const chart = rows
    .filter((r) => r.status !== "failed")
    .map((r) => ({ tooth: r.tooth_fdi, status: r.status, label: r.brand_name }));

  return (
    <div className="space-y-4 text-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">İmplantlar</h2>
        {flags.can_write && (
          <button type="button" className={clinPrimary} onClick={() => dialogs.open({ fixedPatient })}>
            İmplant ekle
          </button>
        )}
      </div>
      <ClinicalNotice error={error} />
      <ErrorBox error={dialogs.error} />

      {loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 && !error ? (
        <EmptyState title="Bu hastaya kayıtlı implant yok." />
      ) : (
        <>
          <div className="bg-white rounded-lg shadow p-4 space-y-2">
            <ToothPicker value="" occupied={chart} readOnly />
            <div className="flex flex-wrap gap-2 text-xs">
              {IMPLANT_STATUSES.filter((s) => s !== "failed").map((s) => (
                <span key={s} className={`px-2 py-0.5 rounded ${IMPLANT_STATUS_STYLES[s]}`}>
                  {IMPLANT_STATUS_LABELS[s]}
                </span>
              ))}
            </div>
          </div>
          <ImplantTable rows={rows} flags={flags} showPatient={false} actions={dialogs.actions} />
          <MoreButton shown={rows.length} total={total} busy={moreBusy} onMore={() => void loadMore()} />
        </>
      )}
      {dialogs.element}
    </div>
  );
}
