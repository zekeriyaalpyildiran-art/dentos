// Realistic day-by-day cash projection for 'Yaklaşan plan'. The plan's own figure counts only the open planned
// entries, so it showed e.g. −200.928 TL on 06.11.2026 while the clinic kept collecting every day and two Burgan
// loans were due to unblock. This adds (1) the expected Burgan releases and (2) a daily net operating flow estimated
// from recent months, and walks the balance day by day. Pure: the page fetches the data and shows the result.

import type { CategoryReportRow, Direction, ReportBucket } from "./finance";

/** Inflows counted in the daily estimate (patient receipts and other income). */
export const ESTIMATE_IN_BUCKETS: readonly ReportBucket[] = ["patient_receipts", "other_income"];

/**
 * Day-to-day outflows counted in the daily estimate. Left out on purpose: rent, tax / SGK and loan principal (they
 * are entered as planned debts and appear in the plan list, so counting them here would count them twice), partner
 * distributions and asset purchases (irregular), and capital movements.
 */
export const ESTIMATE_OUT_BUCKETS: readonly ReportBucket[] = ["doctor", "lab", "supplies", "personnel", "other_expense", "fees"];

export type EstimatePeriod = {
  /** calendar days the period covers */
  days: number;
  rows: readonly Pick<CategoryReportRow, "report_bucket" | "incoming_cents" | "outgoing_cents">[];
  /** Burgan loans of the period: their gross is in the clinic-Excel receipts but arrives blocked (released apart) */
  financingGrossCents: number;
  /** the bank's fees on those loans: booked as expenses, taken from the loan, not from the bank or the till */
  financingFeeCents: number;
};

export type DailyEstimate = {
  dailyNetCents: number;
  receiptsCents: number;
  operatingOutCents: number;
  days: number;
};

/** Average daily net flow (receipts − day-to-day outflows) over the periods, Burgan loans and fees taken out. */
export function dailyNetEstimate(periods: readonly EstimatePeriod[]): DailyEstimate {
  let receipts = 0;
  let out = 0;
  let days = 0;
  for (const p of periods) {
    if (p.days <= 0) continue;
    days += p.days;
    let r = 0;
    let o = 0;
    for (const row of p.rows) {
      if (ESTIMATE_IN_BUCKETS.includes(row.report_bucket)) r += row.incoming_cents;
      if (ESTIMATE_OUT_BUCKETS.includes(row.report_bucket)) o += row.outgoing_cents;
    }
    receipts += Math.max(r - p.financingGrossCents, 0);
    out += Math.max(o - p.financingFeeCents, 0);
  }
  return {
    dailyNetCents: days > 0 ? Math.round((receipts - out) / days) : 0,
    receiptsCents: receipts,
    operatingOutCents: out,
    days,
  };
}

/** 'YYYY-MM-DD' plus n calendar days (UTC arithmetic, no time zone drift). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/** Saturday and Sunday move to the next Monday (the bank pays out on business days). */
export function businessDayOnOrAfter(day: string): string {
  const w = weekday(day);
  return w === 6 ? addDays(day, 2) : w === 0 ? addDays(day, 1) : day;
}

export type PlanItem = { due_date: string; direction: Direction; outstanding_cents: number };
export type ReleaseItem = { id: string; name: string; expected_release: string | null; net_cents: number };

export type PlacedRelease = ReleaseItem & {
  /** the day the projection counts it (overdue → today; weekend → Monday) */
  day: string;
  /** the expected release day has passed and it is not confirmed yet: check the bank */
  overdue: boolean;
};

export type ProjectionDay = {
  day: string;
  planOutCents: number;
  planInCents: number;
  burganCents: number;
  estimateCents: number;
  balanceCents: number;
};

export type Projection = {
  days: ProjectionDay[];
  releases: PlacedRelease[];
  /** the lowest end-of-day balance in the window */
  min: { day: string; balanceCents: number } | null;
  /** end of the window */
  endBalanceCents: number;
};

/**
 * Walks today … windowEnd. Day balance = previous balance − planned outflows + planned inflows + Burgan releases +
 * the daily estimate (from tomorrow on; today's collections are already in the last balance or still to come in the
 * till). Overdue open entries count on today, as in the plan list. Releases without an expected day are left out.
 */
export function buildProjection(input: {
  today: string;
  windowEnd: string;
  startCents: number;
  plan: readonly PlanItem[];
  releases: readonly ReleaseItem[];
  dailyNetCents: number;
}): Projection {
  const { today, windowEnd } = input;
  const releases: PlacedRelease[] = [];
  for (const r of input.releases) {
    if (!r.expected_release) continue;
    const overdue = r.expected_release < today;
    const day = businessDayOnOrAfter(overdue ? today : r.expected_release);
    if (day > windowEnd) continue;
    releases.push({ ...r, day, overdue });
  }
  releases.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const days: ProjectionDay[] = [];
  let balance = input.startCents;
  let min: Projection["min"] = null;
  for (let day = today, i = 0; day <= windowEnd && i < 400; day = addDays(day, 1), i++) {
    const onDay = (due: string) => (due < today ? today : due) === day;
    const planOut = input.plan.filter((p) => p.direction === "out" && onDay(p.due_date)).reduce((n, p) => n + p.outstanding_cents, 0);
    const planIn = input.plan.filter((p) => p.direction === "in" && onDay(p.due_date)).reduce((n, p) => n + p.outstanding_cents, 0);
    const burgan = releases.filter((r) => r.day === day).reduce((n, r) => n + r.net_cents, 0);
    const estimate = day > today ? input.dailyNetCents : 0;
    balance += planIn - planOut + burgan + estimate;
    days.push({ day, planOutCents: planOut, planInCents: planIn, burganCents: burgan, estimateCents: estimate, balanceCents: balance });
    if (!min || balance < min.balanceCents) min = { day, balanceCents: balance };
  }
  return { days, releases, min, endBalanceCents: balance };
}

/** Days of a 'YYYY-MM' month, and of the current month up to `today` (inclusive). */
export function monthDays(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const previousMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
