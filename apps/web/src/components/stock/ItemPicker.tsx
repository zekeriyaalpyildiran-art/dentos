"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { stockItemLevels, toStockError, type LevelRow, type StockError } from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { LevelBadge, StockErrorBox, stockInput } from "./ui";

/** Scanner modal; the component and its decoder load only when first opened. */
export const BarcodeScanner = dynamic(() => import("./BarcodeScannerModal"), { ssr: false });

const PICKER_LIMIT = 40;
type Tab = "all" | "favorites" | "recent";

/**
 * Item search for the movement sheet and filters (SU picker): ready cards only by default,
 * tabs Tümü / Favoriler / Son kullandıklarım, at most 40 rows.
 */
export function ItemPicker({
  onPick,
  operable = true,
  autoFocus,
  locationId,
}: {
  onPick: (row: LevelRow) => void;
  operable?: boolean;
  autoFocus?: boolean;
  /** Only items with stock at this location (and their quantity there). */
  locationId?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LevelRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<StockError | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    stockItemLevels(
      {
        q: query || undefined,
        operable: operable || undefined,
        favorites: tab === "favorites" || undefined,
        recent: tab === "recent" || undefined,
        location_id: locationId || undefined,
      },
      { offset: 0, limit: PICKER_LIMIT }
    )
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows || []);
        setTotal(r.total ?? 0);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRows([]);
        setError(toStockError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [query, tab, operable, locationId]);

  return (
    <div className="space-y-2">
      <input
        className={stockInput}
        placeholder="Ad, marka, kod veya barkod"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus={autoFocus}
        aria-label="Ürün ara"
      />
      <div className="flex gap-1" role="tablist">
        {(
          [
            ["all", "Tümü"],
            ["favorites", "Favoriler"],
            ["recent", "Son kullandıklarım"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`px-3 min-h-[40px] rounded text-sm ${tab === key ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <StockErrorBox error={error} />
      <ul className="divide-y border rounded max-h-[45dvh] overflow-y-auto">
        {rows === null ? (
          <li className="p-3 text-sm text-gray-500">Yükleniyor...</li>
        ) : rows.length === 0 ? (
          <li className="p-3 text-sm text-gray-500">
            {tab === "favorites"
              ? "Favori ürününüz yok. Kart sayfasındaki yıldızla ekleyebilirsiniz."
              : tab === "recent"
                ? "Henüz stok işleminiz yok."
                : "Ürün bulunamadı."}
          </li>
        ) : (
          rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onPick(row)}
                className="w-full text-left px-3 py-2 min-h-11 hover:bg-blue-50 flex items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-gray-900 truncate">
                    {row.is_favorite ? "★ " : ""}
                    {row.item_name}
                  </span>
                  <span className="block text-xs text-gray-500 truncate">
                    {[row.brand, row.model, row.item_code].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <LevelBadge level={row.tracking_level} />
                  <span className="block text-xs text-gray-600 mt-0.5 tabular-nums">
                    {formatQty(locationId && row.at_location_qty !== undefined ? row.at_location_qty : row.usable_qty)}{" "}
                    {row.usage_unit} kullanılabilir
                  </span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      {total > PICKER_LIMIT && (
        <p className="text-xs text-gray-500">
          {total} üründen ilk {PICKER_LIMIT} tanesi gösteriliyor. Aramayı daraltın.
        </p>
      )}
    </div>
  );
}
