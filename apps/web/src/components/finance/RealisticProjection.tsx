"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  finDashboard,
  finFinancingList,
  finFinancingSummary,
  finForecast,
  formatDay,
  formatMonth,
  formatTL,
  toFinanceError,
  type EntryJson,
  type FinanceError,
  type FinancingJson,
  type ForecastJson,
} from "@/lib/finance";
import {
  buildProjection,
  dailyNetEstimate,
  monthDays,
  previousMonth,
  weekday,
  type DailyEstimate,
} from "@/lib/finance-projection";
import { Card, ErrorBox, Loading, MoneyRow } from "./ui";

const WEEKDAYS = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
const NUM = "px-2 py-1.5 text-right tabular-nums whitespace-nowrap";

type Loaded = {
  plan: EntryJson[];
  releases: FinancingJson[];
  estimate: DailyEstimate;
  months: [string, string];
};

/** Every open entry of the plan window (fin_forecast pages of 200). */
async function allPlanRows(): Promise<EntryJson[]> {
  const rows: EntryJson[] = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const page = await finForecast(offset, 200);
    rows.push(...page.rows);
    if (rows.length >= page.total_count || page.rows.length === 0) break;
  }
  return rows;
}

/**
 * 'Yaklaşan plan': the balance day by day with the planned entries, the expected Burgan releases and an estimated
 * daily net flow (receipts − day-to-day outflows of the previous month and this month so far). The estimate can be
 * overridden (e.g. 0 for a worst case). Nothing is saved.
 */
export function RealisticProjection({ forecast }: { forecast: ForecastJson }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [override, setOverride] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const cur = forecast.today.slice(0, 7);
      const prev = previousMonth(cur);
      const [plan, list, dPrev, dCur, fPrev, fCur] = await Promise.all([
        allPlanRows(),
        finFinancingList({ status: "blocked" }, { offset: 0, limit: 200 }),
        finDashboard(prev),
        finDashboard(cur),
        finFinancingSummary(prev),
        finFinancingSummary(cur),
      ]);
      const estimate = dailyNetEstimate([
        { days: monthDays(prev), rows: dPrev.category_report, financingGrossCents: fPrev.gross_cents, financingFeeCents: fPrev.fee_cents },
        {
          days: Number(forecast.today.slice(8, 10)),
          rows: dCur.category_report,
          financingGrossCents: fCur.gross_cents,
          financingFeeCents: fCur.fee_cents,
        },
      ]);
      setLoaded({ plan, releases: list.rows, estimate, months: [prev, cur] });
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    }
  }, [forecast.today]);

  useEffect(() => {
    load();
  }, [load]);

  const overrideCents = useMemo(() => {
    const t = override.trim().replace(/\./g, "").replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }, [override]);

  const projection = useMemo(() => {
    if (!loaded) return null;
    return buildProjection({
      today: forecast.today,
      windowEnd: forecast.window_end,
      startCents: forecast.liquid_cents ?? 0,
      plan: loaded.plan.filter((r) => !r.cancelled_at && r.outstanding_cents > 0),
      releases: loaded.releases.map((f) => ({
        id: f.id,
        name: f.patient_name ?? f.patient_name_raw,
        expected_release: f.expected_release,
        net_cents: f.net_cents,
      })),
      dailyNetCents: overrideCents ?? loaded.estimate.dailyNetCents,
    });
  }, [loaded, forecast, overrideCents]);

  if (error) return <ErrorBox error={error} onReload={load} />;
  if (!loaded || !projection) return <Loading />;

  const { estimate, months } = loaded;
  const daily = overrideCents ?? estimate.dailyNetCents;
  const burganTotal = projection.releases.reduce((n, r) => n + r.net_cents, 0);
  const minNegative = !!projection.min && projection.min.balanceCents < 0;

  return (
    <Card title={`Gün gün tahmini bakiye · ${formatDay(forecast.today)} – ${formatDay(forecast.window_end)}`}>
      <div className="grid gap-x-8 md:grid-cols-2">
        <MoneyRow
          label="Son bakiye (banka + kasa)"
          cents={forecast.liquid_cents}
          hint={forecast.snapshot_day ? `${formatDay(forecast.snapshot_day)} tarihli bakiye` : undefined}
        />
        <MoneyRow label="Planlı ödemeler − tahsilatlar" cents={forecast.expected_in_cents - forecast.expected_out_cents} tone="auto" />
        <MoneyRow
          label={`Burgan bloke çözülmeleri (${projection.releases.length})`}
          cents={burganTotal}
          hint="Tahmini çözülme günü; bankadan doğrulayın."
        />
        <MoneyRow
          label="Günlük net akış tahmini"
          cents={daily}
          tone="auto"
          hint={
            overrideCents === null
              ? `${formatMonth(months[0])} ve ${formatMonth(months[1])} ortalaması (${estimate.days} gün)`
              : "Elle girilen değer"
          }
        />
        <MoneyRow label="Dönem sonu tahmini bakiye" cents={projection.endBalanceCents} tone="auto" strong />
        <MoneyRow
          label="En düşük bakiye"
          cents={projection.min?.balanceCents ?? null}
          tone="auto"
          strong
          hint={projection.min ? `${formatDay(projection.min.day)} ${WEEKDAYS[weekday(projection.min.day)]}` : undefined}
        />
      </div>

      {minNegative && (
        <p role="alert" className="mt-3 p-3 rounded bg-red-50 text-red-700 text-sm">
          {formatDay(projection.min!.day)} günü bakiye eksiye düşüyor ({formatTL(projection.min!.balanceCents)}). Kasadan
          bankaya para aktarmayı ya da bir ödemenin gününü değiştirmeyi planlayın.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          <span className="block font-semibold text-gray-800 mb-1">Günlük net akış (TL/gün)</span>
          <input
            inputMode="decimal"
            className="px-3 py-2 border rounded bg-white text-gray-900 w-40"
            placeholder={String(Math.round(estimate.dailyNetCents / 100))}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
          />
        </label>
        {override && (
          <button type="button" className="px-3 py-2 border rounded hover:bg-gray-50" onClick={() => setOverride("")}>
            Ortalamaya dön
          </button>
        )}
        <span className="text-gray-600">
          Kötü senaryo için 0 yazın. Ortalama: tahsilat {formatTL(estimate.receiptsCents)} − düzenli giderler{" "}
          {formatTL(estimate.operatingOutCents)}, {estimate.days} güne bölünmüş.
        </span>
      </div>

      {projection.releases.length > 0 && (
        <ul className="mt-3 text-sm text-gray-700 space-y-0.5">
          {projection.releases.map((r) => (
            <li key={r.id}>
              Burgan · {r.name}: {formatTL(r.net_cents)} · {formatDay(r.day)} {WEEKDAYS[weekday(r.day)]}
              {r.overdue
                ? " (çözülme günü geçti, henüz doğrulanmadı)"
                : r.expected_release !== r.day
                  ? ` (çözülme ${formatDay(r.expected_release)}, hafta sonu)`
                  : ""}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b">
            <tr className="text-left text-gray-800">
              <th className="px-2 py-2 font-semibold">Gün</th>
              <th className="px-2 py-2 font-semibold text-right">Planlı ödeme</th>
              <th className="px-2 py-2 font-semibold text-right">Planlı tahsilat</th>
              <th className="px-2 py-2 font-semibold text-right">Burgan</th>
              <th className="px-2 py-2 font-semibold text-right">Günlük tahmin</th>
              <th className="px-2 py-2 font-semibold text-right">Bakiye</th>
            </tr>
          </thead>
          <tbody>
            {projection.days.map((d) => {
              const isMin = projection.min?.day === d.day;
              return (
                <tr key={d.day} className={`border-b ${isMin ? "bg-amber-50 font-semibold" : ""}`}>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {formatDay(d.day)} <span className="text-gray-500">{WEEKDAYS[weekday(d.day)]}</span>
                  </td>
                  <td className={`${NUM} ${d.planOutCents ? "text-red-600" : "text-gray-400"}`}>
                    {d.planOutCents ? formatTL(-d.planOutCents) : "—"}
                  </td>
                  <td className={`${NUM} ${d.planInCents ? "text-green-700" : "text-gray-400"}`}>
                    {d.planInCents ? formatTL(d.planInCents) : "—"}
                  </td>
                  <td className={`${NUM} ${d.burganCents ? "text-green-700" : "text-gray-400"}`}>
                    {d.burganCents ? formatTL(d.burganCents) : "—"}
                  </td>
                  <td className={`${NUM} text-gray-600`}>{d.estimateCents ? formatTL(d.estimateCents) : "—"}</td>
                  <td className={`${NUM} ${d.balanceCents < 0 ? "text-red-600" : ""}`}>{formatTL(d.balanceCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Tahmindir. Günlük tahmin, bugünden sonraki her güne eklenir: hasta tahsilatları eksi hekim, personel, lab, sarf,
        diğer giderler ve banka masrafları. Kira, vergi / SGK ve kredi ödemeleri planlı kayıt olarak girildiği için
        tahmine katılmaz (plan listesinde sayılır); ortak dağıtımı ve demirbaş alımı da katılmaz. Burgan kredileri
        bloke çözülünce net tutarla sayılır; brüt tutarı ve kesintileri ortalamaya girmez. Bakiye banka ve kasanın
        toplamıdır: ödemeleri bankadan yapacaksanız kasadaki nakdin bankaya aktarılması gerekebilir.
      </p>
    </Card>
  );
}
