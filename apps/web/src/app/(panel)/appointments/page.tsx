"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { cancelPendingReminders } from "./reminder-utils";
import { ReminderDialog } from "@/components/crm/ReminderDialog";
import { WhatsAppReminderLink, useClinicContact } from "@/components/appointments/WhatsAppReminderLink";
import { reminderDoctorName } from "@/lib/appointments/whatsapp";
import { isReminderCurrent } from "@/lib/crm";
import { REMINDER_OUTCOME_LABELS, type ReminderOutcome } from "@/lib/crm/codes";
import { addDays, formatDateTime, isDay, istanbulDayOf, istanbulToday } from "@/lib/clinical/dates";
import { dayRange, formatClock, formatDayWithWeekday } from "@/lib/appointments/agenda";
import {
  AGENDA_STATUS_LABELS as STATUS_LABELS,
  AGENDA_STATUS_STYLES as STATUS_STYLES,
} from "@/lib/appointments/patient-appointments";
import { PatientPicker, type PatientRef } from "@/components/patients/PatientPicker";
import { PatientAppointmentsPanel } from "@/components/appointments/PatientAppointmentsPanel";

interface Appointment {
  id: string;
  patient_id: string;
  doctor_id: string;
  chair_id: string;
  procedure_id?: string | null;
  start_time: string;
  end_time: string;
  status: string;
  notes?: string | null;
  /** Phase 6 manual reminder outcome (written only by crm_set_reminder_outcome). */
  reminder_outcome?: ReminderOutcome | null;
  reminder_note?: string | null;
  reminder_start_time?: string | null;
  reminder_doctor_id?: string | null;
  // Many-to-one embeds: only the patients, doctors, chairs and procedures of the loaded day travel.
  patients: { full_name: string; phone: string | null } | null;
  doctors: { specialty: string | null; users: { full_name: string } | null } | null;
  chairs: { name: string } | null;
  procedures_catalog: { name: string } | null;
}

const APPOINTMENT_COLUMNS =
  "id,patient_id,doctor_id,chair_id,procedure_id,start_time,end_time,status,notes," +
  "reminder_outcome,reminder_note,reminder_start_time,reminder_doctor_id," +
  "patients(full_name,phone),doctors(specialty,users(full_name)),chairs(name),procedures_catalog(name)";

type StatusAction = "completed" | "no_show" | "cancelled";

const STATUS_ACTIONS: Record<StatusAction, { confirm: string; error: string }> = {
  completed: {
    confirm: "Bu randevuyu tamamlandı olarak işaretlemek istiyor musunuz?",
    error: "Randevu tamamlandı olarak işaretlenemedi.",
  },
  no_show: {
    confirm: "Hasta bu randevuya gelmedi olarak işaretlensin mi?",
    error: "Randevu gelmedi olarak işaretlenemedi.",
  },
  cancelled: {
    confirm: "Bu randevuyu iptal etmek istiyor musunuz?",
    error: "Randevu iptal edilemedi.",
  },
};

const navButton = "px-3 py-2 min-h-[44px] rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-50";

const SEARCH_INPUT_ID = "agenda-patient-search";
/** Marks the appointment opened with "Güne git" in the day list and the calendar. */
const HIGHLIGHT_CLASS = "bg-amber-50 ring-2 ring-inset ring-amber-400";

const getPatientName = (apt: Appointment) => apt.patients?.full_name || "-";
const getDoctorName = (apt: Appointment) => apt.doctors?.users?.full_name || apt.doctors?.specialty || "-";
const getChairName = (apt: Appointment) => apt.chairs?.name || "-";
const getProcedureName = (apt: Appointment) => apt.procedures_catalog?.name || "-";

export default function Page() {
  const { user } = useAuthStore();
  const clinicId = user?.clinic_id;
  const supabase = useMemo(() => createClient(), []);
  const clinic = useClinicContact();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "calendar">("list");
  // The agenda shows one Istanbul day; only that day's appointments are loaded (PostgREST answers at most 1000 rows).
  const [selectedDate, setSelectedDate] = useState(istanbulToday);
  const [dateReady, setDateReady] = useState(false);
  const [reminder, setReminder] = useState<{ id: string; fromWhatsApp?: boolean } | null>(null);
  const requestId = useRef(0);
  // "Hasta ara": the chosen patient's appointments are shown above the day ("Güne git" opens their day).
  const [searchPatient, setSearchPatient] = useState<PatientRef | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [panelReloadKey, setPanelReloadKey] = useState(0);
  const [highlight, setHighlight] = useState<{ id: string; seq: number } | null>(null);
  const focusSearchAfterClear = useRef(false);
  /** Each "Güne git" click gets a new number; it scrolls once, later list changes do not scroll again. */
  const highlightSeq = useRef(0);
  const scrolledSeq = useRef(0);

  // ?date=YYYY-MM-DD (set after saving an appointment, kept while browsing); read directly so no Suspense is needed.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("date");
    if (fromUrl && isDay(fromUrl)) setSelectedDate(fromUrl);
    setDateReady(true);
  }, []);

  useEffect(() => {
    if (!clinicId || !dateReady) return;
    const range = dayRange(selectedDate);
    if (!range) return;
    const req = ++requestId.current;
    setLoading(true);
    setLoadFailed(false);

    supabase
      .from("appointments")
      .select(APPOINTMENT_COLUMNS)
      .eq("clinic_id", clinicId)
      .gte("start_time", range.from)
      .lt("start_time", range.to)
      .order("start_time")
      .order("id")
      .then(({ data, error }) => {
        // A newer day supersedes this answer.
        if (req !== requestId.current) return;
        if (error) {
          console.error("Error fetching appointments:", error);
          setAppointments([]);
          setLoadFailed(true);
        } else {
          setAppointments((data || []) as unknown as Appointment[]);
        }
        setLoading(false);
      });
  }, [supabase, clinicId, selectedDate, dateReady]);

  /** Shows another day; `highlightId` marks one of its appointments ("Güne git"), any other change clears the mark. */
  const changeDate = (day: string, highlightId: string | null = null) => {
    if (!isDay(day)) return;
    setSelectedDate(day);
    setHighlight(highlightId ? { id: highlightId, seq: ++highlightSeq.current } : null);
    // Keep the day in the address so "Geri" from a detail page returns to it; the router's own state is preserved.
    window.history.replaceState(window.history.state, "", `/appointments?date=${day}`);
  };

  const clearPatientSearch = () => {
    setSearchPatient(null);
    setHighlight(null);
    setPickerKey((k) => k + 1);
    focusSearchAfterClear.current = true;
  };

  // After "Temizle" the search box is back: put the focus in it (keyboard and screen reader users stay in place).
  useEffect(() => {
    if (searchPatient || !focusSearchAfterClear.current) return;
    focusSearchAfterClear.current = false;
    document.getElementById(SEARCH_INPUT_ID)?.focus();
  }, [searchPatient, pickerKey]);

  // "Güne git": once the day is loaded, scroll to the marked appointment and move the focus to it (once per click).
  useEffect(() => {
    if (!highlight || loading || scrolledSeq.current === highlight.seq) return;
    const el = document.getElementById(`apt-${highlight.id}`);
    if (!el) return;
    scrolledSeq.current = highlight.seq;
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // Older browsers: animate.
    }
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }, [highlight, loading, appointments, view]);

  const today = istanbulToday();
  const now = Date.now();

  // Manual reminder (no SMS is sent): only for scheduled appointments from today on (Istanbul).
  const canRemind = (apt: Appointment) => apt.status === "scheduled" && (istanbulDayOf(apt.start_time) ?? "") >= today;
  // The WhatsApp text only makes sense before the appointment starts.
  const canWhatsApp = (apt: Appointment) => apt.status === "scheduled" && new Date(apt.start_time).getTime() > now;
  const reminderLabel = (apt: Appointment) => {
    if (!apt.reminder_outcome || !isReminderCurrent({ ...apt, doctor_id: apt.doctor_id ?? null })) return null;
    return REMINDER_OUTCOME_LABELS[apt.reminder_outcome] ?? apt.reminder_outcome;
  };

  const whatsAppLink = (apt: Appointment, className?: string) =>
    canWhatsApp(apt) ? (
      <WhatsAppReminderLink
        patientName={apt.patients?.full_name}
        phone={apt.patients?.phone}
        startTime={apt.start_time}
        doctorName={reminderDoctorName(apt.doctors)}
        clinic={clinic}
        // After the message is opened, ask for the outcome so CRM "Bugün" no longer lists this reminder.
        onOpen={() => setReminder({ id: apt.id, fromWhatsApp: true })}
        className={className}
      />
    ) : null;

  const updateStatus = async (id: string, status: StatusAction) => {
    const action = STATUS_ACTIONS[status];
    if (!clinicId || !confirm(action.confirm)) return;

    setUpdatingId(id);
    try {
      // Only a still-scheduled appointment may change status, so a stale list cannot overwrite a status set elsewhere.
      const { data, error } = await supabase
        .from("appointments")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("clinic_id", clinicId)
        .eq("status", "scheduled")
        .select("id");

      if (error || !data || data.length === 0) {
        alert(action.error);
        return;
      }
      setAppointments((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
      setPanelReloadKey((k) => k + 1);

      // A completed or missed appointment must not trigger its reminder either, so every status change closes them.
      if (!(await cancelPendingReminders(supabase, clinicId, id))) {
        alert("Randevu durumu güncellendi ancak bekleyen hatırlatmalar kapatılamadı.");
      }
    } catch (error) {
      console.error("Error updating appointment status:", error);
      alert(action.error);
    } finally {
      setUpdatingId(null);
    }
  };

  const emptyText = loadFailed
    ? "Randevular yüklenemedi. Lütfen sayfayı yenileyin."
    : `${formatDayWithWeekday(selectedDate)} tarihinde randevu yok`;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Randevular</h1>
        <Link
          href="/appointments/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Yeni Randevu
        </Link>
      </div>

      {searchPatient && clinicId ? (
        <PatientAppointmentsPanel
          key={searchPatient.id}
          patient={searchPatient}
          clinicId={clinicId}
          reloadKey={panelReloadKey}
          highlightId={highlight?.id ?? null}
          onGoToDay={(day, id) => changeDate(day, id)}
          onClear={clearPatientSearch}
        />
      ) : (
        <div className="mb-6 max-w-xl">
          <label htmlFor={SEARCH_INPUT_ID} className="block text-sm font-semibold text-gray-800 mb-1">
            Hasta ara: ad veya telefon
          </label>
          <PatientPicker
            key={pickerKey}
            inputId={SEARCH_INPUT_ID}
            value={null}
            onChange={(p) => {
              if (p) setSearchPatient(p);
            }}
            placeholder="En az 2 harf veya rakam"
            inputClassName="w-full px-3 py-2 min-h-[44px] border rounded bg-white text-base text-gray-900"
          />
        </div>
      )}

      <div className="flex gap-4 mb-6">
        <button
          onClick={() => setView("list")}
          className={`px-4 py-2 rounded ${view === "list" ? "bg-blue-600 text-white" : "bg-gray-200"}`}
        >
          Liste
        </button>
        <button
          onClick={() => setView("calendar")}
          className={`px-4 py-2 rounded ${view === "calendar" ? "bg-blue-600 text-white" : "bg-gray-200"}`}
        >
          Takvim
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-6">
        <button
          type="button"
          onClick={() => changeDate(addDays(selectedDate, -1))}
          className={navButton}
          aria-label="Önceki gün"
        >
          ←
        </button>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => changeDate(e.target.value)}
          className="px-4 py-2 min-h-[44px] border rounded"
          aria-label="Gün"
        />
        <button
          type="button"
          onClick={() => changeDate(addDays(selectedDate, 1))}
          className={navButton}
          aria-label="Sonraki gün"
        >
          →
        </button>
        <button
          type="button"
          onClick={() => changeDate(today)}
          disabled={selectedDate === today}
          className={navButton}
        >
          Bugün
        </button>
        <span className="ml-2 font-semibold text-gray-800">{formatDayWithWeekday(selectedDate)}</span>
        {!loading && !loadFailed && (
          <span className="text-sm text-gray-600">· {appointments.length} randevu</span>
        )}
      </div>

      {view === "list" && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-2 text-left">Hasta</th>
                <th className="px-4 py-2 text-left">Hekim</th>
                <th className="px-4 py-2 text-left">Koltuk</th>
                <th className="px-4 py-2 text-left">Tedavi</th>
                <th className="px-4 py-2 text-left">Tarih/Saat</th>
                <th className="px-4 py-2 text-left">Durum</th>
                <th className="px-4 py-2 text-left">Hatırlatma</th>
                <th className="px-4 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    Yükleniyor...
                  </td>
                </tr>
              ) : appointments.length === 0 ? (
                <tr>
                  <td colSpan={8} className={`px-4 py-8 text-center ${loadFailed ? "text-red-600" : "text-gray-500"}`}>
                    {emptyText}
                  </td>
                </tr>
              ) : (
                appointments.map((apt) => (
                  <tr
                    key={apt.id}
                    id={`apt-${apt.id}`}
                    tabIndex={-1}
                    aria-current={highlight?.id === apt.id ? "true" : undefined}
                    className={`border-b focus:outline-none ${
                      highlight?.id === apt.id ? HIGHLIGHT_CLASS : "hover:bg-gray-50"
                    }`}
                  >
                    <td className="px-4 py-2">
                      {getPatientName(apt)}
                      {highlight?.id === apt.id && <span className="sr-only"> (aranan hastanın randevusu)</span>}
                    </td>
                    <td className="px-4 py-2">{getDoctorName(apt)}</td>
                    <td className="px-4 py-2">{getChairName(apt)}</td>
                    <td className="px-4 py-2">{getProcedureName(apt)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(apt.start_time)}</td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-1 rounded text-sm ${STATUS_STYLES[apt.status] ?? STATUS_STYLES.scheduled}`}>
                        {STATUS_LABELS[apt.status] ?? apt.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {reminderLabel(apt) && (
                        <span
                          className={apt.reminder_outcome === "reminded" ? "text-green-700" : "text-amber-700"}
                          title={apt.reminder_note ?? undefined}
                        >
                          {reminderLabel(apt)}
                        </span>
                      )}
                      {whatsAppLink(apt, "block text-green-700 hover:underline whitespace-nowrap")}
                      {canRemind(apt) && (
                        <button
                          onClick={() => setReminder({ id: apt.id })}
                          className="block text-blue-600 hover:underline whitespace-nowrap"
                        >
                          {reminderLabel(apt) ? "Yeniden kaydet" : "Sonuç kaydet"}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-3 whitespace-nowrap">
                        <Link href={`/appointments/${apt.id}`} className="text-blue-600 hover:underline">
                          Detay
                        </Link>
                        {apt.status === "scheduled" && (
                          <div className="flex gap-3 whitespace-nowrap">
                            <Link href={`/appointments/${apt.id}/edit`} className="text-blue-600 hover:underline">
                              Düzenle
                            </Link>
                            <button
                              onClick={() => updateStatus(apt.id, "completed")}
                              disabled={updatingId === apt.id}
                              className="text-green-700 hover:underline disabled:opacity-50"
                            >
                              Tamamlandı
                            </button>
                            {/* A no-show can only be recorded once the appointment has started. */}
                            {new Date(apt.start_time).getTime() <= now && (
                              <button
                                onClick={() => updateStatus(apt.id, "no_show")}
                                disabled={updatingId === apt.id}
                                className="text-yellow-700 hover:underline disabled:opacity-50"
                              >
                                Gelmedi
                              </button>
                            )}
                            <button
                              onClick={() => updateStatus(apt.id, "cancelled")}
                              disabled={updatingId === apt.id}
                              className="text-red-600 hover:underline disabled:opacity-50"
                            >
                              İptal Et
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === "calendar" && (
        <div className="grid grid-cols-1 gap-4">
          {loading ? (
            <p className="text-gray-500">Yükleniyor...</p>
          ) : appointments.length === 0 ? (
            <p className={loadFailed ? "text-red-600" : "text-gray-500"}>{emptyText}</p>
          ) : (
            appointments.map((apt) => (
              <div
                key={apt.id}
                id={`apt-${apt.id}`}
                tabIndex={-1}
                aria-current={highlight?.id === apt.id ? "true" : undefined}
                className={`p-4 border rounded focus:outline-none ${highlight?.id === apt.id ? HIGHLIGHT_CLASS : "bg-blue-50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/appointments/${apt.id}`} className="font-semibold hover:underline">
                    {getPatientName(apt)}
                  </Link>
                  <span className={`px-2 py-1 rounded text-sm ${STATUS_STYLES[apt.status] ?? STATUS_STYLES.scheduled}`}>
                    {STATUS_LABELS[apt.status] ?? apt.status}
                  </span>
                </div>
                <div className="text-sm text-gray-600">
                  {formatClock(apt.start_time)} - {formatClock(apt.end_time)}
                </div>
                <div className="text-sm text-gray-600">
                  {getDoctorName(apt)} / {getChairName(apt)}
                </div>
                {apt.procedure_id && <div className="text-sm text-gray-600">{getProcedureName(apt)}</div>}
                {(reminderLabel(apt) || canRemind(apt)) && (
                  <div className="text-sm text-gray-600 flex flex-wrap gap-3">
                    {reminderLabel(apt) && <span>Hatırlatma: {reminderLabel(apt)}</span>}
                    {whatsAppLink(apt)}
                    {canRemind(apt) && (
                      <button onClick={() => setReminder({ id: apt.id })} className="text-blue-600 hover:underline">
                        Hatırlatma sonucu
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {reminder && (
        <ReminderDialog
          key={reminder.id}
          appointmentId={reminder.id}
          fromWhatsApp={reminder.fromWhatsApp}
          onClose={() => setReminder(null)}
          onSaved={(r) => {
            setAppointments((prev) =>
              prev.map((a) =>
                a.id === r.appointment.id
                  ? {
                      ...a,
                      reminder_outcome: r.appointment.reminder_outcome,
                      reminder_note: r.appointment.reminder_note,
                      reminder_start_time: r.appointment.start_time,
                      reminder_doctor_id: r.appointment.doctor_id,
                    }
                  : a
              )
            );
            setReminder(null);
          }}
        />
      )}
    </div>
  );
}
