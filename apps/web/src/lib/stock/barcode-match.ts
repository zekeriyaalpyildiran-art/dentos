// Matching a scanned code to stock cards and lots (spec p7_rules_ui §14.2). Pure.

import { MAX_BARCODE_LENGTH, parseGs1, type Gs1Scan } from "./gs1";

export interface MatchItem {
  id: string;
  gtin: string | null;
  name?: string;
}

export interface ResolvedScan extends Gs1Scan {
  itemId: string;
}

export interface MatchBatch {
  stockItemId: string;
  lotNumber: string;
  serialNumber: string | null;
  expiryDate: string | null;
}

export type ScanLike = Partial<Gs1Scan> & { itemId?: string };

export const BARCODE_MATCH_MESSAGES = {
  unreadable: "Kod okunamadı. Etiketi yeniden okutun veya ürünü elle seçin.",
  noGtin: "Bu kodda ürün barkodu bulunamadı. Ürünün stok barkodunu okutun.",
  ambiguous: "Bu barkod birden fazla ürüne bağlı. Stok sorumlusuna bildirin.",
  unknown: "Bu barkod ürün listesinde yok. Stok sorumlusu ürün kartına barkodu tanımlamalı.",
  lockedMismatch: "Okunan ürün seçilen siparişle eşleşmiyor.",
  newUnreadable: "Barkod okunamadı. Etiketi yeniden okutun veya numarayı elle yazın.",
  newNoGtin: "Bu kodda ürün barkodu bulunamadı. Ambalajdaki ürün barkodunu okutun.",
} as const;

const padGtin = (gtin: string | null | undefined) => (gtin ? gtin.padStart(14, "0") : "");

export type IdentifyResult = { kind: "new"; scan: Gs1Scan } | { kind: "known"; scan: ResolvedScan };

export function identifyStockBarcode(raw: string, items: readonly MatchItem[]): IdentifyResult {
  if (!raw.trim() || raw.length > MAX_BARCODE_LENGTH) throw new Error(BARCODE_MATCH_MESSAGES.unreadable);
  const p = parseGs1(raw);
  if (!p.gtin) throw new Error(BARCODE_MATCH_MESSAGES.noGtin);
  const matches = items.filter((item) => padGtin(item.gtin) === p.gtin);
  if (matches.length === 0) return { kind: "new", scan: p };
  if (matches.length > 1) throw new Error(BARCODE_MATCH_MESSAGES.ambiguous);
  return { kind: "known", scan: { ...p, itemId: matches[0].id } };
}

/** Known items only; `lockedItemId` is the Phase 8 purchase-order hook. */
export function resolveStockScan(raw: string, items: readonly MatchItem[], lockedItemId?: string): ResolvedScan {
  const result = identifyStockBarcode(raw, items);
  if (result.kind === "new") throw new Error(BARCODE_MATCH_MESSAGES.unknown);
  if (lockedItemId && result.scan.itemId !== lockedItemId) throw new Error(BARCODE_MATCH_MESSAGES.lockedMismatch);
  return result.scan;
}

/** GTIN for a new card; refuses one that another listed card already holds. */
export function resolveNewProductGtin(raw: string, items: readonly MatchItem[]): string {
  if (!raw.trim() || raw.length > MAX_BARCODE_LENGTH) throw new Error(BARCODE_MATCH_MESSAGES.newUnreadable);
  const p = parseGs1(raw);
  if (!p.gtin) throw new Error(BARCODE_MATCH_MESSAGES.newNoGtin);
  const existing = items.find((item) => padGtin(item.gtin) === p.gtin);
  if (existing) throw new Error(`Bu barkod zaten ${existing.name || "başka bir ürün"} kartında kayıtlı.`);
  return p.gtin;
}

export function hasScannedBatch(scan: ScanLike | null | undefined): boolean {
  return Boolean(scan && (scan.lot || scan.serial || scan.expiry));
}

/**
 * Each scanned field must equal the batch field; an empty scan field matches anything. The product must always
 * match (legacy barcode-match:40): a scan not yet resolved to a card (no itemId) matches no lot, so a shared lot /
 * serial / expiry on another card can never be picked.
 */
export function batchMatchesScan(batch: MatchBatch, scan: ScanLike): boolean {
  if (!scan.itemId || batch.stockItemId !== scan.itemId) return false;
  if (scan.lot && batch.lotNumber !== scan.lot) return false;
  if (scan.serial && (batch.serialNumber ?? "") !== scan.serial) return false;
  if (scan.expiry && (batch.expiryDate ?? "") !== scan.expiry) return false;
  return true;
}
