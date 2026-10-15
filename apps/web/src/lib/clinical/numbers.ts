// Turkish decimal input (spec p9_clinical §8.1). The UI converts "4,0" before sending; the server takes numbers.

/**
 * "4,0" / "4.0" / "3,75" → number. Refuses more than `maxDecimals` decimals, a second separator ("4,0,1"),
 * thousands grouping ("1.000,5"), signs and letters. Blank → null.
 */
export function parseDecimalTr(s: string, maxDecimals: number): number | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > maxDecimals) return null;
  const n = Number(frac ? `${m[1]}.${frac}` : m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * TL text → integer cents, without floating point. Accepts "1.500,50", "1500,5", "1500.50", "1.500" (Turkish
 * thousands) and an optional "TL" / "₺". More than 2 decimals, negatives, zero and blanks → null.
 */
export function parseTlToCents(raw: string): number | null {
  let s = (raw ?? "").replace(/\s+/g, "").replace(/tl$/i, "").replace(/^₺|₺$/g, "");
  if (s === "" || !/^[0-9.,]+$/.test(s)) return null;

  let intPart: string;
  let frac = "";
  if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length !== 2 || parts[1] === "" || parts[1].includes(".")) return null;
    intPart = parts[0];
    frac = parts[1];
    if (intPart.includes(".")) {
      if (!/^[1-9]\d{0,2}(\.\d{3})+$/.test(intPart)) return null;
      intPart = intPart.replace(/\./g, "");
    }
  } else if (s.includes(".")) {
    if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
      intPart = s.replace(/\./g, "");
    } else {
      const parts = s.split(".");
      if (parts.length !== 2 || parts[1] === "") return null;
      intPart = parts[0];
      frac = parts[1];
    }
  } else {
    intPart = s;
  }
  s = intPart;
  if (!/^\d*$/.test(s) || !/^\d*$/.test(frac)) return null;
  if (frac.length > 2) return null;
  if (s === "") s = "0";
  s = s.replace(/^0+(?=\d)/, "");
  if (s.length > 13) return null;
  const cents = Number(s) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

/** Value for an editable TL input: "1500,5" style without grouping, so it parses back unchanged. */
export function centsToTlInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${whole}${frac ? "," + String(frac).padStart(2, "0") : ""}`;
}

/** "₺1.234,56" for display; null → "—". */
export function formatTl(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}₺${whole},${String(abs % 100).padStart(2, "0")}`;
}

/** Sizes such as 4 / 3.75 / 11.5 shown with a decimal comma ("3,75"). */
export function formatDecimalTr(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(v).replace(".", ",");
}
