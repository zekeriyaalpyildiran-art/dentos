// Finance import: shared primitives (spec p2i_parsers_rules §1).
//
// These one-liners decide source-key bytes. They are ported character for character from the
// legacy readers (finance-import.ts FI:5-7, bank-table-import.ts BT:4-19, finance-model.ts FM:22);
// do not "simplify" them. The only deliberate change is D2: Date cells are converted with local
// calendar fields instead of toISOString() (which gave the previous day in Europe/Istanbul).
//
// Pure module: no DOM, no network, no heavy libraries.

/** FI:5. Turkish-formatted text → JS float in TL (not cents). Removes every '.', so only for TR text. */
export const trNumber = (s: unknown): number =>
  typeof s === "number" ? s : Number(String(s ?? "").replace(/\s|TL/g, "").replace(/\./g, "").replace(",", "."));

/** FI:6. Only dd.mm.yyyy or dd/mm/yyyy (2+2+4 digits); does not check the calendar. */
export const isoDate = (s: string): string => {
  const m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};

/** FI:7. Classification / workbook normaliser: Turkish lower case, whitespace collapsed, trimmed. */
export const normTr = (s: string): string => s.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** D2: a Date cell (SheetJS gives local midnight) → its local calendar day. */
export const localDateIso = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** BT:4 (with D2 for Date values). */
export const bankText = (s: unknown): string =>
  s instanceof Date ? (Number.isNaN(s.getTime()) ? "" : localDateIso(s)) : String(s ?? "").trim();

/** BT:5. Generic-mapper normaliser: Turkish lower case, accents stripped, ı→i, whitespace collapsed. */
export const normB = (s: unknown): string =>
  bankText(s)
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ");

/** BT:6-12 (with D2 for Date values). Returns 'YYYY-MM-DD' or ''. */
export function bankDate(v: unknown): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : localDateIso(v);
  if (typeof v === "number" && v > 20000 && v < 100000)
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  const s = bankText(v);
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s|T|$)/);
  let y = "";
  let mo = "";
  let d = "";
  if (m) {
    [, y, mo, d] = m;
  } else {
    m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s|$)/);
    if (!m) return "";
    [, d, mo, y] = m;
  }
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const stamp = Date.parse(iso + "T12:00:00Z");
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === iso ? iso : "";
}

export type NumberFormat = "tr" | "en";

/** BT:13-19. Integer cents (signed) or null when the text is not a number in that format. */
export function bankNumber(v: unknown, format: NumberFormat): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = bankText(v);
  if (!s || s === "-") return 0;
  const neg = /^\(.*\)$/.test(s) || /^-|-$/.test(s);
  s = s.replace(/TRY|TL|₺/gi, "").replace(/[\s()]/g, "").replace(/^[+-]|-$/g, "");
  const pattern =
    format === "tr" ? /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/ : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
  if (!pattern.test(s)) return null;
  const n = Number(format === "tr" ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) * (neg ? -1 : 1) : null;
}

/** FM:22 financeDay as a plain predicate: 'YYYY-MM-DD' that exists on the calendar. */
export const financeDayOk = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  (() => {
    const d = new Date(v + "T12:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  })();

/** 'YYYY-MM' with a real month. */
export const monthOk = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/**
 * Turkish money text of integer cents: '.' thousands, ',' decimals, always two decimals,
 * '-' prefix when negative. 123456789 → '1.234.567,89', 0 → '0,00'. Used to rebuild the raw
 * balance text of a TEB PDF from the TEB spreadsheet's numeric cell (§6.1).
 */
export function trMoney(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "-" : "") + whole + "," + String(abs % 100).padStart(2, "0");
}

/** MT:3 matching normaliser (debt candidate scoring, §12.2). */
export const normM = (s: string): string =>
  s
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Adds N days to a 'YYYY-MM-DD' day (UTC noon arithmetic, BG:8). */
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(day + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** Own-property lookup on a sheet map (sheet names are file data). */
export const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * File names go to the database (history, sources, balances) and are shown to read-only users. Banks often
 * name statements after the account number, so every run of 6+ digits is masked to its last 4 ('…1234')
 * and the name is limited to 200 characters. Applied once, where a file enters the import screens.
 */
export const maskFileName = (name: string): string =>
  (name.replace(/\d{6,}/g, (run) => "…" + run.slice(-4)).trim() || "Dosya").slice(0, 200);

/**
 * A layout pattern that may be empty (skip patterns, p2i_db_contract §2.7: 0..200 characters).
 * An empty pattern never matches (new RegExp("") would match every text).
 */
export function optionalPattern(pattern: string | null | undefined, flags: string): { test: (s: string) => boolean } {
  if (!pattern) return { test: () => false };
  const re = new RegExp(pattern, flags);
  return { test: (s: string) => re.test(s) };
}
