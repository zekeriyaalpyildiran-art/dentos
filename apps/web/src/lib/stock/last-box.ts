// "Son kutu" (last box): an assistant who opens the last box / tube of a product in a room reports it, and the app
// opens a room request (oda talebi) for that room from the main warehouse. Usage in rooms is almost never recorded,
// so quantity alerts cannot see a room running out; this report is the signal. Notification is in the app only
// (menu count and the stock home notice for stock managers).
//
// Pure helpers (no React, no network); the RPCs (stock_room_request_create / _list, migration 0025) stay
// authoritative. Relative imports only: vitest runs these without the "@/" alias.

import { qtyLabel } from "./purchasing";
import { formatQty, isWholeNumber, type QuantityUnit } from "./units";

/** Pre-filled note of a last-box request (editable). */
export const LAST_BOX_NOTE = "Son kutu açıldı";

/** Label of the quick action (stock home, quick movement sheet, card page). */
export const LAST_BOX_ACTION_LABEL = "Son kutu açıldı / azaldı";

/** Room requests list (its default tab is the room tab, default status 'Açık'). */
export const ROOM_REQUESTS_HREF = "/inventory/requests";

/** The list filtered to one room (RoomRequestsPanel reads ?location=). */
export function roomRequestsHref(locationId?: string | null): string {
  return locationId ? `${ROOM_REQUESTS_HREF}?location=${encodeURIComponent(locationId)}` : ROOM_REQUESTS_HREF;
}

/**
 * Remembered room of this device. Deliberately not under the "dentos-stock-" prefix that sign-out clears: the phone
 * or tablet stays in its room when people sign in and out. It holds a location id only, never personal data.
 */
export const lastBoxRoomKey = (clinicId: string) => `dentos-lastbox-room:${clinicId}`;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomLike {
  id: string;
  name: string;
  kind: string;
  is_default_warehouse: boolean;
  is_active?: boolean;
}

/** Where a room request may point (the RPC answers E_RQ_LOCATION otherwise): rooms and sterilization, never the main warehouse. */
export function isRequestRoom(location: RoomLike): boolean {
  return (
    (location.kind === "room" || location.kind === "sterilization") &&
    !location.is_default_warehouse &&
    location.is_active !== false
  );
}

export function requestRooms<T extends RoomLike>(locations: readonly T[]): T[] {
  return locations.filter(isRequestRoom);
}

/** Starting room: this device's last room, else the user's shift room, else the only room; '' when unsure. */
export function pickStartRoom(
  rooms: readonly Pick<RoomLike, "id">[],
  remembered: string | null | undefined,
  shiftRoom: string | null | undefined
): string {
  const has = (id: string | null | undefined): id is string => !!id && rooms.some((r) => r.id === id);
  if (has(remembered)) return remembered;
  if (has(shiftRoom)) return shiftRoom;
  return rooms.length === 1 ? rooms[0].id : "";
}

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

export interface PackInfo {
  tracking_level?: string;
  usage_unit: string;
  purchase_unit: string | null | undefined;
  units_per_purchase: number | string | null | undefined;
}

/** The card's factor (usage units per purchase pack); 1 when missing or invalid. */
export function packFactor(item: Pick<PackInfo, "units_per_purchase">): number {
  const f = Number(item.units_per_purchase);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/** Whether the card has a separate purchase pack the form may offer ("kutu" of 10 "adet"). */
export function hasPurchasePack(item: PackInfo): boolean {
  return packFactor(item) !== 1 && !!item.purchase_unit && item.purchase_unit !== item.usage_unit;
}

export interface LastBoxQuantity {
  /** Text for the quantity input. */
  qtyText: string;
  unit: QuantityUnit;
  /** In usage units, as the server will store it. */
  usageQty: number;
  /** "1 kutu (10 adet)" or "1 adet". */
  label: string;
}

/**
 * Default request: one purchase pack when the card is bought in packs of more than one usage unit (the room opened
 * its last box, so it needs a new box), else one usage unit. An A-level card (whole units only) with a fractional
 * factor falls back to one unit.
 */
export function lastBoxDefaultQuantity(item: PackInfo): LastBoxQuantity {
  const f = packFactor(item);
  const pack = f > 1 && hasPurchasePack(item) && !(item.tracking_level === "A" && !isWholeNumber(f));
  if (pack) {
    return { qtyText: "1", unit: "purchase", usageQty: f, label: qtyLabel(f, item.usage_unit, item.purchase_unit, f) };
  }
  return { qtyText: "1", unit: "usage", usageQty: 1, label: `${formatQty(1)} ${item.usage_unit}` };
}

/** A draft or passive card cannot get a request (the RPC answers E_ITEM_NOT_FOUND); same texts as a scanned one. */
export const LAST_BOX_DRAFT_TEXT = "Bu ürünün kartı henüz tamamlanmadı. Stok sorumlusuna bildirin.";
export const LAST_BOX_INACTIVE_TEXT = "Bu ürün kartı pasif. Stok sorumlusuna bildirin.";

/** Why this card cannot be reported (passive or draft), or null when it can. */
export function lastBoxItemProblem(item: { is_active?: boolean | null; needs_review?: boolean | null }): string | null {
  if (item.is_active === false) return LAST_BOX_INACTIVE_TEXT;
  if (item.needs_review) return LAST_BOX_DRAFT_TEXT;
  return null;
}

// ---------------------------------------------------------------------------
// Duplicates and texts
// ---------------------------------------------------------------------------

export type RoomRequestStatusLike = "pending" | "approved" | "delivered" | "rejected" | "cancelled" | string;

export interface RoomRequestLike {
  id: string;
  ref_no: number;
  status: RoomRequestStatusLike;
  location_id: string;
  stock_item_id: string;
}

/** Statuses that still wait for the stock team (approve and / or deliver). */
export const OPEN_ROOM_REQUEST_STATUSES: readonly string[] = ["pending", "approved"];

export function isOpenRoomRequest(row: Pick<RoomRequestLike, "status">): boolean {
  return OPEN_ROOM_REQUEST_STATUSES.includes(row.status);
}

/**
 * The open request for the same room and card, if any: a second report of the same last box must not open a second
 * request. Pending first, then the newest (the list RPC already orders rows that way).
 */
export function findOpenRoomRequest<T extends RoomRequestLike>(
  rows: readonly T[] | null | undefined,
  locationId: string,
  stockItemId: string
): T | null {
  const open = (rows || []).filter(
    (r) => isOpenRoomRequest(r) && r.location_id === locationId && r.stock_item_id === stockItemId
  );
  return open.find((r) => r.status === "pending") ?? open[0] ?? null;
}

export function lastBoxSuccessText(refNo: number, alreadySaved = false): string {
  return alreadySaved
    ? `Talep #${refNo} zaten açılmıştı; stok sorumlusu görecek.`
    : `Talep #${refNo} açıldı; stok sorumlusu görecek.`;
}

export function lastBoxDuplicateText(refNo: number): string {
  return `Bu oda için zaten açık talep var (Talep #${refNo})`;
}

/** Whether a request note came from the last-box action (shown with a marker on the requests list). */
export function isLastBoxNote(note: string | null | undefined): boolean {
  return (note ?? "").trim().toLocaleLowerCase("tr-TR").startsWith(LAST_BOX_NOTE.toLocaleLowerCase("tr-TR"));
}

/** Manager notice headline: "2 oda talebi bekliyor". */
export function openRoomRequestsText(n: number): string {
  return `${n} oda talebi bekliyor`;
}

export interface RoomRequestSummaryRow extends RoomRequestLike {
  location_name: string;
  item_name: string;
}

/** Open requests named in the stock home notice (managers). */
export const NOTICE_ROOM_REQUESTS = 3;
/** Further open requests listed in 'Bugün dikkat isteyenler', after the ones the notice already names. */
export const ATTENTION_ROOM_REQUESTS = 3;

/**
 * Rows for 'Bugün dikkat isteyenler': the open requests after the first `noticeRows` (the notice above already lists
 * those), at most `max`. The same request is never shown twice on the stock home.
 */
export function attentionRoomRequests<T extends Pick<RoomRequestLike, "status">>(
  rows: readonly T[],
  noticeRows = NOTICE_ROOM_REQUESTS,
  max = ATTENTION_ROOM_REQUESTS
): T[] {
  const n = Math.max(0, noticeRows);
  return rows.filter(isOpenRoomRequest).slice(n, n + Math.max(0, max));
}

/** First few open requests as "Oda 2 · Kompozit A2", plus how many more are not listed. */
export function summarizeRoomRequests(
  rows: readonly RoomRequestSummaryRow[],
  total: number,
  max = NOTICE_ROOM_REQUESTS
): { lines: { id: string; refNo: number; text: string }[]; more: number } {
  const open = rows.filter(isOpenRoomRequest).slice(0, Math.max(0, max));
  return {
    lines: open.map((r) => ({ id: r.id, refNo: r.ref_no, text: `${r.location_name} · ${r.item_name}` })),
    more: Math.max(0, (Number.isFinite(total) ? total : open.length) - open.length),
  };
}
