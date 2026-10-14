import type { createClient } from "@/lib/supabase";

type SupabaseClient = ReturnType<typeof createClient>;

// reminder_status has no "cancelled" value and reminders have no DELETE policy, so a reminder of an
// appointment that is no longer scheduled is closed as "failed" with this reason; the reminders page shows it as "İptal".
export const REMINDER_CANCELLED_REASON = "Hatırlatma iptal edildi";

const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

// Applies changes to the appointment's pending reminders. Returns false if any of them was not updated,
// since RLS skips rows silently; an appointment without pending reminders counts as success.
const updatePendingReminders = async (
  supabase: SupabaseClient,
  clinicId: string,
  appointmentId: string,
  changes: Record<string, unknown>
) => {
  const { data: pending, error } = await supabase
    .from("reminders")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("appointment_id", appointmentId)
    .eq("status", "pending");

  if (error) return false;
  if (!pending || pending.length === 0) return true;

  const { data: updated, error: updateError } = await supabase
    .from("reminders")
    .update(changes)
    .in("id", pending.map((r) => r.id))
    .eq("clinic_id", clinicId)
    .eq("status", "pending")
    .select("id");

  return !updateError && (updated?.length ?? 0) === pending.length;
};

export const cancelPendingReminders = (supabase: SupabaseClient, clinicId: string, appointmentId: string) =>
  updatePendingReminders(supabase, clinicId, appointmentId, {
    status: "failed",
    error_message: REMINDER_CANCELLED_REASON,
  });

// Moves pending reminders to 24h before the new start, matching how appointments/new schedules them.
export const reschedulePendingReminders = (
  supabase: SupabaseClient,
  clinicId: string,
  appointmentId: string,
  startIso: string
) =>
  updatePendingReminders(supabase, clinicId, appointmentId, {
    scheduled_at: new Date(new Date(startIso).getTime() - REMINDER_LEAD_MS).toISOString(),
  });
