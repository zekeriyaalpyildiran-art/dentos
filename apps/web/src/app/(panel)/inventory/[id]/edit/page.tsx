import { redirect } from "next/navigation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Old route (direct stock_items update) replaced by the Phase 7 card form; ids are the same uuids. */
export default function OldEditInventoryItemPage({ params }: { params: { id: string } }) {
  redirect(UUID_RE.test(params.id) ? `/inventory/items/${params.id}/edit` : "/inventory/items");
}
