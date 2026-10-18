"use client";

import { Suspense } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisPayrollView } from "@/components/finance/HakedisPayrollView";
import { Loading } from "@/components/finance/ui";

/** Finans → Hakediş · Maaş ve prim: the month's fixed salaries and bonus / other rows (0031). */
export default function FinanceHakedisPayrollPage() {
  return (
    <FinanceShell title="Maaş ve prim">
      <Suspense fallback={<Loading />}>
        <HakedisPayrollView mode="finance" />
      </Suspense>
    </FinanceShell>
  );
}
