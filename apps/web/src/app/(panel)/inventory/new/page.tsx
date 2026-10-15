import { redirect } from "next/navigation";

/** Old route (direct stock_items insert) replaced by the Phase 7 card form. */
export default function OldNewInventoryItemPage() {
  redirect("/inventory/items/new");
}
