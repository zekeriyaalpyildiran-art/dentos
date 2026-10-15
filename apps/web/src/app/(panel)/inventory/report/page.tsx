"use client";

// Period stock report for cost viewers (contract §5.12). Aggregated in SQL; the CSV is built on the device.

import { useState } from "react";
import { categoryLabel } from "@/lib/stock/codes";
import { addDays } from "@/lib/stock/expiry";
import { istanbulToday, stockPeriodReport, toStockError, type PeriodReport, type StockError } from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { formatTL } from "@/lib/finance";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import {
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  StockErrorBox,
  buttonPrimary,
  buttonSecondary,
  stockInput,
} from "@/components/stock/ui";

/** Semicolon CSV cell with formula-injection guard (Excel opens it with Turkish decimals). */
function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n).replace(".", ","));
const money = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));

export default function StockReportPage() {
  const { gates } = useStock();
  const [from, setFrom] = useState(() => addDays(istanbulToday(), -30));
  const [to, setTo] = useState(() => istanbulToday());
  const [report, setReport] = useState<PeriodReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(await stockPeriodReport(from, to));
    } catch (e) {
      setReport(null);
      setError(toStockError(e));
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    if (!report) return;
    const header = [
      "Ürün",
      "Kategori",
      "Birim",
      "Açılış",
      "Mal kabul",
      "Kullanım",
      "İade",
      "Fire",
      "Sayım artı",
      "Sayım eksi",
      "Net kullanım maliyeti (TL)",
      "Fire maliyeti (TL)",
      "Sayım net maliyeti (TL)",
      "Fiyatsız satır",
    ];
    const lines = report.rows.map((r) =>
      [
        r.item_name,
        categoryLabel(r.category),
        r.usage_unit ?? "",
        num(r.opening_qty),
        num(r.received_qty),
        num(r.used_qty),
        num(r.returned_qty),
        num(r.waste_qty),
        num(r.adjust_in_qty),
        num(r.adjust_out_qty),
        money(r.net_used_cost_cents),
        money(r.waste_cost_cents),
        money(r.adjust_net_cost_cents),
        r.uncosted_rows,
      ]
        .map(csvCell)
        .join(";")
    );
    const blob = new Blob(["﻿" + [header.map(csvCell).join(";"), ...lines].join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stok-raporu-${report.from}-${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!gates.cost) {
    return (
      <StockShell title="Stok raporu">
        <Notice tone="warn">Maliyet bilgilerini görme yetkiniz yok.</Notice>
      </StockShell>
    );
  }

  return (
    <StockShell title="Stok raporu" subtitle="Dönem içindeki giriş, kullanım, fire ve sayım farkları (düzeltilmiş kayıtlar hariç).">
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Başlangıç">
            <input type="date" className={stockInput} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Bitiş">
            <input type="date" className={stockInput} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button type="button" className={`${buttonPrimary} min-h-[44px]`} disabled={busy || !from || !to} onClick={() => void run()}>
            {busy ? "Hazırlanıyor..." : "Raporu getir"}
          </button>
          {report && report.rows.length > 0 && (
            <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={downloadCsv}>
              CSV indir
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-2">En fazla 366 günlük aralık seçilebilir.</p>
      </Card>
      <StockErrorBox error={error} />
      {busy && !report ? (
        <Loading />
      ) : report ? (
        <Card>
          {report.rows.length === 0 ? (
            <EmptyState>Bu dönemde hareket yok.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-left text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Ürün</th>
                    <th className="px-3 py-2 text-right">Mal kabul</th>
                    <th className="px-3 py-2 text-right">Kullanım</th>
                    <th className="px-3 py-2 text-right">İade</th>
                    <th className="px-3 py-2 text-right">Fire</th>
                    <th className="px-3 py-2 text-right">Sayım ±</th>
                    <th className="px-3 py-2 text-right">Net kullanım</th>
                    <th className="px-3 py-2 text-right">Fire maliyeti</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.stock_item_id} className="border-b">
                      <td className="px-3 py-2">
                        {r.item_name}
                        {r.uncosted_rows > 0 && (
                          <span className="block text-xs text-amber-700">{r.uncosted_rows} satırın fiyatı yok</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(Number(r.received_qty) + Number(r.opening_qty))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(r.used_qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(r.returned_qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(r.waste_qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        +{formatQty(r.adjust_in_qty)} / −{formatQty(r.adjust_out_qty)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.net_used_cost_cents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.waste_cost_cents)}</td>
                    </tr>
                  ))}
                </tbody>
                {report.totals && (
                  <tfoot>
                    <tr className="font-semibold">
                      <td className="px-3 py-2">Toplam</td>
                      <td colSpan={5} />
                      <td className="px-3 py-2 text-right tabular-nums">{formatTL(report.totals.net_used_cost_cents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTL(report.totals.waste_cost_cents)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </StockShell>
  );
}
