// Panel menu and role start pages (lib/nav.ts). Synthetic users only.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME,
  MENU_BADGES,
  MENU_ITEMS,
  ROLE_HOME,
  badgeText,
  OWNER_FINANCE_HOME,
  homePathFor,
  homePathForUser,
  isMenuItemActive,
  menuBadge,
  menuItemsFor,
  rolesAllowedFor,
  SECTIONS_CLOSED_FOR,
  type MenuItem,
} from "../nav";
import { STAFF_ROLES } from "../staff";

const PANEL_DIR = fileURLToPath(new URL("../../app/(panel)", import.meta.url));

function pageSource(href: string): string | null {
  const file = `${PANEL_DIR}${href}/page.tsx`;
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const user = (role: string, permissions: string[] = []) => ({ role, permissions });
const hrefs = (items: MenuItem[]) => items.map((i) => i.href);

describe("menuItemsFor", () => {
  it("never lists Hatırlatmalar or Mesajlar (routes stay, menu entries are gone)", () => {
    for (const role of STAFF_ROLES) {
      const list = hrefs(menuItemsFor(user(role, ["finance"])));
      expect(list).not.toContain("/reminders");
      expect(list).not.toContain("/messages");
    }
    expect(pageSource("/reminders")).not.toBeNull();
    expect(pageSource("/messages")).not.toBeNull();
  });

  it("shows Finans only to finance / finance_readonly holders, whatever the role", () => {
    expect(hrefs(menuItemsFor(user("owner")))).not.toContain("/finance");
    expect(hrefs(menuItemsFor(user("admin", ["crm_manage", "stock_manage"])))).not.toContain("/finance");
    expect(hrefs(menuItemsFor(user("reception", ["finance_readonly"])))).toContain("/finance");
    expect(hrefs(menuItemsFor(user("owner", ["finance"])))).toContain("/finance");
    expect(hrefs(menuItemsFor(null))).not.toContain("/finance");
  });

  it("keeps Finans right after Raporlar", () => {
    const list = hrefs(menuItemsFor(user("owner", ["finance"])));
    expect(list.indexOf("/finance")).toBe(list.indexOf("/reports") + 1);
  });

  it("shows every other item to every role, except sections closed to that role", () => {
    const ungated = MENU_ITEMS.filter((i) => !i.visible).map((i) => i.href);
    for (const role of STAFF_ROLES) {
      const closed = Object.entries(SECTIONS_CLOSED_FOR)
        .filter(([, roles]) => (roles as readonly string[]).includes(role))
        .map(([section]) => section);
      const expected = ungated.filter((href) => !closed.some((s) => href === s || href.startsWith(s + "/")));
      expect(hrefs(menuItemsFor(user(role))), role).toEqual(expected);
    }
  });

  it("points every item at an existing page", () => {
    for (const item of MENU_ITEMS) {
      expect(pageSource(item.href), item.href).not.toBeNull();
    }
  });

  it("puts the badges on CRM · Bugün, Görevler and Stok", () => {
    const badged = Object.fromEntries(MENU_ITEMS.filter((i) => i.badge).map((i) => [i.badge, i.href]));
    expect(badged).toEqual({ crm: "/crm/today", tasks: "/tasks", stock: "/inventory" });
  });
});

describe("isMenuItemActive", () => {
  const item = (href: string) => MENU_ITEMS.find((i) => i.href === href)!;

  it("matches the page itself and, with a prefix, its sub-pages", () => {
    expect(isMenuItemActive(item("/patients"), "/patients")).toBe(true);
    expect(isMenuItemActive(item("/patients"), "/patients/123")).toBe(false);
    expect(isMenuItemActive(item("/inventory"), "/inventory/items/1")).toBe(true);
    expect(isMenuItemActive(item("/clinical/implants"), "/clinical/brands")).toBe(true);
    expect(isMenuItemActive(item("/inventory"), "/inventoryx")).toBe(false);
  });

  it("keeps CRM · Bugün and CRM apart", () => {
    expect(isMenuItemActive(item("/crm/today"), "/crm/today")).toBe(true);
    expect(isMenuItemActive(item("/crm/leads"), "/crm/today")).toBe(false);
    expect(isMenuItemActive(item("/crm/leads"), "/crm/kanban")).toBe(true);
    expect(isMenuItemActive(item("/crm/leads"), "/crm/leads/abc")).toBe(true);
  });

  it("is false without a path", () => {
    expect(isMenuItemActive(item("/patients"), null)).toBe(false);
  });
});

describe("homePathFor", () => {
  it("maps each role to its start page", () => {
    expect(homePathFor("reception")).toBe("/crm/today");
    expect(homePathFor("assistant")).toBe("/inventory");
    expect(homePathFor("doctor")).toBe("/appointments");
    expect(homePathFor("owner")).toBe("/crm/today");
    expect(homePathFor("admin")).toBe("/crm/today");
  });

  it("has an entry for every staff role and falls back for anything else", () => {
    expect(Object.keys(ROLE_HOME).sort()).toEqual([...STAFF_ROLES].sort());
    expect(homePathFor("hygienist")).toBe(DEFAULT_HOME);
    expect(homePathFor("constructor")).toBe(DEFAULT_HOME);
    expect(homePathFor(null)).toBe(DEFAULT_HOME);
    expect(homePathFor(undefined)).toBe(DEFAULT_HOME);
  });

  it("sends the owner to Finans only while the owner can see finance", () => {
    expect(homePathForUser({ role: "owner", permissions: ["finance"] })).toBe(OWNER_FINANCE_HOME);
    expect(homePathForUser({ role: "owner", permissions: ["finance_readonly"] })).toBe(OWNER_FINANCE_HOME);
    expect(homePathForUser({ role: "owner", permissions: [] })).toBe(ROLE_HOME.owner);
    expect(homePathForUser({ role: "admin", permissions: ["finance"] })).toBe(ROLE_HOME.admin);
    expect(homePathForUser({ role: "reception", permissions: ["finance"] })).toBe(ROLE_HOME.reception);
    expect(homePathForUser(null)).toBe(DEFAULT_HOME);
    expect(pageSource(OWNER_FINANCE_HOME)).not.toBeNull();
  });

  it("only uses pages every role may open (a refused page sends the user to /dashboard)", () => {
    for (const target of [...Object.values(ROLE_HOME), DEFAULT_HOME]) {
      const src = pageSource(target);
      expect(src, target).not.toBeNull();
      expect(target).not.toBe("/dashboard");
      expect(src).not.toMatch(/allowedRoles|requiredPermission|FinanceShell/);
    }
  });
});

describe("sections closed for a role", () => {
  it("assistants do not see CRM, Ekip or Raporlar; everything else stays", () => {
    const list = hrefs(menuItemsFor(user("assistant")));
    expect(list).not.toContain("/crm/today");
    expect(list).not.toContain("/crm/leads");
    expect(list).not.toContain("/team");
    expect(list).not.toContain("/reports");
    for (const href of ["/appointments", "/patients", "/tasks", "/lab", "/clinical/implants", "/inventory", "/settings"]) {
      expect(list).toContain(href);
    }
  });

  it("other roles keep CRM, Ekip and Raporlar", () => {
    for (const role of ["owner", "admin", "doctor", "reception"]) {
      const list = hrefs(menuItemsFor(user(role)));
      expect(list, role).toEqual(expect.arrayContaining(["/crm/today", "/crm/leads", "/team", "/reports"]));
    }
  });

  it("each closed section has a layout that refuses exactly those roles", () => {
    for (const section of Object.keys(SECTIONS_CLOSED_FOR)) {
      const file = `${PANEL_DIR}${section}/layout.tsx`;
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8")).toContain(`rolesAllowedFor("${section}")`);
      const allowed = rolesAllowedFor(section);
      for (const role of SECTIONS_CLOSED_FOR[section]) expect(allowed).not.toContain(role);
      expect(allowed.length + SECTIONS_CLOSED_FOR[section].length).toBe(STAFF_ROLES.length);
    }
  });

  it("no role starts on a section closed to it", () => {
    for (const role of STAFF_ROLES) {
      const home = homePathFor(role);
      for (const [section, roles] of Object.entries(SECTIONS_CLOSED_FOR)) {
        if ((roles as readonly string[]).includes(role)) expect(home === section || home.startsWith(section + "/"), role).toBe(false);
      }
    }
  });
});

describe("menuBadge", () => {
  it("shows the count with a word and links to the list behind it", () => {
    expect(menuBadge("stock", 9)).toEqual({
      text: "9 kritik",
      label: "9 kritik stok kartı (en düşük seviyede veya tükenmiş); listeyi aç",
      href: "/inventory/items?status=critical",
    });
    expect(menuBadge("crm", 12)?.text).toBe("12 iş");
    expect(menuBadge("crm", 12)?.href).toBe("/crm/today");
    expect(menuBadge("tasks", 3)?.text).toBe("3 görev");
    expect(menuBadge("tasks", 3)?.href).toBe("/tasks");
    expect(menuBadge("tasks", 150)?.text).toBe("99+ görev");
  });

  it("is hidden at zero, without a key or without a number", () => {
    expect(menuBadge("stock", 0)).toBeNull();
    expect(menuBadge("stock", undefined)).toBeNull();
    expect(menuBadge(undefined, 5)).toBeNull();
  });

  it("every badge target is a page that exists", () => {
    for (const key of Object.keys(MENU_BADGES) as (keyof typeof MENU_BADGES)[]) {
      expect(pageSource(MENU_BADGES[key].href.split("?")[0]), key).not.toBeNull();
    }
  });
});

describe("badgeText", () => {
  it("hides zero and invalid values and caps at 99+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(null)).toBeNull();
    expect(badgeText(-3)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(7)).toBe("7");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });
});
