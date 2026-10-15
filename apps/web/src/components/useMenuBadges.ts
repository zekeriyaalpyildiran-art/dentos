"use client";

// Small counts next to the menu items. They reuse the read RPCs of the pages they point to (nothing new in the
// database): crm_work_list for CRM · Bugün ("Günlük liste") and the caller's open tasks, stock_item_levels for the
// critical stock cards. Refreshed every minute while the tab is visible; any failure just hides that badge.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { crmWorkList } from "@/lib/crm";
import { stockItemLevels } from "@/lib/stock/rpc";
import type { MenuBadgeKey } from "@/lib/nav";

export type MenuBadges = Partial<Record<MenuBadgeKey, number>>;

const REFRESH_MS = 60_000;
/** Page changes and returning to the tab refresh too, but never more often than this. */
const MIN_GAP_MS = 15_000;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function loadBadges(): Promise<MenuBadges> {
  const [work, stock] = await Promise.allSettled([
    // Same list as the CRM · Bugün page opens with (all staff, 'Günlük liste'); one row is enough for the counts.
    crmWorkList({ p_filter: "all", p_user_id: null, p_page: { offset: 0, limit: 1 } }),
    stockItemLevels({ status: "critical" }, { offset: 0, limit: 1 }),
  ]);
  const badges: MenuBadges = {};
  if (work.status === "fulfilled" && work.value) {
    badges.crm = count(work.value.counts?.all);
    badges.tasks = count(work.value.my_tasks?.open);
  }
  if (stock.status === "fulfilled" && stock.value) {
    badges.stock = count(stock.value.total);
  }
  return badges;
}

export function useMenuBadges(userId: string | null | undefined): MenuBadges {
  const pathname = usePathname();
  const [badges, setBadges] = useState<MenuBadges>({});
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setBadges({});
    if (!userId) return;

    let alive = true;
    let busy = false;
    let last = 0;

    const refresh = (force = false) => {
      if (!alive || busy || document.visibilityState !== "visible") return;
      if (!force && Date.now() - last < MIN_GAP_MS) return;
      busy = true;
      last = Date.now();
      loadBadges()
        .then((next) => {
          if (alive) setBadges(next);
        })
        .catch(() => {
          if (alive) setBadges({});
        })
        .finally(() => {
          busy = false;
        });
    };

    refreshRef.current = () => refresh();
    refresh(true);
    const timer = window.setInterval(() => refresh(), REFRESH_MS);
    const onVisibility = () => refresh();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      refreshRef.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId]);

  // After a page change (e.g. a call result was saved and the user moved on) the counts follow sooner.
  useEffect(() => {
    refreshRef.current();
  }, [pathname]);

  return badges;
}
