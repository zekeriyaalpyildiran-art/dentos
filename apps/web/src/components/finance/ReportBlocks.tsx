"use client";

import Link from "next/link";
import { Card } from "@/components/finance/ui";
import {
  BUCKET_LABELS,
  DIRECTION_LABELS,
  formatMonth,
  formatTL,
  type CategoryReportRow,
} from "@/lib/finance";

/** One of the three monthly result figures (label, amount, explanation). */
export function ResultFigure({ label, cents, explain }: { label: string; cents: number; explain: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-gray-600">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${cents < 0 ? "text-red-600" : "text-gray-900"}`}>
        {formatTL(cents)}
      </div>
      <div className="text-xs text-gray-500 mt-1">{explain}</div>
    </div>
  );
}

/** Category report (p3 §5.10): month flows per category plus open amounts, straight from fin_dashboard. */
export function CategoryReportCard({ month, rows }: { month: string; rows: CategoryReportRow[] }) {
  return (
    <Card title={`Kategori raporu · ${formatMonth(month)}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b">
            <tr className="text-left text-gray-800">
              <th className="px-3 py-2 font-semibold">Kategori</th>
              <th className="px-3 py-2 font-semibold">Yön</th>
              <th className="px-3 py-2 font-semibold text-right">Kayıt</th>
              <th className="px-3 py-2 font-semibold text-right">Ay içi giriş</th>
              <th className="px-3 py-2 font-semibold text-right">Ay içi çıkış</th>
              <th className="px-3 py-2 font-semibold text-right">Açık alacak</th>
              <th className="px-3 py-2 font-semibold text-right">Açık borç</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category_id} className="border-b">
                <td className="px-3 py-2">
                  <Link href={`/finance/entries?category_id=${r.category_id}`} className="hover:underline">
                    {r.name}
                  </Link>
                  {!r.is_active && <span className="text-xs text-gray-500"> (pasif)</span>}
                  <div className="text-xs text-gray-500">{BUCKET_LABELS[r.report_bucket]}</div>
                </td>
                <td className="px-3 py-2 text-gray-600">{DIRECTION_LABELS[r.direction]}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.incoming_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.outgoing_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.open_incoming_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatTL(r.open_outgoing_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Giriş ve çıkış sütunları yalnızca seçilen ayın ödemeleridir; kayıt sayısı ve açık tutarlar ay
        seçiminden bağımsızdır.
      </p>
    </Card>
  );
}
