"use client";

import { useEffect, useId, type ReactNode } from "react";
import { TRACKING_INFO, MOVEMENT_STYLES, movementLabel, type TrackingLevel } from "@/lib/stock/codes";
import { daysLeft, expiryLabel, expiryTone } from "@/lib/stock/expiry";
import { formatDay } from "@/lib/finance";
import { formatQty } from "@/lib/stock/units";
import { RELOAD_KEYS, type StockError } from "@/lib/stock/rpc";

export {
  Card,
  Field,
  Loading,
  Pager,
  SuccessBox,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
export { formatDay, formatTimestamp, formatTL } from "@/lib/finance";

/** Inputs on stock forms use 16px text so iOS does not zoom (p7_rules_ui §20.0). */
export const stockInput =
  "w-full px-3 py-2 border rounded bg-white text-base text-gray-900 disabled:bg-gray-100 disabled:text-gray-500";
export const bigPrimary =
  "w-full h-12 px-4 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400";

export function StockErrorBox({
  error,
  onReload,
  reloadLabel = "Yenile",
}: {
  error: StockError | null;
  onReload?: () => void;
  reloadLabel?: string;
}) {
  if (!error) return null;
  const showReload = !!onReload && (error.isConflict || (error.key !== null && RELOAD_KEYS.has(error.key)));
  return (
    <div className="p-3 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3" role="alert">
      <span className="flex-1 min-w-[12rem]">
        {error.message}
        {showReload && error.key && RELOAD_KEYS.has(error.key) && (
          <span className="block text-xs text-red-600 mt-1">Formunuz korunuyor. Yenile düğmesine basın.</span>
        )}
      </span>
      {showReload && (
        <button
          type="button"
          onClick={onReload}
          className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100 min-h-[44px] sm:min-h-0"
        >
          {reloadLabel}
        </button>
      )}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "danger" | "success";
  children: ReactNode;
}) {
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

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-gray-500 text-sm">{children}</p>;
}

export function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${className}`}>{children}</span>;
}

export function LevelBadge({ level }: { level: TrackingLevel | string }) {
  const info = TRACKING_INFO[level as TrackingLevel];
  if (!info) return <Badge className="bg-gray-100 text-gray-700">{level}</Badge>;
  return (
    <span title={info.description}>
      <Badge className={info.badge}>{info.short}</Badge>
    </span>
  );
}

export function MovementPill({ type }: { type: string }) {
  const cls = MOVEMENT_STYLES[type as keyof typeof MOVEMENT_STYLES] ?? "bg-gray-100 text-gray-700";
  return <Badge className={cls}>{movementLabel(type)}</Badge>;
}

/** Expiry date with "N gün kaldı" / "Süresi geçmiş" tone. `today` comes from the server. */
export function ExpiryBadge({ expiry, today }: { expiry: string | null | undefined; today: string | null | undefined }) {
  if (!expiry) return <span className="text-gray-400">—</span>;
  const days = today ? daysLeft(expiry, today) : NaN;
  const tone = expiryTone(days);
  const cls =
    tone === "red" ? "bg-red-100 text-red-800" : tone === "amber" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="tabular-nums">{formatDay(expiry)}</span>
      {tone && <Badge className={cls}>{expiryLabel(days)}</Badge>}
    </span>
  );
}

/** Fill bar of usable stock against MAX (legacy StockMeter). */
export function StockMeter({
  usable,
  min,
  max,
}: {
  usable: number;
  min: number;
  max: number;
}) {
  if (!(max > 0)) return null;
  const pct = Math.max(0, Math.min(100, (usable / max) * 100));
  const color = usable <= 0 ? "bg-red-500" : usable <= min ? "bg-amber-500" : "bg-green-500";
  return (
    <div className="w-full max-w-[10rem] h-2 rounded bg-gray-200 overflow-hidden" aria-hidden="true">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function QtyText({ qty, unit }: { qty: number | string | null | undefined; unit?: string | null }) {
  return (
    <span className="tabular-nums whitespace-nowrap">
      {formatQty(qty)}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

/**
 * Dialog that becomes a full-screen sheet on phones. Escape and the backdrop close it unless `busy`.
 * `side` renders a right-side panel on larger screens (quick movement sheet).
 */
export function StockModal({
  title,
  description,
  children,
  footer,
  onClose,
  busy,
  wide,
  side,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  side?: boolean;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const frame = side
    ? "fixed inset-0 z-50 flex justify-end bg-black/40"
    : "fixed inset-0 z-50 flex items-stretch sm:items-start justify-center bg-black/40 sm:p-4";
  const panel = side
    ? "bg-white w-full sm:max-w-lg h-[100dvh] flex flex-col shadow-xl text-gray-900"
    : `bg-white w-full ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"} sm:mt-10 sm:rounded-lg shadow-xl text-gray-900 flex flex-col max-h-[100dvh] sm:max-h-[95dvh]`;

  return (
    <div
      className={frame}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={panel}>
        <div className="flex items-start justify-between gap-4 px-4 sm:px-6 py-4 border-b shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
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

export function StatTile({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "red" | "amber" | "green";
  onClick?: () => void;
}) {
  const valueColor =
    tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-green-700" : "text-gray-900";
  const body = (
    <>
      <div className="text-sm text-gray-600">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${valueColor}`}>{value}</div>
      {detail && <div className="text-xs text-gray-500 mt-1">{detail}</div>}
    </>
  );
  if (!onClick) return <div className="bg-white p-5 rounded-lg shadow text-left">{body}</div>;
  return (
    <button type="button" onClick={onClick} className="bg-white p-5 rounded-lg shadow text-left hover:ring-2 hover:ring-blue-200">
      {body}
    </button>
  );
}
