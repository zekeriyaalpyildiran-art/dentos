-- Phase 10: Platform (staff management, e-mail invitations, audit history, patient archive). Safe to re-run.
--
-- Contract: spec_parts/p10_platform.md §1-§2 (error keys, RPCs, JSON shapes, acceptance). Requires 0019 (users_guard,
-- audit_row_change, staff_permissions, has_permission). Independent of 0020-0026 objects (none is changed here).
--
--  2.1 Preflight: helper functions, users_guard, column shapes, auth.users columns and SELECT right, user_role labels,
--      service_role, tr-x-icu. The audit_logs policy names are captured so the end can prove none was added/dropped.
--  2.2 Internals plt__*: plt__raise (every Turkish text, key in HINT), e-mail predicates (shared vectors §6.3), caller,
--      login JSON (auth.users read only by id, only from definer functions), staff item JSON, finance-lock predicate.
--  2.3 Index idx_audit_logs_clinic_created_id (keyset paging of /settings/audit).
--  2.4 Public RPCs (SECURITY DEFINER, authenticated only): plt_staff_list, plt_staff_save, plt_patient_set_active.
--  2.5 Service-role functions (Edge Function invite-staff and the harness only): plt_svc_invite_context,
--      plt_svc_link_auth_user, plt_svc_log_staff_event.
--  2.6 Trigger plt_patient_active_guard: patients.is_active changes only through plt_patient_set_active for API users,
--      and an API user cannot insert an archived patient.
--  2.6b Trigger plt_users_email_guard (review fix, see below).
--  2.7 doctors gets the standard audit_row_change trigger.
--  2.8 plt__harden_privileges(): EXECUTE revoked from PUBLIC / anon / authenticated on every plt_* function; public
--      RPCs granted to authenticated, plt_svc_* to service_role only, internals never; then self-checks.
--  2.9 Self-checks (RAISE rolls everything back), including a rolled-back replay in a temporary clinic.
--
-- Error contract (as 0020-0026): RAISE USING MESSAGE = <Turkish text>, ERRCODE = 42501 (403), PT404 (404), PT409
-- (409) or P0001 (400), HINT = key (PLT_*). Errors raised by users_guard (no HINT) pass through plt_staff_save.
--
-- Deliberate additions to the spec (security review of the Phase 10 deliverables):
--   * Finance escalation guard. 0019 lets only the owner or a 'finance' holder grant finance / finance_readonly or
--     reactivate a finance holder. An unlinked staff row can hold such grants, so changing its e-mail and inviting it
--     would hand a finance login to whoever controls the new address. Therefore, unless the caller is the owner or
--     holds an active 'finance' grant (checked by users.id, the service role has no auth.uid()):
--       - plt_svc_invite_context / plt_svc_link_auth_user refuse to invite a target holding an active finance or
--         finance_readonly grant (PLT_INVITE_FINANCE, 403);
--       - plt_staff_save and the new trigger plt_users_email_guard refuse to change such a row's e-mail
--         (PLT_EMAIL_FINANCE, 403).
--   * plt_users_email_guard (BEFORE UPDATE OF email ON users, API callers only): a linked row's e-mail cannot change
--     through REST either (PLT_EMAIL_LINKED), so users.email and the login e-mail never drift apart (D2 enforced for
--     direct PATCHes, not only inside plt_staff_save). Case / surrounding-space-only changes are allowed.
--     users_guard itself is unchanged.
--   * plt_svc_link_auth_user links only an account that is still "fresh invite shaped": no password, e-mail not
--     confirmed, never signed in (else PLT_EMAIL_IN_USE). GoTrue's inviteUserByEmail re-sends an invite to an
--     existing UNCONFIRMED user instead of failing, so an account self-registered (with a password) between the
--     context pre-check and the invite would otherwise be linked. Checked after the idempotent / conflict steps.
--   * Login JSON also carries recovery_sent_at and link_sent_at = greatest(invited_at, recovery_sent_at), so the team
--     page shows the time of the latest "Daveti yeniden gönder" (recovery flow) instead of the first invite. For an
--     account in use (status 'active') only last_sign_in_at is filled; the other timestamps are NULL (an admin must
--     not learn e.g. when the owner last used "Şifremi unuttum").
--   * List items carry finance_locked; can_invite is false for a finance-locked row (mirrors PLT_INVITE_FINANCE).
--   * plt_staff_save validates e-mail and phone on an edit only when they change, so rows saved before Phase 10 with
--     legacy values stay editable (e.g. can be deactivated).
--   * plt_patient_active_guard also covers INSERT: an API user cannot create a patient that is already archived.
--   * The two trigger functions are SECURITY DEFINER (they call the never-granted internals plt__raise /
--     plt__norm_email); they read only the caller's own users / staff_permissions rows.
--   * plt_staff_save serialises per clinic with an advisory lock before its e-mail duplicate check, because
--     users_clinic_id_email_key is case-sensitive and cannot catch 'A@x.com' vs 'a@x.com' races;
--     plt_svc_link_auth_user serialises per auth account.
--
-- RUNBOOK (production is the only database):
--   0. Quiet time: the index build briefly blocks audited writes; the triggers on patients / doctors / users take
--      short locks. No web build containing the Phase 10 files may go live before step 1 (the team page then shows
--      "Personel yönetimi güncelleniyor" and archiving fails with "Arşiv işlemi güncelleniyor").
--   1. SQL editor → New query → paste this file ALONE → Run. One transaction; any self-check failure rolls everything
--      back. Expected: success (NOTICEs possible). Between this step and the web deploy the OLD patients page's
--      "Pasif Yap" button fails with PLT_PATIENT_DIRECT (shown as "Hasta pasif yapılamadı."); nothing else changes.
--   2. Deploy the Edge Function and set the Auth settings exactly as docs/edge-functions.md (sign-up OFF is required).
--   3. Deploy the web build (Vercel). Ask everyone to reload open tabs.
--   4. Run scratchpad phase10_acceptance.py, then phase10_cleanup.py. Manual check spec §8.3.
--   Re-running this file is safe (CREATE OR REPLACE, DROP TRIGGER IF EXISTS, CREATE INDEX IF NOT EXISTS; no data step).
--   Rollback after COMMIT: drop the plt_* functions, the three triggers and the index; no data is lost.

BEGIN;

-- ---------------------------------------------------------------------------
-- 2.1 Preflight
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_labels text;
BEGIN
  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY['public.current_clinic_id()', 'public.current_app_role()', 'public.current_app_user_id()',
                    'public.has_permission(text)', 'public.audit_row_change()', 'public.users_guard()',
                    'auth.uid()', 'auth.jwt()']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 0 eksik, önce 0019 uygulanmalı: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.users'::regclass AND t.tgname = 'users_guard' AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'users_guard tetikleyicisi users tablosunda yok veya kapalı; önce 0019 uygulanmalı.';
  END IF;

  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.typ, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('users', 'id', 'uuid'), ('users', 'clinic_id', 'uuid'), ('users', 'auth_user_id', 'uuid'),
    ('users', 'role', 'user_role'), ('users', 'full_name', 'text'), ('users', 'email', 'text'),
    ('users', 'phone', 'text'), ('users', 'is_active', 'bool'), ('users', 'created_at', 'timestamptz'),
    ('users', 'updated_at', 'timestamptz'),
    ('doctors', 'id', 'uuid'), ('doctors', 'clinic_id', 'uuid'), ('doctors', 'user_id', 'uuid'),
    ('doctors', 'specialty', 'text'), ('doctors', 'updated_at', 'timestamptz'),
    ('patients', 'id', 'uuid'), ('patients', 'clinic_id', 'uuid'), ('patients', 'full_name', 'text'),
    ('patients', 'is_active', 'bool'), ('patients', 'updated_at', 'timestamptz'),
    ('appointments', 'id', 'uuid'), ('appointments', 'clinic_id', 'uuid'), ('appointments', 'patient_id', 'uuid'),
    ('appointments', 'start_time', 'timestamptz'), ('appointments', 'status', 'appointment_status'),
    ('audit_logs', 'id', 'uuid'), ('audit_logs', 'clinic_id', 'uuid'), ('audit_logs', 'user_id', 'uuid'),
    ('audit_logs', 'entity_type', 'text'), ('audit_logs', 'entity_id', 'uuid'), ('audit_logs', 'action', 'text'),
    ('audit_logs', 'changes', 'jsonb'), ('audit_logs', 'before_data', 'jsonb'), ('audit_logs', 'after_data', 'jsonb'),
    ('audit_logs', 'created_at', 'timestamptz'),
    ('clinics', 'id', 'uuid'), ('clinics', 'name', 'text'), ('clinics', 'slug', 'text'),
    ('staff_permissions', 'user_id', 'uuid'), ('staff_permissions', 'permission', 'text'),
    ('staff_permissions', 'revoked_at', 'timestamptz')
  ) AS e(tbl, col, typ)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name::text = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.typ;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Tablolar beklenen yapıda değil: %', v_missing;
  END IF;

  SELECT string_agg(e.col, ', ')
    INTO v_missing
  FROM unnest(ARRAY['id', 'email', 'invited_at', 'last_sign_in_at', 'email_confirmed_at', 'created_at',
                    'recovery_sent_at', 'encrypted_password']) AS e(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'auth' AND c.table_name = 'users' AND c.column_name::text = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'auth.users beklenen sütunları içermiyor: %', v_missing;
  END IF;
  IF NOT has_table_privilege(current_user, 'auth.users', 'SELECT') THEN
    RAISE EXCEPTION 'auth.users okunamıyor; 0027 SQL editöründe postgres rolüyle çalıştırılmalı.';
  END IF;

  SELECT string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder)
    INTO v_labels
  FROM pg_enum e
  WHERE e.enumtypid = 'public.user_role'::regtype;
  IF v_labels IS DISTINCT FROM 'owner,admin,doctor,assistant,reception' THEN
    RAISE EXCEPTION 'user_role beklenen değerlere sahip değil: %', coalesce(v_labels, '(yok)');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'service_role rolü bulunamadı.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE EXCEPTION 'anon / authenticated rolleri bulunamadı.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.users'::regclass AND c.conname = 'users_clinic_id_email_key' AND c.contype = 'u'
  ) THEN
    RAISE NOTICE 'users_clinic_id_email_key bulunamadı; e-posta tekilliği yalnız plt_staff_save içinde denetlenir.';
  END IF;
END $$;

-- Policy names on audit_logs before this file (self-check 2.9-4).
DROP TABLE IF EXISTS pg_temp.plt_tmp_audit_policies;
CREATE TEMP TABLE plt_tmp_audit_policies ON COMMIT DROP AS
  SELECT p.policyname::text AS policyname
  FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs';

-- Any older signature of a plt_* function goes before re-creation (no overloads, §1.3). Trigger functions take no
-- arguments, so their signatures never differ and they are never dropped here.
DO $$
DECLARE
  v_f record;
  v_path text := current_setting('search_path');
BEGIN
  -- regprocedure text depends on visibility; compare with public first on the path, restore it afterwards.
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  FOR v_f IN
    SELECT p.oid::regprocedure::text AS sig, p.oid AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'plt\_%'
      AND p.prorettype <> 'trigger'::regtype
      AND p.oid::regprocedure::text NOT IN (
        'plt__raise(text,text)', 'plt__norm_email(text)', 'plt__email_ok(text)', 'plt__is_placeholder_email(text)',
        'plt__is_editor()', 'plt__caller()', 'plt__login_json(uuid)', 'plt__finance_locked(uuid,uuid)',
        'plt__staff_json(users,users)', 'plt__trg_patient_active_guard()', 'plt__trg_users_email_guard()',
        'plt__harden_privileges()',
        'plt_staff_list()',
        'plt_staff_save(uuid,timestamp with time zone,text,text,text,text,boolean,text)',
        'plt_patient_set_active(uuid,boolean,text)',
        'plt_svc_invite_context(uuid,uuid,text)', 'plt_svc_link_auth_user(uuid,uuid,uuid)',
        'plt_svc_log_staff_event(uuid,uuid,text)')
  LOOP
    EXECUTE 'DROP FUNCTION ' || v_f.fn::regprocedure::text;
  END LOOP;
  PERFORM set_config('search_path', v_path, true);
END $$;

-- ---------------------------------------------------------------------------
-- 2.2 Internals (never granted; SECURITY INVOKER except trigger functions)
-- ---------------------------------------------------------------------------

-- §1.1 / §1.2: one place for every Turkish text; the key travels in HINT. '%s' is replaced by p_arg.
CREATE OR REPLACE FUNCTION public.plt__raise(p_key text, p_arg text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_msg text;
  v_code text := 'P0001';
BEGIN
  CASE p_key
    -- Staff
    WHEN 'PLT_SESSION' THEN v_msg := 'Oturum bulunamadı. Lütfen yeniden giriş yapın.'; v_code := '42501';
    WHEN 'PLT_FORBIDDEN' THEN v_msg := 'Personel bilgilerini yalnızca klinik sahibi veya yönetici görebilir ve değiştirebilir.'; v_code := '42501';
    WHEN 'PLT_NOT_FOUND' THEN v_msg := 'Personel bulunamadı.'; v_code := 'PT404';
    WHEN 'PLT_ID_TAKEN' THEN v_msg := 'Kayıt kaydedilemedi. Formu kapatıp yeniden açın.'; v_code := 'PT409';
    WHEN 'PLT_VERSION' THEN v_msg := 'Personel kaydı başka bir ekranda değişti. Listeyi yenileyip tekrar deneyin.'; v_code := 'PT409';
    WHEN 'PLT_NAME' THEN v_msg := 'Ad soyad 2–120 karakter olmalı.';
    WHEN 'PLT_EMAIL' THEN v_msg := 'Geçerli bir e-posta adresi girin.';
    WHEN 'PLT_EMAIL_TAKEN' THEN v_msg := 'Bu e-posta adresi klinikte başka bir personelde kayıtlı.'; v_code := 'PT409';
    WHEN 'PLT_EMAIL_LINKED' THEN v_msg := 'Giriş hesabı olan personelin e-postası buradan değiştirilemez. Giriş e-postası değişecekse destekle iletişime geçin.'; v_code := 'PT409';
    WHEN 'PLT_EMAIL_FINANCE' THEN v_msg := 'Finans yetkisi olan personelin e-postasını yalnızca klinik sahibi veya finans yetkilisi değiştirebilir.'; v_code := '42501';
    WHEN 'PLT_PHONE' THEN v_msg := 'Telefon en fazla 30 karakter olmalı; yalnız rakam, boşluk, +, (, ) ve - kullanılabilir.';
    WHEN 'PLT_ROLE' THEN v_msg := 'Geçerli bir rol seçin.';
    WHEN 'PLT_SPECIALTY' THEN v_msg := 'Uzmanlık en fazla 120 karakter olabilir.';
    WHEN 'PLT_ACTIVE' THEN v_msg := 'Personelin aktif olup olmadığını seçin.';
    WHEN 'PLT_OWNER_ROLE' THEN v_msg := 'Klinik sahibi rolünü yalnızca klinik sahibi atayabilir.'; v_code := '42501';
    WHEN 'PLT_OWNER_ROW' THEN v_msg := 'Klinik sahibinin kaydını yalnızca klinik sahibi değiştirebilir.'; v_code := '42501';
    WHEN 'PLT_SELF' THEN v_msg := 'Kendi rolünüzü veya aktiflik durumunuzu değiştiremezsiniz.'; v_code := '42501';
    -- Patients
    WHEN 'PLT_PATIENT_FORBIDDEN' THEN v_msg := 'Hastayı arşivlemek veya arşivden çıkarmak için klinik sahibi veya yönetici olmanız gerekir.'; v_code := '42501';
    WHEN 'PLT_PATIENT_NOT_FOUND' THEN v_msg := 'Hasta bulunamadı.'; v_code := 'PT404';
    WHEN 'PLT_PATIENT_ARGS' THEN v_msg := 'Hastanın arşivlenmesi mi yoksa arşivden çıkarılması mı istendiği belirtilmedi.';
    WHEN 'PLT_REASON' THEN v_msg := 'Açıklama en fazla 500 karakter olabilir.';
    WHEN 'PLT_PATIENT_DIRECT' THEN v_msg := 'Hasta arşivleme ve arşivden çıkarma yalnız Hastalar ekranındaki işlemle yapılabilir.'; v_code := '42501';
    -- Invitations
    WHEN 'PLT_ACTION' THEN v_msg := 'Geçersiz işlem.';
    WHEN 'PLT_CALLER' THEN v_msg := 'Davet göndermek için aktif klinik sahibi veya yönetici olmanız gerekir.'; v_code := '42501';
    WHEN 'PLT_SELF_INVITE' THEN v_msg := 'Kendinize davet gönderemezsiniz.';
    WHEN 'PLT_OWNER_INVITE' THEN v_msg := 'Klinik sahibine yalnızca klinik sahibi davet gönderebilir.'; v_code := '42501';
    WHEN 'PLT_INACTIVE' THEN v_msg := 'Pasif personele davet gönderilemez. Önce personeli aktif yapın.'; v_code := 'PT409';
    WHEN 'PLT_EMAIL_INVALID' THEN v_msg := 'Personelin e-posta adresi geçersiz. Önce personel kaydını düzeltin.';
    WHEN 'PLT_EMAIL_PLACEHOLDER' THEN v_msg := 'Bu personelin e-posta adresi geçici bir adres (%s). Önce “Düzenle” ile gerçek e-posta adresini girin, sonra davet gönderin.';
    WHEN 'PLT_INVITE_FINANCE' THEN v_msg := 'Finans yetkisi olan personele yalnızca klinik sahibi veya finans yetkilisi davet gönderebilir.'; v_code := '42501';
    WHEN 'PLT_EMAIL_IN_USE' THEN v_msg := 'Bu e-posta adresiyle zaten bir giriş hesabı var. Güvenlik nedeniyle mevcut hesap personele otomatik bağlanmaz; farklı bir e-posta girin veya destekle iletişime geçin.'; v_code := 'PT409';
    WHEN 'PLT_ALREADY_INVITED' THEN v_msg := 'Bu personele daha önce davet gönderilmiş. “Daveti yeniden gönder”i kullanın.'; v_code := 'PT409';
    WHEN 'PLT_ALREADY_ACTIVE' THEN v_msg := 'Bu personel giriş hesabını zaten kullanıyor. Şifresini unuttuysa giriş sayfasındaki “Şifremi unuttum” bağlantısını kullanabilir.'; v_code := 'PT409';
    WHEN 'PLT_NOT_INVITED' THEN v_msg := 'Bu personele henüz davet gönderilmemiş. Önce “Davet gönder”i kullanın.'; v_code := 'PT409';
    WHEN 'PLT_AUTH_MISSING' THEN v_msg := 'Personelin giriş hesabı bulunamadı. Destekle iletişime geçin.'; v_code := 'PT409';
    WHEN 'PLT_EMAIL_MISMATCH' THEN v_msg := 'Personelin e-postası giriş hesabındaki adresle aynı değil. Destekle iletişime geçin.'; v_code := 'PT409';
    WHEN 'PLT_LINK_CONFLICT' THEN v_msg := 'Personel kaydı bu sırada değişti. Listeyi yenileyip tekrar deneyin.'; v_code := 'PT409';
    WHEN 'PLT_AUTH_TAKEN' THEN v_msg := 'Bu giriş hesabı başka bir personele bağlı.'; v_code := 'PT409';
    ELSE
      RAISE EXCEPTION 'plt__raise: bilinmeyen anahtar %', coalesce(p_key, '(boş)');
  END CASE;

  v_msg := replace(v_msg, '%s', coalesce(p_arg, ''));
  RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = p_key;
END;
$$;

-- §1.4 e-mail normalisation.
CREATE OR REPLACE FUNCTION public.plt__norm_email(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(btrim(p))
$$;

-- §1.4 valid e-mail (on the normalised value). Placeholders are valid.
CREATE OR REPLACE FUNCTION public.plt__email_ok(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(char_length(lower(btrim(p))) <= 254
                  AND lower(btrim(p)) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$', false)
$$;

-- §1.4 / D3 placeholder: domain (text after the last '@') is local / localhost / test / invalid / example or a
-- subdomain of one. NULL or no '@' -> false (validity is a separate check). 'example.com' is NOT a placeholder.
CREATE OR REPLACE FUNCTION public.plt__is_placeholder_email(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p IS NULL OR position('@' IN p) = 0 THEN false
           ELSE regexp_replace(lower(btrim(p)), '^.*@', '') IN ('local', 'localhost', 'test', 'invalid', 'example')
                OR regexp_replace(lower(btrim(p)), '^.*@', '') ~ '\.(local|localhost|test|invalid|example)$'
         END
$$;

-- SQL editor / service role / imports: no auth.uid() and no API role (same detection as users_guard).
CREATE OR REPLACE FUNCTION public.plt__is_editor()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT auth.uid() IS NULL
     AND coalesce(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated')
     AND coalesce(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
$$;

-- The caller's ACTIVE users row, or PLT_SESSION. Called only from the definer RPCs.
CREATE OR REPLACE FUNCTION public.plt__caller()
RETURNS public.users
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v public.users;
BEGIN
  IF v_uid IS NULL THEN
    PERFORM public.plt__raise('PLT_SESSION');
  END IF;
  SELECT * INTO v FROM public.users u WHERE u.auth_user_id = v_uid AND u.is_active = true LIMIT 1;
  IF v.id IS NULL THEN
    PERFORM public.plt__raise('PLT_SESSION');
  END IF;
  RETURN v;
END;
$$;

-- §1.4 login status. Reads exactly one auth.users row by id; only minimal timestamps leave this function (never the
-- auth id, e-mail, password hash or tokens). link_sent_at = the newest of invite / recovery e-mail (review fix). For an
-- account in use only last_sign_in_at is returned (review fix). Note: users.auth_user_id itself still reaches owners /
-- admins through audit_logs.before_data / after_data of entity_type 'users' (0019 audit_row_change, unchanged here);
-- the UI shows it only as "Bağlı".
CREATE OR REPLACE FUNCTION public.plt__login_json(p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_invited timestamptz;
  v_last timestamptz;
  v_confirmed timestamptz;
  v_recovery timestamptz;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'none', 'invited_at', NULL, 'last_sign_in_at', NULL,
                              'email_confirmed_at', NULL, 'recovery_sent_at', NULL, 'link_sent_at', NULL);
  END IF;
  SELECT a.invited_at, a.last_sign_in_at, a.email_confirmed_at, a.recovery_sent_at
    INTO v_invited, v_last, v_confirmed, v_recovery
  FROM auth.users a
  WHERE a.id = p_auth_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing', 'invited_at', NULL, 'last_sign_in_at', NULL,
                              'email_confirmed_at', NULL, 'recovery_sent_at', NULL, 'link_sent_at', NULL);
  END IF;
  IF v_last IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'active', 'invited_at', NULL, 'last_sign_in_at', v_last,
                              'email_confirmed_at', NULL, 'recovery_sent_at', NULL, 'link_sent_at', NULL);
  END IF;
  RETURN jsonb_build_object(
    'status', 'invited',
    'invited_at', v_invited,
    'last_sign_in_at', NULL,
    'email_confirmed_at', v_confirmed,
    'recovery_sent_at', v_recovery,
    'link_sent_at', greatest(v_invited, v_recovery));
END;
$$;

-- Review fix (finance escalation): true when p_target holds an active finance / finance_readonly grant and the
-- caller (by users.id) is neither the owner nor an active 'finance' holder. NULL caller -> locked.
CREATE OR REPLACE FUNCTION public.plt__finance_locked(p_target uuid, p_caller uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.staff_permissions sp
           WHERE sp.user_id = p_target AND sp.permission IN ('finance', 'finance_readonly') AND sp.revoked_at IS NULL
         )
     AND NOT coalesce((
           SELECT u.role = 'owner'
              OR EXISTS (SELECT 1 FROM public.staff_permissions sp
                         WHERE sp.user_id = u.id AND sp.permission = 'finance' AND sp.revoked_at IS NULL)
           FROM public.users u
           WHERE u.id = p_caller AND u.is_active = true
         ), false)
$$;

-- §2.4.1 list item. auth_user_id is never part of it.
CREATE OR REPLACE FUNCTION public.plt__staff_json(p_u public.users, p_caller public.users)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_login jsonb := public.plt__login_json(p_u.auth_user_id);
  v_doc jsonb;
  v_active boolean := coalesce(p_u.is_active, false);
  v_placeholder boolean := public.plt__is_placeholder_email(p_u.email);
  v_valid boolean := public.plt__email_ok(p_u.email);
  v_can_edit boolean := (p_u.role <> 'owner' OR p_caller.role = 'owner');
  v_not_me boolean := (p_u.id <> p_caller.id);
  v_fin_locked boolean := public.plt__finance_locked(p_u.id, p_caller.id);
BEGIN
  SELECT jsonb_build_object('id', d.id, 'specialty', d.specialty)
    INTO v_doc
  FROM public.doctors d
  WHERE d.user_id = p_u.id
  LIMIT 1;

  RETURN jsonb_build_object(
    'id', p_u.id,
    'full_name', p_u.full_name,
    'email', p_u.email,
    'phone', coalesce(p_u.phone, ''),
    'role', p_u.role,
    'is_active', v_active,
    'updated_at', p_u.updated_at,
    'is_me', NOT v_not_me,
    'email_placeholder', v_placeholder,
    'doctor', v_doc,
    'login', v_login,
    'can_edit', v_can_edit,
    'can_change_role_active', v_can_edit AND v_not_me,
    'finance_locked', v_fin_locked,
    'can_invite', v_can_edit AND v_not_me AND v_active AND v_login ->> 'status' = 'none' AND v_valid
                  AND NOT v_placeholder AND NOT v_fin_locked,
    'can_resend', v_can_edit AND v_not_me AND v_active AND v_login ->> 'status' = 'invited');
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.3 Index for keyset paging of the audit history
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_logs_clinic_created_id
  ON public.audit_logs (clinic_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 2.4 Public RPCs (SECURITY DEFINER, search_path = public, authenticated only)
-- ---------------------------------------------------------------------------

-- §2.4.1
CREATE OR REPLACE FUNCTION public.plt_staff_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users := public.plt__caller();
  v_staff jsonb;
BEGIN
  IF v_caller.role NOT IN ('owner', 'admin') THEN
    PERFORM public.plt__raise('PLT_FORBIDDEN');
  END IF;

  SELECT coalesce(jsonb_agg(public.plt__staff_json(u, v_caller)
                            ORDER BY u.is_active DESC NULLS LAST, u.full_name COLLATE "tr-x-icu", u.id), '[]'::jsonb)
    INTO v_staff
  FROM public.users u
  WHERE u.clinic_id = v_caller.clinic_id;

  RETURN jsonb_build_object(
    'ok', true,
    'me', jsonb_build_object('user_id', v_caller.id, 'role', v_caller.role),
    'can_assign_owner', v_caller.role = 'owner',
    'staff', v_staff);
END;
$$;

-- §2.4.2 create (p_expected_updated_at IS NULL) or edit. users_guard and audit_row_change keep running with the real
-- caller (auth.uid() is unchanged inside SECURITY DEFINER).
CREATE OR REPLACE FUNCTION public.plt_staff_save(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_full_name text,
  p_email text,
  p_phone text,
  p_role text,
  p_is_active boolean,
  p_specialty text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users := public.plt__caller();
  v_row public.users;
  v_doc public.doctors;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_email text := public.plt__norm_email(coalesce(p_email, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_spec text := nullif(btrim(coalesce(p_specialty, '')), '');
  v_role public.user_role;
  v_constraint text;
  v_email_changed boolean;
  v_new_email text;
  v_user_changed boolean;
  v_doc_insert boolean := false;
  v_doc_update boolean := false;
BEGIN
  -- 1. Gate
  IF v_caller.role NOT IN ('owner', 'admin') THEN
    PERFORM public.plt__raise('PLT_FORBIDDEN');
  END IF;
  -- 2. Client id
  IF p_id IS NULL THEN
    PERFORM public.plt__raise('PLT_ID_TAKEN');
  END IF;
  -- 4. Validation (3. normalisation above)
  IF char_length(v_name) NOT BETWEEN 2 AND 120 THEN
    PERFORM public.plt__raise('PLT_NAME');
  END IF;
  -- E-mail and phone: here for a create; for an edit only when changed (step 7, review fix).
  IF p_expected_updated_at IS NULL AND NOT public.plt__email_ok(v_email) THEN
    PERFORM public.plt__raise('PLT_EMAIL');
  END IF;
  IF p_expected_updated_at IS NULL AND v_phone IS NOT NULL
     AND (char_length(v_phone) > 30 OR v_phone !~ '^[0-9 +()-]+$') THEN
    PERFORM public.plt__raise('PLT_PHONE');
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'doctor', 'assistant', 'reception') THEN
    PERFORM public.plt__raise('PLT_ROLE');
  END IF;
  v_role := p_role::public.user_role;
  IF v_spec IS NOT NULL AND char_length(v_spec) > 120 THEN
    PERFORM public.plt__raise('PLT_SPECIALTY');
  END IF;
  IF p_is_active IS NULL THEN
    PERFORM public.plt__raise('PLT_ACTIVE');
  END IF;

  -- E-mail uniqueness is case-insensitive here but the constraint is not: serialise saves per clinic.
  PERFORM pg_advisory_xact_lock(hashtextextended('plt.staff_save:' || v_caller.clinic_id::text, 0));

  IF p_expected_updated_at IS NULL THEN
    -- 5. + 6. Create
    IF v_role = 'owner' AND v_caller.role <> 'owner' THEN
      PERFORM public.plt__raise('PLT_OWNER_ROLE');
    END IF;

    SELECT * INTO v_row FROM public.users u WHERE u.id = p_id;
    IF v_row.id IS NOT NULL THEN
      IF v_row.clinic_id = v_caller.clinic_id
         AND public.plt__norm_email(v_row.email) = v_email
         AND v_row.full_name = v_name THEN
        RETURN jsonb_build_object('ok', true, 'already_saved', true, 'changed', false,
                                  'user', public.plt__staff_json(v_row, v_caller));
      END IF;
      PERFORM public.plt__raise('PLT_ID_TAKEN');
    END IF;

    IF EXISTS (SELECT 1 FROM public.users u
               WHERE u.clinic_id = v_caller.clinic_id AND public.plt__norm_email(u.email) = v_email) THEN
      PERFORM public.plt__raise('PLT_EMAIL_TAKEN');
    END IF;

    BEGIN
      INSERT INTO public.users (id, clinic_id, role, full_name, email, phone, is_active, auth_user_id)
      VALUES (p_id, v_caller.clinic_id, v_role, v_name, v_email, v_phone, p_is_active, NULL);
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'users_clinic_id_email_key' THEN
        PERFORM public.plt__raise('PLT_EMAIL_TAKEN');
      END IF;
      PERFORM public.plt__raise('PLT_ID_TAKEN');
    END;

    IF v_role = 'doctor' THEN
      INSERT INTO public.doctors (clinic_id, user_id, specialty) VALUES (v_caller.clinic_id, p_id, v_spec);
    END IF;

    SELECT * INTO v_row FROM public.users u WHERE u.id = p_id;
    RETURN jsonb_build_object('ok', true, 'already_saved', false, 'changed', true,
                              'user', public.plt__staff_json(v_row, v_caller));
  END IF;

  -- 7. Edit
  SELECT * INTO v_row FROM public.users u
  WHERE u.id = p_id AND u.clinic_id = v_caller.clinic_id
  FOR UPDATE;
  IF v_row.id IS NULL THEN
    PERFORM public.plt__raise('PLT_NOT_FOUND');
  END IF;
  -- Values saved before Phase 10 may not meet today's rules; an unchanged e-mail / phone is not re-validated.
  IF public.plt__norm_email(v_row.email) IS DISTINCT FROM v_email AND NOT public.plt__email_ok(v_email) THEN
    PERFORM public.plt__raise('PLT_EMAIL');
  END IF;
  IF v_phone IS DISTINCT FROM nullif(btrim(coalesce(v_row.phone, '')), '') AND v_phone IS NOT NULL
     AND (char_length(v_phone) > 30 OR v_phone !~ '^[0-9 +()-]+$') THEN
    PERFORM public.plt__raise('PLT_PHONE');
  END IF;
  IF v_row.role = 'owner' AND v_caller.role <> 'owner' THEN
    PERFORM public.plt__raise('PLT_OWNER_ROW');
  END IF;
  IF v_role = 'owner' AND v_caller.role <> 'owner' THEN
    PERFORM public.plt__raise('PLT_OWNER_ROLE');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    PERFORM public.plt__raise('PLT_VERSION');
  END IF;
  IF v_row.id = v_caller.id
     AND (v_role <> v_row.role OR p_is_active IS DISTINCT FROM coalesce(v_row.is_active, false)) THEN
    PERFORM public.plt__raise('PLT_SELF');
  END IF;

  -- A case / space-only difference is not a change; the stored spelling is kept.
  v_email_changed := public.plt__norm_email(v_row.email) IS DISTINCT FROM v_email;
  v_new_email := CASE WHEN v_email_changed THEN v_email ELSE v_row.email END;
  IF v_email_changed AND v_row.auth_user_id IS NOT NULL THEN
    PERFORM public.plt__raise('PLT_EMAIL_LINKED');
  END IF;
  IF v_email_changed AND public.plt__finance_locked(v_row.id, v_caller.id) THEN
    PERFORM public.plt__raise('PLT_EMAIL_FINANCE');
  END IF;
  IF v_email_changed AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.clinic_id = v_caller.clinic_id AND u.id <> v_row.id AND public.plt__norm_email(u.email) = v_email
  ) THEN
    PERFORM public.plt__raise('PLT_EMAIL_TAKEN');
  END IF;

  SELECT * INTO v_doc FROM public.doctors d WHERE d.user_id = v_row.id FOR UPDATE;
  IF v_doc.id IS NOT NULL THEN
    v_doc_update := v_doc.specialty IS DISTINCT FROM v_spec;
  ELSIF v_role = 'doctor' THEN
    v_doc_insert := true;
  END IF;

  v_user_changed := v_row.full_name IS DISTINCT FROM v_name
                    OR v_email_changed
                    OR v_row.phone IS DISTINCT FROM v_phone
                    OR v_row.role IS DISTINCT FROM v_role
                    OR coalesce(v_row.is_active, false) IS DISTINCT FROM p_is_active;

  IF NOT v_user_changed AND NOT v_doc_insert AND NOT v_doc_update THEN
    RETURN jsonb_build_object('ok', true, 'already_saved', false, 'changed', false,
                              'user', public.plt__staff_json(v_row, v_caller));
  END IF;

  IF v_user_changed THEN
    BEGIN
      UPDATE public.users
      SET full_name = v_name,
          email = v_new_email,
          phone = v_phone,
          role = v_role,
          is_active = CASE WHEN coalesce(v_row.is_active, false) = p_is_active THEN v_row.is_active ELSE p_is_active END,
          updated_at = now()
      WHERE id = v_row.id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'users_clinic_id_email_key' THEN
        PERFORM public.plt__raise('PLT_EMAIL_TAKEN');
      END IF;
      RAISE;
    END;
  END IF;

  -- A role change away from doctor keeps the doctors row (history, RESTRICT FKs).
  IF v_doc_insert THEN
    INSERT INTO public.doctors (clinic_id, user_id, specialty) VALUES (v_row.clinic_id, v_row.id, v_spec);
  ELSIF v_doc_update THEN
    UPDATE public.doctors SET specialty = v_spec, updated_at = now() WHERE id = v_doc.id;
  END IF;

  SELECT * INTO v_row FROM public.users u WHERE u.id = p_id;
  RETURN jsonb_build_object('ok', true, 'already_saved', false, 'changed', true,
                            'user', public.plt__staff_json(v_row, v_caller));
END;
$$;

-- §2.4.3 archive / restore. The audit row carries only is_active (+ optional reason), never patient data (KVKK).
CREATE OR REPLACE FUNCTION public.plt_patient_set_active(p_patient_id uuid, p_active boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users := public.plt__caller();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_clinic uuid;
  v_old boolean;
  v_future bigint;
BEGIN
  IF v_caller.role NOT IN ('owner', 'admin') THEN
    PERFORM public.plt__raise('PLT_PATIENT_FORBIDDEN');
  END IF;
  IF p_active IS NULL THEN
    PERFORM public.plt__raise('PLT_PATIENT_ARGS');
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    PERFORM public.plt__raise('PLT_REASON');
  END IF;

  SELECT p.clinic_id, coalesce(p.is_active, true)
    INTO v_clinic, v_old
  FROM public.patients p
  WHERE p.id = p_patient_id AND p.clinic_id = v_caller.clinic_id
  FOR UPDATE;
  IF v_clinic IS NULL THEN
    PERFORM public.plt__raise('PLT_PATIENT_NOT_FOUND');
  END IF;

  SELECT count(*) INTO v_future
  FROM public.appointments a
  WHERE a.patient_id = p_patient_id AND a.clinic_id = v_clinic
    AND a.status = 'scheduled' AND a.start_time > now();

  IF v_old = p_active THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'patient_id', p_patient_id, 'is_active', p_active,
                              'future_appointments', v_future);
  END IF;

  PERFORM set_config('plt.patient_active', p_patient_id::text, true);
  UPDATE public.patients SET is_active = p_active, updated_at = now() WHERE id = p_patient_id;
  PERFORM set_config('plt.patient_active', '', true);

  INSERT INTO public.audit_logs (clinic_id, user_id, entity_type, entity_id, action, changes, before_data, after_data)
  VALUES (v_clinic, v_caller.id, 'patients', p_patient_id, CASE WHEN p_active THEN 'restore' ELSE 'archive' END,
          jsonb_build_object('is_active', p_active, 'reason', v_reason),
          jsonb_build_object('is_active', v_old),
          jsonb_build_object('is_active', p_active));

  RETURN jsonb_build_object('ok', true, 'changed', true, 'patient_id', p_patient_id, 'is_active', p_active,
                            'future_appointments', v_future);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.5 Service-role functions (Edge Function invite-staff after it verified the JWT, and the harness). They take the
--     acting ids as arguments because the service role has no auth.uid(). EXECUTE: service_role only.
-- ---------------------------------------------------------------------------

-- §2.5.1 read-only; checks in this exact order (+ PLT_INVITE_FINANCE after the placeholder check for 'invite').
CREATE OR REPLACE FUNCTION public.plt_svc_invite_context(p_caller_auth_id uuid, p_user_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users;
  v_target public.users;
  v_email text;
  v_auth_found boolean;
  v_auth_email text;
  v_auth_last timestamptz;
  v_auth_invited timestamptz;
  v_clinic_name text;
BEGIN
  -- 1.
  IF p_action IS NULL OR p_action NOT IN ('invite', 'resend') THEN
    PERFORM public.plt__raise('PLT_ACTION');
  END IF;
  -- 2.
  IF p_caller_auth_id IS NOT NULL THEN
    SELECT * INTO v_caller FROM public.users u
    WHERE u.auth_user_id = p_caller_auth_id AND u.is_active = true AND u.role IN ('owner', 'admin')
    LIMIT 1;
  END IF;
  IF v_caller.id IS NULL THEN
    PERFORM public.plt__raise('PLT_CALLER');
  END IF;
  -- 3.
  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id AND u.clinic_id = v_caller.clinic_id;
  IF v_target.id IS NULL THEN
    PERFORM public.plt__raise('PLT_NOT_FOUND');
  END IF;
  -- 4.-8.
  IF v_target.id = v_caller.id THEN
    PERFORM public.plt__raise('PLT_SELF_INVITE');
  END IF;
  IF v_target.role = 'owner' AND v_caller.role <> 'owner' THEN
    PERFORM public.plt__raise('PLT_OWNER_INVITE');
  END IF;
  IF v_target.is_active IS DISTINCT FROM true THEN
    PERFORM public.plt__raise('PLT_INACTIVE');
  END IF;
  IF NOT public.plt__email_ok(v_target.email) THEN
    PERFORM public.plt__raise('PLT_EMAIL_INVALID');
  END IF;
  IF public.plt__is_placeholder_email(v_target.email) THEN
    PERFORM public.plt__raise('PLT_EMAIL_PLACEHOLDER', v_target.email);
  END IF;
  v_email := public.plt__norm_email(v_target.email);

  IF v_target.auth_user_id IS NOT NULL THEN
    SELECT true, lower(a.email::text), a.last_sign_in_at, a.invited_at
      INTO v_auth_found, v_auth_email, v_auth_last, v_auth_invited
    FROM auth.users a
    WHERE a.id = v_target.auth_user_id;
  END IF;
  v_auth_found := coalesce(v_auth_found, false);

  IF p_action = 'invite' THEN
    -- 8b. (review fix) finance escalation
    IF public.plt__finance_locked(v_target.id, v_caller.id) THEN
      PERFORM public.plt__raise('PLT_INVITE_FINANCE');
    END IF;
    -- 9.
    IF v_target.auth_user_id IS NOT NULL THEN
      -- (review fix) a linked row whose login account is gone is not "already active".
      IF NOT v_auth_found THEN
        PERFORM public.plt__raise('PLT_AUTH_MISSING');
      END IF;
      IF v_auth_last IS NULL THEN
        PERFORM public.plt__raise('PLT_ALREADY_INVITED');
      END IF;
      PERFORM public.plt__raise('PLT_ALREADY_ACTIVE');
    END IF;
    IF EXISTS (SELECT 1 FROM auth.users a WHERE lower(a.email::text) = v_email) THEN
      PERFORM public.plt__raise('PLT_EMAIL_IN_USE');
    END IF;
  ELSE
    -- 10.
    IF v_target.auth_user_id IS NULL THEN
      PERFORM public.plt__raise('PLT_NOT_INVITED');
    END IF;
    IF NOT v_auth_found THEN
      PERFORM public.plt__raise('PLT_AUTH_MISSING');
    END IF;
    IF v_auth_last IS NOT NULL THEN
      PERFORM public.plt__raise('PLT_ALREADY_ACTIVE');
    END IF;
    IF v_auth_email IS DISTINCT FROM v_email THEN
      PERFORM public.plt__raise('PLT_EMAIL_MISMATCH');
    END IF;
  END IF;

  SELECT c.name INTO v_clinic_name FROM public.clinics c WHERE c.id = v_caller.clinic_id;

  -- 11. (auth reports only linked / invited_at; never the auth id)
  RETURN jsonb_build_object(
    'ok', true,
    'action', p_action,
    'caller_user_id', v_caller.id,
    'caller_role', v_caller.role,
    'clinic_id', v_caller.clinic_id,
    'clinic_name', coalesce(v_clinic_name, ''),
    'target', jsonb_build_object('id', v_target.id, 'full_name', v_target.full_name, 'email', v_email,
                                 'role', v_target.role),
    'auth', jsonb_build_object('linked', v_target.auth_user_id IS NOT NULL,
                               'invited_at', CASE WHEN v_auth_found THEN v_auth_invited END));
END;
$$;

-- §2.5.2 called right after a successful inviteUserByEmail. Writes the link only while auth_user_id is still NULL,
-- only for an account whose e-mail equals the row's, that no other row uses and that is still fresh invite shaped.
CREATE OR REPLACE FUNCTION public.plt_svc_link_auth_user(p_actor_user_id uuid, p_user_id uuid, p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.users;
  v_target public.users;
  v_email text;
  v_auth_email text;
  v_invited timestamptz;
  v_confirmed timestamptz;
  v_last timestamptz;
  v_has_password boolean;
  v_n integer;
  v_constraint text;
BEGIN
  -- 1.
  SELECT * INTO v_actor FROM public.users u
  WHERE u.id = p_actor_user_id AND u.is_active = true AND u.role IN ('owner', 'admin');
  IF v_actor.id IS NULL THEN
    PERFORM public.plt__raise('PLT_CALLER');
  END IF;

  -- Two invites returning the same auth account serialise here.
  IF p_auth_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('plt.link:' || p_auth_user_id::text, 0));
  END IF;

  -- 2.
  SELECT * INTO v_target FROM public.users u
  WHERE u.id = p_user_id AND u.clinic_id = v_actor.clinic_id
  FOR UPDATE;
  IF v_target.id IS NULL THEN
    PERFORM public.plt__raise('PLT_NOT_FOUND');
  END IF;
  IF v_target.id = v_actor.id THEN
    PERFORM public.plt__raise('PLT_SELF_INVITE');
  END IF;
  IF v_target.role = 'owner' AND v_actor.role <> 'owner' THEN
    PERFORM public.plt__raise('PLT_OWNER_INVITE');
  END IF;
  IF v_target.is_active IS DISTINCT FROM true THEN
    PERFORM public.plt__raise('PLT_INACTIVE');
  END IF;
  IF NOT public.plt__email_ok(v_target.email) THEN
    PERFORM public.plt__raise('PLT_EMAIL_INVALID');
  END IF;
  IF public.plt__is_placeholder_email(v_target.email) THEN
    PERFORM public.plt__raise('PLT_EMAIL_PLACEHOLDER', v_target.email);
  END IF;
  IF public.plt__finance_locked(v_target.id, v_actor.id) THEN
    PERFORM public.plt__raise('PLT_INVITE_FINANCE');
  END IF;
  v_email := public.plt__norm_email(v_target.email);

  -- 3.
  SELECT lower(a.email::text), a.invited_at, a.email_confirmed_at, a.last_sign_in_at,
         coalesce(a.encrypted_password::text, '') <> ''
    INTO v_auth_email, v_invited, v_confirmed, v_last, v_has_password
  FROM auth.users a
  WHERE a.id = p_auth_user_id;
  IF NOT FOUND THEN
    PERFORM public.plt__raise('PLT_AUTH_MISSING');
  END IF;
  IF v_auth_email IS DISTINCT FROM v_email THEN
    PERFORM public.plt__raise('PLT_EMAIL_MISMATCH');
  END IF;

  -- 4. idempotent (second concurrent invite of the same person); no audit row
  IF v_target.auth_user_id = p_auth_user_id THEN
    RETURN jsonb_build_object('ok', true, 'already_linked', true, 'user_id', v_target.id, 'invited_at', v_invited);
  END IF;
  -- 5.
  IF v_target.auth_user_id IS NOT NULL THEN
    PERFORM public.plt__raise('PLT_LINK_CONFLICT');
  END IF;
  -- 6.
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.auth_user_id = p_auth_user_id) THEN
    PERFORM public.plt__raise('PLT_AUTH_TAKEN');
  END IF;
  -- 6b. (review fix) only an account nobody could have used yet: no password, unconfirmed, never signed in.
  IF v_has_password OR v_confirmed IS NOT NULL OR v_last IS NOT NULL THEN
    PERFORM public.plt__raise('PLT_EMAIL_IN_USE');
  END IF;

  -- 7. users_guard passes for the service role (no auth.uid(), role not anon / authenticated).
  BEGIN
    UPDATE public.users
    SET auth_user_id = p_auth_user_id, updated_at = now()
    WHERE id = v_target.id AND auth_user_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    PERFORM public.plt__raise('PLT_AUTH_TAKEN');
  END;
  IF v_n <> 1 THEN
    PERFORM public.plt__raise('PLT_LINK_CONFLICT');
  END IF;

  -- 8.
  INSERT INTO public.audit_logs (clinic_id, user_id, entity_type, entity_id, action, changes)
  VALUES (v_target.clinic_id, v_actor.id, 'users', v_target.id, 'invite',
          jsonb_build_object('email', v_email, 'login', 'invited'));

  -- 9.
  RETURN jsonb_build_object('ok', true, 'already_linked', false, 'user_id', v_target.id, 'invited_at', v_invited);
END;
$$;

-- §2.5.3
CREATE OR REPLACE FUNCTION public.plt_svc_log_staff_event(p_actor_user_id uuid, p_user_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor public.users;
  v_target public.users;
BEGIN
  IF p_action IS DISTINCT FROM 'invite_resend' THEN
    PERFORM public.plt__raise('PLT_ACTION');
  END IF;
  SELECT * INTO v_actor FROM public.users u
  WHERE u.id = p_actor_user_id AND u.is_active = true AND u.role IN ('owner', 'admin');
  IF v_actor.id IS NULL THEN
    PERFORM public.plt__raise('PLT_CALLER');
  END IF;
  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id AND u.clinic_id = v_actor.clinic_id;
  IF v_target.id IS NULL THEN
    PERFORM public.plt__raise('PLT_NOT_FOUND');
  END IF;

  INSERT INTO public.audit_logs (clinic_id, user_id, entity_type, entity_id, action, changes)
  VALUES (v_target.clinic_id, v_actor.id, 'users', v_target.id, 'invite_resend',
          jsonb_build_object('email', public.plt__norm_email(v_target.email)));

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.6 patients.is_active only through plt_patient_set_active (D7). SECURITY DEFINER because it calls the internal
--     plt__raise; it reads no table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plt__trg_patient_active_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- (review fix) a new patient may not start archived, except from the SQL editor / service role.
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_active IS DISTINCT FROM false OR public.plt__is_editor() THEN
      RETURN NEW;
    END IF;
    PERFORM public.plt__raise('PLT_PATIENT_DIRECT');
    RETURN NULL;
  END IF;
  IF NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
    RETURN NEW;
  END IF;
  IF public.plt__is_editor() THEN
    RETURN NEW;
  END IF;
  -- Set only by plt_patient_set_active around its single UPDATE (transaction-local; not settable through PostgREST).
  IF current_setting('plt.patient_active', true) IS NOT DISTINCT FROM NEW.id::text THEN
    RETURN NEW;
  END IF;
  PERFORM public.plt__raise('PLT_PATIENT_DIRECT');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS plt_patient_active_guard ON public.patients;
CREATE TRIGGER plt_patient_active_guard
  BEFORE INSERT OR UPDATE OF is_active ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.plt__trg_patient_active_guard();

-- ---------------------------------------------------------------------------
-- 2.6b users.email for API callers (review fix): a linked row's e-mail never changes; an unlinked row holding an
--      active finance / finance_readonly grant changes e-mail only by the owner or a 'finance' holder. Runs before
--      users_guard (trigger names fire in alphabetical order); users_guard itself is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plt__trg_users_email_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
BEGIN
  IF public.plt__norm_email(NEW.email) IS NOT DISTINCT FROM public.plt__norm_email(OLD.email) THEN
    RETURN NEW;
  END IF;
  IF public.plt__is_editor() THEN
    RETURN NEW;
  END IF;
  IF OLD.auth_user_id IS NOT NULL THEN
    PERFORM public.plt__raise('PLT_EMAIL_LINKED');
  END IF;
  SELECT u.id INTO v_caller FROM public.users u WHERE u.auth_user_id = auth.uid() AND u.is_active = true LIMIT 1;
  IF v_caller IS NULL THEN
    PERFORM public.plt__raise('PLT_SESSION');
  END IF;
  IF public.plt__finance_locked(OLD.id, v_caller) THEN
    PERFORM public.plt__raise('PLT_EMAIL_FINANCE');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plt_users_email_guard ON public.users;
CREATE TRIGGER plt_users_email_guard
  BEFORE UPDATE OF email ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.plt__trg_users_email_guard();

-- ---------------------------------------------------------------------------
-- 2.7 doctors audit (visible through the existing owner/admin audit policy; no policy change)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_row_change ON public.doctors;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.doctors
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

-- ---------------------------------------------------------------------------
-- 2.8 Function privileges and self-checks (clin__harden_privileges pattern). PostgreSQL grants EXECUTE to PUBLIC on
--     every new function (and Supabase's default privileges add anon and authenticated); CREATE OR REPLACE keeps the
--     ACL. Every plt_* / plt__* function loses EXECUTE from PUBLIC, anon and authenticated; plt_svc_* is then granted
--     to service_role only, the other public RPCs to authenticated only; internals never. Runs as the migration
--     owner; never granted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plt__harden_privileges()
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
    WHERE n.nspname = 'public' AND p.proname LIKE 'plt\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_f.sig);
    IF v_f.proname LIKE 'plt\_svc\_%' THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM service_role', v_f.sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_f.sig);
    ELSIF v_f.proname NOT LIKE 'plt\_\_%' THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM service_role', v_f.sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_f.sig);
    ELSE
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM service_role', v_f.sig);
    END IF;
  END LOOP;

  -- No overloads (§1.3).
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'plt\_%'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'plt_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- Every public RPC (plt_staff_*, plt_patient_*, plt_svc_*) is SECURITY DEFINER with search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'plt\_%' AND p.proname NOT LIKE 'plt\_\_%'
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  -- Internals fail closed: only trigger functions may be SECURITY DEFINER; all have search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'plt\_\_%'
    AND ((p.prosecdef AND p.prorettype <> 'trigger'::regtype)
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç platform fonksiyonları beklenen gibi değil (SECURITY DEFINER / search_path): %', v_bad;
  END IF;

  -- anon can call nothing; authenticated no internal and no service function; service_role exactly plt_svc_*.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'plt\_%'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR ((p.proname LIKE 'plt\_\_%' OR p.proname LIKE 'plt\_svc\_%')
             AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
         OR (p.proname NOT LIKE 'plt\_\_%' AND p.proname NOT LIKE 'plt\_svc\_%'
             AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Platform fonksiyon yetkileri beklenen gibi değil (anon / authenticated): %', v_bad;
  END IF;

  SELECT string_agg(f.fn, ', ') INTO v_bad
  FROM unnest(ARRAY['public.plt_svc_invite_context(uuid,uuid,text)', 'public.plt_svc_link_auth_user(uuid,uuid,uuid)',
                    'public.plt_svc_log_staff_event(uuid,uuid,text)']) AS f(fn)
  WHERE to_regprocedure(f.fn) IS NULL
     OR NOT has_function_privilege('service_role', to_regprocedure(f.fn), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'service_role şu fonksiyonları çalıştıramıyor: %', v_bad;
  END IF;
END;
$$;

SELECT public.plt__harden_privileges();

-- ---------------------------------------------------------------------------
-- 2.9 Self-checks (any failure rolls back the whole file)
-- ---------------------------------------------------------------------------

-- 1. Shared vectors §6.3 (lib/__tests__/staff.test.ts must agree).
DO $$
DECLARE
  v_fail text;
BEGIN
  SELECT string_agg(format('%L (geçerli %s / geçici %s)', v.e, public.plt__email_ok(v.e),
                           public.plt__is_placeholder_email(v.e)), ', ')
    INTO v_fail
  FROM (VALUES
    ('ayse@dentos.local', true, true),
    ('  AYSE@DENTOS.LOCAL ', true, true),
    ('x@clinic.test', true, true),
    ('x@a.invalid', true, true),
    ('x@shop.example', true, true),
    ('x@foo.localhost', true, true),
    ('x@localhost', false, true),
    ('x@example.com', true, false),
    ('x@gmail.com', true, false),
    ('x@local.com.tr', true, false),
    ('x@dentos.locale', true, false),
    ('x@testing.com', true, false),
    ('no-at-sign', false, false),
    ('a b@c.com', false, false)
  ) AS v(e, valid, placeholder)
  WHERE public.plt__email_ok(v.e) IS DISTINCT FROM v.valid
     OR public.plt__is_placeholder_email(v.e) IS DISTINCT FROM v.placeholder;
  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION 'E-posta vektörleri tutmuyor: %', v_fail;
  END IF;
  IF public.plt__is_placeholder_email(NULL) OR public.plt__email_ok(NULL) THEN
    RAISE EXCEPTION 'E-posta denetimleri NULL için false dönmeli.';
  END IF;
END $$;

-- 2.-4. Triggers, index, audit policies unchanged.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(e.tbl || '.' || e.tg, ', ') INTO v_bad
  FROM (VALUES ('patients', 'plt_patient_active_guard'), ('doctors', 'audit_row_change'),
               ('users', 'users_guard'), ('users', 'plt_users_email_guard'), ('users', 'audit_row_change')) AS e(tbl, tg)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = format('public.%I', e.tbl)::regclass AND t.tgname = e.tg AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
  );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Tetikleyiciler eksik veya kapalı: %', v_bad;
  END IF;

  IF to_regclass('public.idx_audit_logs_clinic_created_id') IS NULL THEN
    RAISE EXCEPTION 'idx_audit_logs_clinic_created_id oluşturulamadı.';
  END IF;

  SELECT string_agg(coalesce(a.policyname, b.policyname), ', ') INTO v_bad
  FROM (SELECT policyname FROM pg_temp.plt_tmp_audit_policies) a
  FULL JOIN (SELECT p.policyname::text AS policyname FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs') b
    ON a.policyname = b.policyname
  WHERE a.policyname IS NULL OR b.policyname IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs politikaları değişti (0027 politika eklememeli / silmemeli): %', v_bad;
  END IF;
END $$;

-- 5. Replay inside a block that is always rolled back: temporary clinic 'p10-test-selfcheck-<random>' with an owner,
--    an admin, a linked assistant (its login account does not exist), an unlinked finance holder, an unlinked assistant
--    and a patient. auth.uid() is simulated through request.jwt.claims and, for older auth.uid() / auth.jwt() bodies,
--    request.jwt.claim.sub / request.jwt.claim.role. Every RPC path runs once here (create, edit, version, archive,
--    restore, link refusals, invite / resend context, resend audit), so a runtime error fails the migration instead of
--    production. Nothing survives the block.
DO $$
DECLARE
  v_slug text := 'p10-test-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();
  v_adm_auth uuid := gen_random_uuid();
  v_lnk uuid := gen_random_uuid();
  v_fin uuid := gen_random_uuid();
  v_new uuid := gen_random_uuid();
  v_tgt uuid := gen_random_uuid();
  v_patient uuid := gen_random_uuid();
  v_j jsonb;
  v_hint text;
  v_n bigint;
  v_keys text;
  v_upd timestamptz;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P10', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p10-sc-own-' || v_tag || '@example.invalid', true),
      (v_adm, v_clinic, v_adm_auth, 'admin', 'Öz denetim yönetici', 'p10-sc-adm-' || v_tag || '@example.invalid', true),
      (v_lnk, v_clinic, gen_random_uuid(), 'assistant', 'Öz denetim asistan',
       'p10-sc-lnk-' || v_tag || '@example.com', true),
      (v_fin, v_clinic, NULL, 'assistant', 'Öz denetim finans', 'p10-sc-fin-' || v_tag || '@example.com', true),
      (v_tgt, v_clinic, NULL, 'assistant', 'Öz denetim hedef', 'p10-sc-tgt-' || v_tag || '@example.com', true);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by)
    VALUES (v_clinic, v_fin, 'finance_readonly', v_own);
    INSERT INTO public.patients (id, clinic_id, full_name, phone)
    VALUES (v_patient, v_clinic, 'Öz denetim hasta', '5000000097');

    -- From here on the caller is the admin.
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_adm_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_adm_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_adm_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;

    -- Create a doctor with specialty (placeholder e-mail is valid): one doctors row, audited with the admin as actor.
    v_j := public.plt_staff_save(v_new, NULL, '  Öz Denetim Hekim  ', 'ozdenetim-' || v_tag || '@dentos.local', '',
                                 'doctor', true, 'Endodonti');
    IF NOT coalesce((v_j ->> 'ok')::boolean, false) OR (v_j ->> 'already_saved')::boolean
       OR v_j #>> '{user,full_name}' IS DISTINCT FROM 'Öz Denetim Hekim'
       OR v_j #>> '{user,doctor,specialty}' IS DISTINCT FROM 'Endodonti'
       OR NOT (v_j #>> '{user,email_placeholder}')::boolean
       OR (v_j #>> '{user,can_invite}')::boolean THEN
      v_fail := array_append(v_fail, 'personel oluşturma: ' || left(v_j::text, 300));
    END IF;
    SELECT count(*) INTO v_n FROM public.doctors d WHERE d.user_id = v_new;
    IF v_n <> 1 THEN
      v_fail := array_append(v_fail, 'hekim kaydı sayısı ' || v_n);
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_logs a
    WHERE a.clinic_id = v_clinic AND a.action = 'create' AND a.user_id = v_adm
      AND ((a.entity_type = 'users' AND a.entity_id = v_new)
           OR (a.entity_type = 'doctors' AND a.entity_id = (SELECT d.id FROM public.doctors d WHERE d.user_id = v_new)));
    IF v_n <> 2 THEN
      v_fail := array_append(v_fail, 'users/doctors create denetim kaydı ' || v_n);
    END IF;

    -- Idempotent retry.
    v_j := public.plt_staff_save(v_new, NULL, 'Öz Denetim Hekim', 'OZDENETIM-' || v_tag || '@DENTOS.LOCAL', '',
                                 'doctor', true, 'Endodonti');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'tekrar deneme already_saved değil');
    END IF;

    -- Owner role by an admin.
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_staff_save(gen_random_uuid(), NULL, 'Öz Denetim Sahip 2', 'p10-sc-o2-' || v_tag || '@example.com',
                                    '', 'owner', true, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_OWNER_ROLE' THEN
      v_fail := array_append(v_fail, 'sahip rolü: ' || coalesce(v_hint, '-'));
    END IF;

    -- Edit path: name, phone and specialty change; one users and one doctors 'update' audit row by the admin.
    v_upd := (SELECT u.updated_at FROM public.users u WHERE u.id = v_new);
    v_j := public.plt_staff_save(v_new, v_upd, 'Öz Denetim Hekim 2', 'ozdenetim-' || v_tag || '@dentos.local',
                                 '0532 000 00 00', 'doctor', true, 'Ortodonti');
    IF NOT coalesce((v_j ->> 'changed')::boolean, false)
       OR v_j #>> '{user,full_name}' IS DISTINCT FROM 'Öz Denetim Hekim 2'
       OR v_j #>> '{user,phone}' IS DISTINCT FROM '0532 000 00 00'
       OR v_j #>> '{user,doctor,specialty}' IS DISTINCT FROM 'Ortodonti' THEN
      v_fail := array_append(v_fail, 'personel düzenleme: ' || left(v_j::text, 300));
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_logs a
    WHERE a.clinic_id = v_clinic AND a.action = 'update' AND a.user_id = v_adm
      AND a.entity_type = 'users' AND a.entity_id = v_new;
    IF v_n <> 1 THEN
      v_fail := array_append(v_fail, 'users update denetim kaydı ' || v_n);
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_logs a
    WHERE a.clinic_id = v_clinic AND a.action = 'update' AND a.user_id = v_adm AND a.entity_type = 'doctors'
      AND a.entity_id = (SELECT d.id FROM public.doctors d WHERE d.user_id = v_new);
    IF v_n <> 1 THEN
      v_fail := array_append(v_fail, 'doctors update denetim kaydı ' || v_n);
    END IF;
    -- Same values again: no change.
    v_upd := (SELECT u.updated_at FROM public.users u WHERE u.id = v_new);
    v_j := public.plt_staff_save(v_new, v_upd, 'Öz Denetim Hekim 2', 'ozdenetim-' || v_tag || '@dentos.local',
                                 '0532 000 00 00', 'doctor', true, 'Ortodonti');
    IF coalesce((v_j ->> 'changed')::boolean, true) THEN
      v_fail := array_append(v_fail, 'değişmeyen düzenleme changed = true');
    END IF;
    -- Stale version (updated_at is constant inside one transaction, so a fixed old value is used).
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_staff_save(v_new, '2000-01-01 00:00:00+00'::timestamptz, 'Öz Denetim Hekim 3',
                                    'ozdenetim-' || v_tag || '@dentos.local', '0532 000 00 00', 'doctor', true,
                                    'Ortodonti');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_VERSION' THEN
      v_fail := array_append(v_fail, 'eski sürüm: ' || coalesce(v_hint, '-'));
    END IF;
    -- A legacy phone that no longer passes validation does not block an edit; a changed invalid phone does.
    UPDATE public.users SET phone = 'Tel. 0532/000.00.00' WHERE id = v_new;
    v_upd := (SELECT u.updated_at FROM public.users u WHERE u.id = v_new);
    v_j := public.plt_staff_save(v_new, v_upd, 'Öz Denetim Hekim 3', 'ozdenetim-' || v_tag || '@dentos.local',
                                 'Tel. 0532/000.00.00', 'doctor', true, 'Ortodonti');
    IF NOT coalesce((v_j ->> 'changed')::boolean, false) THEN
      v_fail := array_append(v_fail, 'eski telefonlu düzenleme: ' || left(v_j::text, 200));
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_staff_save(v_new, (SELECT u.updated_at FROM public.users u WHERE u.id = v_new),
                                    'Öz Denetim Hekim 3', 'ozdenetim-' || v_tag || '@dentos.local', 'Tel. 0532/111',
                                    'doctor', true, 'Ortodonti');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_PHONE' THEN
      v_fail := array_append(v_fail, 'değişen geçersiz telefon: ' || coalesce(v_hint, '-'));
    END IF;

    -- Finance holder's e-mail cannot be changed by a non-finance admin (RPC and direct UPDATE).
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_staff_save(v_fin, (SELECT u.updated_at FROM public.users u WHERE u.id = v_fin),
                                    'Öz denetim finans', 'p10-sc-fin2-' || v_tag || '@example.com', '', 'assistant',
                                    true, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_EMAIL_FINANCE' THEN
      v_fail := array_append(v_fail, 'finans e-postası (RPC): ' || coalesce(v_hint, '-'));
    END IF;
    v_hint := NULL;
    BEGIN
      UPDATE public.users SET email = 'p10-sc-fin3-' || v_tag || '@example.com' WHERE id = v_fin;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_EMAIL_FINANCE' THEN
      v_fail := array_append(v_fail, 'finans e-postası (UPDATE): ' || coalesce(v_hint, '-'));
    END IF;

    -- A linked row's e-mail cannot be changed directly; a case-only change is allowed.
    v_hint := NULL;
    BEGIN
      UPDATE public.users SET email = 'p10-sc-other-' || v_tag || '@example.com' WHERE id = v_lnk;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_EMAIL_LINKED' THEN
      v_fail := array_append(v_fail, 'bağlı e-posta (UPDATE): ' || coalesce(v_hint, '-'));
    END IF;
    UPDATE public.users SET email = upper(email) WHERE id = v_lnk;

    -- Invite context: the admin may not invite the finance holder; the owner may (no auth row has that e-mail).
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_invite_context(v_adm_auth, v_fin, 'invite');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_INVITE_FINANCE' THEN
      v_fail := array_append(v_fail, 'finans daveti (yönetici): ' || coalesce(v_hint, '-'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users a WHERE lower(a.email::text) = 'p10-sc-fin-' || v_tag || '@example.com') THEN
      v_j := public.plt_svc_invite_context(v_own_auth, v_fin, 'invite');
      IF v_j #>> '{target,email}' IS DISTINCT FROM 'p10-sc-fin-' || v_tag || '@example.com'
         OR v_j ->> 'caller_user_id' IS DISTINCT FROM v_own::text
         OR (v_j #>> '{auth,linked}')::boolean OR v_j::text LIKE '%auth_user_id%' THEN
        v_fail := array_append(v_fail, 'davet bağlamı: ' || left(v_j::text, 300));
      END IF;
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_invite_context(v_own_auth, v_new, 'invite');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_EMAIL_PLACEHOLDER' THEN
      v_fail := array_append(v_fail, 'geçici e-posta daveti: ' || coalesce(v_hint, '-'));
    END IF;

    -- Link refusals, invite / resend context for a linked row whose login account is gone, resend audit.
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_link_auth_user(v_own, v_tgt, gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_AUTH_MISSING' THEN
      v_fail := array_append(v_fail, 'bağlama, hesap yok: ' || coalesce(v_hint, '-'));
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_link_auth_user(v_adm, v_own, gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_OWNER_INVITE' THEN
      v_fail := array_append(v_fail, 'bağlama, sahip: ' || coalesce(v_hint, '-'));
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_invite_context(v_adm_auth, v_lnk, 'resend');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_AUTH_MISSING' THEN
      v_fail := array_append(v_fail, 'yeniden gönderim bağlamı, hesap yok: ' || coalesce(v_hint, '-'));
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_invite_context(v_adm_auth, v_lnk, 'invite');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_AUTH_MISSING' THEN
      v_fail := array_append(v_fail, 'davet bağlamı, hesap yok: ' || coalesce(v_hint, '-'));
    END IF;
    v_j := public.plt_svc_log_staff_event(v_adm, v_lnk, 'invite_resend');
    SELECT count(*) INTO v_n FROM public.audit_logs a
    WHERE a.clinic_id = v_clinic AND a.entity_type = 'users' AND a.entity_id = v_lnk AND a.action = 'invite_resend'
      AND a.user_id = v_adm;
    IF NOT coalesce((v_j ->> 'ok')::boolean, false) OR v_n <> 1 THEN
      v_fail := array_append(v_fail, 'yeniden gönderim denetim kaydı ' || v_n);
    END IF;

    -- Staff list as admin: owner row not editable, no auth_user_id anywhere, the new doctor present, the finance
    -- holder finance-locked (no invite offered).
    v_j := public.plt_staff_list();
    IF v_j::text LIKE '%auth_user_id%'
       OR (v_j ->> 'can_assign_owner')::boolean
       OR jsonb_array_length(v_j -> 'staff') <> 6
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'staff') s
                      WHERE s ->> 'id' = v_fin::text AND (s ->> 'finance_locked')::boolean
                        AND NOT (s ->> 'can_invite')::boolean)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'staff') s
                      WHERE s ->> 'id' = v_tgt::text AND NOT (s ->> 'finance_locked')::boolean
                        AND (s ->> 'can_invite')::boolean)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'staff') s
                      WHERE s ->> 'id' = v_own::text AND NOT (s ->> 'can_edit')::boolean)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'staff') s
                      WHERE s ->> 'id' = v_adm::text AND (s ->> 'is_me')::boolean
                        AND NOT (s ->> 'can_change_role_active')::boolean)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'staff') s
                      WHERE s ->> 'id' = v_lnk::text AND s #>> '{login,status}' = 'missing') THEN
      v_fail := array_append(v_fail, 'personel listesi: ' || left(v_j::text, 300));
    END IF;

    -- Patient archive: one audit row with only is_active / reason; a direct UPDATE is refused.
    v_j := public.plt_patient_set_active(v_patient, false, '  Öz denetim  ');
    IF NOT coalesce((v_j ->> 'changed')::boolean, false)
       OR (SELECT p.is_active FROM public.patients p WHERE p.id = v_patient) IS DISTINCT FROM false THEN
      v_fail := array_append(v_fail, 'arşivleme: ' || left(v_j::text, 200));
    END IF;
    SELECT count(*), string_agg(DISTINCT k.key, ',' ORDER BY k.key)
      INTO v_n, v_keys
    FROM public.audit_logs a
    CROSS JOIN LATERAL (
      SELECT jsonb_object_keys(coalesce(a.changes, '{}'::jsonb)) AS key
      UNION ALL SELECT jsonb_object_keys(coalesce(a.before_data, '{}'::jsonb))
      UNION ALL SELECT jsonb_object_keys(coalesce(a.after_data, '{}'::jsonb))
    ) k
    WHERE a.clinic_id = v_clinic AND a.entity_type = 'patients' AND a.action = 'archive' AND a.user_id = v_adm
      AND a.entity_id = v_patient;
    IF v_n = 0 OR v_keys IS DISTINCT FROM 'is_active,reason' THEN
      v_fail := array_append(v_fail, 'arşiv denetim kaydı anahtarları: ' || coalesce(v_keys, '-'));
    END IF;
    v_j := public.plt_patient_set_active(v_patient, false, NULL);
    IF (v_j ->> 'changed')::boolean THEN
      v_fail := array_append(v_fail, 'arşivleme tekrarında changed = true');
    END IF;
    v_hint := NULL;
    BEGIN
      UPDATE public.patients SET is_active = true WHERE id = v_patient;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_PATIENT_DIRECT' THEN
      v_fail := array_append(v_fail, 'doğrudan arşivden çıkarma: ' || coalesce(v_hint, '-'));
    END IF;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.patients (id, clinic_id, full_name, phone, is_active)
      VALUES (gen_random_uuid(), v_clinic, 'Öz denetim hasta 2', '5000000098', false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_PATIENT_DIRECT' THEN
      v_fail := array_append(v_fail, 'arşivde hasta ekleme: ' || coalesce(v_hint, '-'));
    END IF;

    -- Restore: one 'restore' audit row with only is_active / reason.
    v_j := public.plt_patient_set_active(v_patient, true, NULL);
    IF NOT coalesce((v_j ->> 'changed')::boolean, false)
       OR (SELECT p.is_active FROM public.patients p WHERE p.id = v_patient) IS DISTINCT FROM true THEN
      v_fail := array_append(v_fail, 'arşivden çıkarma: ' || left(v_j::text, 200));
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_logs a
    WHERE a.clinic_id = v_clinic AND a.entity_type = 'patients' AND a.action = 'restore' AND a.user_id = v_adm
      AND a.entity_id = v_patient;
    SELECT string_agg(DISTINCT k.key, ',' ORDER BY k.key)
      INTO v_keys
    FROM public.audit_logs a
    CROSS JOIN LATERAL (
      SELECT jsonb_object_keys(coalesce(a.changes, '{}'::jsonb)) AS key
      UNION ALL SELECT jsonb_object_keys(coalesce(a.before_data, '{}'::jsonb))
      UNION ALL SELECT jsonb_object_keys(coalesce(a.after_data, '{}'::jsonb))
    ) k
    WHERE a.clinic_id = v_clinic AND a.entity_type = 'patients' AND a.action = 'restore' AND a.user_id = v_adm
      AND a.entity_id = v_patient;
    IF v_n <> 1 OR v_keys IS DISTINCT FROM 'is_active,reason' THEN
      v_fail := array_append(v_fail, 'arşivden çıkarma denetim kaydı ' || v_n || ' / ' || coalesce(v_keys, '-'));
    END IF;

    -- The owner (not finance-locked) is offered the finance holder's invite.
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.plt_staff_list();
    IF NOT coalesce((v_j ->> 'can_assign_owner')::boolean, false)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'staff') s
                      WHERE s ->> 'id' = v_fin::text AND NOT (s ->> 'finance_locked')::boolean
                        AND (s ->> 'can_invite')::boolean) THEN
      v_fail := array_append(v_fail, 'personel listesi (sahip): ' || left(v_j::text, 300));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (personel / davet / arşiv): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p10_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;

  IF EXISTS (SELECT 1 FROM public.clinics c WHERE c.slug = v_slug) THEN
    RAISE EXCEPTION 'Öz denetim kliniği geri alınmadı: %', v_slug;
  END IF;
  IF nullif(current_setting('request.jwt.claims', true), '') IS DISTINCT FROM nullif(v_claims_before, '')
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS DISTINCT FROM nullif(v_sub_before, '')
     OR nullif(current_setting('request.jwt.claim.role', true), '') IS DISTINCT FROM nullif(v_role_before, '') THEN
    RAISE EXCEPTION 'request.jwt.claims / request.jwt.claim.* öz denetimden sonra eski değerine dönmedi.';
  END IF;
END $$;

-- Make the API see the new functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
