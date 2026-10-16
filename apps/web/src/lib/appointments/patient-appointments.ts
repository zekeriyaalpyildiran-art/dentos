// "Hasta ara" on the Ajanda: one patient's appointments, upcoming first, then the last few past ones. Days are Istanbul
// calendar days (fixed +03:00, see agenda.ts). Pure helpers without a Supabase import, so they are unit-tested.

import { addDays, istanbulDayOf } from "../clinical/dates";
import { dayRange, formatClock, formatDayWithWeekday } from "./agenda";

/** At most this many rows per group; the page asks the server for one more to know whether more exist. */
export const PATIENT_APPOINTMENT_LIMITS = { upcoming: 10, past: 5 } as const;

/** Status words and badge colours of the Ajanda (shared by the day list and the patient panel). */
export const AGENDA_STATUS_LABELS: Record<string, string> = {
  scheduled: "Planlı",
  completed: "Tamamlandı",
  cancelled: "İptal",
  no_show: "Gelmedi",
};

export const AGENDA_STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-yellow-100 text-yellow-800",
};

export function agendaStatusLabel(status: string | null | undefined): string {
  return (status && AGENDA_STATUS_LABELS[status]) || status || "—";
}

export function agendaStatusStyle(status: string | null | undefined): string {
  return (status && AGENDA_STATUS_STYLES[status]) || "bg-gray-100 text-gray-800";
}

/**
 * The instant that separates upcoming from past: the start of `today` in Istanbul. Today's appointments count as
 * upcoming, also those already over, so the receptionist sees the whole day of a patient who is in the clinic today.
 * Null for an invalid day.
 */
export function upcomingFrom(today: string): string | null {
  return dayRange(today)?.from ?? null;
}

interface Timed {
  id: string;
  start_time: string;
}

export interface PatientAppointmentGroups<T> {
  /** From today on, earliest first. */
  upcoming: T[];
  /** Before today, latest first. */
  past: T[];
  moreUpcoming: boolean;
  morePast: boolean;
}

function startMs(row: Timed): number {
  return new Date(row.start_time).getTime();
}

/**
 * Splits rows by the Istanbul day of their start (today and later = upcoming), sorts each group (upcoming ascending,
 * past descending, id as tie-break) and cuts it to the limit. Rows without a valid start and repeated ids are dropped.
 */
export function groupPatientAppointments<T extends Timed>(
  rows: readonly T[],
  today: string,
  limits: { upcoming: number; past: number } = PATIENT_APPOINTMENT_LIMITS
): PatientAppointmentGroups<T> {
  const seen = new Set<string>();
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const row of rows) {
    if (!row || seen.has(row.id)) continue;
    const day = istanbulDayOf(row.start_time);
    if (!day) continue;
    seen.add(row.id);
    (day >= today ? upcoming : past).push(row);
  }
  const byStart = (a: T, b: T) => startMs(a) - startMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  upcoming.sort(byStart);
  past.sort((a, b) => byStart(b, a));
  return {
    upcoming: upcoming.slice(0, limits.upcoming),
    past: past.slice(0, limits.past),
    moreUpcoming: upcoming.length > limits.upcoming,
    morePast: past.length > limits.past,
  };
}

/** Istanbul day 'YYYY-MM-DD' of an appointment (for "Güne git"), or null. */
export function appointmentDay(startTime: string | null | undefined): string | null {
  return istanbulDayOf(startTime);
}

/** "16.10.2026 Cuma" in Istanbul time; "—" when the start is missing or invalid. */
export function appointmentDayLabel(startTime: string | null | undefined): string {
  const day = istanbulDayOf(startTime);
  return day ? formatDayWithWeekday(day) : "—";
}

/** "14:30–15:15" (Istanbul wall clock); only the start when the end is missing or invalid. */
export function appointmentTimeLabel(startTime: string | null | undefined, endTime?: string | null): string {
  const start = formatClock(startTime);
  const end = formatClock(endTime);
  return end === "—" || start === "—" ? start : `${start}–${end}`;
}

/** "Bugün", "Yarın" or "Dün" next to the date, or null for any other day. */
export function relativeDayWord(day: string | null | undefined, today: string): string | null {
  if (!day) return null;
  if (day === today) return "Bugün";
  if (day === addDays(today, 1)) return "Yarın";
  if (day === addDays(today, -1)) return "Dün";
  return null;
}

/** Panel title: "Ayşe Yılmaz · randevular". */
export function patientAppointmentsTitle(fullName: string | null | undefined): string {
  const name = (fullName ?? "").trim();
  return `${name || "Hasta"} · randevular`;
}
