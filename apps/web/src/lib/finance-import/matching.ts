// Finance import: matching a bank outflow to an open debt (spec p2i_parsers_rules §12; legacy MT:4-14).
// One bank row settles one debt; outflows only (C15); the candidates come from fin_debt_candidates.

import type { Direction } from "../finance";
import { normM } from "./primitives";
import type { ParsedRow } from "./types";

/** §12.1: offered only for unsaved bank outflows whose category is an outflow (D9: also signedCents < 0). */
export function isMatchEligible(row: Pick<ParsedRow, "key" | "signedCents">, categoryDirection: Direction | null, saved: boolean): boolean {
  return /^(bank:|bank-table:)/.test(row.key) && categoryDirection === "out" && row.signedCents < 0 && !saved;
}

export type DebtCandidateInput = {
  id: string;
  due_date: string;
  outstanding_cents: number;
  counterparty_name: string;
};

export type ScoredCandidate<T extends DebtCandidateInput> = {
  entry: T;
  suggested: boolean;
  score: number;
  reason: string;
};

const STOP_TOKENS = ["banka", "odeme", "toplam"];

/** MT:4-13 scoring, client side. Entries whose outstanding is below the row amount are dropped. */
export function scoreCandidates<T extends DebtCandidateInput>(
  row: Pick<ParsedRow, "description" | "date" | "amount">,
  candidates: readonly T[],
): ScoredCandidate<T>[] {
  const desc = normM(row.description);
  return candidates
    .filter((c) => c.outstanding_cents >= row.amount)
    .map((entry) => {
      const tokens = normM(entry.counterparty_name)
        .split(" ")
        .filter((t) => t.length >= 3 && !STOP_TOKENS.includes(t));
      const nameMatch = tokens.length > 0 && tokens.every((t) => desc.includes(t));
      const days = Math.abs(Date.parse(row.date) - Date.parse(entry.due_date)) / 86400000;
      const exact = entry.outstanding_cents === row.amount;
      return {
        entry,
        suggested: nameMatch && days <= 45,
        score: (nameMatch ? 100 : 0) + (exact ? 20 : 0) + (days <= 7 ? 10 : 0),
        reason: nameMatch ? "Kişi / kurum eşleşiyor" + (exact ? " · tutar aynı" : " · kısmi ödeme") : "Elle kontrol edin",
      };
    })
    .sort((a, b) => b.score - a.score || a.entry.due_date.localeCompare(b.entry.due_date));
}

export const MATCH_SAME_DEBT_ERROR =
  "Aynı borca bu aktarımda tek banka satırı eşleştirin; sonraki ödemeyi yenilenen kalan tutarla aktarın.";
export const MATCH_SUGGESTED_TEXT = "Olası borç eşleşmesi bulundu. Yukarıdan seçip onaylayın.";

/** §12.3 client rule: two rows may not target the same debt in one save. */
export function matchTargetsError(targets: readonly (string | null | undefined)[]): string | null {
  const ids = targets.filter((t): t is string => !!t);
  return new Set(ids).size === ids.length ? null : MATCH_SAME_DEBT_ERROR;
}
