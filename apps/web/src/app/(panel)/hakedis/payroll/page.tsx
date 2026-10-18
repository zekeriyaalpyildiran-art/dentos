"use client";

import { Suspense } from "react";
import { HakedisPrepFrame } from "@/components/finance/HakedisParts";
import { HakedisPayrollView } from "@/components/finance/HakedisPayrollView";
import { Loading } from "@/components/finance/ui";

/** Hakediş ve maaş · Maaş ve prim: salaries (read-only) and the month's bonus / other rows (open months). */
export default function HakedisPrepPayrollPage() {
  return (
    <HakedisPrepFrame title="Maaş ve prim">
      <Suspense fallback={<Loading />}>
        <HakedisPayrollView mode="prep" />
      </Suspense>
    </HakedisPrepFrame>
  );
}
