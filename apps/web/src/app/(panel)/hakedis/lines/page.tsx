"use client";

import { Suspense } from "react";
import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisLinesView } from "@/components/finance/HakedisLinesView";
import { Loading } from "@/components/finance/ui";

/** Hakediş ve maaş · Satırlar ve hastalar: revenue lines, implants, lab costs and patient marks (open months). */
export default function HakedisPrepLinesPage() {
  return (
    <HakedisPrepFrame title="Hakediş satırları">
      <Suspense fallback={<Loading />}>
        <HakedisLinesView mode="prep" />
      </Suspense>
    </HakedisPrepFrame>
  );
}
