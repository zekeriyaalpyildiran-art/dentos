// Finance import: bring an already imported clinic-Excel day total (clinic:<day>:receipts) up to the workbook's new
// amount. Rows added to the workbook after a day was imported were never reflected (the import refuses a saved key),
// so the day's receipts stayed short (e.g. 04.11.2026: 10.000 TL saved, 137.000 TL in the workbook). The update uses
// the ordinary entry / payment RPCs (fin_edit_entry, fin_correct_payment, fin_record_payment), so every change is
// version-checked and appears in the entry history. Pure: the wizard fetches the entry and runs the steps in order.

/** The entry fields the plan reads (EntryJson). */
export type PlanEntry = {
  id: string;
  amount_cents: number;
  cancelled_at: string | null;
  excluded_from_totals: boolean;
};

/** The payment fields the plan reads (PaymentJson). */
export type PlanPayment = {
  id: string;
  paid_on: string;
  amount_cents: number;
  account_id: string;
  is_voided: boolean;
};

export type ReceiptsStep =
  /** fin_correct_payment: the payment's new amount (date and account unchanged). */
  | { kind: "correct_payment"; paymentId: string; amount: number; paidOn: string; accountId: string }
  /** fin_edit_entry: the entry's new amount (every other field unchanged). */
  | { kind: "edit_amount"; amount: number }
  /** fin_record_payment: a new payment on the day (only when the entry has no live payment). */
  | { kind: "record_payment"; amount: number; paidOn: string };

export type ReceiptsPlan = { ok: true; steps: ReceiptsStep[] } | { ok: false; error: string };

export const RECEIPTS_UPDATE_ERRORS = {
  cancelled: "Bu günün tahsilat kaydı iptal edilmiş; finans listesinden kontrol edin.",
  excluded: "Bu günün tahsilat kaydı toplam dışında; finans listesinden kontrol edin.",
  invalid: "Dosyadaki tutar geçersiz.",
  no_account: "Kaydın ödemesi yok ve hesap bilinmiyor; finans listesinden düzeltin.",
  too_small:
    "Dosyadaki tutar, kaydın diğer ödemelerinden de az. Bu günü finans listesinden elle düzeltin (fazla ödemeyi iptal edin).",
} as const;

/**
 * The payment that carries the day: the import's own payment (its id is the entry id, RT:111), else the live payment
 * dated on the day, else the latest live payment. null without a live payment.
 */
export function carrierPayment(entry: PlanEntry, payments: readonly PlanPayment[], day: string): PlanPayment | null {
  const live = payments.filter((p) => !p.is_voided);
  return (
    live.find((p) => p.id === entry.id) ??
    live.find((p) => p.paid_on === day) ??
    [...live].sort((a, b) => (a.paid_on < b.paid_on ? 1 : a.paid_on > b.paid_on ? -1 : 0))[0] ??
    null
  );
}

/**
 * Steps that make the entry's amount and its live payments both equal `target`, keeping the paid ≤ amount invariant
 * after every step: a decrease first lowers the carrier payment, then the amount; an increase first raises the
 * amount, then the carrier payment. Only the carrier payment moves; its date and account stay. Re-planning after a
 * half-done update continues from where it stopped (state based), and an entry already at `target` gives no steps.
 * `accountId` is used only when the entry has no live payment (the wizard passes the payment account of the day).
 */
export function planReceiptsUpdate(
  entry: PlanEntry,
  payments: readonly PlanPayment[],
  target: number,
  day: string,
  accountId: string | null = null,
): ReceiptsPlan {
  if (!Number.isInteger(target) || target < 1 || target > 1e12) return { ok: false, error: RECEIPTS_UPDATE_ERRORS.invalid };
  if (entry.cancelled_at) return { ok: false, error: RECEIPTS_UPDATE_ERRORS.cancelled };
  if (entry.excluded_from_totals) return { ok: false, error: RECEIPTS_UPDATE_ERRORS.excluded };
  const live = payments.filter((p) => !p.is_voided);
  const paid = live.reduce((n, p) => n + p.amount_cents, 0);
  const carrier = carrierPayment(entry, payments, day);
  const steps: ReceiptsStep[] = [];
  const diff = target - paid;
  if (diff < 0) {
    // carrier exists: paid > target ≥ 1 means some live payment
    const c = carrier as PlanPayment;
    const amount = c.amount_cents + diff;
    if (amount < 1) return { ok: false, error: RECEIPTS_UPDATE_ERRORS.too_small };
    steps.push({ kind: "correct_payment", paymentId: c.id, amount, paidOn: c.paid_on, accountId: c.account_id });
  }
  if (entry.amount_cents !== target) steps.push({ kind: "edit_amount", amount: target });
  if (diff > 0) {
    if (carrier)
      steps.push({
        kind: "correct_payment",
        paymentId: carrier.id,
        amount: carrier.amount_cents + diff,
        paidOn: carrier.paid_on,
        accountId: carrier.account_id,
      });
    else if (accountId) steps.push({ kind: "record_payment", amount: diff, paidOn: day });
    else return { ok: false, error: RECEIPTS_UPDATE_ERRORS.no_account };
  }
  return { ok: true, steps };
}

/** Workbook day-total rows whose saved amount differs from the file (legacy 'TUTAR DEĞİŞMİŞ'). */
export const isChangedReceipts = (row: { key: string; kind: string; amount: number; flags: { saved: boolean; savedAmount: number | null } }) =>
  row.kind === "workbook_receipts" &&
  row.key.startsWith("clinic:") &&
  row.flags.saved &&
  row.flags.savedAmount !== null &&
  row.flags.savedAmount !== row.amount;
