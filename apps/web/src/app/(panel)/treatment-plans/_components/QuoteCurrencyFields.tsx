"use client";

// Plan create / edit: quote currency and quote rate (spec p5 §2.3, §6.1 "Plan create and edit").
// The database trigger resolves the rate's source and day from quote_fx_rate_id; the client sends only the rate.

import { CURRENCIES, CURRENCY_LABELS, formatMoney, tryCents, type Currency } from "@/lib/payments";
import { FxRateInput, RateCheckBox, type RateField } from "./payment-ui";

export function QuoteCurrencyFields({
  currency,
  onCurrency,
  field,
  ratesLoading,
  ratesError,
  today,
  totalCents,
  currencyLocked,
  lockReason = "Ödeme alınmış planın para birimi değiştirilemez.",
  totalReinterpreted,
  rateChecked,
  onRateChecked,
  disabled,
}: {
  currency: Currency;
  onCurrency: (c: Currency) => void;
  field: RateField;
  ratesLoading: boolean;
  ratesError: string | null;
  today: string;
  /** current plan total in the plan currency, or null when it cannot be read */
  totalCents: number | null;
  /** the plan has payments (E_PLAN_CURRENCY_LOCKED) or items (E_PLAN_CURRENCY_ITEMS) */
  currencyLocked?: boolean;
  lockReason?: string;
  /** edit of a plan without items: the typed total keeps its number and is read in the new currency */
  totalReinterpreted?: boolean;
  rateChecked: boolean;
  onRateChecked: (v: boolean) => void;
  disabled?: boolean;
}) {
  const foreign = currency !== "TRY";
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-semibold mb-2" htmlFor="plan-currency">
          Para birimi
        </label>
        <select
          id="plan-currency"
          value={currency}
          disabled={disabled || currencyLocked}
          onChange={(e) => onCurrency(e.target.value as Currency)}
          className="w-full px-4 py-2 border rounded disabled:bg-gray-100"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {CURRENCY_LABELS[c]}
            </option>
          ))}
        </select>
        {currencyLocked && <p className="mt-1 text-xs text-gray-500">{lockReason}</p>}
        {totalReinterpreted && !currencyLocked && (
          <p className="mt-1 text-xs text-amber-700">
            Toplam tutar dönüştürülmez; aynı sayı yeni para biriminde okunur. Tutarı kontrol edin.
          </p>
        )}
        {foreign && !currencyLocked && (
          <p className="mt-1 text-xs text-gray-500">
            Plan kalemleri bu para biriminde fiyatlandırılır; katalogdaki TL fiyatları otomatik doldurulmaz.
          </p>
        )}
      </div>
      {foreign && (
        <>
          <FxRateInput
            label={`Teklif kuru (1 ${currency} = ? ₺)`}
            currency={currency}
            field={field}
            refDay={today}
            loading={ratesLoading}
            disabled={disabled}
            dayLabel="teklif gününün"
          />
          {ratesError && <p className="text-xs text-red-600">Kayıtlı kurlar okunamadı: {ratesError}</p>}
          {totalCents !== null && field.micro !== null && (
            <div className="p-3 rounded bg-gray-50 text-sm text-gray-800">
              Teklif TL karşılığı: {formatMoney(tryCents(totalCents, field.micro), "TRY")}
            </div>
          )}
          <RateCheckBox fields={[field]} checked={rateChecked} onChange={onRateChecked} disabled={disabled} />
        </>
      )}
    </div>
  );
}
