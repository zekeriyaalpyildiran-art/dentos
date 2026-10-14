// Per-person grants stored in staff_permissions. They are independent of the role:
// an admin does not see finance unless someone with 'finance' grants it.

export const PERMISSIONS = [
  "finance",
  "finance_readonly",
  "stock_manage",
  "stock_cost_view",
  "crm_manage",
  "clinical",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  finance: "Finans",
  finance_readonly: "Finans – sadece görüntüleme",
  stock_manage: "Stok yönetimi",
  stock_cost_view: "Stok maliyetlerini görme",
  crm_manage: "CRM yönetimi",
  clinical: "Klinik kayıtlar",
};

/** Only a holder of 'finance' may grant or revoke these (enforced by the database). */
export const FINANCE_PERMISSIONS: readonly Permission[] = ["finance", "finance_readonly"];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

type WithPermissions = { permissions?: readonly string[] } | null | undefined;

export function hasPermission(user: WithPermissions, permission: Permission): boolean {
  return !!user?.permissions?.includes(permission);
}

/** Finance figures (collections, revenue, payment sums) are visible to finance and finance_readonly holders. */
export function canSeeFinance(user: WithPermissions): boolean {
  return hasPermission(user, "finance") || hasPermission(user, "finance_readonly");
}
