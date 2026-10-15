// Units and quantity display (spec p7_rules_ui §2, §14.3). Pure; the server is authoritative.

export type QuantityUnit = "usage" | "purchase";

/** Preview of the usage-unit quantity the server will record (SW:1-5). NaN when invalid. */
export function quantityInStockUnits(q: number, unit: string, factor: number): number {
  if (!Number.isFinite(q) || q <= 0) return NaN;
  if (unit !== "usage" && unit !== "purchase") return NaN;
  if (unit === "purchase" && (!Number.isFinite(factor) || factor <= 0)) return NaN;
  return Number((q * (unit === "purchase" ? factor : 1)).toFixed(4));
}

/** Default entry unit (legacy chooseUnit): the purchase unit only for a receipt without serial. */
export function chooseUnit(
  item: { units_per_purchase: number },
  type: string,
  serial: string | null | undefined
): QuantityUnit {
  return Number(item.units_per_purchase) !== 1 && type === "receive" && !serial ? "purchase" : "usage";
}

const QTY_FORMAT = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 });

export function formatQty(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? QTY_FORMAT.format(v) : "—";
}

/**
 * True for "1.000" / "12.500" / "1.000.000": in Turkish entry the dot groups thousands, but the same text reads as
 * a decimal elsewhere. Such input is refused (parseQty -> NaN) instead of being booked 1000 times too small.
 */
export function isAmbiguousThousands(raw: string): boolean {
  const s = (raw ?? "").trim().replace(/\s+/g, "");
  return !s.includes(",") && /^\d{1,3}(\.\d{3})+$/.test(s);
}

export const AMBIGUOUS_QTY_MESSAGE = "Ondalık için virgül kullanın (ör. 2,5); binlik ayırıcı yazmayın.";

/** Message for a typed quantity that cannot be read, or null when parseQty accepts it. */
export function qtyInputProblem(raw: string): string | null {
  if (isAmbiguousThousands(raw)) return AMBIGUOUS_QTY_MESSAGE;
  return Number.isNaN(parseQty(raw)) ? "Geçerli bir miktar girin." : null;
}

/**
 * Parses a typed quantity ("2,5", "1.000,25", "3", "2.5"). Returns NaN for anything that is not a positive-or-zero
 * number with at most 4 decimals. A dot is a decimal mark only when the text has no comma and does not look like
 * thousands grouping ("1.000" is refused, see isAmbiguousThousands).
 */
export function parseQty(raw: string): number {
  let s = (raw ?? "").trim().replace(/\s+/g, "");
  if (!s) return NaN;
  if (isAmbiguousThousands(s)) return NaN;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return NaN;
  return Number(s);
}

export function isWholeNumber(n: number): boolean {
  return Number.isFinite(n) && Math.trunc(n) === n;
}

/** "2 kutu = 100 adet" (SA live conversion line). */
export function conversionLine(qty: number, purchaseUnit: string, usageUnit: string, factor: number): string {
  const usage = quantityInStockUnits(qty, "purchase", factor);
  if (!Number.isFinite(usage)) return "";
  return `${formatQty(qty)} ${purchaseUnit} = ${formatQty(usage)} ${usageUnit}`;
}
