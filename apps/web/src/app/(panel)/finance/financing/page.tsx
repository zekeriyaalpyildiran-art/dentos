"use client";

import { useState } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { useReferenceData } from "@/components/finance/useReferenceData";
import { ErrorBox, Loading, SuccessBox } from "@/components/finance/ui";
import { FinancingList } from "@/components/finance/import/FinancingList";
import { FinancingSettingsCard } from "@/components/finance/import/FinancingSettingsCard";
import { FinancingSummaryCard } from "@/components/finance/import/FinancingSummaryCard";
import { FinancingUpload } from "@/components/finance/import/FinancingUpload";
import { useImportSetup } from "@/components/finance/import/useImportSetup";

export default function FinanceFinancingPage() {
  return (
    <FinanceShell title="Hasta finansmanı">
      <Financing />
    </FinanceShell>
  );
}

function Financing() {
  const canWrite = useCanWriteFinance();
  const setup = useImportSetup();
  const ref = useReferenceData();
  const [refreshKey, setRefreshKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  if (!setup.data || !ref.data) {
    return setup.loading || ref.loading ? <Loading /> : <ErrorBox error={setup.error ?? ref.error} />;
  }

  const changed = (text: string) => {
    setMessage(text);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-700">
        Hasta kredisiyle (finansman) gelen ödemelerde brüt tutar klinik Excel’indeki günlük tahsilatın içindedir. Bu
        bölümde yalnızca bankanın kesintileri gider olarak kaydedilir ve bloke takibi yapılır.{" "}
        <strong>Blokeli tutarlar kullanılabilir banka bakiyesine eklenmez.</strong> Bloke tarihi dolunca otomatik
        çözülmüş sayılmaz; bankadan kontrol edip doğrulayın.
      </p>
      <SuccessBox text={message} />
      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <FinancingSummaryCard key={`s${refreshKey}`} month={null} />
        <FinancingSettingsCard setup={setup.data} refData={ref.data} canWrite={canWrite} onSaved={() => setup.reload()} />
      </div>
      {canWrite && <FinancingUpload setup={setup.data} onSaved={changed} />}
      <FinancingList canWrite={canWrite} refreshKey={refreshKey} onChanged={changed} />
    </div>
  );
}
