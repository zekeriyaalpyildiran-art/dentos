// Phase 10 staff helpers (spec p10_platform §1.4, §6.1, §6.3). Synthetic values only.

import { describe, expect, it } from "vitest";
import {
  INVITE_TEXTS,
  STAFF_TEXTS,
  formatIstanbulDateTime,
  inviteStaff,
  isPlaceholderEmail,
  isValidEmail,
  loginStatusLabel,
  normalizeEmail,
  validateStaffForm,
  type Db,
} from "../staff";

// §6.3: the same vectors are asserted by the 0027 self-check (§2.9-1).
const VECTORS: [string, boolean, boolean][] = [
  ["ayse@dentos.local", true, true],
  ["  AYSE@DENTOS.LOCAL ", true, true],
  ["x@clinic.test", true, true],
  ["x@a.invalid", true, true],
  ["x@shop.example", true, true],
  ["x@foo.localhost", true, true],
  ["x@localhost", false, true],
  ["x@example.com", true, false],
  ["x@gmail.com", true, false],
  ["x@local.com.tr", true, false],
  ["x@dentos.locale", true, false],
  ["x@testing.com", true, false],
  ["no-at-sign", false, false],
  ["a b@c.com", false, false],
];

describe("e-mail predicates", () => {
  it.each(VECTORS)("%s → valid %s, placeholder %s", (input, valid, placeholder) => {
    expect(isValidEmail(input)).toBe(valid);
    expect(isPlaceholderEmail(input)).toBe(placeholder);
  });

  it("normalises by trimming and lower-casing", () => {
    expect(normalizeEmail("  AYSE@Dentos.Local ")).toBe("ayse@dentos.local");
    expect(normalizeEmail(null)).toBe("");
  });

  it("rejects over-long addresses", () => {
    expect(isValidEmail("a".repeat(250) + "@b.com")).toBe(false);
  });
});

describe("validateStaffForm", () => {
  const ok = { full_name: "Ayşe Kurgu", email: "ayse@gmail.com", phone: "", role: "doctor", specialty: "" };

  it("accepts a valid form, including a placeholder e-mail", () => {
    expect(validateStaffForm(ok)).toBeNull();
    expect(validateStaffForm({ ...ok, email: "ayse@dentos.local" })).toBeNull();
    expect(validateStaffForm({ ...ok, phone: "+90 (532) 000-00-00" })).toBeNull();
  });

  it("returns the §1.2 texts", () => {
    expect(validateStaffForm({ ...ok, full_name: " A " })).toBe(STAFF_TEXTS.name);
    expect(validateStaffForm({ ...ok, full_name: "x".repeat(121) })).toBe(STAFF_TEXTS.name);
    expect(validateStaffForm({ ...ok, email: "x@y" })).toBe(STAFF_TEXTS.email);
    expect(validateStaffForm({ ...ok, phone: "12a" })).toBe(STAFF_TEXTS.phone);
    expect(validateStaffForm({ ...ok, phone: "1".repeat(31) })).toBe(STAFF_TEXTS.phone);
    expect(validateStaffForm({ ...ok, role: "boss" })).toBe(STAFF_TEXTS.role);
    expect(validateStaffForm({ ...ok, specialty: "x".repeat(121) })).toBe(STAFF_TEXTS.specialty);
    expect(STAFF_TEXTS.name).toBe("Ad soyad 2–120 karakter olmalı.");
  });

  it("on an edit, does not re-validate an unchanged legacy e-mail or phone", () => {
    const stored = { email: "Eski Adres", phone: "Tel. 0532/000.00.00" };
    const legacy = { ...ok, email: " eski adres ", phone: "Tel. 0532/000.00.00 " };
    expect(validateStaffForm(legacy, stored)).toBeNull();
    expect(validateStaffForm(legacy)).toBe(STAFF_TEXTS.email);
    expect(validateStaffForm({ ...legacy, phone: "Tel. 0532/111" }, stored)).toBe(STAFF_TEXTS.phone);
    expect(validateStaffForm({ ...legacy, email: "yeni" }, stored)).toBe(STAFF_TEXTS.email);
    expect(validateStaffForm({ ...ok, phone: "" }, { email: ok.email, phone: null })).toBeNull();
  });
});

describe("loginStatusLabel", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const base = { invited_at: null, last_sign_in_at: null, email_confirmed_at: null };

  it("none", () => {
    expect(loginStatusLabel({ ...base, status: "none" }, now)).toEqual({ text: "Yok", tone: "gray", hint: null });
  });

  it("invited, fresh and older than 24 h", () => {
    const fresh = loginStatusLabel({ ...base, status: "invited", invited_at: "2026-10-15T11:03:00Z" }, now);
    expect(fresh.text).toBe("Davet gönderildi · 15.10.2026 14:03");
    expect(fresh.tone).toBe("gray");
    expect(fresh.hint).toBeNull();
    const stale = loginStatusLabel({ ...base, status: "invited", invited_at: "2026-10-14T11:00:00Z" }, now);
    expect(stale.tone).toBe("amber");
    expect(stale.hint).toBe("süresi dolmuş olabilir");
  });

  it("invited, then resent through the recovery flow: the newest link decides text and age", () => {
    const resent = loginStatusLabel(
      {
        ...base,
        status: "invited",
        invited_at: "2026-10-13T08:00:00Z",
        recovery_sent_at: "2026-10-15T11:03:00Z",
        link_sent_at: "2026-10-15T11:03:00Z",
      },
      now
    );
    expect(resent).toEqual({ text: "Bağlantı yeniden gönderildi · 15.10.2026 14:03", tone: "gray", hint: null });
    // An older recovery (e.g. before the invite) does not hide the invite time.
    const older = loginStatusLabel(
      { ...base, status: "invited", invited_at: "2026-10-15T11:03:00Z", recovery_sent_at: "2026-10-01T08:00:00Z" },
      now
    );
    expect(older.text).toBe("Davet gönderildi · 15.10.2026 14:03");
    const staleResend = loginStatusLabel(
      { ...base, status: "invited", invited_at: "2026-10-10T08:00:00Z", recovery_sent_at: "2026-10-14T08:00:00Z" },
      now
    );
    expect(staleResend.tone).toBe("amber");
    expect(staleResend.hint).toBe("süresi dolmuş olabilir");
  });

  it("active and missing", () => {
    const active = loginStatusLabel({ ...base, status: "active", last_sign_in_at: "2026-10-15T11:03:00+00:00" }, now);
    expect(active).toEqual({ text: "Aktif · son giriş 15.10.2026 14:03", tone: "green", hint: null });
    expect(loginStatusLabel({ ...base, status: "missing" }, now)).toEqual({
      text: "Hesap bulunamadı",
      tone: "red",
      hint: null,
    });
  });

  it("formats Istanbul time around midnight", () => {
    expect(formatIstanbulDateTime("2026-10-15T21:30:00Z")).toBe("16.10.2026 00:30");
    expect(formatIstanbulDateTime(null)).toBe("—");
    expect(formatIstanbulDateTime("nope")).toBe("—");
  });
});

describe("inviteStaff", () => {
  const dbWith = (result: unknown, calls: unknown[] = []) =>
    ({
      functions: {
        invoke: async (name: string, opts: unknown) => {
          calls.push([name, opts]);
          return result;
        },
      },
    }) as unknown as Db;

  const httpError = (status: number, body: unknown) => {
    const err = new Error("Edge Function returned a non-2xx status code") as Error & { context: unknown };
    err.name = "FunctionsHttpError";
    err.context = {
      status,
      json: async () => {
        if (body === undefined) throw new Error("no json");
        return body;
      },
    };
    return err;
  };

  it("sends action and user_id and returns the data", async () => {
    const calls: unknown[] = [];
    const data = { ok: true, action: "invite", user_id: "u1", email: "a@b.com", login_status: "invited" };
    const r = await inviteStaff(dbWith({ data, error: null }, calls), "u1", "invite");
    expect(r).toEqual({ ok: true, data });
    expect(calls).toEqual([["invite-staff", { body: { action: "invite", user_id: "u1" } }]]);
  });

  it("uses the function's Turkish message", async () => {
    const r = await inviteStaff(
      dbWith({ data: null, error: httpError(409, { ok: false, code: "PLT_EMAIL_IN_USE", message: "Zaten var." }) }),
      "u1",
      "invite"
    );
    expect(r).toEqual({ ok: false, message: "Zaten var.", code: "PLT_EMAIL_IN_USE" });
  });

  it("maps a 404 without our body to 'not deployed'", async () => {
    const r = await inviteStaff(dbWith({ data: null, error: httpError(404, undefined) }), "u1", "resend");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toBe(INVITE_TEXTS.notDeployed);
  });

  it("maps relay / fetch errors to 'unreachable'", async () => {
    const err = new Error("Failed to send a request to the Edge Function");
    err.name = "FunctionsFetchError";
    const r = await inviteStaff(dbWith({ data: null, error: err }), "u1", "invite");
    expect(!r.ok && r.message).toBe(INVITE_TEXTS.unreachable);
    // A browser cannot tell "function missing" from "offline" (no CORS headers): the text names both.
    expect(INVITE_TEXTS.unreachable).toContain("invite-staff");
  });
});
