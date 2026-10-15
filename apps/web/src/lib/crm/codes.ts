// Phase 6 CRM code lists (DB contract §1.4). ASCII codes live in the database (CHECK constraints);
// the Turkish labels live here. Order = the legacy order (MO:7-14), which the selects and reports follow.

// ---------------------------------------------------------------------------
// Stage (leads.stage)
// ---------------------------------------------------------------------------

export const STAGES = [
  { value: "new", label: "Yeni başvuru" },
  { value: "in_contact", label: "Görüşülüyor" },
  { value: "appointment_booked", label: "Randevu alındı" },
  { value: "appointment_attended", label: "Randevuya geldi" },
  { value: "offer_given", label: "Teklif verildi" },
  { value: "treatment_started", label: "Tedavi başladı" },
  { value: "treatment_completed", label: "Tedavi tamamlandı" },
  { value: "lost", label: "Olumsuz" },
  { value: "archived", label: "Arşiv" },
] as const;

export type Stage = (typeof STAGES)[number]["value"];

export const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.value, s.label])) as Record<Stage, string>;

export const STAGE_STYLES: Record<Stage, string> = {
  new: "bg-gray-100 text-gray-800",
  in_contact: "bg-blue-100 text-blue-800",
  appointment_booked: "bg-indigo-100 text-indigo-800",
  appointment_attended: "bg-violet-100 text-violet-800",
  offer_given: "bg-amber-100 text-amber-800",
  treatment_started: "bg-emerald-100 text-emerald-800",
  treatment_completed: "bg-green-100 text-green-800",
  lost: "bg-red-100 text-red-800",
  archived: "bg-gray-200 text-gray-600",
};

/** TK:16, RR:192 */
export const CLOSED_STAGES: readonly Stage[] = ["treatment_started", "treatment_completed", "lost", "archived"];
/** CP:23 */
export const BOOKED_STAGES: readonly Stage[] = [
  "appointment_booked",
  "appointment_attended",
  "offer_given",
  "treatment_started",
  "treatment_completed",
];
/** TK:49 */
export const WON_STAGES: readonly Stage[] = ["treatment_started", "treatment_completed"];

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "—";
  return STAGE_LABELS[stage as Stage] ?? stage;
}

// ---------------------------------------------------------------------------
// Interest, contact result, loss reason
// ---------------------------------------------------------------------------

export const INTERESTS = [
  { value: "hot", label: "Sıcak" },
  { value: "warm", label: "Ilık" },
  { value: "cold", label: "Soğuk" },
  { value: "unknown", label: "Belirsiz" },
] as const;
export type Interest = (typeof INTERESTS)[number]["value"];
export const INTEREST_LABELS = Object.fromEntries(INTERESTS.map((s) => [s.value, s.label])) as Record<
  Interest,
  string
>;
export const INTEREST_STYLES: Record<Interest, string> = {
  hot: "bg-red-100 text-red-700",
  warm: "bg-amber-100 text-amber-800",
  cold: "bg-sky-100 text-sky-800",
  unknown: "bg-gray-100 text-gray-600",
};

export const CONTACT_RESULTS = [
  { value: "unspecified", label: "Belirtilmedi" },
  { value: "wants_treatment", label: "Randevu / tedavi istiyor" },
  { value: "considering_price", label: "Fiyatı değerlendiriyor" },
  { value: "considering_timing", label: "Zamanlamayı değerlendiriyor" },
  { value: "will_think_later", label: "Daha sonra düşünecek" },
  { value: "unreachable", label: "Ulaşılamadı" },
  { value: "call_on_date", label: "Belirli tarihte aranmak istiyor" },
  { value: "negative", label: "Olumsuz" },
  { value: "comparing_clinics", label: "Başka yerle de görüşüyor" },
  { value: "appointment_confirmed", label: "Randevu kesinleşti" },
] as const;
export type ContactResult = (typeof CONTACT_RESULTS)[number]["value"];
export const CONTACT_RESULT_LABELS = Object.fromEntries(CONTACT_RESULTS.map((s) => [s.value, s.label])) as Record<
  ContactResult,
  string
>;

export const LOSS_REASONS = [
  { value: "price_high", label: "Fiyat yüksek" },
  { value: "timing_unsuitable", label: "Zamanlama uygun değil" },
  { value: "unreachable", label: "Ulaşılamadı" },
  { value: "chose_other_clinic", label: "Başka klinik seçti" },
  { value: "postponed", label: "Tedaviyi erteledi" },
  { value: "not_suitable", label: "Tedaviye uygun değil" },
  { value: "other", label: "Diğer" },
] as const;
export type LossReason = (typeof LOSS_REASONS)[number]["value"];
export const LOSS_REASON_LABELS = Object.fromEntries(LOSS_REASONS.map((s) => [s.value, s.label])) as Record<
  LossReason,
  string
>;

// ---------------------------------------------------------------------------
// Source (leads.source, crm_ad_spend.source)
// ---------------------------------------------------------------------------

export const SOURCES = [
  { value: "instagram_meta", label: "Instagram / Meta" },
  { value: "google", label: "Google" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone_call", label: "Arama" },
  { value: "referral", label: "Referans" },
  { value: "walk_in", label: "Yoldan gelen" },
  { value: "other", label: "Diğer" },
] as const;
export type Source = (typeof SOURCES)[number]["value"];

/** Accepted but deprecated: shown with " (eski)" and only kept when unchanged (contract §1.4). */
export const DEPRECATED_SOURCES = [
  { value: "direct", label: "Doğrudan (eski)" },
  { value: "online", label: "Online (eski)" },
  { value: "social_media", label: "Sosyal Medya (eski)" },
] as const;

const SOURCE_LABEL_MAP: Record<string, string> = Object.fromEntries(
  [...SOURCES, ...DEPRECATED_SOURCES].map((s) => [s.value, s.label])
);

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Bilinmiyor";
  return SOURCE_LABEL_MAP[source] ?? source;
}

export function isActiveSource(value: string): value is Source {
  return SOURCES.some((s) => s.value === value);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const CALL_STATUSES = [
  { value: "planned", label: "Planlandı" },
  { value: "reached", label: "Görüşüldü" },
  { value: "unreachable", label: "Ulaşılamadı" },
  { value: "cancelled", label: "İptal" },
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number]["value"];
export type CallResultStatus = Exclude<CallStatus, "planned">;
export const CALL_STATUS_LABELS = Object.fromEntries(CALL_STATUSES.map((s) => [s.value, s.label])) as Record<
  CallStatus,
  string
>;
export const CALL_STATUS_STYLES: Record<CallStatus, string> = {
  planned: "bg-blue-100 text-blue-800",
  reached: "bg-green-100 text-green-800",
  unreachable: "bg-amber-100 text-amber-800",
  cancelled: "bg-gray-200 text-gray-600",
};

export type CallOrigin = "manual" | "automatic";
export const CALL_ORIGIN_LABELS: Record<CallOrigin, string> = {
  manual: "Elle",
  automatic: "Otomatik",
};

/** CRF:12 labels. */
export const CALL_DECISIONS = [
  { value: "auto", label: "Sonuca göre otomatik planla" },
  { value: "followup", label: "Yeni arama planla" },
  { value: "clinic", label: "Klinik randevusu kesinleşti" },
  { value: "completed", label: "Takip tamamlandı" },
  { value: "lost", label: "Olumsuz sonuçlandı" },
  { value: "stop", label: "Telefonla aranmak istemiyor" },
] as const;
export type CallDecision = (typeof CALL_DECISIONS)[number]["value"];
export const CALL_DECISION_LABELS = Object.fromEntries(CALL_DECISIONS.map((s) => [s.value, s.label])) as Record<
  CallDecision,
  string
>;

// ---------------------------------------------------------------------------
// Reminders, follow-up state, activities
// ---------------------------------------------------------------------------

export const REMINDER_OUTCOMES = [
  { value: "reminded", label: "Hatırlatıldı" },
  { value: "unreachable", label: "Ulaşılamadı" },
] as const;
export type ReminderOutcome = (typeof REMINDER_OUTCOMES)[number]["value"];
export const REMINDER_OUTCOME_LABELS: Record<ReminderOutcome, string> = {
  reminded: "Hatırlatıldı",
  unreachable: "Ulaşılamadı",
};

export type FollowupState = "open" | "done";
export const FOLLOWUP_STATE_LABELS: Record<FollowupState, string> = {
  open: "Takip açık",
  done: "Takip tamamlandı",
};

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  note: "Not",
  update: "Güncelleme",
  stage: "Aşama",
  call: "Arama",
  schedule: "Plan değişikliği",
  reminder: "Hatırlatma",
  handoff: "Aktarım",
  legacy: "Eski not",
  sms: "SMS",
  email: "E-posta",
  visit: "Ziyaret",
};

// ---------------------------------------------------------------------------
// Handoffs and staff tasks
// ---------------------------------------------------------------------------

export const HANDOFF_TOPICS = [
  { value: "price_payment", label: "Fiyat / ödeme talebi" },
  { value: "treatment_question", label: "Tedaviyle ilgili soru" },
  { value: "followup_decision", label: "Takip kararı" },
  { value: "other", label: "Diğer" },
] as const;
export type HandoffTopic = (typeof HANDOFF_TOPICS)[number]["value"];
export const HANDOFF_TOPIC_LABELS = Object.fromEntries(HANDOFF_TOPICS.map((s) => [s.value, s.label])) as Record<
  HandoffTopic,
  string
>;

export type HandoffStatus = "waiting" | "answered" | "completed" | "cancelled";
/** Inbox filters (HI). */
export const HANDOFF_STATUS_TABS: { value: HandoffStatus; label: string }[] = [
  { value: "waiting", label: "Karar bekleyen" },
  { value: "answered", label: "Yapılacak işler" },
  { value: "completed", label: "Tamamlandı" },
  { value: "cancelled", label: "Geri çekildi" },
];
export const HANDOFF_STATUS_LABELS: Record<HandoffStatus, string> = {
  waiting: "Yönetici kararı bekleniyor",
  answered: "Yanıtlandı · yapılacak iş",
  completed: "Tamamlandı",
  cancelled: "Geri çekildi",
};
export const HANDOFF_STATUS_STYLES: Record<HandoffStatus, string> = {
  waiting: "bg-amber-100 text-amber-800",
  answered: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-gray-200 text-gray-600",
};

export type TaskStatus = "open" | "done" | "cancelled";
export type TaskDisplayStatus = "done" | "cancelled" | "overdue" | "new" | "open";
/** TMU:19 */
export const TASK_DISPLAY_LABELS: Record<TaskDisplayStatus, string> = {
  done: "Tamamlandı",
  cancelled: "İptal edildi",
  overdue: "Gecikti",
  new: "Yeni",
  open: "Açık",
};
export const TASK_DISPLAY_STYLES: Record<TaskDisplayStatus, string> = {
  done: "bg-green-100 text-green-800",
  cancelled: "bg-gray-200 text-gray-600",
  overdue: "bg-red-100 text-red-700",
  new: "bg-blue-100 text-blue-800",
  open: "bg-amber-100 text-amber-800",
};

// ---------------------------------------------------------------------------
// Work list
// ---------------------------------------------------------------------------

export const WORK_FILTERS = [
  { value: "all", label: "Günlük liste" },
  { value: "overdue", label: "Gecikenler" },
  { value: "today", label: "Bugün yapılacaklar" },
  { value: "missing", label: "Takip planı eksik" },
  { value: "future", label: "İleri tarihli" },
] as const;
export type WorkFilter = (typeof WORK_FILTERS)[number]["value"];

export function isWorkFilter(value: string | null | undefined): value is WorkFilter {
  return WORK_FILTERS.some((f) => f.value === value);
}

export type WorkItemType =
  | "handoff"
  | "reminder"
  | "clinic_result"
  | "clinic_today"
  | "call_overdue"
  | "call_today"
  | "review"
  | "followup_overdue"
  | "unreachable"
  | "followup_today"
  | "first_contact"
  | "missing_step"
  | "missing_plan"
  | "future_handoff"
  | "future_call"
  | "future_followup";

// ---------------------------------------------------------------------------
// Money and calendar
// ---------------------------------------------------------------------------

export const CURRENCIES = ["TRY", "EUR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const CURRENCY_LABELS: Record<Currency, string> = { TRY: "TL", EUR: "EUR", USD: "USD" };

/** 0 = Pazar … 6 = Cumartesi (FU:6). */
export const WEEKDAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"] as const;

// ---------------------------------------------------------------------------
// Appointments (appointment_status; legacy visit labels Planlandı / Geldi / Gelmedi / İptal)
// ---------------------------------------------------------------------------

export const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: "Planlı",
  completed: "Geldi",
  cancelled: "İptal",
  no_show: "Gelmedi",
};
export const APPOINTMENT_STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-yellow-100 text-yellow-800",
};
