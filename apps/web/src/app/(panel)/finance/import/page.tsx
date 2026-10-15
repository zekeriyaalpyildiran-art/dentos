"use client";

import Link from "next/link";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { Card } from "@/components/finance/ui";
import { ImportNav } from "@/components/finance/import/ImportNav";
import { ImportWizard } from "@/components/finance/import/ImportWizard";

export default function FinanceImportPage() {
  return (
    <FinanceShell title="Dosyadan aktar">
      <ImportNav />
      <ImportContent />
    </FinanceShell>
  );
}

function ImportContent() {
  const canWrite = useCanWriteFinance();
  if (!canWrite) {
    return (
      <Card>
        <p className="text-sm text-gray-700">
          Dosyadan aktarım için finans yazma yetkisi gerekir. Önceki aktarımları{" "}
          <Link href="/finance/import/history" className="text-blue-600 hover:underline">
            aktarım geçmişinden
          </Link>{" "}
          inceleyebilirsiniz.
        </p>
      </Card>
    );
  }
  return <ImportWizard />;
}
