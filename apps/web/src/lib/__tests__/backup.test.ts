// Automatic backup status box (migration 0029, backup_status). Synthetic values only.

import { describe, expect, it } from "vitest";
import {
  BACKUP_STALE_HOURS,
  BACKUP_STATUS_HREF,
  BACKUP_TEXTS,
  describeBackupNotice,
  describeBackupStatus,
  fetchBackupStatus,
  formatBackupAge,
  formatBackupSize,
  isBackupStatusResponse,
  type BackupStatusResult,
  type Db,
} from "../backup";

const HOUR = 60 * 60 * 1000;
const NOW = "2026-10-16T09:00:00.000Z"; // 12:00 Istanbul

function ok(ranAgoMs: number | null, size = 12_345_678, authIncluded?: boolean | null): BackupStatusResult {
  const now = new Date(NOW).getTime();
  return {
    kind: "ok",
    data: {
      ok: true,
      now: NOW,
      last:
        ranAgoMs === null
          ? null
          : {
              ran_at: new Date(now - ranAgoMs).toISOString(),
              size_bytes: size,
              toc_entries: 1234,
              ...(authIncluded === undefined ? {} : { auth_included: authIncluded }),
            },
    },
  };
}

const dbWith = (result: unknown, calls: unknown[] = []) =>
  ({
    rpc: async (...args: unknown[]) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
  }) as unknown as Db;

describe("formatBackupSize", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1 KB"],
    [1500, "1,5 KB"],
    [12_345_678, "12,3 MB"],
    [999_999_999, "1.000 MB"],
    [1_200_000_000, "1,2 GB"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("%s → %s", (bytes, text) => {
    expect(formatBackupSize(bytes)).toBe(text);
  });
});

describe("formatBackupAge", () => {
  it.each([
    [-5000, "az önce"],
    [30_000, "az önce"],
    [5 * 60_000, "5 dakika önce"],
    [HOUR, "1 saat önce"],
    [5 * HOUR + 59 * 60_000, "5 saat önce"],
    [47 * HOUR, "47 saat önce"],
    [48 * HOUR, "2 gün önce"],
    [10 * 24 * HOUR, "10 gün önce"],
  ])("%s ms → %s", (ms, text) => {
    expect(formatBackupAge(ms)).toBe(text);
  });
});

describe("describeBackupStatus", () => {
  it("fresh backup is green with age, size and Istanbul time", () => {
    const view = describeBackupStatus(ok(9.5 * HOUR));
    expect(view?.tone).toBe("green");
    expect(view?.title).toBe("Otomatik yedek: son yedek 9 saat önce (12,3 MB)");
    expect(view?.detail).toContain("16.10.2026 02:30 (İstanbul)");
  });

  it(`turns amber only when older than ${BACKUP_STALE_HOURS} hours`, () => {
    expect(describeBackupStatus(ok(BACKUP_STALE_HOURS * HOUR))?.tone).toBe("green");
    const stale = describeBackupStatus(ok(BACKUP_STALE_HOURS * HOUR + 60_000));
    expect(stale?.tone).toBe("amber");
    expect(stale?.title).toBe("Otomatik yedek: son yedek 36 saat önce (12,3 MB)");
    expect(stale?.detail).toContain(BACKUP_TEXTS.staleDetail);
  });

  it("no run yet is amber", () => {
    const view = describeBackupStatus(ok(null));
    expect(view).toEqual({ tone: "amber", title: "Henüz otomatik yedek alınmadı", detail: BACKUP_TEXTS.noneDetail });
  });

  it("uses the server clock, not the PC clock", () => {
    const wrongPcClock = new Date("2030-01-01T00:00:00Z");
    expect(describeBackupStatus(ok(2 * HOUR), wrongPcClock)?.tone).toBe("green");
  });

  it("falls back to the PC clock when the server time is unusable", () => {
    const r = ok(2 * HOUR);
    if (r.kind !== "ok") throw new Error("setup");
    r.data.now = "not a date";
    const pc = new Date(new Date(NOW).getTime() + 3 * 24 * HOUR);
    expect(describeBackupStatus(r, pc)?.tone).toBe("amber");
  });

  it("says so when staff logins were not in the backup, without changing the tone", () => {
    const fresh = describeBackupStatus(ok(2 * HOUR, 1000, false));
    expect(fresh?.tone).toBe("green");
    expect(fresh?.detail).toContain(BACKUP_TEXTS.authMissing);
    const stale = describeBackupStatus(ok(40 * HOUR, 1000, false));
    expect(stale?.tone).toBe("amber");
    expect(stale?.detail).toContain(BACKUP_TEXTS.staleDetail);
    expect(stale?.detail).toContain(BACKUP_TEXTS.authMissing);
    for (const auth of [true, null, undefined]) {
      expect(describeBackupStatus(ok(2 * HOUR, 1000, auth))?.detail).not.toContain(BACKUP_TEXTS.authMissing);
    }
  });

  it("missing RPC, errors and forbidden", () => {
    expect(describeBackupStatus({ kind: "missing" })).toEqual({ tone: "gray", title: BACKUP_TEXTS.missing, detail: null });
    expect(describeBackupStatus({ kind: "error", message: "x" })).toEqual({
      tone: "gray",
      title: BACKUP_TEXTS.error,
      detail: "x",
    });
    expect(describeBackupStatus({ kind: "forbidden" })).toBeNull();
  });
});

describe("describeBackupNotice (every panel page)", () => {
  it("is shown only when overdue or never run", () => {
    expect(describeBackupNotice(ok(2 * HOUR))).toBeNull();
    expect(describeBackupNotice(ok(BACKUP_STALE_HOURS * HOUR))).toBeNull();
    expect(describeBackupNotice(ok(3 * 24 * HOUR))).toEqual({
      text: "Otomatik yedek gecikti: son yedek 3 gün önce.",
      linkText: BACKUP_TEXTS.noticeLink,
      href: BACKUP_STATUS_HREF,
    });
    expect(describeBackupNotice(ok(BACKUP_STALE_HOURS * HOUR + 60_000))?.text).toBe(
      "Otomatik yedek gecikti: son yedek 36 saat önce."
    );
    expect(describeBackupNotice(ok(null))).toEqual({
      text: BACKUP_TEXTS.noticeNone,
      linkText: BACKUP_TEXTS.noticeLink,
      href: "/settings/export",
    });
  });

  it("never nags without a reason: missing RPC, errors, non-owner, bad data", () => {
    expect(describeBackupNotice({ kind: "missing" })).toBeNull();
    expect(describeBackupNotice({ kind: "error", message: "x" })).toBeNull();
    expect(describeBackupNotice({ kind: "forbidden" })).toBeNull();
    const bad = ok(2 * HOUR);
    if (bad.kind !== "ok" || !bad.data.last) throw new Error("setup");
    bad.data.last.ran_at = "not a date";
    expect(describeBackupNotice(bad)).toBeNull();
  });

  it("uses the server clock, not the PC clock", () => {
    expect(describeBackupNotice(ok(2 * HOUR), new Date("2030-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("fetchBackupStatus", () => {
  it("calls backup_status without arguments and validates the shape", async () => {
    const calls: unknown[] = [];
    const data = { ok: true, now: NOW, last: { ran_at: NOW, size_bytes: 10, toc_entries: 5 } };
    expect(await fetchBackupStatus(dbWith({ data, error: null }, calls))).toEqual({ kind: "ok", data });
    expect(calls).toEqual([["backup_status"]]);
    expect(await fetchBackupStatus(dbWith({ data: { ok: true, now: NOW, last: null }, error: null }))).toEqual({
      kind: "ok",
      data: { ok: true, now: NOW, last: null },
    });
  });

  it("maps a missing function (0029 not applied) to 'missing'", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const r = await fetchBackupStatus(dbWith({ data: null, error: { code, message: "Could not find the function" } }));
      expect(r).toEqual({ kind: "missing" });
    }
  });

  it("maps 42501 to forbidden, other errors to a message", async () => {
    expect(
      await fetchBackupStatus(dbWith({ data: null, error: { code: "42501", message: "Otomatik yedek durumunu…" } }))
    ).toEqual({ kind: "forbidden" });
    expect(await fetchBackupStatus(dbWith({ data: null, error: { code: "XX000", message: "boom" } }))).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(await fetchBackupStatus(dbWith(new Error("Failed to fetch")))).toEqual({
      kind: "error",
      message: BACKUP_TEXTS.network,
    });
    expect(await fetchBackupStatus(dbWith({ data: { ok: true }, error: null }))).toEqual({
      kind: "error",
      message: "Beklenmeyen yanıt.",
    });
  });

  it("shape guard never exposes extra keys as valid when types are wrong", () => {
    expect(isBackupStatusResponse({ ok: true, now: NOW, last: { ran_at: NOW, size_bytes: "10", toc_entries: 1 } })).toBe(
      false
    );
    expect(isBackupStatusResponse(null)).toBe(false);
    const last = { ran_at: NOW, size_bytes: 10, toc_entries: 1 };
    expect(isBackupStatusResponse({ ok: true, now: NOW, last: { ...last, auth_included: false } })).toBe(true);
    expect(isBackupStatusResponse({ ok: true, now: NOW, last: { ...last, auth_included: null } })).toBe(true);
    expect(isBackupStatusResponse({ ok: true, now: NOW, last: { ...last, auth_included: "false" } })).toBe(false);
  });
});
