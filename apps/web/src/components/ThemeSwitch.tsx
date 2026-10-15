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

/** 'Görünüm: Açık / Koyu / Sistem' for the navy sidebar and the mobile drawer. Native radios: arrow keys work. */
export function ThemeSwitch({ roomy }: { roomy?: boolean }) {
  const name = `theme-${useId()}`;
  const preference = useThemePreference();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs font-medium text-sidebar-muted">Görünüm</legend>
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-sidebar-border p-1">
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
                roomy ? "py-2.5" : "py-1.5"
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
