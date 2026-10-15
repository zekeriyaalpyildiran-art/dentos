"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, MoneyRow } from "@/components/finance/ui";
import {
  finFinancingSummary,
  formatMonth,
  toFinanceError,
  type FinanceError,
  type FinancingSummaryJson,
} from "@/lib/finance";

/**
 * Patient-financing card (legacy burganSummary, BF:32-35; BG:14-15). The gross is already inside the clinic
 * receipts and the fees inside the expenses; the blocked net is never added to liquidity.
 * Renders nothing until the Phase 4 RPC answers (e.g. before the migration is applied).
 */
export function FinancingSummaryCard({ month, compact }: { month: string | null; compact?: boolean }) {
  const [data, setData] = useState<FinancingSummaryJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);

  useEffect(() => {
    let alive = true;
    finFinancingSummary(month)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((err) => alive && setError(toFinanceError(err)));
    return () => {
      alive = false;
    };
  }, [month]);

  if (!data) {
    if (error && !compact) return <p className="text-sm text-red-600">{error.message}</p>;
    return null;
  }
  if (compact && data.monthly_count === 0 && data.blocked_count === 0 && data.needs_check_count === 0) return null;

  return (
    <Card title={`Hasta finansmanı · ${formatMonth(data.month)}`}>
      <MoneyRow label="Finansmanla gelen brüt tahsilat" hint="Klinik Excel tahsilatlarının içinde" cents={data.gross_cents} />
      <MoneyRow label="Finansman kesintileri" hint="Giderlerin içinde (faiz / banka masrafı)" cents={data.fee_cents} />
      <MoneyRow
        label="Blokede bekleyen net"
        hint={`${data.blocked_count} finansman · tüm dönemler · kullanılabilir bakiyeye eklenmez`}
        cents={data.blocked_net_cents}
        strong
      />
      {data.needs_check_count > 0 && (
        <p className="text-sm text-amber-700 mt-2">
          {data.needs_check_count} finansmanın tahmini çözülme tarihi geçti: bankadan kontrol gerekli.
        </p>
      )}
      <p className="text-xs text-gray-500 mt-2">
        {data.monthly_count} finansman bu ay.{" "}
        <Link href="/finance/financing" className="text-blue-600 hover:underline">
          Hasta finansmanı
        </Link>
      </p>
    </Card>
  );
}
