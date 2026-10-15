"use client";

// Stock picker of the implant form (spec p9_clinical §7.1 field 6, §6.4): ready A-level cards with usable balances,
// grouped by card, FEFO order from the server. Choosing a row fixes the batch, the location and the lot / serial.

import { useEffect, useState } from "react";
import {
  clinImplantStockOptions,
  toClinicalError,
  type ClinicalError,
  type StockOptionBatch,
  type StockOptionItem,
} from "@/lib/clinical/rpc";
import { formatMonthYear } from "@/lib/clinical/dates";
import { ClinicalNotice, clinInput } from "./ui";

export interface StockChoice {
  item: StockOptionItem;
  batch: StockOptionBatch;
}

export function lotSerialText(lot: string | null | undefined, serial: string | null | undefined): string {
  const parts: string[] = [];
  if (lot && lot !== "GENEL") parts.push(`Lot ${lot}`);
  if (serial) parts.push(`Seri ${serial}`);
  return parts.join(" · ") || "Lot / seri yok";
}

export function ImplantStockPicker({
  value,
  onChange,
  disabled,
}: {
  value: StockChoice | null;
  onChange: (choice: StockChoice | null) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<StockOptionItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [busy, setBusy] = useState(false);
  // Locations seen in the unfiltered answer, so the filter keeps its options after narrowing.
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      setBusy(true);
      clinImplantStockOptions(q.trim().slice(0, 100) || null, locationId || null)
        .then((r) => {
          if (cancelled) return;
          setItems(r.items || []);
          setTruncated(!!r.truncated);
          setError(null);
          if (!locationId) {
            const seen = new Map<string, string>();
            for (const it of r.items || []) for (const b of it.batches) seen.set(b.location_id, b.location_name);
            setLocations((prev) => {
              const merged = new Map(prev.map((l) => [l.id, l.name]));
              seen.forEach((name, id) => merged.set(id, name));
              return Array.from(merged, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "tr"));
            });
          }
        })
        .catch((err) => {
          if (!cancelled) setError(toClinicalError(err));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, locationId]);

  const selected = value;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
        <input
          className={clinInput}
          placeholder="Ürün, marka, model, lot, seri veya barkod ara"
          aria-label="İmplant stoğunda ara"
          value={q}
          disabled={disabled}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className={clinInput}
          aria-label="Konum"
          value={locationId}
          disabled={disabled}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Tüm konumlar</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <ClinicalNotice error={error} />
      {busy && !items && <p className="text-sm text-gray-500">Stok yükleniyor...</p>}
      {items && items.length === 0 && !error && (
        <p className="text-sm text-gray-600 p-3 border rounded bg-gray-50">
          Kullanılabilir A grubu implant stoğu yok. Önce mal kabul yapın veya “Stok dışı” seçin.
        </p>
      )}
      {items && items.length > 0 && (
        <div className="border rounded divide-y max-h-72 overflow-y-auto">
          {items.map((item) => (
            <div key={item.stock_item_id}>
              <div className="px-3 py-2 bg-gray-50 text-sm font-semibold text-gray-800">
                {item.item_name}
                {(item.brand || item.model) && (
                  <span className="font-normal text-gray-600"> · {[item.brand, item.model].filter(Boolean).join(" ")}</span>
                )}
              </div>
              <ul>
                {item.batches.map((b) => {
                  const isSel = !!value && b.batch_id === value.batch.batch_id && b.location_id === value.batch.location_id;
                  return (
                    <li key={`${b.batch_id}:${b.location_id}`}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange(isSel ? null : { item, batch: b })}
                        className={`w-full text-left px-3 py-2 min-h-[44px] text-sm ${
                          isSel ? "bg-blue-600 text-white" : "hover:bg-blue-50 text-gray-800"
                        }`}
                        aria-pressed={isSel}
                      >
                        {lotSerialText(b.lot_number, b.serial_number)}
                        {b.expiry_date && ` · SKT ${formatMonthYear(b.expiry_date)}`} · {b.location_name} · {b.quantity} adet
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {truncated && <p className="text-xs text-gray-500">Liste kısaltıldı; aramayı daraltın.</p>}
      {selected && (
        <p className="text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded p-2">
          Kaydedince: {selected.item.item_name} · {lotSerialText(selected.batch.lot_number, selected.batch.serial_number)} ·{" "}
          {selected.batch.location_name} konumundan 1 adet düşülecek.
        </p>
      )}
    </div>
  );
}
