// Closing balance of a column-mapped bank statement (bank-table.ts closingBalance, balances.ts tableBalance).
//
// The last test reads a real Ziraat export only when DENTOS_ZIRAAT_SAMPLE points to it (skipped otherwise, like
// samples.test.ts). The file is never copied into the repo and this file holds none of its figures: the expected
// closing day and amount come from DENTOS_ZIRAAT_SAMPLE_EXPECT ('YYYY-MM-DD=1234.56') and are compared without
// printing them.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mapperBalance,
  maskedKeyLabel,
  TABLE_BALANCE_NEEDS_KEY,
  TABLE_BALANCE_NOTE,
  TABLE_BALANCE_UNKNOWN,
  tableBalance,
} from "../balances";
import { closingBalance, parseBankTable, suggestMapping, type BankMapping, type BankTable, type ChainRow } from "../bank-table";
import { normB } from "../primitives";
import { readSpreadsheetFile } from "../read-file";
import { seedRules } from "./fixtures";

const rules = seedRules();
const HEADER = ["Tarih", "Fiş No", "Açıklama", "İşlem Tutarı", "Bakiye"];
type Line = [date: string, amount: unknown, balance: unknown];

/** A statement like the Ziraat export: title lines, the header, movements in the given order, a footer. */
function statement(lines: Line[], name = "Hesap hareketleri"): BankTable {
  return {
    name,
    rows: [
      ["Sayın Müşteri", null, null, null, null],
      ["01.10.2026 - 05.10.2026 tarihleri arasındaki hesap hareketleri listelenmektedir.", null, null, null, null],
      HEADER,
      // Narration from the movement itself, so a re-ordered export describes each movement the same way.
      ...lines.map(([date, amount, balance]) => [date, "F1", "Hareket " + String(amount), amount, balance]),
      [],
      [null, null, null, "Borç:-1,00", "Alacak:1,00"],
    ],
  };
}

const mappingOf = (t: BankTable, patch: Partial<BankMapping> = {}): BankMapping => ({ ...suggestMapping(t.rows), account: "Banka 1234", ...patch });
const closingOf = async (t: BankTable, patch: Partial<BankMapping> = {}) => (await parseBankTable(t, mappingOf(t, patch), "x.xlsx", rules)).closing;

// 10.000,00 opening; two movements on 03.10, three on 04.10; closing 10.999,25 after the 04.10 −0,75 movement.
const OLDEST_FIRST: Line[] = [
  ["03.10.2026", "1.000,00", "11.000,00"],
  ["03.10.2026", "-250,50", "10.749,50"],
  ["04.10.2026", "-49,50", "10.700,00"],
  ["04.10.2026", "300,00", "11.000,00"],
  ["04.10.2026", "-0,75", "10.999,25"],
];

describe("closing balance of a column-mapped statement", () => {
  it("suggested mapping reads the balance column", () => {
    const m = mappingOf(statement(OLDEST_FIRST));
    expect([m.header, m.date, m.description, m.amount, m.balance, m.mode, m.format]).toEqual([2, 0, 2, 3, 4, "signed", "tr"]);
  });

  it("oldest first: the balance after the last movement of the latest day", async () => {
    expect(await closingOf(statement(OLDEST_FIRST))).toEqual({ ok: true, day: "2026-10-04", amountCents: 1099925, line: 8 });
  });

  it("newest first (bank export order): the same balance", async () => {
    expect(await closingOf(statement([...OLDEST_FIRST].reverse()))).toEqual({ ok: true, day: "2026-10-04", amountCents: 1099925, line: 4 });
  });

  it("same-day movements in any order follow the balance chain", async () => {
    const [a, b, c, d, e] = OLDEST_FIRST;
    const c1 = await closingOf(statement([d, a, e, b, c]));
    expect(c1).toMatchObject({ ok: true, day: "2026-10-04", amountCents: 1099925 });
  });

  it("single movement", async () => {
    expect(await closingOf(statement([["05.10.2026", "-12,34", "987,66"]]))).toEqual({ ok: true, day: "2026-10-05", amountCents: 98766, line: 4 });
  });

  it("several days: the latest date wins wherever it is in the file", async () => {
    const lines: Line[] = [
      ["03.10.2026", "-100,00", "900,00"],
      ["05.10.2026", "50,00", "1.000,00"],
      ["05.10.2026", "50,00", "1.050,00"],
      ["04.10.2026", "50,00", "950,00"],
    ];
    expect(await closingOf(statement(lines))).toMatchObject({ ok: true, day: "2026-10-05", amountCents: 105000 });
  });

  it("repeated balances are resolved by walking the whole chain back", () => {
    // 0 → +10 → 10 → +5 → 15 → −5 → 10 → +1 → 11: two movements end at 10; only one order uses every movement.
    const rows: ChainRow[] = [
      { date: "2026-10-04", signedCents: 1000, balanceCents: 1000, line: 1 },
      { date: "2026-10-04", signedCents: 100, balanceCents: 1100, line: 2 },
      { date: "2026-10-04", signedCents: 500, balanceCents: 1500, line: 3 },
      { date: "2026-10-04", signedCents: -500, balanceCents: 1000, line: 4 },
    ];
    expect(closingBalance(rows)).toEqual({ ok: true, day: "2026-10-04", amountCents: 1100, line: 2 });
  });

  it("ambiguous or inconsistent chains give no balance", async () => {
    // +100 then −100 or −100 then +100: both orders fit, the last balance is 1.000,00 or 1.100,00.
    const cycle = await closingOf(statement([["04.10.2026", "100,00", "1.100,00"], ["04.10.2026", "-100,00", "1.000,00"]]));
    expect(cycle).toEqual({ ok: false, day: "2026-10-04" });
    // Two separate chains (a movement in between is missing).
    const gap = await closingOf(statement([["04.10.2026", "-10,00", "990,00"], ["04.10.2026", "-20,00", "500,00"]]));
    expect(gap).toEqual({ ok: false, day: "2026-10-04" });
    // A column that is not the balance after each movement (here: the balance before it).
    const before = await closingOf(statement([["04.10.2026", "-10,00", "1.000,00"], ["04.10.2026", "-20,00", "990,00"], ["04.10.2026", "-5,00", "970,00"]]));
    expect(before).toEqual({ ok: false, day: "2026-10-04" });
    // Identical movements cannot both be last.
    const twice = await closingOf(statement([["04.10.2026", "-10,00", "990,00"], ["04.10.2026", "-10,00", "990,00"]]));
    expect(twice).toEqual({ ok: false, day: "2026-10-04" });
  });

  it("missing balance cells: unknown on the latest day, harmless on an earlier day", async () => {
    const [a, b, c, d, e] = OLDEST_FIRST;
    expect(await closingOf(statement([a, b, c, d, [e[0], e[1], ""]]))).toEqual({ ok: false, day: "2026-10-04" });
    expect(await closingOf(statement([a, b, c, d, [e[0], e[1], "-"]]))).toEqual({ ok: false, day: "2026-10-04" });
    expect(await closingOf(statement([a, b, c, d, [e[0], e[1], "bilinmiyor"]]))).toEqual({ ok: false, day: "2026-10-04" });
    expect(await closingOf(statement([[a[0], a[1], null], [b[0], b[1], ""], c, d, e]))).toMatchObject({ ok: true, amountCents: 1099925 });
  });

  it("a movement of the latest day that could not be read blocks the balance; total lines do not", async () => {
    const t = statement(OLDEST_FIRST);
    const unreadable = { ...t, rows: [...t.rows.slice(0, -2), ["04.10.2026", "F9", "Ödeme", "abc", "10.000,00"]] };
    expect(await closingOf(unreadable)).toEqual({ ok: false, day: "2026-10-04" });
    const later = { ...t, rows: [...t.rows.slice(0, -2), ["05.10.2026", "F9", "", "-1,00", "10.998,25"]] };
    expect(await closingOf(later)).toEqual({ ok: false, day: "2026-10-05" });
    const total = { ...t, rows: [...t.rows.slice(0, -2), ["04.10.2026", "", "Toplam", "1,00", "10.999,25"]] };
    expect(await closingOf(total)).toMatchObject({ ok: true, day: "2026-10-04", amountCents: 1099925 });
  });

  it("Turkish and English number formats, text or numeric cells, split debit/credit columns", async () => {
    const en: Line[] = [
      ["2026-10-03", "1,000.00", "11,000.00"],
      ["2026-10-04", "-0.75", "10,999.25"],
    ];
    expect(await closingOf(statement(en), { format: "en" })).toMatchObject({ ok: true, amountCents: 1099925 });
    // The same text read as Turkish is not a valid number: no balance is guessed.
    expect((await closingOf(statement(en), { format: "tr" }))?.ok).not.toBe(true);
    const numeric: Line[] = [
      ["03.10.2026", 1000, 11000],
      ["04.10.2026", -0.75, 10999.25],
    ];
    expect(await closingOf(statement(numeric))).toMatchObject({ ok: true, amountCents: 1099925 });
    const split: BankTable = {
      name: "Hareketler",
      rows: [
        ["İşlem Tarihi", "Açıklama", "Borç", "Alacak", "Bakiye"],
        ["04.10.2026", "Kira", "12.500,25", "", "87.499,75"],
        ["04.10.2026", "POS yatışı", "", "8.000,00", "95.499,75"],
        ["03.10.2026", "Devir", "", "", "100.000,00"],
      ],
    };
    expect(mappingOf(split).mode).toBe("split");
    expect(await closingOf(split)).toMatchObject({ ok: true, day: "2026-10-04", amountCents: 9549975 });
  });

  it("the latest day must start where the previous day ended", async () => {
    // 990,00 after 15.10; 16.10 −20,00 → 123,00 contradicts it (the column is not the balance after each movement).
    const contradicts: Line[] = [
      ["15.10.2026", "-10,00", "990,00"],
      ["16.10.2026", "-20,00", "123,00"],
    ];
    expect(await closingOf(statement(contradicts))).toEqual({ ok: false, day: "2026-10-16" });
    expect(await closingOf(statement([...contradicts].reverse()))).toEqual({ ok: false, day: "2026-10-16" });
    const fits: Line[] = [
      ["15.10.2026", "-10,00", "990,00"],
      ["16.10.2026", "-20,00", "970,00"],
    ];
    expect(await closingOf(statement(fits))).toMatchObject({ ok: true, day: "2026-10-16", amountCents: 97000 });
  });

  it("a mis-mapped balance column on a one-movement day gives no balance", async () => {
    // Like the Ziraat export (Tarih | Fiş No | Açıklama | İşlem Tutarı | Bakiye) with 'Fiş No' chosen as the balance.
    const t: BankTable = {
      name: "Hesap hareketleri",
      rows: [
        HEADER,
        ["16.10.2026", "4711", "Havale", "7.556,80", "42.559,72"],
        ["15.10.2026", "4710", "Masraf", "-2,63", "35.002,92"],
        ["15.10.2026", "4709", "Masraf", "-0,67", "35.005,55"],
        ["15.10.2026", "4708", "Ödeme", "-100.000,00", "35.006,22"],
      ],
    };
    expect(await closingOf(t)).toEqual({ ok: true, day: "2026-10-16", amountCents: 4255972, line: 2 });
    expect(await closingOf(t, { balance: 1 })).toEqual({ ok: false, day: "2026-10-16" });
    // A one-movement previous day: its 'balance' (a slip number) is not where the latest day started either.
    const oneEach = { ...t, rows: t.rows.slice(0, 3) };
    expect(await closingOf(oneEach)).toMatchObject({ ok: true, amountCents: 4255972 });
    expect(await closingOf(oneEach, { balance: 1 })).toEqual({ ok: false, day: "2026-10-16" });
  });

  it("a net-zero latest day (reversal) starts where the previous day ended", async () => {
    const prev: Line = ["15.10.2026", "-10,00", "1.000,00"];
    const pair: Line[] = [
      ["16.10.2026", "-50,00", "950,00"],
      ["16.10.2026", "50,00", "1.000,00"],
    ];
    expect(await closingOf(statement([prev, ...pair]))).toEqual({ ok: true, day: "2026-10-16", amountCents: 100000, line: 6 });
    expect(await closingOf(statement([...pair].reverse().concat([prev])))).toMatchObject({ ok: true, amountCents: 100000 });
    // Started at 950,00 the other order is the only one: +50 → 1.000,00, then −50 → 950,00.
    expect(await closingOf(statement([["15.10.2026", "-10,00", "950,00"], ...pair]))).toMatchObject({ ok: true, amountCents: 95000 });
    const three: Line[] = [
      ["15.10.2026", "5,00", "1.000,00"],
      ["16.10.2026", "150,00", "1.000,00"],
      ["16.10.2026", "-50,00", "850,00"],
      ["16.10.2026", "-100,00", "900,00"],
    ];
    expect(await closingOf(statement(three))).toMatchObject({ ok: true, day: "2026-10-16", amountCents: 100000 });
    // Without an earlier day, or when it cannot be told where that day ended, nothing is guessed.
    expect(await closingOf(statement(pair))).toEqual({ ok: false, day: "2026-10-16" });
    const prevPair: Line[] = [
      ["15.10.2026", "-5,00", "995,00"],
      ["15.10.2026", "5,00", "1.000,00"],
    ];
    expect(await closingOf(statement([...prevPair, ...pair]))).toEqual({ ok: false, day: "2026-10-16" });
    // ... and the previous day's balances still rule out a start that is none of them.
    const single: Line = ["16.10.2026", "-20,00", "975,00"];
    expect(await closingOf(statement([...prevPair, single]))).toMatchObject({ ok: true, amountCents: 97500 });
    expect(await closingOf(statement([...prevPair, ["16.10.2026", "-20,00", "123,00"]]))).toEqual({ ok: false, day: "2026-10-16" });
  });

  it("no check against a previous day that is not fully read", async () => {
    const t = statement([["16.10.2026", "-20,00", "970,00"]]);
    const prevMissing = { ...t, rows: [...t.rows.slice(0, 3), ["15.10.2026", "F1", "Ödeme", "-10,00", ""], ...t.rows.slice(3)] };
    expect(await closingOf(prevMissing)).toMatchObject({ ok: true, day: "2026-10-16", amountCents: 97000 });
    const prevBlocked = { ...t, rows: [...t.rows.slice(0, 3), ["15.10.2026", "F1", "Ödeme", "abc", "500,00"], ...t.rows.slice(3)] };
    expect(await closingOf(prevBlocked)).toMatchObject({ ok: true, day: "2026-10-16", amountCents: 97000 });
  });

  it("a movement whose date cannot be read gives no balance; undated total lines do not matter", async () => {
    const t = statement([["16.10.2026", "-10,00", "990,00"]]);
    const undated = { ...t, rows: [...t.rows.slice(0, 4), ["16.10.26", "F2", "Ödeme", "-20,00", "970,00"], ...t.rows.slice(4)] };
    const parsed = await parseBankTable(undated, mappingOf(undated), "x", rules);
    expect(parsed.issues.map((i) => i.line)).toContain(5);
    expect(parsed.closing).toEqual({ ok: false, day: "2026-10-16" });
    const total = { ...t, rows: [...t.rows.slice(0, 4), ["", "", "Toplam", "-10,00", ""], ...t.rows.slice(4)] };
    expect(await closingOf(total)).toMatchObject({ ok: true, amountCents: 99000 });
  });

  it("footer and zero-amount information lines do not block the day; an empty amount does", async () => {
    const t = statement([["16.10.2026", "-10,00", "990,00"]]);
    const withRow = (row: unknown[]) => ({ ...t, rows: [...t.rows.slice(0, 4), row, ...t.rows.slice(4)] });
    expect(await closingOf(withRow(["17.10.2026 10:34", "", "", "", ""]))).toMatchObject({ ok: true, day: "2026-10-16", amountCents: 99000 });
    expect(await closingOf(withRow(["16.10.2026", "F3", "Faiz oranı bilgisi", "0,00", "990,00"]))).toMatchObject({ ok: true, amountCents: 99000 });
    expect(await closingOf(withRow(["16.10.2026", "F3", "Ödeme", "", "970,00"]))).toEqual({ ok: false, day: "2026-10-16" });
    expect(await closingOf(withRow(["16.10.2026", "F3", "", "-20,00", "970,00"]))).toEqual({ ok: false, day: "2026-10-16" });
  });

  it("no balance column or no movement: nothing to offer", async () => {
    const t = statement(OLDEST_FIRST);
    expect(await closingOf(t, { balance: -1 })).toBeNull();
    expect(await closingOf(statement([]))).toBeNull();
    expect((await parseBankTable(t, mappingOf(t, { account: "" }), "x", rules)).closing).toBeNull();
  });

  it("row keys stay as before: the same movements give the same keys in either order", async () => {
    const t = statement(OLDEST_FIRST);
    const withBalance = await parseBankTable(t, mappingOf(t), "x", rules);
    const reread = await parseBankTable(statement([...OLDEST_FIRST].reverse()), mappingOf(t), "y", rules);
    expect(new Set(reread.rows.map((r) => r.key))).toEqual(new Set(withBalance.rows.map((r) => r.key)));
  });
});

describe("balance source for the balances card", () => {
  const ok = { ok: true as const, day: "2026-10-04", amountCents: 1099925, line: 8 };
  const opts = { importKey: "Ziraat:65712345675001", file: "ziraat.xlsx", today: "2026-10-17" };

  it("bank source for the resolved account's key, masked like the ready readers", () => {
    expect(tableBalance(ok, opts)).toEqual({
      source: {
        kind: "bank",
        importKey: "Ziraat:65712345675001",
        label: "Ziraat · …5001",
        day: "2026-10-04",
        amountCents: 1099925,
        file: "ziraat.xlsx",
        note: TABLE_BALANCE_NOTE,
      },
      note: null,
    });
    expect(tableBalance(ok, { ...opts, importKey: " Ziraat 657-12345678-5001 " }).source?.label).toBe("Ziraat …5001");
  });

  it("unknown balance, a future day or a pre-2000 day: no source, the card note", () => {
    const unknown = { source: null, note: TABLE_BALANCE_UNKNOWN };
    expect(tableBalance({ ok: false, day: "2026-10-04" }, opts)).toEqual(unknown);
    expect(tableBalance({ ...ok, day: "2026-10-18" }, opts)).toEqual(unknown);
    expect(tableBalance({ ...ok, day: "1999-12-31" }, opts)).toEqual(unknown);
    expect(tableBalance({ ...ok, day: "2026-10-17" }, opts).source?.day).toBe("2026-10-17");
  });

  it("no balance column or no account: nothing at all", () => {
    expect(tableBalance(null, opts)).toEqual({ source: null, note: null });
    expect(tableBalance(ok, { ...opts, importKey: "  " })).toEqual({ source: null, note: null });
  });

  it("mapper: the account's own key, or a linkable mapper key with the account to link", () => {
    const base = { file: "ziraat.xlsx", today: "2026-10-17" };
    const keyed = { id: "a", import_key: "Ziraat:65712345675001" };
    const free = { id: "b", import_key: null };
    const accounts = [keyed, free];
    expect(mapperBalance(ok, { ...base, account: keyed, keyLabel: "başka etiket", accounts }).source).toMatchObject({
      importKey: "Ziraat:65712345675001",
      label: "Ziraat · …5001",
    });
    expect(mapperBalance(ok, { ...base, account: keyed, keyLabel: "x", accounts }).source?.accountId).toBeUndefined();
    expect(mapperBalance(ok, { ...base, account: free, keyLabel: " Ziraat:657-5001 ", accounts }).source).toMatchObject({
      importKey: "Ziraat:657-5001",
      accountId: "b",
    });
    const needsKey = { source: null, note: TABLE_BALANCE_NEEDS_KEY };
    // Not 'Banka:hesap' (fin_set_account_import_key refuses it) or another account's key.
    expect(mapperBalance(ok, { ...base, account: free, keyLabel: "Ziraat Bankası Ana Hesap", accounts })).toEqual(needsKey);
    expect(mapperBalance(ok, { ...base, account: free, keyLabel: "Ziraat:65712345675001", accounts })).toEqual(needsKey);
    // An unknown balance stays the 'belirlenemedi' note.
    expect(mapperBalance({ ok: false, day: "2026-10-04" }, { ...base, account: free, keyLabel: "x y", accounts })).toEqual({
      source: null,
      note: TABLE_BALANCE_UNKNOWN,
    });
  });

  it("key labels", () => {
    expect(maskedKeyLabel("TEB:123456789")).toBe("TEB · …6789");
    expect(maskedKeyLabel("Garanti:1234-5678901")).toBe("Garanti · …8901");
    expect(maskedKeyLabel("Ziraat Ana Hesap")).toBe("Ziraat Ana Hesap");
    expect(maskedKeyLabel("Ziraat 5001")).toBe("Ziraat 5001");
    expect(maskedKeyLabel("Ziraat: TR12 0001 0006 5712 3456 7500 01")).toBe("Ziraat: TR…0001");
  });
});

const ZIRAAT = process.env.DENTOS_ZIRAAT_SAMPLE;
const ZIRAAT_EXPECT = process.env.DENTOS_ZIRAAT_SAMPLE_EXPECT;

/** Compares without printing the values (sample figures never reach a terminal or CI log). */
function same(label: string, actual: unknown, expected: unknown) {
  expect(JSON.stringify(actual) === JSON.stringify(expected), `${label}: örnek dosya beklentisiyle uyuşmuyor`).toBe(true);
}

describe.skipIf(!ZIRAAT || !existsSync(ZIRAAT))("real Ziraat statement (DENTOS_ZIRAAT_SAMPLE)", () => {
  it("closing balance after the last movement, in either row order", async () => {
    const bytes = readFileSync(ZIRAAT as string);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const book = await readSpreadsheetFile(data, "ziraat.xlsx", "general");
    const table = book.names
      .map((name) => ({ name, rows: book.sheets[name] }))
      .find((t) => {
        const m = suggestMapping(t.rows);
        return m.date >= 0 && m.amount >= 0 && m.balance >= 0;
      });
    expect(!!table, "bakiye sütunlu sayfa yok").toBe(true);
    const t = table as BankTable;
    const m = { ...suggestMapping(t.rows), account: "Ziraat örnek" };
    const parsed = await parseBankTable(t, m, "ziraat.xlsx", rules);
    expect(parsed.rows.length > 0, "hareket okunmadı").toBe(true);
    expect(parsed.closing?.ok, "son bakiye belirlenemedi").toBe(true);
    const reversed = { ...t, rows: [...t.rows.slice(0, m.header + 1), ...t.rows.slice(m.header + 1).reverse()] };
    const again = (await parseBankTable(reversed, m, "ziraat.xlsx", rules)).closing;
    const pick = (c: typeof again) => (c?.ok ? [c.day, c.amountCents] : null);
    same("ters sıralı dosya", pick(again), pick(parsed.closing));
    // The slip-number column chosen as the balance is refused (the last day must start where the day before ended).
    const slip = t.rows[m.header].findIndex((c) => normB(c).trim() === "fis no");
    if (slip >= 0) {
      const wrong = (await parseBankTable(t, { ...m, balance: slip }, "ziraat.xlsx", rules)).closing;
      expect(wrong?.ok === true, "yanlış bakiye sütunu kabul edildi").toBe(false);
    }
    const { source, note } = tableBalance(parsed.closing, { importKey: "Ziraat:0000", file: "ziraat.xlsx", today: "9999-12-31" });
    expect(!!source && note === null, "bakiye kaynağı yok").toBe(true);
    if (ZIRAAT_EXPECT) {
      const [day, tl] = ZIRAAT_EXPECT.split("=");
      same("kapanış günü ve bakiyesi", [source?.day, source?.amountCents], [day, Math.round(Number(tl) * 100)]);
    }
  });
});
