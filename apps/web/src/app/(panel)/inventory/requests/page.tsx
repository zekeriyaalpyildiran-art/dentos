"use client";

// Product definition requests from unknown barcodes (spec p7_rules_ui §20.11, contract §4.10-4.11, §5.9).
// A request never changes stock; a manager defines a card, links an existing card or rejects it.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PRODUCT_REQUEST_STATUS_LABELS,
  PRODUCT_REQUEST_STATUS_STYLES,
  type ProductRequestStatus,
} from "@/lib/stock/codes";
import {
  newKey,
  stockDefineItem,
  stockProductRequestList,
  toStockError,
  type LevelRow,
  type ProductRequestJson,
  type StockError,
} from "@/lib/stock/rpc";
import { formatDay, formatTimestamp } from "@/lib/finance";
import { ItemPicker } from "@/components/stock/ItemPicker";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  Pager,
  StockErrorBox,
  StockModal,
  bigPrimary,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  stockInput,
} from "@/components/stock/ui";

const PAGE = 30;
type Tab = ProductRequestStatus | "all";
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "Tümü" },
  { value: "pending", label: "Bekleyen" },
  { value: "resolved", label: "Tanımlanan" },
  { value: "rejected", label: "Tanımlanmayacak" },
];

export default function ProductRequestsPage() {
  const { gates, tick, notifyChanged, openSheet } = useStock();
  const [tab, setTab] = useState<Tab>("all");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<ProductRequestJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<StockError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ProductRequestJson | null>(null);
  const [linking, setLinking] = useState<ProductRequestJson | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await stockProductRequestList(tab, { offset, limit: PAGE });
      setRows(r.rows || []);
      setTotal(r.total ?? 0);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(toStockError(e));
    }
  }, [tab, offset]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  return (
    <StockShell
      title="Tanımlama talepleri"
      subtitle="Listede olmayan barkodlar için bırakılan talepler. Talep stoğu değiştirmez."
    >
      <div className="flex flex-wrap gap-2 mb-4" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => {
              setTab(t.value);
              setOffset(0);
            }}
            className={`px-3 min-h-[40px] rounded text-sm ${tab === t.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {message && (
        <div className="mb-4">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      <StockErrorBox error={error} onReload={() => void load()} />
      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState>{tab === "pending" || tab === "all" ? "Bekleyen tanımlama talebi yok." : "Kayıt yok."}</EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-sm font-mono text-gray-700">{r.gtin}</p>
                  {r.note && <p className="text-sm text-gray-700">{r.note}</p>}
                  {(r.lot_number || r.serial_number || r.expiry_date) && (
                    <p className="text-xs text-gray-600">
                      Okutulan: {r.lot_number ? `Lot ${r.lot_number}` : ""}
                      {r.serial_number ? ` · Seri ${r.serial_number}` : ""}
                      {r.expiry_date ? ` · SKT ${formatDay(r.expiry_date)}` : ""}
                    </p>
                  )}
                  <p className="text-xs text-gray-500">
                    {r.requested_by_name ?? "Kullanıcı"} · {formatTimestamp(r.created_at)}
                  </p>
                  {r.status === "resolved" && r.stock_item_id && (
                    <p className="text-sm">
                      Kart:{" "}
                      <Link href={`/inventory/items/${r.stock_item_id}`} className="text-blue-700 hover:underline">
                        {r.item_name ?? "Stok kartı"}
                      </Link>
                    </p>
                  )}
                  {r.resolution_note && <p className="text-xs text-gray-600">Not: {r.resolution_note}</p>}
                </div>
                <Badge className={PRODUCT_REQUEST_STATUS_STYLES[r.status]}>{PRODUCT_REQUEST_STATUS_LABELS[r.status]}</Badge>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {gates.mgr && r.status === "pending" && (
                  <>
                    <Link href={`/inventory/items/new?request=${r.id}`} className={`${buttonPrimary} min-h-[44px] flex items-center`}>
                      Ürünü tanımla
                    </Link>
                    <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => setLinking(r)}>
                      Mevcut karta bağla
                    </button>
                    <button type="button" className={`${buttonDanger} min-h-[44px]`} onClick={() => setRejecting(r)}>
                      Tanımlanmayacak
                    </button>
                  </>
                )}
                {gates.op && r.status === "resolved" && r.stock_item_id && (
                  <button
                    type="button"
                    className={`${buttonPrimary} min-h-[44px]`}
                    onClick={() =>
                      openSheet({
                        type: "receive",
                        itemId: r.stock_item_id!,
                        scan: {
                          gtin: r.gtin,
                          lot: r.lot_number || undefined,
                          serial: r.serial_number || undefined,
                          expiry: r.expiry_date || undefined,
                        },
                      })
                    }
                  >
                    Malzeme geldi işlemini aç
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />

      {rejecting && (
        <RequestActionDialog
          title="Tanımlanmayacak"
          request={rejecting}
          action="reject"
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            setMessage("Talep kapatıldı.");
            notifyChanged();
          }}
        />
      )}
      {linking && (
        <RequestActionDialog
          title="Mevcut karta bağla"
          request={linking}
          action="link"
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            setMessage("Barkod karta bağlandı ve talep kapandı.");
            notifyChanged();
          }}
        />
      )}
    </StockShell>
  );
}

function RequestActionDialog({
  title,
  request,
  action,
  onClose,
  onDone,
}: {
  title: string;
  request: ProductRequestJson;
  action: "reject" | "link";
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [item, setItem] = useState<LevelRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StockError | null>(null);
  const opKey = useRef(newKey());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await stockDefineItem({
        p_operation_key: opKey.current,
        p_request_id: request.id,
        p_action: action,
        p_item_id: action === "link" ? item?.id ?? null : null,
        p_item: null,
        p_note: note.trim() || null,
      });
      onDone();
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || (action === "reject" ? !note.trim() : !item);
  return (
    <StockModal
      title={title}
      description={`${request.name} · ${request.gtin}`}
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={bigPrimary} disabled={disabled} onClick={() => void submit()}>
          {busy ? "Kaydediliyor..." : action === "reject" ? "Talebi kapat" : "Barkodu bu karta bağla"}
        </button>
      }
    >
      <div className="space-y-3">
        {action === "link" &&
          (item ? (
            <div className="p-3 rounded border bg-gray-50 flex justify-between items-center gap-2">
              <span>
                {item.item_name}
                {item.gtin && <span className="block text-xs text-amber-700">Bu kartın barkodu var: {item.gtin}</span>}
              </span>
              <button type="button" className="text-sm text-blue-700 hover:underline min-h-[44px]" onClick={() => setItem(null)}>
                Değiştir
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-700">Barkodu olmayan bir kartı seçin; talepteki barkod karta yazılır.</p>
              <ItemPicker onPick={setItem} autoFocus />
            </>
          ))}
        <Field label={action === "reject" ? "Not *" : "Not"}>
          <textarea className={stockInput} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <StockErrorBox error={error} />
      </div>
    </StockModal>
  );
}
