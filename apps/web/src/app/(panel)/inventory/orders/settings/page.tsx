"use client";

// Purchasing settings (spec p8_purchasing §12.8). Readable by every staff member; the server decides who may change
// which setting (owner: approval rule; finance holders: payable link).

import Link from "next/link";
import { StockShell } from "@/components/stock/StockShell";
import { PurchasingSettings } from "@/components/stock/purchasing/PurchasingSettings";

export default function PurchasingSettingsPage() {
  return (
    <StockShell
      title="Satın alma ayarları"
      subtitle={
        <Link href="/inventory/orders" className="text-blue-700 hover:underline">
          ← Siparişler
        </Link>
      }
    >
      <div className="max-w-3xl">
        <PurchasingSettings />
      </div>
    </StockShell>
  );
}
