"use client";

// Patient archive / restore confirmation (spec p10_platform §5.5). Writes only through plt_patient_set_active; used by
// the patients list (Arşivle / Arşivden çıkar) and the patient detail page (Arşivden çıkar). No delete anywhere.

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { toStaffError } from "@/lib/staff";
import { InlineMessage, Modal, pltDanger, pltInput, pltPrimary, pltSecondary } from "@/components/staff/Modal";

export const ARCHIVE_REASON_MAX = 500;

export function PatientArchiveDialog({
  patient,
  mode,
  onClose,
  onDone,
}: {
  patient: { id: string; full_name: string };
  mode: "archive" | "restore";
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [reason, setReason] = useState("");
  const [future, setFuture] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "archive") return;
    let cancelled = false;
    (async () => {
      const { count, error: err } = await supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("patient_id", patient.id)
        .eq("status", "scheduled")
        .gt("start_time", new Date().toISOString());
      if (!cancelled && !err) setFuture(count ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, patient.id, mode]);

  const submit = async () => {
    if (busyRef.current) return;
    if (reason.trim().length > ARCHIVE_REASON_MAX) {
      setError("Açıklama en fazla 500 karakter olabilir.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc("plt_patient_set_active", {
        p_patient_id: patient.id,
        p_active: mode === "restore",
        p_reason: mode === "archive" && reason.trim() ? reason.trim() : null,
      });
      if (err) throw err;
      onDone(mode === "archive" ? "Hasta arşivlendi." : "Hasta arşivden çıkarıldı.");
    } catch (err) {
      const e = toStaffError(err);
      setError(
        e.code === "PGRST202" || e.code === "42883"
          ? "Arşiv işlemi güncelleniyor. Birkaç dakika sonra tekrar deneyin."
          : e.message
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === "archive" ? "Hasta arşivlensin mi?" : "Hasta arşivden çıkarılsın mı?"}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={pltSecondary} onClick={onClose} disabled={busy}>
              Vazgeç
            </button>
            <button
              type="button"
              className={mode === "archive" ? pltDanger : pltPrimary}
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? "Kaydediliyor..." : mode === "archive" ? "Arşivle" : "Arşivden çıkar"}
            </button>
          </div>
        </div>
      }
    >
      {mode === "archive" ? (
        <>
          <p className="text-gray-800">
            <strong>{patient.full_name}</strong> hasta listesinden kalkar. Randevu, tedavi, ödeme ve klinik kayıtları
            silinmez; hasta Arşiv sekmesinden geri alınabilir.
          </p>
          {future !== null && future > 0 && (
            <InlineMessage tone="warn">
              Bu hastanın {future} ileri tarihli randevusu var. Randevular iptal edilmez; gerekiyorsa Ajanda&apos;dan
              iptal edin.
            </InlineMessage>
          )}
          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Açıklama</span>
            <textarea
              rows={3}
              className={pltInput}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={ARCHIVE_REASON_MAX}
            />
            <span className="block text-xs text-gray-500 mt-1">
              İsteğe bağlı. Hasta adı veya T.C. kimlik numarası yazmayın.
            </span>
          </label>
        </>
      ) : (
        <p className="text-gray-800">
          <strong>{patient.full_name}</strong> yeniden aktif hasta listesine alınsın mı?
        </p>
      )}
    </Modal>
  );
}
