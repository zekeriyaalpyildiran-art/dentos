"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import {
  STATUS_LABELS,
  formatTL,
  type EntryStatus,
  type FinanceError,
  type ListTotalsJson,
} from "@/lib/finance";

export const inputClass =
  "w-full px-3 py-2 border rounded bg-white text-gray-900 disabled:bg-gray-100 disabled:text-gray-500";
export const buttonPrimary =
  "px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400";
export const buttonSecondary =
  "px-4 py-2 border border-gray-300 text-gray-800 rounded hover:bg-gray-50 disabled:opacity-40";
export const buttonDanger =
  "px-4 py-2 border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-40";

export function Card({
  title,
  children,
  actions,
  className = "",
}: {
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white p-6 rounded-lg shadow text-gray-900 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 mb-4">
          {title && <h2 className="text-lg font-semibold text-gray-900">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** One label / money line inside a card. */
export function MoneyRow({
  label,
  cents,
  hint,
  strong,
  tone,
}: {
  label: ReactNode;
  cents: number | null | undefined;
  hint?: ReactNode;
  strong?: boolean;
  tone?: "auto" | "green" | "red";
}) {
  let color = "text-gray-900";
  if (tone === "green") color = "text-green-700";
  else if (tone === "red") color = "text-red-600";
  else if (tone === "auto" && typeof cents === "number") {
    color = cents < 0 ? "text-red-600" : "text-green-700";
  }
  return (
    <div className="flex justify-between gap-4 py-2 border-b last:border-b-0">
      <div>
        <div className={strong ? "font-semibold text-gray-900" : "text-gray-700"}>{label}</div>
        {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
      </div>
      <div className={`text-right whitespace-nowrap tabular-nums ${strong ? "font-semibold" : ""} ${color}`}>
        {formatTL(cents)}
      </div>
    </div>
  );
}

export function ErrorBox({
  error,
  onReload,
  backHref,
}: {
  error: FinanceError | null;
  /** PT409 (version conflict): "Yenile" reloads the record. */
  onReload?: () => void;
  backHref?: string;
}) {
  if (!error) return null;
  return (
    <div className="p-4 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3">
      <span className="flex-1 min-w-[12rem]">{error.message}</span>
      {error.isConflict && onReload && (
        <button type="button" onClick={onReload} className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100">
          Yenile
        </button>
      )}
      {error.isNotFound && backHref && (
        <Link href={backHref} className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100">
          Listeye dön
        </Link>
      )}
    </div>
  );
}

export function SuccessBox({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="p-4 rounded bg-green-50 text-green-800 text-sm">{text}</div>;
}

export function Loading() {
  return <p className="text-gray-500">Yükleniyor...</p>;
}

export function StatusBadge({ status, overdue }: { status: EntryStatus; overdue?: boolean }) {
  const cls =
    status === "cancelled"
      ? "bg-gray-200 text-gray-700"
      : status === "completed"
        ? "bg-green-100 text-green-800"
        : overdue
          ? "bg-red-100 text-red-700"
          : "bg-amber-100 text-amber-800";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status === "open" && overdue ? "Vadesi geçti" : STATUS_LABELS[status]}
    </span>
  );
}

export function Pager({
  offset,
  limit,
  total,
  onChange,
  disabled,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
  disabled?: boolean;
}) {
  if (total <= limit && offset === 0) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between gap-4 mt-4 text-sm text-gray-700">
      <span>
        {from}–{to} / {total} kayıt
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonSecondary}
          disabled={disabled || offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          ← Önceki
        </button>
        <button
          type="button"
          className={buttonSecondary}
          disabled={disabled || offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Sonraki →
        </button>
      </div>
    </div>
  );
}

/** Legacy FP:51 totals box: always the server's totals over every matched row, never only the page. */
export function ListTotalsBox({ totals, note }: { totals: ListTotalsJson; note?: boolean }) {
  return (
    <div className="mt-4 bg-gray-50 border rounded-lg p-4 text-gray-900">
      <h3 className="font-semibold mb-2">Listedeki {totals.count.toLocaleString("tr-TR")} kaydın toplamı</h3>
      <div className="grid gap-x-8 md:grid-cols-2">
        <MoneyRow label="Gerçekleşen harcama / ödeme" cents={totals.outgoing_cents} />
        <MoneyRow label="Gerçekleşen tahsilat / giriş" cents={totals.incoming_cents} />
        <MoneyRow label="Kalan ödeme / borç" cents={totals.open_outgoing_cents} />
        <MoneyRow label="Beklenen tahsilat" cents={totals.open_incoming_cents} />
        <MoneyRow label="Net gerçekleşen (giriş − çıkış)" cents={totals.net_cents} tone="auto" strong />
      </div>
      {note !== false && (
        <p className="text-xs text-gray-500 mt-2">
          Gerçekleşen tutarlar bu kayıtların bugüne kadarki tüm ödemelerini kapsar. Toplam dışı
          bırakılan kayıtların ödemeleri gerçekleşen tutarlara katılmaz; kalan tutarları dahildir.
        </p>
      )}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
  className = "",
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-sm font-semibold mb-1 text-gray-800">{label}</span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

/** Minimal modal dialog. Escape and the backdrop close it unless `busy`. */
export function Modal({
  title,
  children,
  onClose,
  busy,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`bg-white rounded-lg shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-lg"} mt-12 text-gray-900`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-500 hover:text-gray-800 disabled:opacity-40"
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
