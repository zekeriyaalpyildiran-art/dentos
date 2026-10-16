"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuthStore } from "@/lib/store";
import { ROLE_LABELS, signOut, type AuthUser } from "@/lib/auth";
import { clearStockStorage } from "@/lib/stock/storage";
import { badgeText, isMenuItemActive, menuItemsFor, type MenuBadgeKey, type MenuItem } from "@/lib/nav";
import { useMenuBadges, type MenuBadges } from "@/components/useMenuBadges";
import { ClinicLogo, ClinicMark } from "@/components/ClinicLogo";
import { ThemeSwitch } from "@/components/ThemeSwitch";

const DRAWER_ID = "panel-mobile-menu";
/** Tailwind `md`: from here on the fixed sidebar is shown and the drawer is not used. */
const DESKTOP_QUERY = "(min-width: 768px)";
/** Keyboard focus on the navy background. */
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white";

const BADGES: Record<MenuBadgeKey, { label: (n: number) => string; className: string }> = {
  crm: { label: (n) => `Günlük listede ${n} iş`, className: "bg-blue-600 text-white" },
  tasks: { label: (n) => `${n} açık görev`, className: "bg-blue-600 text-white" },
  stock: { label: (n) => `${n} kritik stok kartı`, className: "bg-red-600 text-white" },
};

function NavList({
  items,
  pathname,
  badges,
  roomy,
  onNavigate,
}: {
  items: MenuItem[];
  pathname: string | null;
  badges: MenuBadges;
  /** Taller rows for touch screens. */
  roomy?: boolean;
  onNavigate?: () => void;
}) {
  // The current page's link is scrolled into view inside the menu (Finans, Stok, Ayarlar sit low in a long list).
  // Only the nav scrolls; scrollIntoView would also move the page or the drawer's backdrop.
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const link = activeRef.current;
    const nav = link?.closest("nav");
    if (!link || !nav) return;
    const l = link.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (l.top < n.top) nav.scrollTop -= n.top - l.top + 8;
    else if (l.bottom > n.bottom) nav.scrollTop += l.bottom - n.bottom + 8;
  }, [pathname]);

  return (
    <ul className="space-y-0.5 px-3">
      {items.map((item) => {
        const isActive = isMenuItemActive(item, pathname);
        const n = item.badge ? badges[item.badge] : undefined;
        const text = badgeText(n);
        const info = item.badge ? BADGES[item.badge] : null;
        return (
          <li key={item.href}>
            <Link
              ref={isActive ? activeRef : undefined}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-2 px-3 ${roomy ? "py-2.5" : "py-2"} rounded-lg transition-colors ${FOCUS} ${
                isActive
                  ? "bg-sidebar-accent font-semibold text-white shadow-[inset_3px_0_0_0_rgb(var(--sidebar-highlight))]"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white"
              }`}
            >
              <span className="min-w-0 flex-1">{item.name}</span>
              {text && info && n !== undefined && (
                <span
                  title={info.label(n)}
                  className={`shrink-0 min-w-[1.5rem] px-1.5 rounded-full text-xs font-semibold leading-5 text-center ${info.className}`}
                >
                  <span aria-hidden="true">{text}</span>
                  <span className="sr-only">{`, ${info.label(n)}`}</span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Logo, user, menu, appearance and logout; the same content in the desktop sidebar and the mobile drawer. */
function MenuPanel({
  user,
  items,
  pathname,
  badges,
  roomy,
  headerAction,
  onNavigate,
  onLogout,
}: {
  user: AuthUser | null;
  items: MenuItem[];
  pathname: string | null;
  badges: MenuBadges;
  roomy?: boolean;
  headerAction?: ReactNode;
  onNavigate?: () => void;
  onLogout: () => void;
}) {
  // Header and footer stay compact so a 1366x768 laptop still shows most of the 13 menu items without scrolling.
  return (
    <>
      {/* Header: the clinic logo on its light panel (as in the legacy apps), then the user with 'DentOS' on the role line */}
      <div className="px-4 py-3 border-b border-sidebar-border">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ClinicLogo priority compact className="max-w-[156px]" />
          </div>
          {headerAction}
        </div>
        <div className="mt-2 text-sm min-w-0">
          {user && (
            <p className="truncate font-medium text-sidebar-foreground" title={user.email}>
              {user.email}
            </p>
          )}
          <p className="flex items-baseline justify-between gap-2 text-sidebar-muted">
            <span className="min-w-0 truncate">{user ? ROLE_LABELS[user.role] || user.role : ""}</span>
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.25em]">DentOS</span>
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overscroll-contain py-2" aria-label="Ana menü">
        <NavList items={items} pathname={pathname} badges={badges} roomy={roomy} onNavigate={onNavigate} />
      </nav>

      {/* Footer */}
      <div className="px-3 py-2.5 space-y-2 border-t border-sidebar-border">
        <ThemeSwitch roomy={roomy} />
        <button
          type="button"
          onClick={onLogout}
          className={`w-full px-4 ${roomy ? "py-2.5" : "py-1.5"} text-sm text-sidebar-foreground border border-sidebar-border rounded-lg hover:bg-sidebar-accent hover:text-white transition-colors ${FOCUS}`}
        >
          Çıkış Yap
        </button>
      </div>
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const badges = useMenuBadges(user?.user_id);

  const handleLogout = async () => {
    try {
      // Per-viewer stock drafts (bulk cart with costs, count drafts) never outlive the session on a shared PC.
      clearStockStorage();
      await signOut();
      router.push("/login");
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  return <SidebarView user={user} pathname={pathname} badges={badges} onLogout={handleLogout} />;
}

/** The menu itself, without data fetching: mobile top bar + drawer below md, fixed navy sidebar from md. */
export function SidebarView({
  user,
  pathname,
  badges,
  onLogout,
}: {
  user: AuthUser | null;
  pathname: string | null;
  badges: MenuBadges;
  onLogout: () => void;
}) {
  const items = menuItemsFor(user);
  const current = items.find((item) => isMenuItemActive(item, pathname));

  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // Close the drawer whenever the page changes (back / forward included).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Focus moves into the drawer when it opens and back to the menu button when it closes.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      closeButtonRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [open]);

  // While open: Escape closes, Tab stays inside the drawer, and widening to desktop closes it.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      const drawer = drawerRef.current;
      if (e.key !== "Tab" || !drawer) return;
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = !!active && drawer.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onBreakpoint = () => {
      if (desktop.matches) setOpen(false);
    };
    onBreakpoint();

    document.addEventListener("keydown", onKeyDown);
    desktop.addEventListener("change", onBreakpoint);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener("change", onBreakpoint);
    };
  }, [open]);

  const myTasks = badgeText(badges.tasks);

  return (
    <>
      {/* Mobile top bar (below md). Navigation is not printed: the navy colours would print as pale text on paper. */}
      <header className="md:hidden print:hidden flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 text-sidebar-foreground">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label={myTasks ? `Menüyü aç, ${badges.tasks} açık görev` : "Menüyü aç"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? DRAWER_ID : undefined}
          className={`relative inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-sidebar-accent ${FOCUS}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {myTasks && (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-sidebar"
            />
          )}
        </button>
        <ClinicMark className="h-9 w-9 shrink-0" />
        <span className="text-lg font-bold text-white">DentOS</span>
        {current && <span className="ml-auto min-w-0 truncate pr-2 text-sm text-sidebar-muted">{current.name}</span>}
      </header>

      {/* Desktop sidebar (md and up) */}
      <aside className="hidden md:flex print:hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <MenuPanel user={user} items={items} pathname={pathname} badges={badges} onLogout={onLogout} />
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            ref={drawerRef}
            id={DRAWER_ID}
            role="dialog"
            aria-modal="true"
            aria-label="Menü"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-xl"
          >
            <MenuPanel
              user={user}
              items={items}
              pathname={pathname}
              badges={badges}
              roomy
              onNavigate={() => setOpen(false)}
              onLogout={onLogout}
              headerAction={
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Menüyü kapat"
                  className={`-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-sidebar-accent ${FOCUS}`}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-6 w-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              }
            />
          </div>
        </div>
      )}
    </>
  );
}
