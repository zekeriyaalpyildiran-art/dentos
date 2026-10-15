// "Aranacaklar" call list PDF (CE:3-11, contract §5.2). Built in the browser from crm_overdue_list.export_rows:
// name, phone, date, days and the action only (never notes or money). The header uses the clinic name from the
// database; no clinic or person is hard-coded. Loaded only through a dynamic import() when the button is pressed.

import { A4, COLORS, createKit, fetchFonts, fit, wrap } from "./finance-pdf/common";

export interface CallListRow {
  name: string;
  phone: string;
  date: string;
  days: number;
  action: string;
}

function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}

export async function createCallListPdf(input: {
  clinicName: string;
  today: string;
  rows: CallListRow[];
}): Promise<Uint8Array> {
  const fonts = await fetchFonts();
  const kit = await createKit(fonts, {
    title: `Aranacaklar ${dayLabel(input.today)}`,
    author: input.clinicName || "DentOS",
    subject: "Geciken hasta arama listesi",
  });
  const { doc, font, bold, clean } = kit;
  const [W, H] = A4;
  const M = 40;
  const cols = [
    { label: "#", x: M, w: 22 },
    { label: "Hasta", x: M + 22, w: 140 },
    { label: "Telefon", x: M + 162, w: 95 },
    { label: "Tarih", x: M + 257, w: 58 },
    { label: "Gün", x: M + 315, w: 30 },
    { label: "Yapılacak", x: M + 345, w: W - M - (M + 345) },
  ];

  let page = doc.addPage(A4);
  let y = H - M;
  const pages = [page];

  const header = (first: boolean) => {
    if (first) {
      page.drawText(clean(input.clinicName || "Klinik"), { x: M, y: y - 14, size: 14, font: bold, color: COLORS.ink });
      y -= 30;
      page.drawText(clean(`Aranacak hastalar · ${dayLabel(input.today)} · ${input.rows.length} hasta`), {
        x: M,
        y,
        size: 10,
        font,
        color: COLORS.muted,
      });
      y -= 22;
    }
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: COLORS.pale });
    for (const c of cols) {
      page.drawText(clean(c.label), { x: c.x + 2, y, size: 8, font: bold, color: COLORS.ink });
    }
    y -= 18;
  };

  header(true);

  input.rows.forEach((row, i) => {
    const actionLines = wrap(font, clean(row.action), 8, cols[5].w - 4);
    const blockH = Math.max(1, actionLines.length) * 10 + 22;
    if (y - blockH < M + 20) {
      page = doc.addPage(A4);
      pages.push(page);
      y = H - M;
      header(false);
    }
    const color = row.days > 0 ? COLORS.red : COLORS.ink;
    page.drawText(String(i + 1), { x: cols[0].x + 2, y, size: 8, font, color: COLORS.muted });
    page.drawText(fit(bold, clean(row.name), 8, cols[1].w - 4), { x: cols[1].x + 2, y, size: 8, font: bold, color: COLORS.ink });
    page.drawText(fit(font, clean(row.phone), 8, cols[2].w - 4), { x: cols[2].x + 2, y, size: 8, font, color: COLORS.ink });
    page.drawText(dayLabel(row.date), { x: cols[3].x + 2, y, size: 8, font, color });
    page.drawText(String(row.days), { x: cols[4].x + 2, y, size: 8, font, color });
    actionLines.forEach((line, j) => {
      page.drawText(line, { x: cols[5].x + 2, y: y - j * 10, size: 8, font, color: COLORS.ink });
    });
    const lineY = y - actionLines.length * 10 - 4;
    page.drawText(clean("Sonuç / not:"), { x: cols[1].x + 2, y: lineY, size: 7, font, color: COLORS.muted });
    page.drawLine({
      start: { x: cols[1].x + 50, y: lineY - 1 },
      end: { x: W - M, y: lineY - 1 },
      thickness: 0.4,
      color: COLORS.muted,
    });
    y = lineY - 14;
  });

  if (input.rows.length === 0) {
    page.drawText(clean("Geciken arama veya takip yok."), { x: M, y, size: 10, font, color: COLORS.muted });
  }

  pages.forEach((p, i) => {
    p.drawText(clean(`${input.clinicName || "Klinik"} · Aranacaklar ${dayLabel(input.today)} · Sayfa ${i + 1}/${pages.length}`), {
      x: M,
      y: M / 2,
      size: 7,
      font,
      color: COLORS.muted,
    });
  });

  return doc.save();
}
