"use client";

// New stock card (spec p7_rules_ui §20.4). With ?request=<id> the card answers a product definition request
// (stock_define_item 'create'), and afterwards the receipt can be opened with the scanned lot / serial / expiry.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { UUID_RE } from "@/lib/finance";
import { stockProductRequestList, toStockError, type LevelRow, type ProductRequestJson, type StockError } from "@/lib/stock/rpc";
import { ItemForm } from "@/components/stock/ItemForm";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { Card, Loading, Notice, StockErrorBox, buttonPrimary, buttonSecondary } from "@/components/stock/ui";

export default function NewItemPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NewItem />
    </Suspense>
  );
}

function NewItem() {
  const params = useSearchParams();
  const router = useRouter();
  const { gates, notifyChanged, openSheet } = useStock();
  const requestId = params.get("request");
  const [request, setRequest] = useState<ProductRequestJson | null | undefined>(requestId ? undefined : null);
  const [error, setError] = useState<StockError | null>(null);
  const [saved, setSaved] = useState<{ item: LevelRow; request: ProductRequestJson | null } | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (!requestId) return;
    if (!UUID_RE.test(requestId)) {
      setRequest(null);
      return;
    }
    let cancelled = false;
    stockProductRequestList("pending", { offset: 0, limit: 200 })
      .then((r) => {
        if (!cancelled) setRequest((r.rows || []).find((x) => x.id === requestId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) {
          setRequest(null);
          setError(toStockError(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (!gates.mgr) {
    return (
      <StockShell title="Ürünü bir kez tanımlayın">
        <Notice tone="warn">Bu işlem için stok yönetim yetkisi gerekir.</Notice>
      </StockShell>
    );
  }

  return (
    <StockShell title="Ürünü bir kez tanımlayın" subtitle="Kartı bir kez tanımlayın; stok miktarı yalnız hareketlerle değişir.">
      <Card>
        <StockErrorBox error={error} />
        {saved ? (
          <div className="space-y-4">
            <div className="p-4 rounded bg-green-50 text-green-800 text-sm">
              {saved.item.item_name} kartı oluşturuldu{saved.request ? " ve tanımlama talebi kapandı" : ""}.
            </div>
            <div className="flex flex-wrap gap-2">
              {gates.op && (
                <button
                  type="button"
                  className={`${buttonPrimary} min-h-[44px]`}
                  onClick={() =>
                    openSheet({
                      type: "receive",
                      itemId: saved.item.id,
                      scan: saved.request
                        ? {
                            gtin: saved.request.gtin,
                            lot: saved.request.lot_number || undefined,
                            serial: saved.request.serial_number || undefined,
                            expiry: saved.request.expiry_date || undefined,
                          }
                        : undefined,
                    })
                  }
                >
                  Malzeme geldi işlemini aç
                </button>
              )}
              <Link href={`/inventory/items/${saved.item.id}`} className={`${buttonSecondary} min-h-[44px] flex items-center`}>
                Kartı görüntüle
              </Link>
              <button
                type="button"
                className={`${buttonSecondary} min-h-[44px]`}
                onClick={() => {
                  setSaved(null);
                  setFormKey((k) => k + 1);
                  if (requestId) router.replace("/inventory/items/new");
                }}
              >
                Başka ürün tanımla
              </button>
            </div>
          </div>
        ) : request === undefined ? (
          <Loading />
        ) : (
          <>
            {requestId && !request && (
              <div className="mb-4">
                <Notice tone="warn">Tanımlama talebi bulunamadı veya daha önce sonuçlandırılmış. Kartı normal olarak tanımlayabilirsiniz.</Notice>
              </div>
            )}
            <ItemForm
              key={formKey}
              request={request}
              canViewCosts={gates.cost}
              onCancel={() => router.push("/inventory/items")}
              onSaved={(item) => {
                notifyChanged();
                setSaved({ item, request: request ?? null });
              }}
            />
          </>
        )}
      </Card>
    </StockShell>
  );
}
