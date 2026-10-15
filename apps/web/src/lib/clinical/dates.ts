// Calendar days for the clinical screens (spec p9_clinical §7.0). "Today" is the Istanbul day (CW:13). Days are
// 'YYYY-MM-DD' strings and are never parsed through UTC. Own copy, so lib/stock (another workflow) is not imported.

const ISTANBUL = "Europe/Istanbul";
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function istanbulToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: ISTANBUL }).format(new Date());
}

/** A real calendar day 'YYYY-MM-DD' (years 2000-2200, same window as the server's clin__day). */
export function isDay(value: string | null | undefined): boolean {
  const m = DAY_RE.exec(value ?? "");
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Adds calendar months; a day past the target month's end is clamped to its last day (31 → 28/29/30). */
export function addMonths(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const d = Math.min(Number(m[3]), daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(d)}`;
}

export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  const a = DAY_RE.exec(from);
  const b = DAY_RE.exec(to);
  if (!a || !b) return NaN;
  const ta = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const tb = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((tb - ta) / 86_400_000);
}

/** 'dd.MM.yyyy' (CW:14); empty → "—". */
export function formatDay(d: string | null | undefined): string {
  if (!d) return "—";
  const m = DAY_RE.exec(d.slice(0, 10));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
}

/** 'dd.MM' for compact table cells. */
export function formatDayShort(d: string | null | undefined): string {
  if (!d) return "—";
  const m = DAY_RE.exec(d.slice(0, 10));
  return m ? `${m[3]}.${m[2]}` : d;
}

/** Timestamp as 'dd.MM.yyyy HH:mm' in Istanbul time. */
export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return ts;
  const parts = new Intl.DateTimeFormat("tr-TR", {
    timeZone: ISTANBUL,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Istanbul calendar day of a timestamp. */
export function istanbulDayOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: ISTANBUL }).format(t);
}

/** 'MM.yyyy' for expiry dates. */
export function formatMonthYear(d: string | null | undefined): string {
  if (!d) return "—";
  const m = DAY_RE.exec(d.slice(0, 10));
  return m ? `${m[2]}.${m[1]}` : d;
}
