"use client";

// Lab status and payable chips (spec p9_clinical §7.6): "Gecikti · " prefix when late (CW:39), revision count.

import type { LabOrderJson } from "@/lib/clinical/rpc";
import { LAB_STATUS_LABELS, LAB_STATUS_STYLES } from "@/lib/clinical/codes";
import { Badge } from "./ui";

export function LabStatusBadge({ order }: { order: LabOrderJson }) {
  const label = LAB_STATUS_LABELS[order.status] ?? order.status;
  return (
    <Badge className={order.is_late ? "bg-red-100 text-red-800" : LAB_STATUS_STYLES[order.status]}>
      {order.is_late ? `Gecikti · ${label}` : label}
      {order.revision_count > 0 ? ` · ${order.revision_count}. revizyon` : ""}
    </Badge>
  );
}

export function PayableChip({ order }: { order: LabOrderJson }) {
  if (!order.cost) return null;
  if (order.cost.payable_state === "posted") return <Badge className="bg-green-100 text-green-800">Finansa işlendi</Badge>;
  if (order.cost.payable_state === "awaiting_finance") return <Badge className="bg-amber-100 text-amber-800">Finans bekliyor</Badge>;
  return null;
}
