"use client";

import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisGroupsView } from "@/components/finance/HakedisMacroParts";

/** Hakediş ve maaş · İşlem grupları: procedure groups and the Macro doctor mapping (0033). */
export default function HakedisPrepGroupsPage() {
  return (
    <HakedisPrepFrame title="İşlem grupları ve Macro hekimleri">
      <HakedisGroupsView mode="prep" />
    </HakedisPrepFrame>
  );
}
