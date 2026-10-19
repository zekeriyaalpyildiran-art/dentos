// Phase 10 audit history viewer (spec p10_platform §5.4, §6.2). Read-only: rows come straight from audit_logs with
// the caller's own login, so every RLS gate (finance, CRM ad spend, stock / lab costs) keeps applying.

import { ROLE_LABELS } from "./auth";
import { PERMISSION_LABELS, isPermission } from "./permissions";
import { formatIstanbulDateTime } from "./staff";

export interface AuditRow {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string;
  action: string;
  user_id: string | null;
  changes: unknown;
  before_data: unknown;
  after_data: unknown;
}

export const AUDIT_SELECT = "id,created_at,entity_type,entity_id,action,user_id,changes,before_data,after_data";

// ---------------------------------------------------------------------------
// Labels (§5.4.2)
// ---------------------------------------------------------------------------

export const ENTITY_GROUPS: { label: string; types: [string, string][] }[] = [
  {
    label: "Personel",
    types: [
      ["users", "Personel"],
      ["doctors", "Hekim"],
      ["staff_permissions", "Yetki"],
    ],
  },
  {
    label: "Hasta ve tedavi",
    types: [
      ["patients", "Hasta (arşiv)"],
      ["treatment_plans", "Tedavi planı"],
      ["payments", "Hasta ödemesi"],
      ["fx_rates", "Döviz kuru"],
    ],
  },
  {
    label: "Finans",
    types: [
      ["fin_settings", "Finans ayarları"],
      ["fin_accounts", "Kasa / banka hesabı"],
      ["fin_report_groups", "Rapor grubu"],
      ["fin_categories", "Finans kategorisi"],
      ["fin_counterparties", "Cari"],
      ["fin_entries", "Finans kaydı"],
      ["fin_payments", "Finans ödemesi"],
      ["fin_balance_snapshots", "Bakiye görüntüsü"],
      ["fin_balance_sources", "Bakiye kaynağı"],
      ["fin_import_batches", "İçe aktarma"],
      ["fin_import_sources", "İçe aktarma kaynağı"],
      ["fin_classification_rules", "Sınıflandırma kuralı"],
      ["fin_import_layouts", "İçe aktarma şablonu"],
      ["fin_patient_financing", "Hasta finansmanı"],
      ["fin_hk_rules", "Hakediş kuralı"],
      ["fin_hk_lines", "Hakediş tahsilat satırı"],
      ["fin_hk_pieces", "Hakediş implant / işlem adedi"],
      ["fin_hk_patient_marks", "Hakediş hasta işareti"],
      ["fin_hk_lab_costs", "Hakediş lab gideri"],
      ["fin_hk_months", "Hakediş ayı"],
      ["fin_hk_statements", "Hakediş dökümü"],
      ["fin_hk_adjustments", "Hakediş prim / diğer"],
      ["fin_hk_proc_groups", "Hakediş işlem grubu"],
      ["fin_hk_ext_doctors", "Macro hekim eşleştirmesi"],
      ["fin_hk_import_batches", "Macro yüklemesi"],
    ],
  },
  {
    label: "CRM",
    types: [
      ["leads", "Aday hasta"],
      ["crm_calls", "Arama"],
      ["crm_handoffs", "Devir"],
      ["staff_tasks", "Görev"],
      ["crm_followup_rules", "Takip kuralı"],
      ["crm_ad_spend", "Reklam harcaması"],
    ],
  },
  {
    label: "Stok",
    types: [
      ["stock_items", "Stok kartı"],
      ["stock_locations", "Stok yeri"],
      ["suppliers", "Tedarikçi"],
      ["stock_item_costs", "Stok maliyeti"],
      ["stock_batch_costs", "Parti maliyeti"],
      ["stock_correction_requests", "Stok düzeltme talebi"],
      ["stock_product_requests", "Ürün talebi"],
      ["stock_settings", "Stok ayarları"],
      ["purchase_orders", "Satın alma siparişi"],
      ["purchase_order_items", "Sipariş kalemi"],
      ["purchase_order_item_costs", "Sipariş kalemi maliyeti"],
      ["stock_room_requests", "Oda talebi"],
    ],
  },
  {
    label: "Klinik",
    types: [
      ["implant_brands", "İmplant markası"],
      ["labs", "Laboratuvar"],
      ["patient_implants", "İmplant"],
      ["lab_orders", "Lab işi"],
      ["lab_order_items", "Lab kalemi"],
      ["lab_order_costs", "Lab maliyeti"],
      ["clinical_settings", "Klinik ayarları"],
    ],
  },
];

export const ENTITY_LABELS: Record<string, string> = Object.fromEntries(
  ENTITY_GROUPS.flatMap((g) => g.types)
);

export function entityLabel(type: string): string {
  return ENTITY_LABELS[type] ?? type;
}

export const ACTION_LABELS: Record<string, string> = {
  create: "Oluşturma",
  update: "Güncelleme",
  delete: "Silme",
  invite: "Davet",
  invite_resend: "Davet yeniden gönderimi",
  archive: "Arşivleme",
  restore: "Arşivden çıkarma",
};

export const ACTION_TONES: Record<string, string> = {
  create: "bg-green-100 text-green-800",
  update: "bg-blue-100 text-blue-800",
  delete: "bg-red-100 text-red-800",
  invite: "bg-purple-100 text-purple-800",
  invite_resend: "bg-purple-100 text-purple-800",
  archive: "bg-gray-200 text-gray-800",
  restore: "bg-green-100 text-green-800",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

// ---------------------------------------------------------------------------
// Field labels (§5.4.3)
// ---------------------------------------------------------------------------

export const FIELD_LABELS: Record<string, string> = {
  full_name: "Ad soyad",
  name: "Ad",
  email: "E-posta",
  phone: "Telefon",
  role: "Rol",
  is_active: "Durum",
  specialty: "Uzmanlık",
  user_id: "Personel",
  patient_id: "Hasta",
  doctor_id: "Hekim",
  treatment_plan_id: "Tedavi planı",
  appointment_id: "Randevu",
  permission: "Yetki",
  granted_at: "Verildiği zaman",
  granted_by: "Veren",
  revoked_at: "Kaldırıldığı zaman",
  revoked_by: "Kaldıran",
  amount: "Tutar",
  amount_cents: "Tutar",
  currency: "Para birimi",
  status: "Durum",
  payment_method: "Ödeme yöntemi",
  paid_at: "Ödeme zamanı",
  due_date: "Vade / beklenen tarih",
  notes: "Notlar",
  note: "Not",
  description: "Açıklama",
  title: "Başlık",
  total_cost: "Toplam tutar",
  cancelled_at: "İptal zamanı",
  cancel_reason: "İptal nedeni",
  deleted_at: "Silinme zamanı",
  delete_reason: "Silme nedeni",
  assigned_to: "Sorumlu",
  category_id: "Kategori",
  counterparty_id: "Cari",
  account_id: "Hesap",
  entry_id: "Finans kaydı",
  item_name: "Ürün adı",
  item_code: "Ürün kodu",
  min_qty: "En az stok",
  max_qty: "En çok stok",
  supplier_id: "Tedarikçi",
  lab_id: "Laboratuvar",
  tooth_fdi: "Diş",
  placed_on: "Uygulama tarihi",
  next_control_on: "Kontrol tarihi",
  brand_id: "Marka",
  model: "Model",
  auth_user_id: "Giriş hesabı",
  reason: "Açıklama",
  login: "Giriş durumu",
  transaction_id: "İşlem no",
  created_by: "Oluşturan",
  updated_by: "Güncelleyen",
};

/** Per-table overrides of the shared labels. */
const ENTITY_FIELD_LABELS: Record<string, Record<string, string>> = {
  payments: { status: "Ödeme durumu" },
  patients: { is_active: "Arşiv durumu" },
  doctors: { user_id: "Personel" },
  fin_counterparties: { staff_user_id: "Bağlı personel" },
  stock_items: { name: "Ürün adı" },
  labs: { name: "Laboratuvar adı" },
  implant_brands: { name: "Marka adı" },
};

export function fieldLabel(entity: string, key: string): string {
  return ENTITY_FIELD_LABELS[entity]?.[key] ?? FIELD_LABELS[key] ?? key;
}

export function hasFieldLabel(entity: string, key: string): boolean {
  return !!(ENTITY_FIELD_LABELS[entity]?.[key] ?? FIELD_LABELS[key]);
}

/** Never shown in diffs. */
export const HIDDEN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "clinic_id",
  "created_at",
  "updated_at",
  "version",
  "name_key",
  "phone_normalized",
  "search_text",
  "legacy_id",
]);

/** Values that hold a users.id (resolved through the clinic's users map). */
export const USER_ID_KEYS: ReadonlySet<string> = new Set([
  "user_id",
  "created_by",
  "updated_by",
  "granted_by",
  "revoked_by",
  "assigned_to",
  "deleted_by",
  "posted_by",
  "actor_user_id",
  "cancelled_by",
  "staff_user_id",
]);

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  paid: "Ödendi",
  pending: "Bekliyor",
  cancelled: "İptal",
  refunded: "İade",
};

const LOGIN_LABELS: Record<string, string> = {
  invited: "Davet gönderildi",
};

// ---------------------------------------------------------------------------
// Value formatting (§5.4.1)
// ---------------------------------------------------------------------------

export interface AuditNameContext {
  entityType?: string;
  users?: Record<string, string>;
  patients?: Record<string, string>;
  doctors?: Record<string, string>;
}

export const MAX_VALUE_CHARS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

export function shortId(id: string): string {
  return "#" + id.slice(0, 8);
}

function truncate(s: string, full: boolean): string {
  return !full && s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) + "…" : s;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && NUMERIC_RE.test(value)) return Number(value);
  return null;
}

const TRY_FMT = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });
const AMOUNT_FMT = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUMBER_FMT = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 6 });

function lookup(map: Record<string, string> | undefined, id: string): string {
  return map?.[id] ?? shortId(id);
}

/** Formats one diff value; `full` skips the 200-character truncation (expanded cell). */
export function formatAuditValue(
  key: string,
  value: unknown,
  ctx: AuditNameContext = {},
  full = false
): string {
  if (key === "auth_user_id") return value ? "Bağlı" : "—";
  if (value === null || value === undefined) return "—";

  if (typeof value === "boolean") {
    if (key === "is_active") return value ? "Aktif" : "Pasif";
    return value ? "Evet" : "Hayır";
  }

  if (typeof value === "string") {
    if (key === "role") return ROLE_LABELS[value] ?? value;
    if (key === "permission") return isPermission(value) ? PERMISSION_LABELS[value] : value;
    if (key === "login") return LOGIN_LABELS[value] ?? value;
    if (key === "status" && ctx.entityType === "payments") return PAYMENT_STATUS_LABELS[value] ?? value;
    if (UUID_RE.test(value)) {
      if (USER_ID_KEYS.has(key)) return lookup(ctx.users, value);
      if (key === "patient_id") return lookup(ctx.patients, value);
      if (key === "doctor_id") return lookup(ctx.doctors, value);
      return shortId(value);
    }
  }

  if (key.endsWith("_cents")) {
    const n = asNumber(value);
    if (n !== null) return TRY_FMT.format(n / 100);
  }
  if (key === "amount") {
    const n = asNumber(value);
    if (n !== null) return AMOUNT_FMT.format(n);
  }

  if (typeof value === "number") return NUMBER_FMT.format(value);

  if (typeof value === "string") {
    if (ISO_TS_RE.test(value)) {
      const t = formatIstanbulDateTime(value);
      if (t !== "—") return t;
    }
    const m = DAY_RE.exec(value);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    return truncate(value, full);
  }

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  return truncate(json, full);
}

// ---------------------------------------------------------------------------
// Diff (§5.4)
// ---------------------------------------------------------------------------

export interface AuditDiffLine {
  key: string;
  label: string;
  before: unknown;
  after: unknown;
  changed: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function same(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function unionKeys(...objs: (Record<string, unknown> | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of objs) {
    if (!o) continue;
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

export function auditDiff(row: Pick<AuditRow, "entity_type" | "action" | "changes" | "before_data" | "after_data">): AuditDiffLine[] {
  const before = asObject(row.before_data);
  const after = asObject(row.after_data);
  const changes = asObject(row.changes);
  const changeKeys = changes ? Object.keys(changes) : [];

  const afterOf = (k: string) => (after && k in after ? after[k] : changes?.[k]);

  let keys: string[];
  let pick: (k: string) => { b: unknown; a: unknown };

  switch (row.action) {
    case "create":
      keys = after ? Object.keys(after) : changeKeys;
      pick = (k) => ({ b: undefined, a: afterOf(k) });
      break;
    case "delete":
      keys = before ? Object.keys(before) : changeKeys;
      pick = (k) => ({ b: before ? before[k] : changes?.[k], a: undefined });
      break;
    case "update":
      keys =
        changeKeys.length > 0
          ? changeKeys
          : unionKeys(before, after).filter((k) => !same(before?.[k], after?.[k]));
      pick = (k) => ({ b: before?.[k], a: afterOf(k) });
      break;
    default:
      // invite / invite_resend / archive / restore and anything newer: the keys the writer put in `changes`.
      keys = changeKeys.length > 0 ? changeKeys : unionKeys(before, after);
      pick = (k) => ({ b: before?.[k], a: afterOf(k) });
  }

  return keys
    .filter((k) => !HIDDEN_KEYS.has(k))
    .map((k) => {
      const { b, a } = pick(k);
      return { key: k, label: fieldLabel(row.entity_type, k), before: b, after: a, changed: !same(b, a) };
    });
}

/** "Ad soyad, E-posta, Rol +2" — the first three changed fields of a row. */
export function auditSummary(row: Pick<AuditRow, "entity_type" | "action" | "changes" | "before_data" | "after_data">): string {
  const lines = auditDiff(row).filter((l) => l.changed);
  if (lines.length === 0) return "—";
  const head = lines.slice(0, 3).map((l) => l.label).join(", ");
  return lines.length > 3 ? `${head} +${lines.length - 3}` : head;
}

// ---------------------------------------------------------------------------
// Query helpers (§5.4)
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;
export const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

export function clampPageSize(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v) || v < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(v));
}

function isDay(s: string | null | undefined): s is string {
  const m = DAY_RE.exec(s ?? "");
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function nextDay(day: string): string {
  const m = DAY_RE.exec(day)!;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Istanbul calendar days → created_at bounds. Turkey is UTC+3 all year. Invalid days are ignored. */
export function istanbulDayRange(from?: string | null, to?: string | null): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  if (isDay(from)) out.gte = `${from}T00:00:00+03:00`;
  if (isDay(to)) out.lt = `${nextDay(to)}T00:00:00+03:00`;
  return out;
}

/** PostgREST `or` filter for the page after `last` in (created_at DESC, id DESC) order. */
export function keysetFilter(last: Pick<AuditRow, "created_at" | "id">): string {
  const ts = last.created_at.replace(/"/g, "");
  const id = last.id.replace(/[^0-9a-fA-F-]/g, "");
  return `created_at.lt."${ts}",and(created_at.eq."${ts}",id.lt.${id})`;
}

/** Appends rows not seen yet (by id). */
export function mergeAuditRows(current: AuditRow[], next: AuditRow[]): AuditRow[] {
  const seen = new Set(current.map((r) => r.id));
  const out = current.slice();
  for (const r of next) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/** Pages that have a detail screen. */
export function entityHref(type: string, id: string): string | null {
  switch (type) {
    case "patients":
      return `/patients/${id}`;
    case "treatment_plans":
      return `/treatment-plans/${id}`;
    case "lab_orders":
      return `/lab/${id}`;
    default:
      return null;
  }
}
