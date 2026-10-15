// Lab vectors L1-L7 (spec p9_clinical §8.3); the SQL self-check uses the same 21 pairs.

import { describe, expect, it } from "vitest";
import { LAB_STATUSES, type LabStatus } from "../codes";
import { daysLate, isLabLate, labTransitionOk } from "../lab";

const T = true;
const F = false;
// Rows: from; columns: submitted, in_progress, try_in, revision, ready, delivered, cancelled (§1.5).
const COLUMNS: LabStatus[] = ["submitted", "in_progress", "try_in", "revision", "ready", "delivered", "cancelled"];
const MATRIX: Record<LabStatus, boolean[]> = {
  draft: [T, F, F, F, F, F, T],
  submitted: [F, T, T, F, T, F, T],
  in_progress: [F, F, T, F, T, F, T],
  try_in: [F, F, F, T, T, T, T],
  revision: [F, T, T, F, T, F, T],
  ready: [F, F, F, T, F, T, T],
  delivered: [F, F, F, F, T, F, F],
  cancelled: [F, F, F, F, F, F, F],
};

describe("labTransitionOk", () => {
  it("L1: all 64 pairs match the §1.5 table (21 allowed)", () => {
    let allowed = 0;
    for (const from of LAB_STATUSES) {
      for (const to of LAB_STATUSES) {
        const col = COLUMNS.indexOf(to);
        const expected = col >= 0 ? MATRIX[from][col] : false;
        expect(labTransitionOk(from, to), `${from} → ${to}`).toBe(expected);
        if (expected) allowed++;
      }
    }
    expect(allowed).toBe(21);
  });

  it("L2: x → x is never a transition", () => {
    for (const s of LAB_STATUSES) expect(labTransitionOk(s, s)).toBe(false);
  });

  it("unknown statuses are refused", () => {
    expect(labTransitionOk("bogus", "submitted")).toBe(false);
    expect(labTransitionOk("draft", "bogus")).toBe(false);
  });
});

describe("isLabLate / daysLate", () => {
  it("L3: sent and past due", () => {
    expect(isLabLate("submitted", "2026-10-14", "2026-10-15")).toBe(true);
  });
  it("L4: try-in counts (CW:32)", () => {
    expect(isLabLate("try_in", "2026-10-14", "2026-10-15")).toBe(true);
  });
  it("L5: arrived, delivered, cancelled and draft are never late", () => {
    for (const s of ["ready", "delivered", "cancelled", "draft"]) {
      expect(isLabLate(s, "2026-10-01", "2026-10-15")).toBe(false);
    }
  });
  it("L6: due today is not late", () => {
    expect(isLabLate("submitted", "2026-10-15", "2026-10-15")).toBe(false);
  });
  it("L7: days late", () => {
    expect(daysLate("2026-10-12", "2026-10-15")).toBe(3);
  });
});
