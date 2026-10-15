"use client";

// FDI tooth picker (spec p9_clinical §7.1 field 8): 4 quadrant rows in the dentist's view plus a text input.
// Teeth with a live implant of the patient are filled and disabled. Also used read-only as the patient's mini chart.

import { FDI_ROWS, parseFdi } from "@/lib/clinical/fdi";
import { IMPLANT_STATUS_LABELS, IMPLANT_STATUS_STYLES, type ImplantStatus } from "@/lib/clinical/codes";

export interface OccupiedTooth {
  tooth: number;
  status?: ImplantStatus;
  label?: string;
}

export function ToothPicker({
  value,
  onChange,
  occupied,
  disabled,
  readOnly,
}: {
  value: string;
  onChange?: (tooth: string) => void;
  occupied: OccupiedTooth[];
  disabled?: boolean;
  /** Chart only: no input, buttons not clickable. */
  readOnly?: boolean;
}) {
  const byTooth = new Map(occupied.map((o) => [o.tooth, o]));
  const selected = parseFdi(value);

  const cell = (t: number) => {
    const occ = byTooth.get(t);
    const isSelected = selected === t;
    const statusCls = occ?.status ? IMPLANT_STATUS_STYLES[occ.status] : "bg-gray-300 text-gray-700";
    const cls = isSelected
      ? "bg-blue-600 text-white border-blue-700"
      : occ
        ? `${statusCls} border-transparent`
        : "bg-white text-gray-800 border-gray-300 hover:bg-blue-50";
    const title = occ
      ? readOnly
        ? `Diş ${t}${occ.status ? ` · ${IMPLANT_STATUS_LABELS[occ.status]}` : ""}${occ.label ? ` · ${occ.label}` : ""}`
        : "Bu dişte etkin implant var"
      : `Diş ${t}`;
    if (readOnly) {
      return (
        <span key={t} title={title} className={`flex items-center justify-center h-9 rounded border text-sm tabular-nums ${cls}`}>
          {t}
        </span>
      );
    }
    return (
      <button
        key={t}
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={isSelected}
        disabled={disabled || (!!occ && !isSelected)}
        onClick={() => onChange?.(String(t))}
        className={`h-11 rounded border text-sm tabular-nums disabled:cursor-not-allowed ${cls}`}
      >
        {t}
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1 overflow-x-auto">
        {FDI_ROWS.map(([right, left], i) => (
          <div key={i} className={`grid grid-cols-[repeat(16,minmax(2.1rem,1fr))] gap-1 min-w-[34rem] ${i === 1 ? "pt-1 border-t border-dashed" : ""}`}>
            {right.map(cell)}
            {left.map(cell)}
          </div>
        ))}
      </div>
      {!readOnly && (
        <input
          className="w-28 px-3 py-2 min-h-[44px] border rounded bg-white text-base text-gray-900 disabled:bg-gray-100"
          inputMode="numeric"
          maxLength={2}
          placeholder="Örn. 36"
          aria-label="Diş numarası (FDI)"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 2);
            onChange?.(v);
          }}
        />
      )}
    </div>
  );
}
