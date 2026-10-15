"use client";

import Link from "next/link";
import { movementSource, movementTarget } from "@/lib/stock/codes";
import type { MovementRow } from "@/lib/stock/rpc";
import { formatTimestamp } from "@/lib/finance";
import { Badge, MovementPill, QtyText } from "./ui";

function Flags({ row }: { row: MovementRow }) {
  return (
    <>
      {row.corrected && <Badge className="bg-gray-200 text-gray-700">Düzeltildi</Badge>}
      {row.correction_status === "pending" && <Badge className="bg-amber-100 text-amber-800">Düzeltme bekliyor</Badge>}
      {row.is_reentry && <Badge className="bg-gray-100 text-gray-700">Düzeltilmiş kayıt{row.source_ref_no ? ` (#${row.source_ref_no})` : ""}</Badge>}
    </>
  );
}

function lotText(row: MovementRow): string {
  return [row.lot_number, row.serial_number ? `seri ${row.serial_number}` : null].filter(Boolean).join(" · ");
}

function personText(row: MovementRow): string {
  return [row.patient_name, row.doctor_name ? `Dr. ${row.doctor_name}` : null].filter(Boolean).join(" · ");
}

/**
 * Ledger rows (contract §5.4). Desktop table; stacked cards below 640 px. Actions appear only when the server
 * says the caller may use them (can_request_correction, can_return).
 */
export function MovementTable({
  rows,
  showItem = true,
  onRequestCorrection,
  onReturn,
}: {
  rows: MovementRow[];
  showItem?: boolean;
  onRequestCorrection?: (row: MovementRow) => void;
  onReturn?: (row: MovementRow) => void;
}) {
  const actions = (row: MovementRow) => (
    <div className="flex flex-wrap gap-2">
      {onRequestCorrection && row.can_request_correction && (
        <button type="button" className="text-sm text-blue-700 hover:underline min-h-[36px]" onClick={() => onRequestCorrection(row)}>
          Düzeltme iste
        </button>
      )}
      {onReturn && row.can_return && row.returnable_qty > 0 && (
        <button type="button" className="text-sm text-teal-700 hover:underline min-h-[36px]" onClick={() => onReturn(row)}>
          İade al
        </button>
      )}
    </div>
  );

  return (
    <>
      <ul className="sm:hidden divide-y border rounded">
        {rows.map((row) => (
          <li key={row.id} className="p-3 space-y-1">
            <div className="flex flex-wrap items-center gap-1">
              <MovementPill type={row.movement_type} />
              <Flags row={row} />
              <span className="ml-auto text-xs text-gray-500">#{row.ref_no}</span>
            </div>
            {showItem && (
              <Link href={`/inventory/items/${row.stock_item_id}`} className="block font-medium text-blue-700">
                {row.item_name}
              </Link>
            )}
            <p className="text-sm">
              <QtyText qty={row.quantity} unit={row.usage_unit} /> · {movementSource(row.movement_type, row.from_location_name)} →{" "}
              {movementTarget(row.movement_type, row.to_location_name)}
            </p>
            <p className="text-xs text-gray-600">{lotText(row)}</p>
            {personText(row) && <p className="text-xs text-gray-600">{personText(row)}</p>}
            {row.reason && <p className="text-xs text-gray-600">{row.reason}</p>}
            <p className="text-xs text-gray-500">
              {formatTimestamp(row.created_at)} · {row.actor_name ?? "Sistem"}
            </p>
            {actions(row)}
          </li>
        ))}
      </ul>
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b text-left text-gray-700">
            <tr>
              <th className="px-3 py-2">Tür</th>
              {showItem && <th className="px-3 py-2">Ürün</th>}
              <th className="px-3 py-2 text-right">Miktar</th>
              <th className="px-3 py-2">Nereden → nereye</th>
              <th className="px-3 py-2">Lot / seri</th>
              <th className="px-3 py-2">Hasta / hekim</th>
              <th className="px-3 py-2">Kayıt</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b align-top">
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <MovementPill type={row.movement_type} />
                    <Flags row={row} />
                  </div>
                </td>
                {showItem && (
                  <td className="px-3 py-2">
                    <Link href={`/inventory/items/${row.stock_item_id}`} className="text-blue-700 hover:underline">
                      {row.item_name}
                    </Link>
                    {row.reason && <div className="text-xs text-gray-500">{row.reason}</div>}
                  </td>
                )}
                <td className="px-3 py-2 text-right">
                  <QtyText qty={row.quantity} unit={row.usage_unit} />
                </td>
                <td className="px-3 py-2">
                  {movementSource(row.movement_type, row.from_location_name)} → {movementTarget(row.movement_type, row.to_location_name)}
                  {!showItem && row.reason && <div className="text-xs text-gray-500">{row.reason}</div>}
                  {row.document_no && <div className="text-xs text-gray-500">Belge: {row.document_no}</div>}
                </td>
                <td className="px-3 py-2">{lotText(row)}</td>
                <td className="px-3 py-2">{personText(row) || <span className="text-gray-400">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600">
                  #{row.ref_no}
                  <br />
                  {formatTimestamp(row.created_at)}
                  <br />
                  {row.actor_name ?? "Sistem"}
                </td>
                <td className="px-3 py-2">{actions(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
