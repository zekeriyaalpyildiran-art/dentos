"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase";
import {
  crmSetReminderOutcome,
  formatDateTime,
  isReminderCurrent,
  newId,
  splitIstanbul,
  istanbulToday,
  telHref,
  toCrmError,
  type CrmError,
  type ReminderResult,
} from "@/lib/crm";
import { REMINDER_OUTCOMES, REMINDER_OUTCOME_LABELS, type ReminderOutcome } from "@/lib/crm/codes";
import { CrmErrorBox, CrmModal, Field, Loading, Notice, buttonPrimary, buttonSecondary, inputClass } from "./ui";
import {
  WHATSAPP_REMINDER_NOTE,
  WhatsAppReminderLink,
  useClinicContact,
} from "@/components/appointments/WhatsAppReminderLink";

interface AppointmentRow {
  id: string;
  start_time: string;
  end_time: string;
  doctor_id: string | null;
  status: string;
  reminder_outcome: ReminderOutcome | null;
  reminder_note: string | null;
  reminded_at: string | null;
  reminder_start_time: string | null;
  reminder_doctor_id: string | null;
  patient: { full_name: string | null; phone: string | null } | null;
  doctor: { specialty: string | null; users: { full_name: string | null } | null } | null;
}

interface LogRow {
  id: string;
  outcome: ReminderOutcome;
  note: string;
  created_at: string;
  actor: { full_name: string | null } | null;
}

/**
 * Manual appointment reminder (owner decision 2: no SMS is sent). Reception phones the patient or opens a ready
 * WhatsApp message, then records "Hatırlatıldı" or "Ulaşılamadı" with a note. The outcome is bound to the start time
 * and doctor shown here (the legacy visitKey), so a changed appointment is refused with E_REMINDER_STALE.
 * initialNote prefills the note (e.g. after the agenda's WhatsApp link was used).
 */
export function ReminderDialog({
  appointmentId,
  initialNote,
  onClose,
  onSaved,
}: {
  appointmentId: string;
  initialNote?: string;
  onClose: () => void;
  onSaved: (result: ReminderResult) => void;
}) {
  const [eventId] = useState(newId);
  const [row, setRow] = useState<AppointmentRow | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReminderOutcome>("reminded");
  const [note, setNote] = useState(initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const clinic = useClinicContact();

  const load = useCallback(async () => {
    const supabase = createClient();
    const [a, l] = await Promise.all([
      supabase
        .from("appointments")
        .select(
          "id,start_time,end_time,doctor_id,status,reminder_outcome,reminder_note,reminded_at,reminder_start_time,reminder_doctor_id,patient:patients(full_name,phone),doctor:doctors(specialty,users(full_name))"
        )
        .eq("id", appointmentId)
        .maybeSingle(),
      supabase
        .from("appointment_reminder_logs")
        .select("id,outcome,note,created_at,actor:users(full_name)")
        .eq("appointment_id", appointmentId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (a.error || !a.data) {
      setLoadError("Randevu bulunamadı.");
      return;
    }
    setRow(a.data as unknown as AppointmentRow);
    setLogs((l.data || []) as unknown as LogRow[]);
    setLoadError(null);
  }, [appointmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!row || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await crmSetReminderOutcome({
        p_appointment_id: row.id,
        p_event_id: eventId,
        p_start_time: row.start_time,
        p_doctor_id: row.doctor_id,
        p_outcome: outcome,
        p_note: note.trim(),
      });
      onSaved(r);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  const local = row ? splitIstanbul(row.start_time) : null;
  const doctorName = row?.doctor?.users?.full_name || row?.doctor?.specialty || "Hekim";
  const editable = !!row && row.status === "scheduled" && !!local && local.date >= istanbulToday();
  const current = row ? isReminderCurrent(row) : false;
  const upcoming = editable && !!row && new Date(row.start_time).getTime() > Date.now();

  return (
    <CrmModal title="Randevu hatırlatması" onClose={onClose} busy={busy}>
      {!row && !loadError && <Loading />}
      {loadError && <Notice tone="danger">{loadError}</Notice>}
      {row && local && (
        <form onSubmit={submit} className="space-y-4">
          <div className="p-3 rounded bg-gray-50 text-sm space-y-1">
            <p className="font-semibold">{row.patient?.full_name ?? "Hasta"}</p>
            {row.patient?.phone && (
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                <a href={telHref(row.patient.phone)} className="text-blue-700 underline">
                  {row.patient.phone}
                </a>
                {upcoming && (
                  <WhatsAppReminderLink
                    patientName={row.patient.full_name}
                    phone={row.patient.phone}
                    startTime={row.start_time}
                    doctorName={row.doctor?.users?.full_name || row.doctor?.specialty || null}
                    clinic={clinic}
                    onOpen={() => setNote((prev) => prev || WHATSAPP_REMINDER_NOTE)}
                    className="text-green-700 underline"
                  />
                )}
              </p>
            )}
            <p>
              {formatDateTime(row.start_time)} · {doctorName}
            </p>
            {current && row.reminder_outcome && (
              <p>
                Son sonuç: <b>{REMINDER_OUTCOME_LABELS[row.reminder_outcome]}</b>
                {row.reminder_note ? ` · ${row.reminder_note}` : ""}
              </p>
            )}
          </div>
          <p className="text-xs text-gray-600">
            Program hastaya kendiliğinden SMS veya mesaj göndermez. Hastayı arayıp ya da WhatsApp&apos;tan yazıp
            hatırlattıktan sonra sonucu buraya kaydedin. Randevunun tarihi, saati veya hekimi değişirse kayıtlı sonuç
            geçersiz olur.
          </p>
          {!editable ? (
            <Notice tone="warn">
              Hatırlatma yalnızca bugün veya ileride planlı klinik randevusu için kaydedilebilir.
            </Notice>
          ) : (
            <fieldset disabled={busy} className="space-y-3">
              <div className="flex gap-2" role="radiogroup" aria-label="Hatırlatma sonucu">
                {REMINDER_OUTCOMES.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={outcome === o.value}
                    onClick={() => setOutcome(o.value)}
                    className={`px-3 py-1.5 rounded border text-sm ${
                      outcome === o.value ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <Field label="Not *">
                <textarea
                  required
                  rows={3}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className={inputClass}
                  placeholder="Ör. Hasta randevuyu teyit etti / telefon kapalı"
                />
              </Field>
            </fieldset>
          )}
          <CrmErrorBox error={error} onReload={load} />
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
              Kapat
            </button>
            {editable && (
              <button type="submit" className={buttonPrimary} disabled={busy || !note.trim()}>
                {busy ? "Kaydediliyor…" : "Sonucu kaydet"}
              </button>
            )}
          </div>
          {logs.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Önceki denemeler</p>
              <ul className="text-sm divide-y border rounded">
                {logs.map((l) => (
                  <li key={l.id} className="px-3 py-2">
                    <b>{REMINDER_OUTCOME_LABELS[l.outcome] ?? l.outcome}</b> · {formatDateTime(l.created_at)}
                    {l.actor?.full_name ? ` · ${l.actor.full_name}` : ""}
                    <p className="text-gray-700">{l.note}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      )}
    </CrmModal>
  );
}
