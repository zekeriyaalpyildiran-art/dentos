"use client";

// Movement history (spec p7_rules_ui §20.8, contract §5.4): filters, paged ledger (total from SQL), correction
// requests and usage returns.

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { MOVEMENT_LABELS, MOVEMENT_TYPES, type MovementType } from "@/lib/stock/codes";
import { addDays } from "@/lib/stock/expiry";
import {
  istanbulToday,
  stockMovementHistory,
  toStockError,
  type HistoryFilters,
  type LevelRow,
  type MovementRow,
  type StockError,
} from "@/lib/stock/rpc";
import { UUID_RE } from "@/lib/finance";
import { ItemPicker } from "@/components/stock/ItemPicker";
import { MovementTable } from "@/components/stock/MovementTable";
import { RequestCorrectionDialog } from "@/components/stock/CorrectionDialogs";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { useStockLocations } from "@/components/stock/useStockRefs";
import {
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  Pager,
  StockErrorBox,
  StockModal,
  buttonSecondary,
  stockInput,
} from "@/components/stock/ui";

const PAGE = 50;

export default function MovementsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Movements />
    </Suspense>
  );
}

function Movements() {
  const params = useSearchParams();
  const { today: serverToday, tick, notifyChanged, openSheet } = useStock();
  const { locations } = useStockLocations();
  const today = serverToday ?? istanbulToday();

  const [from, setFrom] = useState(() => addDays(istanbulToday(), -30));
  const [to, setTo] = useState(() => istanbulToday());
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const [locationId, setLocationId] = useState("");
  const [types, setTypes] = useState<MovementType[]>([]);
  const [mine, setMine] = useState(params.get("mine") === "1");
  const [corrected, setCorrected] = useState<"" | "only" | "exclude">("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<MovementRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<StockError | null>(null);
  const [pickItem, setPickItem] = useState(false);
  const [correctionRow, setCorrectionRow] = useState<MovementRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const id = params.get("item");
    if (id && UUID_RE.test(id)) setItem({ id, name: "Seçilen ürün" });
  }, [params]);

  const load = useCallback(async () => {
    if (from && to && from > to) {
      setError(toStockError({ message: "Geçerli tarih aralığı seçin.", code: "P0001" }));
      return;
    }
    const filters: HistoryFilters = {
      stock_item_id: item?.id,
      location_id: locationId || undefined,
      types: types.length ? types : undefined,
      from: from || undefined,
      to: to || undefined,
      mine: mine || undefined,
      corrected: corrected || undefined,
    };
    try {
      const r = await stockMovementHistory(filters, { offset, limit: PAGE });
      setRows(r.rows || []);
      setTotal(r.total ?? 0);
      setError(null);
      if (item && item.name === "Seçilen ürün" && r.rows?.[0]) setItem({ id: item.id, name: r.rows[0].item_name });
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [item, locationId, types, from, to, mine, corrected, offset]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const toggleType = (t: MovementType) => {
    setTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));
    setOffset(0);
  };

  return (
    <StockShell title="Hareketler" subtitle="Her stok değişikliği bir hareket kaydıdır; kayıtlar silinmez, düzeltme ile geri alınır.">
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Başlangıç">
            <input
              type="date"
              className={stockInput}
              value={from}
              max={today}
              onChange={(e) => {
                setFrom(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="Bitiş">
            <input
              type="date"
              className={stockInput}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="Konum">
            <select
              className={stockInput}
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Tümü</option>
              {(locations || []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ürün">
            {item ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate">{item.name}</span>
                <button
                  type="button"
                  className="text-sm text-blue-700 hover:underline min-h-[44px]"
                  onClick={() => {
                    setItem(null);
                    setOffset(0);
                  }}
                >
                  Temizle
                </button>
              </div>
            ) : (
              <button type="button" className={`${buttonSecondary} w-full min-h-[44px]`} onClick={() => setPickItem(true)}>
                Ürün seç
              </button>
            )}
          </Field>
        </div>
        <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="Hareket türü">
          {MOVEMENT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={types.includes(t)}
              onClick={() => toggleType(t)}
              className={`px-3 min-h-[36px] rounded text-sm ${types.includes(t) ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
            >
              {MOVEMENT_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 mt-3 text-sm">
          <label className="flex items-center gap-2 min-h-[44px]">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => {
                setMine(e.target.checked);
                setOffset(0);
              }}
            />
            Yalnız benim kayıtlarım
          </label>
          <label className="flex items-center gap-2">
            Düzeltilenler:
            <select
              className="border rounded px-2 py-1 text-base"
              value={corrected}
              onChange={(e) => {
                setCorrected(e.target.value as "" | "only" | "exclude");
                setOffset(0);
              }}
            >
              <option value="">Tümü</option>
              <option value="only">Yalnız düzeltilenler</option>
              <option value="exclude">Düzeltilenler hariç</option>
            </select>
          </label>
        </div>
      </Card>

      {message && (
        <div className="mb-4">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      <StockErrorBox error={error} onReload={() => void load()} />

      <Card>
        {rows === null ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState>Bu filtrelerle hareket yok.</EmptyState>
        ) : (
          <MovementTable
            rows={rows}
            onRequestCorrection={setCorrectionRow}
            onReturn={(row) => openSheet({ type: "return", itemId: row.stock_item_id, sourceMovementId: row.id })}
          />
        )}
        <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />
      </Card>

      {pickItem && (
        <StockModal title="Ürün seç" onClose={() => setPickItem(false)}>
          <ItemPicker
            operable={false}
            autoFocus
            onPick={(row: LevelRow) => {
              setItem({ id: row.id, name: row.item_name });
              setOffset(0);
              setPickItem(false);
            }}
          />
        </StockModal>
      )}

      {correctionRow && (
        <RequestCorrectionDialog
          row={correctionRow}
          onClose={() => setCorrectionRow(null)}
          onDone={() => {
            setCorrectionRow(null);
            setMessage("Düzeltme talebi stok sorumlusuna iletildi. Stok değişmedi.");
            notifyChanged();
          }}
        />
      )}
    </StockShell>
  );
}
