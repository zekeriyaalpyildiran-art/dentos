// "Hasta ara" panel on the Ajanda: grouping by Istanbul day and the labels. Synthetic rows only.

import { describe, expect, it } from "vitest";
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
} from "../patient-appointments";

const row = (id: string, start_time: string) => ({ id, start_time });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("upcomingFrom", () => {
  it("is the start of the Istanbul day", () => {
    expect(upcomingFrom("2026-10-16")).toBe("2026-10-15T21:00:00.000Z");
    expect(upcomingFrom("2026-13-01")).toBeNull();
  });
});

describe("groupPatientAppointments", () => {
  const today = "2026-10-16";

  it("counts the whole Istanbul day as upcoming, already finished appointments of today included", () => {
    const g = groupPatientAppointments(
      [
        row("late-yesterday", "2026-10-15T23:30:00+03:00"), // 20:30 UTC on the 15th
        row("early-today", "2026-10-16T00:10:00+03:00"), // 21:10 UTC on the 15th: already today in Istanbul
        row("this-morning", "2026-10-16T09:00:00+03:00"),
        row("tomorrow", "2026-10-17T10:00:00+03:00"),
      ],
      today
    );
    expect(ids(g.upcoming)).toEqual(["early-today", "this-morning", "tomorrow"]);
    expect(ids(g.past)).toEqual(["late-yesterday"]);
  });

  it("puts upcoming earliest first and past latest first, id breaking ties", () => {
    const g = groupPatientAppointments(
      [
        row("p1", "2026-01-05T10:00:00+03:00"),
        row("u2", "2026-11-02T10:00:00+03:00"),
        row("p3", "2026-09-30T10:00:00+03:00"),
        row("u1", "2026-10-20T10:00:00+03:00"),
        row("u0b", "2026-10-20T07:00:00Z"),
        row("u0a", "2026-10-20T07:00:00Z"),
      ],
      today
    );
    // u0a, u0b and u1 start at the same instant (10:00 Istanbul).
    expect(ids(g.upcoming)).toEqual(["u0a", "u0b", "u1", "u2"]);
    expect(ids(g.past)).toEqual(["p3", "p1"]);
  });

  it("cuts each group to its limit and says whether more exist", () => {
    expect(PATIENT_APPOINTMENT_LIMITS).toEqual({ upcoming: 10, past: 5 });
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => row(`u${String(i).padStart(2, "0")}`, `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00+03:00`)),
      ...Array.from({ length: 6 }, (_, i) => row(`p${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00+03:00`)),
    ];
    const g = groupPatientAppointments(rows, today);
    expect(g.upcoming).toHaveLength(10);
    expect(g.upcoming[0].id).toBe("u00");
    expect(g.moreUpcoming).toBe(true);
    expect(g.past).toHaveLength(5);
    expect(ids(g.past)).toEqual(["p5", "p4", "p3", "p2", "p1"]);
    expect(g.morePast).toBe(true);

    const small = groupPatientAppointments(rows.slice(0, 2), today, { upcoming: 2, past: 1 });
    expect(small.moreUpcoming).toBe(false);
    expect(small.morePast).toBe(false);
  });

  it("drops rows without a valid start and repeated ids", () => {
    const g = groupPatientAppointments(
      [row("a", "2026-10-20T10:00:00+03:00"), row("a", "2026-10-21T10:00:00+03:00"), row("bad", "not a date"), row("empty", "")],
      today
    );
    expect(ids(g.upcoming)).toEqual(["a"]);
    expect(g.past).toEqual([]);
  });

  it("handles a patient without appointments", () => {
    expect(groupPatientAppointments([], today)).toEqual({ upcoming: [], past: [], moreUpcoming: false, morePast: false });
  });
});

describe("labels", () => {
  it("formats the Istanbul date with its weekday", () => {
    expect(appointmentDayLabel("2026-10-16T09:00:00+03:00")).toBe("16.10.2026 Cuma");
    // 22:30 UTC on Saturday is already Sunday in Istanbul.
    expect(appointmentDayLabel("2026-10-17T22:30:00Z")).toBe("18.10.2026 Pazar");
    expect(appointmentDayLabel(null)).toBe("—");
    expect(appointmentDayLabel("x")).toBe("—");
    expect(appointmentDay("2026-10-17T22:30:00Z")).toBe("2026-10-18");
    expect(appointmentDay(undefined)).toBeNull();
  });

  it("formats the time range in Istanbul time", () => {
    expect(appointmentTimeLabel("2026-10-16T11:30:00Z", "2026-10-16T12:15:00Z")).toBe("14:30–15:15");
    expect(appointmentTimeLabel("2026-10-16T11:30:00Z", null)).toBe("14:30");
    expect(appointmentTimeLabel("2026-10-16T11:30:00Z", "bad")).toBe("14:30");
    expect(appointmentTimeLabel(null, "2026-10-16T12:15:00Z")).toBe("—");
  });

  it("names today, tomorrow and yesterday only", () => {
    expect(relativeDayWord("2026-10-16", "2026-10-16")).toBe("Bugün");
    expect(relativeDayWord("2026-10-17", "2026-10-16")).toBe("Yarın");
    expect(relativeDayWord("2026-10-15", "2026-10-16")).toBe("Dün");
    expect(relativeDayWord("2027-01-01", "2026-12-31")).toBe("Yarın");
    expect(relativeDayWord("2026-10-18", "2026-10-16")).toBeNull();
    expect(relativeDayWord(null, "2026-10-16")).toBeNull();
  });

  it("titles the panel with the patient's name", () => {
    expect(patientAppointmentsTitle("Ayşe Yılmaz")).toBe("Ayşe Yılmaz · randevular");
    expect(patientAppointmentsTitle("  ")).toBe("Hasta · randevular");
    expect(patientAppointmentsTitle(null)).toBe("Hasta · randevular");
  });

  it("uses the agenda's status words and colours, with a neutral fallback", () => {
    expect(agendaStatusLabel("scheduled")).toBe("Planlı");
    expect(agendaStatusLabel("completed")).toBe("Tamamlandı");
    expect(agendaStatusLabel("no_show")).toBe("Gelmedi");
    expect(agendaStatusLabel("cancelled")).toBe("İptal");
    expect(agendaStatusLabel("weird")).toBe("weird");
    expect(agendaStatusLabel(null)).toBe("—");
    expect(agendaStatusStyle("cancelled")).toBe("bg-red-100 text-red-800");
    expect(agendaStatusStyle("weird")).toBe("bg-gray-100 text-gray-800");
  });
});
