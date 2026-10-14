-- Phase 0 security hardening. Safe to re-run.
--
--  1. current_clinic_id() / current_app_role() return NULL for inactive staff; new current_app_user_id().
--  2. staff_permissions table (read-only for clinic staff, written only through RPCs) with
--     has_permission(), my_permissions(), grant_staff_permission(), revoke_staff_permission().
--  3. clinic_today(): today's date in Europe/Istanbul.
--  4. users_guard trigger: clients cannot relink accounts, move clinics, change their own role/status,
--     write an owner row unless they are an active owner, reactivate a finance holder without 'finance'
--     (owner excepted), or deactivate the clinic's last active finance holder. Anonymous requests are refused.
--  5. Drops the cross-tenant clinics_owner_admin_see_all policy.
--  6. audit_logs: before_data/after_data, written only by the audit_row_change trigger on users,
--     staff_permissions, payments and treatment_plans; readable by owner/admin only, and payments rows
--     only by the owner or finance/finance_readonly holders.
--  7. payments: amount must be > 0; UPDATE limited to the owner or finance holders; anyone else may only
--     INSERT a 'paid' payment, dated by the server clock.
--  8. appointments: DELETE policy dropped (the app only cancels).
--  9. payments.treatment_plan_id, payments.patient_id, treatment_plans.doctor_id, doctors.user_id
--     become ON DELETE RESTRICT so deleting a parent can no longer wipe financial or clinical rows.
-- 10. patient_access_logs INSERT compares accessed_by_user_id to the caller's users.id, not auth.uid().
-- 11. EXECUTE on every function here is revoked from PUBLIC/anon and granted to authenticated.
-- 12. The clinic owner receives 'finance' once.
--
-- Not covered yet (Phase 1): payments SELECT and treatment_plans.total_cost are still open to all clinic staff.
-- Staff and patients are deactivated, never hard-deleted: the RESTRICT keys above and staff_permissions.user_id
-- make such deletes fail once payments, plans, doctor rows or permission history point at the row.

BEGIN;

-- The audit trigger writes into the live audit_logs table; stop here if its shape is not the one 0010 created,
-- otherwise every audited write would fail at runtime.
DO $$
DECLARE
  v_problem text;
BEGIN
  SELECT string_agg(format('%s (%s beklenirken %s)', e.col, e.typ, coalesce(c.data_type::text, 'yok')), ', ')
    INTO v_problem
  FROM (VALUES
    ('clinic_id', 'uuid'),
    ('user_id', 'uuid'),
    ('entity_type', 'text'),
    ('entity_id', 'uuid'),
    ('action', 'text'),
    ('changes', 'jsonb')
  ) AS e(col, typ)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'audit_logs' AND c.column_name::text = e.col
  WHERE c.data_type::text IS DISTINCT FROM e.typ;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs beklenen yapıda değil: %', v_problem;
  END IF;

  SELECT string_agg(column_name::text, ', ')
    INTO v_problem
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'audit_logs'
    AND is_nullable = 'NO'
    AND column_default IS NULL
    AND is_identity = 'NO'
    AND is_generated = 'NEVER'
    AND column_name NOT IN ('clinic_id', 'entity_type', 'entity_id', 'action');

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs tetikleyicinin doldurmadığı zorunlu sütunlar içeriyor: %', v_problem;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Identity helpers: a deactivated staff member resolves to no clinic and no role, so every policy denies them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT clinic_id FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1
$$;

-- users.id of the caller; FK columns pointing at users must compare to this, never to auth.uid().
CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- 3. Clinic-local date, so "today" does not flip at 03:00 Istanbul time when the server runs in UTC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clinic_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE 'Europe/Istanbul')::date
$$;

-- ---------------------------------------------------------------------------
-- 2. Staff permissions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (permission IN (
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical'
  )),
  granted_by uuid REFERENCES public.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id)
);

-- Revoked rows stay as history; only one active grant per user and permission.
CREATE UNIQUE INDEX IF NOT EXISTS staff_permissions_active_user_permission_key
  ON public.staff_permissions (user_id, permission)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_permissions_clinic_id ON public.staff_permissions (clinic_id);

ALTER TABLE public.staff_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_permissions_clinic_isolation" ON public.staff_permissions;
CREATE POLICY "staff_permissions_clinic_isolation" ON public.staff_permissions
  FOR SELECT USING (clinic_id = public.current_clinic_id());

-- No write policies: grants and revokes go through the RPCs below. Table privileges are trimmed as well.
REVOKE ALL ON public.staff_permissions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.staff_permissions FROM authenticated;
GRANT SELECT ON public.staff_permissions TO authenticated;

CREATE OR REPLACE FUNCTION public.has_permission(p text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.staff_permissions sp ON sp.user_id = u.id AND sp.clinic_id = u.clinic_id
    WHERE u.auth_user_id = auth.uid()
      AND u.is_active = true
      AND sp.permission = p
      AND sp.revoked_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.my_permissions()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sp.permission
  FROM public.users u
  JOIN public.staff_permissions sp ON sp.user_id = u.id AND sp.clinic_id = u.clinic_id
  WHERE u.auth_user_id = auth.uid()
    AND u.is_active = true
    AND sp.revoked_at IS NULL
  ORDER BY sp.permission
$$;

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
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical'
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
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical'
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

-- ---------------------------------------------------------------------------
-- 4. users hardening. Only the SQL editor / dashboard (no JWT claims, no API role) and the service role are
--    not restricted; an anonymous API request is refused outright.
--    Works together with users_insert_own_clinic / users_update_owner_admin (owner/admin only).
-- ---------------------------------------------------------------------------
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

DROP TRIGGER IF EXISTS users_guard ON public.users;
CREATE TRIGGER users_guard
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_guard();

-- ---------------------------------------------------------------------------
-- 5. clinics: owner/admin of one clinic could read every clinic.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "clinics_owner_admin_see_all" ON public.clinics;

-- ---------------------------------------------------------------------------
-- 6. Audit log: written only by the trigger, read only by owner/admin; the payment history (before/after
--    amounts) only by the owner or a finance/finance_readonly holder.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS before_data jsonb,
  ADD COLUMN IF NOT EXISTS after_data jsonb;

DROP POLICY IF EXISTS "audit_logs_insert_own_clinic" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_clinic_isolation" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_select_owner_admin" ON public.audit_logs;
CREATE POLICY "audit_logs_select_owner_admin" ON public.audit_logs
  FOR SELECT USING (
    clinic_id = public.current_clinic_id()
    AND public.current_app_role() IN ('owner', 'admin')
    AND (
      entity_type <> 'payments'
      OR public.current_app_role() = 'owner'
      OR public.has_permission('finance')
      OR public.has_permission('finance_readonly')
    )
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_changes jsonb;
  v_clinic_id uuid;
  v_actor uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_before := to_jsonb(OLD);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_after := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF v_before = v_after THEN
      RETURN NULL;
    END IF;
    -- changes keeps only the columns that moved, with their new values.
    SELECT jsonb_object_agg(a.key, a.value)
      INTO v_changes
    FROM jsonb_each(v_after) AS a
    WHERE v_before -> a.key IS DISTINCT FROM a.value;
  END IF;

  v_row := coalesce(v_after, v_before);
  v_clinic_id := (v_row ->> 'clinic_id')::uuid;

  -- A clinic delete cascades into these tables; an audit row for a vanished clinic would fail its FK.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.clinics WHERE id = v_clinic_id) THEN
    RETURN NULL;
  END IF;

  -- NULL for SQL editor / service role writes.
  SELECT id INTO v_actor FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;

  INSERT INTO public.audit_logs (clinic_id, user_id, entity_type, entity_id, action, changes, before_data, after_data)
  VALUES (
    v_clinic_id,
    v_actor,
    TG_TABLE_NAME,
    (v_row ->> 'id')::uuid,
    CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
    v_changes,
    v_before,
    v_after
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_row_change ON public.users;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_row_change ON public.staff_permissions;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.staff_permissions
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_row_change ON public.payments;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_row_change ON public.treatment_plans;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.treatment_plans
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

-- ---------------------------------------------------------------------------
-- 7. payments: any staff member may record money taken now, only the owner or a finance holder may record
--    any other payment or change one. There is no DELETE policy.
-- ---------------------------------------------------------------------------

-- A zero or negative row would silently cancel out real takings. NOT VALID first, so an old bad row cannot
-- abort this migration; existing rows are validated only when none break the rule.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_amount_positive'
  ) THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;

  SELECT count(*) INTO v_bad FROM public.payments WHERE amount <= 0;
  IF v_bad > 0 THEN
    RAISE NOTICE 'payments: % satırda tutar 0 veya negatif; payments_amount_positive şimdilik yalnızca yeni ve değişen satırlara uygulanıyor.', v_bad;
  ELSE
    ALTER TABLE public.payments VALIDATE CONSTRAINT payments_amount_positive;
  END IF;
END $$;

-- Without 'finance' (and not the owner) a payment can only be one taken at the desk right now: status 'paid'
-- and paid_at set by the server clock, so it cannot be back-dated into a closed month or entered as
-- pending/cancelled. The client's paid_at is replaced rather than rejected, so a skewed PC clock is harmless.
CREATE OR REPLACE FUNCTION public.payments_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- SQL editor / service role; an anonymous request is refused by the RLS policy afterwards.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.current_app_role() = 'owner' OR public.has_permission('finance') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'Finans yetkisi olmadan yalnızca tahsil edilmiş (ödendi) ödeme kaydedilebilir.';
  END IF;
  NEW.paid_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_insert_guard ON public.payments;
CREATE TRIGGER payments_insert_guard
  BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payments_insert_guard();

DROP POLICY IF EXISTS "payments_update_own_clinic" ON public.payments;
DROP POLICY IF EXISTS "payments_update_owner_finance" ON public.payments;
CREATE POLICY "payments_update_owner_finance" ON public.payments
  FOR UPDATE
  USING (
    clinic_id = public.current_clinic_id()
    AND (public.current_app_role() = 'owner' OR public.has_permission('finance'))
  )
  WITH CHECK (
    clinic_id = public.current_clinic_id()
    AND (public.current_app_role() = 'owner' OR public.has_permission('finance'))
  );

-- ---------------------------------------------------------------------------
-- 8. appointments: the app cancels instead of deleting.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "appointments_delete_own_clinic" ON public.appointments;

-- ---------------------------------------------------------------------------
-- 9. Deleting a plan, patient, doctor or user must fail while payments/plans/doctor rows still point at it.
--    Re-created under the same name only when the live rule is not already RESTRICT.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('payments', 'payments_treatment_plan_id_fkey', 'treatment_plan_id', 'treatment_plans'),
      ('payments', 'payments_patient_id_fkey', 'patient_id', 'patients'),
      ('treatment_plans', 'treatment_plans_doctor_id_fkey', 'doctor_id', 'doctors'),
      ('doctors', 'doctors_user_id_fkey', 'user_id', 'users')
    ) AS t(tbl, conname, col, ref)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = format('public.%I', fk.tbl)::regclass
        AND c.conname = fk.conname
        AND c.contype = 'f'
        AND c.confdeltype = 'r'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', fk.tbl, fk.conname);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE RESTRICT',
        fk.tbl, fk.conname, fk.col, fk.ref
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 10. patient_access_logs: accessed_by_user_id references users.id, so auth.uid() never matched.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "access_logs_insert_own_clinic" ON public.patient_access_logs;
CREATE POLICY "access_logs_insert_own_clinic" ON public.patient_access_logs
  FOR INSERT WITH CHECK (
    clinic_id = public.current_clinic_id()
    AND accessed_by_user_id = public.current_app_user_id()
  );

-- ---------------------------------------------------------------------------
-- 11. Function privileges. anon loses the RLS helpers too, so logged-out requests error instead of probing.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.current_clinic_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_app_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_app_user_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.clinic_today() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_permission(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_permissions() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.grant_staff_permission(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_staff_permission(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.users_guard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.audit_row_change() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.payments_insert_guard() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.current_clinic_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.clinic_today() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_permissions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_staff_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.users_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_row_change() TO authenticated;
GRANT EXECUTE ON FUNCTION public.payments_insert_guard() TO authenticated;

-- ---------------------------------------------------------------------------
-- 12. The owner starts as the finance holder. Skipped once any finance row (even a revoked one) exists,
--     so a re-run never undoes a deliberate revoke.
-- ---------------------------------------------------------------------------
INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by)
SELECT u.clinic_id, u.id, 'finance', u.id
FROM public.users u
WHERE u.role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = u.id AND sp.permission = 'finance'
  )
ON CONFLICT (user_id, permission) WHERE revoked_at IS NULL DO NOTHING;

-- Make the API see the new table and functions now instead of whenever the schema cache next refreshes.
-- Delivered at COMMIT, so nothing is reloaded if the migration rolls back.
NOTIFY pgrst, 'reload schema';

COMMIT;
