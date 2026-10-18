// Per-person grants stored in staff_permissions. They are independent of the role:
// an admin does not see finance unless someone with 'finance' grants it.

export const PERMISSIONS = [
  "finance",
  "finance_readonly",
  "hakedis_prepare",
  "stock_manage",
  "stock_cost_view",
  "crm_manage",
  "clinical",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  finance: "Finans",
  finance_readonly: "Finans – sadece görüntüleme",
  hakedis_prepare: "Hakediş ve maaş hazırlama",
  stock_manage: "Stok yönetimi",
  stock_cost_view: "Stok maliyetlerini görme",
  crm_manage: "CRM yönetimi",
  clinical: "Klinik kayıtlar",
};

/** Only a holder of 'finance' may grant or revoke these (enforced by the database). */
export const FINANCE_PERMISSIONS: readonly Permission[] = ["finance", "finance_readonly"];

/**
 * Only the clinic owner may grant or revoke these (enforced by the database: 'stock_manage' since 0024,
 * 'hakedis_prepare' since 0031). 'stock_cost_view' is the owner's or a 'finance' holder's (0024).
 */
export const OWNER_GRANTED_PERMISSIONS: readonly Permission[] = ["stock_manage", "hakedis_prepare"];

type Granter = {
  /** users.role of the signed-in user */
  role?: string | null;
  /** the signed-in user holds 'finance' */
  holdsFinance: boolean;
};

/**
 * Why the signed-in user may not grant or revoke `permission` (the database refuses it), or null when they may. Same
 * rules as grant_staff_permission / revoke_staff_permission; the owner-of-an-owner rule is checked by the caller.
 */
export function permissionGrantLock(permission: Permission, granter: Granter): string | null {
  const isOwner = granter.role === "owner";
  if (FINANCE_PERMISSIONS.includes(permission) && !granter.holdsFinance) {
    return "Finans yetkilerini yalnızca finans yetkisi olan kullanıcılar verebilir.";
  }
  if (permission === "stock_manage" && !isOwner) {
    return "Stok yönetim yetkisini yalnızca klinik sahibi verebilir veya kaldırabilir.";
  }
  if (permission === "hakedis_prepare" && !isOwner) {
    return "Hakediş ve maaş hazırlama yetkisini yalnızca klinik sahibi verebilir veya kaldırabilir.";
  }
  if (permission === "stock_cost_view" && !isOwner && !granter.holdsFinance) {
    return "Stok maliyet yetkisini yalnızca klinik sahibi veya finans yetkisi olan kullanıcılar verebilir.";
  }
  return null;
}

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

/**
 * The 'Hakediş ve maaş' section (/hakedis, 0031): its layout guard and menu item. Same keys as
 * fin__hk_require_prep_read().
 */
export const HAKEDIS_READ_PERMISSIONS: readonly Permission[] = ["finance", "finance_readonly", "hakedis_prepare"];

/**
 * Hakediş and payroll preparation (0031): every payee's month calculation and the rules, read-only. Finance holders
 * and 'hakedis_prepare' holders; the latter never see ledger data (payments, paid / remaining amounts).
 */
export function canSeeHakedis(user: WithPermissions): boolean {
  return HAKEDIS_READ_PERMISSIONS.some((p) => hasPermission(user, p));
}

/**
 * Entering hakediş data (lines, implants, patient marks, lab costs, bonuses) in open months: 'finance' or
 * 'hakedis_prepare'. Rules, settings and closing a month stay with 'finance' (reopening with the owner).
 */
export function canPrepareHakedis(user: WithPermissions): boolean {
  return hasPermission(user, "finance") || hasPermission(user, "hakedis_prepare");
}
