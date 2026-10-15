"use client";

// Goods receipt against a purchase order (spec p8_purchasing §12.5, RPC §5.3): 1–20 rows of one order in one
// all-or-nothing call. Each row is one lot / serial of one order line; "Lot / seri ekle" splits a line into rows.
// The order price becomes the batch cost on the server; cost viewers may type the invoice price instead.

import { useMemo, useRef, useState } from "react";
import { centsToInput, formatTL, parseTL } from "@/lib/finance";
import { resolveStockScan, type MatchItem } from "@/lib/stock/barcode-match";
import { daysLeft } from "@/lib/stock/expiry";
import { packsOf, qtyLabel, qtyToInput, rowErrorIndex } from "@/lib/stock/purchasing";
import {
  newKey,
  stockDb,
  stockPoReceive,
  toStockError,
  type PoDetailOrder,
  type PoLineJson,
  type PoReceiveRow,
  type StockError,
} from "@/lib/stock/rpc";
import { formatQty, isWholeNumber, parseQty, quantityInStockUnits, type QuantityUnit } from "@/lib/stock/units";
import { BarcodeScanner } from "../ItemPicker";
import { useStockLocations } from "../useStockRefs";
import { Field, LevelBadge, Notice, StockErrorBox, StockModal, bigPrimary, buttonSecondary, stockInput } from "../ui";

const MAX_ROWS = 20;

interface ReceiveRowState {
  key: string;
  lineId: string;
  qty_text: string;
  unit: QuantityUnit;
  to: string;
  lot: string;
  serial: string;
  expiry: string;
  /** Cost viewers: type the invoice price instead of the order price. */
  custom_cost: boolean;
  cost_text: string;
  cost_unit: QuantityUnit;
  scan_error: string | null;
}

function factorOf(line: PoLineJson): number {
  return Number(line.card_units_per_purchase) || Number(line.units_per_purchase) || 1;
}

function newRow(line: PoLineJson, qty: number, to: string): ReceiveRowState {
  const factor = factorOf(line);
  const packs = packsOf(qty, factor);
  const usePurchase = factor !== 1 && packs.whole && qty > 0 && line.tracking_level !== "A";
  return {
    key: newKey(),
    lineId: line.id,
    qty_text: qty > 0 ? qtyToInput(usePurchase ? packs.packs : qty) : "",
    unit: usePurchase ? "purchase" : "usage",
    to,
    lot: line.tracking_level === "C" ? "GENEL" : "",
    serial: "",
    expiry: "",
    custom_cost: false,
    cost_text: "",
    cost_unit: "usage",
    scan_error: null,
  };
}

export function PoReceiveDialog({
  order,
  lineIds,
  canCost,
  today,
  onClose,
  onDone,
  onStale,
}: {
  order: PoDetailOrder;
  /** Lines to open the dialog with (one for "Mal kabul", every open line for "Teslimatı kaydet"). */
  lineIds: string[];
  canCost: boolean;
  today: string;
  onClose: () => void;
  onDone: (message: string) => void;
  /**
   * The order changed since the dialog opened (E_VERSION), or this receipt may already have been saved (E_OP_KEY
   * after a lost response). The parent closes the dialog, re-reads the order and shows the message, so nobody
   * receives the same goods twice (a PO receipt cannot be corrected afterwards).
   */
  onStale: (message: string) => void;
}) {
  const { active: locations, defaultWarehouse } = useStockLocations();
  const linesById = useMemo(() => new Map(order.lines.map((l) => [l.id, l])), [order.lines]);
  const defaultTo = defaultWarehouse?.id ?? "";
  // The version the dialog was opened with: a receipt saved meanwhile (by anyone) answers E_VERSION.
  const openedVersion = useRef(order.version);
  // The card's preferred location when it is set and active (spec §12.5), else the default warehouse.
  const preferredTo = (line: PoLineJson | undefined) =>
    line?.preferred_location_id && locations.some((l) => l.id === line.preferred_location_id)
      ? line.preferred_location_id
      : "";
  const [rows, setRows] = useState<ReceiveRowState[]>(() =>
    lineIds
      .map((id) => linesById.get(id))
      .filter((l): l is PoLineJson => !!l && Number(l.qty_remaining) > 0)
      .slice(0, MAX_ROWS)
      .map((l) => newRow(l, Number(l.qty_remaining), ""))
  );
  const [documentNo, setDocumentNo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<{ row: number | null; text: string } | null>(null);
  const [errorRow, setErrorRow] = useState<number | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const gtins = useRef<Promise<MatchItem[]> | null>(null);
  const opKey = useRef(newKey());

  // Rows opened before the locations loaded take the default warehouse.
  const effectiveTo = (r: ReceiveRowState) => r.to || preferredTo(linesById.get(r.lineId)) || defaultTo;

  const update = (key: string, patch: Partial<ReceiveRowState>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const usageOf = (r: ReceiveRowState) => {
    const line = linesById.get(r.lineId);
    if (!line) return NaN;
    return quantityInStockUnits(parseQty(r.qty_text), r.unit, factorOf(line));
  };

  function validate(): { row: number | null; text: string } | null {
    if (rows.length === 0) return { row: null, text: "Kaydedilecek satır yok." };
    if (rows.length > MAX_ROWS) return { row: null, text: "Bir kayıtta en fazla 20 satır olabilir." };
    const used = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = linesById.get(r.lineId);
      const at = (text: string) => ({ row: i, text: `${i + 1}. satır: ${text}` });
      if (!line) return at("Sipariş satırı bulunamadı.");
      const q = usageOf(r);
      if (!(q > 0) || !Number.isFinite(q)) return at("Miktar sıfırdan büyük olmalıdır.");
      if (line.tracking_level === "A" && !isWholeNumber(q)) return at("Bu üründe tam adet girin.");
      const sum = (used.get(r.lineId) ?? 0) + q;
      used.set(r.lineId, sum);
      if (sum > Number(line.qty_remaining) + 1e-9) return at("Giriş miktarı siparişin kalan miktarından fazla.");
      if (!effectiveTo(r)) return at("Malzemeyi koyduğunuz konumu seçin.");
      const lot = r.lot.trim();
      if ((line.tracking_level === "A" || line.tracking_level === "B") && (!lot || lot.toUpperCase() === "GENEL")) {
        return at("Bu üründe ambalajdaki lot / parti numarasını girin.");
      }
      if (line.tracking_level === "B" && !r.expiry) return at("Bu üründe son kullanma tarihini girin.");
      if (r.expiry && daysLeft(r.expiry, today) < 0) return at("Süresi geçmiş ürün yeni stok olarak kabul edilemez.");
      if (r.serial.trim() && q !== 1) return at("Seri numaralı ürünleri tek tek, 1 adet olarak girin.");
      if (canCost && (r.custom_cost || line.unit_price_cents === null || line.unit_price_cents === undefined)) {
        const text = r.cost_text.trim();
        if (r.custom_cost && !text) return at("Faturadaki birim maliyeti girin.");
        if (text) {
          const parsed = parseTL(text, { allowZero: true });
          if (!parsed.ok) return at(parsed.error);
        }
      }
    }
    return null;
  }

  function buildRows(): PoReceiveRow[] {
    return rows.map((r) => {
      const line = linesById.get(r.lineId)!;
      const factor = factorOf(line);
      const out: PoReceiveRow = {
        po_item_id: r.lineId,
        to_location_id: effectiveTo(r),
        quantity: parseQty(r.qty_text),
        lot_number: r.lot.trim() || null,
        serial_number: r.serial.trim() || null,
        expiry_date: r.expiry || null,
      };
      let purchaseUsed = false;
      if (r.unit === "purchase") {
        out.quantity_unit = "purchase";
        purchaseUsed = true;
      }
      const priced = typeof line.unit_price_cents === "number";
      if (canCost && (r.custom_cost || !priced) && r.cost_text.trim()) {
        const parsed = parseTL(r.cost_text.trim(), { allowZero: true });
        if (parsed.ok) {
          out.unit_cost_cents = parsed.cents;
          if (r.cost_unit === "purchase" && factor !== 1) {
            out.cost_unit = "purchase";
            purchaseUsed = true;
          }
        }
      }
      if (purchaseUsed) out.units_per_purchase = factor;
      return out;
    });
  }

  async function submit() {
    setError(null);
    setErrorRow(null);
    const problem = validate();
    setLocalError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await stockPoReceive({
        p_operation_key: opKey.current,
        p_order_id: order.id,
        p_lines: buildRows(),
        p_document_no: documentNo.trim() || null,
        p_reason: reason.trim() || null,
        p_version: openedVersion.current,
      });
      opKey.current = newKey();
      onDone("Mal kabul kaydedildi.");
    } catch (e) {
      const err = toStockError(e);
      // A network failure keeps the key: pressing the button again with the same rows replays the same call
      // (already_saved). Changed rows under the same key (E_OP_KEY) or a newer order version (E_VERSION) mean the
      // earlier attempt may have been saved: never retry blindly, re-read the order instead.
      if (err.key === "E_OP_KEY" || err.key === "E_VERSION") {
        onStale(
          "Sipariş bu pencere açıldıktan sonra değişti veya önceki mal kabul denemeniz kaydedilmiş olabilir. " +
            "Satırların altındaki mal kabul kayıtlarını kontrol edin; gerekiyorsa kalan miktar için yeniden mal kabul yapın."
        );
        return;
      }
      setErrorRow(rowErrorIndex(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** The order's cards with their barcodes (read once, when the scanner is first used). */
  function loadGtins(): Promise<MatchItem[]> {
    if (!gtins.current) {
      const ids = Array.from(new Set(order.lines.map((l) => l.stock_item_id)));
      gtins.current = Promise.resolve(stockDb().from("stock_items").select("id,gtin,item_name").in("id", ids)).then(
        ({ data, error: err }) => {
          if (err) {
            gtins.current = null;
            return [];
          }
          return ((data || []) as { id: string; gtin: string | null; item_name: string }[]).map((d) => ({
            id: d.id,
            gtin: d.gtin,
            name: d.item_name,
          }));
        }
      );
    }
    return gtins.current;
  }

  function openScanner(rowKey: string) {
    setScanFor(rowKey);
    void loadGtins();
  }

  async function handleScan(raw: string) {
    const rowKey = scanFor;
    setScanFor(null);
    if (!rowKey) return;
    const row = rows.find((r) => r.key === rowKey);
    const line = row ? linesById.get(row.lineId) : null;
    if (!row || !line) return;
    try {
      const scan = resolveStockScan(raw, await loadGtins(), line.stock_item_id);
      const patch: Partial<ReceiveRowState> = { scan_error: null };
      if (scan.lot) patch.lot = scan.lot;
      if (scan.expiry) patch.expiry = scan.expiry;
      if (scan.serial) {
        patch.serial = scan.serial;
        patch.qty_text = "1";
        patch.unit = "usage";
      }
      update(rowKey, patch);
    } catch (e) {
      update(rowKey, { scan_error: e instanceof Error ? e.message : String(e) });
    }
  }

  const highlighted = errorRow ?? localError?.row ?? null;

  return (
    <StockModal
      title={`Mal kabul · ${order.order_number}`}
      description={order.supplier.name}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <button type="button" className={bigPrimary} disabled={busy || rows.length === 0} onClick={() => void submit()}>
          {busy ? "Kaydediliyor..." : "Mal kabulü kaydet"}
        </button>
      }
    >
      <div className="space-y-4">
        <Notice tone="warn">
          Siparişe bağlı mal kabul kayıtları sonradan düzeltme talebiyle değiştirilemez; miktarları ambalajla kontrol edin.
        </Notice>
        {rows.length === 0 && <p className="text-sm text-gray-600">Teslim alınacak açık satır yok.</p>}
        {rows.map((r, i) => {
          const line = linesById.get(r.lineId);
          if (!line) return null;
          const factor = factorOf(line);
          const hasPack = factor !== 1 && line.purchase_unit && line.purchase_unit !== line.usage_unit;
          const usage = usageOf(r);
          const priced = typeof line.unit_price_cents === "number";
          const sameLineRows = rows.filter((x) => x.lineId === r.lineId).length;
          return (
            <fieldset
              key={r.key}
              className={`border rounded p-3 space-y-3 ${highlighted === i ? "border-red-400 bg-red-50" : ""}`}
            >
              <legend className="px-1 text-sm">
                <span className="text-gray-500">{i + 1}. </span>
                <span className="font-semibold">{line.item_name}</span> <LevelBadge level={line.tracking_level} />
              </legend>
              <p className="text-xs text-gray-600">
                Kalan {qtyLabel(Number(line.qty_remaining), line.usage_unit, line.purchase_unit, factor)}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Miktar *">
                  <div className="flex gap-2">
                    <input
                      className={stockInput}
                      inputMode="decimal"
                      value={r.qty_text}
                      onChange={(e) => update(r.key, { qty_text: e.target.value })}
                    />
                    {hasPack ? (
                      <select
                        className={`${stockInput} max-w-[8rem]`}
                        value={r.unit}
                        onChange={(e) => update(r.key, { unit: e.target.value as QuantityUnit })}
                        aria-label="Birim"
                      >
                        <option value="purchase">{line.purchase_unit}</option>
                        <option value="usage">{line.usage_unit}</option>
                      </select>
                    ) : (
                      <span className="self-center text-sm text-gray-700">{line.usage_unit}</span>
                    )}
                  </div>
                  {r.unit === "purchase" && Number.isFinite(usage) && (
                    <span className="block text-xs text-gray-500 mt-1">
                      = {formatQty(usage)} {line.usage_unit}
                    </span>
                  )}
                </Field>
                <Field label="Konum *">
                  <select className={stockInput} value={effectiveTo(r)} onChange={(e) => update(r.key, { to: e.target.value })}>
                    <option value="">Seçin</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.is_default_warehouse ? " (ana depo)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={line.tracking_level === "C" ? "Lot" : "Lot *"}>
                  <input className={stockInput} value={r.lot} onChange={(e) => update(r.key, { lot: e.target.value })} />
                </Field>
                <Field label={line.tracking_level === "B" ? "Son kullanma tarihi *" : "Son kullanma tarihi"}>
                  <input
                    type="date"
                    className={stockInput}
                    min={today}
                    value={r.expiry}
                    onChange={(e) => update(r.key, { expiry: e.target.value })}
                  />
                </Field>
                {line.tracking_level === "A" && (
                  <Field label="Seri numarası" hint="Seri numaralı ürünler tek tek, 1 adet olarak girilir.">
                    <input className={stockInput} value={r.serial} onChange={(e) => update(r.key, { serial: e.target.value })} />
                  </Field>
                )}
                {canCost && (
                  <Field
                    label="Birim maliyet"
                    hint={
                      priced && !r.custom_cost
                        ? `Sipariş fiyatı: ${formatTL(line.unit_price_cents)} / ${line.usage_unit}`
                        : !priced
                          ? "Boş bırakılırsa kartın son maliyeti kullanılır."
                          : undefined
                    }
                  >
                    {priced && (
                      <label className="flex items-center gap-2 text-sm mb-1 min-h-[32px]">
                        <input
                          type="checkbox"
                          checked={r.custom_cost}
                          onChange={(e) =>
                            update(r.key, {
                              custom_cost: e.target.checked,
                              cost_text: e.target.checked && !r.cost_text ? centsToInput(line.unit_price_cents) : r.cost_text,
                            })
                          }
                        />
                        Faturadaki fiyat farklı
                      </label>
                    )}
                    {(!priced || r.custom_cost) && (
                      <div className="flex gap-2">
                        <input
                          className={stockInput}
                          inputMode="decimal"
                          value={r.cost_text}
                          onChange={(e) => update(r.key, { cost_text: e.target.value })}
                        />
                        {hasPack && (
                          <select
                            className={`${stockInput} max-w-[9rem]`}
                            value={r.cost_unit}
                            onChange={(e) => update(r.key, { cost_unit: e.target.value as QuantityUnit })}
                            aria-label="Maliyet birimi"
                          >
                            <option value="usage">{line.usage_unit} başı</option>
                            <option value="purchase">{line.purchase_unit} başı</option>
                          </select>
                        )}
                      </div>
                    )}
                  </Field>
                )}
              </div>
              {!canCost && <p className="text-xs text-gray-500">Maliyet sipariş fiyatından otomatik alınır.</p>}
              {r.scan_error && <p className="text-sm text-red-700">{r.scan_error}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={`${buttonSecondary} text-sm min-h-[44px]`} onClick={() => openScanner(r.key)}>
                  Barkod okut
                </button>
                <button
                  type="button"
                  className={`${buttonSecondary} text-sm min-h-[44px]`}
                  disabled={rows.length >= MAX_ROWS}
                  onClick={() =>
                    setRows((rs) => {
                      const idx = rs.findIndex((x) => x.key === r.key);
                      const copy = [...rs];
                      copy.splice(idx + 1, 0, { ...newRow(line, 0, effectiveTo(r)), lot: line.tracking_level === "C" ? r.lot : "" });
                      return copy;
                    })
                  }
                >
                  {line.tracking_level === "A" ? "Seri ekle" : "Lot ekle"}
                </button>
                {(sameLineRows > 1 || rows.length > 1) && (
                  <button
                    type="button"
                    className="text-sm text-red-600 hover:underline min-h-[44px] px-2"
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  >
                    Satırı çıkar
                  </button>
                )}
              </div>
            </fieldset>
          );
        })}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="İrsaliye / fatura no">
            <input className={stockInput} maxLength={60} value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} />
          </Field>
          <Field label="Not">
            <input className={stockInput} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        {localError && <Notice tone="danger">{localError.text}</Notice>}
        <StockErrorBox error={error} />
      </div>
      {scanFor && <BarcodeScanner purpose="movement" onClose={() => setScanFor(null)} onScan={(raw) => void handleScan(raw)} />}
    </StockModal>
  );
}
