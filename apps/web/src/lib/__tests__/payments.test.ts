// Client money math of patient payments (spec p5 §4.1, acceptance A07). Synthetic values only.

import { describe, expect, it } from "vitest";
import {
  appliedCents,
  formatMoney,
  formatRate,
  maxPayable,
  microToInput,
  parseMoney,
  parseRate,
  paymentMath,
  rateFarOff,
  rateMicro,
  tryCents,
} from "../payments";

const micro = (s: string) => {
  const p = parseRate(s);
  if (!p.ok) throw new Error(p.error);
  return p.micro;
};

describe("rates", () => {
  it("parses Turkish and plain notation into micro units", () => {
    expect(micro("49,8765")).toBe(49876500n);
    expect(micro("49.8765")).toBe(49876500n);
    expect(micro("49")).toBe(49000000n);
    expect(micro("1.000,0")).toBe(1000000000n);
    expect(parseRate("1.000,5").ok).toBe(false);
    expect(micro("0,000001")).toBe(1n);
    expect(parseRate("49,87654321").ok).toBe(false);
    expect(parseRate("0").ok).toBe(false);
    expect(parseRate("1000,000001").ok).toBe(false);
    expect(parseRate("abc").ok).toBe(false);
    expect(parseRate("").ok).toBe(false);
    const p = parseRate("45,5");
    expect(p.ok && p.text).toBe("45.500000");
  });

  it("reads DB strings and JSON numbers", () => {
    expect(rateMicro("49.876500")).toBe(49876500n);
    expect(rateMicro(48)).toBe(48000000n);
    expect(rateMicro(0.000001)).toBe(1n);
    expect(rateMicro(null)).toBeNull();
  });

  it("formats with 4 decimals, 6 when needed", () => {
    expect(formatRate("49.876500")).toBe("49,8765");
    expect(formatRate("48.000000")).toBe("48,0000");
    expect(formatRate("45.123456")).toBe("45,123456");
    expect(formatRate("1000.000000")).toBe("1.000,0000");
    expect(microToInput(45123400n)).toBe("45,1234");
  });
});

describe("rounding parity with SQL (A07)", () => {
  it("rounds exact decimals half up where float rounding is off by a cent", () => {
    expect(tryCents(1100, micro("1.005"))).toBe(1106);
    expect(Math.round(1100 * 1.005)).toBe(1105);
    expect(tryCents(2500, micro("1.015"))).toBe(2538);
  });

  it("USD on a EUR plan", () => {
    const r = paymentMath(10000, "USD", "EUR", micro("45.123456"), micro("49.5"));
    expect(r).toEqual({ try_cents: 451235, applied_cents: 9116 });
    expect(appliedCents(1000000, micro("50"))).toBe(20000);
  });

  it("matches the SQL exact division at the half-cent boundary (golden 'A07 sınır' / 'A07 yarım')", () => {
    // Exact quotient 500999999.4999999995: plain 16-digit numeric division would round it up.
    expect(appliedCents(500999998999, micro("999.999999"))).toBe(500999999);
    expect(appliedCents(25, micro("50"))).toBe(1);
  });

  it("follows the §3 table", () => {
    expect(paymentMath(30000, "EUR", "EUR", micro("49"), null)).toEqual({ try_cents: 1470000, applied_cents: 30000 });
    expect(paymentMath(1000000, "TRY", "EUR", null, micro("50"))).toEqual({ try_cents: 1000000, applied_cents: 20000 });
    expect(paymentMath(500, "TRY", "TRY", null, null)).toEqual({ try_cents: 500, applied_cents: 500 });
    expect(paymentMath(100, "EUR", "TRY", micro("49"), null)).toEqual({ try_cents: 4900, applied_cents: 4900 });
    expect(paymentMath(100, "EUR", "TRY", null, null)).toBeNull();
    expect(paymentMath(100, "TRY", "EUR", null, null)).toBeNull();
  });
});

describe("rate tolerance (E_FX_RANGE)", () => {
  it("is exact at 10 %", () => {
    expect(rateFarOff(micro("52.8"), micro("48"))).toBe(false);
    expect(rateFarOff(micro("52.800001"), micro("48"))).toBe(true);
    expect(rateFarOff(micro("43.2"), micro("48"))).toBe(false);
    expect(rateFarOff(micro("43.199999"), micro("48"))).toBe(true);
    expect(rateFarOff(micro("0.000001"), micro("48"))).toBe(true);
  });
});

describe("maxPayable", () => {
  it("finds the largest amount whose applied value fits", () => {
    expect(maxPayable(50000, "EUR", "EUR", micro("49"), null)).toBe(50000);
    // €500 left at 50 TL/EUR: ₺25.000 fits, ₺25.000,01 rounds to €500,00 too (2.500.001 / 50 = 50000,02).
    const m = maxPayable(50000, "TRY", "EUR", null, micro("50")) as number;
    expect(appliedCents(m, micro("50"))).toBeLessThanOrEqual(50000);
    expect(appliedCents(m + 1, micro("50"))).toBeGreaterThan(50000);
    expect(maxPayable(0, "TRY", "TRY", null, null)).toBeNull();
    expect(maxPayable(100, "EUR", "TRY", null, null)).toBeNull();
  });
});

describe("money text", () => {
  it("formats per currency", () => {
    expect(formatMoney(123456, "EUR")).toBe("€1.234,56");
    expect(formatMoney(-5, "TRY")).toBe("-₺0,05");
    expect(formatMoney(null, "USD")).toBe("—");
  });

  it("parses with an optional matching symbol", () => {
    expect(parseMoney("€1.234,56", "EUR")).toEqual({ ok: true, cents: 123456 });
    expect(parseMoney("1234.5 EUR", "EUR")).toEqual({ ok: true, cents: 123450 });
    expect(parseMoney("100 TL", "TRY")).toEqual({ ok: true, cents: 10000 });
    expect(parseMoney("100 TL", "EUR").ok).toBe(false);
    expect(parseMoney("0", "EUR").ok).toBe(false);
  });
});
