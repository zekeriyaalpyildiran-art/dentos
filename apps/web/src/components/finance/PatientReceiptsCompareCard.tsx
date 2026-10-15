"use client";

// /finance: DentOS patient payments vs the ledger's patient receipts for one month (spec p5 §6.5). Read-only:
// DentOS payments never reach the ledger (owner decision 1); there is deliberately no button that writes anything.

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDay, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  CURRENCY_LABELS,
  finPatientReceiptsCompare,
  formatMoney,
  type ReceiptsCompareJson,
} from "@/lib/payments";
import { Card, ErrorBox, Loading, MoneyRow } from "./ui";

export function PatientReceiptsCompareCard({ month }: { month: string | null }) {
  const [data, setData] = useState<ReceiptsCompareJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    finPatientReceiptsCompare(month)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(toFinanceError(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const t = data?.totals;
  const flagged = (data?.days ?? []).filter((d) => d.flag).slice(0, 31);
  const foreign = (t?.dentos_by_currency ?? []).filter((c) => c.currency !== "TRY");

  return (
    <Card title="DentOS hasta ödemeleri ve defter (bilgi)">
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        t && (
          <>
            <MoneyRow
              label="DentOS tahsilatı (TL karşılığı)"
              hint={`${t.dentos_count.toLocaleString("tr-TR")} ödeme · ödeme tarihine göre, iptal edilenler hariç`}
              cents={t.dentos_try_cents}
            />
            {foreign.length > 0 && (
              <div className="py-2 border-b text-sm text-gray-700">
                <div className="mb-1">Dövizli tahsilat (kendi para biriminde)</div>
                {foreign.map((c) => (
                  <div key={c.currency} className="flex justify-between gap-4 text-gray-600">
                    <span>{CURRENCY_LABELS[c.currency] ?? c.currency}</span>
                    <span className="tabular-nums">{formatMoney(c.amount_cents, c.currency)}</span>
                  </div>
                ))}
              </div>
            )}
            <MoneyRow label="Defterdeki hasta tahsilatı" cents={t.ledger_cents} />
            <MoneyRow label="Fark (defter − DentOS)" cents={t.diff_cents} strong />

            <h3 className="font-semibold mt-4 mb-2 text-sm">Farklı günler (&gt; 1 TL)</h3>
            {flagged.length === 0 ? (
              <p className="text-sm text-gray-500">Bu ay 1 TL&apos;den fazla farklı gün yok.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-left">
                    <tr>
                      <th className="px-3 py-2">Gün</th>
                      <th className="px-3 py-2 text-right">DentOS</th>
                      <th className="px-3 py-2 text-right">Defter</th>
                      <th className="px-3 py-2 text-right">Fark</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flagged.map((d) => (
                      <tr key={d.day} className="border-b bg-amber-50">
                        <td className="px-3 py-2 whitespace-nowrap">{formatDay(d.day)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(d.dentos_try_cents, "TRY")}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(d.ledger_cents, "TRY")}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(d.diff_cents, "TRY")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-xs text-gray-500 mt-3">
              Bilgi amaçlıdır. DentOS ödemeleri deftere aktarılmaz; defterdeki hasta tahsilatı yalnızca dosyadan aktarım
              veya elle kayıtla değişir.
            </p>
            <Link href="/finance/offers" className="inline-block mt-2 text-sm text-blue-600 hover:underline">
              Teklifler ve tahsilat →
            </Link>
          </>
        )
      )}
    </Card>
  );
}
