"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import {
  THEME_OPTIONS,
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
  watchTheme,
  type ThemePreference,
} from "@/lib/theme";

function useThemePreference(): ThemePreference {
  // The server always renders the light default; the stored choice takes over right after hydration.
  return useSyncExternalStore(subscribeThemePreference, getThemePreference, () => "light");
}

/**
 * 'Görünüm: Açık / Koyu / Sistem' for the navy sidebar and the mobile drawer, on one compact row so the menu keeps its
 * room. Native radios: arrow keys work. `roomy`: taller segments for touch (drawer).
 */
export function ThemeSwitch({ roomy }: { roomy?: boolean }) {
  const name = `theme-${useId()}`;
  const preference = useThemePreference();
  return (
    <fieldset className="flex min-w-0 items-center gap-2">
      <legend className="sr-only">Görünüm</legend>
      <span aria-hidden="true" className="shrink-0 text-xs font-medium text-sidebar-muted">
        Görünüm
      </span>
      <div className="grid min-w-0 flex-1 grid-cols-3 gap-0.5 rounded-lg border border-sidebar-border p-0.5">
        {THEME_OPTIONS.map((option) => (
          <label key={option.value} className="relative cursor-pointer">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={preference === option.value}
              onChange={() => setThemePreference(option.value)}
              className="peer sr-only"
            />
            <span
              className={`block rounded-md px-1 text-center text-xs ${
                roomy ? "py-2" : "py-1"
              } text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 peer-checked:bg-sidebar-accent peer-checked:font-semibold peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-white`}
            >
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Mounted once in the root layout: follows OS changes for 'Sistem' and choices made in other tabs. */
export function ThemeSync() {
  useEffect(() => watchTheme(), []);
  return null;
}
