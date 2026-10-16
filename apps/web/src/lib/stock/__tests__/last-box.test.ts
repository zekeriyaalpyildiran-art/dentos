// 'Son kutu' helpers (lib/stock/last-box.ts): default quantity, rooms, duplicate detection and the texts / links
// of the manager notice and the menu count. Synthetic data only.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LAST_BOX_NOTE,
  ROOM_REQUESTS_HREF,
  findOpenRoomRequest,
  hasPurchasePack,
  isLastBoxNote,
  isOpenRoomRequest,
  isRequestRoom,
  lastBoxDefaultQuantity,
  lastBoxDuplicateText,
  lastBoxRoomKey,
  lastBoxSuccessText,
  openRoomRequestsText,
  packFactor,
  pickStartRoom,
  requestRooms,
  roomRequestsHref,
  summarizeRoomRequests,
  type RoomRequestSummaryRow,
} from "../last-box";
import { MENU_BADGES, menuBadge } from "../../nav";

const PANEL_DIR = fileURLToPath(new URL("../../../app/(panel)", import.meta.url));

const card = (over: Partial<Parameters<typeof lastBoxDefaultQuantity>[0]> = {}) => ({
  tracking_level: "C",
  usage_unit: "adet",
  purchase_unit: "kutu",
  units_per_purchase: 10,
  ...over,
});

describe("lastBoxDefaultQuantity", () => {
  it("asks for one purchase pack when a pack holds more than one usage unit", () => {
    expect(lastBoxDefaultQuantity(card())).toEqual({ qtyText: "1", unit: "purchase", usageQty: 10, label: "1 kutu (10 adet)" });
    expect(lastBoxDefaultQuantity(card({ units_per_purchase: "4" })).label).toBe("1 kutu (4 adet)");
    expect(lastBoxDefaultQuantity(card({ units_per_purchase: 2.5, tracking_level: "B" })).usageQty).toBe(2.5);
  });

  it("asks for one usage unit when there is no separate pack", () => {
    for (const c of [
      card({ units_per_purchase: 1 }),
      card({ units_per_purchase: null }),
      card({ units_per_purchase: 0 }),
      card({ units_per_purchase: 0.5 }),
      card({ purchase_unit: "" }),
      card({ purchase_unit: "adet" }),
    ]) {
      expect(lastBoxDefaultQuantity(c), JSON.stringify(c)).toEqual({ qtyText: "1", unit: "usage", usageQty: 1, label: "1 adet" });
    }
  });

  it("keeps whole units for A-level cards with a fractional pack", () => {
    expect(lastBoxDefaultQuantity(card({ tracking_level: "A", units_per_purchase: 2.5 })).unit).toBe("usage");
    expect(lastBoxDefaultQuantity(card({ tracking_level: "A", units_per_purchase: 5 })).unit).toBe("purchase");
  });

  it("packFactor / hasPurchasePack read the card factor safely", () => {
    expect(packFactor({ units_per_purchase: "12" })).toBe(12);
    expect(packFactor({ units_per_purchase: "x" })).toBe(1);
    expect(packFactor({ units_per_purchase: -3 })).toBe(1);
    expect(hasPurchasePack(card())).toBe(true);
    expect(hasPurchasePack(card({ purchase_unit: null }))).toBe(false);
  });
});

describe("rooms", () => {
  const locs = [
    { id: "w", name: "Ana Depo", kind: "warehouse", is_default_warehouse: true, is_active: true },
    { id: "r1", name: "Oda 1", kind: "room", is_default_warehouse: false, is_active: true },
    { id: "r2", name: "Oda 2", kind: "room", is_default_warehouse: false, is_active: false },
    { id: "s", name: "Sterilizasyon", kind: "sterilization", is_default_warehouse: false },
    { id: "rw", name: "Oda deposu", kind: "room", is_default_warehouse: true, is_active: true },
  ];

  it("offers rooms and sterilization, never the main warehouse or a passive room", () => {
    expect(requestRooms(locs).map((l) => l.id)).toEqual(["r1", "s"]);
    expect(isRequestRoom(locs[0])).toBe(false);
  });

  it("starts with the device's room, then the shift room, then the only room", () => {
    const rooms = [{ id: "r1" }, { id: "s" }];
    expect(pickStartRoom(rooms, "s", "r1")).toBe("s");
    expect(pickStartRoom(rooms, "gone", "r1")).toBe("r1");
    expect(pickStartRoom(rooms, "", "")).toBe("");
    expect(pickStartRoom([{ id: "r1" }], null, undefined)).toBe("r1");
    expect(pickStartRoom([], "r1", "r1")).toBe("");
  });

  it("remembers the room per clinic on the device, outside the keys cleared at sign-out", () => {
    expect(lastBoxRoomKey("c1")).toBe("dentos-lastbox-room:c1");
    expect(lastBoxRoomKey("c1").startsWith("dentos-stock-")).toBe(false);
  });
});

describe("findOpenRoomRequest (no duplicate request for the same room and card)", () => {
  const row = (over: Partial<RoomRequestSummaryRow>): RoomRequestSummaryRow => ({
    id: "q",
    ref_no: 1,
    status: "pending",
    location_id: "r1",
    stock_item_id: "i1",
    location_name: "Oda 1",
    item_name: "Kompozit A2",
    ...over,
  });

  it("finds a pending or approved request of the same room and card", () => {
    expect(findOpenRoomRequest([row({ id: "a", ref_no: 7 })], "r1", "i1")?.ref_no).toBe(7);
    expect(findOpenRoomRequest([row({ id: "b", status: "approved", ref_no: 8 })], "r1", "i1")?.ref_no).toBe(8);
  });

  it("prefers the pending one", () => {
    const rows = [row({ id: "a", status: "approved", ref_no: 3 }), row({ id: "b", status: "pending", ref_no: 4 })];
    expect(findOpenRoomRequest(rows, "r1", "i1")?.ref_no).toBe(4);
  });

  it("ignores closed requests, other rooms and other cards", () => {
    const rows = [
      row({ status: "delivered" }),
      row({ status: "rejected" }),
      row({ status: "cancelled" }),
      row({ location_id: "r2" }),
      row({ stock_item_id: "i2" }),
    ];
    expect(findOpenRoomRequest(rows, "r1", "i1")).toBeNull();
    expect(findOpenRoomRequest(null, "r1", "i1")).toBeNull();
    expect(isOpenRoomRequest({ status: "approved" })).toBe(true);
    expect(isOpenRoomRequest({ status: "delivered" })).toBe(false);
  });

  it("summarizes the first open requests for the manager notice", () => {
    const rows = [
      row({ id: "a", ref_no: 1, location_name: "Oda 1", item_name: "Kompozit A2" }),
      row({ id: "b", ref_no: 2, location_name: "Oda 3", item_name: "Bond" }),
      row({ id: "c", ref_no: 3, location_name: "Oda 2", item_name: "Eldiven" }),
      row({ id: "d", ref_no: 4, location_name: "Oda 4", item_name: "Maske" }),
    ];
    const s = summarizeRoomRequests(rows, 6);
    expect(s.lines.map((l) => l.text)).toEqual(["Oda 1 · Kompozit A2", "Oda 3 · Bond", "Oda 2 · Eldiven"]);
    expect(s.more).toBe(3);
    expect(summarizeRoomRequests(rows.slice(0, 1), 1).more).toBe(0);
    expect(summarizeRoomRequests([row({ status: "delivered" })], 0).lines).toEqual([]);
  });
});

describe("texts and links", () => {
  it("says what happened, in Turkish", () => {
    expect(lastBoxSuccessText(12)).toBe("Talep #12 açıldı; stok sorumlusu görecek.");
    expect(lastBoxSuccessText(12, true)).toBe("Talep #12 zaten açılmıştı; stok sorumlusu görecek.");
    expect(lastBoxDuplicateText(7)).toBe("Bu oda için zaten açık talep var (Talep #7)");
    expect(openRoomRequestsText(2)).toBe("2 oda talebi bekliyor");
  });

  it("recognizes the last-box note (also edited after the prefix)", () => {
    expect(isLastBoxNote(LAST_BOX_NOTE)).toBe(true);
    expect(isLastBoxNote("  son kutu açıldı, A3 de azaldı")).toBe(true);
    expect(isLastBoxNote("Haftalık ihtiyaç")).toBe(false);
    expect(isLastBoxNote(null)).toBe(false);
  });

  it("links to the requests page, optionally filtered to one room", () => {
    expect(roomRequestsHref()).toBe(ROOM_REQUESTS_HREF);
    expect(roomRequestsHref("r1")).toBe("/inventory/requests?location=r1");
    expect(existsSync(`${PANEL_DIR}${ROOM_REQUESTS_HREF}/page.tsx`)).toBe(true);
  });

  it("menu count: '2 talep' to the same list", () => {
    expect(menuBadge("roomRequests", 2)?.text).toBe("2 talep");
    expect(MENU_BADGES.roomRequests.href).toBe(ROOM_REQUESTS_HREF);
  });
});
