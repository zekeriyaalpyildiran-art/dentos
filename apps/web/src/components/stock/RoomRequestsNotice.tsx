"use client";

// In-app notice of open room requests for the people who approve and deliver them (stock managers): the block at the
// top of the stock home and the rows in 'Bugün dikkat isteyenler'. Pure views; the home page loads the rows
// (stock_room_request_list, status 'open') and passes them in.

import Link from "next/link";
import {
  ROOM_REQUESTS_HREF,
  isLastBoxNote,
  openRoomRequestsText,
  packFactor,
  roomRequestsHref,
  summarizeRoomRequests,
} from "@/lib/stock/last-box";
import { ROOM_REQUEST_STATUS_LABELS, qtyLabel } from "@/lib/stock/purchasing";
import type { RoomRequestJson } from "@/lib/stock/rpc";
import { formatTimestamp } from "./ui";

function requestQty(r: RoomRequestJson): string {
  return qtyLabel(Number(r.quantity), r.usage_unit, r.purchase_unit, packFactor(r));
}

/** "Bekliyor · 1 kutu (10 adet) · Ayşe Yılmaz · 16.10.2026 10:42" */
function requestMeta(r: RoomRequestJson): string {
  return [
    ROOM_REQUEST_STATUS_LABELS[r.status] ?? r.status,
    requestQty(r),
    r.requested_by_name ?? null,
    formatTimestamp(r.created_at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Top of the stock home for managers: "2 oda talebi bekliyor" with the first few rooms and products. */
export function RoomRequestsNotice({ total, rows, max = 3 }: { total: number; rows: RoomRequestJson[]; max?: number }) {
  if (!(total > 0)) return null;
  const { lines, more } = summarizeRoomRequests(rows, total, max);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (
    <section
      aria-labelledby="room-requests-notice-title"
      className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-amber-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="room-requests-notice-title" className="text-lg font-semibold">
          <span aria-hidden="true" className="mr-1.5">
            📣
          </span>
          {openRoomRequestsText(total)}
        </h2>
        <Link
          href={ROOM_REQUESTS_HREF}
          className="inline-flex items-center min-h-[48px] px-4 rounded-lg bg-amber-700 text-white font-semibold hover:bg-amber-800"
        >
          Talepleri aç
        </Link>
      </div>
      {lines.length > 0 && (
        <ul className="mt-2 space-y-1">
          {lines.map((line) => {
            const r = byId.get(line.id);
            return (
              <li key={line.id}>
                <Link
                  href={roomRequestsHref(r?.location_id)}
                  className="flex flex-wrap items-baseline gap-x-2 min-h-[44px] py-1 hover:underline"
                >
                  <span className="font-semibold">{line.text}</span>
                  {r && (
                    <span className="text-sm">
                      {requestQty(r)}
                      {r.requested_by_name ? ` · ${r.requested_by_name}` : ""}
                      {isLastBoxNote(r.note) ? " · son kutu açıldı" : ""}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && <p className="mt-1 text-sm">+{more} talep daha</p>}
    </section>
  );
}

/** One open room request in 'Bugün dikkat isteyenler' (managers); opens the room's requests. */
export function RoomRequestAttentionRow({ request: r }: { request: RoomRequestJson }) {
  return (
    <Link
      href={roomRequestsHref(r.location_id)}
      className="block w-full text-left p-3 rounded border border-l-4 border-l-amber-500 hover:bg-gray-50 min-h-[48px]"
    >
      <span className="block font-medium">
        <span aria-hidden="true" className="mr-1.5">
          📣
        </span>
        {r.location_name}: {r.item_name}
      </span>
      <span className="block text-sm text-gray-600">
        Oda talebi #{r.ref_no} · {requestMeta(r)}
      </span>
      {r.note && <span className="block text-sm text-gray-700 whitespace-pre-wrap">“{r.note}”</span>}
    </Link>
  );
}
