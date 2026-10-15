import type { Config } from "tailwindcss"
import { themedPalette, token } from "./src/lib/theme-colors"

// Light / dark theming lives in src/lib/theme-colors.ts (how the palette is wired) and src/app/globals.css (the values).
const ink = themedPalette("ink")

const config = {
  darkMode: ["class"],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ...themedPalette("fill"),
        white: "rgb(255 255 255 / <alpha-value>)",
        black: "rgb(0 0 0 / <alpha-value>)",
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        surface: token("surface"),
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
        },
        sidebar: {
          DEFAULT: token("sidebar"),
          foreground: token("sidebar-foreground"),
          accent: token("sidebar-accent"),
          border: token("sidebar-border"),
          muted: token("sidebar-muted"),
          highlight: token("sidebar-highlight"),
        },
        brand: {
          // The clinic logo's own background: white in both themes.
          panel: "rgb(255 255 255 / <alpha-value>)",
        },
      },
      textColor: ink,
      placeholderColor: ink,
      caretColor: ink,
      textDecorationColor: ink,
      backgroundColor: {
        // Cards and dialogs: white in light, the dark surface in dark. text-white / border-white stay real white.
        white: token("surface"),
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        // `shadow` is the card style (bg-white rounded-lg shadow): a hairline edge plus a soft shadow.
        DEFAULT: "var(--shadow)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        "2xl": "var(--shadow-2xl)",
      },
    },
  },
  plugins: [],
} satisfies Config

export default config
