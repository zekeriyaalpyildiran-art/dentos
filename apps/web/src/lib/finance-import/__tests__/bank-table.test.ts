import { describe, expect, it } from "vitest";
import { headerSignature, MAPPING_ERRORS, parseBankTable, pasteTable, pdfTable, suggestMapping, type BankTable } from "../bank-table";
import type { PdfCell } from "../types";
import { seedRules } from "./fixtures";

const rules = seedRules();
const table: BankTable = {
  name: "Hareketler",
  rows: [
    ["Bilinmeyen banka"],
    ["İşlem Tarihi", "Açıklama", "Borç", "Alacak", "Bakiye"],
    ["02.10.2026", "Kira", "12.500,25", "", "87.499,75"],
    ["03.10.2026", "POS yatışı", "", "8.000,00", "95.499,75"],
  ],
};
const mapping = { ...suggestMapping(table.rows), account: "Test Banka TR123" };

describe("generic table mapper (TBT:6-14)", () => {
  it("split columns, header offset, inflows unselected", async () => {
    expect(mapping.header).toBe(1);
    expect(mapping.mode).toBe("split");
    expect([mapping.date, mapping.description, mapping.debit, mapping.credit, mapping.balance]).toEqual([0, 1, 2, 3, 4]);
    const p = await parseBankTable(table, mapping, "banka.xlsx", rules);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].amount).toBe(1250025);
    expect(p.rows[0].signedCents).toBe(-1250025);
    expect(p.rows[1].amount).toBe(800000);
    expect(p.rows.every((r) => !r.selected)).toBe(true);
    expect(p.rows[1].bucket).toBe("patient_receipts");
    expect(p.rows[0].bucket).toBe("rent");
    expect(p.rows[0].sourceKind).toBe("bank_table");
    expect(p.rows[0].key).toBe("bank-table:fd241e64fa5f4ff04cf29fd700b8fe2c3c778c89b8d7e0f5936f3af5be1f8f55");
    expect(p.rows[1].key).toBe("bank-table:b075cd87096cca31c9836368cf7d4c3a968be0fc70806bda48b40e2a0f51cb9f");
    expect(p.rows[0].warnings[0].text.startsWith("Banka çıkışı · Hareketler, satır 3.")).toBe(true);
  });
  it("stable keys across file names and overlapping exports", async () => {
    const a = (await parseBankTable(table, mapping, "first.xlsx", rules)).rows;
    const b = (await parseBankTable(table, mapping, "renamed.pdf", rules)).rows;
    expect(a.map((r) => r.key)).toEqual(b.map((r) => r.key));
    const partial = { name: "Partial", rows: [table.rows[1], table.rows[3]] };
    expect((await parseBankTable(partial, { ...mapping, header: 0 }, "part.csv", rules)).rows[0].key).toBe(a[1].key);
  });
  it("identical rows are distinct occurrences", async () => {
    const p = await parseBankTable({ ...table, rows: [...table.rows, table.rows[3]] }, mapping, "x", rules);
    expect(p.rows).toHaveLength(3);
    expect(p.rows[2].key).toBe("bank-table:47dfe767da788da73a418d363a04dc39c0d03a989dd2ab66e4da37eec20963e1");
    expect(p.rows[2].meta.occurrence).toBe(2);
  });
  it("wrong dates, currencies, both debit/credit and duplicate columns are blocked", async () => {
    const t = { ...table, rows: [...table.rows, ["31.02.2026", "Ödeme", "100,00", "", "50,00"], ["04.10.2026", "Ödeme", "100,00", "50,00", "25,00"]] };
    expect((await parseBankTable(t, mapping, "x", rules)).issues).toHaveLength(2);
    const dup = await parseBankTable(table, { ...mapping, balance: mapping.debit }, "x", rules);
    expect(dup.rows).toHaveLength(0);
    expect(dup.issues[0].reason).toBe(MAPPING_ERRORS.duplicate);
    expect((await parseBankTable(table, { ...mapping, account: " " }, "x", rules)).rows).toHaveLength(0);
    const fx = { name: "FX", rows: [["Date", "Description", "Amount", "Currency"], ["2026-10-03", "Fee", "-20.00", "EUR"]] };
    const p = await parseBankTable(fx, { ...suggestMapping(fx.rows), format: "en", account: "FX" }, "x", rules);
    expect(p.rows).toHaveLength(0);
    expect(p.issues[0].reason).toMatch(/Döviz/);
  });
  it("direction column handles positive debit values", async () => {
    const t = { name: "Bank", rows: [["Tarih", "Açıklama", "Tutar", "B/A"], ["03.10.2026", "Vergi", "1.000,00", "B"], ["03.10.2026", "Giriş", "200,00", "A"], ["03.10.2026", "Bilinmeyen", "200,00", "?"]] };
    const m = { ...suggestMapping(t.rows), account: "A" };
    expect(m.mode).toBe("direction");
    const p = await parseBankTable(t, m, "x", rules);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].bucket).toBe("tax");
    expect(p.rows[0].signedCents).toBe(-100000);
    expect(p.issues).toHaveLength(1);
  });
  it("totals and opening lines are issues; blank rows are skipped; non-dated rows are ignored", async () => {
    const t = { name: "T", rows: [["Tarih", "Açıklama", "Tutar"], ["03.10.2026", "Devir bakiyesi", "5,00"], [null, "", ""], ["not a date", "", ""]] };
    const p = await parseBankTable(t, { ...suggestMapping(t.rows), account: "A" }, "x", rules);
    expect(p.issues).toHaveLength(1);
    expect(p.ignored).toBe(1);
  });
  it("positioned PDF text becomes a column table", async () => {
    const cell = (str: string, x: number, y: number): PdfCell => ({ str, transform: [1, 0, 0, 1, x, y], width: str.length * 5 });
    const t = pdfTable([[cell("Tarih", 30, 700), cell("Açıklama", 120, 700), cell("Borç", 330, 700), cell("Alacak", 420, 700), cell("03.10.2026", 30, 680), cell("Kira", 120, 680), cell("1.000,00", 330, 680)]]);
    const p = await parseBankTable(t, { ...suggestMapping(t.rows), account: "New bank" }, "x.pdf", rules);
    expect(p.rows[0].amount).toBe(100000);
  });
  it("paste and header signature", () => {
    expect(pasteTable("a\tb\r\nc\td\n").rows).toEqual([["a", "b"], ["c", "d"]]);
    expect(headerSignature(["Tarih", null, "Açıklama "])).toEqual(["tarih", "aciklama"]);
  });
});
