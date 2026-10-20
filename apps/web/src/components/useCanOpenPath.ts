"use client";

import { useAuthStore } from "@/lib/store";
import { canOpenPath } from "@/lib/nav";

/**
 * Whether the signed-in user's role may open `href` (lib/nav.ts SECTIONS_CLOSED_FOR). Shared pages use it to leave out
 * links into a section closed to the role (CRM, Ekip, Raporlar for assistants and doctors; İmplantlar for doctors) or
 * show them as plain text.
 */
export function useCanOpenPath(href: string): boolean {
  const role = useAuthStore((s) => s.user?.role);
  return canOpenPath(role, href);
}
