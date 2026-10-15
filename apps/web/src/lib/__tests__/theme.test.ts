// Light / dark theme: preference helpers, the inline init script, the palette in globals.css (every themed shade
// defined in both themes, WCAG contrast of the main text pairs) and a guard against unthemed colour families.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT, THEME_OPTIONS, THEME_STORAGE_KEY, parseThemePreference, resolveTheme } from "../theme";
import { THEMED_FAMILIES, THEME_SHADES } from "../theme-colors";
import tailwindConfig from "../../../tailwind.config";

const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(SRC_DIR, "app/globals.css"), "utf8");

describe("theme preference", () => {
  it("defaults to light for anything unknown", () => {
    expect(parseThemePreference(null)).toBe("light");
    expect(parseThemePreference("")).toBe("light");
    expect(parseThemePreference("DARK")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
  });

  it("resolves 'system' from the OS setting only", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("offers Açık / Koyu / Sistem", () => {
    expect(THEME_OPTIONS.map((o) => o.label)).toEqual(["Açık", "Koyu", "Sistem"]);
  });
});

describe("THEME_INIT_SCRIPT", () => {
  function run(stored: string | null | Error, systemDark = false): string[] {
    const classes: string[] = [];
    const localStorage = {
      getItem: (key: string) => {
        if (stored instanceof Error) throw stored;
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const window = { matchMedia: () => ({ matches: systemDark }) };
    const document = { documentElement: { classList: { add: (c: string) => classes.push(c) } } };
    new Function("localStorage", "window", "document", THEME_INIT_SCRIPT)(localStorage, window, document);
    return classes;
  }

  it("adds 'dark' only for a dark choice, or 'Sistem' on a dark OS", () => {
    expect(run("dark")).toEqual(["dark"]);
    expect(run("system", true)).toEqual(["dark"]);
    expect(run("system", false)).toEqual([]);
    expect(run("light", true)).toEqual([]);
    expect(run(null, true)).toEqual([]);
  });

  it("never throws when storage is blocked (stays light)", () => {
    expect(run(new Error("SecurityError"))).toEqual([]);
  });
});

/** "--name: r g b;" pairs of the first `selector {` block in globals.css (the blocks hold no nested braces). */
function block(selector: string): Map<string, string> {
  const start = CSS.search(new RegExp(`\\n\\s*${selector.replace(".", "\\.")} \\{`));
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  const body = CSS.slice(start, CSS.indexOf("}", start));
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*(\d+ \d+ \d+);/g)) vars.set(m[1], m[2]);
  return vars;
}

const LIGHT = block(":root");
const DARK = block(".dark");

function rgb(vars: Map<string, string>, name: string): number[] {
  // Dark redefines what it changes; the rest comes from :root, as in the browser.
  const value = vars.get(name) ?? LIGHT.get(name);
  expect(value, name).toBeDefined();
  return (value as string).split(" ").map(Number);
}

const WHITE = [255, 255, 255];

function luminance([r, g, b]: number[]): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("globals.css palette", () => {
  it("defines every themed shade in both themes; dark redefines the text ink of 400-950", () => {
    for (const family of THEMED_FAMILIES) {
      for (const shade of THEME_SHADES) {
        expect(LIGHT.has(`--c-${family}-${shade}`), `light ${family}-${shade}`).toBe(true);
        expect(DARK.has(`--c-${family}-${shade}`), `dark ${family}-${shade}`).toBe(true);
        if (shade >= 400) expect(DARK.has(`--c-${family}-${shade}-ink`), `dark ink ${family}-${shade}`).toBe(true);
      }
    }
    for (const token of ["background", "foreground", "surface", "border", "input", "brand-panel", "sidebar", "sidebar-foreground"]) {
      expect(LIGHT.has(`--${token}`), token).toBe(true);
    }
  });

  for (const [theme, vars] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    const fill = (family: string, shade: number) => rgb(vars, `--c-${family}-${shade}`);
    // var(--c-x-ink, var(--c-x)): the ink when either block defines it (cascade), else the fill.
    const ink = (family: string, shade: number) => {
      const name = `--c-${family}-${shade}-ink`;
      return vars.has(name) || LIGHT.has(name) ? rgb(vars, name) : fill(family, shade);
    };
    const canvas = rgb(vars, "--background");
    const card = rgb(vars, "--surface");

    const pairs: [string, number[], number[]][] = [
      ["body text on canvas", rgb(vars, "--foreground"), canvas],
      ["text-gray-900 on card", ink("gray", 900), card],
      ["text-gray-700 on bg-gray-50", ink("gray", 700), fill("gray", 50)],
      ["text-gray-600 on canvas", ink("gray", 600), canvas],
      ["text-gray-600 on bg-gray-100", ink("gray", 600), fill("gray", 100)],
      ["text-gray-500 on canvas", ink("gray", 500), canvas],
      ["text-gray-500 on card", ink("gray", 500), card],
      ["text-gray-500 on bg-gray-50", ink("gray", 500), fill("gray", 50)],
      ["text-gray-500 on bg-gray-100", ink("gray", 500), fill("gray", 100)],
      ["text-gray-800 on bg-gray-200", ink("gray", 800), fill("gray", 200)],
      ["text-blue-600 on canvas", ink("blue", 600), canvas],
      ["text-blue-600 on card", ink("blue", 600), card],
      ["text-blue-600 on bg-blue-50", ink("blue", 600), fill("blue", 50)],
      ["text-blue-700 on bg-blue-50", ink("blue", 700), fill("blue", 50)],
      ["text-red-600 on canvas", ink("red", 600), canvas],
      ["text-red-600 on bg-red-50", ink("red", 600), fill("red", 50)],
      ["text-red-700 on bg-red-50", ink("red", 700), fill("red", 50)],
      ["text-red-800 on bg-red-100", ink("red", 800), fill("red", 100)],
      ["text-amber-700 on bg-amber-50", ink("amber", 700), fill("amber", 50)],
      ["text-amber-800 on bg-amber-100", ink("amber", 800), fill("amber", 100)],
      ["text-green-600 on canvas", ink("green", 600), canvas],
      ["text-green-700 on bg-green-50", ink("green", 700), fill("green", 50)],
      ["text-green-800 on bg-green-100", ink("green", 800), fill("green", 100)],
      ["text-white on bg-blue-600", WHITE, fill("blue", 600)],
      ["text-white on bg-red-600", WHITE, fill("red", 600)],
      ["text-white on bg-gray-900 (toast)", WHITE, fill("gray", 900)],
      ["sidebar text", rgb(vars, "--sidebar-foreground"), rgb(vars, "--sidebar")],
      ["sidebar muted text", rgb(vars, "--sidebar-muted"), rgb(vars, "--sidebar")],
      ["active sidebar item", WHITE, rgb(vars, "--sidebar-accent")],
    ];
    for (const fam of ["yellow", "orange", "purple", "indigo", "sky", "teal", "emerald", "violet"]) {
      pairs.push([`text-${fam}-800 on bg-${fam}-100`, ink(fam, 800), fill(fam, 100)]);
    }

    it(`${theme}: main text pairs reach WCAG AA (4.5:1)`, () => {
      const failing = pairs
        .map(([label, fg, bg]) => [label, Math.round(contrast(fg, bg) * 100) / 100] as const)
        .filter(([, ratio]) => ratio < 4.5);
      expect(failing).toEqual([]);
    });

    // The one documented exception: text-gray-400 is the de-emphasised tone ('—' placeholders, voided or inactive rows,
    // which also keep their line-through), lighter than gray-500 on purpose but still readable.
    it(`${theme}: text-gray-400 stays readable (>= 3.5:1) and lighter than text-gray-500`, () => {
      for (const [label, bg] of [
        ["card", card],
        ["canvas", canvas],
        ["bg-gray-50", fill("gray", 50)],
      ] as const) {
        expect(contrast(ink("gray", 400), bg), `text-gray-400 on ${label}`).toBeGreaterThanOrEqual(3.5);
        expect(contrast(ink("gray", 400), bg), `text-gray-400 vs -500 on ${label}`).toBeLessThan(
          contrast(ink("gray", 500), bg)
        );
      }
    });
  }

  it("light: the canvas is visibly darker than the white cards (the owner found the near-white page tiring)", () => {
    expect(contrast(rgb(LIGHT, "--background"), rgb(LIGHT, "--surface"))).toBeGreaterThanOrEqual(1.15);
    expect(rgb(LIGHT, "--surface")).toEqual(WHITE);
  });

  it("the logo panel keeps the dark lettering crisp and is not a pure white block in dark", () => {
    const lettering = [29, 29, 27]; // #1d1d1b in public/brand/klinik-prime-logo.svg
    expect(rgb(LIGHT, "--brand-panel")).toEqual(WHITE);
    expect(rgb(DARK, "--brand-panel")).not.toEqual(WHITE);
    expect(contrast(lettering, rgb(DARK, "--brand-panel"))).toBeGreaterThanOrEqual(7);
  });

  it("dark cards, subtle rows and borders stay distinguishable from the canvas", () => {
    const card = rgb(DARK, "--surface");
    expect(contrast(rgb(DARK, "--c-gray-50"), card)).toBeGreaterThan(1.1);
    expect(contrast(rgb(DARK, "--border"), card)).toBeGreaterThan(1.3);
    expect(luminance(card)).toBeGreaterThan(luminance(rgb(DARK, "--background")));
  });
});

describe("colour classes", () => {
  // Tailwind only generates classes it finds in `content`: a folder missing there loses its classes in the build
  // (lib/crm/codes.ts and lib/stock/*.ts hold badge classes such as bg-sky-100 / text-violet-800).
  it("tailwind `content` scans every source folder", () => {
    const content = (tailwindConfig.content as string[]).map((glob) => glob.replace(/^\.\//, ""));
    for (const name of readdirSync(SRC_DIR)) {
      if (!statSync(join(SRC_DIR, name)).isDirectory()) continue;
      expect(
        content.some((glob) => glob.startsWith(`src/${name}/`)),
        `src/${name} in tailwind content`
      ).toBe(true);
    }
  });

  // A family missing from THEMED_FAMILIES would keep Tailwind's fixed colours and break dark mode.
  const FAMILY_RE =
    /\b(?:bg|text|border|ring|divide|from|via|to|placeholder|accent|outline|fill|stroke|decoration|caret|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
      return /\.(tsx?|css)$/.test(name) ? [path] : [];
    });
  }

  it("only use colour families that the theme maps", () => {
    const themed = new Set<string>(THEMED_FAMILIES);
    const unthemed = new Set<string>();
    for (const file of sources(SRC_DIR)) {
      for (const m of readFileSync(file, "utf8").matchAll(FAMILY_RE)) {
        if (!themed.has(m[1])) unthemed.add(`${m[0]} (${file.slice(SRC_DIR.length)})`);
      }
    }
    expect([...unthemed]).toEqual([]);
  });
});
