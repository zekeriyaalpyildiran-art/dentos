"use client";

// UI gates for stock (spec p7_db_contract §1.2, owner decisions §0.3). They only hide controls that the database
// would refuse; every RPC enforces the same rules. When a read RPC returns can_* flags, those win.

import { useAuthStore } from "@/lib/store";
import { hasPermission } from "@/lib/permissions";
import type { AuthUser } from "@/lib/auth";

type U = Pick<AuthUser, "role" | "permissions"> | null | undefined;

/** Receive, issue, transfer, waste, bulk receive, correction / product requests. Reception is read-only. */
export function canOperateStock(user: U): boolean {
  if (!user) return false;
  return ["owner", "admin", "doctor", "assistant"].includes(user.role) || hasPermission(user, "stock_manage");
}

/** Catalog, locations, suppliers, counts, correction approval, usage returns. Admin alone is not a manager. */
export function canManageStock(user: U): boolean {
  if (!user) return false;
  return user.role === "owner" || hasPermission(user, "stock_manage");
}

/** Costs and stock value: owner, stock_cost_view or finance (finance_readonly alone does not see costs). */
export function canViewStockCosts(user: U): boolean {
  if (!user) return false;
  return user.role === "owner" || hasPermission(user, "stock_cost_view") || hasPermission(user, "finance");
}

export interface StockGates {
  op: boolean;
  mgr: boolean;
  cost: boolean;
}

export function useStockGates(): StockGates {
  const user = useAuthStore((state) => state.user);
  return { op: canOperateStock(user), mgr: canManageStock(user), cost: canViewStockCosts(user) };
}

export const useStockOp = () => useStockGates().op;
export const useStockMgr = () => useStockGates().mgr;
export const useCostView = () => useStockGates().cost;
