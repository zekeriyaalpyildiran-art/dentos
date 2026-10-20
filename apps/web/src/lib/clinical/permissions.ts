// UI hints for the clinical screens (spec p9_clinical §1.2). The server's `flags` always win once a response is in;
// these only decide what to show before the first response.

import { hasPermission } from "../permissions";

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

/**
 * Lab jobs of the caller's own doctor record only (owner's decision 2026-10-20, enforced by the server since 0036:
 * clin_can_view_all_lab_orders()): role 'doctor' without 'finance' / 'finance_readonly'. A server response decides;
 * a response without lab_own_only means the server does not scope; the role decides only before the first response.
 */
export function labOwnOnly(user: UserLike, flags?: { lab_own_only?: boolean } | null): boolean {
  if (flags) return flags.lab_own_only === true; // a response without the key predates 0036 (or follows its rollback): the server does not scope
  if (!user) return false;
  return user.role === "doctor" && !hasPermission(user, "finance") && !hasPermission(user, "finance_readonly");
}

/** Server text of CL_LAB_NO_DOCTOR (0036): a doctor account without a doctor record cannot open a lab job. */
export const LAB_NO_DOCTOR_TEXT =
  "Hesabınıza bağlı hekim kaydı bulunamadı. Lab işi açmak için klinik yöneticisine başvurun.";

/** The signed-in user's own doctor record among `doctors` (doctors.user_id = AuthUser.user_id), or null. */
export function ownDoctor<T extends { user_id: string | null }>(
  doctors: readonly T[],
  user: { user_id?: string | null } | null | undefined
): T | null {
  if (!user?.user_id) return null;
  return doctors.find((d) => d.user_id === user.user_id) ?? null;
}
