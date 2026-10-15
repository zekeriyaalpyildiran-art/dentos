// Turkish texts for appointment write errors. The database guard (migration 0028, trigger appt_slot_guard) raises
// the same keys and texts as the CRM booking (crm__raise E_SLOT_*) with the key in HINT; the exclusion constraints
// behind it answer 23P01 with the constraint name. Pure helper, unit-tested.

export const SLOT_ERROR_TEXTS = {
  E_SLOT_DOCTOR: "Seçilen hekimin bu saatte başka bir randevusu var.",
  E_SLOT_CHAIR: "Seçilen koltuk bu saatte dolu.",
  E_SLOT_ORDER: "Bitiş saati başlangıç saatinden sonra olmalı.",
} as const;

export type SlotErrorKey = keyof typeof SLOT_ERROR_TEXTS;

/** Names of the exclusion constraints created by 0028_ajanda_guard.sql. */
export const SLOT_CONSTRAINTS = {
  doctor: "appointments_no_double_doctor",
  chair: "appointments_no_double_chair",
} as const;

const KEY_RE = /^E_[A-Z0-9_]+$/;

/**
 * User-facing text for a failed appointment insert / update. Known keys map to fixed texts; another server error
 * carrying an E_* key in HINT already has a Turkish message (error contract of 0020-0028); anything else gets the
 * caller's fallback, so raw English database texts never reach the user.
 */
export function appointmentWriteErrorText(err: unknown, fallback: string): string {
  if (!err || typeof err !== "object") return fallback;
  const e = err as { code?: unknown; hint?: unknown; message?: unknown };
  const hint = typeof e.hint === "string" ? e.hint : "";
  const message = typeof e.message === "string" ? e.message : "";

  if (hint in SLOT_ERROR_TEXTS) return SLOT_ERROR_TEXTS[hint as SlotErrorKey];
  if (e.code === "23P01") {
    if (message.includes(SLOT_CONSTRAINTS.doctor)) return SLOT_ERROR_TEXTS.E_SLOT_DOCTOR;
    if (message.includes(SLOT_CONSTRAINTS.chair)) return SLOT_ERROR_TEXTS.E_SLOT_CHAIR;
    return "Bu saatte çakışan başka bir randevu var.";
  }
  if (KEY_RE.test(hint) && message) return message;
  return fallback;
}
