"use client";

// Consumption rows (spec p9_clinical §6.5, §7.5 Sarf, §7.10). Read-only for everyone. Cost columns only when the
// server sent the cost keys (0024 stock_can_view_costs).

import Link from "next/link";
import type { MaterialRow } from "@/lib/clinical/rpc";
import { formatDateTime } from "@/lib/clinical/dates";
import { formatDecimalTr, formatTl } from "@/lib/clinical/numbers";
import { lotSerialText } from "./ImplantStockPicker";
import { Badge } from "./ui";

function qty(n: number | null | undefined): string {
  return formatDecimalTr(n ?? 0);
}

function Chips({ r }: { r: MaterialRow }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {r.implant_id && <Badge className="bg-indigo-100 text-indigo-800">İmplant · diş {r.implant_tooth ?? "?"}</Badge>}
      {r.correction_status === "pending" && <Badge className="bg-amber-100 text-amber-800">Düzeltme bekliyor</Badge>}
      {r.is_reentry && <Badge className="bg-blue-100 text-blue-800">Düzeltilmiş kayıt</Badge>}
    </span>
  );
}

export function hasCostKeys(rows: readonly { cost_cents?: unknown; unit_cost_cents?: unknown }[]): boolean {
  return rows.some((r) => "cost_cents" in r || "unit_cost_cents" in r);
}

export function MaterialTable({ rows, showAppointment = true }: { rows: MaterialRow[]; showAppointment?: boolean }) {
  const showCost = hasCostKeys(rows);
  return (
    <>
      <div className="hidden md:block bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b text-left text-gray-800">
            <tr>
              <th className="px-4 py-3 font-semibold">Tarih</th>
              <th className="px-4 py-3 font-semibold">Ürün</th>
              <th className="px-4 py-3 font-semibold">Lot / seri</th>
              <th className="px-4 py-3 font-semibold text-right">Miktar</th>
              <th className="px-4 py-3 font-semibold text-right">Net</th>
              <th className="px-4 py-3 font-semibold">Hekim</th>
              {showAppointment && <th className="px-4 py-3 font-semibold">Randevu</th>}
              {showCost && <th className="px-4 py-3 font-semibold text-right">Maliyet</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.movement_id} className="border-b align-top">
                <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                  {formatDateTime(r.effective_at)}
                  <div className="text-xs text-gray-500">#{r.ref_no}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium">{r.item_name}</div>
                  <Chips r={r} />
                </td>
                <td className="px-4 py-3 text-xs text-gray-700">{lotSerialText(r.lot_number, r.serial_number)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                  {qty(r.quantity)} {r.usage_unit}
                </td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                  {qty(r.net_qty)} {r.usage_unit}
                  {r.returned_qty > 0 && <div className="text-xs text-gray-500">İade: {qty(r.returned_qty)}</div>}
                </td>
                <td className="px-4 py-3">{r.doctor_name ?? "—"}</td>
                {showAppointment && (
                  <td className="px-4 py-3 whitespace-nowrap">
                    {r.appointment_id ? (
                      <Link href={`/appointments/${r.appointment_id}`} className="text-blue-700 hover:underline">
                        {formatDateTime(r.appointment_start)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                {showCost && (
                  <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                    {r.cost_cents !== undefined && r.cost_cents !== null ? formatTl(r.cost_cents) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="md:hidden space-y-3">
        {rows.map((r) => (
          <li key={r.movement_id} className="bg-white rounded-lg shadow p-4 space-y-1 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{r.item_name}</span>
              <span className="tabular-nums whitespace-nowrap">
                {qty(r.net_qty)} {r.usage_unit}
              </span>
            </div>
            <div className="text-xs text-gray-600">
              {formatDateTime(r.effective_at)} · #{r.ref_no}
            </div>
            <div className="text-xs text-gray-600">{lotSerialText(r.lot_number, r.serial_number)}</div>
            {r.returned_qty > 0 && (
              <div className="text-xs text-gray-600">
                Çıkış: {qty(r.quantity)} · İade: {qty(r.returned_qty)}
              </div>
            )}
            {r.doctor_name && <div className="text-xs text-gray-600">Hekim: {r.doctor_name}</div>}
            {showAppointment && r.appointment_id && (
              <Link href={`/appointments/${r.appointment_id}`} className="text-xs text-blue-700 hover:underline">
                Randevu: {formatDateTime(r.appointment_start)}
              </Link>
            )}
            {showCost && r.cost_cents !== undefined && r.cost_cents !== null && (
              <div className="text-xs text-gray-700">Maliyet: {formatTl(r.cost_cents)}</div>
            )}
            <Chips r={r} />
          </li>
        ))}
      </ul>
    </>
  );
}
