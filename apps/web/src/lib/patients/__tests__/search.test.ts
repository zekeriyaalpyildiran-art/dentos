// Server-side patient search filter (PatientPicker, Hastalar list).

import { describe, expect, it } from "vitest";
import { nameSearchPattern, patientSearchFilter, safeSearchTerm } from "../search";

/** Postgres `~*` stand-in for these patterns (letters, digits, spaces, "-" and [iıİI] classes only). */
function nameMatches(term: string, fullName: string): boolean {
  const pattern = nameSearchPattern(safeSearchTerm(term));
  return pattern !== null && new RegExp(pattern, "iu").test(fullName);
}

describe("safeSearchTerm", () => {
  it("drops PostgREST syntax characters and squeezes spaces", () => {
    expect(safeSearchTerm("  ayşe,(yılmaz)*  ")).toBe("ayşe yılmaz");
    expect(safeSearchTerm('a.b:c"d\'e%f\\g')).toBe("a b c d e f g");
  });
});

describe("nameSearchPattern", () => {
  it("turns every Turkish i into one class", () => {
    expect(nameSearchPattern("yılmaz")).toBe("y[iıİI]lmaz");
    expect(nameSearchPattern("YILMAZ")).toBe("Y[iıİI]LMAZ");
    expect(nameSearchPattern("Ilgın")).toBe("[iıİI]lg[iıİI]n");
    expect(nameSearchPattern("İrem")).toBe("[iıİI]rem");
    expect(nameSearchPattern("Ayşe")).toBe("Ayşe");
  });

  it("drops characters that could act as regex operators", () => {
    expect(nameSearchPattern("a+b?c^d$e{f}g|h[i]j")).toBe("abcdefgh[iıİI]j");
    expect(nameSearchPattern("Ayşe-Nur 2")).toBe("Ayşe-Nur 2");
    expect(nameSearchPattern("+ ? $")).toBeNull();
    expect(nameSearchPattern("")).toBeNull();
  });

  it("drops a combining dot (i̇ typed as i + U+0307)", () => {
    expect(nameSearchPattern("i̇rem")).toBe("[iıİI]rem");
  });

  it.each([
    ["yılmaz", "AHMET YILMAZ"],
    ["YILMAZ", "Ahmet Yılmaz"],
    ["ırmak", "Irmak Demir"],
    ["ılgın", "Ilgın Kaya"],
    ["irem", "İREM ŞAHİN"],
    ["şahin", "İrem Şahin"],
    ["ali yıl", "Ali Yılmaz"],
  ])("%s finds %s", (term, name) => {
    expect(nameMatches(term, name)).toBe(true);
  });

  it("does not widen the search beyond the i letters", () => {
    expect(nameMatches("ali", "Alan Kaya")).toBe(false);
    expect(nameMatches("emin", "Ekrem Nur")).toBe(false);
    expect(nameMatches("yılmaz", "Ayşe Yalmaz")).toBe(false);
  });
});

describe("patientSearchFilter", () => {
  it("searches name and phone", () => {
    expect(patientSearchFilter("Ayşe")).toBe("full_name.imatch.Ayşe,phone.ilike.*Ayşe*");
  });

  it("matches the Turkish i letters in the name, not in the phone parts", () => {
    expect(patientSearchFilter("yılmaz")).toBe("full_name.imatch.y[iıİI]lmaz,phone.ilike.*yılmaz*");
    expect(patientSearchFilter("Irmak")).toContain("full_name.imatch.[iıİI]rmak,");
  });

  it("adds the normalised phone digits from 3 digits on, without leading zeros", () => {
    expect(patientSearchFilter("0532 123")).toBe(
      "full_name.imatch.0532 123,phone.ilike.*0532 123*,phone_normalized.ilike.*532123*"
    );
    expect(patientSearchFilter("+90 532")).toBe(
      "full_name.imatch.90 532,phone.ilike.*+90 532*,phone_normalized.ilike.*90532*"
    );
    expect(patientSearchFilter("05")).toBe("full_name.imatch.05,phone.ilike.*05*");
  });

  it("leaves the name out when nothing searchable is left for it", () => {
    expect(patientSearchFilter("++")).toBe("phone.ilike.*++*");
  });

  it("returns null below the minimum length", () => {
    expect(patientSearchFilter("")).toBeNull();
    expect(patientSearchFilter("  ")).toBeNull();
    expect(patientSearchFilter("(,)")).toBeNull();
    expect(patientSearchFilter("a", 2)).toBeNull();
    expect(patientSearchFilter("ab", 2)).toBe("full_name.imatch.ab,phone.ilike.*ab*");
  });

  it("never lets a term break out of the or-filter", () => {
    const f = patientSearchFilter("x),id.eq.1,(y")!;
    expect(f).not.toMatch(/[()]/);
    expect(f.split(",").length).toBe(2);
    // No PostgREST array value ({...}) and no quoted value can start the name pattern.
    expect(patientSearchFilter('{a}"b"')).toBe("full_name.imatch.a b,phone.ilike.*{a} b*");
  });
});
