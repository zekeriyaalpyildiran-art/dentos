"use client";

import { FinanceShell } from "@/components/finance/FinanceShell";
import { ImportNav } from "@/components/finance/import/ImportNav";
import { RulesEditor } from "@/components/finance/import/RulesEditor";

export default function FinanceImportRulesPage() {
  return (
    <FinanceShell title="Sınıflandırma kuralları">
      <ImportNav />
      <RulesEditor />
    </FinanceShell>
  );
}
