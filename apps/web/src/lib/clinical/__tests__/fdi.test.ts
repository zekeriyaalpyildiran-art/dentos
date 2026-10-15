// FDI vectors F1-F4 (spec p9_clinical §8.3).

import { describe, expect, it } from "vitest";
import { ALL_PERMANENT_FDI, FDI_ROWS, isPermanentFdi, parseFdi } from "../fdi";

const VALID = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48];

describe("isPermanentFdi", () => {
  it("F1: the 32 permanent teeth are valid", () => {
    expect(VALID).toHaveLength(32);
    for (const t of VALID) expect(isPermanentFdi(t)).toBe(true);
    expect([...ALL_PERMANENT_FDI].sort()).toEqual(VALID);
  });

  it("F2: everything else, primary teeth included, is invalid (CR:25)", () => {
    for (const t of [10, 19, 20, 29, 30, 39, 40, 49, 50, 51, 55, 61, 85, 0, 99, 100, -11]) {
      expect(isPermanentFdi(t)).toBe(false);
    }
    expect(isPermanentFdi(36.5)).toBe(false);
  });
});

describe("parseFdi", () => {
  it("F3: trims and parses two digits", () => {
    expect(parseFdi(" 36 ")).toBe(36);
    expect(parseFdi("36")).toBe(36);
  });

  it("F4: refuses other shapes and invalid teeth", () => {
    for (const s of ["036", "3 6", "3.6", "", "19"]) expect(parseFdi(s)).toBeNull();
  });
});

describe("FDI_ROWS", () => {
  it("lists every permanent tooth once in the dentist's view", () => {
    const flat = FDI_ROWS.flatMap(([right, left]) => [...right, ...left]);
    expect(flat).toHaveLength(32);
    expect(new Set(flat).size).toBe(32);
    expect(FDI_ROWS[0][0][0]).toBe(18);
    expect(FDI_ROWS[1][1][7]).toBe(38);
  });
});
