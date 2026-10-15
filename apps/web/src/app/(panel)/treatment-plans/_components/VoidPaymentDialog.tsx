"use client";

// Void dialog (spec p5 §6.2). Reachable only with can_void; the server enforces E_VOID_ROLE anyway.

import { useState } from "react";
import { Modal } from "@/components/finance/ui";
import { formatDay, toFinanceError, type FinanceError } from "@/lib/finance";
import { formatMoney, methodLabel, ppVoidPayment, type PaymentJson, type PaymentWriteResult } from "@/lib/payments";
import { tryPart } from "./payment-ui";

export function VoidPaymentDialog({
  payment,
  onClose,
  onVoided,
}: {
  payment: PaymentJson;
  onClose: () => void;
  onVoided: (res: PaymentWriteResult) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FinanceError | null>(null);
  const trimmed = reason.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= 500;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ppVoidPayment(payment.id, trimmed);
      onVoided(res);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  const tl = tryPart(payment);
  return (
    <Modal title="Ödemeyi iptal et" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">Tutar</dt>
          <dd className="font-semibold">
            {formatMoney(payment.amount_cents, payment.currency)} {payment.currency}
          </dd>
          {tl && (
            <>
              <dt className="text-gray-500">TL karşılığı</dt>
              <dd>{tl}</dd>
            </>
          )}
          <dt className="text-gray-500">Tarih</dt>
          <dd>{formatDay(payment.paid_on)}</dd>
          <dt className="text-gray-500">Yöntem</dt>
          <dd>{methodLabel(payment.method, payment.method_raw)}</dd>
          <dt className="text-gray-500">Kaydeden</dt>
          <dd>{payment.received_by_name || "Bilinmiyor"}</dd>
          {payment.plan_title && (
            <>
              <dt className="text-gray-500">Plan</dt>
              <dd>{payment.plan_title}</dd>
            </>
          )}
        </dl>

        <label className="block">
          <span className="block text-sm font-semibold mb-1">İptal nedeni</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            required
            disabled={busy}
            className="w-full px-3 py-2 border rounded"
            placeholder="Örn: Yanlış tutar girildi"
          />
          <span className={`block text-xs mt-1 ${trimmed.length > 0 && !valid ? "text-red-600" : "text-gray-500"}`}>
            {trimmed.length}/500 · en az 3 karakter
          </span>
        </label>

        <p className="text-xs text-gray-600">
          İptal edilen ödeme silinmez; geçmişte üstü çizili görünür ve toplamlara katılmaz.
        </p>

        {error && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{error.message}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 border border-gray-300 text-gray-800 rounded hover:bg-gray-50 disabled:opacity-40"
          >
            Vazgeç
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400"
          >
            {busy ? "İşleniyor..." : "Ödemeyi iptal et"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
