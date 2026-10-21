// Finance import: settling open debts with imported payments (spec p2i_parsers_rules §12; legacy MT:4-14; owner
// decision 2026-10-21, migration 0037). One row settles one debt; outflows only (C15). The review asks
// fin_debt_candidates_batch for every eligible row at once and pre-selects a strong match; fin_debt_candidates is the
// full list of one row. A row saved as a new entry next to an open debt of the same amount needs ack_open_debt.

import type {
  DebtCandidateJson,
  DebtMatchKind,
  DebtSuggestionInput,
  DebtSuggestionJson,
  DebtSuggestionRowJson,
  Direction,
  OpenDebtJson,
} from "../finance";
import type { ParsedRow } from "./types";

/** Bank statement rows and clinic workbook expense rows (cash or bank-paid); daily receipts never settle a debt. */
const MATCHABLE_KEY = /^(bank:|bank-table:|clinic:\d{4}-\d{2}-\d{2}:expense:[1-9]\d{0,4}$)/;

/** §12.1: offered only for unsaved outflows (D9: signedCents < 0) whose category is an outflow. */
export function isMatchEligible(row: Pick<ParsedRow, "key" | "signedCents">, categoryDirection: Direction | null, saved: boolean): boolean {
  return MATCHABLE_KEY.test(row.key) && categoryDirection === "out" && row.signedCents < 0 && !saved;
}

/** fin__debt_kind: the payment against a debt's outstanding; the margin is min(2 % of the outstanding, 1.000,00 TL). */
export function debtKind(amount: number, outstanding: number): DebtMatchKind | null {
  if (!(amount >= 1) || !(outstanding >= 1)) return null;
  if (amount === outstanding) return "exact";
  const gap = Math.abs(outstanding - amount);
  const small = gap <= 100000 && gap * 50 <= outstanding;
  if (outstanding > amount) return small ? "near" : "partial";
  return small ? "higher" : null;
}

export const MATCH_SAME_DEBT_ERROR =
  "Aynı borca bu aktarımda tek ödeme satırı eşleştirin; sonraki ödemeyi yenilenen kalan tutarla aktarın.";
export const MATCH_SUGGESTED_TEXT = "Olası borç eşleşmesi bulundu. Yukarıdan seçip onaylayın.";
export const MATCH_OVERPAID_TEXT = "Ödeme eşleştirilen borcun kalanından fazla. Başka borç seçin veya yeni gider oluşturun.";
export const OPEN_DEBT_ACK_TEXT = "Yine de yeni gider olarak kaydet";
export const openDebtProblem = (n: number) =>
  `${n} seçili satırda aynı veya yakın tutarda açık borç var. Satırı borca eşleştirin ya da “${OPEN_DEBT_ACK_TEXT}” kutusunu işaretleyin.`;

/** §12.3 client rule: two rows may not target the same debt in one save. */
export function matchTargetsError(targets: readonly (string | null | undefined)[]): string | null {
  const ids = targets.filter((t): t is string => !!t);
  return new Set(ids).size === ids.length ? null : MATCH_SAME_DEBT_ERROR;
}

// ---------------------------------------------------------------------------
// Review state of a row's debt match
// ---------------------------------------------------------------------------

/** The debt a row settles (fin_import_rows `match`) and what the row shows about it. */
export type MatchChoice = {
  entry_id: string;
  version: number;
  payment_id: string;
  counterparty_name: string;
  category_name: string;
  due_date: string;
  amount_cents: number;
  outstanding_cents: number;
  reason: string;
};

export type MatchState = {
  key: string;
  amount: number;
  match: MatchChoice | null;
  /**
   * the user decided the row: picked an option (a debt or 'Yeni gider kaydı oluştur') or ticked one of its boxes
   * ('Kalan … borcu kapat', 'Yine de yeni gider olarak kaydet'); automatic pre-selection leaves the row alone
   */
  matchChosen: boolean;
  /** close_remainder: cancel the rest of the matched debt in the same save */
  closeRemainder: boolean;
  /** ack_open_debt: save as a new entry although an open debt of the same amount exists */
  ackOpenDebt: boolean;
};

export const matchFromCandidate = (c: DebtCandidateJson, paymentId: string): MatchChoice => ({
  entry_id: c.entry.id,
  version: c.entry.version,
  payment_id: paymentId,
  counterparty_name: c.entry.counterparty_name,
  category_name: c.entry.category_name,
  due_date: c.entry.due_date,
  amount_cents: c.entry.amount_cents,
  outstanding_cents: c.entry.outstanding_cents,
  reason: c.reason,
});

/** Closing the rest is offered (and on by default) for a near payment, offered for a larger partial one. */
export const remainderDefault = (amount: number, outstanding: number): boolean => debtKind(amount, outstanding) === "near";

/** The user's own pick in the select; null = 'Yeni gider kaydı oluştur'. A re-picked debt keeps its payment id. */
export function chooseMatch(
  row: Pick<MatchState, "amount" | "match">,
  c: DebtCandidateJson | null,
  newPaymentId: () => string,
): Pick<MatchState, "match" | "matchChosen" | "closeRemainder"> {
  if (!c) return { match: null, matchChosen: true, closeRemainder: false };
  const paymentId = row.match?.entry_id === c.entry.id ? row.match.payment_id : newPaymentId();
  return { match: matchFromCandidate(c, paymentId), matchChosen: true, closeRemainder: remainderDefault(row.amount, c.entry.outstanding_cents) };
}

/** close_remainder as sent: only a matched payment below the debt's outstanding leaves something to close. */
export const closesRemainder = (row: Pick<MatchState, "amount" | "match" | "closeRemainder">): boolean =>
  !!row.match && row.closeRemainder && row.amount < row.match.outstanding_cents;

/**
 * An amount edit: the open-debt confirmation is asked again and a matched row's 'Kalan … borcu kapat' goes back to
 * its default for the new amount (on only for a near payment), so a corrected amount never closes a large rest.
 */
export const amountPatch = (
  row: Pick<MatchState, "match">,
  amount: number,
): Pick<MatchState, "amount" | "ackOpenDebt"> & Partial<Pick<MatchState, "closeRemainder">> => ({
  amount,
  ackOpenDebt: false,
  ...(row.match ? { closeRemainder: remainderDefault(amount, row.match.outstanding_cents) } : {}),
});

export const overpaysMatch = (row: Pick<MatchState, "amount" | "match">): boolean =>
  !!row.match && row.amount > row.match.outstanding_cents;

/**
 * fin_debt_candidates_batch's pre-selection rule over the merged answers of every call of one refresh (the server
 * resolves conflicts only among the ≤ 500 rows of one call): a row with exactly one strong candidate gets it, unless
 * that debt is also the only strong candidate of other rows; then the row strictly closest to the due date (exact
 * before near) wins, and a tie pre-selects the debt for none of them. Row key → the pre-selected candidate.
 */
export function preselections(answers: ReadonlyMap<string, DebtSuggestionRowJson>): Map<string, DebtSuggestionJson> {
  const byDebt = new Map<string, { key: string; c: DebtSuggestionJson; rank: number }[]>();
  for (const [key, a] of answers) {
    // Candidates come strong first; strong ones are exact or near, so (days, exact before near) is one number.
    const c = a.strong_count === 1 ? a.candidates.find((x) => x.strong) : undefined;
    if (!c) continue;
    byDebt.set(c.entry.id, [...(byDebt.get(c.entry.id) ?? []), { key, c, rank: c.days * 2 + (c.kind === "exact" ? 0 : 1) }]);
  }
  const out = new Map<string, DebtSuggestionJson>();
  for (const list of byDebt.values()) {
    const best = Math.min(...list.map((x) => x.rank));
    const top = list.filter((x) => x.rank === best);
    if (top.length === 1) out.set(top[0].key, top[0].c);
  }
  return out;
}

/**
 * Applies fin_debt_candidates_batch answers (by row key, every call of one refresh). Rows the user decided (a debt,
 * 'Yeni gider kaydı oluştur', a confirmation box) are left alone, and only their picks reserve a debt. Any other row
 * follows preselections() unless its debt is reserved (none → back to a new entry); a row without an answer is no
 * longer eligible (saved, a financing line, moved out of the month …) and drops an automatic pre-selection.
 */
export function applySuggestions<T extends MatchState>(
  rows: readonly T[],
  answers: ReadonlyMap<string, DebtSuggestionRowJson>,
  newPaymentId: () => string,
): T[] {
  const pre = preselections(answers);
  const taken = new Set(rows.filter((r) => r.match && r.matchChosen).map((r) => r.match!.entry_id));
  return rows.map((r) => {
    if (r.matchChosen) return r;
    const pick = pre.get(r.key);
    if (!pick || taken.has(pick.entry.id)) return r.match ? { ...r, match: null, closeRemainder: false } : r;
    taken.add(pick.entry.id);
    const same = r.match?.entry_id === pick.entry.id;
    return {
      ...r,
      match: matchFromCandidate(pick, same ? r.match!.payment_id : newPaymentId()),
      closeRemainder: same ? r.closeRemainder : pick.kind === "near",
    };
  });
}

/** The user's pick of a debt on one row releases that debt from rows that only had it pre-selected. */
export function releaseAutoMatches<T extends MatchState>(rows: readonly T[], key: string, entryId: string): T[] {
  return rows.map((r) =>
    r.key !== key && !r.matchChosen && r.match?.entry_id === entryId ? { ...r, match: null, closeRemainder: false } : r
  );
}

const toOpenDebt = (c: DebtSuggestionJson): OpenDebtJson => ({
  entry_id: c.entry.id,
  version: c.entry.version,
  counterparty_name: c.entry.counterparty_name,
  category_name: c.entry.category_name,
  due_date: c.entry.due_date,
  amount_cents: c.entry.amount_cents,
  outstanding_cents: c.entry.outstanding_cents,
  kind: c.kind as OpenDebtJson["kind"],
  days: c.days,
});

/** What the rows the save sends do to the debts they match (fin__open_debts), by entry id. */
export type MatchedDebts = {
  /** nothing stays open: the payments reach the outstanding, or a row closes the rest (close_remainder) */
  settled: ReadonlySet<string>;
  /** partly paid: the debt as matched and the sum of the payments on it */
  partial: ReadonlyMap<string, { debt: MatchChoice; paid: number }>;
};

/** fin__open_debts' view of the chosen rows' matches: a partial payment never hides the rest of its debt. */
export function matchedDebts(rows: readonly Pick<MatchState, "amount" | "match" | "closeRemainder">[]): MatchedDebts {
  const sums = new Map<string, { debt: MatchChoice; paid: number; closes: boolean }>();
  for (const r of rows) {
    if (!r.match) continue;
    const s = sums.get(r.match.entry_id) ?? { debt: r.match, paid: 0, closes: false };
    sums.set(r.match.entry_id, { debt: s.debt, paid: s.paid + r.amount, closes: s.closes || closesRemainder(r) });
  }
  const settled = new Set<string>();
  const partial = new Map<string, { debt: MatchChoice; paid: number }>();
  sums.forEach((s, id) => {
    if (s.closes || s.paid >= s.debt.outstanding_cents) settled.add(id);
    else partial.set(id, { debt: s.debt, paid: s.paid });
  });
  return { settled, partial };
}

const dayDistance = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86400000);

/**
 * Open debts a row saved as a new entry would count twice (fin__open_debts): the check's 'open_debt' debts and the
 * exact / near suggestions within 45 days, except the debts the chosen rows match (the save sends only those). A
 * settled debt counts for no row; a partly paid one counts with the rest left open, for bank and workbook expense
 * outflows exact or near to that rest within 45 days. Closest due date first; empty for a matched row (it never
 * needs ack_open_debt).
 */
export function rowOpenDebts(
  row: Pick<MatchState, "key" | "amount" | "match"> & Pick<ParsedRow, "signedCents" | "date">,
  checked: readonly OpenDebtJson[] | undefined,
  suggestion: DebtSuggestionRowJson | undefined,
  matched: MatchedDebts,
): OpenDebtJson[] {
  if (row.match) return [];
  const all = [
    ...(checked ?? []),
    ...(suggestion?.candidates ?? []).filter((c) => (c.kind === "exact" || c.kind === "near") && c.days <= 45).map(toOpenDebt),
  ];
  const byId = new Map<string, OpenDebtJson>();
  for (const d of all) {
    if (!matched.settled.has(d.entry_id) && !matched.partial.has(d.entry_id) && !byId.has(d.entry_id)) byId.set(d.entry_id, d);
  }
  // The answers above know a partly paid debt only as a whole; the save compares the row with what stays open.
  if (MATCHABLE_KEY.test(row.key) && row.signedCents < 0) {
    matched.partial.forEach(({ debt, paid }, id) => {
      const left = debt.outstanding_cents - paid;
      const kind = debtKind(row.amount, left);
      const days = dayDistance(row.date, debt.due_date);
      if ((kind === "exact" || kind === "near") && days <= 45) {
        byId.set(id, {
          entry_id: id,
          version: debt.version,
          counterparty_name: debt.counterparty_name,
          category_name: debt.category_name,
          due_date: debt.due_date,
          amount_cents: debt.amount_cents,
          outstanding_cents: left,
          kind,
          days,
        });
      }
    });
  }
  return Array.from(byId.values())
    .sort(
      (a, b) =>
        a.days - b.days ||
        Number(a.kind !== "exact") - Number(b.kind !== "exact") ||
        a.due_date.localeCompare(b.due_date) ||
        a.entry_id.localeCompare(b.entry_id),
    );
}

export type SuggestionRow = {
  key: string;
  date: string;
  amount: number;
  /** null for rows the user has not selected: their narration never leaves the browser */
  text: string | null;
  categoryId: string | null;
  counterpartyId: string | null;
};

/** fin_debt_candidates_batch requests (≤ 500 rows each); row_no is the 1-based position in its call. */
export function suggestionCalls(rows: readonly SuggestionRow[], size = 500): { keys: string[]; rows: DebtSuggestionInput[] }[] {
  const out: { keys: string[]; rows: DebtSuggestionInput[] }[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    out.push({
      keys: part.map((r) => r.key),
      rows: part.map((r, j) => ({
        row_no: j + 1,
        amount_cents: r.amount,
        date: r.date,
        text: r.text === null ? null : r.text.trim().slice(0, 1000),
        category_id: r.categoryId,
        counterparty_id: r.counterpartyId,
      })),
    });
  }
  return out;
}
