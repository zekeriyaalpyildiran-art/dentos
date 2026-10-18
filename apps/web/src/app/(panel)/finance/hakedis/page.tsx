"use client";

import { Suspense } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisMonthView } from "@/components/finance/HakedisMonthView";
import { Loading } from "@/components/finance/ui";

/** Finans → Hakediş · Ay özeti: every payee's month, the month close and (owner) reopen. */
export default function FinanceHakedisPage() {
  return (
    <FinanceShell title="Hakediş">
      <Suspense fallback={<Loading />}>
        <HakedisMonthView mode="finance" />
      </Suspense>
    </FinanceShell>
  );
}
