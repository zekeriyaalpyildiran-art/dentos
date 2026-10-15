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

const ROW_ISSUES = {
  dateColumn: "Tarih seçilen sütunda değil; eşleştirmeyi kontrol edin.",
  emptyOrTotal: "Açıklama boş veya toplam/devir satırı. İşlem olarak eklenmedi.",
  currency: "Dövizli hareket TL olarak aktarılamaz; TL karşılığı olan bir döküm kullanın.",
  split: "Borç/alacak tutarı belirsiz veya iki sütun da dolu.",
  amount: "Tutar veya giriş/çıkış yönü okunamadı. Sütun ve sayı biçimini kontrol edin.",
} as const;

export type BankTableResult = { rows: ParsedRow[]; issues: ParseIssue[]; ignored: number };

/** BT:28-53 + BM:13. Every generic row starts unselected (C8). */
export async function parseBankTable(table: BankTable, m: BankMapping, file: string, rules: CompiledRules): Promise<BankTableResult> {
  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Map<string, number>();
  let ignored = 0;
  if (!m.account.trim()) return { rows, issues: [{ line: 0, reason: MAPPING_ERRORS.account }], ignored };
  if (
    m.date < 0 ||
    m.description < 0 ||
    (["signed", "direction", "debit", "credit"].includes(m.mode) && m.amount < 0) ||
    (m.mode === "split" && m.debit < 0 && m.credit < 0) ||
    (m.mode === "direction" && m.direction < 0)
  )
    return { rows, issues: [{ line: 0, reason: MAPPING_ERRORS.columns }], ignored };
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
  if (new Set(used).size !== used.length) return { rows, issues: [{ line: 0, reason: MAPPING_ERRORS.duplicate }], ignored };
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
      )
        issues.push({ line: i + 1, reason: ROW_ISSUES.dateColumn });
      else ignored++;
      continue;
    }
    if (!desc || /^(toplam|devir|acilis bakiyesi|kapanis bakiyesi|opening balance|closing balance|total)\b/.test(normB(desc))) {
      issues.push({ line: i + 1, reason: ROW_ISSUES.emptyOrTotal });
      continue;
    }
    if (m.currency >= 0 && bankText(raw[m.currency]) && !/^(tl|try|₺|turk lirasi)$/.test(normB(raw[m.currency]))) {
      issues.push({ line: i + 1, reason: ROW_ISSUES.currency });
      continue;
    }
    let amount: number | null = null;
    if (m.mode === "split") {
      const debit = m.debit >= 0 ? bankNumber(raw[m.debit], m.format) : 0;
      const credit = m.credit >= 0 ? bankNumber(raw[m.credit], m.format) : 0;
      if (debit === null || credit === null || debit < 0 || credit < 0 || (debit && credit)) {
        issues.push({ line: i + 1, reason: ROW_ISSUES.split });
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
      continue;
    }
    const balance = m.balance >= 0 ? bankNumber(raw[m.balance], m.format) : null;
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
  return { rows, issues, ignored };
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
