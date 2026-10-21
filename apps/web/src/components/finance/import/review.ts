// Wizard rows: the parser library's review rows (lib/finance-import/review.ts) plus the UI-only state
// the save needs: the resolved account (C16), the source layout and an optional debt match (§12; 0037 flags in
// lib/finance-import/matching.ts).

import type {
  CategoryJson,
  Direction,
  ImportLayoutJson,
  ImportSetupJson,
  ImportWarningCode,
  ReferenceData,
  ReportBucket,
} from "@/lib/finance";
import type { MatchState } from "@/lib/finance-import/matching";
import {
  rowBlockers,
  type Blocker,
  type ReviewRow as LibReviewRow,
  type RowCategory,
} from "@/lib/finance-import/review";
import type { ParsedRow } from "@/lib/finance-import/types";

/** `match` settles an existing debt instead of creating an entry; see MatchState for the 0037 flags. */
export type WizardRow = LibReviewRow &
  MatchState & {
    /** fin_accounts id of the payment; null = the statement's account still has to be linked */
    accountId: string | null;
    /** workbook layout or saved bank-table layout the row came from (history only) */
    layoutId: string | null;
  };

/** Match state of a row as read from a file: nothing chosen yet. */
export const NO_MATCH: Pick<WizardRow, "match" | "matchChosen" | "closeRemainder" | "ackOpenDebt"> = {
  match: null,
  matchChosen: false,
  closeRemainder: false,
  ackOpenDebt: false,
};

export const NO_ACCOUNT_TEXT = "Bu dökümün hesabı bir finans hesabıyla eşleşmemiş. Banka kartından hesabı seçin.";
export const CATEGORY_TEXT = "Satırın giriş / çıkış yönüne uygun aktif bir kategori seçin.";

export const WARNING_LABEL: Record<ImportWarningCode, string> = {
  possible_duplicate: "Mevcut kayıtta aynı tarih ve tutar var. Tekrar olmadığını kontrol edin.",
  batch_duplicate: "Bu aktarımda aynı tarih ve tutarda başka bir satır var.",
  manual_receipt_overlap:
    "Bu ay elle girilmiş tahsilatlar var. Excel aynı tahsilatları içeriyorsa birlikte sayılmamalı. Tam dönem toplamları eşleşirse Excel esas alınır; kısmi aktarımla devam etmeyin.",
};

export const rowDirection = (r: Pick<ParsedRow, "signedCents">): Direction => (r.signedCents > 0 ? "in" : "out");

/** Active system category of a bucket (the import default when a rule gives only a bucket). */
export function systemCategory(ref: ReferenceData, bucket: ReportBucket | null): CategoryJson | undefined {
  if (!bucket) return undefined;
  return ref.categories.find((c) => c.is_system && c.report_bucket === bucket && c.is_active);
}

/** The category the row will be saved with: the rule's / user's pick, else the bucket's system category. */
export function rowCategory(ref: ReferenceData, row: Pick<ParsedRow, "categoryId" | "bucket">): CategoryJson | undefined {
  if (row.categoryId) return ref.categories.find((c) => c.id === row.categoryId);
  return systemCategory(ref, row.bucket);
}

export function toRowCategory(c: CategoryJson | undefined): RowCategory | null {
  return c ? { id: c.id, bucket: c.report_bucket, name: c.name, is_system: c.is_system } : null;
}

/** Account rules (C16, p2i_db_contract §2.7). */
export function resolveAccount(
  row: ParsedRow,
  setup: ImportSetupJson,
  layout: ImportLayoutJson | null,
  mapperAccountId: string | null
): string | null {
  if (row.sourceKind === "clinic_excel") {
    if (!layout) return null;
    if (row.kind === "workbook_receipts") return layout.receipts_account_id;
    return row.legacyAccount === "Banka" ? layout.bank_paid_account_id : layout.cash_paid_account_id;
  }
  if (row.sourceKind === "bank_table") return mapperAccountId;
  const key = row.accountImportKey;
  if (!key) return null;
  return setup.accounts.find((a) => a.import_key === key && (a.kind === "bank" || a.kind === "pos"))?.id ?? null;
}

/** Library blockers (never overridable) plus the account and category rules of the save RPC. */
export function wizardBlockers(row: WizardRow, ctx: { month: string; today: string; ref: ReferenceData }): Blocker[] {
  const out = rowBlockers(row, ctx);
  if (!row.accountId) out.push({ code: "no_account", text: NO_ACCOUNT_TEXT });
  if (!row.match) {
    const c = rowCategory(ctx.ref, row);
    if (!c || !c.is_active || c.direction !== rowDirection(row)) {
      if (!out.some((b) => b.code === "invalid")) out.push({ code: "category", text: CATEGORY_TEXT });
    }
  }
  return out;
}

/** Warning codes the server reported for the row (each needs the explicit override, C9). */
export function rowWarnings(row: WizardRow): ImportWarningCode[] {
  const out: ImportWarningCode[] = [];
  if (row.flags.possibleDuplicate) out.push("possible_duplicate");
  if (row.flags.listDuplicate) out.push("batch_duplicate");
  if (row.flags.manualReceiptOverlap) out.push("manual_receipt_overlap");
  return out;
}
