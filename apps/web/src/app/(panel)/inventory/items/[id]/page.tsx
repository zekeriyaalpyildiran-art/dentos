"use client";

// Stock card detail (spec p7_rules_ui §20.3, contract §5.5): lots × locations, paged history, recent counts.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { ORDER_POLICY_LABELS, categoryLabel, type OrderPolicy } from "@/lib/stock/codes";
import {
  newKey,
  stockDb,
  stockItemDetail,
  stockMovementHistory,
  stockSaveItem,
  stockSetFavorite,
  toStockError,
  type ItemDetailJson,
  type MovementRow,
  type StockError,
} from "@/lib/stock/rpc";
import { formatQty } from "@/lib/stock/units";
import { UUID_RE, formatTimestamp } from "@/lib/finance";
import { MovementTable } from "@/components/stock/MovementTable";
import { RequestCorrectionDialog } from "@/components/stock/CorrectionDialogs";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import {
  Badge,
  Card,
  EmptyState,
  ExpiryBadge,
  LevelBadge,
  Loading,
  Notice,
  Pager,
  StockErrorBox,
  StockMeter,
  StockModal,
  bigPrimary,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  formatTL,
} from "@/components/stock/ui";

const HISTORY_PAGE = 20;

interface CountRow {
  id: string;
  created_at: string;
  expected_qty: number;
  actual_qty: number;
  delta: number;
  reason: string;
  location_id: string;
}

export default function ItemDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const { gates, today, openSheet, tick, notifyChanged } = useStock();
  const [detail, setDetail] = useState<ItemDetailJson | null>(null);
  const [error, setError] = useState<StockError | null>(null);
  const [history, setHistory] = useState<MovementRow[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [counts, setCounts] = useState<CountRow[] | null>(null);
  const [correctionRow, setCorrectionRow] = useState<MovementRow | null>(null);
  const [confirmActive, setConfirmActive] = useState(false);
  const [activeBusy, setActiveBusy] = useState(false);
  const [activeError, setActiveError] = useState<StockError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const activeKey = useRef(newKey());

  const load = useCallback(async () => {
    if (!UUID_RE.test(id)) {
      setError(toStockError({ message: "Ürün bulunamadı veya kart bilgileri henüz tamamlanmadı.", code: "PT404" }));
      return;
    }
    try {
      setDetail(await stockItemDetail(id));
      setError(null);
    } catch (e) {
      setError(toStockError(e));
    }
  }, [id]);

  const loadHistory = useCallback(async () => {
    if (!UUID_RE.test(id)) return;
    try {
      const r = await stockMovementHistory({ stock_item_id: id }, { offset: historyOffset, limit: HISTORY_PAGE });
      setHistory(r.rows || []);
      setHistoryTotal(r.total ?? 0);
    } catch (e) {
      setHistory([]);
      setError(toStockError(e));
    }
  }, [id, historyOffset]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, tick]);

  // Last 10 count lines of this item (RLS-filtered direct read, contract §9).
  useEffect(() => {
    if (!clinicId || !UUID_RE.test(id)) return;
    let cancelled = false;
    stockDb()
      .from("stock_counts")
      .select("id,created_at,expected_qty,actual_qty,delta,reason,location_id")
      .eq("clinic_id", clinicId)
      .eq("stock_item_id", id)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (!cancelled) setCounts((data || []) as CountRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId, id, tick]);

  async function toggleFavorite() {
    if (!detail) return;
    try {
      await stockSetFavorite(detail.item.id, !detail.item.is_favorite);
      setDetail({ ...detail, item: { ...detail.item, is_favorite: !detail.item.is_favorite } });
    } catch (e) {
      setError(toStockError(e));
    }
  }

  async function setActive(active: boolean) {
    if (!detail) return;
    setActiveBusy(true);
    setActiveError(null);
    try {
      await stockSaveItem({
        p_operation_key: activeKey.current,
        p_id: detail.item.id,
        p_version: detail.item.version,
        p_item: { is_active: active },
      });
      activeKey.current = newKey();
      setConfirmActive(false);
      setMessage(active ? "Kart yeniden etkinleştirildi." : "Kart pasif yapıldı.");
      notifyChanged();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") activeKey.current = newKey();
      setActiveError(err);
    } finally {
      setActiveBusy(false);
    }
  }

  if (!detail) {
    return (
      <StockShell title="Stok kartı">
        {error ? <StockErrorBox error={error} /> : <Loading />}
        <Link href="/inventory/items" className="inline-block mt-4 text-blue-700 hover:underline">
          ← Stok kartlarına dön
        </Link>
      </StockShell>
    );
  }

  const item = detail.item;
  const showCost = detail.can_view_costs ?? gates.cost;
  const ready = item.is_active && !item.needs_review;
  const locationName = (lid: string) => detail.by_location.find((b) => b.location_id === lid)?.location_name ?? "";

  return (
    <StockShell
      title={
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void toggleFavorite()}
            aria-label={item.is_favorite ? "Favorilerden çıkar" : "Favorilere ekle"}
            className="text-amber-500 min-w-[44px] min-h-[44px]"
          >
            {item.is_favorite ? "★" : "☆"}
          </button>
          {item.item_name}
          <LevelBadge level={item.tracking_level} />
          {item.needs_review && <Badge className="bg-amber-100 text-amber-800">Taslak</Badge>}
          {!item.is_active && <Badge className="bg-gray-200 text-gray-700">Pasif</Badge>}
        </span>
      }
      subtitle={[item.brand, item.model, categoryLabel(item.category)].filter(Boolean).join(" · ")}
      actions={
        <>
          {gates.op && ready && (
            <button type="button" className={`${buttonPrimary} min-h-[44px]`} onClick={() => openSheet({ itemId: item.id })}>
              Hareket
            </button>
          )}
          {gates.mgr && (
            <Link href={`/inventory/items/${item.id}/edit`} className={`${buttonSecondary} min-h-[44px] flex items-center`}>
              Düzenle
            </Link>
          )}
          {gates.mgr && ready && (
            <Link href={`/inventory/counts?item=${item.id}`} className={`${buttonSecondary} min-h-[44px] flex items-center`}>
              Sayım gir
            </Link>
          )}
          {gates.mgr && (
            <button
              type="button"
              className={`${item.is_active ? buttonDanger : buttonSecondary} min-h-[44px]`}
              onClick={() => {
                setActiveError(null);
                setConfirmActive(true);
              }}
            >
              {item.is_active ? "Pasifleştir" : "Etkinleştir"}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-6">
        {message && <Notice tone="success">{message}</Notice>}
        <StockErrorBox error={error} onReload={() => void load()} />

        <Card>
          <div className="grid gap-6 md:grid-cols-3">
            <div className="space-y-1">
              <p className="text-sm text-gray-600">Kullanılabilir</p>
              <p className="text-3xl font-bold tabular-nums">
                {formatQty(item.usable_qty)} <span className="text-base font-normal">{item.usage_unit}</span>
              </p>
              <StockMeter usable={Number(item.usable_qty)} min={Number(item.min_qty)} max={Number(item.max_qty)} />
              <p className="text-sm text-gray-700">
                Toplam {formatQty(item.total_qty)} · SKT geçmiş {formatQty(item.expired_qty)}
              </p>
              <p className="text-sm text-gray-700">
                {Number(item.min_qty) === 0 && Number(item.max_qty) === 0
                  ? "MIN/MAX belirlenmedi"
                  : `MIN ${formatQty(item.min_qty)} / MAX ${formatQty(item.max_qty)}`}
              </p>
              <p className="text-sm">
                En yakın SKT: <ExpiryBadge expiry={item.next_expiry} today={today} />
              </p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm md:col-span-2">
              <dt className="text-gray-600">Birimler</dt>
              <dd>
                1 {item.purchase_unit} = {formatQty(item.units_per_purchase)} {item.usage_unit}
              </dd>
              <dt className="text-gray-600">Varsayılan konum</dt>
              <dd>{item.preferred_location_name ?? "Ana depo"}</dd>
              <dt className="text-gray-600">Tedarikçi</dt>
              <dd>{item.supplier_name ?? "—"}</dd>
              <dt className="text-gray-600">Stok kodu</dt>
              <dd>{item.item_code}</dd>
              <dt className="text-gray-600">Barkod</dt>
              <dd className="font-mono">{item.gtin ?? "—"}</dd>
              <dt className="text-gray-600">ABC / model</dt>
              <dd>
                {item.abc_class || "–"} · {ORDER_POLICY_LABELS[(item.order_policy || "") as OrderPolicy] ?? item.order_policy}
              </dd>
              {showCost && (
                <>
                  <dt className="text-gray-600">Son birim maliyet</dt>
                  <dd>
                    {detail.cost?.last_unit_cost_cents !== null && detail.cost?.last_unit_cost_cents !== undefined
                      ? `${formatTL(detail.cost.last_unit_cost_cents)} / ${item.usage_unit}`
                      : "Fiyat girilmemiş"}
                  </dd>
                  {detail.cost && (
                    <>
                      <dt className="text-gray-600">Stok değeri</dt>
                      <dd>
                        {formatTL(detail.cost.value_cents)}
                        {detail.cost.uncosted_qty > 0 && (
                          <span className="text-xs text-amber-700 ml-2">
                            {formatQty(detail.cost.uncosted_qty)} {item.usage_unit} fiyatsız
                          </span>
                        )}
                      </dd>
                    </>
                  )}
                </>
              )}
              {item.notes && (
                <>
                  <dt className="text-gray-600">Not</dt>
                  <dd className="whitespace-pre-wrap">{item.notes}</dd>
                </>
              )}
            </dl>
          </div>
          {item.locked_fields?.length > 0 && gates.mgr && (
            <p className="text-xs text-gray-500 mt-4">
              Geçmiş miktarların anlamını korumak için takip kuralı ve birimleri sabittir.
            </p>
          )}
        </Card>

        <Card title="Lotlar ve konumlar">
          {detail.by_location.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {detail.by_location.map((b) => (
                <span key={b.location_id} className="px-3 py-1 rounded bg-gray-100 text-sm">
                  {b.location_name}: {formatQty(b.usable_qty)}
                  {Number(b.total_qty) !== Number(b.usable_qty) ? ` (toplam ${formatQty(b.total_qty)})` : ""} {item.usage_unit}
                </span>
              ))}
            </div>
          )}
          {detail.balances.length === 0 ? (
            <EmptyState>Bu üründe stok yok.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-left text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Lot</th>
                    <th className="px-3 py-2">Seri</th>
                    <th className="px-3 py-2">SKT</th>
                    <th className="px-3 py-2">Konum</th>
                    <th className="px-3 py-2 text-right">Miktar</th>
                    <th className="px-3 py-2">Giriş</th>
                    {showCost && <th className="px-3 py-2 text-right">Birim maliyet</th>}
                    {showCost && <th className="px-3 py-2 text-right">Değer</th>}
                    {gates.op && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {detail.balances.map((b) => (
                    <tr key={`${b.batch_id}-${b.location_id}`} className="border-b">
                      <td className="px-3 py-2">{b.lot_number}</td>
                      <td className="px-3 py-2">{b.serial_number ?? "—"}</td>
                      <td className="px-3 py-2">
                        <ExpiryBadge expiry={b.expiry_date} today={today} />
                      </td>
                      <td className="px-3 py-2">{b.location_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(b.quantity)}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">{formatTimestamp(b.received_at)}</td>
                      {showCost && (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {b.unit_cost_cents === null || b.unit_cost_cents === undefined ? "Fiyat girilmemiş" : formatTL(b.unit_cost_cents)}
                        </td>
                      )}
                      {showCost && (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {b.unit_cost_cents === null || b.unit_cost_cents === undefined
                            ? "—"
                            : formatTL(Math.round(Number(b.quantity) * b.unit_cost_cents))}
                        </td>
                      )}
                      {gates.op && (
                        <td className="px-3 py-2">
                          {ready && (
                            <button
                              type="button"
                              className="text-blue-700 hover:underline"
                              onClick={() =>
                                openSheet({
                                  type: b.usable ? "issue" : "waste",
                                  itemId: item.id,
                                  batchId: b.batch_id,
                                  fromLocationId: b.location_id,
                                })
                              }
                            >
                              {b.usable ? "İşlem" : "Fire"}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {(detail.pending_corrections.length > 0 || detail.product_requests.length > 0) && (
          <Card title="Bekleyen talepler">
            <ul className="text-sm space-y-1">
              {detail.pending_corrections.map((c) => (
                <li key={c.id}>
                  <Link href="/inventory/corrections" className="text-blue-700 hover:underline">
                    Düzeltme #{c.ref_no}
                  </Link>{" "}
                  · {c.reason}
                </li>
              ))}
              {detail.product_requests.map((r) => (
                <li key={r.id}>
                  <Link href="/inventory/requests?tab=products" className="text-blue-700 hover:underline">
                    Tanımlama talebi
                  </Link>{" "}
                  · {r.name} · {r.status}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Hareket geçmişi">
          {history === null ? (
            <Loading />
          ) : history.length === 0 ? (
            <EmptyState>Bu üründe hareket yok.</EmptyState>
          ) : (
            <MovementTable
              rows={history}
              showItem={false}
              onRequestCorrection={setCorrectionRow}
              onReturn={(row) => openSheet({ type: "return", itemId: row.stock_item_id, sourceMovementId: row.id })}
            />
          )}
          <Pager offset={historyOffset} limit={HISTORY_PAGE} total={historyTotal} onChange={setHistoryOffset} />
        </Card>

        <Card title="Son sayımlar">
          {counts === null ? (
            <Loading />
          ) : counts.length === 0 ? (
            <EmptyState>Bu ürün henüz sayılmadı.</EmptyState>
          ) : (
            <ul className="divide-y text-sm">
              {counts.map((c) => (
                <li key={c.id} className="py-2 flex flex-wrap justify-between gap-2">
                  <span>
                    {locationName(c.location_id) || "Konum"} · Sistem {formatQty(c.expected_qty)} → Sayılan {formatQty(c.actual_qty)}
                    {Number(c.delta) !== 0 && (
                      <span className={Number(c.delta) > 0 ? "text-green-700" : "text-red-700"}>
                        {" "}
                        ({Number(c.delta) > 0 ? "+" : ""}
                        {formatQty(c.delta)})
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-500">
                    {formatTimestamp(c.created_at)} · {c.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {correctionRow && (
        <RequestCorrectionDialog
          row={correctionRow}
          onClose={() => setCorrectionRow(null)}
          onDone={() => {
            setCorrectionRow(null);
            setMessage("Düzeltme talebi stok sorumlusuna iletildi.");
            notifyChanged();
          }}
        />
      )}

      {confirmActive && (
        <StockModal
          title={item.is_active ? "Kartı pasif yap" : "Kartı yeniden etkinleştir"}
          onClose={() => setConfirmActive(false)}
          busy={activeBusy}
          footer={
            <button type="button" className={bigPrimary} disabled={activeBusy} onClick={() => void setActive(!item.is_active)}>
              {activeBusy ? "Kaydediliyor..." : item.is_active ? "Pasif yap" : "Etkinleştir"}
            </button>
          }
        >
          <div className="space-y-3 text-sm">
            {item.is_active ? (
              <p>
                Pasif kartla stok hareketi yapılamaz; geçmiş korunur. Stoku olan kart pasif yapılamaz: önce stoğu fire,
                kullanım veya sayımla sıfırlayın.
              </p>
            ) : (
              <p>Kart yeniden kullanıma açılır. Barkodu başka bir aktif kartta kayıtlıysa etkinleştirme reddedilir.</p>
            )}
            <StockErrorBox error={activeError} onReload={() => void load()} />
          </div>
        </StockModal>
      )}
    </StockShell>
  );
}
