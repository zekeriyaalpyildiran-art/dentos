"use client";

// Period consumption report (spec p8_purchasing §12.7, §10). Stock managers and cost viewers; cost columns only
// when the server sent them. Count differences and room deliveries are separate columns, never consumption.

import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { TRACKING_LEVELS, categoryLabel, type TrackingLevel } from "@/lib/stock/codes";
import { downloadCsv, qtyCell, tlCell, toCsv, type CsvCell } from "@/lib/stock/csv";
import { canReadStockReport } from "@/lib/stock/purchasing";
import {
  istanbulToday,
  stockConsumptionReport,
  stockDb,
  toStockError,
  type ConsumptionFilters,
  type ConsumptionReport,
  type ConsumptionRow,
  type StockError,
} from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { useStockLocations } from "@/components/stock/useStockRefs";
import { PurchasingErrorBox } from "@/components/stock/purchasing/common";
import {
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  StatTile,
  buttonPrimary,
  buttonSecondary,
  formatTL,
  stockInput,
} from "@/components/stock/ui";

function signedQty(n: number): string {
  const v = Number(n);
  if (!v) return "0";
  return `${v > 0 ? "+" : "−"}${formatQty(Math.abs(v))}`;
}

function buildCsv(report: ConsumptionReport, withCost: boolean): string {
  const header: CsvCell[] = [
    "Stok kodu",
    "Ürün",
    "Kategori",
    "Takip",
    "Birim",
    "Açılış",
    "Mal kabul",
    "Siparişten gelen",
    "Kullanım",
    "İade",
    "Net kullanım",
    "Fire",
    "Sayım fazlası",
    "Sayım eksiği",
    "Sayım farkı",
    "Odalara teslim",
  ];
  if (withCost) {
    header.push(
      "Mal kabul tutarı (TL)",
      "Net kullanım maliyeti (TL)",
      "Fire maliyeti (TL)",
      "Sayım farkı maliyeti (TL)",
      "Fiyatsız satır"
    );
  }
  const rows: CsvCell[][] = [header];
  for (const r of report.rows) {
    const row: CsvCell[] = [
      r.item_code,
      r.item_name,
      categoryLabel(r.category),
      r.tracking_level,
      r.usage_unit,
      qtyCell(r.opening_qty),
      qtyCell(r.received_qty),
      qtyCell(r.received_po_qty),
      qtyCell(r.used_qty),
      qtyCell(r.returned_qty),
      qtyCell(r.net_used_qty),
      qtyCell(r.waste_qty),
      qtyCell(r.adjust_in_qty),
      qtyCell(r.adjust_out_qty),
      qtyCell(r.adjust_net_qty),
      qtyCell(r.room_delivery_qty),
    ];
    if (withCost) {
      row.push(
        tlCell(r.received_cost_cents),
        tlCell(r.net_used_cost_cents),
        tlCell(r.waste_cost_cents),
        tlCell(r.adjust_net_cost_cents),
        qtyCell(r.uncosted_rows)
      );
    }
    rows.push(row);
  }
  if (withCost) {
    const t = report.totals;
    const total: CsvCell[] = ["TOPLAM", ...Array<CsvCell>(15).fill("")];
    total.push(
      tlCell(t.received_cost_cents),
      tlCell(t.net_used_cost_cents),
      tlCell(t.waste_cost_cents),
      tlCell(t.adjust_net_cost_cents),
      qtyCell(t.uncosted_rows)
    );
    rows.push(total);
  }
  return toCsv(rows);
}

export default function StockReportsPage() {
  const { gates, today: serverToday, dashboard } = useStock();
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const today = serverToday ?? istanbulToday();
  const { active: locations } = useStockLocations();
  const [from, setFrom] = useState(() => `${istanbulToday().slice(0, 8)}01`);
  const [to, setTo] = useState(() => istanbulToday());
  const [category, setCategory] = useState("");
  const [locationId, setLocationId] = useState("");
  const [level, setLevel] = useState<TrackingLevel | "">("");
  const [categories, setCategories] = useState<string[]>([]);
  const [report, setReport] = useState<ConsumptionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);

  // Card categories for the filter (direct RLS-filtered read, like the pickers).
  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    stockDb()
      .from("stock_items")
      .select("category")
      .eq("clinic_id", clinicId)
      .then(({ data }) => {
        if (cancelled) return;
        const set = new Set<string>();
        for (const r of (data || []) as { category: string | null }[]) if (r.category) set.add(r.category);
        setCategories(Array.from(set).sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), "tr")));
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId]);

  const withCost = useMemo(() => !!report && typeof report.totals?.net_used_cost_cents === "number", [report]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const filters: ConsumptionFilters = {
        category: category || undefined,
        location_id: locationId || undefined,
        tracking_level: level || undefined,
      };
      setReport(await stockConsumptionReport(from, to, filters));
    } catch (e) {
      setReport(null);
      setError(toStockError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!canReadStockReport(gates)) {
    return (
      <StockShell title="Raporlar">
        <Notice tone="warn">Raporu görme yetkiniz yok.</Notice>
      </StockShell>
    );
  }

  return (
    <StockShell title="Raporlar" subtitle="Dönem tüketim raporu">
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end">
          <Field label="Başlangıç">
            <input type="date" className={stockInput} max={today} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Bitiş">
            <input type="date" className={stockInput} max={today} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Kategori">
            <select className={stockInput} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Tümü</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Konum">
            <select className={stockInput} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Tümü</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Takip">
            <select className={stockInput} value={level} onChange={(e) => setLevel(e.target.value as TrackingLevel | "")}>
              <option value="">Tümü</option>
              {TRACKING_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${buttonPrimary} min-h-[44px]`} disabled={busy || !from || !to} onClick={() => void run()}>
              {busy ? "Hazırlanıyor..." : "Raporu getir"}
            </button>
            <button
              type="button"
              className={`${buttonSecondary} min-h-[44px]`}
              disabled={!report || report.rows.length === 0}
              onClick={() => report && downloadCsv(`stok-tuketim-${report.from}-${report.to}.csv`, buildCsv(report, withCost))}
            >
              CSV indir
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-600 mt-3">
          Seçilen tarihlerdeki kayıtlar işlem tarihine göre hesaplanır. İadeler net kullanımdan düşer; fire ve sayım
          farkları ayrı gösterilir. Düzeltilmiş kayıtların doğru miktarı asıl işlemin tarihinde sayılır. Odalara teslimler
          tüketim değildir.
          {gates.cost && " Maliyetler lot maliyetlerinden alınır; fiyatsız satırlar ayrıca belirtilir."} En fazla 366 günlük
          aralık seçilebilir.
        </p>
      </Card>

      <div className="mb-4">
        <PurchasingErrorBox error={error} />
      </div>

      {withCost && report && (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 mb-4">
          <StatTile label="Net kullanım maliyeti" value={formatTL(report.totals.net_used_cost_cents)} />
          <StatTile label="Fire maliyeti" value={formatTL(report.totals.waste_cost_cents)} tone="red" />
          <StatTile label="Sayım farkı (maliyet)" value={formatTL(report.totals.adjust_net_cost_cents)} />
          <StatTile label="Mal kabul tutarı" value={formatTL(report.totals.received_cost_cents)} />
          {dashboard?.value && (
            <>
              <StatTile label="Güncel stok değeri" value={formatTL(dashboard.value.value_cents)} />
              <StatTile
                label="90 gün içinde SKT riski"
                value={formatTL(dashboard.value.expiry_risk_value_cents)}
                tone="amber"
              />
            </>
          )}
        </div>
      )}

      {busy && !report ? (
        <Loading />
      ) : report ? (
        <Card>
          {report.rows.length === 0 ? (
            <EmptyState>Bu dönemde hareket yok.</EmptyState>
          ) : (
            <>
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-left text-gray-700">
                    <tr>
                      <th className="px-3 py-2 sticky left-0 bg-gray-50 z-10">Ürün</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Mal kabul (siparişten)</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Net kullanım</th>
                      <th className="px-3 py-2 text-right">Fire</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Sayım farkı</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Odalara teslim</th>
                      {withCost && (
                        <>
                          <th className="px-3 py-2 text-right whitespace-nowrap">Mal kabul tutarı</th>
                          <th className="px-3 py-2 text-right whitespace-nowrap">Net kullanım maliyeti</th>
                          <th className="px-3 py-2 text-right whitespace-nowrap">Fire maliyeti</th>
                          <th className="px-3 py-2 text-right whitespace-nowrap">Sayım farkı maliyeti</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <ReportRow key={r.stock_item_id} row={r} withCost={withCost} />
                    ))}
                  </tbody>
                  {withCost && (
                    <tfoot>
                      <tr className="font-semibold border-t">
                        <td className="px-3 py-2 sticky left-0 bg-white">Toplam ({report.totals.items} ürün)</td>
                        <td colSpan={5} />
                        <td className="px-3 py-2 text-right tabular-nums">{formatTL(report.totals.received_cost_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTL(report.totals.net_used_cost_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTL(report.totals.waste_cost_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTL(report.totals.adjust_net_cost_cents)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {report.by_category.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-semibold min-h-[44px] flex items-center">Kategoriye göre</summary>
                  <table className="w-full text-sm mt-2">
                    <thead className="text-left text-gray-600 border-b">
                      <tr>
                        <th className="px-3 py-1">Kategori</th>
                        <th className="px-3 py-1 text-right">Ürün</th>
                        {withCost && <th className="px-3 py-1 text-right">Net kullanım maliyeti</th>}
                        {withCost && <th className="px-3 py-1 text-right">Fire maliyeti</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {report.by_category.map((c) => (
                        <tr key={c.category} className="border-b last:border-b-0">
                          <td className="px-3 py-1">{categoryLabel(c.category)}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{c.items}</td>
                          {withCost && <td className="px-3 py-1 text-right tabular-nums">{formatTL(c.net_used_cost_cents)}</td>}
                          {withCost && <td className="px-3 py-1 text-right tabular-nums">{formatTL(c.waste_cost_cents)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}
        </Card>
      ) : null}
    </StockShell>
  );
}

function ReportRow({ row: r, withCost }: { row: ConsumptionRow; withCost: boolean }) {
  const unit = r.usage_unit;
  return (
    <tr className="border-b align-top">
      <td className="px-3 py-2 sticky left-0 bg-white min-w-[10rem]">
        <span className="font-medium">{r.item_name}</span>
        <span className="block text-xs text-gray-500">
          {[r.item_code, categoryLabel(r.category), r.tracking_level].filter(Boolean).join(" · ")}
        </span>
        {withCost && typeof r.uncosted_rows === "number" && r.uncosted_rows > 0 && (
          <span className="block text-xs text-amber-700">{r.uncosted_rows} satırın fiyatı yok</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        {formatQty(r.received_qty)} {unit}
        {Number(r.received_po_qty) > 0 && <span className="block text-xs text-gray-500">({formatQty(r.received_po_qty)})</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        {formatQty(r.net_used_qty)} {unit}
        {Number(r.returned_qty) > 0 && (
          <span className="block text-xs text-gray-500">
            {formatQty(r.used_qty)} − {formatQty(r.returned_qty)} iade
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(r.waste_qty)}</td>
      <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${Number(r.adjust_net_qty) < 0 ? "text-red-700" : ""}`}>
        {signedQty(r.adjust_net_qty)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(r.room_delivery_qty)}</td>
      {withCost && (
        <>
          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(r.received_cost_cents)}</td>
          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(r.net_used_cost_cents)}</td>
          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(r.waste_cost_cents)}</td>
          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(r.adjust_net_cost_cents)}</td>
        </>
      )}
    </tr>
  );
}
