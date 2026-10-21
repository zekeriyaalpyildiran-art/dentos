import { describe, expect, it } from "vitest";
import { detectBank, pageHasText, parseBankText, pdfPagesText } from "../bank-text";
import { detectTebSheet, parseTebSheet } from "../bank-xlsx";
import { bankBalance } from "../balances";
import { intakePdf, intakeSpreadsheet } from "../detect";
import type { PdfCell } from "../types";
import { compileRules } from "../classify";
import { LAYOUT, rule, SEED_RULES, seedRules } from "./fixtures";

const rules = seedRules();

describe("known-bank text reader (FI:26-44, TFI:25-27)", () => {
  it("split PDF decimals; POS inflow unselected; commission split off", () => {
    const p = parseBankText("T. Garanti Bankası\nHesap Numarası\n: 123\n01.09.2026\nPOS K: 50,00\n+950\n,00 TL\n1.950\n,00 TL", "test.pdf", rules);
    expect(p.bank).toBe("Garanti");
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].amount).toBe(95000);
    expect(p.rows[0].selected).toBe(false);
    expect(p.rows[0].kind).toBe("bank_in");
    expect(p.rows[0].key).toBe("bank:Garanti:123:2026-09-01:950:1.950,00:");
    expect(p.rows[1].amount).toBe(5000);
    expect(p.rows[1].bucket).toBe("fees");
    expect(p.rows[1].selected).toBe(true);
    expect(p.rows[1].kind).toBe("bank_fee_split");
    expect(p.rows[1].key).toBe("bank:Garanti:123:2026-09-01:-50:1.950,00:fee");
  });
  it("0038: a hakediş-month rule's suggestion fills the month and selects the outflow", () => {
    const withRules = compileRules([
      ...SEED_RULES,
      rule(60, "bank", "contains", "örnek personel", "personnel", {
        counterparty_id: "cp-staff",
        requires_entitlement_month: true,
        entitlement_month_default: "from_text",
      }),
      rule(61, "bank", "contains", "örnek hekim", "doctor", { requires_entitlement_month: true, entitlement_month_default: "same" }),
    ]);
    const text = [
      "T. Garanti Bankası",
      "Hesap Numarası : 7",
      "05.10.2026",
      "ÖRNEK PERSONEL EYLÜL MAAŞ",
      "-15.000,00",
      "80.000,00 TL",
      "06.10.2026",
      "ÖRNEK HEKİM AVANS",
      "-2.000,00",
      "78.000,00 TL",
    ].join("\n");
    const p = parseBankText(text, "g.pdf", withRules);
    expect(p.rows.map((r) => [r.bucket, r.entitlementMonth, r.ruleEntitlementMonth, r.selected, r.counterpartyId])).toEqual([
      ["personnel", "2026-09", "2026-09", true, "cp-staff"],
      ["doctor", "2026-10", "2026-10", true, null],
    ]);
    expect(p.rows[0].meta).toEqual({ line: 3 });
  });
  it("0038: the rule's own text (a made-up payee named like a month) is not read as the hakediş month", () => {
    const withRules = compileRules([
      ...SEED_RULES,
      rule(60, "bank", "contains", "örnek kasım", "doctor", { requires_entitlement_month: true, entitlement_month_default: "from_text" }),
    ]);
    const text = ["T. Garanti Bankası", "Hesap Numarası : 7", "05.11.2026", "ÖRNEK KASIM EKİM HAKEDİŞİ", "-15.000,00", "80.000,00 TL"].join("\n");
    const p = parseBankText(text, "g.pdf", withRules);
    expect(p.rows.map((r) => [r.bucket, r.entitlementMonth, r.selected])).toEqual([["doctor", "2026-10", true]]);
  });
  it("TEB needs value-date and time lines; description skips them", () => {
    const text = [
      "Türk Ekonomi Bankası A.Ş.",
      "Hesap No: 999",
      "05/03/2026 tarihi itibarıyla devir",
      "12.345,67",
      "06.03.2026",
      "06.03.2026",
      "11:15",
      "POS SATIŞ",
      "2.500,00",
      "14.845,67",
      "06.03.2026",
      "06.03.2026",
      "11:15",
      "POS KOMİSYON",
      "-36,25",
      "14.809,42",
      "teb.com.tr",
    ].join("\n");
    const p = parseBankText(text, "teb.pdf", rules);
    expect(p.bank).toBe("TEB");
    expect(p.rows.map((r) => r.key)).toEqual(["bank:TEB:999:2026-03-06:2500:14.845,67:", "bank:TEB:999:2026-03-06:-36.25:14.809,42:"]);
    expect(p.rows[0].description).toBe("POS SATIŞ");
    expect(p.rows[1].selected).toBe(true);
  });
  it("VakıfBank description follows the balance and stops at the footer", () => {
    const text = "VakıfBank\nVakiflar Bankası\nHesap No: 555\n04.03.2026\n-410,00\n21.004,16\nPOS YAZILIM BAKIM\nayrıntı\n***Dekont footer";
    const p = parseBankText(text, "v.pdf", rules);
    expect(p.bank).toBe("VakıfBank");
    expect(p.rows[0].description).toBe("POS YAZILIM BAKIM ayrıntı");
    expect(p.rows[0].key).toBe("bank:VakıfBank:555:2026-03-04:-410:21.004,16:");
  });
  it("unknown bank and empty statements throw legacy texts", () => {
    expect(() => parseBankText("Some bank\n01.10.2026\n1,00\n2,00", "x.pdf", rules)).toThrow(/banka biçimi tanınmadı/);
    expect(() => parseBankText("T. Garanti Bankası\nnothing", "x.pdf", rules)).toThrow(/işlem satırı okunamadı/);
  });
  it("detection: the header/footer zone wins over narrations naming another bank (D5)", () => {
    const body = Array.from({ length: 40 }, (_, i) => (i === 20 ? "GELEN EFT T. Garanti Bankası" : `satır ${i}`));
    const text = ["TÜRK EKONOMİ BANKASI", ...body, "www.teb.com.tr"].join("\n");
    expect(detectBank(text)).toBe("TEB");
    expect(detectBank(["başlık", ...body].join("\n"))).toBe("Garanti"); // legacy order over the whole text
    expect(detectBank("nothing")).toBe("");
  });
  it("PDF header balance (BI:3-11): first 'Bakiye … TL', latest period end, masked label", () => {
    const text = "T. Garanti Bankası\nHesap Numarası : 111-2222222\nDönem\n01.02.2026 - 12.03.2026\nBakiye : 27.413\n,09 TL\nKullanılabilir Bakiye : 99,00 TL";
    const b = bankBalance(text, "g.pdf");
    expect(b).toEqual({
      kind: "bank",
      importKey: "Garanti:111-2222222",
      label: "Garanti · …2222",
      day: "2026-03-12",
      amountCents: 2741309,
      file: "g.pdf",
      note: "Dökümdeki hesap bakiyesi; kullanılabilir limit veya işlem toplamı değildir.",
    });
    expect(bankBalance("T. Garanti Bankası\nBakiye : 1,00 TL", "x")).toBe(null);
  });
  it("page text and scanned check (IP:36-38)", () => {
    const cell = (str: string): PdfCell => ({ str, transform: [1, 0, 0, 1, 0, 0], width: 1 });
    expect(pdfPagesText([[cell("a"), cell("b")], [cell("c")]])).toBe("a\nb\n\nc\n\n");
    expect(pageHasText([cell("x".repeat(49))])).toBe(false);
    expect(pageHasText([cell("x".repeat(50))])).toBe(true);
    const out = intakePdf([[cell("short")]], { file: "s.pdf", rules });
    expect(out.scanned).toBe(true);
    expect(out.card.knownRows).toBeUndefined();
    expect(out.card.notice).toMatch(/okunabilir metin yok/);
  });
});

describe("TEB spreadsheet reader (§6.1, D6)", () => {
  const sheet = (): unknown[][] => [
    ["Hesap Hareketleri", null],
    ["Hesap Numarası", "12 345"],
    ["Bakiye", "14.807,72 TL"],
    ["01/03/2026 - 12/03/2026", null],
    ["Tarih", "Valör", "Saat", "x", "Açıklama", "Banka", "Tutar", "Bakiye", "Dekont"],
    ["", "", "", "", "devir", "", "", 12345.67, ""],
    ["06.03.2026", "06.03.2026", "11:15", "", "POS SATIŞ", "TÜRK EKONOMİ BANKASI A.Ş", 2500, 12345.67 + 2500, "1"],
    ["06.03.2026", "06.03.2026", "11:15", "", "POS BSMV", "TÜRK EKONOMİ BANKASI A.Ş", 1.1 - 2.8000000000000003, 12345.67 + 2500 - 1.7, "1"],
    ["06.03.2026", "06.03.2026", "11:15", "", "POS KOMİSYON", "TÜRK EKONOMİ BANKASI A.Ş", -36.25, 12345.67 + 2500 - 1.7 - 36.25 + 1e-11, "1"],
    ["footer"],
  ];
  it("emits TEB PDF-identical keys and the header balance", () => {
    const t = sheet();
    const layout = detectTebSheet(t)!;
    expect(layout).not.toBe(null);
    const r = parseTebSheet(t, layout, "teb.xlsx", rules);
    expect(r.rows.map((x) => x.key)).toEqual([
      "bank:TEB:12345:2026-03-06:2500:14.845,67:",
      "bank:TEB:12345:2026-03-06:-1.7:14.843,97:",
      "bank:TEB:12345:2026-03-06:-36.25:14.807,72:",
    ]);
    expect(r.rows[0].selected).toBe(false);
    expect(r.rows[1].selected).toBe(true);
    expect(r.balance?.amountCents).toBe(1480772);
    expect(r.balance?.day).toBe("2026-03-12");
    expect(r.balance?.importKey).toBe("TEB:12345");
  });
  it("drops the header balance when it disagrees with the last movement", () => {
    const t = sheet();
    t[2] = ["Bakiye", "1,00 TL"];
    const r = parseTebSheet(t, detectTebSheet(t)!, "teb.xlsx", rules);
    expect(r.balance).toBe(null);
    expect(r.balanceNote).toMatch(/uyuşmuyor/);
  });
  it("a numeric account cell (lost zeros / formatting) falls back to the generic mapper", () => {
    const t = sheet();
    t[1] = ["Hesap Numarası", 12345];
    expect(detectTebSheet(t)).toBe(null);
    t[1] = ["Hesap Numarası", "012-345"];
    expect(detectTebSheet(t)?.account).toBe("012-345");
  });
  it("is detected only with the marker, header and account row", () => {
    const t = sheet().map((r) => r.map((c) => (typeof c === "string" ? c.replace("TÜRK EKONOMİ BANKASI A.Ş", "X") : c)));
    expect(detectTebSheet(t)).toBe(null);
  });
  it("intake: known rows plus the generic tables; financing files refused", () => {
    const out = intakeSpreadsheet({ names: ["S"], sheets: { S: sheet() } }, { file: "teb.xlsx", month: "2026-03", layouts: [{ id: "l1", layout: LAYOUT }], rules });
    expect(out.kind).toBe("bank");
    if (out.kind === "bank") {
      expect(out.card.knownRows).toHaveLength(3);
      expect(out.card.tables).toHaveLength(1);
      expect(out.balance?.amountCents).toBe(1480772);
    }
    const fin = intakeSpreadsheet({ names: ["S"], sheets: { S: [["x", "Bayi Katkı Faizi"]] } }, { file: "f.xlsx", month: "2026-03", layouts: [], rules });
    expect(fin.kind).toBe("financing_refused");
    const other = intakeSpreadsheet({ names: ["S"], sheets: { S: [["a"]] } }, { file: "o.csv", month: "2026-03", layouts: [], rules });
    expect(other.kind === "bank" && other.card.knownRows === undefined && other.notes[0].includes("hazır okuyucu bakiye bulamadı")).toBe(true);
  });
});
