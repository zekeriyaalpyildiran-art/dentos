"use client";

import { FinanceShell } from "@/components/finance/FinanceShell";
import { ImportNav } from "@/components/finance/import/ImportNav";
import { LayoutsEditor } from "@/components/finance/import/LayoutsEditor";

export default function FinanceImportLayoutsPage() {
  return (
    <FinanceShell title="Sütun eşleştirmeleri ve hesap anahtarları">
      <ImportNav />
      <LayoutsEditor />
    </FinanceShell>
  );
}
