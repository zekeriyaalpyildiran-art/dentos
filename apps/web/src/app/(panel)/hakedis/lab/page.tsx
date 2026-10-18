"use client";

import { Suspense } from "react";
import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisLabView } from "@/components/finance/HakedisLabView";
import { Loading } from "@/components/finance/ui";

/** Hakediş ve maaş · Lab özeti: the month's lab costs per doctor and lab, and the totals per lab (0032), read-only. */
export default function HakedisPrepLabPage() {
  return (
    <HakedisPrepFrame title="Lab özeti">
      <Suspense fallback={<Loading />}>
        <HakedisLabView mode="prep" />
      </Suspense>
    </HakedisPrepFrame>
  );
}
