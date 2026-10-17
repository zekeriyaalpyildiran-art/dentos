// Finance import, parser D: the generic table mapper for unknown bank spreadsheets, CSV,
// pasted TSV and PDF tables (spec p2i_parsers_rules §7; legacy BT:20-67, BM:13-22).
// suggestMapping, parseBankTable and pdfTable are verbatim ports; keys are hashed as BM:13 did.

import { bankRow } from "./bank-text";
import type { CompiledRules } from "./classify";
import { bankTableKey } from "./keys";
import { bankDate, bankNumber, bankText, normB, type NumberFormat } from "./primitives";
import type { ParseIssue, ParsedRow, PdfCell } from "./types";

export type BankTable = { name: string; rows: unknown[][] };
export type MappingMode = "signed" | "split" | "direction" | "debit" | "credit";
export type BankMapping = {
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
  mode: MappingMode;
  format: NumberFormat;
  /** The account's immutable key label (fin_accounts.import_key / layout key_label), never free text. */
  account: string;
};

type Field = Exclude<keyof BankMapping, "header" | "mode" | "format" | "account">;

const PATTERNS: Record<Field, RegExp> = {
  date: /^(islem |kayit |posting |transaction |value )?(tarih[i]?|date)$/,
  description: /aciklama|description|detay|details/,
  amount: /^(islem |transaction )?(tutar[i]?|amount)$|^net tutar$/,
  debit: /borc|debit|cikis|cekilen/,
  credit: /alacak|credit|giris|yatirilan/,
  direction: /yon|borc.alacak|islem tipi|islem turu|debit.credit|^b.a$/,
  balance: /bakiye|balance/,
  reference: /referans|reference|dekont|islem no/,
  currency: /para birimi|doviz|currency/,
};

/** BT:20-27. The header is the first row (of the first 100) with the most distinct pattern hits. */
export function suggestMapping(rows: unknown[][]): BankMapping {
  let best = 0;
  let score = -1;
  rows.slice(0, 100).forEach((r, i) => {
    const s = Object.values(PATTERNS).filter((p) => r.some((c) => p.test(normB(c)))).length;
    if (s > score) {
      score = s;
      best = i;
    }
  });
  const header = rows[best] || [];
  const mapping = { header: best, mode: "signed", format: "tr", account: "" } as BankMapping;
  for (const [k, p] of Object.entries(PATTERNS) as [Field, RegExp][]) mapping[k] = header.findIndex((c) => p.test(normB(c)));
  if (mapping.direction >= 0) {
    if (mapping.debit === mapping.direction) mapping.debit = -1;
    if (mapping.credit === mapping.direction) mapping.credit = -1;
  }
  if (mapping.debit >= 0 || mapping.credit >= 0) mapping.mode = "split";
  else if (mapping.direction >= 0) mapping.mode = "direction";
  return mapping;
}

export const MAPPING_ERRORS = {
  account: "Banka hesabını seçin. Aynı hesap için her yüklemede aynı hesap anahtarı kullanılır.",
  columns: "Tarih, açıklama ve tutar/yön sütunlarını eşleştirin.",
  duplicate: "Aynı sütun birden çok alan için seçilmiş. Özellikle işlem tutarı ile bakiyeyi ayrı seçin.",
} as const;

/** Total, carry-over and opening / closing balance lines: not movements. */
const TOTAL_LINE = /^(toplam|devir|acilis bakiyesi|kapanis bakiyesi|opening balance|closing balance|total)\b/;

const ROW_ISSUES = {
  dateColumn: "Tarih seçilen sütunda değil; eşleştirmeyi kontrol edin.",
  emptyOrTotal: "Açıklama boş veya toplam/devir satırı. İşlem olarak eklenmedi.",
  currency: "Dövizli hareket TL olarak aktarılamaz; TL karşılığı olan bir döküm kullanın.",
  split: "Borç/alacak tutarı belirsiz veya iki sütun da dolu.",
  amount: "Tutar veya giriş/çıkış yönü okunamadı. Sütun ve sayı biçimini kontrol edin.",
} as const;

/**
 * The balance after the last movement of a column-mapped statement (`ok`), or the day it could not be told for.
 * null when no balance column is mapped or no movement was read.
 */
export type TableClosing = { ok: true; day: string; amountCents: number; line: number } | { ok: false; day: string };

export type BankTableResult = { rows: ParsedRow[]; issues: ParseIssue[]; ignored: number; closing: TableClosing | null };

/** One read movement for the closing balance: signed cents and the balance after it (null when empty / unreadable). */
export type ChainRow = { date: string; signedCents: number; balanceCents: number | null; line: number };
type Linked = ChainRow & { balanceCents: number };

/** At most this many steps are tried to place every same-day movement on one balance chain. */
const CHAIN_BUDGET = 50_000;

/**
 * Closing balance from the 'balance after' column, whatever the row order (newest or oldest first). The day is the
 * latest movement date; on that day each movement continues from the one whose balance equals its own balance minus
 * its amount, and the last movement is the only one no other same-day movement continues from. Every same-day
 * movement must sit on that one chain; otherwise (gap, repeated balances, a column that is not a running balance,
 * an empty cell, or a movement of that day that could not be read: `blockedDays`) nothing is guessed.
 *
 * When the previous movement day is fully read, the day must also start where that day ended (its closing balance,
 * or when that one cannot be told, one of its balances): this catches a mis-mapped column on a one-movement day, and
 * the previous closing balance tells where a day without a single last movement (a reversal pair) starts.
 */
export function closingBalance(rows: readonly ChainRow[], blockedDays: ReadonlySet<string> = new Set()): TableClosing | null {
  if (!rows.length) return null;
  let day = "";
  for (const r of rows) if (r.date > day) day = r.date;
  for (const d of Array.from(blockedDays)) if (d > day) day = d;
  const unknown: TableClosing = { ok: false, day };
  if (blockedDays.has(day)) return unknown;
  const same = linkedDay(rows, day);
  if (!same) return unknown;
  const opening = openingAnchor(rows, day, blockedDays);
  const net = same.reduce((n, r) => n + r.signedCents, 0);
  const continued = new Set(same.map(before));
  const ends = same.filter((r) => !continued.has(r.balanceCents));
  let end: Linked | null = null;
  if (ends.length === 1) {
    // Walked back from the one last movement; the day then started at its balance minus the day's net movement.
    if (fullChain(same.length, ends, previousOf(same))) end = ends[0];
    if (end && opening && !opening.has(end.balanceCents - net)) end = null;
  } else if (opening?.size === 1) {
    // No single last movement (a net-zero day): walk forward from where the previous day ended.
    const start = Array.from(opening)[0];
    end = fullChain(same.length, same.filter((r) => before(r) === start), nextOf(same));
  }
  return end ? { ok: true, day, amountCents: end.balanceCents, line: end.line } : unknown;
}

const before = (r: Linked) => r.balanceCents - r.signedCents;

/** The day's movements, or null when one of them has no balance. */
function linkedDay(rows: readonly ChainRow[], day: string): Linked[] | null {
  const same = rows.filter((r) => r.date === day);
  return same.length && same.every((r) => r.balanceCents !== null) ? (same as Linked[]) : null;
}

/**
 * Balances the latest day may start from: the previous movement day's closing balance, or all of that day's balances
 * when its own last one cannot be told. null (no check) when there is no earlier day, or it is not fully read.
 */
function openingAnchor(rows: readonly ChainRow[], day: string, blockedDays: ReadonlySet<string>): Set<number> | null {
  let prevDay = "";
  for (const r of rows) if (r.date < day && r.date > prevDay) prevDay = r.date;
  for (const d of Array.from(blockedDays)) if (d < day && d > prevDay) prevDay = d;
  if (!prevDay || blockedDays.has(prevDay)) return null;
  const prev = linkedDay(rows, prevDay);
  if (!prev) return null;
  const closing = closingBalance(prev);
  return new Set(closing?.ok ? [closing.amountCents] : prev.map((r) => r.balanceCents));
}

function previousOf(rows: Linked[]): (r: Linked) => readonly Linked[] {
  const byBalance = groupBy(rows, (r) => r.balanceCents);
  return (r) => byBalance.get(before(r)) ?? [];
}

function nextOf(rows: Linked[]): (r: Linked) => readonly Linked[] {
  const byBefore = groupBy(rows, before);
  return (r) => byBefore.get(r.balanceCents) ?? [];
}

function groupBy(rows: Linked[], key: (r: Linked) => number): Map<number, Linked[]> {
  const out = new Map<number, Linked[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}

/**
 * Depth-first with backtracking: an order of all `count` movements that starts with one of `first` and where each
 * movement is followed by one of `follow(movement)`. Returns the order's last movement, or null when there is none
 * (or the step budget runs out).
 */
function fullChain(count: number, first: readonly Linked[], follow: (r: Linked) => readonly Linked[]): Linked | null {
  const used = new Set<Linked>();
  const path: { options: readonly Linked[]; next: number; row?: Linked }[] = [{ options: first, next: 0 }];
  let budget = CHAIN_BUDGET;
  while (path.length) {
    if (--budget < 0) return null;
    const top = path[path.length - 1];
    let pick: Linked | undefined;
    while (!pick && top.next < top.options.length) {
      const c = top.options[top.next++];
      if (!used.has(c)) pick = c;
    }
    if (!pick) {
      path.pop();
      if (top.row) used.delete(top.row);
      continue;
    }
    used.add(pick);
    if (used.size === count) return pick;
    path.push({ options: follow(pick), next: 0, row: pick });
  }
  return null;
}

/** BT:28-53 + BM:13. Every generic row starts unselected (C8). */
export async function parseBankTable(table: BankTable, m: BankMapping, file: string, rules: CompiledRules): Promise<BankTableResult> {
  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Map<string, number>();
  const chain: ChainRow[] = [];
  const blocked = new Set<string>();
  // A movement whose date could not be read may be the last one: no closing balance is told then.
  let undatedMovement = false;
  let ignored = 0;
  if (!m.account.trim()) return { rows, issues: [{ line: 0, reason: MAPPING_ERRORS.account }], ignored, closing: null };
  if (
    m.date < 0 ||
    m.description < 0 ||
    (["signed", "direction", "debit", "credit"].includes(m.mode) && m.amount < 0) ||
    (m.mode === "split" && m.debit < 0 && m.credit < 0) ||
    (m.mode === "direction" && m.direction < 0)
  )
    return { rows, issues: [{ line: 0, reason: MAPPING_ERRORS.columns }], ignored, closing: null };
  const used = [
    m.date,
    m.description,
    m.mode === "split" ? m.debit : m.amount,
    m.mode === "split" ? m.credit : -1,
    m.mode === "direction" ? m.direction : -1,
    m.balance,
    m.reference,
    m.currency,
  ].filter((i) => i >= 0);
  if (new Set(used).size !== used.length) return { rows, issues: [{ line: 0, reason: MAPPING_ERRORS.duplicate }], ignored, closing: null };
  const amountColumns = (m.mode === "split" ? [m.debit, m.credit] : [m.amount]).filter((c) => c >= 0);
  /** The row's amount cell(s) for the mode hold a readable non-zero number (a movement, not a footer or note line). */
  const moves = (raw: unknown[]) =>
    amountColumns.some((c) => {
      const v = bankNumber(raw[c], m.format);
      return v !== null && v !== 0;
    });
  for (let i = m.header + 1; i < table.rows.length; i++) {
    const raw = table.rows[i] || [];
    if (!raw.some((v) => bankText(v))) continue;
    const date = bankDate(raw[m.date]);
    const desc = bankText(raw[m.description]);
    if (!date) {
      if (
        raw.some((v) => bankDate(v)) ||
        (bankText(raw[m.description]) &&
          [m.amount, m.debit, m.credit]
            .filter((c) => c >= 0)
            .some((c) => {
              const v = bankNumber(raw[c], m.format);
              return v !== null && v !== 0;
            }))
      ) {
        issues.push({ line: i + 1, reason: ROW_ISSUES.dateColumn });
        if (moves(raw) && !TOTAL_LINE.test(normB(desc))) undatedMovement = true;
      } else ignored++;
      continue;
    }
    if (!desc || TOTAL_LINE.test(normB(desc))) {
      issues.push({ line: i + 1, reason: ROW_ISSUES.emptyOrTotal });
      // A dated movement without narration may be the day's last one; total / opening lines and dated lines without
      // an amount (a print time in the footer) are not movements.
      if (!desc && moves(raw)) blocked.add(date);
      continue;
    }
    if (m.currency >= 0 && bankText(raw[m.currency]) && !/^(tl|try|₺|turk lirasi)$/.test(normB(raw[m.currency]))) {
      issues.push({ line: i + 1, reason: ROW_ISSUES.currency });
      blocked.add(date);
      continue;
    }
    let amount: number | null = null;
    if (m.mode === "split") {
      const debit = m.debit >= 0 ? bankNumber(raw[m.debit], m.format) : 0;
      const credit = m.credit >= 0 ? bankNumber(raw[m.credit], m.format) : 0;
      if (debit === null || credit === null || debit < 0 || credit < 0 || (debit && credit)) {
        issues.push({ line: i + 1, reason: ROW_ISSUES.split });
        blocked.add(date);
        continue;
      }
      amount = credit - debit;
    } else {
      amount = bankNumber(raw[m.amount], m.format);
      if (amount !== null) {
        if (m.mode === "debit") amount = -Math.abs(amount);
        if (m.mode === "credit") amount = Math.abs(amount);
        if (m.mode === "direction") {
          const dir = normB(raw[m.direction]);
          if (/^(b|borc|borç|debit|dr|cikis|giden|cekilen|-)$/.test(dir)) amount = -Math.abs(amount);
          else if (/^(a|alacak|credit|cr|giris|gelen|yatirilan|\+)$/.test(dir)) amount = Math.abs(amount);
          else amount = null;
        }
      }
    }
    if (amount === null || !amount || !Number.isSafeInteger(amount) || Math.abs(amount) > 1e12) {
      issues.push({ line: i + 1, reason: ROW_ISSUES.amount });
      // An information line with a written zero amount ('0,00') is not a movement; an empty or unreadable amount
      // may be one, so its day gets no closing balance.
      const zero = amountColumns.every((c) => bankNumber(raw[c], m.format) === 0) && amountColumns.some((c) => bankText(raw[c]));
      if (!zero) blocked.add(date);
      continue;
    }
    const balance = m.balance >= 0 ? bankNumber(raw[m.balance], m.format) : null;
    if (m.balance >= 0) {
      // For the closing balance an empty or '-' cell is missing, not 0 (the key below keeps bankNumber's value).
      const cell = bankText(raw[m.balance]);
      chain.push({ date, signedCents: amount, balanceCents: cell && cell !== "-" ? balance : null, line: i + 1 });
    }
    const ref = m.reference >= 0 ? bankText(raw[m.reference]) : "";
    // Stable across file names and overlapping exports; identical movements stay distinct (occurrence).
    const identity = JSON.stringify([normB(m.account).replace(/\s/g, ""), date, amount, ref || normB(desc), balance]);
    const occurrence = (seen.get(identity) || 0) + 1;
    seen.set(identity, occurrence);
    const base = bankRow({
      file,
      bankAccount: m.account,
      date,
      description: desc,
      amountTl: amount / 100,
      balance: balance === null ? "" : String(balance),
      reference: ref,
      sourceKind: "bank_table",
      rules,
    });
    const ruleWarning = base.warnings.map((w) => w.text).join(" ");
    rows.push({
      ...base,
      key: await bankTableKey(identity, occurrence),
      selected: false,
      warnings: [
        {
          code: "W_TABLE_ROW",
          text: `${amount < 0 ? "Banka çıkışı" : "Banka girişi"} · ${table.name}, satır ${i + 1}. ${ruleWarning} Önizlemeyi kontrol edip seçin.`,
        },
        ...base.warnings,
      ],
      meta: { line: i + 1, table: table.name, occurrence },
    });
  }
  const closing = m.balance >= 0 ? closingBalance(chain, blocked) : null;
  return { rows, issues, ignored, closing: closing && undatedMovement ? { ok: false, day: closing.day } : closing };
}

/** BT:55-67: positioned PDF text items → a column table. */
export function pdfTable(pages: PdfCell[][]): BankTable {
  const rows: unknown[][] = [];
  for (const items of pages) {
    const lines: { y: number; cells: PdfCell[] }[] = [];
    for (const item of [...items]
      .filter((i) => i.str.trim())
      .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
      let line = lines.find((l) => Math.abs(l.y - item.transform[5]) < 3);
      if (!line) {
        line = { y: item.transform[5], cells: [] };
        lines.push(line);
      }
      line.cells.push(item);
    }
    const grouped = lines.map((l) => {
      const merged: { str: string; x: number; end: number }[] = [];
      for (const c of l.cells.sort((a, b) => a.transform[4] - b.transform[4])) {
        const x = c.transform[4];
        const prev = merged[merged.length - 1];
        if (prev && x - prev.end < 9) {
          prev.str += " " + c.str;
          prev.end = x + c.width;
        } else merged.push({ str: c.str, x, end: x + c.width });
      }
      return merged;
    });
    const header = grouped.find((r) => {
      const m = suggestMapping([r.map((c) => c.str)]);
      return m.date >= 0 && (m.amount >= 0 || m.debit >= 0 || m.credit >= 0);
    });
    const anchor = header || grouped.find((r) => r.some((c) => bankDate(c.str)) && r.length >= 3);
    if (!anchor) {
      rows.push(...grouped.map((r) => r.map((c) => c.str)));
      continue;
    }
    for (const line of grouped) {
      const row: string[] = Array(anchor.length).fill("");
      for (const cell of line) {
        let col = 0;
        for (let i = 1; i < anchor.length; i++) if (cell.x >= anchor[i].x - 12) col = i;
        row[col] += (row[col] ? " " : "") + cell.str;
      }
      rows.push(row);
    }
  }
  return { name: "PDF tablosu", rows };
}

/** BM:21: pasted TSV (all strings). */
export const pasteTable = (paste: string): BankTable => ({
  name: "Yapıştırılan tablo",
  rows: paste
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split("\t")),
});

/** Folded header cells used to offer a saved bank_table layout automatically (p2i_db_contract §2.7). */
export const headerSignature = (row: unknown[]): string[] =>
  row
    .map((c) => normB(c).trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((c) => c.slice(0, 80));
