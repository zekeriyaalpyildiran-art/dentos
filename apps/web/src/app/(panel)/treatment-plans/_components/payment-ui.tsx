"use client";

// Small shared pieces of the patient payment screens (spec p5 §6.1–§6.3).

import { useEffect, useState } from "react";
import {
  CURRENCY_SYMBOLS,
  LEGACY_STATUS_LABELS,
  formatMoney,
  formatRate,
  microToInput,
  parseRate,
  ppFxRates,
  rateDiffPercent,
  rateFarOff,
  rateMicro,
  type Currency,
  type FxRateJson,
  type FxRatesJson,
  type PaymentJson,
} from "@/lib/payments";
import { formatDay, toFinanceError, type FinanceError } from "@/lib/finance";

/** "Ödendi" / "Eski kayıt: Bekliyor" / "İptal". */
export function PaymentStatusBadge({ payment }: { payment: PaymentJson }) {
  if (payment.voided_at) {
    return <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">İptal</span>;
  }
  const legacy = payment.legacy_status ?? (payment.status !== "paid" ? payment.status : null);
  if (legacy) {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">
        Eski kayıt: {LEGACY_STATUS_LABELS[legacy] ?? legacy}
      </span>
    );
  }
  if (!payment.counts) {
    return <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">Sayılmıyor</span>;
  }
  return <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Ödendi</span>;
}

/** "· ₺14.700,00 (1 EUR = 49,0000)" for a foreign payment; empty for TRY. */
export function tryPart(p: PaymentJson): string {
  if (p.currency === "TRY") return "";
  return `${formatMoney(p.amount_try_cents, "TRY")} (1 ${p.currency} = ${formatRate(p.fx_rate)})`;
}

/** "plana yansıyan €200,00 (1 EUR = 50,0000)" when the payment and plan currencies differ. */
export function appliedPart(p: PaymentJson): string {
  if (p.currency === p.plan_currency) return "";
  const rate = p.plan_currency === "TRY" ? "" : ` (1 ${p.plan_currency} = ${formatRate(p.plan_fx_rate)})`;
  return `plana yansıyan ${formatMoney(p.applied_plan_cents, p.plan_currency)}${rate}`;
}

/** Latest known rates on or before `on` (pp_fx_rates); refetched when the day changes, only while `enabled`. */
export function useFxRates(on: string | null, enabled: boolean) {
  const [data, setData] = useState<FxRatesJson | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FinanceError | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    ppFxRates(on)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setData(null);
        setError(toFinanceError(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [on, enabled]);

  const of = (currency: Currency): FxRateJson | null =>
    currency === "TRY" ? null : data?.rates.find((r) => r.currency === currency) ?? null;
  return { data, loading, error, of };
}

/**
 * One editable rate field, prefilled from the suggestion until the user types. `reset()` re-applies the suggestion
 * (call it when the currency changes). The suggestion's id is always sent; the server marks an edited rate 'entered'.
 */
export function useRateField(suggestion: FxRateJson | null) {
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const sugRate = suggestion?.rate ?? null;

  useEffect(() => {
    if (edited) return;
    const m = rateMicro(sugRate);
    setText(m !== null ? microToInput(m) : "");
  }, [sugRate, edited]);

  const parsed = parseRate(text);
  const sugMicro = rateMicro(sugRate);
  const diff = parsed.ok && sugMicro !== null ? rateDiffPercent(parsed.micro, sugMicro) : 0;
  return {
    text,
    setText: (v: string) => {
      setText(v);
      setEdited(true);
    },
    reset: () => setEdited(false),
    edited,
    parsed,
    micro: parsed.ok ? parsed.micro : null,
    suggestion,
    /** |difference from the suggestion| > 10 % (exact; the server refuses it for staff without owner / finance) */
    farOff: parsed.ok && sugMicro !== null ? rateFarOff(parsed.micro, sugMicro) : false,
    diff,
  };
}

export type RateField = ReturnType<typeof useRateField>;

/** Rate input with the suggestion line and notes (§6.1). */
export function FxRateInput({
  label,
  currency,
  field,
  refDay,
  loading,
  disabled,
  dayLabel = "ödeme gününün",
  restricted = false,
}: {
  label: string;
  currency: Currency;
  field: RateField;
  /** the day the rate is for (payment day / quote day) */
  refDay: string;
  loading?: boolean;
  disabled?: boolean;
  dayLabel?: string;
  /** payment rates of staff without owner / finance rights: a registered rate is required (E_FX_NO_REF) */
  restricted?: boolean;
}) {
  const s = field.suggestion;
  const sugMicro = rateMicro(s?.rate ?? null);
  const showError = field.text.trim() !== "" && !field.parsed.ok;
  return (
    <div>
      <label className="block text-sm font-semibold mb-2" htmlFor={`fx-${label}`}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600 whitespace-nowrap">1 {currency} =</span>
        <input
          id={`fx-${label}`}
          type="text"
          inputMode="decimal"
          value={field.text}
          disabled={disabled}
          onChange={(e) => field.setText(e.target.value)}
          className="w-full px-4 py-2 border rounded"
          placeholder="0,0000"
          autoComplete="off"
        />
        <span className="text-sm text-gray-600">₺</span>
      </div>
      {loading ? (
        <p className="mt-1 text-xs text-gray-500">Kayıtlı kur aranıyor...</p>
      ) : s && sugMicro !== null ? (
        <>
          <p className="mt-1 text-xs text-gray-500">
            Önerilen: {formatRate(s.rate)} · {formatDay(s.rate_on)} · {sourceText(s.source)}
            {field.edited && field.micro !== sugMicro && (
              <>
                {" "}
                ·{" "}
                <button type="button" className="text-blue-600 hover:underline" onClick={field.reset} disabled={disabled}>
                  Önerileni kullan
                </button>
              </>
            )}
          </p>
          {s.rate_on < refDay && (
            <p className="mt-1 text-xs text-amber-700">
              Bu kur {formatDay(s.rate_on)} tarihli; {dayLabel} kurunu kontrol edin.
            </p>
          )}
        </>
      ) : restricted ? (
        <p className="mt-1 text-xs text-red-600">
          Kayıtlı {currency} kuru yok. Kuru klinik sahibi veya finans yetkilisi Finans ayarları &gt; Döviz kurları
          ekranından kaydetmeli.
        </p>
      ) : (
        <p className="mt-1 text-xs text-amber-700">Kayıtlı kur yok; kuru girin.</p>
      )}
      {showError && !field.parsed.ok && <p className="mt-1 text-xs text-red-600">{field.parsed.error}</p>}
    </div>
  );
}

function sourceText(source: string): string {
  if (source === "workbook") return "Klinik Excel'i";
  if (source === "manual") return "Elle girilen kur";
  return "Kayıtlı kur";
}

/**
 * Rate sanity confirmation. Owner / finance (and plan quotes) confirm with a checkbox; for other staff a payment rate
 * more than 10 % away from the registered rate is refused by the server (E_FX_RANGE), so no checkbox is offered.
 */
export function RateCheckBox({
  fields,
  checked,
  onChange,
  disabled,
  restricted = false,
}: {
  fields: RateField[];
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  restricted?: boolean;
}) {
  const far = fields.filter((f) => f.farOff);
  if (!far.length) return null;
  if (restricted) {
    return (
      <div className="p-3 rounded bg-red-50 text-red-700 text-sm">
        {far.map((f, i) => (
          <p key={i}>Önerilen kurdan %{Math.round(Math.abs(f.diff)).toLocaleString("tr-TR")} farklı.</p>
        ))}
        <p className="mt-1">
          Kayıtlı kurdan %10&apos;dan fazla farklı kuru yalnızca klinik sahibi veya finans yetkilisi kaydedebilir.
          Önerilen kuru kullanın.
        </p>
      </div>
    );
  }
  return (
    <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm">
      {far.map((f, i) => (
        <p key={i}>Önerilen kurdan %{Math.round(Math.abs(f.diff)).toLocaleString("tr-TR")} farklı.</p>
      ))}
      <label className="flex items-center gap-2 mt-2">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        Kuru kontrol ettim
      </label>
    </div>
  );
}

export const currencySymbol = (c: Currency) => CURRENCY_SYMBOLS[c];
