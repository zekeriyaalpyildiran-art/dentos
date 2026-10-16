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

  it("shows every other item to every role (those pages have no role gate)", () => {
    const ungated = MENU_ITEMS.filter((i) => !i.visible).map((i) => i.href);
    for (const role of STAFF_ROLES) {
      expect(hrefs(menuItemsFor(user(role)))).toEqual(ungated);
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
