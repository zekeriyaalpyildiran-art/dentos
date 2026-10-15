"use client";

// Small modal used by the Phase 10 screens (team, patients archive). Full-height sheet on phones, Escape closes.

import { useEffect, type ReactNode } from "react";

export const pltInput =
  "w-full px-3 py-2 min-h-[44px] border rounded bg-white text-base text-gray-900 disabled:bg-gray-100 disabled:text-gray-500";
export const pltPrimary =
  "px-4 py-2 min-h-[44px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400";
export const pltSecondary =
  "px-4 py-2 min-h-[44px] border border-gray-300 text-gray-800 bg-white rounded hover:bg-gray-50 disabled:opacity-40";
export const pltDanger =
  "px-4 py-2 min-h-[44px] bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400";

export function Modal({
  title,
  children,
  footer,
  onClose,
  busy,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
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
        className="bg-white w-full sm:max-w-lg sm:mt-8 sm:rounded-lg shadow-xl text-gray-900 flex flex-col h-[100dvh] sm:h-auto sm:max-h-[95dvh]"
      >
        <div className="flex items-start justify-between gap-4 px-4 sm:px-6 py-4 border-b shrink-0">
          <h2 className="text-lg font-semibold">{title}</h2>
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
        <div className="px-4 sm:px-6 py-4 overflow-y-auto flex-1 space-y-4">{children}</div>
        {footer && <div className="px-4 sm:px-6 py-3 border-t bg-white shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

export function InlineMessage({
  tone,
  children,
  onClose,
}: {
  tone: "success" | "error" | "warn" | "info";
  children: ReactNode;
  onClose?: () => void;
}) {
  const cls =
    tone === "success"
      ? "bg-green-50 text-green-800 border-green-200"
      : tone === "error"
        ? "bg-red-50 text-red-700 border-red-200"
        : tone === "warn"
          ? "bg-amber-50 text-amber-900 border-amber-200"
          : "bg-blue-50 text-blue-900 border-blue-200";
  return (
    <div
      className={`p-3 rounded border text-sm flex items-start gap-3 ${cls}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <div className="flex-1">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Kapat">
          ✕
        </button>
      )}
    </div>
  );
}
