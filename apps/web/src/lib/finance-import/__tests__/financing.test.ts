import { describe, expect, it } from "vitest";
import {
  financingFee,
  financingNet,
  hasFinancingMarker,
  isFinancingLine,
  loanKey,
  parseFinancing,
  proposedRelease,
  toFinancingPayload,
  validateFinancingItem,
} from "../financing";
import type { SheetBook } from "../types";
import { uuidShape } from "../keys";
import { createHash } from "node:crypto";

// Synthetic references and names only (TBU:6-8 shape).
const header = ["İşlem Tarihi", "Döviz Cinsi", "İşlem Tutarı", "İşlem Açıklaması", "Son Bakiye"];
const sample = (): unknown[][] => [
  [""],
  header,
  ["05/03/2026", "TRY", -2193.06, "1050-12345678-1 TEST Bayi Katkı Faizi KKDF", 66064.42],
  ["05/03/2026", "TRY", -2193.06, "1050-12345678-1 TEST Bayi Katkı Faizi BSMV", 68257.48],
  ["05/03/2026", "TRY", -14620.4, "1050-12345678-1 TEST Bayi Katkı Faizi", 70450.54],
  ["05/03/2026", "TRY", 85000, "123-TEST 1050-12345678-351 hesaba TRY KK", 85070.94],
];
const book = (rows: unknown[][], name = "Sheet1"): SheetBook => ({ names: [name], sheets: { [name]: rows } });

describe("financing parser (BF:10-31, TBU)", () => {
  it("groups the transfer and three deductions by loan, independent of file name and order", () => {
    const a = parseFinancing(book(sample()), "a.xlsx");
    expect(a.items).toHaveLength(1);
    const item = a.items[0];
    expect(item.gross).toBe(8500000);
    expect(item.commission).toBe(1462040);
    expect(item.kkdf).toBe(219306);
    expect(item.bsmv).toBe(219306);
    expect(financingFee(item)).toBe(1900652);
    expect(financingNet(item)).toBe(6599348);
    expect(item.reference).toBe("1050-12345678-1");
    expect(item.name).toBe("TEST");
    expect(item.date).toBe("2026-03-05");
    const rows = sample();
    const b = parseFinancing(book([header, ...rows.slice(2).reverse()], "S"), "renamed.xlsx");
    expect(b.items[0].gross).toBe(item.gross);
  });
  it("partial or duplicated lines fail instead of guessing", () => {
    const a = sample();
    a.pop();
    expect(() => parseFinancing(book(a), "a")).toThrow(/eksik/);
    const b = sample();
    b.push(b[2]);
    expect(() => parseFinancing(book(b), "b")).toThrow(/birden fazla kkdf/);
  });
  it("TRY only; unreadable lines stop the file; lines without a reference are skipped with a warning", () => {
    const fx = sample();
    fx[2] = ["05/03/2026", "EUR", -1, "1050-12345678-1 TEST Bayi Katkı Faizi KKDF", 0];
    expect(() => parseFinancing(book(fx), "x")).toThrow(/para birimi/);
    const extra = [...sample(), ["06/03/2026", "TRY", -5, "masraf", 0]];
    expect(parseFinancing(book(extra), "x").warnings).toEqual(["2026-03-06: finansman referansı olmayan hareket atlandı; genel banka aktarımından kontrol edin."]);
    expect(() => parseFinancing(book([header, ["05/03/2026", "TRY", 1, "x", 0]]), "x")).toThrow(/tablosu bulunamadı/);
  });
  it("fee bounds and blocked release dates", () => {
    const item = parseFinancing(book(sample()), "a").items[0];
    expect(validateFinancingItem({ ...item, blocked: false, expectedRelease: null })).toBe(null);
    expect(validateFinancingItem({ ...item, blocked: true, expectedRelease: null })).toMatch(/çözülme/);
    expect(validateFinancingItem({ ...item, blocked: true, expectedRelease: "2026-03-01" })).toMatch(/önce/);
    expect(validateFinancingItem({ ...item, commission: item.gross, blocked: false, expectedRelease: null })).toMatch(/Kesinti/);
    expect(proposedRelease("2026-03-05", 30)).toBe("2026-04-04");
  });
  it("markers and the forward block", () => {
    expect(hasFinancingMarker(book(sample()))).toBe(true);
    expect(hasFinancingMarker(book([["x"]]))).toBe(false);
    expect(loanKey("1050-12345678-351")).toBe("1050-12345678");
    expect(isFinancingLine("havale 1050-12345678-351", ["1050-12345678"])).toBe(true);
    expect(isFinancingLine("BAYİ KATKI FAİZİ", [])).toBe(false); // legacy /i does not fold İ
    expect(isFinancingLine("Bayi Katkı Faizi", [])).toBe(true);
    expect(isFinancingLine("kira", ["1050-12345678"])).toBe(false);
  });
  it("payload for fin_financing_import", async () => {
    const item = parseFinancing(book(sample()), "a.xlsx").items[0];
    const p = await toFinancingPayload(item, { clinicId: "c1", blocked: true, expectedRelease: "2026-04-04" });
    expect(Object.keys(p)).toEqual([
      "id",
      "entry_id",
      "provider",
      "reference",
      "patient_name_raw",
      "txn_date",
      "currency",
      "gross_cents",
      "commission_cents",
      "kkdf_cents",
      "bsmv_cents",
      "blocked",
      "expected_release",
      "file",
    ]);
    expect(p.id).not.toBe(p.entry_id);
    expect(p.expected_release).toBe("2026-04-04");
    expect(p.provider).toBe("burgan");
    // Deterministic ids the database recomputes (fin__import_id): sha256('<clinic>|financing|<key>') / ('<clinic>|<key>').
    const key = "burgan-finance:1050-12345678-1:2026-03-05";
    expect(p.id).toBe(uuidShape(createHash("sha256").update("c1|financing|" + key).digest("hex")));
    expect(p.entry_id).toBe(uuidShape(createHash("sha256").update("c1|" + key).digest("hex")));
  });
});
