import { describe, expect, it } from "vitest";
import {
  classify,
  compileRules,
  monthFromText,
  regexSafetyProblem,
  shiftMonth,
  suggestEntitlementMonth,
  workbookFirstPass,
} from "../classify";
import { physicianRule, rule, SEED_RULES, seedRules } from "./fixtures";

const c = seedRules();
const bucket = (text: string, cents: number, scope: "bank" | "clinic" = "bank") => classify(c, text, cents, scope)?.bucket ?? null;

describe("classification engine (§10)", () => {
  it("inflows: the bank 'always' rule wins before any text rule (FI:10)", () => {
    const r = classify(c, "POS komisyon iadesi", 1000, "bank");
    expect(r?.bucket).toBe("patient_receipts");
    expect(r?.autoSelect).toBe(false);
    expect(r?.warning?.code).toBe("W_BANK_IN");
  });
  it("outflow keyword rules in legacy order", () => {
    expect(bucket("Teftiş Defteri ödemesi", -1)).toBe("other_expense");
    expect(classify(c, "Teftiş Defteri ödemesi", -1, "bank")?.subcategory).toBe("official_fee");
    expect(bucket("FİZİKİ POS ÖKC HİZMET BEDELİ", -1)).toBe("fees");
    expect(bucket("EFT ÜCRETİ", -1)).toBe("fees");
    expect(bucket("Hesaplararası virman kesinti", -1)).toBe("fees"); // kesinti (40) before transfer (50)
    expect(classify(c, "Hesaplar arası virman", -1, "bank")?.warning?.code).toBe("W_TRANSFER");
    expect(bucket("K.KARTI ÖDEME", -1)).toBe("principal");
    expect(bucket("Dükkan KİRA", -1)).toBe("rent");
    expect(bucket("laboratuvar faturası", -1)).toBe("lab");
    expect(bucket("Personel MAAŞ", -1)).toBe("personnel");
    expect(bucket("SGK prim", -1)).toBe("tax");
    const fallback = classify(c, "bilinmeyen", -1, "bank");
    expect(fallback?.bucket).toBe("other_expense");
    expect(fallback?.autoSelect).toBe(false);
    expect(fallback?.warning?.code).toBe("W_CHECK");
  });
  it("scope: workbook-only rules never touch bank rows", () => {
    expect(classify(c, "döviz bozdurma", -1, "clinic")?.scope).toBe("clinic");
    expect(classify(c, "döviz bozdurma", -1, "bank")?.ruleId).toBe(SEED_RULES[SEED_RULES.length - 1].id);
    expect(classify(c, "girdi", 5, "clinic")).toBe(null); // no in-direction rule for workbook rows
  });
  it("starts_with is the legacy physician test (FC:10)", () => {
    const rules = compileRules([...SEED_RULES, physicianRule("Hekim Örnek")]);
    expect(classify(rules, "HEKİM ÖRNEK", -1, "bank")?.bucket).toBe("doctor");
    expect(classify(rules, "hekim örnek (ekim)", -1, "bank")?.bucket).toBe("doctor");
    expect(classify(rules, "hekim örnek ödeme", -1, "bank")?.bucket).toBe("doctor");
    expect(classify(rules, "hekim örnekler", -1, "bank")?.bucket).toBe("other_expense");
    expect(classify(rules, "ödeme hekim örnek", -1, "bank")?.bucket).toBe("other_expense");
  });
  it("priority, ties by created_at then id, inactive and invalid rules", () => {
    const a = rule(50, "any", "contains", "abc", "rent", { created_at: "2026-10-02" });
    const b = rule(50, "any", "contains", "abc", "lab", { created_at: "2026-10-01" });
    const off = rule(1, "any", "contains", "abc", "tax", { is_active: false });
    const bad = rule(2, "any", "regex", "(", "tax");
    const compiled = compileRules([a, b, off, bad]);
    expect(compiled.invalid.map((x) => x.id)).toEqual([bad.id]);
    expect(classify(compiled, "xabcx", -1, "bank")?.bucket).toBe("lab");
    expect(classify(compileRules([]), "x", -1, "bank")).toBe(null);
  });
  it("regex safety: nested repetition, back-references and look-behind are refused (ReDoS)", () => {
    for (const bad of ["(a+)+x", "(\\w+\\s?)+$", "(a|aa)*b{2,}(c*)*", "(x{1,9})+", "(.)\\1", "(?<n>a)\\k<n>", "(?<=a)b", "((ab)+)+"])
      expect(regexSafetyProblem(bad), bad).not.toBe(null);
    for (const ok of ["pos kullanım ücreti|fiziki pos.*hizmet bedeli|ö?kc hizmet bedeli", "k.kartı ödeme|kredi", "(ab)+", "(a+)?x", "[(+)]+", "\\(a+\\)+", "^\\d{2}$", "(kira|aidat)\\s+\\d+"])
      expect(regexSafetyProblem(ok), ok).toBe(null);
    const compiled = compileRules([rule(1, "any", "regex", "(a+)+$", "tax")]);
    expect(compiled.rules).toHaveLength(0);
    expect(compiled.invalid[0].message).toMatch(/iç içe tekrar/);
  });
  it("classification text is capped (outsider-controlled narrations)", () => {
    const rules = compileRules([rule(1, "any", "contains", "kira", "rent")]);
    expect(classify(rules, "x".repeat(1000) + " kira", -1, "bank")).toBe(null);
    expect(classify(rules, "x".repeat(900) + " kira", -1, "bank")?.bucket).toBe("rent");
  });
  it("workbook first pass: entitlement and workbook-only rules beat generic keywords (FI:62-64)", () => {
    const ent = rule(60, "clinic", "regex", "örnek sahip", "doctor", { requires_entitlement_month: true, counterparty_id: "cp-owner" });
    const rules = compileRules([...SEED_RULES, ent]);
    // 'kesinti' is a priority-40 fee keyword; legacy still treated the row as the entitlement payment.
    expect(classify(rules, "Örnek Sahip kesinti", -1, "clinic", { firstPass: workbookFirstPass })?.bucket).toBe("doctor");
    expect(classify(rules, "Örnek Sahip kesinti", -1, "clinic")?.bucket).toBe("fees");
    expect(classify(rules, "döviz bozdur masraf", -1, "clinic", { firstPass: workbookFirstPass })?.warning?.code).toBe("W_FX_EXCHANGE");
  });
  it("exact and contains fold the pattern", () => {
    const rules = compileRules([rule(1, "any", "exact", "  KİRA ", "rent"), rule(2, "any", "contains", "SARF", "supplies")]);
    expect(classify(rules, "kira", -1, "bank")?.bucket).toBe("rent");
    expect(classify(rules, "kira x", -1, "bank")).toBe(null);
    expect(classify(rules, "Sarf malzeme", -1, "bank")?.bucket).toBe("supplies");
  });
});

describe("hakediş month suggestion (0038)", () => {
  it("same / previous / none", () => {
    expect(suggestEntitlementMonth("same", "x", "2026-10-15")).toBe("2026-10");
    expect(suggestEntitlementMonth("previous", "x", "2026-10-15")).toBe("2026-09");
    expect(suggestEntitlementMonth("previous", "x", "2026-01-05")).toBe("2025-12");
    expect(suggestEntitlementMonth("none", "Ekim", "2026-10-15")).toBe(null);
    expect(suggestEntitlementMonth(undefined, "Ekim", "2026-10-15")).toBe(null);
    expect(suggestEntitlementMonth("same", "x", "2026-02-30")).toBe(null);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-03", -14)).toBe("2025-01");
  });
  it("from_text: a month name in the text, else the previous month", () => {
    const at = (text: string, date = "2026-11-03") => suggestEntitlementMonth("from_text", text, date);
    expect(at("ÖRNEK PERSONEL EKİM MAAŞI")).toBe("2026-10");
    expect(at("örnek hekim ekim'in hakedişi")).toBe("2026-10");
    // No month name, or only inside another word: the previous month.
    expect(at("ÖRNEK PERSONEL MAAŞ")).toBe("2026-10");
    expect(at("MARTI KAFE ÖDEMESİ", "2026-06-10")).toBe("2026-05");
    expect(at("ekimde ödenen avans", "2026-06-10")).toBe("2026-05");
    // Case and diacritics do not matter.
    for (const t of ["Şubat avansı", "SUBAT AVANSI", "ŞUBAT AVANSI", "subat avansi"]) expect(at(t, "2026-03-02"), t).toBe("2026-02");
    for (const t of ["EYLÜL", "Eylul", "eylül"]) expect(at(t, "2026-10-01"), t).toBe("2026-09");
    expect(at("MAYIS PRİMİ", "2026-07-01")).toBe("2026-05");
    expect(at("Ağustos maaş", "2026-09-01")).toBe("2026-08");
    expect(at("KASIM", "2026-12-01")).toBe("2026-11");
    expect(at("ARALIK AVANS", "2026-12-20")).toBe("2026-12"); // the row's own month is not after the row date
  });
  it("from_text: without a year the most recent such month not after the row date; a year next to the name wins", () => {
    expect(monthFromText("Aralık avansı", "2026-01-10")).toBe("2025-12");
    expect(monthFromText("Ocak maaşı", "2026-01-31")).toBe("2026-01");
    expect(monthFromText("Şubat 2025 farkı", "2026-10-01")).toBe("2025-02");
    expect(monthFromText("AĞUSTOS-2026 maaş", "2026-09-05")).toBe("2026-08");
    expect(monthFromText("ocak/2027 avans", "2026-12-28")).toBe("2027-01");
    // An amount after the name is not a year; a year far from the row date is ignored.
    expect(monthFromText("Kasım 2500,00 TL", "2026-10-15")).toBe("2025-11");
    expect(monthFromText("Kasım 25000 TL", "2026-10-15")).toBe("2025-11");
    expect(monthFromText("Ocak 1999 notu", "2026-10-15")).toBe("2026-01");
    // The first month name wins.
    expect(monthFromText("Eylül-Ekim farkı", "2026-11-01")).toBe("2026-09");
    expect(monthFromText("maaş", "2026-11-01")).toBe(null);
    expect(monthFromText("ekim", "bad")).toBe(null);
    // A month name with a valid year is preferred over an earlier one without.
    expect(monthFromText("Mart farkı Ekim 2026", "2026-11-05")).toBe("2026-10");
  });
  it("from_text: the rule's own text (a payee named like a month) is not read as the month", () => {
    // Made-up payees whose names are month names; the rule pattern is the name.
    expect(suggestEntitlementMonth("from_text", "KASIM DEMIR HAKEDIS EKIM 2026", "2026-11-03", "Kasım Demir")).toBe("2026-10");
    expect(suggestEntitlementMonth("from_text", "EYLUL YILMAZ EKIM MAASI", "2026-11-05", "EYLÜL YILMAZ")).toBe("2026-10");
    expect(suggestEntitlementMonth("from_text", "NİSAN KAYA MAAŞ", "2026-11-05", "Nisan Kaya")).toBe("2026-10");
    // Without the pattern: a year next to the real month still wins over the name; without a year the name wins.
    expect(suggestEntitlementMonth("from_text", "KASIM DEMIR HAKEDIS EKIM 2026", "2026-11-03")).toBe("2026-10");
    expect(suggestEntitlementMonth("from_text", "EYLUL YILMAZ EKIM MAASI", "2026-11-05")).toBe("2026-09");
    expect(suggestEntitlementMonth("from_text", "NİSAN KAYA MAAŞ", "2026-11-05")).toBe("2026-04");
    // Every occurrence is left out; a blank pattern changes nothing.
    expect(monthFromText("ocak bey ocak bey şubat", "2026-03-01", "Ocak Bey")).toBe("2026-02");
    expect(monthFromText("Mart avansı", "2026-04-01", "  ")).toBe("2026-03");
  });
  it("classify passes the rule's own text for contains / starts_with / exact, not for regex / always", () => {
    const rules = compileRules([
      rule(70, "any", "contains", "Örnek Kasım", "doctor", { requires_entitlement_month: true }),
      rule(71, "any", "regex", "^ornek regex", "personnel", { requires_entitlement_month: true }),
      rule(72, "bank", "always", null, "other_expense"),
    ]);
    expect(classify(rules, "ÖRNEK KASIM AVANS", -1, "bank")?.pattern).toBe("Örnek Kasım");
    expect(classify(rules, "ornek regex maaş", -1, "bank")?.pattern).toBe(null);
    expect(classify(rules, "başka bir ödeme", -1, "bank")?.pattern).toBe(null);
  });
  it("only rules that require the month carry their suggestion", () => {
    const ent = rule(60, "any", "contains", "örnek personel", "personnel", {
      requires_entitlement_month: true,
      counterparty_id: "cp-staff",
      entitlement_month_default: "from_text",
    });
    const plain = rule(61, "any", "contains", "örnek kira", "rent", { entitlement_month_default: "previous" });
    const rules = compileRules([ent, plain, rule(62, "any", "contains", "örnek hekim", "doctor", { requires_entitlement_month: true })]);
    expect(classify(rules, "ÖRNEK PERSONEL MAAŞ", -1, "bank")?.entitlementMonthDefault).toBe("from_text");
    expect(classify(rules, "örnek kira", -1, "bank")?.entitlementMonthDefault).toBe("none");
    expect(classify(rules, "örnek hekim", -1, "bank")?.entitlementMonthDefault).toBe("none");
  });
});
