// Shared pdf-lib helpers for the Phase 3 finance PDFs. This module (and pdf-lib / fontkit with it) is only ever
// loaded through a dynamic import() when a PDF button is pressed, so no other page ships it.

import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { formatTL } from "../finance";

export const A4: [number, number] = [595.28, 841.89];

export const COLORS = {
  ink: rgb(0.08, 0.18, 0.22),
  accent: rgb(0.03, 0.4, 0.35),
  muted: rgb(0.35, 0.42, 0.46),
  pale: rgb(0.93, 0.97, 0.96),
  warn: rgb(0.72, 0.33, 0.04),
  warnPale: rgb(1, 0.95, 0.88),
  red: rgb(0.75, 0.1, 0.1),
};

/**
 * DejaVu Sans (Bitstream Vera license, see /fonts/DejaVu-LICENSE.txt) covers every Turkish letter. The files in
 * public/fonts are unmodified copies of DejaVuSans.ttf / DejaVuSans-Bold.ttf from the npm package
 * dejavu-fonts-ttf@2.37.3 (ttf/ directory).
 */
const FONT_URLS = { regular: "/fonts/DejaVuSans.ttf", bold: "/fonts/DejaVuSans-Bold.ttf" };

export interface FontBytes {
  regular: ArrayBuffer;
  bold: ArrayBuffer;
}

export async function fetchFonts(): Promise<FontBytes> {
  const load = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("PDF yazı tipi yüklenemedi.");
    return res.arrayBuffer();
  };
  const [regular, bold] = await Promise.all([load(FONT_URLS.regular), load(FONT_URLS.bold)]);
  return { regular, bold };
}

export interface PdfKit {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  /** formatTL, with "TL" instead of "₺" if the embedded font lacked the lira sign */
  money: (cents: number | null | undefined) => string;
  /** strips control characters and replaces glyphs the font does not have */
  clean: (text: string) => string;
}

export async function createKit(
  fonts: FontBytes,
  meta: { title: string; author: string; subject: string }
): Promise<PdfKit> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fonts.regular, { subset: true });
  const bold = await doc.embedFont(fonts.bold, { subset: true });
  doc.setTitle(meta.title);
  doc.setAuthor(meta.author);
  doc.setSubject(meta.subject);
  doc.setCreator("DentOS");
  doc.setProducer("DentOS");
  doc.setLanguage("tr-TR");
  doc.setCreationDate(new Date());

  const chars = new Set(font.getCharacterSet());
  const boldChars = new Set(bold.getCharacterSet());
  const hasLira = chars.has(0x20ba) && boldChars.has(0x20ba);
  const money = (cents: number | null | undefined) => {
    const s = formatTL(cents);
    if (hasLira || s === "—") return s;
    return s.replace("₺", "") + " TL";
  };
  const clean = (text: string) => {
    let out = "";
    for (const ch of (text ?? "").replace(/[\r\n\t]+/g, " ")) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
      out += chars.has(cp) && boldChars.has(cp) ? ch : "?";
    }
    return out;
  };
  return { doc, font, bold, money, clean };
}

/** Shortens text with an ellipsis until it fits the width. */
export function fit(font: PDFFont, text: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let s = text;
  while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > width) s = s.slice(0, -1);
  return s + "…";
}

/** Word wrap; words wider than the line are broken by character (legacy finance-pdf text()). */
export function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let part = "";
  for (const word of text.split(/ +/)) {
    const next = part ? part + " " + word : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      part = next;
      continue;
    }
    if (part) lines.push(part);
    part = "";
    for (const ch of Array.from(word)) {
      if (part && font.widthOfTextAtSize(part + ch, size) > width) {
        lines.push(part);
        part = "";
      }
      part += ch;
    }
  }
  lines.push(part || " ");
  return lines;
}

export function drawRight(
  page: PDFPage,
  font: PDFFont,
  text: string,
  right: number,
  y: number,
  size: number,
  color: RGB
) {
  page.drawText(text, { x: right - font.widthOfTextAtSize(text, size), y, size, font, color });
}

/** 'Klinik Adı' → 'Klinik-Adi' for file names (ASCII only). */
export function fileSlug(text: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "C", Ğ: "G", İ: "I", Ö: "O", Ş: "S", Ü: "U" };
  const ascii = text
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => map[c] ?? c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const slug = ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "Klinik";
}
