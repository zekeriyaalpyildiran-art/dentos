// Finance import: review-list rules (spec p2i_parsers_rules §3.4, §10.4, §11; legacy IP:18-26, IP:50-65)
// and the RPC payload builders (p2i_db_contract §4.5, §4.7). Pure: ledger-wide checks
// (already saved, possible duplicates, manual receipts) come from fin_import_check.

import type { ReportBucket } from "../finance";
import { importCounterparty, importedEntryId, importFingerprint, importSubcategory } from "./keys";
import { financeDayOk, trMoney } from "./primitives";
import type { ParsedRow } from "./types";

export type CheckStatus = "new" | "saved_same" | "saved_changed" | "matched_same" | "matched_changed" | "match_voided" | "id_taken";
export type CheckWarningCode = "possible_duplicate" | "batch_duplicate" | "manual_receipt_overlap";
export type CheckErrorCode = "outside_month" | "future_date" | "financing_line" | "receipts_day_taken" | "invalid_key";

/** The part of a fin_import_check row answer the review list uses. */
export type RowCheck = {
  status: CheckStatus;
  existing?: { amount_cents: number } | null;
  warnings?: { code: CheckWarningCode }[];
  errors?: CheckErrorCode[];
};

export type ReviewFlags = {
  saved: boolean;
  /** Saved clinic: row whose stored amount differs (legacy 'TUTAR DEĞİŞMİŞ'). */
  savedAmount: number | null;
  idTaken: boolean;
  possibleDuplicate: boolean;
  /** Bank row appended while the list already had a row with the same date and absolute amount (IP:18). */
  listDuplicate: boolean;
  manualReceiptOverlap: boolean;
  financingLine: boolean;
  receiptsDayTaken: boolean;
  /** The database refused the source key's shape or meaning for this row (fin_import_check 'invalid_key'). */
  invalidKey: boolean;
};

export type ReviewRow = ParsedRow & { seq: number; flags: ReviewFlags };

const SAVED: CheckStatus[] = ["saved_same", "saved_changed", "matched_same", "matched_changed"];

export function flagsFromCheck(check: RowCheck | undefined): ReviewFlags {
  const codes = new Set((check?.warnings ?? []).map((w) => w.code));
  const errors = new Set(check?.errors ?? []);
  const saved = !!check && SAVED.includes(check.status);
  return {
    saved,
    savedAmount: saved && check?.existing ? check.existing.amount_cents : null,
    idTaken: check?.status === "id_taken",
    possibleDuplicate: codes.has("possible_duplicate"),
    listDuplicate: false,
    manualReceiptOverlap: codes.has("manual_receipt_overlap"),
    financingLine: errors.has("financing_line"),
    receiptsDayTaken: errors.has("receipts_day_taken"),
    invalidKey: errors.has("invalid_key"),
  };
}

/**
 * §3.4 / §11.2: append parsed rows. A key already in the list (or earlier in the batch) is
 * dropped (first occurrence wins). Selection is cleared for saved rows, possible duplicates,
 * manual-receipt overlaps and, for bank rows, rows whose date and absolute amount equal a row
 * that was already in the list before this append.
 */
export function appendToReview(
  list: readonly ReviewRow[],
  incoming: readonly ParsedRow[],
  source: "workbook" | "bank",
  checkOf: (key: string) => RowCheck | undefined,
): ReviewRow[] {
  const known = new Set(list.map((r) => r.key));
  let seq = list.reduce((n, r) => Math.max(n, r.seq), 0);
  const added: ReviewRow[] = [];
  for (const r of incoming) {
    if (known.has(r.key)) continue;
    known.add(r.key);
    const flags = flagsFromCheck(checkOf(r.key));
    if (source === "bank") flags.listDuplicate = list.some((o) => o.date === r.date && o.amount === r.amount);
    const selected =
      r.selected &&
      !flags.saved &&
      !flags.possibleDuplicate &&
      !flags.manualReceiptOverlap &&
      !(source === "bank" && flags.listDuplicate);
    added.push({ ...r, seq: ++seq, flags, selected });
  }
  return [...list, ...added];
}

/** Re-applies fresh fin_import_check answers (e.g. before saving); keeps selection and list flags. */
export const refreshChecks = (list: readonly ReviewRow[], checkOf: (key: string) => RowCheck | undefined): ReviewRow[] =>
  list.map((r) => ({ ...r, flags: { ...flagsFromCheck(checkOf(r.key)), listDuplicate: r.flags.listDuplicate } }));

/** Display order: date, then file, then the parser's own order (never affects keys). */
export const sortReview = (list: readonly ReviewRow[]): ReviewRow[] =>
  [...list].sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file) || a.seq - b.seq);

export type Blocker = { code: string; text: string };

export const INVALID_ROW_TEXT = "Tutar, açıklama veya kategori geçersiz. İlgili satırı düzeltin ya da seçimden çıkarın.";

/** Reasons a row cannot be ticked (never overridable, §11.4). Empty → the row may be selected. */
export function rowBlockers(row: ReviewRow, ctx: { month: string; today: string }): Blocker[] {
  const out: Blocker[] = [];
  if (row.flags.saved)
    out.push({
      code: "saved",
      text:
        row.flags.savedAmount !== null && row.flags.savedAmount !== row.amount && row.key.startsWith("clinic:")
          ? `TUTAR DEĞİŞMİŞ: Kayıt ${trMoney(row.flags.savedAmount)} TL, dosya ${trMoney(row.amount)} TL. Otomatik atlanmış bir güncelleme değildir; mevcut kaydın tutarını ve gerçekleşen tahsilatını finans listesinden düzeltin. Yeni kayıt eklemeyin.`
          : "Daha önce aktarıldı. Değişiklik için finans listesinden düzenle.",
    });
  if (row.date.slice(0, 7) !== ctx.month) out.push({ code: "outside_month", text: "Seçilen ay dışında." });
  if (row.date > ctx.today) out.push({ code: "future_date", text: "Gelecek tarihli satır aktarılamaz." });
  if (
    !row.description.trim() ||
    !Number.isInteger(row.amount) ||
    row.amount < 1 ||
    row.amount > 1e12 ||
    !financeDayOk(row.date) ||
    (!row.bucket && !row.categoryId)
  )
    out.push({ code: "invalid", text: INVALID_ROW_TEXT });
  if (row.flags.financingLine)
    out.push({
      code: "financing_line",
      text: "Burgan finansman kesintilerini finans ekranındaki Burgan finansman bölümünden yükleyin. Çift sayımı önlemek için bu aktarım durduruldu.",
    });
  if (row.flags.receiptsDayTaken) out.push({ code: "receipts_day_taken", text: "Bu gün için uygulama içi günlük tahsilat kaydı var." });
  if (row.flags.idTaken) out.push({ code: "id_taken", text: "Kayıt kaydedilemedi." });
  if (row.flags.invalidKey && !keyDateMismatch(row))
    out.push({ code: "invalid_key", text: "Kaynak satır anahtarı bu satırla uyuşmuyor; dosyayı yeniden okuyun." });
  if (keyDateMismatch(row))
    out.push({
      code: "key_date",
      text: "Kaynak satırın tarihi dosyadaki tarihle aynı olmalı. Tarihi geri alın; farklı günse dosyayı düzeltip yeniden okuyun.",
    });
  return out;
}

/**
 * Workbook and known-bank keys embed the row's day; the database refuses a row whose date differs from its key
 * (the key is the row's identity and drives daily coverage), so those dates are not editable.
 */
export function keyDay(key: string): string | null {
  const m = key.match(/^clinic:(\d{4}-\d{2}-\d{2}):/) ?? key.match(/^bank:[^:]+:[^:]+:(\d{4}-\d{2}-\d{2}):/);
  return m ? m[1] : null;
}
export const keyDateMismatch = (row: Pick<ParsedRow, "key" | "date">): boolean => {
  const day = keyDay(row.key);
  return day !== null && day !== row.date;
};

/**
 * Rows that may be sent to fin_import_check at all: inside the chosen month, a real calendar day and a valid amount.
 * Rows outside the month are never sent to the database (critique 16), not even for the preflight.
 */
export const checkableRow = (row: Pick<ParsedRow, "date" | "amount">, month: string): boolean =>
  row.date.slice(0, 7) === month &&
  financeDayOk(row.date) &&
  Number.isInteger(row.amount) &&
  row.amount >= 1 &&
  row.amount <= 1e12;

/** §11.1 IP:26: what a save sends. */
export const chosenRows = (list: readonly ReviewRow[], ctx: { month: string; today: string }): ReviewRow[] =>
  list.filter((r) => r.selected && rowBlockers(r, ctx).length === 0);

/** §11.4: warning codes a ticked row must carry as `acknowledged`. */
export function acknowledgements(row: ReviewRow): CheckWarningCode[] {
  const out: CheckWarningCode[] = [];
  if (row.flags.possibleDuplicate) out.push("possible_duplicate");
  if (row.flags.listDuplicate) out.push("batch_duplicate");
  if (row.flags.manualReceiptOverlap) out.push("manual_receipt_overlap");
  return out;
}

export const OVERRIDE_TEXT = (n: number) =>
  `Uyarılı ${n} satırı (olası tekrar / elle girilmiş tahsilat) bilerek aktarıyorum.`;
export const FINAL_CONFIRM_TEXT = "Seçtiğim kayıtların kategori, tutar ve tekrar kontrollerini yaptım.";
export const ENTITLEMENT_MONTH_REQUIRED = "Hekim hakediş ödemelerinde hakediş ayını seçin.";

/** Batch-level problems before the save call (1..500 rows, entitlement months). */
export function saveProblems(chosen: readonly ReviewRow[]): string[] {
  const out: string[] = [];
  if (!chosen.length) out.push("Aktarılacak satır seçin.");
  if (chosen.length > 500) out.push("En fazla 500 kayıt aktarılabilir.");
  if (chosen.some((r) => r.requiresEntitlementMonth && r.bucket === "doctor" && !r.entitlementMonth)) out.push(ENTITLEMENT_MONTH_REQUIRED);
  return out;
}

/** §11.1 informational line: Σ selected patient receipts. */
export const selectedReceiptsCents = (chosen: readonly ReviewRow[]): number =>
  chosen.filter((r) => r.bucket === "patient_receipts").reduce((n, r) => n + r.amount, 0);

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export type RowCategory = { id: string; bucket: ReportBucket; name: string; is_system: boolean };

export type RowSaveContext = {
  /** 1-based position in the user's selection. */
  rowNo: number;
  clinicId: string;
  /** Resolved fin_accounts id (§2.3 account rules). */
  accountId: string;
  category: RowCategory;
  /** A chosen counterparty master (entitlement rows); its name is the fingerprint counterparty. */
  counterparty?: { id: string; name: string } | null;
  /** Layout receipt_text.counterparty ('Günlük toplam' in legacy). */
  receiptsCounterpartyText: string;
  /** Settle an existing debt instead of creating an entry (§12). */
  match?: { entry_id: string; version: number; payment_id: string } | null;
  acknowledged?: CheckWarningCode[];
};

const direction = (r: ParsedRow): "in" | "out" => (r.signedCents > 0 ? "in" : "out");

/**
 * A configured counterparty applies only to entitlement rows of the doctor bucket (legacy IP:54 used a fixed name
 * only for the entitlement physician); every other row's counterparty is its narration (critique 16).
 */
export const usesCounterparty = (row: Pick<ParsedRow, "requiresEntitlementMonth">, bucket: ReportBucket): boolean =>
  row.requiresEntitlementMonth && bucket === "doctor";

/** Fingerprint of the row as it will be saved (after review edits). */
export async function rowFingerprint(row: ParsedRow, ctx: Pick<RowSaveContext, "category" | "counterparty" | "receiptsCounterpartyText">) {
  const master = usesCounterparty(row, ctx.category.bucket) ? (ctx.counterparty ?? null) : null;
  const counterparty = importCounterparty({
    bucket: ctx.category.bucket,
    description: row.description,
    counterpartyName: master?.name ?? null,
    receiptsCounterpartyText: ctx.receiptsCounterpartyText,
  });
  const entitlementMonth = ctx.category.bucket === "doctor" ? row.entitlementMonth : null;
  const subcategory = importSubcategory(ctx.category.bucket, row.description, row.date, entitlementMonth, row.subcategory);
  const fingerprint = await importFingerprint({
    bucket: ctx.category.bucket,
    categoryName: ctx.category.name,
    isSystem: ctx.category.is_system,
    subcategory,
    counterparty,
    description: row.description,
    date: row.date,
    amount: row.amount,
    entitlementMonth,
    legacyAccount: row.legacyAccount,
  });
  return { fingerprint, counterparty: counterparty.trim(), subcategory, entitlementMonth, master };
}

/** fin_import_rows p_rows item (p2i_db_contract §4.7, strict keys). */
export async function toImportRowPayload(row: ParsedRow, ctx: RowSaveContext) {
  const base = {
    row_no: ctx.rowNo,
    key: row.key,
    kind: row.sourceKind,
    file: row.file.slice(0, 200),
    date: row.date,
    amount_cents: row.amount,
    direction: direction(row),
    currency: "TRY" as const,
    account_id: ctx.accountId,
    acknowledged: ctx.acknowledged ?? [],
    description: row.description.trim().slice(0, 1000),
  };
  if (ctx.match) return { ...base, match: ctx.match };
  const fp = await rowFingerprint(row, ctx);
  return {
    ...base,
    entry_id: await importedEntryId(ctx.clinicId, row.key),
    fingerprint: fp.fingerprint,
    category_id: ctx.category.id,
    subcategory: fp.subcategory,
    entitlement_month: fp.entitlementMonth,
    counterparty_id: fp.master?.id ?? null,
    counterparty_text: fp.master ? null : fp.counterparty.slice(0, 200),
    match: null,
  };
}

/**
 * fin_import_check p_rows item (p2i_db_contract §4.5). `category` null → no fingerprint yet. The narration is sent
 * only for rows the user has selected (`withDescription`); unselected rows get their saved / duplicate status from
 * key, date, amount and fingerprint alone, so third-party narrations never leave the browser unless chosen.
 * Callers send only checkableRow() rows.
 */
export async function toCheckPayload(
  row: ParsedRow,
  ctx: {
    rowNo: number;
    clinicId: string;
    category: RowCategory | null;
    counterparty?: { id: string; name: string } | null;
    receiptsCounterpartyText: string;
    withDescription: boolean;
  },
) {
  const base = {
    row_no: ctx.rowNo,
    key: row.key,
    kind: row.sourceKind,
    entry_id: await importedEntryId(ctx.clinicId, row.key),
    date: row.date,
    amount_cents: row.amount,
    direction: direction(row),
    fingerprint: ctx.category ? (await rowFingerprint(row, { ...ctx, category: ctx.category })).fingerprint : null,
  };
  return ctx.withDescription ? { ...base, description: row.description.trim().slice(0, 1000) } : base;
}
