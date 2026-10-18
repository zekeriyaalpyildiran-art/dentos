-- Hakediş v1.2: the reception prepares the doctors' hakediş and the staff payroll ('hakedis_prepare', without the
-- finance permission), fixed monthly net salaries (rule kind fixed_monthly), monthly bonus / other rows
-- (fin_hk_adjustments), and the staff payroll written to Finans at month close (one personnel entry per staff payee
-- and month). Safe to re-run.
--
-- Contract: hakedis_spec_v12.md on top of 0030_hakedis.sql (v1 + v1.1, applied and live; not edited). Requires 0019
-- (users_guard), 0020, 0022, 0024 (owner-only stock grants, kept below), 0027 (plt__finance_locked) and 0030.
-- Independent of 0029.
--
--  * No names, rates or amounts in this file: salaries, bonuses and rates are rows the owner / the reception enter.
--  * Permission 'hakedis_prepare' (UI "Hakediş ve maaş hazırlama"): staff_permissions CHECK recreated with the full
--    key list; grant_staff_permission / revoke_staff_permission keep the 0024 bodies and add: 'hakedis_prepare' is
--    granted and revoked by the clinic OWNER only (an admin or a non-owner finance writer gets 42501).
--  * A 'hakedis_prepare' grant cannot be handed over or revived behind the owner's back either:
--    - plt__finance_locked (0027 body; drives PLT_EMAIL_FINANCE in plt_staff_save / plt_users_email_guard and
--      PLT_INVITE_FINANCE in the invite functions) also locks a row holding an active 'hakedis_prepare' grant, so an
--      admin without 'finance' cannot re-address an unlinked holder to a mailbox they control and invite it;
--    - users_guard (0019 §4 body) lets only the owner reactivate a user who still holds 'hakedis_prepare' (granting it
--      is owner-only, so reviving it is too; a non-owner 'finance' holder is refused as well).
--  * fin__hk_require_prep_read() (finance, finance_readonly or hakedis_prepare) / fin__hk_require_prep_write()
--    (finance or hakedis_prepare): SECURITY INVOKER like every fin__* helper; return the caller's clinic or 42501.
--    Switched to them (same signatures, bodies of 0030 otherwise): fin_hk_reference, fin_hk_month, fin_hk_marks (read)
--    and fin_hk_save_line / void_line / save_piece / void_piece / save_mark / save_lab_cost / void_lab_cost (write).
--    Finance-only as before: fin_hk_save_rule, fin_hk_save_settings, fin_hk_close_month; fin_hk_reopen_month (owner).
--    fin_hk_save_mark by a caller without 'finance' is held by the reception's closed-month lock (fin__hk_mark_locked:
--    own doctor, birth date or child flag of a patient with a live line in a closed month).
--  * Ledger data stays with finance / finance_readonly holders: for a caller without them (hakedis_prepare only)
--    fin_hk_month (and close / reopen, which such a caller cannot call) leaves out payees[].counterparty_id, the
--    NO_COUNTERPARTY warnings, statements[].entry (null; fin_entry_id stays) and breakdown.counterparty_id. Nothing
--    else in the hakediş payloads comes from fin_entries / fin_payments. fin_hk_reference still lists lab names
--    (active lab counterparties, strings only) for the lab cost picker.
--  * Rule kind fixed_monthly: payee = any active user of the clinic (staff or doctor), no doctor / segment / share /
--    deductions, piece_cents = the monthly NET salary (> 0). Overlap per (clinic, kind, payee) for fixed_monthly; the
--    other kinds keep (clinic, kind, doctor, segment) regardless of the payee.
--  * fin_hk_adjustments: per payee and month, kind 'bonus' | 'other', amount <> 0 (negative = deduction), description
--    1..500, voided with a reason, never deleted; RLS SELECT for finance holders only; same closed-month lock as
--    lines (a closed month, or any month before a closed one, cannot be written); never a month after the current
--    one. fin_hk_save_adjustment / fin_hk_void_adjustment (prep write).
--  * fin__hk_compute adds per payee one 'fixed_monthly' component per active rule and one 'adjustments' component (Σ
--    live rows of the month, with the rows as items); the payee total includes both; a payee may have only these.
--    Months without them give exactly the 0030 result.
--  * Month close: a payee with a doctors row keeps the 0030 entitlement path (one 'Hekim hakedişi' entry, whose total
--    now includes salary / bonus). A payee without a doctors row whose components are only fixed_monthly /
--    adjustments (staff) gets one entry 'payroll:<counterparty>:<YYYY-MM>' in the active system category of bucket
--    'personnel' (no subcategory, no entitlement month, due date the 1st of the month like fin_add_entitlement),
--    under a 'staff' counterparty linked to the user (fin_counterparties.staff_user_id; created, or an unlinked staff
--    counterparty of the same name is linked). Same safety rules as the entitlement path: amount never below what is
--    paid, a cancelled entry is refused, a live entry of an earlier statement that the close does not account for is
--    refused, total 0 → no entry. A payee without a doctors row with hakediş components is refused as in 0030.
--    A payroll entry keeps its person and category like an entitlement entry (fin_edit_entry, 0020): the trigger
--    fin_payroll_entry_guard on fin_entries refuses a counterparty, category, subcategory or entitlement month change
--    on source_key 'payroll:%'; amount (never below what is paid), due date and description stay editable.
--  * hk_my_months / hk_my_month: the caller's own payroll components come with the payee object; the month's entry is
--    the payee's entitlement or payroll entry. Still only the caller's own data.
--  * fin_audit_list / fin_export_manifest include fin_hk_adjustments.
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). The UI shows error.message verbatim.
--
-- JSON shapes (changes against 0030; months are 'YYYY-MM-01' dates):
--   AdjustmentJson  {id, version, month, payee_user_id, payee_name, kind, amount_cents, description, is_voided,
--                    voided_at, voided_by_name, void_reason, created_at, created_by_name, updated_at, updated_by_name}
--   Component       + {rule_id, kind: 'fixed_monthly', doctor_id: null, doctor_name: null, segment: null, share_bp: null,
--                      piece_cents (= the salary), by_method: null, base_cents: null, amount_cents (= the salary),
--                      qty: null, lines_count: 0, lab_patients: null}
--                   + {kind: 'adjustments', amount_cents (Σ items), items: [{id, kind, amount_cents, description}]}
--                     (live rows of the month, oldest first; no rule_id). Order in a payee: the 0030 kinds, then
--                     fixed_monthly, then adjustments.
--   Payee           counterparty_id: the physician counterparty (doctors row) or, for a staff payee, the staff
--                   counterparty linked to the user.
--   Warning         NO_COUNTERPARTY reason 'no_doctor' only for a payee without a doctors row that has hakediş
--                   components; a staff payee reports 'missing' (created at close) or 'inactive'.
--   fin_hk_reference()  + {can_prepare, ledger_visible}; payees: every user of the clinic (inactive flagged)
--                       {user_id, name, role, is_active, doctor_id (null for staff)}.
--   fin_hk_month(), fin_hk_close_month(), fin_hk_reopen_month()
--                       + {can_prepare, ledger_visible, adjustments: [AdjustmentJson] (the month's rows of every
--                       payee, voided ones included)}; stripped as above when ledger_visible is false.
--   fin_hk_save_adjustment(), fin_hk_void_adjustment()  {already_saved, record: AdjustmentJson}
--   hk_my_month()       entitlement: the caller's entitlement entry, or the payroll entry for a staff payee.
--
-- RUNBOOK (production is the only database):
--   1. Quiet moment (a few seconds): staff_permissions, fin_counterparties and fin_hk_rules get new constraints and
--      fin_entries a new trigger in this transaction, so permission checks and finance writes wait until it commits.
--      SQL editor → New query → paste this file ALONE → Run. One transaction; the self-checks at the end (including a
--      replay in a temporary clinic that is always rolled back) undo everything on any failure.
--   2. Deploy the web build with the 'Hakediş ve maaş' pages afterwards (before step 1 the new calls fail with the RPC
--      error; the existing finance Hakediş pages keep working).
--   3. Owner: Ayarlar → Yetkiler → give the reception user "Hakediş ve maaş hazırlama".
--   Re-running 0019, 0024 or 0027 later puts back their older users_guard / grant_staff_permission /
--   revoke_staff_permission / plt__finance_locked bodies (no 'hakedis_prepare' rules): re-run this file afterwards.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Salary rules first. The 0030 fin__hk_compute has no kind filter: it turns every fixed_monthly rule into a
--       component with a NULL amount, so the salary silently drops out of a doctor's total and a staff payee gets a
--       NULL total. So, if any fin_hk_rules row has kind 'fixed_monthly', delete those rows first
--       (DELETE FROM public.fin_hk_rules WHERE kind = 'fixed_monthly'; fin__trg_no_delete allows row deletes from the
--       SQL editor); if they must stay, do not roll back. The bonus / other rows are lost with the DROP TABLE in (c):
--       export fin_hk_adjustments first if they are needed.
--   (b) Re-run the 0030 definitions of the fin_hk_* RPCs, fin__hk_compute, fin__hk_description, fin__hk_month_json,
--       hk_my_months / hk_my_month, fin_audit_list and fin_export_manifest; 0024 §8.0 (grant_staff_permission /
--       revoke_staff_permission); 0027 plt__finance_locked; 0019 §4 users_guard (the function only).
--   (c) DROP TRIGGER IF EXISTS fin_counterparty_staff ON public.fin_counterparties;
--       DROP TRIGGER IF EXISTS fin_payroll_entry_guard ON public.fin_entries;
--       DROP TABLE public.fin_hk_adjustments;   (drops the table's own triggers too)
--   (d) Only then DROP FUNCTION the functions new here: fin_hk_save_adjustment, fin_hk_void_adjustment,
--       fin__hk_require_prep_read / _write, fin__hk_strip_ledger, fin__hk_adjustment_json, fin__hk_parts,
--       fin__hk_payroll_description, fin__hk_payee_entry, fin__trg_hk_adjustment_guard, fin__trg_counterparty_staff,
--       fin__trg_payroll_entry_guard.
--   (e) Only when no staff link exists (no fin_counterparties.staff_user_id set): restore the 0030 fin_hk_rules kind
--       constraints and DROP COLUMN fin_counterparties.staff_user_id. Revoke every 'hakedis_prepare' grant before
--       restoring the 0019 staff_permissions CHECK (after (b) revoke_staff_permission no longer knows the key: use
--       UPDATE public.staff_permissions SET revoked_at = now() WHERE permission = 'hakedis_prepare' AND revoked_at IS
--       NULL; revoked rows keep the key, so add the old CHECK back NOT VALID, or keep the 0031 one, a superset).
--   Payroll entries already written by a close stay in the ledger (ordinary 0020 personnel entries).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0019 / 0020 / 0022 / 0024 / 0027 / 0030 live, expected columns, and a fin_hk_adjustments table or a
--     fin_counterparties.staff_user_id column left by an earlier run must already have the shape created below.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'grant_staff_permission', 'revoke_staff_permission', 'audit_row_change',
                    'fin__require_read', 'fin__require_write', 'fin_can_read', 'fin__harden_privileges',
                    'fin__normalize_name', 'fin__month_start', 'fin__reason', 'fin__day', 'fin__user_name',
                    'fin__paid', 'fin__page', 'fin__trg_touch', 'fin__trg_no_delete', 'fin_add_entitlement',
                    'fin_cancel_entry', 'fin_record_payment', 'fin_audit_list', 'fin_export_manifest',
                    'fin__hk_tl', 'fin__hk_pct', 'fin__hk_patient_name', 'fin__hk_patient_ref', 'fin__hk_desc',
                    'fin__hk_birth_date', 'fin__hk_doctor_name', 'fin__hk_child_age_limit', 'fin__hk_closed_lines',
                    'fin__hk_mark_locked', 'fin__hk_check_open', 'fin__hk_close_lock', 'fin__hk_month_lock',
                    'fin__hk_ortho_walk', 'fin__hk_eval_lines', 'fin__hk_compute', 'fin__hk_self_payee',
                    'fin__hk_description', 'fin__hk_lab_names', 'fin__hk_rule_json', 'fin__hk_line_json',
                    'fin__hk_piece_json', 'fin__hk_mark_json', 'fin__hk_lab_cost_json', 'fin__hk_month_row_json',
                    'fin__hk_statement_json', 'fin__hk_settings_json', 'fin__hk_month_json', 'fin__trg_hk_refs',
                    'fin_hk_reference', 'fin_hk_month', 'fin_hk_marks', 'fin_hk_save_rule', 'fin_hk_save_line',
                    'fin_hk_void_line', 'fin_hk_save_piece', 'fin_hk_void_piece', 'fin_hk_save_mark',
                    'fin_hk_save_settings', 'fin_hk_save_lab_cost', 'fin_hk_void_lab_cost', 'fin_hk_close_month',
                    'fin_hk_reopen_month', 'hk_my_months', 'hk_my_month', 'hk_marks_access', 'hk_marks_list',
                    'hk_save_mark', 'fin_edit_entry', 'users_guard', 'plt__finance_locked', 'plt_staff_save',
                    'plt_svc_invite_context']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0019, 0020, 0022, 0024, 0027 ve 0030 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;
  IF to_regprocedure('public.plt__finance_locked(uuid,uuid)') IS NULL OR to_regprocedure('public.users_guard()') IS NULL
  THEN
    RAISE EXCEPTION 'plt__finance_locked(uuid, uuid) / users_guard() beklenen imzada değil; önce 0019 ve 0027 uygulanmalı.';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() / auth.jwt() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  -- The grant / revoke bodies replaced below are 0024's (owner-only stock grants); refuse an older shape.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'grant_staff_permission'
      AND p.prosrc LIKE '%Stok yönetim yetkisini yalnızca klinik sahibi verebilir.%'
  ) THEN
    RAISE EXCEPTION 'grant_staff_permission 0024 sürümünde değil; önce 0024 uygulanmalı.';
  END IF;

  -- users_guard is replaced below with the 0019 body plus one check; refuse a body that is not 0019's (on a re-run
  -- it is this file's, which keeps the 0019 text).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'users_guard'
      AND p.prosrc LIKE '%Finans yetkisi olan personeli yalnızca klinik sahibi veya finans yetkilisi yeniden aktifleştirebilir.%'
  ) THEN
    RAISE EXCEPTION 'users_guard 0019 sürümünde değil.';
  END IF;

  SELECT string_agg(t.tbl, ', ')
    INTO v_missing
  FROM unnest(ARRAY['clinics', 'users', 'doctors', 'audit_logs', 'staff_permissions', 'fin_entries', 'fin_payments',
                    'fin_counterparties', 'fin_categories', 'fin_accounts', 'fin_settings', 'fin_hk_rules',
                    'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks', 'fin_hk_lab_costs', 'fin_hk_months',
                    'fin_hk_statements'])
    AS t(tbl)
  WHERE to_regclass(format('public.%I', t.tbl)) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen tablolar bulunamadı (0020, 0022 ve 0030 uygulanmalı): %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('staff_permissions', 'permission'), ('staff_permissions', 'revoked_at'),
    ('users', 'id'), ('users', 'clinic_id'), ('users', 'role'), ('users', 'full_name'), ('users', 'is_active'),
    ('doctors', 'id'), ('doctors', 'clinic_id'), ('doctors', 'user_id'),
    ('fin_counterparties', 'id'), ('fin_counterparties', 'clinic_id'), ('fin_counterparties', 'name'),
    ('fin_counterparties', 'normalized_name'), ('fin_counterparties', 'kind'), ('fin_counterparties', 'doctor_id'),
    ('fin_counterparties', 'note'), ('fin_counterparties', 'is_active'),
    ('fin_entries', 'id'), ('fin_entries', 'clinic_id'), ('fin_entries', 'category_id'),
    ('fin_entries', 'subcategory'), ('fin_entries', 'counterparty_id'), ('fin_entries', 'counterparty_text'),
    ('fin_entries', 'description'), ('fin_entries', 'due_date'), ('fin_entries', 'amount_cents'),
    ('fin_entries', 'entitlement_month'), ('fin_entries', 'cancelled_at'), ('fin_entries', 'source_key'),
    ('fin_entries', 'version'),
    ('fin_categories', 'id'), ('fin_categories', 'clinic_id'), ('fin_categories', 'report_bucket'),
    ('fin_categories', 'is_system'), ('fin_categories', 'is_active'),
    ('fin_settings', 'hk_child_age_limit'),
    ('fin_hk_rules', 'kind'), ('fin_hk_rules', 'payee_user_id'), ('fin_hk_rules', 'piece_cents'),
    ('fin_hk_statements', 'fin_entry_id')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı: %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_adjustments', 'id'), ('fin_hk_adjustments', 'clinic_id'), ('fin_hk_adjustments', 'month'),
    ('fin_hk_adjustments', 'payee_user_id'), ('fin_hk_adjustments', 'kind'), ('fin_hk_adjustments', 'amount_cents'),
    ('fin_hk_adjustments', 'description'), ('fin_hk_adjustments', 'voided_at'), ('fin_hk_adjustments', 'voided_by'),
    ('fin_hk_adjustments', 'void_reason'), ('fin_hk_adjustments', 'version'), ('fin_hk_adjustments', 'created_by'),
    ('fin_hk_adjustments', 'created_at'), ('fin_hk_adjustments', 'updated_by'), ('fin_hk_adjustments', 'updated_at')
  ) AS e(tbl, col)
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut fin_hk_adjustments tablosu beklenen yapıda değil: %', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'fin_counterparties' AND c.column_name = 'staff_user_id'
      AND c.data_type <> 'uuid'
  ) THEN
    RAISE EXCEPTION 'fin_counterparties.staff_user_id beklenen yapıda değil.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Permission 'hakedis_prepare'. The staff_permissions CHECK (0019, inline, so its name is generated) is replaced
--     by one named constraint with the full key list. First, so the lock on staff_permissions is taken before any
--     other table of this file.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'permission'
    WHERE c.conrelid = 'public.staff_permissions'::regclass
      AND c.contype = 'c'
      AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.staff_permissions DROP CONSTRAINT %I', v_con);
  END LOOP;
END $$;

ALTER TABLE public.staff_permissions
  ADD CONSTRAINT staff_permissions_permission_check CHECK (permission IN (
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical', 'hakedis_prepare'
  ));

-- 0024 §8.0 bodies (CREATE OR REPLACE keeps the ACL) plus 'hakedis_prepare' in the key list and one rule: it is
-- granted and revoked by the clinic owner only (salaries and every payee's figures; a finance holder who is not the
-- owner sees them anyway but must not hand them out).
CREATE OR REPLACE FUNCTION public.grant_staff_permission(p_user_id uuid, p_permission text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_caller FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF v_caller.id IS NULL OR v_caller.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Yetki vermek için klinik sahibi veya yönetici olmanız gerekir.';
  END IF;

  IF p_permission IS NULL OR p_permission NOT IN (
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical', 'hakedis_prepare'
  ) THEN
    RAISE EXCEPTION 'Geçersiz yetki türü: %', coalesce(p_permission, '(boş)');
  END IF;

  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF v_target.id IS NULL OR v_target.clinic_id <> v_caller.clinic_id THEN
    RAISE EXCEPTION 'Personel bulunamadı.';
  END IF;
  IF v_target.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pasif personelin yetkileri değiştirilemez.';
  END IF;

  IF p_permission IN ('finance', 'finance_readonly') AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Finans yetkilerini yalnızca finans yetkisi olan kullanıcılar verebilir.';
  END IF;
  IF p_permission = 'stock_manage' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Stok yönetim yetkisini yalnızca klinik sahibi verebilir.' USING ERRCODE = '42501';
  END IF;
  IF p_permission = 'stock_cost_view' AND v_caller.role <> 'owner' AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Stok maliyet yetkisini yalnızca klinik sahibi veya finans yetkisi olan kullanıcılar verebilir.'
      USING ERRCODE = '42501';
  END IF;
  IF p_permission = 'hakedis_prepare' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Hakediş ve maaş hazırlama yetkisini yalnızca klinik sahibi verebilir.' USING ERRCODE = '42501';
  END IF;

  -- Already granted is not an error.
  INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by)
  VALUES (v_target.clinic_id, v_target.id, p_permission, v_caller.id)
  ON CONFLICT (user_id, permission) WHERE revoked_at IS NULL DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_staff_permission(p_user_id uuid, p_permission text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_caller FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF v_caller.id IS NULL OR v_caller.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Yetki kaldırmak için klinik sahibi veya yönetici olmanız gerekir.';
  END IF;

  IF p_permission IS NULL OR p_permission NOT IN (
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical', 'hakedis_prepare'
  ) THEN
    RAISE EXCEPTION 'Geçersiz yetki türü: %', coalesce(p_permission, '(boş)');
  END IF;

  -- Inactive targets are allowed here (unlike grant) so a departed person's grants can still be cleaned up.
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF v_target.id IS NULL OR v_target.clinic_id <> v_caller.clinic_id THEN
    RAISE EXCEPTION 'Personel bulunamadı.';
  END IF;

  IF p_permission IN ('finance', 'finance_readonly') AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Finans yetkilerini yalnızca finans yetkisi olan kullanıcılar kaldırabilir.';
  END IF;
  IF p_permission = 'stock_manage' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Stok yönetim yetkisini yalnızca klinik sahibi kaldırabilir.' USING ERRCODE = '42501';
  END IF;
  IF p_permission = 'stock_cost_view' AND v_caller.role <> 'owner' AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Stok maliyet yetkisini yalnızca klinik sahibi veya finans yetkisi olan kullanıcılar kaldırabilir.'
      USING ERRCODE = '42501';
  END IF;
  IF p_permission = 'hakedis_prepare' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Hakediş ve maaş hazırlama yetkisini yalnızca klinik sahibi kaldırabilir.' USING ERRCODE = '42501';
  END IF;

  -- An admin must not be able to strip the owner, who could then not win finance back.
  IF v_target.role = 'owner' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Klinik sahibinin yetkilerini yalnızca klinik sahibi kaldırabilir.';
  END IF;

  IF p_permission = 'finance' THEN
    -- Serialise finance revokes and finance-holder deactivations (users_guard) per clinic, so two concurrent
    -- changes cannot both pass the last-holder check.
    PERFORM pg_advisory_xact_lock(hashtextextended('staff_permissions.finance:' || v_target.clinic_id::text, 0));

    -- Only an active holder counts; revoking an inactive one's leftover grant never lowers the active count.
    IF v_target.is_active = true AND EXISTS (
      SELECT 1 FROM public.staff_permissions
      WHERE user_id = v_target.id AND permission = 'finance' AND revoked_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.staff_permissions sp
      JOIN public.users u ON u.id = sp.user_id
      WHERE sp.clinic_id = v_target.clinic_id
        AND sp.permission = 'finance'
        AND sp.revoked_at IS NULL
        AND sp.user_id <> v_target.id
        AND u.is_active = true
    ) THEN
      RAISE EXCEPTION 'Klinikteki son finans yetkilisinin finans yetkisi kaldırılamaz.';
    END IF;
  END IF;

  -- Nothing active to revoke is not an error.
  UPDATE public.staff_permissions
  SET revoked_at = now(), revoked_by = v_caller.id
  WHERE user_id = v_target.id
    AND permission = p_permission
    AND revoked_at IS NULL;
END;
$$;

-- Same ACL as 0019 / 0024 (idempotent; CREATE OR REPLACE already kept it).
REVOKE EXECUTE ON FUNCTION public.grant_staff_permission(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_staff_permission(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_staff_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_permission(uuid, text) TO authenticated;

-- 1.1b 'hakedis_prepare' shows every salary, bonus and payee figure and is granted by the owner only, so the
--      finance escalation guards of 0019 / 0027 cover it too.
--
-- (1) 0027 plt__finance_locked, body unchanged except that the target side also counts an active 'hakedis_prepare'
--     grant: an unlinked holder must not be re-addressed (plt_staff_save / plt_users_email_guard: PLT_EMAIL_FINANCE)
--     or invited (plt_svc_invite_context / plt_svc_link_auth_user: PLT_INVITE_FINANCE) by an admin without 'finance',
--     who would otherwise get a login carrying the grant. The owner and active 'finance' holders (who see the figures
--     anyway) stay unlocked, as for finance grants. The PLT_* texts still say "Finans yetkisi"; the key is the same.
--     CREATE OR REPLACE keeps the 0027 ACL (internal: no EXECUTE for PUBLIC, anon, authenticated or service_role);
--     repeated for a re-run.
CREATE OR REPLACE FUNCTION public.plt__finance_locked(p_target uuid, p_caller uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.staff_permissions sp
           WHERE sp.user_id = p_target AND sp.permission IN ('finance', 'finance_readonly', 'hakedis_prepare')
             AND sp.revoked_at IS NULL
         )
     AND NOT coalesce((
           SELECT u.role = 'owner'
              OR EXISTS (SELECT 1 FROM public.staff_permissions sp
                         WHERE sp.user_id = u.id AND sp.permission = 'finance' AND sp.revoked_at IS NULL)
           FROM public.users u
           WHERE u.id = p_caller AND u.is_active = true
         ), false)
$$;

REVOKE EXECUTE ON FUNCTION public.plt__finance_locked(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- (2) 0019 §4 users_guard, body verbatim plus one check after the finance reactivation rule: grants survive
--     deactivation and has_permission only looks at is_active, so reactivating a 'hakedis_prepare' holder revives an
--     owner-only grant and is owner-only too. plt_staff_save passes the error through. CREATE OR REPLACE keeps the
--     trigger and the ACL; the 0019 ACL lines are repeated for a re-run.
CREATE OR REPLACE FUNCTION public.users_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_caller_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    -- Both the JWT role claim and the API role PostgREST switched to are checked, so a request without
    -- claims still cannot pass as the SQL editor.
    IF coalesce(auth.jwt() ->> 'role', '') IN ('anon', 'authenticated')
       OR coalesce(current_setting('role', true), '') IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION 'Oturum açmadan personel kaydı değiştirilemez.';
    END IF;
    RETURN NEW;
  END IF;

  v_caller_is_owner := EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = v_uid AND is_active = true AND role = 'owner'
  );

  IF TG_OP = 'INSERT' THEN
    -- Logins are linked by hand in the SQL editor, never from the client.
    IF NEW.auth_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'Yeni personel kaydı bir oturum hesabına bağlı olarak eklenemez.';
    END IF;
    IF NEW.role = 'owner' AND NOT v_caller_is_owner THEN
      RAISE EXCEPTION 'Klinik sahibi rolünü yalnızca klinik sahibi atayabilir.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
    RAISE EXCEPTION 'Personelin oturum hesabı bağlantısı değiştirilemez.';
  END IF;
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
    RAISE EXCEPTION 'Personelin kliniği değiştirilemez.';
  END IF;

  IF OLD.auth_user_id = v_uid
     AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
    RAISE EXCEPTION 'Kendi rolünüzü veya aktiflik durumunuzu değiştiremezsiniz.';
  END IF;

  IF NOT v_caller_is_owner THEN
    -- The whole owner row, not just role/status: an admin must not rename it or swap its e-mail either.
    IF OLD.role = 'owner' THEN
      RAISE EXCEPTION 'Klinik sahibinin kaydını yalnızca klinik sahibi değiştirebilir.';
    END IF;
    IF NEW.role = 'owner' THEN
      RAISE EXCEPTION 'Klinik sahibi rolünü yalnızca klinik sahibi atayabilir.';
    END IF;
  END IF;

  -- Grants survive deactivation, so reactivating a finance holder revives their grant; that needs the same
  -- right as granting it. The caller is never the target here (own status changes were refused above).
  IF OLD.is_active IS DISTINCT FROM true AND NEW.is_active = true
     AND NOT v_caller_is_owner
     AND NOT public.has_permission('finance')
     AND EXISTS (
       SELECT 1 FROM public.staff_permissions
       WHERE user_id = OLD.id
         AND permission IN ('finance', 'finance_readonly')
         AND revoked_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Finans yetkisi olan personeli yalnızca klinik sahibi veya finans yetkilisi yeniden aktifleştirebilir.';
  END IF;

  -- 0031: 'hakedis_prepare' is granted by the owner only, so reviving a holder's grant is owner-only too
  -- (a non-owner finance writer cannot grant it either).
  IF OLD.is_active IS DISTINCT FROM true AND NEW.is_active = true
     AND NOT v_caller_is_owner
     AND EXISTS (
       SELECT 1 FROM public.staff_permissions
       WHERE user_id = OLD.id AND permission = 'hakedis_prepare' AND revoked_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Hakediş ve maaş hazırlama yetkisi olan personeli yalnızca klinik sahibi yeniden aktifleştirebilir.'
      USING ERRCODE = '42501';
  END IF;

  -- Deactivating the last active finance holder would leave nobody able to grant finance again.
  -- Same lock key as revoke_staff_permission, so a revoke and a deactivation cannot both slip through.
  IF OLD.is_active = true AND NEW.is_active IS DISTINCT FROM true
     AND EXISTS (
       SELECT 1 FROM public.staff_permissions
       WHERE user_id = OLD.id AND permission = 'finance' AND revoked_at IS NULL
     ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('staff_permissions.finance:' || OLD.clinic_id::text, 0));

    IF NOT EXISTS (
      SELECT 1
      FROM public.staff_permissions sp
      JOIN public.users u ON u.id = sp.user_id
      WHERE sp.clinic_id = OLD.clinic_id
        AND sp.permission = 'finance'
        AND sp.revoked_at IS NULL
        AND sp.user_id <> OLD.id
        AND u.is_active = true
    ) THEN
      RAISE EXCEPTION 'Klinikteki son finans yetkilisi pasif yapılamaz.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.users_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.users_guard() TO authenticated;

-- ---------------------------------------------------------------------------
-- 1.2 Schema
-- ---------------------------------------------------------------------------

-- Rule kind fixed_monthly (monthly net salary in piece_cents). The inline kind CHECK of 0030 (generated name) is
-- replaced by a named one; the shape CHECK gets the fixed_monthly branch.
DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'kind'
    WHERE c.conrelid = 'public.fin_hk_rules'::regclass
      AND c.contype = 'c'
      AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.fin_hk_rules DROP CONSTRAINT %I', v_con);
  END LOOP;
END $$;

ALTER TABLE public.fin_hk_rules
  DROP CONSTRAINT IF EXISTS fin_hk_rules_kind_shape,
  ADD CONSTRAINT fin_hk_rules_kind_check CHECK (
    kind IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share', 'fixed_monthly')
  ),
  -- Which fields each kind uses; deductions only before a percentage of ciro.
  ADD CONSTRAINT fin_hk_rules_kind_shape CHECK (
    (kind = 'ciro_share' AND doctor_id IS NOT NULL AND segment IS NOT NULL AND share_bp IS NOT NULL
       AND piece_cents IS NULL)
    OR (kind = 'ortho_lab_first' AND doctor_id IS NOT NULL AND segment IS NULL AND share_bp IS NOT NULL
       AND piece_cents IS NULL)
    OR (kind = 'implant_piece' AND doctor_id IS NOT NULL AND segment IS NULL AND share_bp IS NULL
       AND piece_cents IS NOT NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0)
    OR (kind = 'clinic_ciro_share' AND doctor_id IS NULL AND segment IS NULL AND share_bp IS NOT NULL
       AND piece_cents IS NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0)
    OR (kind = 'fixed_monthly' AND doctor_id IS NULL AND segment IS NULL AND share_bp IS NULL
       AND piece_cents IS NOT NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0)
  );

-- Staff counterparty of a payroll payee: linked to the user (at most one per user and clinic), only on kind 'staff'.
-- Created or linked by fin_hk_close_month; fin_save_counterparty leaves the link as it is.
ALTER TABLE public.fin_counterparties
  ADD COLUMN IF NOT EXISTS staff_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fin_counterparties'::regclass AND conname = 'fin_counterparties_staff_kind'
  ) THEN
    ALTER TABLE public.fin_counterparties
      ADD CONSTRAINT fin_counterparties_staff_kind CHECK (staff_user_id IS NULL OR kind = 'staff');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS fin_counterparties_staff_user_key
  ON public.fin_counterparties (clinic_id, staff_user_id) WHERE staff_user_id IS NOT NULL;

-- Bonus / other rows per payee and month (TL cents, negative = deduction). Voided with a reason, never deleted.
CREATE TABLE IF NOT EXISTS public.fin_hk_adjustments (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1 AND month BETWEEN DATE '2000-01-01' AND DATE '2100-12-01'),
  payee_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,   -- same clinic: fin_hk_refs
  kind text NOT NULL CHECK (kind IN ('bonus', 'other')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND amount_cents BETWEEN -1000000000000 AND 1000000000000),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  voided_at timestamptz,
  voided_by uuid REFERENCES public.users(id),
  void_reason text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_hk_adjustments_void_shape CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 3 AND 500)
  )
);
CREATE INDEX IF NOT EXISTS idx_fin_hk_adjustments_month ON public.fin_hk_adjustments (clinic_id, month);
CREATE INDEX IF NOT EXISTS idx_fin_hk_adjustments_payee
  ON public.fin_hk_adjustments (clinic_id, payee_user_id, month);

-- ---------------------------------------------------------------------------
-- 1.3 Guard triggers (SECURITY DEFINER, never granted). The RPCs check the same rules first.
-- ---------------------------------------------------------------------------

-- A staff link stays on a 'staff' counterparty and points at a user of the same clinic.
CREATE OR REPLACE FUNCTION public.fin__trg_counterparty_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.staff_user_id IS NOT NULL THEN
    IF NEW.kind <> 'staff' THEN
      RAISE EXCEPTION 'Personele bağlı cari kaydının türü "personel" kalmalı.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = NEW.staff_user_id AND u.clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'Kişi bulunamadı.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fin_counterparty_staff ON public.fin_counterparties;
CREATE TRIGGER fin_counterparty_staff
  BEFORE INSERT OR UPDATE ON public.fin_counterparties
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_counterparty_staff();

-- A payroll entry written by fin_hk_close_month keeps its person and category, as fin_edit_entry (0020) keeps an
-- entitlement entry's: the next close finds it by source_key and rewrites only amount and description, so a moved
-- entry would book the salary outside the personnel bucket or under someone else. A trigger instead of a new
-- fin_edit_entry body; only fin_edit_entry changes these columns today. Amount (never below what is paid), due date
-- and description stay editable; personnel entries have no entitlement month or subcategory (fin_entry_guard).
CREATE OR REPLACE FUNCTION public.fin__trg_payroll_entry_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.source_key LIKE 'payroll:%'
     AND (NEW.counterparty_id, NEW.counterparty_text, NEW.category_id, NEW.subcategory, NEW.entitlement_month)
         IS DISTINCT FROM (OLD.counterparty_id, OLD.counterparty_text, OLD.category_id, OLD.subcategory,
                           OLD.entitlement_month) THEN
    RAISE EXCEPTION 'Maaş kaydının kişisi ve kategorisi değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fin_payroll_entry_guard ON public.fin_entries;
CREATE TRIGGER fin_payroll_entry_guard
  BEFORE UPDATE OF counterparty_id, counterparty_text, category_id, subcategory, entitlement_month
  ON public.fin_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_payroll_entry_guard();

-- Adjustments: nothing is written into a closed month or a month before a closed one (old and new month on an
-- edit), a voided row is frozen, a row cannot be inserted voided. Same lock as lines (fin__hk_check_open).
CREATE OR REPLACE FUNCTION public.fin__trg_hk_adjustment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt eklenemez.';
    END IF;
    PERFORM public.fin__hk_check_open(NEW.clinic_id, NEW.month);
    RETURN NEW;
  END IF;

  IF OLD.voided_at IS NOT NULL THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM public.fin__hk_check_open(OLD.clinic_id, OLD.month);
  IF NEW.month IS DISTINCT FROM OLD.month THEN
    PERFORM public.fin__hk_check_open(NEW.clinic_id, NEW.month);
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger wiring, RLS (SELECT for finance / finance_readonly holders only), no write privileges, audit. BEFORE
-- triggers fire in name order: fin_hk_guard, fin_hk_refs, then fin_touch.
DO $$
DECLARE
  v_t text := 'fin_hk_adjustments';
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS fin_touch ON public.%I', v_t);
  EXECUTE format('CREATE TRIGGER fin_touch BEFORE UPDATE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_touch()', v_t);
  EXECUTE format('DROP TRIGGER IF EXISTS fin_no_delete ON public.%I', v_t);
  EXECUTE format('CREATE TRIGGER fin_no_delete BEFORE DELETE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
  EXECUTE format('DROP TRIGGER IF EXISTS fin_no_truncate ON public.%I', v_t);
  EXECUTE format('CREATE TRIGGER fin_no_truncate BEFORE TRUNCATE ON public.%I
                  FOR EACH STATEMENT EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
  EXECUTE format('DROP TRIGGER IF EXISTS fin_hk_refs ON public.%I', v_t);
  EXECUTE format('CREATE TRIGGER fin_hk_refs BEFORE INSERT OR UPDATE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_refs()', v_t);
  EXECUTE format('DROP TRIGGER IF EXISTS fin_hk_guard ON public.%I', v_t);
  EXECUTE format('CREATE TRIGGER fin_hk_guard BEFORE INSERT OR UPDATE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_adjustment_guard()', v_t);

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_t || '_select_finance', v_t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
                    clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.fin_can_read()))',
                 v_t || '_select_finance', v_t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_t);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_t);

  EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', v_t);
  EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()', v_t);
END $$;

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (SECURITY INVOKER, never granted; called from the SECURITY DEFINER RPCs).
-- ---------------------------------------------------------------------------

-- First statement of the hakediş read RPCs: the caller's clinic when they hold 'finance', 'finance_readonly' or
-- 'hakedis_prepare' (active users only, as has_permission), else 42501.
CREATE OR REPLACE FUNCTION public.fin__hk_require_prep_read()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_permission('finance') OR public.has_permission('finance_readonly')
          OR public.has_permission('hakedis_prepare')) THEN
    RAISE EXCEPTION 'Hakediş verilerini görme yetkiniz yok.' USING ERRCODE = '42501';
  END IF;
  RETURN v_clinic;
END;
$$;

-- First statement of the hakediş data entry RPCs (lines, pieces, marks, lab costs, adjustments): 'finance' or
-- 'hakedis_prepare', else 42501. Rules, settings and month close keep fin__require_write().
CREATE OR REPLACE FUNCTION public.fin__hk_require_prep_write()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_permission('finance') OR public.has_permission('hakedis_prepare')) THEN
    RAISE EXCEPTION 'Bu işlem için finans veya hakediş hazırlama yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;
  RETURN v_clinic;
END;
$$;

-- Month payload without ledger data, for a caller without 'finance' / 'finance_readonly': no counterparty ids on the
-- payees or in the statement breakdowns, no NO_COUNTERPARTY warnings, statement entries null (fin_entry_id stays).
CREATE OR REPLACE FUNCTION public.fin__hk_strip_ledger(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p || jsonb_build_object(
    'payees', coalesce((
      SELECT jsonb_agg(x.e - 'counterparty_id' ORDER BY x.o)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p -> 'payees') = 'array' THEN p -> 'payees' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS x(e, o)), '[]'::jsonb),
    'warnings', coalesce((
      SELECT jsonb_agg(w.e ORDER BY w.o)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p -> 'warnings') = 'array' THEN p -> 'warnings' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS w(e, o)
      WHERE (w.e ->> 'code') IS DISTINCT FROM 'NO_COUNTERPARTY'), '[]'::jsonb),
    'statements', coalesce((
      SELECT jsonb_agg(s.e || jsonb_build_object(
                         'entry', NULL::jsonb,
                         'breakdown', CASE WHEN jsonb_typeof(s.e -> 'breakdown') = 'object'
                                           THEN (s.e -> 'breakdown') - 'counterparty_id'
                                           ELSE s.e -> 'breakdown' END)
                       ORDER BY s.o)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p -> 'statements') = 'array' THEN p -> 'statements' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS s(e, o)), '[]'::jsonb))
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_adjustment_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', a.id,
           'version', a.version,
           'month', a.month,
           'payee_user_id', a.payee_user_id,
           'payee_name', u.full_name,
           'kind', a.kind,
           'amount_cents', a.amount_cents,
           'description', a.description,
           'is_voided', a.voided_at IS NOT NULL,
           'voided_at', a.voided_at,
           'voided_by_name', public.fin__user_name(a.voided_by),
           'void_reason', a.void_reason,
           'created_at', a.created_at,
           'created_by_name', public.fin__user_name(a.created_by),
           'updated_at', a.updated_at,
           'updated_by_name', public.fin__user_name(a.updated_by))
  FROM public.fin_hk_adjustments a
  LEFT JOIN public.users u ON u.id = a.payee_user_id
  WHERE a.clinic_id = p_clinic AND a.id = p_id
$$;

-- Components of a payee as short Turkish parts for the ledger entry description, '; '-joined (NULL when none):
-- the 0030 kinds as '<label> × <base> = <amount>' (zero amounts left out; the doctor is named only when the rule's
-- doctor is not the payee's own doctors row), 'sabit maaş <amount>', and from the adjustments 'prim <Σ bonus>' /
-- 'diğer <Σ other>' (zero sums left out).
CREATE OR REPLACE FUNCTION public.fin__hk_parts(p_payee jsonb, p_payee_doctor uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT string_agg(y.txt, '; ' ORDER BY y.ord)
  FROM (
    SELECT o.ord,
           CASE (o.c ->> 'kind')
             WHEN 'fixed_monthly' THEN
               'sabit maaş ' || public.fin__hk_tl((o.c ->> 'amount_cents')::bigint)
             WHEN 'adjustments' THEN
               nullif(concat_ws('; ',
                        CASE WHEN a.bonus <> 0 THEN 'prim ' || public.fin__hk_tl(a.bonus) END,
                        CASE WHEN a.other <> 0 THEN 'diğer ' || public.fin__hk_tl(a.other) END), '')
             ELSE
               CASE (o.c ->> 'kind')
                 WHEN 'implant_piece' THEN
                   'implant' || d.doc || ' ' || (o.c ->> 'qty') || ' × '
                   || public.fin__hk_tl((o.c ->> 'piece_cents')::bigint)
                 WHEN 'clinic_ciro_share' THEN
                   'yönetim payı ' || public.fin__hk_pct((o.c ->> 'share_bp')::integer) || ' × '
                   || public.fin__hk_tl((o.c ->> 'base_cents')::bigint)
                 WHEN 'ortho_lab_first' THEN
                   'ortodonti (önce lab)' || d.doc || ' ' || public.fin__hk_pct((o.c ->> 'share_bp')::integer)
                   || ' × ' || public.fin__hk_tl((o.c ->> 'base_cents')::bigint)
                 ELSE
                   'ciro payı' || d.doc || ' ('
                   || CASE (o.c ->> 'segment') WHEN 'child' THEN 'çocuk' WHEN 'own' THEN 'kendi hastası'
                                               ELSE 'standart' END
                   || ') ' || public.fin__hk_pct((o.c ->> 'share_bp')::integer) || ' × '
                   || public.fin__hk_tl((o.c ->> 'base_cents')::bigint)
               END || ' = ' || public.fin__hk_tl((o.c ->> 'amount_cents')::bigint)
           END AS txt
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_payee -> 'components') = 'array' THEN p_payee -> 'components'
                ELSE '[]'::jsonb END) WITH ORDINALITY AS o(c, ord)
    CROSS JOIN LATERAL (
      SELECT CASE WHEN (o.c ->> 'doctor_id') IS NOT NULL
                       AND (o.c ->> 'doctor_id') IS DISTINCT FROM p_payee_doctor::text
                  THEN ' ' || coalesce((o.c ->> 'doctor_name'), '')
                  ELSE '' END AS doc
    ) d
    CROSS JOIN LATERAL (
      SELECT coalesce(sum((i.item ->> 'amount_cents')::bigint) FILTER (WHERE (i.item ->> 'kind') = 'bonus'), 0)::bigint
               AS bonus,
             coalesce(sum((i.item ->> 'amount_cents')::bigint)
                        FILTER (WHERE (i.item ->> 'kind') IS DISTINCT FROM 'bonus'), 0)::bigint AS other
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(o.c -> 'items') = 'array' THEN o.c -> 'items' ELSE '[]'::jsonb END) AS i(item)
    ) a
    WHERE coalesce((o.c ->> 'amount_cents')::bigint, 0) <> 0 OR (o.c ->> 'kind') = 'adjustments'
  ) y
$$;

-- Ledger entry description of a doctor payee (fin_entries.description, <= 1000 characters), e.g.
-- 'DentOS hakediş 2026-11: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL; sabit maaş 100,00 TL; prim 10,00 TL'.
-- Same text as 0030 for payees without salary / adjustments.
CREATE OR REPLACE FUNCTION public.fin__hk_description(p_payee jsonb, p_month date, p_payee_doctor uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT left('DentOS hakediş ' || to_char(p_month, 'YYYY-MM') || ': '
              || coalesce(public.fin__hk_parts(p_payee, p_payee_doctor), 'tutar yok'),
              1000)
$$;

-- Ledger entry description of a staff payee, e.g. 'DentOS maaş 2026-11: sabit maaş 100,00 TL; prim 10,00 TL'.
CREATE OR REPLACE FUNCTION public.fin__hk_payroll_description(p_payee jsonb, p_month date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT left('DentOS maaş ' || to_char(p_month, 'YYYY-MM') || ': '
              || coalesce(public.fin__hk_parts(p_payee, NULL), 'tutar yok'),
              1000)
$$;

-- The month's ledger entry of a payee (any state), as a month close would key it: with a doctors row the
-- entitlement entry of the physician counterparty, else the payroll entry of the staff counterparty linked to the
-- user. NULL when the counterparty or the entry does not exist (yet). Used by hk_my_* for open months.
CREATE OR REPLACE FUNCTION public.fin__hk_payee_entry(p_clinic uuid, p_user uuid, p_month date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT e.id
  FROM public.fin_entries e
  WHERE e.clinic_id = p_clinic
    AND e.source_key = (
      CASE WHEN EXISTS (SELECT 1 FROM public.doctors d WHERE d.clinic_id = p_clinic AND d.user_id = p_user)
           THEN (SELECT 'entitlement:' || cp.id::text
                 FROM public.doctors d
                 JOIN public.fin_counterparties cp ON cp.clinic_id = d.clinic_id AND cp.doctor_id = d.id
                 WHERE d.clinic_id = p_clinic AND d.user_id = p_user
                 LIMIT 1)
           ELSE (SELECT 'payroll:' || cp.id::text
                 FROM public.fin_counterparties cp
                 WHERE cp.clinic_id = p_clinic AND cp.staff_user_id = p_user
                 LIMIT 1)
      END || ':' || to_char(public.fin__month_start(p_month), 'YYYY-MM'))
$$;

-- ---------------------------------------------------------------------------
-- 3. Calculation (0030 §2, same signature). Changes: the active fixed_monthly rules and the month's live adjustments
--    become components of their payees (0031); a payee with only those and no doctors row is staff (counterparty =
--    the staff counterparty linked to the user, NO_COUNTERPARTY reason 'missing' / 'inactive', never 'no_doctor').
--    Everything else is the 0030 body, so a month without salaries or adjustments gives the 0030 result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__hk_compute(p_clinic uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_month date := public.fin__month_start(p_month);
  v_next date := (public.fin__month_start(p_month) + interval '1 month')::date;
  v_result jsonb;
BEGIN
  WITH ar AS MATERIALIZED (
    SELECT r.id, r.payee_user_id, r.doctor_id, r.kind, r.segment, r.share_bp, r.piece_cents,
           r.deduct_cash_bp, r.deduct_card_bp, r.deduct_transfer_bp, r.deduct_financing_bp,
           public.fin__hk_doctor_name(r.doctor_id) AS doctor_name
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = p_clinic
      AND r.from_month <= v_month
      AND (r.to_month IS NULL OR r.to_month >= v_month)
  ),
  ev AS MATERIALIZED (
    SELECT * FROM public.fin__hk_eval_lines(p_clinic, v_month)
  ),
  meth (ord, method) AS (
    VALUES (1, 'cash'), (2, 'card'), (3, 'transfer'), (4, 'financing')
  ),
  -- One bucket per share rule and payment method.
  bucket AS (
    SELECT ar.id AS rule_id,
           meth.ord,
           meth.method,
           CASE meth.method
             WHEN 'cash' THEN ar.deduct_cash_bp
             WHEN 'card' THEN ar.deduct_card_bp
             WHEN 'transfer' THEN ar.deduct_transfer_bp
             ELSE ar.deduct_financing_bp
           END AS bp,
           coalesce(s.gross, 0)::bigint AS gross,
           coalesce(s.implant, 0)::bigint AS implant,
           coalesce(s.lab, 0)::bigint AS lab,
           coalesce(s.n, 0)::bigint AS n
    FROM ar
    CROSS JOIN meth
    LEFT JOIN LATERAL (
      SELECT sum(ev.try_cents) AS gross,
             sum(ev.implant_cents) AS implant,
             sum(ev.lab_part_cents) AS lab,
             count(*) AS n
      FROM ev
      WHERE ev.rule_id = ar.id AND ev.method = meth.method
    ) s ON true
    WHERE ar.kind IN ('ciro_share', 'ortho_lab_first')
  ),
  bucket_d AS (
    SELECT b.rule_id, b.ord, b.method, b.bp, b.gross, b.implant, b.lab, b.n,
           b.gross - b.implant - b.lab AS eligible,
           round((b.gross - b.implant - b.lab)::numeric * b.bp / 10000)::bigint AS deduction
    FROM bucket b
  ),
  rule_sum AS (
    SELECT b.rule_id,
           jsonb_object_agg(b.method, jsonb_build_object(
             'gross', b.gross,
             'implant', b.implant,
             'lab', b.lab,
             'eligible', b.eligible,
             'deduct_bp', b.bp,
             'deduction', b.deduction)) AS by_method,
           sum(b.eligible - b.deduction)::bigint AS base,
           sum(b.n)::bigint AS n
    FROM bucket_d b
    GROUP BY b.rule_id
  ),
  pcs AS (
    SELECT p.doctor_id, sum(p.qty)::bigint AS qty, count(*)::bigint AS n
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = p_clinic AND p.voided_at IS NULL AND p.day >= v_month AND p.day < v_next
    GROUP BY p.doctor_id
  ),
  gross AS (
    SELECT coalesce(sum(l.try_cents), 0)::bigint AS total, count(*)::bigint AS n
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = p_clinic AND l.voided_at IS NULL AND l.day >= v_month AND l.day < v_next
  ),
  walk AS MATERIALIZED (
    SELECT * FROM public.fin__hk_ortho_walk(p_clinic, v_month)
  ),
  -- Per-patient lab figures of the ortho doctors, to date (months <= this month).
  lab_tot AS (
    SELECT c.doctor_id,
           c.patient_ref,
           sum(c.amount_cents)::bigint AS total,
           count(*) FILTER (WHERE c.day >= v_month) AS n_month,
           (array_agg(c.patient_name ORDER BY c.day DESC, c.created_at DESC, c.id DESC))[1] AS patient_name
    FROM public.fin_hk_lab_costs c
    WHERE c.clinic_id = p_clinic
      AND c.voided_at IS NULL
      AND c.day < v_next
      AND c.doctor_id IN (SELECT ar.doctor_id FROM ar WHERE ar.kind = 'ortho_lab_first')
    GROUP BY c.doctor_id, c.patient_ref
  ),
  lab_rec AS (
    SELECT w.doctor_id,
           w.patient_ref,
           sum(w.lab_part_cents)::bigint AS recovered,
           count(*) FILTER (WHERE w.line_day >= v_month) AS n_month
    FROM walk w
    GROUP BY w.doctor_id, w.patient_ref
  ),
  -- Patients with a lab total that is still being recovered or moved this month.
  lab_pat AS (
    SELECT t.doctor_id,
           jsonb_agg(jsonb_build_object(
             'patient_ref', t.patient_ref,
             'patient_name', t.patient_name,
             'lab_total_cents', t.total,
             'recovered_cents', coalesce(r.recovered, 0),
             'remaining_cents', t.total - coalesce(r.recovered, 0))
             ORDER BY t.patient_name COLLATE "tr-x-icu", t.patient_ref) AS items
    FROM lab_tot t
    LEFT JOIN lab_rec r ON r.doctor_id = t.doctor_id AND r.patient_ref = t.patient_ref
    WHERE t.total <> 0
      AND (t.total - coalesce(r.recovered, 0) <> 0 OR t.n_month > 0 OR coalesce(r.n_month, 0) > 0)
    GROUP BY t.doctor_id
  ),
  comp AS (
    SELECT ar.payee_user_id,
           ar.id AS rule_id,
           ar.kind,
           ar.doctor_id,
           ar.doctor_name,
           ar.segment,
           ar.share_bp,
           ar.piece_cents,
           CASE ar.kind WHEN 'ciro_share' THEN 1 WHEN 'ortho_lab_first' THEN 2 WHEN 'implant_piece' THEN 3 ELSE 4 END
             AS kind_ord,
           CASE ar.segment WHEN 'standard' THEN 1 WHEN 'child' THEN 2 WHEN 'own' THEN 3 ELSE 0 END AS seg_ord,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN sh.by_method END AS by_method,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN coalesce(sh.base, 0)
                WHEN ar.kind = 'clinic_ciro_share' THEN g.total
           END AS base_cents,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first')
                  THEN round(coalesce(sh.base, 0)::numeric * ar.share_bp / 10000)::bigint
                WHEN ar.kind = 'implant_piece' THEN coalesce(pc.qty, 0) * ar.piece_cents
                ELSE round(g.total::numeric * ar.share_bp / 10000)::bigint
           END AS amount_cents,
           CASE WHEN ar.kind = 'implant_piece' THEN coalesce(pc.qty, 0) END AS qty,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN coalesce(sh.n, 0)
                WHEN ar.kind = 'implant_piece' THEN coalesce(pc.n, 0)
                ELSE g.n
           END AS lines_count,
           CASE WHEN ar.kind = 'ortho_lab_first' THEN coalesce(lp.items, '[]'::jsonb) END AS lab_patients
    FROM ar
    CROSS JOIN gross g
    LEFT JOIN rule_sum sh ON sh.rule_id = ar.id
    LEFT JOIN pcs pc ON ar.kind = 'implant_piece' AND pc.doctor_id = ar.doctor_id
    LEFT JOIN lab_pat lp ON ar.kind = 'ortho_lab_first' AND lp.doctor_id = ar.doctor_id
    WHERE ar.kind IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share')
  ),
  -- 0031: the month's live bonus / other rows per payee (items oldest first).
  adj AS (
    SELECT a.payee_user_id,
           sum(a.amount_cents)::bigint AS total,
           jsonb_agg(jsonb_build_object(
             'id', a.id,
             'kind', a.kind,
             'amount_cents', a.amount_cents,
             'description', a.description)
             ORDER BY a.created_at, a.id) AS items
    FROM public.fin_hk_adjustments a
    WHERE a.clinic_id = p_clinic AND a.month = v_month AND a.voided_at IS NULL
    GROUP BY a.payee_user_id
  ),
  -- Every component as jsonb with its sort keys: the 0030 kinds (unchanged), then fixed_monthly (one per active
  -- rule, the salary as amount), then one adjustments component per payee with live rows.
  cj AS (
    SELECT c.payee_user_id,
           c.amount_cents,
           c.kind_ord,
           c.doctor_name AS sort_name,
           c.seg_ord,
           c.rule_id AS sort_id,
           jsonb_build_object(
             'rule_id', c.rule_id,
             'kind', c.kind,
             'doctor_id', c.doctor_id,
             'doctor_name', c.doctor_name,
             'segment', c.segment,
             'share_bp', c.share_bp,
             'piece_cents', c.piece_cents,
             'by_method', c.by_method,
             'base_cents', c.base_cents,
             'amount_cents', c.amount_cents,
             'qty', c.qty,
             'lines_count', c.lines_count,
             'lab_patients', c.lab_patients) AS j
    FROM comp c
    UNION ALL
    SELECT ar.payee_user_id,
           ar.piece_cents,
           5,
           NULL::text,
           0,
           ar.id,
           jsonb_build_object(
             'rule_id', ar.id,
             'kind', ar.kind,
             'doctor_id', NULL::uuid,
             'doctor_name', NULL::text,
             'segment', NULL::text,
             'share_bp', NULL::integer,
             'piece_cents', ar.piece_cents,
             'by_method', NULL::jsonb,
             'base_cents', NULL::bigint,
             'amount_cents', ar.piece_cents,
             'qty', NULL::bigint,
             'lines_count', 0,
             'lab_patients', NULL::jsonb)
    FROM ar
    WHERE ar.kind = 'fixed_monthly'
    UNION ALL
    SELECT a.payee_user_id,
           a.total,
           6,
           NULL::text,
           0,
           NULL::uuid,
           jsonb_build_object('kind', 'adjustments', 'amount_cents', a.total, 'items', a.items)
    FROM adj a
  ),
  -- payroll_only: only fixed_monthly / adjustments components. Such a payee without a doctors row is staff (paid
  -- through the personnel bucket at close) and its counterparty is the staff counterparty linked to the user.
  payee AS (
    SELECT c.payee_user_id,
           u.full_name AS payee_name,
           pd.id AS payee_doctor_id,
           bool_and(c.kind_ord >= 5) AS payroll_only,
           CASE WHEN pd.id IS NOT NULL THEN cp.id WHEN bool_and(c.kind_ord >= 5) THEN sc.id END AS counterparty_id,
           CASE WHEN pd.id IS NOT NULL THEN cp.is_active WHEN bool_and(c.kind_ord >= 5) THEN sc.is_active END
             AS counterparty_is_active,
           sum(c.amount_cents)::bigint AS total,
           jsonb_agg(c.j ORDER BY c.kind_ord, c.sort_name COLLATE "tr-x-icu", c.seg_ord, c.sort_id) AS components
    FROM cj c
    JOIN public.users u ON u.id = c.payee_user_id
    LEFT JOIN public.doctors pd ON pd.user_id = c.payee_user_id AND pd.clinic_id = p_clinic
    LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = p_clinic AND cp.doctor_id = pd.id
    LEFT JOIN public.fin_counterparties sc ON sc.clinic_id = p_clinic AND sc.staff_user_id = c.payee_user_id
    GROUP BY c.payee_user_id, u.full_name, pd.id, cp.id, cp.is_active, sc.id, sc.is_active
  ),
  warn AS (
    SELECT 1 AS ord,
           public.fin__hk_doctor_name(ev.doctor_id) AS sort_name,
           jsonb_build_object(
             'code', 'UNRULED_LINES',
             'doctor_id', ev.doctor_id,
             'doctor_name', public.fin__hk_doctor_name(ev.doctor_id),
             'count', count(*),
             'try_cents', sum(ev.try_cents)::bigint) AS w
    FROM ev
    WHERE ev.rule_id IS NULL
    GROUP BY ev.doctor_id
    UNION ALL
    SELECT 2,
           public.fin__hk_doctor_name(pc.doctor_id),
           jsonb_build_object(
             'code', 'UNRULED_PIECES',
             'doctor_id', pc.doctor_id,
             'doctor_name', public.fin__hk_doctor_name(pc.doctor_id),
             'qty', pc.qty)
    FROM pcs pc
    WHERE pc.qty <> 0
      AND NOT EXISTS (SELECT 1 FROM ar WHERE ar.kind = 'implant_piece' AND ar.doctor_id = pc.doctor_id)
    UNION ALL
    SELECT 3,
           p.payee_name,
           jsonb_build_object(
             'code', 'NO_COUNTERPARTY',
             'payee_user_id', p.payee_user_id,
             'payee_name', p.payee_name,
             'reason', CASE WHEN p.payee_doctor_id IS NULL AND NOT p.payroll_only THEN 'no_doctor'
                            WHEN p.counterparty_id IS NULL THEN 'missing'
                            ELSE 'inactive' END)
    FROM payee p
    WHERE p.total <> 0
      AND (p.counterparty_id IS NULL OR NOT p.counterparty_is_active)
  )
  SELECT jsonb_build_object(
           'month', v_month,
           'payees', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'payee_user_id', p.payee_user_id,
                      'payee_name', p.payee_name,
                      'doctor_id', p.payee_doctor_id,
                      'counterparty_id', p.counterparty_id,
                      'total_cents', p.total,
                      'components', p.components)
                    ORDER BY p.payee_name COLLATE "tr-x-icu", p.payee_user_id)
             FROM payee p), '[]'::jsonb),
           'clinic_total_cents', (SELECT g.total FROM gross g),
           'warnings', coalesce((
             SELECT jsonb_agg(w.w ORDER BY w.ord, w.sort_name COLLATE "tr-x-icu")
             FROM warn w), '[]'::jsonb))
    INTO v_result;

  RETURN v_result;
END;
$$;

-- Month payload of fin_hk_month / fin_hk_close_month / fin_hk_reopen_month (0030, same signature) + can_prepare,
-- ledger_visible and the month's adjustments (voided ones included). A caller without finance / finance_readonly
-- ('hakedis_prepare' only) gets it without ledger data (fin__hk_strip_ledger).
CREATE OR REPLACE FUNCTION public.fin__hk_month_json(p_clinic uuid, p_month date, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_month date := public.fin__month_start(p_month);
  v_next date := (public.fin__month_start(p_month) + interval '1 month')::date;
  v_ledger boolean := coalesce(public.fin_can_read(), false);
  v_result jsonb;
BEGIN
  v_result := public.fin__hk_compute(p_clinic, v_month)
    || public.fin__hk_month_row_json(p_clinic, v_month)
    || jsonb_build_object(
         'today', p_today,
         'current_month', public.fin__month_start(p_today),
         'can_write', public.has_permission('finance'),
         'can_prepare', public.has_permission('finance') OR public.has_permission('hakedis_prepare'),
         'ledger_visible', v_ledger,
         'is_owner', coalesce(public.current_app_role() = 'owner', false),
         'is_closable', v_month < public.fin__month_start(p_today),
         'statements', coalesce((
           SELECT jsonb_agg(public.fin__hk_statement_json(p_clinic, s.id)
                            ORDER BY u.full_name COLLATE "tr-x-icu", s.id)
           FROM public.fin_hk_statements s
           LEFT JOIN public.users u ON u.id = s.payee_user_id
           WHERE s.clinic_id = p_clinic AND s.month = v_month AND s.superseded_at IS NULL), '[]'::jsonb),
         'lines', coalesce((
           SELECT jsonb_agg(public.fin__hk_line_json(p_clinic, l.id)
                            || jsonb_build_object(
                                 'resolved_segment', ev.segment,
                                 'rule_id', ev.rule_id,
                                 'rule_kind', ev.rule_kind,
                                 'payee_user_id', ev.payee_user_id,
                                 'lab_part', ev.lab_part_cents)
                            ORDER BY l.day, l.created_at, l.id)
           FROM public.fin_hk_lines l
           LEFT JOIN public.fin__hk_eval_lines(p_clinic, v_month) ev ON ev.line_id = l.id
           WHERE l.clinic_id = p_clinic AND l.day >= v_month AND l.day < v_next), '[]'::jsonb),
         'pieces', coalesce((
           SELECT jsonb_agg(public.fin__hk_piece_json(p_clinic, p.id) ORDER BY p.day, p.created_at, p.id)
           FROM public.fin_hk_pieces p
           WHERE p.clinic_id = p_clinic AND p.day >= v_month AND p.day < v_next), '[]'::jsonb),
         'lab_costs', coalesce((
           SELECT jsonb_agg(public.fin__hk_lab_cost_json(p_clinic, c.id) ORDER BY c.day, c.created_at, c.id)
           FROM public.fin_hk_lab_costs c
           WHERE c.clinic_id = p_clinic AND c.day >= v_month AND c.day < v_next), '[]'::jsonb),
         'adjustments', coalesce((
           SELECT jsonb_agg(public.fin__hk_adjustment_json(p_clinic, a.id)
                            ORDER BY u.full_name COLLATE "tr-x-icu", a.payee_user_id, a.created_at, a.id)
           FROM public.fin_hk_adjustments a
           LEFT JOIN public.users u ON u.id = a.payee_user_id
           WHERE a.clinic_id = p_clinic AND a.month = v_month), '[]'::jsonb));
  IF NOT v_ledger THEN
    v_result := public.fin__hk_strip_ledger(v_result);
  END IF;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Finance RPCs fin_hk_* (0030 §4, same signatures; CREATE OR REPLACE keeps the ACL). Reads now start with
--    fin__hk_require_prep_read(), the data entry writes with fin__hk_require_prep_write(); rules, settings and the
--    month close keep fin__require_write(), reopening also the owner role (fin_hk_reopen_month is not changed).
-- ---------------------------------------------------------------------------

-- Everything the Hakediş screens need besides the month figures (0030) + can_prepare / ledger_visible; payees are
-- every user of the clinic. Nothing in it comes from the ledger except the lab names of the lab cost picker.
CREATE OR REPLACE FUNCTION public.fin_hk_reference()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_read();
  v_today date := public.clinic_today();
BEGIN
  RETURN jsonb_build_object(
    'today', v_today,
    'current_month', public.fin__month_start(v_today),
    'can_write', public.has_permission('finance'),
    'can_prepare', public.has_permission('finance') OR public.has_permission('hakedis_prepare'),
    'ledger_visible', coalesce(public.fin_can_read(), false),
    'is_owner', coalesce(public.current_app_role() = 'owner', false),
    'doctors', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', d.id,
               'name', u.full_name,
               'user_id', d.user_id,
               'specialty', d.specialty,
               'is_active', coalesce(u.is_active, false))
             ORDER BY u.full_name COLLATE "tr-x-icu", d.id)
      FROM public.doctors d
      JOIN public.users u ON u.id = d.user_id
      WHERE d.clinic_id = v_clinic), '[]'::jsonb),
    -- Payees: every user of the clinic (0031: any active user may get a fixed monthly salary or a bonus; hakediş
    -- rules still need a doctors row or the owner role). Inactive users are included, flagged.
    'payees', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', u.id,
               'name', u.full_name,
               'role', u.role::text,
               'is_active', coalesce(u.is_active, false),
               'doctor_id', d.id)
             ORDER BY u.full_name COLLATE "tr-x-icu", u.id)
      FROM public.users u
      LEFT JOIN public.doctors d ON d.user_id = u.id AND d.clinic_id = v_clinic
      WHERE u.clinic_id = v_clinic), '[]'::jsonb),
    'rules', coalesce((
      SELECT jsonb_agg(public.fin__hk_rule_json(v_clinic, r.id)
                       ORDER BY pu.full_name COLLATE "tr-x-icu", r.payee_user_id,
                                CASE r.kind WHEN 'ciro_share' THEN 1 WHEN 'ortho_lab_first' THEN 2
                                            WHEN 'implant_piece' THEN 3 ELSE 4 END,
                                r.from_month DESC, r.id)
      FROM public.fin_hk_rules r
      LEFT JOIN public.users pu ON pu.id = r.payee_user_id
      WHERE r.clinic_id = v_clinic), '[]'::jsonb),
    'months', coalesce((
      SELECT jsonb_agg(public.fin__hk_month_row_json(v_clinic, m.month) ORDER BY m.month DESC)
      FROM public.fin_hk_months m
      WHERE m.clinic_id = v_clinic), '[]'::jsonb),
    'lab_names', public.fin__hk_lab_names(v_clinic),
    'settings', public.fin__hk_settings_json(v_clinic));
END;
$$;

-- One month (0030): figures, status, statements, lines, pieces, lab costs + adjustments. NULL → the current month.
CREATE OR REPLACE FUNCTION public.fin_hk_month(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_read();
  v_today date := public.clinic_today();
BEGIN
  RETURN public.fin__hk_month_json(v_clinic, public.fin__month_start(public.fin__day(coalesce(p_month, v_today))),
                                   v_today);
END;
$$;

-- Patient marks (0030), sorted by patient name.
CREATE OR REPLACE FUNCTION public.fin_hk_marks()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_read();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(public.fin__hk_mark_json(v_clinic, m.id) ORDER BY m.patient_name COLLATE "tr-x-icu", m.id)
    FROM public.fin_hk_patient_marks m
    WHERE m.clinic_id = v_clinic), '[]'::jsonb);
END;
$$;

-- Payee rule (finance writers only, 0030) + kind fixed_monthly. Fields by kind:
--   ciro_share         doctor, segment, share_bp, deductions
--   ortho_lab_first    doctor, share_bp, deductions (no segment)
--   implant_piece      doctor, piece_cents (no share, no deductions)
--   clinic_ciro_share  share_bp only (no doctor, no segment, no deductions)
--   fixed_monthly      piece_cents = monthly net salary only; payee any user of the clinic (0031)
-- Months: any day of the month is accepted and stored as its first day. Overlap check under a per-clinic lock.
CREATE OR REPLACE FUNCTION public.fin_hk_save_rule(
  p_id uuid,
  p_version integer,
  p_payee_user_id uuid,
  p_doctor_id uuid,
  p_kind text,
  p_segment text,
  p_share_bp integer,
  p_piece_cents bigint,
  p_deduct_cash_bp integer,
  p_deduct_card_bp integer,
  p_deduct_transfer_bp integer,
  p_deduct_financing_bp integer,
  p_from_month date,
  p_to_month date,
  p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_rules%ROWTYPE;
  v_payee public.users%ROWTYPE;
  v_cash integer := coalesce(p_deduct_cash_bp, 0);
  v_card integer := coalesce(p_deduct_card_bp, 0);
  v_transfer integer := coalesce(p_deduct_transfer_bp, 0);
  v_financing integer := coalesce(p_deduct_financing_bp, 0);
  v_from date;
  v_to date;
  v_note text;
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_kind IS NULL
     OR p_kind NOT IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share', 'fixed_monthly') THEN
    RAISE EXCEPTION 'Geçersiz kural türü.';
  END IF;

  IF p_kind = 'clinic_ciro_share' THEN
    IF p_doctor_id IS NOT NULL THEN
      RAISE EXCEPTION 'Yönetim payı kuralında hekim seçilmez.';
    END IF;
  ELSIF p_kind = 'fixed_monthly' THEN
    IF p_doctor_id IS NOT NULL THEN
      RAISE EXCEPTION 'Sabit aylık maaş kuralında hekim seçilmez.';
    END IF;
  ELSIF p_doctor_id IS NULL THEN
    RAISE EXCEPTION 'Hekim seçilmeli.';
  END IF;

  IF p_kind = 'ciro_share' THEN
    IF p_segment IS NULL OR p_segment NOT IN ('standard', 'child', 'own') THEN
      RAISE EXCEPTION 'Ciro payı kuralında hasta grubu seçilmeli.';
    END IF;
  ELSIF p_segment IS NOT NULL THEN
    RAISE EXCEPTION 'Hasta grubu yalnızca ciro payı kuralında seçilir.';
  END IF;

  IF p_kind = 'implant_piece' THEN
    IF p_share_bp IS NOT NULL THEN
      RAISE EXCEPTION 'İmplant kuralında pay oranı girilmez.';
    END IF;
    IF p_piece_cents IS NULL OR p_piece_cents NOT BETWEEN 1 AND 1000000000000 THEN
      RAISE EXCEPTION 'Adet başı tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
    END IF;
  ELSIF p_kind = 'fixed_monthly' THEN
    IF p_share_bp IS NOT NULL THEN
      RAISE EXCEPTION 'Sabit aylık maaş kuralında pay oranı girilmez.';
    END IF;
    IF p_piece_cents IS NULL OR p_piece_cents NOT BETWEEN 1 AND 1000000000000 THEN
      RAISE EXCEPTION 'Aylık net maaş 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
    END IF;
  ELSE
    IF p_piece_cents IS NOT NULL THEN
      RAISE EXCEPTION 'Adet başı tutar yalnızca implant kuralında girilir.';
    END IF;
    IF p_share_bp IS NULL OR p_share_bp NOT BETWEEN 1 AND 10000 THEN
      RAISE EXCEPTION 'Pay oranı %%0,01 ile %%100 arasında olmalı.';
    END IF;
  END IF;

  IF v_cash NOT BETWEEN 0 AND 10000 OR v_card NOT BETWEEN 0 AND 10000
     OR v_transfer NOT BETWEEN 0 AND 10000 OR v_financing NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Kesinti oranları %%0 ile %%100 arasında olmalı.';
  END IF;
  IF p_kind IN ('implant_piece', 'clinic_ciro_share', 'fixed_monthly')
     AND (v_cash <> 0 OR v_card <> 0 OR v_transfer <> 0 OR v_financing <> 0) THEN
    RAISE EXCEPTION 'Kesinti oranları yalnızca ciro payı ve ortodonti kurallarında girilir.';
  END IF;

  IF p_from_month IS NULL THEN
    RAISE EXCEPTION 'Başlangıç ayı seçilmeli.';
  END IF;
  v_from := public.fin__month_start(public.fin__day(p_from_month));
  IF p_to_month IS NOT NULL THEN
    v_to := public.fin__month_start(public.fin__day(p_to_month));
    IF v_to < v_from THEN
      RAISE EXCEPTION 'Bitiş ayı başlangıç ayından önce olamaz.';
    END IF;
  END IF;
  IF char_length(btrim(coalesce(p_note, ''))) > 500 THEN
    RAISE EXCEPTION 'Not en fazla 500 karakter olabilir.';
  END IF;
  v_note := btrim(coalesce(p_note, ''));

  -- Payee: a staff member of the clinic with a doctors row, or the owner; for fixed_monthly any user of the clinic
  -- (active when newly chosen, checked below).
  SELECT * INTO v_payee FROM public.users u WHERE u.id = p_payee_user_id AND u.clinic_id = v_clinic;
  IF v_payee.id IS NULL THEN
    RAISE EXCEPTION 'Hakediş alacak kişi bulunamadı.';
  END IF;
  IF p_kind <> 'fixed_monthly' AND v_payee.role::text <> 'owner' AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.user_id = v_payee.id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hakediş yalnızca hekimlere ve klinik sahibine tanımlanabilir.';
  END IF;
  IF p_doctor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;

  -- Serialises rule saves per clinic, so two overlapping rules cannot both pass the check below.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_hk_rules:' || v_clinic::text, 0));

  -- Only rows of the caller's clinic are read or locked (an id of another clinic looks unknown here).
  SELECT * INTO v_row FROM public.fin_hk_rules r WHERE r.clinic_id = v_clinic AND r.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_rule_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.payee_user_id, v_row.doctor_id, v_row.kind, v_row.segment, v_row.share_bp, v_row.piece_cents,
        v_row.deduct_cash_bp, v_row.deduct_card_bp, v_row.deduct_transfer_bp, v_row.deduct_financing_bp,
        v_row.from_month, v_row.to_month, v_row.note)
       IS NOT DISTINCT FROM
       (p_payee_user_id, p_doctor_id, p_kind, p_segment, p_share_bp, p_piece_cents,
        v_cash, v_card, v_transfer, v_financing, v_from, v_to, v_note) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_rule_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  -- A newly chosen payee must be active; an unchanged one is kept even if deactivated since.
  IF (v_row.id IS NULL OR v_row.payee_user_id IS DISTINCT FROM p_payee_user_id)
     AND v_payee.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pasif personel seçilemez.';
  END IF;

  -- Overlap: fixed_monthly per payee (0031: every staff member has a salary of their own), the other kinds per
  -- (kind, doctor, segment) whoever the payee is.
  SELECT r.id INTO v_other
  FROM public.fin_hk_rules r
  WHERE r.clinic_id = v_clinic
    AND r.id <> p_id
    AND r.kind = p_kind
    AND (CASE WHEN p_kind = 'fixed_monthly' THEN r.payee_user_id = p_payee_user_id
              ELSE r.doctor_id IS NOT DISTINCT FROM p_doctor_id AND r.segment IS NOT DISTINCT FROM p_segment END)
    AND r.from_month <= coalesce(v_to, DATE '9999-12-01')
    AND v_from <= coalesce(r.to_month, DATE '9999-12-01')
  ORDER BY r.from_month, r.id
  LIMIT 1;
  IF v_other IS NOT NULL AND p_kind = 'fixed_monthly' THEN
    RAISE EXCEPTION 'Bu kişi için bu aylarla çakışan başka bir sabit aylık maaş kuralı var. Önce onun bitiş ayını girin.'
      USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Aynı tür, hekim ve hasta grubu için bu aylarla çakışan başka bir kural var. Önce onun bitiş ayını girin.'
      USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_rules (id, clinic_id, payee_user_id, doctor_id, kind, segment, share_bp, piece_cents,
                                     deduct_cash_bp, deduct_card_bp, deduct_transfer_bp, deduct_financing_bp,
                                     from_month, to_month, note, created_by, updated_by)
    VALUES (p_id, v_clinic, p_payee_user_id, p_doctor_id, p_kind, p_segment, p_share_bp, p_piece_cents,
            v_cash, v_card, v_transfer, v_financing, v_from, v_to, v_note, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_rules r WHERE r.id = p_id AND r.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_rule_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_rules r
    SET payee_user_id = p_payee_user_id,
        doctor_id = p_doctor_id,
        kind = p_kind,
        segment = p_segment,
        share_bp = p_share_bp,
        piece_cents = p_piece_cents,
        deduct_cash_bp = v_cash,
        deduct_card_bp = v_card,
        deduct_transfer_bp = v_transfer,
        deduct_financing_bp = v_financing,
        from_month = v_from,
        to_month = v_to,
        note = v_note
    WHERE r.clinic_id = v_clinic AND r.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_rule_json(v_clinic, p_id));
END;
$$;

-- Revenue line (0030), now also for 'hakedis_prepare' holders.
CREATE OR REPLACE FUNCTION public.fin_hk_save_line(
  p_id uuid,
  p_version integer,
  p_day date,
  p_doctor_id uuid,
  p_patient_name text,
  p_patient_ref text,
  p_method text,
  p_currency text,
  p_amount_cents bigint,
  p_try_cents bigint,
  p_implant_cents bigint,
  p_segment text,
  p_description text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_lines%ROWTYPE;
  v_day date;
  v_name text;
  v_ref text;
  v_currency text := upper(coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'TRY'));
  v_try bigint;
  v_implant bigint := coalesce(p_implant_cents, 0);
  v_desc text;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_day := public.fin__day(p_day);
  IF v_day > public.clinic_today() THEN
    RAISE EXCEPTION 'Tarih bugünden sonra olamaz.';
  END IF;
  IF p_doctor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  v_name := public.fin__hk_patient_name(p_patient_name);
  v_ref := public.fin__hk_patient_ref(p_patient_ref, v_name);
  IF p_method IS NULL OR p_method NOT IN ('cash', 'card', 'transfer', 'financing') THEN
    RAISE EXCEPTION 'Geçersiz ödeme şekli.';
  END IF;
  IF v_currency NOT IN ('TRY', 'EUR', 'USD', 'GBP') THEN
    RAISE EXCEPTION 'Geçersiz para birimi.';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents = 0 OR abs(p_amount_cents) > 1000000000000 THEN
    RAISE EXCEPTION 'Tutar 0 olamaz ve en fazla 10.000.000.000 olabilir.';
  END IF;
  IF v_currency = 'TRY' THEN
    v_try := coalesce(p_try_cents, p_amount_cents);
    IF v_try <> p_amount_cents THEN
      RAISE EXCEPTION 'TL ödemede TL karşılığı tutara eşit olmalı.';
    END IF;
  ELSE
    v_try := p_try_cents;
    IF v_try IS NULL OR v_try = 0 OR (v_try > 0) <> (p_amount_cents > 0) OR abs(v_try) > 1000000000000 THEN
      RAISE EXCEPTION 'TL karşılığı girilmeli; 0 olamaz ve tutarla aynı işaretli olmalı.';
    END IF;
  END IF;
  IF v_implant <> 0 AND ((v_implant > 0) <> (v_try > 0) OR abs(v_implant) > abs(v_try)) THEN
    RAISE EXCEPTION 'İmplant payı TL tutarını aşamaz ve tutarla aynı işaretli olmalı.';
  END IF;
  IF p_segment IS NOT NULL AND p_segment NOT IN ('standard', 'child', 'own') THEN
    RAISE EXCEPTION 'Geçersiz hasta grubu.';
  END IF;
  v_desc := public.fin__hk_desc(p_description);

  SELECT * INTO v_row FROM public.fin_hk_lines l WHERE l.clinic_id = v_clinic AND l.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_line_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF v_row.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
    END IF;
    IF (v_row.day, v_row.doctor_id, v_row.patient_name, v_row.patient_ref, v_row.method, v_row.currency,
        v_row.amount_cents, v_row.try_cents, v_row.implant_cents, v_row.segment, v_row.description)
       IS NOT DISTINCT FROM
       (v_day, p_doctor_id, v_name, v_ref, p_method, v_currency, p_amount_cents, v_try, v_implant, p_segment, v_desc) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_line_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
    PERFORM public.fin__hk_check_open(v_clinic, v_row.day);
  END IF;
  PERFORM public.fin__hk_check_open(v_clinic, v_day);

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_lines (id, clinic_id, source, day, doctor_id, patient_ref, patient_name, method,
                                     currency, amount_cents, try_cents, implant_cents, segment, description,
                                     created_by, updated_by)
    VALUES (p_id, v_clinic, 'manual', v_day, p_doctor_id, v_ref, v_name, p_method,
            v_currency, p_amount_cents, v_try, v_implant, p_segment, v_desc, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_lines l WHERE l.id = p_id AND l.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_line_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_lines l
    SET day = v_day,
        doctor_id = p_doctor_id,
        patient_ref = v_ref,
        patient_name = v_name,
        method = p_method,
        currency = v_currency,
        amount_cents = p_amount_cents,
        try_cents = v_try,
        implant_cents = v_implant,
        segment = p_segment,
        description = v_desc
    WHERE l.clinic_id = v_clinic AND l.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_line_json(v_clinic, p_id));
END;
$$;

-- Voids a line (0030), now also for 'hakedis_prepare' holders. Not in a closed month.
CREATE OR REPLACE FUNCTION public.fin_hk_void_line(
  p_id uuid,
  p_version integer,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_row public.fin_hk_lines%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_row FROM public.fin_hk_lines l WHERE l.clinic_id = v_clinic AND l.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_line_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);
  PERFORM public.fin__hk_check_open(v_clinic, v_row.day);

  UPDATE public.fin_hk_lines l
  SET voided_at = now(), voided_by = public.current_app_user_id(), void_reason = v_reason
  WHERE l.clinic_id = v_clinic AND l.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_line_json(v_clinic, p_id));
END;
$$;

-- Implants placed (0030), now also for 'hakedis_prepare' holders.
CREATE OR REPLACE FUNCTION public.fin_hk_save_piece(
  p_id uuid,
  p_version integer,
  p_day date,
  p_doctor_id uuid,
  p_patient_name text,
  p_patient_ref text,
  p_qty integer,
  p_description text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_pieces%ROWTYPE;
  v_day date;
  v_name text;
  v_ref text;
  v_desc text;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_day := public.fin__day(p_day);
  IF v_day > public.clinic_today() THEN
    RAISE EXCEPTION 'Tarih bugünden sonra olamaz.';
  END IF;
  IF p_doctor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  v_name := public.fin__hk_patient_name(p_patient_name);
  v_ref := public.fin__hk_patient_ref(p_patient_ref, v_name);
  IF p_qty IS NULL OR p_qty = 0 OR p_qty NOT BETWEEN -1000 AND 1000 THEN
    RAISE EXCEPTION 'Adet 0 olamaz ve -1000 ile 1000 arasında olmalı.';
  END IF;
  v_desc := public.fin__hk_desc(p_description);

  SELECT * INTO v_row FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_piece_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF v_row.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
    END IF;
    IF (v_row.day, v_row.doctor_id, v_row.patient_name, v_row.patient_ref, v_row.qty, v_row.description)
       IS NOT DISTINCT FROM (v_day, p_doctor_id, v_name, v_ref, p_qty, v_desc) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_piece_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
    PERFORM public.fin__hk_check_open(v_clinic, v_row.day);
  END IF;
  PERFORM public.fin__hk_check_open(v_clinic, v_day);

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_pieces (id, clinic_id, source, day, doctor_id, patient_ref, patient_name, qty,
                                      description, created_by, updated_by)
    VALUES (p_id, v_clinic, 'manual', v_day, p_doctor_id, v_ref, v_name, p_qty, v_desc, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_pieces p WHERE p.id = p_id AND p.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_piece_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_pieces p
    SET day = v_day,
        doctor_id = p_doctor_id,
        patient_ref = v_ref,
        patient_name = v_name,
        qty = p_qty,
        description = v_desc
    WHERE p.clinic_id = v_clinic AND p.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_piece_json(v_clinic, p_id));
END;
$$;

-- Voids an implant row (0030), now also for 'hakedis_prepare' holders.
CREATE OR REPLACE FUNCTION public.fin_hk_void_piece(
  p_id uuid,
  p_version integer,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_row public.fin_hk_pieces%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_row FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_piece_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);
  PERFORM public.fin__hk_check_open(v_clinic, v_row.day);

  UPDATE public.fin_hk_pieces p
  SET voided_at = now(), voided_by = public.current_app_user_id(), void_reason = v_reason
  WHERE p.clinic_id = v_clinic AND p.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_piece_json(v_clinic, p_id));
END;
$$;

-- Patient mark, every field (0030), now also for 'hakedis_prepare' holders, who are held by the reception's
-- closed-month lock (finance writers are not). p_birth_date has no default: a client that omits it must not clear a
-- birth date entered at the reception.
CREATE OR REPLACE FUNCTION public.fin_hk_save_mark(
  p_id uuid,
  p_version integer,
  p_patient_ref text,
  p_patient_name text,
  p_own_doctor_id uuid,
  p_is_child boolean,
  p_note text,
  p_birth_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_patient_marks%ROWTYPE;
  v_name text;
  v_ref text;
  v_birth date;
  v_child boolean := coalesce(p_is_child, false);
  v_note text;
  v_other uuid;
  v_n integer;
  v_finance boolean := public.has_permission('finance');
  v_locked boolean;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_name := public.fin__hk_patient_name(p_patient_name);
  v_ref := public.fin__hk_patient_ref(p_patient_ref, v_name);
  v_birth := public.fin__hk_birth_date(p_birth_date);
  IF p_own_doctor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_own_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  IF char_length(btrim(coalesce(p_note, ''))) > 500 THEN
    RAISE EXCEPTION 'Not en fazla 500 karakter olabilir.';
  END IF;
  v_note := btrim(coalesce(p_note, ''));

  SELECT * INTO v_row FROM public.fin_hk_patient_marks m WHERE m.clinic_id = v_clinic AND m.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_mark_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.patient_ref, v_row.patient_name, v_row.own_doctor_id, v_row.birth_date, v_row.is_child, v_row.note)
       IS NOT DISTINCT FROM (v_ref, v_name, p_own_doctor_id, v_birth, v_child, v_note) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_mark_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  SELECT m.id INTO v_other
  FROM public.fin_hk_patient_marks m
  WHERE m.clinic_id = v_clinic AND m.patient_ref = v_ref AND m.id <> p_id
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu hasta için zaten bir işaret kaydı var.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  -- 0031: a caller without 'finance' ('hakedis_prepare') is held by the reception's closed-month lock, under the
  -- clinic's close lock (shared) as in hk_save_mark: own doctor, birth date or child flag of a patient with a live
  -- line in a closed month (a changed patient key: the mark leaves the old key and arrives at the new one).
  IF NOT v_finance THEN
    PERFORM pg_advisory_xact_lock_shared(public.fin__hk_close_lock(v_clinic));
    IF v_row.id IS NOT NULL AND v_row.patient_ref IS DISTINCT FROM v_ref THEN
      v_locked := public.fin__hk_mark_locked(v_clinic, v_row.patient_ref, v_row.own_doctor_id, NULL,
                                             v_row.birth_date, NULL, v_row.is_child, false)
                  OR public.fin__hk_mark_locked(v_clinic, v_ref, NULL, p_own_doctor_id, NULL, v_birth, false, v_child);
    ELSE
      v_locked := public.fin__hk_mark_locked(v_clinic, v_ref, v_row.own_doctor_id, p_own_doctor_id,
                                             v_row.birth_date, v_birth, coalesce(v_row.is_child, false), v_child);
    END IF;
    IF v_locked THEN
      RAISE EXCEPTION 'Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.';
    END IF;
  END IF;

  IF p_version = 0 THEN
    BEGIN
      INSERT INTO public.fin_hk_patient_marks (id, clinic_id, patient_ref, patient_name, own_doctor_id, birth_date,
                                               is_child, note, created_by, updated_by)
      VALUES (p_id, v_clinic, v_ref, v_name, p_own_doctor_id, v_birth, v_child, v_note, v_user, v_user)
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu hasta için zaten bir işaret kaydı var.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_patient_marks m WHERE m.id = p_id AND m.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_mark_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    BEGIN
      UPDATE public.fin_hk_patient_marks m
      SET patient_ref = v_ref,
          patient_name = v_name,
          own_doctor_id = p_own_doctor_id,
          birth_date = v_birth,
          is_child = v_child,
          note = v_note
      WHERE m.clinic_id = v_clinic AND m.id = p_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu hasta için zaten bir işaret kaydı var.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_mark_json(v_clinic, p_id));
END;
$$;

-- Lab cost per lab invoice / charge (0030), now also for 'hakedis_prepare' holders.
CREATE OR REPLACE FUNCTION public.fin_hk_save_lab_cost(
  p_id uuid,
  p_version integer,
  p_day date,
  p_doctor_id uuid,
  p_patient_name text,
  p_patient_ref text,
  p_lab_name text,
  p_amount_cents bigint,
  p_description text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_lab_costs%ROWTYPE;
  v_day date;
  v_name text;
  v_ref text;
  v_lab text;
  v_desc text;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_day := public.fin__day(p_day);
  IF v_day > public.clinic_today() THEN
    RAISE EXCEPTION 'Tarih bugünden sonra olamaz.';
  END IF;
  IF p_doctor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  v_name := public.fin__hk_patient_name(p_patient_name);
  v_ref := public.fin__hk_patient_ref(p_patient_ref, v_name);
  IF p_lab_name IS NULL OR char_length(btrim(p_lab_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Laboratuvar adı boş olamaz ve en fazla 120 karakter olabilir.';
  END IF;
  v_lab := btrim(p_lab_name);
  IF p_amount_cents IS NULL OR p_amount_cents = 0 OR abs(p_amount_cents) > 1000000000000 THEN
    RAISE EXCEPTION 'Tutar 0 olamaz ve en fazla 10.000.000.000 TL olabilir.';
  END IF;
  v_desc := public.fin__hk_desc(p_description);

  SELECT * INTO v_row FROM public.fin_hk_lab_costs c WHERE c.clinic_id = v_clinic AND c.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_lab_cost_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF v_row.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
    END IF;
    IF (v_row.day, v_row.doctor_id, v_row.patient_name, v_row.patient_ref, v_row.lab_name, v_row.amount_cents,
        v_row.description)
       IS NOT DISTINCT FROM (v_day, p_doctor_id, v_name, v_ref, v_lab, p_amount_cents, v_desc) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_lab_cost_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
    PERFORM public.fin__hk_check_open(v_clinic, v_row.day);
  END IF;
  PERFORM public.fin__hk_check_open(v_clinic, v_day);

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_lab_costs (id, clinic_id, day, doctor_id, patient_ref, patient_name, lab_name,
                                         amount_cents, description, created_by, updated_by)
    VALUES (p_id, v_clinic, v_day, p_doctor_id, v_ref, v_name, v_lab, p_amount_cents, v_desc, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_lab_costs c WHERE c.id = p_id AND c.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_lab_cost_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_lab_costs c
    SET day = v_day,
        doctor_id = p_doctor_id,
        patient_ref = v_ref,
        patient_name = v_name,
        lab_name = v_lab,
        amount_cents = p_amount_cents,
        description = v_desc
    WHERE c.clinic_id = v_clinic AND c.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_lab_cost_json(v_clinic, p_id));
END;
$$;

-- Voids a lab cost (0030), now also for 'hakedis_prepare' holders.
CREATE OR REPLACE FUNCTION public.fin_hk_void_lab_cost(
  p_id uuid,
  p_version integer,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_row public.fin_hk_lab_costs%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_row FROM public.fin_hk_lab_costs c WHERE c.clinic_id = v_clinic AND c.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_lab_cost_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);
  PERFORM public.fin__hk_check_open(v_clinic, v_row.day);

  UPDATE public.fin_hk_lab_costs c
  SET voided_at = now(), voided_by = public.current_app_user_id(), void_reason = v_reason
  WHERE c.clinic_id = v_clinic AND c.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_lab_cost_json(v_clinic, p_id));
END;
$$;

-- Bonus / other row of a payee for one month (TL cents, negative = deduction; description 1..500). Any day of the
-- month is accepted and stored as its first day; never a month after the current one, never a closed month or a
-- month before a closed one (old and new month on an edit). A newly chosen payee must be an active user of the
-- clinic; an unchanged one is kept even if deactivated since. Save conventions as fin_hk_save_line.
CREATE OR REPLACE FUNCTION public.fin_hk_save_adjustment(
  p_id uuid,
  p_version integer,
  p_month date,
  p_payee_user_id uuid,
  p_kind text,
  p_amount_cents bigint,
  p_description text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_adjustments%ROWTYPE;
  v_payee public.users%ROWTYPE;
  v_month date;
  v_desc text;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Ay seçilmeli.';
  END IF;
  v_month := public.fin__month_start(public.fin__day(p_month));
  IF v_month > public.fin__month_start(public.clinic_today()) THEN
    RAISE EXCEPTION 'Gelecek aylar için prim / kesinti girilemez.';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('bonus', 'other') THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents = 0 OR abs(p_amount_cents) > 1000000000000 THEN
    RAISE EXCEPTION 'Tutar 0 olamaz ve en fazla 10.000.000.000 TL olabilir.';
  END IF;
  IF p_description IS NULL OR char_length(btrim(p_description)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Açıklama boş olamaz ve en fazla 500 karakter olabilir.';
  END IF;
  v_desc := btrim(p_description);

  SELECT * INTO v_payee FROM public.users u WHERE u.id = p_payee_user_id AND u.clinic_id = v_clinic;
  IF v_payee.id IS NULL THEN
    RAISE EXCEPTION 'Kişi bulunamadı.';
  END IF;

  -- Only rows of the caller's clinic are read or locked (an id of another clinic looks unknown here).
  SELECT * INTO v_row FROM public.fin_hk_adjustments a WHERE a.clinic_id = v_clinic AND a.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_adjustment_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF v_row.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
    END IF;
    IF (v_row.month, v_row.payee_user_id, v_row.kind, v_row.amount_cents, v_row.description)
       IS NOT DISTINCT FROM (v_month, p_payee_user_id, p_kind, p_amount_cents, v_desc) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_adjustment_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF (v_row.id IS NULL OR v_row.payee_user_id IS DISTINCT FROM p_payee_user_id)
     AND v_payee.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pasif personel seçilemez.';
  END IF;

  IF p_version > 0 THEN
    PERFORM public.fin__hk_check_open(v_clinic, v_row.month);
  END IF;
  PERFORM public.fin__hk_check_open(v_clinic, v_month);

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_adjustments (id, clinic_id, month, payee_user_id, kind, amount_cents, description,
                                           created_by, updated_by)
    VALUES (p_id, v_clinic, v_month, p_payee_user_id, p_kind, p_amount_cents, v_desc, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_adjustments a WHERE a.id = p_id AND a.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_adjustment_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_adjustments a
    SET month = v_month,
        payee_user_id = p_payee_user_id,
        kind = p_kind,
        amount_cents = p_amount_cents,
        description = v_desc
    WHERE a.clinic_id = v_clinic AND a.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_adjustment_json(v_clinic, p_id));
END;
$$;

-- Voids a bonus / other row (reason 3..500). Already voided → already_saved. Not in a closed month.
CREATE OR REPLACE FUNCTION public.fin_hk_void_adjustment(
  p_id uuid,
  p_version integer,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_row public.fin_hk_adjustments%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_row FROM public.fin_hk_adjustments a WHERE a.clinic_id = v_clinic AND a.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_adjustment_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);
  PERFORM public.fin__hk_check_open(v_clinic, v_row.month);

  UPDATE public.fin_hk_adjustments a
  SET voided_at = now(), voided_by = public.current_app_user_id(), void_reason = v_reason
  WHERE a.clinic_id = v_clinic AND a.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_adjustment_json(v_clinic, p_id));
END;
$$;

-- Month close (finance write, 0030) + the staff payroll. Only a month before the current one; version = month row
-- version (0 = no row). Refuses unruled lines / pieces unless p_accept_unruled, and any negative payee total. A
-- non-cancelled entry linked by an earlier statement of this month (a close before a reopen) that this close does not
-- account for is refused: its payee has no payable amount now, or the payee's entry now lives under another
-- counterparty. Then, per payee:
--   * with a doctors row (0030): physician counterparty (created, or an unlinked physician counterparty of the same
--     name is linked, when missing); entitlement entry 'entitlement:<cp>:<YYYY-MM>' created through
--     fin_add_entitlement, or its amount / description updated (never below what is already paid; a cancelled entry
--     is refused). Its total includes a fixed salary and adjustments of the doctor (0031);
--   * without a doctors row and only fixed_monthly / adjustments components (staff, 0031): staff counterparty linked
--     to the user (created, or an unlinked staff counterparty of the same name is linked); payroll entry
--     'payroll:<cp>:<YYYY-MM>' in the active system category of bucket 'personnel', due on the 1st of the month, no
--     subcategory and no entitlement month, created or updated under the same rules;
--   * without a doctors row but with hakediş components: refused as in 0030;
--   * total = 0: no entry (an existing non-cancelled entry for that month is refused: it can only be cancelled);
--   * a statement (the computed payee object) linked to the entry. Earlier active statements are superseded.
-- Every refusal rolls the whole close back. Already closed → the month payload with already_saved = true.
CREATE OR REPLACE FUNCTION public.fin_hk_close_month(
  p_month date,
  p_version integer,
  p_accept_unruled boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date := public.clinic_today();
  v_user uuid := public.current_app_user_id();
  v_month date;
  v_row public.fin_hk_months%ROWTYPE;
  v_c jsonb;
  v_bad text;
  v_p jsonb;
  v_payee uuid;
  v_name text;
  v_total bigint;
  v_doctor uuid;
  v_cp uuid;
  v_cp_active boolean;
  v_other uuid;
  v_other_kind text;
  v_other_doctor uuid;
  v_other_active boolean;
  v_entry uuid;
  v_entry_amount bigint;
  v_entry_cancelled boolean;
  v_entry_desc text;
  v_paid bigint;
  v_desc text;
  v_staff boolean;
  v_prefix text;
  v_other_staff uuid;
  v_personnel uuid;
BEGIN
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Geçersiz tarih.';
  END IF;
  v_month := public.fin__month_start(public.fin__day(p_month));
  IF v_month >= public.fin__month_start(v_today) THEN
    RAISE EXCEPTION 'Yalnızca bitmiş aylar kapatılabilir.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  -- Exclusive close and month locks, in that order: line / piece / lab cost writes of the clinic wait
  -- (fin__hk_check_open takes both shared), as a write into an earlier month would change this month's ortho walk.
  PERFORM pg_advisory_xact_lock(public.fin__hk_close_lock(v_clinic));
  PERFORM pg_advisory_xact_lock(public.fin__hk_month_lock(v_clinic, v_month));

  SELECT * INTO v_row FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = v_month FOR UPDATE;
  IF v_row.status = 'closed' THEN
    RETURN public.fin__hk_month_json(v_clinic, v_month, v_today) || jsonb_build_object('already_saved', true);
  END IF;
  IF p_version IS DISTINCT FROM coalesce(v_row.version, 0) THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  v_c := public.fin__hk_compute(v_clinic, v_month);

  IF NOT coalesce(p_accept_unruled, false) THEN
    SELECT string_agg(DISTINCT coalesce(w ->> 'doctor_name', '?'), ', ' ORDER BY coalesce(w ->> 'doctor_name', '?'))
      INTO v_bad
    FROM jsonb_array_elements(v_c -> 'warnings') w
    WHERE (w ->> 'code') IN ('UNRULED_LINES', 'UNRULED_PIECES');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Kuralı olmayan hekim satırları var: %. Kural ekleyin ya da kuralsız satırları kabul ederek kapatın.',
        v_bad;
    END IF;
  END IF;

  SELECT string_agg(p ->> 'payee_name', ', ' ORDER BY p ->> 'payee_name')
    INTO v_bad
  FROM jsonb_array_elements(v_c -> 'payees') p
  WHERE (p ->> 'total_cents')::bigint < 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş toplamı eksi çıkan kişi var: %. Ay kapatılamaz; düzeltme satırlarını kontrol edin.', v_bad;
  END IF;

  -- A live entry linked by any earlier statement of this month (superseded at reopen) whose payee now has no payable
  -- amount: missing from the computation (rule moved to another payee or ended) or total 0.
  SELECT string_agg(DISTINCT coalesce(u.full_name, '?'), ', ' ORDER BY coalesce(u.full_name, '?'))
    INTO v_bad
  FROM public.fin_hk_statements s
  JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id AND e.cancelled_at IS NULL
  LEFT JOIN public.users u ON u.id = s.payee_user_id
  WHERE s.clinic_id = v_clinic AND s.month = v_month
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_c -> 'payees') p
      WHERE (p ->> 'payee_user_id')::uuid = s.payee_user_id AND (p ->> 'total_cents')::bigint <> 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Şu kişiler için bu ayın hakediş kaydı zaten var, yeni hesapta ise hakedişleri yok (0): %. Tutar yanlışsa satırları / kuralları düzeltin. Tutar gerçekten 0 ise kaydı Finans ekranında iptal edin, sonra ayı kapatın. İptal geri alınamaz; bu kişiye aynı ay için yeniden hakediş kaydı açılamaz.',
      v_bad;
  END IF;

  UPDATE public.fin_hk_statements s
  SET superseded_at = now(), superseded_by = v_user
  WHERE s.clinic_id = v_clinic AND s.month = v_month AND s.superseded_at IS NULL;

  FOR v_p IN SELECT p FROM jsonb_array_elements(v_c -> 'payees') p
  LOOP
    v_payee := (v_p ->> 'payee_user_id')::uuid;
    v_name := v_p ->> 'payee_name';
    v_total := (v_p ->> 'total_cents')::bigint;
    v_doctor := NULL;
    v_cp := NULL;
    v_cp_active := NULL;
    v_entry := NULL;
    v_entry_amount := NULL;
    v_entry_cancelled := NULL;
    v_entry_desc := NULL;

    SELECT d.id INTO v_doctor FROM public.doctors d WHERE d.user_id = v_payee AND d.clinic_id = v_clinic;
    -- 0031: a payee without a doctors row whose components are only fixed_monthly / adjustments is staff: one
    -- payroll entry in the personnel bucket under the staff counterparty linked to the user.
    v_staff := v_doctor IS NULL AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(v_p -> 'components') = 'array' THEN v_p -> 'components' ELSE '[]'::jsonb END) k
      WHERE (k ->> 'kind') IS DISTINCT FROM 'fixed_monthly' AND (k ->> 'kind') IS DISTINCT FROM 'adjustments');
    v_prefix := CASE WHEN v_staff THEN 'payroll:' ELSE 'entitlement:' END;
    IF v_doctor IS NOT NULL THEN
      SELECT cp.id, cp.is_active INTO v_cp, v_cp_active
      FROM public.fin_counterparties cp
      WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_doctor;
    ELSIF v_staff THEN
      SELECT cp.id, cp.is_active INTO v_cp, v_cp_active
      FROM public.fin_counterparties cp
      WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_payee;
    END IF;
    IF v_cp IS NOT NULL THEN
      SELECT e.id, e.amount_cents, e.cancelled_at IS NOT NULL, e.description
        INTO v_entry, v_entry_amount, v_entry_cancelled, v_entry_desc
      FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic
        AND e.source_key = v_prefix || v_cp::text || ':' || to_char(v_month, 'YYYY-MM')
      FOR UPDATE;
    END IF;

    IF v_total = 0 THEN
      IF v_entry IS NOT NULL AND NOT v_entry_cancelled THEN
        IF v_staff THEN
          RAISE EXCEPTION '% için bu ayın maaş kaydı zaten var (%), yeni hesaplanan tutar ise 0. Tutar yanlışsa sabit maaş kuralını / prim satırlarını düzeltin. Tutar gerçekten 0 ise kaydı Finans ekranında iptal edin, sonra ayı kapatın. İptal geri alınamaz; bu kişiye aynı ay için yeniden maaş kaydı açılamaz.',
            v_name, public.fin__hk_tl(v_entry_amount);
        END IF;
        RAISE EXCEPTION '% için bu ayın hakediş kaydı zaten var (%), yeni hesaplanan tutar ise 0. Tutar yanlışsa satırları / kuralları düzeltin. Tutar gerçekten 0 ise kaydı Finans ekranında iptal edin, sonra ayı kapatın. İptal geri alınamaz; bu hekime aynı ay için yeniden hakediş kaydı açılamaz.',
          v_name, public.fin__hk_tl(v_entry_amount);
      END IF;
      v_entry := NULL;
    ELSE
      IF v_doctor IS NULL AND NOT v_staff THEN
        RAISE EXCEPTION '% için hekim kaydı yok, hakediş cari kaydı açılamadı. Önce Ekip ekranından hekim kaydını ekleyin.',
          v_name;
      END IF;

      IF v_cp IS NULL THEN
        -- An unlinked counterparty of the payee's kind (physician / staff) with the payee's name is linked; any other
        -- name clash is refused.
        SELECT cp.id, cp.kind, cp.doctor_id, cp.staff_user_id, cp.is_active
          INTO v_other, v_other_kind, v_other_doctor, v_other_staff, v_other_active
        FROM public.fin_counterparties cp
        WHERE cp.clinic_id = v_clinic AND cp.normalized_name = public.fin__normalize_name(v_name);
        IF v_staff THEN
          IF v_other IS NOT NULL THEN
            IF v_other_kind <> 'staff' OR v_other_staff IS NOT NULL THEN
              RAISE EXCEPTION '"%" adlı başka bir cari kaydı var. Cariler ekranında o kaydın adını değiştirin, sonra ayı kapatın.',
                v_name;
            END IF;
            UPDATE public.fin_counterparties cp
            SET staff_user_id = v_payee
            WHERE cp.clinic_id = v_clinic AND cp.id = v_other;
            v_cp := v_other;
            v_cp_active := v_other_active;
          ELSE
            v_cp := gen_random_uuid();
            INSERT INTO public.fin_counterparties (id, clinic_id, name, normalized_name, kind, staff_user_id, note,
                                                   is_active, created_by, updated_by)
            VALUES (v_cp, v_clinic, left(btrim(v_name), 200), public.fin__normalize_name(left(btrim(v_name), 200)),
                    'staff', v_payee, 'Maaş için otomatik oluşturuldu', true, v_user, v_user);
            v_cp_active := true;
          END IF;
        ELSIF v_other IS NOT NULL THEN
          IF v_other_kind <> 'physician' OR v_other_doctor IS NOT NULL THEN
            RAISE EXCEPTION '"%" adlı başka bir cari kaydı var. Cariler ekranında bu hekime bağlayın veya adını değiştirin, sonra ayı kapatın.',
              v_name;
          END IF;
          UPDATE public.fin_counterparties cp SET doctor_id = v_doctor WHERE cp.clinic_id = v_clinic AND cp.id = v_other;
          v_cp := v_other;
          v_cp_active := v_other_active;
        ELSE
          v_cp := gen_random_uuid();
          INSERT INTO public.fin_counterparties (id, clinic_id, name, normalized_name, kind, doctor_id, note, is_active,
                                                 created_by, updated_by)
          VALUES (v_cp, v_clinic, left(btrim(v_name), 200), public.fin__normalize_name(left(btrim(v_name), 200)),
                  'physician', v_doctor, 'Hakediş için otomatik oluşturuldu', true, v_user, v_user);
          v_cp_active := true;
        END IF;
        -- A fresh link has no entry for this month yet (the key carries the counterparty id).
        SELECT e.id, e.amount_cents, e.cancelled_at IS NOT NULL, e.description
          INTO v_entry, v_entry_amount, v_entry_cancelled, v_entry_desc
        FROM public.fin_entries e
        WHERE e.clinic_id = v_clinic
          AND e.source_key = v_prefix || v_cp::text || ':' || to_char(v_month, 'YYYY-MM')
        FOR UPDATE;
      END IF;

      IF NOT coalesce(v_cp_active, false) THEN
        IF v_staff THEN
          RAISE EXCEPTION '% için personel cari kaydı pasif. Cariler ekranından aktifleştirin, sonra ayı kapatın.', v_name;
        END IF;
        RAISE EXCEPTION '% için hekim cari kaydı pasif. Cariler ekranından aktifleştirin, sonra ayı kapatın.', v_name;
      END IF;

      -- A live entry of this payee linked by any earlier statement of the month must be the one found above (same
      -- counterparty key); one under another counterparty (doctor relinked since, or a staff payee who got a doctors
      -- row) would be a second payable. Every earlier statement is checked, so a later statement without an entry
      -- cannot hide an older live one.
      IF EXISTS (
        SELECT 1
        FROM public.fin_hk_statements s
        JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
        WHERE s.clinic_id = v_clinic AND s.month = v_month AND s.payee_user_id = v_payee
          AND e.cancelled_at IS NULL AND e.id IS DISTINCT FROM v_entry
      ) THEN
        IF v_staff THEN
          RAISE EXCEPTION '% için bu ayın maaş kaydı başka bir cari kaydında duruyor. Önce o kaydı Finans ekranında düzeltin veya iptal edin, sonra ayı kapatın.',
            v_name;
        END IF;
        RAISE EXCEPTION '% için bu ayın hakediş kaydı başka bir cari kaydında duruyor. Önce o kaydı Finans ekranında düzeltin veya iptal edin, sonra ayı kapatın.',
          v_name;
      END IF;

      IF v_staff THEN
        v_desc := public.fin__hk_payroll_description(v_p, v_month);
      ELSE
        v_desc := public.fin__hk_description(v_p, v_month, v_doctor);
      END IF;

      IF v_entry IS NULL THEN
        v_entry := gen_random_uuid();
        IF v_staff THEN
          -- Same shape as an entry typed in Finans for the personnel bucket: no subcategory, no entitlement month
          -- (fin_entry_guard), due on the 1st of the month like fin_add_entitlement.
          IF v_personnel IS NULL THEN
            SELECT c.id INTO v_personnel
            FROM public.fin_categories c
            WHERE c.clinic_id = v_clinic AND c.report_bucket = 'personnel' AND c.is_system AND c.is_active;
            IF v_personnel IS NULL THEN
              RAISE EXCEPTION 'Personel gider kategorisi bulunamadı veya pasif. Finans → Kategoriler ekranında "Personel" kategorisini aktifleştirin, sonra ayı kapatın.';
            END IF;
          END IF;
          INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                          description, due_date, amount_cents, entitlement_month, source_key,
                                          created_by, updated_by)
          VALUES (v_entry, v_clinic, v_personnel, NULL, v_cp, NULL,
                  v_desc, v_month, v_total, NULL, 'payroll:' || v_cp::text || ':' || to_char(v_month, 'YYYY-MM'),
                  v_user, v_user);
        ELSE
          PERFORM public.fin_add_entitlement(v_entry, v_cp, to_char(v_month, 'YYYY-MM'), v_total, 0, NULL, NULL,
                                             v_desc);
        END IF;
      ELSIF v_entry_cancelled THEN
        IF v_staff THEN
          RAISE EXCEPTION '% için bu ayın maaş kaydı iptal edilmiş; iptal geri alınamadığı için aynı ay için yeni maaş kaydı açılamaz. Ayı kapatmak için bu kişinin bu ayki tutarını 0 yapın (sabit maaş kuralının aylarını düzeltin, prim / diğer satırlarını iptal edin); ödenecek tutarı Finans ekranında ayrı bir personel gideri olarak girin.',
            v_name;
        END IF;
        RAISE EXCEPTION '% için bu ayın hakediş kaydı iptal edilmiş; iptal geri alınamadığı için aynı ay için yeni kayıt açılamaz. Ayı kapatmak için Cariler ekranında hekimi yeni bir hekim carisine bağlayın (eski cariyi bağlantısız bırakıp adını değiştirin).',
          v_name;
      ELSE
        v_paid := public.fin__paid(v_entry);
        IF v_total < v_paid THEN
          IF v_staff THEN
            RAISE EXCEPTION '% için bu aya şimdiye kadar % ödenmiş; yeni maaş tutarı (%) bundan az olamaz. Önce fazla ödemeyi düzeltin.',
              v_name, public.fin__hk_tl(v_paid), public.fin__hk_tl(v_total);
          END IF;
          RAISE EXCEPTION '% için bu aya şimdiye kadar % ödenmiş; yeni hakediş tutarı (%) bundan az olamaz. Önce fazla ödemeyi düzeltin.',
            v_name, public.fin__hk_tl(v_paid), public.fin__hk_tl(v_total);
        END IF;
        IF v_entry_amount IS DISTINCT FROM v_total OR v_entry_desc IS DISTINCT FROM v_desc THEN
          UPDATE public.fin_entries e
          SET amount_cents = v_total, description = v_desc
          WHERE e.clinic_id = v_clinic AND e.id = v_entry;
        END IF;
      END IF;
    END IF;

    INSERT INTO public.fin_hk_statements (clinic_id, month, payee_user_id, total_cents, breakdown, fin_entry_id,
                                          created_by)
    VALUES (v_clinic, v_month, v_payee, v_total, v_p, v_entry, v_user);
  END LOOP;

  IF v_row.id IS NULL THEN
    INSERT INTO public.fin_hk_months (clinic_id, month, status, closed_at, closed_by, created_by, updated_by)
    VALUES (v_clinic, v_month, 'closed', now(), v_user, v_user, v_user);
  ELSE
    UPDATE public.fin_hk_months m
    SET status = 'closed', closed_at = now(), closed_by = v_user
    WHERE m.clinic_id = v_clinic AND m.id = v_row.id;
  END IF;

  RETURN public.fin__hk_month_json(v_clinic, v_month, v_today) || jsonb_build_object('already_saved', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Self-service RPCs (0030 §5, same signatures; still only the caller's own data). A payee's fixed salary and
--    adjustments come with the own payee object; an open month is also computed when the caller has live adjustments
--    in it; the month's entry is the caller's entitlement entry or, for a payee without a doctors row, the payroll
--    entry (fin__hk_payee_entry).
-- ---------------------------------------------------------------------------

-- The caller's months, newest first, from the earliest month of the caller's rules (at most 60 months back) to the
-- current month. Closed months show the statement total and the linked entry's paid / remaining; open months the
-- live estimate (and what is already paid on the month's entry, if one exists).
CREATE OR REPLACE FUNCTION public.hk_my_months()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
  v_user uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_current date := public.fin__month_start(public.clinic_today());
  v_first date;
  v_m date;
  v_status text;
  v_total bigint;
  v_entry uuid;
  v_amount bigint;
  v_cancelled boolean;
  v_paid bigint;
  v_remaining bigint;
  v_months jsonb := '[]'::jsonb;
BEGIN
  IF v_clinic IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;

  SELECT min(r.from_month) INTO v_first
  FROM public.fin_hk_rules r
  WHERE r.clinic_id = v_clinic AND r.payee_user_id = v_user;
  IF v_first IS NULL THEN
    RETURN jsonb_build_object('has_rules', false, 'today', v_today, 'current_month', v_current,
                              'months', '[]'::jsonb);
  END IF;
  v_first := greatest(v_first, (v_current - interval '59 months')::date);

  FOR v_m IN
    SELECT g::date FROM generate_series(v_current::timestamp, v_first::timestamp, interval '-1 month') AS g
  LOOP
    v_status := NULL;
    v_total := NULL;
    v_entry := NULL;
    v_amount := NULL;
    v_cancelled := NULL;
    v_paid := 0;
    v_remaining := NULL;

    SELECT m.status INTO v_status FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = v_m;
    v_status := coalesce(v_status, 'open');

    IF v_status = 'closed' THEN
      SELECT s.total_cents, s.fin_entry_id INTO v_total, v_entry
      FROM public.fin_hk_statements s
      WHERE s.clinic_id = v_clinic AND s.month = v_m AND s.payee_user_id = v_user AND s.superseded_at IS NULL;
    ELSE
      IF EXISTS (
        SELECT 1 FROM public.fin_hk_rules r
        WHERE r.clinic_id = v_clinic AND r.payee_user_id = v_user
          AND r.from_month <= v_m AND (r.to_month IS NULL OR r.to_month >= v_m)
      ) OR EXISTS (
        SELECT 1 FROM public.fin_hk_adjustments a
        WHERE a.clinic_id = v_clinic AND a.payee_user_id = v_user AND a.month = v_m AND a.voided_at IS NULL
      ) THEN
        SELECT (p ->> 'total_cents')::bigint INTO v_total
        FROM jsonb_array_elements(public.fin__hk_compute(v_clinic, v_m) -> 'payees') p
        WHERE (p ->> 'payee_user_id') = v_user::text;
      END IF;
      v_entry := public.fin__hk_payee_entry(v_clinic, v_user, v_m);
    END IF;
    v_total := coalesce(v_total, 0);

    IF v_entry IS NOT NULL THEN
      SELECT e.amount_cents, e.cancelled_at IS NOT NULL INTO v_amount, v_cancelled
      FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic AND e.id = v_entry;
      v_paid := public.fin__paid(v_entry);
    END IF;
    IF v_status = 'closed' THEN
      v_remaining := CASE WHEN v_entry IS NULL THEN greatest(v_total - v_paid, 0)
                          WHEN v_cancelled THEN 0
                          ELSE v_amount - v_paid END;
    END IF;

    v_months := v_months || jsonb_build_array(jsonb_build_object(
      'month', v_m,
      'status', v_status,
      'is_estimate', v_status <> 'closed',
      'total_cents', v_total,
      'paid_cents', v_paid,
      'remaining_cents', v_remaining));
  END LOOP;

  RETURN jsonb_build_object('has_rules', true, 'today', v_today, 'current_month', v_current, 'months', v_months);
END;
$$;

-- One month of the caller (0030): own payee object (frozen statement breakdown when closed, live estimate otherwise;
-- salary and adjustments components included), the lines counted under the caller's own ciro_share / ortho rules plus
-- the unruled lines of the caller's own doctors row, the pieces of the caller's implant rule doctors, the lab costs
-- of the caller's ortho patients, and the caller's own statement / entry. A caller without any rule gets
-- {has_rules: false}.
CREATE OR REPLACE FUNCTION public.hk_my_month(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
  v_user uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_month date;
  v_next date;
  v_status text;
  v_active boolean;
  v_share_doctors uuid[];
  v_piece_doctors uuid[];
  v_stmt_total bigint;
  v_stmt_at timestamptz;
  v_stmt_entry uuid;
  v_stmt_breakdown jsonb;
  v_entry uuid;
  v_payees jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_pieces jsonb := '[]'::jsonb;
  v_lab jsonb := '[]'::jsonb;
  v_statement jsonb;
  v_entitlement jsonb;
BEGIN
  IF v_clinic IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fin_hk_rules r WHERE r.clinic_id = v_clinic AND r.payee_user_id = v_user) THEN
    RETURN jsonb_build_object('has_rules', false);
  END IF;

  v_month := public.fin__month_start(public.fin__day(coalesce(p_month, v_today)));
  v_next := (v_month + interval '1 month')::date;

  SELECT m.status INTO v_status FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = v_month;
  v_status := coalesce(v_status, 'open');

  SELECT count(*) > 0,
         coalesce(array_agg(DISTINCT r.doctor_id) FILTER (WHERE r.kind IN ('ciro_share', 'ortho_lab_first')),
                  '{}'::uuid[]),
         coalesce(array_agg(DISTINCT r.doctor_id) FILTER (WHERE r.kind = 'implant_piece'), '{}'::uuid[])
    INTO v_active, v_share_doctors, v_piece_doctors
  FROM public.fin_hk_rules r
  WHERE r.clinic_id = v_clinic AND r.payee_user_id = v_user
    AND r.from_month <= v_month AND (r.to_month IS NULL OR r.to_month >= v_month);

  IF v_status = 'closed' THEN
    SELECT s.total_cents, s.created_at, s.fin_entry_id, s.breakdown
      INTO v_stmt_total, v_stmt_at, v_stmt_entry, v_stmt_breakdown
    FROM public.fin_hk_statements s
    WHERE s.clinic_id = v_clinic AND s.month = v_month AND s.payee_user_id = v_user AND s.superseded_at IS NULL;
    IF v_stmt_breakdown IS NOT NULL THEN
      v_payees := jsonb_build_array(public.fin__hk_self_payee(v_stmt_breakdown));
      v_statement := jsonb_build_object('total_cents', v_stmt_total, 'closed_at', v_stmt_at);
    END IF;
    v_entry := v_stmt_entry;
  ELSE
    IF v_active OR EXISTS (
      SELECT 1 FROM public.fin_hk_adjustments a
      WHERE a.clinic_id = v_clinic AND a.payee_user_id = v_user AND a.month = v_month AND a.voided_at IS NULL
    ) THEN
      SELECT coalesce(jsonb_agg(public.fin__hk_self_payee(p)), '[]'::jsonb) INTO v_payees
      FROM jsonb_array_elements(public.fin__hk_compute(v_clinic, v_month) -> 'payees') p
      WHERE (p ->> 'payee_user_id') = v_user::text;
    END IF;
    v_entry := public.fin__hk_payee_entry(v_clinic, v_user, v_month);
  END IF;

  IF v_entry IS NOT NULL THEN
    SELECT jsonb_build_object(
             'amount_cents', e.amount_cents,
             'paid_cents', public.fin__paid(e.id),
             'remaining_cents', CASE WHEN e.cancelled_at IS NOT NULL THEN 0
                                     ELSE e.amount_cents - public.fin__paid(e.id) END,
             'is_cancelled', e.cancelled_at IS NOT NULL)
      INTO v_entitlement
    FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND e.id = v_entry;
  END IF;

  IF cardinality(v_share_doctors) > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id,
             'day', l.day,
             'patient_name', l.patient_name,
             'method', l.method,
             'currency', l.currency,
             'amount_cents', l.amount_cents,
             'try_cents', l.try_cents,
             'implant_cents', l.implant_cents,
             'segment', ev.segment,
             'lab_part', ev.lab_part_cents,
             'counted', coalesce(ev.payee_user_id = v_user, false))
             ORDER BY l.day, l.created_at, l.id), '[]'::jsonb)
      INTO v_lines
    FROM public.fin__hk_eval_lines(v_clinic, v_month) ev
    JOIN public.fin_hk_lines l ON l.clinic_id = v_clinic AND l.id = ev.line_id
    WHERE ev.doctor_id = ANY (v_share_doctors)
      AND (ev.payee_user_id = v_user
           OR (ev.rule_id IS NULL
               AND EXISTS (SELECT 1 FROM public.doctors d
                           WHERE d.clinic_id = v_clinic AND d.id = ev.doctor_id AND d.user_id = v_user)));
  END IF;

  IF cardinality(v_piece_doctors) > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', pc.id,
             'day', pc.day,
             'patient_name', pc.patient_name,
             'qty', pc.qty,
             'description', pc.description)
             ORDER BY pc.day, pc.created_at, pc.id), '[]'::jsonb)
      INTO v_pieces
    FROM public.fin_hk_pieces pc
    WHERE pc.clinic_id = v_clinic AND pc.voided_at IS NULL AND pc.day >= v_month AND pc.day < v_next
      AND pc.doctor_id = ANY (v_piece_doctors);
  END IF;

  -- Lab cost rows of the patients listed in the caller's own ortho components (to date).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'day', c.day,
           'patient_name', c.patient_name,
           'lab_name', c.lab_name,
           'amount_cents', c.amount_cents)
           ORDER BY c.day, c.created_at, c.id), '[]'::jsonb)
    INTO v_lab
  FROM public.fin_hk_lab_costs c
  WHERE c.clinic_id = v_clinic
    AND c.voided_at IS NULL
    AND c.day < v_next
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_payees) py
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(py -> 'components') = 'array' THEN py -> 'components' ELSE '[]'::jsonb END) k
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(k -> 'lab_patients') = 'array' THEN k -> 'lab_patients' ELSE '[]'::jsonb END) lp
      WHERE (k ->> 'kind') = 'ortho_lab_first'
        AND (k ->> 'doctor_id') = c.doctor_id::text
        AND (lp ->> 'patient_ref') = c.patient_ref);

  RETURN jsonb_build_object(
    'has_rules', true,
    'today', v_today,
    'current_month', public.fin__month_start(v_today),
    'month', v_month,
    'status', v_status,
    'is_estimate', v_status <> 'closed',
    'payees', v_payees,
    'lines', v_lines,
    'pieces', v_pieces,
    'lab_costs', v_lab,
    'statement', v_statement,
    'entitlement', v_entitlement);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. 0030 functions replaced with the same signature (CREATE OR REPLACE keeps the ACL; no overload):
--    fin_hk_adjustments joins the 'Finans geçmişi' entity filter and the owner JSON export. Bodies otherwise verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_audit_list(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_entity_type text;
  v_entity_id uuid;
  v_user_id uuid;
  v_from date;
  v_to date;
  v_offset integer;
  v_limit integer;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_f) AS k(k_name)
    WHERE k.k_name NOT IN ('entity_type', 'entity_id', 'user_id', 'date_from', 'date_to')
  ) THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  BEGIN
    v_entity_type := nullif(v_f ->> 'entity_type', '');
    v_entity_id := nullif(v_f ->> 'entity_id', '')::uuid;
    v_user_id := nullif(v_f ->> 'user_id', '')::uuid;
    v_from := nullif(v_f ->> 'date_from', '')::date;
    v_to := nullif(v_f ->> 'date_to', '')::date;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END;
  IF v_entity_type IS NOT NULL AND v_entity_type NOT IN (
       'fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories', 'fin_counterparties', 'fin_entries',
       'fin_payments', 'fin_balance_snapshots', 'fin_balance_sources',
       'fin_import_batches', 'fin_import_sources', 'fin_classification_rules', 'fin_import_layouts',
       'fin_patient_financing',
       'fin_hk_rules', 'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks', 'fin_hk_lab_costs',
       'fin_hk_months', 'fin_hk_statements', 'fin_hk_adjustments') THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF v_from > v_to THEN
    RAISE EXCEPTION 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.fin__page(p_page) pg;

  WITH a AS (
    SELECT al.id, al.created_at, al.user_id, al.entity_type, al.entity_id, al.action, al.changes,
           al.before_data, al.after_data
    FROM public.audit_logs al
    WHERE al.clinic_id = v_clinic
      AND left(al.entity_type, 4) = 'fin_'
      AND (v_entity_type IS NULL OR al.entity_type = v_entity_type)
      AND (v_entity_id IS NULL OR al.entity_id = v_entity_id)
      AND (v_user_id IS NULL OR al.user_id = v_user_id)
      AND (v_from IS NULL OR (al.created_at AT TIME ZONE 'Europe/Istanbul')::date >= v_from)
      AND (v_to IS NULL OR (al.created_at AT TIME ZONE 'Europe/Istanbul')::date <= v_to)
  ),
  pg AS (
    SELECT a.*
    FROM a
    ORDER BY a.created_at DESC, a.id DESC
    OFFSET v_offset
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
           'rows', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', pg.id,
                      'at', pg.created_at,
                      'user_id', pg.user_id,
                      'user_name', u.full_name,
                      'entity_type', pg.entity_type,
                      'entity_id', pg.entity_id,
                      'action', pg.action,
                      'changes', pg.changes,
                      'before_data', pg.before_data,
                      'after_data', pg.after_data)
                    ORDER BY pg.created_at DESC, pg.id DESC)
             FROM pg
             LEFT JOIN public.users u ON u.id = pg.user_id), '[]'::jsonb),
           'total_count', (SELECT count(*)::bigint FROM a),
           'offset', v_offset,
           'limit', v_limit)
    INTO v_result;

  RETURN v_result;
END;
$$;

-- Owner JSON export manifest (0020 §3.8, 0022, 0030) + fin_hk_adjustments.
CREATE OR REPLACE FUNCTION public.fin_export_manifest()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;
  IF public.current_app_role() IS DISTINCT FROM 'owner' OR NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Dışa aktarma yalnızca finans yetkisi olan klinik sahibine açıktır.' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'format', 'dentos-finance-export/1',
    'generated_at', now(),
    'clinic_today', public.clinic_today(),
    'clinic', (SELECT jsonb_build_object('id', c.id, 'name', c.name) FROM public.clinics c WHERE c.id = v_clinic),
    'tables', jsonb_build_array(
      jsonb_build_object('name', 'fin_settings', 'row_count',
        (SELECT count(*) FROM public.fin_settings t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_accounts', 'row_count',
        (SELECT count(*) FROM public.fin_accounts t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_report_groups', 'row_count',
        (SELECT count(*) FROM public.fin_report_groups t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_categories', 'row_count',
        (SELECT count(*) FROM public.fin_categories t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_counterparties', 'row_count',
        (SELECT count(*) FROM public.fin_counterparties t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_entries', 'row_count',
        (SELECT count(*) FROM public.fin_entries t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_payments', 'row_count',
        (SELECT count(*) FROM public.fin_payments t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_balance_snapshots', 'row_count',
        (SELECT count(*) FROM public.fin_balance_snapshots t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_balance_sources', 'row_count',
        (SELECT count(*) FROM public.fin_balance_sources t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_import_batches', 'row_count',
        (SELECT count(*) FROM public.fin_import_batches t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_import_sources', 'row_count',
        (SELECT count(*) FROM public.fin_import_sources t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_classification_rules', 'row_count',
        (SELECT count(*) FROM public.fin_classification_rules t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_import_layouts', 'row_count',
        (SELECT count(*) FROM public.fin_import_layouts t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_patient_financing', 'row_count',
        (SELECT count(*) FROM public.fin_patient_financing t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_rules', 'row_count',
        (SELECT count(*) FROM public.fin_hk_rules t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_lines', 'row_count',
        (SELECT count(*) FROM public.fin_hk_lines t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_pieces', 'row_count',
        (SELECT count(*) FROM public.fin_hk_pieces t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_patient_marks', 'row_count',
        (SELECT count(*) FROM public.fin_hk_patient_marks t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_lab_costs', 'row_count',
        (SELECT count(*) FROM public.fin_hk_lab_costs t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_months', 'row_count',
        (SELECT count(*) FROM public.fin_hk_months t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_statements', 'row_count',
        (SELECT count(*) FROM public.fin_hk_statements t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_adjustments', 'row_count',
        (SELECT count(*) FROM public.fin_hk_adjustments t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'audit_logs', 'filter', 'entity_type LIKE ''fin\_%''', 'row_count',
        (SELECT count(*) FROM public.audit_logs t WHERE t.clinic_id = v_clinic AND left(t.entity_type, 4) = 'fin_'))));
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs (fin_hk_*, incl. fin_hk_save_adjustment / fin_hk_void_adjustment) granted to authenticated,
--    internals (fin__hk_*, fin__trg_*) never; plus its self-checks over every fin_* function and table (incl.
--    fin_hk_adjustments). The hk_* RPCs keep their 0030 ACL (CREATE OR REPLACE); repeated here for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_months() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hk_my_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_months() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hk_my_month(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_j jsonb;
  v_doc uuid := '00000000-0000-0000-0000-00000000000a';
BEGIN
  -- 1. fin_hk_adjustments: RLS, exactly one SELECT policy, audit / no-delete / no-truncate / fin_touch / fin_hk_refs
  --    / fin_hk_guard triggers.
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'fin_hk_adjustments' AND c.relrowsecurity)
     OR (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = 'fin_hk_adjustments') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = 'fin_hk_adjustments'
                      AND p.policyname = 'fin_hk_adjustments_select_finance' AND p.cmd = 'SELECT')
     OR EXISTS (
          SELECT 1
          FROM unnest(ARRAY['audit_row_change', 'fin_no_delete', 'fin_no_truncate', 'fin_touch', 'fin_hk_refs',
                            'fin_hk_guard']) AS g(name)
          WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tr
                            WHERE tr.tgrelid = 'public.fin_hk_adjustments'::regclass
                              AND tr.tgname = g.name AND NOT tr.tgisinternal)) THEN
    RAISE EXCEPTION 'fin_hk_adjustments kurulumu eksik.';
  END IF;

  -- 2. Signatures (no accidental overload; fin__harden_privileges refuses overloads of fin_* too).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin_hk_reference()',
    'public.fin_hk_month(date)',
    'public.fin_hk_marks()',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text)',
    'public.fin_hk_save_line(uuid,integer,date,uuid,text,text,text,text,bigint,bigint,bigint,text,text)',
    'public.fin_hk_void_line(uuid,integer,text)',
    'public.fin_hk_save_piece(uuid,integer,date,uuid,text,text,integer,text)',
    'public.fin_hk_void_piece(uuid,integer,text)',
    'public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date)',
    'public.fin_hk_save_settings(integer,integer)',
    'public.fin_hk_save_lab_cost(uuid,integer,date,uuid,text,text,text,bigint,text)',
    'public.fin_hk_void_lab_cost(uuid,integer,text)',
    'public.fin_hk_save_adjustment(uuid,integer,date,uuid,text,bigint,text)',
    'public.fin_hk_void_adjustment(uuid,integer,text)',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.fin_hk_reopen_month(date,integer)',
    'public.hk_my_months()',
    'public.hk_my_month(date)',
    'public.hk_marks_access()',
    'public.hk_marks_list(text)',
    'public.hk_save_mark(uuid,integer,text,text,uuid,date)',
    'public.fin_audit_list(jsonb,jsonb)',
    'public.fin_export_manifest()',
    'public.grant_staff_permission(uuid,text)',
    'public.revoke_staff_permission(uuid,text)',
    'public.fin__hk_require_prep_read()',
    'public.fin__hk_require_prep_write()',
    'public.fin__hk_strip_ledger(jsonb)',
    'public.fin__hk_adjustment_json(uuid,uuid)',
    'public.fin__hk_parts(jsonb,uuid)',
    'public.fin__hk_description(jsonb,date,uuid)',
    'public.fin__hk_payroll_description(jsonb,date)',
    'public.fin__hk_payee_entry(uuid,uuid,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin__trg_payroll_entry_guard()',
    'public.plt__finance_locked(uuid,uuid)',
    'public.users_guard()']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v1.2 fonksiyon imzaları beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Public RPCs callable by authenticated, never by anon; the prep helpers never by authenticated (also checked
  --    by fin__harden_privileges); grant / revoke / hk_my_* keep SECURITY DEFINER + search_path.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_hk_save_adjustment', 'fin_hk_void_adjustment', 'grant_staff_permission',
                      'revoke_staff_permission', 'hk_my_months', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v1.2 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__hk_require_prep_read', 'fin__hk_require_prep_write')
    AND (p.prosecdef OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hazırlık yetki yardımcıları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  -- plt__finance_locked stays an internal (0027): SECURITY INVOKER, search_path = public, callable by nobody else.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'plt__finance_locked'
    AND (p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'plt__finance_locked yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 4. Constraints: one CHECK on staff_permissions.permission with every key; fin_hk_rules kinds incl.
  --    fixed_monthly; fin_counterparties.staff_user_id with its kind check, unique key and trigger; the
  --    'hakedis_prepare' rules in grant / revoke, plt__finance_locked and users_guard (still on users); the payroll
  --    entry guard on fin_entries.
  IF (SELECT count(*)
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'permission'
      WHERE c.conrelid = 'public.staff_permissions'::regclass AND c.contype = 'c' AND c.conkey = ARRAY[a.attnum]) <> 1
     OR EXISTS (
          SELECT 1
          FROM unnest(ARRAY['finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical',
                            'hakedis_prepare']) AS k(key)
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'public.staff_permissions'::regclass
              AND c.conname = 'staff_permissions_permission_check'
              AND pg_get_constraintdef(c.oid) LIKE '%''' || k.key || '''%')) THEN
    RAISE EXCEPTION 'staff_permissions yetki listesi beklenen gibi değil.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_check'
                   AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_shape'
                      AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_counterparties'::regclass
                      AND c.conname = 'fin_counterparties_staff_kind')
     OR to_regclass('public.fin_counterparties_staff_user_key') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger tr
                    WHERE tr.tgrelid = 'public.fin_counterparties'::regclass
                      AND tr.tgname = 'fin_counterparty_staff' AND NOT tr.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'grant_staff_permission'
                      AND p.prosrc LIKE '%''hakedis_prepare''%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'revoke_staff_permission'
                      AND p.prosrc LIKE '%''hakedis_prepare''%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'plt__finance_locked'
                      AND p.prosrc LIKE '%''finance_readonly'', ''hakedis_prepare''%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'users_guard' AND p.prosecdef
                      AND p.prosrc LIKE '%Finans yetkisi olan personeli yalnızca klinik sahibi veya finans yetkilisi yeniden aktifleştirebilir.%'
                      AND p.prosrc LIKE '%Hakediş ve maaş hazırlama yetkisi olan personeli yalnızca klinik sahibi yeniden aktifleştirebilir.%')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger tr
                    WHERE tr.tgrelid = 'public.users'::regclass AND tr.tgname = 'users_guard'
                      AND tr.tgfoid = 'public.users_guard()'::regprocedure AND NOT tr.tgisinternal
                      AND tr.tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger tr
                    WHERE tr.tgrelid = 'public.fin_entries'::regclass AND tr.tgname = 'fin_payroll_entry_guard'
                      AND tr.tgfoid = 'public.fin__trg_payroll_entry_guard()'::regprocedure AND NOT tr.tgisinternal
                      AND tr.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Hakediş v1.2 kısıtları / tetikleyicileri eksik.';
  END IF;

  -- 5. Pure helpers: entry descriptions (the 0030 text for the 0030 kinds; salary and adjustment parts), the ledger
  --    strip, and an empty computation (runs every query of the engine once; still the 0030 result).
  v_j := jsonb_build_object('components', jsonb_build_array(
           jsonb_build_object('kind', 'ciro_share', 'doctor_id', v_doc, 'doctor_name', 'D', 'segment', 'standard',
                              'share_bp', 2500, 'base_cents', 100000, 'amount_cents', 25000),
           jsonb_build_object('kind', 'implant_piece', 'doctor_id', v_doc, 'doctor_name', 'D', 'qty', 2,
                              'piece_cents', 10000, 'amount_cents', 20000),
           jsonb_build_object('kind', 'clinic_ciro_share', 'share_bp', 300, 'base_cents', 100000, 'amount_cents', 0),
           jsonb_build_object('kind', 'fixed_monthly', 'amount_cents', 300000),
           jsonb_build_object('kind', 'adjustments', 'amount_cents', 5000, 'items', jsonb_build_array(
             jsonb_build_object('kind', 'bonus', 'amount_cents', 10000),
             jsonb_build_object('kind', 'other', 'amount_cents', -5000)))));
  IF public.fin__hk_description(v_j, DATE '2024-01-01', v_doc)
       IS DISTINCT FROM 'DentOS hakediş 2024-01: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL; implant 2 × '
                        || '100,00 TL = 200,00 TL; sabit maaş 3.000,00 TL; prim 100,00 TL; diğer -50,00 TL'
     OR public.fin__hk_description(v_j #- '{components,3}' #- '{components,3}', DATE '2024-01-01', NULL)
          IS DISTINCT FROM 'DentOS hakediş 2024-01: ciro payı D (standart) %25 × 1.000,00 TL = 250,00 TL; '
                           || 'implant D 2 × 100,00 TL = 200,00 TL'
     OR public.fin__hk_payroll_description(jsonb_build_object('components', '[]'::jsonb), DATE '2024-01-01')
          IS DISTINCT FROM 'DentOS maaş 2024-01: tutar yok'
     OR public.fin__hk_payroll_description(
          jsonb_build_object('components', jsonb_build_array(
            jsonb_build_object('kind', 'adjustments', 'amount_cents', 0, 'items', jsonb_build_array(
              jsonb_build_object('kind', 'bonus', 'amount_cents', 100),
              jsonb_build_object('kind', 'other', 'amount_cents', -100))))), DATE '2024-02-01')
          IS DISTINCT FROM 'DentOS maaş 2024-02: prim 1,00 TL; diğer -1,00 TL' THEN
    RAISE EXCEPTION 'Hakediş kayıt açıklaması beklenen gibi değil.';
  END IF;
  IF public.fin__hk_strip_ledger(
       '{"month": "2024-01-01",
         "payees": [{"payee_user_id": "u", "counterparty_id": "c", "total_cents": 1}],
         "warnings": [{"code": "NO_COUNTERPARTY", "payee_user_id": "u"}, {"code": "UNRULED_LINES"}],
         "statements": [{"id": "s", "fin_entry_id": "e", "entry": {"paid_cents": 1},
                         "breakdown": {"counterparty_id": "c", "total_cents": 1}}]}'::jsonb)
     IS DISTINCT FROM
       '{"month": "2024-01-01",
         "payees": [{"payee_user_id": "u", "total_cents": 1}],
         "warnings": [{"code": "UNRULED_LINES"}],
         "statements": [{"id": "s", "fin_entry_id": "e", "entry": null, "breakdown": {"total_cents": 1}}]}'::jsonb THEN
    RAISE EXCEPTION 'Hakediş defter verisi ayıklaması beklenen gibi değil.';
  END IF;
  v_j := public.fin__hk_compute(gen_random_uuid(), DATE '2024-01-15');
  IF v_j IS DISTINCT FROM jsonb_build_object('month', DATE '2024-01-01', 'payees', '[]'::jsonb,
                                             'clinic_total_cents', 0, 'warnings', '[]'::jsonb) THEN
    RAISE EXCEPTION 'Boş klinik hesabı beklenen gibi değil: %', left(v_j::text, 300);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.2 Replay inside a block that is always rolled back: temporary clinic 'p31-test-hk-selfcheck-<random>' with an
--     owner (finance, doctors row), doctors A (ciro share + fixed salary + bonus) and B (ciro share only), a
--     reception user R ('hakedis_prepare', fixed salary, bonus), assistants S (fixed salary; an unlinked staff
--     counterparty of the same name exists) and T (bonus only, no login; a supplier counterparty of the same name
--     exists), an admin F holding 'finance', an admin G without it, and an inactive user X. Made-up names, rates and
--     amounts only. auth.uid() is simulated through request.jwt.claims (and request.jwt.claim.sub / .role), as in
--     0030. Covered: owner-only grant / revoke of 'hakedis_prepare'; the unlinked holder T locked against G's e-mail
--     change and invite (plt__finance_locked); fixed_monthly validation and overlap per payee; R entering and voiding
--     lines, pieces, lab costs, marks and adjustments, seeing every payee's figures without ledger data, refused on
--     rules / settings / close / reopen / other finance RPCs and on closed months, held by the mark lock; the month
--     close writing personnel entries (keys, category, amounts, descriptions, counterparty created / linked / name
--     clash) next to unchanged doctor entitlements; a payroll entry's person / category locked in fin_edit_entry;
--     re-close with a paid entry, a payee dropping out, a cancelled payroll entry; hk_my_* of a doctor with salary and
--     of a staff payee (own data only); reactivating a deactivated holder (owner only); revocation. Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p31-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_own_doc uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_a_auth uuid := gen_random_uuid();
  v_a_doc uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_b_auth uuid := gen_random_uuid();
  v_b_doc uuid := gen_random_uuid();
  v_r uuid := gen_random_uuid();
  v_r_auth uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_s_auth uuid := gen_random_uuid();
  v_t uuid := gen_random_uuid();
  v_f uuid := gen_random_uuid();
  v_f_auth uuid := gen_random_uuid();
  v_g uuid := gen_random_uuid();
  v_g_auth uuid := gen_random_uuid();
  v_x uuid := gen_random_uuid();
  v_cp_s uuid := gen_random_uuid();
  v_cp_t uuid := gen_random_uuid();
  v_rule_b uuid := gen_random_uuid();
  v_rule_a uuid := gen_random_uuid();
  v_rule_af uuid := gen_random_uuid();
  v_rule_r uuid := gen_random_uuid();
  v_rule_s uuid := gen_random_uuid();
  v_l1 uuid := gen_random_uuid();
  v_l2 uuid := gen_random_uuid();
  v_l3 uuid := gen_random_uuid();
  v_pc uuid := gen_random_uuid();
  v_lc uuid := gen_random_uuid();
  v_mk uuid := gen_random_uuid();
  v_adj_r uuid := gen_random_uuid();
  v_adj_r2 uuid := gen_random_uuid();
  v_adj_a uuid := gen_random_uuid();
  v_adj_t uuid := gen_random_uuid();
  v_adj_t2 uuid := gen_random_uuid();
  v_cp_r uuid;
  v_entry_r uuid;
  v_entry_t uuid;
  v_entry_s uuid;
  v_cat_pers uuid;
  v_cat_other uuid;
  v_account uuid;
  v_sql text;
  v_j jsonb;
  v_err text;
  v_state text;
  v_hint text;
  v_n bigint;
  v_ver integer;
  v_ver_e integer;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P31', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p31-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p31-sc-a-' || v_tag || '@example.invalid', true),
      (v_b, v_clinic, v_b_auth, 'doctor', 'Öz denetim Hekim B', 'p31-sc-b-' || v_tag || '@example.invalid', true),
      (v_r, v_clinic, v_r_auth, 'reception', 'Öz denetim Banko', 'p31-sc-r-' || v_tag || '@example.invalid', true),
      (v_s, v_clinic, v_s_auth, 'assistant', 'Öz denetim Asistan S', 'p31-sc-s-' || v_tag || '@example.invalid',
       true),
      (v_t, v_clinic, NULL, 'assistant', 'Öz denetim Asistan T', 'p31-sc-t-' || v_tag || '@example.invalid', true),
      (v_f, v_clinic, v_f_auth, 'admin', 'Öz denetim Yönetici', 'p31-sc-f-' || v_tag || '@example.invalid', true),
      (v_g, v_clinic, v_g_auth, 'admin', 'Öz denetim Yönetici G', 'p31-sc-g-' || v_tag || '@example.invalid', true),
      (v_x, v_clinic, NULL, 'assistant', 'Öz denetim Eski', 'p31-sc-x-' || v_tag || '@example.invalid', false);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_own_doc, v_clinic, v_own), (v_a_doc, v_clinic, v_a), (v_b_doc, v_clinic, v_b);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own), (v_clinic, v_f, 'finance', v_own);
    INSERT INTO public.fin_counterparties (id, clinic_id, name, normalized_name, kind, note, is_active) VALUES
      (v_cp_s, v_clinic, 'Öz denetim Asistan S', public.fin__normalize_name('Öz denetim Asistan S'), 'staff', '', true),
      (v_cp_t, v_clinic, 'Öz denetim Asistan T', public.fin__normalize_name('Öz denetim Asistan T'), 'supplier', '',
       true);
    SELECT a.id INTO v_account
    FROM public.fin_accounts a
    WHERE a.clinic_id = v_clinic AND a.kind = 'cash' AND a.is_active
    ORDER BY a.sort_order, a.id
    LIMIT 1;

    -- 'hakedis_prepare': refused for the admin who holds 'finance', granted by the owner; the admin cannot revoke it.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_f_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_f_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;
    v_state := NULL;
    BEGIN
      PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'finans yetkili yönetici hazırlama yetkisi verdi: ' || coalesce(v_state, '-'));
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');
    PERFORM public.grant_staff_permission(v_s, 'hakedis_prepare');

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_f_auth::text, true);
    v_state := NULL;
    BEGIN
      PERFORM public.revoke_staff_permission(v_r, 'hakedis_prepare');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'finans yetkili yönetici hazırlama yetkisini kaldırdı: ' || coalesce(v_state, '-'));
    END IF;
    SELECT count(*) INTO v_n
    FROM public.staff_permissions sp
    WHERE sp.clinic_id = v_clinic AND sp.permission = 'hakedis_prepare' AND sp.revoked_at IS NULL
      AND sp.user_id IN (v_r, v_s) AND sp.granted_by = v_own;
    IF v_n <> 2 THEN
      v_fail := array_append(v_fail, 'hazırlama yetkileri ' || v_n);
    END IF;

    -- An unlinked 'hakedis_prepare' holder is locked like a finance holder (plt__finance_locked): the owner grants it
    -- to T (no login) and may change T's e-mail; the admin G (no 'finance') can neither change it (RPC or UPDATE) nor
    -- invite T; R is locked out too, F ('finance') and the owner are not. Revoked again at the end of this part.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.grant_staff_permission(v_t, 'hakedis_prepare');
    IF NOT public.plt__finance_locked(v_t, v_r)
       OR NOT public.plt__finance_locked(v_t, v_g)
       OR public.plt__finance_locked(v_t, v_f)
       OR public.plt__finance_locked(v_t, v_own)
       OR public.plt__finance_locked(v_b, v_g) THEN
      v_fail := array_append(v_fail, 'hazırlama yetkisi e-posta / davet kilidi');
    END IF;
    v_j := public.plt_staff_save(v_t, (SELECT u.updated_at FROM public.users u WHERE u.id = v_t),
                                 'Öz denetim Asistan T', 'p31-sc-t2-' || v_tag || '@example.com', '', 'assistant',
                                 true, '');
    IF NOT coalesce((v_j ->> 'changed')::boolean, false)
       OR (SELECT u.email FROM public.users u WHERE u.id = v_t) IS DISTINCT FROM 'p31-sc-t2-' || v_tag || '@example.com' THEN
      v_fail := array_append(v_fail, 'sahip hazırlama yetkili personelin e-postası: ' || left(v_j::text, 300));
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_g_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_g_auth::text, true);
    v_state := NULL;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_staff_save(v_t, (SELECT u.updated_at FROM public.users u WHERE u.id = v_t),
                                    'Öz denetim Asistan T', 'p31-sc-t3-' || v_tag || '@example.com', '', 'assistant',
                                    true, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_state IS DISTINCT FROM '42501' OR v_hint IS DISTINCT FROM 'PLT_EMAIL_FINANCE' THEN
      v_fail := array_append(v_fail, 'hazırlama yetkili personelin e-postası (RPC): ' || coalesce(v_state, '-') || ' / '
                                     || coalesce(v_hint, '-'));
    END IF;
    v_state := NULL;
    v_hint := NULL;
    BEGIN
      UPDATE public.users SET email = 'p31-sc-t3-' || v_tag || '@example.com' WHERE id = v_t;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_state IS DISTINCT FROM '42501' OR v_hint IS DISTINCT FROM 'PLT_EMAIL_FINANCE' THEN
      v_fail := array_append(v_fail, 'hazırlama yetkili personelin e-postası (UPDATE): ' || coalesce(v_state, '-')
                                     || ' / ' || coalesce(v_hint, '-'));
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.plt_svc_invite_context(v_g_auth, v_t, 'invite');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'PLT_INVITE_FINANCE' THEN
      v_fail := array_append(v_fail, 'hazırlama yetkili personele davet: ' || coalesce(v_hint, '-'));
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.revoke_staff_permission(v_t, 'hakedis_prepare');
    IF public.plt__finance_locked(v_t, v_g) THEN
      v_fail := array_append(v_fail, 'kaldırılan hazırlama yetkisi hâlâ kilitli');
    END IF;

    -- Owner: rules. Two fixed salaries of different payees overlap in months (per-payee overlap); a second one for
    -- the same payee does not.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.fin_hk_save_rule(v_rule_b, 0, v_b, v_b_doc, 'ciro_share', 'standard', 2500, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_a, 0, v_a, v_a_doc, 'ciro_share', 'standard', 3000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_af, 0, v_a, NULL, 'fixed_monthly', NULL, NULL, 1000000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_r, 0, v_r, NULL, 'fixed_monthly', NULL, NULL, 3000000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    v_j := public.fin_hk_save_rule(v_rule_s, 0, v_s, NULL, 'fixed_monthly', NULL, NULL, 2500000,
                                   0, 0, 0, 0, DATE '2024-01-15', NULL, '');
    IF (v_j #>> '{record,kind}') IS DISTINCT FROM 'fixed_monthly'
       OR (v_j #>> '{record,piece_cents}')::bigint IS DISTINCT FROM 2500000
       OR (v_j #>> '{record,from_month}') IS DISTINCT FROM '2024-01-01'
       OR (v_j #> '{record,doctor_id}') IS DISTINCT FROM 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'sabit maaş kuralı: ' || left(v_j::text, 300));
    END IF;
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_r, NULL, 'fixed_monthly', NULL, NULL, 100,
                                      0, 0, 0, 0, DATE '2024-06-01', NULL, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM 'PT409' THEN
      v_fail := array_append(v_fail, 'aynı kişiye çakışan sabit maaş: ' || coalesce(v_state, '-'));
    END IF;
    FOREACH v_sql IN ARRAY ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''fixed_monthly'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2024-01-01'', NULL, '''')', v_t, v_b_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''fixed_monthly'', NULL, 2500, 100, '
             '0, 0, 0, 0, DATE ''2024-01-01'', NULL, '''')', v_t),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''fixed_monthly'', NULL, NULL, 100, '
             '0, 100, 0, 0, DATE ''2024-01-01'', NULL, '''')', v_t),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''fixed_monthly'', NULL, NULL, NULL, '
             '0, 0, 0, 0, DATE ''2024-01-01'', NULL, '''')', v_t),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''fixed_monthly'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2024-01-01'', NULL, '''')', v_x),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''ciro_share'', ''standard'', 2000, NULL, '
             '0, 0, 0, 0, DATE ''2025-01-01'', NULL, '''')', v_r, v_b_doc)]
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS NULL OR v_err NOT IN ('Sabit aylık maaş kuralında hekim seçilmez.',
                                        'Sabit aylık maaş kuralında pay oranı girilmez.',
                                        'Kesinti oranları yalnızca ciro payı ve ortodonti kurallarında girilir.',
                                        'Aylık net maaş 0,01 TL ile 10.000.000.000 TL arasında olmalı.',
                                        'Pasif personel seçilemez.',
                                        'Hakediş yalnızca hekimlere ve klinik sahibine tanımlanabilir.') THEN
        v_fail := array_append(v_fail, 'kural doğrulaması: ' || v_sql || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- The reception user R ('hakedis_prepare'): reference without ledger data, data entry, voids, adjustments.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_reference();
    IF NOT coalesce((v_j ->> 'can_prepare')::boolean, false)
       OR coalesce((v_j ->> 'ledger_visible')::boolean, true)
       OR coalesce((v_j ->> 'can_write')::boolean, true)
       OR jsonb_array_length(v_j -> 'rules') <> 5
       OR jsonb_array_length(v_j -> 'payees') <> 9
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'user_id') = v_r::text AND (p -> 'doctor_id') = 'null'::jsonb
                        AND (p ->> 'role') = 'reception') THEN
      v_fail := array_append(v_fail, 'hazırlayıcı referans: ' || left(v_j::text, 500));
    END IF;

    PERFORM public.fin_hk_save_line(v_l1, 0, DATE '2024-01-10', v_b_doc, 'Hasta Bir', NULL, 'cash', 'TRY',
                                    100000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(v_l2, 0, DATE '2024-01-11', v_a_doc, 'Hasta İki', NULL, 'cash', 'TRY',
                                    200000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(v_l3, 0, DATE '2024-01-15', v_b_doc, 'Hasta Bir', NULL, 'cash', 'TRY',
                                    5000, NULL, NULL, NULL, 'yanlış');
    PERFORM public.fin_hk_void_line(v_l3, 1, 'yanlış giriş');
    PERFORM public.fin_hk_save_piece(v_pc, 0, DATE '2024-01-12', v_a_doc, 'Hasta İki', NULL, 1, '');
    PERFORM public.fin_hk_void_piece(v_pc, 1, 'yanlış giriş');
    PERFORM public.fin_hk_save_lab_cost(v_lc, 0, DATE '2024-01-12', v_a_doc, 'Hasta İki', NULL, 'Lab Bir', 5000, '');
    PERFORM public.fin_hk_void_lab_cost(v_lc, 1, 'yanlış giriş');
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Üç', NULL, true, 'banko notu', NULL);
    IF jsonb_array_length(public.fin_hk_marks()) <> 1 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı işaret listesi');
    END IF;

    PERFORM public.fin_hk_save_adjustment(v_adj_r, 0, DATE '2024-01-20', v_r, 'bonus', 200000, 'Ocak primi');
    PERFORM public.fin_hk_save_adjustment(v_adj_a, 0, DATE '2024-01-01', v_a, 'bonus', 50000, 'Ek prim');
    PERFORM public.fin_hk_save_adjustment(v_adj_t, 0, DATE '2024-01-01', v_t, 'bonus', 30000, 'Tek seferlik prim');
    v_j := public.fin_hk_save_adjustment(v_adj_r, 0, DATE '2024-01-20', v_r, 'bonus', 200000, 'Ocak primi');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false)
       OR (v_j #>> '{record,month}') IS DISTINCT FROM '2024-01-01'
       OR (v_j #>> '{record,payee_name}') IS DISTINCT FROM 'Öz denetim Banko'
       OR (v_j #>> '{record,version}')::integer IS DISTINCT FROM 1 THEN
      v_fail := array_append(v_fail, 'prim tekrar deneme: ' || left(v_j::text, 300));
    END IF;
    FOREACH v_sql IN ARRAY ARRAY[
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, %L, %L, ''bonus'', 100, ''x'')',
             public.clinic_today() + 40, v_r),
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE ''2024-01-01'', %L, ''bonus'', 100, '
             '''  '')', v_r),
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE ''2024-01-01'', %L, ''bonus'', 0, '
             '''x'')', v_r),
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE ''2024-01-01'', %L, ''prim'', 100, '
             '''x'')', v_r),
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE ''2024-01-01'', %L, ''bonus'', 100, '
             '''x'')', v_x)]
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS NULL OR v_err NOT IN ('Gelecek aylar için prim / kesinti girilemez.',
                                        'Açıklama boş olamaz ve en fazla 500 karakter olabilir.',
                                        'Tutar 0 olamaz ve en fazla 10.000.000.000 TL olabilir.',
                                        'Geçersiz tür.',
                                        'Pasif personel seçilemez.') THEN
        v_fail := array_append(v_fail, 'prim doğrulaması: ' || v_sql || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- R: no rules, settings, close, reopen, nor any other finance RPC.
    FOREACH v_sql IN ARRAY ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''fixed_monthly'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_r),
      'SELECT public.fin_hk_save_settings(1, 13)',
      'SELECT public.fin_hk_close_month(DATE ''2024-01-01'', 0, true)',
      'SELECT public.fin_hk_reopen_month(DATE ''2024-01-01'', 1)',
      'SELECT public.fin_list(''{}''::jsonb, ''{}''::jsonb)',
      'SELECT public.fin_reference_data()',
      'SELECT public.fin_audit_list(''{}''::jsonb, ''{}''::jsonb)',
      'SELECT public.fin_export_manifest()',
      format('SELECT public.fin_cancel_entry(%L, 1, ''öz denetim'')', gen_random_uuid())]
    LOOP
      v_state := NULL;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      END;
      IF v_state IS DISTINCT FROM '42501' THEN
        v_fail := array_append(v_fail, 'hazırlayıcı finans çağrısı: ' || v_sql || ' / ' || coalesce(v_state, '-'));
      END IF;
    END LOOP;

    -- January as R: every payee's figures (B 25 % of 100000 = 25000; A 30 % of 200000 + salary 1000000 + bonus 50000
    -- = 1110000; R 3000000 + 200000; S 2500000; T bonus only 30000), the adjustments, no counterparty / warnings.
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 300000
       OR coalesce((v_j ->> 'ledger_visible')::boolean, true)
       OR NOT coalesce((v_j ->> 'can_prepare')::boolean, false)
       OR jsonb_array_length(v_j -> 'payees') <> 5
       OR jsonb_array_length(v_j -> 'warnings') <> 0
       OR jsonb_array_length(v_j -> 'adjustments') <> 3
       OR position('counterparty_id' IN v_j::text) > 0
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_b::text) IS DISTINCT FROM 25000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_a::text) IS DISTINCT FROM 1110000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_r::text) IS DISTINCT FROM 3200000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_s::text) IS DISTINCT FROM 2500000
       OR (SELECT p -> 'components' FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_t::text)
          IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
            'kind', 'adjustments', 'amount_cents', 30000, 'items', jsonb_build_array(jsonb_build_object(
              'id', v_adj_t, 'kind', 'bonus', 'amount_cents', 30000, 'description', 'Tek seferlik prim'))))
       OR (SELECT string_agg(c ->> 'kind', ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'payees') p
           CROSS JOIN LATERAL jsonb_array_elements(p -> 'components') WITH ORDINALITY AS x(c, o)
           WHERE (p ->> 'payee_user_id') = v_a::text) IS DISTINCT FROM 'ciro_share,fixed_monthly,adjustments'
       OR (SELECT (c ->> 'amount_cents')::bigint
           FROM jsonb_array_elements(v_j -> 'payees') p
           CROSS JOIN LATERAL jsonb_array_elements(p -> 'components') c
           WHERE (c ->> 'rule_id') = v_rule_af::text) IS DISTINCT FROM 1000000 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı ocak: ' || left(v_j::text, 900));
    END IF;

    -- The owner sees the counterparty state: every payee still lacks one ('missing', never 'no_doctor' for staff).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF NOT coalesce((v_j ->> 'ledger_visible')::boolean, false)
       OR (SELECT count(*) FROM jsonb_array_elements(v_j -> 'warnings') w
           WHERE (w ->> 'code') = 'NO_COUNTERPARTY' AND (w ->> 'reason') = 'missing') <> 5 THEN
      v_fail := array_append(v_fail, 'sahip ocak uyarıları: ' || left((v_j -> 'warnings')::text, 500));
    END IF;

    -- Close: refused while a supplier counterparty carries T's name (rolled back, S not linked either); after the
    -- rename, staff entries in the personnel bucket, doctor entitlements as in 0030.
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-01-01', 0, false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM '"Öz denetim Asistan T" adlı başka bir cari kaydı var. Cariler ekranında o kaydın adını değiştirin, sonra ayı kapatın.'
       OR EXISTS (SELECT 1 FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.staff_user_id IS NOT NULL)
    THEN
      v_fail := array_append(v_fail, 'ad çakışmasıyla kapatma: ' || coalesce(v_err, '-'));
    END IF;
    UPDATE public.fin_counterparties cp SET name = 'Öz denetim Tedarikçi' WHERE cp.clinic_id = v_clinic AND cp.id = v_cp_t;

    v_j := public.fin_hk_close_month(DATE '2024-01-01', 0, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed' OR jsonb_array_length(v_j -> 'statements') <> 5
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_r::text AND (st #>> '{entry,paid_cents}')::bigint = 0
                        AND (st #>> '{entry,amount_cents}')::bigint = 3200000) THEN
      v_fail := array_append(v_fail, 'ocak kapatma: ' || left(v_j::text, 500));
    END IF;
    SELECT cp.id INTO v_cp_r
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_r AND cp.kind = 'staff' AND cp.is_active
      AND cp.name = 'Öz denetim Banko' AND cp.note = 'Maaş için otomatik oluşturuldu';
    SELECT e.id INTO v_entry_r
    FROM public.fin_entries e
    JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
    JOIN public.fin_hk_statements s ON s.clinic_id = e.clinic_id AND s.fin_entry_id = e.id
    WHERE e.clinic_id = v_clinic
      AND e.source_key = 'payroll:' || v_cp_r::text || ':2024-01'
      AND e.counterparty_id = v_cp_r
      AND c.report_bucket = 'personnel' AND c.is_system
      AND e.amount_cents = 3200000 AND e.subcategory IS NULL AND e.entitlement_month IS NULL
      AND e.due_date = DATE '2024-01-01' AND e.cancelled_at IS NULL
      AND e.description = 'DentOS maaş 2024-01: sabit maaş 30.000,00 TL; prim 2.000,00 TL'
      AND s.payee_user_id = v_r AND s.superseded_at IS NULL AND s.total_cents = 3200000;
    IF v_entry_r IS NULL THEN
      v_fail := array_append(v_fail, 'banko maaş kaydı');
    END IF;
    SELECT count(*) INTO v_n
    FROM public.fin_entries e
    JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
    WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
      AND ((e.source_key = 'payroll:' || v_cp_s::text || ':2024-01' AND c.report_bucket = 'personnel'
            AND e.amount_cents = 2500000 AND e.description = 'DentOS maaş 2024-01: sabit maaş 25.000,00 TL')
           OR (e.source_key = 'payroll:' || (SELECT cp.id FROM public.fin_counterparties cp
                                               WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_t
                                                 AND cp.kind = 'staff' AND cp.name = 'Öz denetim Asistan T')::text
                              || ':2024-01'
               AND c.report_bucket = 'personnel' AND e.amount_cents = 30000
               AND e.description = 'DentOS maaş 2024-01: prim 300,00 TL')
           OR (e.source_key = 'entitlement:' || (SELECT cp.id FROM public.fin_counterparties cp
                                                   WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_a_doc)::text
                              || ':2024-01'
               AND c.report_bucket = 'doctor' AND e.entitlement_month = DATE '2024-01-01'
               AND e.amount_cents = 1110000
               AND e.description = 'DentOS hakediş 2024-01: ciro payı (standart) %30 × 2.000,00 TL = 600,00 TL; '
                                   || 'sabit maaş 10.000,00 TL; prim 500,00 TL')
           OR (e.source_key = 'entitlement:' || (SELECT cp.id FROM public.fin_counterparties cp
                                                   WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_b_doc)::text
                              || ':2024-01'
               AND c.report_bucket = 'doctor' AND e.amount_cents = 25000
               AND e.description = 'DentOS hakediş 2024-01: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL'));
    IF v_n <> 4
       OR NOT EXISTS (SELECT 1 FROM public.fin_counterparties cp
                      WHERE cp.clinic_id = v_clinic AND cp.id = v_cp_s AND cp.staff_user_id = v_s)
       OR (SELECT count(*) FROM public.fin_counterparties cp
           WHERE cp.clinic_id = v_clinic AND cp.staff_user_id IS NOT NULL) <> 3 THEN
      v_fail := array_append(v_fail, 'ocak kayıtları ' || v_n);
    END IF;

    -- A payroll entry keeps its person and category (fin_payroll_entry_guard): S's January entry (nothing paid, so
    -- the 0020 paid-category rule does not answer first) cannot move to another category or counterparty; its
    -- description and due date can change (the next close rewrites the description).
    SELECT e.id, e.version, e.category_id INTO v_entry_s, v_ver_e, v_cat_pers
    FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND e.source_key = 'payroll:' || v_cp_s::text || ':2024-01';
    SELECT c.id INTO v_cat_other
    FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.report_bucket = 'other_expense' AND c.is_active
    ORDER BY c.sort_order, c.id
    LIMIT 1;
    IF v_entry_s IS NULL OR v_cat_other IS NULL THEN
      v_fail := array_append(v_fail, 'S ocak maaş kaydı / diğer gider kategorisi yok');
    ELSE
      FOREACH v_sql IN ARRAY ARRAY[
        format('SELECT public.fin_edit_entry(%L, %s, %L, NULL, %L, NULL, ''Öz denetim'', DATE ''2024-01-01'', 2500000, '
               'NULL)', v_entry_s, v_ver_e, v_cat_other, v_cp_s),
        format('SELECT public.fin_edit_entry(%L, %s, %L, NULL, %L, NULL, ''Öz denetim'', DATE ''2024-01-01'', 2500000, '
               'NULL)', v_entry_s, v_ver_e, v_cat_pers, v_cp_t)]
      LOOP
        v_err := NULL;
        BEGIN
          EXECUTE v_sql;
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        END;
        IF v_err IS DISTINCT FROM 'Maaş kaydının kişisi ve kategorisi değiştirilemez.' THEN
          v_fail := array_append(v_fail, 'maaş kaydı taşındı: ' || v_sql || ' / ' || coalesce(v_err, '-'));
        END IF;
      END LOOP;
      PERFORM public.fin_edit_entry(v_entry_s, v_ver_e, v_cat_pers, NULL, v_cp_s, NULL, 'Öz denetim açıklama',
                                    DATE '2024-01-25', 2500000, NULL);
      IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                     WHERE e.id = v_entry_s AND e.category_id = v_cat_pers AND e.counterparty_id = v_cp_s
                       AND e.description = 'Öz denetim açıklama' AND e.due_date = DATE '2024-01-25'
                       AND e.version = v_ver_e + 1) THEN
        v_fail := array_append(v_fail, 'maaş kaydının açıklaması / vadesi düzeltilemedi');
      END IF;
    END IF;

    -- R after the close: statements without their ledger entry (the entry id link stays), no paid / remaining, no
    -- counterparty; no write into the closed month; the mark lock.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR jsonb_array_length(v_j -> 'statements') <> 5
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                  WHERE jsonb_typeof(st -> 'entry') IS DISTINCT FROM 'null')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_r::text AND (st ->> 'fin_entry_id') = v_entry_r::text)
       OR position('paid_cents' IN v_j::text) > 0
       OR position('outstanding_cents' IN v_j::text) > 0
       OR position('counterparty_id' IN v_j::text) > 0
       OR position(v_cp_r::text IN v_j::text) > 0
       OR position(v_cp_s::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı kapalı ocak: ' || left(v_j::text, 900));
    END IF;
    FOREACH v_sql IN ARRAY ARRAY[
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE ''2024-01-01'', %L, ''bonus'', 100, '
             '''x'')', v_r),
      format('SELECT public.fin_hk_void_adjustment(%L, 1, ''öz denetim'')', v_adj_a),
      format('SELECT public.fin_hk_save_line(gen_random_uuid(), 0, DATE ''2024-01-20'', %L, ''Hasta Bir'', NULL, '
             '''cash'', ''TRY'', 100, NULL, NULL, NULL, '''')', v_b_doc)]
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM 'Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.' THEN
        v_fail := array_append(v_fail, 'hazırlayıcı kapalı aya yazma: ' || v_sql || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Bir', NULL, true, '', NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı işaret kilidi: ' || coalesce(v_err, '-'));
    END IF;
    PERFORM public.fin_hk_save_mark(v_mk, 0, NULL, 'Hasta Bir', NULL, false, 'banko notu', NULL);

    -- Self-service. A: own salary and bonus in the frozen breakdown, own entitlement; B unchanged; R (staff payee):
    -- own payroll figures and entry only.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 1110000
       OR (v_j #>> '{statement,total_cents}')::bigint IS DISTINCT FROM 1110000
       OR (v_j #>> '{entitlement,remaining_cents}')::bigint IS DISTINCT FROM 1110000
       OR (SELECT string_agg(c ->> 'kind', ',' ORDER BY o)
           FROM jsonb_array_elements(v_j #> '{payees,0,components}') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'ciro_share,fixed_monthly,adjustments'
       OR (v_j #>> '{payees,0,components,2,items,0,amount_cents}')::bigint IS DISTINCT FROM 50000
       OR jsonb_array_length(v_j -> 'lines') <> 1
       OR position(v_r::text IN v_j::text) > 0
       OR position(v_b::text IN v_j::text) > 0
       OR position(v_s::text IN v_j::text) > 0
       OR position(v_t::text IN v_j::text) > 0
       OR position('Hasta Bir' IN v_j::text) > 0
       OR position('Ocak primi' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A ocak: ' || left(v_j::text, 800));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_b_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 25000
       OR jsonb_array_length(v_j #> '{payees,0,components}') <> 1
       OR (v_j #>> '{entitlement,remaining_cents}')::bigint IS DISTINCT FROM 25000
       OR position('fixed_monthly' IN v_j::text) > 0
       OR position('adjustments' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim B ocak: ' || left(v_j::text, 800));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR jsonb_array_length(v_j -> 'payees') <> 1
       OR (v_j #>> '{payees,0,payee_user_id}') IS DISTINCT FROM v_r::text
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 3200000
       OR (v_j -> 'entitlement') IS DISTINCT FROM jsonb_build_object('amount_cents', 3200000, 'paid_cents', 0,
                                                                     'remaining_cents', 3200000, 'is_cancelled', false)
       OR jsonb_array_length(v_j -> 'lines') <> 0
       OR position(v_a::text IN v_j::text) > 0
       OR position(v_b::text IN v_j::text) > 0
       OR position(v_s::text IN v_j::text) > 0
       OR position(v_t::text IN v_j::text) > 0
       OR position('Hekim' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'banko kendi ayı: ' || left(v_j::text, 800));
    END IF;
    v_j := public.hk_my_months();
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR (DATE '2024-01-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                           WHERE (m ->> 'month') = '2024-01-01' AND (m ->> 'status') = 'closed'
                             AND (m ->> 'total_cents')::bigint = 3200000 AND (m ->> 'paid_cents')::bigint = 0
                             AND (m ->> 'remaining_cents')::bigint = 3200000)) THEN
      v_fail := array_append(v_fail, 'banko aylar: ' || left(v_j::text, 500));
    END IF;

    -- Re-close with a paid payroll entry: 31000,00 TL paid, R's bonus voided (30000,00 TL < paid) → refused; an
    -- 'other' row of 1000,00 TL → the same entry gets 31000,00 TL.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    SELECT e.version INTO v_ver_e FROM public.fin_entries e WHERE e.id = v_entry_r;
    PERFORM public.fin_record_payment(v_entry_r, v_ver_e, gen_random_uuid(), DATE '2024-02-01', 3100000, v_account);
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    PERFORM public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    PERFORM public.fin_hk_void_adjustment(v_adj_r, (SELECT a.version FROM public.fin_hk_adjustments a
                                                    WHERE a.id = v_adj_r), 'öz denetim');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Öz denetim Banko için bu aya şimdiye kadar 31.000,00 TL ödenmiş; yeni maaş tutarı (30.000,00 TL) bundan az olamaz. Önce fazla ödemeyi düzeltin.' THEN
      v_fail := array_append(v_fail, 'ödenenden az maaş: ' || coalesce(v_err, '-'));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    PERFORM public.fin_hk_save_adjustment(v_adj_r2, 0, DATE '2024-01-01', v_r, 'other', 100000, 'Fark');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_entry_r AND e.amount_cents = 3100000 AND e.cancelled_at IS NULL
                        AND e.description = 'DentOS maaş 2024-01: sabit maaş 30.000,00 TL; diğer 1.000,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.payee_user_id = v_r
                        AND s.superseded_at IS NULL AND s.fin_entry_id = v_entry_r AND s.total_cents = 3100000) THEN
      v_fail := array_append(v_fail, 'ödenmiş maaşla yeniden kapatma: ' || left(v_j::text, 500));
    END IF;

    -- A payee dropping out: T's only bonus voided → refused while T's January entry is live; cancelled → closes
    -- without T.
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    PERFORM public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    PERFORM public.fin_hk_void_adjustment(v_adj_t, (SELECT a.version FROM public.fin_hk_adjustments a
                                                    WHERE a.id = v_adj_t), 'öz denetim');
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'Şu kişiler için bu ayın hakediş kaydı zaten var%Öz denetim Asistan T%' THEN
      v_fail := array_append(v_fail, 'düşen personelle yeniden kapatma: ' || coalesce(v_err, '-'));
    END IF;
    SELECT e.id, e.version INTO v_entry_t, v_ver_e
    FROM public.fin_hk_statements s
    JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
    WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.payee_user_id = v_t
    LIMIT 1;
    IF v_entry_t IS NULL THEN
      v_fail := array_append(v_fail, 'T ocak maaş kaydı yok');
    ELSE
      PERFORM public.fin_cancel_entry(v_entry_t, v_ver_e, 'öz denetim');
    END IF;
    v_j := public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR jsonb_array_length(v_j -> 'statements') <> 4
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                  WHERE (st ->> 'payee_user_id') = v_t::text) THEN
      v_fail := array_append(v_fail, 'iptal sonrası kapatma: ' || left(v_j::text, 500));
    END IF;

    -- A cancelled payroll entry is final: a new bonus of T in January is refused at close.
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    PERFORM public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    PERFORM public.fin_hk_save_adjustment(v_adj_t2, 0, DATE '2024-01-01', v_t, 'bonus', 10000, 'Yeni prim');
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'Öz denetim Asistan T için bu ayın maaş kaydı iptal edilmiş;%' THEN
      v_fail := array_append(v_fail, 'iptal edilmiş maaş kaydı: ' || coalesce(v_err, '-'));
    END IF;
    PERFORM public.fin_hk_void_adjustment(v_adj_t2, 1, 'öz denetim');
    v_j := public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed' OR jsonb_array_length(v_j -> 'statements') <> 4 THEN
      v_fail := array_append(v_fail, 'son kapatma: ' || left(v_j::text, 300));
    END IF;

    -- February (open, no lines): the salaries alone; B's rule gives 0 as in 0030.
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
        WHERE (p ->> 'payee_user_id') = v_a::text) IS DISTINCT FROM 1000000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_b::text) IS DISTINCT FROM 0
       OR (SELECT jsonb_array_length(p -> 'components') FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_b::text) IS DISTINCT FROM 1
       OR (SELECT (p ->> 'counterparty_id') FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_r::text) IS DISTINCT FROM v_cp_r::text
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_t::text) THEN
      v_fail := array_append(v_fail, 'şubat: ' || left(v_j::text, 800));
    END IF;

    -- Reactivation: S (still holding 'hakedis_prepare') deactivated by the owner; the admin F, though a 'finance'
    -- holder, cannot reactivate S (users_guard, through plt_staff_save or a direct UPDATE); the owner can.
    UPDATE public.users SET is_active = false WHERE id = v_s;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_f_auth::text, true);
    FOREACH v_sql IN ARRAY ARRAY[
      format('SELECT public.plt_staff_save(%L, (SELECT u.updated_at FROM public.users u WHERE u.id = %L), '
             '''Öz denetim Asistan S'', ''p31-sc-s-%s@example.invalid'', '''', ''assistant'', true, '''')',
             v_s, v_s, v_tag),
      format('UPDATE public.users SET is_active = true WHERE id = %L', v_s)]
    LOOP
      v_state := NULL;
      v_err := NULL;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
      END;
      IF v_state IS DISTINCT FROM '42501'
         OR v_err IS DISTINCT FROM 'Hakediş ve maaş hazırlama yetkisi olan personeli yalnızca klinik sahibi yeniden aktifleştirebilir.' THEN
        v_fail := array_append(v_fail, 'yönetici hazırlama yetkili personeli aktifleştirdi: ' || v_sql || ' / '
                                       || coalesce(v_state, '-') || ' ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    UPDATE public.users SET is_active = true WHERE id = v_s;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_s AND u.is_active) THEN
      v_fail := array_append(v_fail, 'sahip hazırlama yetkili personeli aktifleştiremedi');
    END IF;

    -- Revocation: S reads while holding 'hakedis_prepare', is refused once the owner revoked it; the owner can
    -- still change the mark the reception lock held.
    PERFORM public.fin_hk_save_mark(v_mk, 1, NULL, 'Hasta Bir', NULL, true, 'banko notu', NULL);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_s_auth::text, true);
    v_j := public.fin_hk_reference();
    IF NOT coalesce((v_j ->> 'can_prepare')::boolean, false) OR coalesce((v_j ->> 'ledger_visible')::boolean, true) THEN
      v_fail := array_append(v_fail, 'S hazırlama yetkisiyle referans: ' || left(v_j::text, 300));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.revoke_staff_permission(v_s, 'hakedis_prepare');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_s_auth::text, true);
    FOREACH v_sql IN ARRAY ARRAY[
      'SELECT public.fin_hk_reference()',
      'SELECT public.fin_hk_month(DATE ''2024-02-01'')',
      format('SELECT public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE ''2024-02-01'', %L, ''bonus'', 100, '
             '''x'')', v_s)]
    LOOP
      v_state := NULL;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      END;
      IF v_state IS DISTINCT FROM '42501' THEN
        v_fail := array_append(v_fail, 'kaldırılan yetki: ' || v_sql || ' / ' || coalesce(v_state, '-'));
      END IF;
    END LOOP;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v1.2): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p31_selfcheck_rollback';
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

-- Make the API see the new table and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
