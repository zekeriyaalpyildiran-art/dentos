// Phase 7 stock: typed RPC wrappers and JSON shapes (spec p7_db_contract §4, §5, §9).
// Every write is a SECURITY DEFINER RPC; the clinic, "today" and "now" come from the server. Write RPCs take a
// client operation key (crypto.randomUUID()) made when the form opens and reused for every retry of that submit;
// a new key is made after a successful save.

import { createClient } from "@/lib/supabase";
import type {
  AbcClass,
  CorrectionStatus,
  LocationKind,
  MovementType,
  OrderPolicy,
  ProductRequestStatus,
  TrackingLevel,
} from "./codes";
import type { QuantityUnit } from "./units";

// ---------------------------------------------------------------------------
// Errors (contract §1.1: 42501 → 403, PT404 → 404, PT409 → 409, P0001 → 400; HINT = key)
// ---------------------------------------------------------------------------

export class StockError extends Error {
  code: string | null;
  /** Error key from HINT, e.g. 'E_COUNT_STALE'. */
  key: string | null;
  detail: string | null;
  /** True when the request never got a definitive answer (network / timeout): retry with the same key. */
  network: boolean;

  constructor(message: string, code: string | null, key: string | null, detail: string | null, network = false) {
    super(message);
    this.name = "StockError";
    this.code = code;
    this.key = key;
    this.detail = detail;
    this.network = network;
  }

  get isConflict() {
    return this.code === "PT409";
  }
  get isNotFound() {
    return this.code === "PT404";
  }
  get isForbidden() {
    return this.code === "42501";
  }
}

const NETWORK_MESSAGE = "İşlem tamamlanamadı. Bağlantınızı kontrol edip aynı düğmeyle tekrar deneyin.";

export function toStockError(err: unknown): StockError {
  if (err instanceof StockError) return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; hint?: unknown; details?: unknown };
    const hasMessage = typeof e.message === "string" && e.message !== "";
    const code = typeof e.code === "string" && e.code ? e.code : null;
    // supabase-js reports fetch failures as { message: 'TypeError: Failed to fetch', code: '' }.
    const network = !code && (!hasMessage || /fetch|network|timeout|load failed/i.test(String(e.message)));
    return new StockError(
      network || !hasMessage ? NETWORK_MESSAGE : (e.message as string),
      code,
      typeof e.hint === "string" && e.hint ? e.hint : null,
      typeof e.details === "string" && e.details ? e.details : null,
      network
    );
  }
  return new StockError(NETWORK_MESSAGE, null, null, null, true);
}

/** Keys whose 409 keeps the form and offers "Yenile" (p7_rules_ui §20.0). */
export const RELOAD_KEYS = new Set(["E_ITEM_VERSION", "E_VERSION", "E_COUNT_STALE", "E_UNIT_CHANGED"]);

let client: ReturnType<typeof createClient> | null = null;
export function stockDb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await stockDb().rpc(name, args) : await stockDb().rpc(name);
  } catch (err) {
    throw toStockError(err);
  }
  if (result.error) throw toStockError(result.error);
  return result.data as T;
}

export function newKey(): string {
  return crypto.randomUUID();
}

export interface PageArg {
  offset: number;
  limit: number;
}

export interface PermissionFlags {
  can_view_costs?: boolean;
  can_operate?: boolean;
  can_manage?: boolean;
}

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

export type LevelState = "ok" | "critical" | "out";

/** §5.2 level row. */
export interface LevelRow {
  id: string;
  item_code: string;
  item_name: string;
  brand: string;
  model: string;
  category: string;
  tracking_level: TrackingLevel;
  gtin: string | null;
  sku: string;
  purchase_unit: string;
  usage_unit: string;
  units_per_purchase: number;
  min_qty: number;
  max_qty: number;
  abc_class: AbcClass;
  order_policy: OrderPolicy;
  needs_review: boolean;
  is_active: boolean;
  version: number;
  supplier_id: string | null;
  supplier_name: string | null;
  preferred_location_id: string | null;
  preferred_location_name: string | null;
  total_qty: number;
  usable_qty: number;
  expired_qty: number;
  next_expiry: string | null;
  days_to_expiry: number | null;
  state: LevelState;
  at_location_qty?: number;
  is_favorite: boolean;
  has_history: boolean;
  /** Cost viewers only. */
  last_unit_cost_cents?: number | null;
}

export interface LevelFilters {
  q?: string;
  tracking_level?: TrackingLevel;
  status?: "all" | "ready" | "draft" | "critical" | "expiring" | "out" | "inactive";
  category?: string;
  location_id?: string;
  favorites?: boolean;
  recent?: boolean;
  operable?: boolean;
}

export interface LevelList extends PermissionFlags {
  total: number;
  rows: LevelRow[];
}

/** §5.4 history row. */
export interface MovementRow {
  id: string;
  ref_no: number;
  movement_type: MovementType;
  created_at: string;
  effective_at: string;
  stock_item_id: string;
  item_name: string;
  usage_unit: string;
  tracking_level: TrackingLevel;
  quantity: number;
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  from_location_id: string | null;
  from_location_name: string | null;
  to_location_id: string | null;
  to_location_name: string | null;
  patient_id: string | null;
  patient_name: string | null;
  appointment_id: string | null;
  doctor_id: string | null;
  doctor_name: string | null;
  supplier_name: string | null;
  document_no: string;
  reason: string;
  actor_user_id: string | null;
  actor_name: string | null;
  source_movement_id: string | null;
  source_ref_no: number | null;
  correction_status: CorrectionStatus | null;
  corrected: boolean;
  is_reentry: boolean;
  can_request_correction: boolean;
  can_return: boolean;
  returnable_qty: number;
}

export interface HistoryFilters {
  stock_item_id?: string;
  location_id?: string;
  types?: MovementType[];
  from?: string;
  to?: string;
  actor_user_id?: string;
  mine?: boolean;
  patient_id?: string;
  corrected?: "only" | "exclude";
  operation_key?: string;
}

export interface HistoryList extends PermissionFlags {
  total: number;
  rows: MovementRow[];
}

export interface CriticalRow {
  stock_item_id: string;
  item_name: string;
  usage_unit: string;
  tracking_level: TrackingLevel;
  usable_qty: number;
  min_qty: number;
  max_qty: number;
  suggested_qty: number;
  state: "out" | "critical";
}

export type ExpiryState = "expired" | "critical" | "warning";

export interface ExpiryRow {
  stock_item_id: string;
  item_name: string;
  usage_unit?: string;
  tracking_level?: TrackingLevel;
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string;
  days_left: number;
  state: ExpiryState;
  location_id: string;
  location_name: string;
  quantity: number;
  action?: "waste" | "issue";
  value_cents?: number;
}

export type AttentionRow =
  | ({ kind: "critical"; severity: "red" | "amber" } & CriticalRow)
  | ({ kind: "expiry"; severity: "red" | "amber" } & ExpiryRow);

export interface DashboardJson extends PermissionFlags {
  today: string;
  items: { active: number; draft: number; by_level: Record<TrackingLevel, number> };
  health_by_level: Record<TrackingLevel, { items: number; ok: number }>;
  critical: { count: number; out_of_stock: number; rows: CriticalRow[] };
  expiry: { count: number; expired: number; critical: number; rows: ExpiryRow[] };
  attention: AttentionRow[];
  pending: { corrections: number; product_requests: number };
  recent_movements: MovementRow[];
  value?: {
    value_cents: number;
    expiry_risk_value_cents: number;
    uncosted_batches: number;
    by_category: { category: string; value_cents: number }[];
  };
}

export interface ExpiryWatch extends PermissionFlags {
  total?: number;
  totals?: { count: number; expired: number; critical: number; value_cents?: number };
  rows: ExpiryRow[];
}

export interface BalanceRow {
  location_id: string;
  location_name: string;
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  received_at: string;
  quantity: number;
  usable: boolean;
  unit_cost_cents?: number | null;
}

export interface CorrectionJson {
  id: string;
  ref_no: number;
  status: CorrectionStatus;
  reason: string;
  resolution: string;
  corrected_qty: number | null;
  requested_by: string;
  requested_by_name: string | null;
  resolved_by_name: string | null;
  created_at: string;
  resolved_at: string | null;
  movement: MovementRow;
}

export interface ProductRequestJson {
  id: string;
  gtin: string;
  name: string;
  note: string;
  lot_number: string;
  serial_number: string;
  expiry_date: string | null;
  status: ProductRequestStatus;
  stock_item_id: string | null;
  item_name: string | null;
  resolution_note: string;
  requested_by_name: string | null;
  resolved_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemDetailJson extends PermissionFlags {
  item: LevelRow & {
    notes: string;
    created_at: string;
    updated_at: string;
    locked_fields: string[];
    legacy?: { quantity_on_hand: number; quantity_minimum: number; opening_movement_id: string | null };
  };
  balances: BalanceRow[];
  by_location: { location_id: string; location_name: string; usable_qty: number; total_qty: number }[];
  recent_movements: MovementRow[];
  pending_corrections: CorrectionJson[];
  product_requests: ProductRequestJson[];
  cost?: { last_unit_cost_cents: number | null; value_cents: number; uncosted_qty: number };
}

export interface SnapshotRow {
  batch_id: string;
  stock_item_id: string;
  item_name: string;
  usage_unit: string;
  tracking_level: TrackingLevel;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  expired: boolean;
  expected_qty: number;
}

export interface LocationSnapshot extends PermissionFlags {
  location: { id: string; name: string; kind: LocationKind };
  total: number;
  snapshot_at: string;
  rows: SnapshotRow[];
}

export interface ScanBatch {
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  location_id: string;
  location_name: string;
  quantity: number;
  usable: boolean;
  matches_scan: boolean;
}

export interface ScanLookup extends PermissionFlags {
  gtin: string;
  match: "known" | "unknown" | "draft" | "inactive";
  item: LevelRow | null;
  batches: ScanBatch[];
  pending_request: ProductRequestJson | null;
}

export interface Paged<T> extends PermissionFlags {
  total: number;
  rows: T[];
}

export interface ReturnCandidate {
  movement_id: string;
  ref_no: number;
  stock_item_id: string;
  item_name: string;
  usage_unit: string;
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  location_id: string;
  location_name: string;
  patient_name: string | null;
  doctor_name: string | null;
  quantity: number;
  returned_qty: number;
  remaining: number;
  effective_at: string;
}

export interface CountSessionRow {
  operation_key: string;
  location_id: string;
  location_name: string;
  created_at: string;
  actor_name: string | null;
  reason: string;
  lines: number;
  differences: number;
  adjust_in_qty: number;
  adjust_out_qty: number;
}

export interface PeriodReportRow {
  stock_item_id: string;
  item_name: string;
  usage_unit?: string;
  category?: string;
  received_qty: number;
  opening_qty: number;
  used_qty: number;
  returned_qty: number;
  waste_qty: number;
  adjust_in_qty: number;
  adjust_out_qty: number;
  net_used_cost_cents: number;
  waste_cost_cents: number;
  adjust_net_cost_cents: number;
  uncosted_rows: number;
}

export interface PeriodReport {
  from: string;
  to: string;
  rows: PeriodReportRow[];
  totals: Partial<Record<keyof PeriodReportRow, number>>;
}

// ---------------------------------------------------------------------------
// Write shapes
// ---------------------------------------------------------------------------

export interface MoveResultMovement {
  id: string;
  ref_no: number;
  movement_type: MovementType;
  stock_item_id: string;
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  quantity: number;
  from_location_id: string | null;
  to_location_id: string | null;
}

export interface MoveResult {
  ok: true;
  already_saved: boolean;
  operation_key: string;
  movements: MoveResultMovement[];
  items: { id: string; usable_qty: number; total_qty: number; expired_qty: number; next_expiry: string | null }[];
}

export interface CountResult extends MoveResult {
  location_id: string;
  lines: number;
  differences: number;
  adjust_in_qty: number;
  adjust_out_qty: number;
}

/** stock_save_item.p_item (contract §4.12). On edit, an absent key keeps the current value. */
export interface ItemInput {
  item_name?: string;
  item_code?: string;
  category?: string;
  brand?: string;
  model?: string;
  tracking_level?: TrackingLevel;
  sku?: string;
  gtin?: string | null;
  purchase_unit?: string;
  usage_unit?: string;
  units_per_purchase?: number;
  min_qty?: number;
  max_qty?: number;
  abc_class?: AbcClass;
  order_policy?: OrderPolicy;
  needs_review?: boolean;
  supplier_id?: string | null;
  preferred_location_id?: string | null;
  notes?: string;
  is_active?: boolean;
  /** Only cost viewers may send this key (E_COST_FORBIDDEN otherwise). */
  last_unit_cost_cents?: number | null;
}

export interface ItemSaveResult {
  ok: true;
  already_saved: boolean;
  item: LevelRow & { notes?: string; locked_fields?: string[] };
}

export interface BulkLine {
  stock_item_id: string;
  to_location_id: string;
  quantity: number;
  quantity_unit: QuantityUnit;
  /** The card factor the line was entered with; present when the purchase unit is used (E_UNIT_CHANGED). */
  units_per_purchase?: number;
  lot_number: string | null;
  serial_number: string | null;
  expiry_date: string | null;
  unit_cost_cents?: number | null;
  cost_unit?: QuantityUnit;
  supplier_id: string | null;
  document_no: string | null;
  reason: string | null;
}

export interface LocationJson {
  id: string;
  name: string;
  kind: LocationKind;
  is_default_warehouse: boolean;
  chair_id: string | null;
  chair_name?: string | null;
  sort_order: number;
  is_active: boolean;
  version: number;
  stock_lines?: number;
}

export interface SupplierJson {
  id: string;
  name: string;
  phone: string;
  email: string;
  tax_no: string;
  note: string;
  is_active: boolean;
  version: number;
  linked_to_finance?: boolean;
  fin_counterparty_id?: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Missing blocks become empty ones, so a partial answer never breaks the home screen. */
export function normalizeDashboard(d: Partial<DashboardJson> | null | undefined): DashboardJson {
  const levels = { A: 0, B: 0, C: 0 };
  return {
    ...d,
    today: d?.today ?? istanbulToday(),
    items: { active: 0, draft: 0, ...d?.items, by_level: { ...levels, ...d?.items?.by_level } },
    health_by_level: {
      A: { items: 0, ok: 0 },
      B: { items: 0, ok: 0 },
      C: { items: 0, ok: 0 },
      ...d?.health_by_level,
    },
    critical: { count: 0, out_of_stock: 0, ...d?.critical, rows: d?.critical?.rows ?? [] },
    expiry: { count: 0, expired: 0, critical: 0, ...d?.expiry, rows: d?.expiry?.rows ?? [] },
    attention: d?.attention ?? [],
    pending: { corrections: 0, product_requests: 0, ...d?.pending },
    recent_movements: d?.recent_movements ?? [],
    value: d?.value ? { ...d.value, by_category: d.value.by_category ?? [] } : undefined,
  };
}

export const stockDashboard = async () => normalizeDashboard(await rpc<Partial<DashboardJson>>("stock_dashboard"));

export const stockItemLevels = (filters: LevelFilters, page: PageArg) =>
  rpc<LevelList>("stock_item_levels", { p_filters: compact(filters), p_page: page });

export const stockExpiryWatch = (days: number, locationId: string | null, page: PageArg) =>
  rpc<ExpiryWatch>("stock_expiry_watch", { p_days: days, p_location_id: locationId, p_page: page });

export const stockMovementHistory = (filters: HistoryFilters, page: PageArg) =>
  rpc<HistoryList>("stock_movement_history", { p_filters: compact(filters), p_page: page });

export const stockItemDetail = (id: string) => rpc<ItemDetailJson>("stock_item_detail", { p_stock_item_id: id });

export const stockLocationSnapshot = (locationId: string, filters: { q?: string; stock_item_id?: string }, page: PageArg) =>
  rpc<LocationSnapshot>("stock_location_snapshot", {
    p_location_id: locationId,
    p_filters: compact(filters),
    p_page: page,
  });

export const stockScanLookup = (args: {
  gtin: string;
  lot?: string;
  serial?: string;
  expiry?: string;
  locationId?: string | null;
}) =>
  rpc<ScanLookup>("stock_scan_lookup", {
    p_gtin: args.gtin,
    p_lot_number: args.lot || null,
    p_serial_number: args.serial || null,
    p_expiry_date: args.expiry || null,
    p_location_id: args.locationId || null,
  });

export const stockCorrectionList = (status: CorrectionStatus | "all", page: PageArg) =>
  rpc<Paged<CorrectionJson>>("stock_correction_list", { p_status: status, p_page: page });

export const stockProductRequestList = (status: ProductRequestStatus | "all", page: PageArg) =>
  rpc<Paged<ProductRequestJson>>("stock_product_request_list", { p_status: status, p_page: page });

export const stockReturnCandidates = (itemId: string | null, page: PageArg) =>
  rpc<Paged<ReturnCandidate>>("stock_return_candidates", { p_stock_item_id: itemId, p_page: page });

export const stockCountHistory = (locationId: string | null, page: PageArg) =>
  rpc<Paged<CountSessionRow>>("stock_count_history", { p_location_id: locationId, p_page: page });

export const stockPeriodReport = (from: string, to: string) =>
  rpc<PeriodReport>("stock_period_report", { p_from: from, p_to: to });

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function stockReceive(args: {
  p_operation_key: string;
  p_stock_item_id: string;
  p_to_location_id: string;
  p_quantity: number;
  p_quantity_unit: QuantityUnit;
  p_lot_number: string | null;
  p_serial_number: string | null;
  p_expiry_date: string | null;
  p_unit_cost_cents: number | null;
  p_cost_unit: QuantityUnit;
  p_supplier_id: string | null;
  p_document_no: string | null;
  p_reason: string | null;
  /** The card factor the user saw; sent whenever the purchase unit was used (quantity or cost) -> E_UNIT_CHANGED. */
  p_units_per_purchase?: number | null;
}) {
  return rpc<MoveResult>("stock_receive", args);
}

export function stockIssue(args: {
  p_operation_key: string;
  p_stock_item_id: string;
  p_from_location_id: string;
  p_quantity: number;
  p_quantity_unit: QuantityUnit;
  p_batch_id: string | null;
  p_patient_id: string | null;
  p_appointment_id: string | null;
  p_doctor_id: string | null;
  p_reason: string | null;
  p_units_per_purchase?: number | null;
}) {
  return rpc<MoveResult>("stock_issue", args);
}

export function stockTransfer(args: {
  p_operation_key: string;
  p_stock_item_id: string;
  p_from_location_id: string;
  p_to_location_id: string;
  p_quantity: number;
  p_quantity_unit: QuantityUnit;
  p_batch_id: string | null;
  p_reason: string | null;
  p_units_per_purchase?: number | null;
}) {
  return rpc<MoveResult>("stock_transfer", args);
}

export function stockWaste(args: {
  p_operation_key: string;
  p_stock_item_id: string;
  p_from_location_id: string;
  p_quantity: number;
  p_quantity_unit: QuantityUnit;
  p_batch_id: string | null;
  p_reason: string;
  p_units_per_purchase?: number | null;
}) {
  return rpc<MoveResult>("stock_waste", args);
}

export function stockReturn(args: {
  p_operation_key: string;
  p_source_movement_id: string;
  p_quantity: number;
  p_unused_confirmed: boolean;
  p_reason: string;
}) {
  return rpc<MoveResult>("stock_return", args);
}

export function stockBulkReceive(args: { p_operation_key: string; p_lines: BulkLine[] }) {
  return rpc<MoveResult>("stock_bulk_receive", args);
}

export function stockCount(args: {
  p_operation_key: string;
  p_location_id: string;
  p_lines: { batch_id: string; expected_qty: number; actual_qty: number }[];
  p_reason: string;
}) {
  return rpc<CountResult>("stock_count", args);
}

export function stockRequestCorrection(args: {
  p_operation_key: string;
  p_request_id: string;
  p_movement_id: string;
  p_reason: string;
}) {
  return rpc<{ ok: true; already_saved: boolean; request: CorrectionJson }>("stock_request_correction", args);
}

export function stockResolveCorrection(args: {
  p_operation_key: string;
  p_request_id: string;
  p_action: "approve" | "reject";
  p_corrected_qty: number | null;
  p_resolution: string;
}) {
  return rpc<{ ok: true; already_saved: boolean; request: CorrectionJson; movements?: MoveResultMovement[] }>(
    "stock_resolve_correction",
    args
  );
}

export function stockRequestProduct(args: {
  p_operation_key: string;
  p_request_id: string;
  p_gtin: string;
  p_name: string;
  p_note: string | null;
  p_lot_number: string | null;
  p_serial_number: string | null;
  p_expiry_date: string | null;
}) {
  return rpc<{ ok: true; already_saved: boolean; already_pending: boolean; request: ProductRequestJson }>(
    "stock_request_product",
    args
  );
}

export function stockDefineItem(args: {
  p_operation_key: string;
  p_request_id: string;
  p_action: "create" | "link" | "reject";
  p_item_id: string | null;
  p_item: ItemInput | null;
  p_note: string | null;
}) {
  return rpc<{ ok: true; already_saved: boolean; request: ProductRequestJson; item: ItemSaveResult["item"] | null }>(
    "stock_define_item",
    args
  );
}

export function stockSaveItem(args: {
  p_operation_key: string;
  p_id: string;
  p_version: number | null;
  p_item: ItemInput;
}) {
  return rpc<ItemSaveResult>("stock_save_item", args);
}

export function stockSaveLocation(args: {
  p_operation_key: string;
  p_id: string;
  p_version: number | null;
  p_location: Partial<Pick<LocationJson, "name" | "kind" | "chair_id" | "sort_order" | "is_active" | "is_default_warehouse">>;
}) {
  return rpc<{ ok: true; already_saved: boolean; location: LocationJson }>("stock_save_location", args);
}

export function stockSaveSupplier(args: {
  p_operation_key: string;
  p_id: string;
  p_version: number | null;
  p_supplier: Partial<Pick<SupplierJson, "name" | "phone" | "email" | "tax_no" | "note" | "is_active">>;
}) {
  return rpc<{ ok: true; already_saved: boolean; supplier: SupplierJson }>("stock_save_supplier", args);
}

export function stockSetFavorite(itemId: string, favorite: boolean) {
  return rpc<{ ok: true; stock_item_id: string; favorite: boolean; count: number }>("stock_set_favorite", {
    p_stock_item_id: itemId,
    p_favorite: favorite,
  });
}

/**
 * Whether a movement submit with this operation key reached the ledger. Used after an unanswered submit (network
 * error) or an E_OP_KEY refusal, so the UI never mints a new key for something that may already be saved.
 */
export async function movementOperationSaved(key: string): Promise<boolean> {
  const res = await stockMovementHistory({ operation_key: key }, { offset: 0, limit: 1 });
  return (res.total ?? res.rows?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Drops undefined, null, '' and false filter values (unknown/empty keys are refused or meaningless). */
export function compact<T extends object>(filters: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Clinic-local (Europe/Istanbul) calendar day; only for default filter values, never for stock decisions. */
export function istanbulToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** "Düzeltme #12" style short reference. */
export function refLabel(refNo: number | null | undefined): string {
  return refNo === null || refNo === undefined ? "" : `#${refNo}`;
}
