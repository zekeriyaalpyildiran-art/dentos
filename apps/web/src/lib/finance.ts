// Finance ledger (Phase 1) client helpers: money parsing / formatting, labels and typed RPC wrappers.
// Contract: spec p1 §1, p2 §3 (fin_* RPCs). Every read and write goes through SECURITY DEFINER RPCs;
// money is integer cents; "today" always comes from the server (clinic_today()).

import { createClient } from "./supabase";

// ---------------------------------------------------------------------------
// Domain enums and labels
// ---------------------------------------------------------------------------

export type Direction = "in" | "out";
export type ProfitClass = "income" | "expense" | "none";
export type ReportBucket =
  | "patient_receipts"
  | "other_income"
  | "rent"
  | "doctor"
  | "lab"
  | "supplies"
  | "personnel"
  | "tax"
  | "other_expense"
  | "distribution"
  | "capital"
  | "principal"
  | "fees"
  | "asset";
export type Subcategory = "current_physician" | "past_physician_debt" | "official_fee";
export type AccountKind = "bank" | "cash" | "pos" | "mixed";
export type CounterpartyKind =
  | "physician"
  | "lab"
  | "supplier"
  | "landlord"
  | "bank"
  | "staff"
  | "partner"
  | "tax"
  | "other";
export type EntryStatus = "open" | "completed" | "cancelled";

/** p1 §1.4: the bucket fixes direction and profit class. Order = seed sort order. */
export const REPORT_BUCKETS: readonly {
  value: ReportBucket;
  label: string;
  direction: Direction;
  profit_class: ProfitClass;
}[] = [
  { value: "patient_receipts", label: "Hasta tahsilatı", direction: "in", profit_class: "income" },
  { value: "other_income", label: "Diğer faaliyet geliri", direction: "in", profit_class: "income" },
  { value: "rent", label: "Kira", direction: "out", profit_class: "expense" },
  { value: "doctor", label: "Hekim hakedişi", direction: "out", profit_class: "expense" },
  { value: "lab", label: "Laboratuvar", direction: "out", profit_class: "expense" },
  { value: "supplies", label: "Sarf / tedarikçi", direction: "out", profit_class: "expense" },
  { value: "personnel", label: "Personel", direction: "out", profit_class: "expense" },
  { value: "tax", label: "Vergi / SGK", direction: "out", profit_class: "expense" },
  { value: "other_expense", label: "Diğer faaliyet gideri", direction: "out", profit_class: "expense" },
  { value: "distribution", label: "Ortak dağıtımı", direction: "out", profit_class: "none" },
  { value: "capital", label: "Sermaye / borç girişi", direction: "in", profit_class: "none" },
  { value: "principal", label: "Kredi / borç anapara ödemesi", direction: "out", profit_class: "none" },
  { value: "fees", label: "Faiz / banka masrafı", direction: "out", profit_class: "expense" },
  { value: "asset", label: "Demirbaş alımı", direction: "out", profit_class: "none" },
];

export const BUCKET_LABELS = Object.fromEntries(
  REPORT_BUCKETS.map((b) => [b.value, b.label])
) as Record<ReportBucket, string>;

export const PROFIT_CLASS_LABELS: Record<ProfitClass, string> = {
  income: "Faaliyet geliri",
  expense: "Faaliyet gideri",
  none: "Faaliyet dışı",
};

export const DIRECTION_LABELS: Record<Direction, string> = {
  in: "Kliniğe giriş",
  out: "Klinikten çıkış",
};

export const SUBCATEGORY_LABELS: Record<Subcategory, string> = {
  current_physician: "Cari dönem hekim hakedişi",
  past_physician_debt: "Geçmiş dönem hekim hakedişi borç ödemesi",
  official_fee: "Resmi harç",
};

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  bank: "Banka",
  cash: "Nakit",
  pos: "POS",
  mixed: "Karma",
};

export const COUNTERPARTY_KIND_LABELS: Record<CounterpartyKind, string> = {
  physician: "Hekim",
  lab: "Laboratuvar",
  supplier: "Tedarikçi",
  landlord: "Kiraya veren",
  bank: "Banka / finans kurumu",
  staff: "Personel",
  partner: "Ortak",
  tax: "Vergi / resmi kurum",
  other: "Diğer",
};

export const STATUS_LABELS: Record<EntryStatus, string> = {
  open: "Açık",
  completed: "Tamamlandı",
  cancelled: "İptal",
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  fin_settings: "Ayarlar",
  fin_accounts: "Hesap",
  fin_report_groups: "Rapor grubu",
  fin_categories: "Kategori",
  fin_counterparties: "Kişi / kurum",
  fin_entries: "Kayıt",
  fin_payments: "Ödeme",
  fin_balance_snapshots: "Bakiye",
  fin_balance_sources: "Bakiye kaynağı",
  fin_import_batches: "Dosya aktarımı",
  fin_import_sources: "Aktarım kaynağı",
  fin_classification_rules: "Sınıflandırma kuralı",
  fin_import_layouts: "Sütun eşleştirmesi",
  fin_patient_financing: "Hasta finansmanı",
  fin_hk_rules: "Hakediş kuralı",
  fin_hk_lines: "Hakediş tahsilat satırı",
  fin_hk_pieces: "Hakediş implant / işlem adedi",
  fin_hk_patient_marks: "Hakediş hasta işareti",
  fin_hk_lab_costs: "Hakediş lab gideri",
  fin_hk_months: "Hakediş ayı",
  fin_hk_statements: "Hakediş dökümü",
  fin_hk_adjustments: "Hakediş prim / diğer",
  fin_hk_proc_groups: "Hakediş işlem grubu",
  fin_hk_ext_doctors: "Macro hekim eşleştirmesi",
  fin_hk_import_batches: "Macro yüklemesi",
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: "Oluşturuldu",
  update: "Değiştirildi",
  delete: "Silindi",
};

// ---------------------------------------------------------------------------
// Money: integer cents <-> Turkish text
// ---------------------------------------------------------------------------

/** p1 hard rule: 1 ≤ amount ≤ 1,000,000,000,000 cents (10.000.000.000 TL). */
export const MAX_CENTS = 1_000_000_000_000;

export type ParseResult = { ok: true; cents: number } | { ok: false; error: string };

interface ParseOptions {
  /** Bank balances may be negative (FM:32). */
  allowNegative?: boolean;
  /** Zero is allowed for balances and the paid part of an entitlement. */
  allowZero?: boolean;
}

/**
 * Parses a TL amount typed in Turkish or plain notation into integer cents, without floating point.
 * Accepts "1.234,56", "1234,56", "1234.56", "1.000.000" and an optional "TL" / "₺".
 * More than two decimal places is rejected, never rounded.
 */
export function parseTL(raw: string, opts: ParseOptions = {}): ParseResult {
  let s = (raw ?? "").replace(/\s+/g, "").replace(/tl$/i, "").replace(/^₺|₺$/g, "");
  if (s === "") return { ok: false, error: "Tutar girin." };

  let negative = false;
  if (s.startsWith("-")) {
    if (!opts.allowNegative) return { ok: false, error: "Tutar negatif olamaz." };
    negative = true;
    s = s.slice(1);
  }
  if (!/^[0-9.,]+$/.test(s)) return { ok: false, error: "Geçersiz tutar. Örnek: 1.250,50" };

  let intPart: string;
  let frac = "";
  if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length !== 2 || parts[1] === "") {
      return { ok: false, error: "Geçersiz tutar. Örnek: 1.250,50" };
    }
    intPart = parts[0];
    frac = parts[1];
    if (intPart.includes(".")) {
      if (!/^[1-9]\d{0,2}(\.\d{3})+$/.test(intPart)) {
        return { ok: false, error: "Binlik ayracı hatalı. Örnek: 1.250,50" };
      }
      intPart = intPart.replace(/\./g, "");
    }
    if (frac.includes(".")) return { ok: false, error: "Geçersiz tutar. Örnek: 1.250,50" };
  } else if (s.includes(".")) {
    if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
      // Turkish thousands grouping: "1.000" is one thousand TL.
      intPart = s.replace(/\./g, "");
    } else {
      const parts = s.split(".");
      if (parts.length !== 2 || parts[1] === "") {
        return { ok: false, error: "Geçersiz tutar. Örnek: 1.250,50" };
      }
      intPart = parts[0];
      frac = parts[1];
    }
  } else {
    intPart = s;
  }

  if (frac.length > 2) return { ok: false, error: "Kuruş kısmı en fazla 2 basamak olabilir." };
  if (intPart === "") intPart = "0";
  intPart = intPart.replace(/^0+(?=\d)/, "");
  if (intPart.length > 13) return { ok: false, error: "Tutar en fazla 10.000.000.000 TL olabilir." };

  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, error: "Geçersiz tutar." };
  if (cents > MAX_CENTS) return { ok: false, error: "Tutar en fazla 10.000.000.000 TL olabilir." };
  if (cents === 0 && !opts.allowZero) {
    return { ok: false, error: "Tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı." };
  }
  return { ok: true, cents: negative ? -cents : cents };
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "₺1.234,56" (tr-TR). null / undefined → "—" (legacy financeMoney(null)). Exact for any safe integer. */
export function formatTL(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}₺${groupThousands(String(whole))},${frac}`;
}

/** Value for an editable amount input: "1234,56" (no grouping, so it parses back unchanged). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${negative ? "-" : ""}${whole}${frac ? "," + String(frac).padStart(2, "0") : ""}`;
}

// ---------------------------------------------------------------------------
// Dates (wire format 'YYYY-MM-DD' / 'YYYY-MM'; never parsed through UTC)
// ---------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function formatDay(day: string | null | undefined): string {
  if (!day) return "—";
  const m = DAY_RE.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}

export function formatMonth(month: string | null | undefined): string {
  if (!month) return "—";
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("tr-TR", {
    month: "long",
    year: "numeric",
  });
}

export function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function isDay(value: string): boolean {
  return DAY_RE.test(value);
}

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value) && Number(value.slice(5, 7)) >= 1 && Number(value.slice(5, 7)) <= 12;
}

/** Turkish-aware search key (legacy toLocaleLowerCase('tr'), FP:53). */
export function searchKey(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
}

/** Client-supplied ids (p1 hard rule): created when a form opens, reused for retries until success. */
export function newId(): string {
  // crypto.randomUUID exists only in secure contexts (HTTPS / localhost); a clinic PC that opens the app over plain
  // HTTP by LAN address still has getRandomValues, so a v4 uuid is built from it there.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Errors (p1 §1.1)
// ---------------------------------------------------------------------------

export class FinanceError extends Error {
  code: string | null;
  details: string | null;

  constructor(message: string, code: string | null, details: string | null) {
    super(message);
    this.name = "FinanceError";
    this.code = code;
    this.details = details;
  }

  /** PT409: version / base conflict or duplicate key; the UI offers "Yenile". */
  get isConflict() {
    return this.code === "PT409";
  }
  /** PT404: row not in the caller's clinic. */
  get isNotFound() {
    return this.code === "PT404";
  }
  /** 42501: missing permission or session. */
  get isForbidden() {
    return this.code === "42501";
  }
}

const NETWORK_MESSAGE = "İşlem tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin.";
/**
 * 40P01: two receipt writes of one month reconciled at the same time (0022 live reconciliation); the database
 * cancelled one. Every finance write is idempotent, so retrying is safe. Mapped here so every finance page shows it.
 */
const DEADLOCK_MESSAGE = "Aynı anda başka bir finans işlemi kaydedildi. Tekrar deneyin.";

export function toFinanceError(err: unknown): FinanceError {
  if (err instanceof FinanceError) return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; details?: unknown };
    const message =
      e.code === "40P01" ? DEADLOCK_MESSAGE : typeof e.message === "string" && e.message ? e.message : NETWORK_MESSAGE;
    return new FinanceError(
      message,
      typeof e.code === "string" ? e.code : null,
      typeof e.details === "string" ? e.details : null
    );
  }
  return new FinanceError(NETWORK_MESSAGE, null, null);
}

let client: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await sb().rpc(name, args) : await sb().rpc(name);
  } catch (err) {
    throw toFinanceError(err);
  }
  if (result.error) throw toFinanceError(result.error);
  return result.data as T;
}

// ---------------------------------------------------------------------------
// JSON shapes (p2 §3.0.1, §3.1, §3.5)
// ---------------------------------------------------------------------------

export interface EntryJson {
  id: string;
  version: number;
  category_id: string;
  category_name: string;
  direction: Direction;
  profit_class: ProfitClass;
  report_bucket: ReportBucket;
  subcategory: Subcategory | null;
  counterparty_id: string | null;
  counterparty_text: string | null;
  counterparty_name: string;
  counterparty_kind: CounterpartyKind | null;
  report_group_id: string | null;
  report_group_name: string | null;
  description: string;
  due_date: string;
  amount_cents: number;
  paid_cents: number;
  outstanding_cents: number;
  status: EntryStatus;
  is_overdue: boolean;
  entitlement_month: string | null;
  is_entitlement: boolean;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  excluded_from_totals: boolean;
  exclusion_reason: string | null;
  excluded_at: string | null;
  excluded_by_name: string | null;
  source_key: string | null;
  source_file: string | null;
  has_legacy_id: boolean;
  payment_count: number;
  voided_payment_count: number;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
  // Phase 2 / 4 (0022 fin__entry_json); optional so pages keep working before the migration is applied.
  /** 'receipt_reconciliation' exclusions are controlled by the clinic Excel reconciliation, not by hand */
  exclusion_source?: "manual" | "receipt_reconciliation" | null;
  reconciled_month?: string | null;
  /** financing fee entry: changes only through /finance/financing */
  is_locked?: boolean;
  financing?: {
    id: string;
    version: number;
    provider: string;
    reference: string;
    blocked: boolean;
    expected_release: string | null;
    released_on: string | null;
    is_voided: boolean;
  } | null;
  import?: { source_kind: string; batch_id: string | null; file_name: string | null; origin: string } | null;
}

export interface PaymentJson {
  id: string;
  entry_id: string;
  paid_on: string;
  amount_cents: number;
  account_id: string;
  account_name: string;
  account_kind: AccountKind;
  account_is_active: boolean;
  is_voided: boolean;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  physician_split: "current" | "past" | null;
  bank_source: { key: string; file: string | null; description: string | null } | null;
  recorded_at: string;
  recorded_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

export interface DetailPaymentJson extends PaymentJson {
  /** amount − paid + this payment (RT:134); 0 for voided payments. */
  max_correction_cents: number;
}

export interface SnapshotSourceJson {
  id: string;
  kind: "bank" | "cash";
  source_key: string;
  account_id: string | null;
  account_name: string | null;
  label: string;
  as_of: string;
  amount_cents: number;
  file_name: string | null;
  note: string;
  is_manual: boolean;
  is_older_than_today: boolean;
}

export interface SnapshotJson {
  id: string;
  version: number;
  day: string;
  bank_cents: number;
  cash_cents: number;
  liquid_cents: number;
  bank_as_of: string;
  cash_as_of: string;
  bank_mode: "manual" | "accounts";
  is_today: boolean;
  note: string;
  updated_at: string;
  updated_by_name: string | null;
  sources: SnapshotSourceJson[];
}

export interface ListTotalsJson {
  count: number;
  incoming_cents: number;
  outgoing_cents: number;
  open_incoming_cents: number;
  open_outgoing_cents: number;
  net_cents: number;
}

export interface SettingsJson {
  id: string;
  version: number;
  buffer_target_cents: number;
  forecast_days: number;
  physician_fee_note: string | null;
  report_brand_name: string | null;
  entitlement_account_id: string | null;
}

export interface AccountJson {
  id: string;
  version: number;
  name: string;
  kind: AccountKind;
  bank_name: string | null;
  import_key: string | null;
  is_active: boolean;
  sort_order: number;
  is_used: boolean;
}

export interface ReportGroupJson {
  id: string;
  version: number;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export interface CategoryJson {
  id: string;
  version: number;
  name: string;
  direction: Direction;
  profit_class: ProfitClass;
  report_bucket: ReportBucket;
  report_group_id: string | null;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface CounterpartyJson {
  id: string;
  version: number;
  name: string;
  kind: CounterpartyKind;
  doctor_id: string | null;
  doctor_name: string | null;
  report_group_id: string | null;
  note: string;
  is_active: boolean;
}

export interface DoctorRefJson {
  doctor_id: string;
  full_name: string;
  is_active: boolean;
  counterparty_id: string | null;
}

export interface ReferenceData {
  today: string;
  current_month: string;
  can_write: boolean;
  settings: SettingsJson;
  accounts: AccountJson[];
  report_groups: ReportGroupJson[];
  categories: CategoryJson[];
  counterparties: CounterpartyJson[];
  doctors: DoctorRefJson[];
}

export interface EntryWriteResult {
  already_saved: boolean;
  entry: EntryJson;
  payments: PaymentJson[];
}

export interface MasterWriteResult<T> {
  already_saved: boolean;
  record: T;
}

export interface BalanceWriteResult {
  already_saved: boolean;
  snapshot: SnapshotJson;
  /** fin_merge_balance_sources only: true when nothing was written (preview) */
  dry_run?: boolean;
}

export interface Paged {
  total_count: number;
  offset: number;
  limit: number;
}

export interface PageArg {
  offset?: number;
  limit?: number;
}

export type StatusFilter = "all" | "open" | "completed" | "cancelled";

/** fin_list p_filters. Only set keys are sent; an unknown key or bad value → E_FILTER. */
export interface ListFilters {
  status?: StatusFilter;
  category_id?: string;
  direction?: Direction;
  counterparty_id?: string;
  counterparty_text?: string;
  /** a report group id, or "other" for the implicit 'Diğer borçlar' group */
  report_group?: string;
  query?: string;
  date_from?: string;
  date_to?: string;
  overdue?: boolean;
}

export interface ListResult extends Paged {
  today: string;
  rows: EntryJson[];
  totals: ListTotalsJson;
}

export interface HistoryRowJson {
  id: string;
  at: string;
  user_name: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, unknown> | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

export interface EntryDetail {
  today: string;
  entry: EntryJson;
  payments: DetailPaymentJson[];
  max_payment_cents: number;
  history: HistoryRowJson[];
}

export interface OpenGroupsJson {
  payable: {
    report_group_id: string | null;
    name: string;
    is_active: boolean;
    outstanding_cents: number;
    entry_count: number;
  }[];
  payable_total_cents: number;
  receivable_cents: number;
  receivable_entry_count: number;
}

export interface CategoryReportRow {
  category_id: string;
  name: string;
  direction: Direction;
  report_bucket: ReportBucket;
  is_active: boolean;
  count: number;
  incoming_cents: number;
  outgoing_cents: number;
  open_incoming_cents: number;
  open_outgoing_cents: number;
  net_cents: number;
}

export interface DashboardJson {
  today: string;
  month: string;
  is_current_month: boolean;
  settings: { buffer_target_cents: number; forecast_days: number; physician_fee_note: string | null };
  liquidity: { snapshot: SnapshotJson | null; liquid_cents: number | null };
  month_summary: {
    receipts_cents: number;
    inflow_cents: number;
    outflow_cents: number;
    net_cents: number;
    profit_income_cents: number;
    profit_expense_cents: number;
    loan_payments_cents: number;
    other_payments_cents: number;
    after_all_payments_cents: number;
    profit_cents: number;
    current_period_result_cents: number;
  };
  expenses: {
    by_bucket: Partial<Record<ReportBucket, number>>;
    current_doctor_cents: number;
    past_doctor_cents: number;
    general_cents: number;
    operational_cents: number;
  };
  forecast: {
    window_end: string;
    expected_in_cents: number;
    expected_out_cents: number;
    after_payments_cents: number | null;
    forecast_cents: number | null;
  };
  buffer: { target_cents: number; liquid_cents: number | null; delta_cents: number | null };
  groups: OpenGroupsJson;
  category_report: CategoryReportRow[];
  exclusions: {
    /** every excluded entry, any month */
    entry_count: number;
    /** excluded entries with a live payment in the selected month */
    entry_count_in_month: number;
    paid_cents_in_month: number;
  };
}

export interface ForecastJson extends Paged {
  today: string;
  window_end: string;
  forecast_days: number;
  rows: EntryJson[];
  totals: ListTotalsJson;
  expected_in_cents: number;
  expected_out_cents: number;
  liquid_cents: number | null;
  after_payments_cents: number | null;
  forecast_cents: number | null;
}

export interface LedgerRowJson {
  counterparty_id: string | null;
  counterparty_text: string | null;
  name: string;
  kind: CounterpartyKind | null;
  is_active: boolean | null;
  doctor_name: string | null;
  report_group_name: string | null;
  receivable_cents: number;
  payable_cents: number;
  net_cents: number;
  open_entry_count: number;
  paid_in_cents: number;
  paid_out_cents: number;
  last_due_date: string | null;
}

export interface LedgerJson extends Paged {
  rows: LedgerRowJson[];
  totals: { receivable_cents: number; payable_cents: number; net_cents: number };
}

export interface BalanceHistoryJson extends Paged {
  today: string;
  current_snapshot_id: string | null;
  rows: SnapshotJson[];
}

export type AuditEntityType =
  | "fin_settings"
  | "fin_accounts"
  | "fin_report_groups"
  | "fin_categories"
  | "fin_counterparties"
  | "fin_entries"
  | "fin_payments"
  | "fin_balance_snapshots"
  | "fin_balance_sources"
  | "fin_import_batches"
  | "fin_import_sources"
  | "fin_classification_rules"
  | "fin_import_layouts"
  | "fin_patient_financing"
  | "fin_hk_rules"
  | "fin_hk_lines"
  | "fin_hk_pieces"
  | "fin_hk_patient_marks"
  | "fin_hk_lab_costs"
  | "fin_hk_months"
  | "fin_hk_statements"
  | "fin_hk_adjustments"
  | "fin_hk_proc_groups"
  | "fin_hk_ext_doctors"
  | "fin_hk_import_batches";

export interface AuditFilters {
  entity_type?: AuditEntityType;
  entity_id?: string;
  user_id?: string;
  date_from?: string;
  date_to?: string;
}

export interface AuditRowJson {
  id: string;
  at: string;
  user_id: string | null;
  user_name: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, unknown> | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

export interface AuditListJson extends Paged {
  rows: AuditRowJson[];
}

export interface ExportManifestJson {
  format: string;
  generated_at: string;
  clinic_today: string;
  clinic: { id: string; name: string };
  tables: { name: string; row_count: number; filter?: string }[];
}

/** Drops undefined, null, empty-string and `false` overdue values so fin_list never sees an unset key. */
export function compactFilters<T extends object>(filters: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(filters) as [keyof T, unknown][]) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "overdue" && value === false) continue;
    if (key === "status" && value === "all") continue;
    out[key] = value as T[keyof T];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read RPCs (p2 §3.1, §3.5, §3.6, §3.8) — fin__require_read(): finance or finance_readonly
// ---------------------------------------------------------------------------

export function finReferenceData() {
  return rpc<ReferenceData>("fin_reference_data");
}

export function finList(filters: ListFilters, page: PageArg) {
  return rpc<ListResult>("fin_list", { p_filters: compactFilters(filters), p_page: page });
}

export function finEntryDetail(id: string) {
  return rpc<EntryDetail>("fin_entry_detail", { p_id: id });
}

/** p_month 'YYYY-MM'; null = current month. */
export function finDashboard(month: string | null) {
  return rpc<DashboardJson>("fin_dashboard", { p_month: month });
}

export function finForecast(offset: number, limit: number) {
  return rpc<ForecastJson>("fin_forecast", { p_offset: offset, p_limit: limit });
}

export function finOpenGroups() {
  return rpc<OpenGroupsJson>("fin_open_groups");
}

export function finCounterpartyLedger(
  query: string | null,
  includeSettled: boolean,
  offset: number,
  limit: number
) {
  return rpc<LedgerJson>("fin_counterparty_ledger", {
    p_query: query && query.trim() ? query.trim() : null,
    p_include_settled: includeSettled,
    p_offset: offset,
    p_limit: limit,
  });
}

export function finBalanceHistory(offset: number, limit: number) {
  return rpc<BalanceHistoryJson>("fin_balance_history", { p_offset: offset, p_limit: limit });
}

export function finAuditList(filters: AuditFilters, page: PageArg) {
  return rpc<AuditListJson>("fin_audit_list", { p_filters: compactFilters(filters), p_page: page });
}

/** Owner + 'finance' only (E_EXPORT otherwise). */
export function finExportManifest() {
  return rpc<ExportManifestJson>("fin_export_manifest");
}

// ---------------------------------------------------------------------------
// Master-data write RPCs (p2 §3.1) — fin__require_write(): finance. p_version 0 = create.
// ---------------------------------------------------------------------------

export function finSaveSettings(args: {
  p_version: number;
  p_buffer_target_cents: number;
  p_forecast_days: number;
  p_physician_fee_note: string | null;
  p_report_brand_name: string | null;
  p_entitlement_account_id: string | null;
}) {
  return rpc<MasterWriteResult<SettingsJson>>("fin_save_settings", args);
}

export function finSaveAccount(args: {
  p_id: string;
  p_version: number;
  p_name: string;
  p_kind: AccountKind;
  p_bank_name: string | null;
  p_is_active: boolean;
  p_sort_order: number;
}) {
  return rpc<MasterWriteResult<AccountJson>>("fin_save_account", args);
}

export function finSaveReportGroup(args: {
  p_id: string;
  p_version: number;
  p_name: string;
  p_is_active: boolean;
  p_sort_order: number;
}) {
  return rpc<MasterWriteResult<ReportGroupJson>>("fin_save_report_group", args);
}

export function finSaveCategory(args: {
  p_id: string;
  p_version: number;
  p_name: string;
  p_report_bucket: ReportBucket;
  p_report_group_id: string | null;
  p_is_active: boolean;
  p_sort_order: number;
}) {
  return rpc<MasterWriteResult<CategoryJson>>("fin_save_category", args);
}

export function finSaveCounterparty(args: {
  p_id: string;
  p_version: number;
  p_name: string;
  p_kind: CounterpartyKind;
  p_doctor_id: string | null;
  p_report_group_id: string | null;
  p_note: string;
  p_is_active: boolean;
}) {
  return rpc<MasterWriteResult<CounterpartyJson>>("fin_save_counterparty", args);
}

// ---------------------------------------------------------------------------
// Entry and payment write RPCs (p2 §3.2)
// ---------------------------------------------------------------------------

export function finCreateEntry(args: {
  p_id: string;
  p_category_id: string;
  p_subcategory: Subcategory | null;
  p_counterparty_id: string | null;
  p_counterparty_text: string | null;
  p_description: string;
  p_due_date: string;
  p_amount_cents: number;
  p_entitlement_month: string | null;
  p_realized: boolean;
  p_account_id: string | null;
}) {
  return rpc<EntryWriteResult>("fin_create_entry", args);
}

export function finEditEntry(args: {
  p_id: string;
  p_version: number;
  p_category_id: string;
  p_subcategory: Subcategory | null;
  p_counterparty_id: string | null;
  p_counterparty_text: string | null;
  p_description: string;
  p_due_date: string;
  p_amount_cents: number;
  p_entitlement_month: string | null;
}) {
  return rpc<EntryWriteResult>("fin_edit_entry", args);
}

export function finRecordPayment(args: {
  p_entry_id: string;
  p_version: number;
  p_payment_id: string;
  p_paid_on: string;
  p_amount_cents: number;
  p_account_id: string;
}) {
  return rpc<EntryWriteResult>("fin_record_payment", args);
}

export function finCorrectPayment(args: {
  p_entry_id: string;
  p_version: number;
  p_payment_id: string;
  p_paid_on: string;
  p_amount_cents: number;
  p_account_id: string;
}) {
  return rpc<EntryWriteResult>("fin_correct_payment", args);
}

export function finVoidPayment(args: {
  p_entry_id: string;
  p_version: number;
  p_payment_id: string;
  p_reason: string;
}) {
  return rpc<EntryWriteResult>("fin_void_payment", args);
}

export function finCancelEntry(args: { p_id: string; p_version: number; p_reason: string }) {
  return rpc<EntryWriteResult>("fin_cancel_entry", args);
}

export function finSetExclusion(args: {
  p_id: string;
  p_version: number;
  p_excluded: boolean;
  p_reason: string | null;
}) {
  return rpc<EntryWriteResult>("fin_set_exclusion", args);
}

export function finAddEntitlement(args: {
  p_id: string;
  p_counterparty_id: string;
  p_month: string;
  p_amount_cents: number;
  p_paid_cents: number;
  p_paid_on: string | null;
  p_account_id: string | null;
  p_description: string;
}) {
  return rpc<EntryWriteResult>("fin_add_entitlement", args);
}

// ---------------------------------------------------------------------------
// Balance write RPCs (p2 §3.3)
// ---------------------------------------------------------------------------

export interface BalanceAccountItem {
  account_id: string;
  amount_cents: number;
  as_of: string | null;
}

/** Exactly one of p_bank_total_cents / p_bank_accounts (E_BALANCE_MODE). */
export function finSaveBalance(args: {
  p_day: string;
  p_version: number;
  p_bank_total_cents: number | null;
  p_bank_accounts: BalanceAccountItem[] | null;
  p_cash_cents: number;
  p_note: string;
}) {
  return rpc<BalanceWriteResult>("fin_save_balance", args);
}

export interface MergeSourceItem {
  kind: "bank" | "cash";
  account_id: string | null;
  amount_cents: number;
  as_of: string;
  label: string | null;
  file_name: string | null;
  note: string | null;
}

export function finMergeBalanceSources(args: {
  p_base_snapshot_id: string | null;
  p_base_version: number | null;
  p_sources: MergeSourceItem[];
  p_initialize_banks: boolean;
  /** true: returns the merged snapshot without writing anything (legacy preview BP:9-13) */
  p_dry_run?: boolean;
}) {
  return rpc<BalanceWriteResult>("fin_merge_balance_sources", args);
}

// ---------------------------------------------------------------------------
// Small pure helpers shared by the pages
// ---------------------------------------------------------------------------

export function sortByOrder<T extends { sort_order: number; name: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "tr-TR")
  );
}

/** Pickers offer active rows, plus the currently selected row even if it is inactive. */
export function pickable<T extends { id: string; is_active: boolean }>(
  rows: T[],
  selectedId?: string | null
): T[] {
  return rows.filter((r) => r.is_active || r.id === selectedId);
}

export function bucketOf(ref: ReferenceData | null, categoryId: string): CategoryJson | undefined {
  return ref?.categories.find((c) => c.id === categoryId);
}

/** Subcategory choices for a bucket (p1 §1.4). */
export function subcategoryOptions(bucket: ReportBucket | undefined): { value: Subcategory | ""; label: string }[] {
  if (bucket === "doctor") {
    return [
      { value: "current_physician", label: "Cari dönem" },
      { value: "past_physician_debt", label: "Geçmiş dönem borç ödemesi" },
    ];
  }
  if (bucket === "other_expense") {
    return [
      { value: "", label: "Genel gider" },
      { value: "official_fee", label: "Resmi harç" },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Drill-down text without the URL. Names of patients, physicians and suppliers must not end up in the address
// bar, browser history or Vercel request logs (every App Router navigation fetches ?_rsc= with the full query
// string). A free-text drill-down therefore travels as a random reference: the text sits in memory and, for a
// reload of the same tab, in sessionStorage; the URL only carries ?cp_ref=<uuid>.
// ---------------------------------------------------------------------------

const DRILL_PREFIX = "fin:drill:";
const drillMemory = new Map<string, string>();

/** Stores a counterparty text for the entries page and returns the reference to put in the URL. */
export function stashDrillText(text: string): string {
  const key = newId();
  drillMemory.set(key, text);
  try {
    window.sessionStorage.setItem(DRILL_PREFIX + key, text);
  } catch {
    // private mode / blocked storage: the in-memory copy still serves client-side navigation
  }
  return key;
}

/** Reads a stashed drill-down text; null when unknown (another tab, closed tab, cleared storage). */
export function readDrillText(key: string): string | null {
  if (!UUID_RE.test(key)) return null;
  const cached = drillMemory.get(key);
  if (cached !== undefined) return cached;
  try {
    const stored = window.sessionStorage.getItem(DRILL_PREFIX + key);
    if (stored !== null) {
      drillMemory.set(key, stored);
      return stored;
    }
  } catch {
    // storage unavailable
  }
  return null;
}

/** Forgets a drill-down text when its filter is cleared. */
export function dropDrillText(key: string): void {
  drillMemory.delete(key);
  try {
    window.sessionStorage.removeItem(DRILL_PREFIX + key);
  } catch {
    // storage unavailable
  }
}

/** Matches a typed name to an active master counterparty, the way the server snaps free text (p2 §3.2). */
export function matchCounterparty(
  ref: ReferenceData | null,
  text: string
): CounterpartyJson | undefined {
  const key = searchKey(text);
  if (!key || !ref) return undefined;
  return ref.counterparties.find((c) => c.is_active && searchKey(c.name) === key);
}

// ---------------------------------------------------------------------------
// Phase 2 + 4: file imports, bank matching, balances from files, patient financing (spec p2i_db_contract §4).
// Files are parsed in the browser (lib/finance-import); only confirmed rows reach these RPCs.
// ---------------------------------------------------------------------------

export type FinancingReceiptsSource = "clinic_excel" | "dentos_payments";

/** fin__settings_json after Phase 2/4 (§2.12): the P1 shape plus the four financing fields. */
export interface ImportSettingsJson extends SettingsJson {
  financing_receipts_source: FinancingReceiptsSource;
  default_block_days: number;
  financing_counterparty_id: string | null;
  financing_account_id: string | null;
}

export type RuleScope = "any" | "bank" | "clinic";
export type RuleMatchKind = "contains" | "starts_with" | "exact" | "regex" | "always";

export interface ClassificationRuleJson {
  id: string;
  version: number;
  priority: number;
  scope: RuleScope;
  match_kind: RuleMatchKind;
  pattern: string | null;
  category_id: string;
  category_name: string;
  report_bucket: ReportBucket;
  direction: Direction;
  subcategory: Subcategory | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  requires_entitlement_month: boolean;
  auto_select: boolean;
  warning: string;
  is_active: boolean;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

export type ImportLayoutKind = "clinic_workbook" | "bank_table";

export interface ImportLayoutJson {
  id: string;
  version: number;
  kind: ImportLayoutKind;
  name: string;
  config: Record<string, unknown>;
  key_label: string | null;
  account_id: string | null;
  account_name: string | null;
  receipts_account_id: string | null;
  receipts_account_name: string | null;
  bank_paid_account_id: string | null;
  bank_paid_account_name: string | null;
  cash_paid_account_id: string | null;
  cash_paid_account_name: string | null;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportSetupAccountJson {
  id: string;
  /** not part of the §4.1 shape; read the version from fin_reference_data when writing */
  version?: number;
  name: string;
  kind: AccountKind;
  bank_name: string | null;
  import_key: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface ImportSetupJson {
  today: string;
  current_month: string;
  can_write: boolean;
  settings: ImportSettingsJson;
  financing_ready: boolean;
  accounts: ImportSetupAccountJson[];
  rules: ClassificationRuleJson[];
  layouts: ImportLayoutJson[];
}

export function finImportSetup() {
  return rpc<ImportSetupJson>("fin_import_setup");
}

export function finSaveImportSettings(args: {
  p_version: number;
  p_financing_receipts_source: FinancingReceiptsSource;
  p_default_block_days: number;
  p_financing_counterparty_id: string | null;
  p_financing_account_id: string | null;
}) {
  return rpc<MasterWriteResult<ImportSettingsJson>>("fin_save_import_settings", args);
}

/** Writes fin_accounts.import_key ('<Bank>:<account>'); null / blank clears it. Compared exactly, never folded. */
export function finSetAccountImportKey(args: { p_id: string; p_version: number; p_import_key: string | null }) {
  return rpc<MasterWriteResult<AccountJson>>("fin_set_account_import_key", args);
}

export function finSaveClassificationRule(args: {
  p_id: string;
  p_version: number;
  p_priority: number;
  p_scope: RuleScope;
  p_match_kind: RuleMatchKind;
  p_pattern: string | null;
  p_category_id: string;
  p_subcategory: Subcategory | null;
  p_counterparty_id: string | null;
  p_requires_entitlement_month: boolean;
  p_auto_select: boolean;
  p_warning: string;
  p_is_active: boolean;
}) {
  return rpc<MasterWriteResult<ClassificationRuleJson>>("fin_save_classification_rule", args);
}

export function finSaveImportLayout(args: {
  p_id: string;
  p_version: number;
  p_kind: ImportLayoutKind;
  p_name: string;
  p_config: Record<string, unknown>;
  p_key_label: string | null;
  p_account_id: string | null;
  p_receipts_account_id: string | null;
  p_bank_paid_account_id: string | null;
  p_cash_paid_account_id: string | null;
  p_is_default: boolean;
  p_is_active: boolean;
}) {
  return rpc<MasterWriteResult<ImportLayoutJson>>("fin_save_import_layout", args);
}

// --- Review preflight (§4.5) -------------------------------------------------

export type ImportSourceKind = "clinic_excel" | "bank_known" | "bank_table";
export type ImportWarningCode = "possible_duplicate" | "batch_duplicate" | "manual_receipt_overlap";
export type ImportRowError = "outside_month" | "future_date" | "financing_line" | "receipts_day_taken" | "invalid_key";
export type ImportCheckStatus =
  | "new"
  | "saved_same"
  | "saved_changed"
  | "matched_same"
  | "matched_changed"
  | "match_voided"
  | "id_taken";

export interface ImportCheckRowInput {
  row_no: number;
  key: string;
  kind: ImportSourceKind;
  entry_id: string;
  date: string;
  amount_cents: number;
  direction: Direction;
  /** sent only for rows the user selected (narrations of unselected rows never leave the browser) */
  description?: string;
  fingerprint: string | null;
}

export interface DuplicateExampleJson {
  entry_id: string;
  counterparty_name: string;
  paid_on: string;
  amount_cents: number;
  account_name: string;
}

export interface ImportCheckWarningJson {
  code: ImportWarningCode;
  examples?: DuplicateExampleJson[];
  row_no?: number;
}

export interface ReceiptReconciliationCoreJson {
  month: string;
  equivalent: boolean;
  through: string | null;
  excluded_ids: string[];
  manual_total_cents: number;
  imported_total_cents: number;
  overlap: boolean;
}

export interface ImportCheckRowJson {
  row_no: number;
  key: string;
  status: ImportCheckStatus;
  existing: {
    entry_id: string;
    amount_cents: number;
    counterparty_name: string;
    paid_on: string | null;
    source_kind: string;
    batch_id: string | null;
  } | null;
  warnings: ImportCheckWarningJson[];
  errors: ImportRowError[];
}

export interface ImportCheckJson {
  month: string;
  manual_receipts: { count: number; total_cents: number };
  reconciliation: ReceiptReconciliationCoreJson;
  rows: ImportCheckRowJson[];
}

/** Write permission; reads only. 1..2000 rows in review-list order. */
export function finImportCheck(month: string, rows: ImportCheckRowInput[]) {
  return rpc<ImportCheckJson>("fin_import_check", { p_month: month, p_rows: rows });
}

// --- Bank matching candidates (§4.6) -------------------------------------------

export interface DebtCandidateJson {
  suggested: boolean;
  score: number;
  reason: string;
  entry: {
    id: string;
    version: number;
    counterparty_name: string;
    description: string;
    category_name: string;
    report_bucket: ReportBucket;
    due_date: string;
    amount_cents: number;
    outstanding_cents: number;
  };
}

export function finDebtCandidates(amountCents: number, date: string, text: string, limit = 50) {
  return rpc<{ total_count: number; candidates: DebtCandidateJson[] }>("fin_debt_candidates", {
    p_amount_cents: amountCents,
    p_date: date,
    p_text: text.slice(0, 1000),
    p_limit: limit,
  });
}

// --- Commit (§4.7) ----------------------------------------------------------------

export interface ImportRowPayload {
  row_no: number;
  key: string;
  kind: ImportSourceKind;
  file: string;
  date: string;
  amount_cents: number;
  direction: Direction;
  currency: "TRY";
  account_id: string;
  acknowledged: ImportWarningCode[];
  description: string;
  entry_id?: string | null;
  fingerprint?: string | null;
  category_id?: string | null;
  subcategory?: Subcategory | null;
  entitlement_month?: string | null;
  counterparty_id?: string | null;
  counterparty_text?: string | null;
  match: { entry_id: string; version: number; payment_id: string } | null;
}

export interface ImportBatchJson {
  id: string;
  kind: "rows" | "financing";
  month: string | null;
  file_names: string[];
  layout_ids: string[];
  rows_sent: number;
  inserted: number;
  matched: number;
  skipped: number;
  acknowledged: number;
  created_at: string;
  created_by_name: string | null;
}

export interface ImportRowsResultJson {
  already_saved: boolean;
  batch: ImportBatchJson;
  inserted: number;
  matched: number;
  skipped: number;
  acknowledged: number;
  rows: {
    row_no: number;
    key: string;
    status: "inserted" | "matched" | "skipped_same" | "skipped_matched";
    entry_id: string;
    payment_id: string | null;
  }[];
  reconciliation: {
    month: string;
    equivalent: boolean;
    through: string | null;
    excluded_count: number;
    manual_total_cents: number;
    imported_total_cents: number;
  } | null;
}

export function finImportRows(
  rows: ImportRowPayload[],
  batch: { id: string; month: string; file_names: string[]; layout_ids: string[] }
) {
  return rpc<ImportRowsResultJson>("fin_import_rows", { p_rows: rows, p_batch: batch });
}

// --- Receipt reconciliation read side (§4.8) ------------------------------------

export interface ReconciliationEntryJson {
  id: string;
  counterparty_name: string;
  due_date: string;
  paid_cents: number;
  is_cancelled: boolean;
  excluded_from_totals: boolean;
  exclusion_source: "manual" | "receipt_reconciliation" | null;
}

export interface ReceiptReconciliationJson extends ReceiptReconciliationCoreJson {
  applied_ids: string[];
  in_sync: boolean;
  manual_entries: ReconciliationEntryJson[];
  imported_entries: ReconciliationEntryJson[];
}

export function finReceiptReconciliation(month: string | null) {
  return rpc<ReceiptReconciliationJson>("fin_receipt_reconciliation", { p_month: month });
}

// --- Balances read from files (§4.9) --------------------------------------------

export interface ImportBalanceItem {
  kind: "bank" | "cash";
  /** '<Bank>:<account>' for bank sources, 'clinic-cash' for the workbook cash */
  import_key: string;
  amount_cents: number;
  as_of: string;
  label: string;
  file_name: string;
  note: string;
}

export interface ImportBalancesResultJson extends BalanceWriteResult {
  mapped: { import_key: string; account_id: string | null; account_name: string | null }[];
}

export function finImportBalances(args: {
  p_sources: ImportBalanceItem[];
  /** updated_at of the current snapshot exactly as read; null when there is none */
  p_base_updated_at: string | null;
  p_initialize_banks: boolean;
  p_dry_run: boolean;
}) {
  return rpc<ImportBalancesResultJson>("fin_import_balances", args);
}

// --- Patient financing (§4.10) ----------------------------------------------------

export type FinancingStatus = "unblocked" | "blocked" | "released" | "voided";

export interface FinancingJson {
  id: string;
  version: number;
  provider: string;
  reference: string;
  loan_key: string;
  patient_name_raw: string;
  patient_id: string | null;
  patient_name: string | null;
  txn_date: string;
  gross_cents: number;
  commission_cents: number;
  kkdf_cents: number;
  bsmv_cents: number;
  fee_cents: number;
  net_cents: number;
  blocked: boolean;
  expected_release: string | null;
  released_on: string | null;
  released_by_name: string | null;
  status: FinancingStatus;
  needs_check: boolean;
  entry_id: string;
  source_key: string;
  source_file: string | null;
  voided_at: string | null;
  void_reason: string | null;
  corrected_at: string | null;
  correction_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

export interface FinancingItemPayload {
  id: string;
  entry_id: string;
  provider: string;
  reference: string;
  patient_name_raw: string;
  txn_date: string;
  currency: "TRY";
  gross_cents: number;
  commission_cents: number;
  kkdf_cents: number;
  bsmv_cents: number;
  blocked: boolean;
  expected_release: string | null;
  file: string;
}

export interface FinancingImportResultJson {
  already_saved: boolean;
  batch: ImportBatchJson;
  added: number;
  skipped: number;
  items: FinancingJson[];
}

export function finFinancingImport(batchId: string, items: FinancingItemPayload[], grossConfirmed: boolean) {
  return rpc<FinancingImportResultJson>("fin_financing_import", {
    p_batch_id: batchId,
    p_items: items,
    p_gross_confirmed: grossConfirmed,
  });
}

export interface FinancingWriteResult {
  already_saved: boolean;
  record: FinancingJson;
  entry: EntryJson;
}

export function finFinancingRelease(args: { p_id: string; p_version: number; p_date: string }) {
  return rpc<FinancingWriteResult>("fin_financing_release", args);
}

export function finFinancingCorrect(args: {
  p_id: string;
  p_version: number;
  p_gross_cents: number;
  p_commission_cents: number;
  p_kkdf_cents: number;
  p_bsmv_cents: number;
  p_blocked: boolean;
  p_expected_release: string | null;
  p_released_on: string | null;
  p_reason: string;
}) {
  return rpc<FinancingWriteResult>("fin_financing_correct", args);
}

export function finFinancingVoid(args: { p_id: string; p_version: number; p_reason: string }) {
  return rpc<FinancingWriteResult>("fin_financing_void", args);
}

export function finFinancingLinkPatient(args: { p_id: string; p_version: number; p_patient_id: string | null }) {
  return rpc<FinancingWriteResult>("fin_financing_link_patient", args);
}

export interface FinancingSummaryJson {
  today: string;
  month: string;
  receipts_source: FinancingReceiptsSource;
  gross_cents: number;
  fee_cents: number;
  monthly_count: number;
  blocked_net_cents: number;
  blocked_count: number;
  needs_check_count: number;
}

export function finFinancingSummary(month: string | null) {
  return rpc<FinancingSummaryJson>("fin_financing_summary", { p_month: month });
}

export type FinancingStatusFilter = "all" | "unblocked" | "blocked" | "needs_check" | "released" | "voided";

export interface FinancingFilters {
  month?: string;
  status?: FinancingStatusFilter;
  query?: string;
  patient_id?: string;
}

export interface FinancingListJson extends Paged {
  today: string;
  rows: FinancingJson[];
  totals: { gross_cents: number; fee_cents: number; net_cents: number };
}

export function finFinancingList(filters: FinancingFilters, page: PageArg) {
  const f: FinancingFilters = { ...filters };
  if (f.status === "all") delete f.status;
  return rpc<FinancingListJson>("fin_financing_list", { p_filters: compactFilters(f), p_page: page });
}

// --- History (§4.11) ------------------------------------------------------------

export interface ImportHistoryFilters {
  kind?: "rows" | "financing";
  month?: string;
  date_from?: string;
  date_to?: string;
}

export function finImportHistory(filters: ImportHistoryFilters, page: PageArg) {
  return rpc<{ rows: ImportBatchJson[] } & Paged>("fin_import_history", {
    p_filters: compactFilters(filters),
    p_page: page,
  });
}

export interface ImportBatchSourceJson {
  source_key: string;
  source_kind: string;
  link_kind: "entry" | "payment_match";
  file_name: string | null;
  txn_date: string | null;
  amount_cents: number | null;
  entry_id: string;
  payment_id: string | null;
  payment_is_voided: boolean;
  rebind_count: number;
  rebound_at: string | null;
  entry: {
    counterparty_name: string;
    category_name: string;
    status: EntryStatus;
    amount_cents: number;
    outstanding_cents: number;
  } | null;
}

export function finImportBatch(id: string) {
  return rpc<{ batch: ImportBatchJson; sources: ImportBatchSourceJson[] }>("fin_import_batch", { p_id: id });
}

/** §1 item 6: two concurrent receipt writes in one month can deadlock; the retry is safe (every write is idempotent). */
export function importErrorMessage(err: FinanceError): string {
  if (err.code === "40P01") return DEADLOCK_MESSAGE;
  return err.message;
}

/** DETAIL of per-row import errors: {"row_no": n, "key": "…"} (§1 item 1). */
export function importErrorRow(err: FinanceError): { row_no: number | null; key: string | null } {
  if (!err.details) return { row_no: null, key: null };
  try {
    const d = JSON.parse(err.details) as { row_no?: unknown; key?: unknown };
    return {
      row_no: typeof d.row_no === "number" ? d.row_no : null,
      key: typeof d.key === "string" ? d.key : null,
    };
  } catch {
    return { row_no: null, key: null };
  }
}
