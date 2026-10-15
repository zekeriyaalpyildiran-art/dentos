"use client";

// Order builder (spec p8_purchasing §12.4). `?edit=<orderId>` edits a pending order with the same form.

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { UUID_RE } from "@/lib/finance";
import { StockShell } from "@/components/stock/StockShell";
import { PoBuilder } from "@/components/stock/purchasing/PoForm";
import { Loading } from "@/components/stock/ui";

export default function NewOrderPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NewOrder />
    </Suspense>
  );
}

function NewOrder() {
  const params = useSearchParams();
  const raw = params.get("edit");
  const editId = raw && UUID_RE.test(raw) ? raw : null;
  return (
    <StockShell
      title={editId ? "Siparişi düzenle" : "Yeni sipariş"}
      subtitle={
        editId
          ? "Yalnızca onay bekleyen sipariş değiştirilebilir."
          : "Önerilerden veya ürün listesinden sipariş hazırlayın; sipariş onaya gönderilir."
      }
    >
      <PoBuilder key={editId ?? "new"} editId={editId} />
    </StockShell>
  );
}
