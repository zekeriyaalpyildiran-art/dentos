"use client";

// Purchase order list (spec p8_purchasing §12.3, §6.1). Managers and cost viewers read it; totals only for cost
// viewers (absent keys are never shown as 0). Filters live in the address bar (?status=&supplier=&q=).

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { canReadPurchasing, PO_STATUSES, type PoStatus } from "@/lib/stock/purchasing";
import {
  stockPoList,
  stockPoTransition,
  toStockError,
  type PoFilters,
  type PoListRow,
  type StockError,
} from "@/lib/stock/rpc";
import { UUID_RE } from "@/lib/finance";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { useStockSuppliers } from "@/components/stock/useStockRefs";
import {
  ConfirmDialog,
  PoStatusBadge,
  PurchasingErrorBox,
  useActionKeys,
} from "@/components/stock/purchasing/common";
import {
  Card,
  EmptyState,
  Loading,
  Notice,
  Pager,
  Toast,
  buttonPrimary,
  buttonSecondary,
  formatDay,
  formatTL,
  formatTimestamp,
  stockInput,
} from "@/components/stock/ui";

const PAGE = 50;

type Chip = "open" | PoStatus | "all" | "overdue";
const CHIPS: { value: Chip; label: string }[] = [
  { value: "open", label: "Açık" },
  { value: "pending", label: "Onay bekliyor" },
  { value: "approved", label: "Onaylandı" },
  { value: "ordered", label: "Sipariş verildi" },
  { value: "partially_received", label: "Kısmi teslim" },
  { value: "received", label: "Teslim alındı" },
  { value: "cancelled", label: "İptal" },
  { value: "all", label: "Tümü" },
  { value: "overdue", label: "Gecikenler" },
];

function isChip(v: string | null): v is Chip {
  return !!v && CHIPS.some((c) => c.value === v);
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Orders />
    </Suspense>
  );
}

function Orders() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { gates, tick, notifyChanged } = useStock();
  const { suppliers } = useStockSuppliers();
  const actionKey = useActionKeys();

  const chipParam = params.get("status");
  const chip: Chip = isChip(chipParam) ? chipParam : "open";
  const supplierParam = params.get("supplier") ?? "";
  const supplier = UUID_RE.test(supplierParam) ? supplierParam : "";
  const qParam = params.get("q") ?? "";

  const [search, setSearch] = useState(qParam);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<PoListRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Partial<Record<PoStatus | "overdue", number>>>({});
  const [error, setError] = useState<StockError | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<StockError | null>(null);
  const [confirmOrder, setConfirmOrder] = useState<PoListRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
      setOffset(0);
    },
    [params, router, pathname]
  );

  // Debounced search into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== qParam) setParam("q", search.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [search, qParam, setParam]);

  const filters = useMemo<PoFilters>(() => {
    const f: PoFilters = { supplier_id: supplier || undefined, q: qParam || undefined };
    if (chip === "overdue") f.overdue = true;
    else f.status = chip;
    return f;
  }, [chip, supplier, qParam]);

  const load = useCallback(async () => {
    try {
      const r = await stockPoList(filters, { offset, limit: PAGE });
      setRows(r.rows || []);
      setTotal(r.total ?? 0);
      setCounts(r.counts || {});
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [filters, offset]);

  const canRead = canReadPurchasing(gates);
  useEffect(() => {
    if (canRead) void load();
  }, [load, tick, canRead]);

  async function transition(row: PoListRow, action: "approve" | "mark_ordered") {
    setBusyId(row.id);
    try {
      await stockPoTransition({
        p_operation_key: actionKey(`${row.id}:${action}:${row.version}`),
        p_order_id: row.id,
        p_version: row.version,
        p_action: action,
      });
      setToast(action === "approve" ? `Sipariş ${row.order_number} onaylandı.` : `Sipariş ${row.order_number} sipariş verildi olarak işaretlendi.`);
      notifyChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (!canRead) {
    return (
      <StockShell title="Siparişler">
        <Notice tone="warn">Satın alma kayıtlarını görme yetkiniz yok.</Notice>
      </StockShell>
    );
  }

  const openCount =
    (counts.pending ?? 0) + (counts.approved ?? 0) + (counts.ordered ?? 0) + (counts.partially_received ?? 0);
  const chipCount = (c: Chip): number | null => {
    if (c === "open") return openCount;
    if (c === "all") return PO_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);
    return counts[c] ?? 0;
  };

  return (
    <StockShell
      title="Siparişler"
      subtitle="Sipariş verildi etiketi tedarikçiye mesaj göndermez. Siparişe bağlı mal kabul yapıldıkça teslim miktarı güncellenir."
      actions={
        <>
          <Link href="/inventory/orders/settings" className={`${buttonSecondary} min-h-[44px] flex items-center`}>
            Satın alma ayarları
          </Link>
          {gates.mgr && (
            <Link href="/inventory/orders/new" className={`${buttonPrimary} min-h-[44px] flex items-center`}>
              Yeni sipariş
            </Link>
          )}
        </>
      }
    >
      <div className="flex flex-wrap gap-2 mb-3" role="tablist" aria-label="Sipariş durumu">
        {CHIPS.map((c) => {
          const n = chipCount(c.value);
          const active = chip === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setParam("status", c.value === "open" ? "" : c.value)}
              className={`px-3 min-h-[40px] rounded text-sm ${
                active ? "bg-blue-600 text-white" : c.value === "overdue" && n ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-800"
              }`}
            >
              {c.label}
              {n !== null && <span className="ml-1 tabular-nums opacity-80">({n})</span>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          className={`${stockInput} sm:max-w-xs`}
          placeholder="Sipariş no, tedarikçi veya ürün"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Sipariş ara"
        />
        <select
          className={`${stockInput} sm:max-w-xs`}
          value={supplier}
          onChange={(e) => setParam("supplier", e.target.value)}
          aria-label="Tedarikçi"
        >
          <option value="">Tüm tedarikçiler</option>
          {(suppliers || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.is_active ? "" : " (pasif)"}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-3 mb-3">
        <PurchasingErrorBox error={error} onReload={() => void load()} />
        <PurchasingErrorBox error={actionError} onReload={() => void load()} />
      </div>

      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          {chip === "open" && !qParam && !supplier ? (
            <div className="text-center py-6 space-y-3">
              <p className="text-gray-700">Henüz sipariş yok.</p>
              <p className="text-sm text-gray-500">Kritik ürünler için sipariş listesi hazırlayın.</p>
              {gates.mgr && (
                <Link href="/inventory/orders/new" className={`${buttonPrimary} inline-flex items-center min-h-[44px]`}>
                  Yeni sipariş
                </Link>
              )}
            </div>
          ) : (
            <EmptyState>Bu filtrede sipariş yok.</EmptyState>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id} className="!p-4 sm:!p-5">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/inventory/orders/${r.id}`} className="font-semibold text-blue-700 hover:underline">
                      {r.order_number}
                    </Link>
                    <PoStatusBadge status={r.status} closedShort={r.closed_short} />
                    {r.overdue && <span className="text-xs font-semibold text-red-700">Gecikti</span>}
                  </div>
                  <p className="text-sm text-gray-900">{r.supplier_name ?? "Tedarikçi"}</p>
                  <p className="text-sm text-gray-700 break-words">{r.summary}</p>
                  <p className="text-xs text-gray-500">
                    {r.expected_date && (
                      <span className={r.overdue ? "text-red-700 font-medium" : ""}>Beklenen {formatDay(r.expected_date)} · </span>
                    )}
                    {r.created_by_name ?? "Kullanıcı"} · {formatTimestamp(r.created_at)} · {r.lines_complete} / {r.line_count}{" "}
                    satır tamam
                  </p>
                  {typeof r.total_cents === "number" && (
                    <p className="text-sm">
                      Sipariş toplamı <span className="font-semibold tabular-nums">{formatTL(r.total_cents)}</span>
                      {typeof r.unpriced_lines === "number" && r.unpriced_lines > 0 && (
                        <span className="text-amber-700"> · {r.unpriced_lines} satır fiyatsız</span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end shrink-0">
                  {r.actions.can_approve && (
                    <button
                      type="button"
                      className={`${buttonPrimary} min-h-[44px]`}
                      disabled={busyId === r.id}
                      onClick={() => {
                        setActionError(null);
                        transition(r, "approve").catch((e) => setActionError(toStockError(e)));
                      }}
                    >
                      Onayla
                    </button>
                  )}
                  {!r.actions.can_approve && r.actions.approve_blocked === "self" && (
                    <span className="text-xs text-gray-600 max-w-[14rem]">Bu siparişi başka bir stok yetkilisi onaylamalı.</span>
                  )}
                  {r.actions.can_mark_ordered && (
                    <button
                      type="button"
                      className={`${buttonSecondary} min-h-[44px]`}
                      disabled={busyId === r.id}
                      onClick={() => setConfirmOrder(r)}
                    >
                      Sipariş verildi
                    </button>
                  )}
                  {r.actions.can_receive && (
                    <Link href={`/inventory/orders/${r.id}?receive=1`} className={`${buttonPrimary} min-h-[44px] flex items-center`}>
                      Mal kabul
                    </Link>
                  )}
                  <Link href={`/inventory/orders/${r.id}`} className={`${buttonSecondary} min-h-[44px] flex items-center`}>
                    Ayrıntı
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />

      {confirmOrder && (
        <ConfirmDialog
          title={`${confirmOrder.order_number} · Sipariş verildi`}
          text="Tedarikçiye mesaj gönderilmez; siparişi tedarikçiye siz iletin."
          confirmLabel="Sipariş verildi olarak işaretle"
          onClose={() => setConfirmOrder(null)}
          onConfirm={async () => {
            await transition(confirmOrder, "mark_ordered");
            setConfirmOrder(null);
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </StockShell>
  );
}

