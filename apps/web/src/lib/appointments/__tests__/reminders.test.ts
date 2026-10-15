// Legacy reminder rows: display status, and the texts / keys shared with migration 0028_ajanda_guard.sql.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REMINDER_CANCELLED_REASON, REMINDER_NOT_SENT_REASON, reminderDisplayStatus } from "../reminders";
import { SLOT_CONSTRAINTS, SLOT_ERROR_TEXTS } from "../errors";

const MIGRATION = join(__dirname, "..", "..", "..", "..", "..", "..", "packages", "db", "migrations", "0028_ajanda_guard.sql");

describe("reminderDisplayStatus", () => {
  it("separates cancelled and never-sent rows from real failures", () => {
    expect(reminderDisplayStatus("failed", REMINDER_CANCELLED_REASON)).toBe("cancelled");
    expect(reminderDisplayStatus("failed", REMINDER_NOT_SENT_REASON)).toBe("not_sent");
    expect(reminderDisplayStatus("failed", "Gateway timeout")).toBe("failed");
    expect(reminderDisplayStatus("failed", null)).toBe("failed");
    expect(reminderDisplayStatus("sent", null)).toBe("sent");
    expect(reminderDisplayStatus("pending", null)).toBe("pending");
    expect(reminderDisplayStatus(null, null)).toBe("pending");
  });

  it("keeps the not-sent reason free of PostgREST filter syntax characters", () => {
    expect(REMINDER_NOT_SENT_REASON).not.toMatch(/[,().:"'*%\\]/);
  });
});

describe("migration 0028 agrees with the web app", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("closes pending SMS rows with the same reason text", () => {
    expect(sql).toContain(`error_message = '${REMINDER_NOT_SENT_REASON}'`);
  });

  it("raises the same keys and texts the UI maps", () => {
    for (const [key, text] of Object.entries(SLOT_ERROR_TEXTS)) {
      expect(sql).toContain(`HINT = '${key}'`);
      expect(sql).toContain(`MESSAGE = '${text}'`);
    }
  });

  it("names the exclusion constraints the UI recognises", () => {
    expect(sql).toContain(`ADD CONSTRAINT ${SLOT_CONSTRAINTS.doctor}`);
    expect(sql).toContain(`ADD CONSTRAINT ${SLOT_CONSTRAINTS.chair}`);
  });

  it("locks the patient's leads before the advisory lock in the slot guard (CRM lock order, no deadlock)", () => {
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.appt__trg_slot_guard()");
    const end = sql.indexOf("CREATE TRIGGER appt_slot_guard");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = sql.slice(start, end);
    const leadLock = body.indexOf("FROM public.leads l");
    const forUpdate = body.indexOf("FOR UPDATE;", leadLock);
    const advisory = body.indexOf("pg_advisory_xact_lock(");
    expect(leadLock).toBeGreaterThan(-1);
    expect(body).toContain("ORDER BY l.created_at, l.id");
    expect(forUpdate).toBeGreaterThan(leadLock);
    expect(advisory).toBeGreaterThan(forUpdate);
  });

  it("ends with a summary query after COMMIT (the SQL editor shows no NOTICEs)", () => {
    const tail = sql.slice(sql.lastIndexOf("COMMIT;"));
    expect(tail).toMatch(/SELECT[\s\S]*AS durum[\s\S]*mevcut_cakismalar[\s\S]*kapatilan_sms/);
    expect(tail).toContain(`error_message = '${REMINDER_NOT_SENT_REASON}'`);
  });
});
