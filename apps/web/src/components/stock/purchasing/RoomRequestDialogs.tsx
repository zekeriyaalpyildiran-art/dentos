"use client";

// Room request dialogs (spec p8_purchasing §12.6, RPC §5.4, §5.5): create (any operating role) and deliver (stock
// managers; FEFO transfer from the default warehouse, chosen lots for A-level cards).

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { newId } from "@/lib/finance";
import { LOCATION_KIND_LABELS } from "@/lib/stock/codes";
import { qtyLabel, qtyToInput } from "@/lib/stock/purchasing";
import {
  newKey,
  stockItemDetail,
  stockRoomRequestAction,
  stockRoomRequestCreate,
  stockRoomRequestList,
  toStockError,
  type BalanceRow,
  type LevelRow,
  type RoomRequestJson,
  type StockError,
} from "@/lib/stock/rpc";
import { STORAGE_KEYS, readString } from "@/lib/stock/storage";
import {
  conversionLine,
  formatQty,
  isWholeNumber,
  parseQty,
  qtyInputProblem,
  quantityInStockUnits,
  type QuantityUnit,
} from "@/lib/stock/units";
import { ItemPicker } from "../ItemPicker";
import { useStockLocations } from "../useStockRefs";
import { ExpiryBadge, Field, LevelBadge, Loading, Notice, StockErrorBox, StockModal, bigPrimary, stockInput } from "../ui";

const NOTE_MAX = 500;

function QtyInput({
  value,
  unit,
  onValue,
  onUnit,
  usageUnit,
  purchaseUnit,
  factor,
}: {
  value: string;
  unit: QuantityUnit;
  onValue: (v: string) => void;
  onUnit: (u: QuantityUnit) => void;
  usageUnit: string;
  purchaseUnit: string;
  factor: number;
}) {
  const hasPack = factor !== 1 && purchaseUnit && purchaseUnit !== usageUnit;
  const problem = value.trim() ? qtyInputProblem(value) : null;
  const q = parseQty(value);
  return (
    <>
      <div className="flex gap-2">
        <input className={stockInput} inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} />
        {hasPack ? (
          <select
            className={`${stockInput} max-w-[8rem]`}
            value={unit}
            onChange={(e) => onUnit(e.target.value as QuantityUnit)}
            aria-label="Birim"
          >
            <option value="usage">{usageUnit}</option>
            <option value="purchase">{purchaseUnit}</option>
          </select>
        ) : (
          <span className="self-center text-sm text-gray-700">{usageUnit}</span>
        )}
      </div>
      {problem ? (
        <span className="block text-xs text-red-600 mt-1">{problem}</span>
      ) : unit === "purchase" && q > 0 ? (
        <span className="block text-xs text-gray-500 mt-1">{conversionLine(q, purchaseUnit, usageUnit, factor)}</span>
      ) : null}
    </>
  );
}

/** "Odaya malzeme talep et" (SA:2003-2058). */
export function RoomRequestDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const user = useAuthStore((state) => state.user);
  const { active } = useStockLocations();
  const rooms = useMemo(
    () => active.filter((l) => (l.kind === "room" || l.kind === "sterilization") && !l.is_default_warehouse),
    [active]
  );
  const [item, setItem] = useState<LevelRow | null>(null);
  const [qtyText, setQtyText] = useState("");
  const [unit, setUnit] = useState<QuantityUnit>("usage");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const requestId = useRef(newId());
  const opKey = useRef(newKey());

  // Default target: the user's shift room when it is a room / sterilization area.
  useEffect(() => {
    if (locationId || rooms.length === 0 || !user) return;
    const shift = readString(STORAGE_KEYS.shiftRoom(user.user_id));
    if (shift && rooms.some((r) => r.id === shift)) setLocationId(shift);
  }, [rooms, user, locationId]);

  // Warn when the same card already has an open request for this room (allowed, legacy allowed it too).
  useEffect(() => {
    setDuplicate(false);
    if (!item || !locationId) return;
    let cancelled = false;
    stockRoomRequestList({ status: "open", stock_item_id: item.id, location_id: locationId }, { offset: 0, limit: 1 })
      .then((r) => {
        if (!cancelled) setDuplicate((r.total ?? r.rows?.length ?? 0) > 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item, locationId]);

  const factor = Number(item?.units_per_purchase) || 1;

  async function submit() {
    setError(null);
    if (!item) return setLocalError("Ürünü seçin.");
    const q = parseQty(qtyText);
    const usage = quantityInStockUnits(q, unit, factor);
    if (!(q > 0) || !Number.isFinite(usage)) return setLocalError("Miktar sıfırdan büyük olmalıdır.");
    if (item.tracking_level === "A" && !isWholeNumber(usage)) return setLocalError("Bu üründe tam adet girin.");
    if (!locationId) return setLocalError("Talep için bir oda veya sterilizasyon alanı seçin.");
    if (note.trim().length > NOTE_MAX) return setLocalError("Not en fazla 500 karakter olabilir.");
    setLocalError(null);
    setBusy(true);
    try {
      await stockRoomRequestCreate({
        p_operation_key: opKey.current,
        p_request_id: requestId.current,
        p_stock_item_id: item.id,
        p_location_id: locationId,
        p_quantity: q,
        p_quantity_unit: unit,
        p_units_per_purchase: unit === "purchase" ? factor : null,
        p_note: note.trim() || null,
      });
      onDone("Oda talebi oluşturuldu.");
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      if (err.key === "E_ID_TAKEN") {
        requestId.current = newId();
        opKey.current = newKey();
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StockModal
      title="Odaya malzeme talep et"
      description="Talep bir kişiye değil, yetkili stok ekibine düşer."
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={bigPrimary} disabled={busy || !item} onClick={() => void submit()}>
          {busy ? "Kaydediliyor..." : "Talebi oluştur"}
        </button>
      }
    >
      <div className="space-y-4">
        {item ? (
          <div className="p-3 rounded border bg-gray-50 flex justify-between items-center gap-2">
            <span>
              <span className="font-medium">{item.item_name}</span> <LevelBadge level={item.tracking_level} />
            </span>
            <button
              type="button"
              className="text-sm text-blue-700 hover:underline min-h-[44px]"
              onClick={() => {
                setItem(null);
                setUnit("usage");
              }}
            >
              Değiştir
            </button>
          </div>
        ) : (
          <ItemPicker autoFocus onPick={setItem} />
        )}
        {item && (
          <Field
            label="Miktar *"
            hint="Örneğin birim “kutu” ise 2 kutu için 2 yazın. Talep açıldığında stok değişmez; “Teslim et” işlemi odaya aktarır."
          >
            <QtyInput
              value={qtyText}
              unit={unit}
              onValue={setQtyText}
              onUnit={setUnit}
              usageUnit={item.usage_unit}
              purchaseUnit={item.purchase_unit}
              factor={factor}
            />
          </Field>
        )}
        <Field label="Oda / alan *">
          <select className={stockInput} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Seçin</option>
            {rooms.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({LOCATION_KIND_LABELS[l.kind]})
              </option>
            ))}
          </select>
        </Field>
        {duplicate && <Notice tone="warn">Bu oda için aynı üründe başka açık talep var.</Notice>}
        <Field label="Not" hint={`${note.trim().length} / ${NOTE_MAX}`}>
          <textarea className={stockInput} rows={2} maxLength={NOTE_MAX + 50} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {localError && <Notice tone="danger">{localError}</Notice>}
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}

function fefoCompare(a: BalanceRow, b: BalanceRow): number {
  if (a.expiry_date && b.expiry_date && a.expiry_date !== b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : 1;
  if (a.expiry_date && !b.expiry_date) return -1;
  if (!a.expiry_date && b.expiry_date) return 1;
  return a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0;
}

/** "Teslim et" / "Onayla ve teslim et": FEFO transfer from the default warehouse into the room. */
export function RoomDeliverDialog({
  request,
  today,
  operationKey,
  onClose,
  onDone,
}: {
  request: RoomRequestJson;
  today: string | null;
  /** Reused across retries of this delivery (same request version). */
  operationKey: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { defaultWarehouse } = useStockLocations();
  const factor = Number(request.units_per_purchase) || 1;
  const levelA = request.tracking_level === "A";
  const [qtyText, setQtyText] = useState(qtyToInput(request.quantity));
  const [unit, setUnit] = useState<QuantityUnit>("usage");
  const [balances, setBalances] = useState<BalanceRow[] | null>(null);
  const [loadError, setLoadError] = useState<StockError | null>(null);
  const [mode, setMode] = useState<"auto" | "chosen">(levelA ? "chosen" : "auto");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const key = useRef(operationKey);

  useEffect(() => {
    let cancelled = false;
    stockItemDetail(request.stock_item_id)
      .then((d) => {
        if (!cancelled) setBalances(d.balances || []);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(toStockError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [request.stock_item_id]);

  const lots = useMemo(
    () =>
      (balances || [])
        .filter((b) => defaultWarehouse && b.location_id === defaultWarehouse.id && b.usable && Number(b.quantity) > 0)
        .sort(fefoCompare),
    [balances, defaultWarehouse]
  );
  const available = lots.reduce((n, b) => n + Number(b.quantity), 0);

  async function submit() {
    setError(null);
    const q = parseQty(qtyText);
    const usage = quantityInStockUnits(q, unit, factor);
    if (!(q > 0) || !Number.isFinite(usage)) return setLocalError("Miktar sıfırdan büyük olmalıdır.");
    if (usage > Number(request.quantity) + 1e-9) return setLocalError("Teslim miktarı talep edilen miktarı aşamaz.");
    if (levelA && !isWholeNumber(usage)) return setLocalError("Bu üründe tam adet girin.");
    if (mode === "chosen" && chosen.size === 0) return setLocalError("A grubu: Lot / seri seçin");
    setLocalError(null);
    const sameAsRequested = unit === "usage" && usage === Number(request.quantity);
    setBusy(true);
    try {
      await stockRoomRequestAction({
        p_operation_key: key.current,
        p_request_id: request.id,
        p_version: request.version,
        p_action: "deliver",
        p_quantity: sameAsRequested ? null : q,
        p_quantity_unit: unit,
        p_units_per_purchase: unit === "purchase" ? factor : null,
        p_batch_ids: mode === "chosen" ? lots.filter((b) => chosen.has(b.batch_id)).map((b) => b.batch_id) : null,
      });
      onDone("Malzeme odaya teslim edildi.");
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") key.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StockModal
      title={`${request.status === "pending" ? "Onayla ve teslim et" : "Teslim et"} · Talep #${request.ref_no}`}
      description={`${request.item_name} → ${request.location_name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={bigPrimary} disabled={busy} onClick={() => void submit()}>
          {busy ? "Kaydediliyor..." : "Teslim et"}
        </button>
      }
    >
      <div className="space-y-4">
        <Notice tone="info">Teslim et, malzemeyi ana depodan odaya aktarır. Aynı taşıma için ayrıca transfer kaydetmeyin.</Notice>
        <p className="text-sm">
          Talep: {qtyLabel(Number(request.quantity), request.usage_unit, request.purchase_unit, factor)}
          {defaultWarehouse && (
            <span className="text-gray-600">
              {" "}
              · {defaultWarehouse.name} kullanılabilir: {formatQty(available)} {request.usage_unit}
            </span>
          )}
        </p>
        <Field label="Teslim edilen miktar">
          <QtyInput
            value={qtyText}
            unit={unit}
            onValue={setQtyText}
            onUnit={setUnit}
            usageUnit={request.usage_unit}
            purchaseUnit={request.purchase_unit}
            factor={factor}
          />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-semibold">{levelA ? "A grubu: Lot / seri seçin" : "Lot seçimi"}</p>
          {!levelA && (
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-2 text-sm min-h-[44px]">
                <input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} />
                Otomatik: En yakın son kullanma tarihi
              </label>
              <label className="flex items-center gap-2 text-sm min-h-[44px]">
                <input type="radio" checked={mode === "chosen"} onChange={() => setMode("chosen")} />
                Lot seç
              </label>
            </div>
          )}
          {loadError ? (
            <StockErrorBox error={loadError} />
          ) : balances === null ? (
            <Loading />
          ) : lots.length === 0 ? (
            <p className="text-sm text-red-700">Ana depoda bu ürünün kullanılabilir stoğu yok.</p>
          ) : (
            <ol className="border rounded divide-y text-sm">
              {lots.map((b, i) => (
                <li key={b.batch_id} className="px-3 py-2 flex items-center gap-3">
                  {mode === "chosen" ? (
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={chosen.has(b.batch_id)}
                      onChange={(e) =>
                        setChosen((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(b.batch_id);
                          else next.delete(b.batch_id);
                          return next;
                        })
                      }
                      aria-label={`Lot ${b.lot_number}`}
                    />
                  ) : (
                    <span className="text-xs text-gray-500 w-5 text-center">{i + 1}.</span>
                  )}
                  <span className="flex-1 min-w-0">
                    Lot {b.lot_number}
                    {b.serial_number ? ` · Seri ${b.serial_number}` : ""}
                  </span>
                  <ExpiryBadge expiry={b.expiry_date} today={today} />
                  <span className="tabular-nums whitespace-nowrap">
                    {formatQty(b.quantity)} {request.usage_unit}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-gray-500">
            Lotlar son kullanma tarihine göre sıralıdır (en yakın önce); süresi geçmiş lotlar aktarılmaz.
          </p>
        </div>
        {localError && <Notice tone="danger">{localError}</Notice>}
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}
