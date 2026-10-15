import { WORKBOOK_LAYOUT_TEMPLATE, validateWorkbookLayout, type WorkbookLayout } from "@/lib/finance-import/layout";

// Saved layout configs (fin_import_layouts.config), exactly the shapes validated by fin__layout_config
// (spec p2i_db_contract §2.7). The values are the clinic's own column map: data, never code. The template below is
// only offered as a starting point in the layouts editor; the parser reads saved rows only.

export type WorkbookLayoutConfig = WorkbookLayout;

export type BankTableMode = "signed" | "split" | "direction" | "debit" | "credit";

export interface BankTableMappingConfig {
  header: number;
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  direction: number;
  balance: number;
  reference: number;
  currency: number;
  mode: BankTableMode;
  format: "tr" | "en";
}

export interface BankTableLayoutConfig {
  version: 1;
  sheet_name?: string;
  header_signature: string[];
  mapping: BankTableMappingConfig;
}

/** Starting template offered by the layouts editor (the parser library's legacy column map; never a fallback). */
export function workbookTemplate(): WorkbookLayoutConfig {
  return JSON.parse(JSON.stringify(WORKBOOK_LAYOUT_TEMPLATE)) as WorkbookLayoutConfig;
}

// --- Excel column letters <-> 0-based indexes (display only) --------------------

export function colLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) return "";
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(letters: string): number | null {
  const s = letters.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(s)) return null;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  const idx = n - 1;
  return idx >= 0 && idx <= 255 ? idx : null;
}

export function colsToText(cols: number[]): string {
  return cols.map(colLetter).join(", ");
}

/** "C, H, I" → [2, 7, 8]; null when any token is invalid. At most 10 columns (fin__layout_config). */
export function textToCols(text: string): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 10) return null;
  const out: number[] = [];
  for (const p of parts) {
    const i = colIndex(p);
    if (i === null) return null;
    out.push(i);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const isCol = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255;
const isColOrNone = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= -1 && v <= 255;
/** Client-side mirror of fin__layout_config for workbook layouts: the first problem, or null. */
export function checkWorkbookConfig(v: unknown): string | null {
  const res = validateWorkbookLayout(v);
  return res.ok ? null : res.errors[0] ?? "config";
}

export function checkBankTableConfig(v: unknown): string | null {
  if (!isRecord(v)) return "config";
  if (v.version !== 1) return "version";
  if (v.sheet_name !== undefined && v.sheet_name !== null && (typeof v.sheet_name !== "string" || v.sheet_name.length < 1 || v.sheet_name.length > 100)) return "sheet_name";
  if (!Array.isArray(v.header_signature) || v.header_signature.length > 40 || !v.header_signature.every((s) => typeof s === "string" && s.length <= 80)) return "header_signature";
  const m = v.mapping;
  if (!isRecord(m)) return "mapping";
  if (!Number.isInteger(m.header) || (m.header as number) < 0 || (m.header as number) > 10000) return "mapping.header";
  if (!isCol(m.date)) return "mapping.date";
  for (const k of ["description", "amount", "debit", "credit", "direction", "balance", "reference", "currency"]) {
    if (!isColOrNone(m[k])) return `mapping.${k}`;
  }
  if (!["signed", "split", "direction", "debit", "credit"].includes(m.mode as string)) return "mapping.mode";
  if (m.format !== "tr" && m.format !== "en") return "mapping.format";
  return null;
}

export function asWorkbookConfig(v: unknown): WorkbookLayoutConfig | null {
  return checkWorkbookConfig(v) === null ? (v as WorkbookLayoutConfig) : null;
}

export function asBankTableConfig(v: unknown): BankTableLayoutConfig | null {
  return checkBankTableConfig(v) === null ? (v as BankTableLayoutConfig) : null;
}
