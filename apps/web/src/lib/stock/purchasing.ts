// Phase 8 purchasing: labels, quantity / price helpers and the order payload builder (spec p8_purchasing §12.1).
// Pure (no React, no network). The database is authoritative; these helpers only mirror its rules so the form can
// explain a problem before submit.

import { MAX_CENTS, parseTL } from "../finance";
import { formatQty, isWholeNumber, parseQty, quantityInStockUnits, type QuantityUnit } from "./units";

// ---------------------------------------------------------------------------
// Status codes and labels (§8)
// ---------------------------------------------------------------------------

export type PoStatus = "pending" | "approved" | "ordered" | "partially_received" | "received" | "cancelled";
export const PO_STATUSES: PoStatus[] = ["pending", "approved", "ordered", "partially_received", "received", "cancelled"];
/** Statuses whose lines still count as open quantity (D:154). */
export const PO_OPEN_STATUSES: PoStatus[] = ["pending", "approved", "ordered", "partially_received"];

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  pending: "Onay bekliyor",
  approved: "Onaylandı",
  ordered: "Sipariş verildi",
  partially_received: "Kısmi teslim",
  received: "Teslim alındı",
  cancelled: "İptal edildi",
};

export const PO_STATUS_STYLES: Record<PoStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-sky-100 text-sky-800",
  ordered: "bg-indigo-100 text-indigo-800",
  partially_received: "bg-purple-100 text-purple-800",
  received: "bg-green-100 text-green-800",
  cancelled: "bg-gray-200 text-gray-700",
};

/** "Eksik kapatıldı" for a short-closed order (status received + closed_short). */
export function poStatusLabel(status: PoStatus, closedShort?: boolean | null): string {
  if (status === "received" && closedShort) return "Eksik kapatıldı";
  return PO_STATUS_LABELS[status] ?? status;
}

export type RoomRequestStatus = "pending" | "approved" | "delivered" | "rejected" | "cancelled";
export const ROOM_REQUEST_STATUSES: RoomRequestStatus[] = ["pending", "approved", "delivered", "rejected", "cancelled"];

export const ROOM_REQUEST_STATUS_LABELS: Record<RoomRequestStatus, string> = {
  pending: "Bekliyor",
  approved: "Onaylandı",
  delivered: "Teslim edildi",
  rejected: "Reddedildi",
  cancelled: "Geri çekildi",
};

export const ROOM_REQUEST_STATUS_STYLES: Record<RoomRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-sky-100 text-sky-800",
  delivered: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-gray-200 text-gray-700",
};

export type PayableState =
  | "none"
  | "disabled"
  | "created"
  | "skipped_unpriced"
  | "skipped_zero"
  | "skipped_no_category"
  | "skipped_error";

/** Finance link state under a received order (§12.5). `none` shows nothing. */
export const PAYABLE_STATE_LABELS: Record<PayableState, string> = {
  none: "",
  disabled: "Finans kaydı kapalı",
  created: "Finans borç kaydı oluşturuldu",
  skipped_unpriced: "Fiyatsız satır olduğu için finans kaydı oluşturulmadı",
  skipped_zero: "Teslim alınan tutar sıfır olduğu için finans kaydı oluşturulmadı",
  skipped_no_category: "Gider kategorisi bulunamadığı için finans kaydı oluşturulmadı",
  skipped_error: "Finans kaydı oluşturulamadı; finans sorumlusuna bildirin",
};

// ---------------------------------------------------------------------------
// Gates and storage
// ---------------------------------------------------------------------------

/** PO list / detail and the consumption report: stock managers and cost viewers (§1.2 PO_READ / REPORT). */
export function canReadPurchasing(gates: { mgr: boolean; cost: boolean }): boolean {
  return gates.mgr || gates.cost;
}
export const canReadStockReport = canReadPurchasing;

/** Unsent order builder draft (per viewer). The "dentos-stock-" prefix lets clearStockStorage remove it on sign-out. */
export const poDraftKey = (userId: string) => `dentos-stock-po-draft:${userId}`;

// ---------------------------------------------------------------------------
// Quantities and prices (§1.4)
// ---------------------------------------------------------------------------

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/** Purchase packs of a usage quantity; `whole` when it is a whole number of packs. */
export function packsOf(qty: number, factor: number): { packs: number; whole: boolean } {
  const f = Number(factor) > 0 ? Number(factor) : 1;
  const packs = round4(Number(qty) / f);
  return { packs, whole: isWholeNumber(packs) };
}

/** "9 kutu (900 adet)" when the quantity is whole packs of a factor ≠ 1, else "905 adet". */
export function qtyLabel(qty: number, usageUnit: string, purchaseUnit: string | null | undefined, factor: number): string {
  const f = Number(factor);
  if (purchaseUnit && f > 0 && f !== 1 && Number(qty) > 0) {
    const { packs, whole } = packsOf(qty, f);
    if (whole) return `${formatQty(packs)} ${purchaseUnit} (${formatQty(qty)} ${usageUnit})`;
  }
  return `${formatQty(qty)} ${usageUnit}`;
}

/** Cents per usage unit; a per-pack price is divided by the factor and rounded (S24:2276-2277). */
export function pricePerUsage(price: number, unit: QuantityUnit, factor: number): number {
  if (unit !== "purchase") return price;
  const f = Number(factor) > 0 ? Number(factor) : 1;
  return Math.round(price / f);
}

/**
 * round(qty × unit price), half away from zero like Postgres numeric round. Exact for quantities with at most four
 * decimals and prices up to 100 000 000 000 cents (BigInt, no floating-point drift).
 */
export function lineTotalCents(qty: number, unitPriceCents: number): number {
  const q = BigInt(Math.round(Math.abs(Number(qty)) * 10_000));
  const p = BigInt(Math.round(Math.abs(Number(unitPriceCents))));
  const abs = Number((q * p + BigInt(5_000)) / BigInt(10_000));
  return Math.sign(Number(qty)) * Math.sign(Number(unitPriceCents)) < 0 ? -abs : abs;
}

/** Quantity still to come: ordered − received while the order is open, else 0 (§2.4). */
export function poLineRemaining(
  line: { qty_ordered: number; qty_received: number },
  status: PoStatus
): number {
  if (!PO_OPEN_STATUSES.includes(status)) return 0;
  return Math.max(0, round4(Number(line.qty_ordered) - Number(line.qty_received)));
}

/** Expected date passed while the order is approved / ordered / partially received (§6.1 `overdue`). */
export function isOverdue(expected: string | null | undefined, today: string, status: PoStatus): boolean {
  if (!expected) return false;
  if (status !== "approved" && status !== "ordered" && status !== "partially_received") return false;
  return expected < today;
}

/** Editable text of a quantity: comma decimals and no grouping, so parseQty reads it back unchanged. */
export function qtyToInput(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "";
  return String(round4(Number(n))).replace(".", ",");
}

/**
 * Index (0-based) of the row a list RPC refused: message `'<n>. satır: …'` with DETAIL = n (S24:455-467).
 * null when the error is not a row error.
 */
export function rowErrorIndex(err: { message: string; detail: string | null } | null | undefined): number | null {
  if (!err) return null;
  const m = /^(\d+)\. satır: /.exec(err.message);
  if (!m) return null;
  if (err.detail !== null && err.detail !== m[1]) return null;
  const n = Number(m[1]);
  return n >= 1 ? n - 1 : null;
}

// ---------------------------------------------------------------------------
// Order form → stock_po_save payload (§5.1)
// ---------------------------------------------------------------------------

export const PO_MAX_LINES = 20;
export const PO_NOTE_MAX = 1000;
export const PO_LINE_NOTE_MAX = 200;
const MAX_PRICE_CENTS = 100_000_000_000;

export const PO_MESSAGES = {
  supplier: "Tedarikçi seçin.",
  lines: "Siparişe 1–20 ürün ekleyin.",
  duplicate: "Aynı ürün siparişte iki kez yer alamaz; miktarı tek satırda toplayın.",
  note: "Sipariş notu en fazla 1000 karakter, satır notu en fazla 200 karakter olabilir.",
  date: "Teslim tarihini kontrol edin.",
  qty: "Miktar sıfırdan büyük olmalıdır.",
  qtyInteger: "Bu üründe tam adet girin.",
  price: "Birim fiyat en fazla 1.000.000.000 TL olabilir.",
  unchanged: "Kaydedilecek bir değişiklik yok.",
} as const;

export interface PoFormLine {
  stock_item_id: string;
  item_name: string;
  tracking_level: string;
  usage_unit: string;
  purchase_unit: string;
  /** The card factor shown to the user (sent back as `units_per_purchase` when a purchase unit is used). */
  units_per_purchase: number;
  qty_text: string;
  quantity_unit: QuantityUnit;
  /** Cost viewers only; '' = no price. */
  price_text: string;
  price_unit: QuantityUnit;
  note: string;
  /** Price per usage unit when the line was loaded for editing (cost viewers); null = unpriced, undefined = new line. */
  original_price_cents?: number | null;
  /** The card's default supplier (hint for the "other supplier" warning). */
  card_supplier_id?: string | null;
}

export interface PoForm {
  supplier_id: string;
  expected_date: string;
  note: string;
  lines: PoFormLine[];
}

export interface PoLinePayload {
  stock_item_id: string;
  quantity: number;
  quantity_unit?: QuantityUnit;
  units_per_purchase?: number;
  unit_price_cents?: number | null;
  price_unit?: QuantityUnit;
  note?: string;
}

export interface PoPayload {
  supplier_id?: string;
  expected_date?: string | null;
  note?: string;
  lines?: PoLinePayload[];
}

export type PoPayloadResult =
  | { ok: true; payload: PoPayload }
  | { ok: false; error: string; line: number | null };

export interface BuildPoOptions {
  canViewCosts: boolean;
  /** Clinic-local today ('YYYY-MM-DD') for the expected-date check. */
  today: string;
  /** Edit mode: the form as loaded. Unchanged header keys and an unchanged line set are left out (§5.1 step 5). */
  original?: PoForm | null;
}

function lineError(index: number, text: string): PoPayloadResult {
  return { ok: false, error: `${index + 1}. satır: ${text}`, line: index };
}

function buildLines(form: PoForm, opts: BuildPoOptions): { ok: true; lines: PoLinePayload[] } | PoPayloadResult {
  if (form.lines.length < 1 || form.lines.length > PO_MAX_LINES) return { ok: false, error: PO_MESSAGES.lines, line: null };
  const out: PoLinePayload[] = [];
  for (let i = 0; i < form.lines.length; i++) {
    const l = form.lines[i];
    const factor = Number(l.units_per_purchase) > 0 ? Number(l.units_per_purchase) : 1;
    const qty = parseQty(l.qty_text);
    const usage = quantityInStockUnits(qty, l.quantity_unit, factor);
    if (!(qty > 0) || !Number.isFinite(usage)) return lineError(i, PO_MESSAGES.qty);
    if (l.tracking_level === "A" && !isWholeNumber(usage)) return lineError(i, PO_MESSAGES.qtyInteger);
    const note = l.note.trim();
    if (note.length > PO_LINE_NOTE_MAX) return lineError(i, PO_MESSAGES.note);

    const line: PoLinePayload = { stock_item_id: l.stock_item_id, quantity: qty };
    let usesPurchase = false;
    if (l.quantity_unit === "purchase") {
      line.quantity_unit = "purchase";
      usesPurchase = true;
    }
    if (opts.canViewCosts) {
      const text = l.price_text.trim();
      if (text) {
        const parsed = parseTL(text, { allowZero: true });
        if (!parsed.ok) return lineError(i, parsed.error);
        if (parsed.cents > MAX_PRICE_CENTS || parsed.cents > MAX_CENTS) return lineError(i, PO_MESSAGES.price);
        line.unit_price_cents = parsed.cents;
        if (l.price_unit === "purchase") {
          line.price_unit = "purchase";
          usesPurchase = true;
        }
      } else if (typeof l.original_price_cents === "number") {
        // A viewer emptied a price that was set: clear it. An unpriced line stays unpriced by leaving the key out.
        line.unit_price_cents = null;
      }
    }
    if (usesPurchase) line.units_per_purchase = factor;
    if (note) line.note = note;
    out.push(line);
  }
  // Duplicates after every row parsed, reported on the second occurrence (server order, §5.1 step 2).
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    if (seen.has(out[i].stock_item_id)) return lineError(i, PO_MESSAGES.duplicate);
    seen.add(out[i].stock_item_id);
  }
  return { ok: true, lines: out };
}

/**
 * Builds `p_order` for stock_po_save from the form. Validation messages mirror the server keys (E_PO_LINES,
 * E_PO_DUP_ITEM, E_QTY_INTEGER, E_PO_NOTE, E_PO_DATE). Price keys are never sent by a non-viewer (E_COST_FORBIDDEN).
 */
export function buildPoPayload(form: PoForm, opts: BuildPoOptions): PoPayloadResult {
  if (!form.supplier_id) return { ok: false, error: PO_MESSAGES.supplier, line: null };
  const note = form.note.trim();
  if (note.length > PO_NOTE_MAX) return { ok: false, error: PO_MESSAGES.note, line: null };
  const date = form.expected_date.trim();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < opts.today)) {
    // An unchanged past date on an older order is the server's to judge only when it is resent.
    if (!opts.original || opts.original.expected_date.trim() !== date) {
      return { ok: false, error: PO_MESSAGES.date, line: null };
    }
  }
  const built = buildLines(form, opts);
  if (!("lines" in built)) return built;

  if (!opts.original) {
    const payload: PoPayload = { supplier_id: form.supplier_id, lines: built.lines };
    if (date) payload.expected_date = date;
    if (note) payload.note = note;
    return { ok: true, payload };
  }

  const payload: PoPayload = {};
  const orig = opts.original;
  if (form.supplier_id !== orig.supplier_id) payload.supplier_id = form.supplier_id;
  if (date !== orig.expected_date.trim()) payload.expected_date = date || null;
  if (note !== orig.note.trim()) payload.note = note;
  const origLines = buildLines(orig, { ...opts, original: null });
  const same = "lines" in origLines && JSON.stringify(origLines.lines) === JSON.stringify(built.lines);
  if (!same) payload.lines = built.lines;
  if (Object.keys(payload).length === 0) return { ok: false, error: PO_MESSAGES.unchanged, line: null };
  return { ok: true, payload };
}

/** Usage quantity of a form line (NaN when the text is not a valid quantity). */
export function formLineUsageQty(line: Pick<PoFormLine, "qty_text" | "quantity_unit" | "units_per_purchase">): number {
  return quantityInStockUnits(parseQty(line.qty_text), line.quantity_unit, Number(line.units_per_purchase) || 1);
}

/** Price per usage unit of a form line (cents) or null when empty / invalid. */
export function formLinePriceCents(line: Pick<PoFormLine, "price_text" | "price_unit" | "units_per_purchase">): number | null {
  const text = line.price_text.trim();
  if (!text) return null;
  const parsed = parseTL(text, { allowZero: true });
  if (!parsed.ok) return null;
  return pricePerUsage(parsed.cents, line.price_unit, Number(line.units_per_purchase) || 1);
}
