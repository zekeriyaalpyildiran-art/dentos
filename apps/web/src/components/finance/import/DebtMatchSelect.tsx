"use client";

import { useState } from "react";
import {
  finDebtCandidates,
  formatDay,
  formatTL,
  newId,
  toFinanceError,
  type DebtCandidateJson,
  type DebtSuggestionJson,
  type DebtSuggestionRowJson,
  type FinanceError,
  type OpenDebtJson,
} from "@/lib/finance";
import {
  MATCH_OVERPAID_TEXT,
  MATCH_SUGGESTED_TEXT,
  OPEN_DEBT_ACK_TEXT,
  chooseMatch,
  type MatchChoice,
  type MatchState,
} from "@/lib/finance-import/matching";

export type MatchPatch = Partial<Pick<MatchState, "match" | "matchChosen" | "closeRemainder">>;

const isSuggestion = (c: DebtCandidateJson): c is DebtSuggestionJson => "strong" in c;

/**
 * 'Mevcut borca eşleştir' (MT:4-13, IP:65; owner decision 2026-10-21): the row's candidates come with the review
 * (fin_debt_candidates_batch) and a strong one is already chosen; "Tüm uygun borçlar" loads the full list
 * (fin_debt_candidates: outflow categories, open, outstanding ≥ amount, never financing fees). One row settles one
 * debt; the debt keeps its category, counterparty and entitlement period.
 */
export function DebtMatchSelect({
  amount,
  date,
  description,
  suggestion,
  value,
  closeRemainder,
  disabled,
  onChange,
}: {
  amount: number;
  date: string;
  description: string;
  /** undefined while the review's suggestions are loading or could not be read */
  suggestion: DebtSuggestionRowJson | undefined;
  value: MatchChoice | null;
  closeRemainder: boolean;
  disabled: boolean;
  onChange: (patch: MatchPatch) => void;
}) {
  const [full, setFull] = useState<DebtCandidateJson[] | null>(null);
  const [fullTotal, setFullTotal] = useState(0);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await finDebtCandidates(amount, date, description, 50);
      setFull(res.candidates);
      setFullTotal(res.total_count);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  };

  const suggested = suggestion?.candidates ?? [];
  const items: DebtCandidateJson[] = [...suggested, ...(full ?? []).filter((c) => !suggested.some((s) => s.entry.id === c.entry.id))];
  const total = Math.max(suggestion?.total_count ?? 0, fullTotal);
  const label = (c: DebtCandidateJson) =>
    `${(isSuggestion(c) ? c.strong : c.suggested) ? "Öneri: " : ""}${c.entry.counterparty_name} · ${formatDay(c.entry.due_date)} · kalan ${formatTL(
      c.entry.outstanding_cents
    )} · ${c.entry.category_name}`;
  const loadButton = (text: string) => (
    <button type="button" className="text-blue-600 hover:underline text-xs" disabled={disabled || loading} onClick={load}>
      {loading ? "Borçlar yükleniyor..." : text}
    </button>
  );

  if (!suggestion && !full && !value) {
    return (
      <div className="space-y-1">
        {loadButton("Açık borçları göster")}
        {error && <div className="text-xs text-red-600">{error.message}</div>}
      </div>
    );
  }

  const remainder = value ? value.outstanding_cents - amount : 0;

  return (
    <div className="space-y-1">
      {value && (
        <div className="text-xs font-semibold text-green-700">
          Açık borca eşleşti: {value.counterparty_name} · vade {formatDay(value.due_date)} · kalan {formatTL(value.outstanding_cents)}
          {value.reason && <span className="font-normal"> ({value.reason})</span>}
        </div>
      )}
      <select
        aria-label="Ödemenin eşleşeceği borç"
        className="w-full px-2 py-1 border rounded bg-white text-xs"
        disabled={disabled}
        value={value?.entry_id ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          const c = id ? items.find((x) => x.entry.id === id) : null;
          if (c !== undefined) onChange(chooseMatch({ amount, match: value }, c, newId));
        }}
      >
        <option value="">Yeni gider kaydı oluştur</option>
        {value && !items.some((c) => c.entry.id === value.entry_id) && (
          <option value={value.entry_id}>
            {value.counterparty_name} · {formatDay(value.due_date)} · kalan {formatTL(value.outstanding_cents)} · {value.category_name}
          </option>
        )}
        {items.map((c) => (
          <option key={c.entry.id} value={c.entry.id}>
            {label(c)}
          </option>
        ))}
      </select>
      {value ? (
        <>
          <div className="text-xs text-gray-600">
            Mevcut borca {formatTL(amount)} ödeme işlenecek. Yeni gider oluşmaz; kategori ve hakediş dönemi mevcut borçtan
            korunur.
          </div>
          {remainder < 0 && <div className="text-xs text-red-700 font-medium">{MATCH_OVERPAID_TEXT}</div>}
          {remainder > 0 && (
            <>
              <label className="flex items-start gap-1 text-xs text-gray-800">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={closeRemainder}
                  disabled={disabled}
                  onChange={(e) => onChange({ closeRemainder: e.target.checked, matchChosen: true })}
                />
                Kalan {formatTL(remainder)} borcu kapat (bu ödemeyle borç tamamlandı)
              </label>
              <div className="text-xs text-gray-500">
                {closeRemainder
                  ? "Borcun kalanı bu kayıtla iptal edilir; planda açık borç kalmaz."
                  : `İşaretlenmezse kalan ${formatTL(remainder)} planda açık borç olarak kalır.`}
              </div>
            </>
          )}
        </>
      ) : items.length > 0 && suggestion && suggestion.strong_count > 0 ? (
        <div className="text-xs font-semibold text-amber-700">{MATCH_SUGGESTED_TEXT}</div>
      ) : (
        <div className="text-xs text-gray-500">{items.length === 0 ? "Uygun açık borç yok." : "Uygun açık borç varsa listeden seçebilirsiniz."}</div>
      )}
      {!full && total > suggested.length && loadButton(`Tüm uygun borçlar (${total})`)}
      {!full && !suggestion && value && loadButton("Listeyi yükle")}
      {full && fullTotal > full.length && (
        <div className="text-xs text-gray-500">
          İlk {full.length} / {fullTotal} gösteriliyor.
        </div>
      )}
      {error && <div className="text-xs text-red-600">{error.message}</div>}
    </div>
  );
}

/**
 * A row saved as a new entry next to an open debt of the same or a near amount (0037 'open_debt'): the payment would
 * be counted twice, so the save needs the row's own confirmation (ack_open_debt). A small overpayment of a debt
 * ('higher') can never be matched; it is only pointed out.
 */
export function OpenDebtNotice({
  debts,
  higher,
  ack,
  disabled,
  onAck,
}: {
  debts: OpenDebtJson[];
  higher: DebtSuggestionJson | null;
  ack: boolean;
  disabled: boolean;
  onAck: (ack: boolean) => void;
}) {
  const d = debts[0];
  if (!d && !higher) return null;
  return (
    <div className="space-y-1">
      {d && (
        <div className="text-xs font-semibold text-amber-700">
          {d.kind === "exact" ? "Aynı tutarda" : "Yakın tutarda"} açık borç var: {d.counterparty_name} · vade {formatDay(d.due_date)} · kalan{" "}
          {formatTL(d.outstanding_cents)}
          {debts.length > 1 && ` (+${debts.length - 1} borç daha)`}. Yeni gider olarak kaydederseniz ödeme iki kez sayılır.
          <label className="flex items-start gap-1 mt-1 font-normal text-gray-800">
            <input type="checkbox" className="mt-0.5" checked={ack} disabled={disabled} onChange={(e) => onAck(e.target.checked)} />
            {OPEN_DEBT_ACK_TEXT}
          </label>
        </div>
      )}
      {higher && (
        <div className="text-xs text-amber-700">
          Ödeme açık borçtan {formatTL(higher.excess_cents)} fazla; borç kaydını kontrol edin ({higher.entry.counterparty_name} · vade{" "}
          {formatDay(higher.entry.due_date)} · kalan {formatTL(higher.entry.outstanding_cents)}).
        </div>
      )}
    </div>
  );
}
