// Agenda days for the Randevular page. A day is an Istanbul calendar day 'YYYY-MM-DD'. Türkiye has used a fixed
// +03:00 offset since 2016 (the same assumption as lib/crm istanbulIso), so a day's bounds need no time zone database.
// Pure helpers without a Supabase import, so they are unit-tested.

import { isDay } from "../clinical/dates";

const ISTANBUL = "Europe/Istanbul";
const ISTANBUL_OFFSET = "+03:00";
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Turkish weekday names, Sunday first (Date.getUTCDay order). */
export const TR_WEEKDAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"] as const;

/**
 * The half-open range [from, to) of an Istanbul day as UTC ISO timestamps, for
 * `.gte("start_time", from).lt("start_time", to)`. Null for an invalid day.
 */
export function dayRange(day: string): { from: string; to: string } | null {
  if (!isDay(day)) return null;
  const from = new Date(`${day}T00:00:00${ISTANBUL_OFFSET}`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Turkish weekday name of a day ("Cuma"), or "" for an invalid day. */
export function weekdayName(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m || !isDay(day)) return "";
  return TR_WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

/** "16.10.2026 Cuma"; the input unchanged when it is not a day. */
export function formatDayWithWeekday(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m || !isDay(day)) return day;
  return `${m[3]}.${m[2]}.${m[1]} ${weekdayName(day)}`;
}

/** Istanbul wall clock "HH:mm" of a timestamp; "—" when empty or invalid. */
export function formatClock(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("tr-TR", {
    timeZone: ISTANBUL,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU versions print midnight as "24" with hour12: false.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${hour}:${get("minute")}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPatientId = (id: string | null | undefined) => (id && UUID_RE.test(id) ? id : null);

/**
 * The Ajanda's address: `/appointments?date=YYYY-MM-DD`, plus `&patient=<id>` while "Hasta ara" shows a patient, so
 * "Geri" (or "← Randevular") from an appointment's page brings the day and the patient's panel back.
 */
export function agendaHref(day: string | null | undefined, patientId?: string | null): string {
  const q = new URLSearchParams();
  if (isDay(day)) q.set("date", day!);
  const patient = validPatientId(patientId);
  if (patient) q.set("patient", patient);
  const query = q.toString();
  return query ? `/appointments?${query}` : "/appointments";
}

/** `?date=` and `?patient=` of an address (the Ajanda's or an appointment page's); malformed values read as null. */
export function readAgendaQuery(search: string): { date: string | null; patientId: string | null } {
  const q = new URLSearchParams(search);
  const date = q.get("date");
  return { date: isDay(date) ? date : null, patientId: validPatientId(q.get("patient")) };
}

/** An appointment's page; opened from the "Hasta ara" panel it carries the patient, for its "← Randevular" link. */
export function appointmentDetailHref(appointmentId: string, patientId?: string | null): string {
  const patient = validPatientId(patientId);
  return `/appointments/${appointmentId}${patient ? `?patient=${patient}` : ""}`;
}
