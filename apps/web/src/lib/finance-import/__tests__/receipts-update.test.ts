import { describe, expect, it } from "vitest";
import {
  RECEIPTS_UPDATE_ERRORS,
  carrierPayment,
  isChangedReceipts,
  planReceiptsUpdate,
  type PlanEntry,
  type PlanPayment,
} from "../receipts-update";

const DAY = "2026-11-04";
const KARMA = "acc-karma";
const entry = (amount: number, over: Partial<PlanEntry> = {}): PlanEntry => ({
  id: "e1",
  amount_cents: amount,
  cancelled_at: null,
  excluded_from_totals: false,
  ...over,
});
const pay = (id: string, amount: number, over: Partial<PlanPayment> = {}): PlanPayment => ({
  id,
  paid_on: DAY,
  amount_cents: amount,
  account_id: KARMA,
  is_voided: false,
  ...over,
});

/** Applies the steps the way the RPCs do and checks paid ≤ amount after every step. */
function apply(e: PlanEntry, payments: PlanPayment[], target: number) {
  const plan = planReceiptsUpdate(e, payments, target, DAY, KARMA);
  if (!plan.ok) throw new Error(plan.error);
  let amount = e.amount_cents;
  let list = payments.map((p) => ({ ...p }));
  for (const s of plan.steps) {
    if (s.kind === "edit_amount") amount = s.amount;
    else if (s.kind === "correct_payment") list = list.map((p) => (p.id === s.paymentId ? { ...p, amount_cents: s.amount } : p));
    else list.push(pay("new", s.amount, { paid_on: s.paidOn }));
    const paid = list.filter((p) => !p.is_voided).reduce((n, p) => n + p.amount_cents, 0);
    expect(paid).toBeLessThanOrEqual(amount);
  }
  return { amount, paid: list.filter((p) => !p.is_voided).reduce((n, p) => n + p.amount_cents, 0), steps: plan.steps, list };
}

describe("planReceiptsUpdate", () => {
  it("raises the amount first, then the import payment (04.11.2026: 10.000 → 137.000 TL)", () => {
    const r = apply(entry(1_000_000), [pay("e1", 1_000_000)], 13_700_000);
    expect(r.steps.map((s) => s.kind)).toEqual(["edit_amount", "correct_payment"]);
    expect(r.amount).toBe(13_700_000);
    expect(r.paid).toBe(13_700_000);
    expect(r.list).toHaveLength(1);
  });

  it("lowers the import payment first, then the amount", () => {
    const r = apply(entry(5_000_000), [pay("e1", 5_000_000)], 4_200_000);
    expect(r.steps.map((s) => s.kind)).toEqual(["correct_payment", "edit_amount"]);
    expect(r.amount).toBe(4_200_000);
    expect(r.paid).toBe(4_200_000);
  });

  it("keeps the payment's date and account", () => {
    const plan = planReceiptsUpdate(entry(100), [pay("e1", 100, { account_id: "other", paid_on: DAY })], 250, DAY, KARMA);
    expect(plan).toEqual({
      ok: true,
      steps: [
        { kind: "edit_amount", amount: 250 },
        { kind: "correct_payment", paymentId: "e1", amount: 250, paidOn: DAY, accountId: "other" },
      ],
    });
  });

  it("continues a half-done increase (amount already raised, payment not yet)", () => {
    const r = apply(entry(13_700_000), [pay("e1", 1_000_000)], 13_700_000);
    expect(r.steps.map((s) => s.kind)).toEqual(["correct_payment"]);
    expect(r.paid).toBe(13_700_000);
  });

  it("continues a half-done decrease (payment already lowered, amount not yet)", () => {
    const r = apply(entry(5_000_000), [pay("e1", 4_200_000)], 4_200_000);
    expect(r.steps.map((s) => s.kind)).toEqual(["edit_amount"]);
  });

  it("has nothing to do when the entry already matches (e.g. fixed by hand with a second payment)", () => {
    const plan = planReceiptsUpdate(entry(13_700_000), [pay("e1", 1_000_000), pay("p2", 12_700_000)], 13_700_000, DAY, KARMA);
    expect(plan).toEqual({ ok: true, steps: [] });
  });

  it("moves only the import payment when there are several", () => {
    const r = apply(entry(13_700_000), [pay("e1", 1_000_000), pay("p2", 12_700_000)], 14_000_000);
    expect(r.steps).toEqual([
      { kind: "edit_amount", amount: 14_000_000 },
      { kind: "correct_payment", paymentId: "e1", amount: 1_300_000, paidOn: DAY, accountId: KARMA },
    ]);
  });

  it("refuses a decrease that would take the import payment to zero or below", () => {
    const plan = planReceiptsUpdate(entry(13_700_000), [pay("e1", 1_000_000), pay("p2", 12_700_000)], 12_000_000, DAY, KARMA);
    expect(plan).toEqual({ ok: false, error: RECEIPTS_UPDATE_ERRORS.too_small });
  });

  it("records a payment when the entry has none (all voided)", () => {
    const r = apply(entry(1_000_000), [pay("e1", 1_000_000, { is_voided: true })], 1_500_000);
    expect(r.steps).toEqual([
      { kind: "edit_amount", amount: 1_500_000 },
      { kind: "record_payment", amount: 1_500_000, paidOn: DAY },
    ]);
  });

  it("refuses cancelled, excluded and invalid targets", () => {
    expect(planReceiptsUpdate(entry(100, { cancelled_at: "x" }), [], 200, DAY, KARMA)).toEqual({ ok: false, error: RECEIPTS_UPDATE_ERRORS.cancelled });
    expect(planReceiptsUpdate(entry(100, { excluded_from_totals: true }), [], 200, DAY, KARMA)).toEqual({ ok: false, error: RECEIPTS_UPDATE_ERRORS.excluded });
    expect(planReceiptsUpdate(entry(100), [pay("e1", 100)], 0, DAY, KARMA)).toEqual({ ok: false, error: RECEIPTS_UPDATE_ERRORS.invalid });
    expect(planReceiptsUpdate(entry(100), [], 200, DAY, null)).toEqual({ ok: false, error: RECEIPTS_UPDATE_ERRORS.no_account });
  });
});

describe("carrierPayment", () => {
  it("prefers the import payment, then the day's payment, then the latest", () => {
    const e = entry(300);
    expect(carrierPayment(e, [pay("x", 100, { paid_on: "2026-11-05" }), pay("e1", 200)], DAY)?.id).toBe("e1");
    expect(carrierPayment(e, [pay("x", 100, { paid_on: "2026-11-05" }), pay("y", 200)], DAY)?.id).toBe("y");
    expect(carrierPayment(e, [pay("x", 100, { paid_on: "2026-11-05" }), pay("z", 200, { paid_on: "2026-11-06" })], DAY)?.id).toBe("z");
    expect(carrierPayment(e, [pay("e1", 100, { is_voided: true })], DAY)).toBeNull();
  });
});

describe("isChangedReceipts", () => {
  const row = (over: object) => ({
    key: "clinic:2026-11-04:receipts",
    kind: "workbook_receipts",
    amount: 13_700_000,
    flags: { saved: true, savedAmount: 1_000_000 },
    ...over,
  });
  it("is true only for a saved clinic day total whose amount moved", () => {
    expect(isChangedReceipts(row({}))).toBe(true);
    expect(isChangedReceipts(row({ flags: { saved: true, savedAmount: 13_700_000 } }))).toBe(false);
    expect(isChangedReceipts(row({ flags: { saved: false, savedAmount: null } }))).toBe(false);
    expect(isChangedReceipts(row({ kind: "workbook_expense", key: "clinic:2026-11-04:expense:1" }))).toBe(false);
  });
});
