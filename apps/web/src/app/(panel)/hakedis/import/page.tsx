"use client";

import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisImportView } from "@/components/finance/HakedisImportView";

/** Hakediş ve maaş · Macro yükleme: the Macro treatments / payments reports of a day range (0033). */
export default function HakedisPrepImportPage() {
  return (
    <HakedisPrepFrame title="Macro yükleme">
      <HakedisImportView mode="prep" />
    </HakedisPrepFrame>
  );
}
