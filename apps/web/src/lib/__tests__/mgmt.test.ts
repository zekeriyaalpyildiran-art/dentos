import { describe, expect, it } from "vitest";
import { addDays, completionRate, dueState, groupBoard, isoWeekday, itemPayload, scheduleLabel, type BoardItem } from "../mgmt";

const row = (over: Partial<BoardItem>): BoardItem => ({
  id: "i",
  title: "t",
  detail: "",
  area: "genel",
  frequency: "daily",
  weekdays: [1, 2, 3, 4, 5, 6],
  weekday: null,
  month_day: null,
  link_href: null,
  sort_order: 0,
  is_active: true,
  active_from: "2026-11-06",
  period_start: "2026-11-06",
  due_date: "2026-11-06",
  done: false,
  done_at: null,
  done_by: null,
  done_by_name: null,
  note: "",
  ...over,
});

describe("mgmt helpers", () => {
  it("does calendar arithmetic across month ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isoWeekday("2026-11-06")).toBe(5);
    expect(isoWeekday("2026-11-08")).toBe(7);
  });

  it("labels schedules", () => {
    expect(scheduleLabel({ frequency: "daily", weekdays: [1, 2, 3, 4, 5, 6], weekday: null, month_day: null })).toBe("Her gün (Pzt–Cmt)");
    expect(scheduleLabel({ frequency: "daily", weekdays: [1, 2, 3, 4, 5, 6, 7], weekday: null, month_day: null })).toBe("Her gün");
    expect(scheduleLabel({ frequency: "daily", weekdays: [1, 3], weekday: null, month_day: null })).toBe("Pzt, Çar");
    expect(scheduleLabel({ frequency: "weekly", weekdays: [], weekday: 5, month_day: null })).toBe("Her Cuma");
    expect(scheduleLabel({ frequency: "monthly", weekdays: [], weekday: null, month_day: 7 })).toBe("Her ayın 7. günü");
  });

  it("gives the due state of a row", () => {
    expect(dueState(row({ done: true, due_date: "2026-11-01" }), "2026-11-06")).toBe("done");
    expect(dueState(row({ due_date: "2026-11-05" }), "2026-11-06")).toBe("late");
    expect(dueState(row({ due_date: "2026-11-06" }), "2026-11-06")).toBe("today");
    expect(dueState(row({ due_date: "2026-11-07" }), "2026-11-06")).toBe("upcoming");
  });

  it("rates completion and groups rows by frequency", () => {
    expect(completionRate(0, 0)).toBeNull();
    expect(completionRate(2, 3)).toBe(67);
    const groups = groupBoard([row({ id: "m", frequency: "monthly" }), row({ id: "d" })]);
    expect(groups.map((g) => g.title)).toEqual(["Bugün", "Bu ay"]);
  });

  it("sends only the chosen frequency's schedule fields", () => {
    const base = { title: " Kasa ", detail: "", area: "finans" as const, weekdays: [1], weekday: 3, month_day: 9, link_href: null, sort_order: 1 };
    expect(itemPayload({ ...base, frequency: "weekly" })).toMatchObject({ title: "Kasa", weekdays: [], weekday: 3, month_day: null });
    expect(itemPayload({ ...base, frequency: "monthly" })).toMatchObject({ weekdays: [], weekday: null, month_day: 9 });
    expect(itemPayload({ ...base, frequency: "daily" })).toMatchObject({ weekdays: [1], weekday: null, month_day: null });
  });
});
