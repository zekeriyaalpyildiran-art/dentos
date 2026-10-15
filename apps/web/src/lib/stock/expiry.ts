// Expiry helpers (spec p7_rules_ui §9.2, §14.3). "Today" always comes from the server (stock_dashboard.today).

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDay(day: string): number {
  const m = DAY_RE.exec(day);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `today` to `expiry` (negative when expired). */
export function daysLeft(expiry: string, today: string): number {
  const a = utcDay(expiry);
  const b = utcDay(today);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((a - b) / 86_400_000);
}

export type ExpiryTone = "red" | "amber";

export function expiryTone(days: number): ExpiryTone | null {
  if (!Number.isFinite(days)) return null;
  if (days <= 30) return "red";
  if (days <= 90) return "amber";
  return null;
}

export function expiryLabel(days: number): string {
  if (!Number.isFinite(days)) return "";
  if (days < 0) return "Süresi geçmiş — kullanmayın";
  if (days === 0) return "Bugün son gün";
  return `${days} gün kaldı`;
}

/** Adds calendar days to a 'YYYY-MM-DD' day. */
export function addDays(day: string, n: number): string {
  const t = utcDay(day);
  if (Number.isNaN(t)) return day;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}
