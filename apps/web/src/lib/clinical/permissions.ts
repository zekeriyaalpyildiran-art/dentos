// UI hints for the clinical screens (spec p9_clinical §1.2). The server's `flags` always win once a response is in;
// these only decide what to show before the first response.

import { hasPermission } from "@/lib/permissions";

type UserLike = { role?: string | null; permissions?: readonly string[] } | null | undefined;

export function canWriteClinical(user: UserLike): boolean {
  if (!user) return false;
  return (
    ["owner", "admin", "doctor", "assistant"].includes(user.role ?? "") || hasPermission(user, "clinical")
  );
}

export function canViewLabCosts(user: UserLike): boolean {
  if (!user) return false;
  return (
    user.role === "owner" ||
    hasPermission(user, "finance") ||
    hasPermission(user, "finance_readonly") ||
    hasPermission(user, "stock_cost_view")
  );
}

export function canEditLabCosts(user: UserLike): boolean {
  if (!user) return false;
  return user.role === "owner" || hasPermission(user, "finance") || hasPermission(user, "stock_cost_view");
}
