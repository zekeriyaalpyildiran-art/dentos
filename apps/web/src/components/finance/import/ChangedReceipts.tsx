"use client";

import { useState } from "react";
import {
  finCorrectPayment,
  finEditEntry,
  finEntryDetail,
  finRecordPayment,
  formatDay,
  formatTL,
  newId,
  toFinanceError,
} from "@/lib/finance";
import { planReceiptsUpdate } from "@/lib/finance-import/receipts-update";

export type ChangedReceiptsItem = {
  key: string;
  /** 'YYYY-MM-DD' */
  date: string;
  fileAmount: number;
  savedAmount: number;
  /** fin_import_check existing.entry_id; null while the check has not answered */
  entryId: string | null;
  /** the day total contains foreign currency converted at the file's rate */
  fxApplied: boolean;
};

/**
 * Saved clinic-Excel day totals whose workbook amount moved (rows added to the workbook after the day was imported).
 * "Farkı işle" brings the day's receipts entry and its payment to the file amount with the ordinary entry / payment
 * RPCs (planReceiptsUpdate). A half-done update is continued by pressing again.
 */
export function ChangedReceipts({
  items,
  receiptsAccountId,
  disabled,
  onUpdated,
}: {
  items: ChangedReceiptsItem[];
  /** the clinic-Excel layout's receipts account (Karma); used only when the day's entry has no live payment */
  receiptsAccountId: string | null;
  disabled?: boolean;
  onUpdated: (key: string, text: string) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const update = async (item: ChangedReceiptsItem) => {
    if (!item.entryId) return;
    const diff = item.fileAmount - item.savedAmount;
    const question =
      `${formatDay(item.date)} günlük tahsilatı ${formatTL(item.savedAmount)} → ${formatTL(item.fileAmount)} ` +
      `(${diff > 0 ? "+" : "−"}${formatTL(Math.abs(diff))}) olarak güncellensin mi?` +
      (item.fxApplied ? "\n\nBu günde döviz var: fark yalnızca kur farkıysa güncellemeyin." : "");
    if (!window.confirm(question)) return;
    setBusyKey(item.key);
    setErrors((e) => ({ ...e, [item.key]: "" }));
    try {
      const detail = await finEntryDetail(item.entryId);
      const e = detail.entry;
      const plan = planReceiptsUpdate(e, detail.payments, item.fileAmount, item.date, receiptsAccountId);
      if (!plan.ok) throw new Error(plan.error);
      let version = e.version;
      for (const step of plan.steps) {
        const res =
          step.kind === "edit_amount"
            ? await finEditEntry({
                p_id: e.id,
                p_version: version,
                p_category_id: e.category_id,
                p_subcategory: e.subcategory,
                p_counterparty_id: e.counterparty_id,
                p_counterparty_text: e.counterparty_id ? null : e.counterparty_text,
                p_description: e.description,
                p_due_date: e.due_date,
                p_amount_cents: step.amount,
                p_entitlement_month: e.entitlement_month ? e.entitlement_month.slice(0, 7) : null,
              })
            : step.kind === "correct_payment"
              ? await finCorrectPayment({
                  p_entry_id: e.id,
                  p_version: version,
                  p_payment_id: step.paymentId,
                  p_paid_on: step.paidOn,
                  p_amount_cents: step.amount,
                  p_account_id: step.accountId,
                })
              : await finRecordPayment({
                  p_entry_id: e.id,
                  p_version: version,
                  p_payment_id: newId(),
                  p_paid_on: step.paidOn,
                  p_amount_cents: step.amount,
                  p_account_id: receiptsAccountId as string,
                });
        version = res.entry.version;
      }
      onUpdated(
        item.key,
        plan.steps.length
          ? `${formatDay(item.date)} günlük tahsilatı ${formatTL(item.fileAmount)} olarak güncellendi.`
          : `${formatDay(item.date)} günlük tahsilatı zaten ${formatTL(item.fileAmount)}; değişiklik gerekmedi.`,
      );
    } catch (err) {
      setErrors((x) => ({ ...x, [item.key]: toFinanceError(err).message }));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const diff = item.fileAmount - item.savedAmount;
        return (
          <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="tabular-nums">
              <b>{formatDay(item.date)}</b>: kayıt {formatTL(item.savedAmount)} → dosya {formatTL(item.fileAmount)} (
              {diff > 0 ? "+" : "−"}
              {formatTL(Math.abs(diff))})
            </span>
            <button
              type="button"
              className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:bg-gray-400"
              disabled={disabled || busyKey !== null || !item.entryId}
              onClick={() => update(item)}
            >
              {busyKey === item.key ? "İşleniyor..." : "Farkı işle"}
            </button>
            {item.fxApplied && (
              <span className="basis-full text-xs text-amber-800">
                Bu günde döviz var; dosya kuru değiştiyse fark yalnızca kur farkı olabilir. Öyleyse güncellemeyin.
              </span>
            )}
            {errors[item.key] && <span className="basis-full text-xs">{errors[item.key]}</span>}
          </li>
        );
      })}
    </ul>
  );
}
