import { describe, expect, it } from "vitest";
import { mergeSessionBalances, toBalancePayload } from "../balances";
import {
  acknowledgements,
  appendToReview,
  chosenRows,
  ENTITLEMENT_MONTH_REQUIRED,
  rowBlockers,
  saveProblems,
  selectedReceiptsCents,
  sortReview,
  toCheckPayload,
  toImportRowPayload,
  checkableRow,
  flagsFromCheck,
  keyDay,
  usesCounterparty,
  type RowCheck,
} from "../review";
import { fingerprintPayload, importFingerprint } from "../keys";
import { compileRules } from "../classify";
import { parseBankText } from "../bank-text";
import { physicianRule, SEED_RULES } from "./fixtures";
import type { BalanceSource, ParsedRow } from "../types";

const base: ParsedRow = {
  key: "k",
  kind: "bank_out",
  sourceKind: "bank_known",
  file: "f.pdf",
  date: "2026-10-06",
  description: "POS komisyonu",
  amount: 3625,
  signedCents: -3625,
  bucket: "fees",
  categoryId: "cat-fees",
  subcategory: null,
  counterpartyId: null,
  requiresEntitlementMonth: false,
  ruleId: null,
  legacyAccount: "Banka",
  accountImportKey: "TEB:1",
  selected: true,
  warnings: [],
  entitlementMonth: null,
  meta: {},
};
const mk = (p: Partial<ParsedRow>): ParsedRow => ({ ...base, ...p });
const ctx = { month: "2026-10", today: "2026-10-15" };

describe("review list (§3.4, §11)", () => {
  it("first occurrence wins; saved/duplicate/list-duplicate rows start unselected", () => {
    const checks: Record<string, RowCheck> = {
      saved: { status: "saved_same" },
      dup: { status: "new", warnings: [{ code: "possible_duplicate" }] },
    };
    let list = appendToReview([], [mk({ key: "a", amount: 100 }), mk({ key: "a", amount: 999 })], "workbook", (k) => checks[k]);
    expect(list).toHaveLength(1);
    expect(list[0].amount).toBe(100);
    list = appendToReview(list, [mk({ key: "saved" }), mk({ key: "dup" }), mk({ key: "same", amount: 100 }), mk({ key: "fresh", amount: 7 })], "bank", (k) => checks[k]);
    const by = Object.fromEntries(list.map((r) => [r.key, r]));
    expect(by.saved.selected).toBe(false);
    expect(by.dup.selected).toBe(false);
    expect(by.same.selected).toBe(false);
    expect(by.same.flags.listDuplicate).toBe(true);
    expect(by.fresh.selected).toBe(true);
    expect(acknowledgements(by.dup)).toEqual(["possible_duplicate"]);
    expect(acknowledgements(by.same)).toEqual(["batch_duplicate"]);
    expect(list.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
  it("blockers: outside month, future, saved, invalid; chosen rows", () => {
    const list = appendToReview(
      [],
      [
        mk({ key: "sep", date: "2026-09-30" }),
        mk({ key: "future", date: "2026-10-20" }),
        mk({ key: "empty", description: "  " }),
        mk({ key: "nocat", bucket: null, categoryId: null }),
        mk({ key: "ok" }),
        mk({ key: "changed", sourceKind: "clinic_excel" }),
      ],
      "workbook",
      (k) => (k === "changed" ? { status: "saved_changed", existing: { amount_cents: 1 } } : undefined),
    );
    const codes = Object.fromEntries(list.map((r) => [r.key, rowBlockers(r, ctx).map((b) => b.code)]));
    expect(codes).toEqual({ sep: ["outside_month"], future: ["future_date"], empty: ["invalid"], nocat: ["invalid"], ok: [], changed: ["saved"] });
    expect(chosenRows(list, ctx).map((r) => r.key)).toEqual(["ok"]);
    const changed = appendToReview([], [mk({ key: "clinic:2026-10-03:receipts" })], "workbook", () => ({ status: "saved_changed", existing: { amount_cents: 100 } }));
    expect(rowBlockers(changed[0], ctx)[0].text).toMatch(/^TUTAR DEĞİŞMİŞ: Kayıt 1,00 TL, dosya 36,25 TL/);
  });
  it("save problems, receipts total, sort order", () => {
    const list = appendToReview([], [mk({ key: "b", date: "2026-10-09", bucket: "patient_receipts", amount: 10 }), mk({ key: "a", date: "2026-10-01", bucket: "doctor", requiresEntitlementMonth: true })], "workbook", () => undefined);
    expect(saveProblems(list)).toEqual(["Hekim hakedişi ve personel ödemelerinde hakediş / maaş ayını seçin."]);
    expect(saveProblems([])).toEqual(["Aktarılacak satır seçin."]);
    // A doctor row matched to an open hakediş debt keeps the debt's period: no month needed (0037).
    const doctor = list.find((r) => r.key === "a")!;
    expect(saveProblems([{ ...doctor, match: { entry_id: "e" } }])).toEqual([]);
    expect(saveProblems([{ ...doctor, match: null }])).toEqual([ENTITLEMENT_MONTH_REQUIRED]);
    expect(selectedReceiptsCents(list)).toBe(10);
    expect(sortReview(list).map((r) => r.key)).toEqual(["a", "b"]);
  });
  it("import row payload: fingerprint, counterparty text, match rows", async () => {
    const row = appendToReview([], [mk({ key: "bank:TEB:1:2026-10-06:-36.25:1,00:", description: " POS komisyonu " })], "bank", () => undefined)[0];
    const category = { id: "cat-fees", bucket: "fees" as const, name: "Faiz / banka masrafı", is_system: true };
    const p = await toImportRowPayload(row, { rowNo: 1, clinicId: "c1", accountId: "acc", category, receiptsCounterpartyText: "Günlük toplam" });
    if (p.match !== null) throw new Error("expected a new-entry row");
    expect(p.counterparty_text).toBe("POS komisyonu");
    expect(p.direction).toBe("out");
    expect(p.fingerprint).toBe(
      await importFingerprint({ bucket: "fees", categoryName: "x", isSystem: true, subcategory: null, counterparty: " POS komisyonu ", description: " POS komisyonu ", date: "2026-10-06", amount: 3625, entitlementMonth: null, legacyAccount: "Banka" }),
    );
    const m = await toImportRowPayload(row, { rowNo: 1, clinicId: "c1", accountId: "acc", category, receiptsCounterpartyText: "G", match: { entry_id: "e", version: 2, payment_id: "p" } });
    expect("fingerprint" in m).toBe(false);
    expect(m.match).toEqual({ entry_id: "e", version: 2, payment_id: "p" });
    const c = await toCheckPayload(row, { rowNo: 1, clinicId: "c1", category: null, receiptsCounterpartyText: "G", withDescription: false });
    expect(c.fingerprint).toBe(null);
    expect(c.kind).toBe("bank_known");
    expect("description" in c).toBe(false); // unselected rows: no narration leaves the browser
    const d = await toCheckPayload(row, { rowNo: 1, clinicId: "c1", category, receiptsCounterpartyText: "G", withDescription: true });
    expect((d as { description?: string }).description).toBe("POS komisyonu");
    expect(d.fingerprint).toBe(p.fingerprint);
  });
});

describe("counterparty, key dates and the preflight scope", () => {
  it("a physician-rule bank row keeps the narration as counterparty and hashes as legacy (critique 16)", async () => {
    const rules = compileRules([...SEED_RULES, physicianRule("Hekim Örnek")]);
    const text = "T. Garanti Bankası\nHesap Numarası : 1\n03.03.2026\nHEKİM ÖRNEK ŞUBAT ÖDEMESİ\n-1.200,00\n5.000,00 TL";
    const parsed = parseBankText(text, "g.pdf", rules).rows[0];
    expect(parsed.bucket).toBe("doctor");
    expect(parsed.counterpartyId).toBe(null);
    const row = appendToReview([], [{ ...parsed, counterpartyId: "cp-doctor" }], "bank", () => undefined)[0];
    const category = { id: "cat-doctor", bucket: "doctor" as const, name: "Hekim hakedişi", is_system: true };
    const p = await toImportRowPayload(row, {
      rowNo: 1,
      clinicId: "c1",
      accountId: "acc",
      category,
      counterparty: { id: "cp-doctor", name: "Dr. Kayıt Adı" }, // ignored: not an entitlement row
      receiptsCounterpartyText: "Günlük toplam",
    });
    if (p.match !== null) throw new Error("expected a new-entry row");
    expect(p.counterparty_id).toBe(null);
    expect(p.counterparty_text).toBe("HEKİM ÖRNEK ŞUBAT ÖDEMESİ");
    expect(p.fingerprint).toBe(
      await importFingerprint({
        bucket: "doctor",
        categoryName: "x",
        isSystem: true,
        subcategory: "current_physician",
        counterparty: "HEKİM ÖRNEK ŞUBAT ÖDEMESİ",
        description: "HEKİM ÖRNEK ŞUBAT ÖDEMESİ",
        date: "2026-03-03",
        amount: 120000,
        entitlementMonth: null,
        legacyAccount: "Banka",
      }),
    );
    // Entitlement rows use the configured counterparty (its name is the fingerprint counterparty).
    const ent = { ...row, requiresEntitlementMonth: true, entitlementMonth: "2026-02" };
    const q = await toImportRowPayload(ent, { rowNo: 1, clinicId: "c1", accountId: "acc", category, counterparty: { id: "cp-owner", name: "Sahip" }, receiptsCounterpartyText: "G" });
    if (q.match !== null) throw new Error("expected a new-entry row");
    expect([q.counterparty_id, q.counterparty_text]).toEqual(["cp-owner", null]);
    expect(fingerprintPayload({ bucket: "doctor", categoryName: "x", isSystem: true, subcategory: "past_physician_debt", counterparty: "Sahip", description: ent.description, date: ent.date, amount: ent.amount, entitlementMonth: "2026-02", legacyAccount: "Banka" })).toContain('"counterparty":"Sahip"');
  });
  it("keys embedding a day pin the row date; the preflight only sees rows of the month", () => {
    expect(keyDay("clinic:2026-03-02:receipts")).toBe("2026-03-02");
    expect(keyDay("bank:TEB:12:2026-03-06:-1.7:1,00:")).toBe("2026-03-06");
    expect(keyDay("bank-table:abc")).toBe(null);
    const [row] = appendToReview([], [mk({ key: "clinic:2026-10-05:expense:3", sourceKind: "clinic_excel", date: "2026-10-05" })], "workbook", () => undefined);
    expect(rowBlockers(row, ctx)).toEqual([]);
    expect(rowBlockers({ ...row, date: "2026-10-06" }, ctx).map((b) => b.code)).toEqual(["key_date"]);
    expect(checkableRow({ date: "2026-10-05", amount: 1 }, "2026-10")).toBe(true);
    expect(checkableRow({ date: "2026-09-30", amount: 1 }, "2026-10")).toBe(false);
    expect(checkableRow({ date: "2026-10-32", amount: 1 }, "2026-10")).toBe(false);
    expect(checkableRow({ date: "2026-10-05", amount: 0 }, "2026-10")).toBe(false);
  });
});

describe("the salary month on Personel rows (0038)", () => {
  const personnel = { id: "cat-personnel", bucket: "personnel" as const, name: "Personel", is_system: true };
  const salary = mk({
    key: "bank:TEB:1:2026-10-05:-15000:80.000,00:",
    date: "2026-10-05",
    description: "ÖRNEK PERSONEL EYLÜL MAAŞ",
    amount: 1500000,
    signedCents: -1500000,
    bucket: "personnel",
    categoryId: "cat-personnel",
  });

  it("a rule-flagged Personel row needs the month, like a doctor row; unflagged rows do not", () => {
    const flagged = appendToReview([], [{ ...salary, requiresEntitlementMonth: true }], "bank", () => undefined);
    expect(saveProblems(flagged)).toEqual([ENTITLEMENT_MONTH_REQUIRED]);
    expect(saveProblems([{ ...flagged[0], entitlementMonth: "2026-09" }])).toEqual([]);
    expect(saveProblems(appendToReview([], [salary], "bank", () => undefined))).toEqual([]);
    // Other buckets never carry the month.
    expect(saveProblems(appendToReview([], [mk({ requiresEntitlementMonth: true })], "bank", () => undefined))).toEqual([]);
    expect(usesCounterparty({ requiresEntitlementMonth: true }, "personnel")).toBe(true);
    expect(usesCounterparty({ requiresEntitlementMonth: true }, "doctor")).toBe(true);
    expect(usesCounterparty({ requiresEntitlementMonth: true }, "rent")).toBe(false);
    expect(usesCounterparty({ requiresEntitlementMonth: false }, "personnel")).toBe(false);
  });

  it("the rule's counterparty and the month are saved and hashed; rows without them hash as before", async () => {
    const ctxBase = { rowNo: 1, clinicId: "c1", accountId: "acc", category: personnel, receiptsCounterpartyText: "G" };
    const cp = { id: "cp-staff", name: "Örnek Personel" };
    const row = { ...salary, requiresEntitlementMonth: true, counterpartyId: cp.id, entitlementMonth: "2026-09" };
    const p = await toImportRowPayload(row, { ...ctxBase, counterparty: cp });
    if (p.match !== null) throw new Error("expected a new-entry row");
    expect([p.counterparty_id, p.counterparty_text, p.entitlement_month, p.subcategory]).toEqual(["cp-staff", null, "2026-09", null]);
    expect(p.fingerprint).toBe(
      await importFingerprint({
        bucket: "personnel",
        categoryName: "x",
        isSystem: true,
        subcategory: null,
        counterparty: "Örnek Personel",
        description: row.description,
        date: row.date,
        amount: row.amount,
        entitlementMonth: "2026-09",
        legacyAccount: "Banka",
      }),
    );
    // An ordinary Personel row (no rule month, no month typed): narration counterparty, no month, the old hash.
    const plain = await toImportRowPayload(salary, { ...ctxBase, counterparty: cp });
    if (plain.match !== null) throw new Error("expected a new-entry row");
    expect([plain.counterparty_id, plain.counterparty_text, plain.entitlement_month]).toEqual([null, salary.description, null]);
    expect(plain.fingerprint).toBe(
      await importFingerprint({
        bucket: "personnel",
        categoryName: "x",
        isSystem: true,
        subcategory: null,
        counterparty: salary.description,
        description: salary.description,
        date: salary.date,
        amount: salary.amount,
        entitlementMonth: null,
        legacyAccount: "Banka",
      }),
    );
    // A month on a row moved to another bucket is not sent.
    const rent = { id: "cat-rent", bucket: "rent" as const, name: "Kira", is_system: true };
    const moved = await toImportRowPayload({ ...row, bucket: "rent", categoryId: "cat-rent" }, { ...ctxBase, category: rent, counterparty: cp });
    if (moved.match !== null) throw new Error("expected a new-entry row");
    expect([moved.counterparty_id, moved.entitlement_month]).toEqual([null, null]);
  });
});

describe("0037 open-debt flags in the payloads", () => {
  const category = { id: "cat-lab", bucket: "lab" as const, name: "Laboratuvar", is_system: true };
  const row = appendToReview([], [mk({ key: "clinic:2026-10-06:expense:2", sourceKind: "clinic_excel", kind: "workbook_expense", bucket: "lab", categoryId: "cat-lab", legacyAccount: "Nakit" })], "workbook", () => undefined)[0];
  const save = { rowNo: 1, clinicId: "c1", accountId: "cash", category, receiptsCounterpartyText: "G" };
  const match = { entry_id: "e", version: 3, payment_id: "p" };
  it("close_remainder only on a matched row, ack_open_debt only on a new entry, both only when set", async () => {
    const closed = await toImportRowPayload(row, { ...save, match, closeRemainder: true, ackOpenDebt: true });
    expect(closed).toMatchObject({ kind: "clinic_excel", account_id: "cash", match, close_remainder: true });
    expect("ack_open_debt" in closed).toBe(false);
    const open = await toImportRowPayload(row, { ...save, match, closeRemainder: false });
    expect("close_remainder" in open).toBe(false);
    const fresh = await toImportRowPayload(row, { ...save, closeRemainder: true, ackOpenDebt: true });
    expect(fresh).toMatchObject({ match: null, ack_open_debt: true });
    expect("close_remainder" in fresh).toBe(false);
    const plain = await toImportRowPayload(row, { ...save, ackOpenDebt: false });
    expect("ack_open_debt" in plain).toBe(false);
  });
  it("the check carries the chosen debt only when there is one, and close_remainder only with it", async () => {
    const check = { rowNo: 1, clinicId: "c1", category, receiptsCounterpartyText: "G", withDescription: false };
    const matched = await toCheckPayload(row, { ...check, matchEntryId: "e" });
    expect(matched.match_entry_id).toBe("e");
    expect("close_remainder" in matched).toBe(false);
    expect(await toCheckPayload(row, { ...check, matchEntryId: "e", closeRemainder: true })).toMatchObject({ match_entry_id: "e", close_remainder: true });
    expect("close_remainder" in (await toCheckPayload(row, { ...check, matchEntryId: "e", closeRemainder: false }))).toBe(false);
    const fresh = await toCheckPayload(row, { ...check, matchEntryId: null, closeRemainder: true });
    expect("match_entry_id" in fresh || "close_remainder" in fresh).toBe(false);
  });
  it("open_debt is no acknowledgeable warning", () => {
    const flags = flagsFromCheck({ status: "new", warnings: [{ code: "open_debt" }] });
    expect(flags.possibleDuplicate || flags.manualReceiptOverlap).toBe(false);
    expect(acknowledgements({ ...row, flags })).toEqual([]);
  });
});

describe("session balances (§3.5)", () => {
  const src = (importKey: string, day: string, amountCents: number): BalanceSource => ({ kind: "bank", importKey, label: "l", day, amountCents, file: "f", note: "n" });
  it("later or equal day wins per key", () => {
    const m = mergeSessionBalances([src("TEB:1", "2026-10-14", 1)], [src("TEB:1", "2026-10-14", 2), src("TEB:1", "2026-10-13", 3), src("G:2", "2026-10-01", 4)]);
    expect(m.map((x) => [x.importKey, x.amountCents])).toEqual([
      ["TEB:1", 2],
      ["G:2", 4],
    ]);
    expect(toBalancePayload(m[0])).toEqual({ kind: "bank", import_key: "TEB:1", amount_cents: 2, as_of: "2026-10-14", label: "l", file_name: "f", note: "n" });
  });
});
