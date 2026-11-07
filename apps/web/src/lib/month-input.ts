/** Same rule as isMonth in lib/finance (kept here so this module has no Supabase import). */
function isMonth(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const m = Number(value.slice(5, 7));
  return m >= 1 && m <= 12;
}

/**
 * Helpers for MonthInput. Desktop Safari has no `<input type="month">`: it renders a plain text box, and our pickers
 * that accept only complete months reset on every keystroke, so the month could not be changed at all there.
 */

/** "YYYY-MM" moved by n months (n may be negative). */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const mon = ((m % 12) + 12) % 12;
  return `${String(year).padStart(4, "0")}-${String(mon + 1).padStart(2, "0")}`;
}

/** Every month from `min` to `max` inclusive, newest first; empty when the range is invalid or reversed. */
export function monthRange(min: string, max: string, limit = 240): string[] {
  if (!isMonth(min) || !isMonth(max) || min > max) return [];
  const out: string[] = [];
  for (let m = max; m >= min && out.length < limit; m = addMonths(m, -1)) out.push(m);
  return out;
}

/** True when `value` is a complete month inside the optional bounds. */
export function monthInBounds(value: string, min?: string, max?: string): boolean {
  return isMonth(value) && (!min || value >= min) && (!max || value <= max);
}

/** The local calendar month as "YYYY-MM". */
export function localMonth(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Whether the browser has a real month picker (false on desktop Safari and old Firefox). */
export function nativeMonthSupported(): boolean {
  if (typeof document === "undefined") return true;
  const input = document.createElement("input");
  input.setAttribute("type", "month");
  if (input.type !== "month") return false;
  // Some engines keep the type but accept any text; a real picker rejects free text.
  input.value = "x";
  return input.value === "";
}

/**
 * Options of the fallback list: `min`..`max` (defaults: 4 years back to 1 year ahead of today), always including the
 * current value so a stored month outside the range stays selectable.
 */
export function monthOptions(value: string, min?: string, max?: string, today = localMonth()): string[] {
  const hi = max && isMonth(max) ? max : addMonths(today, 12);
  const lo = min && isMonth(min) ? min : addMonths(hi < today ? hi : today, -48);
  const list = monthRange(lo, hi);
  if (isMonth(value) && !list.includes(value)) {
    list.push(value);
    list.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  }
  return list;
}
