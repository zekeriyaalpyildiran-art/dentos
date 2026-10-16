// Appearance (Görünüm): light, dark or follow the system, remembered per device in localStorage. Light is the default.
// The root layout runs THEME_INIT_SCRIPT in <head>, so the 'dark' class is on <html> before the first paint (no flash);
// after that the ThemeSwitch / ThemeSync components keep it in step. The colours themselves: globals.css.
// Storage can be unavailable (private mode, blocked site data): every access is guarded and falls back to light.

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "dentos-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Açık" },
  { value: "dark", label: "Koyu" },
  { value: "system", label: "Sistem" },
];

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "dark" || value === "system" ? value : "light";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "dark" || (preference === "system" && systemDark) ? "dark" : "light";
}

/** Inline, before first paint. Kept tiny and self-contained; any failure leaves the light default. */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(p==="dark"||(p==="system"&&window.matchMedia(${JSON.stringify(
  DARK_QUERY
)}).matches)){document.documentElement.classList.add("dark")}}catch(e){}})();`;

function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

function applyTheme(preference: ThemePreference, systemDark = systemPrefersDark()) {
  document.documentElement.classList.toggle("dark", resolveTheme(preference, systemDark) === "dark");
}

// One shared value for every switch on the page (the desktop sidebar and the mobile drawer each render one).
let current: ThemePreference | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function getThemePreference(): ThemePreference {
  if (current === null) current = readStoredPreference();
  return current;
}

export function setThemePreference(preference: ThemePreference) {
  current = preference;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not remembered on this device; the choice still applies until the page is reloaded.
  }
  applyTheme(preference);
  notify();
}

export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keeps <html> in step after load: a 'Sistem' choice follows the OS switching between light and dark, and a choice
 * made in another tab applies here too. Returns the cleanup.
 */
export function watchTheme(): () => void {
  applyTheme(getThemePreference());

  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
    current = readStoredPreference();
    applyTheme(current);
    notify();
  };
  // The event's own value: re-reading matchMedia inside the handler can still return the old answer.
  const onSystemChange = (e: MediaQueryListEvent) => {
    if (getThemePreference() === "system") applyTheme("system", e.matches);
  };

  let media: MediaQueryList | null = null;
  try {
    media = window.matchMedia(DARK_QUERY);
  } catch {
    media = null;
  }
  window.addEventListener("storage", onStorage);
  media?.addEventListener?.("change", onSystemChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    media?.removeEventListener?.("change", onSystemChange);
  };
}
