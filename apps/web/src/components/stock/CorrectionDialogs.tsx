"use client";

// Correction request and resolution (spec p7_rules_ui §20.8, §20.10; contract §4.8-4.9). The original movement is
// never edited: approval writes a reversal plus a re-entry with the original effective date.

import { useRef, useState } from "react";
import { movementSource, movementTarget } from "@/lib/stock/codes";
import {
  newKey,
  stockRequestCorrection,
  stockResolveCorrection,
  toStockError,
  type CorrectionJson,
  type MovementRow,
  type StockError,
} from "@/lib/stock/rpc";
import { AMBIGUOUS_QTY_MESSAGE, formatQty, isAmbiguousThousands, isWholeNumber, parseQty } from "@/lib/stock/units";
import { formatTimestamp } from "@/lib/finance";
import { Field, MovementPill, StockErrorBox, StockModal, bigPrimary, buttonDanger, stockInput } from "./ui";

export function MovementSummary({ row }: { row: MovementRow }) {
  return (
    <div className="p-3 rounded bg-gray-50 border text-sm space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <MovementPill type={row.movement_type} />
        <span className="text-xs text-gray-500">#{row.ref_no}</span>
      </div>
      <p className="font-medium">{row.item_name}</p>
      <p>
        {formatQty(row.quantity)} {row.usage_unit} · {movementSource(row.movement_type, row.from_location_name)} →{" "}
        {movementTarget(row.movement_type, row.to_location_name)}
      </p>
      <p className="text-xs text-gray-600">
        Lot {row.lot_number}
        {row.serial_number ? ` · seri ${row.serial_number}` : ""} · {formatTimestamp(row.created_at)} ·{" "}
        {row.actor_name ?? "Sistem"}
      </p>
      {row.patient_name && <p className="text-xs text-gray-600">{row.patient_name}</p>}
    </div>
  );
}

export function RequestCorrectionDialog({
  row,
  onClose,
  onDone,
}: {
  row: MovementRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const opKey = useRef(newKey());
  const requestId = useRef(newKey());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await stockRequestCorrection({
        p_operation_key: opKey.current,
        p_request_id: requestId.current,
        p_movement_id: row.id,
        p_reason: reason.trim(),
      });
      onDone();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const len = reason.trim().length;
  return (
    <StockModal
      title="Düzeltme iste"
      description="Kayıt değiştirilmez; stok sorumlusu onaylarsa geri kayıt ve doğru kayıt eklenir."
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={bigPrimary} disabled={busy || len < 3 || len > 1000} onClick={() => void submit()}>
          {busy ? "Gönderiliyor..." : "Düzeltme iste"}
        </button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm font-semibold">Düzeltilecek işlem</p>
        <MovementSummary row={row} />
        <Field label="Ne yanlış, doğrusu ne olmalı?" hint={`${len}/1000 · en az 3 karakter`}>
          <textarea className={stockInput} rows={4} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}

export function ResolveCorrectionDialog({
  request,
  onClose,
  onDone,
}: {
  request: CorrectionJson;
  onClose: () => void;
  onDone: () => void;
}) {
  const m = request.movement;
  const [qtyText, setQtyText] = useState("");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const opKey = useRef(newKey());

  const qty = parseQty(qtyText);
  const delta = Number.isFinite(qty) ? qty - Number(m.quantity) : NaN;
  const effects: string[] = [];
  if (Number.isFinite(delta) && delta !== 0) {
    const sign = (n: number) => (n > 0 ? `+${formatQty(n)}` : `−${formatQty(-n)}`);
    if (m.from_location_name) effects.push(`${m.from_location_name} ${sign(-delta)} ${m.usage_unit}`);
    if (m.to_location_name) effects.push(`${m.to_location_name} ${sign(delta)} ${m.usage_unit}`);
  }

  async function submit(action: "approve" | "reject") {
    setLocalError(null);
    setError(null);
    const res = resolution.trim();
    if (res.length < 3 || res.length > 1000) {
      setLocalError("Karar açıklamasını yazın (3–1000 karakter).");
      return;
    }
    if (action === "approve") {
      if (isAmbiguousThousands(qtyText)) {
        setLocalError(AMBIGUOUS_QTY_MESSAGE);
        return;
      }
      if (!Number.isFinite(qty) || qty === Number(m.quantity)) {
        setLocalError("Doğru miktarı girin; iptal için 0 yazın.");
        return;
      }
      if (m.tracking_level === "A" && !isWholeNumber(qty)) {
        setLocalError("Tam adet girin.");
        return;
      }
      if (m.serial_number && qty > 1) {
        setLocalError("Seri numaralı ürün en fazla 1 adettir.");
        return;
      }
    }
    setBusy(true);
    try {
      await stockResolveCorrection({
        p_operation_key: opKey.current,
        p_request_id: request.id,
        p_action: action,
        p_corrected_qty: action === "approve" ? qty : null,
        p_resolution: res,
      });
      onDone();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StockModal
      title={`Düzeltme #${request.ref_no}`}
      description={`${request.requested_by_name ?? "Kullanıcı"} · ${formatTimestamp(request.created_at)}`}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" className={bigPrimary} disabled={busy} onClick={() => void submit("approve")}>
            Onayla ve stoğu düzelt
          </button>
          <button type="button" className={`${buttonDanger} h-12 sm:w-40`} disabled={busy} onClick={() => void submit("reject")}>
            Reddet
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <MovementSummary row={m} />
        <div className="p-3 rounded border text-sm">
          <p className="font-semibold">Talep</p>
          <p className="whitespace-pre-wrap">{request.reason}</p>
        </div>
        <Field label={`Doğru miktar (iptal için 0) · ${m.usage_unit}`}>
          <input className={`${stockInput} h-12`} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
        </Field>
        {effects.length > 0 && <p className="text-sm text-gray-800">Stok etkisi: {effects.join(" · ")}</p>}
        <Field label="Karar açıklaması" hint={`${resolution.trim().length}/1000`}>
          <textarea className={stockInput} rows={3} maxLength={1000} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
        {localError && (
          <div role="alert" className="p-3 rounded bg-red-50 text-red-700 text-sm">
            {localError}
          </div>
        )}
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}
