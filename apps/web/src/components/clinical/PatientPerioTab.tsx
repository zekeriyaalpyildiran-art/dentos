"use client";

// Patient "Perio" tab (0042_perio_charts.sql): the patient's periodontal charts, newest first, and the chart editor.
// Read: every staff member. New / edit / delete: can_write (owner, admin, doctor, assistant, 'clinical').

import { useCallback, useEffect, useRef, useState } from "react";
import { newKey, toClinicalError, type ClinicalError } from "@/lib/clinical/rpc";
import {
  blankData,
  fmt1,
  normalizeData,
  perioDelete,
  perioGet,
  perioList,
  perioSave,
  summaryText,
  trDate,
  type PerioChartRow,
  type PerioData,
  type PerioListResponse,
} from "@/lib/clinical/perio";
import { PerioChartEditor, PerioSummaryTiles } from "./PerioChartEditor";
import { ClinicalNotice, EmptyState, ErrorBox, Loading, Toast, clinDanger, clinInput, clinPrimary, clinSecondary, SAVING_LABEL } from "./ui";

const PREF = "dentos-perio-autoadvance";

interface Draft {
  id: string;
  version: number; // 0 = not saved yet
  examDate: string;
  note: string;
  data: PerioData;
  by: string;
  dirty: boolean;
}

export function PatientPerioTab({ patientId, patientName }: { patientId: string; patientName: string }) {
  const [list, setList] = useState<PerioListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [armed, setArmed] = useState<"close" | "delete" | null>(null);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const req = useRef(0);

  useEffect(() => {
    try {
      setAutoAdvance(localStorage.getItem(PREF) !== "0");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const load = useCallback(async () => {
    const r = ++req.current;
    setLoading(true);
    try {
      const res = await perioList(patientId);
      if (r !== req.current) return;
      setList(res);
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

  // Leaving the page with unsaved measurements asks first.
  useEffect(() => {
    if (!draft?.dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [draft?.dirty]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const canWrite = !!list?.can_write;
  const readOnly = !canWrite;

  const startNew = async () => {
    if (!list) return;
    setBusy(true);
    setError(null);
    try {
      let prev: PerioData | null = null;
      if (list.rows[0]) prev = normalizeData((await perioGet(list.rows[0].id)).data);
      setDraft({
        id: newKey(),
        version: 0,
        examDate: list.today,
        note: "",
        data: blankData(prev, list.implant_teeth || []),
        by: "",
        dirty: false,
      });
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  const open = async (row: PerioChartRow) => {
    setBusy(true);
    setError(null);
    try {
      const full = await perioGet(row.id);
      setDraft({
        id: full.id,
        version: full.version,
        examDate: full.exam_date,
        note: full.note,
        data: normalizeData(full.data),
        by: full.created_by_name || "",
        dirty: false,
      });
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const res = await perioSave({
        id: draft.id,
        patientId,
        version: draft.version,
        examDate: draft.examDate,
        note: draft.note,
        data: draft.data,
      });
      setDraft({ ...draft, version: res.version, by: res.created_by_name || "", dirty: false });
      setToast("Ölçüm kaydedildi.");
      void load();
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (draft?.dirty && armed !== "close") {
      setArmed("close");
      return;
    }
    setArmed(null);
    setDraft(null);
    setError(null);
  };

  const remove = async () => {
    if (!draft || draft.version === 0) return;
    if (armed !== "delete") {
      setArmed("delete");
      return;
    }
    setArmed(null);
    setBusy(true);
    try {
      await perioDelete(draft.id, draft.version);
      setDraft(null);
      setToast("Ölçüm silindi.");
      void load();
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  const copySummary = async () => {
    if (!draft) return;
    const txt = summaryText(draft.data, { patient: patientName, date: draft.examDate, by: draft.by, note: draft.note });
    try {
      await navigator.clipboard.writeText(txt);
      setToast("Özet panoya kopyalandı.");
    } catch {
      setToast("Kopyalanamadı. Tarayıcı panoya erişime izin vermedi.");
    }
  };

  // ---------------------------------------------------------------- editor
  if (draft) {
    const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch, dirty: true });
    return (
      <div className="space-y-4 text-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">
            {draft.version === 0 ? "Yeni periodontal ölçüm" : `Periodontal ölçüm · ${trDate(draft.examDate)}`}
            {draft.dirty && <span className="ml-2 align-middle text-xs font-medium text-amber-700 bg-amber-100 rounded px-2 py-0.5">Kaydedilmedi</span>}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {!readOnly && (
              <label className="inline-flex items-center gap-2 text-sm text-gray-600 mr-2">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => {
                    setAutoAdvance(e.target.checked);
                    try {
                      localStorage.setItem(PREF, e.target.checked ? "1" : "0");
                    } catch {
                      /* storage unavailable */
                    }
                  }}
                />
                Rakamdan sonra sonraki kutuya geç
              </label>
            )}
            <button type="button" className={clinSecondary} onClick={() => void copySummary()}>Özeti kopyala</button>
            {!readOnly && draft.version > 0 && (
              <button type="button" className={clinDanger} disabled={busy} onClick={() => void remove()}>
                {armed === "delete" ? "Silmek için tekrar tıklayın" : "Sil"}
              </button>
            )}
            <button type="button" className={armed === "close" ? clinDanger : clinSecondary} onClick={close}>
              {armed === "close" ? "Kaydetmeden kapat" : "Kapat"}
            </button>
            {!readOnly && (
              <button type="button" className={clinPrimary} disabled={busy || (!draft.dirty && draft.version > 0)} onClick={() => void save()}>
                {busy ? SAVING_LABEL : "Kaydet"}
              </button>
            )}
          </div>
        </div>

        <ErrorBox error={error} onReload={() => { setDraft(null); setError(null); void load(); }} />

        <div className="bg-white rounded-lg shadow p-4 grid gap-3 grid-cols-1 sm:grid-cols-[200px_1fr]">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-gray-500 font-semibold">Muayene tarihi</span>
            <input type="date" className={clinInput} value={draft.examDate} max={list?.today} readOnly={readOnly}
              onChange={(e) => update({ examDate: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-gray-500 font-semibold">Not</span>
            <input className={clinInput} value={draft.note} maxLength={1000} readOnly={readOnly}
              placeholder="Örn. sigara, diyabet, şikâyet, tedavi sonrası kontrol"
              onChange={(e) => update({ note: e.target.value })} />
          </label>
          {draft.version > 0 && draft.by && <p className="text-xs text-gray-500 sm:col-span-2 m-0">Kaydeden: {draft.by}</p>}
        </div>

        <PerioSummaryTiles data={draft.data} />

        <PerioChartEditor
          data={draft.data}
          readOnly={readOnly}
          autoAdvance={autoAdvance}
          onChange={(data) => setDraft({ ...draft, data, dirty: true })}
        />
        {!readOnly && <p className="text-xs text-gray-500">10 mm ve üzeri değer girecekseniz otomatik geçişi kapatın.</p>}
        <Toast text={toast} onDone={() => setToast(null)} />
      </div>
    );
  }

  // ---------------------------------------------------------------- list
  const rows = list?.rows || [];
  return (
    <div className="space-y-4 text-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Periodontal ölçümler</h2>
        {canWrite && (
          <button type="button" className={clinPrimary} disabled={busy || !list} onClick={() => void startNew()}>
            Yeni ölçüm
          </button>
        )}
      </div>
      <ClinicalNotice error={error} />

      {loading && !list ? (
        <Loading />
      ) : rows.length === 0 && !error ? (
        <EmptyState title="Bu hastaya kayıtlı periodontal ölçüm yok.">
          {canWrite ? "“Yeni ölçüm” ile cep derinliği, çekilme, kanama ve plak kaydını başlatın." : null}
        </EmptyState>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Tarih</th>
                <th className="px-3 py-3 font-medium text-right">Kanama</th>
                <th className="px-3 py-3 font-medium text-right">Plak</th>
                <th className="px-3 py-3 font-medium text-right">Ort. cep</th>
                <th className="px-3 py-3 font-medium text-right">Ort. CAL</th>
                <th className="px-3 py-3 font-medium text-right">Cep ≥ 6 mm</th>
                <th className="px-3 py-3 font-medium text-right">Diş</th>
                <th className="px-3 py-3 font-medium">Kaydeden</th>
                <th className="px-3 py-3 font-medium">Not</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = r.summary || {};
                return (
                  <tr key={r.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono whitespace-nowrap">{trDate(r.exam_date)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{s.bop_pct != null ? `%${s.bop_pct}` : "–"}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{s.pl_pct != null ? `%${s.pl_pct}` : "–"}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{fmt1(s.mean_pd ?? null)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{fmt1(s.mean_cal ?? null)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{s.pd6 ?? "–"}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{s.teeth ?? "–"}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.created_by_name || "–"}</td>
                    <td className="px-3 py-3 max-w-[260px] truncate" title={r.note}>{r.note}</td>
                    <td className="px-3 py-3 text-right">
                      <button type="button" className="text-blue-700 hover:underline disabled:opacity-40" disabled={busy} onClick={() => void open(r)}>
                        {canWrite ? "Aç / düzenle" : "Aç"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
