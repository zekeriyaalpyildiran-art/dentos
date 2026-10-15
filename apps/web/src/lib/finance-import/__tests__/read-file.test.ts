import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { decodeCsv, readSpreadsheetFile } from "../read-file";

const require = createRequire(import.meta.url);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("libraries", () => {
  it("public/pdf.worker.min.mjs is the installed pdfjs-dist worker", () => {
    const pkg = require.resolve("pdfjs-dist/package.json");
    expect(require("pdfjs-dist/package.json").version).toBe("4.10.38");
    const installed = join(pkg, "..", "legacy", "build", "pdf.worker.min.mjs");
    const served = join(__dirname, "..", "..", "..", "..", "public", "pdf.worker.min.mjs");
    expect(sha(served), "run: pnpm --filter @dentos/web pdf-worker").toBe(sha(installed));
  });
  it("SheetJS is the patched 0.20.3 build", async () => {
    const X = await import("xlsx");
    expect(X.version).toBe("0.20.3");
  });
});

describe("resource limits", () => {
  it("columns beyond 255 are not read; oversized sheets fail without parsing them whole", async () => {
    const X = await import("xlsx");
    const ws = X.utils.aoa_to_sheet([["a", 1]]);
    ws["Z1"] = { t: "s", v: "z" };
    ws["JZ1"] = { t: "s", v: "far" }; // column index 285
    ws["!ref"] = "A1:JZ1";
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, "S");
    const out = X.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const book = await readSpreadsheetFile(out, "x.xlsx", "general");
    expect(book.sheets.S[0]).toHaveLength(256);
    expect(book.sheets.S[0][25]).toBe("z");
    const big = X.utils.aoa_to_sheet(Array.from({ length: 10002 }, (_, i) => [i]));
    const wb2 = X.utils.book_new();
    X.utils.book_append_sheet(wb2, big, "S");
    const out2 = X.write(wb2, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    await expect(readSpreadsheetFile(out2, "x.xlsx", "general")).rejects.toThrow(/10\.000 satır/);
  });
});

describe("CSV (D3)", () => {
  it("decodes UTF-8 strictly and falls back to windows-1254", () => {
    expect(decodeCsv(new TextEncoder().encode("Açıklama"))).toBe("Açıklama");
    expect(decodeCsv(new Uint8Array([0xfd, 0xfe, 0xf0]))).toBe("ışğ");
  });
  it("keeps Turkish numbers as text", async () => {
    const bytes = new TextEncoder().encode("Tarih,Açıklama,Tutar\n03.10.2026,Kira,1.234\n");
    const book = await readSpreadsheetFile(bytes.buffer as ArrayBuffer, "x.csv", "general");
    expect(book.sheets[book.names[0]][1]).toEqual(["03.10.2026", "Kira", "1.234"]);
  });
  it("reads xlsx with header:1 and keeps blank rows", async () => {
    const X = await import("xlsx");
    const ws = X.utils.aoa_to_sheet([["a", 1], [], ["b", 2.5]]);
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, "01");
    const out = X.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const book = await readSpreadsheetFile(out, "x.xlsx", "general");
    expect(book.names).toEqual(["01"]);
    expect(book.sheets["01"].length).toBe(3);
    expect(book.sheets["01"][2]).toEqual(["b", 2.5]);
  });
});
