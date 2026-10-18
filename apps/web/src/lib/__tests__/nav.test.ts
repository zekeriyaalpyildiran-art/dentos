// Panel menu and role start pages (lib/nav.ts). Synthetic users only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME,
  MENU_BADGES,
  MENU_ITEMS,
  ROLE_HOME,
  badgeText,
  canOpenPath,
  OWNER_FINANCE_HOME,
  homePathFor,
  homePathForUser,
  isMenuItemActive,
  menuBadge,
  menuButtonLabel,
  menuItemsFor,
  rolesAllowedFor,
  SECTIONS_CLOSED_FOR,
  type MenuItem,
} from "../nav";
import { STAFF_ROLES } from "../staff";

const PANEL_DIR = fileURLToPath(new URL("../../app/(panel)", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));

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

  it("puts the badges on CRM · Bugün, Görevler and Stok (critical cards, then open room requests)", () => {
    const badged = Object.fromEntries(MENU_ITEMS.flatMap((i) => (i.badges ?? []).map((key) => [key, i.href])));
    expect(badged).toEqual({ crm: "/crm/today", tasks: "/tasks", stock: "/inventory", roomRequests: "/inventory" });
    expect(MENU_ITEMS.find((i) => i.href === "/inventory")?.badges).toEqual(["stock", "roomRequests"]);
  });

  it("uses every badge key exactly once", () => {
    const keys = MENU_ITEMS.flatMap((i) => i.badges ?? []);
    expect([...keys].sort()).toEqual(Object.keys(MENU_BADGES).sort());
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

describe("Hakedişim (the payee's own hakediş)", () => {
  it("is in the menu of doctors and the owner only, right after Finans", () => {
    for (const role of ["doctor", "owner"]) expect(hrefs(menuItemsFor(user(role))), role).toContain("/hakedisim");
    for (const role of ["reception", "assistant", "admin"]) {
      expect(hrefs(menuItemsFor(user(role, ["finance"]))), role).not.toContain("/hakedisim");
    }
    const list = hrefs(menuItemsFor(user("owner", ["finance"])));
    expect(list.indexOf("/hakedisim")).toBe(list.indexOf("/finance") + 1);
    expect(MENU_ITEMS.find((i) => i.href === "/hakedisim")?.name).toBe("💼 Hakedişim");
  });

  it("is closed to reception, assistants and admins, typed addresses included", () => {
    expect([...rolesAllowedFor("/hakedisim")].sort()).toEqual(["doctor", "owner"]);
    for (const role of ["reception", "assistant", "admin"]) {
      for (const href of ["/hakedisim", "/hakedisim?month=2026-11"]) expect(canOpenPath(role, href), `${role} ${href}`).toBe(false);
    }
    for (const role of ["doctor", "owner"]) expect(canOpenPath(role, "/hakedisim"), role).toBe(true);
    // The finance Hakediş pages are gated by the finance permission, not by this section.
    expect(canOpenPath("reception", "/finance/hakedis")).toBe(true);
    expect(canOpenPath("assistant", "/hakedisimx")).toBe(true);
  });

  it("does not change anyone's start page", () => {
    for (const role of STAFF_ROLES) expect(homePathFor(role).startsWith("/hakedisim"), role).toBe(false);
    expect(homePathForUser({ role: "doctor", permissions: [] })).toBe(ROLE_HOME.doctor);
  });

  it("reads only the self-service RPCs (no finance permission needed, only the caller's figures)", () => {
    const src = pageSource("/hakedisim");
    expect(src).not.toBeNull();
    expect(src).toMatch(/\bhkMyMonths\(/);
    expect(src).toMatch(/\bhkMyMonth\(/);
    expect(src).not.toMatch(/\bfinHk[A-Z]\w*\(|FinanceShell|requiredPermission/);
  });
});

describe("Hasta işaretleri (patient marks at the reception desk)", () => {
  it("is in the menu of reception, admins and the owner, finance permission or not, right after Hakedişim", () => {
    for (const role of ["reception", "admin", "owner"]) {
      for (const perms of [[], ["finance"], ["finance_readonly"]]) {
        expect(hrefs(menuItemsFor(user(role, perms))), `${role} ${perms}`).toContain("/hasta-isaretleri");
      }
    }
    for (const role of ["assistant", "doctor"]) {
      expect(hrefs(menuItemsFor(user(role, ["finance"]))), role).not.toContain("/hasta-isaretleri");
    }
    const owner = hrefs(menuItemsFor(user("owner", ["finance"])));
    expect(owner.indexOf("/hasta-isaretleri")).toBe(owner.indexOf("/hakedisim") + 1);
    const reception = hrefs(menuItemsFor(user("reception")));
    expect(reception.indexOf("/hasta-isaretleri")).toBe(reception.indexOf("/settings") - 1);
    expect(MENU_ITEMS.find((i) => i.href === "/hasta-isaretleri")?.name).toBe("🏷️ Hasta işaretleri");
  });

  it("is closed to assistants and doctors, typed addresses included", () => {
    expect([...rolesAllowedFor("/hasta-isaretleri")].sort()).toEqual(["admin", "owner", "reception"]);
    for (const role of ["assistant", "doctor"]) {
      for (const href of ["/hasta-isaretleri", "/hasta-isaretleri?q=x", "/hasta-isaretleri#liste"]) {
        expect(canOpenPath(role, href), `${role} ${href}`).toBe(false);
      }
    }
    for (const role of ["reception", "admin", "owner"]) expect(canOpenPath(role, "/hasta-isaretleri"), role).toBe(true);
    expect(canOpenPath("doctor", "/hasta-isaretlerix")).toBe(true);
    // The finance marks editor (Hakediş · Satırlar ve hastalar) is gated by the finance permission, not this section.
    expect(canOpenPath("doctor", "/finance/hakedis/lines")).toBe(true);
  });

  it("does not change anyone's start page", () => {
    for (const role of STAFF_ROLES) expect(homePathFor(role).startsWith("/hasta-isaretleri"), role).toBe(false);
    expect(homePathForUser({ role: "reception", permissions: [] })).toBe(ROLE_HOME.reception);
  });

  it("uses only the marking RPCs: no finance permission, no hakediş figures, no amounts", () => {
    const src = pageSource("/hasta-isaretleri");
    expect(src).not.toBeNull();
    expect(src).toMatch(/\bhkMarksAccess\(/);
    expect(src).toMatch(/\bhkMarksList\(/);
    expect(src).toMatch(/\bhkSaveMark\(/);
    expect(src).not.toMatch(/\bfinHk[A-Z]\w*\(|\bhkMy[A-Z]\w*\(|FinanceShell|requiredPermission/);
    expect(src).not.toMatch(/\b(formatTL|formatMoney|parseTL)\b|_cents\b|_bp\b/);
  });
});

describe("canOpenPath (links from shared pages)", () => {
  it("refuses assistants every path of CRM, Ekip and Raporlar, query and fragment ignored", () => {
    for (const href of [
      "/crm",
      "/crm/today",
      "/crm/leads/0b6c3c8e-1d2f-4a8b-9c1d-2e3f4a5b6c7d",
      "/crm/leads?stage=new",
      "/crm/today#work",
      "/team",
      "/team/abc",
      "/reports",
      "/reports?month=2026-10",
    ]) {
      expect(canOpenPath("assistant", href), href).toBe(false);
    }
  });

  it("lets assistants open everything else, mal kabul and the rest of stock included", () => {
    for (const href of [
      "/appointments",
      "/appointments?date=2026-10-16",
      "/patients/abc",
      "/tasks",
      "/inventory",
      "/inventory/receipt",
      "/inventory/requests",
      "/inventory/reports",
      "/finance/reports",
      "/crm-archive",
      "/teams",
    ]) {
      expect(canOpenPath("assistant", href), href).toBe(true);
    }
  });

  it("lets every other role open the closed sections, and does not guess for a user not loaded yet", () => {
    for (const role of ["owner", "admin", "doctor", "reception"]) {
      for (const href of ["/crm/today", "/crm/leads/x", "/team", "/reports"]) expect(canOpenPath(role, href), role).toBe(true);
    }
    expect(canOpenPath(null, "/crm/today")).toBe(true);
    expect(canOpenPath(undefined, "/team")).toBe(true);
  });

  it("is the rule the menu uses", () => {
    for (const role of STAFF_ROLES) {
      const shown = hrefs(menuItemsFor(user(role, ["finance"])));
      for (const item of MENU_ITEMS) expect(shown.includes(item.href), `${role} ${item.href}`).toBe(canOpenPath(role, item.href));
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("links into closed sections from shared pages", () => {
  const sections = Object.keys(SECTIONS_CLOSED_FOR);
  const linkRe = new RegExp(`["'\`](${sections.map((s) => s.replace("/", "\\/")).join("|")})(?=[/"'\`?#])`);
  const rel = (file: string) => relative(SRC_DIR, file).split(sep).join("/");
  const files = sourceFiles(SRC_DIR).map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));
  const inClosedSection = (path: string) => sections.some((s) => path.startsWith(`app/(panel)${s}/`));

  /** Components rendered only on a closed section's own pages: the named export and where it is defined. */
  const SECTION_ONLY: Record<string, string> = {
    "components/crm/DaySummary.tsx": "DaySummary",
    "components/crm/OverdueDialog.tsx": "OverdueDialog",
    "components/crm/ui.tsx": "CrmShell",
  };

  it("finds the links it guards (the check is not vacuous)", () => {
    const tasks = files.find((f) => f.path === "app/(panel)/tasks/page.tsx");
    expect(tasks && linkRe.test(tasks.text)).toBe(true);
  });

  it("every file outside those sections that links into one asks canOpenPath / useCanOpenPath", () => {
    const offenders = files
      .filter((f) => linkRe.test(f.text))
      .filter((f) => !inClosedSection(f.path) && f.path !== "lib/nav.ts" && !(f.path in SECTION_ONLY))
      .filter((f) => !/\b(useCanOpenPath|canOpenPath)\(/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the components allowed to link freely are used only inside the closed sections", () => {
    for (const [path, name] of Object.entries(SECTION_ONLY)) {
      expect(files.some((f) => f.path === path && f.text.includes(`export function ${name}`)), path).toBe(true);
      const base = path.replace(/^.*\//, "").replace(/\.tsx?$/, "");
      const importRe = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*/${base}["']`);
      const users = files.filter((f) => f.path !== path && importRe.test(f.text)).map((f) => f.path);
      expect(users.length, name).toBeGreaterThan(0);
      for (const u of users) expect(inClosedSection(u) || u in SECTION_ONLY, `${name} used in ${u}`).toBe(true);
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

  it("counts open room requests as 'n talep' and opens the room tab of Talepler", () => {
    expect(menuBadge("roomRequests", 2)).toEqual({
      text: "2 talep",
      label: "2 açık oda talebi (onay veya teslim bekliyor); listeyi aç",
      href: "/inventory/requests",
    });
    expect(menuBadge("roomRequests", 0)).toBeNull();
    expect(menuBadge("roomRequests", 120)?.text).toBe("99+ talep");
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

describe("menuButtonLabel (phone menu button)", () => {
  it("names the open tasks and, for stock managers, the open room requests", () => {
    expect(menuButtonLabel({})).toBe("Menüyü aç");
    expect(menuButtonLabel({ tasks: 3 })).toBe("Menüyü aç, 3 açık görev");
    expect(menuButtonLabel({ roomRequests: 4 })).toBe("Menüyü aç, 4 açık oda talebi");
    expect(menuButtonLabel({ tasks: 3, roomRequests: 4, stock: 9 })).toBe("Menüyü aç, 3 açık görev, 4 açık oda talebi");
    expect(menuButtonLabel({ tasks: 0, roomRequests: 0 })).toBe("Menüyü aç");
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
