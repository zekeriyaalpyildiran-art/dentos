// The legacy `reminders` table (0004). No SMS gateway exists and none is planned for now (0021: "No SMS is ever
// sent"), so the app no longer queues rows here; reminders are done by phone or WhatsApp and recorded with
// crm_set_reminder_outcome. reminder_status has only pending / sent / failed and the table keeps its history, so a
// row that will never be sent is a 'failed' row with one of the reasons below. Pure helpers, unit-tested.

/** A pending reminder closed because its appointment was cancelled, completed or missed (shown as "İptal"). */
export const REMINDER_CANCELLED_REASON = "Hatırlatma iptal edildi";

/**
 * A queued SMS closed by migration 0028 because automatic SMS is not active (shown as "Gönderilmedi"). Must equal the
 * text in 0028_ajanda_guard.sql (checked by a unit test); kept free of PostgREST filter syntax characters.
 */
export const REMINDER_NOT_SENT_REASON = "SMS gönderilmedi - otomatik SMS etkin değil";

export type ReminderDisplayStatus = "pending" | "sent" | "failed" | "cancelled" | "not_sent";

export function reminderDisplayStatus(
  status: string | null | undefined,
  errorMessage: string | null | undefined
): ReminderDisplayStatus {
  if (status === "failed" && errorMessage === REMINDER_CANCELLED_REASON) return "cancelled";
  if (status === "failed" && errorMessage === REMINDER_NOT_SENT_REASON) return "not_sent";
  if (status === "sent" || status === "failed") return status;
  return "pending";
}
