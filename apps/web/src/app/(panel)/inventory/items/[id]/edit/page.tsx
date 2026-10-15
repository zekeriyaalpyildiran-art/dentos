"use client";

// Edit a stock card (spec p7_rules_ui §20.4, contract §4.12). The version guards against a concurrent edit;
// "Yenile" reloads the card without remounting the form, so typed values are kept and the next save carries the
// fresh version.

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { UUID_RE } from "@/lib/finance";
import { stockItemDetail, toStockError, type ItemDetailJson, type StockError } from "@/lib/stock/rpc";
import { ItemForm } from "@/components/stock/ItemForm";
import { useStock } from "@/components/stock/StockContext";
import { StockShell } from "@/components/stock/StockShell";
import { Card, Loading, Notice, StockErrorBox } from "@/components/stock/ui";

export default function EditItemPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { gates, notifyChanged } = useStock();
  const id = params.id;
  const [detail, setDetail] = useState<ItemDetailJson | null>(null);
  const [error, setError] = useState<StockError | null>(null);

  const load = useCallback(async () => {
    if (!UUID_RE.test(id)) {
      setError(toStockError({ message: "Ürün bulunamadı.", code: "PT404" }));
      return;
    }
    try {
      setDetail(await stockItemDetail(id));
      setError(null);
    } catch (e) {
      setError(toStockError(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!gates.mgr) {
    return (
      <StockShell title="Stok kartını düzenle">
        <Notice tone="warn">Bu işlem için stok yönetim yetkisi gerekir.</Notice>
      </StockShell>
    );
  }

  return (
    <StockShell title="Stok kartını düzenle" subtitle={detail?.item.item_name}>
      <Card>
        <StockErrorBox error={error} />
        {!detail ? (
          !error && <Loading />
        ) : (
          <ItemForm
            item={detail.item}
            canViewCosts={detail.can_view_costs ?? gates.cost}
            onReload={() => void load()}
            onCancel={() => router.push(`/inventory/items/${id}`)}
            onSaved={() => {
              notifyChanged();
              router.push(`/inventory/items/${id}`);
            }}
          />
        )}
      </Card>
    </StockShell>
  );
}
