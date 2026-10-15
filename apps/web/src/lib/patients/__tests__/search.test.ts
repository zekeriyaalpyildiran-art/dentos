// Server-side patient search filter (PatientPicker, Hastalar list).

import { describe, expect, it } from "vitest";
import { patientSearchFilter, safeSearchTerm } from "../search";

describe("safeSearchTerm", () => {
  it("drops PostgREST syntax characters and squeezes spaces", () => {
    expect(safeSearchTerm("  ayşe,(yılmaz)*  ")).toBe("ayşe yılmaz");
    expect(safeSearchTerm('a.b:c"d\'e%f\\g')).toBe("a b c d e f g");
  });
});

describe("patientSearchFilter", () => {
  it("searches name and phone", () => {
    expect(patientSearchFilter("Ayşe")).toBe("full_name.ilike.*Ayşe*,phone.ilike.*Ayşe*");
  });

  it("adds the normalised phone digits from 3 digits on, without leading zeros", () => {
    expect(patientSearchFilter("0532 123")).toBe(
      "full_name.ilike.*0532 123*,phone.ilike.*0532 123*,phone_normalized.ilike.*532123*"
    );
    expect(patientSearchFilter("+90 532")).toBe(
      "full_name.ilike.*+90 532*,phone.ilike.*+90 532*,phone_normalized.ilike.*90532*"
    );
    expect(patientSearchFilter("05")).toBe("full_name.ilike.*05*,phone.ilike.*05*");
  });

  it("returns null below the minimum length", () => {
    expect(patientSearchFilter("")).toBeNull();
    expect(patientSearchFilter("  ")).toBeNull();
    expect(patientSearchFilter("(,)")).toBeNull();
    expect(patientSearchFilter("a", 2)).toBeNull();
    expect(patientSearchFilter("ab", 2)).toBe("full_name.ilike.*ab*,phone.ilike.*ab*");
  });

  it("never lets a term break out of the or-filter", () => {
    const f = patientSearchFilter("x),id.eq.1,(y")!;
    expect(f).not.toMatch(/[()]/);
    expect(f.split(",").length).toBe(2);
  });
});
