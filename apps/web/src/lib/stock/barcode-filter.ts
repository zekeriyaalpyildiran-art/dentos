// Decoder result filters (spec p7_rules_ui §14.4). Pure, so they are testable without the WASM decoder.

import { MAX_BARCODE_LENGTH, parseGs1 } from "./gs1";

export interface DecodedSymbol {
  isValid: boolean;
  text: string;
  sequenceSize: number;
  readerInit: boolean;
}

/** Partial (structured-append) and reader-programming symbols never fill a form. */
export function uniqueBarcodeTexts(results: readonly DecodedSymbol[]): string[] {
  return [
    ...new Set(
      results
        .filter((r) => r.isValid && r.sequenceSize <= 1 && !r.readerInit && r.text.length <= MAX_BARCODE_LENGTH)
        .map((r) => r.text)
        .filter(Boolean)
    ),
  ];
}

/**
 * Some browser BarcodeDetector implementations drop FNC1 separators, which would silently glue a lot to a serial.
 * A detector result is trusted only when it carries no lot/serial, or still shows its separators.
 */
export function detectorResultTrusted(raw: string): boolean {
  let parsed;
  try {
    parsed = parseGs1(raw);
  } catch {
    return false;
  }
  if (!parsed.lot && !parsed.serial) return true;
  return raw.includes("\u001d") || raw.trim().startsWith("(");
}
