// Hakediş engine mirror (spec §1 "Calculation", §2; v1.1 child patients by age). Made-up doctors, patients, rates
// and amounts only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMonths,
  ageOn,
  applyBp,
  bpToInput,
  childAgeLimitOf,
  componentTitle,
  computeMonth,
  finHkSaveMark,
  finHkSaveSettings,
  formatBp,
  HK_DEFAULT_CHILD_AGE_LIMIT,
  hkMarksAccess,
  hkMarksList,
  hkSaveMark,
  markIsChildOn,
  monthKey,
  monthStart,
  monthStatus,
  normalizePatientRef,
  parsePercent,
  pickDefaultMonth,
  resolveSegment,
  roundHalfAwayDiv,
  ruleActiveIn,
  summarizePayee,
  validateBirthDate,
  validateChildAgeLimit,
  validateRule,
  warningText,
  type HkComponentJson,
  type HkComputeInput,
  type HkComputeLabCost,
  type HkComputeLine,
  type HkComputeMark,
  type HkComputeOutput,
  type HkComputePiece,
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
    expect(s.gross_by_method).toEqual({ cash: 0, card: TL(29_000), transfer: 0, financing: 0 });
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
