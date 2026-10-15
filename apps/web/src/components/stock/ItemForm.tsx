"use client";

// Stock card form (spec p7_rules_ui §20.4, contract §4.11-4.12). Create and edit go through stock_save_item; a card
// defined from a product request goes through stock_define_item('create') so the request is resolved with it.

import { useMemo, useRef, useState } from "react";
import {
  ABC_CLASSES,
  DEFAULT_CATEGORIES,
  ORDER_POLICIES,
  ORDER_POLICY_LABELS,
  TRACKING_INFO,
  TRACKING_LEVELS,
  categoryLabel,
  type AbcClass,
  type OrderPolicy,
  type TrackingLevel,
} from "@/lib/stock/codes";
import {
  newKey,
  stockDefineItem,
  stockSaveItem,
  stockScanLookup,
  toStockError,
  type ItemDetailJson,
  type ItemInput,
  type LevelRow,
  type ProductRequestJson,
  type StockError,
} from "@/lib/stock/rpc";
import { gtinCheckDigitOk, normalizeGtin } from "@/lib/stock/gs1";
import { resolveNewProductGtin } from "@/lib/stock/barcode-match";
import { formatQty, parseQty } from "@/lib/stock/units";
import { centsToInput, formatTL, parseTL } from "@/lib/finance";
import { BarcodeScanner } from "./ItemPicker";
import { useStockLocations, useStockSuppliers } from "./useStockRefs";
import { Field, Notice, StockErrorBox, buttonPrimary, buttonSecondary, stockInput } from "./ui";

type EditableItem = ItemDetailJson["item"];

interface FormState {
  item_name: string;
  brand: string;
  model: string;
  category: string;
  tracking_level: TrackingLevel | "";
  gtin: string;
  purchase_unit: string;
  usage_unit: string;
  units_per_purchase: string;
  item_code: string;
  min_qty: string;
  max_qty: string;
  abc_class: AbcClass;
  order_policy: OrderPolicy;
  preferred_location_id: string;
  supplier_id: string;
  notes: string;
  needs_review: boolean;
  cost: string;
  cost_is_box: boolean;
}

function initialState(item?: EditableItem | null, gtin?: string, name?: string): FormState {
  return {
    item_name: item?.item_name ?? name ?? "",
    brand: item?.brand ?? "",
    model: item?.model ?? "",
    category: item?.category ? categoryLabel(item.category) : "",
    tracking_level: item?.tracking_level ?? "",
    gtin: item?.gtin ?? gtin ?? "",
    purchase_unit: item?.purchase_unit ?? "adet",
    usage_unit: item?.usage_unit ?? "adet",
    units_per_purchase: item ? String(item.units_per_purchase).replace(".", ",") : "1",
    item_code: item?.item_code ?? "",
    min_qty: item ? String(item.min_qty).replace(".", ",") : "0",
    max_qty: item ? String(item.max_qty).replace(".", ",") : "0",
    abc_class: (item?.abc_class ?? "") as AbcClass,
    order_policy: (item?.order_policy ?? "") as OrderPolicy,
    preferred_location_id: item?.preferred_location_id ?? "",
    supplier_id: item?.supplier_id ?? "",
    notes: item?.notes ?? "",
    needs_review: item?.needs_review ?? false,
    cost: item && item.last_unit_cost_cents !== undefined ? centsToInput(item.last_unit_cost_cents) : "",
    cost_is_box: false,
  };
}

export function ItemForm({
  item,
  request,
  initialGtin,
  canViewCosts,
  onSaved,
  onCancel,
  onReload,
  submitLabel,
}: {
  /** Edit mode when given. */
  item?: EditableItem | null;
  /** New-from-request mode (stock_define_item 'create'). */
  request?: ProductRequestJson | null;
  /** New card from an unknown scan. */
  initialGtin?: string;
  canViewCosts: boolean;
  onSaved: (item: LevelRow, alreadySaved: boolean) => void;
  onCancel?: () => void;
  /** E_ITEM_VERSION: reloads the card, keeping what was typed (the caller re-mounts with fresh data). */
  onReload?: () => void;
  submitLabel?: string;
}) {
  const isEdit = !!item;
  const [form, setForm] = useState<FormState>(() =>
    initialState(item, request?.gtin ?? initialGtin, request?.name)
  );
  const [showAdmin, setShowAdmin] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const opKey = useRef(newKey());
  const newId = useRef(newKey());

  const { active: locations } = useStockLocations();
  const { suppliers } = useStockSuppliers();

  const locked = new Set(item?.locked_fields ?? []);
  const hasHistory = !!item?.has_history || locked.size > 0;
  const original = useMemo(() => initialState(item), [item]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const factor = parseQty(form.units_per_purchase);
  const gtinFromRequest = !!request;

  async function onScanned(raw: string) {
    setScanMessage(null);
    try {
      const gtin = resolveNewProductGtin(raw, []);
      const look = await stockScanLookup({ gtin });
      const others = look.item && look.item.id !== item?.id ? [{ id: look.item.id, gtin: look.item.gtin, name: look.item.item_name }] : [];
      resolveNewProductGtin(raw, others);
      set("gtin", gtin);
    } catch (e) {
      setScanMessage(e instanceof Error ? e.message : toStockError(e).message);
    }
  }

  function buildInput(): ItemInput | null {
    const name = form.item_name.trim();
    let category = form.category.trim();
    // Old category codes (materials, …) are shown with their Turkish label; unchanged, the code is kept.
    if (item?.category && category === categoryLabel(item.category)) category = item.category;
    if (!name || !category || !form.tracking_level) {
      setLocalError("Ürün adı, kategori ve takip kuralını tamamlayın.");
      return null;
    }
    const upp = parseQty(form.units_per_purchase);
    const min = parseQty(form.min_qty || "0");
    const max = parseQty(form.max_qty || "0");
    if (!(upp > 0) || upp > 100000 || Number.isNaN(min) || Number.isNaN(max)) {
      setLocalError("Miktar, dönüşüm ve maliyet alanlarını kontrol edin.");
      return null;
    }
    if (max < min) {
      setLocalError("Hedef stok, kritik stoktan küçük olamaz.");
      return null;
    }
    const pu = form.purchase_unit.trim();
    const uu = form.usage_unit.trim();
    if (!form.needs_review && (!pu || !uu || /^belirlenecek$/i.test(pu) || /^belirlenecek$/i.test(uu))) {
      setLocalError("Alış ve tüketim birimini tamamlayın.");
      return null;
    }
    let gtin: string | null = null;
    if (!gtinFromRequest && form.gtin.trim()) {
      gtin = normalizeGtin(form.gtin);
      if (!gtin) {
        setLocalError("Barkod 8, 12, 13 veya 14 rakam olmalıdır.");
        return null;
      }
    }
    if (form.notes.length > 2000) {
      setLocalError("Kart notu en fazla 2000 karakter olabilir.");
      return null;
    }

    const input: ItemInput = {
      item_name: name,
      category,
      brand: form.brand.trim(),
      model: form.model.trim(),
      min_qty: min,
      max_qty: max,
      abc_class: form.abc_class,
      order_policy: form.order_policy,
      preferred_location_id: form.preferred_location_id || null,
      supplier_id: form.supplier_id || null,
      notes: form.notes.trim(),
      needs_review: form.needs_review,
    };
    if (!gtinFromRequest) input.gtin = gtin;
    if (form.item_code.trim()) input.item_code = form.item_code.trim();
    // Locked fields are left out entirely: the server keeps them (contract §4.12, absent key = unchanged).
    if (!locked.has("tracking_level")) input.tracking_level = form.tracking_level;
    if (!locked.has("purchase_unit")) input.purchase_unit = pu;
    if (!locked.has("usage_unit")) input.usage_unit = uu;
    if (!locked.has("units_per_purchase")) input.units_per_purchase = upp;

    // The cost key is sent only by cost viewers and only when it changed (E_COST_FORBIDDEN otherwise).
    if (canViewCosts && form.cost.trim() !== original.cost.trim()) {
      if (!form.cost.trim()) {
        input.last_unit_cost_cents = null;
      } else {
        const parsed = parseTL(form.cost, { allowZero: true });
        if (!parsed.ok) {
          setLocalError(parsed.error);
          return null;
        }
        let cents = parsed.cents;
        if (form.cost_is_box) {
          if (!(upp > 0)) {
            setLocalError("Miktar, dönüşüm ve maliyet alanlarını kontrol edin.");
            return null;
          }
          cents = Math.round(cents / upp);
        }
        input.last_unit_cost_cents = cents;
      }
    }
    return input;
  }

  async function submit() {
    setLocalError(null);
    setError(null);
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    try {
      let saved: LevelRow;
      let already = false;
      if (request) {
        const r = await stockDefineItem({
          p_operation_key: opKey.current,
          p_request_id: request.id,
          p_action: "create",
          p_item_id: newId.current,
          p_item: input,
          p_note: null,
        });
        if (!r.item) throw new Error("Kart oluşturulamadı.");
        saved = r.item;
        already = r.already_saved;
      } else {
        const r = await stockSaveItem({
          p_operation_key: opKey.current,
          p_id: item ? item.id : newId.current,
          p_version: item ? item.version : null,
          p_item: input,
        });
        saved = r.item;
        already = r.already_saved;
      }
      opKey.current = newKey();
      newId.current = newKey();
      onSaved(saved, already);
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const gtinNormalized = normalizeGtin(form.gtin);
  const checkWarning = gtinNormalized && !gtinCheckDigitOk(gtinNormalized);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {request && (
        <Notice tone="info">
          Tanımlama talebi: <strong>{request.name}</strong>
          {request.note ? ` · ${request.note}` : ""}. Barkod talepten gelir; yanlış okunduysa talebi
          &quot;Tanımlanmayacak&quot; olarak kapatıp kartı doğru barkodla ayrıca tanımlayın.
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Ürün adı *" className="md:col-span-2">
          <input className={stockInput} value={form.item_name} maxLength={200} onChange={(e) => set("item_name", e.target.value)} />
        </Field>
        <Field label="Marka">
          <input className={stockInput} value={form.brand} maxLength={120} onChange={(e) => set("brand", e.target.value)} />
        </Field>
        <Field label="Model / özellik">
          <input className={stockInput} value={form.model} maxLength={120} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="Kategori *" hint="Listeden seçin veya yeni kategori yazın.">
          <input
            className={stockInput}
            value={form.category}
            maxLength={80}
            list="stock-category-options"
            onChange={(e) => set("category", e.target.value)}
          />
          <datalist id="stock-category-options">
            {DEFAULT_CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      </div>

      <fieldset>
        <legend className="text-sm font-semibold text-gray-800 mb-2">Takip kuralı *</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {TRACKING_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={form.tracking_level === level}
              disabled={locked.has("tracking_level")}
              onClick={() => set("tracking_level", level)}
              className={`text-left p-3 rounded-lg border min-h-[44px] disabled:opacity-60 ${
                form.tracking_level === level ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600" : "border-gray-300 hover:bg-gray-50"
              }`}
            >
              <span className="block font-semibold">
                {level} · {TRACKING_INFO[level].choice}
              </span>
              <span className="block text-xs text-gray-600 mt-1">{TRACKING_INFO[level].description}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Barkod (GTIN)"
          hint={
            gtinFromRequest
              ? "Talepteki barkod kullanılır."
              : checkWarning
                ? "Kontrol hanesi tutmuyor; ambalajdaki numarayı tekrar kontrol edin."
                : "8, 12, 13 veya 14 rakam. Boş bırakılabilir."
          }
        >
          <div className="flex gap-2">
            <input
              className={stockInput}
              value={form.gtin}
              inputMode="numeric"
              maxLength={14}
              disabled={gtinFromRequest}
              onChange={(e) => set("gtin", e.target.value.replace(/\D/g, ""))}
            />
            {!gtinFromRequest && (
              <button type="button" className={`${buttonSecondary} whitespace-nowrap min-h-[44px]`} onClick={() => setScanOpen(true)}>
                Kamerayla
              </button>
            )}
          </div>
          {scanMessage && (
            <span role="alert" className="block text-xs text-red-700 mt-1">
              {scanMessage}
            </span>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Alış birimi">
          <input
            className={stockInput}
            value={form.purchase_unit}
            maxLength={30}
            disabled={locked.has("purchase_unit")}
            onChange={(e) => set("purchase_unit", e.target.value)}
            placeholder="kutu"
          />
        </Field>
        <Field label="Kullanım birimi">
          <input
            className={stockInput}
            value={form.usage_unit}
            maxLength={30}
            disabled={locked.has("usage_unit")}
            onChange={(e) => set("usage_unit", e.target.value)}
            placeholder="adet"
          />
        </Field>
        <Field label="1 alış birimindeki miktar">
          <input
            className={stockInput}
            value={form.units_per_purchase}
            inputMode="decimal"
            disabled={locked.has("units_per_purchase")}
            onChange={(e) => set("units_per_purchase", e.target.value)}
          />
        </Field>
      </div>
      {factor > 0 && (
        <p className="text-sm text-gray-700 -mt-2">
          1 {form.purchase_unit || "alış birimi"} = {formatQty(factor)} {form.usage_unit || "kullanım birimi"}
        </p>
      )}
      {hasHistory && (
        <Notice tone="warn">
          Geçmiş miktarların anlamını korumak için takip kuralı ve birimleri sabittir. Farklı takip kuralı veya birim
          gerekiyorsa yeni kart açın; eski karttaki açılış miktarını stok sorumlusu düzeltme ile 0&apos;a çeker ve
          gerçek lotlar yeni karta mal kabul ile girilir.
        </Notice>
      )}

      <div className="border rounded-lg">
        <button
          type="button"
          className="w-full flex justify-between items-center px-4 py-3 text-left font-semibold min-h-[44px]"
          aria-expanded={showAdmin}
          onClick={() => setShowAdmin((v) => !v)}
        >
          Yönetim bilgileri
          <span aria-hidden="true">{showAdmin ? "▲" : "▼"}</span>
        </button>
        {showAdmin && (
          <div className="px-4 pb-4 grid gap-4 md:grid-cols-2">
            <Field label="Stok kodu" hint="Boş bırakılırsa otomatik verilir.">
              <input
                className={stockInput}
                value={form.item_code}
                maxLength={40}
                placeholder="Boş bırakılırsa otomatik"
                onChange={(e) => set("item_code", e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="MIN (kritik)">
                <input className={stockInput} inputMode="decimal" value={form.min_qty} onChange={(e) => set("min_qty", e.target.value)} />
              </Field>
              <Field label="MAX (hedef)">
                <input className={stockInput} inputMode="decimal" value={form.max_qty} onChange={(e) => set("max_qty", e.target.value)} />
              </Field>
            </div>
            <Field label="ABC sınıfı">
              <select className={stockInput} value={form.abc_class} onChange={(e) => set("abc_class", e.target.value as AbcClass)}>
                {ABC_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c || "–"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sipariş modeli">
              <select
                className={stockInput}
                value={form.order_policy}
                onChange={(e) => set("order_policy", e.target.value as OrderPolicy)}
              >
                {ORDER_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {ORDER_POLICY_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Varsayılan konum">
              <select
                className={stockInput}
                value={form.preferred_location_id}
                onChange={(e) => set("preferred_location_id", e.target.value)}
              >
                <option value="">Ana depo</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tercih edilen tedarikçi">
              <select className={stockInput} value={form.supplier_id} onChange={(e) => set("supplier_id", e.target.value)}>
                <option value="">—</option>
                {(suppliers || [])
                  .filter((s) => s.is_active || s.id === form.supplier_id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.is_active ? "" : " (pasif)"}
                    </option>
                  ))}
              </select>
            </Field>
            {canViewCosts && (
              <Field
                label="Son birim maliyet (TL, kullanım birimi başına)"
                className="md:col-span-2"
                hint={
                  item?.last_unit_cost_cents !== undefined && item?.last_unit_cost_cents !== null
                    ? `Kayıtlı: ${formatTL(item.last_unit_cost_cents)}`
                    : "Fiyat girilmemiş"
                }
              >
                <input className={stockInput} inputMode="decimal" value={form.cost} onChange={(e) => set("cost", e.target.value)} />
                {factor !== 1 && factor > 0 && (
                  <label className="flex items-center gap-2 mt-2 text-sm">
                    <input type="checkbox" checked={form.cost_is_box} onChange={(e) => set("cost_is_box", e.target.checked)} />
                    Kutu fiyatı girdim ({form.purchase_unit || "alış birimi"} fiyatı; {formatQty(factor)}&apos;e bölünür)
                  </label>
                )}
              </Field>
            )}
          </div>
        )}
      </div>

      <Field label={`Kart notu (${form.notes.length}/2000)`}>
        <textarea
          className={stockInput}
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>

      <fieldset>
        <legend className="text-sm font-semibold text-gray-800 mb-2">Durum</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 min-h-[44px]">
            <input type="radio" checked={!form.needs_review} onChange={() => set("needs_review", false)} />
            Kullanıma hazır
          </label>
          <label className={`flex items-center gap-2 min-h-[44px] ${hasHistory || request ? "opacity-50" : ""}`}>
            <input
              type="radio"
              checked={form.needs_review}
              disabled={hasHistory || !!request}
              onChange={() => set("needs_review", true)}
            />
            Bilgileri tamamlanacak (taslak)
          </label>
        </div>
        {form.needs_review && <p className="text-xs text-gray-500 mt-1">Taslak kartlarla stok hareketi yapılamaz.</p>}
      </fieldset>

      {localError && (
        <div role="alert" className="p-3 rounded bg-red-50 text-red-700 text-sm">
          {localError}
        </div>
      )}
      <StockErrorBox error={error} onReload={onReload} />

      <div className="flex flex-wrap gap-2">
        <button type="submit" className={`${buttonPrimary} min-h-[44px]`} disabled={busy}>
          {busy ? "Kaydediliyor..." : submitLabel ?? (isEdit ? "Kaydet" : "Ürünü oluştur")}
        </button>
        {onCancel && (
          <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
        )}
      </div>

      {scanOpen && (
        <BarcodeScanner purpose="product" onClose={() => setScanOpen(false)} onScan={(raw) => void onScanned(raw)} />
      )}
    </form>
  );
}
