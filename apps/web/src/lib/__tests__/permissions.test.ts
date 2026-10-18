// Per-person permission keys, labels and who may grant them (mirrors grant_staff_permission / revoke_staff_permission).

import { describe, expect, it } from "vitest";
import {
  canPrepareHakedis,
  canSeeFinance,
  canSeeHakedis,
  FINANCE_PERMISSIONS,
  isPermission,
  OWNER_GRANTED_PERMISSIONS,
  PERMISSION_LABELS,
  PERMISSIONS,
  permissionGrantLock,
} from "../permissions";

const user = (permissions: string[]) => ({ permissions });

describe("permission keys", () => {
  it("knows hakedis_prepare with its label", () => {
    expect(isPermission("hakedis_prepare")).toBe(true);
    expect(isPermission("hakedis")).toBe(false);
    expect(PERMISSION_LABELS.hakedis_prepare).toBe("Hakediş ve maaş hazırlama");
    for (const p of PERMISSIONS) expect(PERMISSION_LABELS[p]).toBeTruthy();
  });

  it("keeps hakedis_prepare out of the finance grants and with the owner", () => {
    expect(FINANCE_PERMISSIONS).not.toContain("hakedis_prepare");
    expect(OWNER_GRANTED_PERMISSIONS).toEqual(["stock_manage", "hakedis_prepare"]);
  });
});

describe("permissionGrantLock", () => {
  const owner = { role: "owner", holdsFinance: false };
  const financeAdmin = { role: "admin", holdsFinance: true };
  const admin = { role: "admin", holdsFinance: false };

  it("lets only the owner grant hakedis_prepare and stock_manage", () => {
    expect(permissionGrantLock("hakedis_prepare", owner)).toBeNull();
    expect(permissionGrantLock("hakedis_prepare", financeAdmin)).toBe(
      "Hakediş ve maaş hazırlama yetkisini yalnızca klinik sahibi verebilir veya kaldırabilir."
    );
    expect(permissionGrantLock("hakedis_prepare", admin)).not.toBeNull();
    expect(permissionGrantLock("stock_manage", owner)).toBeNull();
    expect(permissionGrantLock("stock_manage", financeAdmin)).not.toBeNull();
  });

  it("keeps the finance and stock cost rules", () => {
    expect(permissionGrantLock("finance", financeAdmin)).toBeNull();
    expect(permissionGrantLock("finance_readonly", owner)).toBe(
      "Finans yetkilerini yalnızca finans yetkisi olan kullanıcılar verebilir."
    );
    expect(permissionGrantLock("finance", { role: "owner", holdsFinance: true })).toBeNull();
    expect(permissionGrantLock("stock_cost_view", owner)).toBeNull();
    expect(permissionGrantLock("stock_cost_view", financeAdmin)).toBeNull();
    expect(permissionGrantLock("stock_cost_view", admin)).not.toBeNull();
    expect(permissionGrantLock("crm_manage", admin)).toBeNull();
    expect(permissionGrantLock("clinical", admin)).toBeNull();
  });
});

describe("hakediş access", () => {
  it("lets finance holders and hakedis_prepare holders see hakediş, without making them finance readers", () => {
    expect(canSeeHakedis(user(["hakedis_prepare"]))).toBe(true);
    expect(canSeeFinance(user(["hakedis_prepare"]))).toBe(false);
    expect(canSeeHakedis(user(["finance"]))).toBe(true);
    expect(canSeeHakedis(user(["finance_readonly"]))).toBe(true);
    expect(canSeeHakedis(user(["stock_manage", "crm_manage"]))).toBe(false);
    expect(canSeeHakedis(null)).toBe(false);
  });

  it("lets 'finance' and 'hakedis_prepare' enter data, not 'finance_readonly'", () => {
    expect(canPrepareHakedis(user(["hakedis_prepare"]))).toBe(true);
    expect(canPrepareHakedis(user(["finance"]))).toBe(true);
    expect(canPrepareHakedis(user(["finance_readonly"]))).toBe(false);
    expect(canPrepareHakedis(undefined)).toBe(false);
  });
});
