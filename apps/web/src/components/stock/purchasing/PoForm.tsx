"use client";

// Order builder and editor (spec p8_purchasing §12.4, RPC §5.1). Suggestions on one side, the order list on the
// other. Quantities are entered per line in the purchase or usage unit; prices only by cost viewers.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { centsToInput, formatTL, newId, parseTL } from "@/lib/finance";
import {
  PO_MAX_LINES,
  PO_NOTE_MAX,
  buildPoPayload,
  formLinePriceCents,
  formLineUsageQty,
  lineTotalCents,
  packsOf,
  poDraftKey,
  qtyToInput,
  rowErrorIndex,
  type PoForm as PoFormState,
  type PoFormLine,
} from "@/lib/stock/purchasing";
import {
  istanbulToday,
  newKey,
  stockPoDetail,
  stockPoSave,
  toStockError,
  type LevelRow,
  type PoDetail,
  type StockError,
  type SuggestionRow,
} from "@/lib/stock/rpc";
import { readJson, removeKey, writeJson } from "@/lib/stock/storage";
import { conversionLine, formatQty, qtyInputProblem, type QuantityUnit } from "@/lib/stock/units";
import { ItemPicker } from "../ItemPicker";
import { useStock } from "../StockContext";
import { useStockSuppliers } from "../useStockRefs";
import {
  Card,
  EmptyState,
  Field,
  LevelBadge,
  Loading,
  Notice,
  StockModal,
  Toast,
  bigPrimary,
  buttonDanger,
  buttonSecondary,
  stockInput,
} from "../ui";
import { PurchasingErrorBox } from "./common";
import { SuggestionsPanel } from "./SuggestionsPanel";

const EMPTY_FORM: PoFormState = { supplier_id: "", expected_date: "", note: "", lines: [] };

interface Draft {
  form: PoFormState;
  savedAt: string;
}

function defaultUnit(level: string, factor: number): QuantityUnit {
  return Number(factor) !== 1 && level !== "A" ? "purchase" : "usage";
}

function lineFromSuggestion(r: SuggestionRow, canCost: boolean): PoFormLine {
  const unit = defaultUnit(r.tracking_level, r.units_per_purchase);
  const packs = packsOf(r.need_qty, r.units_per_purchase);
  const usePurchase = unit === "purchase" && packs.whole;
  return {
    stock_item_id: r.stock_item_id,
    item_name: r.item_name,
    tracking_level: r.tracking_level,
    usage_unit: r.usage_unit,
    purchase_unit: r.purchase_unit,
    units_per_purchase: Number(r.units_per_purchase) || 1,
    qty_text: qtyToInput(usePurchase ? packs.packs : r.need_qty),
    quantity_unit: usePurchase ? "purchase" : "usage",
    price_text: canCost && typeof r.last_unit_cost_cents === "number" ? centsToInput(r.last_unit_cost_cents) : "",
    price_unit: "usage",
    note: "",
    card_supplier_id: r.supplier_id,
  };
}

function lineFromLevel(r: LevelRow, canCost: boolean): PoFormLine {
  return {
    stock_item_id: r.id,
    item_name: r.item_name,
    tracking_level: r.tracking_level,
    usage_unit: r.usage_unit,
    purchase_unit: r.purchase_unit,
    units_per_purchase: Number(r.units_per_purchase) || 1,
    qty_text: "",
    quantity_unit: defaultUnit(r.tracking_level, r.units_per_purchase),
    price_text: canCost && typeof r.last_unit_cost_cents === "number" ? centsToInput(r.last_unit_cost_cents) : "",
    price_unit: "usage",
    note: "",
    card_supplier_id: r.supplier_id,
  };
}

function formFromDetail(d: PoDetail, canCost: boolean): PoFormState {
  const o = d.order;
  return {
    supplier_id: o.supplier.id,
    expected_date: o.expected_date ?? "",
    note: o.note ?? "",
    lines: o.lines.map((l) => {
      const factor = Number(l.card_units_per_purchase) || 1;
      const packs = packsOf(l.qty_ordered, factor);
      const usePurchase = factor !== 1 && packs.whole && l.tracking_level !== "A";
      const price = canCost && "unit_price_cents" in l ? l.unit_price_cents ?? null : undefined;
      return {
        stock_item_id: l.stock_item_id,
        item_name: l.item_name,
        tracking_level: l.tracking_level,
        usage_unit: l.usage_unit,
        purchase_unit: l.purchase_unit,
        units_per_purchase: factor,
        qty_text: qtyToInput(usePurchase ? packs.packs : l.qty_ordered),
        quantity_unit: usePurchase ? "purchase" : "usage",
        price_text: typeof price === "number" ? centsToInput(price) : "",
        price_unit: "usage",
        note: l.note ?? "",
        original_price_cents: price,
      };
    }),
  };
}

/** The draft never keeps prices (cost data does not outlive the tab in localStorage). */
function draftOf(form: PoFormState): PoFormState {
  return { ...form, lines: form.lines.map((l) => ({ ...l, price_text: "", original_price_cents: undefined })) };
}

export function PoBuilder({ editId }: { editId: string | null }) {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const { gates, today: serverToday, notifyChanged } = useStock();
  const today = serverToday ?? istanbulToday();
  const canCost = gates.cost;
  const { suppliers, active: activeSuppliers } = useStockSuppliers();

  const orderId = useRef(editId ?? newId());
  const opKey = useRef(newKey());
  const [form, setForm] = useState<PoFormState>(EMPTY_FORM);
  const [original, setOriginal] = useState<PoFormState | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<StockError | null>(null);
  const [loading, setLoading] = useState(!!editId);
  const [notEditable, setNotEditable] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftDecided, setDraftDecided] = useState(!!editId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const draftKey = user ? poDraftKey(user.user_id) : null;

  const loadEdit = useCallback(async () => {
    if (!editId) return;
    setLoading(true);
    try {
      const d = await stockPoDetail(editId);
      const f = formFromDetail(d, d.can_view_costs ?? canCost);
      setForm(f);
      setOriginal(f);
      setVersion(d.order.version);
      setOrderNumber(d.order.order_number);
      setNotEditable(!d.order.actions.can_edit);
      setLoadError(null);
      setError(null);
      setErrorLine(null);
      opKey.current = newKey();
    } catch (e) {
      setLoadError(toStockError(e));
    } finally {
      setLoading(false);
    }
  }, [editId, canCost]);

  useEffect(() => {
    void loadEdit();
  }, [loadEdit]);

  // Create mode: offer an unsent list kept on this device.
  useEffect(() => {
    if (editId || !draftKey) return;
    const d = readJson<Draft>(draftKey);
    if (d && d.form && Array.isArray(d.form.lines) && d.form.lines.length > 0) setDraft(d);
    else setDraftDecided(true);
  }, [editId, draftKey]);

  useEffect(() => {
    if (editId || !draftKey || !draftDecided) return;
    if (form.lines.length === 0 && !form.supplier_id && !form.note) removeKey(draftKey);
    else writeJson(draftKey, { form: draftOf(form), savedAt: new Date().toISOString() } satisfies Draft);
  }, [form, editId, draftKey, draftDecided]);

  const listedIds = useMemo(() => new Set(form.lines.map((l) => l.stock_item_id)), [form.lines]);

  const updateLine = (index: number, patch: Partial<PoFormLine>) => {
    setForm((f) => ({ ...f, lines: f.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));
    if (errorLine === index) setErrorLine(null);
  };

  const addLines = (lines: PoFormLine[]) => {
    let added = 0;
    let skipped = 0;
    const next = [...form.lines];
    let supplier = form.supplier_id;
    for (const l of lines) {
      if (next.some((x) => x.stock_item_id === l.stock_item_id)) continue;
      if (next.length >= PO_MAX_LINES) {
        skipped++;
        continue;
      }
      next.push(l);
      added++;
      // Legacy UP:46: the first card's supplier fills an empty supplier select.
      if (!supplier && l.card_supplier_id && activeSuppliers.some((s) => s.id === l.card_supplier_id)) {
        supplier = l.card_supplier_id;
      }
    }
    setForm({ ...form, supplier_id: supplier, lines: next });
    if (skipped > 0) setToast("En fazla 20 ürün eklenebilir.");
    else if (added === 1) setToast("Listeye eklendi.");
    else if (added > 1) setToast(`${added} ürün listeye eklendi.`);
  };

  const otherSupplierLines = form.supplier_id
    ? form.lines.filter((l) => l.card_supplier_id && l.card_supplier_id !== form.supplier_id).length
    : 0;

  const totalCents = useMemo(() => {
    if (!canCost) return null;
    let sum = 0;
    let unpriced = 0;
    for (const l of form.lines) {
      const usage = formLineUsageQty(l);
      const price = formLinePriceCents(l);
      if (price === null || !Number.isFinite(usage)) unpriced++;
      else sum += lineTotalCents(usage, price);
    }
    return { sum, unpriced };
  }, [form.lines, canCost]);

  const quickInvalid =
    !form.supplier_id ||
    form.lines.length === 0 ||
    form.lines.length > PO_MAX_LINES ||
    form.lines.some((l) => {
      const u = formLineUsageQty(l);
      return !(u > 0) || (l.tracking_level === "A" && !Number.isInteger(u));
    });

  async function submit() {
    setError(null);
    setLocalError(null);
    setErrorLine(null);
    const built = buildPoPayload(form, { canViewCosts: canCost, today, original: editId ? original : null });
    if (!built.ok) {
      setLocalError(built.error);
      setErrorLine(built.line);
      return;
    }
    setBusy(true);
    try {
      const res = await stockPoSave({
        p_operation_key: opKey.current,
        p_order_id: orderId.current,
        p_version: editId ? version : null,
        p_order: built.payload,
      });
      if (!editId && draftKey) removeKey(draftKey);
      opKey.current = newKey();
      notifyChanged();
      router.push(`/inventory/orders/${res.order.id}?saved=${editId ? "edited" : "created"}`);
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      if (err.key === "E_ID_TAKEN" && !editId) {
        orderId.current = newId();
        opKey.current = newKey();
      }
      setErrorLine(rowErrorIndex(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!gates.mgr) {
    return <Notice tone="warn">Sipariş oluşturma yetkiniz yok.</Notice>;
  }
  if (editId && loading && !original) return <Loading />;
  if (editId && loadError && !original) return <PurchasingErrorBox error={loadError} onReload={() => void loadEdit()} />;
  if (editId && notEditable) {
    return (
      <Notice tone="warn">
        Yalnızca onay bekleyen sipariş değiştirilebilir. Gerekirse siparişi iptal edip yenisini oluşturun.{" "}
        <Link href={`/inventory/orders/${editId}`} className="underline">
          Siparişe dön
        </Link>
      </Notice>
    );
  }

  const supplierOptions = (suppliers || []).filter((s) => s.is_active || s.id === form.supplier_id);

  return (
    <div className="grid gap-6 lg:grid-cols-2 items-start">
      {draft && !draftDecided && (
        <div className="lg:col-span-2">
          <Notice tone="info">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-[12rem]">
                Kaydedilmemiş bir sipariş listeniz var ({draft.form.lines.length} ürün). Devam etmek ister misiniz?
              </span>
              <button
                type="button"
                className={`${buttonSecondary} min-h-[44px] bg-white`}
                onClick={() => {
                  setForm({ ...EMPTY_FORM, ...draft.form, lines: draft.form.lines.slice(0, PO_MAX_LINES) });
                  setDraft(null);
                  setDraftDecided(true);
                }}
              >
                Devam et
              </button>
              <button
                type="button"
                className={`${buttonDanger} min-h-[44px] bg-white`}
                onClick={() => {
                  if (draftKey) removeKey(draftKey);
                  setDraft(null);
                  setDraftDecided(true);
                }}
              >
                Sil
              </button>
            </div>
          </Notice>
        </div>
      )}

      <SuggestionsPanel
        orderSupplierId={form.supplier_id}
        suppliers={activeSuppliers}
        listedIds={listedIds}
        lineCount={form.lines.length}
        onAdd={(rows) => addLines(rows.map((r) => lineFromSuggestion(r, canCost)))}
      />

      <Card title={editId ? `Sipariş ${orderNumber ?? ""}` : "Sipariş listesi"}>
        <div className="space-y-4">
          <Field label="Tedarikçi *">
            <select
              className={stockInput}
              value={form.supplier_id}
              onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value }))}
            >
              <option value="">Tedarikçi seçin</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
          {otherSupplierLines > 0 && <Notice tone="warn">Listede başka tedarikçiye bağlı ürünler var.</Notice>}

          {form.lines.length === 0 ? (
            <EmptyState>Listede ürün yok. Önerilerden ekleyin veya başka ürün seçin.</EmptyState>
          ) : (
            <ol className="space-y-3">
              {form.lines.map((l, i) => (
                <PoLineEditor
                  key={l.stock_item_id}
                  index={i}
                  line={l}
                  canCost={canCost}
                  highlighted={errorLine === i}
                  onChange={(patch) => updateLine(i, patch)}
                  onRemove={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}
                />
              ))}
            </ol>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${buttonSecondary} min-h-[44px]`}
              disabled={form.lines.length >= PO_MAX_LINES}
              onClick={() => setPickerOpen(true)}
            >
              Başka ürün ekle
            </button>
            <span className="text-xs text-gray-500">
              {form.lines.length} / {PO_MAX_LINES} ürün
            </span>
          </div>

          {totalCents && form.lines.length > 0 && (
            <p className="text-sm">
              Sipariş toplamı <span className="font-semibold tabular-nums">{formatTL(totalCents.sum)}</span>
              {totalCents.unpriced > 0 && <span className="text-amber-700"> · {totalCents.unpriced} satır fiyatsız</span>}
            </p>
          )}
          {!canCost && (
            <p className="text-xs text-gray-600">
              Fiyatları maliyet yetkisi olan kişi girer; mal kabulde maliyet sipariş fiyatından otomatik alınır.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Beklenen teslim tarihi">
              <input
                type="date"
                className={stockInput}
                min={today}
                value={form.expected_date}
                onChange={(e) => setForm((f) => ({ ...f, expected_date: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Not" hint={`${form.note.trim().length} / ${PO_NOTE_MAX}`}>
            <textarea
              className={stockInput}
              rows={2}
              maxLength={PO_NOTE_MAX + 50}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </Field>

          {localError && <Notice tone="danger">{localError}</Notice>}
          <PurchasingErrorBox error={error} onReload={editId ? () => void loadEdit() : undefined} />

          <button type="button" className={bigPrimary} disabled={busy || quickInvalid} onClick={() => void submit()}>
            {busy ? "Kaydediliyor..." : editId ? "Değişiklikleri kaydet" : "Onaya gönder"}
          </button>
          {editId && (
            <Link href={`/inventory/orders/${editId}`} className="block text-center text-sm text-blue-700 hover:underline">
              Vazgeç
            </Link>
          )}
        </div>
      </Card>

      {pickerOpen && (
        <StockModal title="Başka ürün ekle" onClose={() => setPickerOpen(false)}>
          <ItemPicker
            autoFocus
            onPick={(row) => {
              if (listedIds.has(row.id)) {
                setToast("Bu ürün listede zaten var.");
                return;
              }
              addLines([lineFromLevel(row, canCost)]);
              setPickerOpen(false);
            }}
          />
        </StockModal>
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function PoLineEditor({
  index,
  line,
  canCost,
  highlighted,
  onChange,
  onRemove,
}: {
  index: number;
  line: PoFormLine;
  canCost: boolean;
  highlighted: boolean;
  onChange: (patch: Partial<PoFormLine>) => void;
  onRemove: () => void;
}) {
  const factor = Number(line.units_per_purchase) || 1;
  const hasPack = factor !== 1 && line.purchase_unit && line.purchase_unit !== line.usage_unit;
  const usage = formLineUsageQty(line);
  const qtyProblem = line.qty_text.trim() ? qtyInputProblem(line.qty_text) : null;
  const priceText = line.price_text.trim();
  const priceParsed = priceText ? parseTL(priceText, { allowZero: true }) : null;
  const pricePerUsage = formLinePriceCents(line);
  const rounded =
    priceParsed && priceParsed.ok && line.price_unit === "purchase" && factor !== 1 && priceParsed.cents % factor !== 0;

  return (
    <li className={`border rounded p-3 space-y-2 ${highlighted ? "border-red-400 bg-red-50" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs text-gray-500 mr-1">{index + 1}.</span>
          <span className="font-medium">{line.item_name}</span> <LevelBadge level={line.tracking_level} />
        </div>
        <button type="button" className="text-sm text-red-600 hover:underline min-h-[44px] px-2" onClick={onRemove}>
          Çıkar
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Miktar">
          <div className="flex gap-2">
            <input
              className={stockInput}
              inputMode="decimal"
              value={line.qty_text}
              onChange={(e) => onChange({ qty_text: e.target.value })}
              aria-label={`${line.item_name} miktarı`}
            />
            {hasPack ? (
              <select
                className={`${stockInput} max-w-[8rem]`}
                value={line.quantity_unit}
                onChange={(e) => onChange({ quantity_unit: e.target.value as QuantityUnit })}
                aria-label="Birim"
              >
                <option value="purchase">{line.purchase_unit}</option>
                <option value="usage">{line.usage_unit}</option>
              </select>
            ) : (
              <span className="self-center text-sm text-gray-700">{line.usage_unit}</span>
            )}
          </div>
          {qtyProblem ? (
            <span className="block text-xs text-red-600 mt-1">{qtyProblem}</span>
          ) : line.quantity_unit === "purchase" && Number.isFinite(usage) ? (
            <span className="block text-xs text-gray-500 mt-1">
              {conversionLine(usage / factor, line.purchase_unit, line.usage_unit, factor)}
            </span>
          ) : null}
        </Field>
        {canCost && (
          <Field label="Birim fiyat">
            <div className="flex gap-2">
              <input
                className={stockInput}
                inputMode="decimal"
                placeholder="Fiyat girilmemiş"
                value={line.price_text}
                onChange={(e) => onChange({ price_text: e.target.value })}
                aria-label={`${line.item_name} birim fiyatı`}
              />
              {hasPack && (
                <select
                  className={`${stockInput} max-w-[9rem]`}
                  value={line.price_unit}
                  onChange={(e) => onChange({ price_unit: e.target.value as QuantityUnit })}
                  aria-label="Fiyat birimi"
                >
                  <option value="usage">{line.usage_unit} başı</option>
                  <option value="purchase">{line.purchase_unit} başı</option>
                </select>
              )}
            </div>
            {priceParsed && !priceParsed.ok ? (
              <span className="block text-xs text-red-600 mt-1">{priceParsed.error}</span>
            ) : (
              <>
                {rounded && pricePerUsage !== null && (
                  <span className="block text-xs text-amber-700 mt-1">
                    {line.purchase_unit} fiyatı {line.usage_unit} başına yuvarlandı: {formatTL(pricePerUsage)}
                  </span>
                )}
                {pricePerUsage !== null && Number.isFinite(usage) && usage > 0 && (
                  <span className="block text-xs text-gray-600 mt-1">
                    Tutar {formatTL(lineTotalCents(usage, pricePerUsage))} ({formatQty(usage)} {line.usage_unit})
                  </span>
                )}
              </>
            )}
          </Field>
        )}
      </div>
      <input
        className={`${stockInput} text-sm`}
        placeholder="Satır notu (isteğe bağlı)"
        maxLength={250}
        value={line.note}
        onChange={(e) => onChange({ note: e.target.value })}
        aria-label="Satır notu"
      />
    </li>
  );
}
