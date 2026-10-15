// Bulk receipt cart (spec p7_rules_ui §20.7, contract §4.6). The cart lives in browser state only (sessionStorage of
// the tab, cleared on sign-out, because lines can carry unit costs); the database receives exactly the contract's
// line keys (unknown keys are refused with E_FILTER).

import type { TrackingLevel } from "./codes";
import type { BulkLine } from "./rpc";
import type { QuantityUnit } from "./units";

export const BULK_MAX_LINES = 20;

export interface CartLine {
  key: string;
  stock_item_id: string;
  item_name: string;
  tracking_level: TrackingLevel;
  usage_unit: string;
  purchase_unit: string;
  units_per_purchase: number;
  to_location_id: string;
  to_location_name: string;
  quantity: number;
  quantity_unit: QuantityUnit;
  lot_number: string;
  serial_number: string;
  expiry_date: string;
  /** Only present for cost viewers. */
  unit_cost_cents?: number | null;
  cost_unit?: QuantityUnit;
  supplier_id: string;
  document_no: string;
  reason: string;
}

export interface CartState {
  /** Operation key stored with the cart, so a retry after a reload reuses it (p7_rules_ui §13). */
  operationKey: string | null;
  lines: CartLine[];
  /**
   * The last submit got no definitive answer (network error / timeout): it may or may not have been saved. The cart
   * is locked until a retry with the same key answers, or the ledger shows the key was not used.
   */
  pending?: boolean;
}

/** True when the line was entered (quantity or cost) in the card's purchase unit. */
export function usesPurchaseUnit(line: Pick<CartLine, "quantity_unit" | "cost_unit" | "unit_cost_cents">): boolean {
  return (
    line.quantity_unit === "purchase" ||
    (line.unit_cost_cents !== undefined && line.unit_cost_cents !== null && line.cost_unit === "purchase")
  );
}

export function toBulkLine(line: CartLine): BulkLine {
  const out: BulkLine = {
    stock_item_id: line.stock_item_id,
    to_location_id: line.to_location_id,
    quantity: line.quantity,
    quantity_unit: line.quantity_unit,
    lot_number: line.lot_number.trim() || null,
    serial_number: line.serial_number.trim() || null,
    expiry_date: line.expiry_date || null,
    supplier_id: line.supplier_id || null,
    document_no: line.document_no.trim() || null,
    reason: line.reason.trim() || null,
  };
  if (line.unit_cost_cents !== undefined && line.unit_cost_cents !== null) {
    out.unit_cost_cents = line.unit_cost_cents;
    out.cost_unit = line.cost_unit ?? "usage";
  }
  // The factor the line was converted with: a card factor changed since (the cart can be days old) is refused with
  // E_UNIT_CHANGED instead of being applied silently.
  if (usesPurchaseUnit(line)) out.units_per_purchase = line.units_per_purchase;
  return out;
}

export function isCartState(value: unknown): value is CartState {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as CartState).lines) &&
    ((value as CartState).operationKey === null || typeof (value as CartState).operationKey === "string") &&
    ((value as CartState).pending === undefined || typeof (value as CartState).pending === "boolean")
  );
}

/** Row number from a bulk error ("3. satır: …", DETAIL = n). */
export function bulkErrorRow(message: string, detail: string | null): number | null {
  if (detail && /^\d+$/.test(detail.trim())) return Number(detail.trim());
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { row?: unknown };
      if (typeof parsed?.row === "number") return parsed.row;
    } catch {
      // not JSON
    }
  }
  const m = /^(\d+)\. satır:/.exec(message);
  return m ? Number(m[1]) : null;
}
