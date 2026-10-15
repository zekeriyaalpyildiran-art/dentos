// Finance import, parser C: bank spreadsheets with a known layout (spec p2i_parsers_rules §6.1, §13.2).
//
// TEB internet-banking export (DentOS addition D6). Legacy sent it to the generic mapper; this
// reader emits exactly the keys the legacy TEB *PDF* reader emits for the same movements, so a
// PDF and a spreadsheet of the same period de-duplicate by key. Detection uses format markers only.
// (The legacy Ziraat reader is not ported: open point O2, default "not ported".)

import { bankRow, TEB_MARKER } from "./bank-text";
import type { CompiledRules } from "./classify";
import { isoDate, trMoney, trNumber, bankText } from "./primitives";
import type { BalanceSource, ParseResult, ParsedRow } from "./types";
import { maskedLabel } from "./balances";

const HEADER_LABELS = ["Valör", "Tutar", "Bakiye", "Dekont"];

type TebLayout = { header: number; dateCol: number; descCol: number; amountCol: number; balCol: number; account: string };

/** §6.1 detection on one sheet; returns the column map or null. */
export function detectTebSheet(table: unknown[][]): TebLayout | null {
  if (!table.some((r) => r.some((c) => typeof c === "string" && TEB_MARKER.test(c)))) return null;
  const header = table
    .slice(0, 30)
    .findIndex((r) => r[0] === "Tarih" && HEADER_LABELS.every((l) => r.includes(l)));
  if (header < 0) return null;
  const accountRow = table.find((r) => r[0] === "Hesap Numarası");
  // The account is part of every key and must equal the TEB PDF reader's text. A numeric cell may have lost
  // leading zeros or formatting, so only a text cell of digits (spaces / dashes allowed) is accepted; anything
  // else falls back to the generic mapper instead of producing keys that silently differ.
  const rawAccount = accountRow?.[1];
  if (typeof rawAccount !== "string" || !/^\d[\d -]*$/.test(rawAccount.trim())) return null;
  const h = table[header];
  return {
    header,
    dateCol: h.indexOf("Tarih"),
    descCol: h.indexOf("Açıklama"),
    amountCol: h.indexOf("Tutar"),
    balCol: h.indexOf("Bakiye"),
    account: rawAccount.trim().replace(/\s/g, ""),
  };
}

export type TebSheetResult = ParseResult & { accountImportKey: string; balance: BalanceSource | null; balanceNote: string | null };

/** §6.1 rows and §13.2 header balance. */
export function parseTebSheet(table: unknown[][], layout: TebLayout, file: string, rules: CompiledRules): TebSheetResult {
  const bankAccount = "TEB:" + layout.account;
  const rows: ParsedRow[] = [];
  const issues: ParseResult["issues"] = [];
  const dated: { date: string; balCents: number; index: number }[] = [];
  for (let i = layout.header + 1; i < table.length; i++) {
    const r = table[i];
    const date = isoDate(String(r[layout.dateCol] || ""));
    if (!date) continue;
    const amt = r[layout.amountCol];
    const bal = r[layout.balCol];
    if (typeof amt !== "number" || !Number.isFinite(amt) || typeof bal !== "number" || !Number.isFinite(bal)) {
      issues.push({ line: i + 1, reason: "Tutar veya bakiye okunamadı; satır eklenmedi." });
      continue;
    }
    const balCents = Math.round(bal * 100);
    const amountTl = Math.round(amt * 100) / 100;
    rows.push({
      ...bankRow({
        file,
        bankAccount,
        date,
        description: layout.descCol >= 0 ? bankText(r[layout.descCol]) : "",
        amountTl,
        balance: trMoney(balCents),
        sourceKind: "bank_known",
        rules,
      }),
      meta: { line: i + 1 },
    });
    dated.push({ date, balCents, index: i });
  }
  // §13.2 header balance, cross-checked with the last dated movement.
  let balance: BalanceSource | null = null;
  let balanceNote: string | null = null;
  const valueRow = table.find((r) => r[0] === "Bakiye");
  let day = "";
  for (const r of table) {
    for (const c of r) {
      if (typeof c !== "string") continue;
      const m = c.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
      if (m) {
        day = isoDate(m[2]);
        break;
      }
    }
    if (day) break;
  }
  if (valueRow && day && layout.account) {
    const value = trNumber(String(valueRow[1] ?? ""));
    if (Number.isFinite(value)) {
      const amountCents = Math.round(value * 100);
      const latest = dated.reduce<(typeof dated)[number] | null>((best, x) => {
        if (!best || x.date > best.date) return x;
        // Same day: the later line in an ascending export, the earlier one in a descending export.
        if (x.date === best.date) return dated[0].date <= dated[dated.length - 1].date ? x : best;
        return best;
      }, null);
      if (latest && latest.balCents !== amountCents) {
        balanceNote = `${file}: başlık bakiyesi son hareket bakiyesiyle uyuşmuyor; bakiye okunmadı.`;
      } else {
        balance = {
          kind: "bank",
          importKey: bankAccount,
          label: maskedLabel("TEB", layout.account),
          day,
          amountCents,
          file,
          note: "Dökümdeki hesap bakiyesi; kullanılabilir limit veya işlem toplamı değildir.",
        };
      }
    }
  }
  if (!balance && !balanceNote) balanceNote = `${file}: hesap bakiyesi otomatik okunamadı; hareket eşleştirmesi bakiyeyi değiştirmez.`;
  return {
    accountImportKey: bankAccount,
    rows,
    issues,
    notes: [
      `${file}: ${rows.length} banka hareketi okundu. Banka girişleri çift tahsilatı önlemek için seçili değil. Tarih ve tutarları önizlemede kontrol edin.`,
    ],
    balance,
    balanceNote,
  };
}
