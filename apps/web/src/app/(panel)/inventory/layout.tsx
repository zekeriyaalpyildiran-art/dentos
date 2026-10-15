import type { ReactNode } from "react";
import { StockProvider } from "@/components/stock/StockContext";

/** Every /inventory page shares one dashboard read, the change counter and the quick movement sheet. */
export default function InventoryLayout({ children }: { children: ReactNode }) {
  return <StockProvider>{children}</StockProvider>;
}
