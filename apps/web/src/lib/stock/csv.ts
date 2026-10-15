// Semicolon CSV for Excel with Turkish settings (spec p8_purchasing §10.5, legacy UP:16). Pure except downloadCsv.
// - UTF-8 with BOM, ';' separator, CRLF line ends, no line end after the last row.
// - Text cells: a leading = + - @ TAB or CR gets a "'" (formula-injection guard); ; " CR LF → quoted, " doubled.
// - Number cells are written from numbers only (never from user text): decimal comma, no grouping, not prefixed,
//   so a negative count difference stays a number in Excel.

export const CSV_BOM = "﻿";

/** One text cell. */
export function csvText(cell: string | null | undefined): string {
  let s = cell === null || cell === undefined ? "" : String(cell);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One number cell with up to `decimals` decimals (trailing zeros dropped); null / NaN → empty cell. */
export function csvNumber(n: number | null | undefined, decimals = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  let s = n.toFixed(decimals);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s.replace(".", ",");
}

/** Cents as TL with up to two decimals ("1234,5"), exact for any safe integer. */
export function csvCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0").replace(/0+$/, "");
  const body = frac ? `${whole},${frac}` : String(whole);
  return negative && abs !== 0 ? `-${body}` : body;
}

/** A pre-formatted number cell (from csvNumber / csvCents); written as is. */
export interface CsvRaw {
  raw: string;
}

export type CsvCell = string | number | null | undefined | CsvRaw;

function encode(cell: CsvCell): string {
  if (typeof cell === "number") return csvNumber(cell, 4);
  if (cell && typeof cell === "object") return cell.raw;
  return csvText(cell);
}

/** Number cell helpers for toCsv rows. */
export const qtyCell = (n: number | null | undefined): CsvRaw => ({ raw: csvNumber(n, 4) });
export const tlCell = (cents: number | null | undefined): CsvRaw => ({ raw: csvCents(cents) });

export function toCsv(rows: CsvCell[][]): string {
  return CSV_BOM + rows.map((r) => r.map(encode).join(";")).join("\r\n");
}

/** Saves the text as a file (Blob + object URL, revoked after the click). */
export function downloadCsv(name: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
