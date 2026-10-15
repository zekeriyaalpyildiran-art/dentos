// Golden tests on the clinic's real sample files (spec p2i_parsers_rules §14).
//
// The files are sensitive. They are never copied into the repo: they are read from the directory in
// DENTOS_FINANCE_SAMPLES and the whole suite is skipped when it is unset. Files are found by content detection, never
// by name. This file holds NO figure from the samples: every count, amount, balance, rate, date and row digest is in
// an expectations JSON outside the repo (DENTOS_FINANCE_SAMPLE_EXPECT, kept next to the samples); without it only the
// structural checks run. Assertions never pass sample-derived values to toEqual / toBe: values are compared inside
// `same()`, whose failure message names the fact only, so a regression cannot print account numbers or balances
// into a terminal or CI log.
//
// DENTOS_LEGACY_XLSX (optional) points to an installed xlsx@0.18.5 (legacy's pinned SheetJS); the reader-parity test
// then compares the cell arrays legacy produced with the ones DentOS produces (critique 10).

import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileRules, type ClassificationRule } from "../classify";
import { detectBank, pageHasText, pdfPagesText, parseBankText } from "../bank-text";
import { detectTebSheet, parseTebSheet } from "../bank-xlsx";
import { parseBankTable, pdfTable, suggestMapping } from "../bank-table";
import { bankBalance, workbookCashBalance } from "../balances";
import { intakeSpreadsheet } from "../detect";
import { hasFinancingMarker, parseFinancing, type FinancingItem } from "../financing";
import { readPdfFile, readSpreadsheetFile, type PdfjsLike } from "../read-file";
import { appendToReview } from "../review";
import { isClinicWorkbook, parseWorkbook, workbookRates } from "../workbook";
import type { ParsedRow, PdfCell, SheetBook } from "../types";
import { entitlementRule, LAYOUT, physicianRule, SEED_RULES, seedRules } from "./fixtures";

const DIR = process.env.DENTOS_FINANCE_SAMPLES;
const RULES_FILE = process.env.DENTOS_FINANCE_SAMPLE_RULES;
const EXPECT_FILE = process.env.DENTOS_FINANCE_SAMPLE_EXPECT;
const LEGACY_XLSX = process.env.DENTOS_LEGACY_XLSX;
const enabled = !!DIR && existsSync(DIR);
type Facts = Record<string, unknown>;
const EXPECT: Record<string, Facts> | null =
  enabled && EXPECT_FILE && existsSync(EXPECT_FILE) ? (JSON.parse(readFileSync(EXPECT_FILE, "utf8")) as Record<string, Facts>) : null;

const digest = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex");
const stable = (v: unknown) => createHash("sha256").update(JSON.stringify(v) ?? "undefined").digest("hex");
const tail = (key: string) => key.split(":").slice(3).join(":");
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
const MONTH = "2026-10";
const rules = seedRules();

/** Compares inside a digest; the failure names the fact, never the values. */
function same(label: string, actual: unknown, expected: unknown) {
  expect(stable(actual) === stable(expected), `${label}: örnek dosya beklentisiyle uyuşmuyor`).toBe(true);
}

/** Every fact the expectations file lists for `section` must match (skipped when the file is not given). */
function expectFacts(section: string, facts: Facts) {
  if (!EXPECT) return;
  const exp = EXPECT[section];
  expect(!!exp, `${section}: beklenti bölümü yok`).toBe(true);
  for (const k of Object.keys(exp)) {
    expect(k in facts, `${section}.${k}: hesaplanmadı`).toBe(true);
    same(`${section}.${k}`, facts[k], exp[k]);
  }
}

type Pdf = { pages: PdfCell[][]; text: string; bank: string };
const files: {
  wb?: SheetBook;
  tebx?: SheetBook;
  sheetsRead: { name: string; data: ArrayBuffer; mode: "general" | "financing" }[];
  financing: { book: SheetBook; items: FinancingItem[] }[];
  pdf: Record<string, Pdf>;
} = { financing: [], pdf: {}, sheetsRead: [] };

async function load() {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike;
  for (const name of readdirSync(DIR as string)) {
    const path = join(DIR as string, name);
    const bytes = readFileSync(path);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (/\.pdf$/i.test(name)) {
      const { pages } = await readPdfFile(new Uint8Array(data), { pdfjs });
      const text = pdfPagesText(pages);
      files.pdf[detectBank(text) || name] = { pages, text, bank: detectBank(text) };
    } else if (/\.(xlsx|xls|csv)$/i.test(name)) {
      const book = await readSpreadsheetFile(data, name, "general");
      if (hasFinancingMarker(book)) {
        const fbook = await readSpreadsheetFile(data, name, "financing");
        files.financing.push({ book: fbook, items: parseFinancing(fbook, "f.xlsx").items });
        files.sheetsRead.push({ name, data, mode: "financing" });
      } else {
        if (isClinicWorkbook(book, LAYOUT)) files.wb = book;
        else if (book.names.some((n) => detectTebSheet(book.sheets[n]))) files.tebx = book;
        files.sheetsRead.push({ name, data, mode: "general" });
      }
    }
  }
  files.financing.sort((a, b) => b.items.length - a.items.length);
}

const rowLine = (r: ParsedRow) => `${r.date}|${r.signedCents}|${r.kind}|${r.bucket}|${r.selected}|${tail(r.key)}`;
const isDay = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

describe.skipIf(!enabled)("real clinic samples (§14)", () => {
  beforeAll(load, 120000);

  it("§14.1 PDFs: three known banks, all text-based", () => {
    expect(Object.keys(files.pdf).sort()).toEqual(["Garanti", "TEB", "VakıfBank"]);
    for (const p of Object.values(files.pdf)) {
      expect(p.pages.every(pageHasText)).toBe(true);
      // legacy order over the whole text agrees with the zone detection
      expect(detectBank(p.text.replace(/\n/g, " ")) === p.bank).toBe(true);
    }
    expectFacts("pdf_pages", {
      garanti: files.pdf.Garanti.pages.length,
      vakif: files.pdf["VakıfBank"].pages.length,
      teb: files.pdf.TEB.pages.length,
    });
  });

  it("§14.3 Garanti PDF", () => {
    const p = parseBankText(files.pdf.Garanti.text, "g.pdf", rules);
    expect(/^\d{3}-\d{7}$/.test(p.account)).toBe(true);
    expect(new Set(p.rows.map((r) => r.key)).size === p.rows.length).toBe(true);
    expect(p.rows.every((r) => isDay(r.date) && Number.isInteger(r.amount) && r.amount > 0)).toBe(true);
    const b = bankBalance(files.pdf.Garanti.text, "g.pdf");
    expect(b !== null && b.importKey === p.accountImportKey && isDay(b.day)).toBe(true);
    const ins = p.rows.filter((r) => r.signedCents > 0);
    const outs = p.rows.filter((r) => r.signedCents < 0);
    const sendable = p.rows.filter((r) => r.selected && r.date.startsWith(MONTH));
    expect(ins.every((r) => !r.selected)).toBe(true); // C8
    expectFacts("garanti", {
      rows: p.rows.length,
      rows_digest: digest(p.rows.map(rowLine)),
      in: [ins.length, sum(ins.map((r) => r.amount))],
      out: [outs.length, sum(outs.map((r) => r.amount))],
      selected: p.rows.filter((r) => r.selected).length,
      sendable: [sendable.length, sum(sendable.map((r) => r.amount))],
      fee_splits: p.rows.filter((r) => r.kind === "bank_fee_split").length,
      balance: [b?.day, b?.amountCents],
    });
  });

  it("§14.5 VakıfBank PDF", () => {
    const p = parseBankText(files.pdf["VakıfBank"].text, "v.pdf", rules);
    expect(/^\d{17}$/.test(p.account)).toBe(true);
    const sel = p.rows.filter((r) => r.selected);
    const b = bankBalance(files.pdf["VakıfBank"].text, "v.pdf");
    expect(b !== null && b.importKey === p.accountImportKey).toBe(true);
    expect(suggestMapping(pdfTable(files.pdf["VakıfBank"].pages).rows).description === -1).toBe(true);
    expectFacts("vakif", {
      rows: p.rows.length,
      rows_digest: digest(p.rows.map(rowLine)),
      selected: [sel.length, sum(sel.map((r) => r.amount))],
      balance: [b?.day, b?.amountCents],
    });
  });

  it("§14.4 TEB PDF: rows, per-day figures, balance, generic table", async () => {
    const p = parseBankText(files.pdf.TEB.text, "t.pdf", rules);
    expect(/^\d{9}$/.test(p.account)).toBe(true);
    expect(new Set(p.rows.map((r) => r.key)).size === p.rows.length).toBe(true);
    expect(p.rows.every((r) => r.key.endsWith(":"))).toBe(true);
    const days = Array.from(new Set(p.rows.map((r) => r.date))).sort();
    const perDay = days.map((d) => {
      const rs = p.rows.filter((r) => r.date === d);
      const sel = rs.filter((r) => r.selected);
      return `${d}|${rs.length}|${sum(rs.filter((r) => r.signedCents > 0).map((r) => r.amount))}|${sum(rs.filter((r) => r.signedCents < 0).map((r) => r.amount))}|${sel.length}|${sum(sel.map((r) => r.amount))}`;
    });
    const b = bankBalance(files.pdf.TEB.text, "t.pdf");
    expect(b !== null && b.importKey === p.accountImportKey).toBe(true);
    const t = pdfTable(files.pdf.TEB.pages);
    const m = suggestMapping(t.rows);
    const g = await parseBankTable(t, { ...m, account: "TEST" }, "t.pdf", rules);
    const io = (rs: ParsedRow[]) => [sum(rs.filter((r) => r.signedCents > 0).map((r) => r.amount)), sum(rs.filter((r) => r.signedCents < 0).map((r) => r.amount))];
    same("teb.generic_io = known_io", io(g.rows), io(p.rows));
    expectFacts("teb", {
      rows: p.rows.length,
      tail_digest: p.rows.length > 42 ? digest([p.rows[0], p.rows[2], p.rows[42]].map((r) => tail(r.key))) : null,
      per_day_digest: digest(perDay),
      balance: [b?.day, b?.amountCents],
      mapping: [m.header, m.date, m.description, m.amount, m.balance, m.reference, m.mode],
      generic: [g.rows.length, g.issues.length, g.ignored],
      io: io(p.rows),
    });
  });

  it("§14.4 TEB spreadsheet: same keys as the TEB PDF, header balance, legacy generic path", async () => {
    const book = files.tebx as SheetBook;
    expect(book).toBeDefined();
    const sheet = book.sheets[book.names[0]];
    const pdf = parseBankText(files.pdf.TEB.text, "t.pdf", rules);
    const teb = parseTebSheet(sheet, detectTebSheet(sheet)!, "t.xlsx", rules);
    // D6: the spreadsheet reader emits exactly the TEB PDF reader's keys, in the same order.
    same("tebx.keys = teb_pdf.keys", teb.rows.map((r) => r.key), pdf.rows.map((r) => r.key));
    expect(teb.balance !== null && teb.balance.importKey === pdf.accountImportKey).toBe(true);
    same("tebx.balance = teb_pdf.balance", [teb.balance?.day, teb.balance?.amountCents], (() => {
      const b = bankBalance(files.pdf.TEB.text, "t.pdf");
      return [b?.day, b?.amountCents];
    })());
    const m = suggestMapping(sheet);
    const g = await parseBankTable({ name: book.names[0], rows: sheet }, { ...m, account: "TEST" }, "t.xlsx", rules);
    const count = (b: string) => g.rows.filter((r) => r.bucket === b).length;
    expect(g.rows.every((r) => r.meta.occurrence === 1 && !r.selected)).toBe(true);
    // session: TEB PDF first, then the spreadsheet through the DentOS reader → all dropped by key
    const list = appendToReview([], pdf.rows, "bank", () => undefined);
    expect(appendToReview(list, teb.rows, "bank", () => undefined).length === list.length).toBe(true);
    // legacy-style generic rows all collide on date + amount and start unselected
    const generic = appendToReview(list, g.rows, "bank", () => undefined).slice(list.length);
    expect(generic.length > 0 && generic.every((r) => r.flags.listDuplicate && !r.selected)).toBe(true);
    const intake = intakeSpreadsheet(book, { file: "t.xlsx", month: MONTH, layouts: [{ id: "l", layout: LAYOUT }], rules });
    expect(intake.kind === "bank" && intake.card.knownRows?.length === teb.rows.length).toBe(true);
    expectFacts("tebx", {
      mapping: [m.header, m.date, m.description, m.amount, m.balance, m.reference, m.mode],
      generic: [g.rows.length, g.issues.length, g.issues[0]?.line, g.ignored],
      buckets: [count("patient_receipts"), count("fees"), count("other_expense")],
    });
  });

  it("§14.2 clinic workbook: receipts, expenses, cash", () => {
    const book = files.wb as SheetBook;
    expect(book).toBeDefined();
    const p = parseWorkbook(book, { file: "wb.xlsx", month: MONTH, layout: LAYOUT, rules });
    const rec = p.rows.filter((r) => r.kind === "workbook_receipts").sort((a, b) => a.date.localeCompare(b.date));
    expect(rec.every((r) => r.legacyAccount === "Karma" && r.selected && r.bucket === "patient_receipts")).toBe(true);
    const idx = (k: string) => Number(k.split(":").pop());
    const exp = p.rows
      .filter((r) => r.kind === "workbook_expense")
      .sort((a, b) => a.date.localeCompare(b.date) || idx(a.key) - idx(b.key));
    expect(exp.every((r) => r.legacyAccount === "Nakit" && r.selected && r.signedCents < 0 && !r.meta.fxApplied && !r.meta.formulaCellEmpty)).toBe(true);
    expect(p.rows.every((r) => r.key.startsWith("clinic:" + r.date + ":"))).toBe(true);
    const cash = workbookCashBalance(book, LAYOUT, MONTH, "wb.xlsx");
    expect(cash.error === null && cash.source?.importKey === "clinic-cash").toBe(true);
    // the month comes from the picker
    const sep = parseWorkbook(book, { file: "wb.xlsx", month: "2026-09", layout: LAYOUT, rules });
    expect(sep.rows.every((r) => r.key.startsWith("clinic:2026-09-"))).toBe(true);
    expect(sep.rows.some((r) => r.date === "2026-09-31")).toBe(false);
    expectFacts("workbook", {
      sheets: book.names.length,
      rates: workbookRates(book, LAYOUT),
      receipts: [rec.length, sum(rec.map((r) => r.amount))],
      receipts_digest: digest(rec.map((r) => `${r.date}|${r.amount}|${r.meta.contributingRows}|${!!r.meta.fxApplied}`)),
      expenses: [exp.length, sum(exp.map((r) => r.amount))],
      expenses_digest: digest(exp.map((r) => `${r.key.replace(/^clinic:/, "")}|${r.amount}|${r.bucket}`)),
      active_days: cash.activeDays,
      cash: [cash.source?.day, cash.source?.amountCents],
      issues: p.issues.length,
    });
  });

  it.skipIf(!RULES_FILE)("§14.2 workbook with the clinic's own name rules (DENTOS_FINANCE_SAMPLE_RULES)", () => {
    const cfg = JSON.parse(readFileSync(RULES_FILE as string, "utf8")) as { entitlementRules: { pattern: string }[]; physicianNames: string[] };
    const extra: ClassificationRule[] = [...cfg.entitlementRules.map((r) => entitlementRule(r.pattern)), ...cfg.physicianNames.map(physicianRule)];
    const p = parseWorkbook(files.wb as SheetBook, { file: "wb.xlsx", month: MONTH, layout: LAYOUT, rules: compileRules([...SEED_RULES, ...extra]) });
    const doctor = p.rows.filter((r) => r.bucket === "doctor");
    const bank = parseBankText(files.pdf.TEB.text, "t.pdf", compileRules([...SEED_RULES, ...extra]));
    expect(bank.rows.some((r) => r.bucket === "doctor")).toBe(false);
    expect(doctor.filter((r) => !r.requiresEntitlementMonth).every((r) => r.counterpartyId === null)).toBe(true);
    expectFacts("rules", {
      entitlement_rows: doctor.filter((r) => r.requiresEntitlementMonth && !r.selected && r.warnings[0]?.code === "W_ENTITLEMENT_MONTH").length,
      physician_selected: doctor.filter((r) => !r.requiresEntitlementMonth && r.selected).length,
    });
  });

  it("§14.6 financing statements: grouping, normalisation, coverage against the workbook", () => {
    const items = files.financing.flatMap((f) => f.items);
    expect(items.length > 0 && items.every((i) => /^\d{4}-\d{8}-1$/.test(i.reference))).toBe(true);
    expect(new Set(items.map((i) => `${i.reference}:${i.date}`)).size === items.length).toBe(true);
    const line = (i: FinancingItem) => {
      const fee = i.commission + i.kkdf + i.bsmv;
      return `${i.date}|${i.gross}|${i.commission}|${i.kkdf}|${i.bsmv}|${fee}|${i.gross - fee}`;
    };
    // the general import refuses both files
    for (const f of files.financing)
      expect(intakeSpreadsheet(f.book, { file: "f.xlsx", month: MONTH, layouts: [{ id: "l", layout: LAYOUT }], rules }).kind === "financing_refused").toBe(true);
    // coverage: per day, workbook receipts ≥ financing gross
    const rec = parseWorkbook(files.wb as SheetBook, { file: "wb.xlsx", month: MONTH, layout: LAYOUT, rules }).rows.filter(
      (r) => r.kind === "workbook_receipts",
    );
    expect(items.every((i) => (rec.find((r) => r.date === i.date)?.amount ?? 0) >= i.gross)).toBe(true);
    expectFacts("financing", {
      loans: files.financing.map((f) => f.items.length),
      digest: digest(items.map(line)),
    });
  });
});

/** Legacy read options (IP:41, BG:9) without DentOS's resource limits. */
type LegacyX = { read: (d: unknown, o: object) => { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_json: (ws: unknown, o: object) => unknown[][] } };
const cellEq = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : typeof a === typeof b && (a === b || (Number.isNaN(a) && Number.isNaN(b)));

describe.skipIf(!enabled || !LEGACY_XLSX)("SheetJS reader parity with legacy xlsx@0.18.5 (critique 10)", () => {
  beforeAll(load, 120000);
  it("every sample spreadsheet gives the same cell arrays", async () => {
    const mod = (await import(pathToFileURL(LEGACY_XLSX as string).href)) as Partial<LegacyX> & { default?: LegacyX };
    const legacy = (typeof mod.read === "function" ? mod : mod.default) as LegacyX;
    expect(files.sheetsRead.length > 0).toBe(true);
    for (const [fi, f] of files.sheetsRead.entries()) {
      const ours = await readSpreadsheetFile(f.data, f.name, f.mode);
      const opts = f.mode === "general" ? { type: "array", cellStyles: false, cellFormula: false, cellDates: true } : { type: "array", cellDates: true };
      const lb = legacy.read(f.data, opts);
      expect(lb.SheetNames.length === ours.names.length && lb.SheetNames.every((n, i) => n === ours.names[i]), `dosya ${fi}: sayfa listesi`).toBe(true);
      for (const [si, name] of lb.SheetNames.entries()) {
        const theirs = legacy.utils.sheet_to_json(lb.Sheets[name], f.mode === "general" ? { header: 1, defval: null, raw: true } : { header: 1, defval: null });
        const mine = ours.sheets[name];
        expect(theirs.length === mine.length, `dosya ${fi}, sayfa ${si}: satır sayısı`).toBe(true);
        for (let r = 0; r < theirs.length; r++) {
          expect(theirs[r].length === mine[r].length, `dosya ${fi}, sayfa ${si}, satır ${r}: sütun sayısı`).toBe(true);
          for (let c = 0; c < theirs[r].length; c++)
            if (!cellEq(theirs[r][c], mine[r][c])) expect.fail(`dosya ${fi}, sayfa ${si}, satır ${r}, sütun ${c}: hücre farklı`);
        }
      }
    }
  });
});
