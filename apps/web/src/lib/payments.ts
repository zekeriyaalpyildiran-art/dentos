// Patient payments (Phase 5): exact money / FX helpers, labels and typed RPC wrappers.
// Contract: spec p5_patient_payments §3, §4, §5. Every read and write goes through SECURITY DEFINER RPCs (pp_* for any
// staff member, fin_* for finance holders). Money is integer cents next to its currency; rates travel as strings
// ("49.876500", TL per 1 unit) and are handled as BigInt micro units, so no float ever touches money or a rate.

import { createClient } from "./supabase";
import { parseTL, toFinanceError, type PageArg, type Paged, type ParseResult } from "./finance";

// ---------------------------------------------------------------------------
// Codes and labels (§1.2)
// ---------------------------------------------------------------------------

export type Currency = "TRY" | "EUR" | "USD" | "GBP";
export type ForeignCurrency = Exclude<Currency, "TRY">;
export type PaymentMethod = "cash" | "card" | "transfer" | "financing";
export type FxSource = "none" | "workbook" | "manual" | "entered";

export const CURRENCIES: readonly Currency[] = ["TRY", "EUR", "USD", "GBP"];
export const FOREIGN_CURRENCIES: readonly ForeignCurrency[] = ["EUR", "USD", "GBP"];
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "card", "transfer", "financing"];

export const CURRENCY_LABELS: Record<Currency, string> = {
  TRY: "TL (₺)",
  EUR: "Euro (€)",
  USD: "Dolar ($)",
  GBP: "Sterlin (£)",
};

export const CURRENCY_SYMBOLS: Record<Currency, string> = { TRY: "₺", EUR: "€", USD: "$", GBP: "£" };

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Nakit",
  card: "Kart (POS)",
  transfer: "Havale / EFT",
  financing: "Finansman (banka kredisi)",
};

export const FX_SOURCE_LABELS: Record<FxSource, string> = {
  none: "—",
  workbook: "Klinik Excel'i",
  manual: "Elle girilen kur",
  entered: "Ödeme sırasında girildi",
};

/** Old payment rows keep their status; only 'paid' rows count (§1.5). */
export const LEGACY_STATUS_LABELS: Record<string, string> = {
  pending: "Bekliyor",
  partial: "Kısmi",
  overdue: "Gecikmiş",
  cancelled: "İptal edilmiş",
};

export const PLAN_STATUS_LABELS: Record<string, string> = {
  draft: "Taslak",
  proposed: "Önerilen",
  approved: "Onaylı",
  in_progress: "Devam Ediyor",
  completed: "Tamamlandı",
  cancelled: "İptal",
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** A stored currency, or TRY for a value the UI does not know (old rows before the migration). */
export function asCurrency(value: unknown): Currency {
  return isCurrency(value) ? value : "TRY";
}

export function methodLabel(method: string | null | undefined, raw?: string | null): string {
  if (method && method in METHOD_LABELS) return METHOD_LABELS[method as PaymentMethod];
  if (raw) return `Eski kayıt: ${raw}`;
  return "—";
}

export function fxSourceLabel(source: string | null | undefined): string {
  return source && source in FX_SOURCE_LABELS ? FX_SOURCE_LABELS[source as FxSource] : source || "—";
}

// ---------------------------------------------------------------------------
// Rates: BigInt micro units (rate × 1e6)
// ---------------------------------------------------------------------------

const MICRO = 1_000_000n;
const MAX_RATE_MICRO = 1000n * MICRO;

export const RATE_ERROR = "Kur 0'dan büyük, en fazla 1000 ve en fazla 6 ondalık basamaklı olmalı.";

export type RateParse = { ok: true; micro: bigint; text: string } | { ok: false; error: string };

/**
 * "49,8765" / "49.8765" / "49" → micro units, or an error text. One separator is the decimal mark (',' or '.');
 * when both appear, '.' groups thousands ("1.000,5"). Max 6 decimals, 0 < rate ≤ 1000. `text` is the DB string.
 */
export function parseRate(raw: string): RateParse {
  let s = (raw ?? "").replace(/\s+/g, "");
  if (s === "") return { ok: false, error: "Kuru girin." };
  if (s.includes(",")) {
    if (s.includes(".")) {
      if (!/^\d{1,3}(\.\d{3})+,\d*$/.test(s)) return { ok: false, error: "Geçersiz kur. Örnek: 49,8500" };
      s = s.replace(/\./g, "");
    }
    s = s.replace(",", ".");
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { ok: false, error: "Geçersiz kur. Örnek: 49,8500" };
  const frac = m[2] ?? "";
  if (frac.length > 6) return { ok: false, error: RATE_ERROR };
  const intPart = (m[1] || "0").replace(/^0+(?=\d)/, "");
  if (intPart.length > 4) return { ok: false, error: RATE_ERROR };
  const micro = BigInt(intPart) * MICRO + BigInt(frac.padEnd(6, "0") || "0");
  if (micro <= 0n || micro > MAX_RATE_MICRO) return { ok: false, error: RATE_ERROR };
  return { ok: true, micro, text: microToText(micro) };
}

/** DB value ("49.876500", or a JSON number from a table select) → micro units; null when it is not a valid rate. */
export function rateMicro(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? numberText(value) : value;
  if (text === null) return null;
  const p = parseRate(text);
  return p.ok ? p.micro : null;
}

function numberText(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Rates have at most 6 decimals, so the shortest round-trip text is exact; toFixed(6) covers exponent forms.
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(6) : s;
}

/** 49876500n → "49.876500" (the string sent to the RPCs). */
export function microToText(micro: bigint): string {
  const s = micro.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** Editable input value: "49,8765" (at least 4 decimals, up to 6 when non-zero). */
export function microToInput(micro: bigint): string {
  return formatMicro(micro, false);
}

function formatMicro(micro: bigint, group: boolean): string {
  const text = microToText(micro);
  const [whole, frac] = text.split(".");
  const trimmed = frac.replace(/0+$/, "");
  const shown = trimmed.length > 4 ? trimmed : frac.slice(0, 4);
  const w = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : whole;
  return `${w},${shown}`;
}

/** "49,8765" (4 decimals shown; all 6 kept when the last two are non-zero). "—" for a missing rate. */
export function formatRate(value: string | number | null | undefined): string {
  const micro = rateMicro(value);
  return micro === null ? "—" : formatMicro(micro, true);
}

/** Round half up of cents × rate (positive inputs, so equal to half away from zero). Mirrors SQL round(amount*fx*100). */
export function tryCents(cents: number, micro: bigint): number {
  return Number((BigInt(cents) * micro * 2n + MICRO) / (2n * MICRO));
}

/** Round half up of TL cents / plan rate. Mirrors pp__applied_cents. */
export function appliedCents(tryC: number, planMicro: bigint): number {
  return Number((BigInt(tryC) * 2n * MICRO + planMicro) / (2n * planMicro));
}

export interface PaymentMath {
  try_cents: number;
  applied_cents: number;
}

/**
 * §3 table: the TL value and the plan-currency value of `cents` paid in `payCur` on a plan in `planCur`.
 * `fx` is the payment currency's rate (needed when payCur ≠ TRY), `planFx` the plan currency's rate (needed when
 * planCur ≠ TRY and planCur ≠ payCur; when they are equal the payment rate is used). null when a rate is missing.
 */
export function paymentMath(
  cents: number,
  payCur: Currency,
  planCur: Currency,
  fx: bigint | null,
  planFx: bigint | null
): PaymentMath | null {
  let tryC: number;
  if (payCur === "TRY") tryC = cents;
  else if (fx === null) return null;
  else tryC = tryCents(cents, fx);
  if (payCur === planCur) return { try_cents: tryC, applied_cents: cents };
  if (planCur === "TRY") return { try_cents: tryC, applied_cents: tryC };
  if (planFx === null) return null;
  return { try_cents: tryC, applied_cents: appliedCents(tryC, planFx) };
}

/** Largest amount in the payment currency whose applied value is ≤ remaining; null when rates are missing or none fits. */
export function maxPayable(
  remaining: number,
  payCur: Currency,
  planCur: Currency,
  fx: bigint | null,
  planFx: bigint | null
): number | null {
  if (remaining < 1) return null;
  const applied = (a: number) => paymentMath(a, payCur, planCur, fx, planFx)?.applied_cents ?? null;
  if (applied(1) === null) return null;
  // applied() is non-decreasing in the amount, so a binary search finds the boundary exactly.
  let lo = 0;
  let hi = MAX_AMOUNT_CENTS;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if ((applied(mid) as number) <= remaining) lo = mid;
    else hi = mid - 1;
  }
  return lo >= 1 ? lo : null;
}

// ---------------------------------------------------------------------------
// Money text
// ---------------------------------------------------------------------------

/** 1 ≤ cents ≤ 1,000,000,000,000 (fin__amount; E_AMOUNT). */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000;

/** parseTL rules with currency-neutral texts: accepts "1.234,56", "1234.56", an optional symbol or code. */
export function parseMoney(raw: string, currency: Currency, opts?: Parameters<typeof parseTL>[1]): ParseResult {
  let s = (raw ?? "").replace(/\s+/g, "");
  const marker = /^([₺€$£]|tl|try|eur|usd|gbp)|([₺€$£]|tl|try|eur|usd|gbp)$/gi;
  for (const m of s.match(marker) ?? []) {
    const code = markerCurrency(m);
    if (code !== currency) return { ok: false, error: `Tutar seçili para biriminde (${currency}) olmalı.` };
  }
  s = s.replace(marker, "");
  const r = parseTL(s, opts);
  if (r.ok) return r;
  return { ok: false, error: r.error.replace(/ TL/g, "") };
}

function markerCurrency(m: string): Currency {
  const u = m.toUpperCase();
  if (u === "€" || u === "EUR") return "EUR";
  if (u === "$" || u === "USD") return "USD";
  if (u === "£" || u === "GBP") return "GBP";
  return "TRY";
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "€1.234,56", "₺…", "$…", "£…" (formatTL style, exact for any safe integer). null → "—". */
export function formatMoney(cents: number | null | undefined, currency: Currency | string | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const cur = asCurrency(currency);
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${CURRENCY_SYMBOLS[cur]}${groupThousands(String(whole))},${frac}`;
}

/** A numeric DB amount in major units (JSON number from a table select) → integer cents. */
export function amountToCents(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Major-unit number for a numeric column write: 123456 → 1234.56 (shortest round-trip, so exact on the wire). */
export function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * The server's own Turkish text for a refused direct table write (the plan guard trigger raises P0001 texts such as
 * 'Ödeme alınmış planın para birimi değiştirilemez.'), or null for anything else (network, RLS, unknown).
 */
export function serverErrorText(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === "P0001" && typeof e.message === "string" && e.message ? e.message : null;
}

/**
 * More than 10 % away from the reference rate, decided exactly (no float): |typed − ref| × 10 > ref. Same rule as the
 * server's E_FX_RANGE, which refuses such a rate for users without owner / 'finance' rights.
 */
export function rateFarOff(typed: bigint, reference: bigint): boolean {
  if (reference <= 0n) return false;
  const d = typed > reference ? typed - reference : reference - typed;
  return d * 10n > reference;
}

/** Signed percentage difference of `typed` from `suggested`, for the client-side rate sanity check (§6.1). */
export function rateDiffPercent(typed: bigint, suggested: bigint): number {
  if (suggested <= 0n) return 0;
  return (Number(typed - suggested) / Number(suggested)) * 100;
}

// ---------------------------------------------------------------------------
// JSON shapes (§5)
// ---------------------------------------------------------------------------

export interface PaymentJson {
  id: string;
  plan_id: string;
  patient_id: string;
  paid_on: string;
  recorded_at: string | null;
  status: string;
  counts: boolean;
  currency: Currency;
  amount_cents: number;
  fx_rate: string;
  fx_rate_source: FxSource;
  fx_rate_on: string | null;
  amount_try_cents: number;
  plan_currency: Currency;
  plan_fx_rate: string;
  plan_fx_rate_source: FxSource;
  applied_plan_cents: number;
  method: PaymentMethod | null;
  method_raw: string | null;
  note: string | null;
  received_by_name: string | null;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  legacy_status: string | null;
  /** pp_patient_account only */
  plan_title?: string | null;
}

export interface CurrencyCollectedJson {
  currency: Currency;
  amount_cents: number;
  try_cents: number;
  count: number;
}

export interface PlanTotalsJson {
  applied_cents: number;
  remaining_cents: number;
  collected_try_cents: number;
  by_currency: CurrencyCollectedJson[];
  remaining_try_estimate: { cents: number; rate: string; rate_on: string; source: FxSource } | null;
  voided_count: number;
  legacy_count: number;
}

export interface PlanAccountJson {
  today: string;
  can_void: boolean;
  can_backdate: boolean;
  plan: {
    id: string;
    title: string;
    status: string;
    patient_id: string;
    patient_name: string | null;
    currency: Currency;
    total_cents: number;
    quote_fx_rate: string;
    quote_fx_on: string | null;
    quote_fx_source: FxSource;
    quote_total_try_cents: number;
  };
  totals: PlanTotalsJson;
  payments: PaymentJson[];
  truncated: boolean;
}

export interface PatientAccountPlanJson {
  id: string;
  title: string;
  status: string;
  created_at: string;
  currency: Currency;
  total_cents: number;
  quote_fx_rate: string;
  quote_total_try_cents: number;
  applied_cents: number;
  remaining_cents: number;
  collected_try_cents: number;
  last_paid_on: string | null;
}

export interface PatientAccountJson {
  today: string;
  can_void: boolean;
  patient: { id: string; full_name: string };
  by_currency: {
    currency: Currency;
    quoted_cents: number;
    applied_cents: number;
    remaining_cents: number;
    quoted_try_cents: number;
  }[];
  collected: { try_cents: number; by_currency: CurrencyCollectedJson[]; cancelled_plans_try_cents: number };
  remaining_try_estimate: {
    cents: number | null;
    rates: { currency: Currency; rate: string; rate_on: string }[];
    missing_rates: Currency[];
  };
  plans: PatientAccountPlanJson[];
  payments: PaymentJson[];
  payments_truncated: boolean;
  voided_count: number;
}

export interface FxRateJson {
  currency: ForeignCurrency;
  id: string;
  rate: string;
  rate_on: string;
  source: FxSource;
  is_on_day: boolean;
  age_days: number;
}

export interface FxRatesJson {
  as_of: string;
  today: string;
  rates: FxRateJson[];
}

export interface PaymentWriteResult {
  already_saved: boolean;
  payment: PaymentJson;
  account: PlanTotalsJson;
}

export interface RecordPaymentArgs {
  id: string;
  planId: string;
  amountCents: number;
  currency: Currency;
  method: PaymentMethod;
  /** null = today (clinic_today()); another day only for owner / finance */
  paidOn: string | null;
  /** DB string of the payment currency's rate; null for TRY */
  fxRate: string | null;
  fxRateId: string | null;
  /** DB string of the plan currency's rate; only when the plan currency is neither TRY nor the payment currency */
  planFxRate: string | null;
  planFxRateId: string | null;
  note: string | null;
}

export interface FxSaveItem {
  currency: ForeignCurrency;
  rate: string;
  rate_on: string;
  note?: string;
}

export interface FxSaveResult {
  saved: { currency: ForeignCurrency; rate_on: string; rate: string; action: "inserted" | "updated" | "unchanged" }[];
}

export type OfferStatusFilter = "open" | "active" | "cancelled" | "all";
export type OfferSort = "created_desc" | "remaining_try_desc" | "last_payment_desc";

export interface OfferFilters {
  status?: OfferStatusFilter;
  only_remaining?: boolean;
  currency?: Currency;
  query?: string;
  from_month?: string;
  to_month?: string;
  sort?: OfferSort;
}

export interface OfferRowJson {
  plan_id: string;
  plan_title: string;
  patient_id: string;
  patient_name: string;
  doctor_name: string | null;
  status: string;
  created_on: string;
  currency: Currency;
  total_cents: number;
  quote_fx_rate: string;
  quote_total_try_cents: number;
  applied_cents: number;
  remaining_cents: number;
  collected_try_cents: number;
  remaining_try_estimate_cents: number | null;
  last_paid_on: string | null;
}

export interface OfferTotalsJson {
  count: number;
  by_currency: {
    currency: Currency;
    total_cents: number;
    applied_cents: number;
    remaining_cents: number;
    quote_try_cents: number;
  }[];
  quote_try_cents: number;
  collected_try_cents: number;
  remaining_try_estimate_cents: number | null;
  rates: { currency: Currency; rate: string; rate_on: string }[];
  missing_rates: Currency[];
}

export interface OffersJson extends Partial<Paged> {
  rows: OfferRowJson[];
  totals: OfferTotalsJson;
}

export interface ReceiptsCompareDayJson {
  day: string;
  dentos_try_cents: number;
  dentos_count: number;
  dentos_by_currency: { currency: Currency; amount_cents: number }[];
  dentos_by_method: { method: PaymentMethod | null; try_cents: number }[];
  ledger_cents: number;
  ledger_workbook_cents: number;
  ledger_other_cents: number;
  diff_cents: number;
  flag: boolean;
}

export interface ReceiptsCompareJson {
  month: string;
  days: ReceiptsCompareDayJson[];
  totals: {
    dentos_try_cents: number;
    dentos_count: number;
    dentos_by_currency: { currency: Currency; amount_cents: number }[];
    dentos_by_method: { method: PaymentMethod | null; try_cents: number }[];
    ledger_cents: number;
    diff_cents: number;
    flagged_days: number;
  };
}

export interface FxHistoryJson {
  rows: {
    id: string;
    currency: ForeignCurrency;
    rate: string;
    rate_on: string;
    source: FxSource;
    source_file: string | null;
    note: string | null;
    updated_by_name: string | null;
    updated_at: string;
  }[];
  total: number;
}

// ---------------------------------------------------------------------------
// RPC wrappers (§4.2). Errors arrive as FinanceError with the server's Turkish text.
// ---------------------------------------------------------------------------

let client: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await sb().rpc(name, args);
  } catch (err) {
    throw toFinanceError(err);
  }
  if (result.error) throw toFinanceError(result.error);
  return result.data as T;
}

export function ppRecordPayment(a: RecordPaymentArgs) {
  return rpc<PaymentWriteResult>("pp_record_payment", {
    p_id: a.id,
    p_plan_id: a.planId,
    p_amount_cents: a.amountCents,
    p_currency: a.currency,
    p_method: a.method,
    p_paid_on: a.paidOn,
    p_fx_rate: a.fxRate,
    p_fx_rate_id: a.fxRateId,
    p_plan_fx_rate: a.planFxRate,
    p_plan_fx_rate_id: a.planFxRateId,
    p_note: a.note,
  });
}

export function ppVoidPayment(id: string, reason: string) {
  return rpc<PaymentWriteResult>("pp_void_payment", { p_id: id, p_reason: reason });
}

/** Latest known rate per currency on or before `on` (null = today). */
export function ppFxRates(on: string | null) {
  return rpc<FxRatesJson>("pp_fx_rates", { p_on: on });
}

/** Owner or 'finance' only (E_FX_ROLE). */
export function ppFxSaveRates(items: FxSaveItem[], source: "manual" | "workbook", file: string | null) {
  return rpc<FxSaveResult>("pp_fx_save_rates", { p_items: items, p_source: source, p_file: file });
}

export function ppPlanAccount(planId: string) {
  return rpc<PlanAccountJson>("pp_plan_account", { p_plan_id: planId });
}

export function ppPatientAccount(patientId: string, includeVoided: boolean) {
  return rpc<PatientAccountJson>("pp_patient_account", {
    p_patient_id: patientId,
    p_include_voided: includeVoided,
  });
}

/** Only set keys are sent; an unknown key or bad value → E_FILTER. */
export function finPatientOffers(filters: OfferFilters, page: PageArg) {
  const f: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    f[k] = v;
  }
  return rpc<OffersJson>("fin_patient_offers", { p_filters: f, p_page: page });
}

/** p_month 'YYYY-MM'; null = current month. Read-only (owner decision 1). */
export function finPatientReceiptsCompare(month: string | null) {
  return rpc<ReceiptsCompareJson>("fin_patient_receipts_compare", { p_month: month });
}

export function finFxHistory(currency: ForeignCurrency | null, page: PageArg) {
  return rpc<FxHistoryJson>("fin_fx_history", { p_currency: currency, p_page: page });
}
