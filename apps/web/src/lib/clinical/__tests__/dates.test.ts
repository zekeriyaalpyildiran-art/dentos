// Date vectors D1-D2 (spec p9_clinical §8.3).

import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, addMonths, formatDay, isDay, istanbulToday } from "../dates";

describe("addMonths", () => {
  it("D1: clamps to the last day of the target month", () => {
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2026-10-15", 3)).toBe("2027-01-15");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2026-10-15", 12)).toBe("2027-10-15");
  });
});

describe("istanbulToday", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("D2: the Istanbul day, not the UTC day (CW:13)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T21:30:00Z"));
    expect(istanbulToday()).toBe("2026-10-15");
  });
});

describe("day helpers", () => {
  it("validates, formats and adds days", () => {
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("1999-12-31")).toBe(false);
    expect(formatDay("2026-10-15")).toBe("15.10.2026");
    expect(addDays("2026-10-15", -30)).toBe("2026-09-15");
  });
});
