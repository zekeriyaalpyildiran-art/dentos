// Per-viewer conveniences in localStorage (shift room, bulk cart, count drafts, list filters).
// Every access is guarded: the pages work the same when storage is blocked or empty.

export const STORAGE_KEYS = {
  shiftRoom: (userId: string) => `dentos-stock-shift-room:${userId}`,
  cart: (userId: string) => `dentos-stock-cart:${userId}`,
  count: (userId: string, locationId: string) => `dentos-stock-count:${userId}:${locationId}`,
  itemFilters: (userId: string) => `dentos-stock-item-filters:${userId}`,
};

export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota): the page keeps working without it.
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function readString(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeString(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// The bulk cart can carry unit costs (cost viewers only), so it lives in the tab's sessionStorage instead: it
// survives a reload of the tab, never outlives it, and is cleared on sign-out (clearStockStorage).
export function readSessionJson<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSessionJson(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the cart then lasts only as long as the page.
  }
}

export function removeSessionKey(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Removes every per-viewer stock key (both storages) of this browser; called on sign-out (shared clinic PCs). */
export function clearStockStorage(): void {
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = window[area];
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith("dentos-stock-")) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
    } catch {
      // ignore
    }
  }
}
