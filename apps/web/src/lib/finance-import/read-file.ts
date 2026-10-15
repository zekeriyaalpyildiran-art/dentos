// Finance import: the only module that touches SheetJS and pdf.js, both loaded lazily with
// dynamic import() so they are bundled into the import screens' chunks only (spec §0.3).
// Files are read in the browser and never uploaded. Read options are byte-for-byte legacy's
// (IP:41, BG:9) because every parser rule assumes the cell values they produce.

import type { PdfCell, SheetBook } from "./types";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const PDF_OPEN_TIMEOUT_MS = 30000;
/** Budget for reading the text of every page, after the document opened. */
export const PDF_TEXT_BUDGET_MS = 60000;
/** Rows parsed per sheet: one more than the limit, so an oversized sheet is detected without parsing it whole. */
export const SHEET_ROWS_PARSED = 10001;
/** Last column index kept (layouts and mappings address columns 0..255). */
export const MAX_SHEET_COL = 255;
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

export const GENERAL_ACCEPT = ".xlsx,.xls,.csv,.pdf";
export const FINANCING_ACCEPT = ".xlsx,.xls,.csv";

export class FileReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileReadError";
  }
}

export const fileTooLarge = (file: string) => `${file}: 15 MB sınırını aşıyor.`;
export const isPdfName = (name: string) => /\.pdf$/i.test(name);
export const isCsvName = (name: string) => /\.csv$/i.test(name);

// ---------------------------------------------------------------------------
// SheetJS (patched CDN build 0.20.3)
// ---------------------------------------------------------------------------

type Xlsx = typeof import("xlsx");
let xlsxPromise: Promise<Xlsx> | null = null;
/** Lazy SheetJS loader (one chunk, loaded on first use). */
export const loadXlsx = (): Promise<Xlsx> => (xlsxPromise ??= import("xlsx"));

/** D3: CSV text with a strict UTF-8 decode and a windows-1254 fallback. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1254").decode(bytes);
  }
}

export type SheetMode = "general" | "financing";

/**
 * Reads a spreadsheet into `header:1` arrays.
 * - general screen (IP:41): cellStyles/cellFormula off, cellDates on, raw:true; ≤ 9,999 rows per sheet.
 * - financing screen (BG:9): cellDates on; raw defaults to true; ≤ 10,000 rows per sheet.
 * - CSV (D3): decoded text read with raw:true so Turkish '1.234' stays a string.
 */
export async function readSpreadsheetFile(
  data: ArrayBuffer,
  fileName: string,
  mode: SheetMode,
  xlsx?: Pick<Xlsx, "read" | "utils">,
): Promise<SheetBook> {
  const X = xlsx ?? (await loadXlsx());
  // Resource limits (a crafted file must not exhaust the tab): parsing stops after SHEET_ROWS_PARSED rows per
  // sheet (the full range stays in !fullref for the limit check) and only columns 0..MAX_SHEET_COL are read.
  // Neither option changes the cell values of a sheet within the limits.
  const limits = { sheetRows: SHEET_ROWS_PARSED, dense: true } as const;
  const book = isCsvName(fileName)
    ? X.read(decodeCsv(new Uint8Array(data)), { type: "string", raw: true, cellDates: false, ...limits })
    : mode === "general"
      ? X.read(data, { type: "array", cellStyles: false, cellFormula: false, cellDates: true, ...limits })
      : X.read(data, { type: "array", cellDates: true, ...limits });
  const sheets: Record<string, unknown[][]> = {};
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    const ref = ws["!ref"];
    const full = (ws["!fullref"] as string | undefined) ?? ref;
    if (full) {
      const last = X.utils.decode_range(full).e.r;
      if (mode === "general" && last >= 10000)
        throw new FileReadError("Bir sayfada en fazla 10.000 satır destekleniyor. Dökümü tarih aralıklarına bölün.");
      if (mode === "financing" && last > 10000) throw new FileReadError("Dökümü 10.000 satırdan küçük bölümlere ayırın.");
    }
    if (ref) {
      const range = X.utils.decode_range(ref);
      if (range.e.c > MAX_SHEET_COL) ws["!ref"] = X.utils.encode_range({ s: range.s, e: { r: range.e.r, c: MAX_SHEET_COL } });
    }
    sheets[name] =
      mode === "general"
        ? X.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true })
        : X.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  }
  return { names: [...book.SheetNames], sheets };
}

// ---------------------------------------------------------------------------
// pdf.js (pdfjs-dist 4.10.38, legacy build; worker served from /public)
// ---------------------------------------------------------------------------

type TextContentItem = { str?: string; transform?: number[]; width?: number };
type PdfPage = { getTextContent: () => Promise<{ items: TextContentItem[] }> };
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void> };
type PdfTask = { promise: Promise<PdfDoc>; destroy: () => Promise<void> };
/** The slice of the pdf.js API used here (the browser build and the node legacy build both fit). */
export type PdfjsLike = {
  getDocument: (src: { data: Uint8Array; isEvalSupported: boolean }) => PdfTask;
  GlobalWorkerOptions: { workerSrc: string };
};

let pdfjsPromise: Promise<PdfjsLike> | null = null;
/**
 * Lazy browser loader. The legacy build polyfills what the modern build calls directly (Promise.withResolvers,
 * missing before Safari 17.4 / Chrome 119 / Firefox 121) and is the build the golden sample tests run. The worker
 * is legacy/build/pdf.worker.min.mjs copied to apps/web/public (pdf-worker script; a unit test checks the copy).
 */
export const loadPdfjs = (): Promise<PdfjsLike> =>
  (pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
    const lib = m as unknown as PdfjsLike;
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    return lib;
  }));

export type PdfRead = { numPages: number; pages: PdfCell[][] };

/** Rejects with a FileReadError when `deadline` (epoch ms) passes before `p` settles. */
async function withDeadline<T>(p: Promise<T>, deadline: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FileReadError(message)), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Text items per page exactly as legacy (IP:34-36): getDocument({data, isEvalSupported:false}) with
 * no cMapUrl/standardFontDataUrl, page.getTextContent() defaults, items that have 'str'.
 */
export async function readPdfFile(
  data: ArrayBuffer | Uint8Array,
  opts: { pdfjs?: PdfjsLike; onPage?: (page: number, total: number) => void; textBudgetMs?: number } = {},
): Promise<PdfRead> {
  const pdfjs = opts.pdfjs ?? (await loadPdfjs());
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const doc = await Promise.race([
    task.promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void task.destroy();
        reject(new FileReadError("PDF 30 saniyede açılamadı. Sayfayı yenileyip dosyayı tek başına deneyin."));
      }, PDF_OPEN_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new FileReadError("En fazla 50 sayfalık döküm yükleyin.");
    const pages: PdfCell[][] = [];
    const deadline = Date.now() + (opts.textBudgetMs ?? PDF_TEXT_BUDGET_MS);
    for (let p = 1; p <= doc.numPages; p++) {
      opts.onPage?.(p, doc.numPages);
      const content = await withDeadline(
        doc.getPage(p).then((page) => page.getTextContent()),
        deadline,
        "PDF sayfaları zamanında okunamadı. Dökümü daha küçük parçalar halinde yükleyin.",
      );
      pages.push(
        content.items
          .filter((item) => "str" in item)
          .map((item) => ({ str: String(item.str), transform: item.transform ?? [], width: item.width ?? 0 })),
      );
    }
    return { numPages: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}
