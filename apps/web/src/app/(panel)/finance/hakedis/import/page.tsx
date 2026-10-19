"use client";

import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisImportView } from "@/components/finance/HakedisImportView";

/** Finans → Hakediş · Macro yükleme: the Macro treatments / payments reports of a day range (0033). */
export default function FinanceHakedisImportPage() {
  return (
    <FinanceShell title="Macro yükleme">
      <HakedisImportView mode="finance" />
    </FinanceShell>
  );
}
