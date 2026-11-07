import { describe, expect, it } from "vitest";
import { addMonths, localMonth, monthInBounds, monthOptions, monthRange } from "../month-input";

describe("addMonths", () => {
  it("moves across year boundaries both ways", () => {
    expect(addMonths("2026-11", 1)).toBe("2026-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", -23)).toBe("2024-12");
    expect(addMonths("2026-11", 0)).toBe("2026-11");
  });
});

describe("monthRange", () => {
  it("lists months newest first, inclusive", () => {
    expect(monthRange("2026-09", "2026-11")).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(monthRange("2025-12", "2026-01")).toEqual(["2026-01", "2025-12"]);
  });
  it("is empty for reversed or invalid bounds", () => {
    expect(monthRange("2026-11", "2026-09")).toEqual([]);
    expect(monthRange("2026-13", "2026-12")).toEqual([]);
    expect(monthRange("x", "2026-12")).toEqual([]);
  });
});

describe("monthInBounds", () => {
  it("accepts only complete months inside the bounds", () => {
    expect(monthInBounds("2026-10", undefined, "2026-11")).toBe(true);
    expect(monthInBounds("2026-12", undefined, "2026-11")).toBe(false);
    expect(monthInBounds("2026-08", "2026-09")).toBe(false);
    // Partial input while typing in a text box (desktop Safari).
    for (const partial of ["2", "20", "2026", "2026-", "2026-1"]) expect(monthInBounds(partial)).toBe(false);
  });
});

describe("monthOptions", () => {
  it("defaults to 4 years back and 1 year ahead of today", () => {
    const list = monthOptions("2026-11", undefined, undefined, "2026-11");
    expect(list[0]).toBe("2027-11");
    expect(list[list.length - 1]).toBe("2022-11");
    expect(list).toContain("2026-11");
  });
  it("respects max (report pickers stop at the current month)", () => {
    const list = monthOptions("2026-11", undefined, "2026-11", "2026-11");
    expect(list[0]).toBe("2026-11");
    expect(list).toContain("2026-10");
    expect(list).not.toContain("2026-12");
  });
  it("keeps a stored value outside the range selectable", () => {
    const list = monthOptions("2020-03", "2026-01", "2026-03", "2026-03");
    expect(list).toEqual(["2026-03", "2026-02", "2026-01", "2020-03"]);
  });
  it("uses the local month by default", () => {
    expect(monthOptions("", undefined, undefined)).toContain(localMonth());
  });
});
