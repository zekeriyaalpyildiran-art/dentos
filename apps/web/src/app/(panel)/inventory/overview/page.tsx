"use client";

// Stock overview for the owner ("Stok özeti"): where the money in stock sits, what left stock in a period (use vs
// count differences), what needs attention and the monthly receipt / use trend. Card, balance, lot and lot-cost rows
// are read directly (RLS: clinic, costs for cost viewers) and summed on the device (lib/stock/overview); the period
// figures come from stock_consumption_report, so corrections are counted exactly as on the Raporlar tab.

import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/lib/store";
import {
  monthRanges,
  periodRange,
  type OverviewBalance,
  type OverviewBatch,
  type OverviewCost,
  type OverviewItem,
  type PeriodKey,
} from "@/lib/stock/overview";
import {
  istanbulToday,
  stockConsumptionReport,
  stockDb,
  toStockError,
  type ConsumptionReport,
  type StockError,
} from "@/lib/stock/rpc";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { StockOverviewView, type MonthTotals, type StockData } from "@/components/stock/StockOverview";
import { Loading, Notice, StockErrorBox } from "@/components/stock/ui";

const READ_PAGE = 1000;
const MONTHS = 6;

/** Every row of a clinic table, 1000 at a time (PostgREST caps one answer). */
async function readAll<T>(table: string, columns: string, clinicId: string, orderBy: string, positiveQty = false): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    let q = stockDb().from(table).select(columns).eq("clinic_id", clinicId);
    if (positiveQty) q = q.gt("quantity", 0);
    const { data, error } = await q.order(orderBy).range(from, from + READ_PAGE - 1);
    if (error) throw toStockError(error);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < READ_PAGE) return out;
  }
}

async function readStock(clinicId: string): Promise<StockData> {
  const [items, balances, batches, costs] = await Promise.all([
    readAll<OverviewItem>(
      "stock_items",
      "id,item_code,item_name,category,usage_unit,min_qty,max_qty,is_active,needs_review",
      clinicId,
      "id"
    ),
    readAll<OverviewBalance>("stock_balances", "stock_item_id,batch_id,quantity", clinicId, "id", true),
    readAll<OverviewBatch>("stock_batches", "id,stock_item_id,expiry_date,received_at", clinicId, "id"),
    readAll<OverviewCost>("stock_batch_costs", "batch_id,unit_cost_cents", clinicId, "batch_id"),
  ]);
  return { items, balances, batches, costs };
}

export default function StockOverviewPage() {
  const user = useAuthStore((state) => state.user);
  const { today: serverToday, tick } = useStock();
  const today = serverToday ?? istanbulToday();
  const isOwner = user?.role === "owner";
  const clinicId = user?.clinic_id;

  const [stock, setStock] = useState<StockData | null>(null);
  const [stockError, setStockError] = useState<StockError | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [report, setReport] = useState<ConsumptionReport | null>(null);
  const [reportError, setReportError] = useState<StockError | null>(null);
  const [months, setMonths] = useState<MonthTotals[] | null>(null);
  const [monthsError, setMonthsError] = useState<StockError | null>(null);

  useEffect(() => {
    if (!isOwner || !clinicId) return;
    let cancelled = false;
    setStockError(null);
    readStock(clinicId)
      .then((d) => !cancelled && setStock(d))
      .catch((e) => !cancelled && setStockError(toStockError(e)));
    return () => {
      cancelled = true;
    };
  }, [isOwner, clinicId, tick]);

  const range = useMemo(() => periodRange(period, today), [period, today]);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    setReportError(null);
    setReport(null);
    stockConsumptionReport(range.from, range.to, {})
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setReportError(toStockError(e)));
    return () => {
      cancelled = true;
    };
  }, [isOwner, range.from, range.to, tick]);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    setMonthsError(null);
    setMonths(null);
    Promise.all(
      monthRanges(today, MONTHS).map(async (m) => {
        const r = await stockConsumptionReport(m.from, m.to, {});
        return { month: m.month, receivedCents: r.totals.received_cost_cents ?? 0, usedCents: r.totals.net_used_cost_cents ?? 0 };
      })
    )
      .then((list) => {
        if (cancelled) return;
        // Months before the first receipt or use (before stock tracking started) are left out.
        const first = list.findIndex((m) => m.receivedCents !== 0 || m.usedCents !== 0);
        setMonths(first < 0 ? [] : list.slice(first));
      })
      .catch((e) => !cancelled && setMonthsError(toStockError(e)));
    return () => {
      cancelled = true;
    };
  }, [isOwner, today, tick]);

  if (!user) {
    return (
      <StockShell title="Stok özeti">
        <Loading />
      </StockShell>
    );
  }
  if (!isOwner) {
    return (
      <StockShell title="Stok özeti">
        <Notice tone="warn">Bu sayfayı yalnızca klinik sahibi görebilir.</Notice>
      </StockShell>
    );
  }

  return (
    <StockShell title="Stok özeti" subtitle="Stokta ne var, stoktan ne çıktı, neye dikkat etmeli">
      <StockErrorBox error={stockError} />

      {!stock && !stockError ? (
        <Loading />
      ) : stock ? (
        <StockOverviewView
          stock={stock}
          today={today}
          period={period}
          onPeriod={setPeriod}
          range={range}
          report={report}
          reportError={reportError}
          months={months}
          monthsError={monthsError}
        />
      ) : null}
    </StockShell>
  );
}
