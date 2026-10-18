"use client";

import { Suspense } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisLabView } from "@/components/finance/HakedisLabView";
import { Loading } from "@/components/finance/ui";

/** Finans → Hakediş · Lab özeti: the month's lab costs per doctor and lab, and the totals per lab (0032). */
export default function FinanceHakedisLabPage() {
  return (
    <FinanceShell title="Lab özeti">
      <Suspense fallback={<Loading />}>
        <HakedisLabView mode="finance" />
      </Suspense>
    </FinanceShell>
  );
}
