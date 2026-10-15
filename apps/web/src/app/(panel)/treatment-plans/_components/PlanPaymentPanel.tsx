"use client";

// Plan detail payment panel (spec p5 §6.1): 'Ödeme Özeti', the payment form and 'Ödeme Geçmişi'.
// Everything comes from pp_plan_account and is refreshed after each write; payments are recorded only through
// pp_record_payment (received_by and the plan's patient are stamped by the server).

import { useCallback, useEffect, useState } from "react";
import { formatDay, newId, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  CURRENCIES,
  CURRENCY_LABELS,
  CURRENCY_SYMBOLS,
  METHOD_LABELS,
  PAYMENT_METHODS,
  formatMoney,
  formatRate,
  maxPayable,
  microToText,
  parseMoney,
  paymentMath,
  ppPlanAccount,
  ppRecordPayment,
  type Currency,
  type PaymentJson,
  type PaymentMethod,
  type PlanAccountJson,
} from "@/lib/payments";
import { PaymentHistory } from "./PaymentHistory";
import { VoidPaymentDialog } from "./VoidPaymentDialog";
import { FxRateInput, RateCheckBox, useFxRates, useRateField } from "./payment-ui";

export function PlanPaymentPanel({
  planId,
  onAccount,
  refreshKey = 0,
}: {
  planId: string;
  /** Bumped by the plan page after it changes the plan (items, total) so the figures reload. */
  refreshKey?: number;
  /** Called with every freshly loaded account (the plan page uses applied_cents and the currency). */
  onAccount?: (account: PlanAccountJson | null) => void;
}) {
  const [account, setAccount] = useState<PlanAccountJson | null>(null);
  const [loadError, setLoadError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const acc = await ppPlanAccount(planId);
      setAccount(acc);
      setLoadError(null);
    } catch (err) {
      setLoadError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    onAccount?.(account);
  }, [account, onAccount]);

  // --- form state ----------------------------------------------------------------------------------
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [paidOn, setPaidOn] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [rateChecked, setRateChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<FinanceError | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<PaymentJson | null>(null);

  // The id is created when the panel opens and after each success; a retry of the same form reuses it.
  useEffect(() => {
    setPaymentId(newId());
  }, []);

  const planCur: Currency = account?.plan.currency ?? "TRY";
  const payCur: Currency = currency ?? planCur;
  const today = account?.today ?? "";
  const day = paidOn ?? today;
  const needFx = payCur !== "TRY";
  const needPlanFx = planCur !== "TRY" && planCur !== payCur;

  const rates = useFxRates(day || null, !!account && (needFx || needPlanFx));
  const fxField = useRateField(needFx ? rates.of(payCur) : null);
  const planFxField = useRateField(needPlanFx ? rates.of(planCur) : null);

  // Any change of currency or day re-applies the suggested rates.
  const resetRates = () => {
    fxField.reset();
    planFxField.reset();
    setRateChecked(false);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">Ödemeler yükleniyor...</p>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-xl font-bold mb-2">Ödeme Özeti</h3>
        <p className="text-sm text-red-600">{loadError?.message ?? "Ödeme bilgileri yüklenemedi."}</p>
        <button type="button" className="mt-3 text-sm text-blue-600 hover:underline" onClick={() => void load()}>
          Tekrar dene
        </button>
      </div>
    );
  }

  const { plan, totals } = account;
  const remaining = totals.remaining_cents;
  const cancelled = plan.status === "cancelled";

  // --- preview (§4.1 helpers, recalculated on every keystroke) ---------------------------------------
  const amount = amountText.trim() === "" ? null : parseMoney(amountText, payCur);
  const fxMicro = needFx ? fxField.micro : null;
  const planFxMicro = needPlanFx ? planFxField.micro : planCur === payCur ? fxMicro : null;
  const math = amount?.ok ? paymentMath(amount.cents, payCur, planCur, fxMicro, planFxMicro) : null;
  const over = !!math && math.applied_cents > remaining;
  const maxPay = over ? maxPayable(remaining, payCur, planCur, fxMicro, planFxMicro) : null;
  const rateFields = [...(needFx ? [fxField] : []), ...(needPlanFx ? [planFxField] : [])];
  const rateCheckNeeded = rateFields.some((f) => f.farOff);
  // Staff without owner / finance rights need a registered rate and may differ from it by at most 10 % (the server
  // refuses otherwise: E_FX_NO_REF / E_FX_RANGE). can_void is that same predicate (pp_can_void).
  const restrictedRates = !account.can_void;
  const rateBlocked =
    restrictedRates && (rates.loading || rateFields.some((f) => !f.suggestion || f.farOff));
  const tooSmall = !!math && (math.try_cents < 1 || math.applied_cents < 1);
  const noteTooLong = note.trim().length > 500;
  const canSubmit =
    !busy &&
    !!paymentId &&
    !!amount?.ok &&
    !!math &&
    !over &&
    !tooSmall &&
    !noteTooLong &&
    !rateBlocked &&
    (!rateCheckNeeded || rateChecked);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !amount?.ok || !paymentId) return;
    setBusy(true);
    setMessage(null);
    setFormError(null);
    try {
      const res = await ppRecordPayment({
        id: paymentId,
        planId: plan.id,
        amountCents: amount.cents,
        currency: payCur,
        method,
        paidOn: account.can_backdate && paidOn && paidOn !== today ? paidOn : null,
        fxRate: needFx && fxMicro !== null ? microToText(fxMicro) : null,
        fxRateId: needFx ? fxField.suggestion?.id ?? null : null,
        planFxRate: needPlanFx && planFxMicro !== null ? microToText(planFxMicro) : null,
        planFxRateId: needPlanFx ? planFxField.suggestion?.id ?? null : null,
        note: note.trim() || null,
      });
      setMessage(res.already_saved ? "Bu ödeme zaten kaydedilmişti." : "Ödeme kaydedildi.");
      setAmountText("");
      setNote("");
      // Back to today and the suggested rates, so a back-dated entry is not silently repeated on the next payment.
      setPaidOn(null);
      resetRates();
      setPaymentId(newId());
      await load();
    } catch (err) {
      const fe = toFinanceError(err);
      setFormError(fe);
      // The id belongs to another record: start a new one. Server answers refresh the figures (e.g. E_OVERPAY).
      if (fe.isConflict) setPaymentId(newId());
      if (fe.code) await load();
    } finally {
      setBusy(false);
    }
  };

  const foreignInvolved = planCur !== "TRY" || totals.by_currency.some((c) => c.currency !== "TRY");
  const est = totals.remaining_try_estimate;

  return (
    <>
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-xl font-bold mb-4">Ödeme Özeti</h3>

        <div className="mb-4 pb-4 border-b space-y-2 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">Toplam Tutar:</span>
            <span className="font-semibold text-base">{formatMoney(plan.total_cents, planCur)}</span>
          </div>
          {planCur !== "TRY" && (
            <p className="text-xs text-gray-500 text-right">
              Teklif TL: {formatMoney(plan.quote_total_try_cents, "TRY")} · kur {formatRate(plan.quote_fx_rate)}
              {plan.quote_fx_on ? ` (${formatDay(plan.quote_fx_on)})` : ""}
            </p>
          )}
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">Tahsil edilen (plana yansıyan):</span>
            <span className="font-semibold text-green-700">{formatMoney(totals.applied_cents, planCur)}</span>
          </div>
          {remaining < 0 ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">Fazla ödeme:</span>
              <span className="text-lg font-bold text-amber-700">{formatMoney(-remaining, planCur)}</span>
            </div>
          ) : (
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">Kalan:</span>
              <span className={`text-lg font-bold ${remaining > 0 ? "text-red-600" : "text-gray-900"}`}>
                {formatMoney(remaining, planCur)}
              </span>
            </div>
          )}
          {foreignInvolved && totals.by_currency.length > 0 && (
            <div>
              <div className="text-gray-600">Para birimine göre tahsilat:</div>
              <ul className="mt-1 space-y-0.5">
                {totals.by_currency.map((c) => (
                  <li key={c.currency} className="flex justify-between gap-2">
                    <span className="text-gray-500">
                      {CURRENCY_LABELS[c.currency] ?? c.currency} · {c.count} ödeme
                    </span>
                    <span className="font-semibold">{formatMoney(c.amount_cents, c.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {foreignInvolved && (
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">Tahsilat TL karşılığı (ödeme günlerinin kuruyla):</span>
              <span className="font-semibold">{formatMoney(totals.collected_try_cents, "TRY")}</span>
            </div>
          )}
          {planCur !== "TRY" && remaining > 0 && (
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">
                Kalan ≈{" "}
                {est ? (
                  <span className="text-xs text-gray-500">
                    (güncel kur {formatRate(est.rate)} · {formatDay(est.rate_on)})
                  </span>
                ) : null}
              </span>
              <span className="font-semibold">
                {est ? `≈ ${formatMoney(est.cents, "TRY")}` : <span className="text-xs text-amber-700">Güncel kur kayıtlı değil</span>}
              </span>
            </div>
          )}
          {totals.legacy_count > 0 && (
            <p className="text-xs text-gray-500">
              {totals.legacy_count} eski kayıt (ödendi dışı durum) toplamlara katılmaz.
            </p>
          )}
        </div>

        {message && <p className="mb-4 text-sm text-green-700">{message}</p>}

        {cancelled ? (
          <p className="text-sm text-gray-600">İptal edilmiş plana ödeme eklenemez.</p>
        ) : plan.total_cents === 0 ? (
          <p className="text-sm text-gray-600">Plana işlem eklenmeden ödeme alınamaz.</p>
        ) : remaining > 0 ? (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-2" htmlFor="pay-amount">
                Ödeme Tutarı
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="pay-amount"
                  type="text"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  className="w-full px-4 py-2 border rounded"
                  placeholder="0,00"
                  autoComplete="off"
                  disabled={busy}
                  required
                />
                <span className="text-gray-600">{CURRENCY_SYMBOLS[payCur]}</span>
              </div>
              {amount && !amount.ok && <p className="mt-1 text-xs text-red-600">{amount.error}</p>}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2" htmlFor="pay-currency">
                Para Birimi
              </label>
              <select
                id="pay-currency"
                value={payCur}
                disabled={busy}
                onChange={(e) => {
                  setCurrency(e.target.value as Currency);
                  resetRates();
                }}
                className="w-full px-4 py-2 border rounded"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2" htmlFor="pay-method">
                Ödeme Yöntemi
              </label>
              <select
                id="pay-method"
                value={method}
                disabled={busy}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                className="w-full px-4 py-2 border rounded"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
              {method === "card" && (
                <p className="mt-2 text-xs text-gray-500">Kart ödemesi POS cihazında alındıktan sonra kaydedilir.</p>
              )}
              {method === "financing" && (
                <p className="mt-2 text-xs text-gray-500">
                  Banka kredisiyle ödenen tutar. Finansman kesintileri Finans &gt; Hasta finansmanı ekranından izlenir.
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2" htmlFor="pay-date">
                Ödeme Tarihi
              </label>
              {account.can_backdate ? (
                <input
                  id="pay-date"
                  type="date"
                  value={day}
                  max={today}
                  disabled={busy}
                  onChange={(e) => {
                    setPaidOn(e.target.value || null);
                    resetRates();
                  }}
                  className="w-full px-4 py-2 border rounded"
                />
              ) : (
                <>
                  <div className="text-sm text-gray-800">Bugün · {formatDay(today)}</div>
                  <p className="mt-1 text-xs text-gray-500">
                    Geçmiş tarihli ödemeyi klinik sahibi veya finans yetkilisi girer.
                  </p>
                </>
              )}
            </div>

            {needFx && (
              <FxRateInput
                label={`Kur (1 ${payCur} = ? ₺)`}
                currency={payCur}
                field={fxField}
                refDay={day}
                loading={rates.loading}
                disabled={busy}
                restricted={restrictedRates}
              />
            )}
            {needPlanFx && (
              <FxRateInput
                label={`Plan kuru (1 ${planCur} = ? ₺)`}
                currency={planCur}
                field={planFxField}
                refDay={day}
                loading={rates.loading}
                disabled={busy}
                restricted={restrictedRates}
              />
            )}
            {rates.error && (needFx || needPlanFx) && (
              <p className="text-xs text-red-600">Kayıtlı kurlar okunamadı: {rates.error.message}</p>
            )}

            {math && (
              <div
                className={`p-3 rounded text-sm space-y-1 ${over ? "bg-red-50 text-red-700" : "bg-gray-50 text-gray-800"}`}
              >
                {payCur !== "TRY" && <div>TL karşılığı: {formatMoney(math.try_cents, "TRY")}</div>}
                {payCur !== planCur && <div>Plana yansıyan: {formatMoney(math.applied_cents, planCur)}</div>}
                {over ? (
                  <div className="font-semibold">
                    Kalan tutarı aşıyor.{maxPay !== null ? ` En fazla: ${formatMoney(maxPay, payCur)}` : ""}
                  </div>
                ) : tooSmall ? (
                  <div className="font-semibold text-red-700">Tutar, kur dönüşümünden sonra en az 0,01 olmalı.</div>
                ) : (
                  <div>Ödeme sonrası kalan: {formatMoney(remaining - math.applied_cents, planCur)}</div>
                )}
              </div>
            )}

            <RateCheckBox
              fields={rateFields}
              checked={rateChecked}
              onChange={setRateChecked}
              disabled={busy}
              restricted={restrictedRates}
            />

            <div>
              <label className="block text-sm font-semibold mb-2" htmlFor="pay-note">
                Not
              </label>
              <input
                id="pay-note"
                type="text"
                value={note}
                maxLength={500}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
                className="w-full px-4 py-2 border rounded"
                placeholder="Ödeme açıklaması"
              />
            </div>

            {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError.message}</div>}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
            >
              {busy ? "İşleniyor..." : "Ödeme Yap"}
            </button>
          </form>
        ) : remaining === 0 ? (
          <p className="text-sm text-green-700">Plan tamamen ödendi.</p>
        ) : null}
      </div>

      <PaymentHistory
        payments={account.payments}
        canVoid={account.can_void}
        showVoided={showVoided}
        onToggleVoided={setShowVoided}
        voidedCount={totals.voided_count}
        onVoid={setVoiding}
        truncated={account.truncated}
      />

      {voiding && (
        <VoidPaymentDialog
          payment={voiding}
          onClose={() => setVoiding(null)}
          onVoided={(res) => {
            setVoiding(null);
            setMessage(res.already_saved ? "Bu ödeme zaten iptal edilmişti." : "Ödeme iptal edildi.");
            void load();
          }}
        />
      )}
    </>
  );
}
