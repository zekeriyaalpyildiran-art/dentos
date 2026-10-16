"use client";

// Small counts next to the menu items. They reuse the read RPCs of the pages they point to (nothing new in the
// database): crm_work_list for CRM · Bugün ("Günlük liste") and the caller's open tasks, stock_item_levels for the
// critical stock cards, and for stock managers stock_work_counts for the open room requests ('Son kutu' reports land
// there). crm_work_list builds the whole work list on every call, so on the free database the badges refresh only
// every 5 minutes while the tab is visible (page changes at most once a minute); any failure just hides that badge.
// A page that changed one of the counts (e.g. a room request was created) calls refreshMenuBadges() to update now.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { crmWorkList } from "@/lib/crm";
import { stockItemLevels, stockWorkCounts } from "@/lib/stock/rpc";
import type { MenuBadgeKey } from "@/lib/nav";

export type MenuBadges = Partial<Record<MenuBadgeKey, number>>;

const REFRESH_MS = 5 * 60_000;
/** Page changes and returning to the tab refresh too, but never more often than this. */
const MIN_GAP_MS = 60_000;
/** Same-tab signal of refreshMenuBadges() (a window event, so no shared store is needed). */
const REFRESH_EVENT = "dentos:menu-badges-refresh";

/** Reload the menu counts now (after a write that changes one of them); ignores the one-minute gap. */
export function refreshMenuBadges(): void {
  try {
    window.dispatchEvent(new Event(REFRESH_EVENT));
  } catch {
    // Not in a browser: nothing to refresh.
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function loadBadges(stockManager: boolean): Promise<MenuBadges> {
  const [work, stock, rooms] = await Promise.allSettled([
    // Same list as the CRM · Bugün page opens with (all staff, 'Günlük liste'); one row is enough for the counts.
    crmWorkList({ p_filter: "all", p_user_id: null, p_page: { offset: 0, limit: 1 } }),
    stockItemLevels({ status: "critical" }, { offset: 0, limit: 1 }),
    // Only the people who approve / deliver room requests see that count (the server flag decides below).
    stockManager ? stockWorkCounts() : Promise.resolve(null),
  ]);
  const badges: MenuBadges = {};
  if (work.status === "fulfilled" && work.value) {
    badges.crm = count(work.value.counts?.all);
    badges.tasks = count(work.value.my_tasks?.open);
  }
  if (stock.status === "fulfilled" && stock.value) {
    badges.stock = count(stock.value.total);
  }
  if (rooms.status === "fulfilled" && rooms.value && rooms.value.can_manage !== false) {
    const r = rooms.value.room_requests;
    const pending = count(r?.pending);
    const approved = count(r?.approved);
    if (pending !== undefined || approved !== undefined) badges.roomRequests = (pending ?? 0) + (approved ?? 0);
  }
  return badges;
}

/**
 * @param stockManager the client mirror of the stock manager rule (canManageStock); the room request count is only
 *   loaded for them, and only shown when stock_work_counts confirms can_manage.
 */
export function useMenuBadges(userId: string | null | undefined, stockManager = false): MenuBadges {
  const pathname = usePathname();
  const [badges, setBadges] = useState<MenuBadges>({});
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setBadges({});
    if (!userId) return;

    let alive = true;
    let busy = false;
    /** A forced refresh asked while one was running: run once more when it ends. */
    let again = false;
    let last = 0;

    const refresh = (force = false) => {
      if (!alive || document.visibilityState !== "visible") return;
      if (busy) {
        if (force) again = true;
        return;
      }
      if (!force && Date.now() - last < MIN_GAP_MS) return;
      busy = true;
      last = Date.now();
      loadBadges(stockManager)
        .then((next) => {
          if (alive) setBadges(next);
        })
        .catch(() => {
          if (alive) setBadges({});
        })
        .finally(() => {
          busy = false;
          if (again) {
            again = false;
            refresh(true);
          }
        });
    };

    refreshRef.current = () => refresh();
    refresh(true);
    const timer = window.setInterval(() => refresh(), REFRESH_MS);
    const onVisibility = () => refresh();
    const onRequest = () => refresh(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(REFRESH_EVENT, onRequest);

    return () => {
      alive = false;
      refreshRef.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(REFRESH_EVENT, onRequest);
    };
  }, [userId, stockManager]);

  // After a page change (e.g. a call result was saved and the user moved on) the counts follow sooner.
  useEffect(() => {
    refreshRef.current();
  }, [pathname]);

  return badges;
}
