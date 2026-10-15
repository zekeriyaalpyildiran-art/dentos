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
});
