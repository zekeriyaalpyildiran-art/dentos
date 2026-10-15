"use client";

// Purchase order detail (spec p8_purchasing §12.5, §6.2): timeline, actions from the server's `actions` object,
// lines with their receipts, per-line goods receipt. Cost columns only when the server sent the cost keys.

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { UUID_RE } from "@/lib/finance";
import { canSeeFinance } from "@/lib/permissions";
import { PAYABLE_STATE_LABELS, qtyLabel, type PayableState } from "@/lib/stock/purchasing";
import {
  istanbulToday,
  stockPoDetail,
  stockPoTransition,
  toStockError,
  type PoAction,
  type PoDetail,
  type PoLineJson,
  type StockError,
} from "@/lib/stock/rpc";
import { useAuthStore } from "@/lib/store";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import {
  ConfirmDialog,
  PoStatusBadge,
  PurchasingErrorBox,
  ReasonDialog,
  useActionKeys,
} from "@/components/stock/purchasing/common";
import { PoReceiveDialog } from "@/components/stock/purchasing/PoReceiveDialog";
import {
  Card,
  LevelBadge,
  Loading,
  Notice,
  Toast,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  formatDay,
  formatTL,
  formatTimestamp,
} from "@/components/stock/ui";

export default function OrderDetailPage() {
  return (
    <Suspense fallback={<Loading />}>
      <OrderDetail />
    </Suspense>
  );
}

type Dialog =
  | { kind: "mark_ordered" }
  | { kind: "cancel" }
  | { kind: "close" }
  | { kind: "receive"; lineIds: string[] }
  | null;

function OrderDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const { tick, notifyChanged, today: serverToday } = useStock();
  const actionKey = useActionKeys();
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [error, setError] = useState<StockError | null>(null);
  const [actionError, setActionError] = useState<StockError | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handledParams = useRef(false);

  const load = useCallback(async () => {
    if (!UUID_RE.test(id)) {
      setError(toStockError({ message: "Sipariş bulunamadı.", code: "PT404" }));
      return;
    }
    try {
      const d = await stockPoDetail(id);
      setDetail(d);
      setError(null);
    } catch (e) {
      setError(toStockError(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // One-time hints from the address bar: ?saved=created|edited (after the builder), ?receive=1 (list quick action).
  useEffect(() => {
    if (!detail || handledParams.current) return;
    handledParams.current = true;
    const saved = search.get("saved");
    if (saved === "created") setToast(`Sipariş ${detail.order.order_number} onaya gönderildi.`);
    else if (saved === "edited") setToast("Sipariş değişiklikleri kaydedildi.");
    if (search.get("receive") === "1" && detail.order.actions.can_receive) {
      setDialog({ kind: "receive", lineIds: detail.order.lines.filter((l) => Number(l.qty_remaining) > 0).map((l) => l.id) });
    }
    if (saved || search.get("receive")) router.replace(pathname);
  }, [detail, search, router, pathname]);

  async function transition(action: PoAction, reason?: string) {
    if (!detail) return;
    const o = detail.order;
    await stockPoTransition({
      p_operation_key: actionKey(`${o.id}:${action}:${o.version}`),
      p_order_id: o.id,
      p_version: o.version,
      p_action: action,
      p_reason: reason ?? null,
    });
    setDialog(null);
    setToast(
      action === "approve"
        ? "Sipariş onaylandı."
        : action === "mark_ordered"
          ? "Sipariş verildi olarak işaretlendi."
          : action === "cancel"
            ? "Sipariş iptal edildi."
            : "Sipariş eksik kapatıldı."
    );
    notifyChanged();
  }

  if (error && !detail) {
    return (
      <StockShell title="Sipariş">
        <div className="space-y-3">
          <PurchasingErrorBox error={error} onReload={() => void load()} />
          <Link href="/inventory/orders" className="text-blue-700 hover:underline text-sm">
            Siparişlere dön
          </Link>
        </div>
      </StockShell>
    );
  }
  if (!detail) {
    return (
      <StockShell title="Sipariş">
        <Loading />
      </StockShell>
    );
  }

  const o = detail.order;
  const canCost = detail.can_view_costs === true || typeof o.total_cents === "number";
  const today = detail.today ?? serverToday ?? istanbulToday();
  const openLines = o.lines.filter((l) => Number(l.qty_remaining) > 0);
  const payableText = PAYABLE_STATE_LABELS[o.payable_state as PayableState] ?? "";
  const financeReader = canSeeFinance(user);

  return (
    <StockShell
      title={
        <span className="flex flex-wrap items-center gap-3">
          {o.order_number} <PoStatusBadge status={o.status} closedShort={o.closed_short} />
        </span>
      }
      subtitle={
        <Link href="/inventory/orders" className="text-blue-700 hover:underline">
          ← Siparişler
        </Link>
      }
    >
      <div className="space-y-4">
        <PurchasingErrorBox error={error} onReload={() => void load()} />
        <PurchasingErrorBox error={actionError} onReload={() => void load()} />
        {staleNotice && <Notice tone="warn">{staleNotice}</Notice>}

        <Card>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1 text-sm">
              <p className="text-base font-semibold">{o.supplier.name}</p>
              {!o.supplier.is_active && <p className="text-xs text-amber-700">Tedarikçi pasif</p>}
              {o.supplier.phone && (
                <p>
                  <a href={`tel:${o.supplier.phone}`} className="text-blue-700 hover:underline">
                    {o.supplier.phone}
                  </a>
                </p>
              )}
              {o.supplier.email && (
                <p>
                  <a href={`mailto:${o.supplier.email}`} className="text-blue-700 hover:underline">
                    {o.supplier.email}
                  </a>
                </p>
              )}
              {o.expected_date && (
                <p className={o.overdue ? "text-red-700 font-medium" : "text-gray-700"}>
                  Beklenen {formatDay(o.expected_date)}
                  {o.overdue ? " · Gecikti" : ""}
                </p>
              )}
              {o.note && <p className="text-gray-700 whitespace-pre-wrap">{o.note}</p>}
            </div>
            <ol className="text-sm space-y-1 border-l pl-4">
              <TimelineItem label="Oluşturuldu" who={o.created_by_name} at={o.created_at} />
              {o.content_edited_by_name && <TimelineItem label="Son değiştiren" who={o.content_edited_by_name} />}
              {o.approved_at && <TimelineItem label="Onaylandı" who={o.approved_by_name} at={o.approved_at} />}
              {o.ordered_at && <TimelineItem label="Sipariş verildi" who={o.ordered_by_name} at={o.ordered_at} />}
              {o.received_at && (
                <TimelineItem
                  label={o.closed_short ? "Eksik kapatıldı" : "Teslim alındı"}
                  who={o.closed_short ? o.closed_by_name : null}
                  at={o.received_at}
                  extra={o.closed_short && o.close_reason ? `Neden: ${o.close_reason}` : undefined}
                />
              )}
              {o.cancelled_at && (
                <TimelineItem
                  label="İptal edildi"
                  who={o.cancelled_by_name}
                  at={o.cancelled_at}
                  extra={o.cancel_reason ? `Neden: ${o.cancel_reason}` : undefined}
                />
              )}
            </ol>
          </div>

          <div className="flex flex-wrap gap-2 mt-4">
            {o.actions.can_edit && (
              <Link href={`/inventory/orders/new?edit=${o.id}`} className={`${buttonSecondary} min-h-[44px] flex items-center`}>
                Düzenle
              </Link>
            )}
            {o.actions.can_approve && (
              <button
                type="button"
                className={`${buttonPrimary} min-h-[44px]`}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setActionError(null);
                  try {
                    await transition("approve");
                  } catch (e) {
                    setActionError(toStockError(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Onayla
              </button>
            )}
            {!o.actions.can_approve && o.actions.approve_blocked === "self" && (
              <Notice tone="info">Bu siparişi başka bir stok yetkilisi onaylamalı.</Notice>
            )}
            {o.actions.can_mark_ordered && (
              <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={() => setDialog({ kind: "mark_ordered" })}>
                Sipariş verildi
              </button>
            )}
            {o.actions.can_receive && openLines.length > 0 && (
              <button
                type="button"
                className={`${buttonPrimary} min-h-[44px]`}
                onClick={() => setDialog({ kind: "receive", lineIds: openLines.map((l) => l.id) })}
              >
                Teslimatı kaydet
              </button>
            )}
            {o.actions.can_close && (
              <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => setDialog({ kind: "close" })}>
                Eksik kapat
              </button>
            )}
            {o.actions.can_cancel && (
              <button type="button" className={`${buttonDanger} min-h-[44px]`} onClick={() => setDialog({ kind: "cancel" })}>
                İptal et
              </button>
            )}
          </div>
        </Card>

        <Card title="Ürünler">
          <div className="space-y-3">
            {o.lines.map((l) => (
              <LineBlock
                key={l.id}
                line={l}
                canCost={canCost}
                canReceive={o.actions.can_receive}
                onReceive={() => setDialog({ kind: "receive", lineIds: [l.id] })}
              />
            ))}
          </div>
          {canCost && (
            <div className="mt-4 border-t pt-3 grid gap-1 text-sm sm:grid-cols-3">
              <p>
                Sipariş toplamı <span className="font-semibold tabular-nums">{formatTL(o.total_cents)}</span>
              </p>
              {typeof o.unpriced_lines === "number" && (
                <p className={o.unpriced_lines > 0 ? "text-amber-700" : ""}>Fiyatsız satır: {o.unpriced_lines}</p>
              )}
              {"received_value_cents" in o && (
                <p>
                  Teslim alınan değer{" "}
                  <span className="font-semibold tabular-nums">
                    {o.received_value_cents === null ? "Bazı lotların maliyeti yok" : formatTL(o.received_value_cents)}
                  </span>
                </p>
              )}
            </div>
          )}
        </Card>

        {payableText && (
          <Notice tone={o.payable_state === "skipped_error" ? "danger" : o.payable_state === "created" ? "success" : "info"}>
            {payableText}
            {o.payable_state === "created" && financeReader && o.fin_entry_id && (
              <>
                {" · "}
                <Link href={`/finance/entries/${o.fin_entry_id}`} className="underline">
                  Finans kaydını aç
                </Link>
              </>
            )}
          </Notice>
        )}
      </div>

      {dialog?.kind === "mark_ordered" && (
        <ConfirmDialog
          title="Sipariş verildi"
          text="Tedarikçiye mesaj gönderilmez; siparişi tedarikçiye siz iletin."
          confirmLabel="Sipariş verildi olarak işaretle"
          onClose={() => setDialog(null)}
          onConfirm={() => transition("mark_ordered")}
        />
      )}
      {dialog?.kind === "cancel" && (
        <ReasonDialog
          title={`${o.order_number} · İptal et`}
          label="İptal nedeni"
          submitLabel="Siparişi iptal et"
          danger
          onClose={() => setDialog(null)}
          onSubmit={(reason) => transition("cancel", reason)}
        />
      )}
      {dialog?.kind === "close" && (
        <ReasonDialog
          title={`${o.order_number} · Eksik kapat`}
          description="Gelmeyecek miktarlar kapatılır; sipariş Teslim alındı olur."
          label="Kapatma nedeni"
          submitLabel="Siparişi eksik kapat"
          onClose={() => setDialog(null)}
          onSubmit={(reason) => transition("close", reason)}
        />
      )}
      {dialog?.kind === "receive" && (
        <PoReceiveDialog
          order={o}
          lineIds={dialog.lineIds}
          canCost={canCost}
          today={today}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            setStaleNotice(null);
            setToast(message);
            notifyChanged();
          }}
          onStale={(message) => {
            setDialog(null);
            setStaleNotice(message);
            void load();
            notifyChanged();
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </StockShell>
  );
}

function TimelineItem({ label, who, at, extra }: { label: string; who?: string | null; at?: string | null; extra?: ReactNode }) {
  return (
    <li>
      <span className="font-medium">{label}</span>
      {who ? ` · ${who}` : ""}
      {at ? <span className="text-gray-500"> · {formatTimestamp(at)}</span> : null}
      {extra && <span className="block text-xs text-gray-600">{extra}</span>}
    </li>
  );
}

function LineBlock({
  line,
  canCost,
  canReceive,
  onReceive,
}: {
  line: PoLineJson;
  canCost: boolean;
  canReceive: boolean;
  onReceive: () => void;
}) {
  const factor = Number(line.card_units_per_purchase) || Number(line.units_per_purchase) || 1;
  const lbl = (q: number) => qtyLabel(Number(q), line.usage_unit, line.purchase_unit, factor);
  const remaining = Number(line.qty_remaining);
  return (
    <div className="border rounded p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            <Link href={`/inventory/items/${line.stock_item_id}`} className="hover:underline">
              {line.item_name}
            </Link>{" "}
            <LevelBadge level={line.tracking_level} />
          </p>
          <p className="text-xs text-gray-500">{[line.brand, line.item_code].filter(Boolean).join(" · ")}</p>
          {line.note && <p className="text-xs text-gray-700 mt-1">{line.note}</p>}
        </div>
        {canReceive && remaining > 0 && (
          <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={onReceive}>
            Mal kabul · {lbl(remaining)} kaldı
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2 text-sm">
        <div>
          <dt className="text-xs text-gray-500">Sipariş</dt>
          <dd className="tabular-nums">{lbl(line.qty_ordered)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Gelen</dt>
          <dd className="tabular-nums">{lbl(line.qty_received)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Kalan</dt>
          <dd className="tabular-nums">{lbl(remaining)}</dd>
        </div>
        {canCost && "unit_price_cents" in line && (
          <>
            <div>
              <dt className="text-xs text-gray-500">Birim fiyat</dt>
              <dd className="tabular-nums">
                {line.unit_price_cents === null || line.unit_price_cents === undefined ? (
                  <span className="text-amber-700">Fiyat girilmemiş</span>
                ) : (
                  `${formatTL(line.unit_price_cents)} / ${line.usage_unit}`
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Tutar</dt>
              <dd className="tabular-nums">{formatTL(line.line_total_cents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Gelen değer</dt>
              <dd className="tabular-nums">{formatTL(line.received_value_cents)}</dd>
            </div>
          </>
        )}
      </dl>
      {line.receipts.length > 0 && (
        <ul className="mt-2 text-xs text-gray-700 divide-y border-t">
          {line.receipts.map((rc) => (
            <li key={rc.movement_id} className="py-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              <Link href={`/inventory/movements?item=${line.stock_item_id}`} className="text-blue-700 hover:underline">
                #{rc.ref_no}
              </Link>
              <span className="tabular-nums">{lbl(rc.quantity)}</span>
              <span>
                Lot {rc.lot_number}
                {rc.serial_number ? ` · Seri ${rc.serial_number}` : ""}
              </span>
              {rc.expiry_date && <span>SKT {formatDay(rc.expiry_date)}</span>}
              {rc.to_location_name && <span>{rc.to_location_name}</span>}
              {rc.document_no && <span>Belge {rc.document_no}</span>}
              <span className="text-gray-500">
                {rc.actor_name ?? ""} · {formatTimestamp(rc.effective_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
