"use client";

// "Hasta ara" result on the Ajanda: one patient's appointments, upcoming first (today included), then the last few
// past ones. Two small queries filtered by patient_id, ordered and limited on the server; never the whole table.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { istanbulToday } from "@/lib/clinical/dates";
import type { PatientRef } from "@/components/patients/PatientPicker";
import {
  PATIENT_APPOINTMENT_LIMITS,
  agendaStatusLabel,
  agendaStatusStyle,
  appointmentDay,
  appointmentDayLabel,
  appointmentTimeLabel,
  groupPatientAppointments,
  patientAppointmentsTitle,
  relativeDayWord,
  upcomingFrom,
  type PatientAppointmentGroups,
} from "@/lib/appointments/patient-appointments";

interface PatientAppointment {
  id: string;
  start_time: string;
  end_time: string | null;
  status: string | null;
  doctors: { specialty: string | null; users: { full_name: string } | null } | null;
  chairs: { name: string } | null;
  procedures_catalog: { name: string } | null;
}

const COLUMNS =
  "id,start_time,end_time,status,doctors(specialty,users(full_name)),chairs(name),procedures_catalog(name)";

const doctorName = (a: PatientAppointment) => a.doctors?.users?.full_name || a.doctors?.specialty || "Hekim yok";
const chairName = (a: PatientAppointment) => a.chairs?.name || "Koltuk yok";

const actionButton =
  "inline-flex items-center justify-center min-h-[44px] px-3 rounded border border-blue-300 bg-white text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500";

export function PatientAppointmentsPanel({
  patient,
  clinicId,
  reloadKey,
  highlightId,
  onGoToDay,
  onClear,
}: {
  patient: PatientRef;
  clinicId: string;
  /** Changes when the day list changed an appointment, so the panel reloads. */
  reloadKey: number;
  /** The appointment last opened with "Güne git" (marked in the panel too). */
  highlightId: string | null;
  onGoToDay: (day: string, appointmentId: string) => void;
  onClear: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [groups, setGroups] = useState<PatientAppointmentGroups<PatientAppointment> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const today = istanbulToday();
  const titleId = `patient-apts-${patient.id}`;

  useEffect(() => {
    const from = upcomingFrom(today);
    if (!from) return;
    let cancelled = false;
    setFailed(false);
    const base = () =>
      supabase.from("appointments").select(COLUMNS).eq("clinic_id", clinicId).eq("patient_id", patient.id);
    // One extra row per group tells whether more exist.
    Promise.all([
      base()
        .gte("start_time", from)
        .order("start_time")
        .order("id")
        .limit(PATIENT_APPOINTMENT_LIMITS.upcoming + 1),
      base()
        .lt("start_time", from)
        .order("start_time", { ascending: false })
        .order("id", { ascending: false })
        .limit(PATIENT_APPOINTMENT_LIMITS.past + 1),
    ])
      .then(([upcoming, past]) => {
        if (cancelled) return;
        if (upcoming.error || past.error) {
          console.error("Error loading patient appointments:", upcoming.error ?? past.error);
          setGroups(null);
          setFailed(true);
          return;
        }
        const rows = [...(upcoming.data ?? []), ...(past.data ?? [])] as unknown as PatientAppointment[];
        setGroups(groupPatientAppointments(rows, today));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Error loading patient appointments:", err);
        setGroups(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, clinicId, patient.id, today, reloadKey, attempt]);

  const renderRow = (a: PatientAppointment) => {
    const day = appointmentDay(a.start_time);
    const dayLabel = appointmentDayLabel(a.start_time);
    const time = appointmentTimeLabel(a.start_time, a.end_time);
    const rel = relativeDayWord(day, today);
    const marked = a.id === highlightId;
    return (
      <li
        key={a.id}
        className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 ${
          marked ? "-mx-2 px-2 rounded bg-amber-50 ring-2 ring-inset ring-amber-400" : ""
        }`}
      >
        <div className="min-w-0">
          <p className="font-medium text-gray-900">
            {dayLabel}
            {rel && <span className="ml-2 text-xs font-semibold text-blue-700">{rel}</span>}
            <span className="text-gray-700"> · {time}</span>
          </p>
          <p className="text-sm text-gray-600">
            {doctorName(a)} · {chairName(a)}
            {a.procedures_catalog?.name ? ` · ${a.procedures_catalog.name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`px-2 py-1 rounded text-xs font-medium ${agendaStatusStyle(a.status)}`}>
            {agendaStatusLabel(a.status)}
          </span>
          {day && (
            <button
              type="button"
              className={actionButton}
              onClick={() => onGoToDay(day, a.id)}
              aria-label={`Güne git: ${dayLabel} ${time}`}
            >
              Güne git
            </button>
          )}
          <Link href={`/appointments/${a.id}`} className={actionButton} aria-label={`Detay: ${dayLabel} ${time}`}>
            Detay
          </Link>
        </div>
      </li>
    );
  };

  return (
    <section aria-labelledby={titleId} className="mb-6 rounded-lg border border-blue-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} className="text-lg font-semibold text-gray-900 break-words">
          {patientAppointmentsTitle(patient.full_name)}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Link href={`/patients/${patient.id}`} className={actionButton}>
            Hasta kartı
          </Link>
          <button type="button" className={actionButton} onClick={onClear} aria-label="Hasta aramasını temizle">
            Temizle
          </button>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {failed
          ? ""
          : !groups
            ? "Randevular yükleniyor."
            : `${groups.upcoming.length} yaklaşan, ${groups.past.length} geçmiş randevu listelendi.`}
      </p>
      <div>
        {failed ? (
          <p className="mt-3 text-sm text-red-700" role="alert">
            Randevular yüklenemedi.{" "}
            <button type="button" className="underline font-medium" onClick={() => setAttempt((n) => n + 1)}>
              Tekrar dene
            </button>
          </p>
        ) : !groups ? (
          <p className="mt-3 text-sm text-gray-600">Yükleniyor...</p>
        ) : (
          <>
            <h3 className="mt-4 text-sm font-semibold text-gray-700">Yaklaşan</h3>
            {groups.upcoming.length === 0 ? (
              <p className="mt-1 text-sm text-gray-600">Bugün ve sonrasında randevusu yok.</p>
            ) : (
              <ul className="divide-y divide-gray-200">{groups.upcoming.map(renderRow)}</ul>
            )}
            {groups.moreUpcoming && (
              <p className="mt-1 text-xs text-gray-600">
                İlk {PATIENT_APPOINTMENT_LIMITS.upcoming} yaklaşan randevu gösteriliyor.
              </p>
            )}

            <h3 className="mt-4 text-sm font-semibold text-gray-700">
              Geçmiş (son {PATIENT_APPOINTMENT_LIMITS.past})
            </h3>
            {groups.past.length === 0 ? (
              <p className="mt-1 text-sm text-gray-600">Geçmiş randevusu yok.</p>
            ) : (
              <ul className="divide-y divide-gray-200">{groups.past.map(renderRow)}</ul>
            )}
            {groups.morePast && (
              <p className="mt-1 text-xs text-gray-600">
                Daha eski randevular için{" "}
                <Link href={`/patients/${patient.id}`} className="text-blue-700 underline">
                  hasta kartındaki Randevular sekmesine
                </Link>{" "}
                bakın.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
