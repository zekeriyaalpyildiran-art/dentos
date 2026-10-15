"use client";

// Reorder suggestions for the order builder (spec p8_purchasing §12.4, formula §7). Computed in SQL; the panel only
// groups by supplier and hands rows to the order list.

import { useEffect, useMemo, useRef, useState } from "react";
import { qtyLabel, PO_MAX_LINES } from "@/lib/stock/purchasing";
import {
  stockReorderSuggestions,
  toStockError,
  type StockError,
  type SuggestionList,
  type SuggestionRow,
  type SuggestionScope,
  type SupplierJson,
} from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { useStock } from "../StockContext";
import { Badge, Card, EmptyState, LevelBadge, Loading, buttonSecondary, formatTL, stockInput } from "../ui";
import { PurchasingErrorBox } from "./common";

const NO_SUPPLIER = "none";

export function SuggestionsPanel({
  orderSupplierId,
  suppliers,
  listedIds,
  lineCount,
  onAdd,
}: {
  orderSupplierId: string;
  suppliers: SupplierJson[];
  listedIds: Set<string>;
  lineCount: number;
  /** Adds the rows in order; the caller stops at 20 lines and reports it. */
  onAdd: (rows: SuggestionRow[]) => void;
}) {
  const { tick } = useStock();
  const [scope, setScope] = useState<SuggestionScope>("critical");
  const [supplierFilter, setSupplierFilter] = useState("");
  const touched = useRef(false);
  const [data, setData] = useState<SuggestionList | null>(null);
  const [error, setError] = useState<StockError | null>(null);

  // The filter follows the order's supplier until the user picks another filter.
  useEffect(() => {
    if (!touched.current && orderSupplierId) setSupplierFilter(orderSupplierId);
  }, [orderSupplierId]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    stockReorderSuggestions({ scope, supplier_id: supplierFilter || undefined }, { offset: 0, limit: 200 })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(toStockError(e));
        setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, supplierFilter, tick]);

  const groups = useMemo(() => {
    const rows = data?.rows ?? [];
    const order: (string | null)[] = [];
    const byId = new Map<string | null, SuggestionRow[]>();
    for (const r of rows) {
      const k = r.supplier_id ?? null;
      if (!byId.has(k)) {
        byId.set(k, []);
        order.push(k);
      }
      byId.get(k)!.push(r);
    }
    // "Tedarikçi atanmamış" last.
    order.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
    return order.map((k) => ({
      supplierId: k,
      name: k === null ? "Tedarikçi atanmamış" : byId.get(k)![0].supplier_name ?? "Tedarikçi",
      rows: byId.get(k)!,
      info: data?.by_supplier?.find((g) => (g.supplier_id ?? null) === k) ?? null,
    }));
  }, [data]);

  const full = lineCount >= PO_MAX_LINES;

  return (
    <Card title="Sipariş önerileri">
      <p className="text-sm text-gray-600 mb-3">
        Öneriler açık siparişleri düşer ve alış paketine yukarı yuvarlanır. Bir siparişte aynı tedarikçiden en fazla 20 ürün
        olur. Tedarikçiye otomatik mesaj gönderilmez.
      </p>
      <div className="flex flex-wrap gap-2 mb-3">
        <div className="flex gap-1" role="tablist" aria-label="Öneri kapsamı">
          {(
            [
              ["critical", "Kritik olanlar"],
              ["below_max", "Hedefin altındakiler"],
            ] as [SuggestionScope, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={scope === value}
              onClick={() => setScope(value)}
              className={`px-3 min-h-[40px] rounded text-sm ${scope === value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          className={`${stockInput} sm:max-w-xs`}
          value={supplierFilter}
          onChange={(e) => {
            touched.current = true;
            setSupplierFilter(e.target.value);
          }}
          aria-label="Öneri tedarikçisi"
        >
          <option value="">Tüm tedarikçiler</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value={NO_SUPPLIER}>Tedarikçi atanmamış</option>
        </select>
      </div>
      <PurchasingErrorBox error={error} />
      {!data && !error ? (
        <Loading />
      ) : data && data.rows.length === 0 ? (
        <EmptyState>Açık siparişler dikkate alındığında yeni öneri yok.</EmptyState>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const addable = g.rows.filter((r) => !listedIds.has(r.stock_item_id));
            return (
              <div key={g.supplierId ?? "none"} className="border rounded">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-b">
                  <div className="text-sm">
                    <span className="font-semibold">{g.name}</span> · {g.info?.items ?? g.rows.length} ürün
                    {g.info && typeof g.info.est_cost_cents === "number" && (
                      <span className="text-gray-600"> · Tahmini tutar {formatTL(g.info.est_cost_cents)}</span>
                    )}
                    {g.info && typeof g.info.uncosted_items === "number" && g.info.uncosted_items > 0 && (
                      <span className="text-amber-700"> · {g.info.uncosted_items} ürünün maliyeti yok</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`${buttonSecondary} text-sm min-h-[40px]`}
                    disabled={full || addable.length === 0}
                    onClick={() => onAdd(addable)}
                  >
                    Gruptakilerin hepsini ekle
                  </button>
                </div>
                <ul className="divide-y">
                  {g.rows.map((r) => {
                    const listed = listedIds.has(r.stock_item_id);
                    return (
                      <li key={r.stock_item_id} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{r.item_name}</span>
                            <LevelBadge level={r.tracking_level} />
                            {r.state === "out" && <Badge className="bg-red-100 text-red-700">Tükendi</Badge>}
                            {r.supplier_active === false && <Badge className="bg-gray-200 text-gray-700">Tedarikçi pasif</Badge>}
                          </div>
                          <p className="text-xs text-gray-600 tabular-nums">
                            Kullanılabilir {formatQty(r.usable_qty)} · Açık sipariş {formatQty(r.open_po_qty)} · Öneri{" "}
                            {qtyLabel(r.need_qty, r.usage_unit, r.purchase_unit, r.units_per_purchase)}
                            {typeof r.est_cost_cents === "number" && ` · Tahmini ${formatTL(r.est_cost_cents)}`}
                          </p>
                        </div>
                        <button
                          type="button"
                          className={`${buttonSecondary} text-sm min-h-[40px]`}
                          disabled={listed || full}
                          onClick={() => onAdd([r])}
                        >
                          {listed ? "Listede" : "Listeye ekle"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
