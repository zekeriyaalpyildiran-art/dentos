"use client";

import { Suspense } from "react";
import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisMonthView } from "@/components/finance/HakedisMonthView";
import { Loading } from "@/components/finance/ui";

/** Hakediş ve maaş · Ay özeti: every payee's month, read-only (the month is closed in Finans → Hakediş). */
export default function HakedisPrepPage() {
  return (
    <HakedisPrepFrame title="Hakediş ve maaş">
      <Suspense fallback={<Loading />}>
        <HakedisMonthView mode="prep" />
      </Suspense>
    </HakedisPrepFrame>
  );
}
