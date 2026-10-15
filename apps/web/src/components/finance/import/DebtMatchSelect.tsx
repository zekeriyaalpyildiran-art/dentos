"use client";

import { useState } from "react";
import {
  finDebtCandidates,
  formatDay,
  formatTL,
  newId,
  toFinanceError,
  type DebtCandidateJson,
  type FinanceError,
} from "@/lib/finance";
import { MATCH_SUGGESTED_TEXT } from "@/lib/finance-import/matching";
import type { MatchChoice } from "./review";

/**
 * 'Mevcut borca eşleştir' (MT:4-13, IP:65): candidates come from fin_debt_candidates (outflow categories, open,
 * outstanding ≥ amount, never financing fees). One bank row settles one debt; the debt keeps its category,
 * counterparty and entitlement period.
 */
export function DebtMatchSelect({
  amount,
  date,
  description,
  value,
  disabled,
  onChange,
}: {
  amount: number;
  date: string;
  description: string;
  value: MatchChoice | null;
  disabled: boolean;
  onChange: (choice: MatchChoice | null) => void;
}) {
  const [items, setItems] = useState<DebtCandidateJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await finDebtCandidates(amount, date, description, 50);
      setItems(res.candidates);
      setTotal(res.total_count);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  };

  const label = (c: DebtCandidateJson) =>
    `${c.suggested ? "Öneri: " : ""}${c.entry.counterparty_name} · ${formatDay(c.entry.due_date)} · kalan ${formatTL(
      c.entry.outstanding_cents
    )} · ${c.entry.category_name}`;

  if (!items && !value) {
    return (
      <div className="space-y-1">
        <button type="button" className="text-blue-600 hover:underline text-xs" disabled={disabled || loading} onClick={load}>
          {loading ? "Borçlar yükleniyor..." : "Açık borçları göster"}
        </button>
        {error && <div className="text-xs text-red-600">{error.message}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <select
        aria-label="Ödemenin eşleşeceği borç"
        className="w-full px-2 py-1 border rounded bg-white text-xs"
        disabled={disabled}
        value={value?.entry_id ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return onChange(null);
          const c = items?.find((x) => x.entry.id === id);
          if (c) onChange({ entry_id: c.entry.id, version: c.entry.version, payment_id: newId(), label: label(c).replace(/^Öneri: /, "") });
        }}
      >
        <option value="">Yeni gider kaydı oluştur</option>
        {value && !items?.some((c) => c.entry.id === value.entry_id) && <option value={value.entry_id}>{value.label}</option>}
        {(items ?? []).map((c) => (
          <option key={c.entry.id} value={c.entry.id}>
            {label(c)}
          </option>
        ))}
      </select>
      {value ? (
        <div className="text-xs text-gray-600">
          Mevcut borca {formatTL(amount)} ödeme işlenecek. Yeni gider oluşmaz; kategori ve hakediş dönemi mevcut borçtan
          korunur.
        </div>
      ) : items && items.some((c) => c.suggested) ? (
        <div className="text-xs font-semibold text-amber-700">{MATCH_SUGGESTED_TEXT}</div>
      ) : (
        <div className="text-xs text-gray-500">
          {items && items.length === 0 ? "Uygun açık borç yok." : "Uygun açık borç varsa listeden seçebilirsiniz."}
          {items && total > items.length && ` İlk ${items.length} / ${total} gösteriliyor.`}
        </div>
      )}
      {!items && value && (
        <button type="button" className="text-blue-600 hover:underline text-xs" disabled={disabled || loading} onClick={load}>
          Listeyi yükle
        </button>
      )}
      {error && <div className="text-xs text-red-600">{error.message}</div>}
    </div>
  );
}
