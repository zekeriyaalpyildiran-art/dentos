"use client";

// Counts per location (spec p7_rules_ui §20.9, contract §4.7, §5.6, §5.11). The snapshot's balances are sent back as
// expected quantities, so a stock change during the count is refused (E_COUNT_STALE) instead of overwritten.

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { batchMatchesScan } from "@/lib/stock/barcode-match";
import { parseGs1 } from "@/lib/stock/gs1";
import {
  newKey,
  stockCount,
  stockCountHistory,
  stockLocationSnapshot,
  stockScanLookup,
  toStockError,
  type CountSessionRow,
  type LocationSnapshot,
  type SnapshotRow,
  type StockError,
} from "@/lib/stock/rpc";
import { STORAGE_KEYS, readJson, removeKey, writeJson } from "@/lib/stock/storage";
import { AMBIGUOUS_QTY_MESSAGE, formatQty, isAmbiguousThousands, isWholeNumber, parseQty } from "@/lib/stock/units";
import { UUID_RE, formatTimestamp } from "@/lib/finance";
import { BarcodeScanner } from "@/components/stock/ItemPicker";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { useStockLocations } from "@/components/stock/useStockRefs";
import {
  Card,
  EmptyState,
  ExpiryBadge,
  Field,
  LevelBadge,
  Loading,
  Notice,
  Pager,
  StockErrorBox,
  bigPrimary,
  buttonSecondary,
  stockInput,
} from "@/components/stock/ui";

const SNAPSHOT_LIMIT = 500;
const SAVE_LIMIT = 500;
const HISTORY_PAGE = 30;

interface CountDraft {
  operationKey: string;
  entries: Record<string, string>;
}

export default function CountsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Counts />
    </Suspense>
  );
}

function rowProblem(row: SnapshotRow, raw: string): string | null {
  if (isAmbiguousThousands(raw)) return AMBIGUOUS_QTY_MESSAGE;
  const v = parseQty(raw);
  if (Number.isNaN(v)) return "Geçerli bir miktar girin.";
  if (row.tracking_level === "A" && !isWholeNumber(v)) return "A grubu ürünlerde tam adet girin.";
  if (row.serial_number && v > 1) return "Tek seri numarası için en fazla 1 adet bulunabilir.";
  if (row.tracking_level === "A" && v > Number(row.expected_qty)) {
    return "A grubu fazla ürün sayımla eklenemez. Stok sorumlusu lot / seri bilgisiyle mal kabul veya kullanım iadesi yapmalıdır.";
  }
  return null;
}

function Counts() {
  const params = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const { gates, today, tick, notifyChanged } = useStock();
  const { active: locations, defaultWarehouse } = useStockLocations();
  const itemFilter = (() => {
    const id = params.get("item");
    return id && UUID_RE.test(id) ? id : null;
  })();

  const [locationId, setLocationId] = useState("");
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null);
  const [snapOffset, setSnapOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  // Entered values, kept with the location and operation key they belong to (one draft per location).
  const [draft, setDraft] = useState<{ loc: string; key: string; values: Record<string, string> }>({
    loc: "",
    key: "",
    values: {},
  });
  const entries = useMemo(() => (draft.loc === locationId ? draft.values : {}), [draft, locationId]);
  const setEntries = (fn: (values: Record<string, string>) => Record<string, string>) =>
    setDraft((d) => ({ ...d, values: fn(d.values) }));
  const [search, setSearch] = useState("");
  const [onlyEntered, setOnlyEntered] = useState(false);
  const [review, setReview] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<StockError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  // Lots scanned during the count that have no balance row at this location (a surplus of a lot held elsewhere,
  // legacy CP:15-19): counted with expected 0. Kept per location.
  const [extraRows, setExtraRows] = useState<{ loc: string; rows: SnapshotRow[] }>({ loc: "", rows: [] });

  const [history, setHistory] = useState<CountSessionRow[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);

  useEffect(() => {
    if (!locationId && defaultWarehouse) setLocationId(defaultWarehouse.id);
  }, [locationId, defaultWarehouse]);

  // Draft restore per location.
  useEffect(() => {
    if (!user || !locationId) return;
    const saved = readJson<CountDraft>(STORAGE_KEYS.count(user.user_id, locationId));
    if (saved && typeof saved.operationKey === "string" && saved.entries && typeof saved.entries === "object") {
      setDraft({ loc: locationId, key: saved.operationKey, values: saved.entries });
    } else {
      setDraft({ loc: locationId, key: newKey(), values: {} });
    }
    setReview(false);
    setSaveError(null);
    setMessage(null);
    setSnapOffset(0);
  }, [user, locationId]);

  useEffect(() => {
    if (!user || !draft.loc) return;
    const storageKey = STORAGE_KEYS.count(user.user_id, draft.loc);
    const filled = Object.values(draft.values).some((v) => v.trim() !== "");
    if (filled) writeJson(storageKey, { operationKey: draft.key, entries: draft.values } satisfies CountDraft);
    else removeKey(storageKey);
  }, [user, draft]);

  const loadSnapshot = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      const s = await stockLocationSnapshot(
        locationId,
        { stock_item_id: itemFilter ?? undefined },
        { offset: snapOffset, limit: SNAPSHOT_LIMIT }
      );
      setSnapshot(s);
      setError(null);
    } catch (e) {
      setSnapshot(null);
      setError(toStockError(e));
    } finally {
      setLoading(false);
    }
  }, [locationId, itemFilter, snapOffset]);

  useEffect(() => {
    if (gates.mgr) void loadSnapshot();
  }, [loadSnapshot, gates.mgr]);

  const loadHistory = useCallback(async () => {
    try {
      const r = await stockCountHistory(locationId || null, { offset: historyOffset, limit: HISTORY_PAGE });
      setHistory(r.rows || []);
      setHistoryTotal(r.total ?? 0);
    } catch {
      setHistory([]);
    }
  }, [locationId, historyOffset]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, tick]);

  const rows = useMemo(() => {
    const base = snapshot?.rows ?? [];
    if (extraRows.loc !== locationId) return base;
    const known = new Set(base.map((r) => r.batch_id));
    return [...base, ...extraRows.rows.filter((r) => !known.has(r.batch_id))];
  }, [snapshot, extraRows, locationId]);
  const q = search.trim().toLocaleLowerCase("tr-TR");
  const shown = rows.filter((r) => {
    if (onlyEntered && !(entries[r.batch_id] ?? "").trim()) return false;
    if (!q) return true;
    return (
      r.item_name.toLocaleLowerCase("tr-TR").includes(q) ||
      r.lot_number.toLocaleLowerCase("tr-TR").includes(q) ||
      (r.serial_number ?? "").toLocaleLowerCase("tr-TR").includes(q)
    );
  });

  const entered = rows.filter((r) => (entries[r.batch_id] ?? "").trim() !== "");
  const problems = entered.map((r) => ({ row: r, problem: rowProblem(r, entries[r.batch_id]) })).filter((x) => x.problem);
  const toSave = entered.slice(0, SAVE_LIMIT);

  async function onScanned(raw: string) {
    setScanMessage(null);
    try {
      const p = parseGs1(raw);
      if (!p.gtin) throw new Error("Bu kodda ürün barkodu bulunamadı. Ürünün stok barkodunu okutun.");
      const look = await stockScanLookup({ gtin: p.gtin, lot: p.lot, serial: p.serial, expiry: p.expiry, locationId });
      if (!look.item) throw new Error("Bu barkod ürün listesinde yok. Stok sorumlusu ürün kartına barkodu tanımlamalı.");
      const item = look.item;
      const scan = { ...p, itemId: item.id };
      let match: SnapshotRow | undefined = rows.find((r) =>
        batchMatchesScan(
          { stockItemId: r.stock_item_id, lotNumber: r.lot_number, serialNumber: r.serial_number, expiryDate: r.expiry_date },
          scan
        )
      );
      if (!match) {
        // The lot may exist only at other locations: it can still be counted here as a surplus (expected 0), except
        // for level A, where a surplus is never added by a count.
        if (item.tracking_level === "A") {
          throw new Error(
            "Bu lot bu konumda kayıtlı değil. A grubu fazla ürün sayımla eklenemez; stok sorumlusu mal kabul veya kullanım iadesi yapmalıdır."
          );
        }
        const all = await stockScanLookup({ gtin: p.gtin, lot: p.lot, serial: p.serial, expiry: p.expiry });
        const elsewhere = (all.batches || []).find((b) =>
          batchMatchesScan(
            { stockItemId: item.id, lotNumber: b.lot_number, serialNumber: b.serial_number, expiryDate: b.expiry_date },
            scan
          )
        );
        if (!elsewhere) throw new Error("Bu lot kayıtlı değil. Yeni lot için önce mal kabul yapın.");
        const extra: SnapshotRow = {
          batch_id: elsewhere.batch_id,
          stock_item_id: item.id,
          item_name: item.item_name,
          usage_unit: item.usage_unit,
          tracking_level: item.tracking_level,
          lot_number: elsewhere.lot_number,
          serial_number: elsewhere.serial_number,
          expiry_date: elsewhere.expiry_date,
          expired: !!elsewhere.expiry_date && !!today && elsewhere.expiry_date < today,
          expected_qty: 0,
        };
        setExtraRows((x) => ({
          loc: locationId,
          rows: [...(x.loc === locationId ? x.rows : []).filter((r) => r.batch_id !== extra.batch_id), extra],
        }));
        setScanMessage("Bu lot bu konumda kayıtlı değildi; sistemde 0 olarak listeye eklendi. Saydığınız miktarı girin.");
        match = extra;
      }
      const target = match;
      setSearch("");
      setOnlyEntered(false);
      setHighlight(target.batch_id);
      setTimeout(() => {
        const el = inputs.current[target.batch_id];
        el?.scrollIntoView({ block: "center" });
        el?.focus();
      }, 50);
    } catch (e) {
      setScanMessage(e instanceof Error ? e.message : toStockError(e).message);
    }
  }

  async function save() {
    setSaveError(null);
    setMessage(null);
    const r = reason.trim();
    if (r.length < 3 || r.length > 500) {
      setSaveError(toStockError({ message: "Saydığınız miktarı ve kısa bir açıklama girin.", code: "P0001" }));
      return;
    }
    if (problems.length > 0) return;
    setBusy(true);
    try {
      const result = await stockCount({
        p_operation_key: draft.key,
        p_location_id: locationId,
        p_lines: toSave.map((row) => ({
          batch_id: row.batch_id,
          expected_qty: Number(row.expected_qty),
          actual_qty: parseQty(entries[row.batch_id]),
        })),
        p_reason: r,
      });
      const savedIds = new Set(toSave.map((x) => x.batch_id));
      setDraft((d) => ({
        ...d,
        key: newKey(),
        values: Object.fromEntries(Object.entries(d.values).filter(([k]) => !savedIds.has(k))),
      }));
      setReview(false);
      setReason("");
      setExtraRows({ loc: "", rows: [] });
      setMessage(
        `${result.already_saved ? "Bu sayım daha önce kaydedilmişti. " : ""}${result.lines} satır kaydedildi · ${result.differences} fark` +
          (result.differences ? ` (artı ${formatQty(result.adjust_in_qty)}, eksi ${formatQty(result.adjust_out_qty)})` : "")
      );
      notifyChanged();
      void loadSnapshot();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") {
        // Never mint a new key silently: an earlier attempt with this key may already be saved.
        let saved = false;
        try {
          const h = await stockCountHistory(locationId || null, { offset: 0, limit: 50 });
          saved = (h.rows || []).some((x) => x.operation_key === draft.key);
        } catch {
          saved = false;
        }
        if (saved) {
          const savedIds = new Set(toSave.map((x) => x.batch_id));
          setDraft((d) => ({
            ...d,
            key: newKey(),
            values: Object.fromEntries(Object.entries(d.values).filter(([k]) => !savedIds.has(k))),
          }));
          setReview(false);
          setMessage("Bu sayım daha önce kaydedilmiş; ikinci kez kaydedilmedi. Son sayımlar listesini kontrol edin.");
          notifyChanged();
          void loadSnapshot();
          return;
        }
        setDraft((d) => ({ ...d, key: newKey() }));
      }
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!gates.mgr) {
    return (
      <StockShell title="Sayım">
        <Notice tone="warn">Bu işlem için stok yönetim yetkisi gerekir.</Notice>
      </StockShell>
    );
  }

  return (
    <StockShell title="Sayım" subtitle="Konum seç → Lotu say → Gerekçeyi kaydet">
      <div className="space-y-4">
        <Card>
          <div className="grid gap-3 md:grid-cols-[minmax(12rem,20rem)_1fr]">
            <Field label="Oda / depo">
              <select className={stockInput} value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={review}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            {!review && (
              <div className="flex flex-wrap items-end gap-2">
                <input
                  className={`${stockInput} flex-1 min-w-[12rem]`}
                  placeholder="Ürün, lot veya seri ara"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Sayım listesinde ara"
                />
                <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => setScanOpen(true)}>
                  Barkod okut
                </button>
                <label className="flex items-center gap-2 text-sm min-h-[44px]">
                  <input type="checkbox" checked={onlyEntered} onChange={(e) => setOnlyEntered(e.target.checked)} />
                  Yalnız girilenleri göster
                </label>
              </div>
            )}
          </div>
          {itemFilter && <p className="text-xs text-gray-600 mt-2">Yalnız seçilen ürünün lotları gösteriliyor.</p>}
          {scanMessage && (
            <p role="alert" className="text-sm text-red-700 mt-2">
              {scanMessage}
            </p>
          )}
        </Card>

        {message && <Notice tone="success">{message}</Notice>}
        <StockErrorBox error={error} onReload={() => void loadSnapshot()} />

        {!review ? (
          <Card
            title="Oda / depo toplu sayımı"
            actions={
              entered.length > 0 ? (
                <button type="button" className={`${bigPrimary} sm:w-auto px-6`} onClick={() => setReview(true)}>
                  {entered.length} satırı kontrol et
                </button>
              ) : undefined
            }
          >
            <p className="text-sm text-gray-600 mb-3">Boş bırakılan satır değişmez; hiç yoksa 0 yazın.</p>
            {loading && !snapshot ? (
              <Loading />
            ) : shown.length === 0 ? (
              <EmptyState>
                {rows.length === 0
                  ? "Bu konumda sayılacak lot yok. Yeni lot için önce mal kabul yapın."
                  : "Aramaya uyan satır yok."}
              </EmptyState>
            ) : (
              <ul className="divide-y">
                {shown.map((row) => {
                  const raw = entries[row.batch_id] ?? "";
                  const problem = raw.trim() ? rowProblem(row, raw) : null;
                  return (
                    <li
                      key={row.batch_id}
                      className={`py-3 grid gap-2 sm:grid-cols-[1fr_auto] items-center ${highlight === row.batch_id ? "bg-blue-50" : ""}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.item_name}</span>
                          <LevelBadge level={row.tracking_level} />
                        </div>
                        <p className="text-sm text-gray-600">
                          Lot {row.lot_number}
                          {row.serial_number ? ` · seri ${row.serial_number}` : ""}
                        </p>
                        <div className="text-sm">
                          <ExpiryBadge expiry={row.expiry_date} today={today} />
                        </div>
                        <p className="text-sm text-gray-700">
                          Sistemde {formatQty(row.expected_qty)} {row.usage_unit}
                        </p>
                        {problem && <p className="text-xs text-red-700">{problem}</p>}
                      </div>
                      <input
                        ref={(el) => {
                          inputs.current[row.batch_id] = el;
                        }}
                        className={`${stockInput} h-12 sm:w-32`}
                        inputMode="decimal"
                        placeholder="Sayılan"
                        value={raw}
                        onChange={(e) => setEntries((x) => ({ ...x, [row.batch_id]: e.target.value }))}
                        aria-label={`${row.item_name} lot ${row.lot_number} sayılan miktar`}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {snapshot && (
              <Pager offset={snapOffset} limit={SNAPSHOT_LIMIT} total={snapshot.total} onChange={setSnapOffset} />
            )}
          </Card>
        ) : (
          <Card title="Sayımı kontrol edin">
            <ul className="divide-y mb-4">
              {entered.map((row) => {
                const actual = parseQty(entries[row.batch_id]);
                const diff = Number.isNaN(actual) ? NaN : Math.round((actual - Number(row.expected_qty)) * 10000) / 10000;
                const aSurplus = row.tracking_level === "A" && diff > 0;
                const tone = aSurplus ? "text-red-700" : diff !== 0 ? "text-amber-700" : "text-gray-700";
                return (
                  <li key={row.batch_id} className="py-2 flex flex-wrap justify-between gap-2 text-sm">
                    <span>
                      {row.item_name} · Lot {row.lot_number}
                      {row.serial_number ? ` · seri ${row.serial_number}` : ""}
                    </span>
                    <span className={`tabular-nums ${tone}`}>
                      Sistem {formatQty(row.expected_qty)} · Sayılan {Number.isNaN(actual) ? "?" : formatQty(actual)} · Fark{" "}
                      {Number.isNaN(diff) ? "?" : `${diff > 0 ? "+" : ""}${formatQty(diff)}`} {row.usage_unit}
                    </span>
                  </li>
                );
              })}
            </ul>
            {problems.length > 0 && (
              <div className="mb-4">
                <Notice tone="danger">
                  Düzeltilmesi gereken {problems.length} satır var. Düzenlemeye dönüp kırmızı satırları kontrol edin.
                </Notice>
              </div>
            )}
            {entered.length > SAVE_LIMIT && (
              <div className="mb-4">
                <Notice tone="warn">Bir sayımda en fazla {SAVE_LIMIT} satır kaydedilir. İlk {SAVE_LIMIT} satır kaydedilecek.</Notice>
              </div>
            )}
            <Field label="Sayım açıklaması *" hint="Tüm satırlar için geçerlidir (3–500 karakter).">
              <textarea className={stockInput} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="mt-4 space-y-2">
              <StockErrorBox
                error={saveError}
                reloadLabel="Bu konumu yeniden yükle"
                onReload={() => {
                  setSaveError(null);
                  void loadSnapshot();
                }}
              />
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  className={bigPrimary}
                  disabled={busy || problems.length > 0 || toSave.length === 0}
                  onClick={() => void save()}
                >
                  {busy
                    ? "Kaydediliyor..."
                    : entered.length > SAVE_LIMIT
                      ? `İlk ${SAVE_LIMIT} satırı kaydet`
                      : "Onayla ve sayımı kaydet"}
                </button>
                <button type="button" className={`${buttonSecondary} h-12`} disabled={busy} onClick={() => setReview(false)}>
                  Düzenlemeye dön
                </button>
              </div>
            </div>
          </Card>
        )}

        <Card title="Son sayımlar">
          {history === null ? (
            <Loading />
          ) : history.length === 0 ? (
            <EmptyState>Bu konumda kayıtlı sayım yok.</EmptyState>
          ) : (
            <ul className="divide-y text-sm">
              {history.map((h) => (
                <li key={h.operation_key} className="py-2 flex flex-wrap justify-between gap-2">
                  <span>
                    {h.location_name} · {h.lines} satır · {h.differences} fark
                    {h.differences > 0 && ` (artı ${formatQty(h.adjust_in_qty)}, eksi ${formatQty(h.adjust_out_qty)})`}
                    <span className="block text-xs text-gray-600">{h.reason}</span>
                  </span>
                  <span className="text-xs text-gray-500">
                    {formatTimestamp(h.created_at)} · {h.actor_name ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Pager offset={historyOffset} limit={HISTORY_PAGE} total={historyTotal} onChange={setHistoryOffset} />
        </Card>
      </div>

      {scanOpen && <BarcodeScanner purpose="movement" onClose={() => setScanOpen(false)} onScan={(raw) => void onScanned(raw)} />}
    </StockShell>
  );
}
