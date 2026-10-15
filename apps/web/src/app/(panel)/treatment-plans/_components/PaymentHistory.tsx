"use client";

// 'Ödeme Geçmişi' list of one plan (spec p5 §6.1). Voided rows stay visible (struck through) behind a toggle.

import { formatDay, formatTimestamp } from "@/lib/finance";
import { formatMoney, methodLabel, type PaymentJson } from "@/lib/payments";
import { PaymentStatusBadge, appliedPart, tryPart } from "./payment-ui";

export function PaymentHistory({
  payments,
  canVoid,
  showVoided,
  onToggleVoided,
  voidedCount,
  onVoid,
  truncated,
}: {
  payments: PaymentJson[];
  canVoid: boolean;
  showVoided: boolean;
  onToggleVoided: (v: boolean) => void;
  voidedCount: number;
  onVoid: (p: PaymentJson) => void;
  truncated?: boolean;
}) {
  const shown = showVoided ? payments : payments.filter((p) => !p.voided_at);
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h3 className="text-lg font-bold">Ödeme Geçmişi</h3>
        {voidedCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={showVoided} onChange={(e) => onToggleVoided(e.target.checked)} />
            İptal edilenleri göster ({voidedCount})
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-gray-500">
          {payments.length === 0 ? "Henüz ödeme kaydı yok." : "Gösterilecek ödeme yok."}
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((p) => {
            const voided = !!p.voided_at;
            const extra = [tryPart(p), appliedPart(p)].filter(Boolean);
            return (
              <div key={p.id} className="pb-3 border-b last:border-b-0">
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    <div className={`font-semibold ${voided ? "line-through text-gray-400" : ""}`}>
                      {formatMoney(p.amount_cents, p.currency)}
                      {extra.length > 0 && (
                        <span className="font-normal text-sm text-gray-600"> · {extra.join(" · ")}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {methodLabel(p.method, p.method_raw)} · {formatDay(p.paid_on)} · Kaydeden:{" "}
                      {p.received_by_name || "Bilinmiyor"}
                    </div>
                    {p.note && <div className="text-xs text-gray-600 mt-0.5 break-words">{p.note}</div>}
                    {voided && (
                      <div className="text-xs text-red-700 mt-0.5 break-words">
                        İptal: {p.void_reason} · {p.voided_by_name || "Bilinmiyor"} · {formatTimestamp(p.voided_at)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <PaymentStatusBadge payment={p} />
                    {canVoid && !voided && (
                      <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => onVoid(p)}>
                        İptal et
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {truncated && (
        <p className="text-xs text-gray-500 mt-3">Yalnızca son 500 ödeme gösteriliyor; toplamlar tüm ödemeleri kapsar.</p>
      )}
    </div>
  );
}
