"use client";

// Small UI kit of the clinical screens (spec p9_clinical §7.0): 44 px tap targets, 16 px inputs (no iOS zoom),
// dialogs that become full-height sheets on phones. Own copy, so components/stock (another workflow) is not touched.

import { useEffect, type ReactNode } from "react";
import { RELOAD_KEYS, isClinicalModuleMissing, type ClinicalError } from "@/lib/clinical/rpc";
import { NO_PATIENT_TEXT_HINT } from "@/lib/clinical/codes";

export const clinInput =
  "w-full px-3 py-2 min-h-[44px] border rounded bg-white text-base text-gray-900 disabled:bg-gray-100 disabled:text-gray-500";
export const clinPrimary =
  "px-4 py-2 min-h-[44px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400";
export const clinSecondary =
  "px-4 py-2 min-h-[44px] border border-gray-300 text-gray-800 bg-white rounded hover:bg-gray-50 disabled:opacity-40";
export const clinDanger =
  "px-4 py-2 min-h-[44px] border border-red-300 text-red-600 bg-white rounded hover:bg-red-50 disabled:opacity-40";
export const clinLink = "text-blue-700 hover:underline";

export const SAVING_LABEL = "Kaydediliyor…";

export function Field({
  label,
  required,
  hint,
  children,
  className = "",
  group,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Several controls (buttons, pickers): a <div role="group"> instead of a <label>. */
  group?: boolean;
}) {
  const body = (
    <>
      <span className="block text-sm font-semibold mb-1 text-gray-800">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </>
  );
  if (group) {
    return (
      <div role="group" className={`block ${className}`}>
        {body}
      </div>
    );
  }
  return <label className={`block ${className}`}>{body}</label>;
}

/** KVKK helper under free-text fields. */
export function NoPatientTextHint() {
  return <>{NO_PATIENT_TEXT_HINT}</>;
}

export function ErrorBox({ error, onReload }: { error: ClinicalError | null; onReload?: () => void }) {
  if (!error) return null;
  const showReload = !!onReload && (error.isConflict || (error.key !== null && RELOAD_KEYS.has(error.key)));
  return (
    <div className="p-3 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3" role="alert">
      <span className="flex-1 min-w-[12rem]">{error.message}</span>
      {showReload && (
        <button
          type="button"
          onClick={onReload}
          className="px-3 py-1 min-h-[44px] rounded border border-red-300 bg-white hover:bg-red-100"
        >
          Yenile
        </button>
      )}
    </div>
  );
}

/** One notice instead of broken screens when the web build is ahead of migration 0026_clinical_implants_lab (§7.0). */
export function ClinicalNotice({ error }: { error: ClinicalError | null }) {
  if (!error) return null;
  if (isClinicalModuleMissing(error)) {
    return (
      <div className="p-4 rounded border border-amber-200 bg-amber-50 text-amber-900 text-sm" role="status">
        Klinik modülü güncelleniyor. Birkaç dakika sonra sayfayı yenileyin.
      </div>
    );
  }
  return <ErrorBox error={error} />;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "danger" | "success"; children: ReactNode }) {
  const cls =
    tone === "warn"
      ? "bg-amber-50 text-amber-900 border-amber-200"
      : tone === "danger"
        ? "bg-red-50 text-red-800 border-red-200"
        : tone === "success"
          ? "bg-green-50 text-green-800 border-green-200"
          : "bg-blue-50 text-blue-900 border-blue-200";
  return <div className={`p-3 rounded border text-sm ${cls}`}>{children}</div>;
}

export function Badge({ className, children, title }: { className: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="py-10 text-center text-gray-600">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-gray-500">{children}</div>}
    </div>
  );
}

export function Loading() {
  return <p className="text-gray-500 py-4">Yükleniyor...</p>;
}

export function StatTile({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "red" | "amber" | "green";
  active?: boolean;
  onClick?: () => void;
}) {
  const valueColor =
    tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-green-700" : "text-gray-900";
  const cls = `bg-white p-4 rounded-lg shadow text-left min-h-[44px] ${active ? "ring-2 ring-blue-500" : ""}`;
  const body = (
    <>
      <div className="text-sm text-gray-600">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${valueColor}`}>{value}</div>
    </>
  );
  if (!onClick) return <div className={cls}>{body}</div>;
  return (
    <button type="button" onClick={onClick} className={`${cls} hover:ring-2 hover:ring-blue-200`} aria-pressed={active}>
      {body}
    </button>
  );
}

/** Dialog; a full-height sheet on phones. Escape and the backdrop close it unless `busy`. */
export function Sheet({
  title,
  description,
  children,
  footer,
  onClose,
  busy,
  wide,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-start justify-center bg-black/40 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`bg-white w-full ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"} sm:mt-8 sm:rounded-lg shadow-xl text-gray-900 flex flex-col h-[100dvh] sm:h-auto sm:max-h-[95dvh]`}
      >
        <div className="flex items-start justify-between gap-4 px-4 sm:px-6 py-4 border-b shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="text-sm text-gray-600 mt-0.5">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-500 hover:text-gray-800 disabled:opacity-40 min-w-[44px] min-h-[44px] -mr-2 -mt-2"
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>
        <div className="px-4 sm:px-6 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-4 sm:px-6 py-3 border-t bg-white shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

export function Toast({ text, onDone }: { text: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [text, onDone]);
  if (!text) return null;
  return (
    <div
      role="status"
      className="fixed z-[60] bottom-4 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)] px-4 py-3 rounded-lg bg-gray-900 text-white text-sm shadow-lg"
    >
      {text}
    </div>
  );
}

/** "Daha fazla göster" pager (§7.3). */
export function MoreButton({
  shown,
  total,
  busy,
  onMore,
}: {
  shown: number;
  total: number;
  busy?: boolean;
  onMore: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div className="flex flex-col items-center gap-1 mt-4">
      <button type="button" className={clinSecondary} disabled={busy} onClick={onMore}>
        {busy ? "Yükleniyor..." : "Daha fazla göster"}
      </button>
      <span className="text-xs text-gray-500">
        {shown} / {total} kayıt
      </span>
    </div>
  );
}
