"use client";

import { useCallback, useEffect, useState } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { EntryTable } from "@/components/finance/EntryTable";
import { Card, ErrorBox, ListTotalsBox, Loading, MoneyRow, Pager } from "@/components/finance/ui";
import { finForecast, formatDay, toFinanceError, type FinanceError, type ForecastJson } from "@/lib/finance";

const PAGE_SIZE = 50;

export default function FinancePlanPage() {
  return (
    <FinanceShell title="Yaklaşan plan">
      <Plan />
    </FinanceShell>
  );
}

/** Legacy '15 günlük plan' tab (FP:69); the window length is fin_settings.forecast_days. */
function Plan() {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ForecastJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await finForecast(offset, PAGE_SIZE));
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onReload={load} />;

  return (
    <div className="space-y-4">
      <ErrorBox error={error} onReload={load} />
      <Card title={`${data.forecast_days} günlük plan · ${formatDay(data.today)} – ${formatDay(data.window_end)}`}>
        <div className="grid gap-x-8 md:grid-cols-2">
          <MoneyRow label="Ödemeler" cents={data.expected_out_cents} />
          <MoneyRow label="Beklenen tahsilatlar" cents={data.expected_in_cents} />
          <MoneyRow label="Toplam likit (son bakiye)" cents={data.liquid_cents} />
          <MoneyRow label="Ödeme sonrası likit" cents={data.after_payments_cents} tone="auto" />
          <MoneyRow label="Tahsilatlarla birlikte tahmini likit" cents={data.forecast_cents} tone="auto" strong />
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Vadesi geçmiş açık kayıtlar dahil; tahsilatların gerçekleşmesi varsayılır. Kısmi ödemelerde yalnızca kalan
          tutar sayılır.
          {data.liquid_cents === null && " Likit tahmini için önce banka ve kasa bakiyelerini girin."}
        </p>
      </Card>
      {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}
      <EntryTable rows={data.rows} emptyText="Bu dönemde açık kayıt yok." />
      <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
      <ListTotalsBox totals={data.totals} />
    </div>
  );
}
