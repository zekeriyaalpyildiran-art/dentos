// Stock overview ("Stok özeti", owner screen): groups, per-card value, attention list and period summaries.
// Pure (no React, no network). Value follows stock_dashboard: every balance > 0 at its lot cost, expired stock
// included, a lot without a cost row is "fiyatsız" and adds nothing. "Critical" is the database predicate (§1.7), so a
// ready card with MIN/MAX and no stock at all is critical too (state 'out' on the Stok kartları list).

import { addDays, daysLeft } from "./expiry";
import type { ConsumptionRow } from "./rpc";

// ---------------------------------------------------------------------------
// Groups. Card categories are free text (Genel, Endo, Endodonti, ...), so the overview groups by product name first.
// ---------------------------------------------------------------------------

export const OTHER_GROUP = "Diğer";

/** First match wins; tested against the lower-cased "name category" text with ı folded to i ("Matrıces", "INJECTION"). */
const GROUP_RULES: { group: string; re: RegExp }[] = [
  { group: "İmplant ve parçaları", re: /neodent|medentika|\bimp\b|implant(?!.*örtü)|gingiva|scanbody/ },
  { group: "Greft ve membran", re: /greft|kemik|smartbone|maxxeus|mebran|membran|bio-barrier/ },
  { group: "Beyazlatma", re: /opalescence|beyazlat|bleach/ },
  {
    group: "Endodonti",
    re: /gutta|paper|eğe|ege\b|kanal|irigasyon|irrigasyon|edta|hipo|klorheksidin|mta|kalsin|lentilo|post frez|iodoform|endo|oksojen|oksijen/,
  },
  { group: "Anestezi ve enjektör", re: /ultracain|lincaine|dentacaine|karpül|enjektör|insülin/ },
  { group: "Cerrahi sarf", re: /sütur|sutur|suture|bistüri|hemostatik|örtü seti|sakşin|surgi|alveo/ },
  {
    group: "Eldiven ve hijyen",
    re: /eldiven|nitril|lateks|maske|mask\b|önlü|dezenfektan|alkol|otoklav|tabla|atik|kilif|pamuk/,
  },
  {
    group: "Restoratif",
    re: /kompozit|komp\b|bond|aenial|tetric|clearfil|gradia|flo|akişkan|kompomer|kompemar|fissür|dycal|theracal|cavit|e-temp|jade|asit|matr|band|kama|polisaj|sof-lex|soflex|disk|essentia|ivoclar|palodent|applicator|frez|alev|lobut/,
  },
  {
    group: "Protez ve ölçü",
    re: /meron|alçi|zetaplus|elite|oclufast|wax|mum|ölçü|artikülasyon|cavex|temp|injection|siman|protez|dental dam|duradam|teflon/,
  },
];

export const IMPLANT_GROUP = GROUP_RULES[0].group;

export function stockGroup(itemName: string | null | undefined, category: string | null | undefined): string {
  const text = `${itemName ?? ""} ${category ?? ""}`.toLocaleLowerCase("tr").replace(/ı/g, "i");
  for (const rule of GROUP_RULES) if (rule.re.test(text)) return rule.group;
  return OTHER_GROUP;
}

// ---------------------------------------------------------------------------
// Cards with their balances
// ---------------------------------------------------------------------------

export interface OverviewItem {
  id: string;
  item_code: string;
  item_name: string;
  category: string | null;
  usage_unit: string;
  min_qty: number | string;
  max_qty: number | string;
  is_active: boolean;
  needs_review: boolean;
}

export interface OverviewBalance {
  stock_item_id: string;
  batch_id: string;
  quantity: number | string;
}

export interface OverviewBatch {
  id: string;
  stock_item_id: string;
  expiry_date: string | null;
  received_at: string;
}

export interface OverviewCost {
  batch_id: string;
  unit_cost_cents: number | string;
}

export interface OverviewRow {
  id: string;
  code: string;
  name: string;
  group: string;
  unit: string;
  qty: number;
  usableQty: number;
  /** Quantity on expired lots (still in qty and in the value). */
  expiredQty: number;
  minQty: number;
  valueCents: number;
  /** Quantity on lots without a cost row (not in valueCents). */
  unpricedQty: number;
  nextExpiry: string | null;
  /** Quantity on the lots that expire on nextExpiry. */
  nextExpiryQty: number;
  daysToExpiry: number | null;
  /** is_active AND NOT needs_review AND max > 0 AND usable <= min (stock__item_rows). */
  critical: boolean;
  active: boolean;
}

/**
 * Cards that hold stock (any balance > 0) plus critical cards with none, most valuable first. Lists of what is in
 * stock (values, groups, top cards) take `inStock` rows only.
 */
export function buildStockRows(
  items: OverviewItem[],
  balances: OverviewBalance[],
  batches: OverviewBatch[],
  costs: OverviewCost[],
  today: string
): OverviewRow[] {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const costByBatch = new Map(costs.map((c) => [c.batch_id, Number(c.unit_cost_cents)]));
  const acc = new Map<
    string,
    { qty: number; usable: number; value: number; unpriced: number; expiry: string | null; expiryQty: number }
  >();
  for (const b of balances) {
    const q = Number(b.quantity);
    if (!(q > 0)) continue;
    const a = acc.get(b.stock_item_id) ?? { qty: 0, usable: 0, value: 0, unpriced: 0, expiry: null, expiryQty: 0 };
    const expiry = batchById.get(b.batch_id)?.expiry_date ?? null;
    a.qty += q;
    if (!expiry || expiry >= today) a.usable += q;
    if (expiry && (!a.expiry || expiry < a.expiry)) {
      a.expiry = expiry;
      a.expiryQty = q;
    } else if (expiry && expiry === a.expiry) {
      a.expiryQty += q;
    }
    const cost = costByBatch.get(b.batch_id);
    if (cost === undefined) a.unpriced += q;
    else a.value += q * cost;
    acc.set(b.stock_item_id, a);
  }
  const rows: OverviewRow[] = [];
  for (const it of items) {
    const minQty = Number(it.min_qty) || 0;
    const maxQty = Number(it.max_qty) || 0;
    const a = acc.get(it.id) ?? { qty: 0, usable: 0, value: 0, unpriced: 0, expiry: null, expiryQty: 0 };
    const critical = it.is_active && !it.needs_review && maxQty > 0 && round4(a.usable) <= minQty;
    if (!(a.qty > 0) && !critical) continue;
    rows.push({
      id: it.id,
      code: it.item_code,
      name: it.item_name.trim(),
      group: stockGroup(it.item_name, it.category),
      unit: it.usage_unit ?? "",
      qty: round4(a.qty),
      usableQty: round4(a.usable),
      expiredQty: round4(a.qty - a.usable),
      minQty,
      valueCents: Math.round(a.value),
      unpricedQty: round4(a.unpriced),
      nextExpiry: a.expiry,
      nextExpiryQty: round4(a.expiryQty),
      daysToExpiry: a.expiry ? daysLeft(a.expiry, today) : null,
      critical,
      active: it.is_active,
    });
  }
  return rows.sort(
    (x, y) => y.valueCents - x.valueCents || Number(y.qty > 0) - Number(x.qty > 0) || x.name.localeCompare(y.name, "tr")
  );
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export interface GroupTotal {
  group: string;
  valueCents: number;
  items: number;
  unpricedItems: number;
}

export const inStock = (r: OverviewRow) => r.qty > 0;

export function groupTotals(rows: OverviewRow[]): GroupTotal[] {
  const by = new Map<string, GroupTotal>();
  for (const r of rows.filter(inStock)) {
    const g = by.get(r.group) ?? { group: r.group, valueCents: 0, items: 0, unpricedItems: 0 };
    g.valueCents += r.valueCents;
    g.items += 1;
    if (r.unpricedQty > 0) g.unpricedItems += 1;
    by.set(r.group, g);
  }
  return Array.from(by.values()).sort((a, b) => b.valueCents - a.valueCents || a.group.localeCompare(b.group, "tr"));
}

export interface StockSummary {
  valueCents: number;
  implantValueCents: number;
  /** Cards holding stock. */
  items: number;
  unpricedItems: number;
  /** Critical cards, the ones with no stock at all included (same count as the Stok kartları badge). */
  criticalItems: number;
  /** Cards whose earliest lot in stock expires within `days` (expired included). */
  expiringItems: number;
}

export function stockSummary(rows: OverviewRow[], days = 90): StockSummary {
  let valueCents = 0;
  let implantValueCents = 0;
  let unpricedItems = 0;
  let criticalItems = 0;
  let expiringItems = 0;
  for (const r of rows) {
    valueCents += r.valueCents;
    if (r.group === IMPLANT_GROUP) implantValueCents += r.valueCents;
    if (r.unpricedQty > 0) unpricedItems += 1;
    if (r.critical) criticalItems += 1;
    if (r.daysToExpiry !== null && r.daysToExpiry <= days) expiringItems += 1;
  }
  const items = rows.filter(inStock).length;
  return { valueCents, implantValueCents, items, unpricedItems, criticalItems, expiringItems };
}

export type ExpiryState = "expired" | "expiry30" | "expiry90";
export type LevelState = "out" | "critical";

export const ATTENTION_LABELS: Record<ExpiryState | LevelState, string> = {
  expired: "Tarihi geçti",
  expiry30: "Tarihi 30 gün içinde",
  expiry90: "Tarihi 90 gün içinde",
  out: "Stokta yok",
  critical: "Kritik seviyede",
};

export interface AttentionRow extends OverviewRow {
  expiryState: ExpiryState | null;
  levelState: LevelState | null;
}

/**
 * Cards expiring within `days` (expired included) and critical cards: nearest expiry first, then the cards with no
 * usable stock, then the other critical ones, each by name.
 */
export function attentionRows(rows: OverviewRow[], days = 90): AttentionRow[] {
  const out: AttentionRow[] = [];
  for (const r of rows) {
    const d = r.daysToExpiry;
    const expiryState: ExpiryState | null =
      d === null || d > days ? null : d < 0 ? "expired" : d <= 30 ? "expiry30" : "expiry90";
    const levelState: LevelState | null = !r.critical ? null : r.usableQty > 0 ? "critical" : "out";
    if (expiryState || levelState) out.push({ ...r, expiryState, levelState });
  }
  const key = (r: AttentionRow) =>
    r.expiryState ? r.daysToExpiry! : r.levelState === "out" ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name, "tr"));
}

// ---------------------------------------------------------------------------
// Period summaries from stock_consumption_report rows (corrections already resolved in SQL)
// ---------------------------------------------------------------------------

export interface GroupMovement {
  group: string;
  /** Net use (issues minus returns) at lot cost. */
  usedCents: number;
  wasteCents: number;
  /** Cards whose count difference is negative / positive, at lot cost. */
  countLossCents: number;
  countGainCents: number;
}

export function groupMovements(rows: ConsumptionRow[]): GroupMovement[] {
  const by = new Map<string, GroupMovement>();
  for (const r of rows) {
    const group = stockGroup(r.item_name, r.category);
    const g = by.get(group) ?? { group, usedCents: 0, wasteCents: 0, countLossCents: 0, countGainCents: 0 };
    g.usedCents += Number(r.net_used_cost_cents) || 0;
    g.wasteCents += Number(r.waste_cost_cents) || 0;
    const adj = Number(r.adjust_net_cost_cents) || 0;
    if (adj < 0) g.countLossCents += -adj;
    else g.countGainCents += adj;
    by.set(group, g);
  }
  return Array.from(by.values())
    .filter((g) => g.usedCents || g.wasteCents || g.countLossCents || g.countGainCents)
    .sort(
      (a, b) =>
        b.usedCents + b.wasteCents + b.countLossCents - (a.usedCents + a.wasteCents + a.countLossCents) ||
        a.group.localeCompare(b.group, "tr")
    );
}

export interface CountDiffRow {
  id: string;
  code: string;
  name: string;
  group: string;
  unit: string;
  qty: number;
  /** null: no cost key (no cost permission) or every row of the card unpriced (the report then sends 0). */
  costCents: number | null;
  /** Some of the card's rows in the period have no lot cost, so costCents may be short. */
  partlyUnpriced: boolean;
}

/** Cards with a count difference in the period, biggest loss first (cost first, then quantity when unpriced). */
export function countDiffRows(rows: ConsumptionRow[]): CountDiffRow[] {
  return rows
    .filter((r) => Number(r.adjust_net_qty) !== 0)
    .map((r) => {
      const uncosted = Number(r.uncosted_rows) > 0;
      const cost = r.adjust_net_cost_cents === undefined || r.adjust_net_cost_cents === null ? null : Number(r.adjust_net_cost_cents);
      return {
        id: r.stock_item_id,
        code: r.item_code,
        name: r.item_name.trim(),
        group: stockGroup(r.item_name, r.category),
        unit: r.usage_unit,
        qty: Number(r.adjust_net_qty),
        costCents: cost === null || (cost === 0 && uncosted) ? null : cost,
        partlyUnpriced: uncosted && cost !== null && cost !== 0,
      };
    })
    .sort((a, b) => (a.costCents ?? 0) - (b.costCents ?? 0) || a.qty - b.qty || a.name.localeCompare(b.name, "tr"));
}

/** Whether the period has stock leaving it (use, waste or count difference), priced or not. */
export function hasOutflow(rows: ConsumptionRow[]): boolean {
  return rows.some((r) => Number(r.net_used_qty) !== 0 || Number(r.waste_qty) !== 0 || Number(r.adjust_net_qty) !== 0);
}

// ---------------------------------------------------------------------------
// Lot price changes
// ---------------------------------------------------------------------------

export interface PriceChange {
  id: string;
  code: string;
  name: string;
  unit: string;
  firstDay: string;
  firstCents: number;
  lastDay: string;
  lastCents: number;
  /** (last - first) / first; null when the first price is 0. */
  change: number | null;
}

/** Cards whose latest lot cost differs from their earliest one (lots ordered by receipt time). */
export function priceChanges(items: OverviewItem[], batches: OverviewBatch[], costs: OverviewCost[]): PriceChange[] {
  const costByBatch = new Map(costs.map((c) => [c.batch_id, Number(c.unit_cost_cents)]));
  const lots = new Map<string, { at: string; cents: number }[]>();
  for (const b of batches) {
    const cents = costByBatch.get(b.id);
    if (cents === undefined) continue;
    const list = lots.get(b.stock_item_id) ?? [];
    list.push({ at: b.received_at, cents });
    lots.set(b.stock_item_id, list);
  }
  const out: PriceChange[] = [];
  for (const it of items) {
    const list = lots.get(it.id);
    if (!list || list.length < 2) continue;
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const first = list[0];
    const last = list[list.length - 1];
    if (first.cents === last.cents) continue;
    out.push({
      id: it.id,
      code: it.item_code,
      name: it.item_name.trim(),
      unit: it.usage_unit ?? "",
      firstDay: first.at.slice(0, 10),
      firstCents: first.cents,
      lastDay: last.at.slice(0, 10),
      lastCents: last.cents,
      change: first.cents > 0 ? (last.cents - first.cents) / first.cents : null,
    });
  }
  return out.sort((a, b) => (b.change ?? Infinity) - (a.change ?? Infinity) || a.name.localeCompare(b.name, "tr"));
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export type PeriodKey = "30d" | "month" | "prev_month" | "90d";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "30d": "Son 30 gün",
  month: "Bu ay",
  prev_month: "Geçen ay",
  "90d": "Son 90 gün",
};

export function periodRange(key: PeriodKey, today: string): { from: string; to: string } {
  const monthStart = `${today.slice(0, 8)}01`;
  if (key === "month") return { from: monthStart, to: today };
  if (key === "prev_month") {
    const prevEnd = addDays(monthStart, -1);
    return { from: `${prevEnd.slice(0, 8)}01`, to: prevEnd };
  }
  return { from: addDays(today, key === "90d" ? -89 : -29), to: today };
}

/** The last `count` calendar months ending with today's month, oldest first; the current month ends today. */
export function monthRanges(today: string, count: number): { month: string; from: string; to: string }[] {
  const out: { month: string; from: string; to: string }[] = [];
  let start = `${today.slice(0, 8)}01`;
  let end = today;
  for (let i = 0; i < count; i++) {
    out.unshift({ month: start.slice(0, 7), from: start, to: end });
    end = addDays(start, -1);
    start = `${end.slice(0, 8)}01`;
  }
  return out;
}
