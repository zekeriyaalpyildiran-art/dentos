"use client";

import { useEffect, useState } from "react";
import { formatMonth } from "@/lib/finance";
import { monthInBounds, monthOptions, nativeMonthSupported } from "@/lib/month-input";

/**
 * Month picker that works in every browser. Where the browser has a month picker it is used as before; a partly typed
 * value is kept locally until it is a complete month, so typing never snaps back. Desktop Safari has no month picker
 * (it shows a text box), so there a list of months ("Kasım 2026") is shown instead.
 *
 * `onChange` receives only complete months inside min..max, or "" when `allowEmpty` and the field is cleared.
 */
export function MonthInput({
  value,
  onChange,
  min,
  max,
  disabled,
  required,
  allowEmpty,
  emptyLabel = "Tümü",
  className = "px-3 py-2 border rounded bg-white text-gray-900 disabled:bg-gray-100",
  ariaLabel,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  className?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const [native, setNative] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    setNative(nativeMonthSupported());
  }, []);

  if (!native) {
    const options = monthOptions(value, min, max);
    return (
      <select
        id={id}
        aria-label={ariaLabel}
        className={className}
        value={value}
        disabled={disabled}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowEmpty ? (
          <option value="">{emptyLabel}</option>
        ) : (
          !value && (
            <option value="" disabled>
              Ay seçin
            </option>
          )
        )}
        {options.map((m) => (
          <option key={m} value={m}>
            {formatMonth(m)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      id={id}
      aria-label={ariaLabel}
      type="month"
      className={className}
      value={draft ?? value}
      min={min}
      max={max}
      disabled={disabled}
      required={required}
      placeholder="YYYY-AA"
      onChange={(e) => {
        const v = e.target.value;
        if (v === "" && allowEmpty) {
          setDraft(null);
          onChange("");
        } else if (monthInBounds(v, min, max)) {
          setDraft(null);
          onChange(v);
        } else {
          setDraft(v);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
