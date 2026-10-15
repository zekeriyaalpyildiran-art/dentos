// Agenda day helpers: the Randevular page loads exactly one Istanbul day with [from, to).

import { describe, expect, it } from "vitest";
import { dayRange, formatClock, formatDayWithWeekday, weekdayName } from "../agenda";
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
