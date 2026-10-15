"use client";

// Room requests (oda talepleri; spec p8_purchasing §12.6, RPC §5.4-§5.5, §6.4). Every staff member reads them;
// operating roles create; stock managers approve, reject and deliver; the requester may withdraw.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { qtyLabel, type RoomRequestStatus } from "@/lib/stock/purchasing";
import {
  stockRoomRequestAction,
  stockRoomRequestList,
  toStockError,
  type RoomRequestFilters,
  type RoomRequestJson,
  type RoomRequestStatusFilter,
  type StockError,
} from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { useStock } from "../StockContext";
import { useStockLocations } from "../useStockRefs";
import {
  Card,
  EmptyState,
  Loading,
  Pager,
  Toast,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  formatTimestamp,
  stockInput,
} from "../ui";
import { ConfirmDialog, PurchasingErrorBox, ReasonDialog, RoomRequestBadge, useActionKeys } from "./common";
import { RoomDeliverDialog, RoomRequestDialog } from "./RoomRequestDialogs";

const PAGE = 30;

const CHIPS: { value: RoomRequestStatusFilter; label: string }[] = [
  { value: "open", label: "Açık" },
  { value: "pending", label: "Bekliyor" },
  { value: "approved", label: "Onaylandı" },
  { value: "delivered", label: "Teslim edildi" },
  { value: "rejected", label: "Reddedildi" },
  { value: "cancelled", label: "Geri çekildi" },
  { value: "all", label: "Tümü" },
];

type Dialog =
  | { kind: "create" }
  | { kind: "deliver"; request: RoomRequestJson }
  | { kind: "reject"; request: RoomRequestJson }
  | { kind: "cancel"; request: RoomRequestJson }
  | null;

export function RoomRequestsPanel() {
  const { gates, tick, notifyChanged, today } = useStock();
  const { active: locations } = useStockLocations();
  const rooms = useMemo(() => locations.filter((l) => l.kind === "room" || l.kind === "sterilization"), [locations]);
  const actionKey = useActionKeys();
  const [status, setStatus] = useState<RoomRequestStatusFilter>("open");
  const [mine, setMine] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<RoomRequestJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Partial<Record<RoomRequestStatus, number>>>({});
  const [error, setError] = useState<StockError | null>(null);
  const [actionError, setActionError] = useState<StockError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);

  const filters = useMemo<RoomRequestFilters>(
    () => ({ status, mine: mine || undefined, location_id: locationId || undefined }),
    [status, mine, locationId]
  );

  const load = useCallback(async () => {
    try {
      const r = await stockRoomRequestList(filters, { offset, limit: PAGE });
      setRows(r.rows || []);
      setTotal(r.total ?? 0);
      setCounts(r.counts || {});
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [filters, offset]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  async function act(request: RoomRequestJson, action: "approve" | "reject" | "cancel", reason?: string) {
    await stockRoomRequestAction({
      p_operation_key: actionKey(`${request.id}:${action}:${request.version}`),
      p_request_id: request.id,
      p_version: request.version,
      p_action: action,
      p_reason: reason ?? null,
    });
    setDialog(null);
    setToast(action === "approve" ? "Talep onaylandı." : action === "reject" ? "Talep reddedildi." : "Talep geri çekildi.");
    notifyChanged();
  }

  const chipCount = (c: RoomRequestStatusFilter): number | null => {
    if (c === "open") return (counts.pending ?? 0) + (counts.approved ?? 0);
    if (c === "all") return null;
    return counts[c] ?? 0;
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <p className="text-sm text-gray-600">Talep bir kişiye değil, yetkili stok ekibine düşer.</p>
        {gates.op && (
          <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={() => setDialog({ kind: "create" })}>
            Odaya malzeme talep et
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 mb-3" role="tablist" aria-label="Talep durumu">
        {CHIPS.map((c) => {
          const n = chipCount(c.value);
          return (
            <button
              key={c.value}
              type="button"
              role="tab"
              aria-selected={status === c.value}
              onClick={() => {
                setStatus(c.value);
                setOffset(0);
              }}
              className={`px-3 min-h-[40px] rounded text-sm ${status === c.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
            >
              {c.label}
              {n !== null && <span className="ml-1 tabular-nums opacity-80">({n})</span>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm min-h-[44px]">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={mine}
            onChange={(e) => {
              setMine(e.target.checked);
              setOffset(0);
            }}
          />
          Yalnız benimkiler
        </label>
        <select
          className={`${stockInput} sm:max-w-xs`}
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setOffset(0);
          }}
          aria-label="Oda"
        >
          <option value="">Tüm odalar</option>
          {rooms.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-3 mb-3">
        <PurchasingErrorBox error={error} onReload={() => void load()} />
        <PurchasingErrorBox error={actionError} onReload={() => void load()} />
      </div>

      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState>{status === "open" ? "Açık oda talebi yok." : "Kayıt yok."}</EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const factor = Number(r.units_per_purchase) || 1;
            const lbl = (q: number) => qtyLabel(Number(q), r.usage_unit, r.purchase_unit, factor);
            const short = typeof r.warehouse_usable_qty === "number" && Number(r.warehouse_usable_qty) < Number(r.quantity);
            return (
              <Card key={r.id} className="!p-4 sm:!p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <RoomRequestBadge status={r.status} />
                      <span className="text-sm text-gray-500">Talep #{r.ref_no}</span>
                    </div>
                    <p className="font-semibold">
                      <Link href={`/inventory/items/${r.stock_item_id}`} className="hover:underline">
                        {r.item_name}
                      </Link>
                    </p>
                    <p className="text-sm">
                      {lbl(r.quantity)} · {r.location_name}
                    </p>
                    {r.note && <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.note}</p>}
                    <p className="text-xs text-gray-500">
                      {r.requested_by_name ?? "Kullanıcı"} · {formatTimestamp(r.created_at)}
                    </p>
                    {typeof r.warehouse_usable_qty === "number" && (r.status === "pending" || r.status === "approved") && (
                      <p className={`text-xs ${short ? "text-red-700 font-medium" : "text-gray-600"}`}>
                        Ana depoda kullanılabilir: {formatQty(r.warehouse_usable_qty)} {r.usage_unit}
                      </p>
                    )}
                    {r.open_duplicates > 0 && (r.status === "pending" || r.status === "approved") && (
                      <p className="text-xs text-amber-700">Bu oda için aynı üründe başka açık talep var.</p>
                    )}
                    {r.approved_at && r.status !== "delivered" && (
                      <p className="text-xs text-gray-600">
                        Onaylayan {r.approved_by_name ?? ""} · {formatTimestamp(r.approved_at)}
                      </p>
                    )}
                    {r.status === "delivered" && (
                      <p className="text-xs text-gray-600">
                        Teslim edilen {lbl(r.delivered_qty ?? r.quantity)}
                        {r.source_location_name ? ` · ${r.source_location_name} → ${r.location_name}` : ""} ·{" "}
                        {r.delivered_by_name ?? ""} · {formatTimestamp(r.delivered_at)}
                      </p>
                    )}
                    {r.status === "rejected" && (
                      <p className="text-xs text-gray-600">
                        Reddeden {r.rejected_by_name ?? ""} · {formatTimestamp(r.rejected_at)}
                        {r.reject_reason ? ` · Neden: ${r.reject_reason}` : ""}
                      </p>
                    )}
                    {r.status === "cancelled" && (
                      <p className="text-xs text-gray-600">Geri çekildi · {formatTimestamp(r.cancelled_at)}</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {r.actions.can_approve && (
                    <button
                      type="button"
                      className={`${buttonSecondary} min-h-[44px]`}
                      disabled={busyId === r.id}
                      onClick={async () => {
                        setBusyId(r.id);
                        setActionError(null);
                        try {
                          await act(r, "approve");
                        } catch (e) {
                          setActionError(toStockError(e));
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      Onayla
                    </button>
                  )}
                  {r.actions.can_deliver && (
                    <button
                      type="button"
                      className={`${buttonPrimary} min-h-[44px]`}
                      onClick={() => setDialog({ kind: "deliver", request: r })}
                    >
                      {r.status === "pending" ? "Onayla ve teslim et" : "Teslim et"}
                    </button>
                  )}
                  {r.actions.can_reject && (
                    <button type="button" className={`${buttonDanger} min-h-[44px]`} onClick={() => setDialog({ kind: "reject", request: r })}>
                      Reddet
                    </button>
                  )}
                  {r.actions.can_cancel && (
                    <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => setDialog({ kind: "cancel", request: r })}>
                      Geri çek
                    </button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />

      {dialog?.kind === "create" && (
        <RoomRequestDialog
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            setToast(message);
            notifyChanged();
          }}
        />
      )}
      {dialog?.kind === "deliver" && (
        <RoomDeliverDialog
          request={dialog.request}
          today={today}
          operationKey={actionKey(`${dialog.request.id}:deliver:${dialog.request.version}`)}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            setToast(message);
            notifyChanged();
          }}
        />
      )}
      {dialog?.kind === "reject" && (
        <ReasonDialog
          title={`Talep #${dialog.request.ref_no} · Reddet`}
          description={`${dialog.request.item_name} · ${dialog.request.location_name}`}
          label="Ret nedeni"
          submitLabel="Talebi reddet"
          danger
          onClose={() => setDialog(null)}
          onSubmit={(reason) => act(dialog.request, "reject", reason)}
        />
      )}
      {dialog?.kind === "cancel" && (
        <ConfirmDialog
          title={`Talep #${dialog.request.ref_no} · Geri çek`}
          text="Talep geri çekilir; stok değişmez."
          confirmLabel="Talebi geri çek"
          onClose={() => setDialog(null)}
          onConfirm={() => act(dialog.request, "cancel")}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
