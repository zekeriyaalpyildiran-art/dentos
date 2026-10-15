import { describe, expect, it } from "vitest";
import { classify, compileRules, regexSafetyProblem, workbookFirstPass } from "../classify";
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
