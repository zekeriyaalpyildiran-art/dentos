import { describe, expect, it } from "vitest";
import type { DebtSuggestionJson, DebtSuggestionRowJson, OpenDebtJson } from "../../finance";
import {
  amountPatch,
  applySuggestions,
  chooseMatch,
  closesRemainder,
  debtKind,
  isMatchEligible,
  matchFromCandidate,
  matchTargetsError,
  matchedDebts,
  overpaysMatch,
  preselections,
  releaseAutoMatches,
  rowOpenDebts,
  suggestionCalls,
  type MatchState,
} from "../matching";

// Made-up debts and amounts only.
const cand = (id: string, p: Partial<Omit<DebtSuggestionJson, "entry">> & { outstanding?: number; due?: string } = {}): DebtSuggestionJson => {
  const { outstanding = 320000, due = "2026-10-10", ...rest } = p;
  return {
    suggested: false,
    score: 0,
    reason: "Tutar aynı · vade günü",
    kind: "exact",
    strong: false,
    days: 0,
    remainder_cents: 0,
    excess_cents: 0,
    entry: {
      id,
      version: 1,
      counterparty_name: `Örnek Kurum ${id}`,
      description: "",
      category_name: "Laboratuvar",
      report_bucket: "lab",
      due_date: due,
      amount_cents: outstanding,
      outstanding_cents: outstanding,
      excluded_from_totals: false,
    },
    ...rest,
  };
};
const answer = (p: Partial<DebtSuggestionRowJson>): DebtSuggestionRowJson => ({
  row_no: 1,
  preselect_entry_id: null,
  strong_count: (p.candidates ?? []).filter((c) => c.strong).length,
  total_count: p.candidates?.length ?? 0,
  candidates: [],
  higher: null,
  ...p,
});
const state = (key: string, p: Partial<MatchState> = {}): MatchState => ({
  key,
  amount: 315000,
  match: null,
  matchChosen: false,
  closeRemainder: false,
  ackOpenDebt: false,
  ...p,
});
/** A review row for rowOpenDebts: a bank outflow by default. */
const outflow = (key: string, p: Partial<MatchState> & { date?: string; signedCents?: number } = {}) => {
  const { date = "2026-10-10", signedCents, ...rest } = p;
  const s = state(key, rest);
  return { ...s, date, signedCents: signedCents ?? -s.amount };
};
const ids = () => {
  let n = 0;
  return () => `pay-${++n}`;
};
const none = matchedDebts([]);

describe("eligibility and the amount rule (0037)", () => {
  it("bank outflows and clinic workbook expense rows; never receipts, inflows or saved rows", () => {
    expect(isMatchEligible({ key: "bank:x", signedCents: -1 }, "out", false)).toBe(true);
    expect(isMatchEligible({ key: "bank-table:abc", signedCents: -1 }, "out", false)).toBe(true);
    expect(isMatchEligible({ key: "clinic:2026-10-05:expense:3", signedCents: -1 }, "out", false)).toBe(true);
    expect(isMatchEligible({ key: "clinic:2026-10-05:receipts", signedCents: -1 }, "out", false)).toBe(false);
    expect(isMatchEligible({ key: "clinic:2026-10-05:expense:0", signedCents: -1 }, "out", false)).toBe(false);
    expect(isMatchEligible({ key: "clinic:x", signedCents: -1 }, "out", false)).toBe(false);
    expect(isMatchEligible({ key: "bank:x", signedCents: 1 }, "out", false)).toBe(false);
    expect(isMatchEligible({ key: "bank-table:x", signedCents: -1 }, "in", false)).toBe(false);
    expect(isMatchEligible({ key: "clinic:2026-10-05:expense:3", signedCents: -1 }, "out", true)).toBe(false);
    expect(matchTargetsError(["a", null, "b"])).toBe(null);
    expect(matchTargetsError(["a", "a"])).toMatch(/Aynı borca/);
  });
  it("exact / near / partial / higher at the 2 % and 1.000 TL boundaries (fin__debt_kind)", () => {
    expect(debtKind(10000, 10000)).toBe("exact");
    expect(debtKind(9800, 10000)).toBe("near"); // 2 % of 100 TL
    expect(debtKind(9799, 10000)).toBe("partial");
    expect(debtKind(10200, 10000)).toBe("higher");
    expect(debtKind(10201, 10000)).toBe(null);
    expect(debtKind(9_900_000, 10_000_000)).toBe("near"); // 1.000 TL cap below 2 %
    expect(debtKind(9_899_999, 10_000_000)).toBe("partial");
    expect(debtKind(10_100_000, 10_000_000)).toBe("higher");
    expect(debtKind(10_100_001, 10_000_000)).toBe(null);
    expect(debtKind(0, 10000)).toBe(null);
    expect(debtKind(10000, 0)).toBe(null);
    expect(debtKind(Number.NaN, 10000)).toBe(null);
  });
});

describe("the row's match state", () => {
  it("a pick sets the remainder default by kind; the new-entry option is a decision too", () => {
    const next = ids();
    const near = chooseMatch({ amount: 315000, match: null }, cand("d1", { outstanding: 320000 }), next);
    expect(near).toMatchObject({ matchChosen: true, closeRemainder: true, match: { entry_id: "d1", payment_id: "pay-1", outstanding_cents: 320000 } });
    expect(chooseMatch({ amount: 100000, match: null }, cand("d2", { outstanding: 320000 }), next).closeRemainder).toBe(false);
    expect(chooseMatch({ amount: 320000, match: null }, cand("d3"), next).closeRemainder).toBe(false);
    expect(chooseMatch({ amount: 315000, match: near.match }, cand("d1"), next).match?.payment_id).toBe("pay-1");
    expect(chooseMatch({ amount: 315000, match: near.match }, null, next)).toEqual({ match: null, matchChosen: true, closeRemainder: false });
  });
  it("an amount edit puts 'Kalan … borcu kapat' back to its default and asks for the confirmation again", () => {
    // A hand-picked near match (box on) corrected to a large partial payment: the box goes off, the rest stays open.
    const picked = chooseMatch({ amount: 4_975_000, match: null }, cand("d1", { outstanding: 5_000_000 }), ids());
    expect(picked.closeRemainder).toBe(true);
    const row = state("a", { amount: 4_975_000, ...picked, ackOpenDebt: true });
    const large = amountPatch(row, 497_500);
    expect(large).toEqual({ amount: 497_500, ackOpenDebt: false, closeRemainder: false });
    expect(closesRemainder({ ...row, ...large })).toBe(false);
    // A near-to-near correction keeps it on; a box the user turned off for a near payment comes back on.
    expect(amountPatch(row, 4_990_000).closeRemainder).toBe(true);
    const off: MatchState = { ...row, closeRemainder: false };
    expect(amountPatch(off, 4_990_000).closeRemainder).toBe(true);
    // An unmatched row: only the confirmation is reset.
    expect(amountPatch(state("b", { ackOpenDebt: true }), 1000)).toEqual({ amount: 1000, ackOpenDebt: false });
  });
  it("close_remainder only below the outstanding; an overpaid match is flagged", () => {
    const match = matchFromCandidate(cand("d1", { outstanding: 320000 }), "p");
    expect(closesRemainder({ amount: 315000, match, closeRemainder: true })).toBe(true);
    expect(closesRemainder({ amount: 320000, match, closeRemainder: true })).toBe(false);
    expect(closesRemainder({ amount: 315000, match, closeRemainder: false })).toBe(false);
    expect(closesRemainder({ amount: 315000, match: null, closeRemainder: true })).toBe(false);
    expect(overpaysMatch({ amount: 320001, match })).toBe(true);
    expect(overpaysMatch({ amount: 320000, match })).toBe(false);
  });
});

describe("pre-selection from fin_debt_candidates_batch", () => {
  it("undecided rows follow the server; the user's picks and taken debts are kept", () => {
    const next = ids();
    const chosen = matchFromCandidate(cand("d3"), "mine");
    const rows = [
      state("a"),
      state("b", { match: matchFromCandidate(cand("d2"), "old") }),
      state("c", { match: chosen, matchChosen: true }),
      state("d"),
      state("e", { matchChosen: true }),
      state("f"),
    ];
    const answers = new Map([
      ["a", answer({ preselect_entry_id: "d1", candidates: [cand("d1", { kind: "near", strong: true, outstanding: 320000 })] })],
      ["b", answer({ candidates: [cand("d2")] })],
      ["c", answer({ preselect_entry_id: "d9", candidates: [cand("d9", { strong: true })] })],
      ["d", answer({ preselect_entry_id: "d3", candidates: [cand("d3", { strong: true })] })],
      ["e", answer({ preselect_entry_id: "d4", candidates: [cand("d4", { strong: true })] })],
    ]);
    const out = applySuggestions(rows, answers, next);
    expect(out[0].match).toMatchObject({ entry_id: "d1", payment_id: "pay-1", reason: "Tutar aynı · vade günü" });
    expect(out[0].closeRemainder).toBe(true);
    expect(out[1].match).toBe(null); // no pre-selection any more
    expect(out[2]).toBe(rows[2]); // the user's own pick
    expect(out[3].match).toBe(null); // d3 is taken by row c
    expect(out[4]).toBe(rows[4]); // the user chose a new entry
    expect(out[5]).toBe(rows[5]); // no answer
    // A repeated answer keeps the payment id and the remainder choice.
    const again = applySuggestions([{ ...out[0], closeRemainder: false }], answers, next)[0];
    expect([again.match?.payment_id, again.closeRemainder]).toEqual(["pay-1", false]);
  });
  it("pre-selection conflicts across calls follow the SQL rule: the strictly closest row, no one on a tie", () => {
    // Two calls of one refresh each pre-selected debt d1 for their own row (row #10 of the first, #550 of the second).
    const far = answer({ preselect_entry_id: "d1", candidates: [cand("d1", { strong: true, days: 24 })] });
    const near = answer({ preselect_entry_id: "d1", candidates: [cand("d1", { strong: true, days: 1 })] });
    expect(Array.from(preselections(new Map([["r10", far], ["r550", near]])).keys())).toEqual(["r550"]);
    const out = applySuggestions([state("r10"), state("r550")], new Map([["r10", far], ["r550", near]]), ids());
    expect(out.map((r) => r.match?.entry_id ?? null)).toEqual([null, "d1"]);
    // Same distance: exact before near; same distance and kind: nobody.
    const nearKind = answer({ preselect_entry_id: "d1", candidates: [cand("d1", { strong: true, days: 1, kind: "near" })] });
    expect(Array.from(preselections(new Map([["x", nearKind], ["y", near]])).keys())).toEqual(["y"]);
    const tie = applySuggestions([state("x"), state("y")], new Map([["x", near], ["y", { ...near }]]), ids());
    expect(tie.map((r) => r.match)).toEqual([null, null]);
    // Two strong candidates (or none) pre-select nothing, whatever preselect_entry_id says.
    const two = answer({ preselect_entry_id: "d1", candidates: [cand("d1", { strong: true }), cand("d2", { strong: true })] });
    expect(preselections(new Map([["z", two], ["w", answer({ preselect_entry_id: "d3" })]])).size).toBe(0);
  });
  it("rows without an answer drop an automatic match; only the user's own picks reserve a debt", () => {
    const next = ids();
    const auto = matchFromCandidate(cand("d1"), "auto");
    const rows = [
      state("gone", { match: auto }), // pre-selected earlier, now saved / a financing line: no answer
      state("other"),
      state("mine", { match: matchFromCandidate(cand("d2"), "own"), matchChosen: true }), // no answer, kept
      state("new"),
      state("acked", { matchChosen: true, ackOpenDebt: true }), // 'Yine de yeni gider olarak kaydet'
    ];
    const answers = new Map([
      ["other", answer({ preselect_entry_id: "d1", candidates: [cand("d1", { strong: true, days: 3 })] })],
      ["new", answer({ preselect_entry_id: "d2", candidates: [cand("d2", { strong: true })] })],
      ["acked", answer({ preselect_entry_id: "d5", candidates: [cand("d5", { strong: true })] })],
    ]);
    const out = applySuggestions(rows, answers, next);
    expect(out[0]).toMatchObject({ match: null, closeRemainder: false });
    expect(out[1].match).toMatchObject({ entry_id: "d1", payment_id: "pay-1" });
    expect(out[2]).toBe(rows[2]);
    expect(out[3].match).toBe(null); // d2 is the user's pick on 'mine'
    expect(out[4]).toBe(rows[4]); // a confirmed new entry stays one
    // A row saved in this session is decided (ImportWizard sets matchChosen), so a late answer never matches it.
    const saved = state("saved", { matchChosen: true });
    expect(applySuggestions([saved], new Map([["saved", answer({ candidates: [cand("d7", { strong: true })] })]]), next)[0]).toBe(saved);
  });
  it("an exact pre-selection leaves nothing to close; a pick releases the debt from pre-selected rows", () => {
    const [row] = applySuggestions([state("a", { amount: 320000 })], new Map([["a", answer({ preselect_entry_id: "d1", candidates: [cand("d1", { strong: true })] })]]), ids());
    expect([row.match?.entry_id, row.closeRemainder]).toEqual(["d1", false]);
    const rows = [row, state("b", { match: matchFromCandidate(cand("d1"), "x"), matchChosen: true }), state("c", { match: matchFromCandidate(cand("d1"), "y"), matchChosen: true })];
    const out = releaseAutoMatches(rows, "b", "d1");
    expect(out.map((r) => r.match?.entry_id ?? null)).toEqual([null, "d1", "d1"]);
  });
});

const checkedOf = (id: string, outstanding: number): OpenDebtJson => ({
  entry_id: id,
  version: 1,
  counterparty_name: `Örnek Kurum ${id}`,
  category_name: "Laboratuvar",
  due_date: "2026-10-20",
  amount_cents: outstanding,
  outstanding_cents: outstanding,
  kind: "exact",
  days: 0,
});

describe("open debts of a new entry (ack_open_debt)", () => {
  const checked: OpenDebtJson[] = [
    { entry_id: "d2", version: 1, counterparty_name: "Örnek Kurum d2", category_name: "Vergi", due_date: "2026-10-20", amount_cents: 320000, outstanding_cents: 320000, kind: "near", days: 10 },
  ];
  it("the check's debts and the exact / near suggestions within 45 days, minus settled debts, closest first", () => {
    const settled = (...entryIds: string[]) => matchedDebts(entryIds.map((id) => state(id, { amount: 320000, match: matchFromCandidate(cand(id), "p") })));
    const suggestion = answer({
      candidates: [
        cand("d1", { kind: "exact", days: 2 }),
        cand("d2", { kind: "near", days: 10 }),
        cand("d3", { kind: "partial", days: 0 }),
        cand("d4", { kind: "near", days: 46 }),
        cand("d5", { kind: "exact", days: 10 }),
      ],
      higher: cand("d6", { kind: "higher", days: 1, excess_cents: 5000 }),
    });
    expect(rowOpenDebts(outflow("bank:a"), checked, suggestion, none).map((d) => d.entry_id)).toEqual(["d1", "d5", "d2"]);
    expect(rowOpenDebts(outflow("bank:a"), checked, suggestion, settled("d1", "d2")).map((d) => d.entry_id)).toEqual(["d5"]);
    expect(rowOpenDebts(outflow("bank:a"), checked, undefined, none).map((d) => [d.entry_id, d.kind])).toEqual([["d2", "near"]]);
    expect(rowOpenDebts(outflow("bank:a", { match: matchFromCandidate(cand("d1"), "p") }), checked, suggestion, none)).toEqual([]);
    expect(rowOpenDebts(outflow("bank:a"), undefined, answer({ higher: cand("d6", { kind: "higher" }) }), none)).toEqual([]);
  });
  it("only a match that leaves nothing open settles its debt; a partial one leaves the rest (fin__open_debts)", () => {
    // Made-up debt X: 30.000,00 TL open, due 2026-10-20.
    const x = matchFromCandidate(cand("x", { outstanding: 3_000_000, due: "2026-10-20" }), "p");
    const m = (amount: number, closeRemainder = false) => matchedDebts([state("bank:A", { amount, match: x, closeRemainder })]);
    expect(m(3_000_000).settled.has("x")).toBe(true); // paid in full
    expect(m(2_990_000, true).settled.has("x")).toBe(true); // the rest closed
    expect([m(50_000).settled.has("x"), m(50_000).partial.get("x")?.paid]).toEqual([false, 50_000]);
    expect(matchedDebts([state("u", { amount: 50_000 })]).partial.size).toBe(0); // unmatched rows pay nothing
    // Row A pays 500,00 TL on X (partial): row B of 29.500,00 TL is exact for the rest and needs the confirmation; the
    // check's or the suggestion's view of the whole debt (near) is replaced by the rest.
    const b = outflow("bank:B", { amount: 2_950_000, date: "2026-10-22" });
    const whole: OpenDebtJson = { ...checkedOf("x", 3_000_000), kind: "near", days: 2 };
    const sugg = answer({ candidates: [cand("x", { kind: "near", days: 2, outstanding: 3_000_000 })] });
    expect(rowOpenDebts(b, [whole], sugg, m(50_000))).toEqual([
      { ...whole, outstanding_cents: 2_950_000, kind: "exact", days: 2 },
    ]);
    expect(rowOpenDebts(b, [whole], sugg, m(3_000_000))).toEqual([]);
    expect(rowOpenDebts(b, [whole], sugg, m(2_990_000, true))).toEqual([]);
    // Near the rest (and near the whole before the payment); near the whole but above the rest: no warning, as the
    // server ('higher' is never a confirmation).
    expect(rowOpenDebts({ ...b, amount: 2_940_000 }, undefined, undefined, m(50_000)).map((d) => [d.kind, d.outstanding_cents])).toEqual([["near", 2_950_000]]);
    expect(rowOpenDebts({ ...b, amount: 2_980_000 }, [whole], sugg, m(50_000))).toEqual([]);
    // Workbook expense rows count; inflows, daily receipts and rows over 45 days from the due date do not.
    expect(rowOpenDebts(outflow("clinic:2026-10-22:expense:1", { amount: 2_950_000 }), undefined, undefined, m(50_000))).toHaveLength(1);
    expect(rowOpenDebts({ ...b, signedCents: 2_950_000 }, undefined, undefined, m(50_000))).toEqual([]);
    expect(rowOpenDebts({ ...b, key: "clinic:2026-10-22:receipts" }, undefined, undefined, m(50_000))).toEqual([]);
    expect(rowOpenDebts({ ...b, date: "2026-12-05" }, undefined, undefined, m(50_000))).toEqual([]);
    expect(rowOpenDebts({ ...b, date: "2026-12-04" }, undefined, undefined, m(50_000))).toHaveLength(1);
  });
});

describe("suggestion requests", () => {
  it("chunks of the call limit, row numbers per call, narration only when given", () => {
    const rows = ["a", "b", "c"].map((key, i) => ({
      key,
      date: "2026-10-0" + (i + 1),
      amount: 100 * (i + 1),
      text: key === "b" ? null : `  EFT ${key.toUpperCase()}  `,
      categoryId: key === "a" ? "cat-lab" : null,
      counterpartyId: null,
    }));
    const calls = suggestionCalls(rows, 2);
    expect(calls.map((c) => c.keys)).toEqual([["a", "b"], ["c"]]);
    expect(calls[0].rows).toEqual([
      { row_no: 1, amount_cents: 100, date: "2026-10-01", text: "EFT A", category_id: "cat-lab", counterparty_id: null },
      { row_no: 2, amount_cents: 200, date: "2026-10-02", text: null, category_id: null, counterparty_id: null },
    ]);
    expect(calls[1].rows[0].row_no).toBe(1);
    expect(suggestionCalls([])).toEqual([]);
  });
});
