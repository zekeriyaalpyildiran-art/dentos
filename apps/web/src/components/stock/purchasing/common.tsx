"use client";

// Shared Phase 8 pieces: status badges, the reason prompt, the "module missing" notice, work counts for the tab
// bar and a per-action operation key cache (spec p8_purchasing §12).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import {
  PO_STATUS_STYLES,
  ROOM_REQUEST_STATUS_LABELS,
  ROOM_REQUEST_STATUS_STYLES,
  poStatusLabel,
  type PoStatus,
  type RoomRequestStatus,
} from "@/lib/stock/purchasing";
import { newKey, stockWorkCounts, toStockError, type StockError, type WorkCounts } from "@/lib/stock/rpc";
import { isStockModuleMissing, useStock } from "../StockContext";
import { Badge, Field, Notice, StockErrorBox, StockModal, bigPrimary, stockInput } from "../ui";

export const PURCHASING_MISSING_TEXT = "Satın alma modülü güncelleniyor; lütfen daha sonra tekrar deneyin.";

export function PoStatusBadge({ status, closedShort }: { status: PoStatus; closedShort?: boolean | null }) {
  return (
    <Badge className={PO_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-700"}>{poStatusLabel(status, closedShort)}</Badge>
  );
}

export function RoomRequestBadge({ status }: { status: RoomRequestStatus }) {
  return (
    <Badge className={ROOM_REQUEST_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-700"}>
      {ROOM_REQUEST_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Error box that shows one calm notice when the Phase 8 functions are not in the database yet (§11.4). */
export function PurchasingErrorBox({ error, onReload }: { error: StockError | null; onReload?: () => void }) {
  if (!error) return null;
  if (isStockModuleMissing(error)) return <Notice tone="warn">{PURCHASING_MISSING_TEXT}</Notice>;
  return <StockErrorBox error={error} onReload={onReload} />;
}

/**
 * One operation key per (record, action, version): a retry of the same click after a network error replays the
 * same call (already_saved) instead of acting twice; a new version (after success) gets a new key.
 */
export function useActionKeys() {
  const keys = useRef(new Map<string, string>());
  return useCallback((signature: string) => {
    let k = keys.current.get(signature);
    if (!k) {
      k = newKey();
      keys.current.set(signature, k);
    }
    return k;
  }, []);
}

let countsCache: { user: string; counts: WorkCounts | null; missing: boolean } | null = null;

/**
 * stock_work_counts for the tab badges; `missing` when the Phase 8 functions are not deployed yet. `known` stays
 * false until the first answer (or a cached one), so callers can hold back purchasing UI instead of showing it and
 * then taking it away on a database without 0025.
 */
export function useWorkCounts() {
  const user = useAuthStore((state) => state.user);
  const { tick } = useStock();
  const userKey = user ? `${user.clinic_id}:${user.user_id}` : "";
  const cached = countsCache && countsCache.user === userKey ? countsCache : null;
  const [counts, setCounts] = useState<WorkCounts | null>(cached?.counts ?? null);
  const [missing, setMissing] = useState(cached?.missing ?? false);
  const [known, setKnown] = useState(cached !== null);

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;
    stockWorkCounts()
      .then((c) => {
        if (cancelled) return;
        countsCache = { user: userKey, counts: c, missing: false };
        setCounts(c);
        setMissing(false);
        setKnown(true);
      })
      .catch((e) => {
        if (cancelled) return;
        const isMissing = isStockModuleMissing(toStockError(e));
        countsCache = { user: userKey, counts: null, missing: isMissing };
        setCounts(null);
        setMissing(isMissing);
        setKnown(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userKey, tick]);

  return { counts, missing, known };
}

const bigDanger =
  "w-full h-12 px-4 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 disabled:bg-gray-400";

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** Shared reason prompt (cancel, close, reject): 3–500 characters with a live counter. */
export function ReasonDialog({
  title,
  description,
  label,
  submitLabel,
  danger,
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  label: string;
  submitLabel: string;
  danger?: boolean;
  onClose: () => void;
  /** Resolves when saved; throws a StockError to keep the dialog open. */
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const trimmed = text.trim();
  const valid = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(toStockError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StockModal
      title={title}
      description={description}
      onClose={onClose}
      busy={busy}
      footer={
        <button
          type="button"
          className={danger ? bigDanger : bigPrimary}
          disabled={busy || !valid}
          onClick={() => void submit()}
        >
          {busy ? "Kaydediliyor..." : submitLabel}
        </button>
      }
    >
      <div className="space-y-3">
        <Field label={`${label} *`} hint={`${trimmed.length} / ${REASON_MAX} karakter (en az ${REASON_MIN})`}>
          <textarea
            className={stockInput}
            rows={3}
            maxLength={REASON_MAX + 50}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        </Field>
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}

/** Small yes / no confirmation in the stock modal frame. */
export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  return (
    <StockModal
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <button
          type="button"
          className={bigPrimary}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              setError(toStockError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Kaydediliyor..." : confirmLabel}
        </button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-700">{text}</p>
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}
