import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  bankTableKey,
  bankTablePreKey,
  financingKey,
  fingerprintPayload,
  importCounterparty,
  importedEntryId,
  importFingerprint,
  importSubcategory,
  knownBankKey,
  legacySubcategory,
  sha256hex,
  uuidShape,
  workbookExpenseKey,
  workbookReceiptsKey,
} from "../keys";
import { trNumber } from "../primitives";

// Every value below is synthetic (no figure from the clinic's files). Expected hashes are computed here with node's
// own SHA-256 over the expected JSON literal, so the vectors check the payload bytes independently of the code.
const nodeSha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describe("sha256hex", () => {
  it("equals node crypto over UTF-8", async () => {
    for (const s of ["", "abc", "Günlük toplam ışğüçö’", "bank-table:abc:1"])
      expect(await sha256hex(s)).toBe(createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"));
  });
});

describe("key templates (§9.1)", () => {
  it("workbook keys", () => {
    expect(workbookReceiptsKey("2026-03-02")).toBe("clinic:2026-03-02:receipts");
    expect(workbookExpenseKey("2026-03-03", 4)).toBe("clinic:2026-03-03:expense:5");
  });
  it("known-bank vectors", () => {
    expect(knownBankKey("Garanti:111-2222222", "2026-03-03", -2.9, "1.234,50", "")).toBe(
      "bank:Garanti:111-2222222:2026-03-03:-2.9:1.234,50:",
    );
    expect(knownBankKey("TEB:999", "2026-03-06", trNumber("2.500,00"), "14.845,67")).toBe("bank:TEB:999:2026-03-06:2500:14.845,67:");
    expect(knownBankKey("TEB:999", "2026-03-06", trNumber("-0,46"), "1,00")).toBe("bank:TEB:999:2026-03-06:-0.46:1,00:");
    expect(knownBankKey("TEB:999", "2026-03-06", -trNumber("1.000.000,10"), "1,00")).toBe("bank:TEB:999:2026-03-06:-1000000.1:1,00:");
    expect(knownBankKey("Garanti:111-2222222", "2026-03-12", -73.15, "27.413,09", "fee")).toBe(
      "bank:Garanti:111-2222222:2026-03-12:-73.15:27.413,09:fee",
    );
    expect(financingKey("1234-56789012-1", "2026-03-05")).toBe("burgan-finance:1234-56789012-1:2026-03-05");
  });
  it("generic-table vectors K1-K3 (TBT:6)", async () => {
    const k1 = JSON.stringify(["testbankatr123", "2026-10-02", -1250025, "kira", 8749975]);
    expect(bankTablePreKey(k1, 1)).toBe(
      "bank-table:%5B%22testbankatr123%22%2C%222026-10-02%22%2C-1250025%2C%22kira%22%2C8749975%5D:1",
    );
    expect(await bankTableKey(k1, 1)).toBe("bank-table:fd241e64fa5f4ff04cf29fd700b8fe2c3c778c89b8d7e0f5936f3af5be1f8f55");
    const k2 = JSON.stringify(["testbankatr123", "2026-10-03", 800000, "pos yatisi", 9549975]);
    expect(await bankTableKey(k2, 1)).toBe("bank-table:b075cd87096cca31c9836368cf7d4c3a968be0fc70806bda48b40e2a0f51cb9f");
    expect(await bankTableKey(k2, 2)).toBe("bank-table:47dfe767da788da73a418d363a04dc39c0d03a989dd2ab66e4da37eec20963e1");
  });
});

describe("fingerprint (§9.3)", () => {
  it("F1 receipts: exact JSON string and hash", async () => {
    const input = {
      bucket: "patient_receipts" as const,
      categoryName: "x",
      isSystem: true,
      subcategory: null,
      counterparty: "Günlük toplam",
      description: "Klinik günlük toplam tahsilat",
      date: "2026-03-02",
      amount: 3216750,
      entitlementMonth: null,
      legacyAccount: "Karma" as const,
    };
    const json =
      '{"details":{"category":"Hasta tahsilatı","counterparty":"Günlük toplam","description":"Klinik günlük toplam tahsilat","dueDate":"2026-03-02","amountCents":3216750},"paid":3216750,"paymentDate":"2026-03-02","account":"Karma"}';
    expect(fingerprintPayload(input)).toBe(json);
    expect(await importFingerprint(input)).toBe(nodeSha(json));
  });
  it("F2 fees: counterparty and description are trimmed", async () => {
    expect(
      await importFingerprint({
        bucket: "fees",
        categoryName: "renamed",
        isSystem: true,
        subcategory: null,
        counterparty: "POS komisyonu test ",
        description: " POS komisyonu test",
        date: "2026-03-06",
        amount: 3625,
        entitlementMonth: null,
        legacyAccount: "Banka",
      }),
    ).toBe(
      nodeSha(
        '{"details":{"category":"Faiz / banka masrafı","counterparty":"POS komisyonu test","description":"POS komisyonu test","dueDate":"2026-03-06","amountCents":3625},"paid":3625,"paymentDate":"2026-03-06","account":"Banka"}',
      ),
    );
  });
  it("F3 doctor with past entitlement month: key order subcategory/entitlementMonth", async () => {
    const input = {
      bucket: "doctor" as const,
      categoryName: "x",
      isSystem: true,
      subcategory: importSubcategory("doctor", "Hekim A ödeme", "2026-03-11", "2026-02"),
      counterparty: "Hekim A",
      description: "Hekim A ödeme",
      date: "2026-03-11",
      amount: 4250000,
      entitlementMonth: "2026-02",
      legacyAccount: "Nakit" as const,
    };
    expect(input.subcategory).toBe("past_physician_debt");
    const json =
      '{"details":{"category":"Hekim hakedişi","subcategory":"Geçmiş dönem hekim hakedişi borç ödemesi","counterparty":"Hekim A","description":"Hekim A ödeme","dueDate":"2026-03-11","amountCents":4250000,"entitlementMonth":"2026-02"},"paid":4250000,"paymentDate":"2026-03-11","account":"Nakit"}';
    expect(fingerprintPayload(input)).toBe(json);
    expect(await importFingerprint(input)).toBe(nodeSha(json));
  });
  it("F4 official fee", async () => {
    const description = "teftiş defteri ödemesi";
    expect(
      await importFingerprint({
        bucket: "other_expense",
        categoryName: "x",
        isSystem: true,
        subcategory: importSubcategory("other_expense", description, "2026-03-03", null),
        counterparty: importCounterparty({ bucket: "other_expense", description, receiptsCounterpartyText: "Günlük toplam" }),
        description,
        date: "2026-03-03",
        amount: 9050,
        entitlementMonth: null,
        legacyAccount: "Banka",
      }),
    ).toBe(
      nodeSha(
        '{"details":{"category":"Diğer faaliyet gideri","subcategory":"Resmi harç","counterparty":"teftiş defteri ödemesi","description":"teftiş defteri ödemesi","dueDate":"2026-03-03","amountCents":9050},"paid":9050,"paymentDate":"2026-03-03","account":"Banka"}',
      ),
    );
  });
  it("non-system categories hash their own name", () => {
    const s = fingerprintPayload({
      bucket: "other_expense",
      categoryName: "Özel gider",
      isSystem: false,
      subcategory: null,
      counterparty: "a",
      description: "a",
      date: "2026-03-02",
      amount: 1,
      entitlementMonth: null,
      legacyAccount: "Nakit",
    });
    expect(s.startsWith('{"details":{"category":"Özel gider","counterparty"')).toBe(true);
  });
  it("counterparty and subcategory rules (IP:54)", () => {
    expect(importCounterparty({ bucket: "patient_receipts", description: "POS", receiptsCounterpartyText: "Günlük toplam" })).toBe("Günlük toplam");
    expect(importCounterparty({ bucket: "doctor", description: "x", counterpartyName: "Hekim", receiptsCounterpartyText: "G" })).toBe("Hekim");
    expect(importCounterparty({ bucket: "rent", description: "k".repeat(300), receiptsCounterpartyText: "G" })).toHaveLength(200);
    expect(importSubcategory("doctor", "x", "2026-03-11", null)).toBe("current_physician");
    expect(importSubcategory("doctor", "x", "2026-03-11", "2026-03")).toBe("current_physician");
    expect(importSubcategory("rent", "teftiş defteri", "2026-03-11", null)).toBe(null);
  });
  it("official fee is legacy's raw-text test; a rule never sets it (§10.2, IP:54)", () => {
    // Legacy /teftiş defteri/i is not unicode-aware: the dotted capital 'TEFTİŞ' does not match.
    expect(legacySubcategory("other_expense", "TEFTİŞ DEFTERİ ÖDEMESİ")).toBe(null);
    expect(legacySubcategory("other_expense", "Teftiş Defteri ödemesi")).toBe("official_fee");
    expect(legacySubcategory("fees", "teftiş defteri")).toBe(null);
    expect(importSubcategory("other_expense", "TEFTİŞ DEFTERİ ÖDEMESİ", "2026-03-11", null, null)).toBe(null);
    // An explicit review-table choice is kept (documented departure: the user picked 'Resmi harç').
    expect(importSubcategory("other_expense", "harç", "2026-03-11", null, "official_fee")).toBe("official_fee");
  });
});

describe("deterministic ids", () => {
  it("uuid shape of sha256(clinic|key)", async () => {
    const h = createHash("sha256").update("c1|clinic:2026-03-02:receipts").digest("hex");
    const id = await importedEntryId("c1", "clinic:2026-03-02:receipts");
    expect(id).toBe(uuidShape(h));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
