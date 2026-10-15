"use client";

// Correction requests (spec p7_rules_ui §20.10, contract §5.8): managers see and resolve all requests,
// others see their own.

import { useCallback, useEffect, useState } from "react";
import { CORRECTION_STATUS_LABELS, CORRECTION_STATUS_STYLES, type CorrectionStatus } from "@/lib/stock/codes";
import { stockCorrectionList, toStockError, type CorrectionJson, type StockError } from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { formatTimestamp } from "@/lib/finance";
import { MovementSummary, ResolveCorrectionDialog } from "@/components/stock/CorrectionDialogs";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { Badge, Card, EmptyState, Loading, Notice, Pager, StockErrorBox, buttonPrimary } from "@/components/stock/ui";

const PAGE = 30;
const TABS: { value: CorrectionStatus; label: string }[] = [
  { value: "pending", label: "Bekleyen" },
  { value: "approved", label: "Onaylanan" },
  { value: "rejected", label: "Reddedilen" },
];

export default function CorrectionsPage() {
  const { gates, tick, notifyChanged } = useStock();
  const [status, setStatus] = useState<CorrectionStatus>("pending");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<CorrectionJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<StockError | null>(null);
  const [resolving, setResolving] = useState<CorrectionJson | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await stockCorrectionList(status, { offset, limit: PAGE });
      setRows(r.rows || []);
      setTotal(r.total ?? 0);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [status, offset]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  return (
    <StockShell
      title="Düzeltmeler"
      subtitle={
        gates.mgr
          ? "Hatalı stok kayıtları için bırakılan talepler. Onay, kaydı silmez: geri kayıt ve doğru kayıt ekler."
          : "Kendi düzeltme talepleriniz. Talep bırakmak için Hareketler ekranında kaydı seçin."
      }
    >
      <div className="flex flex-wrap gap-2 mb-4" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            onClick={() => {
              setStatus(t.value);
              setOffset(0);
            }}
            className={`px-3 min-h-[40px] rounded text-sm ${status === t.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {message && (
        <div className="mb-4">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      <StockErrorBox error={error} onReload={() => void load()} />
      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState>{status === "pending" ? "Bekleyen düzeltme talebi yok." : "Kayıt yok."}</EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div>
                  <p className="font-semibold">Düzeltme #{c.ref_no}</p>
                  <p className="text-xs text-gray-600">
                    {c.requested_by_name ?? "Kullanıcı"} · {formatTimestamp(c.created_at)}
                  </p>
                </div>
                <Badge className={CORRECTION_STATUS_STYLES[c.status]}>{CORRECTION_STATUS_LABELS[c.status]}</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <MovementSummary row={c.movement} />
                <div className="text-sm space-y-2">
                  <div>
                    <p className="font-semibold">Talep</p>
                    <p className="whitespace-pre-wrap">{c.reason}</p>
                  </div>
                  {c.status !== "pending" && (
                    <div>
                      <p className="font-semibold">Karar</p>
                      {c.status === "approved" && c.corrected_qty !== null && (
                        <p>
                          Doğru miktar: {formatQty(c.corrected_qty)} {c.movement.usage_unit}
                          {Number(c.corrected_qty) === 0 ? " (iptal)" : ""}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap">{c.resolution}</p>
                      <p className="text-xs text-gray-600">
                        {c.resolved_by_name ?? ""} · {formatTimestamp(c.resolved_at)}
                      </p>
                    </div>
                  )}
                </div>
              </div>
              {gates.mgr && c.status === "pending" && (
                <div className="mt-3">
                  <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={() => setResolving(c)}>
                    İncele
                  </button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />

      {resolving && (
        <ResolveCorrectionDialog
          request={resolving}
          onClose={() => setResolving(null)}
          onDone={() => {
            setResolving(null);
            setMessage(`Düzeltme #${resolving.ref_no} sonuçlandırıldı.`);
            notifyChanged();
          }}
        />
      )}
    </StockShell>
  );
}
