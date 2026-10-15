"use client";

// Requests (spec p8_purchasing §12.6): room requests (default tab) and the Phase 7 product definition requests,
// moved unchanged into ProductRequestsPanel. Before migration 0025 only the product tab is shown (§11.4).

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { StockShell } from "@/components/stock/StockShell";
import { useWorkCounts } from "@/components/stock/purchasing/common";
import { ProductRequestsPanel } from "@/components/stock/purchasing/ProductRequestsPanel";
import { RoomRequestsPanel } from "@/components/stock/purchasing/RoomRequestsPanel";
import { Loading } from "@/components/stock/ui";

type Tab = "room" | "products";

export default function RequestsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Requests />
    </Suspense>
  );
}

function Requests() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { missing, known } = useWorkCounts();
  const requested: Tab = params.get("tab") === "products" ? "products" : "room";
  const tab: Tab = missing ? "products" : requested;
  // The room tab needs 0025: wait for the first stock_work_counts answer instead of rendering it and flipping away.
  const waiting = !known && requested === "room";

  const select = (t: Tab) => {
    const next = new URLSearchParams(params.toString());
    if (t === "room") next.delete("tab");
    else next.set("tab", t);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <StockShell title="Talepler" subtitle="Yeni ürün tanımları ve odalara malzeme talepleri.">
      <div className="flex gap-2 mb-4 border-b" role="tablist" aria-label="Talep türü">
        {(
          [
            ["room", "Oda talepleri"],
            ["products", "Ürün tanımlama talepleri"],
          ] as [Tab, string][]
        )
          .filter(([t]) => !((missing || !known) && t === "room"))
          .map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => select(t)}
              className={`px-3 min-h-[44px] text-sm -mb-px border-b-2 ${
                tab === t ? "border-blue-600 text-blue-700 font-semibold" : "border-transparent text-gray-700 hover:text-gray-900"
              }`}
            >
              {label}
            </button>
          ))}
      </div>
      {waiting ? <Loading /> : tab === "room" ? <RoomRequestsPanel /> : <ProductRequestsPanel />}
    </StockShell>
  );
}
