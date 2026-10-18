"use client";

import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisRulesView } from "@/components/finance/HakedisRulesView";

/** Finans → Hakediş · Kurallar: rates, implant amounts, fixed monthly salaries and the child age limit. */
export default function FinanceHakedisRulesPage() {
  return (
    <FinanceShell title="Hakediş kuralları">
      <HakedisRulesView mode="finance" />
    </FinanceShell>
  );
}
