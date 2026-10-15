// GS1 barcode parsing for stock labels (spec p7_rules_ui §14.1). Pure: no DOM, no network.
// Only AIs 01 (GTIN), 17 (expiry), 10 (lot) and 21 (serial) are supported; anything else fails closed.
// The server re-validates every parsed value; this only splits the scan into fields.

export interface Gs1Scan {
  /** 14 digits, or '' when the code carries no GTIN. */
  gtin: string;
  /** 'YYYY-MM-DD', or ''. */
  expiry: string;
  lot: string;
  serial: string;
}

export const GS1_MESSAGES = {
  tooLong: "Barkod verisi çok uzun. Ürünün stok barkodunu okutun.",
  unsupported: "Bu barkod biçimi desteklenmiyor. Ürünü ve lot bilgilerini elle seçin.",
  invalid: "Barkoddaki lot veya ürün bilgisi geçersiz. Ambalajı kontrol edin.",
  gtin: "Barkoddaki ürün kodu geçersiz.",
  expiry: "Barkoddaki son kullanma tarihi geçersiz.",
} as const;

export const MAX_BARCODE_LENGTH = 512;
const MAX_VARIABLE_FIELD = 20;

type Ai = "01" | "17" | "10" | "21";

/** A real calendar day in 'YYYY-MM-DD' form (round-trips through Date). */
export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function expiryFromAi17(content: string): string {
  if (!/^\d{6}$/.test(content)) throw new Error(GS1_MESSAGES.expiry);
  const year = 2000 + Number(content.slice(0, 2));
  const month = Number(content.slice(2, 4));
  let day = Number(content.slice(4, 6));
  if (month < 1 || month > 12) throw new Error(GS1_MESSAGES.expiry);
  // Day 00 means the last day of that month.
  if (day === 0) day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!validDate(iso)) throw new Error(GS1_MESSAGES.expiry);
  return iso;
}

export function parseGs1(value: string): Gs1Scan {
  if (value.length > MAX_BARCODE_LENGTH) throw new Error(GS1_MESSAGES.tooLong);

  let s = value
    .trim()
    .replace(/^\](d2|c1|q3)/i, "")
    .replace(/\u001d/g, "|")
    .replace(/^\|+/, "");

  // A plain EAN-8 / UPC-A / EAN-13 / GTIN-14.
  if (/^\d{8}$/.test(s) || /^\d{12,14}$/.test(s)) {
    return { gtin: s.padStart(14, "0"), expiry: "", lot: "", serial: "" };
  }

  const fields: Partial<Record<Ai, string>> = {};
  const put = (ai: Ai, content: string) => {
    if (fields[ai] !== undefined || content === "") throw new Error(GS1_MESSAGES.invalid);
    if ((ai === "10" || ai === "21") && content.length > MAX_VARIABLE_FIELD) {
      throw new Error(GS1_MESSAGES.invalid);
    }
    fields[ai] = content;
  };

  if (s.startsWith("(")) {
    // Human-readable bracketed form: (01)…(17)…(10)…
    while (s) {
      const m = /^\((01|17|10|21)\)([^()|]+)\|*/.exec(s);
      if (!m) throw new Error(GS1_MESSAGES.unsupported);
      put(m[1] as Ai, m[2]);
      s = s.slice(m[0].length);
    }
  } else {
    for (;;) {
      s = s.replace(/^\|+/, "");
      if (!s) break;
      const ai = s.slice(0, 2);
      if (ai === "01") {
        put(ai, s.slice(2, 16));
        s = s.slice(16);
      } else if (ai === "17") {
        put(ai, s.slice(2, 8));
        s = s.slice(8);
      } else if (ai === "10" || ai === "21") {
        // A variable-length field ends only at a separator (or the end), never at an AI-looking substring.
        const rest = s.slice(2);
        const sep = rest.indexOf("|");
        const content = sep < 0 ? rest : rest.slice(0, sep);
        s = sep < 0 ? "" : rest.slice(sep + 1);
        put(ai, content);
      } else {
        throw new Error(GS1_MESSAGES.unsupported);
      }
    }
  }

  if (fields["01"] !== undefined && !/^\d{14}$/.test(fields["01"])) throw new Error(GS1_MESSAGES.gtin);
  const expiry = fields["17"] !== undefined ? expiryFromAi17(fields["17"]) : "";

  return {
    gtin: fields["01"] ?? "",
    expiry,
    lot: fields["10"] ?? "",
    serial: fields["21"] ?? "",
  };
}

/** Normalises a typed GTIN (8, 12, 13 or 14 digits) to 14 digits; null when invalid. */
export function normalizeGtin(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{8}$/.test(s) || /^\d{12,14}$/.test(s)) return s.padStart(14, "0");
  return null;
}

/** GS1 mod-10 check digit test. Only a warning in the UI; the server does not check it. */
export function gtinCheckDigitOk(gtin14: string): boolean {
  if (!/^\d{14}$/.test(gtin14)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const d = Number(gtin14[i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(gtin14[13]);
}
