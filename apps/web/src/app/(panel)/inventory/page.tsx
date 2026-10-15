"use client";

// Stock home screen (spec p7_rules_ui §20.1, contract §5.1). One stock_dashboard() read (shared with the tab
// badges through StockProvider); every figure is aggregated in SQL.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { TRACKING_INFO, TRACKING_LEVELS, categoryLabel } from "@/lib/stock/codes";
import { expiryLabel } from "@/lib/stock/expiry";
import { stockExpiryWatch, toStockError, type AttentionRow, type ExpiryRow, type StockError } from "@/lib/stock/rpc";
import { STORAGE_KEYS, readString, writeString } from "@/lib/stock/storage";
import { formatQty } from "@/lib/stock/units";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { MovementTable } from "@/components/stock/MovementTable";
import { useStockLocations } from "@/components/stock/useStockRefs";
import {
  Card,
  EmptyState,
  ExpiryBadge,
  LevelBadge,
  Notice,
  Pager,
  StatTile,
  StockErrorBox,
  StockModal,
  buttonPrimary,
  buttonSecondary,
  formatTL,
  stockInput,
} from "@/components/stock/ui";

const ACTIONS = [
  { type: "receive", label: "Malzeme geldi", detail: "Yeni gelenleri stoğa ekle", icon: "📥" },
  { type: "issue", label: "Malzeme kullandım", detail: "Kullandığın miktarı kaydet", icon: "🩺" },
  { type: "transfer", label: "Odaya malzeme götürdüm", detail: "Depo ve odalar arasında taşı", icon: "🚚" },
] as const;

type Drill = "critical" | "expiry" | "value" | null;

export default function StockHomePage() {
  const user = useAuthStore((state) => state.user);
  const { dashboard, dashboardError, reloadDashboard, openSheet, gates, today } = useStock();
  const { active: locations } = useStockLocations();
  const [shiftRoom, setShiftRoom] = useState("");
  const [drill, setDrill] = useState<Drill>(null);

  useEffect(() => {
    if (user) setShiftRoom(readString(STORAGE_KEYS.shiftRoom(user.user_id)));
  }, [user]);

  const rooms = locations.filter((l) => l.kind !== "warehouse");

  const openAttention = (row: AttentionRow) => {
    if (!gates.op) return;
    if (row.kind === "critical") {
      openSheet({ type: "receive", itemId: row.stock_item_id });
    } else {
      openSheet({
        type: row.state === "expired" ? "waste" : "issue",
        itemId: row.stock_item_id,
        batchId: row.batch_id,
        fromLocationId: row.location_id,
      });
    }
  };

  if (!dashboard) {
    return (
      <StockShell title="Stok · Bugün ne yaptınız?" subtitle="İşlemi seçin, barkodu okutun, miktarı kaydedin.">
        {dashboardError ? (
          <Card>
            <StockErrorBox error={dashboardError} />
            <button type="button" className={`${buttonPrimary} mt-4`} onClick={reloadDashboard}>
              Yeniden dene
            </button>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-28 rounded-lg bg-white shadow animate-pulse" />
            ))}
          </div>
        )}
      </StockShell>
    );
  }

  const d = dashboard;
  const attention = gates.op ? d.attention.slice(0, 7) : d.attention.slice(0, 3);
  const emptyCatalog = d.items.active === 0 && d.items.draft === 0;

  return (
    <StockShell title="Stok · Bugün ne yaptınız?" subtitle="İşlemi seçin, barkodu okutun, miktarı kaydedin.">
      <div className="space-y-6">
        {gates.op && (
          <section>
            <div className="grid gap-3 sm:grid-cols-3">
              {ACTIONS.map((a) => (
                <button
                  key={a.type}
                  type="button"
                  onClick={() => openSheet({ type: a.type })}
                  className="min-h-24 bg-white rounded-lg shadow p-4 text-left hover:ring-2 hover:ring-blue-300 flex items-center gap-4"
                >
                  <span className="text-3xl" aria-hidden="true">
                    {a.icon}
                  </span>
                  <span>
                    <span className="block text-lg font-semibold">{a.label}</span>
                    <span className="block text-sm text-gray-600">{a.detail}</span>
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className="mt-2 text-sm text-blue-700 hover:underline min-h-[44px]" onClick={() => openSheet()}>
              Diğer işlemler: fire, sayım, iade ve talepler
            </button>
          </section>
        )}

        {gates.op && user && (
          <Card>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block flex-1 min-w-[14rem]">
                <span className="block text-sm font-semibold mb-1">Bu vardiyada çalıştığım oda</span>
                <select
                  className={stockInput}
                  value={shiftRoom}
                  onChange={(e) => {
                    setShiftRoom(e.target.value);
                    writeString(STORAGE_KEYS.shiftRoom(user.user_id), e.target.value);
                  }}
                >
                  <option value="">Seçilmedi</option>
                  {rooms.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <span className="block text-xs text-gray-500 mt-1">
                  Kullanımda kaynak, transferde hedef olarak önerilir. Yalnız bu cihazda saklanır.
                </span>
              </label>
              <Link href="/inventory/receipt" className={`${buttonSecondary} min-h-[44px] flex items-center`}>
                Toplu mal kabul listesi hazırla
              </Link>
            </div>
          </Card>
        )}

        {emptyCatalog && gates.mgr && (
          <Card title="Henüz stok kartı yok">
            <p className="text-sm text-gray-700 mb-3">
              İlk gerçek stoğu, ürünü tanımladıktan sonra Malzeme geldi ile &apos;Açılış sayımı&apos; açıklamasıyla girin.
            </p>
            <Link href="/inventory/items/new" className={buttonPrimary}>
              İlk ürünü tanımla
            </Link>
          </Card>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/inventory/items" className="bg-white p-5 rounded-lg shadow hover:ring-2 hover:ring-blue-200">
            <div className="text-sm text-gray-600">Aktif ürün</div>
            <div className="text-3xl font-bold mt-1">{d.items.active}</div>
            <div className="flex flex-wrap gap-1 mt-2">
              {TRACKING_LEVELS.map((l) => (
                <span key={l} className={`px-2 py-0.5 rounded text-xs ${TRACKING_INFO[l].badge}`}>
                  {l}: {d.items.by_level?.[l] ?? 0}
                </span>
              ))}
            </div>
            {gates.mgr && d.items.draft > 0 && <div className="text-xs text-amber-700 mt-1">+{d.items.draft} taslak</div>}
          </Link>
          <StatTile
            label="Kritik stok"
            value={d.critical.count}
            tone={d.critical.count > 0 ? "red" : "green"}
            detail={d.critical.out_of_stock > 0 ? `${d.critical.out_of_stock} ürün tükendi` : "MIN seviyesinin altında"}
            onClick={() => setDrill("critical")}
          />
          <StatTile
            label="SKT uyarılı stok"
            value={d.expiry.count}
            tone={d.expiry.expired > 0 || d.expiry.critical > 0 ? "red" : d.expiry.count > 0 ? "amber" : undefined}
            detail={`${d.expiry.expired} süresi geçmiş · ${d.expiry.critical} lot 30 gün içinde`}
            onClick={() => setDrill("expiry")}
          />
          {gates.cost && d.value && (
            <StatTile
              label="Tahmini stok değeri"
              value={formatTL(d.value.value_cents)}
              detail={
                d.value.uncosted_batches > 0 ? `${d.value.uncosted_batches} lotun fiyatı girilmemiş` : "Tüm lotların fiyatı girili"
              }
              onClick={() => setDrill("value")}
            />
          )}
        </section>

        {(d.pending.corrections > 0 || d.pending.product_requests > 0) && (
          <Notice tone="warn">
            {d.pending.corrections > 0 && (
              <Link href="/inventory/corrections" className="underline mr-4">
                {d.pending.corrections} düzeltme talebi bekliyor
              </Link>
            )}
            {d.pending.product_requests > 0 && (
              <Link href="/inventory/requests" className="underline">
                {d.pending.product_requests} ürün tanımlama talebi bekliyor
              </Link>
            )}
          </Notice>
        )}

        <Card title={gates.op ? "Bugün dikkat isteyenler" : "Stok sorumlusuyla kontrol edin"}>
          {attention.length === 0 ? (
            <EmptyState>Şu an dikkat isteyen ürün yok.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {attention.map((row, i) => {
                const border = row.severity === "red" ? "border-l-red-500" : "border-l-amber-500";
                const body =
                  row.kind === "critical" ? (
                    <>
                      <span className="block font-medium">{row.item_name}</span>
                      <span className="block text-sm text-gray-600">
                        {formatQty(row.usable_qty)} {row.usage_unit} kaldı · Kritik seviye {formatQty(row.min_qty)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="block font-medium">{row.item_name}</span>
                      <span className="block text-sm text-gray-600">
                        {row.expiry_date.split("-").reverse().join(".")} · {row.location_name} · Lot {row.lot_number} ·{" "}
                        {expiryLabel(row.days_left)}
                      </span>
                    </>
                  );
                return (
                  <li key={`${row.kind}-${row.stock_item_id}-${i}`}>
                    {gates.op ? (
                      <button
                        type="button"
                        onClick={() => openAttention(row)}
                        className={`w-full text-left p-3 rounded border border-l-4 ${border} hover:bg-gray-50 min-h-[44px]`}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className={`p-3 rounded border border-l-4 ${border}`}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <section className="grid gap-4 md:grid-cols-3">
          {TRACKING_LEVELS.map((l) => {
            const h = d.health_by_level?.[l];
            const pct = h && h.items > 0 ? Math.round((100 * h.ok) / h.items) : null;
            return (
              <div key={l} className="bg-white rounded-lg shadow p-5">
                <div className="flex items-center justify-between">
                  <LevelBadge level={l} />
                  <span className="text-2xl font-bold">{pct === null ? "—" : `%${pct}`}</span>
                </div>
                <p className="text-sm text-gray-600 mt-2">{TRACKING_INFO[l].description}</p>
                <div className="h-2 rounded bg-gray-200 mt-3 overflow-hidden" aria-hidden="true">
                  <div className="h-full bg-green-500" style={{ width: `${pct ?? 0}%` }} />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {h ? `${h.ok}/${h.items} ürün kritik seviyenin üstünde` : "MIN/MAX belirlenmiş ürün yok"}
                </p>
              </div>
            );
          })}
        </section>

        {locations.length > 0 && (
          <Card title="Konumlar">
            <ul className="flex flex-wrap gap-2">
              {locations.map((l) => (
                <li key={l.id}>
                  <Link
                    href={`/inventory/items?location=${l.id}`}
                    className="inline-block px-3 py-2 rounded border hover:bg-gray-50 text-sm min-h-[44px]"
                  >
                    {l.is_default_warehouse ? "★ " : ""}
                    {l.name}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card
          title="Son hareketler"
          actions={
            <Link href="/inventory/movements" className="text-sm text-blue-700 hover:underline">
              Tümünü gör
            </Link>
          }
        >
          {d.recent_movements.length === 0 ? (
            <EmptyState>Henüz stok hareketi yok.</EmptyState>
          ) : (
            <MovementTable rows={d.recent_movements.slice(0, 8)} />
          )}
        </Card>
      </div>

      {drill === "critical" && (
        <StockModal title="Kritik stok" onClose={() => setDrill(null)} wide>
          {d.critical.rows.length === 0 ? (
            <EmptyState>Kritik seviyede ürün yok.</EmptyState>
          ) : (
            <ul className="divide-y">
              {d.critical.rows.map((r) => (
                <li key={r.stock_item_id} className="py-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Link href={`/inventory/items/${r.stock_item_id}`} className="font-medium text-blue-700">
                      {r.item_name}
                    </Link>
                    <p className={`text-sm ${r.state === "out" ? "text-red-700" : "text-amber-700"}`}>
                      Kullanılabilir: {formatQty(r.usable_qty)} {r.usage_unit} · Kritik seviye: {formatQty(r.min_qty)} · Hedef:{" "}
                      {formatQty(r.max_qty)}
                    </p>
                    {r.suggested_qty > 0 && (
                      <p className="text-xs text-gray-500">
                        Önerilen sipariş: {formatQty(r.suggested_qty)} {r.usage_unit}
                      </p>
                    )}
                  </div>
                  {gates.op && (
                    <button
                      type="button"
                      className={`${buttonSecondary} min-h-[44px]`}
                      onClick={() => {
                        setDrill(null);
                        openSheet({ type: "receive", itemId: r.stock_item_id });
                      }}
                    >
                      Stok işlemi yap
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {d.critical.count > d.critical.rows.length && (
            <Link href="/inventory/items?status=critical" className="block mt-3 text-sm text-blue-700 hover:underline">
              Tüm kritik ürünleri listede gör ({d.critical.count})
            </Link>
          )}
        </StockModal>
      )}

      {drill === "expiry" && (
        <ExpiryDrill
          today={today}
          canOperate={gates.op}
          onClose={() => setDrill(null)}
          onAction={(row) => {
            setDrill(null);
            openSheet({
              type: row.state === "expired" || row.action === "waste" ? "waste" : "issue",
              itemId: row.stock_item_id,
              batchId: row.batch_id,
              fromLocationId: row.location_id,
            });
          }}
        />
      )}

      {drill === "value" && d.value && (
        <StockModal title="Tahmini stok değeri" onClose={() => setDrill(null)}>
          <div className="space-y-3 text-sm">
            <p>
              Toplam: <strong>{formatTL(d.value.value_cents)}</strong> · SKT riski (90 gün, geçmiş dahil):{" "}
              <strong>{formatTL(d.value.expiry_risk_value_cents)}</strong>
            </p>
            {d.value.uncosted_batches > 0 && (
              <Notice tone="warn">{d.value.uncosted_batches} lotun fiyatı girilmemiş; değere katılmadı.</Notice>
            )}
            <table className="w-full">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-1">Kategori</th>
                  <th className="py-1 text-right">Değer</th>
                </tr>
              </thead>
              <tbody>
                {d.value.by_category.map((c) => (
                  <tr key={c.category} className="border-b">
                    <td className="py-1">{categoryLabel(c.category)}</td>
                    <td className="py-1 text-right tabular-nums">{formatTL(c.value_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StockModal>
      )}
    </StockShell>
  );
}

function ExpiryDrill({
  today,
  canOperate,
  onClose,
  onAction,
}: {
  today: string | null;
  canOperate: boolean;
  onClose: () => void;
  onAction: (row: ExpiryRow) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<ExpiryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<StockError | null>(null);
  const [search, setSearch] = useState("");
  const LIMIT = 50;

  const load = useCallback(async () => {
    try {
      const r = await stockExpiryWatch(90, null, { offset, limit: LIMIT });
      setRows(r.rows || []);
      setTotal(r.total ?? r.totals?.count ?? (r.rows || []).length);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const q = search.trim().toLocaleLowerCase("tr-TR");
  const shown = (rows || []).filter(
    (r) => !q || r.item_name.toLocaleLowerCase("tr-TR").includes(q) || r.lot_number.toLocaleLowerCase("tr-TR").includes(q)
  );

  return (
    <StockModal title="SKT uyarılı stok (90 gün)" onClose={onClose} wide>
      <input
        className={`${stockInput} mb-3`}
        placeholder="Bu sayfada ürün veya lot ara"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <StockErrorBox error={error} />
      {rows === null ? (
        <p className="text-gray-500">Yükleniyor...</p>
      ) : shown.length === 0 ? (
        <EmptyState>SKT uyarısı olan lot yok.</EmptyState>
      ) : (
        <ul className="divide-y">
          {shown.map((r) => (
            <li key={`${r.batch_id}-${r.location_id}`} className="py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{r.item_name}</p>
                <p className="text-sm text-gray-600">
                  {r.location_name} · Lot {r.lot_number}
                  {r.serial_number ? ` · seri ${r.serial_number}` : ""} · {formatQty(r.quantity)} {r.usage_unit ?? ""}
                </p>
                <ExpiryBadge expiry={r.expiry_date} today={today} />
                {r.value_cents !== undefined && <span className="ml-2 text-xs text-gray-500">{formatTL(r.value_cents)}</span>}
              </div>
              {canOperate && (
                <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => onAction(r)}>
                  {r.state === "expired" ? "Fire olarak ayır" : "Stok işlemi yap"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </StockModal>
  );
}
