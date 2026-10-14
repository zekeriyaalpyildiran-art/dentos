-- Phase 1: finance ledger core (Finans defteri). Safe to re-run.
--
-- Contract: spec_parts p1.md (conventions, error texts), p2_db_contract.md (schema, RPCs, seeds),
-- p3_formulas_acceptance.md (formulas). Requires 0019_phase0_security.sql.
--
--  1. Helpers: fin__tr_lower / fin__normalize_name (Turkish case folding), fin__require_read / fin__require_write
--     (session + 'finance' / 'finance_readonly' gate), fin_can_read (RLS), input validators.
--  2. Nine tables: fin_accounts, fin_settings, fin_report_groups, fin_categories, fin_counterparties, fin_entries,
--     fin_payments, fin_balance_snapshots, fin_balance_sources. Integer cents (bigint), TRY only, client-supplied
--     uuids, version column bumped only by the fin_touch trigger. clinic_id is ON DELETE RESTRICT and every child
--     references (clinic_id, parent_id), so a row can never point into another clinic.
--  3. Guard triggers: nothing is ever deleted or truncated (cancel / void instead), immutable keys, subcategory and
--     entitlement rules, payment date <= clinic_today(), paid <= amount, balance snapshot = sum of its sources,
--     every new clinic is seeded.
--  4. RLS: SELECT only, for 'finance' / 'finance_readonly' holders of the caller's clinic. Role alone (even owner)
--     gives nothing. All write privileges are revoked; every write goes through a SECURITY DEFINER RPC.
--  5. audit_row_change() on all nine tables. The audit_logs SELECT policy shows fin_* rows only to finance holders;
--     every other entity keeps the 0019 rule (payments rows only for the owner or finance holders).
--  6. RPCs fin_* (SECURITY DEFINER, search_path = public, clinic taken from the session, never from the client).
--     Formulas live in internal fin__*(p_clinic, p_today, ...) functions so they can be replayed with a fixed date.
--  7. Seeds per clinic: 14 system categories, accounts Banka / Nakit / POS / Karma (inactive), report group
--     'Laboratuvar', settings defaults. No person or company names.
--  8. EXECUTE on fin_* is revoked from PUBLIC/anon/authenticated; public RPCs (single underscore) are granted to
--     authenticated, internal fin__* helpers never are. Internal helpers that are not trigger functions are
--     SECURITY INVOKER on purpose (fail closed): called from a fin_* RPC they run as its owner exactly as before,
--     but if a later migration ever re-exposes one (a new overload or DROP + CREATE gets PostgreSQL's default
--     PUBLIC EXECUTE back), it runs as the caller and RLS limits it to the caller's own clinic and permission.
--     Every later migration that creates or changes a fin_* function must end with
--     SELECT public.fin__harden_privileges(); (revoke / grant loop + self-checks, §2.6).
--
-- Error contract (p1 §1.1): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). The UI shows error.message verbatim.

BEGIN;

-- ---------------------------------------------------------------------------
-- 2.0 Preflight: Phase 0 must be live, the existing tables must have the columns used here, the Turkish ICU
--     collation must exist, and any fin_* table left by an earlier run must already have the shape created below
--     (CREATE TABLE IF NOT EXISTS would otherwise skip an old shape silently).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'my_permissions', 'audit_row_change']) AS f(fn)
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

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('audit_logs', 'id'), ('audit_logs', 'clinic_id'), ('audit_logs', 'user_id'), ('audit_logs', 'entity_type'),
    ('audit_logs', 'entity_id'), ('audit_logs', 'action'), ('audit_logs', 'changes'), ('audit_logs', 'before_data'),
    ('audit_logs', 'after_data'), ('audit_logs', 'created_at'),
    ('clinics', 'id'), ('clinics', 'name'),
    ('users', 'id'), ('users', 'clinic_id'), ('users', 'auth_user_id'), ('users', 'role'), ('users', 'full_name'),
    ('users', 'is_active'),
    ('doctors', 'id'), ('doctors', 'clinic_id'), ('doctors', 'user_id')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı (önce 0019 uygulanmalı): %', v_missing;
  END IF;

  -- Cariler and reference lists are sorted with Turkish collation (legacy FM:82 localeCompare(...,'tr')).
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_accounts', 'id'), ('fin_accounts', 'clinic_id'), ('fin_accounts', 'name'), ('fin_accounts', 'kind'),
    ('fin_accounts', 'bank_name'), ('fin_accounts', 'import_key'), ('fin_accounts', 'is_active'),
    ('fin_accounts', 'sort_order'), ('fin_accounts', 'version'), ('fin_accounts', 'created_by'),
    ('fin_accounts', 'created_at'), ('fin_accounts', 'updated_by'), ('fin_accounts', 'updated_at'),
    ('fin_settings', 'id'), ('fin_settings', 'clinic_id'), ('fin_settings', 'buffer_target_cents'),
    ('fin_settings', 'forecast_days'), ('fin_settings', 'physician_fee_note'), ('fin_settings', 'report_brand_name'),
    ('fin_settings', 'entitlement_account_id'), ('fin_settings', 'version'), ('fin_settings', 'created_by'),
    ('fin_settings', 'created_at'), ('fin_settings', 'updated_by'), ('fin_settings', 'updated_at'),
    ('fin_report_groups', 'id'), ('fin_report_groups', 'clinic_id'), ('fin_report_groups', 'name'),
    ('fin_report_groups', 'is_active'), ('fin_report_groups', 'sort_order'), ('fin_report_groups', 'version'),
    ('fin_report_groups', 'created_by'), ('fin_report_groups', 'created_at'), ('fin_report_groups', 'updated_by'),
    ('fin_report_groups', 'updated_at'),
    ('fin_categories', 'id'), ('fin_categories', 'clinic_id'), ('fin_categories', 'name'),
    ('fin_categories', 'direction'), ('fin_categories', 'profit_class'), ('fin_categories', 'report_bucket'),
    ('fin_categories', 'report_group_id'), ('fin_categories', 'is_system'), ('fin_categories', 'is_active'),
    ('fin_categories', 'sort_order'), ('fin_categories', 'version'), ('fin_categories', 'created_by'),
    ('fin_categories', 'created_at'), ('fin_categories', 'updated_by'), ('fin_categories', 'updated_at'),
    ('fin_counterparties', 'id'), ('fin_counterparties', 'clinic_id'), ('fin_counterparties', 'name'),
    ('fin_counterparties', 'normalized_name'), ('fin_counterparties', 'kind'), ('fin_counterparties', 'doctor_id'),
    ('fin_counterparties', 'report_group_id'), ('fin_counterparties', 'note'), ('fin_counterparties', 'is_active'),
    ('fin_counterparties', 'version'), ('fin_counterparties', 'created_by'), ('fin_counterparties', 'created_at'),
    ('fin_counterparties', 'updated_by'), ('fin_counterparties', 'updated_at'),
    ('fin_entries', 'id'), ('fin_entries', 'clinic_id'), ('fin_entries', 'category_id'), ('fin_entries', 'subcategory'),
    ('fin_entries', 'counterparty_id'), ('fin_entries', 'counterparty_text'), ('fin_entries', 'description'),
    ('fin_entries', 'due_date'), ('fin_entries', 'amount_cents'), ('fin_entries', 'currency'),
    ('fin_entries', 'entitlement_month'), ('fin_entries', 'cancelled_at'), ('fin_entries', 'cancelled_by'),
    ('fin_entries', 'cancel_reason'), ('fin_entries', 'excluded_from_totals'), ('fin_entries', 'exclusion_reason'),
    ('fin_entries', 'excluded_at'), ('fin_entries', 'excluded_by'), ('fin_entries', 'source_key'),
    ('fin_entries', 'source_fingerprint'), ('fin_entries', 'source_file'), ('fin_entries', 'legacy_id'),
    ('fin_entries', 'version'), ('fin_entries', 'created_by'), ('fin_entries', 'created_at'),
    ('fin_entries', 'updated_by'), ('fin_entries', 'updated_at'),
    ('fin_payments', 'id'), ('fin_payments', 'clinic_id'), ('fin_payments', 'entry_id'), ('fin_payments', 'paid_on'),
    ('fin_payments', 'amount_cents'), ('fin_payments', 'account_id'), ('fin_payments', 'bank_source_key'),
    ('fin_payments', 'bank_source_file'), ('fin_payments', 'bank_source_description'),
    ('fin_payments', 'recorded_by'), ('fin_payments', 'recorded_at'), ('fin_payments', 'updated_by'),
    ('fin_payments', 'updated_at'), ('fin_payments', 'voided_at'), ('fin_payments', 'voided_by'),
    ('fin_payments', 'void_reason'), ('fin_payments', 'legacy_id'),
    ('fin_balance_snapshots', 'id'), ('fin_balance_snapshots', 'clinic_id'), ('fin_balance_snapshots', 'day'),
    ('fin_balance_snapshots', 'bank_cents'), ('fin_balance_snapshots', 'cash_cents'),
    ('fin_balance_snapshots', 'bank_as_of'), ('fin_balance_snapshots', 'cash_as_of'), ('fin_balance_snapshots', 'note'),
    ('fin_balance_snapshots', 'version'), ('fin_balance_snapshots', 'created_by'),
    ('fin_balance_snapshots', 'created_at'), ('fin_balance_snapshots', 'updated_by'),
    ('fin_balance_snapshots', 'updated_at'),
    ('fin_balance_sources', 'id'), ('fin_balance_sources', 'clinic_id'), ('fin_balance_sources', 'snapshot_id'),
    ('fin_balance_sources', 'kind'), ('fin_balance_sources', 'source_key'), ('fin_balance_sources', 'account_id'),
    ('fin_balance_sources', 'label'), ('fin_balance_sources', 'as_of'), ('fin_balance_sources', 'amount_cents'),
    ('fin_balance_sources', 'file_name'), ('fin_balance_sources', 'note'), ('fin_balance_sources', 'is_manual'),
    ('fin_balance_sources', 'created_by'), ('fin_balance_sources', 'created_at'),
    ('fin_balance_sources', 'replaced_at'), ('fin_balance_sources', 'replaced_by')
  ) AS e(tbl, col)
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut fin_* tabloları beklenen yapıda değil: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2.1 Shared helpers
-- ---------------------------------------------------------------------------

-- Turkish-aware lower case (legacy FP:53 toLocaleLowerCase('tr')). The Turkish capitals are translated explicitly
-- so the result does not depend on the database's LC_CTYPE (with 'C', lower() leaves Ç Ğ Ö Ş Ü unchanged).
-- Only pg_catalog functions and no SET clause, so it is IMMUTABLE and usable in index expressions.
CREATE OR REPLACE FUNCTION public.fin__tr_lower(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.lower(pg_catalog.translate(p, 'İIÇĞÖŞÜÂÎÛ', 'iıçğöşüâîû'))
$$;

-- Name key: Turkish lower case, whitespace collapsed, trimmed (legacy FM:77, FC:6).
CREATE OR REPLACE FUNCTION public.fin__normalize_name(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(public.fin__tr_lower(p), '\s+', ' ', 'g'))
$$;

-- First day of the month of a date, without any time zone involvement.
CREATE OR REPLACE FUNCTION public.fin__month_start(p date)
RETURNS date
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p - (EXTRACT(DAY FROM p)::integer - 1)
$$;

-- p1 §1.2. First statement of every read RPC: the caller's clinic, or 42501.
CREATE OR REPLACE FUNCTION public.fin__require_read()
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
  IF NOT (public.has_permission('finance') OR public.has_permission('finance_readonly')) THEN
    RAISE EXCEPTION 'Finans verilerini görme yetkiniz yok.' USING ERRCODE = '42501';
  END IF;
  RETURN v_clinic;
END;
$$;

-- p1 §1.2. First statement of every write RPC (legacy RT:12 / RT:30).
CREATE OR REPLACE FUNCTION public.fin__require_write()
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
  IF NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Bu işlem için finans yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;
  RETURN v_clinic;
END;
$$;

-- Used by the RLS policies. Takes no clinic argument and answers only for the caller, so it is safe to grant.
CREATE OR REPLACE FUNCTION public.fin_can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission('finance') OR public.has_permission('finance_readonly')
$$;

-- Reason for cancel / void / exclusion (E_REASON). Returns the trimmed text.
CREATE OR REPLACE FUNCTION public.fin__reason(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR char_length(btrim(p)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Gerekçe en az 3, en fazla 500 karakter olmalı.';
  END IF;
  RETURN btrim(p);
END;
$$;

-- Amount bound 1..1e12 cents (p1 hard rule; legacy FM:23, FM:25-26). E_AMOUNT.
CREATE OR REPLACE FUNCTION public.fin__amount(p bigint)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR p < 1 OR p > 1000000000000 THEN
    RAISE EXCEPTION 'Tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
  END IF;
  RETURN p;
END;
$$;

-- Business date sanity (legacy FM:22). E_DATE.
CREATE OR REPLACE FUNCTION public.fin__day(p date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR p < DATE '2000-01-01' OR p > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Geçersiz tarih.';
  END IF;
  RETURN p;
END;
$$;

-- 'YYYY-MM' → first day of that month (legacy FM:26 entitlementMonth). NULL / '' → NULL. E_DATE.
CREATE OR REPLACE FUNCTION public.fin__month(p text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(p) !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Geçersiz tarih.';
  END IF;
  RETURN public.fin__day((btrim(p) || '-01')::date);
END;
$$;

-- Report month filter for fin_dashboard: NULL → current month; malformed or after the current month → E_FILTER
-- (legacy FP:58 caps the picker at max={today.slice(0,7)}).
CREATE OR REPLACE FUNCTION public.fin__report_month(p_month text, p_today date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_month date;
BEGIN
  IF p_month IS NULL OR btrim(p_month) = '' THEN
    RETURN public.fin__month_start(p_today);
  END IF;
  IF btrim(p_month) !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  v_month := (btrim(p_month) || '-01')::date;
  IF v_month < DATE '2000-01-01' OR v_month > public.fin__month_start(p_today) THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  RETURN v_month;
END;
$$;

-- Master-data name: trimmed, 1..p_max characters (E_NAME).
CREATE OR REPLACE FUNCTION public.fin__name(p text, p_max integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR char_length(btrim(p)) NOT BETWEEN 1 AND p_max THEN
    RAISE EXCEPTION 'Ad boş olamaz ve en fazla % karakter olabilir.', p_max;
  END IF;
  RETURN btrim(p);
END;
$$;

-- Free note: trimmed, NULL → '', at most p_max characters (E_NOTE).
CREATE OR REPLACE FUNCTION public.fin__note(p text, p_max integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF char_length(btrim(coalesce(p, ''))) > p_max THEN
    RAISE EXCEPTION 'Not en fazla % karakter olabilir.', p_max;
  END IF;
  RETURN btrim(coalesce(p, ''));
END;
$$;

-- Sort order of master rows: NULL → 100, otherwise 0..10000.
CREATE OR REPLACE FUNCTION public.fin__sort_order(p integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NOT NULL AND p NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Sıra 0 ile 10.000 arasında olmalı.';
  END IF;
  RETURN coalesce(p, 100);
END;
$$;

-- Display name of a users row for returned JSON (*_by_name). Finance holders may not otherwise read inactive staff.
CREATE OR REPLACE FUNCTION public.fin__user_name(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT u.full_name FROM public.users u WHERE u.id = p_user
$$;

-- Paging object {offset >= 0 (default 0), limit 1..200 (default 50)}; anything else → E_FILTER.
CREATE OR REPLACE FUNCTION public.fin__page(p_page jsonb, OUT o_offset integer, OUT o_limit integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_page jsonb := coalesce(p_page, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_page) <> 'object' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_page) AS k(k_name) WHERE k.k_name NOT IN ('offset', 'limit')) THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  BEGIN
    o_offset := coalesce((v_page ->> 'offset')::integer, 0);
    o_limit := coalesce((v_page ->> 'limit')::integer, 50);
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END;
  IF o_offset < 0 OR o_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.2 Tables
-- ---------------------------------------------------------------------------

-- Accounts: where money moved (legacy FM:25 enum 'Banka' | 'Nakit' | 'Karma' becomes rows).
CREATE TABLE IF NOT EXISTS public.fin_accounts (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('bank', 'cash', 'pos', 'mixed')),
  bank_name text CHECK (bank_name IS NULL OR char_length(bank_name) <= 80),
  import_key text CHECK (import_key IS NULL OR char_length(import_key) BETWEEN 1 AND 200),  -- Phase 2 (BI:10, BI:25)
  is_active boolean NOT NULL DEFAULT true,   -- inactive: kept on old payments, refused for new ones
  sort_order integer NOT NULL DEFAULT 100,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_accounts_name_key
  ON public.fin_accounts (clinic_id, public.fin__normalize_name(name));
CREATE UNIQUE INDEX IF NOT EXISTS fin_accounts_import_key
  ON public.fin_accounts (clinic_id, import_key) WHERE import_key IS NOT NULL;

-- Settings: one row per clinic. Replaces legacy hard-codes FM:73 (15-day window), FM:76 (1,000,000 TL buffer),
-- FP:65 / IP:55 / IP:67 ('%4 dahil' note) and IP:55 (entitlement payment forced to 'Nakit').
CREATE TABLE IF NOT EXISTS public.fin_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL UNIQUE REFERENCES public.clinics(id) ON DELETE RESTRICT,
  buffer_target_cents bigint NOT NULL DEFAULT 100000000
    CHECK (buffer_target_cents BETWEEN 0 AND 1000000000000),
  forecast_days integer NOT NULL DEFAULT 15 CHECK (forecast_days BETWEEN 1 AND 90),
  physician_fee_note text CHECK (physician_fee_note IS NULL OR char_length(physician_fee_note) <= 500),
  report_brand_name text CHECK (report_brand_name IS NULL OR char_length(report_brand_name) <= 120),
  entitlement_account_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, entitlement_account_id) REFERENCES public.fin_accounts (clinic_id, id)
);

-- Report groups for open payables (legacy FM:79-81 hard-coded alp / baykara / lab / other).
-- Effective group of an open 'out' entry = counterparty.report_group_id, else category.report_group_id,
-- else the implicit 'Diğer borçlar' (no row). Counterparty first keeps the legacy priority (FM:81, C6, FT:14).
CREATE TABLE IF NOT EXISTS public.fin_report_groups (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_report_groups_name_key
  ON public.fin_report_groups (clinic_id, public.fin__normalize_name(name));

-- Categories (p1 §1.4; legacy FM:3-19). Formulas use report_bucket only, never the name.
CREATE TABLE IF NOT EXISTS public.fin_categories (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  profit_class text NOT NULL CHECK (profit_class IN ('income', 'expense', 'none')),
  report_bucket text NOT NULL,
  report_group_id uuid,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, report_group_id) REFERENCES public.fin_report_groups (clinic_id, id),
  -- The bucket fixes direction and profit class (p1 §1.4; legacy FM:4-18).
  CONSTRAINT fin_categories_bucket_class CHECK (
    (report_bucket, direction, profit_class) IN (
      ('patient_receipts', 'in',  'income'),
      ('other_income',     'in',  'income'),
      ('rent',             'out', 'expense'),
      ('doctor',           'out', 'expense'),
      ('lab',              'out', 'expense'),
      ('supplies',         'out', 'expense'),
      ('personnel',        'out', 'expense'),
      ('tax',              'out', 'expense'),
      ('other_expense',    'out', 'expense'),
      ('distribution',     'out', 'none'),
      ('capital',          'in',  'none'),
      ('principal',        'out', 'none'),
      ('fees',             'out', 'expense'),
      ('asset',            'out', 'none')
    )
  ),
  CONSTRAINT fin_categories_group_out CHECK (report_group_id IS NULL OR direction = 'out')
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_categories_name_key
  ON public.fin_categories (clinic_id, public.fin__normalize_name(name));
CREATE UNIQUE INDEX IF NOT EXISTS fin_categories_system_bucket_key
  ON public.fin_categories (clinic_id, report_bucket) WHERE is_system;

-- Counterparties (Cariler master). Legacy groups by free-text name (FM:77-80).
CREATE TABLE IF NOT EXISTS public.fin_counterparties (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  normalized_name text NOT NULL,            -- set by fin__trg_counterparty_normalize, never by clients
  kind text NOT NULL CHECK (kind IN ('physician', 'lab', 'supplier', 'landlord', 'bank', 'staff', 'partner', 'tax', 'other')),
  doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,  -- same clinic checked by trigger
  report_group_id uuid,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, report_group_id) REFERENCES public.fin_report_groups (clinic_id, id),
  CONSTRAINT fin_counterparties_doctor_kind CHECK (doctor_id IS NULL OR kind = 'physician')
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_counterparties_name_key
  ON public.fin_counterparties (clinic_id, normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS fin_counterparties_doctor_key
  ON public.fin_counterparties (clinic_id, doctor_id) WHERE doctor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_counterparties_group
  ON public.fin_counterparties (report_group_id) WHERE report_group_id IS NOT NULL;

-- Entries: one obligation or flow (legacy entrySchema FM:26-27 without the embedded payments[]).
CREATE TABLE IF NOT EXISTS public.fin_entries (
  id uuid PRIMARY KEY,                      -- client-supplied (crypto.randomUUID), legacy RT:21 / RT:113
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  subcategory text CHECK (subcategory IN ('current_physician', 'past_physician_debt', 'official_fee')),  -- FM:26
  counterparty_id uuid,                     -- NULL for free-text counterparties (C16)
  counterparty_text text,                   -- used only when counterparty_id IS NULL
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  due_date date NOT NULL CHECK (due_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),  -- or transaction date when realized (FP:76)
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),            -- FM:23, FM:26
  currency char(3) NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  entitlement_month date CHECK (entitlement_month IS NULL OR EXTRACT(DAY FROM entitlement_month) = 1),
  cancelled_at timestamptz,                 -- 'Kalan planı iptal et' (legacy cancelled, RT:136)
  cancelled_by uuid REFERENCES public.users(id),
  cancel_reason text,
  excluded_from_totals boolean NOT NULL DEFAULT false,  -- replaces legacy receiptReconciliation exclusions (FM:48-66)
  exclusion_reason text,
  excluded_at timestamptz,
  excluded_by uuid REFERENCES public.users(id),
  source_key text CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 800),
  source_fingerprint text CHECK (source_fingerprint IS NULL OR char_length(source_fingerprint) <= 128),
  source_file text CHECK (source_file IS NULL OR char_length(source_file) <= 200),
  legacy_id text CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
  version integer NOT NULL DEFAULT 1,       -- FF:15-21: 1 on create, +1 per change
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, category_id) REFERENCES public.fin_categories (clinic_id, id),
  FOREIGN KEY (clinic_id, counterparty_id) REFERENCES public.fin_counterparties (clinic_id, id),
  CONSTRAINT fin_entries_counterparty_one CHECK (
    (counterparty_id IS NOT NULL AND counterparty_text IS NULL)
    OR (counterparty_id IS NULL AND counterparty_text IS NOT NULL
        AND char_length(btrim(counterparty_text)) BETWEEN 1 AND 200)
  ),
  CONSTRAINT fin_entries_cancel_shape CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
    OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND char_length(cancel_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT fin_entries_exclusion_shape CHECK (
    (NOT excluded_from_totals AND exclusion_reason IS NULL AND excluded_at IS NULL AND excluded_by IS NULL)
    OR (excluded_from_totals AND exclusion_reason IS NOT NULL AND char_length(exclusion_reason) BETWEEN 3 AND 500
        AND excluded_at IS NOT NULL)
  ),
  CONSTRAINT fin_entries_source_shape CHECK (
    source_key IS NOT NULL OR (source_fingerprint IS NULL AND source_file IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_entries_source_key
  ON public.fin_entries (clinic_id, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_entries_legacy_key
  ON public.fin_entries (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_entries_due ON public.fin_entries (clinic_id, due_date, id);
CREATE INDEX IF NOT EXISTS idx_fin_entries_open_due ON public.fin_entries (clinic_id, due_date) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_entries_category ON public.fin_entries (clinic_id, category_id);
CREATE INDEX IF NOT EXISTS idx_fin_entries_counterparty
  ON public.fin_entries (clinic_id, counterparty_id) WHERE counterparty_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_entries_counterparty_text
  ON public.fin_entries (clinic_id, public.fin__normalize_name(counterparty_text)) WHERE counterparty_id IS NULL;

-- Payments: realized movements against an entry (legacy paymentSchema FM:25). The entry is the aggregate root:
-- every payment change bumps fin_entries.version, so payments carry no version of their own.
CREATE TABLE IF NOT EXISTS public.fin_payments (
  id uuid PRIMARY KEY,                      -- client-supplied paymentId (RT:23, RT:119); = entry id for realized create (RT:111)
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL,
  paid_on date NOT NULL CHECK (paid_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),  -- <= clinic_today() by trigger
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  account_id uuid NOT NULL,
  bank_source_key text CHECK (bank_source_key IS NULL OR char_length(bank_source_key) BETWEEN 1 AND 800),  -- Phase 2
  bank_source_file text CHECK (bank_source_file IS NULL OR char_length(bank_source_file) <= 200),
  bank_source_description text CHECK (bank_source_description IS NULL OR char_length(bank_source_description) <= 1000),
  recorded_by uuid REFERENCES public.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,                    -- a wrong payment is voided, never deleted (owner decision 2)
  voided_by uuid REFERENCES public.users(id),
  void_reason text,
  legacy_id text CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, entry_id) REFERENCES public.fin_entries (clinic_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id, account_id) REFERENCES public.fin_accounts (clinic_id, id),
  CONSTRAINT fin_payments_void_shape CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT fin_payments_bank_source_shape CHECK (
    bank_source_key IS NOT NULL OR (bank_source_file IS NULL AND bank_source_description IS NULL)
  )
);
-- Legacy payment ids are unique only inside one entry (C24).
CREATE UNIQUE INDEX IF NOT EXISTS fin_payments_legacy_key
  ON public.fin_payments (entry_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_payments_entry_live
  ON public.fin_payments (entry_id) INCLUDE (amount_cents, paid_on) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_payments_entry ON public.fin_payments (entry_id);
CREATE INDEX IF NOT EXISTS idx_fin_payments_day_live ON public.fin_payments (clinic_id, paid_on) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_payments_account ON public.fin_payments (account_id);
-- Not unique on purpose: identical bank rows are legitimate distinct occurrences (C9, C15).
CREATE INDEX IF NOT EXISTS idx_fin_payments_bank_source
  ON public.fin_payments (clinic_id, bank_source_key) WHERE bank_source_key IS NOT NULL;

-- Balance snapshots: owner-declared bank and cash totals, one per day (legacy finance_balances, RT:99 / RT:106).
-- Never derived from payments (FP:61).
CREATE TABLE IF NOT EXISTS public.fin_balance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  day date NOT NULL CHECK (day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  bank_cents bigint NOT NULL CHECK (bank_cents BETWEEN -1000000000000 AND 1000000000000),  -- FM:32 may be negative
  cash_cents bigint NOT NULL CHECK (cash_cents BETWEEN 0 AND 1000000000000),                -- FM:32 cash >= 0
  bank_as_of date NOT NULL,                 -- oldest bank source day (BI:39)
  cash_as_of date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, day),
  CONSTRAINT fin_balance_snapshots_as_of CHECK (bank_as_of <= day AND cash_as_of <= day)
);

-- Balance sources: the per-account breakdown of a snapshot (legacy bankSources[] / cashSource, FM:29-32).
-- Replaced rows stay with replaced_at set. Exactly one active cash source per snapshot; bank side is either one
-- 'manual:bank' total row or one row per account, never both (fin__trg_snapshot_consistent).
CREATE TABLE IF NOT EXISTS public.fin_balance_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bank', 'cash')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  account_id uuid,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  as_of date NOT NULL CHECK (as_of BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN -1000000000000 AND 1000000000000),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 200),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  is_manual boolean NOT NULL,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz,
  replaced_by uuid REFERENCES public.users(id),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, snapshot_id) REFERENCES public.fin_balance_snapshots (clinic_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (clinic_id, account_id) REFERENCES public.fin_accounts (clinic_id, id),
  CONSTRAINT fin_balance_sources_cash CHECK (kind <> 'cash' OR (amount_cents >= 0 AND source_key = 'clinic-cash')),
  CONSTRAINT fin_balance_sources_key CHECK (
    kind = 'cash'
    OR (source_key = 'manual:bank' AND account_id IS NULL AND is_manual)
    OR (source_key <> 'manual:bank' AND source_key <> 'clinic-cash')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_balance_sources_active_key
  ON public.fin_balance_sources (snapshot_id, source_key) WHERE replaced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_balance_sources_account
  ON public.fin_balance_sources (account_id) WHERE account_id IS NOT NULL;

-- audit_logs lookups by clinic + entity (entry history, finance audit list). Not named idx_audit_logs_entity:
-- 0010 already uses that name for (entity_type, entity_id), and IF NOT EXISTS would silently skip this one.
CREATE INDEX IF NOT EXISTS idx_audit_logs_clinic_entity_created
  ON public.audit_logs (clinic_id, entity_type, entity_id, created_at DESC);

-- Account check for new payments / settings (E_ACCOUNT). Needs fin_accounts, so it is defined after it.
CREATE OR REPLACE FUNCTION public.fin__check_account(p_clinic uuid, p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_active boolean;
BEGIN
  SELECT a.is_active INTO v_active
  FROM public.fin_accounts a
  WHERE a.clinic_id = p_clinic AND a.id = p_account_id;
  IF v_active IS NULL THEN
    RAISE EXCEPTION 'Hesap bulunamadı.';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'Pasif hesap seçilemez.';
  END IF;
END;
$$;

-- paid(e): non-voided payments over all dates (p1 §1.5, legacy FM:41).
CREATE OR REPLACE FUNCTION public.fin__paid(p_entry_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(sum(p.amount_cents), 0)::bigint
  FROM public.fin_payments p
  WHERE p.entry_id = p_entry_id AND p.voided_at IS NULL
$$;

-- ---------------------------------------------------------------------------
-- 2.3 Guard triggers. RPCs check these rules first so the user sees the specific message; the triggers are the
--     backstop for the SQL editor, later imports and RPC bugs. Never granted (EXECUTE is not checked when a
--     trigger fires).
-- ---------------------------------------------------------------------------

-- Version / timestamps on every mutable table (legacy RT:138 version = version + 1).
CREATE OR REPLACE FUNCTION public.fin__trg_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := coalesce(public.current_app_user_id(), NEW.updated_by);
  RETURN NEW;
END;
$$;

-- Nothing in finance is ever deleted (owner decision 2): wrong rows are cancelled or voided.
CREATE OR REPLACE FUNCTION public.fin__trg_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Row deletes stay possible for the SQL editor / service role (no JWT user, not an API role), so test rows
  -- and a botched data migration can be cleaned up; app users and TRUNCATE are always refused.
  IF TG_LEVEL = 'ROW'
     AND auth.uid() IS NULL
     AND coalesce(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated')
     AND coalesce(current_setting('role', true), '') NOT IN ('anon', 'authenticated') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Finans kayıtları silinemez; iptal edin.';
END;
$$;

-- Counterparty name key, and a linked doctor must belong to the same clinic (FM:77, FC:6).
CREATE OR REPLACE FUNCTION public.fin__trg_counterparty_normalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.normalized_name := public.fin__normalize_name(NEW.name);
  IF NEW.doctor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = NEW.doctor_id AND d.clinic_id = NEW.clinic_id
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  RETURN NEW;
END;
$$;

-- A category's bucket fixes every formula it takes part in; it never changes (p1 §1.4).
CREATE OR REPLACE FUNCTION public.fin__trg_category_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.report_bucket IS DISTINCT FROM OLD.report_bucket
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.profit_class IS DISTINCT FROM OLD.profit_class
     OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'Kategorinin rapor türü değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- Subcategory / entitlement month by bucket (FM:26, FP:20, FP:46, p1 §1.4); cancel is final; import keys are
-- immutable (FP:46 keeps importSource on edit).
CREATE OR REPLACE FUNCTION public.fin__trg_entry_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text;
BEGIN
  SELECT c.report_bucket INTO v_bucket
  FROM public.fin_categories c
  WHERE c.clinic_id = NEW.clinic_id AND c.id = NEW.category_id;
  IF v_bucket IS NULL THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;

  IF v_bucket = 'doctor' THEN
    NEW.subcategory := coalesce(NEW.subcategory, 'current_physician');
    IF NEW.subcategory NOT IN ('current_physician', 'past_physician_debt') THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF v_bucket = 'other_expense' THEN
    IF NEW.subcategory IS NOT NULL AND NEW.subcategory <> 'official_fee' THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF NEW.subcategory IS NOT NULL THEN
    RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
  END IF;

  IF NEW.entitlement_month IS NOT NULL AND v_bucket <> 'doctor' THEN
    RAISE EXCEPTION 'Hakediş ayı yalnızca hekim hakedişi kayıtlarında kullanılabilir.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.cancelled_at IS NOT NULL
       AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
            OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
            OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt geri açılamaz.';
    END IF;
    IF NEW.source_key IS DISTINCT FROM OLD.source_key
       OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
       OR NEW.source_file IS DISTINCT FROM OLD.source_file
       OR NEW.legacy_id IS DISTINCT FROM OLD.legacy_id THEN
      RAISE EXCEPTION 'Bu alan değiştirilemez.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Payments: no new payment on a cancelled entry (C1: corrections and voids stay allowed), never a future date,
-- recorder taken from the session; a voided payment is frozen; keys are immutable (RT:131, RT:134).
CREATE OR REPLACE FUNCTION public.fin__trg_payment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cancelled_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT e.cancelled_at INTO v_cancelled_at
    FROM public.fin_entries e
    WHERE e.clinic_id = NEW.clinic_id AND e.id = NEW.entry_id;
    IF v_cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayda ödeme eklenemez.';
    END IF;
    IF NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş ödeme eklenemez.';
    END IF;
    IF NEW.paid_on > public.clinic_today() THEN
      RAISE EXCEPTION 'Ödeme tarihi ve kalan tutarı kontrol edin.';
    END IF;
    -- API calls: recorder and time come from the session. SQL editor imports keep their own values.
    IF auth.uid() IS NOT NULL THEN
      NEW.recorded_at := now();
      NEW.recorded_by := public.current_app_user_id();
      NEW.updated_at := NEW.recorded_at;
      NEW.updated_by := NEW.recorded_by;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.voided_at IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'İptal edilmiş ödeme değiştirilemez.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.bank_source_key IS DISTINCT FROM OLD.bank_source_key
     OR NEW.bank_source_file IS DISTINCT FROM OLD.bank_source_file
     OR NEW.bank_source_description IS DISTINCT FROM OLD.bank_source_description
     OR NEW.legacy_id IS DISTINCT FROM OLD.legacy_id THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;

  IF NEW.paid_on IS DISTINCT FROM OLD.paid_on AND NEW.paid_on > public.clinic_today() THEN
    RAISE EXCEPTION 'Düzeltme tarihi veya tutarı geçersiz.';
  END IF;

  NEW.updated_at := now();
  NEW.updated_by := coalesce(public.current_app_user_id(), NEW.updated_by);
  RETURN NEW;
END;
$$;

-- sum(non-voided payments) <= entry amount (legacy FM:27 superRefine). Fired from both tables.
CREATE OR REPLACE FUNCTION public.fin__trg_paid_within_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry uuid;
  v_amount bigint;
  v_paid bigint;
BEGIN
  -- Separate statements: one CASE expression would resolve NEW.entry_id on fin_entries rows and fail.
  IF TG_TABLE_NAME = 'fin_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;

  SELECT e.amount_cents INTO v_amount FROM public.fin_entries e WHERE e.id = v_entry;
  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_paid
  FROM public.fin_payments p
  WHERE p.entry_id = v_entry AND p.voided_at IS NULL;

  IF v_paid > v_amount THEN
    RAISE EXCEPTION 'Ödeme toplamı kayıt tutarını aşamaz.';
  END IF;
  RETURN NULL;
END;
$$;

-- A snapshot always equals its active sources (FM:32, BI:39). Deferred: the RPC writes the snapshot first.
CREATE OR REPLACE FUNCTION public.fin__trg_snapshot_consistent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot_id uuid;
  v_snap public.fin_balance_snapshots%ROWTYPE;
  v_cash_n bigint;
  v_cash_sum bigint;
  v_cash_as_of date;
  v_bank_n bigint;
  v_manual_n bigint;
  v_bank_sum bigint;
  v_bank_min date;
  v_max_as_of date;
BEGIN
  IF TG_TABLE_NAME = 'fin_balance_snapshots' THEN
    v_snapshot_id := NEW.id;
  ELSE
    v_snapshot_id := NEW.snapshot_id;
  END IF;

  SELECT * INTO v_snap FROM public.fin_balance_snapshots s WHERE s.id = v_snapshot_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE src.kind = 'cash'),
         (sum(src.amount_cents) FILTER (WHERE src.kind = 'cash'))::bigint,
         min(src.as_of) FILTER (WHERE src.kind = 'cash'),
         count(*) FILTER (WHERE src.kind = 'bank'),
         count(*) FILTER (WHERE src.kind = 'bank' AND src.source_key = 'manual:bank'),
         (sum(src.amount_cents) FILTER (WHERE src.kind = 'bank'))::bigint,
         min(src.as_of) FILTER (WHERE src.kind = 'bank'),
         max(src.as_of)
    INTO v_cash_n, v_cash_sum, v_cash_as_of, v_bank_n, v_manual_n, v_bank_sum, v_bank_min, v_max_as_of
  FROM public.fin_balance_sources src
  WHERE src.snapshot_id = v_snapshot_id AND src.replaced_at IS NULL;

  IF v_cash_n IS DISTINCT FROM 1::bigint
     OR v_cash_sum IS DISTINCT FROM v_snap.cash_cents
     OR v_cash_as_of IS DISTINCT FROM v_snap.cash_as_of
     OR v_bank_n < 1
     OR (v_manual_n > 0 AND v_bank_n <> 1)
     OR v_bank_sum IS DISTINCT FROM v_snap.bank_cents
     OR v_bank_min IS DISTINCT FROM v_snap.bank_as_of
     OR v_max_as_of > v_snap.day THEN
    RAISE EXCEPTION 'Bakiye kaynakları toplamla uyuşmuyor.';
  END IF;
  RETURN NULL;
END;
$$;

-- Balance sources are history: only the replacement stamp may be set, once.
CREATE OR REPLACE FUNCTION public.fin__trg_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.replaced_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  IF (NEW.id, NEW.clinic_id, NEW.snapshot_id, NEW.kind, NEW.source_key, NEW.account_id, NEW.label, NEW.as_of,
      NEW.amount_cents, NEW.file_name, NEW.note, NEW.is_manual, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.clinic_id, OLD.snapshot_id, OLD.kind, OLD.source_key, OLD.account_id, OLD.label, OLD.as_of,
      OLD.amount_cents, OLD.file_name, OLD.note, OLD.is_manual, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- Every new clinic gets its finance defaults (§4). fin__seed_clinic is defined in the seeds section.
CREATE OR REPLACE FUNCTION public.fin__trg_seed_clinic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fin__seed_clinic(NEW.id);
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories',
                             'fin_counterparties', 'fin_entries', 'fin_balance_snapshots']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_touch ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_touch()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories',
                             'fin_counterparties', 'fin_entries', 'fin_payments', 'fin_balance_snapshots',
                             'fin_balance_sources']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_delete ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_no_delete BEFORE DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS fin_counterparty_normalize ON public.fin_counterparties;
CREATE TRIGGER fin_counterparty_normalize
  BEFORE INSERT OR UPDATE ON public.fin_counterparties
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_counterparty_normalize();

DROP TRIGGER IF EXISTS fin_category_guard ON public.fin_categories;
CREATE TRIGGER fin_category_guard
  BEFORE UPDATE ON public.fin_categories
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_category_guard();

DROP TRIGGER IF EXISTS fin_entry_guard ON public.fin_entries;
CREATE TRIGGER fin_entry_guard
  BEFORE INSERT OR UPDATE ON public.fin_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_entry_guard();

DROP TRIGGER IF EXISTS fin_payment_guard ON public.fin_payments;
CREATE TRIGGER fin_payment_guard
  BEFORE INSERT OR UPDATE ON public.fin_payments
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_payment_guard();

-- Bulk loaders may SET CONSTRAINTS fin_paid_within_amount DEFERRED.
DROP TRIGGER IF EXISTS fin_paid_within_amount ON public.fin_payments;
CREATE CONSTRAINT TRIGGER fin_paid_within_amount
  AFTER INSERT OR UPDATE ON public.fin_payments
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_paid_within_amount();

DROP TRIGGER IF EXISTS fin_paid_within_amount ON public.fin_entries;
CREATE CONSTRAINT TRIGGER fin_paid_within_amount
  AFTER UPDATE OF amount_cents ON public.fin_entries
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_paid_within_amount();

DROP TRIGGER IF EXISTS fin_snapshot_consistent ON public.fin_balance_snapshots;
CREATE CONSTRAINT TRIGGER fin_snapshot_consistent
  AFTER INSERT OR UPDATE ON public.fin_balance_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_snapshot_consistent();

DROP TRIGGER IF EXISTS fin_snapshot_consistent ON public.fin_balance_sources;
CREATE CONSTRAINT TRIGGER fin_snapshot_consistent
  AFTER INSERT OR UPDATE ON public.fin_balance_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_snapshot_consistent();

DROP TRIGGER IF EXISTS fin_source_guard ON public.fin_balance_sources;
CREATE TRIGGER fin_source_guard
  BEFORE UPDATE ON public.fin_balance_sources
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_source_guard();

DROP TRIGGER IF EXISTS fin_seed_clinic ON public.clinics;
CREATE TRIGGER fin_seed_clinic
  AFTER INSERT ON public.clinics
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_seed_clinic();

-- ---------------------------------------------------------------------------
-- 2.4 Row level security and table privileges. SELECT only, for finance / finance_readonly holders of the
--     caller's clinic. No write policies and no write privileges: every write is an RPC. Supabase grants ALL on
--     new tables to anon / authenticated by default, so the revoke is explicit (pattern of 0019 staff_permissions).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories',
                             'fin_counterparties', 'fin_entries', 'fin_payments', 'fin_balance_snapshots',
                             'fin_balance_sources']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_t || '_select_finance', v_t);
    -- (SELECT ...) lets PostgreSQL evaluate the helpers once per statement instead of once per row.
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
                      clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.fin_can_read()))',
                   v_t || '_select_finance', v_t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2.5 Audit: audit_row_change() (0019) on all nine tables, and the audit_logs SELECT policy. fin_* rows are
--     readable only by finance / finance_readonly holders of the clinic, whatever their role (owners and admins
--     without a finance permission see none). Every other entity type keeps exactly the 0019 rule.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories',
                             'fin_counterparties', 'fin_entries', 'fin_payments', 'fin_balance_snapshots',
                             'fin_balance_sources']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()', v_t);
  END LOOP;
END $$;

-- The 0019 policy is recreated with exactly its 0019 body, so 0019 and 0020 converge whichever ran last
-- (0019 is documented as safe to re-run). fin_* rows are handled by two extra policies that 0019 never touches:
--   * a RESTRICTIVE gate, ANDed with every permissive policy: fin_* rows only for finance / finance_readonly
--     holders. Re-running 0019 can therefore never re-expose them to an owner or admin without finance.
--   * a permissive read so a finance / finance_readonly holder who is not owner/admin sees the clinic's fin_* rows.
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

DROP POLICY IF EXISTS "audit_logs_fin_guard" ON public.audit_logs;
CREATE POLICY "audit_logs_fin_guard" ON public.audit_logs
  AS RESTRICTIVE
  FOR SELECT USING (
    left(entity_type, 4) <> 'fin_'
    OR (SELECT public.fin_can_read())
  );

DROP POLICY IF EXISTS "audit_logs_select_finance" ON public.audit_logs;
CREATE POLICY "audit_logs_select_finance" ON public.audit_logs
  FOR SELECT USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND left(entity_type, 4) = 'fin_'
    AND (SELECT public.fin_can_read())
  );

-- ---------------------------------------------------------------------------
-- 3.4 Shared read internals. Never granted. The two set-returning functions are plain LANGUAGE sql STABLE with
--     no SECURITY DEFINER / SET clause, so the planner inlines them and pushes filters down; they are only ever
--     called from SECURITY DEFINER functions, and every name in them is schema-qualified.
-- ---------------------------------------------------------------------------

-- One row per entry with the derived values every screen uses (p1 §1.5): paid over all dates without voided
-- payments (FM:41), outstanding 0 when cancelled (FM:42), status (FP:53), effective payable group (FM:81, C6).
CREATE OR REPLACE FUNCTION public.fin__entries_state(p_clinic uuid)
RETURNS TABLE (
  id uuid,
  clinic_id uuid,
  category_id uuid,
  category_name text,
  category_sort integer,
  category_is_active boolean,
  direction text,
  profit_class text,
  report_bucket text,
  subcategory text,
  counterparty_id uuid,
  counterparty_text text,
  counterparty_name text,
  counterparty_kind text,
  counterparty_is_active boolean,
  counterparty_key text,
  report_group_id uuid,
  description text,
  due_date date,
  amount_cents bigint,
  paid_cents bigint,
  outstanding_cents bigint,
  status text,
  entitlement_month date,
  cancelled_at timestamptz,
  excluded_from_totals boolean,
  source_key text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT e.id,
         e.clinic_id,
         e.category_id,
         c.name,
         c.sort_order,
         c.is_active,
         c.direction,
         c.profit_class,
         c.report_bucket,
         e.subcategory,
         e.counterparty_id,
         e.counterparty_text,
         coalesce(cp.name, cpn.name, e.counterparty_text),
         cp.kind,
         cp.is_active,
         CASE WHEN coalesce(e.counterparty_id, cpn.id) IS NOT NULL
              THEN 'id:' || coalesce(e.counterparty_id, cpn.id)::text
              ELSE 'text:' || public.fin__normalize_name(e.counterparty_text) END,
         CASE WHEN c.direction = 'out' THEN coalesce(cp.report_group_id, cpn.report_group_id, c.report_group_id) END,
         e.description,
         e.due_date,
         e.amount_cents,
         coalesce(pp.paid, 0)::bigint,
         CASE WHEN e.cancelled_at IS NOT NULL THEN 0::bigint
              ELSE e.amount_cents - coalesce(pp.paid, 0)::bigint END,
         CASE WHEN e.cancelled_at IS NOT NULL THEN 'cancelled'
              WHEN e.amount_cents - coalesce(pp.paid, 0)::bigint > 0 THEN 'open'
              ELSE 'completed' END,
         e.entitlement_month,
         e.cancelled_at,
         e.excluded_from_totals,
         e.source_key,
         e.created_at
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
  -- Free text resolves to the master with the same normalized name (active or not) on the read side, so an entry
  -- typed before its master existed, or while it was inactive, is counted with it (legacy keys by name, FM:77-81).
  LEFT JOIN public.fin_counterparties cpn
    ON e.counterparty_id IS NULL
   AND cpn.clinic_id = e.clinic_id
   AND cpn.normalized_name = public.fin__normalize_name(e.counterparty_text)
  LEFT JOIN LATERAL (
    SELECT sum(p.amount_cents)::bigint AS paid
    FROM public.fin_payments p
    WHERE p.entry_id = e.id AND p.voided_at IS NULL
  ) pp ON true
  WHERE e.clinic_id = p_clinic
$$;

-- Every payment that counts in any realized sum: not voided and paid_on <= p_today (FM:72, FR:9, FR:18).
-- Callers add NOT excluded_from_totals and the month range. is_past is the physician split of p1 §1.5, decided per
-- payment by its own month (FC:12-15, FR:21).
CREATE OR REPLACE FUNCTION public.fin__live_payments(p_clinic uuid, p_today date)
RETURNS TABLE (
  payment_id uuid,
  entry_id uuid,
  paid_on date,
  amount_cents bigint,
  account_id uuid,
  category_id uuid,
  direction text,
  profit_class text,
  report_bucket text,
  excluded_from_totals boolean,
  is_past boolean,
  counterparty_key text
)
LANGUAGE sql
STABLE
AS $$
  SELECT p.id,
         p.entry_id,
         p.paid_on,
         p.amount_cents,
         p.account_id,
         e.category_id,
         c.direction,
         c.profit_class,
         c.report_bucket,
         e.excluded_from_totals,
         (c.report_bucket = 'doctor'
          AND (coalesce(e.entitlement_month < public.fin__month_start(p.paid_on), false)
               OR coalesce(e.subcategory = 'past_physician_debt', false))),
         CASE WHEN coalesce(e.counterparty_id, cpn.id) IS NOT NULL
              THEN 'id:' || coalesce(e.counterparty_id, cpn.id)::text
              ELSE 'text:' || public.fin__normalize_name(e.counterparty_text) END
  FROM public.fin_payments p
  JOIN public.fin_entries e ON e.clinic_id = p.clinic_id AND e.id = p.entry_id
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  LEFT JOIN public.fin_counterparties cpn
    ON e.counterparty_id IS NULL
   AND cpn.clinic_id = e.clinic_id
   AND cpn.normalized_name = public.fin__normalize_name(e.counterparty_text)
  WHERE p.clinic_id = p_clinic
    AND p.voided_at IS NULL
    AND p.paid_on <= p_today
$$;

-- PaymentJson[] of one entry (p2 §3.0.1), voided ones included, ordered paid_on, recorded_at, id.
-- p_with_max adds max_correction_cents = amount − paid + this payment (RT:134); 0 for voided payments.
CREATE OR REPLACE FUNCTION public.fin__payments_json(p_clinic uuid, p_entry_id uuid, p_with_max boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', p.id,
             'entry_id', p.entry_id,
             'paid_on', p.paid_on,
             'amount_cents', p.amount_cents,
             'account_id', p.account_id,
             'account_name', a.name,
             'account_kind', a.kind,
             'account_is_active', a.is_active,
             'is_voided', p.voided_at IS NOT NULL,
             'voided_at', p.voided_at,
             'voided_by_name', public.fin__user_name(p.voided_by),
             'void_reason', p.void_reason,
             'physician_split', CASE
                                  WHEN c.report_bucket <> 'doctor' THEN NULL
                                  WHEN coalesce(e.entitlement_month < public.fin__month_start(p.paid_on), false)
                                       OR coalesce(e.subcategory = 'past_physician_debt', false) THEN 'past'
                                  ELSE 'current'
                                END,
             'bank_source', CASE
                              WHEN p.bank_source_key IS NULL THEN NULL
                              ELSE jsonb_build_object('key', p.bank_source_key,
                                                      'file', p.bank_source_file,
                                                      'description', p.bank_source_description)
                            END,
             'recorded_at', p.recorded_at,
             'recorded_by_name', public.fin__user_name(p.recorded_by),
             'updated_at', p.updated_at,
             'updated_by_name', public.fin__user_name(p.updated_by)
           )
           || CASE
                WHEN p_with_max THEN jsonb_build_object(
                  'max_correction_cents',
                  CASE WHEN p.voided_at IS NULL THEN e.amount_cents - pd.paid + p.amount_cents ELSE 0::bigint END)
                ELSE '{}'::jsonb
              END
           ORDER BY p.paid_on, p.recorded_at, p.id), '[]'::jsonb)
  FROM public.fin_payments p
  JOIN public.fin_entries e ON e.clinic_id = p.clinic_id AND e.id = p.entry_id
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  JOIN public.fin_accounts a ON a.clinic_id = p.clinic_id AND a.id = p.account_id
  CROSS JOIN LATERAL (SELECT public.fin__paid(e.id) AS paid) pd
  WHERE p.clinic_id = p_clinic AND p.entry_id = p_entry_id
$$;

-- EntryJson (p2 §3.0.1). NULL when the entry is not in the clinic.
CREATE OR REPLACE FUNCTION public.fin__entry_json(p_clinic uuid, p_id uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', e.id,
           'version', e.version,
           'category_id', e.category_id,
           'category_name', s.category_name,
           'category_is_active', s.category_is_active,
           'direction', s.direction,
           'profit_class', s.profit_class,
           'report_bucket', s.report_bucket,
           'subcategory', e.subcategory,
           'counterparty_id', e.counterparty_id,
           'counterparty_text', e.counterparty_text,
           'counterparty_name', s.counterparty_name,
           'counterparty_kind', s.counterparty_kind,
           'counterparty_is_active', s.counterparty_is_active,
           'report_group_id', s.report_group_id,
           'report_group_name', rg.name,
           'description', e.description,
           'due_date', e.due_date,
           'amount_cents', e.amount_cents,
           'paid_cents', s.paid_cents,
           'outstanding_cents', s.outstanding_cents,
           'status', s.status,
           'is_overdue', (e.due_date < p_today AND s.outstanding_cents > 0),
           'entitlement_month', to_char(e.entitlement_month, 'YYYY-MM'),
           'is_entitlement', coalesce(e.source_key LIKE 'entitlement:%', false),
           'cancelled_at', e.cancelled_at,
           'cancelled_by_name', public.fin__user_name(e.cancelled_by),
           'cancel_reason', e.cancel_reason,
           'excluded_from_totals', e.excluded_from_totals,
           'exclusion_reason', e.exclusion_reason,
           'excluded_at', e.excluded_at,
           'excluded_by_name', public.fin__user_name(e.excluded_by),
           'source_key', e.source_key,
           'source_file', e.source_file,
           'has_legacy_id', e.legacy_id IS NOT NULL,
           'payment_count', pc.live_n,
           'voided_payment_count', pc.void_n,
           'created_at', e.created_at,
           'created_by_name', public.fin__user_name(e.created_by),
           'updated_at', e.updated_at,
           'updated_by_name', public.fin__user_name(e.updated_by)
         )
  FROM public.fin_entries e
  JOIN public.fin__entries_state(p_clinic) s ON s.id = e.id
  LEFT JOIN public.fin_report_groups rg ON rg.clinic_id = e.clinic_id AND rg.id = s.report_group_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE p.voided_at IS NULL) AS live_n,
           count(*) FILTER (WHERE p.voided_at IS NOT NULL) AS void_n
    FROM public.fin_payments p
    WHERE p.entry_id = e.id
  ) pc
  WHERE e.clinic_id = p_clinic AND e.id = p_id
$$;

-- Write envelope of every entry RPC: { already_saved, entry, payments } (legacy RT:141, RT:114, RT:119).
CREATE OR REPLACE FUNCTION public.fin__entry_envelope(p_clinic uuid, p_id uuid, p_already boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'already_saved', p_already,
           'entry', public.fin__entry_json(p_clinic, p_id, public.clinic_today()),
           'payments', public.fin__payments_json(p_clinic, p_id, false))
$$;

-- Latest snapshot with day <= p_today (FM:68, RT:96).
CREATE OR REPLACE FUNCTION public.fin__current_snapshot_id(p_clinic uuid, p_today date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT s.id
  FROM public.fin_balance_snapshots s
  WHERE s.clinic_id = p_clinic AND s.day <= p_today
  ORDER BY s.day DESC
  LIMIT 1
$$;

-- SnapshotJson (p2 §3.0.1): liquid = bank + cash (FM:69); active sources only, bank first, cash last.
CREATE OR REPLACE FUNCTION public.fin__snapshot_json(p_clinic uuid, p_id uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', s.id,
           'version', s.version,
           'day', s.day,
           'bank_cents', s.bank_cents,
           'cash_cents', s.cash_cents,
           'liquid_cents', s.bank_cents + s.cash_cents,
           'bank_as_of', s.bank_as_of,
           'cash_as_of', s.cash_as_of,
           'bank_mode', CASE WHEN EXISTS (
                               SELECT 1 FROM public.fin_balance_sources m
                               WHERE m.snapshot_id = s.id AND m.replaced_at IS NULL AND m.source_key = 'manual:bank')
                             THEN 'manual' ELSE 'accounts' END,
           'is_today', s.day = p_today,
           'note', s.note,
           'updated_at', s.updated_at,
           'updated_by_name', public.fin__user_name(s.updated_by),
           'sources', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', src.id,
                      'kind', src.kind,
                      'source_key', src.source_key,
                      'account_id', src.account_id,
                      'account_name', a.name,
                      'label', src.label,
                      'as_of', src.as_of,
                      'amount_cents', src.amount_cents,
                      'file_name', src.file_name,
                      'note', src.note,
                      'is_manual', src.is_manual,
                      'is_older_than_today', src.as_of < p_today)
                    ORDER BY CASE WHEN src.kind = 'bank' THEN 0 ELSE 1 END, a.sort_order NULLS LAST, src.label, src.id)
             FROM public.fin_balance_sources src
             LEFT JOIN public.fin_accounts a ON a.clinic_id = src.clinic_id AND a.id = src.account_id
             WHERE src.clinic_id = s.clinic_id AND src.snapshot_id = s.id AND src.replaced_at IS NULL
           ), '[]'::jsonb))
  FROM public.fin_balance_snapshots s
  WHERE s.clinic_id = p_clinic AND s.id = p_id
$$;

-- Master-data row shapes (p2 §3.1).
CREATE OR REPLACE FUNCTION public.fin__settings_json(p_clinic uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', s.id,
           'version', s.version,
           'buffer_target_cents', s.buffer_target_cents,
           'forecast_days', s.forecast_days,
           'physician_fee_note', s.physician_fee_note,
           'report_brand_name', s.report_brand_name,
           'entitlement_account_id', s.entitlement_account_id)
  FROM public.fin_settings s
  WHERE s.clinic_id = p_clinic
$$;

CREATE OR REPLACE FUNCTION public.fin__account_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', a.id,
           'version', a.version,
           'name', a.name,
           'kind', a.kind,
           'bank_name', a.bank_name,
           'import_key', a.import_key,
           'is_active', a.is_active,
           'sort_order', a.sort_order,
           'is_used', EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.account_id = a.id)
                      OR EXISTS (SELECT 1 FROM public.fin_balance_sources src WHERE src.account_id = a.id))
  FROM public.fin_accounts a
  WHERE a.clinic_id = p_clinic AND a.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__report_group_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', g.id,
           'version', g.version,
           'name', g.name,
           'is_active', g.is_active,
           'sort_order', g.sort_order)
  FROM public.fin_report_groups g
  WHERE g.clinic_id = p_clinic AND g.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__category_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', c.id,
           'version', c.version,
           'name', c.name,
           'direction', c.direction,
           'profit_class', c.profit_class,
           'report_bucket', c.report_bucket,
           'report_group_id', c.report_group_id,
           'is_system', c.is_system,
           'is_active', c.is_active,
           'sort_order', c.sort_order)
  FROM public.fin_categories c
  WHERE c.clinic_id = p_clinic AND c.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__counterparty_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', cp.id,
           'version', cp.version,
           'name', cp.name,
           'kind', cp.kind,
           'doctor_id', cp.doctor_id,
           'doctor_name', u.full_name,
           'report_group_id', cp.report_group_id,
           'report_group_name', g.name,
           'note', cp.note,
           'is_active', cp.is_active)
  FROM public.fin_counterparties cp
  LEFT JOIN public.doctors d ON d.id = cp.doctor_id AND d.clinic_id = cp.clinic_id
  LEFT JOIN public.users u ON u.id = d.user_id
  LEFT JOIN public.fin_report_groups g ON g.clinic_id = cp.clinic_id AND g.id = cp.report_group_id
  WHERE cp.clinic_id = p_clinic AND cp.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Formula internals (p3 §5). Each takes p_clinic and p_today so it can be replayed with a fixed date in the SQL
-- editor (p3 §7.5); the public RPCs pass public.clinic_today(). Never granted.
-- ---------------------------------------------------------------------------

-- Entries list with filters, order and ListTotalsJson over every matched row (p2 §3.5 fin_list; p3 §5.9;
-- legacy FP:53, FP:68, FR:4-11). Realized totals: live, non-excluded payments of all dates <= today (FR:9);
-- open totals: outstanding, excluded entries included (FR:8).
CREATE OR REPLACE FUNCTION public.fin__list(p_clinic uuid, p_today date, p_filters jsonb, p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_category uuid;
  v_direction text;
  v_cp uuid;
  v_cp_text text;
  v_has_group boolean := false;
  v_group_other boolean := false;
  v_group uuid;
  v_query text;
  v_from date;
  v_to date;
  v_overdue boolean;
  v_upcoming boolean;
  v_window_end date;
  v_offset integer;
  v_limit integer;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_f) AS k(k_name)
    WHERE k.k_name NOT IN ('status', 'category_id', 'direction', 'counterparty_id', 'counterparty_text',
                           'report_group', 'query', 'date_from', 'date_to', 'overdue', 'upcoming')
  ) THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;

  BEGIN
    v_status := coalesce(nullif(v_f ->> 'status', ''), 'all');
    v_category := nullif(v_f ->> 'category_id', '')::uuid;
    v_direction := nullif(v_f ->> 'direction', '');
    v_cp := nullif(v_f ->> 'counterparty_id', '')::uuid;
    v_cp_text := nullif(btrim(coalesce(v_f ->> 'counterparty_text', '')), '');
    IF nullif(v_f ->> 'report_group', '') IS NOT NULL THEN
      v_has_group := true;
      IF v_f ->> 'report_group' = 'other' THEN
        v_group_other := true;
      ELSE
        v_group := (v_f ->> 'report_group')::uuid;
      END IF;
    END IF;
    v_query := nullif(btrim(coalesce(v_f ->> 'query', '')), '');
    v_from := nullif(v_f ->> 'date_from', '')::date;
    v_to := nullif(v_f ->> 'date_to', '')::date;
    v_overdue := coalesce((v_f ->> 'overdue')::boolean, false);
    v_upcoming := coalesce((v_f ->> 'upcoming')::boolean, false);
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END;

  IF v_status NOT IN ('all', 'open', 'completed', 'cancelled')
     OR (v_direction IS NOT NULL AND v_direction NOT IN ('in', 'out'))
     OR char_length(v_query) > 100
     OR v_from NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'
     OR v_to NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF v_from > v_to THEN
    RAISE EXCEPTION 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
  END IF;

  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.fin__page(p_page) pg;

  IF v_upcoming THEN
    -- No literal fallback (owner decision 4): a clinic without its settings row fails loudly.
    SELECT p_today + (s.forecast_days - 1) INTO v_window_end
    FROM public.fin_settings s
    WHERE s.clinic_id = p_clinic;
    IF v_window_end IS NULL THEN
      RAISE EXCEPTION 'Finans ayarları bulunamadı.';
    END IF;
  END IF;

  WITH m AS (
    SELECT st.id, st.direction, st.due_date, st.created_at, st.outstanding_cents, st.excluded_from_totals
    FROM public.fin__entries_state(p_clinic) st
    WHERE (v_status = 'all' OR st.status = v_status)
      AND (v_category IS NULL OR st.category_id = v_category)
      AND (v_direction IS NULL OR st.direction = v_direction)
      -- Same keys as Cariler: a free-text entry resolved to a master is found by the master's id, not by its text.
      AND (v_cp IS NULL OR st.counterparty_key = 'id:' || v_cp::text)
      AND (v_cp_text IS NULL
           OR st.counterparty_key = 'text:' || public.fin__normalize_name(v_cp_text))
      AND (NOT v_has_group
           OR (st.direction = 'out' AND st.outstanding_cents > 0
               AND CASE WHEN v_group_other THEN st.report_group_id IS NULL
                        ELSE st.report_group_id IS NOT DISTINCT FROM v_group END))
      AND (v_query IS NULL
           OR strpos(public.fin__tr_lower(coalesce(st.counterparty_name, '') || ' ' || st.description),
                     public.fin__tr_lower(v_query)) > 0)
      AND (v_from IS NULL OR st.due_date >= v_from)
      AND (v_to IS NULL OR st.due_date <= v_to)
      AND (NOT v_overdue OR (st.due_date < p_today AND st.outstanding_cents > 0))
      AND (NOT v_upcoming OR (st.outstanding_cents > 0 AND st.due_date <= v_window_end))
  ),
  tot AS (
    SELECT count(*)::bigint AS n,
           coalesce(sum(m.outstanding_cents) FILTER (WHERE m.direction = 'in'), 0)::bigint AS open_in,
           coalesce(sum(m.outstanding_cents) FILTER (WHERE m.direction = 'out'), 0)::bigint AS open_out
    FROM m
  ),
  rz AS (
    SELECT coalesce(sum(p.amount_cents) FILTER (WHERE m.direction = 'in'), 0)::bigint AS inc,
           coalesce(sum(p.amount_cents) FILTER (WHERE m.direction = 'out'), 0)::bigint AS outg
    FROM m
    JOIN public.fin_payments p ON p.clinic_id = p_clinic AND p.entry_id = m.id
    WHERE p.voided_at IS NULL AND p.paid_on <= p_today AND NOT m.excluded_from_totals
  ),
  pg AS (
    SELECT m.id, m.due_date, m.created_at
    FROM m
    ORDER BY m.due_date, m.created_at, m.id
    OFFSET v_offset
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
           'today', p_today,
           'rows', coalesce((
             SELECT jsonb_agg(public.fin__entry_json(p_clinic, pg.id, p_today) ORDER BY pg.due_date, pg.created_at, pg.id)
             FROM pg), '[]'::jsonb),
           'total_count', tot.n,
           'offset', v_offset,
           'limit', v_limit,
           'totals', jsonb_build_object(
             'count', tot.n,
             'incoming_cents', rz.inc,
             'outgoing_cents', rz.outg,
             'open_incoming_cents', tot.open_in,
             'open_outgoing_cents', tot.open_out,
             'net_cents', rz.inc - rz.outg))
    INTO v_result
  FROM tot CROSS JOIN rz;

  RETURN v_result;
END;
$$;

-- Upcoming window and liquidity figures (p3 §5.2, §5.5, §5.6; legacy FM:68-76, FT:12). The window is today plus
-- the next n−1 days plus everything overdue; partial payments count (outstanding, not amount); excluded entries
-- are included (FM:73 ignores exclusions). NULL liquidity propagates.
CREATE OR REPLACE FUNCTION public.fin__forecast_figures(p_clinic uuid, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_days integer;
  v_target bigint;
  v_end date;
  v_in bigint;
  v_out bigint;
  v_snap public.fin_balance_snapshots%ROWTYPE;
  v_liquid bigint;
BEGIN
  -- No literal fallback (owner decision 4): the buffer and the window are data only.
  SELECT s.forecast_days, s.buffer_target_cents INTO v_days, v_target
  FROM public.fin_settings s
  WHERE s.clinic_id = p_clinic;
  IF v_days IS NULL OR v_target IS NULL THEN
    RAISE EXCEPTION 'Finans ayarları bulunamadı.';
  END IF;
  v_end := p_today + (v_days - 1);

  SELECT coalesce(sum(st.outstanding_cents) FILTER (WHERE st.direction = 'in'), 0)::bigint,
         coalesce(sum(st.outstanding_cents) FILTER (WHERE st.direction = 'out'), 0)::bigint
    INTO v_in, v_out
  FROM public.fin__entries_state(p_clinic) st
  WHERE st.outstanding_cents > 0 AND st.due_date <= v_end;

  SELECT * INTO v_snap
  FROM public.fin_balance_snapshots s
  WHERE s.clinic_id = p_clinic AND s.day <= p_today
  ORDER BY s.day DESC
  LIMIT 1;
  IF FOUND THEN
    v_liquid := v_snap.bank_cents + v_snap.cash_cents;
  END IF;

  RETURN jsonb_build_object(
    'window_end', v_end,
    'forecast_days', v_days,
    'expected_in_cents', v_in,
    'expected_out_cents', v_out,
    'liquid_cents', v_liquid,
    'after_payments_cents', v_liquid - v_out,
    'forecast_cents', v_liquid + v_in - v_out,
    'snapshot_id', v_snap.id,
    'snapshot_day', v_snap.day,
    'buffer_target_cents', v_target,
    'buffer_delta_cents', v_liquid - v_target);
END;
$$;

-- Open payables by report group plus receivables (p2 §3.5 fin_open_groups; p3 §5.7; legacy FM:79-81, FP:63).
-- Scope: outstanding > 0 (cancelled entries are out), excluded entries included. 'in' entries count only as
-- receivable. All active groups are listed (even at 0), inactive ones only while they hold an open amount,
-- and the implicit 'Diğer borçlar' row (NULL group) comes last.
CREATE OR REPLACE FUNCTION public.fin__open_groups(p_clinic uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH st AS (
    SELECT s.direction, s.report_group_id, s.outstanding_cents
    FROM public.fin__entries_state(p_clinic) s
    WHERE s.outstanding_cents > 0
  ),
  g AS (
    SELECT st.report_group_id, sum(st.outstanding_cents)::bigint AS amt, count(*)::bigint AS n
    FROM st
    WHERE st.direction = 'out'
    GROUP BY st.report_group_id
  ),
  named AS (
    SELECT rg.id, rg.name, rg.is_active, rg.sort_order,
           coalesce(g.amt, 0)::bigint AS amt, coalesce(g.n, 0)::bigint AS n
    FROM public.fin_report_groups rg
    LEFT JOIN g ON g.report_group_id = rg.id
    WHERE rg.clinic_id = p_clinic AND (rg.is_active OR coalesce(g.amt, 0) > 0)
  ),
  other AS (
    SELECT coalesce(sum(g.amt), 0)::bigint AS amt, coalesce(sum(g.n), 0)::bigint AS n
    FROM g
    WHERE g.report_group_id IS NULL
  ),
  recv AS (
    SELECT coalesce(sum(st.outstanding_cents), 0)::bigint AS amt, count(*)::bigint AS n
    FROM st
    WHERE st.direction = 'in'
  )
  SELECT jsonb_build_object(
           'payable',
             coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'report_group_id', named.id,
                        'name', named.name,
                        'is_active', named.is_active,
                        'sort_order', named.sort_order,
                        'outstanding_cents', named.amt,
                        'entry_count', named.n)
                      ORDER BY named.sort_order, named.name, named.id)
               FROM named), '[]'::jsonb)
             || jsonb_build_array(jsonb_build_object(
                  'report_group_id', NULL::uuid,
                  'name', 'Diğer borçlar',
                  'is_active', true,
                  'sort_order', NULL::integer,
                  'outstanding_cents', other.amt,
                  'entry_count', other.n)),
           'payable_total_cents', (SELECT coalesce(sum(g.amt), 0)::bigint FROM g),
           'other_payable_cents', other.amt,
           'receivable_cents', recv.amt,
           'receivable_entry_count', recv.n)
  FROM other CROSS JOIN recv
$$;

-- Category report for [p_m0, p_m1) (p3 §5.10; legacy FR:12). One row per category, inactive and unused ones
-- included. count / open_* cover all of the category's entries whatever the month; incoming / outgoing only that
-- month's live, non-excluded payments.
CREATE OR REPLACE FUNCTION public.fin__category_report(p_clinic uuid, p_today date, p_m0 date, p_m1 date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH es AS (
    SELECT s.category_id,
           count(*)::bigint AS n,
           coalesce(sum(s.outstanding_cents) FILTER (WHERE s.direction = 'in'), 0)::bigint AS open_in,
           coalesce(sum(s.outstanding_cents) FILTER (WHERE s.direction = 'out'), 0)::bigint AS open_out
    FROM public.fin__entries_state(p_clinic) s
    GROUP BY s.category_id
  ),
  mp AS (
    SELECT lp.category_id,
           coalesce(sum(lp.amount_cents) FILTER (WHERE lp.direction = 'in'), 0)::bigint AS inc,
           coalesce(sum(lp.amount_cents) FILTER (WHERE lp.direction = 'out'), 0)::bigint AS outg
    FROM public.fin__live_payments(p_clinic, p_today) lp
    WHERE NOT lp.excluded_from_totals AND lp.paid_on >= p_m0 AND lp.paid_on < p_m1
    GROUP BY lp.category_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'category_id', c.id,
           'name', c.name,
           'direction', c.direction,
           'report_bucket', c.report_bucket,
           'is_active', c.is_active,
           'count', coalesce(es.n, 0),
           'incoming_cents', coalesce(mp.inc, 0),
           'outgoing_cents', coalesce(mp.outg, 0),
           'open_incoming_cents', coalesce(es.open_in, 0),
           'open_outgoing_cents', coalesce(es.open_out, 0),
           'net_cents', coalesce(mp.inc, 0) - coalesce(mp.outg, 0))
         ORDER BY c.sort_order, c.name, c.id), '[]'::jsonb)
  FROM public.fin_categories c
  LEFT JOIN es ON es.category_id = c.id
  LEFT JOIN mp ON mp.category_id = c.id
  WHERE c.clinic_id = p_clinic
$$;

-- The finance home page in one call (p2 §3.5 fin_dashboard; p3 §5.2-5.7, §5.10). Month figures are cash basis
-- over M = live payments in the month, paid_on <= today, entries not excluded (FM:71-72, FR:13-26).
CREATE OR REPLACE FUNCTION public.fin__dashboard(p_clinic uuid, p_today date, p_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_m0 date := public.fin__report_month(p_month, p_today);
  v_m1 date;
  v_receipts bigint;
  v_inflow bigint;
  v_outflow bigint;
  v_profit_income bigint;
  v_profit_expense bigint;
  v_loan bigint;
  v_doctor bigint;
  v_doctor_current bigint;
  v_doctor_past bigint;
  v_lab bigint;
  v_personnel bigint;
  v_rent bigint;
  v_supplies bigint;
  v_tax bigint;
  v_other_expense bigint;
  v_fees bigint;
  v_principal bigint;
  v_asset bigint;
  v_distribution bigint;
  v_profit bigint;
  v_excluded_n bigint;
  v_excluded_paid bigint;
  v_excluded_month_n bigint;
  v_settings public.fin_settings%ROWTYPE;
  v_forecast jsonb;
  v_snapshot_id uuid;
BEGIN
  v_m1 := (v_m0 + interval '1 month')::date;

  SELECT
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'patient_receipts'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.direction = 'in'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.direction = 'out'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.profit_class = 'income'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.profit_class = 'expense'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'principal'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'doctor'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'doctor' AND NOT lp.is_past), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'doctor' AND lp.is_past), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'lab'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'personnel'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'rent'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'supplies'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'tax'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'other_expense'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'fees'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'principal'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'asset'), 0)::bigint,
    coalesce(sum(lp.amount_cents) FILTER (WHERE lp.report_bucket = 'distribution'), 0)::bigint
  INTO v_receipts, v_inflow, v_outflow, v_profit_income, v_profit_expense, v_loan,
       v_doctor, v_doctor_current, v_doctor_past, v_lab, v_personnel, v_rent, v_supplies,
       v_tax, v_other_expense, v_fees, v_principal, v_asset, v_distribution
  FROM public.fin__live_payments(p_clinic, p_today) lp
  WHERE NOT lp.excluded_from_totals
    AND lp.paid_on >= v_m0
    AND lp.paid_on < v_m1;

  -- 'Tahsilat esaslı faaliyet sonucu': patient receipts only, minus every expense-class payment (FM:82, C2).
  v_profit := v_receipts - v_profit_expense;

  SELECT count(*)::bigint INTO v_excluded_n
  FROM public.fin_entries e
  WHERE e.clinic_id = p_clinic AND e.excluded_from_totals;

  SELECT coalesce(sum(lp.amount_cents), 0)::bigint, count(DISTINCT lp.entry_id)::bigint
    INTO v_excluded_paid, v_excluded_month_n
  FROM public.fin__live_payments(p_clinic, p_today) lp
  WHERE lp.excluded_from_totals AND lp.paid_on >= v_m0 AND lp.paid_on < v_m1;

  SELECT * INTO v_settings FROM public.fin_settings s WHERE s.clinic_id = p_clinic;
  v_forecast := public.fin__forecast_figures(p_clinic, p_today);
  v_snapshot_id := public.fin__current_snapshot_id(p_clinic, p_today);

  -- exclusions.entry_count = every excluded entry (any month); entry_count_in_month = excluded entries with a live
  -- payment in the selected month, whose sum is paid_cents_in_month.
  RETURN jsonb_build_object(
    'today', p_today,
    'month', to_char(v_m0, 'YYYY-MM'),
    'is_current_month', v_m0 = public.fin__month_start(p_today),
    'settings', jsonb_build_object(
      'buffer_target_cents', v_forecast -> 'buffer_target_cents',
      'forecast_days', v_forecast -> 'forecast_days',
      'physician_fee_note', v_settings.physician_fee_note),
    'liquidity', jsonb_build_object(
      'snapshot', CASE WHEN v_snapshot_id IS NULL THEN NULL
                       ELSE public.fin__snapshot_json(p_clinic, v_snapshot_id, p_today) END,
      'liquid_cents', v_forecast -> 'liquid_cents'),
    'month_summary', jsonb_build_object(
      'receipts_cents', v_receipts,
      'inflow_cents', v_inflow,
      'outflow_cents', v_outflow,
      'net_cents', v_inflow - v_outflow,
      'profit_income_cents', v_profit_income,
      'profit_expense_cents', v_profit_expense,
      'loan_payments_cents', v_loan,
      'other_payments_cents', v_outflow - v_profit_expense - v_loan,
      'after_all_payments_cents', v_profit_income - v_outflow,
      'profit_cents', v_profit,
      'current_period_result_cents', v_profit + v_doctor_past),
    'expenses', jsonb_build_object(
      'by_bucket', jsonb_build_object(
        'doctor', v_doctor,
        'lab', v_lab,
        'personnel', v_personnel,
        'rent', v_rent,
        'supplies', v_supplies,
        'tax', v_tax,
        'other_expense', v_other_expense,
        'fees', v_fees,
        'principal', v_principal,
        'asset', v_asset,
        'distribution', v_distribution),
      'current_doctor_cents', v_doctor_current,
      'past_doctor_cents', v_doctor_past,
      'general_cents', v_tax + v_other_expense,
      'operational_cents', v_doctor + v_lab + v_supplies + v_personnel + v_rent + v_tax + v_other_expense + v_fees),
    'forecast', jsonb_build_object(
      'window_end', v_forecast -> 'window_end',
      'forecast_days', v_forecast -> 'forecast_days',
      'expected_in_cents', v_forecast -> 'expected_in_cents',
      'expected_out_cents', v_forecast -> 'expected_out_cents',
      'after_payments_cents', v_forecast -> 'after_payments_cents',
      'forecast_cents', v_forecast -> 'forecast_cents'),
    'buffer', jsonb_build_object(
      'target_cents', v_forecast -> 'buffer_target_cents',
      'liquid_cents', v_forecast -> 'liquid_cents',
      'delta_cents', v_forecast -> 'buffer_delta_cents'),
    'groups', public.fin__open_groups(p_clinic),
    'category_report', public.fin__category_report(p_clinic, p_today, v_m0, v_m1),
    'exclusions', jsonb_build_object(
      'entry_count', v_excluded_n,
      'entry_count_in_month', v_excluded_month_n,
      'paid_cents_in_month', v_excluded_paid));
END;
$$;

-- Cariler (p2 §3.5 fin_counterparty_ledger; p3 §5.8; legacy FM:77-82, FP:70). One row per master counterparty,
-- or per normalized free text when an entry has no master row (the oldest entry's text is shown). Open sums
-- include excluded entries; paid_in / paid_out are lifetime realized (voided and excluded skipped).
CREATE OR REPLACE FUNCTION public.fin__counterparty_ledger(
  p_clinic uuid, p_today date, p_query text, p_include_settled boolean, p_offset integer, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_settled boolean := coalesce(p_include_settled, false);
  v_offset integer := coalesce(p_offset, 0);
  v_limit integer := coalesce(p_limit, 50);
  v_result jsonb;
BEGIN
  IF char_length(v_query) > 100 OR v_offset < 0 OR v_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;

  -- Grouped by counterparty_key only: a free-text entry that resolves to a master (fin__entries_state) shares the
  -- master's 'id:' key and is counted in the master's row; only unresolved text keys become their own rows.
  WITH agg AS (
    SELECT st.counterparty_key AS k,
           (array_agg(st.counterparty_text ORDER BY st.created_at, st.id)
              FILTER (WHERE st.counterparty_text IS NOT NULL))[1] AS first_text,
           coalesce(sum(st.outstanding_cents) FILTER (WHERE st.direction = 'in'), 0)::bigint AS receivable,
           coalesce(sum(st.outstanding_cents) FILTER (WHERE st.direction = 'out'), 0)::bigint AS payable,
           count(*) FILTER (WHERE st.outstanding_cents > 0)::bigint AS open_n,
           max(st.due_date) AS last_due
    FROM public.fin__entries_state(p_clinic) st
    GROUP BY st.counterparty_key
  ),
  paid AS (
    SELECT lp.counterparty_key AS k,
           coalesce(sum(lp.amount_cents) FILTER (WHERE lp.direction = 'in'), 0)::bigint AS paid_in,
           coalesce(sum(lp.amount_cents) FILTER (WHERE lp.direction = 'out'), 0)::bigint AS paid_out
    FROM public.fin__live_payments(p_clinic, p_today) lp
    WHERE NOT lp.excluded_from_totals
    GROUP BY lp.counterparty_key
  ),
  keys AS (
    SELECT 'id:' || cp.id::text AS k, cp.id AS counterparty_id, NULL::text AS counterparty_text,
           cp.name AS display_name, cp.kind, cp.is_active, cp.doctor_id, cp.report_group_id
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = p_clinic
    UNION ALL
    SELECT agg.k, NULL::uuid, agg.first_text, agg.first_text, NULL::text, NULL::boolean, NULL::uuid, NULL::uuid
    FROM agg
    WHERE left(agg.k, 5) = 'text:'
  ),
  r AS (
    SELECT keys.k, keys.counterparty_id, keys.counterparty_text, keys.display_name, keys.kind, keys.is_active,
           keys.doctor_id, keys.report_group_id,
           coalesce(agg.receivable, 0)::bigint AS receivable,
           coalesce(agg.payable, 0)::bigint AS payable,
           coalesce(agg.open_n, 0)::bigint AS open_n,
           agg.last_due,
           coalesce(paid.paid_in, 0)::bigint AS paid_in,
           coalesce(paid.paid_out, 0)::bigint AS paid_out
    FROM keys
    LEFT JOIN agg ON agg.k = keys.k
    LEFT JOIN paid ON paid.k = keys.k
    WHERE (v_settled OR coalesce(agg.receivable, 0) + coalesce(agg.payable, 0) > 0)
      AND (v_query IS NULL
           OR strpos(public.fin__tr_lower(keys.display_name), public.fin__tr_lower(v_query)) > 0)
  ),
  tot AS (
    SELECT count(*)::bigint AS n,
           coalesce(sum(r.receivable), 0)::bigint AS receivable,
           coalesce(sum(r.payable), 0)::bigint AS payable
    FROM r
  ),
  pg AS (
    SELECT r.*
    FROM r
    ORDER BY r.display_name COLLATE "tr-x-icu", r.k
    OFFSET v_offset
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
           'rows', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'counterparty_id', pg.counterparty_id,
                      'counterparty_text', pg.counterparty_text,
                      'name', pg.display_name,
                      'kind', pg.kind,
                      'is_active', pg.is_active,
                      'doctor_name', u.full_name,
                      'report_group_name', g.name,
                      'receivable_cents', pg.receivable,
                      'payable_cents', pg.payable,
                      'net_cents', pg.receivable - pg.payable,
                      'open_entry_count', pg.open_n,
                      'paid_in_cents', pg.paid_in,
                      'paid_out_cents', pg.paid_out,
                      'last_due_date', pg.last_due)
                    ORDER BY pg.display_name COLLATE "tr-x-icu", pg.k)
             FROM pg
             LEFT JOIN public.doctors d ON d.id = pg.doctor_id AND d.clinic_id = p_clinic
             LEFT JOIN public.users u ON u.id = d.user_id
             LEFT JOIN public.fin_report_groups g ON g.clinic_id = p_clinic AND g.id = pg.report_group_id
           ), '[]'::jsonb),
           'total_count', tot.n,
           'offset', v_offset,
           'limit', v_limit,
           'totals', jsonb_build_object(
             'receivable_cents', tot.receivable,
             'payable_cents', tot.payable,
             'net_cents', tot.receivable - tot.payable))
    INTO v_result
  FROM tot;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3.1 Reference data and master-data RPCs.
--     Shared rules: p_id is the client uuid, p_version = 0 means create. Create retry with an id already in the
--     clinic → already_saved; an id of another clinic → E_ID_TAKEN. Update: not found → E_NOT_FOUND, no-op →
--     already_saved (checked before the version, legacy RT:119 before RT:120), else the version must match.
--     Names are unique per clinic on fin__normalize_name (E_NAME_TAKEN, DETAIL = existing id). No deletes.
-- ---------------------------------------------------------------------------

-- Everything the finance forms and the settings screen need, without money figures. Inactive rows included.
CREATE OR REPLACE FUNCTION public.fin_reference_data()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
BEGIN
  RETURN jsonb_build_object(
    'today', v_today,
    'current_month', to_char(v_today, 'YYYY-MM'),
    'can_write', public.has_permission('finance'),
    'settings', public.fin__settings_json(v_clinic),
    'accounts', coalesce((
      SELECT jsonb_agg(public.fin__account_json(v_clinic, a.id) ORDER BY a.sort_order, a.name COLLATE "tr-x-icu", a.id)
      FROM public.fin_accounts a
      WHERE a.clinic_id = v_clinic), '[]'::jsonb),
    'report_groups', coalesce((
      SELECT jsonb_agg(public.fin__report_group_json(v_clinic, g.id) ORDER BY g.sort_order, g.name COLLATE "tr-x-icu", g.id)
      FROM public.fin_report_groups g
      WHERE g.clinic_id = v_clinic), '[]'::jsonb),
    'categories', coalesce((
      SELECT jsonb_agg(public.fin__category_json(v_clinic, c.id) ORDER BY c.sort_order, c.name COLLATE "tr-x-icu", c.id)
      FROM public.fin_categories c
      WHERE c.clinic_id = v_clinic), '[]'::jsonb),
    'counterparties', coalesce((
      SELECT jsonb_agg(public.fin__counterparty_json(v_clinic, cp.id) ORDER BY cp.name COLLATE "tr-x-icu", cp.id)
      FROM public.fin_counterparties cp
      WHERE cp.clinic_id = v_clinic), '[]'::jsonb),
    'doctors', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'doctor_id', d.id,
               'full_name', u.full_name,
               'is_active', coalesce(u.is_active, false),
               'counterparty_id', cp.id)
             ORDER BY u.full_name COLLATE "tr-x-icu", d.id)
      FROM public.doctors d
      JOIN public.users u ON u.id = d.user_id
      LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = v_clinic AND cp.doctor_id = d.id
      WHERE d.clinic_id = v_clinic), '[]'::jsonb));
END;
$$;

-- Settings (p2 §3.1): buffer target and window replace legacy FM:76 / FM:73; the physician fee note replaces the
-- hard-coded '%4 dahil' text (FP:65, IP:55, IP:67); entitlement account replaces the forced 'Nakit' (IP:55).
CREATE OR REPLACE FUNCTION public.fin_save_settings(
  p_version integer,
  p_buffer_target_cents bigint,
  p_forecast_days integer,
  p_physician_fee_note text,
  p_report_brand_name text,
  p_entitlement_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_settings%ROWTYPE;
  v_note text;
  v_brand text;
BEGIN
  IF p_buffer_target_cents IS NULL OR p_buffer_target_cents NOT BETWEEN 0 AND 1000000000000
     OR p_forecast_days IS NULL OR p_forecast_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'Tampon hedefi 0 ile 10.000.000.000 TL, plan süresi 1 ile 90 gün arasında olmalı.';
  END IF;
  v_note := nullif(public.fin__note(p_physician_fee_note, 500), '');
  v_brand := nullif(btrim(coalesce(p_report_brand_name, '')), '');
  IF char_length(v_brand) > 120 THEN
    RAISE EXCEPTION 'Rapor adı en fazla 120 karakter olabilir.';
  END IF;

  SELECT * INTO v_row FROM public.fin_settings s WHERE s.clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  IF (v_row.buffer_target_cents, v_row.forecast_days, v_row.physician_fee_note, v_row.report_brand_name,
      v_row.entitlement_account_id)
     IS NOT DISTINCT FROM
     (p_buffer_target_cents, p_forecast_days, v_note, v_brand, p_entitlement_account_id) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__settings_json(v_clinic));
  END IF;

  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  -- A newly chosen account must be active; an unchanged one is kept even if it was deactivated since.
  IF p_entitlement_account_id IS NOT NULL
     AND p_entitlement_account_id IS DISTINCT FROM v_row.entitlement_account_id THEN
    PERFORM public.fin__check_account(v_clinic, p_entitlement_account_id);
  END IF;

  UPDATE public.fin_settings s
  SET buffer_target_cents = p_buffer_target_cents,
      forecast_days = p_forecast_days,
      physician_fee_note = v_note,
      report_brand_name = v_brand,
      entitlement_account_id = p_entitlement_account_id
  WHERE s.id = v_row.id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__settings_json(v_clinic));
END;
$$;

-- Accounts. import_key is not writable in Phase 1 (Phase 2 mapper, C10).
CREATE OR REPLACE FUNCTION public.fin_save_account(
  p_id uuid,
  p_version integer,
  p_name text,
  p_kind text,
  p_bank_name text,
  p_is_active boolean,
  p_sort_order integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_accounts%ROWTYPE;
  v_name text;
  v_bank text;
  v_active boolean := coalesce(p_is_active, true);
  v_sort integer;
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_name := public.fin__name(p_name, 80);
  IF p_kind IS NULL OR p_kind NOT IN ('bank', 'cash', 'pos', 'mixed') THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;
  v_bank := nullif(btrim(coalesce(p_bank_name, '')), '');
  IF char_length(v_bank) > 80 THEN
    RAISE EXCEPTION 'Banka adı en fazla 80 karakter olabilir.';
  END IF;
  v_sort := public.fin__sort_order(p_sort_order);

  -- Only rows of the caller's clinic are read or locked. An id that belongs to another clinic looks unknown here:
  -- a version-0 create then hits INSERT ... ON CONFLICT (id) DO NOTHING and gets 'Kayıt kaydedilemedi.' (PT409).
  SELECT * INTO v_row FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = p_id FOR UPDATE;

  IF p_version = 0 THEN
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__account_json(v_clinic, p_id));
    END IF;
    SELECT a.id INTO v_other
    FROM public.fin_accounts a
    WHERE a.clinic_id = v_clinic AND public.fin__normalize_name(a.name) = public.fin__normalize_name(v_name)
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
    END IF;
    BEGIN
      INSERT INTO public.fin_accounts (id, clinic_id, name, kind, bank_name, is_active, sort_order, created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, p_kind, v_bank, v_active, v_sort,
              public.current_app_user_id(), public.current_app_user_id())
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_accounts a WHERE a.id = p_id AND a.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__account_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('already_saved', false, 'record', public.fin__account_json(v_clinic, p_id));
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF (v_row.name, v_row.kind, v_row.bank_name, v_row.is_active, v_row.sort_order)
     IS NOT DISTINCT FROM (v_name, p_kind, v_bank, v_active, v_sort) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__account_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_kind <> v_row.kind
     AND (EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.account_id = p_id)
          OR EXISTS (SELECT 1 FROM public.fin_balance_sources src WHERE src.account_id = p_id)) THEN
    RAISE EXCEPTION 'Kullanılmış hesabın türü değiştirilemez.';
  END IF;
  SELECT a.id INTO v_other
  FROM public.fin_accounts a
  WHERE a.clinic_id = v_clinic AND a.id <> p_id
    AND public.fin__normalize_name(a.name) = public.fin__normalize_name(v_name)
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  BEGIN
    UPDATE public.fin_accounts a
    SET name = v_name, kind = p_kind, bank_name = v_bank, is_active = v_active, sort_order = v_sort
    WHERE a.clinic_id = v_clinic AND a.id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
  END;
  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__account_json(v_clinic, p_id));
END;
$$;

-- Report groups: replace the hard-coded Alp / Baykara / Lab groups (FM:79-81, FP:63) with owner data.
CREATE OR REPLACE FUNCTION public.fin_save_report_group(
  p_id uuid,
  p_version integer,
  p_name text,
  p_is_active boolean,
  p_sort_order integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_report_groups%ROWTYPE;
  v_name text;
  v_active boolean := coalesce(p_is_active, true);
  v_sort integer;
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_name := public.fin__name(p_name, 80);
  v_sort := public.fin__sort_order(p_sort_order);

  -- Only rows of the caller's clinic are read or locked. An id that belongs to another clinic looks unknown here:
  -- a version-0 create then hits INSERT ... ON CONFLICT (id) DO NOTHING and gets 'Kayıt kaydedilemedi.' (PT409).
  SELECT * INTO v_row FROM public.fin_report_groups g WHERE g.clinic_id = v_clinic AND g.id = p_id FOR UPDATE;

  IF p_version = 0 THEN
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__report_group_json(v_clinic, p_id));
    END IF;
    SELECT g.id INTO v_other
    FROM public.fin_report_groups g
    WHERE g.clinic_id = v_clinic AND public.fin__normalize_name(g.name) = public.fin__normalize_name(v_name)
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
    END IF;
    BEGIN
      INSERT INTO public.fin_report_groups (id, clinic_id, name, is_active, sort_order, created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, v_active, v_sort, public.current_app_user_id(), public.current_app_user_id())
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_report_groups g WHERE g.id = p_id AND g.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__report_group_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('already_saved', false, 'record', public.fin__report_group_json(v_clinic, p_id));
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF (v_row.name, v_row.is_active, v_row.sort_order) IS NOT DISTINCT FROM (v_name, v_active, v_sort) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__report_group_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  SELECT g.id INTO v_other
  FROM public.fin_report_groups g
  WHERE g.clinic_id = v_clinic AND g.id <> p_id
    AND public.fin__normalize_name(g.name) = public.fin__normalize_name(v_name)
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  BEGIN
    UPDATE public.fin_report_groups g
    SET name = v_name, is_active = v_active, sort_order = v_sort
    WHERE g.clinic_id = v_clinic AND g.id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
  END;
  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__report_group_json(v_clinic, p_id));
END;
$$;

-- Report group reference check shared by categories and counterparties: NULL, or a group of the clinic; a newly
-- chosen group must be active (an unchanged inactive one is kept). E_REPORT_GROUP.
CREATE OR REPLACE FUNCTION public.fin__check_report_group(p_clinic uuid, p_group_id uuid, p_old_group_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_active boolean;
BEGIN
  IF p_group_id IS NULL THEN
    RETURN;
  END IF;
  SELECT g.is_active INTO v_active
  FROM public.fin_report_groups g
  WHERE g.clinic_id = p_clinic AND g.id = p_group_id;
  IF v_active IS NULL THEN
    RAISE EXCEPTION 'Rapor grubu bulunamadı.';
  END IF;
  IF NOT v_active AND p_group_id IS DISTINCT FROM p_old_group_id THEN
    RAISE EXCEPTION 'Pasif rapor grubu seçilemez.';
  END IF;
END;
$$;

-- Categories (p1 §1.4). direction / profit_class are derived from the bucket; the bucket never changes.
CREATE OR REPLACE FUNCTION public.fin_save_category(
  p_id uuid,
  p_version integer,
  p_name text,
  p_report_bucket text,
  p_report_group_id uuid,
  p_is_active boolean,
  p_sort_order integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_categories%ROWTYPE;
  v_name text;
  v_active boolean := coalesce(p_is_active, true);
  v_sort integer;
  v_direction text;
  v_profit_class text;
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_name := public.fin__name(p_name, 80);
  v_sort := public.fin__sort_order(p_sort_order);

  SELECT CASE p_report_bucket
           WHEN 'patient_receipts' THEN 'in' WHEN 'other_income' THEN 'in' WHEN 'capital' THEN 'in'
           WHEN 'rent' THEN 'out' WHEN 'doctor' THEN 'out' WHEN 'lab' THEN 'out' WHEN 'supplies' THEN 'out'
           WHEN 'personnel' THEN 'out' WHEN 'tax' THEN 'out' WHEN 'other_expense' THEN 'out'
           WHEN 'distribution' THEN 'out' WHEN 'principal' THEN 'out' WHEN 'fees' THEN 'out' WHEN 'asset' THEN 'out'
         END,
         CASE p_report_bucket
           WHEN 'patient_receipts' THEN 'income' WHEN 'other_income' THEN 'income'
           WHEN 'distribution' THEN 'none' WHEN 'capital' THEN 'none' WHEN 'principal' THEN 'none'
           WHEN 'asset' THEN 'none'
           WHEN 'rent' THEN 'expense' WHEN 'doctor' THEN 'expense' WHEN 'lab' THEN 'expense'
           WHEN 'supplies' THEN 'expense' WHEN 'personnel' THEN 'expense' WHEN 'tax' THEN 'expense'
           WHEN 'other_expense' THEN 'expense' WHEN 'fees' THEN 'expense'
         END
    INTO v_direction, v_profit_class;
  IF v_direction IS NULL THEN
    RAISE EXCEPTION 'Geçersiz rapor türü.';
  END IF;

  -- Only rows of the caller's clinic are read or locked. An id that belongs to another clinic looks unknown here:
  -- a version-0 create then hits INSERT ... ON CONFLICT (id) DO NOTHING and gets 'Kayıt kaydedilemedi.' (PT409).
  SELECT * INTO v_row FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = p_id FOR UPDATE;

  IF p_version = 0 THEN
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__category_json(v_clinic, p_id));
    END IF;
    IF p_report_group_id IS NOT NULL AND v_direction <> 'out' THEN
      RAISE EXCEPTION 'Rapor grubu yalnızca gider / ödeme kategorilerinde kullanılabilir.';
    END IF;
    PERFORM public.fin__check_report_group(v_clinic, p_report_group_id, NULL);
    SELECT c.id INTO v_other
    FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND public.fin__normalize_name(c.name) = public.fin__normalize_name(v_name)
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
    END IF;
    BEGIN
      INSERT INTO public.fin_categories (id, clinic_id, name, direction, profit_class, report_bucket, report_group_id,
                                         is_system, is_active, sort_order, created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, v_direction, v_profit_class, p_report_bucket, p_report_group_id,
              false, v_active, v_sort, public.current_app_user_id(), public.current_app_user_id())
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_categories c WHERE c.id = p_id AND c.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__category_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('already_saved', false, 'record', public.fin__category_json(v_clinic, p_id));
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF p_report_bucket IS DISTINCT FROM v_row.report_bucket THEN
    RAISE EXCEPTION 'Kategorinin rapor türü değiştirilemez.';
  END IF;
  IF (v_row.name, v_row.report_group_id, v_row.is_active, v_row.sort_order)
     IS NOT DISTINCT FROM (v_name, p_report_group_id, v_active, v_sort) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__category_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_report_group_id IS NOT NULL AND v_row.direction <> 'out' THEN
    RAISE EXCEPTION 'Rapor grubu yalnızca gider / ödeme kategorilerinde kullanılabilir.';
  END IF;
  PERFORM public.fin__check_report_group(v_clinic, p_report_group_id, v_row.report_group_id);
  -- The entitlement flow needs the system physician category (fin_add_entitlement).
  IF v_row.is_system AND v_row.report_bucket = 'doctor' AND NOT v_active THEN
    RAISE EXCEPTION 'Hekim hakedişi sistem kategorisi pasif yapılamaz.';
  END IF;
  SELECT c.id INTO v_other
  FROM public.fin_categories c
  WHERE c.clinic_id = v_clinic AND c.id <> p_id
    AND public.fin__normalize_name(c.name) = public.fin__normalize_name(v_name)
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  BEGIN
    UPDATE public.fin_categories c
    SET name = v_name, report_group_id = p_report_group_id, is_active = v_active, sort_order = v_sort
    WHERE c.clinic_id = v_clinic AND c.id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
  END;
  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__category_json(v_clinic, p_id));
END;
$$;

-- Counterparties (Cariler master). A duplicate normalized name → E_NAME_TAKEN with the existing id in DETAIL, so
-- the UI can offer "Mevcut kaydı kullan".
CREATE OR REPLACE FUNCTION public.fin_save_counterparty(
  p_id uuid,
  p_version integer,
  p_name text,
  p_kind text,
  p_doctor_id uuid,
  p_report_group_id uuid,
  p_note text,
  p_is_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_counterparties%ROWTYPE;
  v_name text;
  v_note text;
  v_active boolean := coalesce(p_is_active, true);
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_name := public.fin__name(p_name, 200);
  IF p_kind IS NULL OR p_kind NOT IN ('physician', 'lab', 'supplier', 'landlord', 'bank', 'staff', 'partner', 'tax', 'other') THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;
  v_note := public.fin__note(p_note, 500);

  -- Only rows of the caller's clinic are read or locked. An id that belongs to another clinic looks unknown here:
  -- a version-0 create then hits INSERT ... ON CONFLICT (id) DO NOTHING and gets 'Kayıt kaydedilemedi.' (PT409).
  SELECT * INTO v_row FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__counterparty_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.name, v_row.kind, v_row.doctor_id, v_row.report_group_id, v_row.note, v_row.is_active)
       IS NOT DISTINCT FROM (v_name, p_kind, p_doctor_id, p_report_group_id, v_note, v_active) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__counterparty_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF p_doctor_id IS NOT NULL THEN
    IF p_kind <> 'physician' THEN
      RAISE EXCEPTION 'Hekim bağlantısı yalnızca hekim türündeki kayıtlarda kullanılabilir.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic) THEN
      RAISE EXCEPTION 'Hekim bulunamadı.';
    END IF;
    SELECT cp.id INTO v_other
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.doctor_id = p_doctor_id AND cp.id <> p_id
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'Bu hekim başka bir kişi / kurum kaydına bağlı.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
    END IF;
  END IF;
  PERFORM public.fin__check_report_group(v_clinic, p_report_group_id, v_row.report_group_id);

  SELECT cp.id INTO v_other
  FROM public.fin_counterparties cp
  WHERE cp.clinic_id = v_clinic AND cp.id <> p_id AND cp.normalized_name = public.fin__normalize_name(v_name)
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  IF p_version = 0 THEN
    BEGIN
      INSERT INTO public.fin_counterparties (id, clinic_id, name, normalized_name, kind, doctor_id, report_group_id,
                                             note, is_active, created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, public.fin__normalize_name(v_name), p_kind, p_doctor_id, p_report_group_id,
              v_note, v_active, public.current_app_user_id(), public.current_app_user_id())
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_counterparties cp WHERE cp.id = p_id AND cp.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__counterparty_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    BEGIN
      UPDATE public.fin_counterparties cp
      SET name = v_name, kind = p_kind, doctor_id = p_doctor_id, report_group_id = p_report_group_id,
          note = v_note, is_active = v_active
      WHERE cp.clinic_id = v_clinic AND cp.id = p_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__counterparty_json(v_clinic, p_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 3.2 Entry and payment write RPCs. Each returns { already_saved, entry: EntryJson, payments: [PaymentJson] }.
--     Write order (legacy RT:116-120): permission → input shape → lock the entry → not found → idempotency /
--     no-op (before the version) → version → business rules → write. Every payment change bumps the entry
--     version through fin_touch.
-- ---------------------------------------------------------------------------

-- Shared entry input normalisation for create and edit (p2 §3.2): amount, date, description; exactly one of
-- counterparty id / text (a text equal to an active master's normalized name is linked to that master, FM:77-80);
-- category of the clinic; subcategory by bucket (FM:26, FP:20); entitlement month only for the doctor bucket.
-- Active checks are left to the caller (create: always; edit: only when changed).
CREATE OR REPLACE FUNCTION public.fin__entry_input(
  p_clinic uuid,
  p_category_id uuid,
  p_subcategory text,
  p_counterparty_id uuid,
  p_counterparty_text text,
  p_description text,
  p_due_date date,
  p_amount_cents bigint,
  p_entitlement_month text,
  OUT o_category_id uuid,
  OUT o_bucket text,
  OUT o_category_active boolean,
  OUT o_subcategory text,
  OUT o_counterparty_id uuid,
  OUT o_counterparty_text text,
  OUT o_counterparty_active boolean,
  OUT o_description text,
  OUT o_due_date date,
  OUT o_amount_cents bigint,
  OUT o_entitlement_month date)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_text text := nullif(btrim(coalesce(p_counterparty_text, '')), '');
  v_match uuid;
BEGIN
  o_amount_cents := public.fin__amount(p_amount_cents);
  o_due_date := public.fin__day(p_due_date);
  o_description := btrim(coalesce(p_description, ''));
  IF char_length(o_description) > 1000 THEN
    RAISE EXCEPTION 'Açıklama en fazla 1000 karakter olabilir.';
  END IF;

  IF (p_counterparty_id IS NULL) = (v_text IS NULL) OR char_length(v_text) > 200 THEN
    RAISE EXCEPTION 'Kişi / kurum seçin veya yazın (en fazla 200 karakter).';
  END IF;
  IF p_counterparty_id IS NOT NULL THEN
    SELECT cp.id, cp.is_active INTO o_counterparty_id, o_counterparty_active
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = p_clinic AND cp.id = p_counterparty_id;
    IF o_counterparty_id IS NULL THEN
      RAISE EXCEPTION 'Kişi / kurum bulunamadı.';
    END IF;
  ELSE
    SELECT cp.id INTO v_match
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = p_clinic AND cp.is_active AND cp.normalized_name = public.fin__normalize_name(v_text)
    LIMIT 1;
    IF v_match IS NOT NULL THEN
      o_counterparty_id := v_match;
    ELSE
      o_counterparty_text := v_text;
    END IF;
    o_counterparty_active := true;
  END IF;

  SELECT c.id, c.report_bucket, c.is_active INTO o_category_id, o_bucket, o_category_active
  FROM public.fin_categories c
  WHERE c.clinic_id = p_clinic AND c.id = p_category_id;
  IF o_category_id IS NULL THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;

  o_subcategory := nullif(btrim(coalesce(p_subcategory, '')), '');
  IF o_bucket = 'doctor' THEN
    o_subcategory := coalesce(o_subcategory, 'current_physician');
    IF o_subcategory NOT IN ('current_physician', 'past_physician_debt') THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF o_bucket = 'other_expense' THEN
    IF o_subcategory IS NOT NULL AND o_subcategory <> 'official_fee' THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF o_subcategory IS NOT NULL THEN
    RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
  END IF;

  o_entitlement_month := public.fin__month(p_entitlement_month);
  IF o_entitlement_month IS NOT NULL AND o_bucket <> 'doctor' THEN
    RAISE EXCEPTION 'Hakediş ayı yalnızca hekim hakedişi kayıtlarında kullanılabilir.';
  END IF;
END;
$$;

-- Create, planned or realized (legacy create RT:21, RT:109-114; FP:46; FF:15). A realized entry gets one payment
-- whose id is the entry id (RT:111, C24); the entry stays at version 1.
CREATE OR REPLACE FUNCTION public.fin_create_entry(
  p_id uuid,
  p_category_id uuid,
  p_subcategory text,
  p_counterparty_id uuid,
  p_counterparty_text text,
  p_description text,
  p_due_date date,
  p_amount_cents bigint,
  p_entitlement_month text,
  p_realized boolean,
  p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date := public.clinic_today();
  v_user uuid := public.current_app_user_id();
  v_realized boolean := coalesce(p_realized, false);
  v_in record;
  v_owner uuid;
  v_n integer := 0;
  v_attempt integer := 0;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;

  LOOP
    v_attempt := v_attempt + 1;

    -- Idempotency (RT:114): the same id in this clinic is the earlier success; the payload is not compared.
    SELECT e.clinic_id INTO v_owner FROM public.fin_entries e WHERE e.id = p_id;
    IF v_owner IS NOT NULL THEN
      IF v_owner = v_clinic THEN
        RETURN public.fin__entry_envelope(v_clinic, p_id, true);
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    IF v_attempt > 2 THEN
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;

    SELECT * INTO v_in
    FROM public.fin__entry_input(v_clinic, p_category_id, p_subcategory, p_counterparty_id, p_counterparty_text,
                                 p_description, p_due_date, p_amount_cents, p_entitlement_month);
    IF NOT v_in.o_category_active THEN
      RAISE EXCEPTION 'Pasif kategori seçilemez.';
    END IF;
    IF NOT v_in.o_counterparty_active THEN
      RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
    END IF;

    IF v_realized THEN
      IF v_in.o_due_date > v_today THEN
        RAISE EXCEPTION 'Gerçekleşmiş işlem için gelecek tarih seçilemez.';
      END IF;
      PERFORM public.fin__check_account(v_clinic, p_account_id);
    END IF;

    INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                    description, due_date, amount_cents, entitlement_month, created_by, updated_by)
    VALUES (p_id, v_clinic, v_in.o_category_id, v_in.o_subcategory, v_in.o_counterparty_id, v_in.o_counterparty_text,
            v_in.o_description, v_in.o_due_date, v_in.o_amount_cents, v_in.o_entitlement_month, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXIT WHEN v_n = 1;
    -- A concurrent request inserted the same id first: the next pass answers it.
  END LOOP;

  IF v_realized THEN
    BEGIN
      INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id,
                                       recorded_by, updated_by)
      VALUES (p_id, v_clinic, p_id, v_in.o_due_date, v_in.o_amount_cents, p_account_id, v_user, v_user);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN public.fin__entry_envelope(v_clinic, p_id, false);
END;
$$;

-- Edit: replaces every editable field (legacy edit RT:22, RT:126-129, {...previous, ...c.data}).
CREATE OR REPLACE FUNCTION public.fin_edit_entry(
  p_id uuid,
  p_version integer,
  p_category_id uuid,
  p_subcategory text,
  p_counterparty_id uuid,
  p_counterparty_text text,
  p_description text,
  p_due_date date,
  p_amount_cents bigint,
  p_entitlement_month text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_e public.fin_entries%ROWTYPE;
  v_in record;
  v_paid bigint;
BEGIN
  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  SELECT * INTO v_in
  FROM public.fin__entry_input(v_clinic, p_category_id, p_subcategory, p_counterparty_id, p_counterparty_text,
                               p_description, p_due_date, p_amount_cents, p_entitlement_month);

  IF (v_e.category_id, v_e.subcategory, v_e.counterparty_id, v_e.counterparty_text, v_e.description, v_e.due_date,
      v_e.amount_cents, v_e.entitlement_month)
     IS NOT DISTINCT FROM
     (v_in.o_category_id, v_in.o_subcategory, v_in.o_counterparty_id, v_in.o_counterparty_text, v_in.o_description,
      v_in.o_due_date, v_in.o_amount_cents, v_in.o_entitlement_month) THEN
    RETURN public.fin__entry_envelope(v_clinic, p_id, true);
  END IF;

  IF p_version IS DISTINCT FROM v_e.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF v_e.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş kayıt düzenlenemez.';
  END IF;

  v_paid := public.fin__paid(v_e.id);
  IF v_paid > 0 AND (v_in.o_category_id <> v_e.category_id OR v_in.o_amount_cents < v_paid) THEN
    RAISE EXCEPTION 'Gerçekleşmiş ödemelerin kategorisi değiştirilemez; tutar ödenenden düşük olamaz.';
  END IF;

  IF coalesce(v_e.source_key LIKE 'entitlement:%', false)
     AND ((v_in.o_counterparty_id, v_in.o_counterparty_text, v_in.o_entitlement_month, v_in.o_category_id)
          IS DISTINCT FROM (v_e.counterparty_id, v_e.counterparty_text, v_e.entitlement_month, v_e.category_id)) THEN
    RAISE EXCEPTION 'Hakediş kaydının hekimi, ayı ve kategorisi değiştirilemez.';
  END IF;

  IF v_in.o_category_id <> v_e.category_id AND NOT v_in.o_category_active THEN
    RAISE EXCEPTION 'Pasif kategori seçilemez.';
  END IF;
  IF v_in.o_counterparty_id IS NOT NULL
     AND v_in.o_counterparty_id IS DISTINCT FROM v_e.counterparty_id
     AND NOT v_in.o_counterparty_active THEN
    RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
  END IF;

  UPDATE public.fin_entries e
  SET category_id = v_in.o_category_id,
      subcategory = v_in.o_subcategory,
      counterparty_id = v_in.o_counterparty_id,
      counterparty_text = v_in.o_counterparty_text,
      description = v_in.o_description,
      due_date = v_in.o_due_date,
      amount_cents = v_in.o_amount_cents,
      entitlement_month = v_in.o_entitlement_month
  WHERE e.id = p_id;

  RETURN public.fin__entry_envelope(v_clinic, p_id, false);
END;
$$;

-- Bumps the entry version after a payment change (the entry is the aggregate root).
CREATE OR REPLACE FUNCTION public.fin__bump_entry(p_clinic uuid, p_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE public.fin_entries e
  SET updated_by = coalesce(public.current_app_user_id(), e.updated_by)
  WHERE e.clinic_id = p_clinic AND e.id = p_id
$$;

-- Record a payment (legacy pay RT:23, RT:130-132). UI: 'Tahsilat kaydet' (in) / 'Ödeme kaydet' (out), FP:52.
-- A retry with the same payment id on the same entry is answered as already saved, before the version check
-- (RT:119; FF:17-18).
CREATE OR REPLACE FUNCTION public.fin_record_payment(
  p_entry_id uuid,
  p_version integer,
  p_payment_id uuid,
  p_paid_on date,
  p_amount_cents bigint,
  p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_e public.fin_entries%ROWTYPE;
  v_owner_clinic uuid;
  v_owner_entry uuid;
  v_outstanding bigint;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;

  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  SELECT p.clinic_id, p.entry_id INTO v_owner_clinic, v_owner_entry
  FROM public.fin_payments p
  WHERE p.id = p_payment_id;
  IF v_owner_clinic IS NOT NULL THEN
    IF v_owner_clinic = v_clinic AND v_owner_entry = p_entry_id THEN
      RETURN public.fin__entry_envelope(v_clinic, p_entry_id, true);
    END IF;
    RAISE EXCEPTION 'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.' USING ERRCODE = 'PT409';
  END IF;

  IF p_version IS DISTINCT FROM v_e.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  PERFORM public.fin__amount(p_amount_cents);
  PERFORM public.fin__day(p_paid_on);

  IF v_e.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş kayda ödeme eklenemez.';
  END IF;

  v_outstanding := v_e.amount_cents - public.fin__paid(v_e.id);
  IF p_paid_on > public.clinic_today() OR p_amount_cents > v_outstanding THEN
    RAISE EXCEPTION 'Ödeme tarihi ve kalan tutarı kontrol edin.';
  END IF;

  PERFORM public.fin__check_account(v_clinic, p_account_id);

  BEGIN
    INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, recorded_by, updated_by)
    VALUES (p_payment_id, v_clinic, p_entry_id, p_paid_on, p_amount_cents, p_account_id, v_user, v_user);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.' USING ERRCODE = 'PT409';
  END;
  PERFORM public.fin__bump_entry(v_clinic, p_entry_id);

  RETURN public.fin__entry_envelope(v_clinic, p_entry_id, false);
END;
$$;

-- Correct a payment (legacy correctPayment RT:24, RT:133-135, as corrected by C1): the amount may go up or down
-- up to amount − paid + this payment, date and account may change, and it is allowed on cancelled entries.
CREATE OR REPLACE FUNCTION public.fin_correct_payment(
  p_entry_id uuid,
  p_version integer,
  p_payment_id uuid,
  p_paid_on date,
  p_amount_cents bigint,
  p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_e public.fin_entries%ROWTYPE;
  v_p public.fin_payments%ROWTYPE;
BEGIN
  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  SELECT * INTO v_p
  FROM public.fin_payments p
  WHERE p.clinic_id = v_clinic AND p.entry_id = p_entry_id AND p.id = p_payment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ödeme bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_p.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş ödeme değiştirilemez.';
  END IF;

  IF (v_p.paid_on, v_p.amount_cents, v_p.account_id) IS NOT DISTINCT FROM (p_paid_on, p_amount_cents, p_account_id) THEN
    RETURN public.fin__entry_envelope(v_clinic, p_entry_id, true);
  END IF;

  IF p_version IS DISTINCT FROM v_e.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  PERFORM public.fin__amount(p_amount_cents);
  PERFORM public.fin__day(p_paid_on);

  IF p_paid_on > public.clinic_today()
     OR p_amount_cents > v_e.amount_cents - public.fin__paid(v_e.id) + v_p.amount_cents THEN
    RAISE EXCEPTION 'Düzeltme tarihi veya tutarı geçersiz.';
  END IF;

  -- A changed account must be active; an unchanged inactive one (legacy 'Karma') is kept.
  IF p_account_id IS DISTINCT FROM v_p.account_id THEN
    PERFORM public.fin__check_account(v_clinic, p_account_id);
  END IF;

  UPDATE public.fin_payments p
  SET paid_on = p_paid_on, amount_cents = p_amount_cents, account_id = p_account_id
  WHERE p.id = p_payment_id;
  PERFORM public.fin__bump_entry(v_clinic, p_entry_id);

  RETURN public.fin__entry_envelope(v_clinic, p_entry_id, false);
END;
$$;

-- Void a wrong payment with a reason (new, owner decision 2). Voided payments count nowhere; the row stays visible.
-- Allowed on cancelled entries (C1). Voiding an already voided payment is answered as already saved.
CREATE OR REPLACE FUNCTION public.fin_void_payment(
  p_entry_id uuid,
  p_version integer,
  p_payment_id uuid,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_e public.fin_entries%ROWTYPE;
  v_p public.fin_payments%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  SELECT * INTO v_p
  FROM public.fin_payments p
  WHERE p.clinic_id = v_clinic AND p.entry_id = p_entry_id AND p.id = p_payment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ödeme bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_p.voided_at IS NOT NULL THEN
    RETURN public.fin__entry_envelope(v_clinic, p_entry_id, true);
  END IF;

  IF p_version IS DISTINCT FROM v_e.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);

  UPDATE public.fin_payments p
  SET voided_at = now(), voided_by = public.current_app_user_id(), void_reason = v_reason
  WHERE p.id = p_payment_id;
  PERFORM public.fin__bump_entry(v_clinic, p_entry_id);

  RETURN public.fin__entry_envelope(v_clinic, p_entry_id, false);
END;
$$;

-- 'Kalan planı iptal et' (legacy cancel RT:25, RT:136; FP:49, FP:78-80). Payments stay and keep counting
-- (FT:13, FF:21). There is no un-cancel.
CREATE OR REPLACE FUNCTION public.fin_cancel_entry(
  p_id uuid,
  p_version integer,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_e public.fin_entries%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_e.cancelled_at IS NOT NULL THEN
    RETURN public.fin__entry_envelope(v_clinic, p_id, true);
  END IF;

  IF p_version IS DISTINCT FROM v_e.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);

  IF v_e.amount_cents - public.fin__paid(v_e.id) <= 0 THEN
    RAISE EXCEPTION 'Kapatılacak kalan tutar yok.';
  END IF;

  UPDATE public.fin_entries e
  SET cancelled_at = now(), cancelled_by = public.current_app_user_id(), cancel_reason = v_reason
  WHERE e.id = p_id;

  RETURN public.fin__entry_envelope(v_clinic, p_id, false);
END;
$$;

-- Manual, audited form of the legacy reconciliation exclusions (FM:48-66, FR:6, FR:14; banner FP:64). The entry's
-- payments leave every realized total; its outstanding still counts in the plan, groups and Cariler (FM:73, FM:80).
CREATE OR REPLACE FUNCTION public.fin_set_exclusion(
  p_id uuid,
  p_version integer,
  p_excluded boolean,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_e public.fin_entries%ROWTYPE;
  v_reason text;
BEGIN
  IF p_excluded IS NULL THEN
    RAISE EXCEPTION 'Geçersiz değer.';
  END IF;

  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_e.excluded_from_totals = p_excluded THEN
    RETURN public.fin__entry_envelope(v_clinic, p_id, true);
  END IF;

  IF p_version IS DISTINCT FROM v_e.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  IF p_excluded THEN
    v_reason := public.fin__reason(p_reason);
    UPDATE public.fin_entries e
    SET excluded_from_totals = true,
        exclusion_reason = v_reason,
        excluded_at = now(),
        excluded_by = public.current_app_user_id()
    WHERE e.id = p_id;
  ELSE
    UPDATE public.fin_entries e
    SET excluded_from_totals = false,
        exclusion_reason = NULL,
        excluded_at = NULL,
        excluded_by = NULL
    WHERE e.id = p_id;
  END IF;

  RETURN public.fin__entry_envelope(v_clinic, p_id, false);
END;
$$;

-- 'Hekim hakedişi ekle' (generalises legacy saveEntitlement IP:55, IP:67 / IR:8, IR:22-31 to any physician
-- counterparty, C5). One entitlement per physician and month (source_key 'entitlement:<cp>:<YYYY-MM>').
CREATE OR REPLACE FUNCTION public.fin_add_entitlement(
  p_id uuid,
  p_counterparty_id uuid,
  p_month text,
  p_amount_cents bigint,
  p_paid_cents bigint,
  p_paid_on date,
  p_account_id uuid,
  p_description text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date := public.clinic_today();
  v_user uuid := public.current_app_user_id();
  v_owner uuid;
  v_month date;
  v_cp public.fin_counterparties%ROWTYPE;
  v_category uuid;
  v_category_active boolean;
  v_paid bigint := coalesce(p_paid_cents, 0);
  v_description text;
  v_key text;
  v_existing uuid;
  v_subcategory text;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;

  SELECT e.clinic_id INTO v_owner FROM public.fin_entries e WHERE e.id = p_id;
  IF v_owner IS NOT NULL THEN
    IF v_owner = v_clinic THEN
      RETURN public.fin__entry_envelope(v_clinic, p_id, true);
    END IF;
    RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
  END IF;

  v_month := public.fin__month(p_month);
  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Geçersiz tarih.';
  END IF;

  SELECT * INTO v_cp FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.id = p_counterparty_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kişi / kurum bulunamadı.';
  END IF;
  IF NOT v_cp.is_active OR v_cp.kind <> 'physician' THEN
    RAISE EXCEPTION 'Hakediş yalnızca aktif, hekim türündeki kişi / kurum için girilebilir.';
  END IF;

  SELECT c.id, c.is_active INTO v_category, v_category_active
  FROM public.fin_categories c
  WHERE c.clinic_id = v_clinic AND c.report_bucket = 'doctor' AND c.is_system;
  IF v_category IS NULL OR NOT v_category_active THEN
    RAISE EXCEPTION 'Hekim hakedişi kategorisi bulunamadı veya pasif.';
  END IF;

  PERFORM public.fin__amount(p_amount_cents);
  IF v_paid < 0 OR v_paid > p_amount_cents THEN
    RAISE EXCEPTION 'Ödenen tutar hakediş tutarını aşamaz; ödeme tarihi bugünden sonra olamaz.';
  END IF;
  IF v_paid > 0 THEN
    PERFORM public.fin__day(p_paid_on);
    IF p_paid_on > v_today THEN
      RAISE EXCEPTION 'Ödenen tutar hakediş tutarını aşamaz; ödeme tarihi bugünden sonra olamaz.';
    END IF;
    PERFORM public.fin__check_account(v_clinic, p_account_id);
  END IF;

  v_description := btrim(coalesce(p_description, ''));
  IF char_length(v_description) > 1000 THEN
    RAISE EXCEPTION 'Açıklama en fazla 1000 karakter olabilir.';
  END IF;

  v_key := 'entitlement:' || p_counterparty_id::text || ':' || to_char(v_month, 'YYYY-MM');
  SELECT e.id INTO v_existing FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.source_key = v_key;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Bu hekim için seçilen ayın hakedişi zaten kayıtlı. Ek ödemeleri mevcut kayda girin.'
      USING ERRCODE = 'PT409', DETAIL = v_existing::text;
  END IF;

  -- Past-period debt when the month lies before the month it is paid in (or before today when unpaid), IP:55.
  IF v_month < public.fin__month_start(CASE WHEN v_paid > 0 THEN p_paid_on ELSE v_today END) THEN
    v_subcategory := 'past_physician_debt';
  ELSE
    v_subcategory := 'current_physician';
  END IF;

  BEGIN
    INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                    description, due_date, amount_cents, entitlement_month, source_key,
                                    created_by, updated_by)
    VALUES (p_id, v_clinic, v_category, v_subcategory, p_counterparty_id, NULL,
            v_description, v_month, p_amount_cents, v_month, v_key, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    SELECT e.id INTO v_existing FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.source_key = v_key;
    RAISE EXCEPTION 'Bu hekim için seçilen ayın hakedişi zaten kayıtlı. Ek ödemeleri mevcut kayda girin.'
      USING ERRCODE = 'PT409', DETAIL = coalesce(v_existing::text, '');
  END;
  IF v_n = 0 THEN
    -- A concurrent request inserted the same id first.
    IF EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = p_id AND e.clinic_id = v_clinic) THEN
      RETURN public.fin__entry_envelope(v_clinic, p_id, true);
    END IF;
    RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
  END IF;

  IF v_paid > 0 THEN
    BEGIN
      INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, recorded_by, updated_by)
      VALUES (p_id, v_clinic, p_id, p_paid_on, v_paid, p_account_id, v_user, v_user);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN public.fin__entry_envelope(v_clinic, p_id, false);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3.3 Balance write RPCs. Both serialise per clinic on an advisory lock and return
--     { already_saved, snapshot: SnapshotJson }. The current snapshot is always the latest with day <= today.
--     Source objects passed between the steps are jsonb:
--     { kind, source_key, account_id, label, as_of, amount_cents, file_name, note, is_manual }.
-- ---------------------------------------------------------------------------

-- Makes the snapshot's active sources equal p_desired: active rows that differ or are no longer wanted get
-- replaced_at (history is kept, owner decision 2); wanted rows not active yet are inserted.
CREATE OR REPLACE FUNCTION public.fin__apply_sources(p_clinic uuid, p_snapshot_id uuid, p_desired jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.current_app_user_id();
BEGIN
  UPDATE public.fin_balance_sources src
  SET replaced_at = now(), replaced_by = v_user
  WHERE src.clinic_id = p_clinic
    AND src.snapshot_id = p_snapshot_id
    AND src.replaced_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_desired) AS d(value)
      WHERE d.value ->> 'source_key' = src.source_key
        AND d.value ->> 'kind' = src.kind
        AND (d.value ->> 'account_id')::uuid IS NOT DISTINCT FROM src.account_id
        AND d.value ->> 'label' = src.label
        AND (d.value ->> 'as_of')::date = src.as_of
        AND (d.value ->> 'amount_cents')::bigint = src.amount_cents
        AND (d.value ->> 'file_name') IS NOT DISTINCT FROM src.file_name
        AND coalesce(d.value ->> 'note', '') = src.note
        AND (d.value ->> 'is_manual')::boolean = src.is_manual
    );

  INSERT INTO public.fin_balance_sources (clinic_id, snapshot_id, kind, source_key, account_id, label, as_of,
                                          amount_cents, file_name, note, is_manual, created_by)
  SELECT p_clinic,
         p_snapshot_id,
         d.value ->> 'kind',
         d.value ->> 'source_key',
         (d.value ->> 'account_id')::uuid,
         d.value ->> 'label',
         (d.value ->> 'as_of')::date,
         (d.value ->> 'amount_cents')::bigint,
         d.value ->> 'file_name',
         coalesce(d.value ->> 'note', ''),
         (d.value ->> 'is_manual')::boolean,
         v_user
  FROM jsonb_array_elements(p_desired) AS d(value)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.fin_balance_sources src
    WHERE src.snapshot_id = p_snapshot_id
      AND src.replaced_at IS NULL
      AND src.source_key = d.value ->> 'source_key'
  );
END;
$$;

-- Declare the complete balance of one day (legacy manual balance RT:26, RT:104-108; dialog FP:44, FP:76; 'Düzelt'
-- from history FP:72). Bank side: either a total (one 'manual:bank' source; replaces that day's per-account
-- breakdown, FP:62) or per-account amounts (key 'account:<id>'). Cash: one 'clinic-cash' source.
-- p_version 0 = create; a second create for the same day → E_BALANCE_CONFLICT (FF:14).
CREATE OR REPLACE FUNCTION public.fin_save_balance(
  p_day date,
  p_version integer,
  p_bank_total_cents bigint,
  p_bank_accounts jsonb,
  p_cash_cents bigint,
  p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_today date;
  v_has_total boolean := p_bank_total_cents IS NOT NULL;
  v_has_accounts boolean;
  v_desired jsonb := '[]'::jsonb;
  v_item jsonb;
  v_account_id uuid;
  v_amount bigint;
  v_as_of date;
  v_acc public.fin_accounts%ROWTYPE;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_bank_cents bigint := 0;
  v_bank_as_of date;
  v_note text;
  v_snap public.fin_balance_snapshots%ROWTYPE;
  v_snap_id uuid;
  v_current jsonb;
  v_wanted jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_balance:' || v_clinic::text, 0));
  v_today := public.clinic_today();

  PERFORM public.fin__day(p_day);
  IF p_day > v_today THEN
    RAISE EXCEPTION 'Gerçek bakiye için gelecek tarih seçilemez.';
  END IF;

  IF p_bank_accounts IS NOT NULL AND jsonb_typeof(p_bank_accounts) NOT IN ('array', 'null') THEN
    RAISE EXCEPTION 'Banka için ya toplam tutar ya da hesap bazında tutarlar girin.';
  END IF;
  v_has_accounts := CASE WHEN jsonb_typeof(p_bank_accounts) = 'array'
                         THEN jsonb_array_length(p_bank_accounts) > 0
                         ELSE false END;
  IF v_has_total = v_has_accounts THEN
    RAISE EXCEPTION 'Banka için ya toplam tutar ya da hesap bazında tutarlar girin.';
  END IF;

  IF v_has_total THEN
    IF p_bank_total_cents NOT BETWEEN -1000000000000 AND 1000000000000 THEN
      RAISE EXCEPTION 'Banka bakiyesi -10.000.000.000 TL ile 10.000.000.000 TL arasında olmalı.';
    END IF;
    v_bank_cents := p_bank_total_cents;
    v_bank_as_of := p_day;
    v_desired := jsonb_build_array(jsonb_build_object(
      'kind', 'bank', 'source_key', 'manual:bank', 'account_id', NULL::uuid, 'label', 'Banka toplamı (manuel)',
      'as_of', p_day, 'amount_cents', p_bank_total_cents, 'file_name', NULL::text, 'note', '', 'is_manual', true));
  ELSE
    IF jsonb_array_length(p_bank_accounts) > 30 THEN
      RAISE EXCEPTION 'En fazla 30 bakiye satırı girilebilir.';
    END IF;
    FOR v_item IN SELECT x.value FROM jsonb_array_elements(p_bank_accounts) AS x(value)
    LOOP
      IF jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION 'Bakiye satırı geçersiz.';
      END IF;

      BEGIN
        v_account_id := nullif(v_item ->> 'account_id', '')::uuid;
      EXCEPTION WHEN data_exception THEN
        v_account_id := NULL;
      END;
      SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = v_account_id;
      IF NOT FOUND OR NOT v_acc.is_active OR v_acc.kind NOT IN ('bank', 'pos') THEN
        RAISE EXCEPTION 'Bakiye hesabı banka veya POS türünde, aktif bir hesap olmalı.';
      END IF;
      IF v_account_id = ANY (v_seen) THEN
        RAISE EXCEPTION 'Aynı hesap için birden fazla bakiye seçildi.';
      END IF;
      v_seen := array_append(v_seen, v_account_id);

      BEGIN
        v_amount := (v_item ->> 'amount_cents')::bigint;
      EXCEPTION WHEN data_exception THEN
        v_amount := NULL;
      END;
      IF v_amount IS NULL OR v_amount NOT BETWEEN -1000000000000 AND 1000000000000 THEN
        RAISE EXCEPTION 'Banka bakiyesi -10.000.000.000 TL ile 10.000.000.000 TL arasında olmalı.';
      END IF;

      BEGIN
        v_as_of := coalesce(nullif(v_item ->> 'as_of', '')::date, p_day);
      EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'Geçersiz tarih.';
      END;
      IF v_as_of < DATE '2000-01-01' OR v_as_of > p_day THEN
        RAISE EXCEPTION 'Geçersiz tarih.';
      END IF;

      v_bank_cents := v_bank_cents + v_amount;
      v_bank_as_of := least(coalesce(v_bank_as_of, v_as_of), v_as_of);
      v_desired := v_desired || jsonb_build_array(jsonb_build_object(
        'kind', 'bank', 'source_key', 'account:' || v_account_id::text, 'account_id', v_account_id,
        'label', v_acc.name, 'as_of', v_as_of, 'amount_cents', v_amount, 'file_name', NULL::text,
        'note', '', 'is_manual', true));
    END LOOP;
    IF v_bank_cents NOT BETWEEN -1000000000000 AND 1000000000000 THEN
      RAISE EXCEPTION 'Banka bakiyesi -10.000.000.000 TL ile 10.000.000.000 TL arasında olmalı.';
    END IF;
  END IF;

  IF p_cash_cents IS NULL THEN
    RAISE EXCEPTION 'Nakit kasa tutarını girin.';
  END IF;
  IF p_cash_cents < 0 THEN
    RAISE EXCEPTION 'Nakit kasa negatif olamaz.';
  END IF;
  IF p_cash_cents > 1000000000000 THEN
    RAISE EXCEPTION 'Tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
  END IF;
  v_desired := v_desired || jsonb_build_array(jsonb_build_object(
    'kind', 'cash', 'source_key', 'clinic-cash', 'account_id', NULL::uuid, 'label', 'Nakit kasa',
    'as_of', p_day, 'amount_cents', p_cash_cents, 'file_name', NULL::text, 'note', '', 'is_manual', true));

  v_note := public.fin__note(p_note, 1000);

  SELECT * INTO v_snap
  FROM public.fin_balance_snapshots s
  WHERE s.clinic_id = v_clinic AND s.day = p_day
  FOR UPDATE;

  IF FOUND THEN
    -- No-op: same active sources (key, account, amount, as_of) and the same note.
    SELECT coalesce(jsonb_agg(jsonb_build_object('k', src.source_key, 'c', src.account_id, 'a', src.amount_cents,
                                                 'd', to_char(src.as_of, 'YYYY-MM-DD'))
                              ORDER BY src.source_key), '[]'::jsonb)
      INTO v_current
    FROM public.fin_balance_sources src
    WHERE src.snapshot_id = v_snap.id AND src.replaced_at IS NULL;
    SELECT coalesce(jsonb_agg(jsonb_build_object('k', d.value ->> 'source_key', 'c', (d.value ->> 'account_id')::uuid,
                                                 'a', (d.value ->> 'amount_cents')::bigint,
                                                 'd', to_char((d.value ->> 'as_of')::date, 'YYYY-MM-DD'))
                              ORDER BY d.value ->> 'source_key'), '[]'::jsonb)
      INTO v_wanted
    FROM jsonb_array_elements(v_desired) AS d(value);
    IF v_current = v_wanted AND v_snap.note = v_note THEN
      RETURN jsonb_build_object('already_saved', true,
                                'snapshot', public.fin__snapshot_json(v_clinic, v_snap.id, v_today));
    END IF;

    IF p_version IS DISTINCT FROM v_snap.version THEN
      RAISE EXCEPTION 'Bakiye başka bir ekranda değişti. Listeyi yenileyip önizlemeyi kontrol edin.' USING ERRCODE = 'PT409';
    END IF;

    UPDATE public.fin_balance_snapshots s
    SET bank_cents = v_bank_cents,
        cash_cents = p_cash_cents,
        bank_as_of = v_bank_as_of,
        cash_as_of = p_day,
        note = v_note
    WHERE s.id = v_snap.id;
    v_snap_id := v_snap.id;
  ELSE
    IF p_version IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Bakiye başka bir ekranda değişti. Listeyi yenileyip önizlemeyi kontrol edin.' USING ERRCODE = 'PT409';
    END IF;
    INSERT INTO public.fin_balance_snapshots (clinic_id, day, bank_cents, cash_cents, bank_as_of, cash_as_of, note,
                                              created_by, updated_by)
    VALUES (v_clinic, p_day, v_bank_cents, p_cash_cents, v_bank_as_of, p_day, v_note, v_user, v_user)
    RETURNING id INTO v_snap_id;
  END IF;

  PERFORM public.fin__apply_sources(v_clinic, v_snap_id, v_desired);

  RETURN jsonb_build_object('already_saved', false, 'snapshot', public.fin__snapshot_json(v_clinic, v_snap_id, v_today));
END;
$$;

-- "Update only these accounts today and keep the rest" (legacy importBalance + mergeBalanceSources RT:20,
-- RT:94-103; BI:28-39; preview BP:7-13). p_sources items:
--   { kind: 'bank'|'cash', account_id, amount_cents, as_of: 'YYYY-MM-DD', label?, file_name?, note? }.
-- The base (p_base_snapshot_id, p_base_version) is the current snapshot as the client read it, both NULL (or
-- version 0) when there was none. p_dry_run returns the merged snapshot without writing anything (replaces the
-- client-side preview BP:9); its version / id are those the write would produce.
CREATE OR REPLACE FUNCTION public.fin_merge_balance_sources(
  p_base_snapshot_id uuid,
  p_base_version integer,
  p_sources jsonb,
  p_initialize_banks boolean,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_today date;
  v_init boolean := coalesce(p_initialize_banks, false);
  v_dry boolean := coalesce(p_dry_run, false);
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_obj jsonb;
  v_kind text;
  v_account_id uuid;
  v_amount bigint;
  v_as_of date;
  v_label text;
  v_file text;
  v_note text;
  v_key text;
  v_acc public.fin_accounts%ROWTYPE;
  v_keys text[] := ARRAY[]::text[];
  v_has_bank_items boolean := false;
  v_prev public.fin_balance_snapshots%ROWTYPE;
  v_has_prev boolean;
  v_banks jsonb := '{}'::jsonb;
  v_manual jsonb;
  v_cash jsonb;
  v_old jsonb;
  v_floor date;
  v_bank_cents bigint;
  v_bank_as_of date;
  v_cash_cents bigint;
  v_cash_as_of date;
  v_desired jsonb;
  v_snap_id uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_balance:' || v_clinic::text, 0));
  v_today := public.clinic_today();

  -- Step 1 (p3 §5.11 B): the base must still be the current snapshot (RT:97, BP:10). Checked before the items, as
  -- legacy answers 409 before mergeBalanceSources validates anything (RT:97-98).
  SELECT * INTO v_prev
  FROM public.fin_balance_snapshots s
  WHERE s.clinic_id = v_clinic AND s.day <= v_today
  ORDER BY s.day DESC
  LIMIT 1
  FOR UPDATE;
  v_has_prev := FOUND;

  IF v_has_prev THEN
    IF p_base_snapshot_id IS DISTINCT FROM v_prev.id OR p_base_version IS DISTINCT FROM v_prev.version THEN
      RAISE EXCEPTION 'Bakiye başka bir ekranda değişti. Listeyi yenileyip önizlemeyi kontrol edin.' USING ERRCODE = 'PT409';
    END IF;
  ELSIF p_base_snapshot_id IS NOT NULL OR coalesce(p_base_version, 0) <> 0 THEN
    RAISE EXCEPTION 'Bakiye başka bir ekranda değişti. Listeyi yenileyip önizlemeyi kontrol edin.' USING ERRCODE = 'PT409';
  END IF;

  -- Step 2-3: shape of every item, duplicates (BI:29-30).
  IF jsonb_typeof(p_sources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'En az bir bakiye seçin.';
  END IF;
  IF jsonb_array_length(p_sources) = 0 THEN
    RAISE EXCEPTION 'En az bir bakiye seçin.';
  END IF;
  IF jsonb_array_length(p_sources) > 30 THEN
    RAISE EXCEPTION 'En fazla 30 bakiye satırı girilebilir.';
  END IF;

  FOR v_item IN SELECT x.value FROM jsonb_array_elements(p_sources) AS x(value)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'Bakiye satırı geçersiz.';
    END IF;
    v_kind := v_item ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('bank', 'cash') THEN
      RAISE EXCEPTION 'Geçersiz tür.';
    END IF;

    BEGIN
      v_amount := (v_item ->> 'amount_cents')::bigint;
    EXCEPTION WHEN data_exception THEN
      v_amount := NULL;
    END;
    IF v_amount IS NULL OR v_amount NOT BETWEEN -1000000000000 AND 1000000000000 THEN
      RAISE EXCEPTION 'Banka bakiyesi -10.000.000.000 TL ile 10.000.000.000 TL arasında olmalı.';
    END IF;

    BEGIN
      v_as_of := nullif(v_item ->> 'as_of', '')::date;
    EXCEPTION WHEN data_exception THEN
      v_as_of := NULL;
    END;
    PERFORM public.fin__day(v_as_of);

    v_note := public.fin__note(v_item ->> 'note', 1000);
    v_label := nullif(btrim(coalesce(v_item ->> 'label', '')), '');
    IF char_length(v_label) > 200 THEN
      RAISE EXCEPTION 'Ad boş olamaz ve en fazla 200 karakter olabilir.';
    END IF;
    v_file := nullif(btrim(coalesce(v_item ->> 'file_name', '')), '');
    IF char_length(v_file) > 200 THEN
      RAISE EXCEPTION 'Dosya adı en fazla 200 karakter olabilir.';
    END IF;

    BEGIN
      v_account_id := nullif(v_item ->> 'account_id', '')::uuid;
    EXCEPTION WHEN data_exception THEN
      RAISE EXCEPTION 'Bakiye hesabı banka veya POS türünde, aktif bir hesap olmalı.';
    END;

    IF v_kind = 'bank' THEN
      SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = v_account_id;
      IF NOT FOUND OR NOT v_acc.is_active OR v_acc.kind NOT IN ('bank', 'pos') THEN
        RAISE EXCEPTION 'Bakiye hesabı banka veya POS türünde, aktif bir hesap olmalı.';
      END IF;
      v_key := 'account:' || v_account_id::text;
      v_label := coalesce(v_label, v_acc.name);
      v_has_bank_items := true;
    ELSE
      IF v_account_id IS NOT NULL THEN
        SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = v_account_id;
        IF NOT FOUND OR NOT v_acc.is_active OR v_acc.kind <> 'cash' THEN
          RAISE EXCEPTION 'Bakiye hesabı banka veya POS türünde, aktif bir hesap olmalı.';
        END IF;
      END IF;
      v_key := 'clinic-cash';
      v_label := coalesce(v_label, 'Nakit kasa');
    END IF;

    IF v_key = ANY (v_keys) THEN
      RAISE EXCEPTION 'Aynı hesap için birden fazla bakiye seçildi.';
    END IF;
    v_keys := array_append(v_keys, v_key);

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'kind', v_kind, 'source_key', v_key, 'account_id', v_account_id, 'label', v_label, 'as_of', v_as_of,
      'amount_cents', v_amount, 'file_name', v_file, 'note', v_note, 'is_manual', v_file IS NULL));
  END LOOP;

  -- Step 5: no-op when today's snapshot already holds every item.
  IF v_has_prev AND v_prev.day = v_today AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) AS i(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.fin_balance_sources src
      WHERE src.snapshot_id = v_prev.id
        AND src.replaced_at IS NULL
        AND src.source_key = i.value ->> 'source_key'
        AND src.amount_cents = (i.value ->> 'amount_cents')::bigint
        AND src.as_of = (i.value ->> 'as_of')::date
    )
  ) THEN
    RETURN jsonb_build_object('already_saved', true, 'dry_run', v_dry,
                              'snapshot', public.fin__snapshot_json(v_clinic, v_prev.id, v_today));
  END IF;

  -- Step 6: start from the previous snapshot (BI:31): its account sources, its manual total, its cash.
  IF v_has_prev THEN
    SELECT coalesce(jsonb_object_agg(src.source_key, jsonb_build_object(
             'kind', src.kind, 'source_key', src.source_key, 'account_id', src.account_id, 'label', src.label,
             'as_of', src.as_of, 'amount_cents', src.amount_cents, 'file_name', src.file_name, 'note', src.note,
             'is_manual', src.is_manual)), '{}'::jsonb)
      INTO v_banks
    FROM public.fin_balance_sources src
    WHERE src.snapshot_id = v_prev.id AND src.replaced_at IS NULL
      AND src.kind = 'bank' AND src.source_key <> 'manual:bank';

    SELECT jsonb_build_object(
             'kind', src.kind, 'source_key', src.source_key, 'account_id', src.account_id, 'label', src.label,
             'as_of', src.as_of, 'amount_cents', src.amount_cents, 'file_name', src.file_name, 'note', src.note,
             'is_manual', src.is_manual)
      INTO v_manual
    FROM public.fin_balance_sources src
    WHERE src.snapshot_id = v_prev.id AND src.replaced_at IS NULL AND src.source_key = 'manual:bank';

    SELECT jsonb_build_object(
             'kind', src.kind, 'source_key', src.source_key, 'account_id', src.account_id, 'label', src.label,
             'as_of', src.as_of, 'amount_cents', src.amount_cents, 'file_name', src.file_name, 'note', src.note,
             'is_manual', src.is_manual)
      INTO v_cash
    FROM public.fin_balance_sources src
    WHERE src.snapshot_id = v_prev.id AND src.replaced_at IS NULL AND src.kind = 'cash';

    v_cash_cents := v_prev.cash_cents;
  ELSE
    v_cash_cents := 0;
  END IF;

  -- Step 7: the first per-account entry after a manual total must cover every bank account (BI:33).
  IF v_has_bank_items AND v_banks = '{}'::jsonb AND NOT v_init THEN
    RAISE EXCEPTION 'İlk hesap bazlı girişte tüm banka hesaplarını girdiğinizi onaylayın. Eski toplamın hesap dağılımı bilinmiyor.';
  END IF;

  -- Step 8: per item (BI:34-36). Deliberate deviation (p3 §5.13 D10): fin_save_balance always writes an active
  -- 'clinic-cash' source, so after a manual total v_old is never NULL for cash and an older cash item is refused
  -- even with p_initialize_banks. Legacy had no cashSource there and let init bypass the check; init is about the
  -- bank breakdown, and this keeps a declared cash figure from being replaced by an older one.
  FOR v_obj IN SELECT i.value FROM jsonb_array_elements(v_items) AS i(value)
  LOOP
    v_as_of := (v_obj ->> 'as_of')::date;
    IF v_as_of > v_today THEN
      RAISE EXCEPTION 'Gelecek tarihli bakiye kaydedilemez.';
    END IF;

    IF v_obj ->> 'kind' = 'bank' THEN
      v_old := v_banks -> (v_obj ->> 'source_key');
      v_floor := coalesce((v_old ->> 'as_of')::date, v_prev.bank_as_of);
    ELSE
      v_old := v_cash;
      v_floor := coalesce((v_old ->> 'as_of')::date, v_prev.cash_as_of);
    END IF;
    IF v_floor IS NULL AND v_has_prev THEN
      v_floor := v_prev.day;
    END IF;
    IF v_floor IS NOT NULL AND v_as_of < v_floor AND (v_old IS NOT NULL OR NOT v_init) THEN
      RAISE EXCEPTION '%: tarih mevcut bakiyeden eski. Bu satırın seçimini kaldırın.', v_obj ->> 'label';
    END IF;

    IF v_obj ->> 'kind' = 'bank' THEN
      v_banks := v_banks || jsonb_build_object(v_obj ->> 'source_key', v_obj);
    ELSE
      IF (v_obj ->> 'amount_cents')::bigint < 0 THEN
        RAISE EXCEPTION 'Nakit kasa negatif olamaz.';
      END IF;
      v_cash := v_obj;
      v_cash_cents := (v_obj ->> 'amount_cents')::bigint;
    END IF;
  END LOOP;

  -- Step 9: the very first snapshot needs both sides (BI:37-38).
  IF NOT v_has_prev AND v_cash IS NULL THEN
    RAISE EXCEPTION 'İlk bakiye için nakit kasa bakiyesini de girin.';
  END IF;
  IF NOT v_has_prev AND v_banks = '{}'::jsonb THEN
    RAISE EXCEPTION 'İlk bakiye için banka bakiyelerini de girin.';
  END IF;

  -- Step 10: the merged result (BI:39). Account sources replace a manual total; without any, the previous
  -- manual total is carried over.
  IF v_banks <> '{}'::jsonb THEN
    SELECT sum((b.value ->> 'amount_cents')::bigint)::bigint, min((b.value ->> 'as_of')::date), jsonb_agg(b.value)
      INTO v_bank_cents, v_bank_as_of, v_desired
    FROM jsonb_each(v_banks) AS b(key, value);
  ELSE
    v_bank_cents := v_prev.bank_cents;
    v_bank_as_of := v_prev.bank_as_of;
    v_desired := CASE WHEN v_manual IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_manual) END;
  END IF;
  IF v_bank_cents NOT BETWEEN -1000000000000 AND 1000000000000 THEN
    RAISE EXCEPTION 'Banka bakiyesi -10.000.000.000 TL ile 10.000.000.000 TL arasında olmalı.';
  END IF;
  v_desired := v_desired || jsonb_build_array(v_cash);
  v_cash_as_of := (v_cash ->> 'as_of')::date;

  -- Step 11: write (or, for a dry run, write inside a subtransaction that is rolled back).
  BEGIN
    IF v_has_prev AND v_prev.day = v_today THEN
      UPDATE public.fin_balance_snapshots s
      SET bank_cents = v_bank_cents,
          cash_cents = v_cash_cents,
          bank_as_of = v_bank_as_of,
          cash_as_of = v_cash_as_of
      WHERE s.id = v_prev.id;
      v_snap_id := v_prev.id;
    ELSE
      INSERT INTO public.fin_balance_snapshots (clinic_id, day, bank_cents, cash_cents, bank_as_of, cash_as_of, note,
                                                created_by, updated_by)
      VALUES (v_clinic, v_today, v_bank_cents, v_cash_cents, v_bank_as_of, v_cash_as_of, '', v_user, v_user)
      RETURNING id INTO v_snap_id;
    END IF;

    PERFORM public.fin__apply_sources(v_clinic, v_snap_id, v_desired);

    v_result := jsonb_build_object('already_saved', false, 'dry_run', v_dry,
                                   'snapshot', public.fin__snapshot_json(v_clinic, v_snap_id, v_today));
    IF v_dry THEN
      RAISE EXCEPTION 'fin dry run' USING ERRCODE = 'PD001';
    END IF;
  EXCEPTION WHEN SQLSTATE 'PD001' THEN
    NULL;  -- dry run: every write of this block is rolled back, v_result keeps the preview
  END;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3.5 Read RPCs. Every one starts with fin__require_read() (finance or finance_readonly) and returns one jsonb,
--     so PostgREST's 1000-row cap never applies; lists are paged and their totals cover every matched row.
-- ---------------------------------------------------------------------------

-- 'Ödeme ve tahsilatlar' tab (FP:53, FP:68; totals FP:51 / FR:4-11).
CREATE OR REPLACE FUNCTION public.fin_list(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
BEGIN
  RETURN public.fin__list(v_clinic, public.clinic_today(), p_filters, p_page);
END;
$$;

-- 'Kayıt ayrıntısı' and payment history (FP:75-78), with the entry's audit history (newest first, at most 200).
CREATE OR REPLACE FUNCTION public.fin_entry_detail(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_e public.fin_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  RETURN jsonb_build_object(
    'today', v_today,
    'entry', public.fin__entry_json(v_clinic, p_id, v_today),
    'payments', public.fin__payments_json(v_clinic, p_id, true),
    'max_payment_cents', CASE WHEN v_e.cancelled_at IS NOT NULL THEN 0::bigint
                              ELSE v_e.amount_cents - public.fin__paid(v_e.id) END,
    'history', coalesce((
      SELECT jsonb_agg(h.obj ORDER BY h.created_at DESC, h.id DESC)
      FROM (
        SELECT al.id, al.created_at,
               jsonb_build_object(
                 'id', al.id,
                 'at', al.created_at,
                 'user_name', u.full_name,
                 'entity_type', al.entity_type,
                 'entity_id', al.entity_id,
                 'action', al.action,
                 'changes', al.changes,
                 'before_data', al.before_data,
                 'after_data', al.after_data) AS obj
        FROM public.audit_logs al
        LEFT JOIN public.users u ON u.id = al.user_id
        WHERE al.clinic_id = v_clinic
          AND ((al.entity_type = 'fin_entries' AND al.entity_id = p_id)
               OR (al.entity_type = 'fin_payments'
                   AND al.entity_id IN (SELECT p.id FROM public.fin_payments p
                                        WHERE p.clinic_id = v_clinic AND p.entry_id = p_id)))
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT 200
      ) h), '[]'::jsonb));
END;
$$;

-- Finance home page: cards FP:57-60, sources FP:62, groups FP:63, monthly card FP:65, report FP:71.
-- p_month 'YYYY-MM' or NULL (current month); a month after the current one → E_FILTER.
CREATE OR REPLACE FUNCTION public.fin_dashboard(p_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
BEGIN
  RETURN public.fin__dashboard(v_clinic, public.clinic_today(), p_month);
END;
$$;

-- '15 günlük plan' tab (FP:69): open entries due up to window_end, overdue included (FP:59), with the figures.
CREATE OR REPLACE FUNCTION public.fin_forecast(p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_fig jsonb;
  v_list jsonb;
BEGIN
  v_fig := public.fin__forecast_figures(v_clinic, v_today);
  v_list := public.fin__list(v_clinic, v_today, '{"upcoming": true}'::jsonb,
                             jsonb_build_object('offset', p_offset, 'limit', p_limit));
  RETURN jsonb_build_object(
    'today', v_today,
    'window_end', v_fig -> 'window_end',
    'forecast_days', v_fig -> 'forecast_days',
    'rows', v_list -> 'rows',
    'total_count', v_list -> 'total_count',
    'offset', v_list -> 'offset',
    'limit', v_list -> 'limit',
    'totals', v_list -> 'totals',
    'expected_in_cents', v_fig -> 'expected_in_cents',
    'expected_out_cents', v_fig -> 'expected_out_cents',
    'liquid_cents', v_fig -> 'liquid_cents',
    'after_payments_cents', v_fig -> 'after_payments_cents',
    'forecast_cents', v_fig -> 'forecast_cents',
    'snapshot_day', v_fig -> 'snapshot_day');
END;
$$;

-- 'Alacaklar / borçlar' (FM:79-81, FP:63).
CREATE OR REPLACE FUNCTION public.fin_open_groups()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
BEGIN
  RETURN public.fin__open_groups(v_clinic);
END;
$$;

-- 'Cariler' (FM:78-82, FP:70). Drill-down: fin_list with counterparty_id or counterparty_text.
CREATE OR REPLACE FUNCTION public.fin_counterparty_ledger(
  p_query text DEFAULT NULL,
  p_include_settled boolean DEFAULT false,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
BEGIN
  RETURN public.fin__counterparty_ledger(v_clinic, public.clinic_today(), p_query, p_include_settled, p_offset, p_limit);
END;
$$;

-- 'Bakiye geçmişi' (FP:72): snapshots newest day first; current_snapshot_id is the latest day <= today (FM:68).
CREATE OR REPLACE FUNCTION public.fin_balance_history(p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_offset integer := coalesce(p_offset, 0);
  v_limit integer := coalesce(p_limit, 50);
  v_total bigint;
BEGIN
  IF v_offset < 0 OR v_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;

  SELECT count(*)::bigint INTO v_total FROM public.fin_balance_snapshots s WHERE s.clinic_id = v_clinic;

  RETURN jsonb_build_object(
    'today', v_today,
    'current_snapshot_id', public.fin__current_snapshot_id(v_clinic, v_today),
    'rows', coalesce((
      SELECT jsonb_agg(public.fin__snapshot_json(v_clinic, pg.id, v_today) ORDER BY pg.day DESC)
      FROM (
        SELECT s.id, s.day
        FROM public.fin_balance_snapshots s
        WHERE s.clinic_id = v_clinic
        ORDER BY s.day DESC
        OFFSET v_offset
        LIMIT v_limit
      ) pg), '[]'::jsonb),
    'total_count', v_total,
    'offset', v_offset,
    'limit', v_limit);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3.6 'Finans geçmişi': audit_logs rows of the clinic for the nine fin_* tables (same visibility as §2.5).
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
       'fin_payments', 'fin_balance_snapshots', 'fin_balance_sources') THEN
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

-- ---------------------------------------------------------------------------
-- 3.8 Owner JSON export manifest (owner decision 3: no paid Supabase backups). Only an owner who also holds
--     'finance'. The page then reads each table directly (SELECT policy of §2.4), keyset-paged by id, and compares
--     the row counts with this manifest; a mismatch means a write happened meanwhile and the export restarts.
-- ---------------------------------------------------------------------------
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
      jsonb_build_object('name', 'audit_logs', 'filter', 'entity_type LIKE ''fin\_%''', 'row_count',
        (SELECT count(*) FROM public.audit_logs t WHERE t.clinic_id = v_clinic AND left(t.entity_type, 4) = 'fin_'))));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Seeds. No person or company names (owner decision 4): the legacy groups 'Alp' / 'Baykara' (FM:81), the name
--    lists (FC:7-8, FC:28-30) and the '%4 dahil' note (FP:65, IP:55) are not seeded; the owner recreates them as
--    counterparties, report groups and settings. Physician counterparties are not generated from doctors either.
--    Idempotent: accounts, the report group and settings only while the clinic has no fin_settings row (written
--    last, as the "seeded" marker), so a re-run never re-adds a row the owner renamed; system categories per
--    missing bucket. created_by stays NULL, so the audit rows carry user_id NULL like any SQL-editor write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__seed_clinic(p_clinic uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_seeded boolean;
  v_cash uuid;
  v_lab_group uuid;
BEGIN
  v_seeded := EXISTS (SELECT 1 FROM public.fin_settings s WHERE s.clinic_id = p_clinic);

  IF NOT v_seeded THEN
    -- Legacy account enum 'Banka' | 'Nakit' | 'Karma' (FM:25) plus POS. 'Karma' is kept inactive for migrated
    -- payments and refused for new ones (fin_record_payment), as the plan decided.
    INSERT INTO public.fin_accounts (id, clinic_id, name, kind, is_active, sort_order)
    VALUES (gen_random_uuid(), p_clinic, 'Banka', 'bank',  true,  10),
           (gen_random_uuid(), p_clinic, 'Nakit', 'cash',  true,  20),
           (gen_random_uuid(), p_clinic, 'POS',   'pos',   true,  30),
           (gen_random_uuid(), p_clinic, 'Karma', 'mixed', false, 40)
    ON CONFLICT DO NOTHING;

    SELECT a.id INTO v_cash
    FROM public.fin_accounts a
    WHERE a.clinic_id = p_clinic AND a.kind = 'cash' AND a.is_active
    ORDER BY a.sort_order, a.id
    LIMIT 1;

    -- 'Diğer borçlar' is implicit (NULL group), not a row. Lab is decided by category (C6, FM:81).
    INSERT INTO public.fin_report_groups (id, clinic_id, name, sort_order)
    VALUES (gen_random_uuid(), p_clinic, 'Laboratuvar', 10)
    ON CONFLICT DO NOTHING;

    SELECT g.id INTO v_lab_group
    FROM public.fin_report_groups g
    WHERE g.clinic_id = p_clinic AND public.fin__normalize_name(g.name) = public.fin__normalize_name('Laboratuvar')
    LIMIT 1;
  END IF;

  -- p1 §1.4: 14 system categories (legacy FM:4-18; 'Alp alacağı' FM:13 is folded into the doctor bucket, FR:19).
  -- A bucket whose system row exists, or whose name the owner already uses, is skipped.
  INSERT INTO public.fin_categories (id, clinic_id, name, direction, profit_class, report_bucket, report_group_id,
                                     is_system, is_active, sort_order)
  SELECT gen_random_uuid(), p_clinic, s.name, s.direction, s.profit_class, s.bucket,
         CASE WHEN s.bucket = 'lab' THEN v_lab_group END,
         true, true, s.sort_order
  FROM (VALUES
    ('Hasta tahsilatı',              'in',  'income',  'patient_receipts', 10),
    ('Diğer faaliyet geliri',        'in',  'income',  'other_income',     20),
    ('Kira',                         'out', 'expense', 'rent',             30),
    ('Hekim hakedişi',               'out', 'expense', 'doctor',           40),
    ('Laboratuvar',                  'out', 'expense', 'lab',              50),
    ('Sarf / tedarikçi',             'out', 'expense', 'supplies',         60),
    ('Personel',                     'out', 'expense', 'personnel',        70),
    ('Vergi / SGK',                  'out', 'expense', 'tax',              80),
    ('Diğer faaliyet gideri',        'out', 'expense', 'other_expense',    90),
    ('Ortak dağıtımı',               'out', 'none',    'distribution',     100),
    ('Sermaye / borç girişi',        'in',  'none',    'capital',          110),
    ('Kredi / borç anapara ödemesi', 'out', 'none',    'principal',        120),
    ('Faiz / banka masrafı',         'out', 'expense', 'fees',             130),
    ('Demirbaş alımı',               'out', 'none',    'asset',            140)
  ) AS s(name, direction, profit_class, bucket, sort_order)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.fin_categories c
    WHERE c.clinic_id = p_clinic
      AND ((c.is_system AND c.report_bucket = s.bucket)
           OR public.fin__normalize_name(c.name) = public.fin__normalize_name(s.name))
  )
  ON CONFLICT DO NOTHING;

  IF NOT v_seeded THEN
    -- Legacy constants become data: buffer 1.000.000 TL (FM:76), 15-day window (FM:73), entitlement account
    -- 'Nakit' (IP:55). physician_fee_note and report_brand_name start empty.
    INSERT INTO public.fin_settings (clinic_id, buffer_target_cents, forecast_days, entitlement_account_id)
    VALUES (p_clinic, 100000000, 15, v_cash)
    ON CONFLICT (clinic_id) DO NOTHING;
  END IF;
END;
$$;

DO $$
DECLARE
  v_clinic record;
BEGIN
  FOR v_clinic IN SELECT c.id FROM public.clinics c ORDER BY c.id
  LOOP
    PERFORM public.fin__seed_clinic(v_clinic.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2.6 Function privileges (pattern of 0019 §11, generalised) and self-checks, packaged as one function so every
--     later migration that creates or changes a fin_* function can end with one line:
--         SELECT public.fin__harden_privileges();
--     PostgreSQL grants EXECUTE to PUBLIC on every new function (and Supabase's default privileges add anon and
--     authenticated); CREATE OR REPLACE keeps the ACL, but a new overload or a DROP + CREATE does not.
--     The function: every fin_* / fin__* function loses EXECUTE from PUBLIC, anon and authenticated; public RPCs
--     (single underscore) are then granted to authenticated; internal helpers (fin__*) never are. Then it checks
--     no overloads, every RPC SECURITY DEFINER + search_path, no internal helper other than a trigger function is
--     SECURITY DEFINER (fail closed), nothing internal or anything at all callable by anon, table privileges.
--     It runs as the caller (the migration owner) and is itself never granted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__harden_privileges()
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
    WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_f.sig);
    IF v_f.proname NOT LIKE 'fin\_\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_f.sig);
    END IF;
  END LOOP;

  -- No overloads (p1 §1.3).
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'fin_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- Every public RPC is SECURITY DEFINER with search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' AND p.proname NOT LIKE 'fin\_\_%'
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  -- Internal helpers fail closed: only trigger functions may be SECURITY DEFINER (they cannot be called over
  -- the API). Every other fin__* runs as its caller, so an accidental grant gives no more than RLS allows.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_\_%'
    AND p.prosecdef AND p.prorettype <> 'trigger'::regtype;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar SECURITY DEFINER olmamalı: %', v_bad;
  END IF;

  -- No internal helper is callable from the API, and anon can call nothing.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR (p.proname LIKE 'fin\_\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar API''ye açık: %', v_bad;
  END IF;

  -- fin_* tables: SELECT only for authenticated, nothing for anon.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories', 'fin_counterparties',
                    'fin_entries', 'fin_payments', 'fin_balance_snapshots', 'fin_balance_sources']) AS t(tbl)
  WHERE has_table_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', format('public.%I', t.tbl), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', t.tbl), 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'fin_* tablo yetkileri beklenen gibi değil: %', v_bad;
  END IF;
END;
$$;

SELECT public.fin__harden_privileges();

-- Self-check specific to this migration: every clinic is seeded.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(c.id::text, ', ') INTO v_bad
  FROM public.clinics c
  WHERE NOT EXISTS (SELECT 1 FROM public.fin_settings s WHERE s.clinic_id = c.id)
     OR NOT EXISTS (SELECT 1 FROM public.fin_categories k
                    WHERE k.clinic_id = c.id AND k.is_system AND k.report_bucket = 'doctor');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Finans varsayılanları eksik klinikler: %', v_bad;
  END IF;
END $$;

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
