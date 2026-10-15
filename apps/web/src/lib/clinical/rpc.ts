// Phase 9 clinical: typed RPC wrappers and JSON shapes (spec p9_clinical §5, §6).
// Every write is a SECURITY DEFINER `clin_*` RPC; the clinic, "today" and "now" come from the server. Create calls
// take a client id / operation key made when the form opens and reused for every retry; a new one after success.

import { createClient } from "@/lib/supabase";
import type {
  ImplantStatus,
  ImplantStockState,
  LabPayableState,
  LabStatus,
  StockSource,
} from "./codes";

// ---------------------------------------------------------------------------
// Errors (§1.1: 42501 → 403, PT404 → 404, PT409 → 409, P0001 → 400; HINT = key)
// ---------------------------------------------------------------------------

export class ClinicalError extends Error {
  code: string | null;
  /** Error key from HINT, e.g. 'CL_TOOTH_TAKEN' or a passed-through stock key such as 'E_INSUFFICIENT'. */
  key: string | null;
  detail: string | null;
  /** No definitive answer (network / timeout): retry with the same key. */
  network: boolean;

  constructor(message: string, code: string | null, key: string | null, detail: string | null, network = false) {
    super(message);
    this.name = "ClinicalError";
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

export const NETWORK_MESSAGE = "İşlem tamamlanamadı. Bağlantınızı kontrol edip aynı düğmeyle tekrar deneyin.";
export const MODULE_MISSING_MESSAGE = "Klinik modülü güncelleniyor. Birkaç dakika sonra sayfayı yenileyin.";

export function toClinicalError(err: unknown): ClinicalError {
  if (err instanceof ClinicalError) return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; hint?: unknown; details?: unknown };
    const hasMessage = typeof e.message === "string" && e.message !== "";
    const code = typeof e.code === "string" && e.code ? e.code : null;
    // supabase-js reports fetch failures as { message: 'TypeError: Failed to fetch', code: '' }.
    const network = !code && (!hasMessage || /fetch|network|timeout|load failed/i.test(String(e.message)));
    const missing = code === "PGRST202" || code === "42883" || code === "PGRST205" || code === "42P01";
    return new ClinicalError(
      network || !hasMessage ? NETWORK_MESSAGE : missing ? MODULE_MISSING_MESSAGE : (e.message as string),
      code,
      typeof e.hint === "string" && e.hint ? e.hint : null,
      typeof e.details === "string" && e.details ? e.details : null,
      network
    );
  }
  return new ClinicalError(NETWORK_MESSAGE, null, null, null, true);
}

/** `clin_*` function (or a Phase 9 table) not deployed yet: web build ahead of migration 0026_clinical_implants_lab (§7.0). */
export function isClinicalModuleMissing(error: ClinicalError | null | undefined): boolean {
  return (
    !!error &&
    (error.code === "PGRST202" || error.code === "42883" || error.code === "PGRST205" || error.code === "42P01")
  );
}

/** Keys whose 409 keeps the form and offers "Yenile". */
export const RELOAD_KEYS = new Set(["CL_VERSION"]);

let client: ReturnType<typeof createClient> | null = null;
export function clinicalDb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await clinicalDb().rpc(name, args) : await clinicalDb().rpc(name);
  } catch (err) {
    throw toClinicalError(err);
  }
  if (result.error) throw toClinicalError(result.error);
  return result.data as T;
}

/** Client id / operation key. Falls back to getRandomValues where randomUUID is missing (plain-HTTP LAN access). */
export function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PageArg {
  offset: number;
  limit: number;
}

/** §1.2 flags returned by every read RPC. */
export interface ClinicalFlags {
  can_write: boolean;
  can_operate_stock: boolean;
  can_view_lab_costs: boolean;
  can_edit_lab_costs: boolean;
  can_finance: boolean;
  can_view_deleted: boolean;
  can_restore: boolean;
}

export const NO_FLAGS: ClinicalFlags = {
  can_write: false,
  can_operate_stock: false,
  can_view_lab_costs: false,
  can_edit_lab_costs: false,
  can_finance: false,
  can_view_deleted: false,
  can_restore: false,
};

// ---------------------------------------------------------------------------
// Implants (§6.1-6.4)
// ---------------------------------------------------------------------------

export interface StockCorrectionRef {
  id: string;
  ref_no: number | null;
  status: "pending" | "approved" | "rejected" | string;
}

export interface ImplantJson {
  id: string;
  patient_id: string;
  patient_name: string;
  tooth_fdi: number;
  brand_id: string;
  brand_name: string;
  brand_active: boolean;
  model: string;
  diameter_mm: number;
  length_mm: number;
  placed_on: string;
  doctor_id: string | null;
  doctor_name: string | null;
  appointment_id: string | null;
  appointment_start: string | null;
  stock_source: StockSource;
  source_note: string;
  stock_item_id: string | null;
  item_name: string | null;
  batch_id: string | null;
  expiry_date: string | null;
  stock_movement_id: string | null;
  movement_ref_no: number | null;
  stock_state: ImplantStockState | null;
  stock_correction: StockCorrectionRef | null;
  lot_text: string;
  serial_text: string;
  torque_ncm: number | null;
  next_control_on: string | null;
  control_due: boolean;
  status: ImplantStatus;
  notes: string;
  version: number;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
  delete_reason: string | null;
}

export interface ImplantFilters {
  q?: string;
  patient_id?: string;
  doctor_id?: string;
  brand_id?: string;
  status?: ImplantStatus[];
  control_due?: boolean;
  stock_source?: StockSource;
  deleted?: "active" | "deleted" | "all";
  placed_from?: string;
  placed_to?: string;
}

export interface ImplantCounts {
  control_due: number;
  healing: number;
  prosthetic: number;
  completed: number;
  follow_up: number;
  failed: number;
  placed_this_month: number;
  external: number;
}

export interface ImplantList {
  rows: ImplantJson[];
  total: number;
  counts: ImplantCounts;
  today: string;
  flags: ClinicalFlags;
}

export function clinImplantList(filters: ImplantFilters = {}, page?: PageArg): Promise<ImplantList> {
  return rpc<ImplantList>("clin_implant_list", { p_filters: filters, p_page: page ?? null });
}

export interface ImplantDetail {
  implant: ImplantJson;
  movement: Record<string, unknown> | null;
  correction: Record<string, unknown> | null;
  other_implants: { id: string; tooth_fdi: number; brand_name: string }[];
  flags: ClinicalFlags;
  today?: string;
}

export function clinImplantDetail(implantId: string): Promise<ImplantDetail> {
  return rpc<ImplantDetail>("clin_implant_detail", { p_implant_id: implantId });
}

export interface StockOptionBatch {
  batch_id: string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  location_id: string;
  location_name: string;
  quantity: number;
}

export interface StockOptionItem {
  stock_item_id: string;
  item_name: string;
  brand: string;
  model: string;
  brand_id: string | null;
  batches: StockOptionBatch[];
}

export interface StockOptions {
  items: StockOptionItem[];
  truncated: boolean;
  flags: ClinicalFlags;
  today?: string;
}

export function clinImplantStockOptions(q: string | null, locationId: string | null): Promise<StockOptions> {
  return rpc<StockOptions>("clin_implant_stock_options", { p_q: q || null, p_location_id: locationId || null });
}

export interface StockMoveResult {
  movements: { id: string; ref_no?: number }[];
  items?: unknown[];
}

export interface ImplantRecordArgs {
  p_operation_key: string;
  p_implant_id: string;
  p_patient_id: string;
  p_tooth_fdi: number;
  p_brand_id: string;
  p_model: string;
  p_diameter_mm: number;
  p_length_mm: number;
  p_placed_on: string;
  p_doctor_id: string | null;
  p_appointment_id: string | null;
  p_stock_source: StockSource;
  p_batch_id: string | null;
  p_from_location_id: string | null;
  p_lot_text: string | null;
  p_serial_text: string | null;
  p_source_note: string | null;
  p_torque_ncm: number | null;
  p_next_control_on: string | null;
  p_status: ImplantStatus;
  p_notes: string | null;
}

export interface ImplantRecordResult {
  ok: true;
  implant: ImplantJson;
  stock: StockMoveResult | null;
  already_saved: boolean;
}

export function clinImplantRecord(args: ImplantRecordArgs): Promise<ImplantRecordResult> {
  return rpc<ImplantRecordResult>("clin_implant_record", { ...args });
}

export interface ImplantUpdateArgs {
  p_implant_id: string;
  p_version: number;
  p_tooth_fdi: number;
  p_brand_id: string;
  p_model: string;
  p_diameter_mm: number;
  p_length_mm: number;
  p_placed_on: string;
  p_doctor_id: string | null;
  p_appointment_id: string | null;
  p_lot_text: string;
  p_serial_text: string;
  p_source_note: string;
  p_torque_ncm: number | null;
  p_next_control_on: string | null;
  p_status: ImplantStatus;
  p_notes: string;
}

export function clinImplantUpdate(args: ImplantUpdateArgs): Promise<{ ok: true; implant: ImplantJson }> {
  return rpc("clin_implant_update", { ...args });
}

export interface ImplantVoidResult {
  ok: true;
  implant: ImplantJson;
  stock_correction: { id: string; ref_no: number | null; status: "pending" } | null;
}

export function clinImplantVoid(implantId: string, version: number, reason: string): Promise<ImplantVoidResult> {
  return rpc<ImplantVoidResult>("clin_implant_void", {
    p_implant_id: implantId,
    p_version: version,
    p_reason: reason,
  });
}

export function clinImplantRestore(implantId: string, version: number): Promise<{ ok: true; implant: ImplantJson }> {
  return rpc("clin_implant_restore", { p_implant_id: implantId, p_version: version });
}

// ---------------------------------------------------------------------------
// Directories (§5.1, §5.2, §6.10)
// ---------------------------------------------------------------------------

export interface BrandRow {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
  implant_count?: number;
}

export interface LabRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  note: string;
  fin_counterparty_id: string | null;
  fin_counterparty_name?: string | null;
  is_active: boolean;
  version: number;
  open_order_count?: number;
}

const trCompare = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "tr");

/** Brands through RLS (§6.10), sorted in Turkish. */
export async function listBrands(): Promise<BrandRow[]> {
  const { data, error } = await clinicalDb()
    .from("implant_brands")
    .select("id,name,is_active,version")
    .order("name")
    .limit(1000);
  if (error) throw toClinicalError(error);
  return ((data || []) as BrandRow[]).slice().sort(trCompare);
}

export async function listLabs(): Promise<LabRow[]> {
  const { data, error } = await clinicalDb()
    .from("labs")
    .select("id,name,phone,email,note,fin_counterparty_id,is_active,version")
    .order("name")
    .limit(1000);
  if (error) throw toClinicalError(error);
  return ((data || []) as LabRow[]).slice().sort(trCompare);
}

export function clinSaveImplantBrand(args: {
  p_id: string;
  p_version: number | null;
  p_name: string;
  p_is_active: boolean;
}): Promise<{ ok: true; brand: BrandRow; already_saved?: boolean }> {
  return rpc("clin_save_implant_brand", { ...args });
}

export function clinSaveLab(args: {
  p_id: string;
  p_version: number | null;
  p_name: string;
  p_phone: string;
  p_email: string;
  p_note: string;
  p_fin_counterparty_id: string | null;
  p_is_active: boolean;
}): Promise<{ ok: true; lab: LabRow; already_saved?: boolean }> {
  return rpc("clin_save_lab", { ...args });
}

// ---------------------------------------------------------------------------
// Materials (§6.5)
// ---------------------------------------------------------------------------

export interface MaterialRow {
  movement_id: string;
  ref_no: number;
  effective_at: string;
  stock_item_id: string;
  item_name: string;
  usage_unit: string;
  tracking_level: "A" | "B" | "C" | string;
  lot_number: string;
  serial_number: string | null;
  expiry_date: string | null;
  quantity: number;
  returned_qty: number;
  net_qty: number;
  doctor_id: string | null;
  doctor_name: string | null;
  appointment_id: string | null;
  appointment_start: string | null;
  from_location_name: string | null;
  actor_name: string | null;
  implant_id: string | null;
  implant_tooth: number | null;
  is_reentry: boolean;
  correction_status: "pending" | "rejected" | null;
  /** Present only for stock cost viewers. */
  unit_cost_cents?: number | null;
  cost_cents?: number | null;
}

export interface MaterialTotal {
  stock_item_id: string;
  item_name: string;
  usage_unit: string;
  net_qty: number;
  cost_cents?: number | null;
}

export interface PatientMaterials {
  rows: MaterialRow[];
  total: number;
  totals: MaterialTotal[];
  flags: ClinicalFlags;
  today?: string;
}

export function clinPatientMaterials(patientId: string, page?: PageArg): Promise<PatientMaterials> {
  return rpc<PatientMaterials>("clin_patient_materials", { p_patient_id: patientId, p_page: page ?? null });
}

export interface AppointmentMaterials {
  appointment: {
    id: string;
    start_time: string;
    end_time: string | null;
    status: string;
    patient_id: string;
    patient_name: string;
    doctor_id: string | null;
    doctor_name: string | null;
  };
  materials: MaterialRow[];
  implants: ImplantJson[];
  flags: ClinicalFlags;
  today?: string;
}

export function clinAppointmentMaterials(appointmentId: string): Promise<AppointmentMaterials> {
  return rpc<AppointmentMaterials>("clin_appointment_materials", { p_appointment_id: appointmentId });
}

// ---------------------------------------------------------------------------
// Lab orders (§5.7-5.12, §6.6-6.9)
// ---------------------------------------------------------------------------

export interface LabCostJson {
  amount_cents: number;
  note: string;
  version: number;
  payable_state: LabPayableState;
  fin_entry_id?: string | null;
  posted_at: string | null;
}

export interface LabOrderJson {
  id: string;
  order_number: string;
  status: LabStatus;
  patient_id: string;
  patient_name: string;
  doctor_id: string;
  doctor_name: string | null;
  lab_id: string | null;
  lab_name: string | null;
  lab_active: boolean | null;
  lab_phone?: string | null;
  treatment_plan_id: string | null;
  due_date: string;
  sent_on: string | null;
  received_on: string | null;
  delivery_date: string | null;
  last_try_in_on: string | null;
  revision_count: number;
  is_late: boolean;
  days_late: number | null;
  notes: string;
  cancel_reason: string | null;
  item_count: number;
  items_summary: string;
  allowed_next: LabStatus[];
  version: number;
  created_at: string;
  updated_at: string;
  /** Key present only for lab cost viewers; null when no cost row exists. */
  cost?: LabCostJson | null;
}

export interface LabOrderFilters {
  q?: string;
  status?: LabStatus[];
  late?: boolean;
  lab_id?: string;
  patient_id?: string;
  doctor_id?: string;
  sent_from?: string;
  sent_to?: string;
  payable_pending?: boolean;
}

export interface LabOrderCounts {
  draft: number;
  at_lab: number;
  late: number;
  try_in: number;
  revision: number;
  arrived: number;
  delivered_30d: number;
  payable_pending?: number;
}

export interface LabOrderList {
  rows: LabOrderJson[];
  total: number;
  counts: LabOrderCounts;
  flags: ClinicalFlags;
  today: string;
}

export function clinLabOrderList(filters: LabOrderFilters = {}, page?: PageArg): Promise<LabOrderList> {
  return rpc<LabOrderList>("clin_lab_order_list", { p_filters: filters, p_page: page ?? null });
}

export interface LabOrderItemJson {
  id: string;
  item_type: string;
  tooth_number: string | null;
  material: string | null;
  color_code: string | null;
  quantity: number | null;
  description: string | null;
}

export interface LabEventJson {
  from_status: LabStatus | null;
  to_status: LabStatus;
  on_date: string;
  note: string;
  actor_name: string | null;
  created_at: string;
}

export interface LabOrderDetail {
  order: LabOrderJson;
  items: LabOrderItemJson[];
  events: LabEventJson[];
  settings: { lab_cost_payable_enabled: boolean };
  flags: ClinicalFlags;
  today?: string;
}

export function clinLabOrderDetail(id: string): Promise<LabOrderDetail> {
  return rpc<LabOrderDetail>("clin_lab_order_detail", { p_lab_order_id: id });
}

export interface LabItemInput {
  item_type: string;
  tooth_number: string;
  material: string;
  color_code: string;
  quantity: number;
  description: string;
}

export interface LabOrderSaveArgs {
  p_id: string;
  p_version: number | null;
  p_patient_id: string;
  p_doctor_id: string;
  p_lab_id: string;
  p_due_date: string;
  p_notes: string;
  p_items: LabItemInput[];
  p_treatment_plan_id: string | null;
  p_submit: boolean;
  p_sent_on: string | null;
}

export function clinLabOrderSave(
  args: LabOrderSaveArgs
): Promise<{ ok: true; order: LabOrderJson; already_saved?: boolean }> {
  return rpc("clin_lab_order_save", { ...args });
}

export function clinLabOrderSetStatus(args: {
  p_lab_order_id: string;
  p_version: number;
  p_status: LabStatus;
  p_on: string | null;
  p_note: string | null;
}): Promise<{ ok: true; order: LabOrderJson; warnings?: string[] }> {
  return rpc("clin_lab_order_set_status", { ...args });
}

export function clinLabOrderDeleteDraft(id: string, version: number): Promise<{ ok: true; deleted_id: string }> {
  return rpc("clin_lab_order_delete_draft", { p_lab_order_id: id, p_version: version });
}

export function clinLabOrderSetCost(args: {
  p_lab_order_id: string;
  p_cost_version: number | null;
  p_amount_cents: number | null;
  p_note: string;
}): Promise<{ ok: true; cost: LabCostJson | null; payable_state: LabPayableState | null }> {
  return rpc("clin_lab_order_set_cost", { ...args });
}

export function clinLabCostPost(
  orderId: string,
  costVersion: number
): Promise<{ ok: true; cost: LabCostJson; payable_state: "posted"; fin_entry_id: string }> {
  return rpc("clin_lab_cost_post", { p_lab_order_id: orderId, p_cost_version: costVersion });
}

export interface ClinicalSettingsJson {
  lab_cost_payable_enabled: boolean;
  version: number;
  updated_at: string | null;
  updated_by_name: string | null;
}

export function clinSettings(): Promise<{ settings: ClinicalSettingsJson; flags: ClinicalFlags }> {
  return rpc("clin_settings");
}

export function clinSaveSettings(
  version: number,
  enabled: boolean
): Promise<{ ok: true; settings: ClinicalSettingsJson }> {
  return rpc("clin_save_settings", { p_version: version, p_lab_cost_payable_enabled: enabled });
}

// ---------------------------------------------------------------------------
// Shared reference reads (direct SELECT through RLS)
// ---------------------------------------------------------------------------

export interface DoctorRef {
  id: string;
  name: string;
  /** users.is_active of the doctor's account. Forms offer active doctors only (0024 stock__check_patient_refs
   *  refuses an inactive one with E_DOCTOR); list filters keep every doctor for old records. */
  active: boolean;
}

/** The clinic's doctors (doctors has no is_active column; the account's users.is_active decides; RLS limits the
 *  rows to the clinic). */
export async function listDoctors(): Promise<DoctorRef[]> {
  const { data, error } = await clinicalDb()
    .from("doctors")
    .select("id,specialty,users(full_name,is_active)")
    .limit(500);
  if (error) throw toClinicalError(error);
  const rows = (data || []) as unknown as {
    id: string;
    specialty: string | null;
    users: { full_name: string; is_active: boolean | null } | null;
  }[];
  return rows
    .map((d) => ({
      id: d.id,
      name: d.users?.full_name || d.specialty || "İsimsiz hekim",
      active: d.users?.is_active === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

export interface AppointmentRef {
  id: string;
  start_time: string;
  doctor_id: string | null;
  status: string;
}

/** The patient's appointments from `fromDay` (Istanbul) to the end of today, newest first (implant form). */
export async function listPatientAppointments(patientId: string, fromIso: string, toIso: string): Promise<AppointmentRef[]> {
  const { data, error } = await clinicalDb()
    .from("appointments")
    .select("id,start_time,doctor_id,status")
    .eq("patient_id", patientId)
    .gte("start_time", fromIso)
    .lt("start_time", toIso)
    .order("start_time", { ascending: false })
    .limit(100);
  if (error) throw toClinicalError(error);
  return (data || []) as AppointmentRef[];
}

/** Every id/brand pair of live implants, paged past the 1000-row cap (brand directory counts). */
export async function countImplantsByBrand(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let last = "";
  for (let i = 0; i < 50; i++) {
    let q = clinicalDb()
      .from("patient_implants")
      .select("id,brand_id")
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(1000);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw toClinicalError(error);
    const rows = (data || []) as { id: string; brand_id: string }[];
    for (const r of rows) counts.set(r.brand_id, (counts.get(r.brand_id) ?? 0) + 1);
    if (rows.length < 1000) break;
    last = rows[rows.length - 1].id;
  }
  return counts;
}

/** Open lab jobs per lab (draft or out at the lab), for the directory. */
export async function countOpenOrdersByLab(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let last = "";
  for (let i = 0; i < 50; i++) {
    let q = clinicalDb()
      .from("lab_orders")
      .select("id,lab_id")
      .in("status", ["draft", "submitted", "in_progress", "try_in", "revision", "ready"])
      .not("lab_id", "is", null)
      .order("id", { ascending: true })
      .limit(1000);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw toClinicalError(error);
    const rows = (data || []) as { id: string; lab_id: string }[];
    for (const r of rows) counts.set(r.lab_id, (counts.get(r.lab_id) ?? 0) + 1);
    if (rows.length < 1000) break;
    last = rows[rows.length - 1].id;
  }
  return counts;
}

/** Finance counterparties of kind 'lab' (finance holders only; RLS returns nothing to others). */
export async function listLabCounterparties(): Promise<{ id: string; name: string; is_active: boolean }[]> {
  const { data, error } = await clinicalDb()
    .from("fin_counterparties")
    .select("id,name,is_active")
    .eq("kind", "lab")
    .order("name")
    .limit(1000);
  if (error) throw toClinicalError(error);
  return ((data || []) as { id: string; name: string; is_active: boolean }[]).sort(trCompare);
}

export interface TreatmentPlanRef {
  id: string;
  title: string;
  status: string;
}

export async function listPatientPlans(patientId: string): Promise<TreatmentPlanRef[]> {
  const { data, error } = await clinicalDb()
    .from("treatment_plans")
    .select("id,title,status")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw toClinicalError(error);
  return (data || []) as TreatmentPlanRef[];
}
