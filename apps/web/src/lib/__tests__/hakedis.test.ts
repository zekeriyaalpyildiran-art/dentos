// Hakediş engine mirror (spec §1 "Calculation", §2; v1.1 child patients by age; v1.2 staff payroll: fixed_monthly
// salaries and bonus / other adjustments; v1.3 bank / cash split: bank_portion rules; v1.4 lab costs deducted from
// the ciro, minimum_monthly floors and the doctor × lab summary; v2 Macro import: unpaid lines, lines without a
// doctor, procedure groups and procedure_piece rules). Made-up doctors, staff, patients, labs, groups, rates and
// amounts only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMonths,
  ADJUSTMENT_KIND_LABELS,
  allocateByWeight,
  ADJUSTMENTS_COMPONENT_LABEL,
  ageOn,
  applyBp,
  BANK_PORTION_HINT,
  bankOverText,
  bankRuleOf,
  bankSplitOf,
  bankSplitText,
  bpToInput,
  childAgeLimitOf,
  compareCodePoints,
  componentKey,
  componentTitle,
  computeMonth,
  DEDUCT_LABELS,
  emptyPayeeSummary,
  EXT_DOCTOR_MODE_LABELS,
  extDoctorOf,
  findImplantPieceConflict,
  findOverlappingRule,
  finHkAssignPiece,
  HK_MACRO_REF_PREFIX,
  markFor,
  finHkImportMacro,
  finHkSaveAdjustment,
  finHkSaveExtDoctor,
  finHkSaveMark,
  finHkSaveProcGroup,
  finHkSaveRule,
  finHkSaveSettings,
  finHkVoidAdjustment,
  formatBp,
  groupLabCosts,
  hkCanPrepare,
  hkLedgerVisible,
  HK_ADJUSTMENT_DESCRIPTION_MAX,
  HK_DEFAULT_CHILD_AGE_LIMIT,
  HK_KINDS,
  HK_LINE_METHODS,
  hkMarksAccess,
  hkMarksList,
  hkSaveMark,
  importRefusalOf,
  isLabWarning,
  KIND_LABELS,
  kindAllowsAnyUser,
  LAB_DEDUCTION_TEXT,
  LAB_LABELS,
  LAB_SUMMARY_HINT,
  labSummaryByDoctor,
  labTotalsOf,
  markIsChildOn,
  MINIMUM_MONTHLY_HINT,
  METHOD_LABELS,
  MINIMUM_TOPUP_COMPONENT_LABEL,
  minimumRuleOf,
  monthKey,
  monthRangesOverlap,
  monthStart,
  monthStatus,
  normalizeOpNames,
  normalizePatientRef,
  opNameMoves,
  parsePercent,
  pickDefaultMonth,
  pieceFieldLabel,
  procGroupOfOperation,
  resolveSegment,
  roundHalfAwayDiv,
  RULE_FIELDS,
  ruleActiveIn,
  ruleDeductBp,
  ruleOverlapKey,
  salaryRuleOf,
  SPLIT_LABELS,
  sumPayeeSummaries,
  summarizePayee,
  validateAdjustment,
  validateBirthDate,
  validateChildAgeLimit,
  validateExtDoctor,
  validateProcGroup,
  validateRule,
  warningText,
  type HkComponentJson,
  type HkComputeAdjustment,
  type HkComputeInput,
  type HkComputeLabCost,
  type HkComputeLine,
  type HkComputeMark,
  type HkComputeOutput,
  type HkComputePiece,
  type HkComputeProcGroup,
  type HkComputeRule,
  type HkRuleInput,
} from "../hakedis";

// RPC wrappers are checked against a stub client (argument names are the SQL contract).
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("../supabase", () => ({ createClient: () => ({ rpc: rpcMock }) }));

const TL = (n: number) => Math.round(n * 100);

const DOCTORS = [
  { id: "doc-a", name: "Hekim A" },
  { id: "doc-b", name: "Hekim B" },
  { id: "doc-c", name: "Hekim C" },
  { id: "doc-d", name: "Hekim D" },
  { id: "doc-e", name: "Hekim E" },
  { id: "doc-s", name: "Hekim S" },
];
const PAYEES = [
  { user_id: "u-a", name: "Hekim A" },
  { user_id: "u-b", name: "Hekim B" },
  { user_id: "u-c", name: "Hekim C" },
  { user_id: "u-s", name: "Hekim S" },
  // Staff without a doctors row (payroll only).
  { user_id: "u-p1", name: "Personel Bir" },
  { user_id: "u-p2", name: "Personel İki" },
];

let seq = 0;
const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}`;

function rule(p: Partial<HkComputeRule> & Pick<HkComputeRule, "kind" | "payee_user_id">): HkComputeRule {
  return {
    id: nextId("r"),
    doctor_id: null,
    segment: null,
    share_bp: null,
    piece_cents: null,
    deduct_cash_bp: 0,
    deduct_card_bp: 0,
    deduct_transfer_bp: 0,
    deduct_financing_bp: 0,
    from_month: "2026-11-01",
    to_month: null,
    ...p,
  };
}

function line(p: Partial<HkComputeLine> & Pick<HkComputeLine, "doctor_id" | "try_cents">): HkComputeLine {
  return {
    id: nextId("l"),
    day: "2026-11-10",
    patient_ref: "hasta 1",
    method: "cash",
    implant_cents: 0,
    segment: null,
    ...p,
  };
}

function piece(p: Partial<HkComputePiece> & Pick<HkComputePiece, "doctor_id" | "qty">): HkComputePiece {
  return { id: nextId("p"), day: "2026-11-12", ...p };
}

function lab(
  p: Partial<HkComputeLabCost> & Pick<HkComputeLabCost, "patient_ref" | "day" | "amount_cents"> & { lab_name: string }
): HkComputeLabCost & { lab_name: string } {
  return { id: nextId("c"), doctor_id: "doc-s", ...p };
}

function run(input: Omit<HkComputeInput, "doctors" | "payees">): HkComputeOutput {
  return computeMonth({ doctors: DOCTORS, payees: PAYEES, ...input });
}

function component(out: HkComputeOutput, ruleId: string): HkComponentJson {
  for (const p of out.payees) {
    const c = p.components.find((x) => x.rule_id === ruleId);
    if (c) return c;
  }
  throw new Error(`component ${ruleId} not found`);
}

function payeeTotal(out: HkComputeOutput, userId: string): number | undefined {
  return out.payees.find((p) => p.payee_user_id === userId)?.total_cents;
}

function labPartOf(out: HkComputeOutput, lineId: string): number | undefined {
  return out.line_results.find((r) => r.id === lineId)?.lab_part;
}

// Hekim A: 25 % of ciro after card 11 %, havale 9 %, financing 13 %, cash 0 %.
const aStd = () =>
  rule({
    kind: "ciro_share",
    payee_user_id: "u-a",
    doctor_id: "doc-a",
    segment: "standard",
    share_bp: 2500,
    deduct_card_bp: 1100,
    deduct_transfer_bp: 900,
    deduct_financing_bp: 1300,
  });

describe("rounding", () => {
  it("rounds half away from zero, unlike Math.round for negatives", () => {
    expect(applyBp(5, 1000)).toBe(1);
    expect(applyBp(-5, 1000)).toBe(-1);
    expect(Math.round(-0.5)).toBe(-0);
    expect(applyBp(-15, 1000)).toBe(-2);
    expect(Math.round(-1.5)).toBe(-1);
    expect(applyBp(-14, 1000)).toBe(-1);
    expect(applyBp(14, 1000)).toBe(1);
    expect(applyBp(0, 2500)).toBe(0);
    expect(roundHalfAwayDiv(-7n, 2n)).toBe(-4n);
    expect(roundHalfAwayDiv(7n, 2n)).toBe(4n);
  });

  it("is exact past the float range", () => {
    // 999.999.999.999 × 9999 / 10000 = 999.899.999.999,0001
    expect(applyBp(999_999_999_999, 9999)).toBe(999_899_999_999);
    expect(applyBp(-999_999_999_999, 9999)).toBe(-999_899_999_999);
  });

  it("rounds negative buckets and shares half away in the engine", () => {
    const r = rule({
      kind: "ciro_share",
      payee_user_id: "u-a",
      doctor_id: "doc-a",
      segment: "standard",
      share_bp: 5000,
      deduct_card_bp: 5000,
    });
    // card −3 cents: deduction round(−1,5) = −2, base −1, share round(−0,5) = −1
    const out = run({ month: "2026-11", rules: [r], lines: [line({ doctor_id: "doc-a", method: "card", try_cents: -3 })] });
    const c = component(out, r.id);
    expect(c.by_method!.card.deduction).toBe(-2);
    expect(c.base_cents).toBe(-1);
    expect(c.amount_cents).toBe(-1);

    const cash = run({ month: "2026-11", rules: [r], lines: [line({ doctor_id: "doc-a", try_cents: -1 })] });
    expect(component(cash, r.id).amount_cents).toBe(-1);
    const plus = run({ month: "2026-11", rules: [r], lines: [line({ doctor_id: "doc-a", try_cents: 3 })] });
    expect(component(plus, r.id).amount_cents).toBe(2);
  });
});

describe("ciro_share", () => {
  it("deducts by payment method before the share", () => {
    const r = aStd();
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [
        line({ doctor_id: "doc-a", method: "cash", try_cents: TL(10_000) }),
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(10_000) }),
        line({ doctor_id: "doc-a", method: "transfer", try_cents: TL(10_000) }),
        line({ doctor_id: "doc-a", method: "financing", try_cents: TL(10_000) }),
      ],
    });
    const c = component(out, r.id);
    expect(c.by_method!.cash).toEqual({
      gross: TL(10_000),
      implant: 0,
      lab: 0,
      eligible: TL(10_000),
      deduct_bp: 0,
      deduction: 0,
    });
    expect(c.by_method!.card.deduction).toBe(TL(1_100));
    expect(c.by_method!.transfer.deduction).toBe(TL(900));
    expect(c.by_method!.financing.deduction).toBe(TL(1_300));
    expect(c.base_cents).toBe(TL(36_700));
    expect(c.amount_cents).toBe(TL(9_175));
    expect(c.lines_count).toBe(4);
    expect(payeeTotal(out, "u-a")).toBe(TL(9_175));
    expect(out.warnings).toEqual([]);
  });

  it("keeps the implant part out of the doctor's ciro", () => {
    const r = aStd();
    const l = line({ doctor_id: "doc-a", method: "card", try_cents: TL(30_000), implant_cents: TL(10_000) });
    const out = run({ month: "2026-11", rules: [r], lines: [l] });
    const b = component(out, r.id).by_method!.card;
    expect(b).toMatchObject({ gross: TL(30_000), implant: TL(10_000), eligible: TL(20_000), deduction: TL(2_200) });
    expect(component(out, r.id).base_cents).toBe(TL(17_800));
    expect(component(out, r.id).amount_cents).toBe(TL(4_450));
    expect(out.line_results).toEqual([{ id: l.id, segment: "standard", rule_id: r.id, lab_part: 0 }]);
  });

  it("takes negative correction lines into the buckets", () => {
    const r = aStd();
    const nov = run({
      month: "2026-11",
      rules: [r],
      lines: [
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(10_000) }),
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(-2_000) }),
      ],
    });
    expect(component(nov, r.id).by_method!.card).toMatchObject({ eligible: TL(8_000), deduction: TL(880) });
    expect(component(nov, r.id).amount_cents).toBe(TL(1_780));

    // A month with only a correction gives a negative share.
    const dec = run({
      month: "2026-12",
      rules: [r],
      lines: [line({ doctor_id: "doc-a", day: "2026-12-03", method: "card", try_cents: TL(-2_000) })],
    });
    expect(component(dec, r.id).by_method!.card.deduction).toBe(TL(-220));
    expect(component(dec, r.id).base_cents).toBe(TL(-1_780));
    expect(payeeTotal(dec, "u-a")).toBe(TL(-445));
  });
});

describe("segments", () => {
  const rules = () => {
    const bStd = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "standard", share_bp: 2500 });
    const bChild = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "child", share_bp: 3200 });
    const cStd = rule({ kind: "ciro_share", payee_user_id: "u-c", doctor_id: "doc-c", segment: "standard", share_bp: 2500 });
    const cOwn = rule({ kind: "ciro_share", payee_user_id: "u-c", doctor_id: "doc-c", segment: "own", share_bp: 3200 });
    return { bStd, bChild, cStd, cOwn };
  };
  const marks = [
    { patient_ref: "cocuk 1", own_doctor_id: null, is_child: true },
    { patient_ref: "kendi 1", own_doctor_id: "doc-c", is_child: false },
    { patient_ref: "ikisi 1", own_doctor_id: "doc-c", is_child: true },
  ];

  it("resolves child and own marks, with fallback to standard", () => {
    const { bStd, bChild, cStd, cOwn } = rules();
    const t = TL(10_000);
    const lines = {
      bChildMark: line({ doctor_id: "doc-b", patient_ref: "cocuk 1", try_cents: t }),
      bOtherOwn: line({ doctor_id: "doc-b", patient_ref: "kendi 1", try_cents: t }),
      bOverride: line({ doctor_id: "doc-b", patient_ref: "hasta 2", segment: "child", try_cents: t }),
      bOwnNoRule: line({ doctor_id: "doc-b", patient_ref: "hasta 3", segment: "own", try_cents: t }),
      bBoth: line({ doctor_id: "doc-b", patient_ref: "ikisi 1", try_cents: t }),
      cOwnMark: line({ doctor_id: "doc-c", patient_ref: "kendi 1", try_cents: t }),
      cChildNoRule: line({ doctor_id: "doc-c", patient_ref: "cocuk 1", try_cents: t }),
      cBoth: line({ doctor_id: "doc-c", patient_ref: "ikisi 1", try_cents: t }),
    };
    const out = run({ month: "2026-11", rules: [bStd, bChild, cStd, cOwn], lines: Object.values(lines), marks });
    const res = (l: HkComputeLine) => out.line_results.find((r) => r.id === l.id)!;

    expect(res(lines.bChildMark)).toMatchObject({ segment: "child", rule_id: bChild.id });
    // Someone else's own patient is a standard patient for this doctor.
    expect(res(lines.bOtherOwn)).toMatchObject({ segment: "standard", rule_id: bStd.id });
    expect(res(lines.bOverride)).toMatchObject({ segment: "child", rule_id: bChild.id });
    // No 'own' rule for Hekim B → the standard rule.
    expect(res(lines.bOwnNoRule)).toMatchObject({ segment: "own", rule_id: bStd.id });
    expect(res(lines.bBoth)).toMatchObject({ segment: "child", rule_id: bChild.id });
    // 'own' wins over 'child' for the own doctor.
    expect(res(lines.cOwnMark)).toMatchObject({ segment: "own", rule_id: cOwn.id });
    expect(res(lines.cBoth)).toMatchObject({ segment: "own", rule_id: cOwn.id });
    expect(res(lines.cChildNoRule)).toMatchObject({ segment: "child", rule_id: cStd.id });

    expect(component(out, bChild.id)).toMatchObject({ lines_count: 3, base_cents: TL(30_000), amount_cents: TL(9_600) });
    expect(component(out, bStd.id)).toMatchObject({ lines_count: 2, base_cents: TL(20_000), amount_cents: TL(5_000) });
    expect(component(out, cOwn.id)).toMatchObject({ lines_count: 2, amount_cents: TL(6_400) });
    expect(component(out, cStd.id)).toMatchObject({ lines_count: 1, amount_cents: TL(2_500) });
    expect(payeeTotal(out, "u-b")).toBe(TL(14_600));
    expect(payeeTotal(out, "u-c")).toBe(TL(8_900));
    expect(out.warnings).toEqual([]);
  });

  it("resolveSegment order: override, own doctor, child, standard", () => {
    const day = "2026-11-10";
    expect(resolveSegment({ segment: "standard", doctor_id: "doc-c", day }, marks[1])).toBe("standard");
    expect(resolveSegment({ segment: null, doctor_id: "doc-c", day }, marks[2])).toBe("own");
    expect(resolveSegment({ segment: null, doctor_id: "doc-b", day }, marks[2])).toBe("child");
    expect(resolveSegment({ segment: null, doctor_id: "doc-b", day }, null)).toBe("standard");
  });

  it("orders components by kind, then doctor, then segment (SQL kind_ord, doctor_name, seg_ord)", () => {
    const { bStd, bChild } = rules();
    const out = run({ month: "2026-11", rules: [bChild, bStd], lines: [] });
    expect(out.payees[0].components.map((c) => c.segment)).toEqual(["standard", "child"]);
    expect(componentTitle(out.payees[0].components[1])).toBe("Ciro payı · Çocuk hasta · Hekim B");

    // One payee with ciro rules on two doctors: doctor before segment.
    const own = (doctor: string, segment: "standard" | "child" | "own") =>
      rule({ kind: "ciro_share", payee_user_id: "u-a", doctor_id: doctor, segment, share_bp: 2500 });
    const cChild = own("doc-c", "child");
    const bOwn = own("doc-b", "own");
    const cStd = own("doc-c", "standard");
    const implant = rule({ kind: "implant_piece", payee_user_id: "u-a", doctor_id: "doc-a", piece_cents: TL(100) });
    const multi = run({ month: "2026-11", rules: [implant, cChild, bOwn, cStd], lines: [] });
    expect(multi.payees[0].components.map((c) => c.rule_id)).toEqual([bOwn.id, cStd.id, cChild.id, implant.id]);
  });
});

// Independent port of PostgreSQL timestamp_age() on the date fields (dt1 = day, dt2 = birth), the year field of
// date_part('year', age(day, birth)): field differences, sign flip when dt1 < dt2, day borrow from the earlier date's
// month, month borrow from the year.
function pgAgeYears(birth: string, day: string): number {
  const [y2, m2, d2] = birth.split("-").map(Number);
  const [y1, m1, d1] = day.split("-").map(Number);
  const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const negative = day < birth;
  let year = y1 - y2;
  let mon = m1 - m2;
  let mday = d1 - d2;
  if (negative) {
    year = -year;
    mon = -mon;
    mday = -mday;
  }
  while (mday < 0) {
    mday += negative ? dim(y1, m1) : dim(y2, m2);
    mon -= 1;
  }
  while (mon < 0) {
    mon += 12;
    year -= 1;
  }
  return negative ? -year || 0 : year;
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

describe("child patients by age (v1.1)", () => {
  it("ageOn counts whole years like PostgreSQL age(): the birthday itself and the day before", () => {
    expect(ageOn("2012-06-15", "2026-06-15")).toBe(14);
    expect(ageOn("2012-06-15", "2026-06-14")).toBe(13);
    expect(ageOn("2012-06-15", "2026-06-15T10:30:00Z")).toBe(14);
    expect(ageOn("2000-01-31", "2014-01-30")).toBe(13);
    expect(ageOn("2000-01-31", "2014-01-31")).toBe(14);
    expect(ageOn("2012-12-31", "2026-12-30")).toBe(13);
    expect(ageOn("2012-12-31", "2027-01-01")).toBe(14);
    expect(ageOn("2026-03-01", "2026-03-01")).toBe(0);
  });

  it("ageOn reaches a 29 February birthday on 1 March in non-leap years", () => {
    expect(ageOn("2012-02-29", "2026-02-28")).toBe(13);
    expect(ageOn("2012-02-29", "2026-03-01")).toBe(14);
    expect(ageOn("2012-02-29", "2028-02-28")).toBe(15);
    expect(ageOn("2012-02-29", "2028-02-29")).toBe(16);
    expect(ageOn("2011-03-01", "2024-02-29")).toBe(12);
    expect(ageOn("2011-02-28", "2024-02-29")).toBe(13);
  });

  it("ageOn before the birth date is the negated age (0 within the first year); bad dates give null", () => {
    expect(ageOn("2026-06-01", "2026-01-01")).toBe(0);
    expect(ageOn("2026-06-01", "2025-06-02")).toBe(0);
    expect(ageOn("2026-06-01", "2025-06-01")).toBe(-1);
    expect(ageOn("2026-06-01", "2024-01-01")).toBe(-2);
    expect(ageOn("2026-02-30", "2026-03-01")).toBeNull();
    expect(ageOn("2025-02-29", "2026-03-01")).toBeNull();
    expect(ageOn("15.06.2012", "2026-06-15")).toBeNull();
    expect(ageOn(null, "2026-06-15")).toBeNull();
    expect(ageOn("2012-06-15", "")).toBeNull();
  });

  it("ageOn equals the PostgreSQL age() port day by day around month ends and leap days", () => {
    const births = [
      "2000-02-29", "2012-02-29", "2011-02-28", "2011-03-01", "2012-01-31", "2012-03-31", "2012-04-30",
      "2012-12-31", "2013-01-01", "2012-11-20", "2025-02-28", "2026-02-28", "2026-03-01", "2027-02-28",
      "2028-02-29",
    ];
    const days = eachDay("2023-12-01", "2028-03-31");
    let checked = 0;
    for (const birth of births) {
      for (const day of days) {
        const expected = pgAgeYears(birth, day);
        if (ageOn(birth, day) !== expected) throw new Error(`ageOn(${birth}, ${day}) ≠ ${expected}`);
        checked += 1;
      }
    }
    expect(checked).toBe(births.length * days.length);
  });

  it("a birth date decides by the age on the payment day; without one the is_child mark is used", () => {
    const born = (birth_date: string | null, is_child = false, own_doctor_id: string | null = null) => ({
      own_doctor_id,
      is_child,
      birth_date,
    });
    const seg = (day: string, mark: Parameters<typeof resolveSegment>[1], limit?: number) =>
      resolveSegment({ segment: null, doctor_id: "doc-b", day }, mark, limit);

    // Turns 14 on the payment day: no longer a child that day, still one the day before.
    expect(seg("2026-06-14", born("2012-06-15"))).toBe("child");
    expect(seg("2026-06-15", born("2012-06-15"))).toBe("standard");
    // 29 February birthday in a non-leap year: still 13 on 28 February, 14 on 1 March.
    expect(seg("2026-02-28", born("2012-02-29"))).toBe("child");
    expect(seg("2026-03-01", born("2012-02-29"))).toBe("standard");
    // is_child fallback only without a birth date; a birth date wins over the manual mark either way.
    expect(seg("2026-11-10", born(null, true))).toBe("child");
    expect(seg("2026-11-10", born(null, false))).toBe("standard");
    expect(seg("2026-11-10", born("2000-01-01", true))).toBe("standard");
    expect(seg("2026-11-10", born("2020-01-01", false))).toBe("child");
    // The limit is data.
    expect(seg("2026-04-30", born("2013-05-01"))).toBe("child");
    expect(seg("2026-04-30", born("2013-05-01"), 12)).toBe("standard");
    expect(seg("2026-04-29", born("2013-04-30"), 13)).toBe("child");
    // Override and own doctor still come first.
    const day = "2026-11-10";
    const ownChild = born("2020-01-01", false, "doc-c");
    expect(resolveSegment({ segment: "standard", doctor_id: "doc-b", day }, born("2020-01-01"))).toBe("standard");
    expect(resolveSegment({ segment: null, doctor_id: "doc-c", day }, ownChild)).toBe("own");
    expect(resolveSegment({ segment: null, doctor_id: "doc-b", day }, ownChild)).toBe("child");
    expect(markIsChildOn(null, "2026-11-10")).toBe(false);
    expect(markIsChildOn({ is_child: true }, "2026-11-10")).toBe(true);
  });

  it("splits one patient's payments around the birthday in computeMonth (default limit)", () => {
    const bStd = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "standard", share_bp: 2500 });
    const bChild = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "child", share_bp: 3200 });
    const marks: HkComputeMark[] = [
      { patient_ref: "cocuk yas 1", own_doctor_id: null, is_child: false, birth_date: "2012-11-20" },
      { patient_ref: "cocuk isaret 1", own_doctor_id: null, is_child: true, birth_date: null },
      { patient_ref: "yetiskin 1", own_doctor_id: null, is_child: true, birth_date: "1990-05-05" },
    ];
    const t = TL(10_000);
    const dayBefore = line({ doctor_id: "doc-b", patient_ref: "cocuk yas 1", day: "2026-11-19", try_cents: t });
    const birthday = line({ doctor_id: "doc-b", patient_ref: "cocuk yas 1", day: "2026-11-20", try_cents: t });
    const marked = line({ doctor_id: "doc-b", patient_ref: "cocuk isaret 1", day: "2026-11-21", try_cents: t });
    const adult = line({ doctor_id: "doc-b", patient_ref: "yetiskin 1", day: "2026-11-22", try_cents: t });
    const lines = [dayBefore, birthday, marked, adult];

    const defaults = [undefined, null, {}, { child_age_limit: null }, { child_age_limit: HK_DEFAULT_CHILD_AGE_LIMIT }];
    for (const settings of defaults) {
      const out = run({ month: "2026-11", rules: [bStd, bChild], lines, marks, settings });
      expect(out.line_results.map((r) => [r.id, r.segment, r.rule_id])).toEqual([
        [dayBefore.id, "child", bChild.id],
        [birthday.id, "standard", bStd.id],
        [marked.id, "child", bChild.id],
        [adult.id, "standard", bStd.id],
      ]);
      expect(component(out, bChild.id)).toMatchObject({ lines_count: 2, base_cents: TL(20_000), amount_cents: TL(6_400) });
      expect(component(out, bStd.id)).toMatchObject({ lines_count: 2, base_cents: TL(20_000), amount_cents: TL(5_000) });
      expect(payeeTotal(out, "u-b")).toBe(TL(11_400));
    }
    expect(HK_DEFAULT_CHILD_AGE_LIMIT).toBe(14);
  });

  it("uses settings.child_age_limit, with 29 February birthdays reached on 1 March", () => {
    const bStd = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "standard", share_bp: 2500 });
    const bChild = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "child", share_bp: 3200 });
    const marks: HkComputeMark[] = [
      { patient_ref: "subat 1", own_doctor_id: null, is_child: false, birth_date: "2012-02-29" },
    ];
    const feb = line({ doctor_id: "doc-b", patient_ref: "subat 1", day: "2027-02-28", try_cents: TL(1_000) });
    const mar = line({ doctor_id: "doc-b", patient_ref: "subat 1", day: "2027-03-01", try_cents: TL(1_000) });
    const at = (month: string, child_age_limit?: number) =>
      run({ month, rules: [bStd, bChild], lines: [feb, mar], marks, settings: { child_age_limit } });

    // Limit 15: 14 on 28 February 2027 (child), 15 on 1 March 2027 (standard).
    expect(at("2027-02", 15).line_results).toEqual([{ id: feb.id, segment: "child", rule_id: bChild.id, lab_part: 0 }]);
    expect(at("2027-03", 15).line_results).toEqual([{ id: mar.id, segment: "standard", rule_id: bStd.id, lab_part: 0 }]);
    expect(payeeTotal(at("2027-02", 15), "u-b")).toBe(TL(320));
    expect(payeeTotal(at("2027-03", 15), "u-b")).toBe(TL(250));
    // Default 14: both are standard.
    expect(at("2027-02").line_results[0].segment).toBe("standard");
    // A child line without a child rule falls back to the standard rule.
    const out = run({ month: "2027-02", rules: [bStd], lines: [feb], marks, settings: { child_age_limit: 15 } });
    expect(out.line_results[0]).toMatchObject({ segment: "child", rule_id: bStd.id });
  });

  it("checks the limit and birth date inputs", () => {
    expect(childAgeLimitOf(undefined)).toBe(14);
    expect(childAgeLimitOf({ child_age_limit: null })).toBe(14);
    expect(childAgeLimitOf({ child_age_limit: 12 })).toBe(12);
    expect(validateChildAgeLimit(1)).toBeNull();
    expect(validateChildAgeLimit(18)).toBeNull();
    for (const bad of [0, 19, 12.5, Number.NaN, null]) expect(validateChildAgeLimit(bad)).not.toBeNull();

    const today = "2026-10-18";
    expect(validateBirthDate("", today)).toBeNull();
    expect(validateBirthDate(null, today)).toBeNull();
    expect(validateBirthDate("2026-10-18", today)).toBeNull();
    expect(validateBirthDate("1900-01-01", today)).toBeNull();
    expect(validateBirthDate("2024-02-29", today)).toBeNull();
    expect(validateBirthDate("2026-10-19", today)).toBe("Doğum tarihi bugünden sonra olamaz.");
    expect(validateBirthDate("1899-12-31", today)).toBe("Doğum tarihi 1900'den önce olamaz.");
    expect(validateBirthDate("2025-02-29", today)).toBe("Doğum tarihi geçersiz.");
    expect(validateBirthDate("18.10.2020", today)).toBe("Doğum tarihi geçersiz.");
  });
});

describe("unruled lines", () => {
  it("reports lines without a rule and leaves them unpaid", () => {
    const r = aStd();
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [
        line({ doctor_id: "doc-d", try_cents: TL(1_000) }),
        line({ doctor_id: "doc-d", method: "card", try_cents: TL(2_500) }),
        line({ doctor_id: "doc-d", try_cents: TL(9_999), voided_at: "2026-11-11T09:00:00Z" }),
        line({ doctor_id: "doc-d", day: "2026-12-01", try_cents: TL(9_999) }),
      ],
    });
    expect(out.warnings).toEqual([
      { code: "UNRULED_LINES", doctor_id: "doc-d", doctor_name: "Hekim D", count: 2, try_cents: TL(3_500) },
    ]);
    expect(out.payees.map((p) => p.payee_user_id)).toEqual(["u-a"]);
    expect(out.line_results.every((x) => x.rule_id === null)).toBe(true);
    expect(out.clinic_total_cents).toBe(TL(3_500));
    expect(warningText(out.warnings[0])).toContain("Hekim D: 2 tahsilat");
  });

  it("does not use an implant-only rule for revenue lines", () => {
    const r = rule({ kind: "implant_piece", payee_user_id: "u-a", doctor_id: "doc-a", piece_cents: TL(1_500) });
    const out = run({ month: "2026-11", rules: [r], lines: [line({ doctor_id: "doc-a", try_cents: TL(1_000) })] });
    expect(out.warnings[0]).toMatchObject({ code: "UNRULED_LINES", doctor_id: "doc-a", count: 1 });
  });
});

describe("ortho_lab_first", () => {
  // Hekim S: lab cost first, then 55 % of each payment, no deductions.
  const sOrtho = () =>
    rule({ kind: "ortho_lab_first", payee_user_id: "u-s", doctor_id: "doc-s", share_bp: 5500 });

  it("recovers lab costs of two labs first, then shares each instalment (owner example shape)", () => {
    const r = sOrtho();
    const labCosts = [
      lab({ patient_ref: "orto 1", patient_name: "Orto Hasta 1", day: "2026-11-03", amount_cents: TL(25_000), lab_name: "Lab X" }),
      lab({ patient_ref: "orto 1", patient_name: "Orto Hasta 1", day: "2026-11-04", amount_cents: TL(15_000), lab_name: "Lab Y" }),
    ];
    const first = line({ doctor_id: "doc-s", patient_ref: "orto 1", patient_name: "Orto Hasta 1", day: "2026-11-06", method: "card", try_cents: TL(40_000) });
    const second = line({ doctor_id: "doc-s", patient_ref: "orto 1", patient_name: "Orto Hasta 1", day: "2026-12-06", try_cents: TL(15_000) });
    const third = line({ doctor_id: "doc-s", patient_ref: "orto 1", patient_name: "Orto Hasta 1", day: "2027-01-06", method: "transfer", try_cents: TL(15_000) });
    const lines = [first, second, third];

    const nov = run({ month: "2026-11", rules: [r], lines, lab_costs: labCosts });
    const cNov = component(nov, r.id);
    expect(labPartOf(nov, first.id)).toBe(TL(40_000));
    expect(cNov.by_method!.card).toMatchObject({ gross: TL(40_000), lab: TL(40_000), eligible: 0, deduction: 0 });
    expect(cNov.amount_cents).toBe(0);
    expect(cNov.lab_patients).toEqual([
      {
        patient_ref: "orto 1",
        patient_name: "Orto Hasta 1",
        lab_total_cents: TL(40_000),
        recovered_cents: TL(40_000),
        remaining_cents: 0,
        recovered_in_month_cents: TL(40_000),
      },
    ]);

    const dec = run({ month: "2026-12", rules: [r], lines, lab_costs: labCosts });
    expect(labPartOf(dec, second.id)).toBe(0);
    expect(component(dec, r.id).amount_cents).toBe(TL(8_250));
    expect(component(dec, r.id).lab_patients![0]).toMatchObject({ remaining_cents: 0, recovered_in_month_cents: 0 });

    const jan = run({ month: "2027-01", rules: [r], lines, lab_costs: labCosts });
    expect(component(jan, r.id).amount_cents).toBe(TL(8_250));
    expect(payeeTotal(jan, "u-s")).toBe(TL(8_250));
  });

  it("counts a lab cost dated later in the same month", () => {
    const r = sOrtho();
    const l = line({ doctor_id: "doc-s", patient_ref: "orto 2", day: "2026-11-05", try_cents: TL(15_000) });
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [l],
      lab_costs: [lab({ patient_ref: "orto 2", day: "2026-11-25", amount_cents: TL(6_000), lab_name: "Lab X" })],
    });
    expect(labPartOf(out, l.id)).toBe(TL(6_000));
    expect(component(out, r.id).base_cents).toBe(TL(9_000));
    expect(component(out, r.id).amount_cents).toBe(TL(4_950));
  });

  it("recovers a lab cost entered in a later month only from later payments", () => {
    const r = sOrtho();
    const nov = line({ doctor_id: "doc-s", patient_ref: "orto 3", day: "2026-11-05", try_cents: TL(15_000) });
    const dec = line({ doctor_id: "doc-s", patient_ref: "orto 3", day: "2026-12-10", try_cents: TL(15_000) });
    const labCosts = [lab({ patient_ref: "orto 3", day: "2026-12-02", amount_cents: TL(6_000), lab_name: "Lab Y" })];

    const outNov = run({ month: "2026-11", rules: [r], lines: [nov, dec], lab_costs: labCosts });
    expect(labPartOf(outNov, nov.id)).toBe(0);
    expect(component(outNov, r.id).amount_cents).toBe(TL(8_250));
    expect(component(outNov, r.id).lab_patients).toEqual([]);

    const outDec = run({ month: "2026-12", rules: [r], lines: [nov, dec], lab_costs: labCosts });
    expect(labPartOf(outDec, dec.id)).toBe(TL(6_000));
    expect(component(outDec, r.id).amount_cents).toBe(TL(4_950));
    expect(component(outDec, r.id).lab_patients).toEqual([
      {
        patient_ref: "orto 3",
        patient_name: "orto 3",
        lab_total_cents: TL(6_000),
        recovered_cents: TL(6_000),
        remaining_cents: 0,
        recovered_in_month_cents: TL(6_000),
      },
    ]);
  });

  it("carries an unrecovered lab balance into the next payments", () => {
    const r = sOrtho();
    const a = line({ doctor_id: "doc-s", patient_ref: "orto 4", day: "2026-11-05", try_cents: TL(6_000) });
    const b = line({ doctor_id: "doc-s", patient_ref: "orto 4", day: "2026-12-05", try_cents: TL(6_000) });
    const labCosts = [lab({ patient_ref: "orto 4", day: "2026-11-01", amount_cents: TL(10_000), lab_name: "Lab X" })];
    const outNov = run({ month: "2026-11", rules: [r], lines: [a, b], lab_costs: labCosts });
    expect(component(outNov, r.id).amount_cents).toBe(0);
    expect(component(outNov, r.id).lab_patients![0]).toMatchObject({ recovered_cents: TL(6_000), remaining_cents: TL(4_000) });
    const outDec = run({ month: "2026-12", rules: [r], lines: [a, b], lab_costs: labCosts });
    expect(labPartOf(outDec, b.id)).toBe(TL(4_000));
    expect(component(outDec, r.id).amount_cents).toBe(TL(1_100));
  });

  it("walks same-day payments by created_at, then id; voided lines and costs are ignored", () => {
    const r = sOrtho();
    const later = line({ id: "l-a", doctor_id: "doc-s", patient_ref: "orto 5", try_cents: TL(3_000), created_at: "2026-11-10T10:00:00Z" });
    const earlier = line({ id: "l-z", doctor_id: "doc-s", patient_ref: "orto 5", try_cents: TL(3_000), created_at: "2026-11-10T09:00:00Z" });
    const voided = line({ doctor_id: "doc-s", patient_ref: "orto 5", day: "2026-11-01", try_cents: TL(9_000), voided_at: "2026-11-02T08:00:00Z" });
    const labCosts = [
      lab({ patient_ref: "orto 5", day: "2026-11-01", amount_cents: TL(5_000), lab_name: "Lab X" }),
      lab({ patient_ref: "orto 5", day: "2026-11-01", amount_cents: TL(7_000), lab_name: "Lab Y", voided_at: "2026-11-02T08:00:00Z" }),
    ];
    const out = run({ month: "2026-11", rules: [r], lines: [later, earlier, voided], lab_costs: labCosts });
    expect(labPartOf(out, "l-z")).toBe(TL(3_000));
    expect(labPartOf(out, "l-a")).toBe(TL(2_000));
    expect(component(out, r.id).amount_cents).toBe(TL(550));
  });

  it("leaves out patients whose lab costs net to zero; names a patient after the latest lab cost (SQL)", () => {
    const r = sOrtho();
    const zeroLine = line({ doctor_id: "doc-s", patient_ref: "orto 6", patient_name: "Orto Hasta 6", try_cents: TL(2_000) });
    const namedLine = line({ doctor_id: "doc-s", patient_ref: "orto 7", patient_name: "Satırdaki Ad", try_cents: TL(1_000) });
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [zeroLine, namedLine],
      lab_costs: [
        lab({ patient_ref: "orto 6", day: "2026-11-02", amount_cents: TL(3_000), lab_name: "Lab X" }),
        lab({ patient_ref: "orto 6", day: "2026-11-03", amount_cents: TL(-3_000), lab_name: "Lab X" }),
        lab({
          patient_ref: "orto 7",
          patient_name: "Lab Adı Eski",
          day: "2026-11-02",
          amount_cents: TL(500),
          lab_name: "Lab X",
          created_at: "2026-11-02T10:00:00Z",
        }),
        lab({
          patient_ref: "orto 7",
          patient_name: "Lab Adı Yeni",
          day: "2026-11-02",
          amount_cents: TL(500),
          lab_name: "Lab Y",
          created_at: "2026-11-02T11:00:00Z",
        }),
      ],
    });
    expect(labPartOf(out, zeroLine.id)).toBe(0);
    expect(component(out, r.id).lab_patients).toEqual([
      {
        patient_ref: "orto 7",
        patient_name: "Lab Adı Yeni",
        lab_total_cents: TL(1_000),
        recovered_cents: TL(1_000),
        remaining_cents: 0,
        recovered_in_month_cents: TL(1_000),
      },
    ]);
  });

  it("takes precedence over ciro_share rules of the same doctor", () => {
    const r = sOrtho();
    const std = rule({ kind: "ciro_share", payee_user_id: "u-s", doctor_id: "doc-s", segment: "standard", share_bp: 2500 });
    const l = line({ doctor_id: "doc-s", try_cents: TL(1_000) });
    const out = run({ month: "2026-11", rules: [std, r], lines: [l] });
    expect(out.line_results[0].rule_id).toBe(r.id);
    expect(component(out, std.id).lines_count).toBe(0);
  });
});

describe("implant_piece", () => {
  it("pays qty × piece rate incl. negative corrections; reports pieces without a rule", () => {
    const r = rule({ kind: "implant_piece", payee_user_id: "u-a", doctor_id: "doc-a", piece_cents: TL(1_500) });
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [],
      pieces: [
        piece({ doctor_id: "doc-a", qty: 3 }),
        piece({ doctor_id: "doc-a", qty: -1 }),
        piece({ doctor_id: "doc-a", qty: 5, voided_at: "2026-11-20T08:00:00Z" }),
        piece({ doctor_id: "doc-a", qty: 2, day: "2026-12-01" }),
        piece({ doctor_id: "doc-e", qty: 1 }),
      ],
    });
    expect(component(out, r.id)).toMatchObject({ qty: 2, amount_cents: TL(3_000), lines_count: 2, base_cents: 0, by_method: null });
    expect(payeeTotal(out, "u-a")).toBe(TL(3_000));
    expect(out.warnings).toEqual([{ code: "UNRULED_PIECES", doctor_id: "doc-e", doctor_name: "Hekim E", qty: 1 }]);
  });

  it("does not warn about pieces without a rule that net to zero (SQL qty <> 0)", () => {
    const out = run({
      month: "2026-11",
      rules: [],
      lines: [],
      pieces: [piece({ doctor_id: "doc-e", qty: 1 }), piece({ doctor_id: "doc-e", qty: -1 })],
    });
    expect(out.warnings).toEqual([]);
  });
});

describe("clinic_ciro_share", () => {
  it("is computed on the gross month ciro incl. implant parts, ortho, unruled and correction lines", () => {
    const aRule = aStd();
    const mgmt = rule({ kind: "clinic_ciro_share", payee_user_id: "u-a", share_bp: 500 });
    const ortho = rule({ kind: "ortho_lab_first", payee_user_id: "u-s", doctor_id: "doc-s", share_bp: 5500 });
    const out = run({
      month: "2026-11",
      rules: [aRule, mgmt, ortho],
      lines: [
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(30_000), implant_cents: TL(10_000) }),
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(-1_000) }),
        line({ doctor_id: "doc-s", patient_ref: "orto 1", try_cents: TL(40_000) }),
        line({ doctor_id: "doc-d", try_cents: TL(3_500) }),
        line({ doctor_id: "doc-a", try_cents: TL(9_999), voided_at: "2026-11-15T08:00:00Z" }),
        line({ doctor_id: "doc-a", day: "2026-10-31", try_cents: TL(9_999) }),
      ],
      lab_costs: [lab({ patient_ref: "orto 1", day: "2026-11-01", amount_cents: TL(40_000), lab_name: "Lab X" })],
    });
    expect(out.clinic_total_cents).toBe(TL(72_500));
    expect(component(out, mgmt.id)).toMatchObject({
      base_cents: TL(72_500),
      amount_cents: TL(3_625),
      lines_count: 4,
      doctor_id: null,
      by_method: null,
    });
    // Ciro share of Hekim A: card (30.000 − 10.000 − 1.000) − 11 % = 16.910 → 25 % = 4.227,50
    expect(component(out, aRule.id).amount_cents).toBe(TL(4_227.5));
    expect(payeeTotal(out, "u-a")).toBe(TL(7_852.5));

    const s = summarizePayee(out.payees.find((p) => p.payee_user_id === "u-a")!);
    expect(s).toMatchObject({
      gross_cents: TL(29_000),
      implant_cents: TL(10_000),
      lab_cents: 0,
      deduction_cents: TL(2_090),
      base_cents: TL(16_910),
      share_cents: TL(4_227.5),
      share_bps: [2500],
      implant_qty: 0,
      management_base_cents: TL(72_500),
      management_cents: TL(3_625),
      total_cents: TL(7_852.5),
    });
    expect(s.gross_by_method).toEqual({ cash: 0, card: TL(29_000), transfer: 0, financing: 0, unpaid: 0 });
  });
});

describe("rule month ranges", () => {
  it("applies rules from from_month to to_month inclusive", () => {
    const r1 = rule({ kind: "ciro_share", payee_user_id: "u-a", doctor_id: "doc-a", segment: "standard", share_bp: 2500, from_month: "2026-11-01", to_month: "2026-12-01" });
    const r2 = rule({ kind: "ciro_share", payee_user_id: "u-a", doctor_id: "doc-a", segment: "standard", share_bp: 2800, from_month: "2027-01-01" });
    const lines = ["2026-10-15", "2026-11-15", "2026-12-31", "2027-01-01"].map((day) =>
      line({ doctor_id: "doc-a", day, try_cents: TL(10_000) })
    );
    const at = (month: string) => run({ month, rules: [r1, r2], lines });

    const oct = at("2026-10");
    expect(oct.payees).toEqual([]);
    expect(oct.warnings[0]).toMatchObject({ code: "UNRULED_LINES", count: 1 });
    expect(payeeTotal(at("2026-11"), "u-a")).toBe(TL(2_500));
    expect(payeeTotal(at("2026-12-01"), "u-a")).toBe(TL(2_500));
    expect(component(at("2027-01"), r2.id).amount_cents).toBe(TL(2_800));
    expect(at("2027-01").payees[0].components.map((c) => c.rule_id)).toEqual([r2.id]);

    expect(ruleActiveIn(r1, "2026-12")).toBe(true);
    expect(ruleActiveIn(r1, "2027-01-01")).toBe(false);
    expect(ruleActiveIn(r2, "2030-06")).toBe(true);
    expect(ruleActiveIn(r2, "2026-12")).toBe(false);
  });

  it("lists payees with a zero month and warns about missing counterparties only for non-zero totals", () => {
    const a = aStd();
    const b = rule({ kind: "implant_piece", payee_user_id: "u-b", doctor_id: "doc-b", piece_cents: TL(1_500) });
    const c = rule({ kind: "ciro_share", payee_user_id: "u-c", doctor_id: "doc-c", segment: "standard", share_bp: 2500 });
    const out = run({
      month: "2026-11",
      rules: [c, b, a],
      lines: [line({ doctor_id: "doc-a", try_cents: TL(1_000) }), line({ doctor_id: "doc-c", try_cents: TL(1_000) })],
      counterparty_user_ids: ["u-a"],
    });
    expect(out.payees.map((p) => [p.payee_name, p.total_cents])).toEqual([
      ["Hekim A", TL(250)],
      ["Hekim B", 0],
      ["Hekim C", TL(250)],
    ]);
    expect(out.warnings).toEqual([
      { code: "NO_COUNTERPARTY", payee_user_id: "u-c", payee_name: "Hekim C", reason: "missing" },
    ]);
  });
});

describe("payroll (v1.2)", () => {
  const salary = (payee: string, cents: number, from_month = "2026-11-01", to_month: string | null = null) =>
    rule({ kind: "fixed_monthly", payee_user_id: payee, piece_cents: cents, from_month, to_month });

  function adj(
    p: Partial<HkComputeAdjustment> & Pick<HkComputeAdjustment, "payee_user_id" | "amount_cents">
  ): HkComputeAdjustment {
    return { id: nextId("a"), month: "2026-11-01", kind: "bonus", description: "Örnek prim", ...p };
  }

  it("pays a fixed monthly salary to staff without a doctors row, within the rule's months", () => {
    const a = aStd();
    const p1 = salary("u-p1", TL(31_000), "2026-11-01", "2026-12-01");
    const p2 = salary("u-p2", TL(28_500), "2026-12-01");
    const lines = [line({ doctor_id: "doc-a", try_cents: TL(1_000) })];
    const at = (month: string) => run({ month, rules: [p2, a, p1], lines });

    const nov = at("2026-11");
    expect(nov.payees.map((p) => [p.payee_name, p.total_cents])).toEqual([
      ["Hekim A", TL(250)],
      ["Personel Bir", TL(31_000)],
    ]);
    expect(component(nov, p1.id)).toEqual({
      rule_id: p1.id,
      kind: "fixed_monthly",
      doctor_id: null,
      doctor_name: null,
      segment: null,
      share_bp: null,
      piece_cents: TL(31_000),
      by_method: null,
      base_cents: null,
      amount_cents: TL(31_000),
      qty: null,
      lines_count: 0,
    });
    // Payroll never touches the clinic ciro or the doctors' figures.
    expect(nov.clinic_total_cents).toBe(TL(1_000));
    expect(nov.warnings).toEqual([]);
    expect(componentTitle(component(nov, p1.id))).toBe("Sabit aylık maaş");

    expect(at("2026-12").payees.map((p) => [p.payee_name, p.total_cents])).toEqual([
      ["Hekim A", 0],
      ["Personel Bir", TL(31_000)],
      ["Personel İki", TL(28_500)],
    ]);
    expect(at("2027-01").payees.map((p) => p.payee_user_id)).toEqual(["u-a", "u-p2"]);
    expect(at("2026-10").payees).toEqual([]);
  });

  it("adds the month's live bonus / other rows as one component after the rule components", () => {
    const a = aStd();
    const aSalary = salary("u-a", TL(5_000));
    const p1 = salary("u-p1", TL(31_000));
    const adjustments = [
      adj({ payee_user_id: "u-p1", amount_cents: TL(2_500), description: "Ay sonu primi", created_at: "2026-11-28T10:00:00Z" }),
      adj({
        payee_user_id: "u-p1",
        kind: "other",
        amount_cents: TL(-400),
        description: "Örnek kesinti",
        created_at: "2026-11-03T09:00:00Z",
      }),
      adj({ payee_user_id: "u-p1", amount_cents: TL(9_999), voided_at: "2026-11-29T08:00:00Z" }),
      adj({ payee_user_id: "u-p1", month: "2026-12-01", amount_cents: TL(1_000) }),
      adj({ payee_user_id: "u-a", amount_cents: TL(750) }),
      // A bonus without any rule: the payee is listed with that component only.
      adj({ payee_user_id: "u-p2", month: "2026-11", amount_cents: TL(1_200) }),
      adj({ payee_user_id: "u-x", payee_name: "Personel Üç", amount_cents: TL(300) }),
    ];
    const out = run({
      month: "2026-11",
      rules: [p1, aSalary, a],
      lines: [line({ doctor_id: "doc-a", try_cents: TL(1_000) })],
      adjustments,
    });

    expect(out.payees.map((p) => [p.payee_name, p.total_cents])).toEqual([
      ["Hekim A", TL(250 + 5_000 + 750)],
      ["Personel Bir", TL(31_000 + 2_500 - 400)],
      ["Personel İki", TL(1_200)],
      ["Personel Üç", TL(300)],
    ]);

    const staff = out.payees.find((p) => p.payee_user_id === "u-p1")!;
    expect(staff.components.map((c) => c.kind)).toEqual(["fixed_monthly", "adjustments"]);
    const adjustmentsComponent = staff.components[1];
    // Exactly the keys of the SQL component (fin__hk_compute 0031): kind, amount and the items, oldest first.
    expect(adjustmentsComponent).toEqual({
      kind: "adjustments",
      amount_cents: TL(2_100),
      items: [
        { id: adjustments[1].id, kind: "other", amount_cents: TL(-400), description: "Örnek kesinti" },
        { id: adjustments[0].id, kind: "bonus", amount_cents: TL(2_500), description: "Ay sonu primi" },
      ],
    });
    expect(componentKey(adjustmentsComponent)).toBe("adjustments");
    expect(componentKey(staff.components[0])).toBe(p1.id);
    expect(componentTitle(adjustmentsComponent)).toBe(ADJUSTMENTS_COMPONENT_LABEL);

    // A doctor's salary and bonus belong to the same payee as the ciro share (one monthly entitlement).
    const doctor = out.payees.find((p) => p.payee_user_id === "u-a")!;
    expect(doctor.components.map((c) => c.kind)).toEqual(["ciro_share", "fixed_monthly", "adjustments"]);

    expect(summarizePayee(staff)).toMatchObject({
      salary_cents: TL(31_000),
      bonus_cents: TL(2_500),
      other_cents: TL(-400),
      adjustments_cents: TL(2_100),
      share_cents: 0,
      base_cents: 0,
      gross_cents: 0,
      total_cents: TL(33_100),
    });
    expect(summarizePayee(doctor)).toMatchObject({
      share_cents: TL(250),
      salary_cents: TL(5_000),
      bonus_cents: TL(750),
      other_cents: 0,
      total_cents: TL(6_000),
    });

    // December: only that month's bonus, no salary rule change.
    const dec = run({ month: "2026-12", rules: [p1], lines: [], adjustments });
    expect(dec.payees.map((p) => [p.payee_user_id, p.total_cents])).toEqual([["u-p1", TL(32_000)]]);
  });

  it("keeps a component whose rows net to zero; counterparty warnings follow the total", () => {
    const out = run({
      month: "2026-11",
      rules: [salary("u-p1", TL(20_000))],
      lines: [],
      adjustments: [
        adj({ payee_user_id: "u-p2", amount_cents: TL(500) }),
        adj({ payee_user_id: "u-p2", kind: "other", amount_cents: TL(-500) }),
      ],
      counterparty_user_ids: [],
    });
    const zero = out.payees.find((p) => p.payee_user_id === "u-p2")!;
    expect(zero.total_cents).toBe(0);
    expect(zero.components).toHaveLength(1);
    expect(zero.components[0]).toMatchObject({ kind: "adjustments", amount_cents: 0 });
    expect(zero.components[0].items).toHaveLength(2);
    expect(out.warnings).toEqual([
      { code: "NO_COUNTERPARTY", payee_user_id: "u-p1", payee_name: "Personel Bir", reason: "missing" },
    ]);
    expect(warningText(out.warnings[0])).toBe("Personel Bir için cari kaydı yok; ay kapatılınca otomatik oluşturulur.");
  });

  it("leaves results identical for months without payroll rows", () => {
    const input: HkComputeInput = {
      month: "2026-11",
      doctors: DOCTORS,
      payees: PAYEES,
      rules: [
        aStd(),
        rule({ kind: "clinic_ciro_share", payee_user_id: "u-a", share_bp: 500 }),
        rule({ kind: "implant_piece", payee_user_id: "u-b", doctor_id: "doc-b", piece_cents: TL(1_500) }),
        salary("u-p1", TL(31_000), "2027-01-01"),
      ],
      lines: [
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(12_345.67) }),
        line({ doctor_id: "doc-d", try_cents: TL(800) }),
      ],
      pieces: [piece({ doctor_id: "doc-b", qty: 2 })],
      counterparty_user_ids: ["u-a"],
    };
    const before = computeMonth(input);
    const after = computeMonth({
      ...input,
      adjustments: [
        adj({ payee_user_id: "u-a", month: "2026-10-01", amount_cents: TL(100) }),
        adj({ payee_user_id: "u-p1", amount_cents: TL(100), voided_at: "2026-11-20T08:00:00Z" }),
      ],
    });
    expect(after).toEqual(before);
    expect(computeMonth({ ...input, adjustments: [] })).toEqual(before);
    expect(before.payees.map((p) => p.payee_user_id)).toEqual(["u-a", "u-b"]);
  });

  it("checks fixed_monthly rules and adjustment inputs", () => {
    expect(HK_KINDS.slice(-3)).toEqual(["fixed_monthly", "bank_portion", "minimum_monthly"]);
    expect(KIND_LABELS.fixed_monthly).toBe("Sabit aylık maaş");
    expect(ADJUSTMENT_KIND_LABELS).toEqual({ bonus: "Prim", other: "Diğer" });
    expect(RULE_FIELDS.fixed_monthly).toEqual({
      doctor: false,
      segment: false,
      share: false,
      piece: true,
      deductions: false,
      unpaid: false,
      group: false,
    });
    expect(pieceFieldLabel("fixed_monthly")).toBe("Aylık net maaş (TL)");
    expect(pieceFieldLabel("implant_piece")).toBe("İmplant başı tutar (TL)");

    const base: HkRuleInput = {
      payee_user_id: "u-p1",
      doctor_id: null,
      kind: "fixed_monthly",
      segment: null,
      share_bp: null,
      piece_cents: TL(31_000),
      deduct_cash_bp: 0,
      deduct_card_bp: 0,
      deduct_transfer_bp: 0,
      deduct_financing_bp: 0,
      from_month: "2026-11",
      to_month: null,
    };
    expect(validateRule(base)).toBeNull();
    expect(validateRule({ ...base, payee_user_id: null })).toBe("Maaş alacak kişiyi seçin.");
    expect(validateRule({ ...base, piece_cents: 0 })).toBe("Aylık net maaş 0'dan büyük olmalı.");
    expect(validateRule({ ...base, piece_cents: null })).toBe("Aylık net maaş 0'dan büyük olmalı.");
    expect(validateRule({ ...base, deduct_card_bp: 100 })).toBe("Bu kural türünde kesinti girilemez.");

    const ok = { month: "2026-11", payee_user_id: "u-p1", kind: "bonus" as const, amount_cents: TL(1_500), description: " Prim " };
    expect(validateAdjustment(ok)).toBeNull();
    expect(validateAdjustment({ ...ok, kind: "other", amount_cents: TL(-250) })).toBeNull();
    expect(validateAdjustment({ ...ok, month: "" })).toBe("Ayı seçin.");
    expect(validateAdjustment({ ...ok, payee_user_id: null })).toBe("Kişiyi seçin.");
    expect(validateAdjustment({ ...ok, kind: null })).toBe("Türü seçin.");
    for (const bad of [0, null, 1.5]) {
      expect(validateAdjustment({ ...ok, amount_cents: bad })).toBe("Tutar 0 olamaz. Kesinti için eksi tutar girin.");
    }
    expect(validateAdjustment({ ...ok, amount_cents: -1_000_000_000_000 })).toBeNull();
    expect(validateAdjustment({ ...ok, amount_cents: 1_000_000_000_001 })).toBe("Tutar en fazla 10.000.000.000 TL olabilir.");
    expect(validateAdjustment({ ...ok, description: "   " })).toBe("Açıklama girin.");
    expect(validateAdjustment({ ...ok, description: "x".repeat(HK_ADJUSTMENT_DESCRIPTION_MAX) })).toBeNull();
    expect(validateAdjustment({ ...ok, description: "x".repeat(HK_ADJUSTMENT_DESCRIPTION_MAX + 1) })).toBe(
      "Açıklama en fazla 500 karakter olabilir."
    );
  });

  it("checks overlaps per payee for salaries and per doctor / segment otherwise", () => {
    const p1 = { ...salary("u-p1", TL(31_000), "2026-11-01", "2026-12-01"), note: "" };
    const p2 = { ...salary("u-p2", TL(28_500)), note: "" };
    const aStdRule = { ...aStd(), from_month: "2026-11-01" };
    const rules = [p1, p2, aStdRule];

    // Two staff members' salaries never overlap each other.
    expect(ruleOverlapKey(p1)).not.toBe(ruleOverlapKey(p2));
    expect(findOverlappingRule(rules, { ...p2, id: "new", payee_user_id: "u-p3" })).toBeUndefined();
    // The same person: a second salary in a covered month is refused, after the end month it is fine.
    expect(findOverlappingRule(rules, { ...p1, id: "new", from_month: "2026-12-01", to_month: null })?.id).toBe(p1.id);
    expect(findOverlappingRule(rules, { ...p1, id: "new", from_month: "2027-01-01", to_month: null })).toBeUndefined();
    // Editing the rule itself is not an overlap.
    expect(findOverlappingRule(rules, p1)).toBeUndefined();
    // Other kinds: per doctor and segment, whoever the payee is.
    expect(findOverlappingRule(rules, { ...aStdRule, id: "new", payee_user_id: "u-b" })?.id).toBe(aStdRule.id);
    expect(findOverlappingRule(rules, { ...aStdRule, id: "new", segment: "child" })).toBeUndefined();
    // The earliest overlapping rule is named, like the server's DETAIL.
    const later = { ...salary("u-p2", TL(1_000), "2025-01-01", "2025-06-01"), note: "" };
    const earliest = { ...salary("u-p2", TL(1_000), "2024-01-01", "2024-12-01"), note: "" };
    expect(findOverlappingRule([later, earliest], { ...later, id: "new", from_month: "2024-06-01", to_month: null })?.id).toBe(
      earliest.id
    );

    expect(monthRangesOverlap({ from_month: "2026-11", to_month: "2026-12" }, { from_month: "2026-12-01", to_month: null })).toBe(true);
    expect(monthRangesOverlap({ from_month: "2026-11", to_month: "2026-11" }, { from_month: "2026-12", to_month: null })).toBe(false);
    expect(monthRangesOverlap({ from_month: "2027-01", to_month: null }, { from_month: "2026-01", to_month: "2026-12" })).toBe(false);

    expect(salaryRuleOf(rules, "u-p1", "2026-12")?.id).toBe(p1.id);
    expect(salaryRuleOf(rules, "u-p1", "2027-01")).toBeUndefined();
    expect(salaryRuleOf(rules, "u-a", "2026-11")).toBeUndefined();
  });

  it("sums payee summaries for a totals row", () => {
    const out = run({
      month: "2026-11",
      rules: [aStd(), salary("u-p1", TL(31_000)), rule({ kind: "clinic_ciro_share", payee_user_id: "u-c", share_bp: 500 })],
      lines: [line({ doctor_id: "doc-a", method: "card", try_cents: TL(10_000) })],
      adjustments: [adj({ payee_user_id: "u-p1", amount_cents: TL(1_000) }), adj({ payee_user_id: "u-p1", kind: "other", amount_cents: TL(-200) })],
    });
    const total = sumPayeeSummaries(out.payees.map(summarizePayee));
    expect(total).toMatchObject({
      gross_cents: TL(10_000),
      deduction_cents: TL(1_100),
      share_cents: TL(2_225),
      share_bps: [2500],
      management_cents: TL(500),
      management_base_cents: 0,
      salary_cents: TL(31_000),
      bonus_cents: TL(1_000),
      other_cents: TL(-200),
      adjustments_cents: TL(800),
      total_cents: TL(2_225 + 500 + 31_000 + 800),
    });
    expect(total.gross_by_method.card).toBe(TL(10_000));
    expect(sumPayeeSummaries([])).toEqual(emptyPayeeSummary());
    expect(emptyPayeeSummary(TL(5)).total_cents).toBe(TL(5));
  });
});

describe("bank / cash split (v1.3)", () => {
  const bank = (payee: string, cents: number, from_month = "2026-11-01", to_month: string | null = null) =>
    rule({ kind: "bank_portion", payee_user_id: payee, piece_cents: cents, from_month, to_month });
  const salary = (payee: string, cents: number) => rule({ kind: "fixed_monthly", payee_user_id: payee, piece_cents: cents });
  const bonus = (payee: string, cents: number): HkComputeAdjustment => ({
    id: nextId("a"),
    month: "2026-11-01",
    payee_user_id: payee,
    kind: "bonus",
    amount_cents: cents,
    description: "Örnek prim",
  });
  const payee = (out: HkComputeOutput, userId: string) => out.payees.find((p) => p.payee_user_id === userId)!;

  it("splits a doctor's hakediş into the bank part and the rest in cash without changing the total", () => {
    const a = aStd();
    const lines = [
      line({ doctor_id: "doc-a", try_cents: TL(60_000) }),
      line({ doctor_id: "doc-a", method: "card", try_cents: TL(20_000) }),
    ];
    const without = run({ month: "2026-11", rules: [a], lines });
    const out = run({ month: "2026-11", rules: [a, bank("u-a", TL(12_500))], lines });

    // 25 % of (60.000 + 20.000 × 0,89) = 19.450 TL; bank 12.500, cash 6.950.
    const doctor = payee(out, "u-a");
    expect(doctor.total_cents).toBe(TL(19_450));
    expect(doctor.bank_cents).toBe(TL(12_500));
    expect(doctor.cash_cents).toBe(TL(6_950));
    // The bank part is no component: components, totals, clinic ciro and line results are those of the plain month.
    expect(doctor.components).toEqual(payee(without, "u-a").components);
    expect(out.clinic_total_cents).toBe(without.clinic_total_cents);
    expect(out.line_results).toEqual(without.line_results);
    expect(out.warnings).toEqual([]);
    expect(payee(without, "u-a")).toMatchObject({ bank_cents: null, cash_cents: null });

    expect(bankSplitOf(doctor)).toEqual({ bank_cents: TL(12_500), cash_cents: TL(6_950), over_cents: 0 });
    expect(bankSplitText(doctor)).toBe("Bankadan ₺12.500,00 · Elden ₺6.950,00");
    expect(summarizePayee(doctor)).toMatchObject({
      share_cents: TL(19_450),
      total_cents: TL(19_450),
      bank_cents: TL(12_500),
      cash_cents: TL(6_950),
    });
  });

  it("pays a staff salary by bank and the month's bonus in cash", () => {
    const out = run({
      month: "2026-11",
      rules: [salary("u-p1", TL(26_000)), bank("u-p1", TL(26_000))],
      lines: [],
      adjustments: [bonus("u-p1", TL(3_750))],
    });
    const staff = payee(out, "u-p1");
    expect(staff.total_cents).toBe(TL(29_750));
    expect(staff.components.map((c) => c.kind)).toEqual(["fixed_monthly", "adjustments"]);
    expect(staff).toMatchObject({ bank_cents: TL(26_000), cash_cents: TL(3_750) });
    expect(summarizePayee(staff)).toMatchObject({
      salary_cents: TL(26_000),
      bonus_cents: TL(3_750),
      bank_cents: TL(26_000),
      cash_cents: TL(3_750),
    });
    // Bank part equal to the total: no warning, nothing in cash.
    const exact = run({ month: "2026-11", rules: [salary("u-p1", TL(26_000)), bank("u-p1", TL(26_000))], lines: [] });
    expect(payee(exact, "u-p1")).toMatchObject({ total_cents: TL(26_000), bank_cents: TL(26_000), cash_cents: 0 });
    expect(exact.warnings).toEqual([]);
  });

  it("lists a payee with only a bank part (total 0) and warns when the bank part exceeds the total", () => {
    const a = aStd();
    const out = run({
      month: "2026-11",
      rules: [a, bank("u-a", TL(5_000)), bank("u-p2", TL(9_000))],
      lines: [line({ doctor_id: "doc-a", try_cents: TL(8_000) }), line({ doctor_id: "doc-d", try_cents: TL(300) })],
      counterparty_user_ids: [],
    });
    expect(out.payees.map((p) => [p.payee_name, p.total_cents, p.bank_cents, p.cash_cents, p.components.length])).toEqual([
      ["Hekim A", TL(2_000), TL(5_000), TL(-3_000), 1],
      ["Personel İki", 0, TL(9_000), TL(-9_000), 0],
    ]);
    // After the other warnings, by payee name; a zero total gets no counterparty warning.
    expect(out.warnings).toEqual([
      { code: "UNRULED_LINES", doctor_id: "doc-d", doctor_name: "Hekim D", count: 1, try_cents: TL(300) },
      { code: "NO_COUNTERPARTY", payee_user_id: "u-a", payee_name: "Hekim A", reason: "missing" },
      { code: "BANK_OVER_TOTAL", payee_user_id: "u-a", payee_name: "Hekim A", bank_cents: TL(5_000), total_cents: TL(2_000) },
      { code: "BANK_OVER_TOTAL", payee_user_id: "u-p2", payee_name: "Personel İki", bank_cents: TL(9_000), total_cents: 0 },
    ]);
    expect(warningText(out.warnings[2])).toBe("Hekim A: Bankadan ödenen tutar bu ayın toplamını ₺3.000,00 aşıyor.");
    expect(warningText(out.warnings[3])).toBe("Personel İki: Bankadan ödenen tutar bu ayın toplamını ₺9.000,00 aşıyor.");
    expect(bankSplitOf(payee(out, "u-p2"))).toEqual({ bank_cents: TL(9_000), cash_cents: TL(-9_000), over_cents: TL(9_000) });

    // A payee unknown to `payees` is named after the rule.
    const named = run({
      month: "2026-11",
      rules: [{ ...bank("u-x", TL(1_000)), payee_name: "Personel Üç" }],
      lines: [],
    });
    expect(named.payees).toEqual([
      { payee_user_id: "u-x", payee_name: "Personel Üç", total_cents: 0, components: [], bank_cents: TL(1_000), cash_cents: TL(-1_000) },
    ]);
  });

  it("applies the bank part within its months; other payees and months are unchanged", () => {
    const a = aStd();
    const b = rule({ kind: "implant_piece", payee_user_id: "u-b", doctor_id: "doc-b", piece_cents: TL(1_500) });
    const aBank = bank("u-a", TL(1_000), "2026-12-01", "2027-01-01");
    const lines = ["2026-11-10", "2026-12-10", "2027-01-10", "2027-02-10"].map((day) =>
      line({ doctor_id: "doc-a", day, try_cents: TL(10_000) })
    );
    const pieces = [piece({ doctor_id: "doc-b", qty: 2, day: "2026-12-05" })];
    const at = (month: string, rules: HkComputeRule[]) => run({ month, rules, lines, pieces, counterparty_user_ids: ["u-a"] });

    for (const month of ["2026-11", "2027-02"]) {
      expect(at(month, [a, b, aBank])).toEqual(at(month, [a, b]));
      expect(at(month, [a, b, aBank]).payees.every((p) => p.bank_cents === null && p.cash_cents === null)).toBe(true);
    }
    const dec = at("2026-12", [a, b, aBank]);
    const plainDec = at("2026-12", [a, b]);
    expect(payee(dec, "u-a")).toMatchObject({ total_cents: TL(2_500), bank_cents: TL(1_000), cash_cents: TL(1_500) });
    expect(payee(dec, "u-b")).toEqual(payee(plainDec, "u-b"));
    expect(payee(dec, "u-b")).toMatchObject({ total_cents: TL(3_000), bank_cents: null, cash_cents: null });
    expect(dec.warnings).toEqual(plainDec.warnings);
    expect(payee(at("2027-01", [a, b, aBank]), "u-a").bank_cents).toBe(TL(1_000));

    // A bank part of another payee never moves to this one.
    expect(payee(at("2026-12", [a, b, bank("u-b", TL(500))]), "u-a").bank_cents).toBeNull();
  });

  it("sums overlapping bank parts like the SQL (only reachable through invalid data)", () => {
    const out = run({
      month: "2026-11",
      rules: [salary("u-p1", TL(10_000)), bank("u-p1", TL(6_000), "2026-10-01"), bank("u-p1", TL(3_000))],
      lines: [],
    });
    expect(payee(out, "u-p1")).toMatchObject({ total_cents: TL(10_000), bank_cents: TL(9_000), cash_cents: TL(1_000) });
    expect(out.warnings).toEqual([]);
    expect(bankOverText(TL(250))).toBe("Bankadan ödenen tutar bu ayın toplamını ₺250,00 aşıyor.");
  });

  it("checks bank_portion rules: fields, labels, overlaps per payee", () => {
    expect(KIND_LABELS.bank_portion).toBe("Bankadan ödenen sabit tutar");
    expect(RULE_FIELDS.bank_portion).toEqual({
      doctor: false,
      segment: false,
      share: false,
      piece: true,
      deductions: false,
      unpaid: false,
      group: false,
    });
    expect(pieceFieldLabel("bank_portion")).toBe("Aylık bankadan ödenen tutar (TL)");
    expect(BANK_PORTION_HINT).toBe(
      "Hakedişin/maaşın bankadan ödenen kısmı; toplamı değiştirmez, ödemeyi bankadan ve elden diye böler."
    );
    expect(SPLIT_LABELS).toEqual({ bank: "Bankadan", cash: "Elden" });
    expect(HK_KINDS.filter(kindAllowsAnyUser)).toEqual(["fixed_monthly", "bank_portion", "minimum_monthly"]);

    const base: HkRuleInput = {
      payee_user_id: "u-p1",
      doctor_id: null,
      kind: "bank_portion",
      segment: null,
      share_bp: null,
      piece_cents: TL(15_000),
      deduct_cash_bp: 0,
      deduct_card_bp: 0,
      deduct_transfer_bp: 0,
      deduct_financing_bp: 0,
      from_month: "2026-11",
      to_month: null,
    };
    expect(validateRule(base)).toBeNull();
    expect(validateRule({ ...base, payee_user_id: null })).toBe("Bankadan ödeme alacak kişiyi seçin.");
    for (const bad of [0, -100, null, 12.5]) {
      expect(validateRule({ ...base, piece_cents: bad })).toBe("Aylık bankadan ödenen tutar 0'dan büyük olmalı.");
    }
    expect(validateRule({ ...base, deduct_cash_bp: 100 })).toBe("Bu kural türünde kesinti girilemez.");
    expect(validateRule({ ...base, to_month: "2026-10" })).toBe("Bitiş ayı başlangıç ayından önce olamaz.");

    const b1 = { ...bank("u-p1", TL(15_000), "2026-11-01", "2026-12-01"), note: "" };
    const b2 = { ...bank("u-a", TL(15_000)), note: "" };
    const s1 = { ...salary("u-p1", TL(15_000)), note: "" };
    const rules = [b1, b2, s1];
    // Per payee: another person's bank part and the same person's salary never overlap it.
    expect(ruleOverlapKey(b1)).toBe("bank_portion|u-p1");
    expect(ruleOverlapKey(b1)).not.toBe(ruleOverlapKey(s1));
    expect(findOverlappingRule(rules, { ...b1, id: "new", payee_user_id: "u-p2" })).toBeUndefined();
    expect(findOverlappingRule(rules, { ...b1, id: "new", from_month: "2026-12-01", to_month: null })?.id).toBe(b1.id);
    expect(findOverlappingRule(rules, { ...b1, id: "new", from_month: "2027-01-01", to_month: null })).toBeUndefined();
    expect(findOverlappingRule(rules, b1)).toBeUndefined();

    expect(bankRuleOf(rules, "u-p1", "2026-12")?.id).toBe(b1.id);
    expect(bankRuleOf(rules, "u-p1", "2027-01")).toBeUndefined();
    expect(bankRuleOf(rules, "u-a", "2030-05")?.id).toBe(b2.id);
    expect(salaryRuleOf(rules, "u-p1", "2026-11")?.id).toBe(s1.id);
  });

  it("reads the split from payloads and sums it for a totals row", () => {
    // A payload without cash_cents (or a frozen statement from before 0032) still splits; no bank part → null.
    expect(bankSplitOf({ total_cents: TL(800), bank_cents: TL(500) })).toEqual({ bank_cents: TL(500), cash_cents: TL(300), over_cents: 0 });
    expect(bankSplitOf({ total_cents: TL(800) })).toBeNull();
    expect(bankSplitOf({ total_cents: TL(800), bank_cents: null, cash_cents: null })).toBeNull();
    expect(bankSplitText({ total_cents: TL(800) })).toBe("");
    expect(summarizePayee({ total_cents: TL(800), components: [] })).toMatchObject({ bank_cents: null, cash_cents: null });

    const out = run({
      month: "2026-11",
      rules: [aStd(), bank("u-a", TL(1_000)), salary("u-p1", TL(20_000)), bank("u-p1", TL(18_000)), salary("u-p2", TL(9_000))],
      lines: [line({ doctor_id: "doc-a", try_cents: TL(10_000) })],
    });
    const rows = out.payees.map(summarizePayee);
    expect(rows.map((r) => [r.total_cents, r.bank_cents, r.cash_cents])).toEqual([
      [TL(2_500), TL(1_000), TL(1_500)],
      [TL(20_000), TL(18_000), TL(2_000)],
      [TL(9_000), null, null],
    ]);
    expect(sumPayeeSummaries(rows)).toMatchObject({
      total_cents: TL(31_500),
      bank_cents: TL(19_000),
      cash_cents: TL(3_500),
    });
    expect(sumPayeeSummaries([rows[2]])).toMatchObject({ bank_cents: null, cash_cents: null });
    expect(emptyPayeeSummary()).toMatchObject({ bank_cents: null, cash_cents: null });
  });
});

describe("lab costs on the ciro (v1.4)", () => {
  const payee = (out: HkComputeOutput, userId: string) => out.payees.find((p) => p.payee_user_id === userId)!;
  // Hekim A: 40 % of ciro after card and havale 8 %, cash 0 %.
  const a40 = () =>
    rule({
      kind: "ciro_share",
      payee_user_id: "u-a",
      doctor_id: "doc-a",
      segment: "standard",
      share_bp: 4000,
      deduct_card_bp: 800,
      deduct_transfer_bp: 800,
    });
  const bStd27 = () =>
    rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "standard", share_bp: 2700 });

  it("deducts the month's lab costs after the method deductions, before the share (owner example shape)", () => {
    const r = a40();
    const lines = [
      line({ doctor_id: "doc-a", method: "card", try_cents: TL(47_500) }),
      line({ doctor_id: "doc-a", method: "transfer", try_cents: TL(22_500) }),
      line({ doctor_id: "doc-a", method: "cash", try_cents: TL(48_000) }),
    ];
    const labs = [
      lab({ doctor_id: "doc-a", patient_ref: "hasta 1", day: "2026-11-05", amount_cents: TL(13_000), lab_name: "Lab Y" }),
      lab({ doctor_id: "doc-a", patient_ref: "hasta 2", day: "2026-11-20", amount_cents: TL(9_400), lab_name: "Lab X" }),
    ];
    const without = run({ month: "2026-11", rules: [r], lines });
    const out = run({ month: "2026-11", rules: [r], lines, lab_costs: labs });

    // Ciro 118.000: card + havale 70.000 − 8 % = 64.400, cash 48.000 → 112.400 − lab 22.400 = 90.000 → 40 % = 36.000.
    expect(component(without, r.id)).toMatchObject({ base_cents: TL(112_400), amount_cents: TL(44_960) });
    // Without lab costs the component has exactly the 0031 keys.
    expect("lab_cents" in component(without, r.id)).toBe(false);
    const c = component(out, r.id);
    expect(c).toEqual({
      ...component(without, r.id),
      base_cents: TL(90_000),
      amount_cents: TL(36_000),
      lab_cents: TL(22_400),
      lab_excess_cents: 0,
    });
    // The method buckets are untouched: the lab comes off after the deductions.
    expect(c.by_method!.card).toEqual({
      gross: TL(47_500),
      implant: 0,
      lab: 0,
      eligible: TL(47_500),
      deduct_bp: 800,
      deduction: TL(3_800),
    });
    expect(payeeTotal(out, "u-a")).toBe(TL(36_000));
    expect(out.warnings).toEqual([]);
    expect(out.line_results).toEqual(without.line_results);
    expect(out.lab_results).toEqual([
      { id: labs[0].id, segment: "standard", rule_id: r.id },
      { id: labs[1].id, segment: "standard", rule_id: r.id },
    ]);
    expect(out.lab_summary).toEqual([
      { doctor_id: "doc-a", doctor_name: "Hekim A", lab_name: "Lab X", cost_cents: TL(9_400), deducted_cents: TL(9_400), count: 1 },
      { doctor_id: "doc-a", doctor_name: "Hekim A", lab_name: "Lab Y", cost_cents: TL(13_000), deducted_cents: TL(13_000), count: 1 },
    ]);
    expect(out.lab_totals).toEqual([
      { lab_name: "Lab X", cost_cents: TL(9_400), deducted_cents: TL(9_400), count: 1 },
      { lab_name: "Lab Y", cost_cents: TL(13_000), deducted_cents: TL(13_000), count: 1 },
    ]);

    const s = summarizePayee(payee(out, "u-a"));
    expect(s).toMatchObject({
      gross_cents: TL(118_000),
      implant_cents: 0,
      lab_cents: TL(22_400),
      lab_excess_cents: 0,
      deduction_cents: TL(5_600),
      base_cents: TL(90_000),
      share_cents: TL(36_000),
      share_bps: [4000],
      total_cents: TL(36_000),
    });
    expect(s.gross_cents - s.implant_cents - s.lab_cents - s.deduction_cents).toBe(s.base_cents);
  });

  it("never takes the base below 0: the excess stays with the clinic (LAB_OVER_CIRO), with no carry-forward", () => {
    const r = bStd27();
    const lines = [
      line({ doctor_id: "doc-b", try_cents: TL(10_000) }),
      line({ doctor_id: "doc-b", day: "2026-12-04", try_cents: TL(10_000) }),
    ];
    const labs = [
      lab({ doctor_id: "doc-b", patient_ref: "hasta 1", day: "2026-11-03", amount_cents: TL(9_000.01), lab_name: "Lab X" }),
      lab({ doctor_id: "doc-b", patient_ref: "hasta 2", day: "2026-11-09", amount_cents: TL(5_999.99), lab_name: "Lab Y" }),
    ];
    const nov = run({ month: "2026-11", rules: [r], lines, lab_costs: labs });
    expect(component(nov, r.id)).toMatchObject({
      base_cents: 0,
      amount_cents: 0,
      lab_cents: TL(10_000),
      lab_excess_cents: TL(5_000),
    });
    expect(nov.warnings).toEqual([
      {
        code: "LAB_OVER_CIRO",
        doctor_id: "doc-b",
        doctor_name: "Hekim B",
        rule_id: r.id,
        segment: "standard",
        lab_cents: TL(15_000),
        ciro_after_deductions_cents: TL(10_000),
        excess_cents: TL(5_000),
      },
    ]);
    expect(warningText(nov.warnings[0])).toBe(
      "Hekim B · Standart: ayın lab maliyeti (₺15.000,00) kesintiler sonrası cirodan (₺10.000,00) fazla; aşan ₺5.000,00 hakedişten düşülmedi, klinikte kalır."
    );
    // The deducted 10.000 is split over the labs by their costs (rounded cumulatively in lab name order).
    expect(nov.lab_summary.map((x) => [x.lab_name, x.cost_cents, x.deducted_cents])).toEqual([
      ["Lab X", TL(9_000.01), TL(6_000.01)],
      ["Lab Y", TL(5_999.99), TL(3_999.99)],
    ]);
    expect(summarizePayee(payee(nov, "u-b"))).toMatchObject({ lab_cents: TL(10_000), lab_excess_cents: TL(5_000), base_cents: 0 });

    // December starts clean: November's excess is not carried forward.
    const dec = run({ month: "2026-12", rules: [r], lines, lab_costs: labs });
    expect(component(dec, r.id)).toEqual(component(run({ month: "2026-12", rules: [r], lines }), r.id));
    expect(component(dec, r.id)).toMatchObject({ base_cents: TL(10_000), amount_cents: TL(2_700) });
    expect(dec.warnings).toEqual([]);
    expect(dec.lab_summary).toEqual([]);
  });

  it("leaves a negative ciro as it is and deducts a lab correction whole", () => {
    const r = bStd27();
    // A month with only a correction line: nothing to deduct the lab cost from.
    const jan = run({
      month: "2027-01",
      rules: [r],
      lines: [line({ doctor_id: "doc-b", day: "2027-01-08", try_cents: TL(-1_800) })],
      lab_costs: [lab({ doctor_id: "doc-b", patient_ref: "hasta 1", day: "2027-01-09", amount_cents: TL(1_000), lab_name: "Lab X" })],
    });
    expect(component(jan, r.id)).toMatchObject({
      base_cents: TL(-1_800),
      amount_cents: TL(-486),
      lab_cents: 0,
      lab_excess_cents: TL(1_000),
    });
    expect(jan.warnings).toEqual([
      expect.objectContaining({ code: "LAB_OVER_CIRO", lab_cents: TL(1_000), ciro_after_deductions_cents: TL(-1_800), excess_cents: TL(1_000) }),
    ]);
    expect(jan.lab_summary[0]).toMatchObject({ cost_cents: TL(1_000), deducted_cents: 0, count: 1 });

    // A lab refund (negative cost) raises the base.
    const feb = run({
      month: "2027-02",
      rules: [r],
      lines: [line({ doctor_id: "doc-b", day: "2027-02-08", try_cents: TL(10_000) })],
      lab_costs: [lab({ doctor_id: "doc-b", patient_ref: "hasta 1", day: "2027-02-10", amount_cents: TL(-500), lab_name: "Lab X" })],
    });
    expect(component(feb, r.id)).toMatchObject({ base_cents: TL(10_500), amount_cents: TL(2_835), lab_cents: TL(-500), lab_excess_cents: 0 });
    expect(feb.warnings).toEqual([]);
    expect(feb.lab_summary[0]).toMatchObject({ cost_cents: TL(-500), deducted_cents: TL(-500) });
  });

  it("resolves each lab cost to the rule of its patient's segment on the cost's day, with the standard fallback", () => {
    const bStd = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "standard", share_bp: 2500 });
    const bChild = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "child", share_bp: 3200 });
    const cStd = rule({ kind: "ciro_share", payee_user_id: "u-c", doctor_id: "doc-c", segment: "standard", share_bp: 2500 });
    const cOwn = rule({ kind: "ciro_share", payee_user_id: "u-c", doctor_id: "doc-c", segment: "own", share_bp: 3200 });
    const marks: HkComputeMark[] = [
      // 14 on 2026-11-15 (default limit 14: a child until the day before).
      { patient_ref: "cocuk 1", own_doctor_id: null, is_child: false, birth_date: "2012-11-15" },
      { patient_ref: "kendi 1", own_doctor_id: "doc-c", is_child: false },
      { patient_ref: "cocuk 2", own_doctor_id: null, is_child: true },
    ];
    const t = TL(10_000);
    const lines = [
      line({ doctor_id: "doc-b", patient_ref: "hasta 1", try_cents: t }),
      line({ doctor_id: "doc-b", patient_ref: "cocuk 2", try_cents: t }),
      line({ doctor_id: "doc-c", patient_ref: "kendi 1", try_cents: t }),
      line({ doctor_id: "doc-c", patient_ref: "hasta 1", try_cents: t }),
    ];
    const labs = {
      bChildByAge: lab({ doctor_id: "doc-b", patient_ref: "cocuk 1", day: "2026-11-14", amount_cents: TL(1_000), lab_name: "Lab X" }),
      bBirthday: lab({ doctor_id: "doc-b", patient_ref: "cocuk 1", day: "2026-11-15", amount_cents: TL(2_000), lab_name: "Lab X" }),
      // Hekim C's own patient is a standard patient for Hekim B.
      bOtherOwn: lab({ doctor_id: "doc-b", patient_ref: "kendi 1", day: "2026-11-10", amount_cents: TL(450), lab_name: "Lab Y" }),
      cOwn: lab({ doctor_id: "doc-c", patient_ref: "kendi 1", day: "2026-11-10", amount_cents: TL(700), lab_name: "Lab Y" }),
      // No child rule for Hekim C → the standard rule.
      cChildNoRule: lab({ doctor_id: "doc-c", patient_ref: "cocuk 2", day: "2026-11-10", amount_cents: TL(300), lab_name: "Lab X" }),
    };
    const rules = [bStd, bChild, cStd, cOwn];
    const out = run({ month: "2026-11", rules, lines, marks, lab_costs: Object.values(labs) });
    const res = (c: HkComputeLabCost) => out.lab_results.find((x) => x.id === c.id);

    expect(res(labs.bChildByAge)).toEqual({ id: labs.bChildByAge.id, segment: "child", rule_id: bChild.id });
    expect(res(labs.bBirthday)).toEqual({ id: labs.bBirthday.id, segment: "standard", rule_id: bStd.id });
    expect(res(labs.bOtherOwn)).toEqual({ id: labs.bOtherOwn.id, segment: "standard", rule_id: bStd.id });
    expect(res(labs.cOwn)).toEqual({ id: labs.cOwn.id, segment: "own", rule_id: cOwn.id });
    expect(res(labs.cChildNoRule)).toEqual({ id: labs.cChildNoRule.id, segment: "child", rule_id: cStd.id });

    expect(component(out, bChild.id)).toMatchObject({ lab_cents: TL(1_000), base_cents: TL(9_000), amount_cents: TL(2_880) });
    expect(component(out, bStd.id)).toMatchObject({ lab_cents: TL(2_450), base_cents: TL(7_550), amount_cents: TL(1_887.5) });
    expect(component(out, cOwn.id)).toMatchObject({ lab_cents: TL(700), base_cents: TL(9_300), amount_cents: TL(2_976) });
    expect(component(out, cStd.id)).toMatchObject({ lab_cents: TL(300), base_cents: TL(9_700), amount_cents: TL(2_425) });
    expect(payeeTotal(out, "u-b")).toBe(TL(4_767.5));
    expect(payeeTotal(out, "u-c")).toBe(TL(5_401));
    expect(out.warnings).toEqual([]);
    expect(out.lab_summary.map((x) => [x.doctor_name, x.lab_name, x.cost_cents, x.deducted_cents, x.count])).toEqual([
      ["Hekim B", "Lab X", TL(3_000), TL(3_000), 2],
      ["Hekim B", "Lab Y", TL(450), TL(450), 1],
      ["Hekim C", "Lab X", TL(300), TL(300), 1],
      ["Hekim C", "Lab Y", TL(700), TL(700), 1],
    ]);
    expect(out.lab_totals).toEqual([
      { lab_name: "Lab X", cost_cents: TL(3_300), deducted_cents: TL(3_300), count: 3 },
      { lab_name: "Lab Y", cost_cents: TL(1_150), deducted_cents: TL(1_150), count: 2 },
    ]);

    // A higher child age limit moves the birthday cost to the child rule too.
    const older = run({ month: "2026-11", rules, lines, marks, lab_costs: Object.values(labs), settings: { child_age_limit: 15 } });
    expect(component(older, bChild.id).lab_cents).toBe(TL(3_000));
    expect(component(older, bStd.id).lab_cents).toBe(TL(450));
  });

  it("keeps the ortho lab-first walk unchanged; its recovery of the month is split per lab in the summary", () => {
    const s = rule({ kind: "ortho_lab_first", payee_user_id: "u-s", doctor_id: "doc-s", share_bp: 5500 });
    const sStd = rule({ kind: "ciro_share", payee_user_id: "u-s", doctor_id: "doc-s", segment: "standard", share_bp: 2500 });
    const labs = [
      lab({ patient_ref: "orto 1", day: "2026-11-03", amount_cents: TL(21_000), lab_name: "Lab Y" }),
      lab({ patient_ref: "orto 1", day: "2026-11-04", amount_cents: TL(15_000), lab_name: "Lab X" }),
    ];
    const nov = line({ doctor_id: "doc-s", patient_ref: "orto 1", day: "2026-11-06", try_cents: TL(18_000) });
    const dec = line({ doctor_id: "doc-s", patient_ref: "orto 1", day: "2026-12-06", try_cents: TL(30_000) });
    const lines = [nov, dec];

    const outNov = run({ month: "2026-11", rules: [s, sStd], lines, lab_costs: labs });
    expect(labPartOf(outNov, nov.id)).toBe(TL(18_000));
    expect(component(outNov, s.id)).toMatchObject({ base_cents: 0, amount_cents: 0 });
    // The costs belong to the ortho rule; nothing is deducted from a ciro component on top of the walk.
    expect(outNov.lab_results.map((x) => x.rule_id)).toEqual([s.id, s.id]);
    expect("lab_cents" in component(outNov, s.id)).toBe(false);
    expect("lab_cents" in component(outNov, sStd.id)).toBe(false);
    expect(component(run({ month: "2026-11", rules: [s], lines, lab_costs: labs }), s.id)).toEqual(component(outNov, s.id));
    expect(outNov.warnings).toEqual([]);
    // 18.000 recovered of 36.000: Lab X 15 / 36 of it, Lab Y 21 / 36.
    expect(outNov.lab_summary).toEqual([
      { doctor_id: "doc-s", doctor_name: "Hekim S", lab_name: "Lab X", cost_cents: TL(15_000), deducted_cents: TL(7_500), count: 1 },
      { doctor_id: "doc-s", doctor_name: "Hekim S", lab_name: "Lab Y", cost_cents: TL(21_000), deducted_cents: TL(10_500), count: 1 },
    ]);

    // December recovers the rest from a payment: rows without costs of the month, only the deducted part.
    const outDec = run({ month: "2026-12", rules: [s, sStd], lines, lab_costs: labs });
    expect(labPartOf(outDec, dec.id)).toBe(TL(18_000));
    expect(component(outDec, s.id)).toMatchObject({ base_cents: TL(12_000), amount_cents: TL(6_600) });
    expect(outDec.lab_results).toEqual([]);
    expect(outDec.lab_summary.map((x) => [x.lab_name, x.cost_cents, x.deducted_cents, x.count])).toEqual([
      ["Lab X", 0, TL(7_500), 0],
      ["Lab Y", 0, TL(10_500), 0],
    ]);
    expect(run({ month: "2027-01", rules: [s], lines, lab_costs: labs }).lab_summary).toEqual([]);
  });

  it("does not recover again in the ortho walk a cost deducted from a ciro_share rule in its own month", () => {
    // Hekim S: ciro_share 25 % in 2026-02 only, then ortho_lab_first 55 % from 2026-03.
    const sCiro = rule({
      kind: "ciro_share",
      payee_user_id: "u-s",
      doctor_id: "doc-s",
      segment: "standard",
      share_bp: 2500,
      from_month: "2026-02-01",
      to_month: "2026-02-01",
    });
    const sOrtho = rule({
      kind: "ortho_lab_first",
      payee_user_id: "u-s",
      doctor_id: "doc-s",
      share_bp: 5500,
      from_month: "2026-03-01",
    });
    const rules = [sCiro, sOrtho];
    const febLine = line({ doctor_id: "doc-s", patient_ref: "hasta 2", day: "2026-02-05", try_cents: TL(10_000) });
    // The patient pays only in March; the February cost came off February's ciro.
    const febCost = lab({ patient_ref: "hasta 1", day: "2026-02-10", amount_cents: TL(1_000), lab_name: "Lab X" });
    const marLine = line({ doctor_id: "doc-s", patient_ref: "hasta 1", day: "2026-03-04", try_cents: TL(4_000) });
    const lines = [febLine, marLine];

    const feb = run({ month: "2026-02", rules, lines, lab_costs: [febCost] });
    expect(component(feb, sCiro.id)).toMatchObject({
      base_cents: TL(9_000),
      amount_cents: TL(2_250),
      lab_cents: TL(1_000),
      lab_excess_cents: 0,
    });

    const mar = run({ month: "2026-03", rules, lines, lab_costs: [febCost] });
    expect(labPartOf(mar, marLine.id)).toBe(0);
    expect(component(mar, sOrtho.id)).toMatchObject({ base_cents: TL(4_000), amount_cents: TL(2_200), lab_patients: [] });
    expect(mar.lab_summary).toEqual([]);
    expect(mar.warnings).toEqual([]);

    // A March cost of the same patient is recovered and listed alone; the per-lab split has no February lab.
    const marCost = lab({ patient_ref: "hasta 1", day: "2026-03-02", amount_cents: TL(500), lab_name: "Lab Y" });
    const mixed = run({ month: "2026-03", rules, lines, lab_costs: [febCost, marCost] });
    expect(labPartOf(mixed, marLine.id)).toBe(TL(500));
    expect(component(mixed, sOrtho.id)).toMatchObject({
      base_cents: TL(3_500),
      amount_cents: TL(1_925),
      lab_patients: [
        {
          patient_ref: "hasta 1",
          patient_name: "hasta 1",
          lab_total_cents: TL(500),
          recovered_cents: TL(500),
          remaining_cents: 0,
          recovered_in_month_cents: TL(500),
        },
      ],
    });
    expect(mixed.lab_summary).toEqual([
      { doctor_id: "doc-s", doctor_name: "Hekim S", lab_name: "Lab Y", cost_cents: TL(500), deducted_cents: TL(500), count: 1 },
    ]);
    // Later months keep it out too (the February rule still decides the February cost).
    const apr = run({
      month: "2026-04",
      rules,
      lines: [...lines, line({ doctor_id: "doc-s", patient_ref: "hasta 1", day: "2026-04-04", try_cents: TL(3_000) })],
      lab_costs: [febCost],
    });
    expect(component(apr, sOrtho.id)).toMatchObject({ base_cents: TL(3_000), lab_patients: [] });
  });

  it("still recovers in the ortho walk a cost that had no rule in its own month (before the ortho start)", () => {
    const sCiro = rule({
      kind: "ciro_share",
      payee_user_id: "u-s",
      doctor_id: "doc-s",
      segment: "standard",
      share_bp: 2500,
      from_month: "2026-02-01",
      to_month: "2026-02-01",
    });
    const sOrtho = rule({
      kind: "ortho_lab_first",
      payee_user_id: "u-s",
      doctor_id: "doc-s",
      share_bp: 5500,
      from_month: "2026-03-01",
    });
    // January: no rule of Hekim S (UNRULED_LAB there); February: ciro_share; March: the walk recovers January's cost.
    const janCost = lab({ patient_ref: "hasta 3", day: "2026-01-20", amount_cents: TL(800), lab_name: "Lab X" });
    const marLine = line({ doctor_id: "doc-s", patient_ref: "hasta 3", day: "2026-03-09", try_cents: TL(3_000) });

    const jan = run({ month: "2026-01", rules: [sCiro, sOrtho], lines: [marLine], lab_costs: [janCost] });
    expect(jan.warnings).toEqual([{ code: "UNRULED_LAB", doctor_id: "doc-s", doctor_name: "Hekim S", lab_cents: TL(800) }]);

    const mar = run({ month: "2026-03", rules: [sCiro, sOrtho], lines: [marLine], lab_costs: [janCost] });
    expect(labPartOf(mar, marLine.id)).toBe(TL(800));
    expect(component(mar, sOrtho.id)).toMatchObject({
      base_cents: TL(2_200),
      amount_cents: TL(1_210),
      lab_patients: [
        {
          patient_ref: "hasta 3",
          patient_name: "hasta 3",
          lab_total_cents: TL(800),
          recovered_cents: TL(800),
          remaining_cents: 0,
          recovered_in_month_cents: TL(800),
        },
      ],
    });
    expect(mar.lab_summary).toEqual([
      { doctor_id: "doc-s", doctor_name: "Hekim S", lab_name: "Lab X", cost_cents: 0, deducted_cents: TL(800), count: 0 },
    ]);
    // Same as an ortho-only history: the February rule has no costs of its own month to take out.
    expect(component(run({ month: "2026-03", rules: [sOrtho], lines: [marLine], lab_costs: [janCost] }), sOrtho.id)).toEqual(
      component(mar, sOrtho.id)
    );
  });

  it("warns about lab costs without a ciro / ortho rule (UNRULED_LAB), before LAB_OVER_CIRO (SQL warning order)", () => {
    const implant = rule({ kind: "implant_piece", payee_user_id: "u-b", doctor_id: "doc-e", piece_cents: TL(1_000) });
    const a = aStd();
    const labs = [
      lab({ doctor_id: "doc-e", patient_ref: "hasta 1", day: "2026-11-02", amount_cents: TL(1_200), lab_name: "Lab X" }),
      lab({ doctor_id: "doc-d", patient_ref: "hasta 2", day: "2026-11-03", amount_cents: TL(800), lab_name: "Lab Y" }),
      // Costs that net to zero lose nothing: no warning.
      lab({ doctor_id: "doc-c", patient_ref: "hasta 3", day: "2026-11-04", amount_cents: TL(500), lab_name: "Lab X" }),
      lab({ doctor_id: "doc-c", patient_ref: "hasta 3", day: "2026-11-05", amount_cents: TL(-500), lab_name: "Lab X" }),
      // A doctor unknown to `doctors` is named after the cost row.
      lab({ doctor_id: "doc-x", doctor_name: "Hekim X", patient_ref: "hasta 4", day: "2026-11-06", amount_cents: TL(100), lab_name: "Lab Y" }),
      // Hekim A has a ciro rule but no ciro this month.
      lab({ doctor_id: "doc-a", patient_ref: "hasta 5", day: "2026-11-07", amount_cents: TL(100), lab_name: "Lab X" }),
    ];
    const out = run({
      month: "2026-11",
      rules: [implant, a],
      lines: [line({ doctor_id: "doc-d", try_cents: TL(300) })],
      lab_costs: labs,
    });
    expect(out.warnings).toEqual([
      { code: "UNRULED_LINES", doctor_id: "doc-d", doctor_name: "Hekim D", count: 1, try_cents: TL(300) },
      { code: "UNRULED_LAB", doctor_id: "doc-d", doctor_name: "Hekim D", lab_cents: TL(800) },
      { code: "UNRULED_LAB", doctor_id: "doc-e", doctor_name: "Hekim E", lab_cents: TL(1_200) },
      { code: "UNRULED_LAB", doctor_id: "doc-x", doctor_name: "Hekim X", lab_cents: TL(100) },
      {
        code: "LAB_OVER_CIRO",
        doctor_id: "doc-a",
        doctor_name: "Hekim A",
        rule_id: a.id,
        segment: "standard",
        lab_cents: TL(100),
        ciro_after_deductions_cents: 0,
        excess_cents: TL(100),
      },
    ]);
    expect(warningText(out.warnings[1])).toBe(
      "Hekim D: ₺800,00 lab maliyeti için ciro payı veya ortodonti kuralı yok; hakedişten düşülmedi."
    );
    expect(out.lab_results.filter((x) => x.rule_id === null)).toHaveLength(5);
    expect(component(out, implant.id)).toMatchObject({ amount_cents: 0, qty: 0 });
    expect(out.lab_summary.map((x) => [x.doctor_name, x.lab_name, x.cost_cents, x.deducted_cents, x.count])).toEqual([
      ["Hekim A", "Lab X", TL(100), 0, 1],
      ["Hekim C", "Lab X", 0, 0, 2],
      ["Hekim D", "Lab Y", TL(800), 0, 1],
      ["Hekim E", "Lab X", TL(1_200), 0, 1],
      ["Hekim X", "Lab Y", TL(100), 0, 1],
    ]);
  });

  it("ignores voided lab costs and costs of other months; results without them stay identical", () => {
    const a = aStd();
    const input: HkComputeInput = {
      month: "2026-11",
      doctors: DOCTORS,
      payees: PAYEES,
      rules: [
        a,
        rule({ kind: "clinic_ciro_share", payee_user_id: "u-c", share_bp: 500 }),
        rule({ kind: "implant_piece", payee_user_id: "u-b", doctor_id: "doc-b", piece_cents: TL(1_500) }),
      ],
      lines: [
        line({ doctor_id: "doc-a", method: "card", try_cents: TL(12_345.67) }),
        line({ doctor_id: "doc-d", try_cents: TL(800) }),
      ],
      pieces: [piece({ doctor_id: "doc-b", qty: 2 })],
      counterparty_user_ids: ["u-a"],
    };
    const before = computeMonth(input);
    const after = computeMonth({
      ...input,
      lab_costs: [
        lab({ doctor_id: "doc-a", patient_ref: "hasta 1", day: "2026-11-10", amount_cents: TL(5_000), lab_name: "Lab X", voided_at: "2026-11-11T08:00:00Z" }),
        lab({ doctor_id: "doc-a", patient_ref: "hasta 1", day: "2026-10-31", amount_cents: TL(5_000), lab_name: "Lab X" }),
        lab({ doctor_id: "doc-a", patient_ref: "hasta 1", day: "2026-12-01", amount_cents: TL(5_000), lab_name: "Lab X" }),
        lab({ doctor_id: "doc-d", patient_ref: "hasta 2", day: "2026-10-15", amount_cents: TL(700), lab_name: "Lab Y" }),
      ],
    });
    expect(after).toEqual(before);
    expect(computeMonth({ ...input, lab_costs: [] })).toEqual(before);
    expect(before.lab_results).toEqual([]);
    expect(before.lab_summary).toEqual([]);
    expect(before.lab_totals).toEqual([]);
    // A ciro component without lab costs keeps exactly its 0031 keys.
    expect(Object.keys(component(before, a.id)).sort()).toEqual(
      ["amount_cents", "base_cents", "by_method", "doctor_id", "doctor_name", "kind", "lines_count", "piece_cents", "qty", "rule_id", "segment", "share_bp"].sort()
    );
  });
});

describe("minimum monthly floor (v1.4)", () => {
  const floor = (payee: string, cents: number, from_month = "2026-11-01", to_month: string | null = null) =>
    rule({ kind: "minimum_monthly", payee_user_id: payee, piece_cents: cents, from_month, to_month });
  const salary = (payee: string, cents: number) => rule({ kind: "fixed_monthly", payee_user_id: payee, piece_cents: cents });
  const bank = (payee: string, cents: number) => rule({ kind: "bank_portion", payee_user_id: payee, piece_cents: cents });
  const bonus = (payee: string, cents: number): HkComputeAdjustment => ({
    id: nextId("a"),
    month: "2026-11-01",
    payee_user_id: payee,
    kind: "bonus",
    amount_cents: cents,
    description: "Örnek prim",
  });
  const payee = (out: HkComputeOutput, userId: string) => out.payees.find((p) => p.payee_user_id === userId)!;

  it("pays the floor when the month is below it, and nothing more when it is equal or above", () => {
    const a = aStd();
    const m = floor("u-a", TL(5_000));
    const linesOf = new Map<number, HkComputeLine[]>();
    const at = (cents: number, rules: HkComputeRule[] = [a, m]) => {
      if (!linesOf.has(cents)) linesOf.set(cents, [line({ doctor_id: "doc-a", try_cents: cents })]);
      return run({ month: "2026-11", rules, lines: linesOf.get(cents)! });
    };

    // 25 % of 7.600 = 1.900 → topped up by 3.100 to the 5.000 floor.
    const below = at(TL(7_600));
    const p = payee(below, "u-a");
    expect(p.total_cents).toBe(TL(5_000));
    expect(p.components.map((c) => c.kind)).toEqual(["ciro_share", "minimum_topup"]);
    expect(p.components[1]).toEqual({ kind: "minimum_topup", rule_id: m.id, amount_cents: TL(3_100) });
    expect(component(below, a.id).amount_cents).toBe(TL(1_900));
    expect(componentTitle(p.components[1])).toBe(MINIMUM_TOPUP_COMPONENT_LABEL);
    expect(componentTitle(p.components[1])).toBe("Taban maaş tamamlaması");
    expect(componentKey(p.components[1])).toBe(m.id);
    expect(summarizePayee(p)).toMatchObject({ share_cents: TL(1_900), minimum_topup_cents: TL(3_100), total_cents: TL(5_000) });
    expect(below.warnings).toEqual([]);

    // Equal to or above the floor: the month is exactly that of the plain rules.
    for (const cents of [TL(20_000), TL(40_000)]) {
      expect(at(cents)).toEqual(at(cents, [a]));
    }
    expect(payeeTotal(at(TL(20_000)), "u-a")).toBe(TL(5_000));
    expect(payeeTotal(at(TL(40_000)), "u-a")).toBe(TL(10_000));
  });

  it("compares the floor with every other component, bonuses and corrections included", () => {
    const a = aStd();
    const m = floor("u-a", TL(5_000));
    const withBonus = run({
      month: "2026-11",
      rules: [a, m],
      lines: [line({ doctor_id: "doc-a", try_cents: TL(7_600) })],
      adjustments: [bonus("u-a", TL(1_000))],
    });
    expect(payee(withBonus, "u-a").components.map((c) => [c.kind, c.amount_cents])).toEqual([
      ["ciro_share", TL(1_900)],
      ["adjustments", TL(1_000)],
      ["minimum_topup", TL(2_100)],
    ]);
    expect(payeeTotal(withBonus, "u-a")).toBe(TL(5_000));

    // A correction month: the floor still holds (top-up = floor − a negative subtotal).
    const dec = run({
      month: "2026-12",
      rules: [a, m],
      lines: [line({ doctor_id: "doc-a", day: "2026-12-03", try_cents: TL(-1_800) })],
    });
    expect(payee(dec, "u-a").components.map((c) => c.amount_cents)).toEqual([TL(-450), TL(5_450)]);
    expect(payeeTotal(dec, "u-a")).toBe(TL(5_000));
  });

  it("lists a payee with only a floor; tops up a lower salary; applies only within its months", () => {
    const rules = [floor("u-p1", TL(17_000)), salary("u-p2", TL(15_000)), floor("u-p2", TL(17_000))];
    const out = run({ month: "2026-11", rules, lines: [], counterparty_user_ids: ["u-p2"] });
    expect(out.payees.map((p) => [p.payee_name, p.total_cents, p.components.map((c) => [c.kind, c.amount_cents])])).toEqual([
      ["Personel Bir", TL(17_000), [["minimum_topup", TL(17_000)]]],
      ["Personel İki", TL(17_000), [["fixed_monthly", TL(15_000)], ["minimum_topup", TL(2_000)]]],
    ]);
    // The topped-up total is what is owed: a counterparty is needed.
    expect(out.warnings).toEqual([
      { code: "NO_COUNTERPARTY", payee_user_id: "u-p1", payee_name: "Personel Bir", reason: "missing" },
    ]);

    const a = aStd();
    const lines = [line({ doctor_id: "doc-a", try_cents: TL(1_000) })];
    const later = floor("u-a", TL(5_000), "2026-12-01", "2026-12-01");
    expect(run({ month: "2026-11", rules: [a, later], lines })).toEqual(run({ month: "2026-11", rules: [a], lines }));
    expect(payeeTotal(run({ month: "2026-12", rules: [a, later], lines }), "u-a")).toBe(TL(5_000));
    expect(run({ month: "2027-01", rules: [later], lines: [] }).payees).toEqual([]);

    // Overlapping floors (only through invalid data): the highest one.
    const low = floor("u-p1", TL(10_000), "2026-10-01");
    const high = floor("u-p1", TL(12_000));
    const both = run({ month: "2026-11", rules: [low, high], lines: [] });
    expect(payee(both, "u-p1").components).toEqual([{ kind: "minimum_topup", rule_id: high.id, amount_cents: TL(12_000) }]);
  });

  it("splits the final total into bank and cash", () => {
    const a = aStd();
    const lines = [line({ doctor_id: "doc-a", try_cents: TL(7_600) })];
    const out = run({ month: "2026-11", rules: [a, floor("u-a", TL(5_000)), bank("u-a", TL(4_000))], lines });
    expect(payee(out, "u-a")).toMatchObject({ total_cents: TL(5_000), bank_cents: TL(4_000), cash_cents: TL(1_000) });
    expect(out.warnings).toEqual([]);

    // The bank part is compared with the topped-up total (5.000), not with the 1.900 hakediş.
    const over = run({ month: "2026-11", rules: [a, floor("u-a", TL(5_000)), bank("u-a", TL(6_000))], lines });
    expect(over.warnings).toEqual([
      { code: "BANK_OVER_TOTAL", payee_user_id: "u-a", payee_name: "Hekim A", bank_cents: TL(6_000), total_cents: TL(5_000) },
    ]);
    const exact = run({ month: "2026-11", rules: [a, floor("u-a", TL(5_000)), bank("u-a", TL(5_000))], lines });
    expect(payee(exact, "u-a")).toMatchObject({ bank_cents: TL(5_000), cash_cents: 0 });
    expect(exact.warnings).toEqual([]);

    const rows = [...out.payees, ...run({ month: "2026-11", rules: [salary("u-p1", TL(9_000)), floor("u-p1", TL(10_000))], lines: [] }).payees].map(
      summarizePayee
    );
    expect(sumPayeeSummaries(rows)).toMatchObject({
      share_cents: TL(1_900),
      salary_cents: TL(9_000),
      minimum_topup_cents: TL(3_100 + 1_000),
      total_cents: TL(15_000),
    });
    expect(emptyPayeeSummary()).toMatchObject({ minimum_topup_cents: 0, lab_excess_cents: 0 });
  });

  it("checks minimum_monthly rules: fields, labels, overlaps per payee", () => {
    expect(KIND_LABELS.minimum_monthly).toBe("Taban maaş (hangisi yüksekse)");
    expect(RULE_FIELDS.minimum_monthly).toEqual({
      doctor: false,
      segment: false,
      share: false,
      piece: true,
      deductions: false,
      unpaid: false,
      group: false,
    });
    expect(pieceFieldLabel("minimum_monthly")).toBe("Aylık taban tutar (TL)");
    expect(MINIMUM_MONTHLY_HINT).toBe("Ayın hakedişi bu tutarın altında kalırsa bu tutar ödenir.");
    expect(kindAllowsAnyUser("minimum_monthly")).toBe(true);

    const base: HkRuleInput = {
      payee_user_id: "u-a",
      doctor_id: null,
      kind: "minimum_monthly",
      segment: null,
      share_bp: null,
      piece_cents: TL(5_000),
      deduct_cash_bp: 0,
      deduct_card_bp: 0,
      deduct_transfer_bp: 0,
      deduct_financing_bp: 0,
      from_month: "2026-11",
      to_month: null,
    };
    expect(validateRule(base)).toBeNull();
    expect(validateRule({ ...base, payee_user_id: null })).toBe("Taban maaş alacak kişiyi seçin.");
    for (const bad of [0, -100, null, 12.5]) {
      expect(validateRule({ ...base, piece_cents: bad })).toBe("Aylık taban tutar 0'dan büyük olmalı.");
    }
    expect(validateRule({ ...base, deduct_card_bp: 100 })).toBe("Bu kural türünde kesinti girilemez.");

    const m1 = { ...floor("u-a", TL(5_000), "2026-11-01", "2026-12-01"), note: "" };
    const s1 = { ...salary("u-a", TL(5_000)), note: "" };
    const b1 = { ...bank("u-a", TL(5_000)), note: "" };
    const rules = [m1, s1, b1];
    expect(ruleOverlapKey(m1)).toBe("minimum_monthly|u-a");
    expect(findOverlappingRule(rules, { ...m1, id: "new", from_month: "2026-12-01", to_month: null })?.id).toBe(m1.id);
    expect(findOverlappingRule(rules, { ...m1, id: "new", from_month: "2027-01-01", to_month: null })).toBeUndefined();
    expect(findOverlappingRule(rules, { ...m1, id: "new", payee_user_id: "u-b" })).toBeUndefined();
    expect(minimumRuleOf(rules, "u-a", "2026-12")?.id).toBe(m1.id);
    expect(minimumRuleOf(rules, "u-a", "2027-01")).toBeUndefined();
    expect(minimumRuleOf(rules, "u-b", "2026-11")).toBeUndefined();
  });
});

describe("lab summary helpers (v1.4)", () => {
  it("splits an amount by weight with cumulative rounding that always adds up", () => {
    expect(allocateByWeight(100, [1, 1, 1])).toEqual([33, 34, 33]);
    expect(allocateByWeight(5, [1, 1])).toEqual([3, 2]);
    expect(allocateByWeight(-5, [1, 1])).toEqual([-3, -2]);
    // amount = total weight: every part is its own weight.
    expect(allocateByWeight(1_000, [700, 300])).toEqual([700, 300]);
    expect(allocateByWeight(-1_000, [-700, -300])).toEqual([-700, -300]);
    expect(allocateByWeight(0, [3, 4])).toEqual([0, 0]);
    expect(allocateByWeight(7, [3, -3])).toEqual([0, 0]);
    expect(allocateByWeight(7, [])).toEqual([]);
    for (const [amount, weights] of [
      [999_999_999_999, [333_333, 666_667, 1]],
      [1_000_000, [900_001, 599_999]],
      [17, [5, 5, 5, 5]],
    ] as const) {
      expect(allocateByWeight(amount, weights).reduce((s, x) => s + x, 0)).toBe(amount);
    }
  });

  it("groups lab cost rows and summary rows per lab, by lab name", () => {
    const rows = [
      { lab_name: "Lab Y", amount_cents: TL(300) },
      { lab_name: "Lab X", amount_cents: TL(1_000) },
      { lab_name: "Lab Y", amount_cents: TL(-100) },
    ];
    expect(groupLabCosts(rows)).toEqual([
      { lab_name: "Lab X", cost_cents: TL(1_000), count: 1 },
      { lab_name: "Lab Y", cost_cents: TL(200), count: 2 },
    ]);
    expect(groupLabCosts([])).toEqual([]);
    expect(
      labTotalsOf([
        { doctor_id: "doc-a", doctor_name: "Hekim A", lab_name: "Lab Y", cost_cents: TL(500), deducted_cents: TL(500), count: 1 },
        { doctor_id: "doc-a", doctor_name: "Hekim A", lab_name: "Lab X", cost_cents: TL(200), deducted_cents: 0, count: 2 },
        { doctor_id: "doc-b", doctor_name: "Hekim B", lab_name: "Lab Y", cost_cents: TL(700), deducted_cents: TL(350), count: 3 },
      ])
    ).toEqual([
      { lab_name: "Lab X", cost_cents: TL(200), deducted_cents: 0, count: 2 },
      { lab_name: "Lab Y", cost_cents: TL(1_200), deducted_cents: TL(850), count: 4 },
    ]);
    expect(LAB_LABELS.tab).toBe("Lab özeti");
    expect(LAB_LABELS.column).toBe("Lab");
    expect(LAB_SUMMARY_HINT).toContain("Finans → Cariler");
  });

  it("groups the summary per doctor for the Lab özeti table and tells the lab warnings apart", () => {
    const rows = [
      { doctor_id: "doc-a", doctor_name: "Hekim A", lab_name: "Lab X", cost_cents: TL(200), deducted_cents: TL(200), count: 2 },
      { doctor_id: "doc-a", doctor_name: "Hekim A", lab_name: "Lab Y", cost_cents: TL(500), deducted_cents: TL(300), count: 1 },
      { doctor_id: "doc-s", doctor_name: "Hekim S", lab_name: "Lab Y", cost_cents: 0, deducted_cents: TL(75), count: 0 },
    ];
    expect(labSummaryByDoctor(rows)).toEqual([
      { doctor_id: "doc-a", doctor_name: "Hekim A", rows: rows.slice(0, 2), cost_cents: TL(700), deducted_cents: TL(500), count: 3 },
      { doctor_id: "doc-s", doctor_name: "Hekim S", rows: rows.slice(2), cost_cents: 0, deducted_cents: TL(75), count: 0 },
    ]);
    expect(labSummaryByDoctor([])).toEqual([]);
    expect(isLabWarning({ code: "UNRULED_LAB", doctor_id: "doc-a", doctor_name: "Hekim A", lab_cents: 1 })).toBe(true);
    expect(isLabWarning({ code: "UNRULED_LINES", doctor_id: "doc-a", doctor_name: "Hekim A", count: 1, try_cents: 1 })).toBe(false);
    expect(LAB_DEDUCTION_TEXT).toContain("kesintilerinden sonra");
  });

  it("compares lab names in byte order (COLLATE \"C\"), code point by code point", () => {
    expect(compareCodePoints("Lab Z", "Lab Ç")).toBe(-1);
    expect(compareCodePoints("Lab Ç", "Lab Z")).toBe(1);
    expect(compareCodePoints("Lab", "Lab X")).toBe(-1);
    expect(compareCodePoints("Lab X", "Lab X")).toBe(0);
    expect(compareCodePoints("lab", "Lab")).toBe(1);
    // Beyond the BMP: U+1F600 (a surrogate pair in UTF-16) sorts after U+FF21, as in UTF-8.
    expect(compareCodePoints("\u{1F600}", "Ａ")).toBe(1);
    expect("\u{1F600}" < "Ａ").toBe(true);
  });

  it("shares a deducted amount over the labs in byte order of their names, as fin__hk_lab_alloc", () => {
    // 1,01 TL of ciro, two 1,00 TL lab costs: 1,01 is deducted; byte order puts "Lab Z" (0x5A) before "Lab Ç" (U+00C7),
    // so the rounding cent goes to Lab Z, while the rows are listed in Turkish order.
    const r = rule({ kind: "ciro_share", payee_user_id: "u-b", doctor_id: "doc-b", segment: "standard", share_bp: 5000 });
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [line({ doctor_id: "doc-b", try_cents: 101 })],
      lab_costs: [
        lab({ doctor_id: "doc-b", patient_ref: "hasta 1", day: "2026-11-11", amount_cents: 100, lab_name: "Lab Ç" }),
        lab({ doctor_id: "doc-b", patient_ref: "hasta 2", day: "2026-11-12", amount_cents: 100, lab_name: "Lab Z" }),
      ],
    });
    expect(component(out, r.id)).toMatchObject({ base_cents: 0, lab_cents: 101, lab_excess_cents: 99 });
    expect(out.lab_summary.map((x) => [x.lab_name, x.cost_cents, x.deducted_cents])).toEqual([
      ["Lab Ç", 100, 50],
      ["Lab Z", 100, 51],
    ]);
    expect(out.lab_totals.map((x) => x.lab_name)).toEqual(["Lab Ç", "Lab Z"]);
    expect(summarizePayee(out.payees[0])).toMatchObject({ lab_cents: 101, ciro_lab_cents: 101, lab_excess_cents: 99 });

    // The same in the ortho walk: 1,01 TL recovered from 2,00 TL of lab costs of one patient.
    const s = rule({ kind: "ortho_lab_first", payee_user_id: "u-s", doctor_id: "doc-s", share_bp: 5000 });
    const ortho = run({
      month: "2026-11",
      rules: [s],
      lines: [line({ doctor_id: "doc-s", patient_ref: "orto 1", try_cents: 101 })],
      lab_costs: [
        lab({ patient_ref: "orto 1", day: "2026-11-02", amount_cents: 100, lab_name: "Lab Ç" }),
        lab({ patient_ref: "orto 1", day: "2026-11-03", amount_cents: 100, lab_name: "Lab Z" }),
      ],
    });
    expect(ortho.lab_summary.map((x) => [x.lab_name, x.deducted_cents])).toEqual([
      ["Lab Ç", 50],
      ["Lab Z", 51],
    ]);
    // Ortho lab parts are by_method lab, not ciro_share lab_cents.
    expect(summarizePayee(ortho.payees[0])).toMatchObject({ lab_cents: 101, ciro_lab_cents: 0 });
  });

  it("breaks ties like the SQL: warnings by doctor id after the name, equal floors by rule id", () => {
    const doctors = [
      { id: "doc-q2", name: "Hekim Aynı" },
      { id: "doc-q1", name: "Hekim Aynı" },
    ];
    const out = computeMonth({
      month: "2026-11",
      doctors,
      payees: PAYEES,
      rules: [],
      lines: [line({ doctor_id: "doc-q2", try_cents: TL(10) }), line({ doctor_id: "doc-q1", try_cents: TL(20) })],
      lab_costs: [
        lab({ doctor_id: "doc-q2", patient_ref: "hasta 1", day: "2026-11-02", amount_cents: TL(5), lab_name: "Lab X" }),
        lab({ doctor_id: "doc-q1", patient_ref: "hasta 2", day: "2026-11-03", amount_cents: TL(6), lab_name: "Lab X" }),
      ],
    });
    expect(out.warnings.map((w) => [w.code, "doctor_id" in w ? w.doctor_id : ""])).toEqual([
      ["UNRULED_LINES", "doc-q1"],
      ["UNRULED_LINES", "doc-q2"],
      ["UNRULED_LAB", "doc-q1"],
      ["UNRULED_LAB", "doc-q2"],
    ]);
    expect(out.lab_summary.map((x) => x.doctor_id)).toEqual(["doc-q1", "doc-q2"]);

    // Overlapping equal floors (invalid data only): the lower rule id, whatever the input order.
    const f1 = rule({ id: "r-floor-1", kind: "minimum_monthly", payee_user_id: "u-p1", piece_cents: TL(9_000) });
    const f2 = rule({ id: "r-floor-2", kind: "minimum_monthly", payee_user_id: "u-p1", piece_cents: TL(9_000), from_month: "2026-10-01" });
    for (const rules of [[f1, f2], [f2, f1]]) {
      const p = run({ month: "2026-11", rules, lines: [] }).payees[0];
      expect(p.components).toEqual([{ kind: "minimum_topup", rule_id: "r-floor-1", amount_cents: TL(9_000) }]);
    }
  });
});

describe("percent helpers", () => {
  it("parses Turkish and plain percentages into basis points", () => {
    const bp = (s: string, allowZero = false) => {
      const p = parsePercent(s, { allowZero });
      return p.ok ? p.bp : p.error;
    };
    expect(bp("30")).toBe(3000);
    expect(bp("12,5")).toBe(1250);
    expect(bp("12.5")).toBe(1250);
    expect(bp("%30")).toBe(3000);
    expect(bp(" 30 % ")).toBe(3000);
    expect(bp("0,01")).toBe(1);
    expect(bp("100")).toBe(10000);
    expect(bp("007")).toBe(700);
    expect(bp("0", true)).toBe(0);
    expect(parsePercent("0").ok).toBe(false);
    expect(parsePercent("100,01").ok).toBe(false);
    expect(parsePercent("1000").ok).toBe(false);
    expect(parsePercent("12,555").ok).toBe(false);
    expect(parsePercent("12,").ok).toBe(false);
    expect(parsePercent("-5").ok).toBe(false);
    expect(parsePercent("abc").ok).toBe(false);
    expect(parsePercent("").ok).toBe(false);
  });

  it("formats basis points", () => {
    expect(formatBp(3000)).toBe("%30");
    expect(formatBp(1250)).toBe("%12,5");
    expect(formatBp(1205)).toBe("%12,05");
    expect(formatBp(1)).toBe("%0,01");
    expect(formatBp(10000)).toBe("%100");
    expect(formatBp(null)).toBe("—");
    expect(bpToInput(0)).toBe("0");
    expect(bpToInput(1250)).toBe("12,5");
    expect(bpToInput(undefined)).toBe("");
    for (const v of [1, 99, 1250, 3333, 10000]) {
      const p = parsePercent(bpToInput(v));
      expect(p.ok && p.bp).toBe(v);
    }
  });
});

describe("months and keys", () => {
  it("normalizes month values", () => {
    expect(monthKey("2026-11-01")).toBe("2026-11");
    expect(monthKey("2026-11")).toBe("2026-11");
    expect(monthStart("2026-11")).toBe("2026-11-01");
    expect(monthStart("2026-11-17")).toBe("2026-11-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11-01", 2)).toBe("2027-01");
    expect(addMonths("2026-12", 0)).toBe("2026-12");
  });

  it("defaults to the previous month while it is open", () => {
    expect(pickDefaultMonth("2026-12-01", [])).toBe("2026-11");
    const months = [{ month: "2026-11-01", status: "closed" as const }];
    expect(pickDefaultMonth("2026-12", months)).toBe("2026-12");
    expect(monthStatus(months, "2026-11")).toBe("closed");
    expect(monthStatus(months, "2026-10")).toBe("open");
    expect(pickDefaultMonth("2026-12", [{ month: "2026-11-01", status: "open" as const }])).toBe("2026-11");
  });

  it("builds the patient key like fin__normalize_name", () => {
    expect(normalizePatientRef("  HASTA   İKİ\tIşık ")).toBe("hasta iki ışık");
    expect(normalizePatientRef("ÇAĞRI ÖZ ŞÜ")).toBe("çağrı öz şü");
    expect(normalizePatientRef(null)).toBe("");
  });
});

describe("validateRule", () => {
  const base: HkRuleInput = {
    payee_user_id: "u-a",
    doctor_id: "doc-a",
    kind: "ciro_share",
    segment: "standard",
    share_bp: 2500,
    piece_cents: null,
    deduct_cash_bp: 0,
    deduct_card_bp: 1100,
    deduct_transfer_bp: 900,
    deduct_financing_bp: 1300,
    from_month: "2026-11",
    to_month: null,
  };

  it("checks the fields of each kind", () => {
    expect(validateRule(base)).toBeNull();
    expect(validateRule({ ...base, segment: null })).not.toBeNull();
    expect(validateRule({ ...base, share_bp: 0 })).not.toBeNull();
    expect(validateRule({ ...base, to_month: "2026-10" })).not.toBeNull();
    expect(validateRule({ ...base, to_month: "2026-11-01" })).toBeNull();
    expect(
      validateRule({ ...base, kind: "implant_piece", segment: null, share_bp: null, piece_cents: TL(1_500) })
    ).toBe("Bu kural türünde kesinti girilemez.");
    expect(
      validateRule({
        ...base,
        kind: "implant_piece",
        segment: null,
        share_bp: null,
        piece_cents: TL(1_500),
        deduct_card_bp: 0,
        deduct_transfer_bp: 0,
        deduct_financing_bp: 0,
      })
    ).toBeNull();
    expect(
      validateRule({
        ...base,
        kind: "clinic_ciro_share",
        doctor_id: null,
        segment: null,
        share_bp: 500,
        deduct_card_bp: 0,
        deduct_transfer_bp: 0,
        deduct_financing_bp: 0,
      })
    ).toBeNull();
    expect(validateRule({ ...base, kind: "ortho_lab_first", doctor_id: null })).toBe("Hekimi seçin.");
  });
});

describe("RPC wrappers (v1.1)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { already_saved: false, record: {} }, error: null });
  });

  it("sends the settings, mark and reception marking arguments by name", async () => {
    await finHkSaveSettings({ p_version: 3, p_child_age_limit: 12 });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_settings", { p_version: 3, p_child_age_limit: 12 });

    const mark = {
      p_id: "m-1",
      p_version: 0,
      p_patient_ref: null,
      p_patient_name: "Hasta Bir",
      p_own_doctor_id: "doc-c",
      p_birth_date: "2015-04-01",
    };
    await hkSaveMark(mark);
    expect(rpcMock).toHaveBeenLastCalledWith("hk_save_mark", mark);

    await finHkSaveMark({ ...mark, p_is_child: false, p_note: "" });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_mark", { ...mark, p_is_child: false, p_note: "" });

    rpcMock.mockResolvedValueOnce({ data: [{ id: "m-1" }], error: null });
    expect(await hkMarksList("  Hasta ")).toEqual([{ id: "m-1" }]);
    expect(rpcMock).toHaveBeenLastCalledWith("hk_marks_list", { p_query: "Hasta" });
    rpcMock.mockResolvedValueOnce({ data: [{ id: "m-2" }], error: null });
    expect(await hkMarksList("")).toEqual([{ id: "m-2" }]);
    expect(rpcMock).toHaveBeenLastCalledWith("hk_marks_list", { p_query: "" });
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    expect(await hkMarksList("x")).toEqual([]);

    const access = { can_mark: true, doctors: [{ id: "doc-c", name: "Hekim C" }] };
    rpcMock.mockResolvedValueOnce({ data: access, error: null });
    expect(await hkMarksAccess()).toEqual(access);
    expect(rpcMock).toHaveBeenLastCalledWith("hk_marks_access");
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    expect(await hkMarksAccess()).toEqual({ can_mark: false, doctors: [] });
  });

  it("turns a refusal into a FinanceError with the server text", async () => {
    const message = "Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.";
    // hk_save_mark raises the closed-month lock with the default code (P0001), a missing right with 42501.
    rpcMock.mockResolvedValueOnce({ data: null, error: { message, code: "P0001" } });
    const args = {
      p_id: "m-1",
      p_version: 2,
      p_patient_ref: "hasta bir",
      p_patient_name: "Hasta Bir",
      p_own_doctor_id: null,
      p_birth_date: null,
    };
    await expect(hkSaveMark(args)).rejects.toMatchObject({ message, code: "P0001", isForbidden: false });
    const forbidden = "Hasta işaretlerini değiştirme yetkiniz yok.";
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: forbidden, code: "42501" } });
    await expect(hkSaveMark(args)).rejects.toMatchObject({ message: forbidden, isForbidden: true });
  });
});

describe("RPC wrappers (v1.2)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { already_saved: false, record: {} }, error: null });
  });

  it("sends the adjustment arguments by name, the month as its first day", async () => {
    const args = {
      p_id: "a-1",
      p_version: 0,
      p_month: "2026-11",
      p_payee_user_id: "u-p1",
      p_kind: "bonus" as const,
      p_amount_cents: TL(1_500),
      p_description: "Örnek prim",
    };
    await finHkSaveAdjustment(args);
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_adjustment", { ...args, p_month: "2026-11-01" });
    await finHkSaveAdjustment({ ...args, p_version: 2, p_month: "2026-12-01", p_kind: "other", p_amount_cents: TL(-300) });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_adjustment", {
      ...args,
      p_version: 2,
      p_month: "2026-12-01",
      p_kind: "other",
      p_amount_cents: TL(-300),
    });

    await finHkVoidAdjustment({ p_id: "a-1", p_version: 3, p_reason: "Yanlış kişi" });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_void_adjustment", { p_id: "a-1", p_version: 3, p_reason: "Yanlış kişi" });
  });

  it("passes the closed-month refusal through as a FinanceError", async () => {
    const message = "Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.";
    rpcMock.mockResolvedValueOnce({ data: null, error: { message, code: "P0001" } });
    await expect(
      finHkVoidAdjustment({ p_id: "a-1", p_version: 1, p_reason: "Yanlış tutar" })
    ).rejects.toMatchObject({ message, isForbidden: false });
  });
});

describe("RPC wrappers (v1.3)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { already_saved: false, record: {} }, error: null });
  });

  it("saves a bank_portion rule by name, months as their first day", async () => {
    const args = {
      p_id: "r-1",
      p_version: 0,
      p_payee_user_id: "u-p1",
      p_doctor_id: null,
      p_kind: "bank_portion" as const,
      p_segment: null,
      p_share_bp: null,
      p_piece_cents: TL(15_000),
      p_deduct_cash_bp: 0,
      p_deduct_card_bp: 0,
      p_deduct_transfer_bp: 0,
      p_deduct_financing_bp: 0,
      p_from_month: "2026-11",
      p_to_month: "2027-03",
      p_note: "",
    };
    await finHkSaveRule(args);
    // 0033: the unpaid deduction and the procedure group are always sent (0 / null when left out).
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_rule", {
      ...args,
      p_from_month: "2026-11-01",
      p_to_month: "2027-03-01",
      p_deduct_unpaid_bp: 0,
      p_proc_group_id: null,
    });
  });

  it("saves a minimum_monthly rule by name (v1.4)", async () => {
    const args = {
      p_id: "r-2",
      p_version: 1,
      p_payee_user_id: "u-a",
      p_doctor_id: null,
      p_kind: "minimum_monthly" as const,
      p_segment: null,
      p_share_bp: null,
      p_piece_cents: TL(5_000),
      p_deduct_cash_bp: 0,
      p_deduct_card_bp: 0,
      p_deduct_transfer_bp: 0,
      p_deduct_financing_bp: 0,
      p_from_month: "2026-11-01",
      p_to_month: null,
      p_note: "",
    };
    await finHkSaveRule(args);
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_rule", { ...args, p_deduct_unpaid_bp: 0, p_proc_group_id: null });
  });
});

describe("access flags of the hakediş payloads (0031)", () => {
  it("lets 'hakedis_prepare' enter data without the finance write flag", () => {
    expect(hkCanPrepare({ can_write: false, can_prepare: true })).toBe(true);
    expect(hkCanPrepare({ can_write: true, can_prepare: true })).toBe(true);
    expect(hkCanPrepare({ can_write: false, can_prepare: false })).toBe(false);
  });

  it("falls back to the 0030 payload (no can_prepare / ledger_visible: finance callers only)", () => {
    expect(hkCanPrepare({ can_write: true })).toBe(true);
    expect(hkCanPrepare({ can_write: false })).toBe(false);
    expect(hkLedgerVisible({})).toBe(true);
    expect(hkLedgerVisible({ ledger_visible: false })).toBe(false);
    expect(hkLedgerVisible({ ledger_visible: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v2 (0033): Macro import — unpaid lines, lines without a doctor, procedure groups and procedure_piece rules
// ---------------------------------------------------------------------------

const GROUPS: HkComputeProcGroup[] = [
  { id: "g-imp", name: "İmplant grubu", is_implant: true },
  { id: "g-cek", name: "Çekim grubu", is_implant: false },
  { id: "g-kist", name: "Kist grubu", is_implant: false },
];

describe("unpaid lines (v2)", () => {
  // Hekim A: 25 % of ciro after card 11 % and unpaid 11 %.
  const aUnpaid = () =>
    rule({
      kind: "ciro_share",
      payee_user_id: "u-a",
      doctor_id: "doc-a",
      segment: "standard",
      share_bp: 2500,
      deduct_card_bp: 1100,
      deduct_unpaid_bp: 1100,
    });

  it("deducts the part unpaid at month end at the rule's unpaid rate (owner example shape)", () => {
    const r = aUnpaid();
    // A 60.000 treatment, 30.000 paid in cash by the end of the month.
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [
        line({ doctor_id: "doc-a", method: "cash", try_cents: TL(30_000) }),
        line({ doctor_id: "doc-a", method: "unpaid", try_cents: TL(30_000) }),
      ],
    });
    const c = component(out, r.id);
    expect(c.by_method!.unpaid).toEqual({
      gross: TL(30_000),
      implant: 0,
      lab: 0,
      eligible: TL(30_000),
      deduct_bp: 1100,
      deduction: TL(3_300),
    });
    // 30.000 + 30.000 × 0,89 = 56.700 → 25 % = 14.175
    expect(c.base_cents).toBe(TL(56_700));
    expect(c.amount_cents).toBe(TL(14_175));
    expect(c.lines_count).toBe(2);
    expect(out.clinic_total_cents).toBe(TL(60_000));
    const s = summarizePayee(out.payees[0]);
    expect(s.gross_by_method).toEqual({ cash: TL(30_000), card: 0, transfer: 0, financing: 0, unpaid: TL(30_000) });
    expect(s).toMatchObject({ gross_cents: TL(60_000), deduction_cents: TL(3_300), base_cents: TL(56_700) });
  });

  it("keeps the implant part of an unpaid line out of the ciro", () => {
    const r = aUnpaid();
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [line({ doctor_id: "doc-a", method: "unpaid", try_cents: TL(20_000), implant_cents: TL(20_000) })],
    });
    expect(component(out, r.id).by_method!.unpaid).toMatchObject({ gross: TL(20_000), implant: TL(20_000), eligible: 0, deduction: 0 });
    expect(component(out, r.id).amount_cents).toBe(0);
  });

  it("adds the unpaid bucket only with an unpaid rate or unpaid lines (0032 keys otherwise)", () => {
    const plain = aStd();
    const before = run({ month: "2026-11", rules: [plain], lines: [line({ doctor_id: "doc-a", try_cents: TL(100) })] });
    expect(Object.keys(component(before, plain.id).by_method!).sort()).toEqual(["card", "cash", "financing", "transfer"]);

    const withRate = aUnpaid();
    const empty = run({ month: "2026-11", rules: [withRate], lines: [] });
    expect(component(empty, withRate.id).by_method!.unpaid).toEqual({
      gross: 0,
      implant: 0,
      lab: 0,
      eligible: 0,
      deduct_bp: 1100,
      deduction: 0,
    });

    // An unpaid line under a rule without an unpaid rate: bucket with 0 % (an ortho rule never has one).
    const noRate = run({
      month: "2026-11",
      rules: [plain],
      lines: [line({ doctor_id: "doc-a", method: "unpaid", try_cents: TL(1_000) })],
    });
    expect(component(noRate, plain.id).by_method!.unpaid).toMatchObject({ gross: TL(1_000), deduct_bp: 0, deduction: 0 });
    expect(component(noRate, plain.id).amount_cents).toBe(TL(250));
  });

  it("applies the lab costs after the unpaid deduction too", () => {
    const r = aUnpaid();
    const out = run({
      month: "2026-11",
      rules: [r],
      lines: [line({ doctor_id: "doc-a", method: "unpaid", try_cents: TL(10_000) })],
      lab_costs: [lab({ doctor_id: "doc-a", patient_ref: "hasta 1", day: "2026-11-03", amount_cents: TL(1_900), lab_name: "Lab X" })],
    });
    // 10.000 − 11 % = 8.900 − lab 1.900 = 7.000 → 25 % = 1.750
    expect(component(out, r.id)).toMatchObject({ base_cents: TL(7_000), amount_cents: TL(1_750), lab_cents: TL(1_900) });
  });
});

describe("lines without a doctor (v2)", () => {
  it("count only in the clinic ciro, never unruled", () => {
    const a = aStd();
    const mgmt = rule({ kind: "clinic_ciro_share", payee_user_id: "u-c", share_bp: 300 });
    const clinicLine = line({ doctor_id: null, method: "card", try_cents: TL(5_000), implant_cents: TL(5_000) });
    const outsideLine = line({ doctor_id: null, method: "unpaid", try_cents: TL(2_100), patient_ref: "macro:7" });
    const out = run({
      month: "2026-11",
      rules: [a, mgmt],
      lines: [line({ doctor_id: "doc-a", try_cents: TL(3_000) }), clinicLine, outsideLine],
      marks: [{ patient_ref: "macro:7", own_doctor_id: null, is_child: true }],
    });
    expect(out.warnings).toEqual([]);
    expect(out.clinic_total_cents).toBe(TL(10_100));
    expect(component(out, mgmt.id)).toMatchObject({ base_cents: TL(10_100), amount_cents: TL(303), lines_count: 3 });
    expect(component(out, a.id)).toMatchObject({ base_cents: TL(3_000), lines_count: 1 });
    expect(out.line_results.filter((x) => x.rule_id === null)).toEqual([
      { id: clinicLine.id, segment: "standard", rule_id: null, lab_part: 0 },
      { id: outsideLine.id, segment: "child", rule_id: null, lab_part: 0 },
    ]);
  });
});

describe("marks of Macro patient keys (v2)", () => {
  const aChild = () =>
    rule({ kind: "ciro_share", payee_user_id: "u-a", doctor_id: "doc-a", segment: "child", share_bp: 3200 });
  const marks: HkComputeMark[] = [
    // Exact Macro-key mark (no child) next to a name mark (child): the exact one wins.
    { patient_ref: "macro:11", own_doctor_id: null, is_child: false },
    { patient_ref: "hasta on bir", own_doctor_id: null, is_child: true },
    // A bare file number (reception "Hasta no") comes before the name.
    { patient_ref: "12", own_doctor_id: null, is_child: true },
    { patient_ref: "hasta on iki", own_doctor_id: null, is_child: false },
    // Only a name mark.
    { patient_ref: "hasta on üç", own_doctor_id: null, is_child: true },
    // A typed key of a manual line takes no name mark.
    { patient_ref: "hasta on beş", own_doctor_id: null, is_child: true },
  ];

  it("gives a Macro key the mark of its key, else of its bare file number, else of its patient's name", () => {
    const std = aStd();
    const child = aChild();
    const t = TL(1_000);
    const rows = {
      exact: line({ doctor_id: "doc-a", patient_ref: "macro:11", patient_name: "Hasta On Bir", try_cents: t }),
      byNo: line({ doctor_id: "doc-a", patient_ref: "macro:12", patient_name: "Hasta On İki", try_cents: t }),
      byName: line({ doctor_id: "doc-a", patient_ref: "macro:13", patient_name: "HASTA  On Üç", try_cents: t }),
      none: line({ doctor_id: "doc-a", patient_ref: "macro:14", patient_name: "Hasta On Dört", try_cents: t }),
      typed: line({ doctor_id: "doc-a", patient_ref: "X-15", patient_name: "Hasta On Beş", try_cents: t }),
      named: line({ doctor_id: "doc-a", patient_ref: "hasta on beş", patient_name: "Hasta On Beş", try_cents: t }),
    };
    const out = run({ month: "2026-11", rules: [std, child], lines: Object.values(rows), marks });
    const seg = (l: HkComputeLine) => out.line_results.find((r) => r.id === l.id)!.segment;
    expect(seg(rows.exact)).toBe("standard");
    expect(seg(rows.byNo)).toBe("child");
    expect(seg(rows.byName)).toBe("child");
    expect(seg(rows.none)).toBe("standard");
    // Manual keys as before: their own mark only.
    expect(seg(rows.typed)).toBe("standard");
    expect(seg(rows.named)).toBe("child");
    expect(component(out, child.id)).toMatchObject({ lines_count: 3, base_cents: TL(3_000) });
    expect(component(out, std.id)).toMatchObject({ lines_count: 3 });
  });

  it("resolves a lab cost with a Macro key the same way (fin__hk_eval_lab_costs)", () => {
    const std = aStd();
    const child = aChild();
    const out = run({
      month: "2026-11",
      rules: [std, child],
      lines: [line({ doctor_id: "doc-a", patient_ref: "macro:13", patient_name: "Hasta On Üç", try_cents: TL(1_000) })],
      marks,
      lab_costs: [
        lab({ doctor_id: "doc-a", patient_ref: "macro:13", patient_name: "hasta on üç", day: "2026-11-04", amount_cents: TL(300), lab_name: "Lab X" }),
      ],
    });
    expect(component(out, child.id)).toMatchObject({ lab_cents: TL(300), base_cents: TL(700) });
    expect(out.lab_results.map((r) => r.segment)).toEqual(["child"]);
  });

  it("markFor mirrors the lookup order", () => {
    const byRef = new Map(marks.map((m) => [m.patient_ref, m]));
    expect(HK_MACRO_REF_PREFIX).toBe("macro:");
    expect(markFor(byRef, { patient_ref: "macro:11", patient_name: "Hasta On Bir" })).toBe(marks[0]);
    expect(markFor(byRef, { patient_ref: "macro:12", patient_name: "Hasta On İki" })).toBe(marks[2]);
    expect(markFor(byRef, { patient_ref: "macro:13", patient_name: " hasta  ON ÜÇ " })).toBe(marks[4]);
    expect(markFor(byRef, { patient_ref: "macro:14" })).toBeUndefined();
    expect(markFor(byRef, { patient_ref: "X-15", patient_name: "Hasta On Beş" })).toBeUndefined();
  });
});

describe("procedure pieces (v2)", () => {
  const sCek = () =>
    rule({ kind: "procedure_piece", payee_user_id: "u-s", doctor_id: "doc-s", proc_group_id: "g-cek", piece_cents: TL(430) });
  const sKist = () =>
    rule({ kind: "procedure_piece", payee_user_id: "u-s", doctor_id: "doc-s", proc_group_id: "g-kist", piece_cents: TL(1_250) });

  it("pays piece_cents × Σ qty of the doctor's live pieces of the group in the month", () => {
    const cek = sCek();
    const kist = sKist();
    const out = run({
      month: "2026-11",
      rules: [cek, kist],
      lines: [],
      proc_groups: GROUPS,
      pieces: [
        piece({ doctor_id: "doc-s", qty: 1, proc_group_id: "g-cek", source: "import" }),
        piece({ doctor_id: "doc-s", qty: 1, proc_group_id: "g-cek", source: "import" }),
        piece({ doctor_id: "doc-s", qty: 1, proc_group_id: "g-cek", source: "import", voided_at: "2026-11-20T08:00:00Z" }),
        piece({ doctor_id: "doc-s", qty: 1, proc_group_id: "g-cek", source: "import", day: "2026-12-01" }),
        piece({ doctor_id: "doc-a", qty: 1, proc_group_id: "g-cek", source: "import" }),
        piece({ doctor_id: "doc-s", qty: 1, proc_group_id: "g-kist", source: "import" }),
      ],
    });
    expect(component(out, cek.id)).toEqual({
      rule_id: cek.id,
      kind: "procedure_piece",
      doctor_id: "doc-s",
      doctor_name: "Hekim S",
      segment: null,
      share_bp: null,
      piece_cents: TL(430),
      by_method: null,
      base_cents: null,
      amount_cents: TL(860),
      qty: 2,
      lines_count: 2,
      proc_group_id: "g-cek",
      proc_group_name: "Çekim grubu",
    });
    expect(component(out, kist.id)).toMatchObject({ qty: 1, amount_cents: TL(1_250) });
    expect(payeeTotal(out, "u-s")).toBe(TL(2_110));
    // Hekim A's extraction is an ordinary treatment: no warning.
    expect(out.warnings).toEqual([]);
    const s = summarizePayee(out.payees[0]);
    expect(s).toMatchObject({ procedure_qty: 3, procedure_amount_cents: TL(2_110), implant_qty: 0, share_cents: 0, base_cents: 0 });
    expect(componentTitle(component(out, cek.id))).toBe("İşlem başı ücret · Çekim grubu · Hekim S");
  });

  it("lets implant_piece count implant-group and ungrouped pieces, never pieces of other groups", () => {
    const imp = rule({ kind: "implant_piece", payee_user_id: "u-a", doctor_id: "doc-a", piece_cents: TL(900) });
    const out = run({
      month: "2026-11",
      rules: [imp],
      lines: [],
      proc_groups: GROUPS,
      pieces: [
        piece({ doctor_id: "doc-a", qty: 2, proc_group_id: "g-imp", source: "import" }),
        piece({ doctor_id: "doc-a", qty: 1 }),
        piece({ doctor_id: "doc-a", qty: 1, source: "clinical" }),
        piece({ doctor_id: "doc-a", qty: 1, proc_group_id: "g-cek", source: "import" }),
      ],
    });
    expect(component(out, imp.id)).toMatchObject({ qty: 4, lines_count: 3, amount_cents: TL(3_600), base_cents: 0 });
    expect(out.warnings).toEqual([]);
    // SQL coalesce(g.is_implant, true): a piece without a group is implant type whatever its source (the import never
    // stores one).
    const ungrouped = run({
      month: "2026-11",
      rules: [imp],
      lines: [],
      proc_groups: GROUPS,
      pieces: [piece({ doctor_id: "doc-a", qty: 1, source: "import" })],
    });
    expect(component(ungrouped, imp.id)).toMatchObject({ qty: 1, amount_cents: TL(900) });
  });

  it("warns about implant pieces no rule takes, only those", () => {
    const sImp = rule({ kind: "procedure_piece", payee_user_id: "u-s", doctor_id: "doc-s", proc_group_id: "g-imp", piece_cents: TL(1_100) });
    const out = run({
      month: "2026-11",
      rules: [sImp],
      lines: [],
      proc_groups: GROUPS,
      pieces: [
        // Taken by the procedure_piece rule of the implant group.
        piece({ doctor_id: "doc-s", qty: 2, proc_group_id: "g-imp", source: "import" }),
        // A legacy implant piece of the same doctor: no implant_piece rule → unruled.
        piece({ doctor_id: "doc-s", qty: 1 }),
        // Implant pieces of a doctor without rules → unruled; the extraction is not.
        piece({ doctor_id: "doc-e", qty: 3, proc_group_id: "g-imp", source: "import" }),
        piece({ doctor_id: "doc-e", qty: 1, proc_group_id: "g-cek", source: "import" }),
      ],
    });
    expect(component(out, sImp.id)).toMatchObject({ qty: 2, amount_cents: TL(2_200) });
    expect(out.warnings).toEqual([
      { code: "UNRULED_PIECES", doctor_id: "doc-e", doctor_name: "Hekim E", qty: 3 },
      { code: "UNRULED_PIECES", doctor_id: "doc-s", doctor_name: "Hekim S", qty: 1 },
    ]);
  });

  it("reports the clinic's pieces still waiting for the performing doctor, last", () => {
    const out = run({
      month: "2026-11",
      rules: [sCek()],
      lines: [line({ doctor_id: "doc-d", try_cents: TL(100) })],
      proc_groups: GROUPS,
      pieces: [
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-kist", source: "import" }),
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-cek", source: "import" }),
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-cek", source: "import" }),
        // Marked "Hakediş yok", without a group, voided, or in another month: not waiting.
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-cek", source: "import", assigned_none: true }),
        piece({ doctor_id: null, qty: 1, source: "import" }),
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-imp", source: "import", voided_at: "2026-11-21T08:00:00Z" }),
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-imp", source: "import", day: "2026-10-31" }),
      ],
    });
    expect(out.warnings).toEqual([
      { code: "UNRULED_LINES", doctor_id: "doc-d", doctor_name: "Hekim D", count: 1, try_cents: TL(100) },
      {
        code: "UNASSIGNED_PIECES",
        count: 3,
        groups: [
          { proc_group_id: "g-cek", name: "Çekim grubu", count: 2 },
          { proc_group_id: "g-kist", name: "Kist grubu", count: 1 },
        ],
      },
    ]);
    // Counted for nobody: Hekim S's extraction rule has no pieces.
    expect(out.payees[0].components[0]).toMatchObject({ kind: "procedure_piece", qty: 0, amount_cents: 0 });
    expect(warningText(out.warnings[1])).toBe(
      "Klinik adına aktarılan 3 işlem için işlemi yapan hekim seçilmedi (Çekim grubu 2, Kist grubu 1); seçilene kadar hakedişe dahil edilmez."
    );
  });

  it("orders procedure_piece components after implant_piece and before the management share", () => {
    const imp = rule({ kind: "implant_piece", payee_user_id: "u-s", doctor_id: "doc-s", piece_cents: TL(900) });
    const mgmt = rule({ kind: "clinic_ciro_share", payee_user_id: "u-s", share_bp: 100 });
    const cek = sCek();
    const out = run({ month: "2026-11", rules: [mgmt, cek, imp], lines: [], proc_groups: GROUPS });
    expect(out.payees[0].components.map((c) => c.kind)).toEqual(["implant_piece", "procedure_piece", "clinic_ciro_share"]);
  });

  it("ranks procedure_piece with implant_piece: by doctor, then the implant rule, then by group name (SQL)", () => {
    // One payee with rules for two doctors (made-up data the SQL orders the same way): Hekim A's procedure rules come
    // before Hekim S's implant rule; each doctor's groups in Turkish name order, whatever the ids.
    const sImp = rule({ kind: "implant_piece", payee_user_id: "u-s", doctor_id: "doc-s", piece_cents: TL(900) });
    const aKist = rule({ kind: "procedure_piece", payee_user_id: "u-s", doctor_id: "doc-a", proc_group_id: "g-kist", piece_cents: TL(10) });
    const aCek = rule({ kind: "procedure_piece", payee_user_id: "u-s", doctor_id: "doc-a", proc_group_id: "g-cek", piece_cents: TL(10) });
    const sCekRule = rule({ kind: "procedure_piece", payee_user_id: "u-s", doctor_id: "doc-s", proc_group_id: "g-cek", piece_cents: TL(10) });
    const out = run({ month: "2026-11", rules: [sCekRule, aKist, sImp, aCek], lines: [], proc_groups: GROUPS });
    expect(out.payees[0].components.map((c) => c.rule_id)).toEqual([aCek.id, aKist.id, sImp.id, sCekRule.id]);
  });

  it("keeps a waiting group whose pieces net to zero in UNASSIGNED_PIECES (SQL)", () => {
    const out = run({
      month: "2026-11",
      rules: [],
      lines: [],
      proc_groups: GROUPS,
      pieces: [
        piece({ doctor_id: null, qty: 1, proc_group_id: "g-cek", source: "import" }),
        piece({ doctor_id: null, qty: -1, proc_group_id: "g-cek", source: "import" }),
      ],
    });
    expect(out.warnings).toEqual([
      { code: "UNASSIGNED_PIECES", count: 0, groups: [{ proc_group_id: "g-cek", name: "Çekim grubu", count: 0 }] },
    ]);
  });
});

describe("rules (v2)", () => {
  const base: HkRuleInput = {
    payee_user_id: "u-s",
    doctor_id: "doc-s",
    kind: "procedure_piece",
    segment: null,
    share_bp: null,
    piece_cents: TL(430),
    deduct_cash_bp: 0,
    deduct_card_bp: 0,
    deduct_transfer_bp: 0,
    deduct_financing_bp: 0,
    proc_group_id: "g-cek",
    from_month: "2026-11",
    to_month: null,
  };

  it("labels and fields", () => {
    expect(HK_KINDS.indexOf("procedure_piece")).toBe(HK_KINDS.indexOf("implant_piece") + 1);
    expect(KIND_LABELS.procedure_piece).toBe("İşlem başı ücret");
    expect(pieceFieldLabel("procedure_piece")).toBe("İşlem başı tutar (TL)");
    expect(RULE_FIELDS.procedure_piece).toEqual({
      doctor: true,
      segment: false,
      share: false,
      piece: true,
      deductions: false,
      unpaid: false,
      group: true,
    });
    expect(RULE_FIELDS.ciro_share).toMatchObject({ deductions: true, unpaid: true, group: false });
    expect(RULE_FIELDS.ortho_lab_first).toMatchObject({ deductions: true, unpaid: false });
    expect(HK_LINE_METHODS).toEqual(["cash", "card", "transfer", "financing", "unpaid"]);
    expect(METHOD_LABELS.unpaid).toBe("Ödenmemiş");
    expect(DEDUCT_LABELS.unpaid).toBe("Ödenmemiş (ay sonu)");
    expect(DEDUCT_LABELS.card).toBe(METHOD_LABELS.card);
    expect(ruleDeductBp({ deduct_cash_bp: 0, deduct_card_bp: 1100, deduct_transfer_bp: 0, deduct_financing_bp: 0 }, "unpaid")).toBe(0);
    expect(
      ruleDeductBp({ deduct_cash_bp: 0, deduct_card_bp: 0, deduct_transfer_bp: 0, deduct_financing_bp: 0, deduct_unpaid_bp: 900 }, "unpaid")
    ).toBe(900);
  });

  it("validates procedure_piece rules and the unpaid deduction", () => {
    expect(validateRule(base)).toBeNull();
    expect(validateRule({ ...base, proc_group_id: null })).toBe("İşlem grubunu seçin.");
    expect(validateRule({ ...base, doctor_id: null })).toBe("Hekimi seçin.");
    expect(validateRule({ ...base, piece_cents: 0 })).toBe("İşlem başı tutar 0'dan büyük olmalı.");
    expect(validateRule({ ...base, deduct_unpaid_bp: 1100 })).toBe("Bu kural türünde kesinti girilemez.");
    const ciro: HkRuleInput = {
      ...base,
      kind: "ciro_share",
      segment: "standard",
      share_bp: 2500,
      piece_cents: null,
      proc_group_id: null,
      deduct_card_bp: 1100,
    };
    expect(validateRule({ ...ciro, deduct_unpaid_bp: 1100 })).toBeNull();
    expect(validateRule({ ...ciro, deduct_unpaid_bp: undefined })).toBeNull();
    expect(validateRule({ ...ciro, deduct_unpaid_bp: 10001 })).toBe("Kesinti oranı %0 ile %100 arasında olmalı.");
    expect(validateRule({ ...ciro, proc_group_id: "g-cek" })).toBe("İşlem grubu yalnızca işlem başı ücret kuralında seçilir.");
    expect(validateRule({ ...ciro, kind: "ortho_lab_first", segment: null, deduct_unpaid_bp: 500 })).toBe(
      "Bu kural türünde kesinti girilemez."
    );
  });

  it("checks overlaps per doctor and group, and implant pieces counted twice", () => {
    const saved = [
      { ...base, id: "r-cek" },
      { ...base, id: "r-imp-proc", proc_group_id: "g-imp" },
      { ...base, id: "r-implant", kind: "implant_piece" as const, proc_group_id: null, doctor_id: "doc-a", payee_user_id: "u-a" },
    ];
    expect(ruleOverlapKey(base)).toBe("procedure_piece|doc-s|g-cek");
    expect(findOverlappingRule(saved, { ...base, id: "new" })?.id).toBe("r-cek");
    expect(findOverlappingRule(saved, { ...base, id: "new", proc_group_id: "g-kist" })).toBeUndefined();

    // An implant_piece rule of Hekim S clashes with S's procedure_piece rule of the implant group, not the extraction one.
    const implantS: HkRuleInput = { ...base, kind: "implant_piece", proc_group_id: null };
    expect(findImplantPieceConflict(saved, implantS, GROUPS)?.id).toBe("r-imp-proc");
    expect(findImplantPieceConflict(saved, { ...implantS, from_month: "2026-01", to_month: "2026-10" }, GROUPS)).toBeUndefined();
    // A procedure_piece rule of the implant group for Hekim A clashes with A's implant_piece rule.
    expect(findImplantPieceConflict(saved, { ...base, doctor_id: "doc-a", proc_group_id: "g-imp" }, GROUPS)?.id).toBe("r-implant");
    expect(findImplantPieceConflict(saved, { ...base, doctor_id: "doc-a", proc_group_id: "g-cek" }, GROUPS)).toBeUndefined();
  });
});

describe("procedure groups and Macro doctors (v2)", () => {
  const groups = [
    { id: "g-1", name: "Çekim grubu", is_active: true, op_names: ["diş çekimi", "gömülü diş çekimi"] },
    { id: "g-2", name: "Eski grup", is_active: false, op_names: ["kist operasyonu"] },
  ];

  it("normalizes and validates groups", () => {
    expect(normalizeOpNames(["  DİŞ  ÇEKİMİ ", "diş çekimi", "", "Kist"])).toEqual(["diş çekimi", "kist"]);
    expect(validateProcGroup({ name: "Kist grubu", op_names: ["Kist Operasyonu (Büyük)"] }, groups)).toBeNull();
    expect(validateProcGroup({ name: " ", op_names: [] }, groups)).toBe("Grup adını girin.");
    expect(validateProcGroup({ name: "x".repeat(81), op_names: [] }, groups)).toBe("Grup adı en fazla 80 karakter olabilir.");
    expect(validateProcGroup({ name: "ÇEKİM GRUBU", op_names: [] }, groups)).toBe("Bu adla başka bir işlem grubu var.");
    expect(validateProcGroup({ id: "g-1", name: "Çekim grubu", op_names: ["Diş Çekimi"] }, groups)).toBeNull();
    expect(validateProcGroup({ name: "Yeni", op_names: ["KİST OPERASYONU"] }, groups)).toBe(
      "“kist operasyonu” işlemi zaten “Eski grup” grubunda."
    );
    expect(validateProcGroup({ name: "Yeni", op_names: ["a".repeat(201)] }, groups)).toBe("İşlem adı en fazla 200 karakter olabilir.");
  });

  it("finds the group of an operation and the mapping of a Macro doctor", () => {
    expect(procGroupOfOperation(groups, "Gömülü  DİŞ Çekimi")?.id).toBe("g-1");
    expect(procGroupOfOperation(groups, "Kist operasyonu")).toBeUndefined(); // inactive group
    expect(procGroupOfOperation(groups, "")).toBeUndefined();
    const mapping = [{ ext_name: "klinik örnek", mode: "clinic" as const }];
    expect(extDoctorOf(mapping, "KLİNİK  ÖRNEK")?.mode).toBe("clinic");
    expect(extDoctorOf(mapping, "Hekim A")).toBeUndefined();
    expect(EXT_DOCTOR_MODE_LABELS).toEqual({
      doctor: "DentOS hekimi",
      clinic: "Klinik",
      outside: "Dışarıdan hekim (hakediş yok)",
      ignore: "Yok say",
    });
    expect(validateExtDoctor({ ext_name: "Hekim A", mode: "doctor", doctor_id: "doc-a" })).toBeNull();
    expect(validateExtDoctor({ ext_name: "Hekim A", mode: "doctor", doctor_id: null })).toBe("DentOS hekimini seçin.");
    expect(validateExtDoctor({ ext_name: "Hekim A", mode: "clinic", doctor_id: "doc-a" })).toBe(
      "Hekim yalnızca “DentOS hekimi” seçeneğinde seçilir."
    );
    expect(validateExtDoctor({ ext_name: " ", mode: "ignore", doctor_id: null })).toBe("Macro hekim adı boş olamaz.");
    expect(validateExtDoctor({ ext_name: "Hekim A", mode: null, doctor_id: null })).toBe("Eşleştirme türünü seçin.");
  });
});

describe("RPC wrappers (v2)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { already_saved: false, record: {} }, error: null });
  });

  it("sends the import, group, mapping and assignment arguments by name", async () => {
    const args = {
      p_batch_id: "b-1",
      p_from: "2026-11-01",
      p_to: "2026-11-30",
      p_lines: [],
      p_pieces: [],
      p_files: ["islem.xls", "odeme.xls"],
    };
    await finHkImportMacro(args);
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_import_macro", { ...args, p_dry_run: false });
    await finHkImportMacro({ ...args, p_dry_run: true });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_import_macro", { ...args, p_dry_run: true });

    const group = {
      p_id: "g-1",
      p_version: 0,
      p_name: "Çekim grubu",
      p_is_implant: false,
      p_op_names: ["Diş Çekimi"],
      p_is_active: true,
      p_note: "",
    };
    await finHkSaveProcGroup(group);
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_proc_group", group);

    const ext = { p_id: "x-1", p_version: 0, p_ext_name: "KLİNİK ÖRNEK", p_mode: "clinic" as const, p_doctor_id: null };
    await finHkSaveExtDoctor(ext);
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_ext_doctor", ext);

    await finHkAssignPiece({ p_id: "p-1", p_version: 2, p_doctor_id: "doc-s", p_none: false });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_assign_piece", { p_id: "p-1", p_version: 2, p_doctor_id: "doc-s", p_none: false });
  });

  it("saves a procedure_piece rule with its group and a ciro rule with its unpaid rate", async () => {
    const args = {
      p_id: "r-3",
      p_version: 0,
      p_payee_user_id: "u-s",
      p_doctor_id: "doc-s",
      p_kind: "procedure_piece" as const,
      p_segment: null,
      p_share_bp: null,
      p_piece_cents: TL(430),
      p_deduct_cash_bp: 0,
      p_deduct_card_bp: 0,
      p_deduct_transfer_bp: 0,
      p_deduct_financing_bp: 0,
      p_from_month: "2026-11-01",
      p_to_month: null,
      p_note: "",
      p_proc_group_id: "g-cek",
    };
    await finHkSaveRule(args);
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_rule", { ...args, p_deduct_unpaid_bp: 0 });
    await finHkSaveRule({ ...args, p_kind: "ciro_share", p_proc_group_id: null, p_deduct_unpaid_bp: 1100 });
    expect(rpcMock).toHaveBeenLastCalledWith("fin_hk_save_rule", {
      ...args,
      p_kind: "ciro_share",
      p_proc_group_id: null,
      p_deduct_unpaid_bp: 1100,
    });
  });
});

describe("Macro import helpers (v2)", () => {
  it("reads the refusal details of fin_hk_import_macro", () => {
    expect(importRefusalOf({ details: JSON.stringify({ unmapped_ext_doctors: ["DR ÖRNEK", "KLİNİK X"] }) })).toEqual({
      unmapped_ext_doctors: ["DR ÖRNEK", "KLİNİK X"],
    });
    expect(importRefusalOf({ details: JSON.stringify({ missing_fx: [{ currency: "EUR", day: "2026-11-03" }] }) })).toEqual({
      missing_fx: [{ currency: "EUR", day: "2026-11-03" }],
    });
    // Other errors: a rule id in DETAIL, no details, broken JSON, an unrelated object.
    expect(importRefusalOf({ details: "0b6c3c8e-1d2f-4a8b-9c1d-2e3f4a5b6c7d" })).toBeNull();
    expect(importRefusalOf({ details: null })).toBeNull();
    expect(importRefusalOf(null)).toBeNull();
    expect(importRefusalOf({ details: "{oops" })).toBeNull();
    expect(importRefusalOf({ details: "{}" })).toBeNull();
  });

  it("moves an operation name between groups (out of its holder, then into the target)", () => {
    const groups = [
      { id: "g-1", op_names: ["diş çekimi", "kanal"] },
      { id: "g-2", op_names: ["kist"] },
      { id: "g-3", op_names: [] as string[] },
    ];
    expect(opNameMoves(groups, "Diş  ÇEKİMİ", "g-2")).toEqual([
      { group: groups[0], op_names: ["kanal"] },
      { group: groups[1], op_names: ["kist", "diş çekimi"] },
    ]);
    expect(opNameMoves(groups, "Kist", null)).toEqual([{ group: groups[1], op_names: [] }]);
    expect(opNameMoves(groups, "Gömülü", "g-3")).toEqual([{ group: groups[2], op_names: ["gömülü"] }]);
    // Already there, or nothing to do.
    expect(opNameMoves(groups, "KİST", "g-2")).toEqual([]);
    expect(opNameMoves(groups, "Yeni", null)).toEqual([]);
    expect(opNameMoves(groups, "  ", "g-1")).toEqual([]);
  });

  it("checks the group and mapping limits of the server", () => {
    const many = Array.from({ length: 501 }, (_, i) => `işlem ${i}`);
    expect(validateProcGroup({ name: "Grup", op_names: many })).toBe("Bir grupta en fazla 500 işlem adı olabilir.");
    expect(validateProcGroup({ name: "Grup", op_names: ["x".repeat(201)] })).toBe("İşlem adı en fazla 200 karakter olabilir.");
    expect(validateProcGroup({ name: "  Çekim   grubu ", op_names: [] }, [{ id: "g-9", name: "çekim grubu", op_names: [] }])).toBe(
      "Bu adla başka bir işlem grubu var."
    );
    expect(validateExtDoctor({ ext_name: "x".repeat(121), mode: "clinic", doctor_id: null })).toBe(
      "Macro hekim adı en fazla 120 karakter olabilir."
    );
    expect(validateExtDoctor({ ext_name: "Dr Örnek", mode: "doctor", doctor_id: "doc-a" })).toBeNull();
  });
});
