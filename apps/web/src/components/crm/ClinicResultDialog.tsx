"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { cancelPendingReminders } from "@/app/(panel)/appointments/reminder-utils";
import { formatDateTime } from "@/lib/crm";
import { CrmModal, Loading, Notice, buttonSecondary } from "./ui";

type Outcome = "completed" | "no_show" | "cancelled";

const OUTCOMES: { value: Outcome; label: string; confirm: string }[] = [
  { value: "completed", label: "Geldi", confirm: "Hasta randevuya geldi olarak işaretlensin mi?" },
  { value: "no_show", label: "Gelmedi", confirm: "Hasta bu randevuya gelmedi olarak işaretlensin mi?" },
  { value: "cancelled", label: "İptal", confirm: "Bu randevu iptal edilsin mi?" },
];

interface Row {
  id: string;
  start_time: string;
  status: string;
  patient: { full_name: string | null } | null;
  doctor: { specialty: string | null; users: { full_name: string | null } | null } | null;
}

/**
 * "Klinik randevusunun sonucu eksik" (TK:25): records the visit outcome on the appointment, exactly as the
 * appointments page does (status change of a still-scheduled row, then its pending SMS reminders are closed).
 * The database trigger moves the linked lead's stage (contract §2.11).
 */
export function ClinicResultDialog({
  appointmentId,
  onClose,
  onSaved,
}: {
  appointmentId: string;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const clinicId = useAuthStore((s) => s.user?.clinic_id);
  const [row, setRow] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    createClient()
      .from("appointments")
      .select("id,start_time,status,patient:patients(full_name),doctor:doctors(specialty,users(full_name))")
      .eq("id", appointmentId)
      .eq("clinic_id", clinicId)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err || !data) setError("Randevu bulunamadı.");
        else setRow(data as unknown as Row);
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId, clinicId]);

  const record = async (o: (typeof OUTCOMES)[number]) => {
    if (!row || !clinicId || busy || !confirm(o.confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: err } = await supabase
        .from("appointments")
        .update({ status: o.value, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("clinic_id", clinicId)
        .eq("status", "scheduled")
        .select("id");
      if (err || !data || data.length === 0) {
        setError("Randevu durumu güncellenemedi. Randevu başka bir ekranda değişmiş olabilir.");
        return;
      }
      const remindersClosed = await cancelPendingReminders(supabase, clinicId, row.id);
      onSaved(
        `Randevu sonucu kaydedildi: ${o.label}.${remindersClosed ? "" : " Bekleyen hatırlatmalar kapatılamadı."}`
      );
    } catch {
      setError("Bağlantı hatası oluştu, tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  };

  const started = row ? new Date(row.start_time).getTime() <= Date.now() : false;

  return (
    <CrmModal title="Klinik randevusu sonucu" onClose={onClose} busy={busy}>
      {!row && !error && <Loading />}
      {error && <Notice tone="danger">{error}</Notice>}
      {row && (
        <div className="space-y-4">
          <div className="p-3 rounded bg-gray-50 text-sm">
            <p className="font-semibold">{row.patient?.full_name ?? "Hasta"}</p>
            <p>
              {formatDateTime(row.start_time)} · {row.doctor?.users?.full_name || row.doctor?.specialty || "Hekim"}
            </p>
          </div>
          {row.status !== "scheduled" ? (
            <Notice tone="info">Bu randevunun sonucu zaten kaydedilmiş.</Notice>
          ) : (
            <div className="flex flex-wrap gap-2">
              {OUTCOMES.filter((o) => o.value !== "no_show" || started).map((o) => (
                <button key={o.value} type="button" className={buttonSecondary} disabled={busy} onClick={() => record(o)}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-600">
            Gelmedi veya İptal kaydında hastanın başka planlı randevusu yoksa hasta adayı “Takip kararı gerekiyor”
            listesine düşer.
          </p>
          <div className="flex justify-end gap-2">
            <Link href={`/appointments/${row.id}/edit`} className={buttonSecondary}>
              Randevuyu düzenle
            </Link>
            <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
              Kapat
            </button>
          </div>
        </div>
      )}
    </CrmModal>
  );
}
