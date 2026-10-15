// Phase 6 CRM follow-up engine: typed RPC wrappers, JSON shapes and small client helpers.
// Contract: spec p6_db_contract (§3.2 JSON shapes, §4 write RPCs, §5 read RPCs, §8 index). Every write goes through a
// SECURITY DEFINER RPC; the clinic, "today" and "now" always come from the server. Ids are client uuids made when a
// form opens and reused for retries (crypto.randomUUID()).

import { createClient } from "./supabase";
import type {
  CallDecision,
  CallOrigin,
  CallResultStatus,
  CallStatus,
  ContactResult,
  Currency,
  FollowupState,
  HandoffStatus,
  HandoffTopic,
  Interest,
  LossReason,
  ReminderOutcome,
  Stage,
  TaskDisplayStatus,
  TaskStatus,
  WorkFilter,
  WorkItemType,
} from "./crm/codes";

export { formatDay, formatMonth, formatTimestamp, formatTL, parseTL, centsToInput, UUID_RE } from "./finance";

// ---------------------------------------------------------------------------
// Errors (contract §1.1: 42501 → 403, PT404 → 404, PT409 → 409, P0001 → 400)
// ---------------------------------------------------------------------------

export class CrmError extends Error {
  code: string | null;
  details: string | null;

  constructor(message: string, code: string | null, details: string | null) {
    super(message);
    this.name = "CrmError";
    this.code = code;
    this.details = details;
  }

  /** PT409: version conflict, already concluded, duplicate; the UI offers "Yenile". */
  get isConflict() {
    return this.code === "PT409";
  }
  get isNotFound() {
    return this.code === "PT404";
  }
  get isForbidden() {
    return this.code === "42501";
  }
}

const NETWORK_MESSAGE = "İşlem tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin.";

export function toCrmError(err: unknown): CrmError {
  if (err instanceof CrmError) return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; details?: unknown };
    const message = typeof e.message === "string" && e.message ? e.message : NETWORK_MESSAGE;
    return new CrmError(
      message,
      typeof e.code === "string" ? e.code : null,
      typeof e.details === "string" ? e.details : null
    );
  }
  return new CrmError(NETWORK_MESSAGE, null, null);
}

let client: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!client) client = createClient();
  return client;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = args ? await sb().rpc(name, args) : await sb().rpc(name);
  } catch (err) {
    throw toCrmError(err);
  }
  if (result.error) throw toCrmError(result.error);
  return result.data as T;
}

/** Client-supplied ids: created when a form opens, reused for retries until success. */
export function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// JSON shapes (contract §3.2; snake_case keys)
// ---------------------------------------------------------------------------

export interface PhoneMatchesJson {
  normalized: string;
  leads: { id: string; full_name: string; stage: Stage; assigned_name: string | null }[];
  patients: { id: string; full_name: string; is_active: boolean }[];
}

export interface NextCallRef {
  id: string;
  date: string;
  time: string;
  caller_user_id: string | null;
  caller_name: string | null;
  origin: CallOrigin;
}

export interface UpcomingAppointmentRef {
  id: string;
  start_time: string;
  end_time: string;
  doctor_name: string | null;
  chair_name: string | null;
  reminder_outcome: ReminderOutcome | null;
  reminder_current: boolean;
}

export interface LeadJson {
  id: string;
  version: number;
  full_name: string;
  phone: string;
  phone_normalized: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  referrer: string;
  campaign: string;
  treatment_interest: string;
  assigned_to: string | null;
  assigned_name: string | null;
  stage: Stage;
  stage_entered_at: string | null;
  /** deprecated compat value of leads.status */
  status: string;
  interest: Interest;
  contact_result: ContactResult;
  loss_reason: LossReason | null;
  followup_date: string | null;
  followup_state: FollowupState;
  next_action: string;
  do_not_contact: boolean;
  automation_review: string | null;
  treatment_closed_at: string | null;
  treatment_closed_by_name: string | null;
  patient_id: string | null;
  patient_name: string | null;
  converted_at: string | null;
  quote_amount_cents: number | null;
  quote_currency: Currency;
  notes_legacy: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by_name: string | null;
  is_open: boolean;
  missing_plan: boolean;
  next_call: NextCallRef | null;
  upcoming_appointment: UpcomingAppointmentRef | null;
  open_handoff: { id: string; status: HandoffStatus; topic: HandoffTopic; answer_due_date: string | null } | null;
}

export interface CallJson {
  id: string;
  version: number;
  lead_id: string;
  lead_name: string | null;
  caller_user_id: string | null;
  caller_name: string | null;
  caller_name_legacy?: string | null;
  date: string;
  time: string;
  status: CallStatus;
  origin: CallOrigin;
  decision: CallDecision | null;
  contact_result: ContactResult | null;
  /** The resolution note as it reads now (a note correction wins over the frozen call row). */
  note: string | null;
  /** True when that note was corrected after the call was saved. */
  note_edited?: boolean;
  auto_cancelled: boolean;
  cancel_reason: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  next_call_id: string | null;
  appointment_id: string | null;
  created_at: string;
}

export interface ScheduleChangeJson {
  type: "call" | "followup";
  call_id?: string | null;
  from_date: string | null;
  from_time?: string | null;
  to_date: string | null;
  to_time?: string | null;
  reason: string;
}

export interface ActivityJson {
  id: string;
  seq: number;
  type: string;
  text: string;
  is_private: boolean;
  schedule_change: ScheduleChangeJson | null;
  call_id: string | null;
  appointment_id: string | null;
  edited_from: string | null;
  edited_at: string | null;
  edited_by_name: string | null;
  actor_name: string | null;
  created_at: string;
  version: number;
  editable: boolean;
}

export interface HandoffJson {
  id: string;
  version: number;
  lead_id: string;
  lead_name: string | null;
  topic: HandoffTopic;
  question: string;
  status: HandoffStatus;
  requested_by_name: string | null;
  requested_at: string;
  answer_text: string | null;
  answer_due_date: string | null;
  answer_assignee_user_id: string | null;
  answer_assignee_name: string | null;
  answered_by_name: string | null;
  answered_at: string | null;
  completion_text: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  system_closed: boolean;
  /** Present only for crm_can_manage(); otherwise the key is absent. */
  private_note?: string | null;
}

export interface TaskJson {
  id: string;
  version: number;
  title: string;
  detail: string;
  due_date: string;
  lead_id: string | null;
  lead_name: string | null;
  lead_visible: boolean;
  patient_id: string | null;
  patient_name: string | null;
  assignee_user_id: string;
  assignee_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  status: TaskStatus;
  read_at: string | null;
  completed_at: string | null;
  completed_by_name: string | null;
  result: string;
  cancelled_at: string | null;
  display_status: TaskDisplayStatus;
}

export interface RulesValues {
  enabled: boolean;
  work_days: number[];
  start_time: string;
  end_time: string;
  call_time: string;
  retry_days: number;
  interested_days: number;
  price_days: number;
  timing_days: number;
  later_days: number;
  max_unreachable: number;
  first_call_minutes: number;
  stale_days: number;
  offer_days: number;
}

export interface RulesJson extends RulesValues {
  /** 0 = defaults, never saved */
  version: number;
  daily_minutes: number;
}

/** Legacy defaultFollowupRules (FU:15) = the column defaults; version 0 when the clinic has no row. */
export const DEFAULT_RULES: RulesJson = {
  version: 0,
  enabled: true,
  work_days: [1, 2, 3, 4, 5, 6],
  start_time: "09:00",
  end_time: "18:00",
  call_time: "10:00",
  retry_days: 1,
  interested_days: 1,
  price_days: 3,
  timing_days: 7,
  later_days: 7,
  max_unreachable: 3,
  first_call_minutes: 60,
  stale_days: 7,
  offer_days: 3,
  daily_minutes: 540,
};

export interface PageArg {
  offset?: number;
  limit?: number;
}

export interface Paged<T> {
  rows: T[];
  total_count: number;
}

/** Envelope of every write RPC. */
export interface Envelope {
  already_saved: boolean;
}

// ---------------------------------------------------------------------------
// Write RPCs (contract §4)
// ---------------------------------------------------------------------------

/** Editable keys of p_lead (§4.1). On edit every key must be present. */
export interface LeadInput {
  full_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  source: string | null;
  referrer: string;
  campaign: string;
  treatment_interest: string;
  assigned_to: string | null;
  stage: Stage;
  interest: Interest;
  contact_result: ContactResult;
  loss_reason: LossReason | null;
  followup_date: string | null;
  followup_state: FollowupState;
  next_action: string;
  do_not_contact: boolean;
  quote_amount_cents: number | null;
  quote_currency: Currency;
}

export interface InitialCallInput {
  id: string;
  date: string;
  time: string;
  caller_user_id: string | null;
}

export interface SaveLeadResult extends Envelope {
  lead: LeadJson;
  phone_matches: PhoneMatchesJson;
  cancelled_call_ids: string[];
  initial_call: CallJson | null;
}

export function crmSaveLead(args: {
  p_id: string;
  p_version: number | null;
  p_lead: LeadInput;
  p_note: string | null;
  p_schedule_reason: string | null;
  p_initial_call: InitialCallInput | null;
}) {
  return rpc<SaveLeadResult>("crm_save_lead", { ...args });
}

export function crmAddNote(args: { p_lead_id: string; p_activity_id: string; p_text: string; p_private: boolean }) {
  return rpc<Envelope & { activity: ActivityJson }>("crm_add_note", { ...args });
}

export function crmCorrectNote(args: {
  p_activity_id: string;
  p_version: number;
  p_text: string;
  p_correction_id: string;
}) {
  return rpc<Envelope & { activity: ActivityJson; correction: ActivityJson | null }>("crm_correct_note", { ...args });
}

export function crmPlanCall(args: {
  p_id: string;
  p_lead_id: string;
  p_caller_user_id: string | null;
  p_date: string;
  p_time: string;
}) {
  return rpc<Envelope & { call: CallJson; lead: LeadJson }>("crm_plan_call", { ...args });
}

export function crmRescheduleCall(args: {
  p_call_id: string;
  p_version: number;
  p_date: string;
  p_time: string;
  p_caller_user_id: string | null;
  p_reason: string | null;
}) {
  return rpc<Envelope & { call: CallJson; lead: LeadJson }>("crm_reschedule_call", { ...args });
}

export interface FollowupInput {
  date: string;
  time: string;
  action: string;
}

export interface NewPatientInput {
  full_name?: string;
  phone?: string;
  email?: string | null;
  gender?: string | null;
  birth_date?: string | null;
  address?: string | null;
  notes?: string | null;
  kvkk_consent?: boolean;
}

export interface AppointmentInput {
  id: string;
  doctor_id: string;
  chair_id: string;
  procedure_id?: string | null;
  start_time: string;
  end_time: string;
  notes?: string | null;
  /** link an existing patient */
  patient_id?: string | null;
  new_patient_id?: string | null;
  patient?: NewPatientInput | null;
}

export interface ResolveCallResult extends Envelope {
  call: CallJson;
  lead: LeadJson;
  next_call: CallJson | null;
  appointment: {
    id: string;
    start_time: string;
    end_time: string;
    doctor_name: string | null;
    chair_name: string | null;
  } | null;
  patient_created: boolean;
  plan: { kind: "call" | "keep" | "stop" | "review"; reason: string; date: string | null; time: string | null } | null;
  cancelled_call_ids: string[];
  phone_matches: PhoneMatchesJson;
}

export function crmResolveCall(args: {
  p_call_id: string;
  p_call_version: number | null;
  p_lead_id: string;
  p_lead_version: number;
  p_request_id: string;
  p_status: CallResultStatus;
  p_note: string;
  p_decision: CallDecision;
  p_contact_result: ContactResult | null;
  p_next_call_id: string | null;
  p_followup: FollowupInput | null;
  p_loss_reason: LossReason | null;
  p_appointment: AppointmentInput | null;
}) {
  return rpc<ResolveCallResult>("crm_resolve_call", { ...args });
}

export interface ConvertResult extends Envelope {
  lead: LeadJson;
  patient: { id: string; full_name: string; phone: string; is_active: boolean };
  created: boolean;
  phone_matches: PhoneMatchesJson;
}

export function crmConvertToPatient(args: {
  p_lead_id: string;
  p_version: number;
  p_patient_id: string | null;
  p_new_patient_id: string | null;
  p_patient: NewPatientInput | null;
}) {
  return rpc<ConvertResult>("crm_convert_to_patient", { ...args });
}

export type HandoffAction = "request" | "answer" | "complete" | "cancel";

export function crmHandoffAction(args: {
  p_action: HandoffAction;
  p_handoff_id: string;
  p_version: number | null;
  p_lead_id: string | null;
  p_topic: HandoffTopic | null;
  p_text: string;
  p_due_date: string | null;
  p_private_note: string | null;
  p_assignee_user_id: string | null;
}) {
  return rpc<Envelope & { handoff: HandoffJson }>("crm_handoff_action", { ...args });
}

export type TaskAction = "create" | "update" | "read" | "complete" | "cancel";

export function staffTaskAction(args: {
  p_action: TaskAction;
  p_id: string;
  p_version: number | null;
  p_title: string | null;
  p_detail: string | null;
  p_due_date: string | null;
  p_assignee_user_id: string | null;
  p_lead_id: string | null;
  p_patient_id: string | null;
  p_result: string | null;
}) {
  return rpc<Envelope & { task: TaskJson }>("staff_task_action", { ...args });
}

export function crmSaveFollowupRules(args: { p_version: number; p_rules: RulesValues }) {
  return rpc<Envelope & { rules: RulesJson }>("crm_save_followup_rules", { ...args });
}

export interface ReminderResult extends Envelope {
  appointment: {
    id: string;
    start_time: string;
    doctor_id: string | null;
    status: string;
    reminder_outcome: ReminderOutcome | null;
    reminder_note: string | null;
    reminded_at: string | null;
    reminded_by_name: string | null;
    reminder_current: boolean;
  };
  log: { id: string; outcome: ReminderOutcome; note: string; created_at: string };
}

export function crmSetReminderOutcome(args: {
  p_appointment_id: string;
  p_event_id: string;
  p_start_time: string;
  p_doctor_id: string | null;
  p_outcome: ReminderOutcome;
  p_note: string;
}) {
  return rpc<ReminderResult>("crm_set_reminder_outcome", { ...args });
}

export interface AdSpendRow {
  id: string;
  version: number;
  source: string;
  /** 'YYYY-MM-DD' (first day) from the table; the RPC row may carry 'YYYY-MM' */
  month: string;
  amount_cents: number;
  currency: Currency;
  note: string;
  updated_at: string;
  updated_by_name?: string | null;
}

export function crmSaveAdSpend(args: {
  p_id: string;
  p_version: number | null;
  p_source: string;
  p_month: string;
  p_amount_cents: number;
  p_currency: Currency;
  p_note: string;
}) {
  return rpc<Envelope & { row: AdSpendRow }>("crm_save_ad_spend", { ...args });
}

export function crmTrashLead(args: { p_lead_id: string; p_version: number }) {
  return rpc<Envelope & { lead_id: string; hidden_call_ids: string[] }>("crm_trash_lead", { ...args });
}

export function crmRestoreLead(args: { p_lead_id: string; p_version: number }) {
  return rpc<Envelope & { lead: LeadJson; phone_matches: PhoneMatchesJson }>("crm_restore_lead", { ...args });
}

// ---------------------------------------------------------------------------
// Read RPCs (contract §5)
// ---------------------------------------------------------------------------

export function crmCanManage() {
  return rpc<boolean>("crm_can_manage");
}

export interface WorkItemJson {
  key: string;
  type: WorkItemType;
  bucket: "daily" | "missing" | "future";
  priority: number;
  reason: string;
  action: string;
  due_date: string | null;
  due_time: string | null;
  lead: {
    id: string;
    version: number;
    full_name: string;
    phone: string;
    interest: Interest;
    stage: Stage;
    assigned_name: string | null;
  } | null;
  patient: { id: string; full_name: string; phone: string } | null;
  call: { id: string; version: number; caller_user_id: string | null; caller_name: string | null } | null;
  handoff_id: string | null;
  appointment: {
    id: string;
    start_time: string;
    doctor_id: string | null;
    doctor_name: string | null;
    reminder_outcome: ReminderOutcome | null;
    reminder_current: boolean;
  } | null;
  quick_call: boolean;
}

export interface WorkCounts {
  all: number;
  overdue: number;
  today: number;
  missing: number;
  future: number;
}

export interface WorkListJson {
  today: string;
  filter: WorkFilter;
  rows: WorkItemJson[];
  total_count: number;
  counts: WorkCounts;
  overdue_patients: number;
  quick_call_lead_ids: string[];
  my_tasks: { open: number; unread: number; overdue: number };
}

export function crmWorkList(args: { p_filter?: WorkFilter; p_user_id?: string | null; p_page?: PageArg } = {}) {
  return rpc<WorkListJson>("crm_work_list", {
    p_filter: args.p_filter ?? "all",
    p_user_id: args.p_user_id ?? null,
    p_page: args.p_page ?? {},
  });
}

export interface OverdueListJson {
  today: string;
  clinic_name: string;
  count: number;
  patient_count: number;
  patients: {
    lead: { id: string; full_name: string; phone: string; assigned_name: string | null } | null;
    patient: { id: string; full_name: string; phone: string } | null;
    items: { key: string; type: WorkItemType; reason: string; action: string; due_date: string | null; due_time: string | null }[];
  }[];
  export_rows: { name: string; phone: string; date: string; days: number; action: string }[];
}

export function crmOverdueList(args: { p_page?: PageArg } = {}) {
  return rpc<OverdueListJson>("crm_overdue_list", { p_page: args.p_page ?? {} });
}

export interface DaySummaryJson {
  day: string;
  counts: {
    resolved: number;
    reached: number;
    unreachable: number;
    cancelled: number;
    unreachable_patients: number;
    pending: number;
    changes: number;
    reminders: number;
    auto_cancelled: number;
    legacy_undated: number;
  };
  resolved: {
    call_id: string;
    lead_id: string;
    lead_name: string;
    status: CallResultStatus;
    resolved_at: string;
    resolved_by_name: string | null;
    scheduled_date: string;
    scheduled_time: string;
  }[];
  unreachable_patients: { lead_id: string; full_name: string; phone: string; attempts: number }[];
  changes: {
    activity_id: string;
    lead_id: string;
    lead_name: string;
    type: "call" | "followup";
    from_date: string | null;
    from_time: string | null;
    to_date: string | null;
    to_time: string | null;
    reason: string;
    at: string;
    actor_name: string | null;
  }[];
  reminders: {
    log_id: string;
    appointment_id: string;
    patient_id: string;
    patient_name: string;
    outcome: ReminderOutcome;
    note: string;
    at: string;
    actor_name: string | null;
  }[];
  truncated: boolean;
}

export function crmDaySummary() {
  return rpc<DaySummaryJson>("crm_day_summary");
}

export interface CohortCounts {
  total: number;
  booked: number;
  won: number;
}

export interface ManagerSummaryJson {
  today: string;
  workload: {
    overdue_items: number;
    today_call_patients: number;
    missing_plan_patients: number;
    /** Leads with a reminder item (same set as the 'reminders' drill-down). */
    reminder_patients: number;
    /** Every reminder item, appointments of patients without a lead included. */
    reminder_items: number;
  };
  cohort: {
    start: string;
    end: string;
    previous_start: string;
    previous_end: string;
    current: CohortCounts;
    previous: CohortCounts;
    by_source: ({ source: string | null } & CohortCounts)[];
  };
}

export function crmManagerSummary(args: { p_days: 1 | 7 | 30 }) {
  return rpc<ManagerSummaryJson>("crm_manager_summary", { ...args });
}

export interface InsightsJson {
  today: string;
  window_start: string;
  rules_version: number;
  counts: {
    waiting: number;
    late_first: number;
    stalled: number;
    offers: number;
    review: number;
    unknown_stage: number;
  };
  first_attempt: { median_minutes: number | null; sample: number; excluded_legacy: number };
  first_reached: { median_minutes: number | null; sample: number };
}

export function crmFollowupInsights() {
  return rpc<InsightsJson>("crm_followup_insights");
}

export type SummaryList =
  | "cohort_total"
  | "cohort_booked"
  | "cohort_won"
  | "previous_cohort_total"
  | "previous_cohort_booked"
  | "previous_cohort_won"
  | "today_calls"
  | "missing_plan"
  | "reminders"
  | "waiting"
  | "late_first"
  | "stalled"
  | "offers"
  | "review"
  | "unknown_stage";

export interface SummaryLeadRow {
  id: string;
  version: number;
  full_name: string;
  phone: string;
  stage: Stage;
  source: string | null;
  assigned_name: string | null;
  followup_date: string | null;
  next_action: string;
  created_at: string;
  open_task_count: number;
}

export function crmSummaryLeads(args: {
  p_list: SummaryList;
  p_days?: number | null;
  p_source?: string | null;
  p_page?: PageArg;
}) {
  return rpc<Paged<SummaryLeadRow> & { title_key: SummaryList }>("crm_summary_leads", {
    p_list: args.p_list,
    p_days: args.p_days ?? null,
    p_source: args.p_source ?? null,
    p_page: args.p_page ?? {},
  });
}

export interface SourceReportRow {
  source: string | null;
  leads: number;
  booked: number;
  won: number;
  lost: number;
  /** money keys: present only when money_visible */
  collections_cents?: number;
  ad_spend?: { currency: Currency; amount_cents: number }[];
  multiplier?: number | null;
}

export interface SourceReportJson {
  from_month: string | null;
  to_month: string | null;
  money_visible: boolean;
  totals: { leads: number; booked: number; won: number; lost: number };
  by_source: SourceReportRow[];
  loss_reasons: { loss_reason: LossReason; count: number }[];
}

export function crmSourceReport(args: { p_from_month: string | null; p_to_month: string | null }) {
  return rpc<SourceReportJson>("crm_source_report", { ...args });
}

export interface LeadListFilters {
  q?: string;
  stage?: Stage;
  source?: string;
  interest?: Interest;
  assigned_to?: string;
  missing_plan?: boolean;
  include_closed?: boolean;
  sort?: "created_desc" | "followup_asc" | "name_asc";
}

export function crmLeadList(args: { p_filters?: LeadListFilters; p_page?: PageArg } = {}) {
  // Unknown keys or empty values raise E_FILTER, so only set keys are sent.
  const filters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.p_filters ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    filters[k] = v;
  }
  return rpc<Paged<LeadJson>>("crm_lead_list", { p_filters: filters, p_page: args.p_page ?? {} });
}

export function crmPhoneMatches(args: {
  p_phone: string;
  p_exclude_lead_id?: string | null;
  p_exclude_patient_id?: string | null;
}) {
  return rpc<PhoneMatchesJson>("crm_phone_matches", {
    p_phone: args.p_phone,
    p_exclude_lead_id: args.p_exclude_lead_id ?? null,
    p_exclude_patient_id: args.p_exclude_patient_id ?? null,
  });
}

export interface LeadAppointmentJson {
  id: string;
  start_time: string;
  end_time: string;
  status: string;
  doctor_name: string | null;
  chair_name: string | null;
  reminder_outcome: ReminderOutcome | null;
  reminder_current: boolean;
}

export interface LeadDetailJson {
  lead: LeadJson;
  activities: ActivityJson[];
  activities_total: number;
  calls: CallJson[];
  due_call: CallJson | null;
  last_notes: { text: string; at: string; actor_name: string | null }[];
  handoffs: HandoffJson[];
  appointments: LeadAppointmentJson[];
  tasks: TaskJson[];
  rules: RulesJson;
  can_manage: boolean;
}

export function crmLeadDetail(args: { p_lead_id: string }) {
  return rpc<LeadDetailJson>("crm_lead_detail", { ...args });
}

export interface TrashRow {
  id: string;
  version: number;
  full_name: string;
  phone: string;
  stage: Stage;
  deleted_at: string;
  deleted_by_name: string | null;
  call_count: number;
}

export function crmTrashList(args: { p_page?: PageArg } = {}) {
  return rpc<Paged<TrashRow>>("crm_trash_list", { p_page: args.p_page ?? {} });
}

export function crmHandoffList(args: { p_status: HandoffStatus; p_page?: PageArg }) {
  return rpc<Paged<HandoffJson> & { counts: Record<HandoffStatus, number> }>("crm_handoff_list", {
    p_status: args.p_status,
    p_page: args.p_page ?? {},
  });
}

// Owner JSON export (settings/export): rows that RLS hides from direct reads (trashed leads and their history,
// calls and handoffs), keyset paged on id, and row counts of every CRM table for the completeness check.
export type CrmTrashedExportTable = "leads" | "lead_activities" | "crm_calls" | "crm_handoffs";

export function crmExportTrashed(args: { p_table: CrmTrashedExportTable; p_after: string | null; p_limit: number }) {
  return rpc<{ table: CrmTrashedExportTable; rows: Record<string, unknown>[]; next_after: string | null }>(
    "crm_export_trashed",
    { ...args }
  );
}

export type CrmExportCounts = Record<string, number>;

export function crmExportCounts() {
  return rpc<CrmExportCounts>("crm_export_counts");
}

export type TaskScope = "mine" | "created" | "all";

export function staffTaskList(args: { p_scope: TaskScope; p_page?: PageArg }) {
  return rpc<Paged<TaskJson> & { counts: { open: number; unread: number; overdue: number } }>("staff_task_list", {
    p_scope: args.p_scope,
    p_page: args.p_page ?? {},
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lead → p_lead with every editable key (an edit must send them all). */
export function leadToInput(lead: LeadJson): LeadInput {
  return {
    full_name: lead.full_name,
    phone: lead.phone,
    email: lead.email,
    address: lead.address,
    source: lead.source,
    referrer: lead.referrer ?? "",
    campaign: lead.campaign ?? "",
    treatment_interest: lead.treatment_interest ?? "",
    assigned_to: lead.assigned_to,
    stage: lead.stage,
    interest: lead.interest,
    contact_result: lead.contact_result,
    loss_reason: lead.loss_reason,
    followup_date: lead.followup_date,
    followup_state: lead.followup_state,
    next_action: lead.next_action ?? "",
    do_not_contact: lead.do_not_contact,
    quote_amount_cents: lead.quote_amount_cents,
    quote_currency: lead.quote_currency ?? "TRY",
  };
}

/** Port of legacy normalizePhone (WF:3), for the client-side "≥ 7 digits" check only. */
export function normalizePhone(raw: string | null | undefined): string {
  let n = (raw ?? "").replace(/[^0-9]/g, "");
  if (n.startsWith("00")) n = n.slice(2);
  if (n.length === 11 && n.startsWith("0")) n = "90" + n.slice(1);
  else if (n.length === 10 && n.startsWith("5")) n = "90" + n;
  return n;
}

/** QC:30: tel: link keeps only '+' and digits. */
export function telHref(phone: string | null | undefined): string {
  return "tel:" + (phone ?? "").replace(/[^+\d]/g, "");
}

const ISTANBUL = "Europe/Istanbul";

/** Today in Istanbul ('YYYY-MM-DD'). For form defaults only; the server decides "today". */
export function istanbulToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: ISTANBUL }).format(new Date());
}

/** Current Istanbul wall clock 'HH:MM'. */
export function istanbulNowTime(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: ISTANBUL, hour: "2-digit", minute: "2-digit" }).format(
    new Date()
  );
}

/** Pure calendar-day addition (legacy followupDate, CT:2). */
export function addDays(day: string, days: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Istanbul date + time → ISO timestamp. Türkiye has used a fixed +03:00 since 2016. */
export function istanbulIso(day: string, time: string): string {
  return `${day}T${time.slice(0, 5)}:00+03:00`;
}

/** Timestamp → Istanbul { date: 'YYYY-MM-DD', time: 'HH:MM' }. */
export function splitIstanbul(ts: string): { date: string; time: string } {
  const d = new Date(ts);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: ISTANBUL }).format(d);
  const time = new Intl.DateTimeFormat("sv-SE", { timeZone: ISTANBUL, hour: "2-digit", minute: "2-digit" }).format(d);
  return { date, time };
}

/** 'HH:MM:SS' or 'HH:MM' → 'HH:MM'. */
export function hhmm(time: string | null | undefined): string {
  return time ? time.slice(0, 5) : "";
}

/** "15.10.2026 10:00" from a day and an optional time. */
export function dayTimeLabel(day: string | null | undefined, time?: string | null): string {
  if (!day) return "Tarih yok";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const d = m ? `${m[3]}.${m[2]}.${m[1]}` : day;
  return time ? `${d} ${hhmm(time)}` : d;
}

/** "15 Ekim Perşembe" for a day. */
export function longDayLabel(day: string): string {
  const d = new Date(day + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("tr-TR", { timeZone: "UTC", day: "numeric", month: "long", weekday: "long" });
}

/** Istanbul "dd.MM.yyyy HH:mm" of a timestamp. */
export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("tr-TR", {
    timeZone: ISTANBUL,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Istanbul "HH:mm" of a timestamp. */
export function formatClock(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("tr-TR", { timeZone: ISTANBUL, hour: "2-digit", minute: "2-digit" });
}

/** FI:30 durationLabel. */
export function durationLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.round(minutes);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} sa${rest > 0 ? ` ${rest} dk` : ""}`;
}

const PERCENT = new Intl.NumberFormat("tr-TR", { style: "percent", maximumFractionDigits: 1 });

/** MS:10: tr-TR percent with at most one decimal, '—' for a zero denominator. */
export function rate(n: number, total: number): string {
  if (!total) return "—";
  return PERCENT.format(n / total);
}

/** MS:11 */
export function changeLabel(current: number, previous: number): string {
  if (current === previous) return "Değişmedi";
  const d = current - previous;
  return `${d > 0 ? "+" : "-"}${Math.abs(d)} hasta`;
}

/** CT:3-14 contact suggestion ("Programın önerisi"); applied only on an explicit click. */
export function contactSuggestion(
  result: ContactResult,
  currentInterest: Interest
): { interest: Interest; days: number | null; nextAction: string } | null {
  switch (result) {
    case "wants_treatment":
      return { interest: "hot", days: 1, nextAction: "Randevu veya tedavi başlangıcını netleştir" };
    case "comparing_clinics":
      return { interest: "warm", days: 3, nextAction: "Diğer görüşmeler sonrası hastanın kararını ve sorularını görüş" };
    case "considering_price":
      return { interest: "warm", days: 3, nextAction: "Teklif hakkındaki sorularını ve kararını görüş" };
    case "considering_timing":
      return { interest: "warm", days: 7, nextAction: "Tedavi için uygun zamanı görüş" };
    case "will_think_later":
      return { interest: "cold", days: 7, nextAction: "Hastanın tedavi planını yeniden görüş" };
    case "unreachable":
      return { interest: currentInterest, days: 1, nextAction: "Hastaya yeniden ulaşmayı dene" };
    case "call_on_date":
      return { interest: currentInterest, days: null, nextAction: "Hastanın istediği tarihte ara" };
    default:
      return null;
  }
}

/** True when a reminder outcome still belongs to the appointment's current time and doctor (§2.9). */
export function isReminderCurrent(a: {
  status: string;
  start_time: string;
  doctor_id: string | null;
  reminder_outcome?: string | null;
  reminder_start_time?: string | null;
  reminder_doctor_id?: string | null;
}): boolean {
  if (a.status !== "scheduled" || !a.reminder_outcome || !a.reminder_start_time) return false;
  if (new Date(a.reminder_start_time).getTime() !== new Date(a.start_time).getTime()) return false;
  return (a.reminder_doctor_id ?? null) === (a.doctor_id ?? null);
}
