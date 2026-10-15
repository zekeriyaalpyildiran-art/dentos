"use client";

import { FinanceShell } from "@/components/finance/FinanceShell";
import { ImportHistory } from "@/components/finance/import/ImportHistory";
import { ImportNav } from "@/components/finance/import/ImportNav";

export default function FinanceImportHistoryPage() {
  return (
    <FinanceShell title="Aktarım geçmişi">
      <ImportNav />
      <ImportHistory />
    </FinanceShell>
  );
}
