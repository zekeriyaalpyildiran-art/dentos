"use client";

// Stock area provider (mounted by app/(panel)/inventory/layout.tsx): one dashboard read shared by the tab badges
// and the home screen, a change counter that pages use to refresh after a save, the quick movement sheet and the
// 'Son kutu' sheet (a room request when a room opens its last box).

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuthStore } from "@/lib/store";
import { useStockGates, type StockGates } from "@/lib/stock/permissions";
import { stockDashboard, toStockError, type DashboardJson, type StockError } from "@/lib/stock/rpc";
import type { CartLine } from "@/lib/stock/cart";
import { UUID_RE } from "@/lib/finance";
import { QuickMovementSheet } from "./QuickMovementSheet";
import { LastBoxSheet, type LastBoxOpenOptions } from "./LastBoxSheet";

export type SheetType = "receive" | "issue" | "transfer" | "waste" | "return";
export const SHEET_TYPES: SheetType[] = ["receive", "issue", "transfer", "waste", "return"];

export interface SheetOpenOptions {
  type?: SheetType;
  itemId?: string;
  /** Scanned label parts (GS1 AIs 10/21/17) to prefill or restrict lots. */
  scan?: { gtin?: string; lot?: string; serial?: string; expiry?: string };
  batchId?: string;
  fromLocationId?: string;
  /** Return mode: the issue movement to return from. */
  sourceMovementId?: string;
  /** Bulk receipt: the sheet adds a cart line instead of saving. */
  onAddToCart?: (line: CartLine) => void;
}

interface StockContextValue {
  dashboard: DashboardJson | null;
  dashboardError: StockError | null;
  reloadDashboard: () => void;
  /** Increments after every successful stock write; include it in load effects to refresh quietly. */
  tick: number;
  notifyChanged: () => void;
  openSheet: (options?: SheetOpenOptions) => void;
  /** 'Son kutu açıldı / azaldı' (closes the quick movement sheet if it is open). */
  openLastBox: (options?: LastBoxOpenOptions) => void;
  gates: StockGates;
  today: string | null;
  /**
   * The stock RPCs are not in the database yet (web build deployed before migration 0024): PostgREST answers
   * PGRST202 (function not found) or 42883. Pages then show one notice instead of broken screens.
   */
  moduleMissing: boolean;
}

/** Error codes meaning "the stock functions do not exist in this database". */
export function isStockModuleMissing(error: StockError | null | undefined): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883");
}

const StockContext = createContext<StockContextValue | null>(null);

export function useStock(): StockContextValue {
  const ctx = useContext(StockContext);
  if (!ctx) throw new Error("useStock must be used inside StockProvider");
  return ctx;
}

export function StockProvider({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user);
  const clientGates = useStockGates();
  const [dashboard, setDashboard] = useState<DashboardJson | null>(null);
  const [dashboardError, setDashboardError] = useState<StockError | null>(null);
  const [tick, setTick] = useState(0);
  const [dashTick, setDashTick] = useState(0);
  const [sheet, setSheet] = useState<SheetOpenOptions | null>(null);
  const sheetSeq = useRef(0);
  const [lastBox, setLastBox] = useState<LastBoxOpenOptions | null>(null);
  const lastBoxSeq = useRef(0);

  // A different signed-in user (e.g. a sign-in synced from another tab) must never keep the previous user's
  // dashboard (cost value block, server permission flags) or open sheet: clear them before refetching, so the
  // gates fall back to the new user's client rules until the server answers.
  useEffect(() => {
    setDashboard(null);
    setDashboardError(null);
    setSheet(null);
    setLastBox(null);
  }, [user?.user_id, user?.clinic_id]);

  useEffect(() => {
    if (!user?.clinic_id || !user?.user_id) return;
    let cancelled = false;
    stockDashboard()
      .then((d) => {
        if (cancelled) return;
        setDashboard(d);
        setDashboardError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setDashboardError(toStockError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [user?.clinic_id, user?.user_id, tick, dashTick]);

  const reloadDashboard = useCallback(() => setDashTick((t) => t + 1), []);
  const notifyChanged = useCallback(() => setTick((t) => t + 1), []);
  const openSheet = useCallback((options?: SheetOpenOptions) => {
    sheetSeq.current++;
    setLastBox(null);
    setSheet(options ?? {});
  }, []);
  const openLastBox = useCallback((options?: LastBoxOpenOptions) => {
    lastBoxSeq.current++;
    setSheet(null);
    setLastBox(options ?? {});
  }, []);

  // Server flags win over the client mirror of the role rules.
  const gates = useMemo<StockGates>(
    () => ({
      op: dashboard?.can_operate ?? clientGates.op,
      mgr: dashboard?.can_manage ?? clientGates.mgr,
      cost: dashboard?.can_view_costs ?? clientGates.cost,
    }),
    [dashboard, clientGates.op, clientGates.mgr, clientGates.cost]
  );

  const value = useMemo<StockContextValue>(
    () => ({
      dashboard,
      dashboardError,
      reloadDashboard,
      tick,
      notifyChanged,
      openSheet,
      openLastBox,
      gates,
      today: dashboard?.today ?? null,
      moduleMissing: isStockModuleMissing(dashboardError),
    }),
    [dashboard, dashboardError, reloadDashboard, tick, notifyChanged, openSheet, openLastBox, gates]
  );

  return (
    <StockContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        <SheetDeepLink />
      </Suspense>
      {gates.op && !sheet && !lastBox && !value.moduleMissing && (
        <button
          type="button"
          onClick={() => openSheet()}
          className="sm:hidden fixed z-40 bottom-4 right-4 h-14 px-6 rounded-full bg-blue-600 text-white font-semibold shadow-lg"
        >
          İşlem
        </button>
      )}
      {sheet && !value.moduleMissing && (
        <QuickMovementSheet
          key={sheetSeq.current}
          options={sheet}
          onClose={() => setSheet(null)}
        />
      )}
      {lastBox && gates.op && !value.moduleMissing && (
        <LastBoxSheet key={lastBoxSeq.current} options={lastBox} onClose={() => setLastBox(null)} />
      )}
    </StockContext.Provider>
  );
}

/**
 * Deep link `?hareket=<type>&item=<id>&gtin=…&lot=…&serial=…&expiry=…` opens the sheet once and is then removed
 * from the address bar. It never carries patient data. `?sonkutu=1&oda=<location id>&item=<id>` opens the 'Son kutu'
 * sheet instead (e.g. a QR label on a room cabinet pointing at /inventory?sonkutu=1&oda=…).
 */
function SheetDeepLink() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { openSheet, openLastBox, gates } = useStock();

  useEffect(() => {
    const type = params.get("hareket");
    const lastBox = params.get("sonkutu");
    if ((!type && !lastBox) || !gates.op) return;
    const item = params.get("item");
    const strip = () => {
      const rest = new URLSearchParams(params.toString());
      ["hareket", "item", "gtin", "lot", "serial", "expiry", "request", "sonkutu", "oda"].forEach((k) => rest.delete(k));
      const qs = rest.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    };
    if (!type) {
      const room = params.get("oda");
      openLastBox({
        itemId: item && UUID_RE.test(item) ? item : undefined,
        locationId: room && UUID_RE.test(room) ? room : undefined,
      });
      strip();
      return;
    }
    const opts: SheetOpenOptions = {
      type: (SHEET_TYPES as string[]).includes(type) ? (type as SheetType) : undefined,
      itemId: item && UUID_RE.test(item) ? item : undefined,
      scan: {
        gtin: params.get("gtin") ?? undefined,
        lot: params.get("lot") ?? undefined,
        serial: params.get("serial") ?? undefined,
        expiry: params.get("expiry") ?? undefined,
      },
    };
    openSheet(opts);
    strip();
  }, [params, gates.op, openSheet, openLastBox, router, pathname]);

  return null;
}
