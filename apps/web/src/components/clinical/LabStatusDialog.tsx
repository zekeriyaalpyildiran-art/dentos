"use client";

// Lab job status change (spec p9_clinical §7.6): one button per `allowed_next` from the server, a dated event and a
// note (required for İptal). Replaces the old select that allowed any status.

import { useRef, useState } from "react";
import {
  ClinicalError,
  clinLabOrderSetStatus,
  toClinicalError,
  type LabOrderJson,
} from "@/lib/clinical/rpc";
import { LAB_STATUS_LABELS, LAB_STATUS_STYLES, LIMITS, type LabStatus } from "@/lib/clinical/codes";
import { statusDateLabel, transitionLabel } from "@/lib/clinical/lab";
import { isDay } from "@/lib/clinical/dates";
import { Badge, ErrorBox, Field, NoPatientTextHint, SAVING_LABEL, Sheet, clinInput, clinPrimary, clinSecondary } from "./ui";

export function statusWarningText(warnings: readonly string[] | undefined): string | null {
  if (warnings?.includes("finance_entry_open")) {
    return "İş iptal edildi. Bu işin maliyeti finansa borç olarak işlenmişti; kaydı finans yetkilisi kontrol etmeli.";
  }
  return null;
}

export function LabStatusDialog({
  order,
  today,
  onClose,
  onDone,
}: {
  order: LabOrderJson;
  today: string;
  onClose: () => void;
  onDone: (order: LabOrderJson, warnings: string[]) => void;
}) {
  const next = order.allowed_next ?? [];
  const [target, setTarget] = useState<LabStatus | null>(next.length === 1 ? next[0] : null);
  const [on, setOn] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<ClinicalError | null>(null);

  const submit = async () => {
    if (!target || busyRef.current) return;
    const text = note.trim();
    if (target === "cancelled" && (text.length < 3 || text.length > LIMITS.labEventNote)) {
      setError(new ClinicalError("Açıklama en fazla 500 karakter olabilir; iptal için 3–500 karakter yazın.", null, null, null));
      return;
    }
    if (text.length > LIMITS.labEventNote) {
      setError(new ClinicalError("Açıklama en fazla 500 karakter olabilir; iptal için 3–500 karakter yazın.", null, null, null));
      return;
    }
    if (!isDay(on) || on > today) {
      setError(new ClinicalError("Gönderim, geliş ve teslim tarihleri bugünden sonra olamaz.", null, null, null));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await clinLabOrderSetStatus({
        p_lab_order_id: order.id,
        p_version: order.version,
        p_status: target,
        p_on: on,
        p_note: text || null,
      });
      onDone(r.order, r.warnings ?? []);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Durum değiştir · ${order.order_number}`}
      description={
        <>
          Şu anki durum:{" "}
          <Badge className={LAB_STATUS_STYLES[order.status]}>{LAB_STATUS_LABELS[order.status] ?? order.status}</Badge>
        </>
      }
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          <ErrorBox error={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={clinSecondary} onClick={onClose} disabled={busy}>
              Vazgeç
            </button>
            <button type="button" className={clinPrimary} onClick={() => void submit()} disabled={busy || !target}>
              {busy ? SAVING_LABEL : "Kaydet"}
            </button>
          </div>
        </div>
      }
    >
      {next.length === 0 ? (
        <p className="text-gray-600">Bu işin durumu artık değiştirilemez.</p>
      ) : (
        <div className="space-y-4">
          <div role="group" aria-label="Yeni durum" className="grid gap-2 sm:grid-cols-2">
            {next.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={target === s}
                disabled={busy}
                onClick={() => setTarget(s)}
                className={`min-h-[44px] px-3 py-2 rounded border text-sm text-left ${
                  target === s
                    ? "bg-blue-600 text-white border-blue-700"
                    : s === "cancelled"
                      ? "bg-white text-red-700 border-red-200"
                      : "bg-white text-gray-800"
                }`}
              >
                {transitionLabel(order.status, s)}
              </button>
            ))}
          </div>
          {target && (
            <>
              <Field label={statusDateLabel(target, order.status)} required>
                <input
                  type="date"
                  className={`${clinInput} sm:max-w-[14rem]`}
                  value={on}
                  max={today}
                  disabled={busy}
                  onChange={(e) => setOn(e.target.value)}
                />
              </Field>
              <Field label={target === "cancelled" ? "İptal nedeni" : "Not"} required={target === "cancelled"} hint={<NoPatientTextHint />}>
                <textarea
                  className={clinInput}
                  rows={2}
                  maxLength={LIMITS.labEventNote}
                  value={note}
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
