// Central palette for tailwind.config.ts. The pages keep their ordinary Tailwind classes (bg-white, text-gray-600,
// bg-red-50 ...); every shade of the families below is a CSS variable defined in app/globals.css for :root (light)
// and .dark (dark), so the whole app follows the theme without per-page `dark:` classes.
//
// Each shade has two channels:
//   --c-<family>-<shade>      "fill": backgrounds, borders, rings, dividers, gradients, accents
//   --c-<family>-<shade>-ink  "ink": text, placeholders, carets, decorations (falls back to the fill when not set)
// In dark mode the fill of 50-300 becomes a dark tinted surface while 400-950 stay saturated (bg-blue-600 buttons keep
// white text), and the ink of 400-950 turns light (text-blue-600 / text-red-700 stay readable on dark surfaces).
//
// `white` stays a real white for text, borders and rings (text-white on coloured buttons); only bg-white is mapped to
// the card surface (white in light, dark slate in dark). Use bg-brand-panel for something that must stay white.
//
// Imported by tailwind.config.ts (relative import, no "@/" alias) and by the theme tests.

export const THEMED_FAMILIES = [
  "gray",
  "slate",
  "red",
  "orange",
  "amber",
  "yellow",
  "green",
  "emerald",
  "teal",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
] as const;

export const THEME_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

type Scale = Record<string, string>;

function scale(family: string, channel: "fill" | "ink"): Scale {
  const out: Scale = {};
  for (const shade of THEME_SHADES) {
    const v = `--c-${family}-${shade}`;
    out[shade] = channel === "ink" ? `rgb(var(${v}-ink, var(${v})) / <alpha-value>)` : `rgb(var(${v}) / <alpha-value>)`;
  }
  return out;
}

export function themedPalette(channel: "fill" | "ink"): Record<string, Scale> {
  const out: Record<string, Scale> = {};
  for (const family of THEMED_FAMILIES) out[family] = scale(family, channel);
  return out;
}

/** A semantic token from globals.css (stored as "r g b"), with Tailwind opacity support (bg-sidebar-accent/60). */
export function token(name: string): string {
  return `rgb(var(--${name}) / <alpha-value>)`;
}
