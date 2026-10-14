// Phase 3 report data: everything the PDFs and the accountant CSV need, read only from the Phase 1 read RPCs
// (fin_list, fin_forecast, fin_counterparty_ledger, fin_balance_history, fin_entry_detail, fin_reference_data) and
// the read-only SELECT policies on fin_payments and fin_entries (id, due_date only) of the caller's clinic
// (finance / finance_readonly, p2 §2.4).
// No money is computed here: amounts are passed through exactly as the server returns them.

import { createClient } from "./supabase";
import {
  FinanceError,
  finBalanceHistory,
  finCounterpartyLedger,
  finEntryDetail,
  finForecast,
  finList,
  toFinanceError,
  type EntryJson,
  type ForecastJson,
  type LedgerRowJson,
  type ReferenceData,
  type SnapshotJson,
} from "./finance";

/** fin_list / fin_forecast / ledger / history accept at most 200 rows per call (fin__page). */
const RPC_PAGE = 200;
/** PostgREST returns at most 1000 rows per request; direct table reads page below that cap. */
const TABLE_PAGE = 1000;

export type ProgressFn = (text: string) => void;

let client: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!client) client = createClient();
  return client;
}

const CHANGED_MESSAGE = "Kayıtlar rapor hazırlanırken değişti. Lütfen tekrar deneyin.";

/**
 * Reads every page of a paged RPC (offset / limit). Rows are de-duplicated by key, because offset paging shifts
 * when another finance user adds or edits a record between two pages. If the de-duplicated count then differs
 * from the last page's total_count (a row was skipped or added), the whole read is retried once, then it fails
 * instead of producing an incomplete report.
 */
async function pageAll<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ rows: T[]; total_count: number }>,
  key: (row: T) => string,
  label: string,
  onProgress?: ProgressFn
): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const seen = new Map<string, T>();
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await fetchPage(offset, RPC_PAGE);
      total = Number(page.total_count);
      for (const row of page.rows) {
        const k = key(row);
        if (!seen.has(k)) seen.set(k, row);
      }
      onProgress?.(`${label}: ${seen.size.toLocaleString("tr-TR")} / ${total.toLocaleString("tr-TR")}`);
      if (page.rows.length < RPC_PAGE || offset + page.rows.length >= total) break;
      offset += RPC_PAGE;
    }
    if (seen.size === total) return Array.from(seen.values());
    if (attempt >= 1) throw new FinanceError(CHANGED_MESSAGE, null, null);
  }
}

const byId = (row: { id: string }) => row.id;
const ledgerKey = (row: LedgerRowJson) =>
  row.counterparty_id ? "id:" + row.counterparty_id : "text:" + (row.counterparty_text ?? row.name);

/** Number of entries the full PDF will list (all dates, all statuses), from one light fin_list call. */
export async function countAllEntries(): Promise<number> {
  const page = await finList({}, { offset: 0, limit: 1 });
  return Number(page.total_count);
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

/** fin_settings.report_brand_name, else clinics.name (RLS: the caller's own clinic), else a neutral word. */
export async function loadBrandName(reference: ReferenceData | null, clinicId: string | null | undefined): Promise<string> {
  const fromSettings = reference?.settings.report_brand_name?.trim();
  if (fromSettings) return fromSettings;
  if (clinicId) {
    try {
      const { data } = await sb().from("clinics").select("name").eq("id", clinicId).maybeSingle();
      const name = typeof data?.name === "string" ? data.name.trim() : "";
      if (name) return name;
    } catch {
      // fall through to the neutral name
    }
  }
  return "Klinik";
}

// ---------------------------------------------------------------------------
// Payments (direct SELECT, keyset-paged by id under the 1000-row cap)
// ---------------------------------------------------------------------------

export interface RawPayment {
  id: string;
  entry_id: string;
  paid_on: string;
  amount_cents: number;
  account_id: string;
  voided_at: string | null;
  void_reason: string | null;
}

const PAYMENT_COLUMNS = "id, entry_id, paid_on, amount_cents, account_id, voided_at, void_reason";

/** Every payment of the clinic (voided ones included), optionally limited to paid_on in [from, toExclusive). */
export async function readPayments(
  clinicId: string,
  range: { from: string; toExclusive: string } | null,
  onProgress?: ProgressFn
): Promise<RawPayment[]> {
  const rows: RawPayment[] = [];
  let last: string | null = null;
  for (;;) {
    let q = sb()
      .from("fin_payments")
      .select(PAYMENT_COLUMNS)
      .eq("clinic_id", clinicId)
      .order("id", { ascending: true })
      .limit(TABLE_PAGE);
    if (range) q = q.gte("paid_on", range.from).lt("paid_on", range.toExclusive);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw toFinanceError(error);
    const page = (data ?? []) as unknown as RawPayment[];
    for (const p of page) rows.push({ ...p, amount_cents: Number(p.amount_cents) });
    onProgress?.(`Ödemeler: ${rows.length.toLocaleString("tr-TR")}`);
    // Stop only on an empty page: a hosted project's PostgREST max_rows may be below TABLE_PAGE, and a short page
    // must not be taken as the last one (keyset paging makes the extra request cheap).
    if (page.length === 0) break;
    last = page[page.length - 1].id;
  }
  return rows;
}

function groupByEntry(payments: RawPayment[]): Map<string, RawPayment[]> {
  const map = new Map<string, RawPayment[]>();
  for (const p of payments) {
    const list = map.get(p.entry_id);
    if (list) list.push(p);
    else map.set(p.entry_id, [p]);
  }
  map.forEach((list) => list.sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.id.localeCompare(b.id)));
  return map;
}

// ---------------------------------------------------------------------------
// Full PDF data
// ---------------------------------------------------------------------------

export interface FullReportExtra {
  /** every entry, every status and date, in fin_list order (due date, created) */
  entries: EntryJson[];
  paymentsByEntry: Map<string, RawPayment[]>;
  forecast: { rows: EntryJson[]; today: string; window_end: string; forecast_days: number };
  ledger: LedgerRowJson[];
  balances: SnapshotJson[];
}

export async function loadFullReportExtra(clinicId: string, onProgress?: ProgressFn): Promise<FullReportExtra> {
  const entries = await pageAll(
    (offset, limit) => finList({}, { offset, limit }),
    byId,
    "Kayıtlar",
    onProgress
  );
  const payments = await readPayments(clinicId, null, onProgress);

  let forecastHead: Pick<ForecastJson, "today" | "window_end" | "forecast_days"> | null = null;
  const forecastRows = await pageAll(
    async (offset, limit) => {
      const page = await finForecast(offset, limit);
      if (!forecastHead) forecastHead = page;
      return page;
    },
    byId,
    "Yaklaşan plan",
    onProgress
  );
  const head = forecastHead as Pick<ForecastJson, "today" | "window_end" | "forecast_days"> | null;

  const ledger = await pageAll(
    (offset, limit) => finCounterpartyLedger(null, false, offset, limit),
    ledgerKey,
    "Cariler",
    onProgress
  );
  const balances = await pageAll(
    (offset, limit) => finBalanceHistory(offset, limit),
    byId,
    "Bakiye geçmişi",
    onProgress
  );

  return {
    entries,
    paymentsByEntry: groupByEntry(payments),
    forecast: {
      rows: forecastRows,
      today: head?.today ?? "",
      window_end: head?.window_end ?? "",
      forecast_days: head?.forecast_days ?? 0,
    },
    ledger,
    balances,
  };
}

// ---------------------------------------------------------------------------
// Accountant CSV data for one month
// ---------------------------------------------------------------------------

export function monthBounds(month: string): { first: string; last: string; nextFirst: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return {
    first: `${month}-01`,
    last: `${month}-${String(days).padStart(2, "0")}`,
    nextFirst: `${ny}-${String(nm).padStart(2, "0")}-01`,
  };
}

export interface MonthEntry {
  entry: EntryJson;
  dueInMonth: boolean;
  paidInMonth: boolean;
}

export interface MonthExport {
  month: string;
  entries: MonthEntry[];
  /** payments with paid_on in the month, voided ones included */
  payments: RawPayment[];
  entryById: Map<string, EntryJson>;
}

/** Runs async jobs with a small concurrency limit. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** ids per IN (...) filter; keeps the request URL short. */
const ID_CHUNK = 100;

/**
 * EntryJson for entries due in other months (payments of this month on older / later entries). Their due dates
 * are read from the fin_entries SELECT policy (finance / finance_readonly), then each distinct due month is read
 * once with the paged fin_list, so the server still builds every EntryJson. A month that only holds one or two of
 * the needed entries, or an entry whose due date moved in between, is read with fin_entry_detail instead.
 */
async function loadEntriesElsewhere(ids: string[], onProgress?: ProgressFn): Promise<EntryJson[]> {
  if (!ids.length) return [];
  const dueById = new Map<string, string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await sb()
      .from("fin_entries")
      .select("id, due_date")
      .in("id", ids.slice(i, i + ID_CHUNK));
    if (error) throw toFinanceError(error);
    for (const r of (data ?? []) as { id: string; due_date: string }[]) dueById.set(r.id, r.due_date);
  }

  const byMonth = new Map<string, string[]>();
  const single: string[] = [];
  for (const id of ids) {
    const due = dueById.get(id);
    if (!due) {
      single.push(id);
      continue;
    }
    const m = due.slice(0, 7);
    const list = byMonth.get(m);
    if (list) list.push(id);
    else byMonth.set(m, [id]);
  }

  const found = new Map<string, EntryJson>();
  const months = Array.from(byMonth.keys()).sort();
  let doneMonths = 0;
  for (const m of months) {
    const wanted = byMonth.get(m)!;
    if (wanted.length <= 2) {
      single.push(...wanted);
      continue;
    }
    const need = new Set(wanted);
    const b = monthBounds(m);
    const rows = await pageAll(
      (offset, limit) => finList({ date_from: b.first, date_to: b.last }, { offset, limit }),
      byId,
      `Diğer aylara ait kayıtlar (${++doneMonths} / ${months.length} ay)`,
      onProgress
    );
    for (const e of rows) if (need.has(e.id)) found.set(e.id, e);
    for (const id of wanted) if (!found.has(id)) single.push(id);
  }

  let done = 0;
  const details = await mapLimited(single, 4, async (id) => {
    const detail = await finEntryDetail(id);
    done += 1;
    onProgress?.(`Diğer aylara ait kayıtlar: ${done} / ${single.length}`);
    return detail.entry;
  });
  for (const e of details) found.set(e.id, e);
  return ids.map((id) => found.get(id)).filter((e): e is EntryJson => !!e);
}

export async function loadMonthExport(clinicId: string, month: string, onProgress?: ProgressFn): Promise<MonthExport> {
  const b = monthBounds(month);
  const due = await pageAll(
    (offset, limit) => finList({ date_from: b.first, date_to: b.last }, { offset, limit }),
    byId,
    "Ay içi vadeli kayıtlar",
    onProgress
  );
  const payments = await readPayments(clinicId, { from: b.first, toExclusive: b.nextFirst }, onProgress);
  payments.sort((x, y) => x.paid_on.localeCompare(y.paid_on) || x.id.localeCompare(y.id));

  const entryById = new Map<string, EntryJson>(due.map((e) => [e.id, e]));
  const missing = Array.from(new Set(payments.map((p) => p.entry_id))).filter((id) => !entryById.has(id));
  for (const e of await loadEntriesElsewhere(missing, onProgress)) entryById.set(e.id, e);

  const paidIds = new Set(payments.map((p) => p.entry_id));
  const dueIds = new Set(due.map((e) => e.id));
  const entries: MonthEntry[] = Array.from(entryById.values())
    .sort(
      (a, c) =>
        a.due_date.localeCompare(c.due_date) || a.created_at.localeCompare(c.created_at) || a.id.localeCompare(c.id)
    )
    .map((entry) => ({ entry, dueInMonth: dueIds.has(entry.id), paidInMonth: paidIds.has(entry.id) }));

  return { month, entries, payments, entryById };
}
