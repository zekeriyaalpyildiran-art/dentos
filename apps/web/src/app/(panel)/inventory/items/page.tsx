"use client";

// Stock cards list (spec p7_rules_ui §20.2, contract §5.2): server-side search, filters and paging.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { TRACKING_INFO, TRACKING_LEVELS, categoryLabel, type TrackingLevel } from "@/lib/stock/codes";
import { parseGs1 } from "@/lib/stock/gs1";
import {
  stockItemLevels,
  stockSetFavorite,
  toStockError,
  type LevelFilters,
  type LevelRow,
  type StockError,
} from "@/lib/stock/rpc";
import { STORAGE_KEYS, readJson, writeJson } from "@/lib/stock/storage";
import { formatQty } from "@/lib/stock/units";
import { UUID_RE } from "@/lib/finance";
import { BarcodeScanner } from "@/components/stock/ItemPicker";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { useStockLocations } from "@/components/stock/useStockRefs";
import {
  Badge,
  Card,
  EmptyState,
  ExpiryBadge,
  LevelBadge,
  Loading,
  Pager,
  StockErrorBox,
  StockMeter,
  buttonPrimary,
  buttonSecondary,
  formatTL,
  stockInput,
} from "@/components/stock/ui";

const PAGE = 50;
type Status = NonNullable<LevelFilters["status"]>;

const STATUS_OPTIONS: { value: Status; label: string; mgr?: boolean }[] = [
  { value: "all", label: "Tümü" },
  { value: "critical", label: "Kritik stok" },
  { value: "expiring", label: "SKT yaklaşıyor" },
  { value: "out", label: "Tükenen" },
  { value: "ready", label: "Kullanıma hazır" },
  { value: "draft", label: "Taslak", mgr: true },
  { value: "inactive", label: "Pasif", mgr: true },
];

interface SavedFilters {
  level?: TrackingLevel | "";
  status?: Status;
  location?: string;
}

export default function ItemsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ItemsList />
    </Suspense>
  );
}

function ItemsList() {
  const params = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const { gates, today, openSheet, tick } = useStock();
  const { active: locations } = useStockLocations();

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<TrackingLevel | "">("");
  const [status, setStatus] = useState<Status>("all");
  const [locationId, setLocationId] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<LevelRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<StockError | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Filters: URL first (dashboard links), then the remembered ones.
  useEffect(() => {
    if (!user || ready) return;
    const saved = readJson<SavedFilters>(STORAGE_KEYS.itemFilters(user.user_id)) ?? {};
    const urlStatus = params.get("status") as Status | null;
    const urlLocation = params.get("location");
    setLevel(saved.level ?? "");
    setStatus(urlStatus && STATUS_OPTIONS.some((s) => s.value === urlStatus) ? urlStatus : saved.status ?? "all");
    setLocationId(urlLocation && UUID_RE.test(urlLocation) ? urlLocation : urlStatus ? "" : saved.location ?? "");
    setReady(true);
  }, [user, params, ready]);

  useEffect(() => {
    if (!user || !ready) return;
    writeJson(STORAGE_KEYS.itemFilters(user.user_id), { level, status, location: locationId } satisfies SavedFilters);
  }, [user, ready, level, status, locationId]);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const r = await stockItemLevels(
        {
          q: query || undefined,
          tracking_level: level || undefined,
          status: status === "all" ? undefined : status,
          location_id: locationId || undefined,
        },
        { offset, limit: PAGE }
      );
      setRows(r.rows || []);
      setTotal(r.total ?? 0);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [query, level, status, locationId, offset]);

  useEffect(() => {
    if (ready) void load();
  }, [load, ready, tick]);

  async function toggleFavorite(row: LevelRow) {
    try {
      await stockSetFavorite(row.id, !row.is_favorite);
      setRows((rs) => (rs || []).map((r) => (r.id === row.id ? { ...r, is_favorite: !row.is_favorite } : r)));
    } catch (e) {
      setError(toStockError(e));
    }
  }

  function onScanned(raw: string) {
    setScanMessage(null);
    try {
      const p = parseGs1(raw);
      if (!p.gtin) throw new Error("Bu kodda ürün barkodu bulunamadı. Ürünün stok barkodunu okutun.");
      setSearch(p.gtin);
    } catch (e) {
      setScanMessage(e instanceof Error ? e.message : "Kod okunamadı.");
    }
  }

  const showCost = gates.cost;

  return (
    <StockShell
      title="Stok kartları"
      subtitle="Ürünler, mevcut miktarlar ve son kullanma tarihleri."
      actions={
        gates.mgr ? (
          <Link href="/inventory/items/new" className={`${buttonPrimary} min-h-[44px] flex items-center`}>
            Yeni ürün
          </Link>
        ) : undefined
      }
    >
      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div className="flex gap-2">
            <input
              className={stockInput}
              placeholder="Ad, marka, model, kategori, kod veya barkod"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Ürün ara"
            />
            <button type="button" className={`${buttonSecondary} whitespace-nowrap min-h-[44px]`} onClick={() => setScanOpen(true)}>
              Kamerayla ara
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              className={`${stockInput} md:w-48`}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as Status);
                setOffset(0);
              }}
              aria-label="Durum"
            >
              {STATUS_OPTIONS.filter((s) => gates.mgr || !s.mgr).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              className={`${stockInput} md:w-48`}
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setOffset(0);
              }}
              aria-label="Konum"
            >
              <option value="">Tüm konumlar</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="Takip kuralı">
          <button
            type="button"
            aria-pressed={level === ""}
            onClick={() => {
              setLevel("");
              setOffset(0);
            }}
            className={`px-3 min-h-[40px] rounded text-sm ${level === "" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
          >
            Tümü
          </button>
          {TRACKING_LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={level === l}
              onClick={() => {
                setLevel(l);
                setOffset(0);
              }}
              className={`px-3 min-h-[40px] rounded text-sm ${level === l ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
            >
              {TRACKING_INFO[l].short}
            </button>
          ))}
        </div>
        {scanMessage && (
          <p role="alert" className="text-sm text-red-700 mt-2">
            {scanMessage}
          </p>
        )}
      </Card>

      <StockErrorBox error={error} onReload={() => void load()} />

      <Card>
        {rows === null ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState>Ürün bulunamadı.</EmptyState>
        ) : (
          <>
            <ul className="md:hidden divide-y">
              {rows.map((row) => (
                <li key={row.id} className="py-3 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/inventory/items/${row.id}`} className="font-medium text-blue-700 min-w-0">
                      {row.item_name}
                    </Link>
                    <button
                      type="button"
                      onClick={() => void toggleFavorite(row)}
                      aria-label={row.is_favorite ? "Favorilerden çıkar" : "Favorilere ekle"}
                      className="text-xl min-w-[44px] min-h-[44px] -mt-2"
                    >
                      {row.is_favorite ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1 items-center">
                    <LevelBadge level={row.tracking_level} />
                    <StateBadges row={row} />
                  </div>
                  <LevelLines row={row} locationScoped={!!locationId} />
                  {row.next_expiry && <ExpiryBadge expiry={row.next_expiry} today={today} />}
                  {showCost && row.last_unit_cost_cents !== undefined && (
                    <p className="text-xs text-gray-600">Birim maliyet: {costText(row)}</p>
                  )}
                  {gates.op && (
                    <button
                      type="button"
                      disabled={row.needs_review || !row.is_active}
                      className={`${buttonSecondary} min-h-[44px] mt-1`}
                      onClick={() => openSheet({ itemId: row.id })}
                    >
                      Hareket
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-left text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Ürün</th>
                    <th className="px-3 py-2">Takip</th>
                    <th className="px-3 py-2">Mevcut / hedef</th>
                    <th className="px-3 py-2">En yakın SKT</th>
                    <th className="px-3 py-2">Konum / tedarikçi</th>
                    {showCost && <th className="px-3 py-2 text-right">Birim maliyet</th>}
                    <th className="px-3 py-2">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b align-top">
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          <button
                            type="button"
                            onClick={() => void toggleFavorite(row)}
                            aria-label={row.is_favorite ? "Favorilerden çıkar" : "Favorilere ekle"}
                            className="text-lg leading-none text-amber-500"
                          >
                            {row.is_favorite ? "★" : "☆"}
                          </button>
                          <div>
                            <Link href={`/inventory/items/${row.id}`} className="font-medium text-blue-700 hover:underline">
                              {row.item_name}
                            </Link>
                            <div className="text-xs text-gray-500">
                              {[row.brand, row.model].filter(Boolean).join(" · ")}
                              {row.brand || row.model ? " · " : ""}
                              {row.item_code} · {categoryLabel(row.category)}
                            </div>
                            {row.gtin && <div className="text-xs text-gray-500 font-mono">{row.gtin}</div>}
                            <div className="flex gap-1 mt-1">
                              <StateBadges row={row} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <LevelBadge level={row.tracking_level} />
                      </td>
                      <td className="px-3 py-2 min-w-[14rem]">
                        <LevelLines row={row} locationScoped={!!locationId} />
                      </td>
                      <td className="px-3 py-2">
                        <ExpiryBadge expiry={row.next_expiry} today={today} />
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">
                        {row.preferred_location_name ?? "—"}
                        <br />
                        {row.supplier_name ?? ""}
                      </td>
                      {showCost && <td className="px-3 py-2 text-right tabular-nums">{costText(row)}</td>}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {gates.op && (
                          <button
                            type="button"
                            disabled={row.needs_review || !row.is_active}
                            className="text-blue-700 hover:underline disabled:text-gray-400 mr-3"
                            onClick={() => openSheet({ itemId: row.id })}
                          >
                            Hareket
                          </button>
                        )}
                        {gates.mgr && (
                          <Link href={`/inventory/items/${row.id}/edit`} className="text-blue-700 hover:underline">
                            Düzenle
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />
      </Card>

      {scanOpen && <BarcodeScanner purpose="product" onClose={() => setScanOpen(false)} onScan={onScanned} />}
    </StockShell>
  );
}

function costText(row: LevelRow): string {
  return row.last_unit_cost_cents === null || row.last_unit_cost_cents === undefined
    ? "Fiyat girilmemiş"
    : `${formatTL(row.last_unit_cost_cents)} / ${row.usage_unit}`;
}

function StateBadges({ row }: { row: LevelRow }) {
  return (
    <>
      {row.needs_review && <Badge className="bg-amber-100 text-amber-800">Taslak</Badge>}
      {!row.is_active && <Badge className="bg-gray-200 text-gray-700">Pasif</Badge>}
      {row.state === "out" && row.is_active && !row.needs_review && <Badge className="bg-red-100 text-red-700">Tükendi</Badge>}
      {row.state === "critical" && <Badge className="bg-amber-100 text-amber-800">Kritik</Badge>}
    </>
  );
}

function LevelLines({ row, locationScoped }: { row: LevelRow; locationScoped: boolean }) {
  if (row.needs_review) return <p className="text-xs text-amber-700">Kart hazırlığı</p>;
  return (
    <div className="space-y-1">
      <StockMeter usable={Number(row.usable_qty)} min={Number(row.min_qty)} max={Number(row.max_qty)} />
      <p className="text-xs text-gray-700">
        Kullanılabilir {formatQty(row.usable_qty)} · Toplam {formatQty(row.total_qty)}
        {Number(row.expired_qty) > 0 ? ` · SKT geçmiş ${formatQty(row.expired_qty)}` : ""} {row.usage_unit}
      </p>
      {locationScoped && row.at_location_qty !== undefined && (
        <p className="text-xs text-gray-700">
          Bu konumda: {formatQty(row.at_location_qty)} {row.usage_unit}
        </p>
      )}
      <p className="text-xs text-gray-500">
        {Number(row.min_qty) === 0 && Number(row.max_qty) === 0
          ? "MIN/MAX belirlenmedi"
          : `MIN ${formatQty(row.min_qty)} / MAX ${formatQty(row.max_qty)} ${row.usage_unit}`}
      </p>
    </div>
  );
}
