// Panel menu and role start pages. The menu only hides what a user cannot open; every page and RPC enforces its own
// rules, so nothing here is a security boundary.

import type { UserRole } from "./auth";
import { canSeeFinance, canSeeHakedis } from "./permissions";

type NavUser = { role?: string | null; permissions?: readonly string[] } | null | undefined;

/** Counts shown next to a menu item (see useMenuBadges). */
export type MenuBadgeKey = "crm" | "tasks" | "stock" | "roomRequests";

export interface MenuItem {
  name: string;
  href: string;
  /** Marks the item active for every page under this prefix (CRM sub-pages, finance, stock). */
  match?: string;
  /** Never active for this path or its sub-pages, even under `match`. */
  exclude?: string;
  /** Counts shown on the row, in this order; each is hidden while its count is 0 or not loaded. */
  badges?: readonly MenuBadgeKey[];
  /** Shown only when this returns true; the same rule the page itself enforces. */
  visible?: (user: NavUser) => boolean;
}

/**
 * Menu order. 'Hatırlatmalar' (/reminders) and 'Mesajlar' (/messages) are left out on purpose: automatic SMS is not
 * active and reminders are done from CRM · Bugün. Their routes still work for direct links.
 */
export const MENU_ITEMS: readonly MenuItem[] = [
  { name: "📅 Ajanda", href: "/appointments" },
  { name: "👥 Hastalar", href: "/patients" },
  { name: "🦷 Tedavi Planları", href: "/treatment-plans" },
  { name: "📞 CRM · Bugün", href: "/crm/today", badges: ["crm"] },
  { name: "📊 CRM", href: "/crm/leads", match: "/crm", exclude: "/crm/today" },
  { name: "✅ Görevler", href: "/tasks", badges: ["tasks"] },
  { name: "🧪 Lab", href: "/lab" },
  { name: "🔩 İmplantlar", href: "/clinical/implants", match: "/clinical" },
  // Red: critical cards. Amber: open room requests ('Son kutu' reports among them), loaded for stock managers only.
  { name: "📦 Stok", href: "/inventory", match: "/inventory", badges: ["stock", "roomRequests"] },
  { name: "👔 Ekip", href: "/team" },
  { name: "📈 Raporlar", href: "/reports" },
  // Finance pages require 'finance' or 'finance_readonly' (FinanceShell); the role alone gives nothing.
  { name: "💰 Finans", href: "/finance", match: "/finance", visible: canSeeFinance },
  // The doctor's own hakediş (hk_my_* RPCs: only the caller's figures). Doctors and the owner; see SECTIONS_CLOSED_FOR.
  { name: "💼 Hakedişim", href: "/hakedisim" },
  // Own-portfolio doctor and birth date of patients, entered at the reception (hk_marks_* RPCs: no amounts). Reception,
  // admins and the owner; see SECTIONS_CLOSED_FOR.
  { name: "🏷️ Hasta işaretleri", href: "/hasta-isaretleri" },
  // Hakediş and payroll preparation (0031): 'hakedis_prepare' (the reception, without the finance permission) and
  // finance holders; the section's layout requires the same permissions, whatever the role.
  { name: "💼 Hakediş ve maaş", href: "/hakedis", match: "/hakedis", visible: canSeeHakedis },
  { name: "⚙️ Ayarlar", href: "/settings" },
];

/**
 * Sections a role does not use (owner's choice, 2026-10-16: assistants work on the agenda, patients, stock, lab and
 * implants, not on CRM, staff or reports). Such a section is left out of that role's menu, and the section's own
 * layout (app/(panel)/<section>/layout.tsx) refuses the role, so a typed address does not open it either.
 * Doctors (owner's decision 2026-10-20) do not use CRM, İmplantlar, Raporlar or Ekip either; the implants of a
 * patient stay on the patient card (only the /clinical section is closed), and the Lab stays, limited by the server
 * to the doctor's own jobs (0036). The closure goes by role: a doctor holding 'crm_manage' or 'clinical' still does
 * not get these sections.
 * Hakedişim is for the payees only: doctors and the owner (management share); reception has no hakediş.
 * Hasta işaretleri (owner's decision 2026-10-18) is for the reception desk: reception, admins and the owner mark the
 * patients; assistants and doctors (the payees) do not.
 */
export const SECTIONS_CLOSED_FOR: Readonly<Record<string, readonly UserRole[]>> = {
  "/crm": ["assistant", "doctor"],
  "/clinical": ["doctor"],
  "/team": ["assistant", "doctor"],
  "/reports": ["assistant", "doctor"],
  "/hakedisim": ["reception", "assistant", "admin"],
  "/hasta-isaretleri": ["assistant", "doctor"],
};

function sectionOf(href: string): string | undefined {
  return Object.keys(SECTIONS_CLOSED_FOR).find((s) => href === s || href.startsWith(s + "/"));
}

/** Roles that may open a section of SECTIONS_CLOSED_FOR (for that section's layout guard). */
export function rolesAllowedFor(section: string): UserRole[] {
  const closed = SECTIONS_CLOSED_FOR[section] ?? [];
  return (Object.keys(ROLE_HOME) as UserRole[]).filter((role) => !closed.includes(role));
}

function closedFor(item: MenuItem, role: string | null | undefined): boolean {
  return !canOpenPath(role, item.href);
}

/**
 * False when `href` (a panel path, query and fragment ignored) lies in a section of SECTIONS_CLOSED_FOR that is closed
 * to this role. Pages other roles share (Görevler, the patient card, the patient form…) use it to show a link into
 * such a section as plain text, or to leave the button out, instead of a link the section's layout would refuse.
 * A missing role (user not loaded) is not refused here; the section's layout still is the guard.
 */
export function canOpenPath(role: string | null | undefined, href: string): boolean {
  const path = href.split(/[?#]/, 1)[0];
  const section = sectionOf(path);
  return !section || !role || !(SECTIONS_CLOSED_FOR[section] as readonly string[]).includes(role);
}

export function menuItemsFor(user: NavUser): MenuItem[] {
  return MENU_ITEMS.filter((item) => (!item.visible || item.visible(user)) && !closedFor(item, user?.role));
}

export function isMenuItemActive(item: MenuItem, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === item.href) return true;
  if (!item.match || !pathname.startsWith(item.match + "/")) return false;
  const ex = item.exclude;
  return !(ex && (pathname === ex || pathname.startsWith(ex + "/")));
}

/**
 * Start page per role: after login and whenever /dashboard is opened (also the installed app's start_url).
 * Every target must be a page all roles may open, because ProtectedRoute sends refused users to /dashboard.
 */
export const ROLE_HOME: Record<UserRole, string> = {
  owner: "/crm/today",
  admin: "/crm/today",
  doctor: "/appointments",
  assistant: "/inventory",
  reception: "/crm/today",
};

/** For a role this build does not know yet. */
export const DEFAULT_HOME = "/appointments";

export function homePathFor(role: string | null | undefined): string {
  return role && Object.prototype.hasOwnProperty.call(ROLE_HOME, role) ? ROLE_HOME[role as UserRole] : DEFAULT_HOME;
}

/**
 * The owner starts on Finans (owner's choice, 2026-10-15). Finance pages are gated by permission, not by role, so the
 * owner goes there only while holding 'finance' or 'finance_readonly'; otherwise the role's start page (no loop via
 * /dashboard).
 */
export const OWNER_FINANCE_HOME = "/finance";

export function homePathForUser(user: NavUser): string {
  if (user?.role === "owner" && canSeeFinance(user)) return OWNER_FINANCE_HOME;
  return homePathFor(user?.role);
}

/**
 * What each menu count means. The number alone said nothing (and its tooltip never shows on a phone), so it carries a
 * short word ('9 kritik') and is its own link to the list behind it.
 */
export const MENU_BADGES: Record<MenuBadgeKey, { short: string; label: (n: number) => string; href: string }> = {
  crm: { short: "iş", label: (n) => `Günlük listede ${n} iş`, href: "/crm/today" },
  tasks: { short: "görev", label: (n) => `${n} açık görev`, href: "/tasks" },
  stock: {
    short: "kritik",
    label: (n) => `${n} kritik stok kartı (en düşük seviyede veya tükenmiş); listeyi aç`,
    href: "/inventory/items?status=critical",
  },
  // Open = waiting for approval or delivery. The requests page opens on the room tab with 'Açık' selected.
  roomRequests: {
    short: "talep",
    label: (n) => `${n} açık oda talebi (onay veya teslim bekliyor); listeyi aç`,
    href: "/inventory/requests",
  },
};

export function menuBadge(
  key: MenuBadgeKey | undefined,
  n: number | null | undefined,
): { text: string; label: string; href: string } | null {
  const count = badgeText(n);
  if (!key || !count || n === null || n === undefined) return null;
  const meta = MENU_BADGES[key];
  return { text: `${count} ${meta.short}`, label: meta.label(n), href: meta.href };
}

/**
 * Screen-reader name of the phone's menu button, with what waits inside the drawer:
 * "Menüyü aç, 3 açık görev, 4 açık oda talebi" (zero or missing counts are left out).
 */
export function menuButtonLabel(badges: Partial<Record<MenuBadgeKey, number>>): string {
  const parts = ["Menüyü aç"];
  if (badgeText(badges.tasks)) parts.push(`${Math.floor(badges.tasks as number)} açık görev`);
  if (badgeText(badges.roomRequests)) parts.push(`${Math.floor(badges.roomRequests as number)} açık oda talebi`);
  return parts.join(", ");
}

/** Badge text: hidden at 0, capped at 99+. */
export function badgeText(n: number | null | undefined): string | null {
  if (!n || n <= 0 || !Number.isFinite(n)) return null;
  return n > 99 ? "99+" : String(Math.floor(n));
}
