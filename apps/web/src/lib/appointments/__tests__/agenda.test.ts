// Agenda day helpers: the Randevular page loads exactly one Istanbul day with [from, to).

import { describe, expect, it } from "vitest";
import {
  agendaHref,
  appointmentDetailHref,
  dayRange,
  formatClock,
  formatDayWithWeekday,
  readAgendaQuery,
  weekdayName,
} from "../agenda";
import { addDays } from "../../clinical/dates";

describe("dayRange", () => {
  it("covers the Istanbul day as a half-open UTC range", () => {
    expect(dayRange("2026-10-15")).toEqual({
      from: "2026-10-14T21:00:00.000Z",
      to: "2026-10-15T21:00:00.000Z",
    });
  });

  it("crosses month and year ends", () => {
    expect(dayRange("2026-12-31")).toEqual({
      from: "2026-12-30T21:00:00.000Z",
      to: "2026-12-31T21:00:00.000Z",
    });
    expect(dayRange("2028-02-29")?.to).toBe("2028-02-29T21:00:00.000Z");
  });

  it("puts an appointment at Istanbul midnight into its own day only", () => {
    const midnight = "2026-10-15T00:00:00+03:00";
    const t = new Date(midnight).getTime();
    const today = dayRange("2026-10-15")!;
    const yesterday = dayRange("2026-10-14")!;
    expect(t >= new Date(today.from).getTime() && t < new Date(today.to).getTime()).toBe(true);
    expect(t >= new Date(yesterday.from).getTime() && t < new Date(yesterday.to).getTime()).toBe(false);
    // Consecutive days touch without a gap.
    expect(yesterday.to).toBe(today.from);
  });

  it("refuses invalid days", () => {
    expect(dayRange("")).toBeNull();
    expect(dayRange("2026-02-30")).toBeNull();
    expect(dayRange("15.10.2026")).toBeNull();
  });
});

describe("day labels", () => {
  it("names Turkish weekdays", () => {
    expect(weekdayName("2026-10-15")).toBe("Perşembe");
    expect(weekdayName("2026-10-16")).toBe("Cuma");
    expect(weekdayName("2026-10-18")).toBe("Pazar");
    expect(weekdayName("2026-10-19")).toBe("Pazartesi");
    expect(weekdayName("2026-10-20")).toBe("Salı");
    expect(weekdayName("2026-10-21")).toBe("Çarşamba");
    expect(weekdayName("2026-10-17")).toBe("Cumartesi");
    expect(weekdayName("nope")).toBe("");
  });

  it("formats dd.MM.yyyy with the weekday", () => {
    expect(formatDayWithWeekday("2026-10-16")).toBe("16.10.2026 Cuma");
    expect(formatDayWithWeekday("x")).toBe("x");
  });

  it("navigates days across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("formatClock", () => {
  it("shows the Istanbul wall clock", () => {
    expect(formatClock("2026-10-16T11:30:00Z")).toBe("14:30");
    expect(formatClock("2026-10-15T21:00:00Z")).toBe("00:00");
    expect(formatClock("2026-10-16T20:59:00Z")).toBe("23:59");
  });

  it("handles empty and invalid input", () => {
    expect(formatClock(null)).toBe("—");
    expect(formatClock("not a date")).toBe("—");
  });
});

describe("Ajanda address (day and 'Hasta ara' patient)", () => {
  const patient = "3f2c1a9e-8b7d-4c6e-9f10-2a3b4c5d6e7f";

  it("keeps the day and, while one is shown, the patient", () => {
    expect(agendaHref("2026-10-16")).toBe("/appointments?date=2026-10-16");
    expect(agendaHref("2026-10-16", patient)).toBe(`/appointments?date=2026-10-16&patient=${patient}`);
    expect(agendaHref("2026-10-16", null)).toBe("/appointments?date=2026-10-16");
  });

  it("drops malformed values", () => {
    expect(agendaHref("2026-13-01", patient)).toBe(`/appointments?patient=${patient}`);
    expect(agendaHref(null, "not-a-uuid")).toBe("/appointments");
    expect(agendaHref("2026-10-16", "x&date=2020-01-01")).toBe("/appointments?date=2026-10-16");
  });

  it("reads back what it writes", () => {
    expect(readAgendaQuery(agendaHref("2026-10-16", patient).split("?")[1])).toEqual({
      date: "2026-10-16",
      patientId: patient,
    });
    expect(readAgendaQuery("?date=2026-10-16")).toEqual({ date: "2026-10-16", patientId: null });
    expect(readAgendaQuery("")).toEqual({ date: null, patientId: null });
    expect(readAgendaQuery("?date=16.10.2026&patient=1")).toEqual({ date: null, patientId: null });
  });

  it("links an appointment's page with the panel's patient only", () => {
    expect(appointmentDetailHref("a1", patient)).toBe(`/appointments/a1?patient=${patient}`);
    expect(appointmentDetailHref("a1", null)).toBe("/appointments/a1");
    expect(appointmentDetailHref("a1", "javascript:alert(1)")).toBe("/appointments/a1");
  });
});
