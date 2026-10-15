// Phase 10 audit viewer helpers (spec p10_platform §5.4, §6.2). Synthetic values only.

import { describe, expect, it } from "vitest";
import {
  auditDiff,
  auditSummary,
  clampPageSize,
  entityLabel,
  fieldLabel,
  formatAuditValue,
  istanbulDayRange,
  keysetFilter,
  mergeAuditRows,
  type AuditRow,
} from "../audit";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

describe("auditDiff", () => {
  it("create: all non-hidden keys of after_data", () => {
    const lines = auditDiff({
      entity_type: "users",
      action: "create",
      changes: null,
      before_data: null,
      after_data: { id: U1, clinic_id: U2, full_name: "Ayşe Kurgu", role: "doctor", created_at: "x", phone: null },
    });
    expect(lines.map((l) => l.key)).toEqual(["full_name", "role", "phone"]);
    expect(lines[0]).toMatchObject({ label: "Ad soyad", before: undefined, after: "Ayşe Kurgu", changed: true });
    expect(lines[2].changed).toBe(false);
  });

  it("update: prefers the keys of changes", () => {
    const lines = auditDiff({
      entity_type: "users",
      action: "update",
      changes: { phone: "555", auth_user_id: U2 },
      before_data: { id: U1, full_name: "A", phone: "444", auth_user_id: null, updated_at: "t1" },
      after_data: { id: U1, full_name: "A", phone: "555", auth_user_id: U2, updated_at: "t2" },
    });
    expect(lines.map((l) => [l.key, l.before, l.after, l.changed])).toEqual([
      ["phone", "444", "555", true],
      ["auth_user_id", null, U2, true],
    ]);
    expect(formatAuditValue("auth_user_id", U2)).toBe("Bağlı");
    expect(formatAuditValue("auth_user_id", null)).toBe("—");
  });

  it("update without changes falls back to differing keys", () => {
    const lines = auditDiff({
      entity_type: "users",
      action: "update",
      changes: {},
      before_data: { full_name: "A", phone: "1", updated_at: "t1" },
      after_data: { full_name: "B", phone: "1", updated_at: "t2" },
    });
    expect(lines.map((l) => l.key)).toEqual(["full_name"]);
  });

  it("delete: all non-hidden keys of before_data", () => {
    const lines = auditDiff({
      entity_type: "staff_permissions",
      action: "delete",
      changes: null,
      before_data: { id: U1, permission: "finance", user_id: U2 },
      after_data: null,
    });
    expect(lines.map((l) => [l.key, l.after])).toEqual([
      ["permission", undefined],
      ["user_id", undefined],
    ]);
  });

  it("archive: only is_active and reason", () => {
    const row = {
      entity_type: "patients",
      action: "archive",
      changes: { is_active: false, reason: "Kurgu açıklama" },
      before_data: { is_active: true },
      after_data: { is_active: false },
    };
    const lines = auditDiff(row);
    expect(lines.map((l) => [l.key, l.label, l.before, l.after])).toEqual([
      ["is_active", "Arşiv durumu", true, false],
      ["reason", "Açıklama", undefined, "Kurgu açıklama"],
    ]);
    expect(auditSummary(row)).toBe("Arşiv durumu, Açıklama");
  });

  it("summary counts the rest", () => {
    expect(
      auditSummary({
        entity_type: "users",
        action: "update",
        changes: { full_name: 1, email: 1, phone: 1, role: 1, is_active: 1 },
        before_data: {},
        after_data: {},
      })
    ).toBe("Ad soyad, E-posta, Telefon +2");
  });
});

describe("formatAuditValue", () => {
  it("formats the common shapes", () => {
    expect(formatAuditValue("x", null)).toBe("—");
    expect(formatAuditValue("is_active", true)).toBe("Aktif");
    expect(formatAuditValue("is_active", false)).toBe("Pasif");
    expect(formatAuditValue("kvkk_consent", true)).toBe("Evet");
    expect(formatAuditValue("role", "doctor")).toBe("Hekim");
    expect(formatAuditValue("permission", "finance")).toBe("Finans");
    expect(formatAuditValue("login", "invited")).toBe("Davet gönderildi");
    expect(formatAuditValue("status", "paid", { entityType: "payments" })).toBe("Ödendi");
    expect(formatAuditValue("due_date", "2026-10-15")).toBe("15.10.2026");
    expect(formatAuditValue("paid_at", "2026-10-15T11:03:00+00:00")).toBe("15.10.2026 14:03");
    expect(formatAuditValue("amount", 100)).toBe("100,00");
    expect(formatAuditValue("amount_cents", 12345)).toContain("123,45");
  });

  it("resolves ids through the maps", () => {
    expect(formatAuditValue("granted_by", U1, { users: { [U1]: "Ayşe Kurgu" } })).toBe("Ayşe Kurgu");
    expect(formatAuditValue("patient_id", U2, { patients: {} })).toBe("#22222222");
    expect(formatAuditValue("lab_id", U2)).toBe("#22222222");
  });

  it("truncates long values unless full", () => {
    const long = "a".repeat(250);
    expect(formatAuditValue("notes", long)).toBe("a".repeat(200) + "…");
    expect(formatAuditValue("notes", long, {}, true)).toBe(long);
    expect(formatAuditValue("items", [1, 2])).toBe("[1,2]");
  });

  it("labels", () => {
    expect(entityLabel("fin_entries")).toBe("Finans kaydı");
    expect(entityLabel("something_new")).toBe("something_new");
    expect(fieldLabel("payments", "status")).toBe("Ödeme durumu");
    expect(fieldLabel("users", "status")).toBe("Durum");
    expect(fieldLabel("users", "odd_col")).toBe("odd_col");
  });
});

describe("query helpers", () => {
  it("istanbulDayRange", () => {
    expect(istanbulDayRange("2026-10-15", "2026-10-15")).toEqual({
      gte: "2026-10-15T00:00:00+03:00",
      lt: "2026-10-16T00:00:00+03:00",
    });
    expect(istanbulDayRange("2026-12-31", "2026-12-31").lt).toBe("2027-01-01T00:00:00+03:00");
    expect(istanbulDayRange("", "2026-02-30")).toEqual({});
  });

  it("keysetFilter quotes the timestamp", () => {
    expect(keysetFilter({ created_at: "2026-10-15T10:01:02.123456+00:00", id: U1 })).toBe(
      `created_at.lt."2026-10-15T10:01:02.123456+00:00",and(created_at.eq."2026-10-15T10:01:02.123456+00:00",id.lt.${U1})`
    );
  });

  it("clampPageSize", () => {
    expect(clampPageSize(5000)).toBe(1000);
    expect(clampPageSize(0)).toBe(50);
    expect(clampPageSize(undefined)).toBe(50);
    expect(clampPageSize("200")).toBe(200);
  });

  it("mergeAuditRows deduplicates by id", () => {
    const r = (id: string) => ({ id }) as AuditRow;
    expect(mergeAuditRows([r("a"), r("b")], [r("b"), r("c")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
