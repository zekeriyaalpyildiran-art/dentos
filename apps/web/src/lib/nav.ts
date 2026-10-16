// Panel menu and role start pages. The menu only hides what a user cannot open; every page and RPC enforces its own
// rules, so nothing here is a security boundary.

import type { UserRole } from "./auth";
import { canSeeFinance } from "./permissions";

type NavUser = { role?: string | null; permissions?: readonly string[] } | null | undefined;

/** Counts shown next to a menu item (see useMenuBadges). */
export type MenuBadgeKey = "crm" | "tasks" | "stock";

export interface MenuItem {
  name: string;
  href: string;
  /** Marks the item active for every page under this prefix (CRM sub-pages, finance, stock). */
  match?: string;
  /** Never active for this path or its sub-pages, even under `match`. */
  exclude?: string;
  badge?: MenuBadgeKey;
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
  { name: "📞 CRM · Bugün", href: "/crm/today", badge: "crm" },
  { name: "📊 CRM", href: "/crm/leads", match: "/crm", exclude: "/crm/today" },
  { name: "✅ Görevler", href: "/tasks", badge: "tasks" },
  { name: "🧪 Lab", href: "/lab" },
  { name: "🔩 İmplantlar", href: "/clinical/implants", match: "/clinical" },
  { name: "📦 Stok", href: "/inventory", match: "/inventory", badge: "stock" },
  { name: "👔 Ekip", href: "/team" },
  { name: "📈 Raporlar", href: "/reports" },
  // Finance pages require 'finance' or 'finance_readonly' (FinanceShell); the role alone gives nothing.
  { name: "💰 Finans", href: "/finance", match: "/finance", visible: canSeeFinance },
  { name: "⚙️ Ayarlar", href: "/settings" },
];

/**
 * Sections a role does not use (owner's choice, 2026-10-16: assistants work on the agenda, patients, stock, lab and
 * implants, not on CRM, staff or reports). Such a section is left out of that role's menu, and the section's own
 * layout (app/(panel)/<section>/layout.tsx) refuses the role, so a typed address does not open it either.
 */
export const SECTIONS_CLOSED_FOR: Readonly<Record<string, readonly UserRole[]>> = {
  "/crm": ["assistant"],
  "/team": ["assistant"],
  "/reports": ["assistant"],
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
  const section = sectionOf(item.href);
  return !!section && !!role && (SECTIONS_CLOSED_FOR[section] as readonly string[]).includes(role);
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

/** Badge text: hidden at 0, capped at 99+. */
export function badgeText(n: number | null | undefined): string | null {
  if (!n || n <= 0 || !Number.isFinite(n)) return null;
  return n > 99 ? "99+" : String(Math.floor(n));
}
