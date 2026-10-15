-- Phase 6: CRM follow-up engine (takip motoru). Safe to re-run.
--
-- Contract: spec_parts p6_db_contract.md (schema, RPCs, JSON shapes, error keys; wins on names and conflicts) and
-- p6_rules_acceptance.md (legacy behaviour, edge cases, acceptance). Requires 0019_phase0_security.sql.
--
--  1. Helpers: crm__raise (Turkish error texts keyed E_*, key in HINT), crm__normalize_phone (legacy WF:3),
--     crm__tr_lower, label / format helpers, input validators, crm_can_manage() (owner or 'crm_manage').
--  2. patients: UNIQUE(clinic_id, phone) is dropped (owner decision: shared numbers are allowed and only warned
--     about), replaced by phone_normalized + a non-unique index.
--  3. leads: pipeline stage (9 legacy stages), follow-up fields, quote, trash, version. leads.status (lead_status)
--     stays readable and in step with stage (a trigger maps status <-> stage for SQL-editor / service writes), but
--     authenticated clients can no longer INSERT / UPDATE / DELETE leads: every lead write is an RPC (contract §6.4
--     step 1 is done here, because the Phase 6 web build writes leads only through RPCs).
--  4. lead_activities: history with private notes, schedule changes, corrections; append-only, RPC writes only.
--  5. New tables: crm_calls (phone call plans, legacy kind 'appointment'), crm_followup_rules, crm_handoffs,
--     crm_handoff_private_notes, staff_tasks, appointment_reminder_logs, crm_ad_spend. appointments gets manual
--     reminder outcome columns and lead_id. No SMS is ever sent; the reminders table is not touched.
--  6. Triggers: phone normalisation, lead compat + stage history, version touch, call guard, no deletes,
--     appointment reminder reset and appointment -> lead sync (legacy clinicalVisit flow).
--  7. RLS: SELECT only on every new table (private notes for CRM managers, ad spend for finance holders);
--     every write goes through a SECURITY DEFINER RPC (crm_* / staff_task_*). Audit on the mutable tables.
--  8. Internals crm__* (never granted, SECURITY INVOKER, always filtered by p_clinic, replayable with a fixed
--     date): automatic plan, working minutes, work items, summaries.
--  9. Seeds: one crm_followup_rules row per clinic (legacy defaults). No staff names are seeded anywhere.
-- 10. crm__harden_privileges(): EXECUTE revoked from PUBLIC/anon/authenticated on every crm_* / staff_task_*
--     function, public RPCs granted to authenticated, internals never; plus self-checks. Every later migration
--     that touches crm_* functions must end with SELECT public.crm__harden_privileges();
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). The UI shows error.message verbatim; HINT carries the error key (E_*), DETAIL a machine
-- value where noted.
--
-- RUNBOOK (apply and deploy together; production is the only database):
--   1. Apply this file in the SQL editor (one transaction; any self-check failure rolls everything back).
--   2. Immediately deploy the Phase 6 web build (apps/web with lib/crm.ts). Between 1 and 2 the previous build
--      cannot write leads (direct writes are revoked), its lead card cannot load (leads now has several foreign
--      keys to users, so its `assignee:users(full_name)` embed is ambiguous, PGRST201) and its export misses the
--      CRM tables. The new build must not go live before step 1 either: it calls crm_* RPCs that do not exist yet.
--   3. Ask everyone to reload open tabs (an old bundle keeps failing on lead writes until reloaded).
--   4. Smoke test as the owner: Bugün list loads; lead card opens and saves; kanban drag saves through
--      crm_save_lead; an appointment status change on /appointments still saves; a patient saved with a phone
--      that another patient already has succeeds and shows the shared-number warning; Ayarlar > Veri yedeği
--      downloads and lists crm_calls / crm_handoffs / staff_tasks / trashed lead counts.
--
-- Column grants: appointments keeps a column-limited INSERT / UPDATE grant (lead_id and reminder_* are RPC-only).
-- Any later migration that adds an appointments column the web app must write has to end with
-- SELECT public.crm__grant_appointment_columns(); (or grant that column explicitly), otherwise PostgREST answers
-- 'permission denied for column'.
--
-- Phone numbers are not an identity (owner decision 1: family members may share one). Patient-portal identity is
-- patients.auth_user_id; inbound SMS / OTP features must resolve the patient through a per-message token of the
-- appointment or reminder that was sent, never through a phone lookup, and must treat several matches as
-- ambiguous and refuse.

BEGIN;

-- ---------------------------------------------------------------------------
-- 2.0 Preflight: Phase 0 must be live, the existing tables must have the columns and types used here, the
--     Turkish ICU collation must exist, and any table / column / type left by an earlier run must already have
--     the shape created below (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS would skip an old shape).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_vals text[];
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'audit_row_change', 'users_guard']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 0 eksik, önce 0019 uygulanmalı: %', v_missing;
  END IF;

  IF to_regclass('public.staff_permissions') IS NULL THEN
    RAISE EXCEPTION 'staff_permissions tablosu yok; önce 0019 uygulanmalı.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.staff_permissions'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%crm_manage%'
  ) THEN
    RAISE EXCEPTION 'staff_permissions ''crm_manage'' yetkisini kabul etmiyor; önce 0019 uygulanmalı.';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() / auth.jwt() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  -- Lists sort by name with Turkish collation (legacy localeCompare(...,'tr'), TK:43).
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  -- Existing columns used here, with their types (udt_name). patients.birth_date is written through
  -- jsonb_populate_record, so its live type does not matter.
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('leads', 'id', 'uuid'), ('leads', 'clinic_id', 'uuid'), ('leads', 'full_name', 'text'),
    ('leads', 'phone', 'text'), ('leads', 'email', 'text'), ('leads', 'address', 'text'), ('leads', 'source', 'text'),
    ('leads', 'status', 'lead_status'), ('leads', 'assigned_to', 'uuid'), ('leads', 'notes', 'text'),
    ('leads', 'created_at', 'timestamptz'), ('leads', 'updated_at', 'timestamptz'),
    ('leads', 'converted_at', 'timestamptz'),
    ('lead_activities', 'id', 'uuid'), ('lead_activities', 'clinic_id', 'uuid'), ('lead_activities', 'lead_id', 'uuid'),
    ('lead_activities', 'activity_type', 'text'), ('lead_activities', 'description', 'text'),
    ('lead_activities', 'created_by', 'uuid'), ('lead_activities', 'created_at', 'timestamptz'),
    ('patients', 'id', 'uuid'), ('patients', 'clinic_id', 'uuid'), ('patients', 'full_name', 'text'),
    ('patients', 'phone', 'text'), ('patients', 'email', 'text'), ('patients', 'is_active', 'bool'),
    ('patients', 'kvkk_consent', 'bool'), ('patients', 'consent_date', 'timestamptz'), ('patients', 'notes', 'text'),
    ('patients', 'gender', 'patient_gender'), ('patients', 'address', 'text'),
    ('appointments', 'id', 'uuid'), ('appointments', 'clinic_id', 'uuid'), ('appointments', 'patient_id', 'uuid'),
    ('appointments', 'doctor_id', 'uuid'), ('appointments', 'chair_id', 'uuid'), ('appointments', 'procedure_id', 'uuid'),
    ('appointments', 'start_time', 'timestamptz'), ('appointments', 'end_time', 'timestamptz'),
    ('appointments', 'status', 'appointment_status'), ('appointments', 'notes', 'text'),
    ('appointments', 'updated_at', 'timestamptz'),
    ('doctors', 'id', 'uuid'), ('doctors', 'clinic_id', 'uuid'), ('doctors', 'user_id', 'uuid'),
    ('chairs', 'id', 'uuid'), ('chairs', 'clinic_id', 'uuid'), ('chairs', 'name', 'text'), ('chairs', 'is_active', 'bool'),
    ('users', 'id', 'uuid'), ('users', 'clinic_id', 'uuid'), ('users', 'full_name', 'text'), ('users', 'role', 'user_role'),
    ('users', 'is_active', 'bool'), ('users', 'auth_user_id', 'uuid'),
    ('payments', 'id', 'uuid'), ('payments', 'clinic_id', 'uuid'), ('payments', 'patient_id', 'uuid'),
    ('payments', 'amount', 'numeric'), ('payments', 'status', 'payment_status'), ('payments', 'paid_at', 'timestamptz'),
    ('procedures_catalog', 'id', 'uuid'), ('procedures_catalog', 'clinic_id', 'uuid'),
    ('clinics', 'id', 'uuid'), ('clinics', 'name', 'text'),
    ('audit_logs', 'entity_type', 'text'), ('audit_logs', 'clinic_id', 'uuid')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı veya türü farklı: %', v_missing;
  END IF;

  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) INTO v_vals
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'lead_status';
  IF v_vals IS DISTINCT FROM ARRAY['new', 'contacted', 'interested', 'qualified', 'converted', 'lost'] THEN
    RAISE EXCEPTION 'lead_status beklenen değerlerde değil: %', v_vals;
  END IF;

  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) INTO v_vals
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'appointment_status';
  IF v_vals IS DISTINCT FROM ARRAY['scheduled', 'completed', 'cancelled', 'no_show'] THEN
    RAISE EXCEPTION 'appointment_status beklenen değerlerde değil: %', v_vals;
  END IF;

  -- Columns this migration adds to existing tables: if one is already there (earlier run), it must have the type
  -- created below.
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, c.udt_name), ', ')
    INTO v_missing
  FROM (VALUES
    ('patients', 'phone_normalized', 'text'),
    ('leads', 'stage', 'text'), ('leads', 'stage_entered_at', 'timestamptz'), ('leads', 'patient_id', 'uuid'),
    ('leads', 'phone_normalized', 'text'), ('leads', 'referrer', 'text'), ('leads', 'campaign', 'text'),
    ('leads', 'treatment_interest', 'text'), ('leads', 'interest', 'text'), ('leads', 'contact_result', 'text'),
    ('leads', 'loss_reason', 'text'), ('leads', 'followup_date', 'date'), ('leads', 'followup_state', 'text'),
    ('leads', 'next_action', 'text'), ('leads', 'do_not_contact', 'bool'), ('leads', 'automation_review', 'text'),
    ('leads', 'treatment_closed_at', 'timestamptz'), ('leads', 'treatment_closed_by', 'uuid'),
    ('leads', 'quote_amount_cents', 'int8'), ('leads', 'quote_currency', 'text'), ('leads', 'deleted_at', 'timestamptz'),
    ('leads', 'deleted_by', 'uuid'), ('leads', 'version', 'int4'), ('leads', 'legacy_id', 'text'),
    ('lead_activities', 'seq', 'int8'), ('lead_activities', 'is_private', 'bool'),
    ('lead_activities', 'schedule_change', 'jsonb'), ('lead_activities', 'call_id', 'uuid'),
    ('lead_activities', 'appointment_id', 'uuid'), ('lead_activities', 'edited_from', 'uuid'),
    ('lead_activities', 'edited_at', 'timestamptz'), ('lead_activities', 'edited_by', 'uuid'),
    ('lead_activities', 'actor_name', 'text'), ('lead_activities', 'version', 'int4'),
    ('lead_activities', 'legacy_id', 'text'),
    ('appointments', 'lead_id', 'uuid'), ('appointments', 'reminder_outcome', 'text'),
    ('appointments', 'reminder_note', 'text'), ('appointments', 'reminded_at', 'timestamptz'),
    ('appointments', 'reminded_by', 'uuid'), ('appointments', 'reminder_start_time', 'timestamptz'),
    ('appointments', 'reminder_doctor_id', 'uuid')
  ) AS e(tbl, col, udt)
  JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text <> e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önceki çalıştırmadan kalan sütunlar beklenen türde değil: %', v_missing;
  END IF;

  -- New tables left by an earlier run must have every column created below.
  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (
    SELECT 'crm_calls' AS tbl, unnest(ARRAY['id', 'clinic_id', 'lead_id', 'caller_user_id', 'caller_name_legacy',
      'scheduled_date', 'scheduled_time', 'status', 'origin', 'decision', 'contact_result', 'note', 'auto_cancelled',
      'cancel_reason', 'resolved_at', 'resolved_by', 'resolve_request_id', 'next_call_id', 'appointment_id', 'version',
      'created_by', 'created_at', 'updated_by', 'updated_at', 'legacy_id']) AS col
    UNION ALL
    SELECT 'crm_followup_rules', unnest(ARRAY['clinic_id', 'id', 'enabled', 'work_days', 'start_time', 'end_time',
      'call_time', 'retry_days', 'interested_days', 'price_days', 'timing_days', 'later_days', 'max_unreachable',
      'first_call_minutes', 'stale_days', 'offer_days', 'version', 'created_at', 'updated_by', 'updated_at'])
    UNION ALL
    SELECT 'crm_handoffs', unnest(ARRAY['id', 'clinic_id', 'lead_id', 'patient_id', 'topic', 'question', 'status',
      'requested_by', 'requested_at', 'answer_text', 'answer_due_date', 'answer_assignee_user_id', 'answered_by',
      'answered_at', 'completion_text', 'completed_by', 'completed_at', 'system_closed', 'version', 'updated_at',
      'legacy_id', 'requested_by_name_legacy', 'answered_by_name_legacy', 'completed_by_name_legacy'])
    UNION ALL
    SELECT 'crm_handoff_private_notes', unnest(ARRAY['handoff_id', 'clinic_id', 'note', 'written_by', 'written_at'])
    UNION ALL
    SELECT 'staff_tasks', unnest(ARRAY['id', 'clinic_id', 'title', 'detail', 'due_date', 'lead_id', 'patient_id',
      'assignee_user_id', 'created_by', 'created_by_name_legacy', 'status', 'read_at', 'completed_at', 'completed_by',
      'result', 'cancelled_at', 'cancelled_by', 'version', 'created_at', 'updated_at', 'legacy_id'])
    UNION ALL
    SELECT 'appointment_reminder_logs', unnest(ARRAY['id', 'clinic_id', 'appointment_id', 'patient_id', 'outcome',
      'note', 'start_time', 'doctor_id', 'created_by', 'created_at', 'legacy_id'])
    UNION ALL
    SELECT 'crm_ad_spend', unnest(ARRAY['id', 'clinic_id', 'source', 'month', 'amount_cents', 'currency', 'note',
      'version', 'created_by', 'created_at', 'updated_by', 'updated_at', 'legacy_id'])
  ) e
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut CRM tabloları beklenen yapıda değil: %', v_missing;
  END IF;

  -- The work item row type is created once; an older shape would break crm__work_items.
  IF to_regtype('public.crm_work_item') IS NOT NULL AND (
    SELECT count(*) FROM pg_attribute a
    WHERE a.attrelid = (SELECT t.typrelid FROM pg_type t WHERE t.oid = to_regtype('public.crm_work_item'))
      AND a.attnum > 0 AND NOT a.attisdropped
  ) <> 17 THEN
    RAISE EXCEPTION 'crm_work_item türü beklenen yapıda değil.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2.1 Pure helpers (no table access). Internal: never granted (crm__harden_privileges).
-- ---------------------------------------------------------------------------

-- Error contract §1.1. One place for every Turkish text; the key travels in HINT so the UI can branch on it.
-- p_arg fills the variable part of E_FIELDS / E_RULES_RANGE / E_RULES_DAYS; p_detail is a machine value.
CREATE OR REPLACE FUNCTION public.crm__raise(p_key text, p_arg text DEFAULT NULL, p_detail text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_msg text;
  v_code text := 'P0001';
BEGIN
  CASE p_key
    WHEN 'E_SESSION' THEN v_msg := 'Oturum bulunamadı. Lütfen yeniden giriş yapın.'; v_code := '42501';
    WHEN 'E_MANAGE' THEN v_msg := 'Bu işlem için CRM yönetici yetkisi gerekir.'; v_code := '42501';
    WHEN 'E_FINANCE_WRITE' THEN v_msg := 'Bu işlem için finans yetkisi gerekir.'; v_code := '42501';
    WHEN 'E_FINANCE_READ' THEN v_msg := 'Finans verilerini görme yetkiniz yok.'; v_code := '42501';
    WHEN 'E_LEAD_NOT_FOUND' THEN v_msg := 'Hasta kaydı bulunamadı.'; v_code := 'PT404';
    WHEN 'E_NOT_FOUND' THEN v_msg := 'Kayıt bulunamadı.'; v_code := 'PT404';
    WHEN 'E_CALL_NOT_FOUND' THEN v_msg := 'Arama kaydı bulunamadı.'; v_code := 'PT404';
    WHEN 'E_VERSION' THEN v_msg := 'Kayıt başka bir ekranda değişti. Listeyi yenileyip tekrar açın.'; v_code := 'PT409';
    WHEN 'E_ID_TAKEN' THEN v_msg := 'Kayıt kaydedilemedi.'; v_code := 'PT409';
    WHEN 'E_FIELDS' THEN v_msg := 'Alanları kontrol edin: ' || coalesce(p_arg, '');
    WHEN 'E_NAME' THEN v_msg := 'Ad soyad en az 2, en fazla 200 karakter olmalı.';
    WHEN 'E_PHONE' THEN v_msg := 'Geçerli bir telefon numarası girin.';
    WHEN 'E_DATE' THEN v_msg := 'Geçersiz tarih.';
    WHEN 'E_TIME' THEN v_msg := 'Geçersiz saat.';
    WHEN 'E_LOSS_REASON' THEN v_msg := 'Olumsuz sonuç nedenini seçin.';
    WHEN 'E_CLOSE_NOTE' THEN v_msg := 'Tedaviyi kapatmak için yeni görüşme notuna tamamlanma açıklamasını yazın.';
    WHEN 'E_REOPEN_NOTE' THEN v_msg := 'Hastayı yeniden açma nedenini yeni görüşme notuna yazın.';
    WHEN 'E_FOLLOWUP_CLOSE_NOTE' THEN v_msg := 'Takibi tamamlamak için yeni görüşme notuna kapanış nedenini yazın.';
    WHEN 'E_FOLLOWUP_REASON' THEN v_msg := 'Takip tarihini değiştirme nedenini yazın.';
    WHEN 'E_CLOSED_NEW_WORK' THEN v_msg := 'Tedavisi kapalı hastada yeni takip başlatılamaz. Önce aşamayı değiştirip hastayı yeniden açın.';
    WHEN 'E_TREATMENT_CLOSED' THEN v_msg := 'Tedavi tamamlanmış. Arama planlamak için önce hasta kartındaki aşamayı değiştirip yeniden açın.';
    WHEN 'E_DNC_INITIAL' THEN v_msg := 'Aranmak istemeyen hastaya arama planlanamaz.';
    WHEN 'E_DNC' THEN v_msg := 'Bu hasta telefonla aranmak istemiyor. Hasta kartındaki iletişim tercihini kontrol edin.';
    WHEN 'E_CALLER' THEN v_msg := 'Arayacak kişi bulunamadı veya pasif.';
    WHEN 'E_ASSIGNEE' THEN v_msg := 'Sorumlu personel bulunamadı veya pasif.';
    WHEN 'E_CALL_PAST' THEN v_msg := 'Arama tarihi bugünden önce olamaz.';
    WHEN 'E_CALL_REASON' THEN v_msg := 'Arama planını değiştirme nedenini yazın.';
    WHEN 'E_CALL_LOCKED' THEN v_msg := 'Sonuç kaydederken planlanan tarih ve saat korunur. Tarih değişikliği için önce arama planını düzenleyin.';
    WHEN 'E_CALL_DONE' THEN v_msg := 'Bu arama zaten sonuçlandırıldı. Yeni bir arama planlayın.'; v_code := 'PT409';
    WHEN 'E_CALL_FROZEN' THEN v_msg := 'Tamamlanmış aramanın sonucunu değiştirmek yerine hasta kartına düzeltme notu ekleyin.';
    WHEN 'E_CALL_LEAD' THEN v_msg := 'Kayıtlı aramanın hastası değiştirilemez. Gerekirse iptal edip yeni arama oluşturun.';
    WHEN 'E_CALL_NOTE' THEN v_msg := 'Görüşme notunu yazın.';
    WHEN 'E_DECISION' THEN v_msg := 'Görüşme sonrası kararı seçin.';
    WHEN 'E_STATUS' THEN v_msg := 'Arama sonucunu seçin.';
    WHEN 'E_AUTO_STATUS' THEN v_msg := 'Otomatik takip için arama sonucunu seçin.';
    WHEN 'E_AUTO_OFF' THEN v_msg := 'Otomatik takip kapalı. Yeni arama tarihini seçin.';
    WHEN 'E_AUTO_RESULT' THEN v_msg := 'Otomatik takip için görüşme sonucunu seçin veya hastanın istediği tarihi belirtin.';
    WHEN 'E_AUTO_SLOT' THEN v_msg := 'Uygun arama günü bulunamadı.';
    WHEN 'E_FOLLOWUP_DATE' THEN v_msg := 'Geçerli takip tarihi seçin.';
    WHEN 'E_FOLLOWUP_TIME' THEN v_msg := 'Takip saatini seçin.';
    WHEN 'E_FOLLOWUP_ACTION' THEN v_msg := 'Sonraki adımı yazın.';
    WHEN 'E_FOLLOWUP_FUTURE' THEN v_msg := 'Sonraki arama için gelecekte bir tarih ve saat seçin.';
    WHEN 'E_CLINIC_FIELDS' THEN v_msg := 'Klinik randevusu için tarih, saat, hekim ve koltuk girin.';
    WHEN 'E_CLINIC' THEN v_msg := 'Klinik randevusu için Görüşüldü sonucunu ve gelecekte bir tarih/saat seçin.';
    WHEN 'E_SLOT_ORDER' THEN v_msg := 'Bitiş saati başlangıç saatinden sonra olmalı.';
    WHEN 'E_SLOT_DOCTOR' THEN v_msg := 'Seçilen hekimin bu saatte başka bir randevusu var.'; v_code := 'PT409';
    WHEN 'E_SLOT_CHAIR' THEN v_msg := 'Seçilen koltuk bu saatte dolu.'; v_code := 'PT409';
    WHEN 'E_DOCTOR' THEN v_msg := 'Hekim bulunamadı.';
    WHEN 'E_CHAIR' THEN v_msg := 'Koltuk bulunamadı veya pasif.';
    WHEN 'E_PATIENT_NOT_FOUND' THEN v_msg := 'Hasta bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PATIENT_LINKED' THEN v_msg := 'Hasta adayı zaten başka bir hasta kaydına bağlı.'; v_code := 'PT409';
    WHEN 'E_NOTE' THEN v_msg := 'Not 1–10000 karakter olmalı.';
    WHEN 'E_NOTE_EDIT' THEN v_msg := 'Düzeltilecek not bulunamadı.';
    WHEN 'E_PRIVATE' THEN v_msg := 'Özel notu yalnızca CRM yöneticisi yazabilir veya düzeltebilir.'; v_code := '42501';
    WHEN 'E_REASON' THEN v_msg := 'Neden en fazla 500 karakter olmalı.';
    WHEN 'E_HANDOFF_OPEN' THEN v_msg := 'Bu hastanın açık bir aktarımı var. Önce mevcut aktarımı sonuçlandırın.'; v_code := 'PT409';
    WHEN 'E_HANDOFF_NOT_FOUND' THEN v_msg := 'Aktarım bulunamadı. Hasta kartını yenileyin.'; v_code := 'PT404';
    WHEN 'E_HANDOFF_ANSWER_ROLE' THEN v_msg := 'Bu kararı yalnızca CRM yöneticisi kaydedebilir.'; v_code := '42501';
    WHEN 'E_HANDOFF_CLOSED' THEN v_msg := 'Bu aktarım kapatıldı. Gerekirse yeni konu aktarın.'; v_code := 'PT409';
    WHEN 'E_HANDOFF_DUE' THEN v_msg := 'Görev için bugün veya ileri bir tarih seçin.';
    WHEN 'E_HANDOFF_STATE' THEN v_msg := 'Aktarımın durumu değişmiş. Hasta kartını yenileyin.'; v_code := 'PT409';
    WHEN 'E_HANDOFF_ARCHIVED' THEN v_msg := 'Yeni aktarım için hastayı arşivden çıkarın.';
    WHEN 'E_HANDOFF_TEXT' THEN v_msg := 'Metin 1–3000 karakter olmalı.';
    WHEN 'E_TASK_NOT_FOUND' THEN v_msg := 'Görev bulunamadı.'; v_code := 'PT404';
    WHEN 'E_TASK_VERSION' THEN v_msg := 'Görev başka ekranda değişti. Listeyi yenileyin.'; v_code := 'PT409';
    WHEN 'E_TASK_CLOSED' THEN v_msg := 'Bu görev artık açık değil.'; v_code := 'PT409';
    WHEN 'E_TASK_FIELDS' THEN v_msg := 'Başlık ve geçerli bir tarih girin.';
    WHEN 'E_TASK_DUE' THEN v_msg := 'Görev için bugün veya ileri bir tarih seçin.';
    WHEN 'E_TASK_RESULT' THEN v_msg := 'Sonucu yazın (en az 2 karakter).';
    WHEN 'E_TASK_ROLE' THEN v_msg := 'Bu görev işlemi için yetkiniz yok.'; v_code := '42501';
    WHEN 'E_RULES_VERSION' THEN v_msg := 'Kurallar başka bir ekranda değişmiş. Sayfayı yenileyin.'; v_code := 'PT409';
    WHEN 'E_RULES_TIME' THEN v_msg := 'Arama saati çalışma başlangıcı ile bitişi arasında olmalı.';
    WHEN 'E_RULES_DAYS' THEN v_msg := coalesce(p_arg, 'Çalışma günleri tekrarlanamaz.');
    WHEN 'E_RULES_RANGE' THEN v_msg := coalesce(p_arg, 'Takip kuralı değerleri izin verilen aralıkta olmalı.');
    WHEN 'E_REMINDER_STALE' THEN v_msg := 'Randevu bilgileri değişmiş. Randevuyu yenileyip hatırlatma sonucunu tekrar girin.'; v_code := 'PT409';
    WHEN 'E_REMINDER_DATE' THEN v_msg := 'Hatırlatma yalnızca bugün veya ileride planlı klinik randevusu için kaydedilebilir.';
    WHEN 'E_REMINDER_NOTE' THEN v_msg := 'Hatırlatma notu 1–1000 karakter olmalı.';
    WHEN 'E_REMINDER_OUTCOME' THEN v_msg := 'Hatırlatma sonucunu seçin.';
    WHEN 'E_APPOINTMENT_NOT_FOUND' THEN v_msg := 'Randevu bulunamadı.'; v_code := 'PT404';
    WHEN 'E_AD_MONTH' THEN v_msg := 'Ay YYYY-AA biçiminde olmalı.';
    WHEN 'E_AD_AMOUNT' THEN v_msg := 'Tutar 0 ile 10.000.000.000 arasında olmalı.';
    WHEN 'E_AD_DUPLICATE' THEN v_msg := 'Bu kaynak, ay ve para birimi için kayıt zaten var.'; v_code := 'PT409';
    WHEN 'E_FILTER' THEN v_msg := 'Filtre değerleri geçersiz.';
    WHEN 'E_TRASHED' THEN v_msg := 'Hasta çöp kutusunda. Önce geri getirin.';
    WHEN 'E_IMMUTABLE' THEN v_msg := 'Bu alan değiştirilemez.';
    WHEN 'E_HISTORY' THEN v_msg := 'Geçmiş kayıtları değiştirilemez.';
    WHEN 'E_NO_DELETE' THEN v_msg := 'Bu kayıtlar silinemez.';
    WHEN 'E_CALL_NO_DELETE' THEN v_msg := 'Arama kayıtları silinemez; iptal edin.';
    WHEN 'E_LEAD_NO_DELETE' THEN v_msg := 'Hasta adayları silinemez; çöp kutusuna taşıyın.';
    WHEN 'E_APPT_REFS' THEN v_msg := 'Randevunun hastası, hekimi ve koltuğu bu kliniğe ait olmalı.';
    WHEN 'E_EXPORT' THEN v_msg := 'Dışa aktarma yalnızca klinik sahibine açıktır.'; v_code := '42501';
    ELSE v_msg := 'Beklenmeyen hata: ' || coalesce(p_key, '(boş)');
  END CASE;

  IF p_detail IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = coalesce(p_key, '');
  ELSE
    RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = coalesce(p_key, ''), DETAIL = p_detail;
  END IF;
END;
$$;

-- Port of legacy normalizePhone (WF:3): ASCII digits only; strip a leading 00; 11 digits starting 0 -> 90...;
-- 10 digits starting 5 -> 905... Only pg_catalog functions and no SET clause, so it is IMMUTABLE and inlinable.
CREATE OR REPLACE FUNCTION public.crm__normalize_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN pg_catalog.length(s.n) = 11 AND pg_catalog.left(s.n, 1) = '0' THEN '90' || pg_catalog.substr(s.n, 2)
           WHEN pg_catalog.length(s.n) = 10 AND pg_catalog.left(s.n, 1) = '5' THEN '90' || s.n
           ELSE s.n
         END
  FROM (
    SELECT CASE WHEN pg_catalog.left(d.n, 2) = '00' THEN pg_catalog.substr(d.n, 3) ELSE d.n END AS n
    FROM (SELECT pg_catalog.regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') AS n) d
  ) s
$$;

-- Turkish lower case for search (same body as 0020 fin__tr_lower; own copy so the CRM does not depend on finance).
CREATE OR REPLACE FUNCTION public.crm__tr_lower(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.lower(pg_catalog.translate(p, 'İIÇĞÖŞÜÂÎÛ', 'iıçğöşüâîû'))
$$;

-- Istanbul wall clock at minute precision (legacy localStamp(), FR:16): "later than now" means strictly later
-- at minute precision. Internals take it as p_now_local so a day can be replayed.
CREATE OR REPLACE FUNCTION public.crm__local_now()
RETURNS timestamp
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.date_trunc('minute', pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')
$$;

-- is_open(l) (contract §3.1, TK:16).
CREATE OR REPLACE FUNCTION public.crm__is_open(p_stage text, p_dnc boolean, p_followup_state text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NOT coalesce(p_dnc, false)
     AND coalesce(p_followup_state, 'open') = 'open'
     AND coalesce(p_stage, 'new') NOT IN ('treatment_started', 'treatment_completed', 'lost', 'archived')
$$;

-- Labels (contract §1.4). Used in Turkish history texts; unknown codes are shown as stored.
CREATE OR REPLACE FUNCTION public.crm__stage_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'new' THEN 'Yeni başvuru'
    WHEN 'in_contact' THEN 'Görüşülüyor'
    WHEN 'appointment_booked' THEN 'Randevu alındı'
    WHEN 'appointment_attended' THEN 'Randevuya geldi'
    WHEN 'offer_given' THEN 'Teklif verildi'
    WHEN 'treatment_started' THEN 'Tedavi başladı'
    WHEN 'treatment_completed' THEN 'Tedavi tamamlandı'
    WHEN 'lost' THEN 'Olumsuz'
    WHEN 'archived' THEN 'Arşiv'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__source_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'instagram_meta' THEN 'Instagram / Meta'
    WHEN 'google' THEN 'Google'
    WHEN 'whatsapp' THEN 'WhatsApp'
    WHEN 'phone_call' THEN 'Arama'
    WHEN 'referral' THEN 'Referans'
    WHEN 'walk_in' THEN 'Yoldan gelen'
    WHEN 'other' THEN 'Diğer'
    WHEN 'direct' THEN 'Doğrudan (eski)'
    WHEN 'online' THEN 'Online (eski)'
    WHEN 'social_media' THEN 'Sosyal Medya (eski)'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__interest_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'hot' THEN 'Sıcak'
    WHEN 'warm' THEN 'Ilık'
    WHEN 'cold' THEN 'Soğuk'
    WHEN 'unknown' THEN 'Belirsiz'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__result_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'unspecified' THEN 'Belirtilmedi'
    WHEN 'wants_treatment' THEN 'Randevu / tedavi istiyor'
    WHEN 'considering_price' THEN 'Fiyatı değerlendiriyor'
    WHEN 'considering_timing' THEN 'Zamanlamayı değerlendiriyor'
    WHEN 'will_think_later' THEN 'Daha sonra düşünecek'
    WHEN 'unreachable' THEN 'Ulaşılamadı'
    WHEN 'call_on_date' THEN 'Belirli tarihte aranmak istiyor'
    WHEN 'negative' THEN 'Olumsuz'
    WHEN 'comparing_clinics' THEN 'Başka yerle de görüşüyor'
    WHEN 'appointment_confirmed' THEN 'Randevu kesinleşti'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__loss_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'price_high' THEN 'Fiyat yüksek'
    WHEN 'timing_unsuitable' THEN 'Zamanlama uygun değil'
    WHEN 'unreachable' THEN 'Ulaşılamadı'
    WHEN 'chose_other_clinic' THEN 'Başka klinik seçti'
    WHEN 'postponed' THEN 'Tedaviyi erteledi'
    WHEN 'not_suitable' THEN 'Tedaviye uygun değil'
    WHEN 'other' THEN 'Diğer'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__topic_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'price_payment' THEN 'Fiyat / ödeme talebi'
    WHEN 'treatment_question' THEN 'Tedaviyle ilgili soru'
    WHEN 'followup_decision' THEN 'Takip kararı'
    WHEN 'other' THEN 'Diğer'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__call_status_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'planned' THEN 'Planlandı'
    WHEN 'reached' THEN 'Görüşüldü'
    WHEN 'unreachable' THEN 'Ulaşılamadı'
    WHEN 'cancelled' THEN 'İptal'
    ELSE p
  END
$$;

-- Clinic appointment status as the legacy visit labels (CV:2).
CREATE OR REPLACE FUNCTION public.crm__appt_status_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p
    WHEN 'scheduled' THEN 'Planlandı'
    WHEN 'completed' THEN 'Geldi'
    WHEN 'no_show' THEN 'Gelmedi'
    WHEN 'cancelled' THEN 'İptal'
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__followup_state_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p WHEN 'open' THEN 'Takip açık' WHEN 'done' THEN 'Takip tamamlandı' ELSE p END
$$;

CREATE OR REPLACE FUNCTION public.crm__reminder_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p WHEN 'reminded' THEN 'Hatırlatıldı' WHEN 'unreachable' THEN 'Ulaşılamadı' ELSE p END
$$;

-- lead_status (deprecated) <-> stage mapping (contract §1.4).
CREATE OR REPLACE FUNCTION public.crm__stage_from_status(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE coalesce(p_status, 'new')
    WHEN 'new' THEN 'new'
    WHEN 'contacted' THEN 'in_contact'
    WHEN 'interested' THEN 'in_contact'
    WHEN 'qualified' THEN 'in_contact'
    WHEN 'converted' THEN 'treatment_started'
    WHEN 'lost' THEN 'lost'
    ELSE 'new'
  END
$$;

CREATE OR REPLACE FUNCTION public.crm__compat_status(p_stage text, p_old_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_stage
    WHEN 'new' THEN 'new'
    WHEN 'in_contact' THEN CASE WHEN p_old_status = 'interested' THEN 'interested' ELSE 'contacted' END
    WHEN 'appointment_booked' THEN 'qualified'
    WHEN 'appointment_attended' THEN 'qualified'
    WHEN 'offer_given' THEN 'qualified'
    WHEN 'treatment_started' THEN 'converted'
    WHEN 'treatment_completed' THEN 'converted'
    WHEN 'lost' THEN 'lost'
    WHEN 'archived' THEN 'lost'
    ELSE coalesce(p_old_status, 'new')
  END
$$;

-- Formatting for Turkish history texts: dd.MM.yyyy, HH:mm, Istanbul local stamps, '15 Ekim'.
CREATE OR REPLACE FUNCTION public.crm__fmt_date(p date)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.to_char(p, 'DD.MM.YYYY')
$$;

CREATE OR REPLACE FUNCTION public.crm__fmt_time(p time)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.to_char(DATE '2000-01-01' + p, 'HH24:MI')
$$;

CREATE OR REPLACE FUNCTION public.crm__fmt_local(p timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.to_char(p AT TIME ZONE 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
$$;

CREATE OR REPLACE FUNCTION public.crm__fmt_day_month(p date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXTRACT(DAY FROM p)::integer::text || ' '
         || (ARRAY['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim',
                   'Kasım', 'Aralık'])[EXTRACT(MONTH FROM p)::integer]
$$;

-- ---------------------------------------------------------------------------
-- Validators (raise the §1.1 texts). All IMMUTABLE/STABLE, no table access.
-- ---------------------------------------------------------------------------

-- Business date sanity (MO:13). E_DATE, or the given key.
CREATE OR REPLACE FUNCTION public.crm__day(p date, p_key text DEFAULT 'E_DATE')
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR p < DATE '2000-01-01' OR p > DATE '2100-12-31' THEN
    PERFORM public.crm__raise(p_key);
  END IF;
  RETURN p;
END;
$$;

-- 'HH:MM', 24 h (MO:19, FU:4). E_TIME, or the given key.
CREATE OR REPLACE FUNCTION public.crm__time(p text, p_key text DEFAULT 'E_TIME')
RETURNS time
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR btrim(p) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    PERFORM public.crm__raise(p_key);
  END IF;
  RETURN btrim(p)::time;
END;
$$;

-- 'YYYY-MM' -> first day of the month. E_AD_MONTH, or the given key.
CREATE OR REPLACE FUNCTION public.crm__month(p text, p_key text DEFAULT 'E_AD_MONTH')
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v date;
BEGIN
  IF p IS NULL OR btrim(p) !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    PERFORM public.crm__raise(p_key);
  END IF;
  v := (btrim(p) || '-01')::date;
  IF v < DATE '2000-01-01' OR v > DATE '2100-12-01' THEN
    PERFORM public.crm__raise(p_key);
  END IF;
  RETURN v;
END;
$$;

-- Paging object {offset >= 0 (default 0), limit 1..200 (default 50)}; anything else -> E_FILTER.
CREATE OR REPLACE FUNCTION public.crm__page(p_page jsonb, OUT o_offset integer, OUT o_limit integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_page jsonb := coalesce(p_page, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_page) <> 'object' THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_page) AS k(k_name) WHERE k.k_name NOT IN ('offset', 'limit')) THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  BEGIN
    o_offset := coalesce((v_page ->> 'offset')::integer, 0);
    o_limit := coalesce((v_page ->> 'limit')::integer, 50);
  EXCEPTION WHEN data_exception THEN
    PERFORM public.crm__raise('E_FILTER');
  END;
  IF o_offset < 0 OR o_limit NOT BETWEEN 1 AND 200 THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
END;
$$;

-- Short text field: trimmed, NULL -> '', at most p_max characters, else E_FIELDS(<field>) (MO:18).
CREATE OR REPLACE FUNCTION public.crm__short(p text, p_field text, p_max integer DEFAULT 200)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF char_length(btrim(coalesce(p, ''))) > p_max THEN
    PERFORM public.crm__raise('E_FIELDS', p_field);
  END IF;
  RETURN btrim(coalesce(p, ''));
END;
$$;

-- Reason text: blank -> p_missing_key (E_FOLLOWUP_REASON / E_CALL_REASON ...), else trimmed 1..500 (E_REASON).
-- Legacy accepts any non-empty reason (scheduleChangeSchema .min(1), RR:84 / RR:134; rules §6.2).
CREATE OR REPLACE FUNCTION public.crm__reason(p text, p_missing_key text DEFAULT 'E_REASON')
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN
    PERFORM public.crm__raise(p_missing_key);
  END IF;
  IF char_length(btrim(p)) > 500 THEN
    PERFORM public.crm__raise('E_REASON');
  END IF;
  RETURN btrim(p);
END;
$$;

-- Note text: trimmed 1..p_max, else p_key (E_NOTE; E_CALL_NOTE for call results; E_REMINDER_NOTE ...).
CREATE OR REPLACE FUNCTION public.crm__note(p text, p_key text DEFAULT 'E_NOTE', p_max integer DEFAULT 10000)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR char_length(btrim(p)) NOT BETWEEN 1 AND p_max THEN
    PERFORM public.crm__raise(p_key);
  END IF;
  RETURN btrim(p);
END;
$$;

-- JSON field readers: a wrong JSON type or an unparsable value -> E_FIELDS(<key>) (or p_err). JSON null and an
-- absent key both read as NULL.
CREATE OR REPLACE FUNCTION public.crm__j_text(p jsonb, p_key text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('string', 'null') THEN
    PERFORM public.crm__raise('E_FIELDS', p_key);
  END IF;
  RETURN p ->> p_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__j_uuid(p jsonb, p_key text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := public.crm__j_text(p, p_key);
BEGIN
  IF v IS NULL OR btrim(v) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN btrim(v)::uuid;
  EXCEPTION WHEN data_exception THEN
    PERFORM public.crm__raise('E_FIELDS', p_key);
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__j_date(p jsonb, p_key text, p_err text DEFAULT NULL)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
  d date;
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('string', 'null') THEN
    IF p_err IS NOT NULL THEN PERFORM public.crm__raise(p_err); END IF;
    PERFORM public.crm__raise('E_FIELDS', p_key);
  END IF;
  v := btrim(p ->> p_key);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    IF p_err IS NOT NULL THEN PERFORM public.crm__raise(p_err); END IF;
    PERFORM public.crm__raise('E_DATE');
  END IF;
  BEGIN
    d := v::date;
  EXCEPTION WHEN data_exception THEN
    IF p_err IS NOT NULL THEN PERFORM public.crm__raise(p_err); END IF;
    PERFORM public.crm__raise('E_DATE');
  END;
  RETURN public.crm__day(d, coalesce(p_err, 'E_DATE'));
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__j_bool(p jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('boolean', 'null') THEN
    PERFORM public.crm__raise('E_FIELDS', p_key);
  END IF;
  RETURN (p ->> p_key)::boolean;
END;
$$;

-- Whole numbers only (a JSON number without a fraction; numeric strings are refused too).
CREATE OR REPLACE FUNCTION public.crm__j_bigint(p jsonb, p_key text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('number', 'null') THEN
    PERFORM public.crm__raise('E_FIELDS', p_key);
  END IF;
  v := p ->> p_key;
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  IF v !~ '^-?[0-9]{1,15}$' THEN
    PERFORM public.crm__raise('E_FIELDS', p_key);
  END IF;
  RETURN v::bigint;
END;
$$;

-- Keys listed in p_keys that p lacks, as 'a, b' (NULL when none). Used for "every key must be present".
CREATE OR REPLACE FUNCTION public.crm__missing_keys(p jsonb, p_keys text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT string_agg(k.k_name, ', ' ORDER BY k.ord)
  FROM unnest(p_keys) WITH ORDINALITY AS k(k_name, ord)
  WHERE NOT (coalesce(p, '{}'::jsonb) ? k.k_name)
$$;

-- ---------------------------------------------------------------------------
-- 1.2 Permission helpers. crm_can_manage() is granted (answers only for the caller, like 0020 fin_can_read);
--     the crm__require_* gates are internal and are the first statement of every RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false) OR public.has_permission('crm_manage')
$$;

CREATE OR REPLACE FUNCTION public.crm__require_staff()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL OR public.current_app_user_id() IS NULL THEN
    PERFORM public.crm__raise('E_SESSION');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__require_manage()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
BEGIN
  IF NOT public.crm_can_manage() THEN
    PERFORM public.crm__raise('E_MANAGE');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__require_finance_write()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
BEGIN
  IF NOT public.has_permission('finance') THEN
    PERFORM public.crm__raise('E_FINANCE_WRITE');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__can_read_money()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.has_permission('finance') OR public.has_permission('finance_readonly')
$$;

-- Requests from the SQL editor / service role (no JWT user, not an API role) are allowed to do what app users
-- may not (row deletes for cleanup, legacy imports). Same test as 0020 fin__trg_no_delete.
CREATE OR REPLACE FUNCTION public.crm__is_editor()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid() IS NULL
     AND coalesce(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated')
     AND coalesce(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
$$;

-- ---------------------------------------------------------------------------
-- 2.2 patients: relax the phone uniqueness (owner decision 1). Shared numbers are allowed; every save that sets a
--     phone returns phone_matches as a warning instead.
-- ---------------------------------------------------------------------------
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS phone_normalized text;

UPDATE public.patients
SET phone_normalized = public.crm__normalize_phone(phone)
WHERE phone_normalized IS DISTINCT FROM public.crm__normalize_phone(phone);

-- Find the unique constraint on exactly (clinic_id, phone) by definition, whatever its live name (expected
-- 'patients_clinic_id_phone_key' from 0003), and drop it. A unique index without a constraint is handled too.
-- Nothing references (clinic_id, phone) and the app never upserts on it (only /api/seed and create-test-users
-- use onConflict, on other keys); auth_user_id UNIQUE and idx_patients_phone stay.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.patients'::regclass
      AND c.contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
             FROM unnest(c.conkey) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
          = ARRAY['clinic_id', 'phone']
  LOOP
    EXECUTE format('ALTER TABLE public.patients DROP CONSTRAINT %I', v.conname);
  END LOOP;

  FOR v IN
    SELECT i.indexrelid::regclass::text AS idx
    FROM pg_index i
    WHERE i.indrelid = 'public.patients'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
             FROM unnest(i.indkey::smallint[]) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['clinic_id', 'phone']
  LOOP
    EXECUTE format('DROP INDEX %s', v.idx);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone_normalized
  ON public.patients (clinic_id, phone_normalized);

-- Composite keys so CRM rows can reference (clinic_id, id) and never point into another clinic (0020 pattern).
-- Added only when no unique constraint on exactly those two columns exists yet.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('patients', 'patients_clinic_id_id_key'),
      ('appointments', 'appointments_clinic_id_id_key')
    ) AS t(tbl, conname)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = format('public.%I', v.tbl)::regclass
        AND c.contype IN ('u', 'p')
        AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
               FROM unnest(c.conkey) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
            = ARRAY['clinic_id', 'id']
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (clinic_id, id)', v.tbl, v.conname);
    END IF;
  END LOOP;
END $$;

-- Adds a named constraint if it is missing. p_not_valid: added NOT VALID, then validated only when every existing
-- row passes; otherwise a NOTICE is raised and the rule applies to new and changed rows only (0019 §7 pattern).
CREATE OR REPLACE FUNCTION public.crm__add_constraint(p_table text, p_name text, p_def text, p_not_valid boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = format('public.%I', p_table)::regclass AND conname = p_name
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s%s', p_table, p_name, p_def,
                   CASE WHEN p_not_valid THEN ' NOT VALID' ELSE '' END);
  END IF;

  IF p_not_valid AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = format('public.%I', p_table)::regclass AND conname = p_name AND NOT convalidated
  ) THEN
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', p_table, p_name);
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE NOTICE '%: % mevcut satırlarda sağlanmıyor; kural şimdilik yalnızca yeni ve değişen satırlara uygulanıyor.',
        p_table, p_name;
    END;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.3 leads: pipeline, follow-up, quote, trash, version.
-- ---------------------------------------------------------------------------
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS stage_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS patient_id uuid,
  ADD COLUMN IF NOT EXISTS phone_normalized text,
  ADD COLUMN IF NOT EXISTS referrer text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS campaign text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS treatment_interest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS interest text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS contact_result text NOT NULL DEFAULT 'unspecified',
  ADD COLUMN IF NOT EXISTS loss_reason text,
  ADD COLUMN IF NOT EXISTS followup_date date,
  ADD COLUMN IF NOT EXISTS followup_state text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS next_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automation_review text,
  ADD COLUMN IF NOT EXISTS treatment_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS treatment_closed_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS quote_amount_cents bigint,
  ADD COLUMN IF NOT EXISTS quote_currency text NOT NULL DEFAULT 'TRY',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS legacy_id text;

-- Backfill once, only where stage is still NULL, so a re-run never overwrites real data. stage_entered_at stays
-- NULL for existing leads (unknown, never fabricated; insights count them as "aşama başlangıcı bilinmiyor").
-- 'qualified' never becomes a booked stage: that needs a real appointment.
UPDATE public.leads
SET stage = public.crm__stage_from_status(status::text),
    interest = CASE status::text WHEN 'interested' THEN 'warm' WHEN 'qualified' THEN 'hot' ELSE interest END,
    loss_reason = CASE WHEN status::text = 'lost' THEN coalesce(loss_reason, 'other') ELSE NULL END
WHERE stage IS NULL;

UPDATE public.leads
SET phone_normalized = public.crm__normalize_phone(phone)
WHERE phone_normalized IS DISTINCT FROM public.crm__normalize_phone(phone);

ALTER TABLE public.leads ALTER COLUMN stage SET DEFAULT 'new';
ALTER TABLE public.leads ALTER COLUMN stage SET NOT NULL;

SELECT public.crm__add_constraint('leads', 'leads_stage_check',
  $c$CHECK (stage IN ('new', 'in_contact', 'appointment_booked', 'appointment_attended', 'offer_given',
                      'treatment_started', 'treatment_completed', 'lost', 'archived'))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_interest_check',
  $c$CHECK (interest IN ('hot', 'warm', 'cold', 'unknown'))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_contact_result_check',
  $c$CHECK (contact_result IN ('unspecified', 'wants_treatment', 'considering_price', 'considering_timing',
                               'will_think_later', 'unreachable', 'call_on_date', 'negative', 'comparing_clinics',
                               'appointment_confirmed'))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_loss_reason_check',
  $c$CHECK (loss_reason IS NULL OR loss_reason IN ('price_high', 'timing_unsuitable', 'unreachable',
                                                  'chose_other_clinic', 'postponed', 'not_suitable', 'other'))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_loss_reason_stage',
  $c$CHECK ((stage = 'lost') = (loss_reason IS NOT NULL))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_followup_state_check',
  $c$CHECK (followup_state IN ('open', 'done'))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_dnc_closed',
  $c$CHECK (NOT do_not_contact OR (followup_state = 'done' AND followup_date IS NULL))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_completed_closed',
  $c$CHECK (stage <> 'treatment_completed'
            OR (followup_state = 'done' AND followup_date IS NULL AND next_action = ''))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_text_lengths',
  $c$CHECK (char_length(referrer) <= 200 AND char_length(campaign) <= 200
            AND char_length(treatment_interest) <= 200 AND char_length(next_action) <= 200
            AND (automation_review IS NULL OR char_length(automation_review) <= 500))$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_quote_check',
  $c$CHECK ((quote_amount_cents IS NULL OR quote_amount_cents BETWEEN 0 AND 1000000000000)
            AND quote_currency IN ('TRY', 'EUR', 'USD'))$c$, false);
-- Old free-text sources stay readable; the rule is validated only when no row breaks it.
SELECT public.crm__add_constraint('leads', 'leads_source_check',
  $c$CHECK (source IS NULL OR source IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral',
                                         'walk_in', 'other', 'direct', 'online', 'social_media'))$c$, true);
SELECT public.crm__add_constraint('leads', 'leads_deleted_pair',
  $c$CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) OR legacy_id IS NOT NULL)$c$, false);
SELECT public.crm__add_constraint('leads', 'leads_clinic_id_id_key', 'UNIQUE (clinic_id, id)', false);
SELECT public.crm__add_constraint('leads', 'leads_patient_fk',
  'FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT', true);

CREATE INDEX IF NOT EXISTS idx_leads_clinic_phone_normalized
  ON public.leads (clinic_id, phone_normalized) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_clinic_stage
  ON public.leads (clinic_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_clinic_followup_open
  ON public.leads (clinic_id, followup_date) WHERE deleted_at IS NULL AND followup_state = 'open';
CREATE INDEX IF NOT EXISTS idx_leads_clinic_created
  ON public.leads (clinic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_patient
  ON public.leads (patient_id) WHERE patient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leads_legacy_key
  ON public.leads (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.4 lead_activities: the lead history (legacy history[], MO:16). Append-only; the only update is a note
--     correction through crm_correct_note.
-- ---------------------------------------------------------------------------
ALTER TABLE public.lead_activities
  ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_change jsonb,
  ADD COLUMN IF NOT EXISTS call_id uuid,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_from uuid REFERENCES public.lead_activities(id),
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS actor_name text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS legacy_id text;

-- 'sms' / 'email' / 'visit' exist only on old rows; no RPC writes them.
SELECT public.crm__add_constraint('lead_activities', 'lead_activities_type_check',
  $c$CHECK (activity_type IN ('note', 'update', 'stage', 'call', 'schedule', 'reminder', 'handoff', 'legacy',
                              'sms', 'email', 'visit'))$c$, true);
SELECT public.crm__add_constraint('lead_activities', 'lead_activities_description_length',
  $c$CHECK (description IS NULL OR char_length(description) <= 12000)$c$, true);
SELECT public.crm__add_constraint('lead_activities', 'lead_activities_schedule_change_check',
  $c$CHECK (schedule_change IS NULL OR jsonb_typeof(schedule_change) = 'object')$c$, false);
SELECT public.crm__add_constraint('lead_activities', 'lead_activities_clinic_lead_fk',
  'FOREIGN KEY (clinic_id, lead_id) REFERENCES public.leads (clinic_id, id) ON DELETE RESTRICT', true);

-- History must never vanish with a lead (C20): the 0008 lead_id -> leads ON DELETE CASCADE key becomes RESTRICT.
-- Leads are trashed, never deleted.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.lead_activities'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.leads'::regclass
      AND c.confdeltype <> 'r'
      AND (SELECT array_agg(a.attname::text)
             FROM unnest(c.conkey) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['lead_id']
  LOOP
    EXECUTE format('ALTER TABLE public.lead_activities DROP CONSTRAINT %I', v.conname);
  END LOOP;
END $$;
SELECT public.crm__add_constraint('lead_activities', 'lead_activities_lead_id_fkey',
  'FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE RESTRICT', true);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_order
  ON public.lead_activities (lead_id, created_at, seq);
CREATE INDEX IF NOT EXISTS idx_lead_activities_schedule_changes
  ON public.lead_activities (clinic_id, created_at) WHERE schedule_change IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_activities_call
  ON public.lead_activities (call_id) WHERE call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lead_activities_legacy_key
  ON public.lead_activities (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- WF:11, NE:6 / T-NE:7, rules R17.3: the free-text leads.notes of an existing lead becomes one 'legacy' history row
-- 'Eski not (görüşme tarihi bilinmiyor): …' by 'Önceki kayıt', dated at the lead's creation, so it stays first in
-- the history, in last_notes / the quick-call context, and can be corrected through crm_correct_note like any
-- other note. leads.notes itself is kept (notes_legacy). Idempotent: a lead that already has a 'note' or 'legacy'
-- row is skipped, so a re-run adds nothing.
INSERT INTO public.lead_activities (id, clinic_id, lead_id, activity_type, description, created_by, created_at,
                                    actor_name)
SELECT gen_random_uuid(), l.clinic_id, l.id, 'legacy',
       left('Eski not (görüşme tarihi bilinmiyor): ' || btrim(l.notes), 12000), NULL, l.created_at, 'Önceki kayıt'
FROM public.leads l
WHERE btrim(coalesce(l.notes, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.lead_activities a WHERE a.lead_id = l.id AND a.activity_type IN ('note', 'legacy')
  );

-- ---------------------------------------------------------------------------
-- 2.5 crm_calls: phone call plans (legacy kind 'appointment'; its 'doctor' field is the caller, MO:19, CP:2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_calls (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  lead_id uuid NOT NULL,
  caller_user_id uuid REFERENCES public.users(id),
  caller_name_legacy text,
  scheduled_date date NOT NULL,
  scheduled_time time NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'reached', 'unreachable', 'cancelled')),
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'automatic')),
  decision text CHECK (decision IN ('auto', 'followup', 'clinic', 'completed', 'lost', 'stop')),
  contact_result text CHECK (contact_result IS NULL OR contact_result IN ('unspecified', 'wants_treatment',
    'considering_price', 'considering_timing', 'will_think_later', 'unreachable', 'call_on_date', 'negative',
    'comparing_clinics', 'appointment_confirmed')),
  note text CHECK (note IS NULL OR char_length(note) <= 10000),
  auto_cancelled boolean NOT NULL DEFAULT false,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.users(id),
  resolve_request_id uuid,
  next_call_id uuid REFERENCES public.crm_calls(id),
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, lead_id) REFERENCES public.leads (clinic_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'planned' OR (resolved_at IS NULL AND decision IS NULL AND NOT auto_cancelled)),
  CHECK (NOT auto_cancelled OR status = 'cancelled'),
  CHECK (decision IS NULL OR NOT auto_cancelled),
  CHECK (decision IS NULL OR decision NOT IN ('auto', 'clinic') OR status IN ('reached', 'unreachable')),
  CHECK (decision IS NULL OR decision <> 'clinic' OR status = 'reached'),
  -- A person's result always carries the decision; only system cancellations and imports may lack one.
  CHECK (status = 'planned' OR decision IS NOT NULL OR auto_cancelled OR legacy_id IS NOT NULL),
  CHECK (caller_user_id IS NOT NULL OR legacy_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_calls_legacy_key
  ON public.crm_calls (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_calls_planned_day
  ON public.crm_calls (clinic_id, scheduled_date, scheduled_time) WHERE status = 'planned';
CREATE INDEX IF NOT EXISTS crm_calls_lead
  ON public.crm_calls (lead_id, scheduled_date DESC, scheduled_time DESC);
CREATE INDEX IF NOT EXISTS crm_calls_resolved
  ON public.crm_calls (clinic_id, resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_calls_caller
  ON public.crm_calls (caller_user_id) WHERE caller_user_id IS NOT NULL;

SELECT public.crm__add_constraint('lead_activities', 'lead_activities_call_fk',
  'FOREIGN KEY (call_id) REFERENCES public.crm_calls(id)', true);

-- ---------------------------------------------------------------------------
-- 2.6 crm_followup_rules: automatic follow-up rules, one row per clinic (FU:5-15). Column defaults equal legacy
--     defaultFollowupRules (FU:15). Distinct work_days is enforced by crm__trg_rules_guard (no subquery in CHECK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_followup_rules (
  clinic_id uuid PRIMARY KEY REFERENCES public.clinics(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  work_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  start_time time NOT NULL DEFAULT '09:00',
  end_time time NOT NULL DEFAULT '18:00',
  call_time time NOT NULL DEFAULT '10:00',
  retry_days smallint NOT NULL DEFAULT 1 CHECK (retry_days BETWEEN 1 AND 30),
  interested_days smallint NOT NULL DEFAULT 1 CHECK (interested_days BETWEEN 1 AND 30),
  price_days smallint NOT NULL DEFAULT 3 CHECK (price_days BETWEEN 1 AND 90),
  timing_days smallint NOT NULL DEFAULT 7 CHECK (timing_days BETWEEN 1 AND 90),
  later_days smallint NOT NULL DEFAULT 7 CHECK (later_days BETWEEN 1 AND 90),
  max_unreachable smallint NOT NULL DEFAULT 3 CHECK (max_unreachable BETWEEN 1 AND 10),
  first_call_minutes smallint NOT NULL DEFAULT 60 CHECK (first_call_minutes BETWEEN 15 AND 1440),
  stale_days smallint NOT NULL DEFAULT 7 CHECK (stale_days BETWEEN 1 AND 90),
  offer_days smallint NOT NULL DEFAULT 3 CHECK (offer_days BETWEEN 1 AND 90),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time AND call_time >= start_time AND call_time < end_time),
  CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ '{0,1,2,3,4,5,6}'::smallint[])
);

-- ---------------------------------------------------------------------------
-- 2.7 crm_handoffs (legacy lead.handoffs[], HO:7-12) and the manager's private note in its own table, so RLS,
--     not projection code, hides it from staff without crm_manage (AC:23, HO:22-25).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_handoffs (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  lead_id uuid NOT NULL,
  patient_id uuid,
  topic text NOT NULL CHECK (topic IN ('price_payment', 'treatment_question', 'followup_decision', 'other')),
  question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 3000),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'answered', 'completed', 'cancelled')),
  requested_by uuid REFERENCES public.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  answer_text text CHECK (answer_text IS NULL OR char_length(btrim(answer_text)) BETWEEN 1 AND 3000),
  answer_due_date date,
  answer_assignee_user_id uuid REFERENCES public.users(id),
  answered_by uuid REFERENCES public.users(id),
  answered_at timestamptz,
  completion_text text CHECK (completion_text IS NULL OR char_length(btrim(completion_text)) BETWEEN 1 AND 3000),
  completed_by uuid REFERENCES public.users(id),
  completed_at timestamptz,
  system_closed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  requested_by_name_legacy text,
  answered_by_name_legacy text,
  completed_by_name_legacy text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, lead_id) REFERENCES public.leads (clinic_id, id) ON DELETE RESTRICT,
  CHECK (status NOT IN ('answered', 'completed')
         OR (answer_text IS NOT NULL AND answer_due_date IS NOT NULL) OR legacy_id IS NOT NULL),
  CHECK (status <> 'waiting' OR (answer_text IS NULL AND answered_at IS NULL)),
  CHECK ((status IN ('completed', 'cancelled')) = (completion_text IS NOT NULL))
);
-- At most one open handoff per lead (HO:32).
CREATE UNIQUE INDEX IF NOT EXISTS crm_handoffs_one_open
  ON public.crm_handoffs (lead_id) WHERE status IN ('waiting', 'answered');
CREATE INDEX IF NOT EXISTS crm_handoffs_status
  ON public.crm_handoffs (clinic_id, status, answer_due_date);
CREATE UNIQUE INDEX IF NOT EXISTS crm_handoffs_legacy_key
  ON public.crm_handoffs (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.crm_handoff_private_notes (
  handoff_id uuid PRIMARY KEY REFERENCES public.crm_handoffs(id) ON DELETE RESTRICT,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  note text NOT NULL CHECK (char_length(note) <= 3000),
  written_by uuid REFERENCES public.users(id),
  written_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, handoff_id) REFERENCES public.crm_handoffs (clinic_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 2.8 staff_tasks: generalised legacy task messages (TMS:3-14, TM). legacy patientId is a CRM lead id (C25).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_tasks (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 2000),
  due_date date NOT NULL,
  lead_id uuid,
  patient_id uuid,
  assignee_user_id uuid NOT NULL REFERENCES public.users(id),
  created_by uuid REFERENCES public.users(id),
  created_by_name_legacy text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  read_at timestamptz,
  completed_at timestamptz,
  completed_by uuid REFERENCES public.users(id),
  result text NOT NULL DEFAULT '' CHECK (char_length(result) <= 2000),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, lead_id) REFERENCES public.leads (clinic_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS staff_tasks_assignee
  ON public.staff_tasks (clinic_id, assignee_user_id, status, due_date);
CREATE INDEX IF NOT EXISTS staff_tasks_creator
  ON public.staff_tasks (clinic_id, created_by, status);
CREATE INDEX IF NOT EXISTS staff_tasks_lead
  ON public.staff_tasks (lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS staff_tasks_legacy_key
  ON public.staff_tasks (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.9 appointments: manual reminder outcome (CRe:3, RR:76-82), keyed by the start time and doctor it was given
--     for (the DentOS form of visitKey, CRe:7), and the CRM link. Plus the per-attempt reminder log.
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS lead_id uuid,
  ADD COLUMN IF NOT EXISTS reminder_outcome text,
  ADD COLUMN IF NOT EXISTS reminder_note text,
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminded_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS reminder_start_time timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_doctor_id uuid;

SELECT public.crm__add_constraint('appointments', 'appointments_reminder_outcome_check',
  $c$CHECK (reminder_outcome IS NULL OR reminder_outcome IN ('reminded', 'unreachable'))$c$, false);
SELECT public.crm__add_constraint('appointments', 'appointments_reminder_note_check',
  $c$CHECK (reminder_note IS NULL OR char_length(reminder_note) BETWEEN 1 AND 1000)$c$, false);
SELECT public.crm__add_constraint('appointments', 'appointments_reminder_consistent',
  $c$CHECK ((reminder_outcome IS NULL) = (reminder_note IS NULL)
            AND (reminder_outcome IS NULL) = (reminded_at IS NULL)
            AND (reminder_outcome IS NULL) = (reminder_start_time IS NULL)
            AND (reminder_outcome IS NULL OR reminder_doctor_id IS NOT NULL OR doctor_id IS NULL)
            AND (reminder_outcome IS NOT NULL OR (reminded_by IS NULL AND reminder_doctor_id IS NULL)))$c$, false);
SELECT public.crm__add_constraint('appointments', 'appointments_lead_fk',
  'FOREIGN KEY (clinic_id, lead_id) REFERENCES public.leads (clinic_id, id) ON DELETE RESTRICT', true);

CREATE INDEX IF NOT EXISTS idx_appointments_lead
  ON public.appointments (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_scheduled_start
  ON public.appointments (clinic_id, start_time) WHERE status = 'scheduled';

-- Every reminder attempt (D-CR:19: several attempts = several rows). Never deleted.
CREATE TABLE IF NOT EXISTS public.appointment_reminder_logs (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('reminded', 'unreachable')),
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 1000),
  start_time timestamptz NOT NULL,
  doctor_id uuid,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES public.appointments (clinic_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES public.patients (clinic_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS appointment_reminder_logs_day
  ON public.appointment_reminder_logs (clinic_id, created_at);
CREATE INDEX IF NOT EXISTS appointment_reminder_logs_appt
  ON public.appointment_reminder_logs (appointment_id, created_at);

-- ---------------------------------------------------------------------------
-- 2.10 crm_ad_spend: monthly ad spend per source (legacy kind 'cost', MO:20). Integer cents (C11). No deletes:
--      an amount of 0 removes the spend from the report. Readable only with finance / finance_readonly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_ad_spend (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral',
                                         'walk_in', 'other')),
  month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 1000000000000),
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency IN ('TRY', 'EUR', 'USD')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, source, month, currency)
);

-- Work item row type (contract §3.4). Created once; the preflight checks an existing one's shape.
DO $$
BEGIN
  IF to_regtype('public.crm_work_item') IS NULL THEN
    CREATE TYPE public.crm_work_item AS (
      item_key text,
      bucket text,
      priority smallint,
      item_type text,
      reason text,
      action text,
      due_date date,
      due_time time,
      lead_id uuid,
      patient_id uuid,
      call_id uuid,
      handoff_id uuid,
      appointment_id uuid,
      caller_user_id uuid,
      assignee_user_id uuid,
      sort_name text,
      quick_call boolean
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Table-dependent helpers (internal; SECURITY INVOKER; every query filtered by p_clinic).
-- ---------------------------------------------------------------------------

-- Name lookups are always scoped to the clinic: they run inside SECURITY DEFINER RPCs and triggers (no RLS), and
-- a foreign id (another clinic's user / doctor / chair) must never resolve to that clinic's name. Earlier
-- unscoped signatures are dropped first so no overload remains (plpgsql / sql bodies are not dependency-tracked).
DROP FUNCTION IF EXISTS public.crm__user_name(uuid);
DROP FUNCTION IF EXISTS public.crm__doctor_name(uuid);
DROP FUNCTION IF EXISTS public.crm__appt_label(timestamptz, uuid, text);

-- Display name of a users row of the clinic for returned JSON and history texts.
CREATE OR REPLACE FUNCTION public.crm__user_name(p_clinic uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT u.full_name FROM public.users u WHERE u.id = p_user AND u.clinic_id = p_clinic
$$;

-- Doctor display name (doctors.user_id -> users.full_name), doctor and user of the clinic.
CREATE OR REPLACE FUNCTION public.crm__doctor_name(p_clinic uuid, p_doctor uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT u.full_name
  FROM public.doctors d
  JOIN public.users u ON u.id = d.user_id AND u.clinic_id = d.clinic_id
  WHERE d.id = p_doctor AND d.clinic_id = p_clinic
$$;

-- Legacy visitLabel (CV:10): 'dd.MM.yyyy HH:mm · <hekim> · <Planlandı|Geldi|Gelmedi|İptal>'.
CREATE OR REPLACE FUNCTION public.crm__appt_label(p_clinic uuid, p_start timestamptz, p_doctor uuid, p_status text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT public.crm__fmt_local(p_start) || ' · ' || coalesce(public.crm__doctor_name(p_clinic, p_doctor), '—')
         || ' · ' || coalesce(public.crm__appt_status_label(p_status), '—')
$$;

-- An active users row of the clinic, else raise p_err (E_CALLER / E_ASSIGNEE).
CREATE OR REPLACE FUNCTION public.crm__active_user(p_clinic uuid, p_user uuid, p_err text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = p_user AND u.clinic_id = p_clinic AND u.is_active = true
  ) THEN
    PERFORM public.crm__raise(p_err);
  END IF;
  RETURN p_user;
END;
$$;

-- Appends one history row; created_by = the caller (NULL from the SQL editor). Order is created_at, seq.
CREATE OR REPLACE FUNCTION public.crm__log(
  p_clinic uuid,
  p_lead uuid,
  p_type text,
  p_text text,
  p_private boolean DEFAULT false,
  p_call uuid DEFAULT NULL,
  p_schedule_change jsonb DEFAULT NULL,
  p_appointment uuid DEFAULT NULL,
  p_id uuid DEFAULT NULL,
  p_edited_from uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid := coalesce(p_id, gen_random_uuid());
BEGIN
  INSERT INTO public.lead_activities (
    id, clinic_id, lead_id, activity_type, description, created_by, is_private, call_id, schedule_change,
    appointment_id, edited_from
  ) VALUES (
    v_id, p_clinic, p_lead, p_type, left(p_text, 12000), public.current_app_user_id(), coalesce(p_private, false),
    p_call, p_schedule_change, p_appointment, p_edited_from
  );
  RETURN v_id;
END;
$$;

-- visit_any / visit_upcoming / call_upcoming (contract §3.1).
CREATE OR REPLACE FUNCTION public.crm__visit_any(p_clinic uuid, p_lead uuid, p_patient uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.clinic_id = p_clinic AND a.status = 'scheduled'
      AND (a.patient_id = p_patient OR a.lead_id = p_lead)
  )
$$;

CREATE OR REPLACE FUNCTION public.crm__visit_upcoming(p_clinic uuid, p_lead uuid, p_patient uuid, p_today date)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.clinic_id = p_clinic AND a.status = 'scheduled'
      AND (a.patient_id = p_patient OR a.lead_id = p_lead)
      AND (a.start_time AT TIME ZONE 'Europe/Istanbul')::date >= p_today
  )
$$;

CREATE OR REPLACE FUNCTION public.crm__call_upcoming(p_clinic uuid, p_lead uuid, p_today date)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.crm_calls c
    WHERE c.clinic_id = p_clinic AND c.lead_id = p_lead AND c.status = 'planned' AND c.scheduled_date >= p_today
  )
$$;

-- RR:225-227. System cancellation of the lead's planned calls (all, or only automatic ones). Marked
-- auto_cancelled so the end-of-day "Sonucu kaydedilen" count leaves them out (fixes Q-4).
CREATE OR REPLACE FUNCTION public.crm__cancel_open_calls(p_clinic uuid, p_lead uuid, p_all boolean, p_reason text)
RETURNS uuid[]
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  WITH c AS (
    UPDATE public.crm_calls k
    SET status = 'cancelled',
        auto_cancelled = true,
        cancel_reason = left(coalesce(p_reason, 'Takip kapatıldı'), 500),
        resolved_at = now(),
        resolved_by = public.current_app_user_id()
    WHERE k.clinic_id = p_clinic
      AND k.lead_id = p_lead
      AND k.status = 'planned'
      AND (p_all OR k.origin = 'automatic')
    RETURNING k.id
  )
  SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_ids FROM c;
  RETURN v_ids;
END;
$$;

-- RR:192, RR:200: a lead in this state no longer keeps (automatic) planned calls.
CREATE OR REPLACE FUNCTION public.crm__should_cancel(p_clinic uuid, l public.leads)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT l.do_not_contact
      OR l.followup_state = 'done'
      OR l.stage IN ('treatment_started', 'treatment_completed', 'lost', 'archived')
      OR public.crm__visit_any(p_clinic, l.id, l.patient_id)
$$;

-- RR:193, RR:200: do-not-contact and a completed treatment cancel manual plans too.
CREATE OR REPLACE FUNCTION public.crm__cancel_all(l public.leads)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT l.do_not_contact OR l.stage = 'treatment_completed'
$$;

CREATE OR REPLACE FUNCTION public.crm__cancel_reason(l public.leads)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN l.do_not_contact THEN 'Hasta aranmak istemiyor'
    WHEN l.stage = 'treatment_completed' THEN 'Tedavi tamamlandı'
    WHEN l.followup_state = 'done' THEN 'Takip kapatıldı'
    WHEN l.stage IN ('treatment_started', 'lost', 'archived') THEN 'Hasta aşaması: ' || public.crm__stage_label(l.stage)
    ELSE 'Klinik randevusu var'
  END
$$;

-- The clinic's rules row, or the column defaults with version 0 when the clinic has none (FRR:15).
CREATE OR REPLACE FUNCTION public.crm__rules(p_clinic uuid)
RETURNS public.crm_followup_rules
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  r public.crm_followup_rules;
BEGIN
  SELECT * INTO r FROM public.crm_followup_rules WHERE clinic_id = p_clinic;
  IF NOT FOUND THEN
    r.clinic_id := p_clinic;
    r.enabled := true;
    r.work_days := '{1,2,3,4,5,6}'::smallint[];
    r.start_time := '09:00';
    r.end_time := '18:00';
    r.call_time := '10:00';
    r.retry_days := 1;
    r.interested_days := 1;
    r.price_days := 3;
    r.timing_days := 7;
    r.later_days := 7;
    r.max_unreachable := 3;
    r.first_call_minutes := 60;
    r.stale_days := 7;
    r.offer_days := 3;
    r.version := 0;
  END IF;
  RETURN r;
END;
$$;

-- Lock a lead of the clinic (FOR UPDATE). Missing -> E_LEAD_NOT_FOUND; trashed -> E_TRASHED unless allowed.
CREATE OR REPLACE FUNCTION public.crm__lead_for_update(p_clinic uuid, p_lead_id uuid, p_allow_trashed boolean DEFAULT false)
RETURNS public.leads
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  l public.leads;
BEGIN
  SELECT * INTO l FROM public.leads WHERE id = p_lead_id AND clinic_id = p_clinic FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.crm__raise('E_LEAD_NOT_FOUND');
  END IF;
  IF l.deleted_at IS NOT NULL AND NOT p_allow_trashed THEN
    PERFORM public.crm__raise('E_TRASHED');
  END IF;
  RETURN l;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.11 Trigger functions. SECURITY DEFINER SET search_path = public, never granted (EXECUTE is not checked when
--      a trigger fires). RPCs check the same rules first so the user sees the specific message.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.crm__trg_phone_normalized()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.phone_normalized := public.crm__normalize_phone(NEW.phone);
  RETURN NEW;
END;
$$;

-- Keeps leads.status (deprecated, still read by older exports) and leads.stage in step: the RPCs write stage only;
-- a SQL-editor / service write of status only (the /api/seed route, manual fixes) still maps to a stage. App users
-- cannot write leads directly any more. No fighting: status -> stage only when status changed and stage did not;
-- stage -> status only when stage changed.
-- It also owns version / updated_at / stage_entered_at and the closure backstops of RR:56, RR:60, RR:70-71.
CREATE OR REPLACE FUNCTION public.crm__trg_leads_compat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text := coalesce(NEW.status::text, 'new');
  v_from_status boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    -- A status-only insert (seed route, SQL editor) arrives with the default stage 'new'.
    IF NEW.stage IS NULL OR (NEW.stage = 'new' AND v_status <> 'new') THEN
      v_from_status := true;
    ELSE
      NEW.status := public.crm__compat_status(NEW.stage, v_status)::public.lead_status;
    END IF;
    IF NEW.legacy_id IS NULL THEN
      NEW.stage_entered_at := coalesce(NEW.stage_entered_at, now());
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.legacy_id IS DISTINCT FROM OLD.legacy_id THEN
      PERFORM public.crm__raise('E_IMMUTABLE');
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
      v_from_status := true;
    ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
      NEW.status := public.crm__compat_status(NEW.stage, OLD.status::text)::public.lead_status;
    END IF;
  END IF;

  IF v_from_status THEN
    NEW.status := v_status::public.lead_status;
    NEW.stage := public.crm__stage_from_status(v_status);
    IF v_status = 'interested' AND NEW.interest = 'unknown' THEN
      NEW.interest := 'warm';
    ELSIF v_status = 'qualified' AND NEW.interest IN ('unknown', 'warm') THEN
      NEW.interest := 'hot';
    ELSIF v_status = 'converted' THEN
      NEW.converted_at := coalesce(NEW.converted_at, now());
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.stage IS DISTINCT FROM OLD.stage
     AND NEW.stage_entered_at IS NOT DISTINCT FROM OLD.stage_entered_at THEN
    NEW.stage_entered_at := now();
  END IF;

  -- Loss reason belongs to 'lost' only (RR:70-71); the old UI has no reason field, so 'other' is used.
  IF NEW.stage = 'lost' THEN
    NEW.loss_reason := coalesce(NEW.loss_reason, 'other');
  ELSE
    NEW.loss_reason := NULL;
  END IF;

  -- A completed treatment closes the follow-up (RR:56). crm_save_lead sets these already; this is the backstop.
  IF NEW.stage = 'treatment_completed' THEN
    NEW.followup_state := 'done';
    NEW.followup_date := NULL;
    NEW.next_action := '';
    NEW.automation_review := NULL;
    IF TG_OP = 'INSERT' OR OLD.stage IS DISTINCT FROM 'treatment_completed' THEN
      NEW.treatment_closed_at := coalesce(NEW.treatment_closed_at, now());
      NEW.treatment_closed_by := coalesce(NEW.treatment_closed_by, public.current_app_user_id());
    END IF;
  END IF;

  -- Do not contact closes the follow-up (RR:60).
  IF NEW.do_not_contact THEN
    NEW.followup_state := 'done';
    NEW.followup_date := NULL;
    NEW.next_action := '';
    NEW.automation_review := NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- The single writer of 'stage' history rows for every path (RPC, appointment sync, current UI, SQL editor), and
-- the call cancellation when a lead becomes closed (RR:192-193, RR:200). RPCs cancel first themselves (to return
-- the ids), so here it usually finds nothing left; it exists for the current UI and the SQL editor.
CREATE OR REPLACE FUNCTION public.crm__trg_leads_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    PERFORM public.crm__log(NEW.clinic_id, NEW.id, 'stage',
      public.crm__stage_label(OLD.stage) || ' → ' || public.crm__stage_label(NEW.stage));
  END IF;

  IF (NEW.do_not_contact AND NOT OLD.do_not_contact)
     OR (NEW.followup_state = 'done' AND OLD.followup_state IS DISTINCT FROM 'done')
     OR (NEW.stage IS DISTINCT FROM OLD.stage
         AND NEW.stage IN ('treatment_started', 'treatment_completed', 'lost', 'archived')) THEN
    PERFORM public.crm__cancel_open_calls(NEW.clinic_id, NEW.id, public.crm__cancel_all(NEW),
                                          public.crm__cancel_reason(NEW));
  END IF;

  RETURN NULL;
END;
$$;

-- Version / timestamps on every mutable CRM table (as 0020 fin__trg_touch). Generic over the column sets: keys,
-- creator and import id are immutable; version + 1; updated_at / updated_by where the table has them.
-- lead_activities is append-only: only a note correction (description, edited_at, edited_by) or the FK clearing
-- appointment_id (ON DELETE SET NULL) may change a row.
CREATE OR REPLACE FUNCTION public.crm__trg_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_patch jsonb;
  v_key text;
  v_free text[] := ARRAY['description', 'edited_at', 'edited_by', 'version', 'appointment_id'];
BEGIN
  FOREACH v_key IN ARRAY ARRAY['id', 'clinic_id', 'created_by', 'created_at', 'legacy_id'] LOOP
    IF v_new ? v_key AND (v_new -> v_key) IS DISTINCT FROM (v_old -> v_key) THEN
      PERFORM public.crm__raise('E_IMMUTABLE');
    END IF;
  END LOOP;

  IF TG_TABLE_NAME = 'lead_activities' THEN
    IF (v_new - v_free) IS DISTINCT FROM (v_old - v_free)
       OR ((v_new -> 'appointment_id') IS DISTINCT FROM (v_old -> 'appointment_id')
           AND jsonb_typeof(v_new -> 'appointment_id') <> 'null') THEN
      PERFORM public.crm__raise('E_HISTORY');
    END IF;
  END IF;

  v_patch := jsonb_build_object('version', (v_old ->> 'version')::integer + 1);
  IF v_new ? 'updated_at' THEN
    v_patch := v_patch || jsonb_build_object('updated_at', now());
  END IF;
  IF v_new ? 'updated_by' THEN
    v_patch := v_patch || jsonb_build_object('updated_by',
                 coalesce(public.current_app_user_id()::text, v_new ->> 'updated_by'));
  END IF;
  NEW := jsonb_populate_record(NEW, v_patch);
  RETURN NEW;
END;
$$;

-- Work days: distinct (FU:6), stored sorted.
CREATE OR REPLACE FUNCTION public.crm__trg_rules_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.work_days IS NULL OR cardinality(NEW.work_days) = 0 THEN
    PERFORM public.crm__raise('E_RULES_DAYS', 'En az bir çalışma günü seçin.');
  END IF;
  IF cardinality(NEW.work_days) <> (SELECT count(DISTINCT d.v) FROM unnest(NEW.work_days) AS d(v)) THEN
    PERFORM public.crm__raise('E_RULES_DAYS', 'Çalışma günleri tekrarlanamaz.');
  END IF;
  NEW.work_days := (SELECT array_agg(d.v ORDER BY d.v) FROM unnest(NEW.work_days) AS d(v));
  RETURN NEW;
END;
$$;

-- crm_calls rules (§2.5): the lead never changes (RR:123); a concluded call is frozen (RR:133, RR:137) except
-- that next_call_id / appointment_id may be filled once and appointment_id cleared by its FK; new calls need an
-- active caller of the clinic (imports excepted); no deletes for API users.
CREATE OR REPLACE FUNCTION public.crm__trg_call_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.crm__is_editor() THEN
      RETURN OLD;
    END IF;
    PERFORM public.crm__raise('E_CALL_NO_DELETE');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.legacy_id IS NULL AND (NEW.caller_user_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = NEW.caller_user_id AND u.clinic_id = NEW.clinic_id AND u.is_active = true
    )) THEN
      PERFORM public.crm__raise('E_CALLER');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lead_id IS DISTINCT FROM OLD.lead_id THEN
    PERFORM public.crm__raise('E_CALL_LEAD');
  END IF;
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    PERFORM public.crm__raise('E_IMMUTABLE');
  END IF;

  IF OLD.status <> 'planned' THEN
    IF NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date
       OR NEW.scheduled_time IS DISTINCT FROM OLD.scheduled_time THEN
      PERFORM public.crm__raise('E_CALL_LOCKED');
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.caller_user_id IS DISTINCT FROM OLD.caller_user_id
       OR NEW.decision IS DISTINCT FROM OLD.decision
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.contact_result IS DISTINCT FROM OLD.contact_result
       OR NEW.auto_cancelled IS DISTINCT FROM OLD.auto_cancelled
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
       OR NEW.resolve_request_id IS DISTINCT FROM OLD.resolve_request_id
       OR (NEW.next_call_id IS DISTINCT FROM OLD.next_call_id AND OLD.next_call_id IS NOT NULL)
       OR (NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
           AND OLD.appointment_id IS NOT NULL AND NEW.appointment_id IS NOT NULL) THEN
      PERFORM public.crm__raise('E_CALL_FROZEN');
    END IF;
  ELSIF NEW.caller_user_id IS DISTINCT FROM OLD.caller_user_id AND NEW.legacy_id IS NULL
        AND (NEW.caller_user_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = NEW.caller_user_id AND u.clinic_id = NEW.clinic_id AND u.is_active = true
        )) THEN
    PERFORM public.crm__raise('E_CALLER');
  END IF;

  RETURN NEW;
END;
$$;

-- CRM history is never deleted by app users (P1 fin__trg_no_delete pattern); TRUNCATE is always refused.
CREATE OR REPLACE FUNCTION public.crm__trg_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND public.crm__is_editor() THEN
    RETURN OLD;
  END IF;
  PERFORM public.crm__raise('E_NO_DELETE');
  RETURN NULL;
END;
$$;

-- Leads are trashed (deleted_at), never deleted (RR:209-222).
CREATE OR REPLACE FUNCTION public.crm__trg_leads_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.crm__is_editor() THEN
    RETURN OLD;
  END IF;
  PERFORM public.crm__raise('E_LEAD_NO_DELETE');
  RETURN NULL;
END;
$$;

-- §2.9 / CRe, RR:76: a new date, time or doctor, or a non-planned status, drops the stored reminder outcome.
-- Moving back to the old time does not restore it; the log rows remain.
CREATE OR REPLACE FUNCTION public.crm__trg_appointment_reminder_reset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.reminder_outcome IS NOT NULL
     AND (NEW.start_time IS DISTINCT FROM OLD.start_time
          OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id
          OR NEW.status IS DISTINCT FROM 'scheduled'::public.appointment_status) THEN
    NEW.reminder_outcome := NULL;
    NEW.reminder_note := NULL;
    NEW.reminded_at := NULL;
    NEW.reminded_by := NULL;
    NEW.reminder_start_time := NULL;
    NEW.reminder_doctor_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- The appointments policies only check clinic_id and their patient / doctor / chair keys are single-column, so an
-- API write could point an appointment at another clinic's row (and the CRM texts would then name it). Composite
-- foreign keys are not used for this: a second appointments -> patients / doctors / chairs key would make the
-- existing PostgREST embeds (patients(...), doctors(...)) ambiguous (PGRST201). Checked only when a key is set or
-- changed by an API user; SQL-editor / service writes and untouched old rows are left alone.
CREATE OR REPLACE FUNCTION public.crm__trg_appointment_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_all boolean := true;
BEGIN
  IF public.crm__is_editor() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    v_all := NEW.clinic_id IS DISTINCT FROM OLD.clinic_id;
  END IF;
  IF NEW.patient_id IS NOT NULL AND (v_all OR NEW.patient_id IS DISTINCT FROM OLD.patient_id)
     AND NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = NEW.patient_id AND p.clinic_id = NEW.clinic_id) THEN
    PERFORM public.crm__raise('E_APPT_REFS');
  END IF;
  IF NEW.doctor_id IS NOT NULL AND (v_all OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id)
     AND NOT EXISTS (SELECT 1 FROM public.doctors d WHERE d.id = NEW.doctor_id AND d.clinic_id = NEW.clinic_id) THEN
    PERFORM public.crm__raise('E_APPT_REFS');
  END IF;
  IF NEW.chair_id IS NOT NULL AND (v_all OR NEW.chair_id IS DISTINCT FROM OLD.chair_id)
     AND NOT EXISTS (SELECT 1 FROM public.chairs c WHERE c.id = NEW.chair_id AND c.clinic_id = NEW.clinic_id) THEN
    PERFORM public.crm__raise('E_APPT_REFS');
  END IF;
  RETURN NEW;
END;
$$;

-- §2.11 crm__trg_appointment_sync: replaces the embedded legacy clinicalVisit flow (CV:4-9, RR:62-68) for every
-- non-trashed lead of the appointment's patient (and the lead that booked it).
--   scheduled  -> stage appointment_booked unless protected (CV:7); follow-up reset to 'Klinik randevu sonucunu
--                 kontrol et' unless the treatment is completed or the lead does not want calls (RR:66, RR:86);
--                 automatic calls cancelled (RR:192).
--   completed  -> stage appointment_attended unless protected (CV:6).
--   no_show / cancelled, and no other scheduled appointment from today on -> booked/attended fall back to
--                 in_contact (CV:8); an open lead is flagged for a follow-up decision (deliberate deviation from
--                 RR:67, which refused the save: the appointments page cannot ask for a follow-up plan).
-- Every change writes one 'update' row 'Klinik randevusu: <önceki> → <yeni>' (WF:21) with appointment_id; the
-- stage row and the status mapping come from the leads triggers. A failure never blocks the appointment page
-- (WARNING); inside crm_resolve_call ('crm.strict_sync' = on) it is re-raised so the booking rolls back whole.
CREATE OR REPLACE FUNCTION public.crm__trg_appointment_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := public.clinic_today();
  v_old_label text;
  v_new_label text;
  l public.leads;
  v_stage text;
  v_state text;
  v_date date;
  v_next text;
  v_review text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
     AND NEW.doctor_id IS NOT DISTINCT FROM OLD.doctor_id
     AND NEW.patient_id IS NOT DISTINCT FROM OLD.patient_id THEN
    RETURN NULL;
  END IF;
  IF NEW.status IS NULL THEN
    RETURN NULL;
  END IF;

  v_new_label := public.crm__appt_label(NEW.clinic_id, NEW.start_time, NEW.doctor_id, NEW.status::text);
  IF TG_OP = 'INSERT' THEN
    v_old_label := 'Yok';
  ELSE
    v_old_label := public.crm__appt_label(OLD.clinic_id, OLD.start_time, OLD.doctor_id, OLD.status::text);
  END IF;

  FOR l IN
    SELECT * FROM public.leads
    WHERE clinic_id = NEW.clinic_id
      AND deleted_at IS NULL
      AND (patient_id = NEW.patient_id OR id = NEW.lead_id)
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    BEGIN
      v_stage := l.stage;
      v_state := l.followup_state;
      v_date := l.followup_date;
      v_next := l.next_action;
      v_review := l.automation_review;

      IF NEW.status = 'scheduled' THEN
        IF v_stage NOT IN ('offer_given', 'treatment_started', 'treatment_completed', 'lost', 'archived') THEN
          v_stage := 'appointment_booked';
        END IF;
        IF v_stage <> 'treatment_completed' AND NOT l.do_not_contact THEN
          v_state := 'open';
          v_date := NULL;
          v_next := 'Klinik randevu sonucunu kontrol et';
          v_review := NULL;
        END IF;
        PERFORM public.crm__cancel_open_calls(NEW.clinic_id, l.id, false, 'Klinik randevusu planlandı');
      ELSIF NEW.status = 'completed' THEN
        IF v_stage NOT IN ('offer_given', 'treatment_started', 'treatment_completed', 'lost', 'archived') THEN
          v_stage := 'appointment_attended';
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.appointments a
        WHERE a.clinic_id = NEW.clinic_id
          AND a.id <> NEW.id
          AND a.status = 'scheduled'
          AND (a.patient_id = NEW.patient_id OR a.lead_id = l.id)
          AND (a.start_time AT TIME ZONE 'Europe/Istanbul')::date >= v_today
      ) THEN
        IF v_stage IN ('appointment_booked', 'appointment_attended') THEN
          v_stage := 'in_contact';
        END IF;
        IF public.crm__is_open(v_stage, l.do_not_contact, v_state) THEN
          -- Rules R5.2 step 3: the 'Klinik randevu sonucunu kontrol et' step of the booking must not survive a
          -- missed visit (legacy RT:67 demanded a new date and step); the review flag asks for them instead.
          v_date := NULL;
          v_next := '';
          v_review := 'Klinik randevusu gerçekleşmedi (Gelmedi/İptal). Yeni takip tarihi ve sonraki adımı belirleyin veya takibi kapatın.';
        END IF;
      END IF;

      IF (v_stage, v_state, v_date, v_next, v_review)
         IS DISTINCT FROM (l.stage, l.followup_state, l.followup_date, l.next_action, l.automation_review) THEN
        UPDATE public.leads
        SET stage = v_stage,
            followup_state = v_state,
            followup_date = v_date,
            next_action = v_next,
            automation_review = v_review
        WHERE id = l.id;
      END IF;

      PERFORM public.crm__log(NEW.clinic_id, l.id, 'update',
        'Klinik randevusu: ' || v_old_label || ' → ' || v_new_label, false, NULL, NULL, NEW.id);
    EXCEPTION WHEN OTHERS THEN
      IF coalesce(current_setting('crm.strict_sync', true), '') = 'on' THEN
        RAISE;
      END IF;
      RAISE WARNING 'CRM randevu eşitlemesi yapılamadı (randevu %, aday %): %', NEW.id, l.id, SQLERRM;
    END;
  END LOOP;

  RETURN NULL;
END;
$$;

-- Trigger wiring (idempotent).
DROP TRIGGER IF EXISTS crm_phone_normalized ON public.patients;
CREATE TRIGGER crm_phone_normalized
  BEFORE INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_phone_normalized();

DROP TRIGGER IF EXISTS crm_phone_normalized ON public.leads;
CREATE TRIGGER crm_phone_normalized
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_phone_normalized();

DROP TRIGGER IF EXISTS crm_leads_compat ON public.leads;
CREATE TRIGGER crm_leads_compat
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_leads_compat();

DROP TRIGGER IF EXISTS crm_leads_after ON public.leads;
CREATE TRIGGER crm_leads_after
  AFTER UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_leads_after();

DROP TRIGGER IF EXISTS crm_leads_no_delete ON public.leads;
CREATE TRIGGER crm_leads_no_delete
  BEFORE DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_leads_no_delete();

DROP TRIGGER IF EXISTS crm_rules_guard ON public.crm_followup_rules;
CREATE TRIGGER crm_rules_guard
  BEFORE INSERT OR UPDATE ON public.crm_followup_rules
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_rules_guard();

DROP TRIGGER IF EXISTS crm_call_guard ON public.crm_calls;
CREATE TRIGGER crm_call_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.crm_calls
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_call_guard();

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['crm_calls', 'crm_handoffs', 'staff_tasks', 'crm_followup_rules', 'crm_ad_spend',
                             'lead_activities']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS crm_touch ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER crm_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.crm__trg_touch()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['lead_activities', 'crm_handoffs', 'crm_handoff_private_notes', 'staff_tasks',
                             'crm_ad_spend', 'appointment_reminder_logs', 'crm_followup_rules']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS crm_no_delete ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER crm_no_delete BEFORE DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.crm__trg_no_delete()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['lead_activities', 'crm_calls', 'crm_handoffs', 'crm_handoff_private_notes',
                             'staff_tasks', 'crm_ad_spend', 'appointment_reminder_logs', 'crm_followup_rules']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS crm_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER crm_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.crm__trg_no_delete()', v_t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS crm_appointment_reminder_reset ON public.appointments;
CREATE TRIGGER crm_appointment_reminder_reset
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_appointment_reminder_reset();

DROP TRIGGER IF EXISTS crm_appointment_refs ON public.appointments;
CREATE TRIGGER crm_appointment_refs
  BEFORE INSERT OR UPDATE OF clinic_id, patient_id, doctor_id, chair_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_appointment_refs();

DROP TRIGGER IF EXISTS crm_appointment_sync ON public.appointments;
CREATE TRIGGER crm_appointment_sync
  AFTER INSERT OR UPDATE OF status, start_time, doctor_id, patient_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.crm__trg_appointment_sync();

-- ---------------------------------------------------------------------------
-- 2.12 Row level security and table privileges. Supabase grants ALL on public tables to anon / authenticated by
--      default, so every table touched here gets an explicit revoke and an explicit authenticated grant set.
--      Helpers are wrapped as (SELECT ...) so they are evaluated once per statement.
-- ---------------------------------------------------------------------------

-- leads: trashed leads disappear from every direct read (RR:21). No direct writes at all (rules §17.4, matrix
-- §27 "Direct INSERT/UPDATE/DELETE on any CRM table → 403"): a direct PATCH of status / assigned_to would skip
-- every crm_save_lead rule (reopen and close notes, loss reason, assignee of the clinic, history). The Phase 6 web
-- build writes leads only through RPCs, so the contract's compatibility window (§6.5) is not opened; see RUNBOOK.
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leads_clinic_isolation" ON public.leads;
CREATE POLICY "leads_clinic_isolation" ON public.leads
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT public.current_clinic_id()) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "leads_insert_own_clinic" ON public.leads;
DROP POLICY IF EXISTS "leads_update_own_clinic" ON public.leads;
DROP POLICY IF EXISTS "leads_delete_own_clinic" ON public.leads;
-- Any other write policy (whatever its live name) goes too; writes are RPC-only.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT p.policyname FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'leads' AND p.cmd <> 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.leads', v.policyname);
  END LOOP;
END $$;

-- Revoking the table privilege also revokes every column privilege granted by an earlier run.
REVOKE ALL ON public.leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.leads TO authenticated;

-- lead_activities: private rows only for CRM managers (AC:23), rows of trashed leads hidden (RR:21). No current
-- page writes this table (settings/export only reads it); every write is an RPC.
ALTER TABLE public.lead_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lead_activities_clinic_isolation" ON public.lead_activities;
DROP POLICY IF EXISTS "lead_activities_insert_own_clinic" ON public.lead_activities;
DROP POLICY IF EXISTS "lead_activities_update_own_clinic" ON public.lead_activities;
DROP POLICY IF EXISTS "lead_activities_select" ON public.lead_activities;
CREATE POLICY "lead_activities_select" ON public.lead_activities
  FOR SELECT TO authenticated
  USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND (NOT is_private OR (SELECT public.crm_can_manage()))
    AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_activities.lead_id AND l.deleted_at IS NULL)
  );
REVOKE ALL ON public.lead_activities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_activities TO authenticated;

-- New tables: SELECT only, one policy each, no write policies.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('crm_calls', 'crm_calls_select',
       'clinic_id = (SELECT public.current_clinic_id())
        AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = crm_calls.lead_id AND l.deleted_at IS NULL)'),
      ('crm_followup_rules', 'crm_followup_rules_select',
       'clinic_id = (SELECT public.current_clinic_id())'),
      ('crm_handoffs', 'crm_handoffs_select',
       'clinic_id = (SELECT public.current_clinic_id())
        AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = crm_handoffs.lead_id AND l.deleted_at IS NULL)'),
      ('crm_handoff_private_notes', 'crm_handoff_private_notes_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.crm_can_manage())'),
      ('staff_tasks', 'staff_tasks_select',
       'clinic_id = (SELECT public.current_clinic_id())
        AND (assignee_user_id = (SELECT public.current_app_user_id())
             OR created_by = (SELECT public.current_app_user_id())
             OR (SELECT public.crm_can_manage()))'),
      ('appointment_reminder_logs', 'appointment_reminder_logs_select',
       'clinic_id = (SELECT public.current_clinic_id())'),
      ('crm_ad_spend', 'crm_ad_spend_select',
       'clinic_id = (SELECT public.current_clinic_id())
        AND (SELECT public.has_permission(''finance'') OR public.has_permission(''finance_readonly''))')
    ) AS t(tbl, pol, expr)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v.pol, v.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', v.pol, v.tbl, v.expr);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v.tbl);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v.tbl);
  END LOOP;
END $$;

-- appointments: policies unchanged (clinic isolation). The pages keep INSERT / UPDATE on every column except
-- lead_id and the reminder_* columns, which only crm_set_reminder_outcome, crm_resolve_call and the reset trigger
-- write. The list is built from the live columns (the table may carry drifted columns, C19), so a column added
-- later is NOT writable until this helper runs again: every later migration that adds an appointments column the
-- web app writes ends with SELECT public.crm__grant_appointment_columns(); (internal, never granted).
CREATE OR REPLACE FUNCTION public.crm__grant_appointment_columns()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'appointments'
    AND c.is_generated = 'NEVER'
    AND c.column_name NOT IN ('lead_id', 'reminder_outcome', 'reminder_note', 'reminded_at', 'reminded_by',
                              'reminder_start_time', 'reminder_doctor_id');

  REVOKE ALL ON public.appointments FROM anon;
  -- Revoking the table privilege also revokes the column privileges of an earlier run.
  REVOKE INSERT, UPDATE ON public.appointments FROM PUBLIC, authenticated;
  EXECUTE format('GRANT INSERT (%s) ON public.appointments TO authenticated', v_cols);
  EXECUTE format('GRANT UPDATE (%s) ON public.appointments TO authenticated', v_cols);
END;
$$;

SELECT public.crm__grant_appointment_columns();

-- patients: unchanged for staff; phone_normalized is always recomputed by its trigger.
REVOKE ALL ON public.patients FROM anon;

-- ---------------------------------------------------------------------------
-- 2.13 Audit: audit_row_change() (0019) on the mutable CRM tables. lead_activities (append-only, corrections are
--      their own rows), crm_handoff_private_notes (would copy private text into audit_logs) and
--      appointment_reminder_logs (itself a log) are not audited. Ad-spend history only for finance holders: a
--      RESTRICTIVE gate, ANDed with the 0019 / 0020 policies, which are not recreated here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['leads', 'crm_calls', 'crm_handoffs', 'staff_tasks', 'crm_followup_rules',
                             'crm_ad_spend']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()', v_t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "audit_logs_crm_money_guard" ON public.audit_logs;
CREATE POLICY "audit_logs_crm_money_guard" ON public.audit_logs
  AS RESTRICTIVE
  FOR SELECT
  USING (
    entity_type <> 'crm_ad_spend'
    OR (SELECT public.has_permission('finance') OR public.has_permission('finance_readonly'))
  );

-- ---------------------------------------------------------------------------
-- §3 Internal engine. Never granted; SECURITY INVOKER (fail closed, 0020 pattern); called from SECURITY DEFINER
--    RPCs, so every query filters by p_clinic. Time-dependent ones take p_today / p_now_local for replay.
-- ---------------------------------------------------------------------------

-- RulesJson (contract §3.2). version 0 = defaults, never saved.
CREATE OR REPLACE FUNCTION public.crm__rules_json(r public.crm_followup_rules)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'version', (r).version,
    'enabled', (r).enabled,
    'work_days', to_jsonb((r).work_days),
    'start_time', public.crm__fmt_time((r).start_time),
    'end_time', public.crm__fmt_time((r).end_time),
    'call_time', public.crm__fmt_time((r).call_time),
    'retry_days', (r).retry_days,
    'interested_days', (r).interested_days,
    'price_days', (r).price_days,
    'timing_days', (r).timing_days,
    'later_days', (r).later_days,
    'max_unreachable', (r).max_unreachable,
    'first_call_minutes', (r).first_call_minutes,
    'stale_days', (r).stale_days,
    'offer_days', (r).offer_days,
    'daily_minutes', (EXTRACT(EPOCH FROM ((r).end_time - (r).start_time)) / 60)::integer
  )
$$;

-- Validated rules from JSON (FU:5-12) on top of p_base. p_require_all: every RulesJson key except version /
-- daily_minutes must be present (crm_save_followup_rules); otherwise missing keys keep p_base (pure helpers).
CREATE OR REPLACE FUNCTION public.crm__rules_from_json(p_base public.crm_followup_rules, p jsonb, p_require_all boolean)
RETURNS public.crm_followup_rules
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  r public.crm_followup_rules := p_base;
  v_missing text;
  v_el jsonb;
  v_days smallint[] := '{}'::smallint[];
  v_n bigint;
  v_f record;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    PERFORM public.crm__raise('E_FIELDS', 'rules');
  END IF;
  IF p_require_all THEN
    v_missing := public.crm__missing_keys(p, ARRAY['enabled', 'work_days', 'start_time', 'end_time', 'call_time',
      'retry_days', 'interested_days', 'price_days', 'timing_days', 'later_days', 'max_unreachable',
      'first_call_minutes', 'stale_days', 'offer_days']);
    IF v_missing IS NOT NULL THEN
      PERFORM public.crm__raise('E_FIELDS', v_missing);
    END IF;
  END IF;

  IF p ? 'enabled' THEN
    r.enabled := public.crm__j_bool(p, 'enabled');
    IF r.enabled IS NULL THEN
      PERFORM public.crm__raise('E_FIELDS', 'enabled');
    END IF;
  END IF;

  IF p ? 'work_days' THEN
    IF jsonb_typeof(p -> 'work_days') <> 'array' THEN
      PERFORM public.crm__raise('E_FIELDS', 'work_days');
    END IF;
    IF jsonb_array_length(p -> 'work_days') = 0 THEN
      PERFORM public.crm__raise('E_RULES_DAYS', 'En az bir çalışma günü seçin.');
    END IF;
    FOR v_el IN SELECT e.value FROM jsonb_array_elements(p -> 'work_days') AS e(value) LOOP
      IF jsonb_typeof(v_el) <> 'number' OR (v_el #>> '{}') !~ '^[0-9]{1,2}$' THEN
        PERFORM public.crm__raise('E_FIELDS', 'work_days');
      END IF;
      v_n := (v_el #>> '{}')::bigint;
      IF v_n > 6 THEN
        PERFORM public.crm__raise('E_RULES_RANGE', 'Çalışma günleri 0–6 arasında olmalı.');
      END IF;
      v_days := v_days || v_n::smallint;
    END LOOP;
    IF cardinality(v_days) <> (SELECT count(DISTINCT d.v) FROM unnest(v_days) AS d(v)) THEN
      PERFORM public.crm__raise('E_RULES_DAYS', 'Çalışma günleri tekrarlanamaz.');
    END IF;
    r.work_days := (SELECT array_agg(d.v ORDER BY d.v) FROM unnest(v_days) AS d(v));
  END IF;

  IF p ? 'start_time' THEN r.start_time := public.crm__time(public.crm__j_text(p, 'start_time')); END IF;
  IF p ? 'end_time' THEN r.end_time := public.crm__time(public.crm__j_text(p, 'end_time')); END IF;
  IF p ? 'call_time' THEN r.call_time := public.crm__time(public.crm__j_text(p, 'call_time')); END IF;

  -- Ranges and Turkish labels of the settings dialog (FS:11).
  FOR v_f IN
    SELECT * FROM (VALUES
      ('retry_days', 'Ulaşılamadı · kaç gün sonra?', 1, 30),
      ('interested_days', 'Randevu / tedavi istiyor · gün', 1, 30),
      ('price_days', 'Fiyatı değerlendiriyor · gün', 1, 90),
      ('timing_days', 'Zamanlamayı değerlendiriyor · gün', 1, 90),
      ('later_days', 'Daha sonra düşünecek · gün', 1, 90),
      ('max_unreachable', 'Art arda ulaşılamayan arama sınırı', 1, 10),
      ('first_call_minutes', 'İlk arama hedefi · çalışma dakikası', 15, 1440),
      ('stale_days', 'Aynı aşamada bekleme · iş günü', 1, 90),
      ('offer_days', 'Teklif yanıtı bekleme · iş günü', 1, 90)
    ) AS t(k, label, lo, hi)
  LOOP
    IF p ? v_f.k THEN
      v_n := public.crm__j_bigint(p, v_f.k);
      IF v_n IS NULL THEN
        PERFORM public.crm__raise('E_FIELDS', v_f.k);
      END IF;
      IF v_n NOT BETWEEN v_f.lo AND v_f.hi THEN
        PERFORM public.crm__raise('E_RULES_RANGE', format('%s %s–%s arasında olmalı.', v_f.label, v_f.lo, v_f.hi));
      END IF;
      r := jsonb_populate_record(r, jsonb_build_object(v_f.k, v_n));
    END IF;
  END LOOP;

  IF NOT (r.start_time < r.end_time AND r.call_time >= r.start_time AND r.call_time < r.end_time) THEN
    PERFORM public.crm__raise('E_RULES_TIME');
  END IF;
  RETURN r;
END;
$$;

-- FU:18-22. First day d in p_day .. p_day+369 that is a working day and whose call time is strictly later than
-- the local minute (a slot in the current minute is not later). Else E_AUTO_SLOT.
CREATE OR REPLACE FUNCTION public.crm__next_working_slot(
  p_day date,
  r public.crm_followup_rules,
  p_now_local timestamp,
  OUT o_date date,
  OUT o_time time
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  SELECT p_day + g.i INTO o_date
  FROM generate_series(0, 369) AS g(i)
  WHERE EXTRACT(DOW FROM (p_day + g.i))::integer = ANY (r.work_days::integer[])
    AND ((p_day + g.i) + r.call_time) > date_trunc('minute', p_now_local)
  ORDER BY g.i
  LIMIT 1;
  IF o_date IS NULL THEN
    PERFORM public.crm__raise('E_AUTO_SLOT');
  END IF;
  o_time := r.call_time;
END;
$$;

-- Exact port of automaticPlan (FU:32-52), pure: every input is an argument. Returns
-- {kind:'call'|'keep'|'stop'|'review', reason, date?, time?, action?, keep_call_id?}; raises E_AUTO_OFF /
-- E_AUTO_RESULT / E_AUTO_SLOT. p_followup_date is already NULL when it equalled the concluded call's date (RR:163).
CREATE OR REPLACE FUNCTION public.crm__auto_plan_core(
  p_dnc boolean,
  p_followup_state text,
  p_stage text,
  p_open_visit boolean,
  p_followup_date date,
  p_next_action text,
  p_status text,
  p_result text,
  r public.crm_followup_rules,
  p_pending_id text,
  p_pending_date date,
  p_pending_time time,
  p_unreachable integer,
  p_today date,
  p_now_local timestamp
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_days integer;
  v_action text;
  v_slot record;
BEGIN
  -- 1. FU:33
  IF coalesce(p_dnc, false) OR coalesce(p_followup_state, 'open') = 'done'
     OR p_stage IN ('treatment_started', 'treatment_completed', 'lost', 'archived') THEN
    RETURN jsonb_build_object('kind', 'stop', 'reason', 'Takip kapalı; otomatik arama oluşturulmadı.');
  END IF;
  -- 2. FU:34
  IF coalesce(p_open_visit, false) THEN
    RETURN jsonb_build_object('kind', 'stop', 'reason', 'Klinik randevusu var; randevu hatırlatma akışı devam ediyor.');
  END IF;
  -- 3. FU:35
  IF p_result = 'negative' THEN
    RETURN jsonb_build_object('kind', 'review', 'reason',
      'Olumsuz görüşme sonucu kaydedildi. Takibin kapanması için hasta aşamasını ve olumsuz sonuç nedenini değerlendirin.');
  END IF;
  -- 4. FU:36
  IF p_result = 'appointment_confirmed' THEN
    RETURN jsonb_build_object('kind', 'review', 'reason',
      'Randevu kesinleşti. Klinik randevusunu “Klinik randevusu kesinleşti” kararıyla veya randevu ekranından kaydedin; planlı arama klinik randevusu değildir.');
  END IF;
  -- 5. FU:37
  IF NOT r.enabled THEN
    PERFORM public.crm__raise('E_AUTO_OFF');
  END IF;
  -- 6. FU:38: an existing planned call (manual or automatic) always wins.
  IF p_pending_id IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'keep', 'reason', 'Mevcut arama planı korundu; ikinci arama oluşturulmadı.',
      'keep_call_id', p_pending_id, 'date', p_pending_date, 'time', public.crm__fmt_time(p_pending_time));
  END IF;
  -- 7. FU:39-40: a future follow-up date on the card is kept, even on a non-working day.
  IF p_followup_date > p_today THEN
    RETURN jsonb_build_object('kind', 'call', 'reason', 'Hasta kartındaki ileri tarihli takip korundu.',
      'date', p_followup_date, 'time', public.crm__fmt_time(r.call_time),
      'action', coalesce(nullif(btrim(p_next_action), ''), 'Hastanın belirlenen takip tarihinde ara'));
  END IF;
  -- 8. FU:41
  IF p_status = 'unreachable' AND coalesce(p_unreachable, 0) >= r.max_unreachable THEN
    RETURN jsonb_build_object('kind', 'review', 'reason',
      format('Art arda %s aramada ulaşılamadı. Yeni arama oluşturmadan takip kararını gözden geçirin.', p_unreachable));
  END IF;
  -- 9. FU:42-51
  v_key := CASE WHEN p_status = 'unreachable' THEN 'unreachable' ELSE p_result END;
  CASE v_key
    WHEN 'unreachable' THEN v_days := r.retry_days; v_action := 'Hastaya yeniden ulaşmayı dene';
    WHEN 'wants_treatment' THEN v_days := r.interested_days; v_action := 'Klinik randevusunu veya tedavi başlangıcını netleştir';
    WHEN 'comparing_clinics' THEN v_days := r.price_days; v_action := 'Diğer görüşmeler sonrası hastanın kararını ve sorularını görüş';
    WHEN 'considering_price' THEN v_days := r.price_days; v_action := 'Teklif hakkındaki sorularını ve kararını görüş';
    WHEN 'considering_timing' THEN v_days := r.timing_days; v_action := 'Tedavi için uygun zamanı görüş';
    WHEN 'will_think_later' THEN v_days := r.later_days; v_action := 'Hastanın tedavi planını yeniden görüş';
    ELSE PERFORM public.crm__raise('E_AUTO_RESULT');
  END CASE;

  SELECT * INTO v_slot FROM public.crm__next_working_slot(p_today + v_days, r, p_now_local);
  RETURN jsonb_build_object('kind', 'call', 'reason', 'Görüşme sonucuna göre otomatik planlandı.',
    'date', v_slot.o_date, 'time', public.crm__fmt_time(v_slot.o_time), 'action', v_action);
END;
$$;

-- The table-reading wrapper used by crm_resolve_call (contract §3.3): open visit and the other planned calls come
-- from the tables; the follow-up date equal to the concluded call's date is dropped first (RR:163).
CREATE OR REPLACE FUNCTION public.crm__auto_plan(
  p_clinic uuid,
  l public.leads,
  p_status text,
  p_contact_result text,
  r public.crm_followup_rules,
  p_call_date date,
  p_exclude_call uuid,
  p_unreachable integer,
  p_today date,
  p_now_local timestamp
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_pending_id uuid;
  v_pending_date date;
  v_pending_time time;
BEGIN
  SELECT c.id, c.scheduled_date, c.scheduled_time INTO v_pending_id, v_pending_date, v_pending_time
  FROM public.crm_calls c
  WHERE c.clinic_id = p_clinic AND c.lead_id = l.id AND c.status = 'planned'
    AND c.id IS DISTINCT FROM p_exclude_call
  ORDER BY c.scheduled_date, c.scheduled_time, c.id
  LIMIT 1;

  RETURN public.crm__auto_plan_core(
    l.do_not_contact, l.followup_state, l.stage,
    public.crm__visit_any(p_clinic, l.id, l.patient_id),
    CASE WHEN l.followup_date = p_call_date THEN NULL ELSE l.followup_date END,
    l.next_action, p_status, p_contact_result, r,
    v_pending_id::text, v_pending_date, v_pending_time,
    p_unreachable, p_today, p_now_local);
END;
$$;

-- RR:160-162: the run of 'unreachable' results among the lead's earlier attempted calls (newest first),
-- stopping at the first 'reached'. Cancelled and planned calls are not in the walk. The caller adds 1.
CREATE OR REPLACE FUNCTION public.crm__consecutive_unreachable(p_clinic uuid, p_lead uuid, p_exclude_call uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  WITH p AS (
    SELECT c.status,
           row_number() OVER (ORDER BY coalesce(c.resolved_at, c.created_at) DESC, c.id DESC) AS rn
    FROM public.crm_calls c
    WHERE c.clinic_id = p_clinic
      AND c.lead_id = p_lead
      AND c.id IS DISTINCT FROM p_exclude_call
      AND c.status IN ('reached', 'unreachable')
  )
  SELECT coalesce(min(p.rn) FILTER (WHERE p.status = 'reached') - 1, count(*))::integer FROM p
$$;

-- FU:23-30: working minutes between two instants on the rules' working days and hours (Istanbul). NULL when an
-- end is missing, reversed, or more than 3660 days apart. One rounding at the end, on numeric (half away from
-- zero, = JS Math.round for positives; float8 round() would round half to even).
CREATE OR REPLACE FUNCTION public.crm__working_minutes(p_from timestamptz, p_to timestamptz, r public.crm_followup_rules)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > interval '3660 days' THEN NULL
    ELSE (
      SELECT round(coalesce(sum(greatest(0::numeric,
               EXTRACT(EPOCH FROM (
                 least(p_to, (d.day + (r).end_time) AT TIME ZONE 'Europe/Istanbul')
                 - greatest(p_from, (d.day + (r).start_time) AT TIME ZONE 'Europe/Istanbul')
               ))::numeric)), 0::numeric) / 60)::integer
      FROM (
        SELECT (p_from AT TIME ZONE 'Europe/Istanbul')::date + g.i AS day
        FROM generate_series(0, (p_to AT TIME ZONE 'Europe/Istanbul')::date
                                - (p_from AT TIME ZONE 'Europe/Istanbul')::date) AS g(i)
      ) d
      WHERE EXTRACT(DOW FROM d.day)::integer = ANY ((r).work_days::integer[])
    )
  END
$$;

-- PhoneMatchesJson (contract §3.2): other non-trashed leads and patients (inactive ones flagged) of the clinic
-- with the same normalized number, at most 10 each. Never an error (owner decision 1).
CREATE OR REPLACE FUNCTION public.crm__phone_matches(p_clinic uuid, p_phone text, p_exclude_lead uuid, p_exclude_patient uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH n AS (SELECT public.crm__normalize_phone(p_phone) AS v)
  SELECT jsonb_build_object(
    'normalized', n.v,
    'leads', CASE WHEN length(n.v) < 7 THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'full_name', x.full_name, 'stage', x.stage,
                                          'assigned_name', x.assigned_name) ORDER BY x.created_at DESC, x.id)
      FROM (
        SELECT l.id, l.full_name, l.stage, l.created_at, u.full_name AS assigned_name
        FROM public.leads l
        LEFT JOIN public.users u ON u.id = l.assigned_to AND u.clinic_id = l.clinic_id
        WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL AND l.phone_normalized = n.v
          AND l.id IS DISTINCT FROM p_exclude_lead
        ORDER BY l.created_at DESC, l.id
        LIMIT 10
      ) x), '[]'::jsonb) END,
    'patients', CASE WHEN length(n.v) < 7 THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', y.id, 'full_name', y.full_name, 'is_active', y.is_active)
                       ORDER BY y.created_at DESC, y.id)
      FROM (
        SELECT p.id, p.full_name, p.is_active IS NOT FALSE AS is_active, p.created_at
        FROM public.patients p
        WHERE p.clinic_id = p_clinic AND p.phone_normalized = n.v
          AND p.id IS DISTINCT FROM p_exclude_patient
        ORDER BY p.created_at DESC, p.id
        LIMIT 10
      ) y), '[]'::jsonb) END
  )
  FROM n
$$;

-- Appointment slot checks of appointments/new (same rule and texts). The advisory lock serialises CRM bookings
-- per clinic so two concurrent ones cannot both pass; the current appointment pages do not take it (pre-existing).
CREATE OR REPLACE FUNCTION public.crm__check_slot(
  p_clinic uuid, p_doctor uuid, p_chair uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('appointments.slot:' || p_clinic::text, 0));
  IF p_end <= p_start THEN
    PERFORM public.crm__raise('E_SLOT_ORDER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.doctors d WHERE d.id = p_doctor AND d.clinic_id = p_clinic) THEN
    PERFORM public.crm__raise('E_DOCTOR');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chairs c WHERE c.id = p_chair AND c.clinic_id = p_clinic AND c.is_active IS NOT FALSE) THEN
    PERFORM public.crm__raise('E_CHAIR');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.clinic_id = p_clinic AND a.status = 'scheduled' AND a.id IS DISTINCT FROM p_exclude
      AND a.start_time < p_end AND a.end_time > p_start AND a.doctor_id = p_doctor
  ) THEN
    PERFORM public.crm__raise('E_SLOT_DOCTOR');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.clinic_id = p_clinic AND a.status = 'scheduled' AND a.id IS DISTINCT FROM p_exclude
      AND a.start_time < p_end AND a.end_time > p_start AND a.chair_id = p_chair
  ) THEN
    PERFORM public.crm__raise('E_SLOT_CHAIR');
  END IF;
END;
$$;

-- Links the lead to an existing patient or creates one (contract §3.3). Never refuses a shared phone (owner
-- decision 1); the caller returns crm__phone_matches. A retry of a successful link or creation returns at the first
-- branch (the lead is linked by then).
CREATE OR REPLACE FUNCTION public.crm__ensure_patient(
  p_clinic uuid,
  l public.leads,
  p_patient_id uuid,
  p_new_patient_id uuid,
  p_patient jsonb,
  OUT o_patient_id uuid,
  OUT o_created boolean
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_obj jsonb := coalesce(p_patient, '{}'::jsonb);
  v_clinic uuid;
  v_name text;
  v_phone text;
  v_email text;
  v_consent boolean;
  v_label text;
BEGIN
  o_created := false;
  IF l.patient_id IS NOT NULL THEN
    IF p_patient_id IS NULL OR p_patient_id = l.patient_id THEN
      o_patient_id := l.patient_id;
      RETURN;
    END IF;
    PERFORM public.crm__raise('E_PATIENT_LINKED');
  END IF;

  -- Link: an active patient of the clinic only (rules R22); a deactivated patient reads as not found.
  IF p_patient_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.patients p
                   WHERE p.id = p_patient_id AND p.clinic_id = p_clinic AND p.is_active IS NOT FALSE) THEN
      PERFORM public.crm__raise('E_PATIENT_NOT_FOUND');
    END IF;
    o_patient_id := p_patient_id;
  ELSE
    IF p_new_patient_id IS NULL THEN
      PERFORM public.crm__raise('E_FIELDS', 'new_patient_id');
    END IF;
    -- Create: the new id must be unused, whatever its clinic. A real retry never gets here (the lead is already
    -- linked, handled above), so an existing id would be a second, unchecked link path.
    SELECT p.clinic_id INTO v_clinic FROM public.patients p WHERE p.id = p_new_patient_id;
    IF FOUND THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    ELSE
      IF jsonb_typeof(v_obj) <> 'object' THEN
        PERFORM public.crm__raise('E_FIELDS', 'patient');
      END IF;
      v_name := btrim(coalesce(nullif(btrim(public.crm__j_text(v_obj, 'full_name')), ''), l.full_name));
      IF char_length(v_name) NOT BETWEEN 2 AND 200 THEN
        PERFORM public.crm__raise('E_NAME');
      END IF;
      v_phone := btrim(coalesce(nullif(btrim(public.crm__j_text(v_obj, 'phone')), ''), l.phone));
      IF char_length(v_phone) > 200 OR length(public.crm__normalize_phone(v_phone)) < 7 THEN
        PERFORM public.crm__raise('E_PHONE');
      END IF;
      v_email := nullif(btrim(coalesce(public.crm__j_text(v_obj, 'email'), l.email, '')), '');
      IF char_length(coalesce(v_email, '')) > 200 THEN
        PERFORM public.crm__raise('E_FIELDS', 'email');
      END IF;
      v_consent := coalesce(public.crm__j_bool(v_obj, 'kvkk_consent'), false);
      PERFORM public.crm__short(public.crm__j_text(v_obj, 'address'), 'address', 500);
      PERFORM public.crm__short(public.crm__j_text(v_obj, 'notes'), 'notes', 5000);

      -- gender (patient_gender) and birth_date are converted to the live column types by jsonb_populate_record.
      BEGIN
        INSERT INTO public.patients (id, clinic_id, full_name, phone, email, gender, birth_date, address, notes,
                                     kvkk_consent, consent_date, is_active)
        SELECT p_new_patient_id, p_clinic, v_name, v_phone, v_email, x.gender, x.birth_date,
               nullif(btrim(x.address), ''), nullif(btrim(x.notes), ''), v_consent,
               CASE WHEN v_consent THEN now() END, true
        FROM jsonb_populate_record(NULL::public.patients, jsonb_build_object(
               'gender', nullif(v_obj -> 'gender', '""'::jsonb),
               'birth_date', nullif(v_obj -> 'birth_date', '""'::jsonb),
               'address', v_obj -> 'address',
               'notes', v_obj -> 'notes')) AS x;
      EXCEPTION WHEN data_exception THEN
        PERFORM public.crm__raise('E_FIELDS', 'patient');
      END;
      o_patient_id := p_new_patient_id;
      o_created := true;
    END IF;
  END IF;

  UPDATE public.leads
  SET patient_id = o_patient_id,
      converted_at = coalesce(converted_at, now())
  WHERE id = l.id AND clinic_id = p_clinic;

  SELECT p.full_name INTO v_label FROM public.patients p WHERE p.id = o_patient_id;
  PERFORM public.crm__log(p_clinic, l.id, 'update',
    CASE WHEN o_created THEN 'Hasta kaydı oluşturuldu: ' ELSE 'Mevcut hasta kaydına bağlandı: ' END
    || coalesce(v_label, ''));
END;
$$;

-- WF:15-17 field diff of a lead card as one 'update' history text ('Etiket: yeni değer · ...'), NULL when nothing
-- moved. NULL and '' count as equal; an empty new value reads 'Kaldırıldı'. Stage is not here (the leads AFTER
-- trigger writes it, WF:18); the quote has its own row (WF:19).
CREATE OR REPLACE FUNCTION public.crm__lead_diff_text(o public.leads, n public.leads)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v text[] := '{}'::text[];
BEGIN
  IF coalesce(o.full_name, '') <> coalesce(n.full_name, '') THEN
    v := v || ('Ad soyad: ' || coalesce(nullif(n.full_name, ''), 'Kaldırıldı'));
  END IF;
  IF coalesce(o.phone, '') <> coalesce(n.phone, '') THEN
    v := v || ('Telefon: ' || coalesce(nullif(n.phone, ''), 'Kaldırıldı'));
  END IF;
  IF coalesce(o.source, '') <> coalesce(n.source, '') THEN
    v := v || ('Başvuru kaynağı: ' || coalesce(public.crm__source_label(nullif(n.source, '')), 'Kaldırıldı'));
  END IF;
  IF coalesce(o.referrer, '') <> coalesce(n.referrer, '') THEN
    v := v || ('Referans olan kişi: ' || coalesce(nullif(n.referrer, ''), 'Kaldırıldı'));
  END IF;
  IF coalesce(o.campaign, '') <> coalesce(n.campaign, '') THEN
    v := v || ('Kampanya: ' || coalesce(nullif(n.campaign, ''), 'Kaldırıldı'));
  END IF;
  IF coalesce(o.treatment_interest, '') <> coalesce(n.treatment_interest, '') THEN
    v := v || ('Tedavi: ' || coalesce(nullif(n.treatment_interest, ''), 'Kaldırıldı'));
  END IF;
  IF o.assigned_to IS DISTINCT FROM n.assigned_to THEN
    v := v || ('Sorumlu: ' || coalesce(public.crm__user_name(n.clinic_id, n.assigned_to), 'Kaldırıldı'));
  END IF;
  IF o.followup_date IS DISTINCT FROM n.followup_date THEN
    v := v || ('Takip tarihi: ' || coalesce(public.crm__fmt_date(n.followup_date), 'Kaldırıldı'));
  END IF;
  IF o.followup_state IS DISTINCT FROM n.followup_state THEN
    v := v || ('Takip durumu: ' || coalesce(public.crm__followup_state_label(n.followup_state), 'Kaldırıldı'));
  END IF;
  IF coalesce(o.next_action, '') <> coalesce(n.next_action, '') THEN
    v := v || ('Sonraki adım: ' || coalesce(nullif(n.next_action, ''), 'Kaldırıldı'));
  END IF;
  IF o.interest IS DISTINCT FROM n.interest THEN
    v := v || ('İlgi durumu: ' || coalesce(public.crm__interest_label(n.interest), 'Kaldırıldı'));
  END IF;
  IF o.contact_result IS DISTINCT FROM n.contact_result THEN
    v := v || ('Görüşme sonucu: ' || coalesce(public.crm__result_label(n.contact_result), 'Kaldırıldı'));
  END IF;
  IF o.loss_reason IS DISTINCT FROM n.loss_reason THEN
    v := v || ('Olumsuz sonuç nedeni: ' || coalesce(public.crm__loss_label(n.loss_reason), 'Kaldırıldı'));
  END IF;
  IF o.do_not_contact IS DISTINCT FROM n.do_not_contact THEN
    v := v || ('Telefonla aranmama tercihi: ' || CASE WHEN n.do_not_contact THEN 'Evet' ELSE 'Hayır' END);
  END IF;
  IF cardinality(v) = 0 THEN
    RETURN NULL;
  END IF;
  RETURN array_to_string(v, ' · ');
END;
$$;

-- ---------------------------------------------------------------------------
-- JSON shapes (contract §3.2). NULL when the row is not in the clinic.
-- ---------------------------------------------------------------------------

-- An appointment's reminder outcome is current iff it was given for the present start time and doctor.
CREATE OR REPLACE FUNCTION public.crm__reminder_current(
  p_status text, p_outcome text, p_reminder_start timestamptz, p_start timestamptz, p_reminder_doctor uuid, p_doctor uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_outcome IS NOT NULL AND p_status = 'scheduled' AND p_reminder_start = p_start
                  AND p_reminder_doctor IS NOT DISTINCT FROM p_doctor, false)
$$;

CREATE OR REPLACE FUNCTION public.crm__lead_json(p_clinic uuid, p_lead_id uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
      'id', l.id,
      'version', l.version,
      'full_name', l.full_name,
      'phone', l.phone,
      'phone_normalized', l.phone_normalized,
      'email', l.email,
      'address', l.address,
      'source', l.source,
      'referrer', l.referrer,
      'campaign', l.campaign,
      'treatment_interest', l.treatment_interest,
      'assigned_to', l.assigned_to,
      'assigned_name', ua.full_name,
      'stage', l.stage,
      'stage_entered_at', l.stage_entered_at,
      'status', l.status,
      'interest', l.interest,
      'contact_result', l.contact_result,
      'loss_reason', l.loss_reason,
      'followup_date', l.followup_date,
      'followup_state', l.followup_state,
      'next_action', l.next_action,
      'do_not_contact', l.do_not_contact,
      'automation_review', l.automation_review
    ) || jsonb_build_object(
      'treatment_closed_at', l.treatment_closed_at,
      'treatment_closed_by_name', public.crm__user_name(p_clinic, l.treatment_closed_by),
      'patient_id', l.patient_id,
      'patient_name', pt.full_name,
      'converted_at', l.converted_at,
      'quote_amount_cents', l.quote_amount_cents,
      'quote_currency', l.quote_currency,
      'notes_legacy', l.notes,
      'created_at', l.created_at,
      'updated_at', l.updated_at,
      'deleted_at', l.deleted_at,
      'deleted_by_name', public.crm__user_name(p_clinic, l.deleted_by),
      'is_open', public.crm__is_open(l.stage, l.do_not_contact, l.followup_state),
      'missing_plan', public.crm__is_open(l.stage, l.do_not_contact, l.followup_state)
                      AND NOT public.crm__visit_upcoming(p_clinic, l.id, l.patient_id, p_today)
                      AND (l.followup_date IS NULL OR btrim(l.next_action) = '')
                      AND NOT public.crm__call_upcoming(p_clinic, l.id, p_today),
      'next_call', (
        SELECT jsonb_build_object('id', c.id, 'date', c.scheduled_date, 'time', public.crm__fmt_time(c.scheduled_time),
                                  'caller_user_id', c.caller_user_id,
                                  'caller_name', coalesce(u.full_name, c.caller_name_legacy), 'origin', c.origin)
        FROM public.crm_calls c
        LEFT JOIN public.users u ON u.id = c.caller_user_id AND u.clinic_id = c.clinic_id
        WHERE c.clinic_id = p_clinic AND c.lead_id = l.id AND c.status = 'planned'
        ORDER BY c.scheduled_date, c.scheduled_time, c.id
        LIMIT 1
      ),
      'upcoming_appointment', (
        SELECT jsonb_build_object('id', a.id, 'start_time', a.start_time, 'end_time', a.end_time,
                                  'doctor_name', public.crm__doctor_name(p_clinic, a.doctor_id), 'chair_name', ch.name,
                                  'reminder_outcome', a.reminder_outcome,
                                  'reminder_current', public.crm__reminder_current(a.status::text, a.reminder_outcome,
                                    a.reminder_start_time, a.start_time, a.reminder_doctor_id, a.doctor_id))
        FROM public.appointments a
        LEFT JOIN public.chairs ch ON ch.id = a.chair_id AND ch.clinic_id = a.clinic_id
        WHERE a.clinic_id = p_clinic AND a.status = 'scheduled'
          AND (a.patient_id = l.patient_id OR a.lead_id = l.id)
          AND (a.start_time AT TIME ZONE 'Europe/Istanbul')::date >= p_today
        ORDER BY a.start_time, a.id
        LIMIT 1
      ),
      'open_handoff', (
        SELECT jsonb_build_object('id', h.id, 'status', h.status, 'topic', h.topic,
                                  'answer_due_date', h.answer_due_date)
        FROM public.crm_handoffs h
        WHERE h.clinic_id = p_clinic AND h.lead_id = l.id AND h.status IN ('waiting', 'answered')
        LIMIT 1
      )
    )
  FROM public.leads l
  LEFT JOIN public.users ua ON ua.id = l.assigned_to AND ua.clinic_id = l.clinic_id
  LEFT JOIN public.patients pt ON pt.id = l.patient_id AND pt.clinic_id = l.clinic_id
  WHERE l.id = p_lead_id AND l.clinic_id = p_clinic
$$;

CREATE OR REPLACE FUNCTION public.crm__call_json(p_clinic uuid, p_call_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', c.id,
    'version', c.version,
    'lead_id', c.lead_id,
    'lead_name', l.full_name,
    'caller_user_id', c.caller_user_id,
    'caller_name', coalesce(u.full_name, c.caller_name_legacy),
    'date', c.scheduled_date,
    'time', public.crm__fmt_time(c.scheduled_time),
    'status', c.status,
    'origin', c.origin,
    'decision', c.decision,
    'contact_result', c.contact_result,
    -- The resolution note is also the call's 'note' history row; crm_correct_note edits that row (the call row is
    -- frozen), so the corrected text wins here and every read path shows the same note (NE:3-16).
    'note', coalesce(cn.description, c.note),
    'note_edited', cn.edited_at IS NOT NULL,
    'auto_cancelled', c.auto_cancelled,
    'cancel_reason', c.cancel_reason,
    'resolved_at', c.resolved_at,
    'resolved_by_name', public.crm__user_name(p_clinic, c.resolved_by),
    'next_call_id', c.next_call_id,
    'appointment_id', c.appointment_id,
    'created_at', c.created_at
  )
  FROM public.crm_calls c
  JOIN public.leads l ON l.id = c.lead_id
  LEFT JOIN public.users u ON u.id = c.caller_user_id AND u.clinic_id = c.clinic_id
  LEFT JOIN LATERAL (
    SELECT a.description, a.edited_at
    FROM public.lead_activities a
    WHERE a.call_id = c.id AND a.clinic_id = c.clinic_id AND a.activity_type = 'note' AND NOT a.is_private
    ORDER BY a.created_at, a.seq
    LIMIT 1
  ) cn ON c.note IS NOT NULL
  WHERE c.id = p_call_id AND c.clinic_id = p_clinic
$$;

CREATE OR REPLACE FUNCTION public.crm__activity_json(a public.lead_activities, p_can_manage boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', (a).id,
    'seq', (a).seq,
    'type', (a).activity_type,
    'text', (a).description,
    'is_private', (a).is_private,
    'schedule_change', (a).schedule_change,
    'call_id', (a).call_id,
    'appointment_id', (a).appointment_id,
    'edited_from', (a).edited_from,
    'edited_at', (a).edited_at,
    'edited_by_name', public.crm__user_name((a).clinic_id, (a).edited_by),
    'actor_name', coalesce(public.crm__user_name((a).clinic_id, (a).created_by), (a).actor_name),
    'created_at', (a).created_at,
    'version', (a).version,
    'editable', (a).activity_type IN ('note', 'legacy') AND (NOT (a).is_private OR coalesce(p_can_manage, false))
  )
$$;

-- HandoffJson: the private_note key is present only for CRM managers (AC:23, HO:22-25).
CREATE OR REPLACE FUNCTION public.crm__handoff_json(p_clinic uuid, p_id uuid, p_can_manage boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
      'id', h.id,
      'version', h.version,
      'lead_id', h.lead_id,
      'lead_name', l.full_name,
      'topic', h.topic,
      'question', h.question,
      'status', h.status,
      'requested_by_name', coalesce(public.crm__user_name(p_clinic, h.requested_by), h.requested_by_name_legacy),
      'requested_at', h.requested_at,
      'answer_text', h.answer_text,
      'answer_due_date', h.answer_due_date,
      'answer_assignee_user_id', h.answer_assignee_user_id,
      'answer_assignee_name', public.crm__user_name(p_clinic, h.answer_assignee_user_id),
      'answered_by_name', coalesce(public.crm__user_name(p_clinic, h.answered_by), h.answered_by_name_legacy),
      'answered_at', h.answered_at,
      'completion_text', h.completion_text,
      'completed_by_name', coalesce(public.crm__user_name(p_clinic, h.completed_by), h.completed_by_name_legacy),
      'completed_at', h.completed_at,
      'system_closed', h.system_closed
    ) || CASE WHEN coalesce(p_can_manage, false) THEN jsonb_build_object('private_note',
           (SELECT pn.note FROM public.crm_handoff_private_notes pn WHERE pn.handoff_id = h.id AND pn.clinic_id = p_clinic))
         ELSE '{}'::jsonb END
  FROM public.crm_handoffs h
  JOIN public.leads l ON l.id = h.lead_id
  WHERE h.id = p_id AND h.clinic_id = p_clinic
$$;

-- TaskJson (TMU:19 display_status).
CREATE OR REPLACE FUNCTION public.crm__task_json(p_clinic uuid, p_id uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', t.id,
    'version', t.version,
    'title', t.title,
    'detail', t.detail,
    'due_date', t.due_date,
    'lead_id', t.lead_id,
    'lead_name', CASE WHEN l.deleted_at IS NULL THEN l.full_name END,
    'lead_visible', t.lead_id IS NOT NULL AND l.id IS NOT NULL AND l.deleted_at IS NULL,
    'patient_id', t.patient_id,
    'patient_name', p.full_name,
    'assignee_user_id', t.assignee_user_id,
    'assignee_name', public.crm__user_name(p_clinic, t.assignee_user_id),
    'created_by', t.created_by,
    'created_by_name', coalesce(public.crm__user_name(p_clinic, t.created_by), t.created_by_name_legacy),
    'status', t.status,
    'read_at', t.read_at,
    'completed_at', t.completed_at,
    'completed_by_name', public.crm__user_name(p_clinic, t.completed_by),
    'result', t.result,
    'cancelled_at', t.cancelled_at,
    'display_status', CASE
      WHEN t.status = 'done' THEN 'done'
      WHEN t.status = 'cancelled' THEN 'cancelled'
      WHEN t.due_date < p_today THEN 'overdue'
      WHEN t.read_at IS NULL THEN 'new'
      ELSE 'open'
    END
  )
  FROM public.staff_tasks t
  LEFT JOIN public.leads l ON l.id = t.lead_id AND l.clinic_id = t.clinic_id
  LEFT JOIN public.patients p ON p.id = t.patient_id AND p.clinic_id = t.clinic_id
  WHERE t.id = p_id AND t.clinic_id = p_clinic
$$;

CREATE OR REPLACE FUNCTION public.crm__ad_spend_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', s.id,
    'version', s.version,
    'source', s.source,
    'month', to_char(s.month, 'YYYY-MM'),
    'amount_cents', s.amount_cents,
    'currency', s.currency,
    'note', s.note,
    'updated_at', s.updated_at,
    'updated_by_name', public.crm__user_name(p_clinic, s.updated_by)
  )
  FROM public.crm_ad_spend s
  WHERE s.id = p_id AND s.clinic_id = p_clinic
$$;

-- ---------------------------------------------------------------------------
-- §3.4 Work items: port of workList (TK:17-44), workBuckets (DW:11-24) and missingPlan (TK:45). Derived on every
--      read, nothing stored. Callers order by priority, due_date NULLS FIRST, due_time NULLS FIRST,
--      sort_name COLLATE "tr-x-icu", item_key (TK:43, DW:22).
--      Lead universe: not trashed, stage <> treatment_completed (TK:20, DW:16). Rows 1-6 may give several items
--      per lead; rows 8-12 give at most one lead-level item (first match, TK:35-41). Reminder rows cover every
--      scheduled appointment of an active patient (owner decision: reminders are an appointment duty).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm__work_items(p_clinic uuid, p_today date, p_now_local timestamp)
RETURNS SETOF public.crm_work_item
LANGUAGE sql
STABLE
AS $$
  WITH appt AS MATERIALIZED (
    SELECT a.id, a.patient_id, a.lead_id, a.doctor_id, a.start_time,
           (a.start_time AT TIME ZONE 'Europe/Istanbul') AS local_start,
           a.reminder_outcome,
           public.crm__reminder_current(a.status::text, a.reminder_outcome, a.reminder_start_time, a.start_time,
                                        a.reminder_doctor_id, a.doctor_id) AS reminder_current
    FROM public.appointments a
    WHERE a.clinic_id = p_clinic AND a.status = 'scheduled'
  ),
  pc AS MATERIALIZED (
    SELECT c.id, c.lead_id, c.scheduled_date, c.scheduled_time, c.caller_user_id
    FROM public.crm_calls c
    WHERE c.clinic_id = p_clinic AND c.status = 'planned'
  ),
  ld AS MATERIALIZED (
    SELECT l.id, l.full_name, l.patient_id, l.stage, l.assigned_to, l.followup_date, l.next_action,
           l.do_not_contact, l.automation_review, l.created_at,
           public.crm__is_open(l.stage, l.do_not_contact, l.followup_state) AS is_open,
           EXISTS (SELECT 1 FROM appt a WHERE a.patient_id = l.patient_id OR a.lead_id = l.id) AS visit_any,
           EXISTS (SELECT 1 FROM appt a
                   WHERE (a.patient_id = l.patient_id OR a.lead_id = l.id) AND a.local_start::date >= p_today)
             AS visit_upcoming,
           EXISTS (SELECT 1 FROM pc WHERE pc.lead_id = l.id AND pc.scheduled_date >= p_today) AS call_upcoming,
           EXISTS (SELECT 1 FROM pc WHERE pc.lead_id = l.id AND pc.scheduled_date = p_today) AS call_today,
           EXISTS (SELECT 1 FROM public.crm_calls c
                   WHERE c.clinic_id = p_clinic AND c.lead_id = l.id AND c.status = 'reached') AS ever_reached,
           lc.status AS last_status,
           lc.scheduled_date AS last_date,
           lc.scheduled_time AS last_time
    FROM public.leads l
    LEFT JOIN LATERAL (
      SELECT c.status, c.scheduled_date, c.scheduled_time
      FROM public.crm_calls c
      WHERE c.clinic_id = p_clinic AND c.lead_id = l.id
      ORDER BY c.scheduled_date DESC, c.scheduled_time DESC, c.id DESC
      LIMIT 1
    ) lc ON true
    WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL AND l.stage <> 'treatment_completed'
  ),
  lm AS MATERIALIZED (
    SELECT ld.*,
           (ld.visit_upcoming OR ld.call_upcoming) AS upcoming,
           -- WL:11 quick-call eligibility of the lead.
           (ld.is_open AND NOT ld.do_not_contact AND ld.automation_review IS NULL AND NOT ld.visit_any) AS quick_ok,
           -- TK:33-34: latest call unreachable, nothing upcoming, no future follow-up, no (non-private) note after
           -- the call's planned instant.
           coalesce(ld.last_status = 'unreachable'
             AND ld.last_date <= p_today
             AND NOT (ld.visit_upcoming OR ld.call_upcoming)
             AND NOT coalesce(ld.followup_date > p_today, false)
             AND NOT EXISTS (
               SELECT 1 FROM public.lead_activities n
               WHERE n.lead_id = ld.id AND n.clinic_id = p_clinic AND n.activity_type = 'note' AND NOT n.is_private
                 AND n.created_at > ((ld.last_date + ld.last_time) AT TIME ZONE 'Europe/Istanbul')
             ), false) AS missed
    FROM ld
  ),
  li AS (
    SELECT lm.*,
           CASE
             WHEN lm.followup_date < p_today THEN 'followup_overdue'
             WHEN lm.missed THEN 'unreachable'
             WHEN lm.followup_date = p_today AND NOT lm.call_today THEN 'followup_today'
             WHEN lm.stage = 'new' AND NOT lm.ever_reached AND NOT lm.upcoming
                  AND (lm.followup_date IS NULL OR lm.followup_date <= p_today) THEN 'first_contact'
             WHEN NOT lm.visit_any AND NOT lm.upcoming
                  AND (lm.followup_date IS NULL OR btrim(lm.next_action) = '') THEN 'missing_step'
           END AS kind
    FROM lm
    WHERE lm.is_open AND lm.automation_review IS NULL
  ),
  clinic_rows AS (
    SELECT DISTINCT ON (a.id)
           a.id AS appointment_id, a.local_start, a.patient_id, lm.id AS lead_id, lm.assigned_to, lm.full_name
    FROM appt a
    JOIN lm ON (lm.patient_id = a.patient_id OR a.lead_id = lm.id)
    WHERE a.local_start::date <= p_today
    ORDER BY a.id, lm.created_at DESC, lm.id
  )
  -- 1. Manager answers due today or overdue (TK:22).
  SELECT ('handoff:' || h.id)::text, 'daily'::text,
         (CASE WHEN h.answer_due_date < p_today THEN 1 ELSE 2 END)::smallint,
         'handoff'::text, 'Yönetici yanıtı · Yapılacak iş'::text, h.answer_text::text,
         h.answer_due_date::date, NULL::time,
         lm.id::uuid, lm.patient_id::uuid, NULL::uuid, h.id::uuid, NULL::uuid, NULL::uuid,
         coalesce(h.answer_assignee_user_id, lm.assigned_to)::uuid, lm.full_name::text, false
  FROM public.crm_handoffs h
  JOIN lm ON lm.id = h.lead_id
  WHERE h.clinic_id = p_clinic AND h.status = 'answered' AND lm.stage <> 'archived'
    AND h.answer_due_date <= p_today

  UNION ALL
  -- 2. Appointment reminders the day before and on the day (TK:23, CRe:9-12).
  SELECT ('reminder:' || a.id)::text, 'daily'::text,
         (CASE WHEN a.local_start::date = p_today THEN 1 ELSE 2 END)::smallint,
         'reminder'::text,
         (CASE
            WHEN a.local_start::date = p_today THEN 'Bugünkü klinik randevusu için hatırlatma eksik'
            WHEN a.reminder_outcome = 'unreachable' AND a.reminder_current THEN 'Randevu hatırlatmasında ulaşılamadı'
            ELSE 'Yarınki klinik randevusunu hatırlat'
          END)::text,
         ('Hastaya ' || public.crm__fmt_day_month(a.local_start::date) || ' saat ' || to_char(a.local_start, 'HH24:MI')
          || ' · ' || coalesce(public.crm__doctor_name(p_clinic, a.doctor_id), 'hekim')
          || ' randevusunu hatırlat ve sonucu kaydet')::text,
         (a.local_start::date - 1)::date, a.local_start::time,
         (SELECT l.id FROM public.leads l
          WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL AND (l.id = a.lead_id OR l.patient_id = a.patient_id)
          ORDER BY (l.id = a.lead_id) DESC NULLS LAST, l.created_at DESC, l.id
          LIMIT 1)::uuid,
         a.patient_id::uuid, NULL::uuid, NULL::uuid, a.id::uuid, NULL::uuid, NULL::uuid,
         p.full_name::text, false
  FROM appt a
  JOIN public.patients p ON p.id = a.patient_id AND p.clinic_id = p_clinic
  WHERE p.is_active IS NOT FALSE
    AND a.local_start::date BETWEEN p_today AND p_today + 1
    AND NOT coalesce(a.reminder_outcome = 'reminded' AND a.reminder_current, false)

  UNION ALL
  -- 3-4. Clinic appointments of a lead that are past without a result, or today (TK:25).
  SELECT ('clinic:' || cr.appointment_id)::text, 'daily'::text,
         (CASE WHEN cr.local_start::date < p_today THEN 0 ELSE 2 END)::smallint,
         (CASE WHEN cr.local_start::date < p_today THEN 'clinic_result' ELSE 'clinic_today' END)::text,
         (CASE WHEN cr.local_start::date < p_today THEN 'Klinik randevusunun sonucu eksik'
               ELSE 'Bugünkü klinik randevusu' END)::text,
         'Randevu ekranında kliniğe geliş sonucunu kaydet'::text,
         cr.local_start::date, cr.local_start::time,
         cr.lead_id::uuid, cr.patient_id::uuid, NULL::uuid, NULL::uuid, cr.appointment_id::uuid, NULL::uuid,
         cr.assigned_to::uuid, cr.full_name::text, false
  FROM clinic_rows cr

  UNION ALL
  -- 5-6 and 15. Planned calls: overdue, today, future (TK:28-29, DW:18-19). Lost / archived leads keep theirs
  -- (manual calls are not auto-cancelled there, D-AF:8), so someone must resolve them.
  SELECT ('call:' || pc.id)::text,
         (CASE WHEN pc.scheduled_date > p_today THEN 'future' ELSE 'daily' END)::text,
         (CASE WHEN pc.scheduled_date < p_today THEN 0 WHEN pc.scheduled_date = p_today THEN 2 ELSE 4 END)::smallint,
         (CASE WHEN pc.scheduled_date < p_today THEN 'call_overdue'
               WHEN pc.scheduled_date = p_today THEN 'call_today' ELSE 'future_call' END)::text,
         (CASE WHEN pc.scheduled_date < p_today THEN 'Geçmiş aramanın sonucu eksik'
               WHEN pc.scheduled_date = p_today THEN 'Bugün aranacak' ELSE 'Planlı arama' END)::text,
         (CASE WHEN pc.scheduled_date < p_today THEN 'Görüşüldü, ulaşılamadı veya iptal sonucunu kaydet'
               WHEN pc.scheduled_date = p_today THEN 'Hastayı ara ve görüşme sonucunu kaydet'
               ELSE 'Arama planını aç veya sonucunu kaydet' END)::text,
         pc.scheduled_date::date, pc.scheduled_time::time,
         lm.id::uuid, lm.patient_id::uuid, pc.id::uuid, NULL::uuid, NULL::uuid, pc.caller_user_id::uuid,
         lm.assigned_to::uuid, lm.full_name::text, lm.quick_ok
  FROM pc
  JOIN lm ON lm.id = pc.lead_id

  UNION ALL
  -- 7. Follow-up decision needed (TK:31); rows 8-12 are skipped for this lead.
  SELECT ('review:' || lm.id)::text, 'daily'::text, 1::smallint, 'review'::text, 'Takip kararı gerekiyor'::text,
         lm.automation_review::text, NULL::date, NULL::time,
         lm.id::uuid, lm.patient_id::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
         lm.assigned_to::uuid, lm.full_name::text, false
  FROM lm
  WHERE lm.is_open AND lm.automation_review IS NOT NULL

  UNION ALL
  -- 8-12. One lead-level item (TK:35-41). Due date and default action as TK:41.
  SELECT ('lead:' || li.id)::text, 'daily'::text,
         (CASE li.kind WHEN 'followup_overdue' THEN 1 WHEN 'unreachable' THEN 1 WHEN 'missing_step' THEN 3
                       ELSE 2 END)::smallint,
         li.kind::text,
         (CASE li.kind
            WHEN 'followup_overdue' THEN 'Görüşme tarihi geçti'
            WHEN 'unreachable' THEN 'Aramada ulaşılamadı'
            WHEN 'followup_today' THEN 'Bugün görüşülecek'
            WHEN 'first_contact' THEN 'Yeni başvuru · ilk görüşme'
            ELSE 'Sonraki adım veya tarih eksik'
          END)::text,
         coalesce(nullif(btrim(li.next_action), ''),
                  CASE
                    WHEN li.missed THEN 'Hastayı tekrar ara ve sonraki adımı planla'
                    WHEN li.stage = 'offer_given' THEN 'Teklif sonucunu görüş ve takip planla'
                    WHEN li.stage = 'appointment_attended' THEN 'Görüşme sonucunu ve sonraki adımı kaydet'
                    ELSE 'Hastayla görüş; sonraki adımı ve tarihi belirle'
                  END)::text,
         (CASE
            WHEN li.kind = 'unreachable' THEN li.last_date
            WHEN li.followup_date IS NOT NULL THEN li.followup_date
            WHEN li.kind = 'missing_step' THEN NULL
            ELSE (li.created_at AT TIME ZONE 'Europe/Istanbul')::date
          END)::date,
         NULL::time,
         li.id::uuid, li.patient_id::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
         li.assigned_to::uuid, li.full_name::text, li.quick_ok
  FROM li
  WHERE li.kind IS NOT NULL

  UNION ALL
  -- 13. 'Takip planı eksik' bucket, one row per lead (DW:13, TK:45).
  SELECT ('missing:' || lm.id)::text, 'missing'::text, 3::smallint, 'missing_plan'::text, 'Takip planı eksik'::text,
         'Hasta kartında sonraki adımı ve tarihi birlikte belirle'::text, lm.followup_date::date, NULL::time,
         lm.id::uuid, lm.patient_id::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
         lm.assigned_to::uuid, lm.full_name::text, lm.quick_ok
  FROM lm
  WHERE lm.is_open AND NOT lm.visit_upcoming AND NOT lm.call_upcoming
    AND (lm.followup_date IS NULL OR btrim(lm.next_action) = '')

  UNION ALL
  -- 14. Manager answers due later (DW:17).
  SELECT ('handoff:' || h.id)::text, 'future'::text, 4::smallint, 'future_handoff'::text,
         'Yönetici yanıtı · İleri tarihli görev'::text, h.answer_text::text, h.answer_due_date::date, NULL::time,
         lm.id::uuid, lm.patient_id::uuid, NULL::uuid, h.id::uuid, NULL::uuid, NULL::uuid,
         coalesce(h.answer_assignee_user_id, lm.assigned_to)::uuid, lm.full_name::text, false
  FROM public.crm_handoffs h
  JOIN lm ON lm.id = h.lead_id
  WHERE h.clinic_id = p_clinic AND h.status = 'answered' AND lm.stage <> 'archived'
    AND h.answer_due_date > p_today

  UNION ALL
  -- 16. Future follow-up date without a planned call on that day (DW:20).
  SELECT ('future:' || lm.id)::text, 'future'::text, 4::smallint, 'future_followup'::text,
         'İleri tarihli takip'::text, coalesce(nullif(btrim(lm.next_action), ''), 'Sonraki adımı belirle')::text,
         lm.followup_date::date, NULL::time,
         lm.id::uuid, lm.patient_id::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
         lm.assigned_to::uuid, lm.full_name::text, lm.quick_ok
  FROM lm
  WHERE lm.is_open AND lm.followup_date > p_today
    AND NOT EXISTS (SELECT 1 FROM pc WHERE pc.lead_id = lm.id AND pc.scheduled_date = lm.followup_date)
$$;

-- WorkItemJson rows for a set of work items (crm_work_list, crm_overdue_list).
CREATE OR REPLACE FUNCTION public.crm__work_item_json(p_clinic uuid, w public.crm_work_item)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'key', (w).item_key,
    'type', (w).item_type,
    'bucket', (w).bucket,
    'priority', (w).priority,
    'reason', (w).reason,
    'action', (w).action,
    'due_date', (w).due_date,
    'due_time', public.crm__fmt_time((w).due_time),
    'lead', (SELECT jsonb_build_object('id', l.id, 'version', l.version, 'full_name', l.full_name, 'phone', l.phone,
                                       'interest', l.interest, 'stage', l.stage,
                                       'assigned_name', public.crm__user_name(p_clinic, l.assigned_to))
             FROM public.leads l WHERE l.id = (w).lead_id AND l.clinic_id = p_clinic),
    'patient', (SELECT jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone)
                FROM public.patients p WHERE p.id = (w).patient_id AND p.clinic_id = p_clinic
                  AND (w).item_type = 'reminder'),
    'call', (SELECT jsonb_build_object('id', c.id, 'version', c.version, 'caller_user_id', c.caller_user_id,
                                       'caller_name', coalesce(public.crm__user_name(p_clinic, c.caller_user_id), c.caller_name_legacy))
             FROM public.crm_calls c WHERE c.id = (w).call_id AND c.clinic_id = p_clinic),
    'handoff_id', (w).handoff_id,
    'appointment', (SELECT jsonb_build_object('id', a.id, 'start_time', a.start_time, 'doctor_id', a.doctor_id,
                                              'doctor_name', public.crm__doctor_name(p_clinic, a.doctor_id),
                                              'reminder_outcome', a.reminder_outcome,
                                              'reminder_current', public.crm__reminder_current(a.status::text,
                                                a.reminder_outcome, a.reminder_start_time, a.start_time,
                                                a.reminder_doctor_id, a.doctor_id))
                    FROM public.appointments a WHERE a.id = (w).appointment_id AND a.clinic_id = p_clinic),
    'quick_call', (w).quick_call
  )
$$;

-- §5.5 per-lead insight flags (FI:17-26) for the open population; used by crm_followup_insights and
-- crm_summary_leads so both use exactly the same predicates.
CREATE OR REPLACE FUNCTION public.crm__insight_flags(p_clinic uuid, p_today date, p_now timestamptz)
RETURNS TABLE (
  lead_id uuid,
  is_review boolean,
  is_waiting boolean,
  is_late_first boolean,
  is_unknown_stage boolean,
  is_stalled boolean,
  is_offer boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH cfg AS (
    SELECT x.r,
           (EXTRACT(EPOCH FROM ((x.r).end_time - (x.r).start_time)) / 60)::integer AS daily
    FROM (SELECT public.crm__rules(p_clinic) AS r) x
  ),
  pop AS (
    SELECT l.id, l.stage, l.stage_entered_at, l.created_at, l.automation_review, l.followup_date,
           public.crm__visit_any(p_clinic, l.id, l.patient_id) AS visit_any,
           NOT EXISTS (SELECT 1 FROM public.crm_calls c
                       WHERE c.clinic_id = p_clinic AND c.lead_id = l.id
                         AND c.status IN ('reached', 'unreachable')) AS waiting
    FROM public.leads l
    WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL
      AND public.crm__is_open(l.stage, l.do_not_contact, l.followup_state)
  ),
  m AS (
    SELECT pop.*, cfg.r, cfg.daily,
           CASE WHEN NOT pop.visit_any AND pop.stage_entered_at IS NOT NULL
                THEN public.crm__working_minutes(pop.stage_entered_at, p_now, cfg.r) END AS stage_minutes
    FROM pop CROSS JOIN cfg
  )
  SELECT m.id,
         m.automation_review IS NOT NULL,
         NOT m.visit_any AND m.waiting,
         NOT m.visit_any AND m.waiting
           AND NOT coalesce(m.followup_date > p_today, false)
           AND NOT EXISTS (
             SELECT 1 FROM public.crm_calls c
             WHERE c.clinic_id = p_clinic AND c.lead_id = m.id AND c.status = 'planned'
               AND (c.scheduled_date + c.scheduled_time) > date_trunc('minute', p_now AT TIME ZONE 'Europe/Istanbul')
           )
           AND coalesce(public.crm__working_minutes(m.created_at, p_now, m.r) >= (m.r).first_call_minutes, false),
         NOT m.visit_any AND m.stage_entered_at IS NULL,
         coalesce(m.stage_minutes >= (m.r).stale_days * m.daily, false),
         m.stage = 'offer_given' AND coalesce(m.stage_minutes >= (m.r).offer_days * m.daily, false)
  FROM m
$$;

-- §5.5 medians (FI:11-16): leads created in [today-29, today]; a lead with an attempted call lacking resolved_at
-- is excluded and counted; median = round(percentile_cont(0.5)) on numeric (= FI:5 with Math.round).
CREATE OR REPLACE FUNCTION public.crm__insight_medians(p_clinic uuid, p_today date, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH cfg AS (SELECT public.crm__rules(p_clinic) AS r),
  s AS (
    SELECT l.id, l.created_at,
           EXISTS (SELECT 1 FROM public.crm_calls c
                   WHERE c.clinic_id = p_clinic AND c.lead_id = l.id
                     AND c.status IN ('reached', 'unreachable') AND c.resolved_at IS NULL) AS legacy,
           (SELECT min(c.resolved_at) FROM public.crm_calls c
             WHERE c.clinic_id = p_clinic AND c.lead_id = l.id AND c.status IN ('reached', 'unreachable')
               AND c.resolved_at BETWEEN l.created_at AND p_now) AS first_at,
           (SELECT min(c.resolved_at) FROM public.crm_calls c
             WHERE c.clinic_id = p_clinic AND c.lead_id = l.id AND c.status = 'reached'
               AND c.resolved_at BETWEEN l.created_at AND p_now) AS reached_at
    FROM public.leads l
    WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL
      AND (l.created_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN p_today - 29 AND p_today
  ),
  m AS (
    SELECT s.legacy,
           CASE WHEN NOT s.legacy THEN public.crm__working_minutes(s.created_at, s.first_at, cfg.r) END AS first_m,
           CASE WHEN NOT s.legacy THEN public.crm__working_minutes(s.created_at, s.reached_at, cfg.r) END AS reached_m
    FROM s CROSS JOIN cfg
  )
  SELECT jsonb_build_object(
    'first_attempt', jsonb_build_object(
      'median_minutes', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY m.first_m))::numeric)::integer,
      'sample', count(m.first_m),
      'excluded_legacy', count(*) FILTER (WHERE m.legacy)),
    'first_reached', jsonb_build_object(
      'median_minutes', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY m.reached_m))::numeric)::integer,
      'sample', count(m.reached_m))
  )
  FROM m
$$;

-- Small envelope helpers.
CREATE OR REPLACE FUNCTION public.crm__no_matches(p_phone text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('normalized', public.crm__normalize_phone(p_phone), 'leads', '[]'::jsonb,
                            'patients', '[]'::jsonb)
$$;

-- ISO 8601 timestamp from JSON; unparsable -> p_err.
CREATE OR REPLACE FUNCTION public.crm__j_ts(p jsonb, p_key text, p_err text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('string', 'null') THEN
    PERFORM public.crm__raise(p_err);
  END IF;
  v := btrim(p ->> p_key);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN v::timestamptz;
  EXCEPTION WHEN data_exception THEN
    PERFORM public.crm__raise(p_err);
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm__appt_brief_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object('id', a.id, 'start_time', a.start_time, 'end_time', a.end_time,
                            'doctor_name', public.crm__doctor_name(p_clinic, a.doctor_id), 'chair_name', ch.name)
  FROM public.appointments a
  LEFT JOIN public.chairs ch ON ch.id = a.chair_id AND ch.clinic_id = a.clinic_id
  WHERE a.id = p_id AND a.clinic_id = p_clinic
$$;

-- ---------------------------------------------------------------------------
-- §4 Write RPCs. Shared shape: plpgsql SECURITY DEFINER SET search_path = public, RETURNS jsonb envelope
--    { already_saved, ... }. Order: permission -> input shape -> lock (lead first, then call / handoff) ->
--    not found -> idempotency replay -> version -> business rules -> writes -> history -> envelope.
-- ---------------------------------------------------------------------------

-- §4.1 Lead card: create (p_version NULL) and edit. Port of RR:29-120, RR:196-201.
CREATE OR REPLACE FUNCTION public.crm_save_lead(
  p_id uuid,
  p_version integer,
  p_lead jsonb,
  p_note text,
  p_schedule_reason text,
  p_initial_call jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_create boolean := p_version IS NULL;
  v_in jsonb := coalesce(p_lead, '{}'::jsonb);
  v_ic jsonb := CASE WHEN jsonb_typeof(p_initial_call) = 'object' THEN p_initial_call END;
  o public.leads;
  n public.leads;
  v_missing text;
  v_existing_clinic uuid;
  v_text text;
  v_uuid uuid;
  v_num bigint;
  v_note text;
  v_reason text;
  v_moved boolean := false;
  v_newly_completed boolean := false;
  v_cancelled uuid[] := '{}'::uuid[];
  v_diff text;
  v_ic_id uuid;
  v_ic_date date;
  v_ic_time time;
  v_ic_caller uuid;
  v_phone_changed boolean;
BEGIN
  IF p_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'id');
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
    PERFORM public.crm__raise('E_FIELDS', 'lead');
  END IF;
  IF p_initial_call IS NOT NULL AND jsonb_typeof(p_initial_call) NOT IN ('object', 'null') THEN
    PERFORM public.crm__raise('E_FIELDS', 'initial_call');
  END IF;

  -- 1. Create idempotency (same id in the clinic -> already_saved; in another clinic -> E_ID_TAKEN) / edit lock.
  IF v_create THEN
    SELECT clinic_id INTO v_existing_clinic FROM public.leads WHERE id = p_id;
    IF FOUND THEN
      IF v_existing_clinic <> v_clinic THEN
        PERFORM public.crm__raise('E_ID_TAKEN');
      END IF;
      RETURN jsonb_build_object(
        'already_saved', true,
        'lead', public.crm__lead_json(v_clinic, p_id, v_today),
        'phone_matches', public.crm__no_matches((SELECT l.phone FROM public.leads l WHERE l.id = p_id)),
        'cancelled_call_ids', '[]'::jsonb,
        'initial_call', public.crm__call_json(v_clinic, public.crm__j_uuid(v_ic, 'id')));
    END IF;
    n.id := p_id;
    n.clinic_id := v_clinic;
    n.stage := 'new';
    n.interest := 'unknown';
    n.contact_result := 'unspecified';
    n.followup_state := 'open';
    n.next_action := '';
    n.do_not_contact := false;
    n.referrer := '';
    n.campaign := '';
    n.treatment_interest := '';
    n.quote_currency := 'TRY';
    n.assigned_to := v_me;   -- replaces the legacy hard-coded default assignee (CRM:81)
  ELSE
    v_missing := public.crm__missing_keys(v_in, ARRAY['full_name', 'phone', 'email', 'address', 'source', 'referrer',
      'campaign', 'treatment_interest', 'assigned_to', 'stage', 'interest', 'contact_result', 'loss_reason',
      'followup_date', 'followup_state', 'next_action', 'do_not_contact', 'quote_amount_cents', 'quote_currency']);
    IF v_missing IS NOT NULL THEN
      PERFORM public.crm__raise('E_FIELDS', v_missing);
    END IF;
    o := public.crm__lead_for_update(v_clinic, p_id);
    IF o.version <> p_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
    n := o;
  END IF;

  -- Field shapes (MO:18). Server-owned keys (stage_entered_at, automation_review, treatment_closed_*, patient_id,
  -- converted_at, deleted_*, version, status, notes) and unknown keys are ignored (RR:43).
  -- Name, phone, e-mail and address are validated on create and when changed only: leads written by the old pages
  -- may hold a short phone or name, and an unrelated edit (a kanban move, a follow-up date) must still save
  -- (same rule as source and assigned_to below). "Unchanged" compares trimmed text.
  IF v_create OR v_in ? 'full_name' THEN
    v_text := btrim(coalesce(public.crm__j_text(v_in, 'full_name'), ''));
    IF (v_create OR v_text IS DISTINCT FROM btrim(coalesce(o.full_name, '')))
       AND char_length(v_text) NOT BETWEEN 2 AND 200 THEN
      PERFORM public.crm__raise('E_NAME');
    END IF;
    n.full_name := CASE WHEN v_text = '' THEN o.full_name ELSE v_text END;
  END IF;
  IF v_create OR v_in ? 'phone' THEN
    v_text := btrim(coalesce(public.crm__j_text(v_in, 'phone'), ''));
    IF (v_create OR v_text IS DISTINCT FROM btrim(coalesce(o.phone, '')))
       AND (char_length(v_text) > 200 OR length(public.crm__normalize_phone(v_text)) < 7) THEN
      PERFORM public.crm__raise('E_PHONE');
    END IF;
    n.phone := CASE WHEN v_text = '' THEN o.phone ELSE v_text END;
  END IF;
  IF v_in ? 'email' THEN
    v_text := btrim(coalesce(public.crm__j_text(v_in, 'email'), ''));
    IF (v_create OR v_text IS DISTINCT FROM btrim(coalesce(o.email, ''))) AND char_length(v_text) > 200 THEN
      PERFORM public.crm__raise('E_FIELDS', 'email');
    END IF;
    n.email := nullif(v_text, '');
  END IF;
  IF v_in ? 'address' THEN
    v_text := btrim(coalesce(public.crm__j_text(v_in, 'address'), ''));
    IF (v_create OR v_text IS DISTINCT FROM btrim(coalesce(o.address, ''))) AND char_length(v_text) > 500 THEN
      PERFORM public.crm__raise('E_FIELDS', 'address');
    END IF;
    n.address := nullif(v_text, '');
  END IF;
  IF v_in ? 'source' THEN
    v_text := nullif(btrim(coalesce(public.crm__j_text(v_in, 'source'), '')), '');
    -- Deprecated / old free-text sources are accepted only when unchanged; new leads cannot pick them.
    IF v_text IS NOT NULL
       AND v_text NOT IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other')
       AND (v_create OR v_text IS DISTINCT FROM o.source) THEN
      PERFORM public.crm__raise('E_FIELDS', 'source');
    END IF;
    n.source := v_text;
  END IF;
  IF v_in ? 'referrer' THEN
    n.referrer := public.crm__short(public.crm__j_text(v_in, 'referrer'), 'referrer');
  END IF;
  IF v_in ? 'campaign' THEN
    n.campaign := public.crm__short(public.crm__j_text(v_in, 'campaign'), 'campaign');
  END IF;
  IF v_in ? 'treatment_interest' THEN
    n.treatment_interest := public.crm__short(public.crm__j_text(v_in, 'treatment_interest'), 'treatment_interest');
  END IF;
  IF v_in ? 'assigned_to' THEN
    v_uuid := public.crm__j_uuid(v_in, 'assigned_to');
    IF v_uuid IS NOT NULL AND (v_create OR v_uuid IS DISTINCT FROM o.assigned_to) THEN
      PERFORM public.crm__active_user(v_clinic, v_uuid, 'E_ASSIGNEE');
    END IF;
    n.assigned_to := v_uuid;
  END IF;
  IF v_in ? 'stage' THEN
    v_text := public.crm__j_text(v_in, 'stage');
    IF v_text IS NULL OR v_text NOT IN ('new', 'in_contact', 'appointment_booked', 'appointment_attended',
        'offer_given', 'treatment_started', 'treatment_completed', 'lost', 'archived') THEN
      PERFORM public.crm__raise('E_FIELDS', 'stage');
    END IF;
    n.stage := v_text;
  END IF;
  IF v_in ? 'interest' THEN
    v_text := public.crm__j_text(v_in, 'interest');
    IF v_text IS NULL OR v_text NOT IN ('hot', 'warm', 'cold', 'unknown') THEN
      PERFORM public.crm__raise('E_FIELDS', 'interest');
    END IF;
    n.interest := v_text;
  END IF;
  IF v_in ? 'contact_result' THEN
    v_text := public.crm__j_text(v_in, 'contact_result');
    IF v_text IS NULL OR v_text NOT IN ('unspecified', 'wants_treatment', 'considering_price', 'considering_timing',
        'will_think_later', 'unreachable', 'call_on_date', 'negative', 'comparing_clinics', 'appointment_confirmed') THEN
      PERFORM public.crm__raise('E_FIELDS', 'contact_result');
    END IF;
    n.contact_result := v_text;
  END IF;
  IF v_in ? 'loss_reason' THEN
    v_text := nullif(public.crm__j_text(v_in, 'loss_reason'), '');
    IF v_text IS NOT NULL AND v_text NOT IN ('price_high', 'timing_unsuitable', 'unreachable', 'chose_other_clinic',
        'postponed', 'not_suitable', 'other') THEN
      PERFORM public.crm__raise('E_FIELDS', 'loss_reason');
    END IF;
    n.loss_reason := v_text;
  END IF;
  IF v_in ? 'followup_date' THEN
    n.followup_date := public.crm__j_date(v_in, 'followup_date');
  END IF;
  IF v_in ? 'followup_state' THEN
    v_text := public.crm__j_text(v_in, 'followup_state');
    IF v_text IS NULL OR v_text NOT IN ('open', 'done') THEN
      PERFORM public.crm__raise('E_FIELDS', 'followup_state');
    END IF;
    n.followup_state := v_text;
  END IF;
  IF v_in ? 'next_action' THEN
    n.next_action := public.crm__short(public.crm__j_text(v_in, 'next_action'), 'next_action');
  END IF;
  IF v_in ? 'do_not_contact' THEN
    n.do_not_contact := public.crm__j_bool(v_in, 'do_not_contact');
    IF n.do_not_contact IS NULL THEN
      PERFORM public.crm__raise('E_FIELDS', 'do_not_contact');
    END IF;
  END IF;
  IF v_in ? 'quote_amount_cents' THEN
    v_num := public.crm__j_bigint(v_in, 'quote_amount_cents');
    IF v_num IS NOT NULL AND v_num NOT BETWEEN 0 AND 1000000000000 THEN
      PERFORM public.crm__raise('E_FIELDS', 'quote_amount_cents');
    END IF;
    n.quote_amount_cents := v_num;
  END IF;
  IF v_in ? 'quote_currency' THEN
    v_text := coalesce(nullif(public.crm__j_text(v_in, 'quote_currency'), ''), 'TRY');
    IF v_text NOT IN ('TRY', 'EUR', 'USD') THEN
      PERFORM public.crm__raise('E_FIELDS', 'quote_currency');
    END IF;
    n.quote_currency := v_text;
  END IF;

  IF p_note IS NOT NULL AND btrim(p_note) <> '' THEN
    v_note := public.crm__note(p_note);
  END IF;

  -- 2. Closing the treatment (RR:51-58).
  IF n.stage = 'treatment_completed' THEN
    IF v_create OR o.stage IS DISTINCT FROM 'treatment_completed' THEN
      IF v_note IS NULL THEN
        PERFORM public.crm__raise('E_CLOSE_NOTE');
      END IF;
      v_newly_completed := true;
      n.treatment_closed_at := now();
      n.treatment_closed_by := v_me;
    END IF;
    n.followup_state := 'done';
    n.followup_date := NULL;
    n.next_action := '';
    n.automation_review := NULL;
    IF v_ic IS NOT NULL THEN
      PERFORM public.crm__raise('E_CLOSED_NEW_WORK');
    END IF;
  END IF;
  -- 3. Reopening (RR:59).
  IF NOT v_create AND o.stage = 'treatment_completed' AND n.stage <> 'treatment_completed' AND v_note IS NULL THEN
    PERFORM public.crm__raise('E_REOPEN_NOTE');
  END IF;
  -- 4. Do not contact (RR:60).
  IF n.do_not_contact THEN
    n.followup_state := 'done';
    n.followup_date := NULL;
    n.next_action := '';
    n.automation_review := NULL;
    IF v_ic IS NOT NULL THEN
      PERFORM public.crm__raise('E_DNC_INITIAL');
    END IF;
  END IF;
  -- 5. Closing the follow-up (RR:61); steps 2 and 4 force 'done', so they need the note too.
  IF n.followup_state = 'done' AND (v_create OR o.followup_state IS DISTINCT FROM 'done') AND v_note IS NULL THEN
    PERFORM public.crm__raise('E_FOLLOWUP_CLOSE_NOTE');
  END IF;
  -- 6. Loss reason (RR:70-71).
  IF n.stage = 'lost' THEN
    IF n.loss_reason IS NULL THEN
      PERFORM public.crm__raise('E_LOSS_REASON');
    END IF;
  ELSE
    n.loss_reason := NULL;
  END IF;
  -- 7. A moved open follow-up date needs a reason (RR:83-84). Setting or clearing a date needs none.
  IF NOT v_create AND o.followup_date IS NOT NULL AND n.followup_date IS NOT NULL
     AND o.followup_date <> n.followup_date AND n.followup_state = 'open' THEN
    v_reason := public.crm__reason(p_schedule_reason, 'E_FOLLOWUP_REASON');
    v_moved := true;
  END IF;
  -- 8. Automation review is cleared by a closed follow-up, an open visit, or a fresh future plan (RR:86).
  IF n.followup_state = 'done'
     OR public.crm__visit_any(v_clinic, n.id, n.patient_id)
     OR (n.followup_date >= v_today AND btrim(n.next_action) <> ''
         AND (v_create OR n.followup_date IS DISTINCT FROM o.followup_date
              OR n.next_action IS DISTINCT FROM o.next_action)) THEN
    n.automation_review := NULL;
  END IF;

  -- 12. Initial call (create only, RR:115-120), validated before any write.
  IF v_ic IS NOT NULL THEN
    IF NOT v_create THEN
      PERFORM public.crm__raise('E_FIELDS', 'initial_call');
    END IF;
    v_ic_id := public.crm__j_uuid(v_ic, 'id');
    IF v_ic_id IS NULL THEN
      PERFORM public.crm__raise('E_FIELDS', 'initial_call.id');
    END IF;
    IF EXISTS (SELECT 1 FROM public.crm_calls WHERE id = v_ic_id) THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
    v_ic_date := public.crm__j_date(v_ic, 'date');
    IF v_ic_date IS NULL THEN
      PERFORM public.crm__raise('E_DATE');
    END IF;
    IF v_ic_date < v_today THEN
      PERFORM public.crm__raise('E_CALL_PAST');
    END IF;
    v_ic_time := public.crm__time(public.crm__j_text(v_ic, 'time'));
    v_ic_caller := public.crm__active_user(v_clinic,
      coalesce(public.crm__j_uuid(v_ic, 'caller_user_id'), n.assigned_to, v_me), 'E_CALLER');
  END IF;

  -- 10-11. Writes and history (WF:12-23).
  IF v_create THEN
    INSERT INTO public.leads (
      id, clinic_id, full_name, phone, email, address, source, referrer, campaign, treatment_interest, assigned_to,
      stage, interest, contact_result, loss_reason, followup_date, followup_state, next_action, do_not_contact,
      automation_review, treatment_closed_at, treatment_closed_by, quote_amount_cents, quote_currency, stage_entered_at
    ) VALUES (
      n.id, v_clinic, n.full_name, n.phone, n.email, n.address, n.source, n.referrer, n.campaign,
      n.treatment_interest, n.assigned_to, n.stage, n.interest, n.contact_result, n.loss_reason, n.followup_date,
      n.followup_state, n.next_action, n.do_not_contact, NULL, n.treatment_closed_at, n.treatment_closed_by,
      n.quote_amount_cents, n.quote_currency, now()
    );
    PERFORM public.crm__log(v_clinic, n.id, 'update', 'Hasta adayı oluşturuldu.');
  ELSE
    v_diff := public.crm__lead_diff_text(o, n);
    IF v_diff IS NOT NULL THEN
      PERFORM public.crm__log(v_clinic, n.id, 'update', v_diff);
    END IF;
    IF o.quote_amount_cents IS DISTINCT FROM n.quote_amount_cents OR o.quote_currency IS DISTINCT FROM n.quote_currency THEN
      PERFORM public.crm__log(v_clinic, n.id, 'update', 'Verilen teklif tutarı güncellendi.');
    END IF;

    -- RR:200: cancel before the write so the ids can be returned; the leads trigger then finds nothing left.
    IF public.crm__should_cancel(v_clinic, n) THEN
      v_cancelled := public.crm__cancel_open_calls(v_clinic, n.id, public.crm__cancel_all(n), public.crm__cancel_reason(n));
    END IF;

    UPDATE public.leads
    SET full_name = n.full_name,
        phone = n.phone,
        email = n.email,
        address = n.address,
        source = n.source,
        referrer = n.referrer,
        campaign = n.campaign,
        treatment_interest = n.treatment_interest,
        assigned_to = n.assigned_to,
        stage = n.stage,
        interest = n.interest,
        contact_result = n.contact_result,
        loss_reason = n.loss_reason,
        followup_date = n.followup_date,
        followup_state = n.followup_state,
        next_action = n.next_action,
        do_not_contact = n.do_not_contact,
        automation_review = n.automation_review,
        treatment_closed_at = n.treatment_closed_at,
        treatment_closed_by = n.treatment_closed_by,
        quote_amount_cents = n.quote_amount_cents,
        quote_currency = n.quote_currency
    WHERE id = n.id;

    IF v_moved THEN
      PERFORM public.crm__log(v_clinic, n.id, 'schedule',
        'Takip tarihi değişti: ' || public.crm__fmt_date(o.followup_date) || ' → '
        || public.crm__fmt_date(n.followup_date) || ' · Neden: ' || v_reason,
        false, NULL,
        jsonb_build_object('type', 'followup', 'from_date', o.followup_date, 'to_date', n.followup_date,
                           'reason', v_reason));
    END IF;

    -- RR:88-90: a newly completed treatment closes the open handoffs.
    IF v_newly_completed THEN
      UPDATE public.crm_handoffs
      SET status = 'cancelled',
          system_closed = true,
          completion_text = 'Tedavi tamamlandığı için takip kapatıldı.',
          completed_by = v_me,
          completed_at = now()
      WHERE clinic_id = v_clinic AND lead_id = n.id AND status IN ('waiting', 'answered');
      PERFORM public.crm__log(v_clinic, n.id, 'update', 'Tedavi tamamlandı; açık aramalar ve aktarım görevleri kapatıldı.');
    END IF;
  END IF;

  IF v_note IS NOT NULL THEN
    PERFORM public.crm__log(v_clinic, n.id, 'note', v_note);
  END IF;

  IF v_ic_id IS NOT NULL THEN
    INSERT INTO public.crm_calls (id, clinic_id, lead_id, caller_user_id, scheduled_date, scheduled_time, status,
                                  origin, created_by, updated_by)
    VALUES (v_ic_id, v_clinic, n.id, v_ic_caller, v_ic_date, v_ic_time, 'planned', 'manual', v_me, v_me);
    PERFORM public.crm__log(v_clinic, n.id, 'call',
      'Arama planlandı: ' || public.crm__fmt_date(v_ic_date) || ' ' || public.crm__fmt_time(v_ic_time) || ' · '
      || coalesce(public.crm__user_name(v_clinic, v_ic_caller), '—') || ' · Planlandı', false, v_ic_id);
  END IF;

  -- 13. Duplicates are a warning, never an error (owner decision 1).
  v_phone_changed := v_create OR public.crm__normalize_phone(o.phone) IS DISTINCT FROM public.crm__normalize_phone(n.phone);
  RETURN jsonb_build_object(
    'already_saved', false,
    'lead', public.crm__lead_json(v_clinic, n.id, v_today),
    'phone_matches', CASE WHEN v_phone_changed THEN public.crm__phone_matches(v_clinic, n.phone, n.id, n.patient_id)
                          ELSE public.crm__no_matches(n.phone) END,
    'cancelled_call_ids', to_jsonb(v_cancelled),
    'initial_call', CASE WHEN v_ic_id IS NOT NULL THEN public.crm__call_json(v_clinic, v_ic_id) END);
END;
$$;

-- §4.2 Notes. A private note (legacy adminOnly) needs crm_manage or owner. The lead version is not bumped.
CREATE OR REPLACE FUNCTION public.crm_add_note(p_lead_id uuid, p_activity_id uuid, p_text text, p_private boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_mgr boolean := public.crm_can_manage();
  v_private boolean := coalesce(p_private, false);
  l public.leads;
  a public.lead_activities;
  v_text text;
BEGIN
  IF v_private AND NOT v_mgr THEN
    PERFORM public.crm__raise('E_PRIVATE');
  END IF;
  IF p_activity_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'activity_id');
  END IF;
  l := public.crm__lead_for_update(v_clinic, p_lead_id);

  SELECT * INTO a FROM public.lead_activities WHERE id = p_activity_id;
  IF FOUND THEN
    IF a.clinic_id <> v_clinic OR a.lead_id <> l.id OR (a.is_private AND NOT v_mgr) THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
    RETURN jsonb_build_object('already_saved', true, 'activity', public.crm__activity_json(a, v_mgr));
  END IF;

  v_text := public.crm__note(p_text);
  PERFORM public.crm__log(v_clinic, l.id, 'note', v_text, v_private, NULL, NULL, NULL, p_activity_id);
  SELECT * INTO a FROM public.lead_activities WHERE id = p_activity_id;
  RETURN jsonb_build_object('already_saved', false, 'activity', public.crm__activity_json(a, v_mgr));
END;
$$;

-- Port of correctNotes (NE:3-16): the text is replaced in place (author and time kept) and an 'update' row with
-- the old text and the same privacy is appended.
CREATE OR REPLACE FUNCTION public.crm_correct_note(p_activity_id uuid, p_version integer, p_text text, p_correction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_mgr boolean := public.crm_can_manage();
  a public.lead_activities;
  c public.lead_activities;
  v_text text;
  v_old text;
BEGIN
  IF p_correction_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'correction_id');
  END IF;

  SELECT x.* INTO a
  FROM public.lead_activities x
  JOIN public.leads l ON l.id = x.lead_id
  WHERE x.id = p_activity_id AND x.clinic_id = v_clinic AND l.deleted_at IS NULL
  FOR UPDATE OF x;
  -- One answer for "missing", "not a note" and "private and you are not a manager" (rules R17.3, NE:8): a
  -- non-manager learns nothing about private rows.
  IF NOT FOUND OR a.activity_type NOT IN ('note', 'legacy') OR (a.is_private AND NOT v_mgr) THEN
    PERFORM public.crm__raise('E_NOTE_EDIT');
  END IF;

  -- Idempotency before the version: a retry after success carries the old version.
  SELECT * INTO c FROM public.lead_activities WHERE id = p_correction_id;
  IF FOUND THEN
    IF c.clinic_id = v_clinic AND c.edited_from = a.id THEN
      RETURN jsonb_build_object('already_saved', true, 'activity', public.crm__activity_json(a, v_mgr),
                                'correction', public.crm__activity_json(c, v_mgr));
    END IF;
    PERFORM public.crm__raise('E_ID_TAKEN');
  END IF;

  IF p_version IS NULL OR a.version <> p_version THEN
    PERFORM public.crm__raise('E_VERSION');
  END IF;

  v_text := public.crm__note(p_text);
  IF v_text = coalesce(a.description, '') THEN   -- NE:9: identical text is a no-op
    RETURN jsonb_build_object('already_saved', true, 'activity', public.crm__activity_json(a, v_mgr),
                              'correction', NULL);
  END IF;

  v_old := a.description;
  UPDATE public.lead_activities
  SET description = v_text, edited_at = now(), edited_by = public.current_app_user_id()
  WHERE id = a.id;
  PERFORM public.crm__log(v_clinic, a.lead_id, 'update', 'Not düzeltildi. Eski metin: ' || coalesce(v_old, ''),
                          a.is_private, NULL, NULL, NULL, p_correction_id, a.id);

  SELECT * INTO a FROM public.lead_activities WHERE id = p_activity_id;
  SELECT * INTO c FROM public.lead_activities WHERE id = p_correction_id;
  RETURN jsonb_build_object('already_saved', false, 'activity', public.crm__activity_json(a, v_mgr),
                            'correction', public.crm__activity_json(c, v_mgr));
END;
$$;

-- §4.3 New planned call (RR:121-129, calendar "Yeni arama"). Lost / archived / done leads may still get a manual
-- call (legacy blocks only completed and do-not-contact leads).
CREATE OR REPLACE FUNCTION public.crm_plan_call(p_id uuid, p_lead_id uuid, p_caller_user_id uuid, p_date date, p_time text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  l public.leads;
  v_existing_clinic uuid;
  v_existing_lead uuid;
  v_caller uuid;
  v_time time;
BEGIN
  IF p_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'id');
  END IF;
  l := public.crm__lead_for_update(v_clinic, p_lead_id);

  SELECT clinic_id, lead_id INTO v_existing_clinic, v_existing_lead FROM public.crm_calls WHERE id = p_id;
  IF FOUND THEN
    IF v_existing_clinic <> v_clinic OR v_existing_lead <> l.id THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
    RETURN jsonb_build_object('already_saved', true, 'call', public.crm__call_json(v_clinic, p_id),
                              'lead', public.crm__lead_json(v_clinic, l.id, v_today));
  END IF;

  IF l.stage = 'treatment_completed' THEN
    PERFORM public.crm__raise('E_TREATMENT_CLOSED');
  END IF;
  IF l.do_not_contact THEN
    PERFORM public.crm__raise('E_DNC');
  END IF;
  v_caller := public.crm__active_user(v_clinic, coalesce(p_caller_user_id, v_me), 'E_CALLER');
  PERFORM public.crm__day(p_date);
  IF p_date < v_today THEN
    PERFORM public.crm__raise('E_CALL_PAST');
  END IF;
  v_time := public.crm__time(p_time);

  INSERT INTO public.crm_calls (id, clinic_id, lead_id, caller_user_id, scheduled_date, scheduled_time, status, origin,
                                created_by, updated_by)
  VALUES (p_id, v_clinic, l.id, v_caller, p_date, v_time, 'planned', 'manual', v_me, v_me);

  -- RR:184: a new plan answers the pending follow-up decision.
  IF l.automation_review IS NOT NULL THEN
    UPDATE public.leads SET automation_review = NULL WHERE id = l.id;
  END IF;

  PERFORM public.crm__log(v_clinic, l.id, 'call',
    'Arama planlandı: ' || public.crm__fmt_date(p_date) || ' ' || public.crm__fmt_time(v_time) || ' · '
    || coalesce(public.crm__user_name(v_clinic, v_caller), '—') || ' · Planlandı', false, p_id);

  RETURN jsonb_build_object('already_saved', false, 'call', public.crm__call_json(v_clinic, p_id),
                            'lead', public.crm__lead_json(v_clinic, l.id, v_today));
END;
$$;

-- §4.4 Move a planned call or change its caller (RR:132-134, RR:145-148). A moved date/time needs a reason; the
-- follow-up date that matched the old call date moves with it (D-DW:9).
CREATE OR REPLACE FUNCTION public.crm_reschedule_call(
  p_call_id uuid, p_version integer, p_date date, p_time text, p_caller_user_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_today date := public.clinic_today();
  v_lead_id uuid;
  l public.leads;
  c public.crm_calls;
  v_date date;
  v_time time;
  v_caller uuid;
  v_moved boolean;
  v_caller_changed boolean;
  v_reason text;
  v_new_followup date;
BEGIN
  SELECT lead_id INTO v_lead_id FROM public.crm_calls WHERE id = p_call_id AND clinic_id = v_clinic;
  IF NOT FOUND THEN
    PERFORM public.crm__raise('E_CALL_NOT_FOUND');
  END IF;
  l := public.crm__lead_for_update(v_clinic, v_lead_id);
  SELECT * INTO c FROM public.crm_calls WHERE id = p_call_id FOR UPDATE;

  IF c.status <> 'planned' THEN
    PERFORM public.crm__raise('E_CALL_LOCKED');
  END IF;
  IF p_version IS NULL OR c.version <> p_version THEN
    PERFORM public.crm__raise('E_VERSION');
  END IF;

  v_date := public.crm__day(coalesce(p_date, c.scheduled_date));
  v_time := CASE WHEN p_time IS NULL THEN c.scheduled_time ELSE public.crm__time(p_time) END;
  v_caller := coalesce(p_caller_user_id, c.caller_user_id);
  v_moved := (v_date, v_time) IS DISTINCT FROM (c.scheduled_date, c.scheduled_time);
  v_caller_changed := v_caller IS DISTINCT FROM c.caller_user_id;

  IF v_moved THEN
    v_reason := public.crm__reason(p_reason, 'E_CALL_REASON');
    IF v_date < v_today THEN
      PERFORM public.crm__raise('E_CALL_PAST');
    END IF;
  END IF;
  IF v_caller_changed THEN
    PERFORM public.crm__active_user(v_clinic, v_caller, 'E_CALLER');
  END IF;
  IF NOT v_moved AND NOT v_caller_changed THEN
    RETURN jsonb_build_object('already_saved', true, 'call', public.crm__call_json(v_clinic, c.id),
                              'lead', public.crm__lead_json(v_clinic, l.id, v_today));
  END IF;

  UPDATE public.crm_calls
  SET scheduled_date = v_date, scheduled_time = v_time, caller_user_id = v_caller
  WHERE id = c.id;

  IF v_moved THEN
    v_new_followup := CASE WHEN l.followup_state = 'open' AND l.followup_date = c.scheduled_date THEN v_date
                           ELSE l.followup_date END;
    IF v_new_followup IS DISTINCT FROM l.followup_date OR l.automation_review IS NOT NULL THEN
      UPDATE public.leads SET followup_date = v_new_followup, automation_review = NULL WHERE id = l.id;
    END IF;
    PERFORM public.crm__log(v_clinic, l.id, 'schedule',
      'Arama planı değişti: ' || public.crm__fmt_date(c.scheduled_date) || ' ' || public.crm__fmt_time(c.scheduled_time)
      || ' → ' || public.crm__fmt_date(v_date) || ' ' || public.crm__fmt_time(v_time) || ' · Neden: ' || v_reason,
      false, c.id,
      jsonb_build_object('type', 'call', 'call_id', c.id, 'from_date', c.scheduled_date,
                         'from_time', public.crm__fmt_time(c.scheduled_time), 'to_date', v_date,
                         'to_time', public.crm__fmt_time(v_time), 'reason', v_reason));
  ELSE
    -- RR:184: any save of a planned call (a caller change too) answers the pending follow-up decision.
    IF l.automation_review IS NOT NULL THEN
      UPDATE public.leads SET automation_review = NULL WHERE id = l.id;
    END IF;
    PERFORM public.crm__log(v_clinic, l.id, 'call',
      'Arama güncellendi: ' || public.crm__fmt_date(v_date) || ' ' || public.crm__fmt_time(v_time) || ' · '
      || coalesce(public.crm__user_name(v_clinic, v_caller), '—') || ' · Planlandı', false, c.id);
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'call', public.crm__call_json(v_clinic, c.id),
                            'lead', public.crm__lead_json(v_clinic, l.id, v_today));
END;
$$;

-- §4.5 Conclude a planned call, or log an ad-hoc one (unknown p_call_id with p_call_version NULL, QC:22-23), with
-- the mandatory decision, in one transaction: call outcome, lead state, next call, clinic appointment and the
-- cancellations (legacy needed a _mutation token and a D1 batch, RR:185-195). The call's own date and time never
-- change. Interest is never changed here (the CT suggestion is a client-side helper).
CREATE OR REPLACE FUNCTION public.crm_resolve_call(
  p_call_id uuid,
  p_call_version integer,
  p_lead_id uuid,
  p_lead_version integer,
  p_request_id uuid,
  p_status text,
  p_note text,
  p_decision text,
  p_contact_result text,
  p_next_call_id uuid,
  p_followup jsonb,
  p_loss_reason text,
  p_appointment jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_now_local timestamp := public.crm__local_now();
  l public.leads;
  n public.leads;
  c public.crm_calls;
  v_note text;
  v_adhoc boolean := false;
  v_fu_date date;
  v_fu_time time;
  v_fu_action text;
  v_appt jsonb := CASE WHEN jsonb_typeof(p_appointment) = 'object' THEN p_appointment END;
  v_appt_id uuid;
  v_doctor uuid;
  v_chair uuid;
  v_proc uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_appt_notes text;
  v_rules public.crm_followup_rules;
  v_unreach integer;
  v_plan jsonb;
  v_plan_text text;
  v_next_id uuid;
  v_next_date date;
  v_next_time time;
  v_next_origin text;
  v_next_caller uuid;
  v_patient_id uuid;
  v_patient_created boolean := false;
  v_cancelled uuid[] := '{}'::uuid[];
  v_diff text;
  v_matches jsonb;
BEGIN
  -- Input shape (CR:4-21).
  IF p_status IS NULL OR p_status NOT IN ('reached', 'unreachable', 'cancelled') THEN
    PERFORM public.crm__raise('E_STATUS');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('auto', 'followup', 'clinic', 'completed', 'lost', 'stop') THEN
    PERFORM public.crm__raise('E_DECISION');
  END IF;
  v_note := public.crm__note(p_note, 'E_CALL_NOTE');
  IF p_request_id IS NULL OR p_call_id IS NULL OR p_lead_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'call_id, lead_id, request_id');
  END IF;
  IF p_contact_result IS NOT NULL AND p_contact_result NOT IN ('unspecified', 'wants_treatment', 'considering_price',
      'considering_timing', 'will_think_later', 'unreachable', 'call_on_date', 'negative', 'comparing_clinics',
      'appointment_confirmed') THEN
    PERFORM public.crm__raise('E_FIELDS', 'contact_result');
  END IF;

  -- 1. Lead (locked first, so concurrent resolutions and lead saves serialise).
  l := public.crm__lead_for_update(v_clinic, p_lead_id);

  -- 2. Call.
  SELECT * INTO c FROM public.crm_calls WHERE id = p_call_id FOR UPDATE;
  IF FOUND THEN
    IF c.clinic_id <> v_clinic THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
    IF c.lead_id <> l.id THEN
      PERFORM public.crm__raise('E_CALL_LEAD');
    END IF;
    IF c.status <> 'planned' THEN
      IF c.resolve_request_id = p_request_id THEN
        RETURN jsonb_build_object(
          'already_saved', true,
          'call', public.crm__call_json(v_clinic, c.id),
          'lead', public.crm__lead_json(v_clinic, l.id, v_today),
          'next_call', CASE WHEN c.next_call_id IS NOT NULL THEN public.crm__call_json(v_clinic, c.next_call_id) END,
          'appointment', public.crm__appt_brief_json(v_clinic, c.appointment_id),
          'patient_created', false,
          'plan', NULL,
          'cancelled_call_ids', '[]'::jsonb,
          'phone_matches', public.crm__no_matches(l.phone));
      END IF;
      PERFORM public.crm__raise('E_CALL_DONE');
    END IF;
    IF p_call_version IS NULL OR c.version <> p_call_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
  ELSE
    IF p_call_version IS NOT NULL THEN
      PERFORM public.crm__raise('E_CALL_NOT_FOUND');
    END IF;
    v_adhoc := true;
  END IF;

  -- 3. Lead version (CR:6, RR:138).
  IF p_lead_version IS NULL OR l.version <> p_lead_version THEN
    PERFORM public.crm__raise('E_VERSION');
  END IF;

  -- 4. Lead guards (RR:128-129).
  IF l.stage = 'treatment_completed' THEN
    PERFORM public.crm__raise('E_TREATMENT_CLOSED');
  END IF;
  IF l.do_not_contact AND p_decision <> 'stop' THEN
    PERFORM public.crm__raise('E_DNC');
  END IF;

  -- 5. Decision rules.
  IF p_decision = 'auto' AND p_status NOT IN ('reached', 'unreachable') THEN
    PERFORM public.crm__raise('E_AUTO_STATUS');
  END IF;
  IF p_decision = 'followup' THEN
    IF p_followup IS NULL OR jsonb_typeof(p_followup) <> 'object' THEN
      PERFORM public.crm__raise('E_FOLLOWUP_DATE');
    END IF;
    v_fu_date := public.crm__j_date(p_followup, 'date', 'E_FOLLOWUP_DATE');
    IF v_fu_date IS NULL THEN
      PERFORM public.crm__raise('E_FOLLOWUP_DATE');
    END IF;
    v_fu_time := public.crm__time(public.crm__j_text(p_followup, 'time'), 'E_FOLLOWUP_TIME');
    v_fu_action := btrim(coalesce(public.crm__j_text(p_followup, 'action'), ''));
    IF char_length(v_fu_action) NOT BETWEEN 1 AND 200 THEN
      PERFORM public.crm__raise('E_FOLLOWUP_ACTION');
    END IF;
    IF (v_fu_date + v_fu_time) <= v_now_local THEN
      PERFORM public.crm__raise('E_FOLLOWUP_FUTURE');
    END IF;
    IF p_next_call_id IS NULL THEN
      PERFORM public.crm__raise('E_FIELDS', 'next_call_id');
    END IF;
  END IF;
  IF p_decision = 'clinic' THEN
    IF v_appt IS NULL THEN
      PERFORM public.crm__raise('E_CLINIC_FIELDS');
    END IF;
    v_appt_id := public.crm__j_uuid(v_appt, 'id');
    v_doctor := public.crm__j_uuid(v_appt, 'doctor_id');
    v_chair := public.crm__j_uuid(v_appt, 'chair_id');
    v_proc := public.crm__j_uuid(v_appt, 'procedure_id');
    v_start := public.crm__j_ts(v_appt, 'start_time', 'E_CLINIC_FIELDS');
    v_end := public.crm__j_ts(v_appt, 'end_time', 'E_CLINIC_FIELDS');
    IF v_appt_id IS NULL OR v_doctor IS NULL OR v_chair IS NULL OR v_start IS NULL OR v_end IS NULL THEN
      PERFORM public.crm__raise('E_CLINIC_FIELDS');
    END IF;
    IF p_status <> 'reached' OR v_start <= now() THEN
      PERFORM public.crm__raise('E_CLINIC');
    END IF;
    v_appt_notes := nullif(public.crm__short(public.crm__j_text(v_appt, 'notes'), 'notes', 2000), '');
    IF EXISTS (SELECT 1 FROM public.appointments WHERE id = v_appt_id) THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
    IF v_proc IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.procedures_catalog pr WHERE pr.id = v_proc AND pr.clinic_id = v_clinic
    ) THEN
      PERFORM public.crm__raise('E_FIELDS', 'procedure_id');
    END IF;
  END IF;
  IF p_decision = 'lost' AND (p_loss_reason IS NULL OR p_loss_reason NOT IN ('price_high', 'timing_unsuitable',
      'unreachable', 'chose_other_clinic', 'postponed', 'not_suitable', 'other')) THEN
    PERFORM public.crm__raise('E_LOSS_REASON');
  END IF;

  -- Ad-hoc call: inserted as a plan at the local minute, then concluded below like any other.
  IF v_adhoc THEN
    INSERT INTO public.crm_calls (id, clinic_id, lead_id, caller_user_id, scheduled_date, scheduled_time, status,
                                  origin, created_by, updated_by)
    VALUES (p_call_id, v_clinic, l.id, v_me, v_now_local::date, v_now_local::time, 'planned', 'manual', v_me, v_me);
    SELECT * INTO c FROM public.crm_calls WHERE id = p_call_id;
  END IF;

  -- 6. Lead changes.
  n := l;
  IF n.followup_date IS NOT NULL AND n.followup_date <= c.scheduled_date THEN    -- RR:149
    n.followup_date := NULL;
  END IF;
  n.contact_result := CASE WHEN p_status = 'unreachable' THEN 'unreachable'
                           ELSE coalesce(p_contact_result, n.contact_result) END;   -- RR:155
  n.automation_review := NULL;                                                       -- RR:156

  CASE p_decision
    WHEN 'auto' THEN
      v_rules := public.crm__rules(v_clinic);
      v_unreach := CASE WHEN p_status = 'unreachable'
                        THEN 1 + public.crm__consecutive_unreachable(v_clinic, l.id, c.id) ELSE 0 END;
      v_plan := public.crm__auto_plan(v_clinic, l, p_status, n.contact_result, v_rules, c.scheduled_date, c.id,
                                      v_unreach, v_today, v_now_local);
      CASE v_plan ->> 'kind'
        WHEN 'call' THEN
          IF p_next_call_id IS NULL THEN
            PERFORM public.crm__raise('E_FIELDS', 'next_call_id');
          END IF;
          v_next_id := p_next_call_id;
          v_next_date := (v_plan ->> 'date')::date;
          v_next_time := (v_plan ->> 'time')::time;
          v_next_origin := 'automatic';
          n.followup_state := 'open';
          n.followup_date := v_next_date;
          n.next_action := left(v_plan ->> 'action', 200);
        WHEN 'keep' THEN
          n.followup_date := (v_plan ->> 'date')::date;
          n.followup_state := 'open';
          n.next_action := coalesce(nullif(btrim(l.next_action), ''), 'Mevcut arama planında hastayı ara');
        WHEN 'review' THEN
          n.followup_date := NULL;
          n.next_action := 'Takip kararını gözden geçir';
          n.automation_review := left(v_plan ->> 'reason', 500);
        ELSE
          NULL;   -- stop
      END CASE;
      v_plan_text := (v_plan ->> 'reason')
        || CASE WHEN v_plan ->> 'kind' = 'call' THEN ' ' || (v_plan ->> 'date') || ' ' || (v_plan ->> 'time') ELSE '' END;
    WHEN 'followup' THEN
      n.followup_state := 'open';
      n.followup_date := v_fu_date;
      n.next_action := v_fu_action;
      v_next_id := p_next_call_id;
      v_next_date := v_fu_date;
      v_next_time := v_fu_time;
      v_next_origin := 'manual';
    WHEN 'clinic' THEN
      NULL;   -- the appointment sync trigger moves the lead (one code path for the RPC and the appointments page)
    WHEN 'completed' THEN
      n.followup_state := 'done';
      n.followup_date := NULL;
      n.next_action := '';
    WHEN 'lost' THEN
      n.followup_state := 'done';
      n.followup_date := NULL;
      n.next_action := '';
      n.stage := 'lost';
      n.loss_reason := p_loss_reason;
    WHEN 'stop' THEN
      n.followup_state := 'done';
      n.followup_date := NULL;
      n.next_action := '';
      n.do_not_contact := true;
  END CASE;

  -- 7. Next call (same caller, or the resolver when that caller is no longer active), then the call itself.
  IF v_next_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.crm_calls WHERE id = v_next_id) THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
    v_next_caller := CASE WHEN EXISTS (SELECT 1 FROM public.users u WHERE u.id = c.caller_user_id
                                         AND u.clinic_id = v_clinic AND u.is_active = true)
                          THEN c.caller_user_id ELSE v_me END;
    INSERT INTO public.crm_calls (id, clinic_id, lead_id, caller_user_id, scheduled_date, scheduled_time, status,
                                  origin, created_by, updated_by)
    VALUES (v_next_id, v_clinic, l.id, v_next_caller, v_next_date, v_next_time, 'planned', v_next_origin, v_me, v_me);
  END IF;

  UPDATE public.crm_calls
  SET status = p_status,
      decision = p_decision,
      contact_result = n.contact_result,
      note = v_note,
      resolved_at = now(),
      resolved_by = v_me,
      resolve_request_id = p_request_id,
      next_call_id = v_next_id
  WHERE id = c.id;

  -- 9.1 history: the call row first (RR:147).
  PERFORM public.crm__log(v_clinic, l.id, 'call',
    CASE WHEN v_adhoc THEN 'Arama kaydedildi: ' ELSE 'Arama güncellendi: ' END
    || public.crm__fmt_date(c.scheduled_date) || ' ' || public.crm__fmt_time(c.scheduled_time) || ' · '
    || coalesce(public.crm__user_name(v_clinic, c.caller_user_id), c.caller_name_legacy, '—') || ' · '
    || public.crm__call_status_label(p_status), false, c.id);
  -- 9.2 field diff.
  v_diff := public.crm__lead_diff_text(l, n);
  IF v_diff IS NOT NULL THEN
    PERFORM public.crm__log(v_clinic, l.id, 'update', v_diff, false, c.id);
  END IF;

  -- 8. Cancellations (RR:192-193), then the lead write; the triggers do status, stage history, stage time.
  IF public.crm__should_cancel(v_clinic, n) THEN
    v_cancelled := public.crm__cancel_open_calls(v_clinic, l.id, public.crm__cancel_all(n), public.crm__cancel_reason(n));
  END IF;
  UPDATE public.leads
  SET followup_date = n.followup_date,
      followup_state = n.followup_state,
      next_action = n.next_action,
      contact_result = n.contact_result,
      automation_review = n.automation_review,
      stage = n.stage,
      loss_reason = n.loss_reason,
      do_not_contact = n.do_not_contact
  WHERE id = l.id;

  -- 9.3 note, 9.4 plan.
  PERFORM public.crm__log(v_clinic, l.id, 'note', v_note, false, c.id);
  IF v_plan_text IS NOT NULL THEN
    PERFORM public.crm__log(v_clinic, l.id, 'update', v_plan_text, false, c.id);
  END IF;

  -- 'clinic': patient, slot, appointment (RR:171-173). The lead is written first; the sync trigger then books it.
  IF p_decision = 'clinic' THEN
    SELECT * INTO n FROM public.leads WHERE id = l.id;
    SELECT x.o_patient_id, x.o_created INTO v_patient_id, v_patient_created
    FROM public.crm__ensure_patient(v_clinic, n, public.crm__j_uuid(v_appt, 'patient_id'),
                                    public.crm__j_uuid(v_appt, 'new_patient_id'),
                                    CASE WHEN jsonb_typeof(v_appt -> 'patient') = 'object' THEN v_appt -> 'patient' END) AS x;
    PERFORM public.crm__check_slot(v_clinic, v_doctor, v_chair, v_start, v_end, NULL);
    v_cancelled := v_cancelled || public.crm__cancel_open_calls(v_clinic, l.id, false, 'Klinik randevusu planlandı');
    PERFORM set_config('crm.strict_sync', 'on', true);
    INSERT INTO public.appointments (id, clinic_id, patient_id, doctor_id, chair_id, procedure_id, start_time, end_time,
                                     status, notes, lead_id)
    VALUES (v_appt_id, v_clinic, v_patient_id, v_doctor, v_chair, v_proc, v_start, v_end, 'scheduled', v_appt_notes, l.id);
    PERFORM set_config('crm.strict_sync', 'off', true);
    UPDATE public.crm_calls SET appointment_id = v_appt_id WHERE id = c.id;
    IF v_patient_created THEN
      v_matches := public.crm__phone_matches(v_clinic, (SELECT p.phone FROM public.patients p WHERE p.id = v_patient_id),
                                             l.id, v_patient_id);
    END IF;
  END IF;

  -- 9.5 decision row.
  PERFORM public.crm__log(v_clinic, l.id, 'update',
    CASE p_decision
      WHEN 'auto' THEN 'Otomatik takip kararı kaydedildi.'
      WHEN 'stop' THEN 'Hasta telefonla aranmak istemiyor; bekleyen aramalar iptal edildi.'
      WHEN 'followup' THEN 'Sonraki arama: ' || public.crm__fmt_date(v_fu_date) || ' ' || public.crm__fmt_time(v_fu_time)
                           || ' · ' || v_fu_action
      WHEN 'clinic' THEN 'Klinik randevusu kesinleşti.'
      WHEN 'lost' THEN 'Takip olumsuz sonuçlandı: ' || public.crm__loss_label(p_loss_reason)
      ELSE 'Takip tamamlandı.'
    END, false, c.id);

  RETURN jsonb_build_object(
    'already_saved', false,
    'call', public.crm__call_json(v_clinic, c.id),
    'lead', public.crm__lead_json(v_clinic, l.id, v_today),
    'next_call', CASE WHEN v_next_id IS NOT NULL THEN public.crm__call_json(v_clinic, v_next_id) END,
    'appointment', CASE WHEN v_appt_id IS NOT NULL AND p_decision = 'clinic'
                        THEN public.crm__appt_brief_json(v_clinic, v_appt_id) END,
    'patient_created', v_patient_created,
    'plan', CASE WHEN v_plan IS NOT NULL THEN jsonb_build_object('kind', v_plan -> 'kind', 'reason', v_plan -> 'reason',
                                                                 'date', v_plan -> 'date', 'time', v_plan -> 'time') END,
    'cancelled_call_ids', to_jsonb(v_cancelled),
    'phone_matches', coalesce(v_matches, public.crm__no_matches(l.phone)));
END;
$$;

-- §4.6 "Hastaya dönüştür": link an existing patient or create one. Neither stage nor follow-up changes.
CREATE OR REPLACE FUNCTION public.crm_convert_to_patient(
  p_lead_id uuid, p_version integer, p_patient_id uuid, p_new_patient_id uuid, p_patient jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_today date := public.clinic_today();
  l public.leads;
  v_patient_id uuid;
  v_created boolean;
  v_already boolean := false;
  v_patient jsonb;
BEGIN
  l := public.crm__lead_for_update(v_clinic, p_lead_id);

  IF l.patient_id IS NOT NULL AND (p_patient_id IS NULL OR p_patient_id = l.patient_id) THEN
    v_already := true;
    v_patient_id := l.patient_id;
    v_created := false;
  ELSE
    IF p_version IS NULL OR l.version <> p_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
    SELECT x.o_patient_id, x.o_created INTO v_patient_id, v_created
    FROM public.crm__ensure_patient(v_clinic, l, p_patient_id, p_new_patient_id,
                                    CASE WHEN jsonb_typeof(p_patient) = 'object' THEN p_patient END) AS x;
  END IF;

  SELECT jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone, 'is_active', p.is_active IS NOT FALSE)
    INTO v_patient
  FROM public.patients p WHERE p.id = v_patient_id AND p.clinic_id = v_clinic;

  RETURN jsonb_build_object(
    'already_saved', v_already,
    'lead', public.crm__lead_json(v_clinic, l.id, v_today),
    'patient', v_patient,
    'created', v_created,
    'phone_matches', public.crm__phone_matches(v_clinic, v_patient ->> 'phone', l.id, v_patient_id));
END;
$$;

-- §4.7 Handoffs (applyHandoff HO:28-52, RR:36-37, RR:107-111). They never change calls, stage or follow-up.
CREATE OR REPLACE FUNCTION public.crm_handoff_action(
  p_action text,
  p_handoff_id uuid,
  p_version integer,
  p_lead_id uuid,
  p_topic text,
  p_text text,
  p_due_date date,
  p_private_note text,
  p_assignee_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_mgr boolean := public.crm_can_manage();
  l public.leads;
  h public.crm_handoffs;
  v_lead_id uuid;
  v_text text;
  v_private text;
  v_assignee uuid;
  v_reanswer boolean;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('request', 'answer', 'complete', 'cancel') THEN
    PERFORM public.crm__raise('E_FIELDS', 'action');
  END IF;
  IF p_handoff_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'handoff_id');
  END IF;
  IF p_action = 'answer' AND NOT v_mgr THEN
    PERFORM public.crm__raise('E_HANDOFF_ANSWER_ROLE');
  END IF;

  IF p_action = 'request' THEN
    IF p_lead_id IS NULL THEN
      PERFORM public.crm__raise('E_FIELDS', 'lead_id');
    END IF;
    l := public.crm__lead_for_update(v_clinic, p_lead_id);
    SELECT * INTO h FROM public.crm_handoffs WHERE id = p_handoff_id;
    IF FOUND THEN
      IF h.clinic_id <> v_clinic OR h.lead_id <> l.id THEN
        PERFORM public.crm__raise('E_ID_TAKEN');
      END IF;
      RETURN jsonb_build_object('already_saved', true, 'handoff', public.crm__handoff_json(v_clinic, h.id, v_mgr));
    END IF;
    IF l.stage = 'archived' THEN
      PERFORM public.crm__raise('E_HANDOFF_ARCHIVED');
    END IF;
    IF l.stage = 'treatment_completed' THEN
      PERFORM public.crm__raise('E_CLOSED_NEW_WORK');
    END IF;
    IF p_topic IS NULL OR p_topic NOT IN ('price_payment', 'treatment_question', 'followup_decision', 'other') THEN
      PERFORM public.crm__raise('E_FIELDS', 'topic');
    END IF;
    v_text := btrim(coalesce(p_text, ''));
    IF char_length(v_text) NOT BETWEEN 1 AND 3000 THEN
      PERFORM public.crm__raise('E_HANDOFF_TEXT');
    END IF;
    IF EXISTS (SELECT 1 FROM public.crm_handoffs x
               WHERE x.clinic_id = v_clinic AND x.lead_id = l.id AND x.status IN ('waiting', 'answered')) THEN
      PERFORM public.crm__raise('E_HANDOFF_OPEN');
    END IF;
    BEGIN
      INSERT INTO public.crm_handoffs (id, clinic_id, lead_id, patient_id, topic, question, status, requested_by,
                                       requested_at)
      VALUES (p_handoff_id, v_clinic, l.id, l.patient_id, p_topic, v_text, 'waiting', v_me, now());
    EXCEPTION WHEN unique_violation THEN
      PERFORM public.crm__raise('E_HANDOFF_OPEN');
    END;
    PERFORM public.crm__log(v_clinic, l.id, 'handoff',
      'Yöneticiye aktarıldı · ' || public.crm__topic_label(p_topic) || ': ' || v_text);
    RETURN jsonb_build_object('already_saved', false, 'handoff', public.crm__handoff_json(v_clinic, p_handoff_id, v_mgr));
  END IF;

  SELECT lead_id INTO v_lead_id FROM public.crm_handoffs WHERE id = p_handoff_id AND clinic_id = v_clinic;
  IF NOT FOUND THEN
    PERFORM public.crm__raise('E_HANDOFF_NOT_FOUND');
  END IF;
  l := public.crm__lead_for_update(v_clinic, v_lead_id);
  SELECT * INTO h FROM public.crm_handoffs WHERE id = p_handoff_id FOR UPDATE;
  v_text := btrim(coalesce(p_text, ''));

  IF p_action = 'answer' THEN
    IF h.status NOT IN ('waiting', 'answered') THEN
      PERFORM public.crm__raise('E_HANDOFF_CLOSED');
    END IF;
    IF p_version IS NULL OR h.version <> p_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
    IF p_due_date IS NULL OR p_due_date < v_today OR p_due_date > DATE '2100-12-31' THEN
      PERFORM public.crm__raise('E_HANDOFF_DUE');
    END IF;
    IF char_length(v_text) NOT BETWEEN 1 AND 3000 THEN
      PERFORM public.crm__raise('E_HANDOFF_TEXT');
    END IF;
    IF p_private_note IS NOT NULL THEN
      v_private := btrim(p_private_note);
      IF char_length(v_private) > 3000 THEN
        PERFORM public.crm__raise('E_HANDOFF_TEXT');
      END IF;
    END IF;
    -- The person who does the task: given, else the requester (generalises the fixed legacy name, HO:21).
    v_assignee := coalesce(p_assignee_user_id,
                           CASE WHEN EXISTS (SELECT 1 FROM public.users u WHERE u.id = h.requested_by
                                               AND u.clinic_id = v_clinic AND u.is_active = true)
                                THEN h.requested_by ELSE v_me END);
    PERFORM public.crm__active_user(v_clinic, v_assignee, 'E_ASSIGNEE');
    v_reanswer := h.status = 'answered';

    UPDATE public.crm_handoffs
    SET status = 'answered',
        answer_text = v_text,
        answer_due_date = p_due_date,
        answer_assignee_user_id = v_assignee,
        answered_by = v_me,
        answered_at = now()
    WHERE id = h.id;

    IF v_private IS NOT NULL THEN
      INSERT INTO public.crm_handoff_private_notes (handoff_id, clinic_id, note, written_by, written_at)
      VALUES (h.id, v_clinic, v_private, v_me, now())
      ON CONFLICT (handoff_id) DO UPDATE
        SET note = EXCLUDED.note, written_by = EXCLUDED.written_by, written_at = EXCLUDED.written_at;
    END IF;

    PERFORM public.crm__log(v_clinic, l.id, 'handoff',
      'Yönetici yanıtı' || CASE WHEN v_reanswer THEN ' güncellendi' ELSE '' END || ' · Yapılacak iş ('
      || public.crm__fmt_date(p_due_date) || ', ' || coalesce(public.crm__user_name(v_clinic, v_assignee), '—') || '): ' || v_text);
    IF coalesce(v_private, '') <> '' THEN
      PERFORM public.crm__log(v_clinic, l.id, 'handoff', 'Aktarım için özel yönetici notu: ' || v_private, true);
    END IF;

  ELSIF p_action = 'complete' THEN
    IF h.status <> 'answered' THEN
      PERFORM public.crm__raise('E_HANDOFF_STATE');
    END IF;
    IF p_version IS NULL OR h.version <> p_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
    IF char_length(v_text) NOT BETWEEN 1 AND 3000 THEN
      PERFORM public.crm__raise('E_HANDOFF_TEXT');
    END IF;
    UPDATE public.crm_handoffs
    SET status = 'completed', completion_text = v_text, completed_by = v_me, completed_at = now()
    WHERE id = h.id;
    PERFORM public.crm__log(v_clinic, l.id, 'handoff', 'Aktarım tamamlandı: ' || v_text);

  ELSE   -- cancel
    IF h.status <> 'waiting' THEN
      PERFORM public.crm__raise('E_HANDOFF_STATE');
    END IF;
    IF p_version IS NULL OR h.version <> p_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
    IF char_length(v_text) NOT BETWEEN 1 AND 3000 THEN
      PERFORM public.crm__raise('E_HANDOFF_TEXT');
    END IF;
    UPDATE public.crm_handoffs
    SET status = 'cancelled', completion_text = v_text, completed_by = v_me, completed_at = now()
    WHERE id = h.id;
    PERFORM public.crm__log(v_clinic, l.id, 'handoff', 'Aktarım geri çekildi: ' || v_text);
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'handoff', public.crm__handoff_json(v_clinic, h.id, v_mgr));
END;
$$;

-- §4.8 Staff tasks (generalised legacy task messages TM:19-58, TMS). Anyone may create a task for themselves; a
-- task for someone else needs a CRM manager (owner or crm_manage; admin needs the grant, rules §1 / §27). Only
-- the assignee reads / completes; the creator or a CRM manager updates / cancels. A task invisible to the caller
-- reads as not found.
CREATE OR REPLACE FUNCTION public.staff_task_action(
  p_action text,
  p_id uuid,
  p_version integer,
  p_title text,
  p_detail text,
  p_due_date date,
  p_assignee_user_id uuid,
  p_lead_id uuid,
  p_patient_id uuid,
  p_result text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_crm_mgr boolean := public.crm_can_manage();
  v_assigner boolean := public.crm_can_manage();   -- owner or crm_manage; role admin alone is not a manager (rules §1)
  t public.staff_tasks;
  v_title text;
  v_detail text;
  v_due date;
  v_assignee uuid;
  v_lead uuid;
  v_patient uuid;
  v_result text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('create', 'update', 'read', 'complete', 'cancel') THEN
    PERFORM public.crm__raise('E_FIELDS', 'action');
  END IF;
  IF p_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'id');
  END IF;

  IF p_action = 'create' THEN
    SELECT * INTO t FROM public.staff_tasks WHERE id = p_id;
    IF FOUND THEN
      IF t.clinic_id <> v_clinic OR NOT coalesce(t.created_by = v_me OR t.assignee_user_id = v_me OR v_assigner, false) THEN
        PERFORM public.crm__raise('E_ID_TAKEN');
      END IF;
      RETURN jsonb_build_object('already_saved', true, 'task', public.crm__task_json(v_clinic, t.id, v_today));
    END IF;
    v_assignee := coalesce(p_assignee_user_id, v_me);
    IF v_assignee <> v_me AND NOT v_assigner THEN
      PERFORM public.crm__raise('E_TASK_ROLE');
    END IF;
    v_lead := p_lead_id;
    v_patient := p_patient_id;
    v_title := btrim(coalesce(p_title, ''));
    v_detail := btrim(coalesce(p_detail, ''));
    v_due := p_due_date;
  ELSE
    SELECT * INTO t FROM public.staff_tasks WHERE id = p_id AND clinic_id = v_clinic FOR UPDATE;
    IF NOT FOUND OR NOT coalesce(t.created_by = v_me OR t.assignee_user_id = v_me OR v_assigner, false) THEN
      PERFORM public.crm__raise('E_TASK_NOT_FOUND');
    END IF;

    IF p_action = 'read' THEN
      IF t.assignee_user_id <> v_me THEN
        PERFORM public.crm__raise('E_TASK_ROLE');
      END IF;
      IF t.read_at IS NOT NULL THEN   -- TM:43-44: idempotent, no version check
        RETURN jsonb_build_object('already_saved', true, 'task', public.crm__task_json(v_clinic, t.id, v_today));
      END IF;
      IF p_version IS NOT NULL AND t.version <> p_version THEN
        PERFORM public.crm__raise('E_TASK_VERSION');
      END IF;
      UPDATE public.staff_tasks SET read_at = now() WHERE id = t.id;
      RETURN jsonb_build_object('already_saved', false, 'task', public.crm__task_json(v_clinic, t.id, v_today));
    END IF;

    IF p_action = 'complete' THEN
      IF t.assignee_user_id <> v_me THEN
        PERFORM public.crm__raise('E_TASK_ROLE');
      END IF;
      IF t.status <> 'open' THEN
        PERFORM public.crm__raise('E_TASK_CLOSED');
      END IF;
      IF p_version IS NULL OR t.version <> p_version THEN
        PERFORM public.crm__raise('E_TASK_VERSION');
      END IF;
      v_result := btrim(coalesce(p_result, ''));
      IF char_length(v_result) NOT BETWEEN 2 AND 2000 THEN
        PERFORM public.crm__raise('E_TASK_RESULT');
      END IF;
      UPDATE public.staff_tasks
      SET status = 'done', completed_at = now(), completed_by = v_me, read_at = coalesce(read_at, now()),
          result = v_result
      WHERE id = t.id;
      RETURN jsonb_build_object('already_saved', false, 'task', public.crm__task_json(v_clinic, t.id, v_today));
    END IF;

    -- update / cancel: the creator or a CRM manager.
    IF NOT coalesce(t.created_by = v_me OR v_crm_mgr, false) THEN
      PERFORM public.crm__raise('E_TASK_ROLE');
    END IF;
    IF t.status <> 'open' THEN
      PERFORM public.crm__raise('E_TASK_CLOSED');
    END IF;
    IF p_version IS NULL OR t.version <> p_version THEN
      PERFORM public.crm__raise('E_TASK_VERSION');
    END IF;

    IF p_action = 'cancel' THEN
      v_result := btrim(coalesce(p_result, ''));
      IF char_length(v_result) > 2000 THEN
        PERFORM public.crm__raise('E_TASK_RESULT');
      END IF;
      UPDATE public.staff_tasks
      SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_me,
          result = CASE WHEN v_result = '' THEN result ELSE v_result END
      WHERE id = t.id;
      RETURN jsonb_build_object('already_saved', false, 'task', public.crm__task_json(v_clinic, t.id, v_today));
    END IF;

    -- update: NULL arguments keep the current values.
    v_assignee := coalesce(p_assignee_user_id, t.assignee_user_id);
    IF v_assignee IS DISTINCT FROM t.assignee_user_id AND v_assignee <> v_me AND NOT v_assigner THEN
      PERFORM public.crm__raise('E_TASK_ROLE');
    END IF;
    v_lead := coalesce(p_lead_id, t.lead_id);
    v_patient := coalesce(p_patient_id, t.patient_id);
    v_title := btrim(coalesce(p_title, t.title));
    v_detail := btrim(coalesce(p_detail, t.detail));
    v_due := coalesce(p_due_date, t.due_date);
  END IF;

  -- Field rules shared by create and update (TMS:4-5, TM:33; a past due date is refused, Q-6).
  IF char_length(v_title) NOT BETWEEN 3 AND 160 OR char_length(v_detail) > 2000
     OR v_due IS NULL OR v_due < DATE '2000-01-01' OR v_due > DATE '2100-12-31' THEN
    PERFORM public.crm__raise('E_TASK_FIELDS');
  END IF;
  IF v_due < v_today AND (p_action = 'create' OR v_due IS DISTINCT FROM t.due_date) THEN
    PERFORM public.crm__raise('E_TASK_DUE');
  END IF;
  IF p_action = 'create' OR v_assignee IS DISTINCT FROM t.assignee_user_id THEN
    PERFORM public.crm__active_user(v_clinic, v_assignee, 'E_ASSIGNEE');
  END IF;
  IF v_lead IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l WHERE l.id = v_lead AND l.clinic_id = v_clinic AND l.deleted_at IS NULL
  ) AND (p_action = 'create' OR v_lead IS DISTINCT FROM t.lead_id) THEN
    PERFORM public.crm__raise('E_LEAD_NOT_FOUND');
  END IF;
  IF v_patient IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patients p WHERE p.id = v_patient AND p.clinic_id = v_clinic
  ) THEN
    PERFORM public.crm__raise('E_PATIENT_NOT_FOUND');
  END IF;

  IF p_action = 'create' THEN
    INSERT INTO public.staff_tasks (id, clinic_id, title, detail, due_date, lead_id, patient_id, assignee_user_id,
                                    created_by, status)
    VALUES (p_id, v_clinic, v_title, v_detail, v_due, v_lead, v_patient, v_assignee, v_me, 'open');
  ELSE
    UPDATE public.staff_tasks
    SET title = v_title,
        detail = v_detail,
        due_date = v_due,
        lead_id = v_lead,
        patient_id = v_patient,
        assignee_user_id = v_assignee,
        read_at = CASE WHEN v_assignee IS DISTINCT FROM t.assignee_user_id THEN NULL ELSE read_at END
    WHERE id = t.id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'task', public.crm__task_json(v_clinic, p_id, v_today));
END;
$$;

-- §4.9 Follow-up rules (FRR:8-19, FU:5-12). p_version 0 inserts; any mismatch -> E_RULES_VERSION. Rule changes
-- apply to future results only; existing calls are never moved (FS:12, D-AF:9).
CREATE OR REPLACE FUNCTION public.crm_save_followup_rules(p_version integer, p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_manage();
  v_me uuid := public.current_app_user_id();
  cur public.crm_followup_rules;
  r public.crm_followup_rules;
  v_rows integer;
BEGIN
  SELECT * INTO cur FROM public.crm_followup_rules WHERE clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    cur := public.crm__rules(v_clinic);
  END IF;
  IF p_version IS NULL OR cur.version <> p_version THEN
    PERFORM public.crm__raise('E_RULES_VERSION');
  END IF;
  r := public.crm__rules_from_json(cur, p_rules, true);

  IF p_version = 0 THEN
    INSERT INTO public.crm_followup_rules (clinic_id, enabled, work_days, start_time, end_time, call_time, retry_days,
      interested_days, price_days, timing_days, later_days, max_unreachable, first_call_minutes, stale_days,
      offer_days, updated_by)
    VALUES (v_clinic, r.enabled, r.work_days, r.start_time, r.end_time, r.call_time, r.retry_days, r.interested_days,
      r.price_days, r.timing_days, r.later_days, r.max_unreachable, r.first_call_minutes, r.stale_days, r.offer_days,
      v_me)
    ON CONFLICT (clinic_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      PERFORM public.crm__raise('E_RULES_VERSION');
    END IF;
  ELSE
    UPDATE public.crm_followup_rules
    SET enabled = r.enabled,
        work_days = r.work_days,
        start_time = r.start_time,
        end_time = r.end_time,
        call_time = r.call_time,
        retry_days = r.retry_days,
        interested_days = r.interested_days,
        price_days = r.price_days,
        timing_days = r.timing_days,
        later_days = r.later_days,
        max_unreachable = r.max_unreachable,
        first_call_minutes = r.first_call_minutes,
        stale_days = r.stale_days,
        offer_days = r.offer_days
    WHERE clinic_id = v_clinic;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'rules', public.crm__rules_json(public.crm__rules(v_clinic)));
END;
$$;

-- §4.10 Manual reminder outcome on an appointment (RR:77-82, RR:112). Nothing is sent to the patient (RF:16).
CREATE OR REPLACE FUNCTION public.crm_set_reminder_outcome(
  p_appointment_id uuid, p_event_id uuid, p_start_time timestamptz, p_doctor_id uuid, p_outcome text, p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  a public.appointments;
  g public.appointment_reminder_logs;
  v_note text;
  v_lead record;
  v_text text;
BEGIN
  IF p_event_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'event_id');
  END IF;
  SELECT * INTO a FROM public.appointments WHERE id = p_appointment_id AND clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.crm__raise('E_APPOINTMENT_NOT_FOUND');
  END IF;

  SELECT * INTO g FROM public.appointment_reminder_logs WHERE id = p_event_id;
  IF FOUND THEN
    IF g.clinic_id <> v_clinic OR g.appointment_id <> a.id THEN
      PERFORM public.crm__raise('E_ID_TAKEN');
    END IF;
  ELSE
    -- The visit key the user saw (CRe:7 visitKey); then the date rule (RR:79-80).
    IF a.start_time IS DISTINCT FROM p_start_time OR a.doctor_id IS DISTINCT FROM p_doctor_id THEN
      PERFORM public.crm__raise('E_REMINDER_STALE');
    END IF;
    IF a.status IS DISTINCT FROM 'scheduled' OR (a.start_time AT TIME ZONE 'Europe/Istanbul')::date < v_today THEN
      PERFORM public.crm__raise('E_REMINDER_DATE');
    END IF;
    IF p_outcome IS NULL OR p_outcome NOT IN ('reminded', 'unreachable') THEN
      PERFORM public.crm__raise('E_REMINDER_OUTCOME');
    END IF;
    v_note := public.crm__note(p_note, 'E_REMINDER_NOTE', 1000);

    INSERT INTO public.appointment_reminder_logs (id, clinic_id, appointment_id, patient_id, outcome, note, start_time,
                                                  doctor_id, created_by)
    VALUES (p_event_id, v_clinic, a.id, a.patient_id, p_outcome, v_note, a.start_time, a.doctor_id, v_me);

    UPDATE public.appointments
    SET reminder_outcome = p_outcome,
        reminder_note = v_note,
        reminded_at = now(),
        reminded_by = v_me,
        reminder_start_time = a.start_time,
        reminder_doctor_id = a.doctor_id
    WHERE id = a.id;

    v_text := 'Klinik randevusu hatırlatması: ' || public.crm__fmt_local(a.start_time) || ' · '
              || coalesce(public.crm__doctor_name(v_clinic, a.doctor_id), '—') || ' · ' || public.crm__reminder_label(p_outcome)
              || ' · ' || v_note;
    FOR v_lead IN
      SELECT l.id FROM public.leads l
      WHERE l.clinic_id = v_clinic AND l.deleted_at IS NULL AND (l.id = a.lead_id OR l.patient_id = a.patient_id)
      ORDER BY l.created_at, l.id
    LOOP
      PERFORM public.crm__log(v_clinic, v_lead.id, 'reminder', v_text, false, NULL, NULL, a.id);
    END LOOP;

    SELECT * INTO g FROM public.appointment_reminder_logs WHERE id = p_event_id;
  END IF;

  SELECT * INTO a FROM public.appointments WHERE id = p_appointment_id;
  RETURN jsonb_build_object(
    'already_saved', v_note IS NULL,
    'appointment', jsonb_build_object(
      'id', a.id, 'start_time', a.start_time, 'doctor_id', a.doctor_id, 'status', a.status,
      'reminder_outcome', a.reminder_outcome, 'reminder_note', a.reminder_note, 'reminded_at', a.reminded_at,
      'reminded_by_name', public.crm__user_name(v_clinic, a.reminded_by),
      'reminder_current', public.crm__reminder_current(a.status::text, a.reminder_outcome, a.reminder_start_time,
                                                       a.start_time, a.reminder_doctor_id, a.doctor_id)),
    'log', jsonb_build_object('id', g.id, 'outcome', g.outcome, 'note', g.note, 'created_at', g.created_at));
END;
$$;

-- §4.11 Monthly ad spend per source (legacy cost editor; costSchema MO:20). Finance holders only.
CREATE OR REPLACE FUNCTION public.crm_save_ad_spend(
  p_id uuid, p_version integer, p_source text, p_month text, p_amount_cents bigint, p_currency text, p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_finance_write();
  v_me uuid := public.current_app_user_id();
  v_month date;
  v_currency text;
  v_note text;
  v_existing_clinic uuid;
  v_dup uuid;
  s public.crm_ad_spend;
BEGIN
  IF p_id IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'id');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in',
                                          'other') THEN
    PERFORM public.crm__raise('E_FIELDS', 'source');
  END IF;
  v_month := public.crm__month(p_month);
  IF p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 0 AND 1000000000000 THEN
    PERFORM public.crm__raise('E_AD_AMOUNT');
  END IF;
  v_currency := coalesce(nullif(btrim(p_currency), ''), 'TRY');
  IF v_currency NOT IN ('TRY', 'EUR', 'USD') THEN
    PERFORM public.crm__raise('E_FIELDS', 'currency');
  END IF;
  v_note := public.crm__short(p_note, 'note', 500);

  IF p_version IS NULL THEN
    SELECT clinic_id INTO v_existing_clinic FROM public.crm_ad_spend WHERE id = p_id;
    IF FOUND THEN
      IF v_existing_clinic <> v_clinic THEN
        PERFORM public.crm__raise('E_ID_TAKEN');
      END IF;
      RETURN jsonb_build_object('already_saved', true, 'row', public.crm__ad_spend_json(v_clinic, p_id));
    END IF;
    SELECT id INTO v_dup FROM public.crm_ad_spend
    WHERE clinic_id = v_clinic AND source = p_source AND month = v_month AND currency = v_currency;
    IF FOUND THEN
      PERFORM public.crm__raise('E_AD_DUPLICATE', NULL, v_dup::text);
    END IF;
    BEGIN
      INSERT INTO public.crm_ad_spend (id, clinic_id, source, month, amount_cents, currency, note, created_by, updated_by)
      VALUES (p_id, v_clinic, p_source, v_month, p_amount_cents, v_currency, v_note, v_me, v_me);
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_dup FROM public.crm_ad_spend
      WHERE clinic_id = v_clinic AND source = p_source AND month = v_month AND currency = v_currency;
      PERFORM public.crm__raise('E_AD_DUPLICATE', NULL, v_dup::text);
    END;
    RETURN jsonb_build_object('already_saved', false, 'row', public.crm__ad_spend_json(v_clinic, p_id));
  END IF;

  SELECT * INTO s FROM public.crm_ad_spend WHERE id = p_id AND clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.crm__raise('E_NOT_FOUND');
  END IF;
  IF s.version <> p_version THEN
    PERFORM public.crm__raise('E_VERSION');
  END IF;
  SELECT id INTO v_dup FROM public.crm_ad_spend
  WHERE clinic_id = v_clinic AND source = p_source AND month = v_month AND currency = v_currency AND id <> s.id;
  IF FOUND THEN
    PERFORM public.crm__raise('E_AD_DUPLICATE', NULL, v_dup::text);
  END IF;
  IF (s.source, s.month, s.amount_cents, s.currency, s.note)
     IS NOT DISTINCT FROM (p_source, v_month, p_amount_cents, v_currency, v_note) THEN
    RETURN jsonb_build_object('already_saved', true, 'row', public.crm__ad_spend_json(v_clinic, p_id));
  END IF;
  UPDATE public.crm_ad_spend
  SET source = p_source, month = v_month, amount_cents = p_amount_cents, currency = v_currency, note = v_note
  WHERE id = s.id;
  RETURN jsonb_build_object('already_saved', false, 'row', public.crm__ad_spend_json(v_clinic, p_id));
END;
$$;

-- §4.12 Trash / restore (RR:209-222, TR:19-30). Calls, handoffs and tasks are kept; they disappear from every list
-- through RLS and the internals. No purge in this phase. Restore warns about shared phones instead of the legacy 409.
CREATE OR REPLACE FUNCTION public.crm_trash_lead(p_lead_id uuid, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  l public.leads;
  v_hidden jsonb;
BEGIN
  l := public.crm__lead_for_update(v_clinic, p_lead_id, true);
  SELECT coalesce(jsonb_agg(c.id ORDER BY c.scheduled_date, c.scheduled_time, c.id), '[]'::jsonb) INTO v_hidden
  FROM public.crm_calls c WHERE c.clinic_id = v_clinic AND c.lead_id = l.id AND c.status = 'planned';

  IF l.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'lead_id', l.id, 'hidden_call_ids', v_hidden);
  END IF;
  IF p_version IS NULL OR l.version <> p_version THEN
    PERFORM public.crm__raise('E_VERSION');
  END IF;
  UPDATE public.leads SET deleted_at = now(), deleted_by = public.current_app_user_id() WHERE id = l.id;
  PERFORM public.crm__log(v_clinic, l.id, 'update', 'Hasta çöp kutusuna taşındı.');
  RETURN jsonb_build_object('already_saved', false, 'lead_id', l.id, 'hidden_call_ids', v_hidden);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_restore_lead(p_lead_id uuid, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_today date := public.clinic_today();
  l public.leads;
  v_already boolean := false;
BEGIN
  l := public.crm__lead_for_update(v_clinic, p_lead_id, true);
  IF l.deleted_at IS NULL THEN
    v_already := true;
  ELSE
    IF p_version IS NULL OR l.version <> p_version THEN
      PERFORM public.crm__raise('E_VERSION');
    END IF;
    UPDATE public.leads SET deleted_at = NULL, deleted_by = NULL WHERE id = l.id;
    PERFORM public.crm__log(v_clinic, l.id, 'update', 'Hasta çöp kutusundan geri getirildi.');
  END IF;
  RETURN jsonb_build_object(
    'already_saved', v_already,
    'lead', public.crm__lead_json(v_clinic, l.id, v_today),
    'phone_matches', public.crm__phone_matches(v_clinic, l.phone, l.id, l.patient_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- §5 Read RPCs (STABLE SECURITY DEFINER over the replayable internals). Today is always clinic_today(), now is
--    always the server clock; the client never sends either. Lists are paged (default 50, max 200) and every count
--    is computed in SQL (PostgREST 1000-row cap). No view is created in this phase.
-- ---------------------------------------------------------------------------

-- §5.1 Work list 'Bugün' (WL, TW, D-DW). p_user_id is the "Sorumlu" filter (caller or assignee; reminder rows
-- have neither and are kept for everyone).
CREATE OR REPLACE FUNCTION public.crm_work_list(
  p_filter text DEFAULT 'all',
  p_user_id uuid DEFAULT NULL,
  p_page jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_now_local timestamp := public.crm__local_now();
  v_off integer;
  v_lim integer;
  v_result jsonb;
BEGIN
  IF p_filter IS NULL OR p_filter NOT IN ('all', 'overdue', 'today', 'missing', 'future') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;

  WITH w AS MATERIALIZED (
    SELECT x AS item FROM public.crm__work_items(v_clinic, v_today, v_now_local) AS x
  ),
  f AS MATERIALIZED (
    SELECT w.item FROM w
    WHERE p_user_id IS NULL
       OR (w.item).item_type = 'reminder'
       OR (w.item).caller_user_id = p_user_id
       OR (w.item).assignee_user_id = p_user_id
  ),
  sel AS MATERIALIZED (
    -- 'missing' lists leads newest first (DW:13 filters records ordered by created DESC; rules R12.1), and the
    -- quick-call queue built from it follows that order. Every other filter uses the TK:43 / DW:22 order.
    SELECT f.item,
           row_number() OVER (ORDER BY CASE WHEN p_filter = 'missing' THEN lc.created_at END DESC NULLS LAST,
                                       (f.item).priority, (f.item).due_date NULLS FIRST, (f.item).due_time NULLS FIRST,
                                       (f.item).sort_name COLLATE "tr-x-icu", (f.item).item_key) AS rn
    FROM f
    LEFT JOIN public.leads lc ON lc.id = (f.item).lead_id AND lc.clinic_id = v_clinic AND p_filter = 'missing'
    WHERE CASE p_filter
            WHEN 'all' THEN (f.item).bucket = 'daily'
            WHEN 'overdue' THEN (f.item).bucket = 'daily' AND (f.item).priority <= 1
            WHEN 'today' THEN (f.item).bucket = 'daily' AND (f.item).priority = 2
            WHEN 'missing' THEN (f.item).bucket = 'missing'
            ELSE (f.item).bucket = 'future'
          END
  )
  SELECT jsonb_build_object(
    'today', v_today,
    'filter', p_filter,
    'rows', coalesce((SELECT jsonb_agg(public.crm__work_item_json(v_clinic, s.item) ORDER BY s.rn)
                      FROM sel s WHERE s.rn > v_off AND s.rn <= v_off + v_lim), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM sel),
    'counts', jsonb_build_object(
      'all', (SELECT count(*) FROM f WHERE (f.item).bucket = 'daily'),
      'overdue', (SELECT count(*) FROM f WHERE (f.item).bucket = 'daily' AND (f.item).priority <= 1),
      'today', (SELECT count(*) FROM f WHERE (f.item).bucket = 'daily' AND (f.item).priority = 2),
      'missing', (SELECT count(*) FROM f WHERE (f.item).bucket = 'missing'),
      'future', (SELECT count(*) FROM f WHERE (f.item).bucket = 'future')),
    'overdue_patients', (SELECT count(DISTINCT coalesce((f.item).lead_id, (f.item).patient_id)) FROM f
                         WHERE (f.item).bucket = 'daily' AND (f.item).priority <= 1),
    'quick_call_lead_ids', coalesce((
      SELECT jsonb_agg(q.lead_id ORDER BY q.first_rn)
      FROM (
        SELECT (s.item).lead_id AS lead_id, min(s.rn) AS first_rn
        FROM sel s
        WHERE (s.item).quick_call AND (s.item).lead_id IS NOT NULL
        GROUP BY (s.item).lead_id
        ORDER BY min(s.rn)
        LIMIT 200
      ) q), '[]'::jsonb),
    'my_tasks', (SELECT jsonb_build_object('open', count(*),
                                           'unread', count(*) FILTER (WHERE t.read_at IS NULL),
                                           'overdue', count(*) FILTER (WHERE t.due_date < v_today))
                 FROM public.staff_tasks t
                 WHERE t.clinic_id = v_clinic AND t.assignee_user_id = v_me AND t.status = 'open')
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- §5.2 'Geciken hasta listesi' (OD, TK:7-15) and the printable call list rows (CE:3-10, no notes, no money).
CREATE OR REPLACE FUNCTION public.crm_overdue_list(p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_today date := public.clinic_today();
  v_now_local timestamp := public.crm__local_now();
  v_off integer;
  v_lim integer;
  v_result jsonb;
BEGIN
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;

  WITH w AS MATERIALIZED (
    SELECT x AS item FROM public.crm__work_items(v_clinic, v_today, v_now_local) AS x
  ),
  o AS MATERIALIZED (
    SELECT w.item,
           row_number() OVER (ORDER BY (w.item).priority, (w.item).due_date NULLS FIRST, (w.item).due_time NULLS FIRST,
                                       (w.item).sort_name COLLATE "tr-x-icu", (w.item).item_key) AS rn,
           CASE WHEN (w.item).lead_id IS NOT NULL THEN 'l:' || (w.item).lead_id
                ELSE 'p:' || (w.item).patient_id END AS gkey
    FROM w
    WHERE (w.item).bucket = 'daily' AND (w.item).priority <= 1
  ),
  g AS MATERIALIZED (
    SELECT o.gkey,
           min(o.rn) AS first_rn,
           (array_agg((o.item).lead_id))[1] AS lead_id,
           (array_agg((o.item).patient_id ORDER BY o.rn))[1] AS patient_id
    FROM o
    GROUP BY o.gkey
  ),
  gp AS (
    SELECT g.*, row_number() OVER (ORDER BY g.first_rn) AS grn FROM g
  ),
  e AS (
    SELECT (o.item).lead_id AS lead_id,
           min(o.rn) AS first_rn,
           coalesce(min((o.item).due_date), v_today) AS d,
           bool_or((o.item).item_type IN ('call_overdue', 'call_today')) AS has_call
    FROM o
    WHERE (o.item).lead_id IS NOT NULL
      AND (o.item).item_type NOT IN ('handoff', 'reminder', 'clinic_result', 'clinic_today', 'review')
    GROUP BY (o.item).lead_id
  )
  SELECT jsonb_build_object(
    'today', v_today,
    'clinic_name', (SELECT c.name FROM public.clinics c WHERE c.id = v_clinic),
    'count', (SELECT count(*) FROM o),
    'patient_count', (SELECT count(*) FROM g),
    'patients', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'lead', (SELECT jsonb_build_object('id', l.id, 'full_name', l.full_name, 'phone', l.phone,
                                                  'assigned_name', public.crm__user_name(v_clinic, l.assigned_to))
                        FROM public.leads l WHERE l.id = gp.lead_id AND l.clinic_id = v_clinic),
               'patient', (SELECT jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone)
                           FROM public.patients p WHERE p.id = gp.patient_id AND p.clinic_id = v_clinic
                             AND gp.lead_id IS NULL),
               'items', (SELECT jsonb_agg(jsonb_build_object('key', (o.item).item_key, 'type', (o.item).item_type,
                                                             'reason', (o.item).reason, 'action', (o.item).action,
                                                             'due_date', (o.item).due_date,
                                                             'due_time', public.crm__fmt_time((o.item).due_time))
                                          ORDER BY o.rn)
                         FROM o WHERE o.gkey = gp.gkey)
             ) ORDER BY gp.grn)
      FROM gp
      WHERE gp.grn > v_off AND gp.grn <= v_off + v_lim), '[]'::jsonb),
    'export_rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'name', l.full_name,
               'phone', l.phone,
               'date', e.d,
               'days', greatest(0, v_today - e.d),
               'action', CASE WHEN e.has_call
                              THEN 'Önce arama kaydını kontrol et. Arama yapılmadıysa hastayı ara; sonucu sisteme kaydet.'
                              ELSE 'Hastayı ara; görüşme sonucunu ve sonraki adımı sisteme kaydet.' END
             ) ORDER BY e.first_rn)
      FROM e
      JOIN public.leads l ON l.id = e.lead_id AND l.clinic_id = v_clinic
      WHERE public.crm__is_open(l.stage, l.do_not_contact, l.followup_state)
        AND l.automation_review IS NULL
        AND NOT public.crm__visit_any(v_clinic, l.id, l.patient_id)), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- §5.3 'Gün sonu özeti' for one day (DW:26-38, TW:11-31). Calls by resolution time, never the planned date;
-- system cancellations (auto_cancelled) are reported apart and never counted as results (fixes Q-4).
CREATE OR REPLACE FUNCTION public.crm__day_summary(p_clinic uuid, p_today date, p_now_local timestamp)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH lv AS MATERIALIZED (
    SELECT l.id, l.full_name, l.phone FROM public.leads l WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL
  ),
  res AS MATERIALIZED (
    SELECT c.id, c.lead_id, lv.full_name AS lead_name, c.status, c.resolved_at, c.resolved_by, c.scheduled_date,
           c.scheduled_time, c.auto_cancelled
    FROM public.crm_calls c
    JOIN lv ON lv.id = c.lead_id
    WHERE c.clinic_id = p_clinic AND c.status <> 'planned' AND c.resolved_at IS NOT NULL
      AND (c.resolved_at AT TIME ZONE 'Europe/Istanbul')::date = p_today
  ),
  rv AS MATERIALIZED (SELECT * FROM res WHERE NOT res.auto_cancelled),
  up AS MATERIALIZED (
    SELECT rv.lead_id, lv.full_name, lv.phone, count(*) AS attempts
    FROM rv JOIN lv ON lv.id = rv.lead_id
    WHERE rv.status = 'unreachable'
    GROUP BY rv.lead_id, lv.full_name, lv.phone
  ),
  ch AS MATERIALIZED (
    SELECT a.id, a.lead_id, lv.full_name AS lead_name, a.schedule_change, a.created_at,
           coalesce(public.crm__user_name(p_clinic, a.created_by), a.actor_name) AS actor_name
    FROM public.lead_activities a
    JOIN lv ON lv.id = a.lead_id
    WHERE a.clinic_id = p_clinic AND a.schedule_change IS NOT NULL AND NOT a.is_private
      AND (a.created_at AT TIME ZONE 'Europe/Istanbul')::date = p_today
  ),
  rem AS MATERIALIZED (
    SELECT g.id, g.appointment_id, g.patient_id, p.full_name AS patient_name, g.outcome, g.note, g.created_at,
           public.crm__user_name(p_clinic, g.created_by) AS actor_name
    FROM public.appointment_reminder_logs g
    LEFT JOIN public.patients p ON p.id = g.patient_id AND p.clinic_id = g.clinic_id
    WHERE g.clinic_id = p_clinic AND (g.created_at AT TIME ZONE 'Europe/Istanbul')::date = p_today
  )
  SELECT jsonb_build_object(
    'day', p_today,
    'counts', jsonb_build_object(
      'resolved', (SELECT count(*) FROM rv),
      'reached', (SELECT count(*) FROM rv WHERE rv.status = 'reached'),
      'unreachable', (SELECT count(*) FROM rv WHERE rv.status = 'unreachable'),
      'cancelled', (SELECT count(*) FROM rv WHERE rv.status = 'cancelled'),
      'unreachable_patients', (SELECT count(*) FROM up),
      'pending', (SELECT count(*) FROM public.crm__work_items(p_clinic, p_today, p_now_local) w WHERE w.bucket = 'daily'),
      'changes', (SELECT count(*) FROM ch),
      'reminders', (SELECT count(*) FROM rem),
      'auto_cancelled', (SELECT count(*) FROM res WHERE res.auto_cancelled),
      'legacy_undated', (SELECT count(*) FROM public.crm_calls c JOIN lv ON lv.id = c.lead_id
                         WHERE c.clinic_id = p_clinic AND c.status <> 'planned' AND c.resolved_at IS NULL)),
    'resolved', coalesce((
      SELECT jsonb_agg(jsonb_build_object('call_id', x.id, 'lead_id', x.lead_id, 'lead_name', x.lead_name,
                                          'status', x.status, 'resolved_at', x.resolved_at,
                                          'resolved_by_name', public.crm__user_name(p_clinic, x.resolved_by),
                                          'scheduled_date', x.scheduled_date,
                                          'scheduled_time', public.crm__fmt_time(x.scheduled_time))
                       ORDER BY x.resolved_at DESC, x.id)
      FROM (SELECT * FROM rv ORDER BY rv.resolved_at DESC, rv.id LIMIT 500) x), '[]'::jsonb),
    'unreachable_patients', coalesce((
      SELECT jsonb_agg(jsonb_build_object('lead_id', x.lead_id, 'full_name', x.full_name, 'phone', x.phone,
                                          'attempts', x.attempts) ORDER BY x.full_name COLLATE "tr-x-icu", x.lead_id)
      FROM (SELECT * FROM up ORDER BY up.full_name COLLATE "tr-x-icu", up.lead_id LIMIT 500) x), '[]'::jsonb),
    'changes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('activity_id', x.id, 'lead_id', x.lead_id, 'lead_name', x.lead_name,
                                          'type', x.schedule_change ->> 'type',
                                          'from_date', x.schedule_change -> 'from_date',
                                          'from_time', x.schedule_change -> 'from_time',
                                          'to_date', x.schedule_change -> 'to_date',
                                          'to_time', x.schedule_change -> 'to_time',
                                          'reason', x.schedule_change ->> 'reason',
                                          'at', x.created_at, 'actor_name', x.actor_name)
                       ORDER BY x.created_at DESC, x.id)
      FROM (SELECT * FROM ch ORDER BY ch.created_at DESC, ch.id LIMIT 500) x), '[]'::jsonb),
    'reminders', coalesce((
      SELECT jsonb_agg(jsonb_build_object('log_id', x.id, 'appointment_id', x.appointment_id,
                                          'patient_id', x.patient_id, 'patient_name', x.patient_name,
                                          'outcome', x.outcome, 'note', x.note, 'at', x.created_at,
                                          'actor_name', x.actor_name)
                       ORDER BY x.created_at DESC, x.id)
      FROM (SELECT * FROM rem ORDER BY rem.created_at DESC, rem.id LIMIT 500) x), '[]'::jsonb),
    'truncated', (SELECT count(*) FROM rv) > 500 OR (SELECT count(*) FROM up) > 500
                 OR (SELECT count(*) FROM ch) > 500 OR (SELECT count(*) FROM rem) > 500
  )
$$;

CREATE OR REPLACE FUNCTION public.crm_day_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
BEGIN
  RETURN public.crm__day_summary(v_clinic, public.clinic_today(), public.crm__local_now());
END;
$$;

-- §5.4 Manager overview (MS, MSU, TK:46-52). Cohort = non-trashed leads created (Istanbul date) in the period,
-- archived included; booked / won by stage only, calls never count (D-CR:7).
CREATE OR REPLACE FUNCTION public.crm__manager_summary(p_clinic uuid, p_today date, p_now_local timestamp, p_days integer)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH b AS (
    SELECT p_today - (p_days - 1) AS s, p_today AS e,
           p_today - (p_days - 1) - p_days AS ps, p_today - p_days AS pe
  ),
  co AS MATERIALIZED (
    SELECT l.id, l.source, l.stage, (l.created_at AT TIME ZONE 'Europe/Istanbul')::date AS d
    FROM public.leads l, b
    WHERE l.clinic_id = p_clinic AND l.deleted_at IS NULL
      AND (l.created_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN b.ps AND b.e
  ),
  cur AS MATERIALIZED (SELECT co.* FROM co, b WHERE co.d BETWEEN b.s AND b.e),
  prev AS MATERIALIZED (SELECT co.* FROM co, b WHERE co.d BETWEEN b.ps AND b.pe),
  w AS MATERIALIZED (SELECT * FROM public.crm__work_items(p_clinic, p_today, p_now_local)),
  srcs AS (
    SELECT x.source, x.ord
    FROM unnest(ARRAY['instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other'])
         WITH ORDINALITY AS x(source, ord)
    UNION ALL
    SELECT DISTINCT cur.source, 100::bigint
    FROM cur
    WHERE cur.source IS NULL
       OR cur.source NOT IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other')
  )
  SELECT jsonb_build_object(
    'today', p_today,
    'workload', jsonb_build_object(
      'overdue_items', (SELECT count(*) FROM w WHERE w.bucket = 'daily' AND w.priority <= 1),
      'today_call_patients', (SELECT count(DISTINCT w.lead_id) FROM w WHERE w.item_type = 'call_today'),
      'missing_plan_patients', (SELECT count(*) FROM w WHERE w.bucket = 'missing'),
      -- Leads with a reminder item (MSU:16 counted leads): the same set as crm_summary_leads('reminders').
      -- reminder_items also counts appointments of patients without a lead (owner decision: every appointment).
      'reminder_patients', (SELECT count(DISTINCT w.lead_id) FROM w WHERE w.item_type = 'reminder' AND w.lead_id IS NOT NULL),
      'reminder_items', (SELECT count(*) FROM w WHERE w.item_type = 'reminder')),
    'cohort', jsonb_build_object(
      'start', b.s, 'end', b.e, 'previous_start', b.ps, 'previous_end', b.pe,
      'current', (SELECT jsonb_build_object(
                    'total', count(*),
                    'booked', count(*) FILTER (WHERE cur.stage IN ('appointment_booked', 'appointment_attended',
                                                 'offer_given', 'treatment_started', 'treatment_completed')),
                    'won', count(*) FILTER (WHERE cur.stage IN ('treatment_started', 'treatment_completed')))
                  FROM cur),
      'previous', (SELECT jsonb_build_object(
                     'total', count(*),
                     'booked', count(*) FILTER (WHERE prev.stage IN ('appointment_booked', 'appointment_attended',
                                                  'offer_given', 'treatment_started', 'treatment_completed')),
                     'won', count(*) FILTER (WHERE prev.stage IN ('treatment_started', 'treatment_completed')))
                   FROM prev),
      'by_source', (SELECT jsonb_agg(jsonb_build_object(
                       'source', s.source,
                       'total', (SELECT count(*) FROM cur WHERE cur.source IS NOT DISTINCT FROM s.source),
                       'booked', (SELECT count(*) FROM cur WHERE cur.source IS NOT DISTINCT FROM s.source
                                    AND cur.stage IN ('appointment_booked', 'appointment_attended', 'offer_given',
                                                      'treatment_started', 'treatment_completed')),
                       'won', (SELECT count(*) FROM cur WHERE cur.source IS NOT DISTINCT FROM s.source
                                 AND cur.stage IN ('treatment_started', 'treatment_completed')))
                     ORDER BY s.ord, s.source NULLS LAST)
                    FROM srcs s))
  )
  FROM b
$$;

CREATE OR REPLACE FUNCTION public.crm_manager_summary(p_days integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_manage();
BEGIN
  IF p_days IS NULL OR p_days NOT IN (1, 7, 30) THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  RETURN public.crm__manager_summary(v_clinic, public.clinic_today(), public.crm__local_now(), p_days);
END;
$$;

-- §5.5 'Takip hızı ve bekleyen kararlar' (FI:6-29).
CREATE OR REPLACE FUNCTION public.crm_followup_insights()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_manage();
  v_today date := public.clinic_today();
  v_now timestamptz := now();
  v_counts jsonb;
BEGIN
  SELECT jsonb_build_object(
           'waiting', count(*) FILTER (WHERE f.is_waiting),
           'late_first', count(*) FILTER (WHERE f.is_late_first),
           'stalled', count(*) FILTER (WHERE f.is_stalled),
           'offers', count(*) FILTER (WHERE f.is_offer),
           'review', count(*) FILTER (WHERE f.is_review),
           'unknown_stage', count(*) FILTER (WHERE f.is_unknown_stage))
    INTO v_counts
  FROM public.crm__insight_flags(v_clinic, v_today, v_now) AS f;

  RETURN jsonb_build_object(
           'today', v_today,
           'window_start', v_today - 29,
           'rules_version', (public.crm__rules(v_clinic)).version,
           'counts', v_counts)
         || public.crm__insight_medians(v_clinic, v_today, v_now);
END;
$$;

-- §5.6 Drill-down lists behind every manager number (PL, MSU:19, MSU:24), with the same predicates.
CREATE OR REPLACE FUNCTION public.crm_summary_leads(
  p_list text,
  p_days integer DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_page jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_manage();
  v_today date := public.clinic_today();
  v_now_local timestamp := public.crm__local_now();
  v_off integer;
  v_lim integer;
  v_base text;
  v_prev boolean;
  v_from date;
  v_to date;
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_ids uuid[];
  v_result jsonb;
BEGIN
  IF p_list IS NULL OR p_list NOT IN ('cohort_total', 'cohort_booked', 'cohort_won', 'previous_cohort_total',
      'previous_cohort_booked', 'previous_cohort_won', 'today_calls', 'missing_plan', 'reminders', 'waiting',
      'late_first', 'stalled', 'offers', 'review', 'unknown_stage') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;
  v_prev := p_list LIKE 'previous\_%';
  v_base := regexp_replace(p_list, '^previous_', '');

  IF v_base IN ('cohort_total', 'cohort_booked', 'cohort_won') THEN
    IF p_days IS NULL OR p_days NOT IN (1, 7, 30) THEN
      PERFORM public.crm__raise('E_FILTER');
    END IF;
    v_from := v_today - (p_days - 1);
    v_to := v_today;
    IF v_prev THEN
      v_to := v_from - 1;
      v_from := v_from - p_days;
    END IF;
    SELECT coalesce(array_agg(l.id), '{}'::uuid[]) INTO v_ids
    FROM public.leads l
    WHERE l.clinic_id = v_clinic AND l.deleted_at IS NULL
      AND (l.created_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN v_from AND v_to
      AND (v_base = 'cohort_total'
           OR (v_base = 'cohort_booked' AND l.stage IN ('appointment_booked', 'appointment_attended', 'offer_given',
                                                         'treatment_started', 'treatment_completed'))
           OR (v_base = 'cohort_won' AND l.stage IN ('treatment_started', 'treatment_completed')));
  ELSIF v_base IN ('today_calls', 'missing_plan', 'reminders') THEN
    SELECT coalesce(array_agg(DISTINCT w.lead_id), '{}'::uuid[]) INTO v_ids
    FROM public.crm__work_items(v_clinic, v_today, v_now_local) AS w
    WHERE w.lead_id IS NOT NULL
      AND ((v_base = 'today_calls' AND w.item_type = 'call_today')
           OR (v_base = 'missing_plan' AND w.bucket = 'missing')
           OR (v_base = 'reminders' AND w.item_type = 'reminder'));
  ELSE
    SELECT coalesce(array_agg(f.lead_id), '{}'::uuid[]) INTO v_ids
    FROM public.crm__insight_flags(v_clinic, v_today, now()) AS f
    WHERE (v_base = 'waiting' AND f.is_waiting)
       OR (v_base = 'late_first' AND f.is_late_first)
       OR (v_base = 'stalled' AND f.is_stalled)
       OR (v_base = 'offers' AND f.is_offer)
       OR (v_base = 'review' AND f.is_review)
       OR (v_base = 'unknown_stage' AND f.is_unknown_stage);
  END IF;

  WITH m AS MATERIALIZED (
    SELECT l.*, row_number() OVER (ORDER BY l.full_name COLLATE "tr-x-icu", l.id) AS rn
    FROM public.leads l
    WHERE l.clinic_id = v_clinic AND l.id = ANY (v_ids) AND (v_source IS NULL OR l.source = v_source)
  )
  SELECT jsonb_build_object(
    'title_key', p_list,
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'version', m.version, 'full_name', m.full_name, 'phone', m.phone, 'stage', m.stage,
               'source', m.source, 'assigned_name', public.crm__user_name(v_clinic, m.assigned_to),
               'followup_date', m.followup_date, 'next_action', m.next_action, 'created_at', m.created_at,
               'open_task_count', (SELECT count(*) FROM public.staff_tasks t
                                   WHERE t.clinic_id = v_clinic AND t.lead_id = m.id AND t.status = 'open'))
             ORDER BY m.rn)
      FROM m WHERE m.rn > v_off AND m.rn <= v_off + v_lim), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM m)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- §5.7 Source performance, loss reasons and finance-gated ROI (RP:11-19). Archived leads are excluded here
-- (RP:13), unlike the manager cohort. Money keys are absent (not NULL) without finance / finance_readonly.
CREATE OR REPLACE FUNCTION public.crm_source_report(p_from_month text, p_to_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_money boolean := public.crm__can_read_money();
  v_from date;
  v_to date;
  v_result jsonb;
BEGIN
  IF p_from_month IS NOT NULL AND btrim(p_from_month) <> '' THEN
    v_from := public.crm__month(p_from_month, 'E_FILTER');
  END IF;
  IF p_to_month IS NOT NULL AND btrim(p_to_month) <> '' THEN
    v_to := public.crm__month(p_to_month, 'E_FILTER');
  END IF;
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_from > v_to THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;

  WITH pop AS MATERIALIZED (
    SELECT l.id, l.source, l.stage, l.loss_reason, l.patient_id
    FROM public.leads l
    WHERE l.clinic_id = v_clinic AND l.deleted_at IS NULL AND l.stage <> 'archived'
      AND (v_from IS NULL OR date_trunc('month', l.created_at AT TIME ZONE 'Europe/Istanbul')::date >= v_from)
      AND (v_to IS NULL OR date_trunc('month', l.created_at AT TIME ZONE 'Europe/Istanbul')::date <= v_to)
  ),
  srcs AS (
    SELECT x.source, x.ord
    FROM unnest(ARRAY['instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other'])
         WITH ORDINALITY AS x(source, ord)
    UNION ALL
    SELECT DISTINCT pop.source, 100::bigint
    FROM pop
    WHERE pop.source IS NULL
       OR pop.source NOT IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other')
  ),
  bs AS (
    SELECT s.source, s.ord,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source) AS leads,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source
              AND pop.stage IN ('appointment_booked', 'appointment_attended', 'offer_given', 'treatment_started',
                                'treatment_completed')) AS booked,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source
              AND pop.stage IN ('treatment_started', 'treatment_completed')) AS won,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source AND pop.stage = 'lost') AS lost
    FROM srcs s
  ),
  mny AS (
    SELECT bs.source,
           CASE WHEN v_money THEN (
             SELECT coalesce(sum(round(p.amount * 100)), 0)::bigint
             FROM public.payments p
             WHERE p.clinic_id = v_clinic AND p.status = 'paid'
               AND p.patient_id IN (SELECT DISTINCT pop.patient_id FROM pop
                                    WHERE pop.source IS NOT DISTINCT FROM bs.source AND pop.patient_id IS NOT NULL)
           ) END AS collections_cents,
           CASE WHEN v_money THEN coalesce((
             SELECT jsonb_agg(jsonb_build_object('currency', a.currency, 'amount_cents', a.total) ORDER BY a.currency)
             FROM (SELECT sp.currency, sum(sp.amount_cents)::bigint AS total
                   FROM public.crm_ad_spend sp
                   WHERE sp.clinic_id = v_clinic AND sp.source = bs.source
                     AND (v_from IS NULL OR sp.month >= v_from) AND (v_to IS NULL OR sp.month <= v_to)
                   GROUP BY sp.currency) a), '[]'::jsonb) END AS ad_spend,
           CASE WHEN v_money THEN (
             SELECT sum(sp.amount_cents)
             FROM public.crm_ad_spend sp
             WHERE sp.clinic_id = v_clinic AND sp.source = bs.source AND sp.currency = 'TRY'
               AND (v_from IS NULL OR sp.month >= v_from) AND (v_to IS NULL OR sp.month <= v_to)
           ) END AS try_spend
    FROM bs
  )
  SELECT jsonb_build_object(
    'from_month', to_char(v_from, 'YYYY-MM'),
    'to_month', to_char(v_to, 'YYYY-MM'),
    'money_visible', v_money,
    'totals', (SELECT jsonb_build_object(
                 'leads', count(*),
                 'booked', count(*) FILTER (WHERE pop.stage IN ('appointment_booked', 'appointment_attended',
                                              'offer_given', 'treatment_started', 'treatment_completed')),
                 'won', count(*) FILTER (WHERE pop.stage IN ('treatment_started', 'treatment_completed')),
                 'lost', count(*) FILTER (WHERE pop.stage = 'lost'))
               FROM pop),
    'by_source', coalesce((
      SELECT jsonb_agg(
               jsonb_build_object('source', bs.source, 'leads', bs.leads, 'booked', bs.booked, 'won', bs.won,
                                  'lost', bs.lost)
               || CASE WHEN v_money THEN jsonb_build_object(
                    'collections_cents', m.collections_cents,
                    'ad_spend', m.ad_spend,
                    'multiplier', CASE WHEN coalesce(m.try_spend, 0) > 0
                                       THEN round(m.collections_cents::numeric / m.try_spend, 2) END)
                  ELSE '{}'::jsonb END
               ORDER BY bs.ord, bs.source NULLS LAST)
      FROM bs JOIN mny m ON m.source IS NOT DISTINCT FROM bs.source), '[]'::jsonb),
    'loss_reasons', coalesce((
      SELECT jsonb_agg(jsonb_build_object('loss_reason', x.loss_reason, 'count', x.n) ORDER BY x.n DESC, x.loss_reason)
      FROM (SELECT pop.loss_reason, count(*) AS n FROM pop WHERE pop.stage = 'lost' GROUP BY pop.loss_reason) x),
      '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- §5.8 Lead table 'Hasta adayları' (CRM:93). Archived leads appear only when stage = 'archived' is selected.
CREATE OR REPLACE FUNCTION public.crm_lead_list(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_today date := public.clinic_today();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_off integer;
  v_lim integer;
  v_q text;
  v_qn text;
  v_stage text;
  v_source text;
  v_interest text;
  v_assigned uuid;
  v_missing boolean;
  v_closed boolean;
  v_sort text;
  v_result jsonb;
BEGIN
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;
  IF jsonb_typeof(v_f) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_each(v_f) AS e(k, v)
    WHERE e.k NOT IN ('q', 'stage', 'source', 'interest', 'assigned_to', 'missing_plan', 'include_closed', 'sort')
       OR (e.k IN ('q', 'stage', 'source', 'interest', 'assigned_to', 'sort') AND jsonb_typeof(e.v) NOT IN ('string', 'null'))
       OR (e.k IN ('missing_plan', 'include_closed') AND jsonb_typeof(e.v) NOT IN ('boolean', 'null'))
  ) THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;

  v_q := nullif(btrim(coalesce(v_f ->> 'q', '')), '');
  IF char_length(coalesce(v_q, '')) > 200 THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  v_qn := CASE WHEN length(regexp_replace(coalesce(v_q, ''), '[^0-9]', '', 'g')) >= 3
               THEN public.crm__normalize_phone(v_q) END;
  v_stage := nullif(v_f ->> 'stage', '');
  IF v_stage IS NOT NULL AND v_stage NOT IN ('new', 'in_contact', 'appointment_booked', 'appointment_attended',
      'offer_given', 'treatment_started', 'treatment_completed', 'lost', 'archived') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  v_source := nullif(v_f ->> 'source', '');
  v_interest := nullif(v_f ->> 'interest', '');
  IF v_interest IS NOT NULL AND v_interest NOT IN ('hot', 'warm', 'cold', 'unknown') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  IF nullif(v_f ->> 'assigned_to', '') IS NOT NULL THEN
    BEGIN
      v_assigned := (v_f ->> 'assigned_to')::uuid;
    EXCEPTION WHEN data_exception THEN
      PERFORM public.crm__raise('E_FILTER');
    END;
  END IF;
  v_missing := coalesce((v_f ->> 'missing_plan')::boolean, false);
  v_closed := coalesce((v_f ->> 'include_closed')::boolean, true);
  v_sort := coalesce(nullif(v_f ->> 'sort', ''), 'created_desc');
  IF v_sort NOT IN ('created_desc', 'followup_asc', 'name_asc') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;

  WITH m AS MATERIALIZED (
    SELECT l.id, l.full_name, l.created_at, l.followup_date
    FROM public.leads l
    WHERE l.clinic_id = v_clinic AND l.deleted_at IS NULL
      AND ((v_stage IS NULL AND l.stage <> 'archived') OR l.stage = v_stage)
      AND (v_closed OR v_stage IS NOT NULL OR l.stage NOT IN ('lost', 'treatment_completed'))
      AND (v_source IS NULL OR l.source = v_source)
      AND (v_interest IS NULL OR l.interest = v_interest)
      AND (v_assigned IS NULL OR l.assigned_to = v_assigned)
      AND (v_q IS NULL
           OR strpos(public.crm__tr_lower(l.full_name || ' ' || l.campaign), public.crm__tr_lower(v_q)) > 0
           OR (v_qn IS NOT NULL AND strpos(l.phone_normalized, v_qn) > 0))
      AND (NOT v_missing OR (
             public.crm__is_open(l.stage, l.do_not_contact, l.followup_state)
             AND NOT public.crm__visit_upcoming(v_clinic, l.id, l.patient_id, v_today)
             AND (l.followup_date IS NULL OR btrim(l.next_action) = '')
             AND NOT public.crm__call_upcoming(v_clinic, l.id, v_today)))
  ),
  o AS MATERIALIZED (
    SELECT m.id,
           row_number() OVER (ORDER BY
             CASE WHEN v_sort = 'created_desc' THEN m.created_at END DESC NULLS LAST,
             CASE WHEN v_sort = 'followup_asc' THEN m.followup_date END ASC NULLS LAST,
             (CASE WHEN v_sort = 'name_asc' THEN m.full_name END) COLLATE "tr-x-icu" ASC NULLS LAST,
             m.created_at DESC, m.id) AS rn
    FROM m
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(public.crm__lead_json(v_clinic, o.id, v_today) ORDER BY o.rn)
                      FROM o WHERE o.rn > v_off AND o.rn <= v_off + v_lim), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM o)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- §5.9 Live duplicate warning for the lead card and the patient forms (CRM:53, CRM:108). Warning only.
CREATE OR REPLACE FUNCTION public.crm_phone_matches(
  p_phone text,
  p_exclude_lead_id uuid DEFAULT NULL,
  p_exclude_patient_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
BEGIN
  RETURN public.crm__phone_matches(v_clinic, p_phone, p_exclude_lead_id, p_exclude_patient_id);
END;
$$;

-- §5.10 Lead card. Trashed leads are readable here (trash panel; the UI renders them read-only).
CREATE OR REPLACE FUNCTION public.crm_lead_detail(p_lead_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_mgr boolean := public.crm_can_manage();
  v_task_all boolean := public.crm_can_manage();
  v_patient uuid;
  v_result jsonb;
BEGIN
  SELECT l.patient_id INTO v_patient FROM public.leads l WHERE l.id = p_lead_id AND l.clinic_id = v_clinic;
  IF NOT FOUND THEN
    PERFORM public.crm__raise('E_LEAD_NOT_FOUND');
  END IF;

  SELECT jsonb_build_object(
    'lead', public.crm__lead_json(v_clinic, p_lead_id, v_today),
    'activities', coalesce((
      SELECT jsonb_agg(public.crm__activity_json(s.a, v_mgr) ORDER BY s.created_at, s.seq)
      FROM (SELECT x AS a, x.created_at, x.seq
            FROM public.lead_activities x
            WHERE x.clinic_id = v_clinic AND x.lead_id = p_lead_id AND (NOT x.is_private OR v_mgr)
            ORDER BY x.created_at DESC, x.seq DESC
            LIMIT 300) s), '[]'::jsonb),
    'activities_total', (SELECT count(*) FROM public.lead_activities x
                         WHERE x.clinic_id = v_clinic AND x.lead_id = p_lead_id AND (NOT x.is_private OR v_mgr)),
    'calls', coalesce((
      SELECT jsonb_agg(public.crm__call_json(v_clinic, c.id)
                       ORDER BY c.scheduled_date DESC, c.scheduled_time DESC, c.created_at DESC, c.id)
      FROM public.crm_calls c WHERE c.clinic_id = v_clinic AND c.lead_id = p_lead_id), '[]'::jsonb),
    'due_call', (
      SELECT public.crm__call_json(v_clinic, c.id)
      FROM public.crm_calls c
      WHERE c.clinic_id = v_clinic AND c.lead_id = p_lead_id AND c.status = 'planned' AND c.scheduled_date <= v_today
      ORDER BY c.scheduled_date, c.scheduled_time, c.id
      LIMIT 1),
    'last_notes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('text', n.description, 'at', n.created_at, 'actor_name', n.actor_name)
                       ORDER BY n.created_at DESC, n.seq DESC)
      FROM (SELECT x.description, x.created_at, x.seq,
                   coalesce(public.crm__user_name(v_clinic, x.created_by), x.actor_name) AS actor_name
            FROM public.lead_activities x
            WHERE x.clinic_id = v_clinic AND x.lead_id = p_lead_id AND NOT x.is_private
              AND x.activity_type IN ('note', 'legacy')
            ORDER BY x.created_at DESC, x.seq DESC
            LIMIT 3) n), '[]'::jsonb),
    'handoffs', coalesce((
      SELECT jsonb_agg(public.crm__handoff_json(v_clinic, h.id, v_mgr) ORDER BY h.requested_at DESC, h.id)
      FROM public.crm_handoffs h WHERE h.clinic_id = v_clinic AND h.lead_id = p_lead_id), '[]'::jsonb),
    'appointments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id, 'start_time', a.start_time, 'end_time', a.end_time, 'status', a.status,
               'doctor_name', public.crm__doctor_name(v_clinic, a.doctor_id), 'chair_name', ch.name,
               'reminder_outcome', a.reminder_outcome,
               'reminder_current', public.crm__reminder_current(a.status::text, a.reminder_outcome,
                                     a.reminder_start_time, a.start_time, a.reminder_doctor_id, a.doctor_id))
             ORDER BY a.start_time, a.id)
      FROM (
        (SELECT x.* FROM public.appointments x
         WHERE x.clinic_id = v_clinic AND (x.patient_id = v_patient OR x.lead_id = p_lead_id) AND x.start_time >= now())
        UNION ALL
        (SELECT x.* FROM public.appointments x
         WHERE x.clinic_id = v_clinic AND (x.patient_id = v_patient OR x.lead_id = p_lead_id) AND x.start_time < now()
         ORDER BY x.start_time DESC
         LIMIT 10)
      ) a
      LEFT JOIN public.chairs ch ON ch.id = a.chair_id AND ch.clinic_id = a.clinic_id), '[]'::jsonb),
    'tasks', coalesce((
      SELECT jsonb_agg(public.crm__task_json(v_clinic, t.id, v_today) ORDER BY t.due_date, t.created_at)
      FROM public.staff_tasks t
      WHERE t.clinic_id = v_clinic AND t.lead_id = p_lead_id AND t.status = 'open'
        AND (t.assignee_user_id = v_me OR t.created_by = v_me OR v_task_all)), '[]'::jsonb),
    'rules', public.crm__rules_json(public.crm__rules(v_clinic)),
    'can_manage', v_mgr
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- §5.11 Trash list (TR:12-16).
CREATE OR REPLACE FUNCTION public.crm_trash_list(p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_off integer;
  v_lim integer;
  v_result jsonb;
BEGIN
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;
  WITH m AS MATERIALIZED (
    SELECT l.id, l.version, l.full_name, l.phone, l.stage, l.deleted_at, l.deleted_by,
           row_number() OVER (ORDER BY l.deleted_at DESC, l.id) AS rn
    FROM public.leads l
    WHERE l.clinic_id = v_clinic AND l.deleted_at IS NOT NULL
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'version', m.version, 'full_name', m.full_name, 'phone', m.phone, 'stage', m.stage,
               'deleted_at', m.deleted_at, 'deleted_by_name', public.crm__user_name(v_clinic, m.deleted_by),
               'call_count', (SELECT count(*) FROM public.crm_calls c WHERE c.clinic_id = v_clinic AND c.lead_id = m.id))
             ORDER BY m.rn)
      FROM m WHERE m.rn > v_off AND m.rn <= v_off + v_lim), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM m)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- Owner JSON export (settings/export, owner decision 3: it is the clinic's only backup). Direct reads hide
-- trashed leads and their history, calls and handoffs (RLS, RR:21), so the export fetches those rows here, keyset
-- paged on id. Owner role only; rows of the caller's clinic only; read-only.
CREATE OR REPLACE FUNCTION public.crm_export_trashed(p_table text, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_lim integer := coalesce(p_limit, 500);
  v_rows jsonb;
BEGIN
  IF NOT coalesce(public.current_app_role() = 'owner', false) THEN
    PERFORM public.crm__raise('E_EXPORT');
  END IF;
  IF p_table IS NULL OR p_table NOT IN ('leads', 'lead_activities', 'crm_calls', 'crm_handoffs')
     OR v_lim NOT BETWEEN 1 AND 1000 THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;

  IF p_table = 'leads' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) INTO v_rows
    FROM (SELECT l.* FROM public.leads l
          WHERE l.clinic_id = v_clinic AND l.deleted_at IS NOT NULL AND (p_after IS NULL OR l.id > p_after)
          ORDER BY l.id LIMIT v_lim) x;
  ELSIF p_table = 'lead_activities' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) INTO v_rows
    FROM (SELECT a.* FROM public.lead_activities a
          JOIN public.leads l ON l.id = a.lead_id AND l.clinic_id = v_clinic AND l.deleted_at IS NOT NULL
          WHERE a.clinic_id = v_clinic AND (p_after IS NULL OR a.id > p_after)
          ORDER BY a.id LIMIT v_lim) x;
  ELSIF p_table = 'crm_calls' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) INTO v_rows
    FROM (SELECT c.* FROM public.crm_calls c
          JOIN public.leads l ON l.id = c.lead_id AND l.clinic_id = v_clinic AND l.deleted_at IS NOT NULL
          WHERE c.clinic_id = v_clinic AND (p_after IS NULL OR c.id > p_after)
          ORDER BY c.id LIMIT v_lim) x;
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) INTO v_rows
    FROM (SELECT h.* FROM public.crm_handoffs h
          JOIN public.leads l ON l.id = h.lead_id AND l.clinic_id = v_clinic AND l.deleted_at IS NOT NULL
          WHERE h.clinic_id = v_clinic AND (p_after IS NULL OR h.id > p_after)
          ORDER BY h.id LIMIT v_lim) x;
  END IF;

  RETURN jsonb_build_object(
    'table', p_table,
    'rows', v_rows,
    'next_after', CASE WHEN jsonb_array_length(v_rows) = v_lim THEN v_rows -> -1 ->> 'id' END);
END;
$$;

-- Row counts of every CRM table of the clinic, trashed rows included, so the export can prove it read everything
-- (direct reads + crm_export_trashed). crm_ad_spend only with finance / finance_readonly. Owner role only.
CREATE OR REPLACE FUNCTION public.crm_export_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_result jsonb;
BEGIN
  IF NOT coalesce(public.current_app_role() = 'owner', false) THEN
    PERFORM public.crm__raise('E_EXPORT');
  END IF;
  SELECT jsonb_build_object(
    'leads', (SELECT count(*) FROM public.leads WHERE clinic_id = v_clinic),
    'leads_trashed', (SELECT count(*) FROM public.leads WHERE clinic_id = v_clinic AND deleted_at IS NOT NULL),
    'lead_activities', (SELECT count(*) FROM public.lead_activities WHERE clinic_id = v_clinic),
    'crm_calls', (SELECT count(*) FROM public.crm_calls WHERE clinic_id = v_clinic),
    'crm_handoffs', (SELECT count(*) FROM public.crm_handoffs WHERE clinic_id = v_clinic),
    'crm_handoff_private_notes', (SELECT count(*) FROM public.crm_handoff_private_notes WHERE clinic_id = v_clinic),
    'staff_tasks', (SELECT count(*) FROM public.staff_tasks WHERE clinic_id = v_clinic),
    'crm_followup_rules', (SELECT count(*) FROM public.crm_followup_rules WHERE clinic_id = v_clinic),
    'appointment_reminder_logs', (SELECT count(*) FROM public.appointment_reminder_logs WHERE clinic_id = v_clinic))
    || CASE WHEN public.crm__can_read_money()
            THEN jsonb_build_object('crm_ad_spend', (SELECT count(*) FROM public.crm_ad_spend WHERE clinic_id = v_clinic))
            ELSE '{}'::jsonb END
    INTO v_result;
  RETURN v_result;
END;
$$;

-- Handoff inbox (HI:11-17): leads that are archived, completed or trashed are left out (HI:6, D-HO:7).
-- Default tab: 'waiting' for CRM managers, 'answered' for everyone else (HI:12).
CREATE OR REPLACE FUNCTION public.crm_handoff_list(p_status text, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_mgr boolean := public.crm_can_manage();
  v_status text := coalesce(nullif(p_status, ''), CASE WHEN public.crm_can_manage() THEN 'waiting' ELSE 'answered' END);
  v_off integer;
  v_lim integer;
  v_result jsonb;
BEGIN
  IF v_status NOT IN ('waiting', 'answered', 'completed', 'cancelled') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;

  WITH base AS MATERIALIZED (
    SELECT h.id, h.status, h.answer_due_date, h.requested_at
    FROM public.crm_handoffs h
    JOIN public.leads l ON l.id = h.lead_id
    WHERE h.clinic_id = v_clinic AND l.deleted_at IS NULL AND l.stage NOT IN ('archived', 'treatment_completed')
  ),
  sel AS MATERIALIZED (
    SELECT base.id,
           row_number() OVER (ORDER BY coalesce(base.answer_due_date, (base.requested_at AT TIME ZONE 'Europe/Istanbul')::date),
                                       base.requested_at, base.id) AS rn
    FROM base WHERE base.status = v_status
  )
  SELECT jsonb_build_object(
    'status', v_status,
    'rows', coalesce((SELECT jsonb_agg(public.crm__handoff_json(v_clinic, sel.id, v_mgr) ORDER BY sel.rn)
                      FROM sel WHERE sel.rn > v_off AND sel.rn <= v_off + v_lim), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM sel),
    'counts', (SELECT jsonb_build_object(
                 'waiting', count(*) FILTER (WHERE base.status = 'waiting'),
                 'answered', count(*) FILTER (WHERE base.status = 'answered'),
                 'completed', count(*) FILTER (WHERE base.status = 'completed'),
                 'cancelled', count(*) FILTER (WHERE base.status = 'cancelled'))
               FROM base)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- Staff task lists (TMU:16-19). 'all' needs a CRM manager (owner or crm_manage).
CREATE OR REPLACE FUNCTION public.staff_task_list(p_scope text, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_off integer;
  v_lim integer;
  v_result jsonb;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('mine', 'created', 'all') THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;
  IF p_scope = 'all' AND NOT public.crm_can_manage() THEN
    PERFORM public.crm__raise('E_TASK_ROLE');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_off, v_lim FROM public.crm__page(p_page) AS pg;

  WITH base AS MATERIALIZED (
    SELECT t.id, t.status, t.due_date, t.created_at, t.read_at,
           row_number() OVER (ORDER BY (t.status = 'open') DESC, t.due_date, t.created_at DESC, t.id) AS rn
    FROM public.staff_tasks t
    WHERE t.clinic_id = v_clinic
      AND (p_scope = 'all'
           OR (p_scope = 'mine' AND t.assignee_user_id = v_me)
           OR (p_scope = 'created' AND t.created_by = v_me))
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(public.crm__task_json(v_clinic, base.id, v_today) ORDER BY base.rn)
                      FROM base WHERE base.rn > v_off AND base.rn <= v_off + v_lim), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM base),
    'counts', (SELECT jsonb_build_object(
                 'open', count(*) FILTER (WHERE base.status = 'open'),
                 'unread', count(*) FILTER (WHERE base.status = 'open' AND base.read_at IS NULL),
                 'overdue', count(*) FILTER (WHERE base.status = 'open' AND base.due_date < v_today))
               FROM base)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Pure helpers over REST (rules part §0.4): the legacy pure functions with an explicit "now", so the automatic
-- plan can be checked against the legacy literals. They read no table; staff session required.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.crm__require_staff();
  RETURN public.crm__normalize_phone(p_phone);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_next_working_slot(p_day date, p_rules jsonb, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.crm_followup_rules;
  v_slot record;
BEGIN
  PERFORM public.crm__require_staff();
  IF p_day IS NULL OR p_now IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'p_day, p_now');
  END IF;
  r := public.crm__rules_from_json(public.crm__rules(NULL::uuid), coalesce(p_rules, '{}'::jsonb), false);
  SELECT * INTO v_slot
  FROM public.crm__next_working_slot(public.crm__day(p_day), r,
                                     date_trunc('minute', p_now AT TIME ZONE 'Europe/Istanbul'));
  RETURN jsonb_build_object('date', v_slot.o_date, 'time', public.crm__fmt_time(v_slot.o_time));
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_working_minutes(p_from timestamptz, p_to timestamptz, p_rules jsonb)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.crm_followup_rules;
BEGIN
  PERFORM public.crm__require_staff();
  r := public.crm__rules_from_json(public.crm__rules(NULL::uuid), coalesce(p_rules, '{}'::jsonb), false);
  RETURN public.crm__working_minutes(p_from, p_to, r);
END;
$$;

-- p_input = {lead:{do_not_contact, followup_state, stage, open_visit, followup_date, next_action}, status, result,
--            rules:{...}, pending:[{id, date, time}], unreachable}
CREATE OR REPLACE FUNCTION public.crm_auto_plan(p_input jsonb, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_in jsonb := coalesce(p_input, '{}'::jsonb);
  v_lead jsonb;
  r public.crm_followup_rules;
  v_status text;
  v_result text;
  v_local timestamp;
  v_pending_id text;
  v_pending_date date;
  v_pending_time time;
  v_unreachable bigint;
BEGIN
  PERFORM public.crm__require_staff();
  IF jsonb_typeof(v_in) <> 'object' OR p_now IS NULL THEN
    PERFORM public.crm__raise('E_FIELDS', 'p_input, p_now');
  END IF;
  v_lead := coalesce(v_in -> 'lead', '{}'::jsonb);
  IF jsonb_typeof(v_lead) <> 'object' THEN
    PERFORM public.crm__raise('E_FIELDS', 'lead');
  END IF;
  r := public.crm__rules_from_json(public.crm__rules(NULL::uuid),
         CASE WHEN jsonb_typeof(v_in -> 'rules') = 'object' THEN v_in -> 'rules' ELSE '{}'::jsonb END, false);
  v_status := public.crm__j_text(v_in, 'status');
  IF v_status IS NULL OR v_status NOT IN ('reached', 'unreachable', 'cancelled') THEN
    PERFORM public.crm__raise('E_STATUS');
  END IF;
  v_result := public.crm__j_text(v_in, 'result');
  v_unreachable := coalesce(public.crm__j_bigint(v_in, 'unreachable'), 0);
  v_local := date_trunc('minute', p_now AT TIME ZONE 'Europe/Istanbul');

  IF jsonb_typeof(v_in -> 'pending') = 'array' THEN
    BEGIN
      SELECT e.value ->> 'id', (e.value ->> 'date')::date, (e.value ->> 'time')::time
        INTO v_pending_id, v_pending_date, v_pending_time
      FROM jsonb_array_elements(v_in -> 'pending') AS e(value)
      ORDER BY (e.value ->> 'date')::date, (e.value ->> 'time')::time, e.value ->> 'id'
      LIMIT 1;
    EXCEPTION WHEN data_exception THEN
      PERFORM public.crm__raise('E_FIELDS', 'pending');
    END;
  END IF;

  RETURN public.crm__auto_plan_core(
    coalesce(public.crm__j_bool(v_lead, 'do_not_contact'), false),
    coalesce(public.crm__j_text(v_lead, 'followup_state'), 'open'),
    coalesce(public.crm__j_text(v_lead, 'stage'), 'new'),
    coalesce(public.crm__j_bool(v_lead, 'open_visit'), false),
    public.crm__j_date(v_lead, 'followup_date'),
    coalesce(public.crm__j_text(v_lead, 'next_action'), ''),
    v_status, v_result, r,
    v_pending_id, v_pending_date, v_pending_time,
    v_unreachable::integer, v_local::date, v_local);
END;
$$;

-- ---------------------------------------------------------------------------
-- §6.1 Seeds: one rules row per existing clinic with the legacy defaults (FU:15: Mon-Sat, 09:00-18:00, call at
--      10:00, 1/1/3/7/7 days, 3 unreachable, first call 60 min, stale 7, offer 3). New clinics fall back to the
--      same defaults (crm__rules, version 0) until a manager saves. Nothing else is seeded: no staff names, no
--      sample leads, no ad spend.
-- ---------------------------------------------------------------------------
INSERT INTO public.crm_followup_rules (clinic_id)
SELECT c.id FROM public.clinics c
ON CONFLICT (clinic_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- §6.2 Function privileges and self-checks (0020 fin__harden_privileges pattern). PostgreSQL grants EXECUTE to
--      PUBLIC on every new function (and Supabase's default privileges add anon and authenticated); CREATE OR
--      REPLACE keeps the ACL, but a new overload or a DROP + CREATE does not. Every crm_* / crm__* / staff_task_*
--      function loses EXECUTE from PUBLIC, anon and authenticated; public RPCs (single underscore) are then
--      granted to authenticated; internal helpers (crm__*) never are. Runs as the migration owner; never granted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm__harden_privileges()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_f record;
  v_bad text;
BEGIN
  FOR v_f IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'crm\_%' OR p.proname LIKE 'staff\_task\_%')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_f.sig);
    IF v_f.proname NOT LIKE 'crm\_\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_f.sig);
    END IF;
  END LOOP;

  -- No overloads (contract §1.3).
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'crm\_%' OR p.proname LIKE 'staff\_task\_%')
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'crm_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- Every public RPC (crm_can_manage, staff_task_* included) is SECURITY DEFINER with search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND ((p.proname LIKE 'crm\_%' AND p.proname NOT LIKE 'crm\_\_%') OR p.proname LIKE 'staff\_task\_%')
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  -- Internal helpers fail closed: only trigger functions may be SECURITY DEFINER.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'crm\_\_%'
    AND p.prosecdef AND p.prorettype <> 'trigger'::regtype;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar SECURITY DEFINER olmamalı: %', v_bad;
  END IF;

  -- No internal helper is callable from the API, and anon can call nothing.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.proname LIKE 'crm\_%' OR p.proname LIKE 'staff\_task\_%')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR (p.proname LIKE 'crm\_\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar API''ye açık: %', v_bad;
  END IF;

  -- New tables: SELECT only for authenticated, nothing for anon. lead_activities: no client writes.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['crm_calls', 'crm_followup_rules', 'crm_handoffs', 'crm_handoff_private_notes', 'staff_tasks',
                    'crm_ad_spend', 'appointment_reminder_logs']) AS t(tbl)
  WHERE has_table_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', format('public.%I', t.tbl), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', t.tbl), 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CRM tablo yetkileri beklenen gibi değil: %', v_bad;
  END IF;
  IF has_table_privilege('authenticated', 'public.lead_activities', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_any_column_privilege('authenticated', 'public.lead_activities', 'INSERT, UPDATE')
     OR has_table_privilege('anon', 'public.lead_activities', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'lead_activities yazma yetkileri kaldırılmamış.';
  END IF;
END;
$$;

SELECT public.crm__harden_privileges();

-- ---------------------------------------------------------------------------
-- §6.3 Migration-specific self-checks. Any failure RAISEs and rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_n bigint;
BEGIN
  -- 1. The patients phone uniqueness is gone; the normalized index exists.
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.patients'::regclass AND i.indisunique
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
             FROM unnest(i.indkey::smallint[]) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ARRAY['clinic_id', 'phone']
  ) THEN
    RAISE EXCEPTION 'Öz denetim: patients (clinic_id, phone) üzerinde benzersizlik kaldı.';
  END IF;
  IF to_regclass('public.idx_patients_clinic_phone_normalized') IS NULL THEN
    RAISE EXCEPTION 'Öz denetim: idx_patients_clinic_phone_normalized yok.';
  END IF;

  -- 2. Backfill complete.
  SELECT count(*) INTO v_n FROM public.leads
  WHERE stage IS NULL OR phone_normalized IS DISTINCT FROM public.crm__normalize_phone(phone);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Öz denetim: % hasta adayında aşama veya normalize telefon eksik.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.patients
  WHERE phone_normalized IS DISTINCT FROM public.crm__normalize_phone(phone);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Öz denetim: % hastada normalize telefon eksik.', v_n;
  END IF;

  -- 3. Every clinic has its rules row.
  SELECT string_agg(c.id::text, ', ') INTO v_bad
  FROM public.clinics c
  WHERE NOT EXISTS (SELECT 1 FROM public.crm_followup_rules r WHERE r.clinic_id = c.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: takip kuralı olmayan klinikler: %', v_bad;
  END IF;

  -- 4. Privileges: leads is read-only for clients (no compat window), RPC-only reminder columns on appointments.
  IF has_table_privilege('authenticated', 'public.leads', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_any_column_privilege('authenticated', 'public.leads', 'INSERT, UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.leads', 'SELECT')
     OR has_table_privilege('anon', 'public.leads', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR EXISTS (SELECT 1 FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = 'leads' AND p.cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'Öz denetim: leads yalnızca okunabilir olmalı (yazma yetkisi veya yazma politikası kaldı).';
  END IF;
  IF has_column_privilege('authenticated', 'public.appointments', 'reminder_outcome', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.appointments', 'reminded_by', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.appointments', 'lead_id', 'INSERT')
     OR has_column_privilege('authenticated', 'public.appointments', 'lead_id', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.appointments', 'status', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.appointments', 'start_time', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.appointments', 'notes', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.appointments', 'patient_id', 'INSERT') THEN
    RAISE EXCEPTION 'Öz denetim: appointments sütun yetkileri beklenen gibi değil.';
  END IF;

  -- 5. RLS on, exactly one SELECT policy and no write policy on every new table; none on lead_activities.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['crm_calls', 'crm_followup_rules', 'crm_handoffs', 'crm_handoff_private_notes', 'staff_tasks',
                    'crm_ad_spend', 'appointment_reminder_logs']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd <> 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: RLS / politika yapısı beklenen gibi değil: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = 'lead_activities' AND p.cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'Öz denetim: lead_activities yazma politikası kaldı.';
  END IF;

  -- 7. crm__normalize_phone golden values (tests/contact.test.mjs, WF:3; rules A1).
  SELECT string_agg(format('%s -> %s (beklenen %s)', g.i, public.crm__normalize_phone(g.i), g.o), '; ') INTO v_bad
  FROM (VALUES
    ('0532 123 45 67', '905321234567'),
    ('532 123 4567', '905321234567'),
    ('0090 532 123 45 67', '905321234567'),
    ('+90 (532) 123-45-67', '905321234567'),
    ('00905551234567', '905551234567'),
    ('+44 7700 900123', '447700900123'),
    ('0212 555 00 11', '902125550011'),
    ('00 44 20 7946 0958', '442079460958'),
    ('12345', '12345'),
    ('abc', '')
  ) AS g(i, o)
  WHERE public.crm__normalize_phone(g.i) IS DISTINCT FROM g.o;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: telefon normalizasyonu: %', v_bad;
  END IF;
END $$;

-- 8. Pure engine replay with fixed dates and the default rules (tests/followup-automation.test.mjs; contract §6.3
--    item 8; rules A2-A4). No table writes.
DO $$
DECLARE
  r public.crm_followup_rules := public.crm__rules(NULL::uuid);
  v_today date := DATE '2026-10-15';            -- Thursday
  v_now timestamp := TIMESTAMP '2026-10-15 11:00';
  v_sat_today date := DATE '2026-09-19';        -- Saturday
  v_sat timestamp := TIMESTAMP '2026-09-19 11:00';
  v_plan jsonb;
  v_slot record;
  v_err text;
  v_fail text[] := '{}'::text[];
  v_case record;
BEGIN
  -- Automatic plan (contract §6.3 item 8).
  FOR v_case IN
    SELECT * FROM (VALUES
      ('unreachable n=1', 'unreachable', 'unreachable', 1, 'call', '2026-10-16'),
      ('considering_price', 'reached', 'considering_price', 0, 'call', '2026-10-19'),
      ('will_think_later', 'reached', 'will_think_later', 0, 'call', '2026-10-22'),
      ('unreachable n=3', 'unreachable', 'unreachable', 3, 'review', NULL)
    ) AS t(label, st, res, n, kind, d)
  LOOP
    v_plan := public.crm__auto_plan_core(false, 'open', 'in_contact', false, NULL, '', v_case.st, v_case.res, r,
                                         NULL, NULL, NULL, v_case.n, v_today, v_now);
    IF v_plan ->> 'kind' IS DISTINCT FROM v_case.kind
       OR (v_case.d IS NOT NULL AND (v_plan ->> 'date' IS DISTINCT FROM v_case.d OR v_plan ->> 'time' <> '10:00')) THEN
      v_fail := v_fail || format('%s: %s', v_case.label, v_plan);
    END IF;
  END LOOP;
  BEGIN
    v_plan := public.crm__auto_plan_core(false, 'open', 'in_contact', false, NULL, '', 'reached', 'unspecified', r,
                                         NULL, NULL, NULL, 0, v_today, v_now);
    v_fail := v_fail || ('unspecified: hata bekleniyordu ' || v_plan::text);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err <> 'Otomatik takip için görüşme sonucunu seçin veya hastanın istediği tarihi belirtin.' THEN
      v_fail := v_fail || ('unspecified: ' || v_err);
    END IF;
  END;

  -- Rules A3 (now = Saturday 2026-09-19 11:00).
  v_plan := public.crm__auto_plan_core(false, 'open', 'in_contact', false, DATE '2026-09-20', 'Hasta Pazar istedi',
                                       'unreachable', 'unreachable', r, NULL, NULL, NULL, 1, v_sat_today, v_sat);
  IF v_plan ->> 'kind' <> 'call' OR v_plan ->> 'date' <> '2026-09-20' OR v_plan ->> 'action' <> 'Hasta Pazar istedi' THEN
    v_fail := v_fail || ('P2: ' || v_plan::text);
  END IF;
  v_plan := public.crm__auto_plan_core(false, 'open', 'in_contact', false, NULL, '', 'unreachable', 'unreachable', r,
                                       'p1', DATE '2026-09-23', TIME '09:00', 3, v_sat_today, v_sat);
  IF v_plan ->> 'kind' <> 'keep' OR v_plan ->> 'keep_call_id' <> 'p1' THEN
    v_fail := v_fail || ('P16: ' || v_plan::text);
  END IF;
  v_plan := public.crm__auto_plan_core(false, 'open', 'offer_given', false, NULL, '', 'reached', 'comparing_clinics', r,
                                       NULL, NULL, NULL, 0, v_sat_today, v_sat);
  IF v_plan ->> 'kind' <> 'call' OR v_plan ->> 'date' <> '2026-09-22' THEN
    v_fail := v_fail || ('P9: ' || v_plan::text);
  END IF;
  v_plan := public.crm__auto_plan_core(false, 'open', 'in_contact', false, NULL, '', 'reached', 'considering_timing', r,
                                       NULL, NULL, NULL, 0, v_sat_today, v_sat);
  IF v_plan ->> 'kind' <> 'call' OR v_plan ->> 'date' <> '2026-09-26' THEN
    v_fail := v_fail || ('P12: ' || v_plan::text);
  END IF;
  v_plan := public.crm__auto_plan_core(true, 'open', 'in_contact', false, NULL, '', 'reached', 'considering_price', r,
                                       NULL, NULL, NULL, 0, v_sat_today, v_sat);
  IF v_plan ->> 'kind' <> 'stop' THEN
    v_fail := v_fail || ('P4: ' || v_plan::text);
  END IF;

  -- Next working slot (rules A2): a slot in the current minute is not later.
  SELECT * INTO v_slot FROM public.crm__next_working_slot(DATE '2026-09-20', r, v_sat);
  IF v_slot.o_date <> DATE '2026-09-21' THEN v_fail := v_fail || ('A2.1: ' || v_slot.o_date::text); END IF;
  SELECT * INTO v_slot FROM public.crm__next_working_slot(DATE '2026-09-21', r, TIMESTAMP '2026-09-21 09:59');
  IF v_slot.o_date <> DATE '2026-09-21' THEN v_fail := v_fail || ('A2.2: ' || v_slot.o_date::text); END IF;
  SELECT * INTO v_slot FROM public.crm__next_working_slot(DATE '2026-09-21', r, TIMESTAMP '2026-09-21 10:00');
  IF v_slot.o_date <> DATE '2026-09-22' THEN v_fail := v_fail || ('A2.3: ' || v_slot.o_date::text); END IF;
  SELECT * INTO v_slot FROM public.crm__next_working_slot(DATE '2026-09-21', r, TIMESTAMP '2026-09-21 10:00:30');
  IF v_slot.o_date <> DATE '2026-09-22' THEN v_fail := v_fail || ('A2.4: ' || v_slot.o_date::text); END IF;

  -- Working minutes (rules A4): numeric rounding, closed Sunday, 3660-day cap.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('A4.1', TIMESTAMPTZ '2026-09-19 14:30:00+00', TIMESTAMPTZ '2026-09-21 06:30:00+00', 60),
      ('A4.2', TIMESTAMPTZ '2026-09-18 06:00:00+00', TIMESTAMPTZ '2026-09-18 06:30:00+00', 30),
      ('A4.3', TIMESTAMPTZ '2026-09-21 03:00:00+00', TIMESTAMPTZ '2026-09-21 05:00:00+00', 0),
      ('A4.4', TIMESTAMPTZ '2026-09-21 06:00:00+00', TIMESTAMPTZ '2026-09-21 06:00:29+00', 0),
      ('A4.5', TIMESTAMPTZ '2026-09-21 06:00:00+00', TIMESTAMPTZ '2026-09-21 06:00:30+00', 1),
      ('A4.6', TIMESTAMPTZ '2026-09-21 07:00:00+00', TIMESTAMPTZ '2026-09-21 06:00:00+00', NULL),
      ('A4.7', TIMESTAMPTZ '2016-01-01 00:00:00+00', TIMESTAMPTZ '2026-09-19 08:00:00+00', NULL),
      ('A4.8', TIMESTAMPTZ '2026-09-18 06:00:00+00', TIMESTAMPTZ '2026-09-21 07:00:00+00', 1140)
    ) AS t(label, f, u, expected)
  LOOP
    IF public.crm__working_minutes(v_case.f, v_case.u, r) IS DISTINCT FROM v_case.expected THEN
      v_fail := v_fail || format('%s: %s', v_case.label, public.crm__working_minutes(v_case.f, v_case.u, r));
    END IF;
  END LOOP;

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'Öz denetim (takip motoru): %', array_to_string(v_fail, ' | ');
  END IF;
END $$;

-- 6. Mapping replay through the compat path (the current UI writes status only), inside a block that is always
--    rolled back. Uses the first clinic; skipped when there is none.
DO $$
DECLARE
  v_clinic uuid;
  v_id uuid := gen_random_uuid();
  l public.leads;
  v_n bigint;
BEGIN
  SELECT c.id INTO v_clinic FROM public.clinics c ORDER BY c.created_at, c.id LIMIT 1;
  IF v_clinic IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.leads (id, clinic_id, full_name, phone, status)
    VALUES (v_id, v_clinic, 'Öz denetim kaydı', '0532 000 00 00', 'qualified');
    SELECT * INTO l FROM public.leads WHERE id = v_id;
    IF l.stage <> 'in_contact' OR l.interest <> 'hot' OR l.stage_entered_at IS NULL
       OR l.phone_normalized <> '905320000000' OR l.status::text <> 'qualified' OR l.version <> 1 THEN
      RAISE EXCEPTION 'Öz denetim: durum -> aşama eşlemesi (ekleme) hatalı: %', to_jsonb(l);
    END IF;

    UPDATE public.leads SET status = 'lost' WHERE id = v_id;
    SELECT * INTO l FROM public.leads WHERE id = v_id;
    SELECT count(*) INTO v_n FROM public.lead_activities WHERE lead_id = v_id AND activity_type = 'stage';
    IF l.stage <> 'lost' OR l.loss_reason IS DISTINCT FROM 'other' OR l.version <> 2 OR v_n <> 1 THEN
      RAISE EXCEPTION 'Öz denetim: durum -> aşama eşlemesi (güncelleme) hatalı: % / % aşama kaydı', to_jsonb(l), v_n;
    END IF;

    UPDATE public.leads SET stage = 'appointment_booked' WHERE id = v_id;
    SELECT * INTO l FROM public.leads WHERE id = v_id;
    IF l.status::text <> 'qualified' OR l.loss_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Öz denetim: aşama -> durum eşlemesi hatalı: %', to_jsonb(l);
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'crm_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;
END $$;

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
