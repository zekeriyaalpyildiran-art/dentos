"use client";

import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisRulesView } from "@/components/finance/HakedisRulesView";

/** Hakediş ve maaş · Kurallar, read-only (the owner edits them in Finans → Hakediş → Kurallar). */
export default function HakedisPrepRulesPage() {
  return (
    <HakedisPrepFrame title="Hakediş kuralları">
      <HakedisRulesView mode="prep" />
    </HakedisPrepFrame>
  );
}
