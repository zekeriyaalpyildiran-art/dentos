"use client";

import { Suspense } from "react";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisLinesView } from "@/components/finance/HakedisLinesView";
import { Loading } from "@/components/finance/ui";

/** Finans → Hakediş · Satırlar ve hastalar: revenue lines, implants, lab costs and patient marks of the month. */
export default function FinanceHakedisLinesPage() {
  return (
    <FinanceShell title="Hakediş satırları">
      <Suspense fallback={<Loading />}>
        <HakedisLinesView mode="finance" />
      </Suspense>
    </FinanceShell>
  );
}
