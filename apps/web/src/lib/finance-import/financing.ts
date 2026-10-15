// Finance import, parser E: patient-financing statement (Burgan) (spec p2i_parsers_rules §8;
// legacy BF:10-31, BG, RT:56-74). The marker and the column headers are format knowledge.
// The patient name (personal data) is only carried to the save payload; never logged or keyed.

import { financingKey, financingRowId, importedEntryId } from "./keys";
import { addDays, bankDate, bankNumber, financeDayOk, hasOwn } from "./primitives";
import { ImportParseError, type SheetBook } from "./types";

/** Financing narration marker (format knowledge, BF:15, IP:42, IR:24). */
export const FINANCING_MARKER = /Bayi Katkı Faizi/i;

export const FINANCING_FILE_REFUSED =
  "Burgan hasta finansmanı dosyası: finans ana ekranındaki Burgan hasta finansmanı bölümünden yükleyin. Brüt tahsilatın tekrar sayılmaması için ayrı aktarılır.";
export const FINANCING_LINE_REFUSED =
  "Burgan finansman kesintilerini finans ekranındaki Burgan finansman bölümünden yükleyin. Çift sayımı önlemek için bu aktarım durduruldu.";
export const FINANCING_MAX_ITEMS = 40;
export const FINANCING_TOO_MANY = "En fazla 40 finansman tek seferde kaydedilebilir; dökümü tarih aralığına bölün.";
export const FINANCING_CONFIRM_TEXT =
  "Brüt tutarlar klinik Excel’inde zaten var. Kesintileri başka yerde gider yazmadım. Hesap türünü ve tutarları kontrol ettim.";

/** §3.1 step 1: any string cell of any sheet carries the financing marker. */
export const hasFinancingMarker = (book: SheetBook): boolean =>
  book.names.some(
    (n) => hasOwn(book.sheets, n) && book.sheets[n].some((r) => r.some((c) => typeof c === "string" && FINANCING_MARKER.test(c))),
  );

/** §8.4 forward block: a bank/workbook row whose text is a financing line or names an imported loan. */
export const isFinancingLine = (description: string, loanKeys: readonly string[] = []): boolean =>
  FINANCING_MARKER.test(description) || loanKeys.some((k) => !!k && description.includes(k));

export type FinancingItem = {
  /** Normalised '<branch>-<loan>-1'. */
  reference: string;
  /** Patient name from the fee lines (personal data), ≤ 200 chars. */
  name: string;
  date: string;
  gross: number;
  commission: number;
  kkdf: number;
  bsmv: number;
  file: string;
};

export const financingFee = (i: Pick<FinancingItem, "commission" | "kkdf" | "bsmv">): number => i.commission + i.kkdf + i.bsmv;
export const financingNet = (i: FinancingItem): number => i.gross - financingFee(i);
/** '<branch>-<loan>' (RT:65): the prefix searched for by the reverse guard. */
export const loanKey = (reference: string): string => reference.split("-").slice(0, 2).join("-");

type Kind = "gross" | "commission" | "kkdf" | "bsmv";
type Group = FinancingItem & { seen: Set<Kind> };

/** BF:10-31. Throws ImportParseError (legacy texts); returns items and skipped-line warnings. */
export function parseFinancing(book: SheetBook, file: string): { items: FinancingItem[]; warnings: string[] } {
  const groups = new Map<string, Group>();
  let recognized = false;
  const warnings: string[] = [];
  for (const sheetName of book.names) {
    if (!hasOwn(book.sheets, sheetName)) continue;
    const rows = book.sheets[sheetName];
    const h = rows.findIndex((r) => r.includes("İşlem Tarihi") && r.includes("İşlem Açıklaması") && r.includes("İşlem Tutarı"));
    if (h < 0) continue;
    const header = rows[h];
    const di = header.indexOf("İşlem Tarihi");
    const ai = header.indexOf("İşlem Tutarı");
    const ti = header.indexOf("İşlem Açıklaması");
    const ci = header.indexOf("Döviz Cinsi");
    if (!rows.some((r) => FINANCING_MARKER.test(String(r[ti])))) continue;
    recognized = true;
    for (const r of rows.slice(h + 1)) {
      const desc = String(r[ti] || "");
      const date = bankDate(r[di]);
      const value = bankNumber(r[ai], "tr");
      if (!desc.trim()) continue;
      if (!date || value === null || (ci >= 0 && !/^(TRY|TL)$/.test(String(r[ci]))))
        throw new ImportParseError("Burgan satırında tarih, tutar veya para birimi okunamadı.");
      const ref = desc.match(/\b(\d{4}-\d{7,}-\d+)\b/)?.[1];
      if (!ref) {
        warnings.push(date + ": finansman referansı olmayan hareket atlandı; genel banka aktarımından kontrol edin.");
        continue;
      }
      const kind: Kind | null =
        value > 0 ? "gross" : /KKDF/i.test(desc) ? "kkdf" : /BSMV/i.test(desc) ? "bsmv" : FINANCING_MARKER.test(desc) ? "commission" : null;
      if (!kind) {
        warnings.push(date + ": eşleşmeyen hareket atlandı.");
        continue;
      }
      // The incoming transfer can carry another suffix than the fee lines: group by branch and loan.
      const reference = loanKey(ref) + "-1";
      const key = reference + ":" + date;
      const g: Group = groups.get(key) || {
        reference,
        name: "Burgan hasta finansmanı",
        date,
        gross: 0,
        commission: 0,
        kkdf: 0,
        bsmv: 0,
        file: file.slice(0, 200),
        seen: new Set<Kind>(),
      };
      if (g.seen.has(kind)) throw new ImportParseError("Aynı finansman için birden fazla " + kind + " satırı var. Dosyayı kontrol edin.");
      g.seen.add(kind);
      g[kind] = Math.abs(value);
      if (kind !== "gross") {
        const name = desc.split(ref)[1]?.split(FINANCING_MARKER)[0]?.trim();
        if (name) g.name = name.slice(0, 200);
      }
      groups.set(key, g);
    }
  }
  if (!recognized) throw new ImportParseError("Burgan finansman tablosu bulunamadı. Bankanın Excel hesap hareketlerini seçin.");
  const items = Array.from(groups.values()).map(({ seen, ...g }) => {
    if (!(["gross", "commission", "kkdf", "bsmv"] as Kind[]).every((k) => seen.has(k)))
      throw new ImportParseError(g.date + ": finansmanın giriş veya kesinti satırları eksik. Tam dökümü yükleyin.");
    const problem = validateFinancingItem({ ...g, blocked: false, expectedRelease: null });
    if (problem) throw new ImportParseError(problem);
    return g;
  });
  if (!items.length) throw new ImportParseError("Finansman işlemi bulunamadı.");
  return { items, warnings };
}

/** BF:6 burganSchema refinements as a plain check. Returns the first problem or null. */
export function validateFinancingItem(
  i: FinancingItem & { blocked: boolean; expectedRelease: string | null },
): string | null {
  const amountOk = (n: number) => Number.isInteger(n) && n >= 0 && n <= 1e12;
  if (!/^\d+-\d+-\d+$/.test(i.reference)) return "Finansman referansı okunamadı.";
  if (!i.name.trim() || i.name.length > 200) return "Hasta adı okunamadı.";
  if (!financeDayOk(i.date)) return "Finansman tarihi okunamadı.";
  if (!amountOk(i.gross) || i.gross <= 0 || !amountOk(i.commission) || !amountOk(i.kkdf) || !amountOk(i.bsmv))
    return "Kesintileri kontrol edin.";
  const fee = financingFee(i);
  if (!(fee > 0 && fee < i.gross)) return "Kesintileri kontrol edin.";
  if (i.blocked && !i.expectedRelease) return "Bloke için tahmini çözülme tarihi gerekli.";
  if (i.expectedRelease && (!financeDayOk(i.expectedRelease) || i.expectedRelease < i.date)) return "Bloke tarihi işlemden önce olamaz.";
  return null;
}

/** BG:8: blocked mode proposes date + N days (N = fin_settings.default_block_days). */
export const proposedRelease = (date: string, blockDays: number): string => addDays(date, blockDays);

/** fin_financing_import item (p2i_db_contract §4.10.1 step 4, strict keys). */
export async function toFinancingPayload(
  item: FinancingItem,
  opts: { clinicId: string; blocked: boolean; expectedRelease: string | null; provider?: string },
) {
  const provider = opts.provider ?? "burgan";
  const key = financingKey(item.reference, item.date, provider);
  return {
    id: await financingRowId(opts.clinicId, key),
    entry_id: await importedEntryId(opts.clinicId, key),
    provider,
    reference: item.reference,
    patient_name_raw: item.name,
    txn_date: item.date,
    currency: "TRY" as const,
    gross_cents: item.gross,
    commission_cents: item.commission,
    kkdf_cents: item.kkdf,
    bsmv_cents: item.bsmv,
    blocked: opts.blocked,
    expected_release: opts.blocked ? opts.expectedRelease : null,
    file: item.file,
  };
}
