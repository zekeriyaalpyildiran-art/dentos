"use client";

import Link from "next/link";
import {
  BUCKET_LABELS,
  DIRECTION_LABELS,
  SUBCATEGORY_LABELS,
  formatDay,
  formatMonth,
  formatTL,
  type EntryJson,
} from "@/lib/finance";
import { StatusBadge } from "./ui";

/** Entries table shared by 'Ödeme ve tahsilatlar' and the plan tab (legacy FP:52). */
export function EntryTable({ rows, emptyText }: { rows: EntryJson[]; emptyText: string }) {
  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr className="text-left text-gray-800">
            <th className="px-4 py-3 font-semibold">Kişi / kurum</th>
            <th className="px-4 py-3 font-semibold">Kategori</th>
            <th className="px-4 py-3 font-semibold">Vade / tarih</th>
            <th className="px-4 py-3 font-semibold text-right">Tutar</th>
            <th className="px-4 py-3 font-semibold text-right">Gerçekleşen</th>
            <th className="px-4 py-3 font-semibold text-right">Kalan</th>
            <th className="px-4 py-3 font-semibold">Durum</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((e) => (
              <tr key={e.id} className={`border-b align-top ${e.status === "cancelled" ? "text-gray-500" : "text-gray-900"}`}>
                <td className="px-4 py-3">
                  <div className="font-medium">{e.counterparty_name}</div>
                  {e.description && <div className="text-xs text-gray-500 line-clamp-2">{e.description}</div>}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {e.entitlement_month && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                        Hakediş ayı: {formatMonth(e.entitlement_month)}
                      </span>
                    )}
                    {e.excluded_from_totals && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-orange-50 text-orange-700" title={e.exclusion_reason ?? ""}>
                        Toplam dışı
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div>{e.category_name}</div>
                  <div className="text-xs text-gray-500">
                    {e.subcategory ? SUBCATEGORY_LABELS[e.subcategory] : BUCKET_LABELS[e.report_bucket]}
                  </div>
                  <div className={`text-xs ${e.direction === "in" ? "text-green-700" : "text-red-600"}`}>
                    {DIRECTION_LABELS[e.direction]}
                  </div>
                </td>
                <td className={`px-4 py-3 whitespace-nowrap ${e.is_overdue ? "text-red-600 font-semibold" : ""}`}>
                  {formatDay(e.due_date)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatTL(e.amount_cents)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatTL(e.paid_cents)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium">
                  {formatTL(e.outstanding_cents)}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={e.status} overdue={e.is_overdue} />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/finance/entries/${e.id}`} className="text-blue-600 hover:underline whitespace-nowrap">
                    Ayrıntı
                  </Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
