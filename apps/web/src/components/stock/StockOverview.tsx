"use client";

// Stock overview body ("Stok özeti", owner screen): takeaway, period choice, tiles, group bars and the tables. The
// page (app/(panel)/inventory/overview) loads the rows; everything here is worked out from them (lib/stock/overview).

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  ATTENTION_LABELS,
  IMPLANT_GROUP,
  PERIOD_LABELS,
  attentionRows,
  buildStockRows,
  countDiffRows,
  groupMovements,
  groupTotals,
  hasOutflow,
  inStock,
  priceChanges,
  stockSummary,
  type OverviewBalance,
  type OverviewBatch,
  type OverviewCost,
  type OverviewItem,
  type PeriodKey,
} from "@/lib/stock/overview";
import type { ConsumptionReport, StockError } from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { Card, EmptyState, Loading, StatTile, StockErrorBox, formatDay, formatTL } from "./ui";

const TOP_ITEMS = 15;

export interface StockData {
  items: OverviewItem[];
  balances: OverviewBalance[];
  batches: OverviewBatch[];
  costs: OverviewCost[];
}

export interface MonthTotals {
  month: string;
  receivedCents: number;
  usedCents: number;
}

/** Sentence openers for the takeaway ("Son 30 günde sayımda net ... eksik çıktı"). */
const PERIOD_PHRASES: Record<PeriodKey, string> = {
  "30d": "Son 30 günde",
  month: "Bu ay",
  prev_month: "Geçen ay",
  "90d": "Son 90 günde",
};

const pct = (part: number, whole: number) => (whole > 0 ? `%${Math.round((part / whole) * 100)}` : "—");

function monthLabel(month: string): string {
  const names = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
  const [y, m] = month.split("-");
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

const ONE_DECIMAL = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Short amount for narrow chart labels: ₺940, ₺71,5 bin, ₺1,2 mn (the exact amount is in the bar's title). */
function compactTL(cents: number): string {
  const tl = cents / 100;
  const abs = Math.abs(tl);
  if (abs >= 1_000_000) return `₺${ONE_DECIMAL.format(tl / 1_000_000)} mn`;
  if (abs >= 1_000) return `₺${ONE_DECIMAL.format(tl / 1_000)} bin`;
  return `₺${Math.round(tl)}`;
}

export function StockOverviewView({
  stock,
  today,
  period,
  onPeriod,
  range,
  report,
  reportError,
  months,
  monthsError,
}: {
  stock: StockData;
  today: string;
  period: PeriodKey;
  onPeriod: (period: PeriodKey) => void;
  range: { from: string; to: string };
  /** null while the period report loads (or after it failed). */
  report: ConsumptionReport | null;
  reportError: StockError | null;
  /** null while the monthly reports load (or after they failed). */
  months: MonthTotals[] | null;
  monthsError: StockError | null;
}) {
  const rows = useMemo(
    () => buildStockRows(stock.items, stock.balances, stock.batches, stock.costs, today),
    [stock, today]
  );
  const summary = useMemo(() => stockSummary(rows), [rows]);
  const groups = useMemo(() => groupTotals(rows), [rows]);
  const attention = useMemo(() => attentionRows(rows), [rows]);
  const prices = useMemo(() => priceChanges(stock.items, stock.batches, stock.costs), [stock]);
  const moves = useMemo(() => (report ? groupMovements(report.rows) : []), [report]);
  const diffs = useMemo(() => (report ? countDiffRows(report.rows) : []), [report]);
  const countNetCents = report?.totals.adjust_net_cost_cents ?? null;
  const usedCents = report?.totals.net_used_cost_cents ?? null;
  const uncostedRows = Number(report?.totals.uncosted_rows) || 0;
  const uncostedNote = uncostedRows > 0 ? `; ${uncostedRows} hareketin fiyatı yok` : "";
  const showWaste = moves.some((m) => m.wasteCents !== 0);
  const periodText = `${formatDay(range.from)} – ${formatDay(range.to)}`;

  return (
    <>
      <p className="text-base text-gray-800 mb-4 max-w-3xl">
        Stokta <strong className="tabular-nums">{formatTL(summary.valueCents)}</strong> değerinde malzeme var; bunun{" "}
        <strong className="tabular-nums">{pct(summary.implantValueCents, summary.valueCents)}</strong> kadarı implant.
        {countNetCents !== null && countNetCents < 0 && (
          <>
            {" "}
            {PERIOD_PHRASES[period]} sayımda net{" "}
            <strong className="tabular-nums text-red-700">{formatTL(-countNetCents)}</strong> eksik çıktı; net
            kullanım <strong className="tabular-nums">{formatTL(usedCents)}</strong>.
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4" role="group" aria-label="Dönem">
        <span className="text-sm text-gray-600 mr-1">Dönem:</span>
        {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onPeriod(k)}
            aria-pressed={period === k}
            className={`px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded text-sm border ${
              period === k ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {PERIOD_LABELS[k]}
          </button>
        ))}
        <span className="text-xs text-gray-500">{periodText}</span>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile
          label="Stoktaki malzemenin değeri"
          value={formatTL(summary.valueCents)}
          detail={`${summary.items} kalem; fiyatı girilmiş lotlardan`}
        />
        <StatTile
          label="Net kullanım"
          value={report ? formatTL(usedCents) : "—"}
          detail={`${PERIOD_LABELS[period]}; stoktan kullanıma düşülen, iadeler düşüldü${uncostedNote}`}
        />
        <StatTile
          label="Sayım farkı (net)"
          value={report ? formatTL(countNetCents) : "—"}
          tone={countNetCents !== null && countNetCents < 0 ? "red" : undefined}
          detail={`${PERIOD_LABELS[period]}; eksik ve fazla çıkanların neti${uncostedNote}`}
        />
        <StatTile
          label="Kritik stok"
          value={summary.criticalItems}
          tone={summary.criticalItems > 0 ? "amber" : undefined}
          detail={
            <Link href="/inventory/items?status=critical" className="text-blue-700 hover:underline">
              Kritik stok listesini aç →
            </Link>
          }
        />
        <StatTile
          label="Tarihi 90 gün içinde doluyor"
          value={summary.expiringItems}
          tone={summary.expiringItems > 0 ? "amber" : undefined}
          detail="Kalem; tarihi geçenler dahil"
        />
        <StatTile
          label="Fiyatı eksik kalem"
          value={summary.unpricedItems}
          detail="Bu kalemlerin fiyatsız lotları değere katılmadı"
        />
      </div>

      <Section title="Stokta para nerede?">
        <Card title="Grup başına stok değeri">
          <p className="text-xs text-gray-500 -mt-2 mb-4">Gruplar ürün adına göre ayrıldı.</p>
          <HBars
            rows={groups.map((g) => ({
              key: g.group,
              label: g.group,
              note: `${g.items} kalem${g.unpricedItems ? `, ${g.unpricedItems} fiyatsız` : ""}`,
              bars: [{ value: g.valueCents, cls: g.group === IMPLANT_GROUP ? "bg-blue-700" : "bg-blue-500" }],
            }))}
          />
        </Card>
        <Card title={`En değerli ${TOP_ITEMS} kalem`}>
          <Table head={["Ürün", "Grup", "Miktar", "Değer"]} right={[2, 3]}>
            {rows.filter(inStock).slice(0, TOP_ITEMS).map((r) => (
              <tr key={r.id} className="border-b last:border-b-0 align-top">
                <td className="px-3 py-2">
                  <ItemLink id={r.id}>{r.name}</ItemLink>
                </td>
                <td className="px-3 py-2 text-gray-600">{r.group}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {formatQty(r.qty)} {r.unit}
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(r.valueCents)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </Section>

      <Section title={`Stoktan ne çıktı? ${periodText}`}>
        <Card title="Kullanım ve sayım eksiği, grup başına">
          <p className="text-xs text-gray-500 -mt-2 mb-3">
            Kullanım: stoktan kullanıma düşülen, iadeler düşülmüş. Sayım eksiği: sayımda sistemdekinden az çıkan.
            {showWaste && " Fire: kırılan, bozulan ya da tarihi geçtiği için atılan."}
            {uncostedRows > 0 && ` Fiyatı girilmemiş lotlardaki ${uncostedRows} hareket tutara katılmadı.`}
          </p>
          <Legend
            items={[
              { cls: "bg-blue-500", label: "Kullanım" },
              { cls: "bg-amber-500", label: "Sayım eksiği" },
              ...(showWaste ? [{ cls: "bg-red-500", label: "Fire" }] : []),
            ]}
          />
          <StockErrorBox error={reportError} />
          {!report && !reportError ? (
            <Loading />
          ) : report && moves.length === 0 ? (
            <EmptyState>
              {hasOutflow(report.rows) ? "Bu dönemdeki çıkışların fiyatı girilmemiş." : "Bu dönemde stoktan çıkış yok."}
            </EmptyState>
          ) : (
            <HBars
              rows={moves.map((m) => ({
                key: m.group,
                label: m.group,
                note: m.countGainCents ? `Sayım fazlası ${formatTL(m.countGainCents)}` : undefined,
                bars: [
                  { name: "Kullanım", value: m.usedCents, cls: "bg-blue-500" },
                  { name: "Sayım eksiği", value: m.countLossCents, cls: "bg-amber-500" },
                  { name: "Fire", value: m.wasteCents, cls: "bg-red-500" },
                ],
              }))}
            />
          )}
        </Card>
        <Card title="Sayım farkları">
          <p className="text-xs text-gray-500 -mt-2 mb-3">
            En çok eksik çıkan başta. Eksi değer: sayımda sistemdekinden az çıktı; artı değer: fazla çıktı.
          </p>
          {!report ? (
            reportError ? null : <Loading />
          ) : diffs.length === 0 ? (
            <EmptyState>Bu dönemde sayım farkı yok.</EmptyState>
          ) : (
            <Table head={["Ürün", "Grup", "Miktar farkı", "Tutar farkı"]} right={[2, 3]}>
              {diffs.map((d) => (
                <tr key={d.id} className="border-b last:border-b-0 align-top">
                  <td className="px-3 py-2">
                    <ItemLink id={d.id}>{d.name}</ItemLink>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{d.group}</td>
                  <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${d.qty < 0 ? "text-red-700" : ""}`}>
                    {d.qty > 0 ? "+" : ""}
                    {formatQty(d.qty)} {d.unit}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {d.costCents === null ? "Fiyatsız" : formatTL(d.costCents)}
                    {d.partlyUnpriced && <span className="block text-xs text-amber-700">kısmen fiyatsız</span>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Section>

      <Section title="Dikkat isteyenler">
        <Card title="Kritik stok ve tarihi yaklaşanlar" className="lg:col-span-2">
          <p className="text-xs text-gray-500 -mt-2 mb-3">
            Kritik seviyede ya da stokta olmayanlar ve son kullanma tarihi 90 gün içinde olanlar; tarihi en yakın olan
            başta.
          </p>
          {attention.length === 0 ? (
            <EmptyState>Şu an dikkat isteyen kalem yok.</EmptyState>
          ) : (
            <Table head={["Ürün", "Kullanılabilir", "Kritik seviye", "En yakın son kullanma", "Durum"]} right={[1, 2]}>
              {attention.map((r) => (
                <tr key={r.id} className="border-b last:border-b-0 align-top">
                  <td className="px-3 py-2">
                    <ItemLink id={r.id}>{r.name}</ItemLink>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatQty(r.usableQty)} {r.unit}
                    {r.expiredQty > 0 && (
                      <span className="block text-xs text-red-700">
                        +{formatQty(r.expiredQty)} tarihi geçmiş
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(r.minQty)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.nextExpiry ? (
                      <>
                        {formatDay(r.nextExpiry)}
                        <span className="block text-xs text-gray-500">
                          {formatQty(r.nextExpiryQty)} {r.unit}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.expiryState && (
                        <StateBadge red={r.expiryState !== "expiry90"}>{ATTENTION_LABELS[r.expiryState]}</StateBadge>
                      )}
                      {r.levelState && (
                        <StateBadge red={r.levelState === "out"}>{ATTENTION_LABELS[r.levelState]}</StateBadge>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Section>

      <Section title="Son 6 ay">
        <Card title="Aylık mal kabul ve kullanım">
          <p className="text-xs text-gray-500 -mt-2 mb-3">
            Mal kabul: stoğa giren malzemenin tutarı (açılış stoğu hariç). Kullanım: stoktan kullanıma düşülen, iadeler
            düşülmüş. Bu ay bugüne kadar.
          </p>
          <Legend items={[{ cls: "bg-emerald-600", label: "Mal kabul" }, { cls: "bg-blue-500", label: "Kullanım" }]} />
          <StockErrorBox error={monthsError} />
          {months === null ? (
            monthsError ? null : <Loading />
          ) : months.length === 0 ? (
            <EmptyState>Henüz mal kabul ya da kullanım yok.</EmptyState>
          ) : (
            <MonthBars months={months} today={today} />
          )}
        </Card>
        <Card title="Lot fiyatı değişen ürünler">
          <p className="text-xs text-gray-500 -mt-2 mb-3">İlk ve son gelen lotun birim fiyatı (kullanım birimi başına).</p>
          {prices.length === 0 ? (
            <EmptyState>Henüz fiyatı değişen ürün yok; yeni gelen lotlarda fiyat değişirse burada görünür.</EmptyState>
          ) : (
            <Table head={["Ürün", "İlk fiyat", "Son fiyat", "Değişim"]} right={[1, 2, 3]}>
              {prices.map((p) => (
                <tr key={p.id} className="border-b last:border-b-0 align-top">
                  <td className="px-3 py-2">
                    <ItemLink id={p.id}>{p.name}</ItemLink>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatTL(p.firstCents)} / {p.unit}
                    <span className="block text-xs text-gray-500">{formatDay(p.firstDay)}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatTL(p.lastCents)} / {p.unit}
                    <span className="block text-xs text-gray-500">{formatDay(p.lastDay)}</span>
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${
                      p.lastCents > p.firstCents ? "text-red-700" : "text-green-700"
                    }`}
                  >
                    {p.change === null ? "—" : `${p.change > 0 ? "+" : "−"}%${Math.abs(Math.round(p.change * 100))}`}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Section>

      <ul className="list-disc pl-5 text-xs text-gray-600 space-y-1 max-w-3xl">
        <li>Değerler lot maliyetlerinden hesaplanır; tarihi geçmiş stok da değere dahildir.</li>
        <li>Sayım eksiği kayıp, fire ya da stoktan düşülmeden kullanılan malzeme olabilir.</li>
        <li>Gruplar ürün adına göre otomatik ayrılır; kart kategorileri değişmez.</li>
      </ul>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-3">{title}</h2>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 items-start">{children}</div>
    </section>
  );
}

function StateBadge({ red, children }: { red: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs whitespace-nowrap ${
        red ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"
      }`}
    >
      {children}
    </span>
  );
}

function ItemLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link href={`/inventory/items/${id}`} className="text-gray-900 hover:text-blue-700 hover:underline">
      {children}
    </Link>
  );
}

function Legend({ items }: { items: { cls: string; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-4 text-xs text-gray-600 mb-3">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={`inline-block w-3 h-3 rounded-sm ${i.cls}`} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function Table({ head, right, children }: { head: string[]; right: number[]; children: ReactNode }) {
  return (
    <div className="overflow-auto max-h-[28rem] -mx-6 px-6">
      <table className="w-full text-sm">
        <thead className="text-left text-gray-600 border-b">
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                className={`px-3 py-2 font-medium sticky top-0 bg-white whitespace-nowrap ${right.includes(i) ? "text-right" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Horizontal bars on one scale (the largest value of all rows is the full width); zero bars of a series are left out. */
function HBars({
  rows,
}: {
  rows: { key: string; label: string; note?: string; bars: { name?: string; value: number; cls: string }[] }[];
}) {
  const max = Math.max(1, ...rows.flatMap((r) => r.bars.map((b) => b.value)));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="font-medium text-gray-900">{r.label}</span>
            {r.note && <span className="text-xs text-gray-500">{r.note}</span>}
          </div>
          <div className="mt-1 space-y-1">
            {r.bars
              .filter((b, _, all) => all.length === 1 || b.value !== 0)
              .map((b) => (
                <div key={b.cls} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div
                      className={`h-3 rounded-sm ${b.cls}`}
                      style={{ width: `${b.value > 0 ? Math.max(0.5, (b.value / max) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-xs tabular-nums text-gray-700">
                    {b.name && <span className="sr-only">{b.name}: </span>}
                    {formatTL(b.value)}
                  </span>
                </div>
              ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Two bars per month (received, used) on one scale, short amounts under each month; the current month is "Bu ay". */
function MonthBars({ months, today }: { months: MonthTotals[]; today: string }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.receivedCents, m.usedCents]));
  const current = today.slice(0, 7);
  return (
    <div className="flex gap-2 sm:gap-3">
      {months.map((m) => {
        const label = m.month === current ? "Bu ay" : monthLabel(m.month);
        const bars = [
          { v: m.receivedCents, cls: "bg-emerald-600", text: "text-emerald-700", name: "Mal kabul" },
          { v: m.usedCents, cls: "bg-blue-500", text: "text-blue-700", name: "Kullanım" },
        ];
        return (
          <div key={m.month} className="flex-1 min-w-0">
            <div className="h-40 flex items-end justify-center gap-1 border-b border-gray-300" aria-hidden="true">
              {bars.map((b) => (
                <div
                  key={b.name}
                  className={`w-2/5 max-w-[2rem] rounded-t-sm ${b.cls}`}
                  style={{ height: `${b.v > 0 ? Math.max(1, (b.v / max) * 100) : 0}%` }}
                  title={`${label} · ${b.name}: ${formatTL(b.v)}`}
                />
              ))}
            </div>
            <div className="text-center text-xs text-gray-700 mt-1 whitespace-nowrap">{label}</div>
            <div className="text-center text-[11px] tabular-nums leading-tight">
              {bars.map((b) => (
                <span key={b.name} className={`block whitespace-nowrap ${b.text}`} title={formatTL(b.v)}>
                  <span className="sr-only">{b.name}: </span>
                  {compactTL(b.v)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
