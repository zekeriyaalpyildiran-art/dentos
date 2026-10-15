-- Phases 2 + 4: file imports, bank matching, classification rules, saved column maps, balances from files and
-- patient financing (Dosyadan aktar / Hasta finansmanı). Safe to re-run.
--
-- Contract: spec_parts p2i_db_contract.md (schema, RPCs, error texts, seeds), p2i_parsers_rules.md (browser side).
-- Requires 0019_phase0_security.sql and 0020_finance_ledger.sql. Extends 0020; everything 0020 defines stays valid
-- unless replaced here with the same signature (fin__settings_json, fin__entry_json, fin_audit_list,
-- fin_export_manifest, fin__seed_clinic, fin__harden_privileges, fin__trg_touch).
--
--  * Files are parsed in the browser and never uploaded. Source keys and fingerprints (SHA-256 of the legacy JSON) are
--    computed client-side; the database stores and compares fingerprints, never recomputes them. It does check that a
--    key means its row (template, embedded day, receipts = inflow) and recomputes the deterministic ids
--    (sha256('<clinic>|<key>'), fin__import_id) to refuse any other id.
--  * Uniqueness of imported and matched source keys lives in fin_import_sources only (one namespace, C15).
--  * Duplicate conditions are warnings re-checked at write time; a flagged row is saved only when the row's
--    'acknowledged' array names the warning (C9). Hard refusals are listed in the RPC comments.
--  * Workbook receipts vs manual patient receipts are reconciled live by deferred triggers (C12); the result is an
--    audited exclusion (exclusion_source = 'receipt_reconciliation'), so the 0020 report formulas need no change.
--  * Financing fee entries are locked against the generic 0020 RPCs by a trigger; the fin_financing_* RPCs are the
--    only way to change them (C7). The gross is never booked: it is already in the clinic's daily receipts.
--  * No clinic-specific data in code: account <-> file mapping (fin_accounts.import_key, fin_import_layouts), the
--    workbook column map (fin_import_layouts.config), name rules (fin_classification_rules) and the financing bank
--    (fin_settings) are rows. Seeds are generic keyword rules only, without person or company names.
--  * Same conventions as 0020: SECURITY DEFINER + search_path on every public RPC, clinic from the session, integer
--    cents, TRY only, Turkish error texts with 42501 / PT404 / PT409 / P0001, internal fin__* helpers never granted.
--  * Write context: RPCs of this part mark their transaction with set_config('fin.ctx', ..., true) so the guard
--    triggers can tell them from the generic 0020 RPCs. PostgREST cannot set this setting.

BEGIN;

-- ---------------------------------------------------------------------------
-- 2.0 Preflight: 0019 + 0020 must be live, every clinic seeded, and any table of this part left by an earlier run
--     must already have the shape created below.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'audit_row_change',
                    'fin__require_read', 'fin__require_write', 'fin__harden_privileges', 'fin__check_account',
                    'fin__entry_input', 'fin__paid', 'fin__normalize_name', 'fin__tr_lower', 'fin__reason',
                    'fin__amount', 'fin__day', 'fin__month', 'fin__month_start', 'fin__page', 'fin__bump_entry',
                    'fin__entry_envelope', 'fin__entry_json', 'fin__entries_state', 'fin__settings_json',
                    'fin__account_json', 'fin__user_name', 'fin__name', 'fin__sort_order', 'fin__report_month',
                    'fin__trg_touch', 'fin__trg_no_delete', 'fin_can_read', 'fin_merge_balance_sources',
                    'fin__seed_clinic']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 1 eksik, önce 0020 uygulanmalı: %', v_missing;
  END IF;

  SELECT string_agg(t.tbl, ', ')
    INTO v_missing
  FROM unnest(ARRAY['fin_settings', 'fin_accounts', 'fin_report_groups', 'fin_categories', 'fin_counterparties',
                    'fin_entries', 'fin_payments', 'fin_balance_snapshots', 'fin_balance_sources', 'patients',
                    'clinics', 'users', 'audit_logs']) AS t(tbl)
  WHERE to_regclass(format('public.%I', t.tbl)) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 1 eksik, önce 0020 uygulanmalı: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES ('patients', 'id'), ('patients', 'clinic_id'), ('patients', 'full_name')) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı: %', v_missing;
  END IF;

  -- Every clinic needs the system categories this part books to (0020 seeds).
  SELECT string_agg(c.id::text || ':' || b.bucket, ', ')
    INTO v_missing
  FROM public.clinics c
  CROSS JOIN unnest(ARRAY['patient_receipts', 'fees', 'doctor']) AS b(bucket)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.fin_categories k
    WHERE k.clinic_id = c.id AND k.is_system AND k.report_bucket = b.bucket
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 1 eksik, önce 0020 uygulanmalı (sistem kategorileri): %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_import_batches', 'id'), ('fin_import_batches', 'clinic_id'), ('fin_import_batches', 'kind'),
    ('fin_import_batches', 'month'), ('fin_import_batches', 'file_names'), ('fin_import_batches', 'layout_ids'),
    ('fin_import_batches', 'rows_sent'), ('fin_import_batches', 'inserted'), ('fin_import_batches', 'matched'),
    ('fin_import_batches', 'skipped'), ('fin_import_batches', 'acknowledged'), ('fin_import_batches', 'result'),
    ('fin_import_batches', 'created_by'), ('fin_import_batches', 'created_at'),
    ('fin_import_sources', 'id'), ('fin_import_sources', 'clinic_id'), ('fin_import_sources', 'source_key'),
    ('fin_import_sources', 'source_kind'), ('fin_import_sources', 'link_kind'), ('fin_import_sources', 'fingerprint'),
    ('fin_import_sources', 'file_name'), ('fin_import_sources', 'entry_id'), ('fin_import_sources', 'payment_id'),
    ('fin_import_sources', 'batch_id'), ('fin_import_sources', 'txn_date'), ('fin_import_sources', 'amount_cents'),
    ('fin_import_sources', 'origin'), ('fin_import_sources', 'rebind_count'), ('fin_import_sources', 'rebound_at'),
    ('fin_import_sources', 'rebound_by'), ('fin_import_sources', 'imported_by'), ('fin_import_sources', 'imported_at'),
    ('fin_classification_rules', 'id'), ('fin_classification_rules', 'clinic_id'),
    ('fin_classification_rules', 'priority'), ('fin_classification_rules', 'scope'),
    ('fin_classification_rules', 'match_kind'), ('fin_classification_rules', 'pattern'),
    ('fin_classification_rules', 'category_id'), ('fin_classification_rules', 'subcategory'),
    ('fin_classification_rules', 'counterparty_id'), ('fin_classification_rules', 'requires_entitlement_month'),
    ('fin_classification_rules', 'auto_select'), ('fin_classification_rules', 'warning'),
    ('fin_classification_rules', 'is_active'), ('fin_classification_rules', 'is_seed'),
    ('fin_classification_rules', 'version'), ('fin_classification_rules', 'created_by'),
    ('fin_classification_rules', 'created_at'), ('fin_classification_rules', 'updated_by'),
    ('fin_classification_rules', 'updated_at'),
    ('fin_import_layouts', 'id'), ('fin_import_layouts', 'clinic_id'), ('fin_import_layouts', 'kind'),
    ('fin_import_layouts', 'name'), ('fin_import_layouts', 'config'), ('fin_import_layouts', 'key_label'),
    ('fin_import_layouts', 'account_id'), ('fin_import_layouts', 'receipts_account_id'),
    ('fin_import_layouts', 'bank_paid_account_id'), ('fin_import_layouts', 'cash_paid_account_id'),
    ('fin_import_layouts', 'is_default'), ('fin_import_layouts', 'is_active'), ('fin_import_layouts', 'sort_order'),
    ('fin_import_layouts', 'version'), ('fin_import_layouts', 'created_by'), ('fin_import_layouts', 'created_at'),
    ('fin_import_layouts', 'updated_by'), ('fin_import_layouts', 'updated_at'),
    ('fin_patient_financing', 'id'), ('fin_patient_financing', 'clinic_id'), ('fin_patient_financing', 'provider'),
    ('fin_patient_financing', 'reference'), ('fin_patient_financing', 'loan_key'),
    ('fin_patient_financing', 'patient_name_raw'), ('fin_patient_financing', 'patient_id'),
    ('fin_patient_financing', 'txn_date'), ('fin_patient_financing', 'currency'),
    ('fin_patient_financing', 'gross_cents'), ('fin_patient_financing', 'commission_cents'),
    ('fin_patient_financing', 'kkdf_cents'), ('fin_patient_financing', 'bsmv_cents'),
    ('fin_patient_financing', 'fee_cents'), ('fin_patient_financing', 'net_cents'),
    ('fin_patient_financing', 'blocked'), ('fin_patient_financing', 'expected_release'),
    ('fin_patient_financing', 'released_on'), ('fin_patient_financing', 'released_at'),
    ('fin_patient_financing', 'released_by'), ('fin_patient_financing', 'source_key'),
    ('fin_patient_financing', 'source_file'), ('fin_patient_financing', 'entry_id'),
    ('fin_patient_financing', 'voided_at'), ('fin_patient_financing', 'voided_by'),
    ('fin_patient_financing', 'void_reason'), ('fin_patient_financing', 'corrected_at'),
    ('fin_patient_financing', 'corrected_by'), ('fin_patient_financing', 'correction_reason'),
    ('fin_patient_financing', 'version'), ('fin_patient_financing', 'created_by'),
    ('fin_patient_financing', 'created_at'), ('fin_patient_financing', 'updated_by'),
    ('fin_patient_financing', 'updated_at')
  ) AS e(tbl, col)
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut Faz 2/4 tabloları beklenen yapıda değil: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2.1 Internal helpers. Never granted. LANGUAGE sql IMMUTABLE ones have no SET clause so they stay inlinable and
--     usable in index / generated-column expressions; every name in them is schema-qualified.
-- ---------------------------------------------------------------------------

-- Accent folding of the generic bank-table mapper (legacy BT:5 norm: NFD + strip marks, ı → i), on top of the
-- Turkish lower case of 0020. A fixed translate list, so it does not depend on the database's ICU / LC_CTYPE.
CREATE OR REPLACE FUNCTION public.fin__fold(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
           pg_catalog.translate(public.fin__tr_lower(p), 'çğıöşüâîûéèêëáàäíìïóòúùñ', 'cgiosuaiueeeeaaaiiioouun'),
           '\s+', ' ', 'g'))
$$;

-- Matching text of the debt suggestions (legacy MT:3 norm): folded, everything outside [a-z0-9 ] becomes a space.
CREATE OR REPLACE FUNCTION public.fin__match_text(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(public.fin__fold(p), '[^a-z0-9 ]', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;

-- 'YYYY-MM-DD' without DateStyle involvement (used in the generated financing source key).
CREATE OR REPLACE FUNCTION public.fin__iso_date(p date)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.lpad((EXTRACT(YEAR FROM p))::integer::text, 4, '0') || '-'
      || pg_catalog.lpad((EXTRACT(MONTH FROM p))::integer::text, 2, '0') || '-'
      || pg_catalog.lpad((EXTRACT(DAY FROM p))::integer::text, 2, '0')
$$;

-- Row context of every per-row import error (legacy IR:17): '<file> · <YYYY-MM-DD> · <n>. seçili satır'.
CREATE OR REPLACE FUNCTION public.fin__row_ctx(p_file text, p_date date, p_row_no integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(nullif(left(pg_catalog.btrim(coalesce(p_file, '')), 200), ''), 'Dosya')
      || ' · ' || coalesce(public.fin__iso_date(p_date), '')
      || ' · ' || coalesce(p_row_no::text, '?') || '. seçili satır'
$$;

-- '<branch>-<loan>' of a financing reference (legacy RT:64, IR:24, BF:22).
CREATE OR REPLACE FUNCTION public.fin__loan_key(p_reference text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT pg_catalog.split_part(p_reference, '-', 1) || '-' || pg_catalog.split_part(p_reference, '-', 2)
$$;

-- FORMAT KNOWLEDGE, not clinic data: every fee line of the patient-financing provider's statement carries the
-- narration marker 'Bayi Katkı Faizi' (legacy BF:15, IR:24, RT:46). Folded on both sides, so dotted / dotless
-- capitals ('BAYI KATKI FAIZI') match as legacy's case-insensitive regex did.
CREATE OR REPLACE FUNCTION public.fin__financing_marker(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(pg_catalog.strpos(public.fin__fold(p), 'bayi katki faizi') > 0, false)
$$;

-- Transaction-local write context (§1 item 4). Returns the previous value so callers can restore it.
CREATE OR REPLACE FUNCTION public.fin__set_ctx(p text)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prev text := coalesce(current_setting('fin.ctx', true), '');
BEGIN
  PERFORM set_config('fin.ctx', coalesce(p, ''), true);
  RETURN v_prev;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin__ctx()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(pg_catalog.current_setting('fin.ctx', true), '')
$$;

-- Daily receipts key of the clinic workbook ('clinic') or of DentOS payments ('dentos', Phase 5). C13.
CREATE OR REPLACE FUNCTION public.fin__receipts_key(p_kind text, p_day date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_kind IN ('clinic', 'dentos') THEN p_kind || ':' || public.fin__iso_date(p_day) || ':receipts' END
$$;

-- Input parsing without exceptions (no subtransaction per value). NULL means "missing or malformed".
CREATE OR REPLACE FUNCTION public.fin__is_uuid(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;

CREATE OR REPLACE FUNCTION public.fin__json_text(p jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(p) = 'string' THEN p #>> '{}' END
$$;

CREATE OR REPLACE FUNCTION public.fin__json_uuid(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'string' OR NOT public.fin__is_uuid(p #>> '{}') THEN
    RETURN NULL;
  END IF;
  RETURN (p #>> '{}')::uuid;
END;
$$;

-- An integral JSON number within [p_min, p_max] (1.0, 1e3, strings and booleans are refused).
CREATE OR REPLACE FUNCTION public.fin__json_int(p jsonb, p_min bigint, p_max bigint)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_t text;
  v_n bigint;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'number' THEN
    RETURN NULL;
  END IF;
  v_t := p #>> '{}';
  IF v_t !~ '^-?\d{1,15}$' THEN
    RETURN NULL;
  END IF;
  v_n := v_t::bigint;
  IF v_n < p_min OR v_n > p_max THEN
    RETURN NULL;
  END IF;
  RETURN v_n;
END;
$$;

-- 'YYYY-MM-DD' that exists on the calendar, 2000-01-01 .. 2100-12-31 (E_DATE bounds of 0020), else NULL.
CREATE OR REPLACE FUNCTION public.fin__parse_day(p text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_y integer;
  v_m integer;
  v_d integer;
  v_last integer;
BEGIN
  IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;
  v_y := substr(p, 1, 4)::integer;
  v_m := substr(p, 6, 2)::integer;
  v_d := substr(p, 9, 2)::integer;
  IF v_y < 2000 OR v_y > 2100 OR v_m < 1 OR v_m > 12 OR v_d < 1 THEN
    RETURN NULL;
  END IF;
  v_last := EXTRACT(DAY FROM (make_date(v_y, v_m, 1) + interval '1 month' - interval '1 day'))::integer;
  IF v_d > v_last THEN
    RETURN NULL;
  END IF;
  RETURN make_date(v_y, v_m, v_d);
END;
$$;

-- Raises one per-row import error: '<ctx>: <text>' with DETAIL = JSON text {row_no, key, ...} (§1 item 1).
CREATE OR REPLACE FUNCTION public.fin__row_raise(p_ctx text, p_text text, p_code text, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = p_ctx || ': ' || p_text,
                        ERRCODE = coalesce(p_code, 'P0001'),
                        DETAIL = coalesce(p_detail, '{}'::jsonb)::text;
END;
$$;

-- E_IMPORT_FIELD: '{ctx}: {label} geçersiz. ...'
CREATE OR REPLACE FUNCTION public.fin__row_field(p_ctx text, p_label text, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.fin__row_raise(p_ctx,
    p_label || ' geçersiz. İlgili satırı düzeltin veya seçimden çıkarın. Hiçbir kayıt aktarılmadı.',
    'P0001', p_detail);
END;
$$;

-- Deterministic import ids (p2i_db_contract §3.2, keys.ts uuidShape): uuid shape of sha256('<clinic>|<key>'). The
-- browser computes them; the RPCs recompute and refuse any other id, so a client can never place rows under ids
-- of its choosing (the ids include the clinic, so another clinic's ids can never be produced either). Financing
-- rows use the key 'financing|<source key>' (keys.ts financingRowId).
CREATE OR REPLACE FUNCTION public.fin__import_id(p_clinic uuid, p_key text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (pg_catalog.substr(x.h, 1, 8) || '-' || pg_catalog.substr(x.h, 9, 4) || '-4' || pg_catalog.substr(x.h, 14, 3)
          || '-a' || pg_catalog.substr(x.h, 18, 3) || '-' || pg_catalog.substr(x.h, 21, 12))::uuid
  FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_clinic::text || '|' || p_key, 'UTF8')), 'hex')
          AS h) x
$$;

-- Shape and meaning of a review-table source key (keys.ts templates). The key is the row's identity and drives the
-- financing coverage and the daily-receipts exclusivity, so it must agree with the row:
--   clinic_excel 'clinic:<day>:receipts' (an inflow) or 'clinic:<day>:expense:<n>' (an outflow), <day> = row day;
--   bank_known   'bank:<Bank>:<account>:<day>:...', <day> = row day;
--   bank_table   'bank-table:<sha256 hex>'.
-- p_direction NULL skips the direction part (fin_import_check rows may omit it). The receipts category rule needs
-- the category and is checked by fin_import_rows.
CREATE OR REPLACE FUNCTION public.fin__source_key_ok(p_kind text, p_key text, p_date date, p_direction text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(CASE p_kind
    WHEN 'clinic_excel' THEN
      p_key ~ '^clinic:\d{4}-\d{2}-\d{2}:(receipts|expense:[1-9]\d{0,4})$'
      AND pg_catalog.substr(p_key, 8, 10) = public.fin__iso_date(p_date)
      AND (p_direction IS NULL
           OR p_direction = CASE WHEN pg_catalog.right(p_key, 9) = ':receipts' THEN 'in' ELSE 'out' END)
    WHEN 'bank_known' THEN
      (pg_catalog.regexp_match(p_key, '^bank:[^:]+:[^:]+:(\d{4}-\d{2}-\d{2}):'))[1] = public.fin__iso_date(p_date)
    WHEN 'bank_table' THEN
      p_key ~ '^bank-table:[0-9a-f]{64}$'
    ELSE false
  END, false)
$$;

-- Regex patterns saved by finance editors run in the browser against outsider-controlled text (EFT narrations,
-- workbook cells). Server backstop of classify.ts regexSafetyProblem (which is stricter): back-references,
-- look-behind and a repeated group that itself contains a repetition ('(a+)+', '(\w+\s?)+') are refused.
CREATE OR REPLACE FUNCTION public.fin__regex_unsafe(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(
    p ~ '\\[1-9]'
    OR pg_catalog.strpos(p, '\k<') > 0
    OR p ~ '\(\?<[=!]'
    OR p ~ '\([^()]*([*+]|\{\d+,\d*\})[^()]*\)\s*([*+]|\{\d+,)',
    false)
$$;

-- ---------------------------------------------------------------------------
-- 2.2 fin_settings: financing and import settings (defaults for every clinic come from the column defaults).
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_settings
  ADD COLUMN IF NOT EXISTS financing_receipts_source text NOT NULL DEFAULT 'clinic_excel'
    CHECK (financing_receipts_source IN ('clinic_excel', 'dentos_payments')),
  ADD COLUMN IF NOT EXISTS default_block_days integer NOT NULL DEFAULT 30
    CHECK (default_block_days BETWEEN 0 AND 365),
  ADD COLUMN IF NOT EXISTS financing_counterparty_id uuid,
  ADD COLUMN IF NOT EXISTS financing_account_id uuid,
  ADD COLUMN IF NOT EXISTS import_rules_seeded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fin_settings'::regclass AND conname = 'fin_settings_financing_counterparty_fkey'
  ) THEN
    ALTER TABLE public.fin_settings
      ADD CONSTRAINT fin_settings_financing_counterparty_fkey
      FOREIGN KEY (clinic_id, financing_counterparty_id) REFERENCES public.fin_counterparties (clinic_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fin_settings'::regclass AND conname = 'fin_settings_financing_account_fkey'
  ) THEN
    ALTER TABLE public.fin_settings
      ADD CONSTRAINT fin_settings_financing_account_fkey
      FOREIGN KEY (clinic_id, financing_account_id) REFERENCES public.fin_accounts (clinic_id, id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2.3 fin_entries: exclusion source (live receipt reconciliation, C12). Phase 1 exclusions are all manual.
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_entries
  ADD COLUMN IF NOT EXISTS exclusion_source text
    CHECK (exclusion_source IS NULL OR exclusion_source IN ('manual', 'receipt_reconciliation')),
  ADD COLUMN IF NOT EXISTS reconciled_month date;

UPDATE public.fin_entries SET exclusion_source = 'manual'
WHERE excluded_from_totals AND exclusion_source IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fin_entries'::regclass AND conname = 'fin_entries_exclusion_source_shape'
  ) THEN
    ALTER TABLE public.fin_entries ADD CONSTRAINT fin_entries_exclusion_source_shape CHECK (
      (NOT excluded_from_totals AND exclusion_source IS NULL AND reconciled_month IS NULL)
      OR (excluded_from_totals AND exclusion_source = 'manual' AND reconciled_month IS NULL)
      OR (excluded_from_totals AND exclusion_source = 'receipt_reconciliation'
          AND reconciled_month IS NOT NULL AND EXTRACT(DAY FROM reconciled_month) = 1)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2.7 fin_import_layouts: saved column maps (generic bank mapper) and the clinic workbook map + accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_import_layouts (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('clinic_workbook', 'bank_table')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 32768),
  key_label text CHECK (key_label IS NULL OR char_length(btrim(key_label)) BETWEEN 1 AND 100),
  account_id uuid,
  receipts_account_id uuid,
  bank_paid_account_id uuid,
  cash_paid_account_id uuid,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, account_id) REFERENCES public.fin_accounts (clinic_id, id),
  FOREIGN KEY (clinic_id, receipts_account_id) REFERENCES public.fin_accounts (clinic_id, id),
  FOREIGN KEY (clinic_id, bank_paid_account_id) REFERENCES public.fin_accounts (clinic_id, id),
  FOREIGN KEY (clinic_id, cash_paid_account_id) REFERENCES public.fin_accounts (clinic_id, id),
  CONSTRAINT fin_import_layouts_shape CHECK (
    (kind = 'bank_table' AND key_label IS NOT NULL AND account_id IS NOT NULL
       AND receipts_account_id IS NULL AND bank_paid_account_id IS NULL AND cash_paid_account_id IS NULL)
    OR (kind = 'clinic_workbook' AND key_label IS NULL AND account_id IS NULL
       AND receipts_account_id IS NOT NULL AND bank_paid_account_id IS NOT NULL AND cash_paid_account_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_import_layouts_name_key
  ON public.fin_import_layouts (clinic_id, kind, public.fin__normalize_name(name));
-- Two labels that legacy would fold to the same key identity (BT:48: norm(account) without spaces) are refused.
CREATE UNIQUE INDEX IF NOT EXISTS fin_import_layouts_key_label_key
  ON public.fin_import_layouts (clinic_id, (pg_catalog.regexp_replace(public.fin__fold(key_label), '\s', '', 'g')))
  WHERE kind = 'bank_table';
CREATE UNIQUE INDEX IF NOT EXISTS fin_import_layouts_default_key
  ON public.fin_import_layouts (clinic_id, kind) WHERE is_default AND is_active;

-- ---------------------------------------------------------------------------
-- 2.4 fin_import_batches: one row per confirmed import or financing upload. Insert-only; the stored result is
--     replayed when the client retries the same batch id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_import_batches (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('rows', 'financing')),
  month date CHECK (month IS NULL OR EXTRACT(DAY FROM month) = 1),
  file_names text[] NOT NULL DEFAULT '{}' CHECK (cardinality(file_names) <= 50),
  layout_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(layout_ids) <= 50),
  rows_sent integer NOT NULL CHECK (rows_sent BETWEEN 1 AND 500),
  inserted integer NOT NULL CHECK (inserted >= 0),
  matched integer NOT NULL CHECK (matched >= 0),
  skipped integer NOT NULL CHECK (skipped >= 0),
  acknowledged integer NOT NULL DEFAULT 0 CHECK (acknowledged >= 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_import_batches_month CHECK ((kind = 'rows') = (month IS NOT NULL)),
  CONSTRAINT fin_import_batches_counts CHECK (inserted + matched + skipped = rows_sent)
);
CREATE INDEX IF NOT EXISTS idx_fin_import_batches_created
  ON public.fin_import_batches (clinic_id, created_at DESC, id);

-- ---------------------------------------------------------------------------
-- 2.5 fin_import_sources: the one namespace of imported and matched source keys (C15).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_import_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 800),
  source_kind text NOT NULL
    CHECK (source_kind IN ('clinic_excel', 'bank_known', 'bank_table', 'financing', 'migration')),
  link_kind text NOT NULL CHECK (link_kind IN ('entry', 'payment_match')),
  fingerprint text CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 200),
  entry_id uuid NOT NULL,
  payment_id uuid,
  batch_id uuid,
  txn_date date,
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents BETWEEN 1 AND 1000000000000),
  origin text NOT NULL DEFAULT 'runtime' CHECK (origin IN ('runtime', 'migration')),
  rebind_count integer NOT NULL DEFAULT 0 CHECK (rebind_count >= 0),
  rebound_at timestamptz,
  rebound_by uuid REFERENCES public.users(id),
  imported_by uuid REFERENCES public.users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, source_key),
  FOREIGN KEY (clinic_id, entry_id) REFERENCES public.fin_entries (clinic_id, id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES public.fin_payments (clinic_id, id),
  -- Deferred: the RPC writes the batch row last, once its counts are known.
  FOREIGN KEY (clinic_id, batch_id) REFERENCES public.fin_import_batches (clinic_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fin_import_sources_prefix CHECK (CASE source_kind
      WHEN 'clinic_excel' THEN source_key LIKE 'clinic:%'
      WHEN 'bank_known'   THEN source_key LIKE 'bank:%'
      WHEN 'bank_table'   THEN source_key LIKE 'bank-table:%'
      WHEN 'financing'    THEN source_key ~ '^[a-z][a-z0-9_]*-finance:'
      ELSE origin = 'migration' END),
  CONSTRAINT fin_import_sources_link CHECK (
    (link_kind = 'entry')
    OR (link_kind = 'payment_match' AND payment_id IS NOT NULL
        AND source_kind IN ('bank_known', 'bank_table', 'migration'))),
  CONSTRAINT fin_import_sources_fingerprint CHECK (
    origin = 'migration' OR link_kind = 'payment_match' OR source_kind = 'financing' OR fingerprint IS NOT NULL),
  CONSTRAINT fin_import_sources_runtime_batch CHECK (origin = 'migration' OR batch_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_fin_import_sources_entry ON public.fin_import_sources (clinic_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_fin_import_sources_batch ON public.fin_import_sources (clinic_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_fin_import_sources_payment
  ON public.fin_import_sources (payment_id) WHERE payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.6 fin_classification_rules: owner-editable defaults of the review table (replaces legacy FI:8-22 / FC:7-10).
--     The direction of a rule is its category's direction. Patterns are evaluated in the browser only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_classification_rules (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 10000),
  scope text NOT NULL DEFAULT 'any' CHECK (scope IN ('any', 'bank', 'clinic')),
  match_kind text NOT NULL CHECK (match_kind IN ('contains', 'starts_with', 'exact', 'regex', 'always')),
  pattern text CHECK (pattern IS NULL OR char_length(pattern) BETWEEN 1 AND 300),
  category_id uuid NOT NULL,
  subcategory text CHECK (subcategory IS NULL OR subcategory IN ('current_physician', 'past_physician_debt', 'official_fee')),
  counterparty_id uuid,
  requires_entitlement_month boolean NOT NULL DEFAULT false,
  auto_select boolean NOT NULL DEFAULT false,
  warning text NOT NULL DEFAULT '' CHECK (char_length(warning) <= 300),
  is_active boolean NOT NULL DEFAULT true,
  is_seed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, category_id) REFERENCES public.fin_categories (clinic_id, id),
  FOREIGN KEY (clinic_id, counterparty_id) REFERENCES public.fin_counterparties (clinic_id, id),
  CONSTRAINT fin_classification_rules_pattern CHECK ((match_kind = 'always') = (pattern IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_fin_classification_rules_order
  ON public.fin_classification_rules (clinic_id, priority, created_at, id);

-- ---------------------------------------------------------------------------
-- 2.8 fin_patient_financing (Phase 4; legacy entry financing block, BF:6). One row per loan and transaction day. The gross
--     is never booked here (it is in that day's clinic receipts); the realized fee entry is the only ledger effect.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_patient_financing (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  -- Allow-list of known statement formats (the provider is part of the legacy source key 'burgan-finance:...');
  -- a new provider is added by a migration, never chosen by a client.
  provider text NOT NULL CHECK (provider IN ('burgan')),
  reference text NOT NULL CHECK (reference ~ '^\d{1,10}-\d{7,20}-1$'),
  loan_key text GENERATED ALWAYS AS (split_part(reference, '-', 1) || '-' || split_part(reference, '-', 2)) STORED,
  patient_name_raw text NOT NULL CHECK (char_length(btrim(patient_name_raw)) BETWEEN 1 AND 200),
  patient_id uuid REFERENCES public.patients(id) ON DELETE SET NULL,
  txn_date date NOT NULL CHECK (txn_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  currency char(3) NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  gross_cents bigint NOT NULL CHECK (gross_cents BETWEEN 1 AND 1000000000000),
  commission_cents bigint NOT NULL CHECK (commission_cents BETWEEN 0 AND 1000000000000),
  kkdf_cents bigint NOT NULL CHECK (kkdf_cents BETWEEN 0 AND 1000000000000),
  bsmv_cents bigint NOT NULL CHECK (bsmv_cents BETWEEN 0 AND 1000000000000),
  fee_cents bigint GENERATED ALWAYS AS (commission_cents + kkdf_cents + bsmv_cents) STORED,
  net_cents bigint GENERATED ALWAYS AS (gross_cents - commission_cents - kkdf_cents - bsmv_cents) STORED,
  blocked boolean NOT NULL,
  expected_release date,
  released_on date,
  released_at timestamptz,
  released_by uuid REFERENCES public.users(id),
  source_key text GENERATED ALWAYS AS
    (provider || '-finance:' || reference || ':' || public.fin__iso_date(txn_date)) STORED,
  source_file text CHECK (source_file IS NULL OR char_length(source_file) <= 200),
  entry_id uuid NOT NULL UNIQUE,
  voided_at timestamptz,
  voided_by uuid REFERENCES public.users(id),
  void_reason text,
  corrected_at timestamptz,
  corrected_by uuid REFERENCES public.users(id),
  correction_reason text CHECK (correction_reason IS NULL OR char_length(correction_reason) BETWEEN 3 AND 500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, source_key),
  FOREIGN KEY (clinic_id, entry_id) REFERENCES public.fin_entries (clinic_id, id),
  CONSTRAINT fin_patient_financing_fees CHECK (
    commission_cents + kkdf_cents + bsmv_cents > 0
    AND commission_cents + kkdf_cents + bsmv_cents < gross_cents),
  CONSTRAINT fin_patient_financing_block CHECK (
    (blocked AND expected_release IS NOT NULL AND expected_release >= txn_date)
    OR (NOT blocked AND expected_release IS NULL)),
  CONSTRAINT fin_patient_financing_release CHECK (
    (released_on IS NULL AND released_at IS NULL AND released_by IS NULL)
    OR (blocked AND released_on IS NOT NULL AND released_on >= txn_date AND released_at IS NOT NULL)),
  CONSTRAINT fin_patient_financing_void CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 3 AND 500))
);
CREATE INDEX IF NOT EXISTS idx_fin_patient_financing_day ON public.fin_patient_financing (clinic_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_fin_patient_financing_loan ON public.fin_patient_financing (clinic_id, loan_key);
-- One row per loan and day whatever the provider string, voided rows included ('a voided key stays forever').
CREATE UNIQUE INDEX IF NOT EXISTS fin_patient_financing_loan_day_key
  ON public.fin_patient_financing (clinic_id, loan_key, txn_date);
CREATE INDEX IF NOT EXISTS idx_fin_patient_financing_open
  ON public.fin_patient_financing (clinic_id, expected_release)
  WHERE blocked AND released_on IS NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_patient_financing_patient
  ON public.fin_patient_financing (patient_id) WHERE patient_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.9 Indexes on 0020 tables.
-- ---------------------------------------------------------------------------
-- possible_duplicate (legacy IP:25): same date and amount, any key, any account.
CREATE INDEX IF NOT EXISTS idx_fin_payments_day_amount_live
  ON public.fin_payments (clinic_id, paid_on, amount_cents) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_entries_reconciled
  ON public.fin_entries (clinic_id, reconciled_month) WHERE reconciled_month IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.10.3 Live receipt reconciliation internals (legacy receiptReconciliation FM:48-66, ported exactly).
--   imported(M): patient_receipts entries keyed 'clinic:YYYY-MM-%:receipts' with a live payment in M.
--   manual(M):   patient_receipts entries without a source key, not excluded by the owner, with a live payment
--                in M. For each distinct payment day 'end' of manual(M), newest first, the closed prefixes old /
--                daily (every live payment in M and <= end) are compared; the first match within 1 TL wins.
--   Payment dates are never later than clinic_today() (0020 payment guard), so legacy's <= today filter is moot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__receipt_reconciliation(p_clinic uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_m0 date := public.fin__month_start(p_month);
  v_m1 date := (public.fin__month_start(p_month) + interval '1 month')::date;
  v_like text := 'clinic:' || to_char(public.fin__month_start(p_month), 'YYYY-MM') || '-%:receipts';
  v_manual uuid[];
  v_imported uuid[];
  v_end date;
  v_old uuid[];
  v_daily uuid[];
  v_latest date;
  v_old_ok boolean;
  v_old_sum bigint;
  v_daily_sum bigint;
BEGIN
  SELECT coalesce(array_agg(e.id ORDER BY e.id), ARRAY[]::uuid[])
    INTO v_manual
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  WHERE e.clinic_id = p_clinic
    AND c.report_bucket = 'patient_receipts'
    AND e.source_key IS NULL
    AND e.exclusion_source IS DISTINCT FROM 'manual'
    AND EXISTS (SELECT 1 FROM public.fin_payments p
                WHERE p.entry_id = e.id AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1);

  SELECT coalesce(array_agg(e.id ORDER BY e.id), ARRAY[]::uuid[])
    INTO v_imported
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  WHERE e.clinic_id = p_clinic
    AND c.report_bucket = 'patient_receipts'
    AND e.source_key LIKE v_like
    AND EXISTS (SELECT 1 FROM public.fin_payments p
                WHERE p.entry_id = e.id AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1);

  FOR v_end IN
    SELECT DISTINCT p.paid_on
    FROM public.fin_payments p
    WHERE p.entry_id = ANY (v_manual) AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1
    ORDER BY p.paid_on DESC
  LOOP
    SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_old
    FROM unnest(v_manual) AS x(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.fin_payments p
                      WHERE p.entry_id = x.id AND p.voided_at IS NULL AND (p.paid_on < v_m0 OR p.paid_on > v_end));

    SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_daily
    FROM unnest(v_imported) AS x(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.fin_payments p
                      WHERE p.entry_id = x.id AND p.voided_at IS NULL AND (p.paid_on < v_m0 OR p.paid_on > v_end));

    IF cardinality(v_daily) < 2 OR cardinality(v_old) = 0 THEN
      CONTINUE;
    END IF;

    SELECT max(p.paid_on) INTO v_latest
    FROM public.fin_payments p
    WHERE p.entry_id = ANY (v_daily) AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1;
    IF v_latest IS DISTINCT FROM v_end THEN
      CONTINUE;
    END IF;

    SELECT bool_and(e.cancelled_at IS NULL AND public.fin__paid(e.id) = e.amount_cents) INTO v_old_ok
    FROM public.fin_entries e
    WHERE e.id = ANY (v_old);
    IF NOT coalesce(v_old_ok, false) THEN
      CONTINUE;
    END IF;

    SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_old_sum
    FROM public.fin_payments p
    WHERE p.entry_id = ANY (v_old) AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1;
    SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_daily_sum
    FROM public.fin_payments p
    WHERE p.entry_id = ANY (v_daily) AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1;

    IF abs(v_daily_sum - v_old_sum) <= 100 THEN
      RETURN jsonb_build_object(
        'month', to_char(v_m0, 'YYYY-MM'),
        'equivalent', true,
        'through', v_end,
        'excluded_ids', to_jsonb(v_old),
        'manual_total_cents', v_old_sum,
        'imported_total_cents', v_daily_sum,
        'overlap', true);
    END IF;
  END LOOP;

  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_old_sum
  FROM public.fin_payments p
  WHERE p.entry_id = ANY (v_manual) AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1;
  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_daily_sum
  FROM public.fin_payments p
  WHERE p.entry_id = ANY (v_imported) AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1;

  RETURN jsonb_build_object(
    'month', to_char(v_m0, 'YYYY-MM'),
    'equivalent', false,
    'through', NULL::date,
    'excluded_ids', '[]'::jsonb,
    'manual_total_cents', v_old_sum,
    'imported_total_cents', v_daily_sum,
    'overlap', cardinality(v_manual) > 0 AND cardinality(v_imported) > 0);
END;
$$;

-- Applies the reconciliation of one month as audited exclusions (§2.10.3) and returns what it computed. Serialised
-- per clinic; after the lock every statement sees the latest committed data (READ COMMITTED).
CREATE OR REPLACE FUNCTION public.fin__reconcile_receipts_month(p_clinic uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_m0 date := public.fin__month_start(p_month);
  v_prev text;
  v_r jsonb;
  v_ids uuid[];
  v_reason text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_receipts:' || p_clinic::text, 0));
  v_prev := public.fin__set_ctx('reconcile');

  v_r := public.fin__receipt_reconciliation(p_clinic, v_m0);
  SELECT coalesce(array_agg(x.v::uuid), ARRAY[]::uuid[]) INTO v_ids
  FROM jsonb_array_elements_text(v_r -> 'excluded_ids') AS x(v);
  v_reason := 'Klinik Excel günlük toplamlarıyla eşleşti (' || to_char(v_m0, 'YYYY-MM') || ', '
              || coalesce(v_r ->> 'through', '') || ' tarihine kadar).';

  UPDATE public.fin_entries e
  SET excluded_from_totals = true,
      exclusion_source = 'receipt_reconciliation',
      reconciled_month = v_m0,
      exclusion_reason = v_reason,
      excluded_at = now(),
      excluded_by = public.current_app_user_id()
  WHERE e.clinic_id = p_clinic
    AND e.id = ANY (v_ids)
    AND (NOT e.excluded_from_totals
         OR (e.exclusion_source = 'receipt_reconciliation'
             AND (e.reconciled_month IS DISTINCT FROM v_m0 OR e.exclusion_reason IS DISTINCT FROM v_reason)));

  UPDATE public.fin_entries e
  SET excluded_from_totals = false,
      exclusion_source = NULL,
      reconciled_month = NULL,
      exclusion_reason = NULL,
      excluded_at = NULL,
      excluded_by = NULL
  WHERE e.clinic_id = p_clinic
    AND e.reconciled_month = v_m0
    AND NOT (e.id = ANY (v_ids));

  PERFORM public.fin__set_ctx(v_prev);
  RETURN v_r;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.10 Guard and maintenance triggers (SECURITY DEFINER, never granted, as 0020 §2.3). RPCs check their own rules
--      first; the triggers are the backstop for the generic 0020 RPCs, the SQL editor and RPC bugs.
-- ---------------------------------------------------------------------------

-- 2.10.1 Financing fee entries and their payment change only through the fin_financing_* RPCs (C7, RT:125). This
-- makes edit, record / correct / void payment, cancel and exclusion of 0020 refuse them without changing those RPCs.
CREATE OR REPLACE FUNCTION public.fin__trg_financing_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry uuid;
BEGIN
  -- Separate statements: one expression would resolve NEW.entry_id on fin_entries rows and fail.
  IF TG_TABLE_NAME = 'fin_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;
  IF public.fin__ctx() <> 'financing'
     AND EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = v_entry) THEN
    RAISE EXCEPTION 'Hasta finansmanı kaydı bu alandan değiştirilemez. Düzeltmeyi Hasta finansmanı bölümünden yapın.';
  END IF;
  RETURN NEW;
END;
$$;

-- Financing rows: identity is immutable, a voided row is frozen (except the informational patient link), money /
-- block / release / void / correction columns change only inside a financing RPC. patient_id -> NULL alone is
-- allowed without the context (ON DELETE SET NULL of patients). version / updated_* are set by fin_touch.
CREATE OR REPLACE FUNCTION public.fin__trg_financing_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.id, NEW.clinic_id, NEW.provider, NEW.reference, NEW.txn_date, NEW.entry_id, NEW.source_file,
      NEW.patient_name_raw, NEW.currency, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.clinic_id, OLD.provider, OLD.reference, OLD.txn_date, OLD.entry_id, OLD.source_file,
      OLD.patient_name_raw, OLD.currency, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;

  IF (NEW.gross_cents, NEW.commission_cents, NEW.kkdf_cents, NEW.bsmv_cents, NEW.blocked, NEW.expected_release,
      NEW.released_on, NEW.released_at, NEW.released_by, NEW.voided_at, NEW.voided_by, NEW.void_reason,
      NEW.corrected_at, NEW.corrected_by, NEW.correction_reason)
     IS DISTINCT FROM
     (OLD.gross_cents, OLD.commission_cents, OLD.kkdf_cents, OLD.bsmv_cents, OLD.blocked, OLD.expected_release,
      OLD.released_on, OLD.released_at, OLD.released_by, OLD.voided_at, OLD.voided_by, OLD.void_reason,
      OLD.corrected_at, OLD.corrected_by, OLD.correction_reason) THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş finansman değiştirilemez.';
    END IF;
    IF public.fin__ctx() <> 'financing' THEN
      RAISE EXCEPTION 'Bu alan değiştirilemez.';
    END IF;
  END IF;

  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id AND NEW.patient_id IS NOT NULL
     AND public.fin__ctx() <> 'financing' THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- A linked patient must belong to the row's clinic (patients is owned by another workstream; read only here).
CREATE OR REPLACE FUNCTION public.fin__trg_financing_patient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patients pt WHERE pt.id = NEW.patient_id AND pt.clinic_id = NEW.clinic_id
  ) THEN
    RAISE EXCEPTION 'Hasta bulunamadı.';
  END IF;
  RETURN NEW;
END;
$$;

-- 2.10.2 Import sources are history: only a payment_match row whose payment was voided may be re-bound, inside an
-- import RPC, with the rebind stamp. Entry links are permanent.
CREATE OR REPLACE FUNCTION public.fin__trg_import_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.clinic_id, NEW.source_key, NEW.source_kind, NEW.origin, NEW.imported_by, NEW.imported_at)
     IS DISTINCT FROM
     (OLD.id, OLD.clinic_id, OLD.source_key, OLD.source_kind, OLD.origin, OLD.imported_by, OLD.imported_at) THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  IF OLD.link_kind <> 'payment_match'
     OR public.fin__ctx() <> 'import'
     OR NOT EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.id = OLD.payment_id AND p.voided_at IS NOT NULL)
     OR NEW.rebind_count IS DISTINCT FROM OLD.rebind_count + 1
     OR NEW.rebound_at IS DISTINCT FROM now()
     OR NEW.rebound_by IS DISTINCT FROM public.current_app_user_id() THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred: an entry link equals its entry's source_key (and its payment belongs to the entry); a payment_match
-- link equals its payment's bank_source_key and entry. Re-reads the row, so later updates in the same transaction
-- are judged on the final state.
CREATE OR REPLACE FUNCTION public.fin__trg_import_source_consistent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s public.fin_import_sources%ROWTYPE;
  v_entry_key text;
  v_pay_entry uuid;
  v_pay_key text;
BEGIN
  SELECT * INTO v_s FROM public.fin_import_sources s WHERE s.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_s.link_kind = 'entry' THEN
    SELECT e.source_key INTO v_entry_key
    FROM public.fin_entries e
    WHERE e.clinic_id = v_s.clinic_id AND e.id = v_s.entry_id;
    IF v_entry_key IS DISTINCT FROM v_s.source_key THEN
      RAISE EXCEPTION 'Aktarım kaynağı kayıtla uyuşmuyor.';
    END IF;
    IF v_s.payment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.fin_payments p
      WHERE p.clinic_id = v_s.clinic_id AND p.id = v_s.payment_id AND p.entry_id = v_s.entry_id
    ) THEN
      RAISE EXCEPTION 'Aktarım kaynağı kayıtla uyuşmuyor.';
    END IF;
  ELSE
    SELECT p.entry_id, p.bank_source_key INTO v_pay_entry, v_pay_key
    FROM public.fin_payments p
    WHERE p.clinic_id = v_s.clinic_id AND p.id = v_s.payment_id;
    IF v_pay_key IS DISTINCT FROM v_s.source_key OR v_pay_entry IS DISTINCT FROM v_s.entry_id THEN
      RAISE EXCEPTION 'Aktarım kaynağı kayıtla uyuşmuyor.';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Batches are insert-only; file names 1..200 characters.
CREATE OR REPLACE FUNCTION public.fin__trg_batch_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.file_names) AS f(name)
    WHERE f.name IS NULL OR char_length(f.name) NOT BETWEEN 1 AND 200
  ) OR array_position(NEW.layout_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  RETURN NEW;
END;
$$;

-- The bank + account label is part of every 'bank-table:' key (BT:48, BM:13); kind and label never change.
CREATE OR REPLACE FUNCTION public.fin__trg_layout_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.key_label IS DISTINCT FROM OLD.key_label THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- Rule subcategory / entitlement flag by the category's bucket (0020 entry rules; NULL subcategory = decided per
-- row by the browser, as legacy IP:54 did for physician rows).
CREATE OR REPLACE FUNCTION public.fin__trg_rule_guard()
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
  IF NEW.subcategory IS NOT NULL THEN
    IF (v_bucket = 'doctor' AND NEW.subcategory NOT IN ('current_physician', 'past_physician_debt'))
       OR (v_bucket = 'other_expense' AND NEW.subcategory <> 'official_fee')
       OR v_bucket NOT IN ('doctor', 'other_expense') THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  END IF;
  IF NEW.requires_entitlement_month AND v_bucket <> 'doctor' THEN
    RAISE EXCEPTION 'Hakediş ayı yalnızca hekim hakedişi kayıtlarında kullanılabilir.';
  END IF;
  -- A configured counterparty is the fingerprint counterparty of entitlement rows only (legacy IP:54); every other
  -- imported row keeps its narration as counterparty_text (critique 16).
  IF NEW.counterparty_id IS NOT NULL AND NOT NEW.requires_entitlement_month THEN
    RAISE EXCEPTION 'Kişi / kurum yalnızca hakediş ayı gerekli hekim kurallarında seçilebilir.';
  END IF;
  IF NEW.match_kind = 'regex' AND public.fin__regex_unsafe(NEW.pattern) THEN
    RAISE EXCEPTION 'Desen tarayıcıyı kilitleyebilecek bir yapı içeriyor (iç içe tekrar, geri başvuru veya geriye bakış).';
  END IF;
  RETURN NEW;
END;
$$;

-- 2.10.4 Exclusion source: 0020's fin_set_exclusion keeps working (it gets 'manual'); reconciliation exclusions
-- are written and cleared only by fin__reconcile_receipts_month (E_RECONCILED).
CREATE OR REPLACE FUNCTION public.fin__trg_exclusion_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.exclusion_source = 'receipt_reconciliation'
       AND public.fin__ctx() <> 'reconcile'
       AND (NEW.excluded_from_totals, NEW.exclusion_source, NEW.reconciled_month)
           IS DISTINCT FROM (OLD.excluded_from_totals, OLD.exclusion_source, OLD.reconciled_month) THEN
      RAISE EXCEPTION 'Bu kayıt klinik Excel tahsilat mutabakatıyla toplam dışında. Klinik Excel aktarımını kontrol edin.';
    END IF;
  END IF;

  IF NOT NEW.excluded_from_totals THEN
    NEW.exclusion_source := NULL;
    NEW.reconciled_month := NULL;
  ELSIF NEW.exclusion_source IS NULL THEN
    NEW.exclusion_source := 'manual';
  END IF;

  IF NEW.exclusion_source = 'receipt_reconciliation' AND public.fin__ctx() <> 'reconcile' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Bu kayıt klinik Excel tahsilat mutabakatıyla toplam dışında. Klinik Excel aktarımını kontrol edin.';
    ELSIF OLD.exclusion_source IS DISTINCT FROM 'receipt_reconciliation' THEN
      RAISE EXCEPTION 'Bu kayıt klinik Excel tahsilat mutabakatıyla toplam dışında. Klinik Excel aktarımını kontrol edin.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred recompute of the receipt reconciliation (C12) after any change that can alter it: a payment of a
-- patient receipt (insert, date / amount change, void), or an entry's cancel / amount / category / owner exclusion.
-- fin_import_rows recomputes its own month and leaves fin.ctx = 'import', so these skip at its commit.
CREATE OR REPLACE FUNCTION public.fin__trg_receipts_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months date[] := ARRAY[]::date[];
  v_m date;
  v_old_bucket text;
  v_new_bucket text;
BEGIN
  IF public.fin__ctx() = 'import' THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'fin_payments' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (OLD.paid_on, OLD.amount_cents, OLD.voided_at IS NULL)
         IS NOT DISTINCT FROM (NEW.paid_on, NEW.amount_cents, NEW.voided_at IS NULL) THEN
        RETURN NULL;
      END IF;
      v_months := ARRAY[public.fin__month_start(OLD.paid_on)];
    END IF;
    SELECT c.report_bucket INTO v_new_bucket
    FROM public.fin_entries e
    JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
    WHERE e.id = NEW.entry_id;
    IF v_new_bucket IS DISTINCT FROM 'patient_receipts' THEN
      RETURN NULL;
    END IF;
    v_months := v_months || public.fin__month_start(NEW.paid_on);
  ELSE
    IF (OLD.cancelled_at IS NULL, OLD.amount_cents, OLD.category_id, coalesce(OLD.exclusion_source = 'manual', false))
       IS NOT DISTINCT FROM
       (NEW.cancelled_at IS NULL, NEW.amount_cents, NEW.category_id, coalesce(NEW.exclusion_source = 'manual', false)) THEN
      RETURN NULL;
    END IF;
    SELECT c.report_bucket INTO v_old_bucket
    FROM public.fin_categories c WHERE c.clinic_id = OLD.clinic_id AND c.id = OLD.category_id;
    SELECT c.report_bucket INTO v_new_bucket
    FROM public.fin_categories c WHERE c.clinic_id = NEW.clinic_id AND c.id = NEW.category_id;
    IF v_old_bucket IS DISTINCT FROM 'patient_receipts' AND v_new_bucket IS DISTINCT FROM 'patient_receipts' THEN
      RETURN NULL;
    END IF;
    SELECT coalesce(array_agg(DISTINCT public.fin__month_start(p.paid_on)), ARRAY[]::date[]) INTO v_months
    FROM public.fin_payments p
    WHERE p.entry_id = NEW.id;
  END IF;

  FOR v_m IN SELECT DISTINCT u.m FROM unnest(v_months) AS u(m) ORDER BY u.m
  LOOP
    PERFORM public.fin__reconcile_receipts_month(NEW.clinic_id, v_m);
  END LOOP;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.10.5 Trigger wiring.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS fin_financing_lock ON public.fin_entries;
CREATE TRIGGER fin_financing_lock
  BEFORE UPDATE ON public.fin_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_financing_lock();

DROP TRIGGER IF EXISTS fin_financing_lock ON public.fin_payments;
CREATE TRIGGER fin_financing_lock
  BEFORE INSERT OR UPDATE ON public.fin_payments
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_financing_lock();

DROP TRIGGER IF EXISTS fin_financing_guard ON public.fin_patient_financing;
CREATE TRIGGER fin_financing_guard
  BEFORE UPDATE ON public.fin_patient_financing
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_financing_guard();

DROP TRIGGER IF EXISTS fin_financing_patient ON public.fin_patient_financing;
CREATE TRIGGER fin_financing_patient
  BEFORE INSERT OR UPDATE OF patient_id ON public.fin_patient_financing
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_financing_patient();

DROP TRIGGER IF EXISTS fin_import_source_guard ON public.fin_import_sources;
CREATE TRIGGER fin_import_source_guard
  BEFORE UPDATE ON public.fin_import_sources
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_import_source_guard();

DROP TRIGGER IF EXISTS fin_import_source_consistent ON public.fin_import_sources;
CREATE CONSTRAINT TRIGGER fin_import_source_consistent
  AFTER INSERT OR UPDATE ON public.fin_import_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_import_source_consistent();

DROP TRIGGER IF EXISTS fin_batch_guard ON public.fin_import_batches;
CREATE TRIGGER fin_batch_guard
  BEFORE INSERT OR UPDATE ON public.fin_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_batch_guard();

DROP TRIGGER IF EXISTS fin_layout_guard ON public.fin_import_layouts;
CREATE TRIGGER fin_layout_guard
  BEFORE UPDATE ON public.fin_import_layouts
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_layout_guard();

DROP TRIGGER IF EXISTS fin_rule_guard ON public.fin_classification_rules;
CREATE TRIGGER fin_rule_guard
  BEFORE INSERT OR UPDATE ON public.fin_classification_rules
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_rule_guard();

DROP TRIGGER IF EXISTS fin_exclusion_source ON public.fin_entries;
CREATE TRIGGER fin_exclusion_source
  BEFORE INSERT OR UPDATE OF excluded_from_totals, exclusion_source, reconciled_month ON public.fin_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_exclusion_source();

DROP TRIGGER IF EXISTS fin_receipts_payments ON public.fin_payments;
CREATE CONSTRAINT TRIGGER fin_receipts_payments
  AFTER INSERT OR UPDATE ON public.fin_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_receipts_recompute();

DROP TRIGGER IF EXISTS fin_receipts_entries ON public.fin_entries;
CREATE CONSTRAINT TRIGGER fin_receipts_entries
  AFTER UPDATE OF cancelled_at, amount_cents, category_id, excluded_from_totals, exclusion_source ON public.fin_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_receipts_recompute();

-- fin_touch on the three versioned tables; nothing is ever deleted or truncated (0020 owner decision 2).
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_classification_rules', 'fin_import_layouts', 'fin_patient_financing']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_touch ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_touch()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['fin_import_batches', 'fin_import_sources', 'fin_classification_rules',
                             'fin_import_layouts', 'fin_patient_financing']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_delete ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_no_delete BEFORE DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2.11 RLS (SELECT only, for finance / finance_readonly holders of the caller's clinic), no write privileges, and
--      audit_row_change() on the five new tables. The 0020 audit_logs policies already restrict every fin_% entity
--      to finance holders, so patient names in fin_patient_financing are visible only to them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_import_batches', 'fin_import_sources', 'fin_classification_rules',
                             'fin_import_layouts', 'fin_patient_financing']
  LOOP
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
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2.12 0020 functions replaced with the same signature (CREATE OR REPLACE keeps the ACL; no overload).
-- ---------------------------------------------------------------------------

-- fin_touch (0020): the live receipt reconciliation (fin__reconcile_receipts_month, fin.ctx = 'reconcile') changes
-- only the exclusion columns of manual receipt entries. It runs in deferred triggers at COMMIT, after an unchanged 0020
-- RPC has already returned that entry's version, so bumping the version there would make the user's next action on
-- the entry fail with PT409. Those updates keep version / updated_*; every other update is stamped as before.
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
  IF TG_TABLE_NAME = 'fin_entries' AND public.fin__ctx() = 'reconcile'
     AND (to_jsonb(NEW) - ARRAY['excluded_from_totals', 'exclusion_source', 'reconciled_month', 'exclusion_reason',
                                'excluded_at', 'excluded_by', 'version', 'updated_at', 'updated_by'])
         = (to_jsonb(OLD) - ARRAY['excluded_from_totals', 'exclusion_source', 'reconciled_month', 'exclusion_reason',
                                  'excluded_at', 'excluded_by', 'version', 'updated_at', 'updated_by']) THEN
    NEW.version := OLD.version;
    NEW.updated_at := OLD.updated_at;
    NEW.updated_by := OLD.updated_by;
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := coalesce(public.current_app_user_id(), NEW.updated_by);
  RETURN NEW;
END;
$$;

-- SettingsJson + the four financing / import settings.
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
           'entitlement_account_id', s.entitlement_account_id,
           'financing_receipts_source', s.financing_receipts_source,
           'default_block_days', s.default_block_days,
           'financing_counterparty_id', s.financing_counterparty_id,
           'financing_account_id', s.financing_account_id)
  FROM public.fin_settings s
  WHERE s.clinic_id = p_clinic
$$;

-- EntryJson (0020) + exclusion_source, reconciled_month, is_locked, financing, import.
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
           'updated_by_name', public.fin__user_name(e.updated_by))
         || jsonb_build_object(
           'exclusion_source', e.exclusion_source,
           'reconciled_month', to_char(e.reconciled_month, 'YYYY-MM'),
           'is_locked', EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = e.id),
           'financing', (
             SELECT jsonb_build_object(
                      'id', f.id,
                      'version', f.version,
                      'provider', f.provider,
                      'reference', f.reference,
                      'blocked', f.blocked,
                      'expected_release', f.expected_release,
                      'released_on', f.released_on,
                      'is_voided', f.voided_at IS NOT NULL)
             FROM public.fin_patient_financing f
             WHERE f.clinic_id = e.clinic_id AND f.entry_id = e.id),
           'import', (
             SELECT jsonb_build_object(
                      'source_kind', src.source_kind,
                      'batch_id', src.batch_id,
                      'file_name', src.file_name,
                      'origin', src.origin)
             FROM public.fin_import_sources src
             WHERE src.clinic_id = e.clinic_id AND src.entry_id = e.id AND src.link_kind = 'entry'
             ORDER BY src.imported_at, src.id
             LIMIT 1))
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

-- 'Finans geçmişi' (0020 §3.6): the entity whitelist adds the five tables of this part.
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
       'fin_patient_financing') THEN
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

-- Owner JSON export manifest (0020 §3.8) + the five tables of this part.
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
      jsonb_build_object('name', 'audit_logs', 'filter', 'entity_type LIKE ''fin\_%''', 'row_count',
        (SELECT count(*) FROM public.audit_logs t WHERE t.clinic_id = v_clinic AND left(t.entity_type, 4) = 'fin_'))));
END;
$$;

-- Privileges + self-checks (0020 §2.6). The table check now covers every public table named fin_* (and requires
-- RLS on each), so later phases need no edit here.
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

  -- Internal helpers fail closed: only trigger functions may be SECURITY DEFINER.
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

  -- Every fin_* table: RLS on, SELECT only for authenticated, nothing for anon.
  SELECT string_agg(c.relname, ', ') INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'fin\_%'
    AND (NOT c.relrowsecurity
         OR has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
         OR has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         OR NOT has_table_privilege('authenticated', c.oid, 'SELECT'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'fin_* tablo yetkileri beklenen gibi değil: %', v_bad;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row shapes of this part (internal).
-- ---------------------------------------------------------------------------

-- RuleJson: every column except clinic_id, plus category / counterparty names.
CREATE OR REPLACE FUNCTION public.fin__rule_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', r.id,
           'version', r.version,
           'priority', r.priority,
           'scope', r.scope,
           'match_kind', r.match_kind,
           'pattern', r.pattern,
           'category_id', r.category_id,
           'category_name', c.name,
           'report_bucket', c.report_bucket,
           'direction', c.direction,
           'category_is_active', c.is_active,
           'subcategory', r.subcategory,
           'counterparty_id', r.counterparty_id,
           'counterparty_name', cp.name,
           'requires_entitlement_month', r.requires_entitlement_month,
           'auto_select', r.auto_select,
           'warning', r.warning,
           'is_active', r.is_active,
           'is_seed', r.is_seed,
           'created_by', r.created_by,
           'created_by_name', public.fin__user_name(r.created_by),
           'created_at', r.created_at,
           'updated_by', r.updated_by,
           'updated_by_name', public.fin__user_name(r.updated_by),
           'updated_at', r.updated_at)
  FROM public.fin_classification_rules r
  JOIN public.fin_categories c ON c.clinic_id = r.clinic_id AND c.id = r.category_id
  LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = r.clinic_id AND cp.id = r.counterparty_id
  WHERE r.clinic_id = p_clinic AND r.id = p_id
$$;

-- LayoutJson: every column except clinic_id, plus account names and the last batch that used it.
CREATE OR REPLACE FUNCTION public.fin__layout_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', l.id,
           'version', l.version,
           'kind', l.kind,
           'name', l.name,
           'config', l.config,
           'key_label', l.key_label,
           'account_id', l.account_id,
           'account_name', a.name,
           'receipts_account_id', l.receipts_account_id,
           'receipts_account_name', ar.name,
           'bank_paid_account_id', l.bank_paid_account_id,
           'bank_paid_account_name', ab.name,
           'cash_paid_account_id', l.cash_paid_account_id,
           'cash_paid_account_name', ac.name,
           'is_default', l.is_default,
           'is_active', l.is_active,
           'sort_order', l.sort_order,
           'last_used_at', (SELECT max(b.created_at) FROM public.fin_import_batches b
                            WHERE b.clinic_id = l.clinic_id AND l.id = ANY (b.layout_ids)),
           'created_by', l.created_by,
           'created_by_name', public.fin__user_name(l.created_by),
           'created_at', l.created_at,
           'updated_by', l.updated_by,
           'updated_by_name', public.fin__user_name(l.updated_by),
           'updated_at', l.updated_at)
  FROM public.fin_import_layouts l
  LEFT JOIN public.fin_accounts a ON a.clinic_id = l.clinic_id AND a.id = l.account_id
  LEFT JOIN public.fin_accounts ar ON ar.clinic_id = l.clinic_id AND ar.id = l.receipts_account_id
  LEFT JOIN public.fin_accounts ab ON ab.clinic_id = l.clinic_id AND ab.id = l.bank_paid_account_id
  LEFT JOIN public.fin_accounts ac ON ac.clinic_id = l.clinic_id AND ac.id = l.cash_paid_account_id
  WHERE l.clinic_id = p_clinic AND l.id = p_id
$$;

-- BatchJson.
CREATE OR REPLACE FUNCTION public.fin__batch_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', b.id,
           'kind', b.kind,
           'month', to_char(b.month, 'YYYY-MM'),
           'file_names', to_jsonb(b.file_names),
           'layout_ids', to_jsonb(b.layout_ids),
           'rows_sent', b.rows_sent,
           'inserted', b.inserted,
           'matched', b.matched,
           'skipped', b.skipped,
           'acknowledged', b.acknowledged,
           'created_at', b.created_at,
           'created_by_name', public.fin__user_name(b.created_by))
  FROM public.fin_import_batches b
  WHERE b.clinic_id = p_clinic AND b.id = p_id
$$;

-- FinancingJson (§4.10).
CREATE OR REPLACE FUNCTION public.fin__financing_json(p_clinic uuid, p_id uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', f.id,
           'version', f.version,
           'provider', f.provider,
           'reference', f.reference,
           'loan_key', f.loan_key,
           'patient_name_raw', f.patient_name_raw,
           'patient_id', f.patient_id,
           'patient_name', pt.full_name,
           'txn_date', f.txn_date,
           'gross_cents', f.gross_cents,
           'commission_cents', f.commission_cents,
           'kkdf_cents', f.kkdf_cents,
           'bsmv_cents', f.bsmv_cents,
           'fee_cents', f.fee_cents,
           'net_cents', f.net_cents,
           'blocked', f.blocked,
           'expected_release', f.expected_release,
           'released_on', f.released_on,
           'released_by_name', public.fin__user_name(f.released_by),
           'status', CASE WHEN f.voided_at IS NOT NULL THEN 'voided'
                          WHEN f.released_on IS NOT NULL THEN 'released'
                          WHEN f.blocked THEN 'blocked'
                          ELSE 'unblocked' END,
           'needs_check', (f.blocked AND f.released_on IS NULL AND f.voided_at IS NULL
                           AND f.expected_release <= p_today),
           'entry_id', f.entry_id,
           'source_key', f.source_key,
           'source_file', f.source_file,
           'voided_at', f.voided_at,
           'void_reason', f.void_reason,
           'corrected_at', f.corrected_at,
           'correction_reason', f.correction_reason,
           'created_at', f.created_at,
           'created_by_name', public.fin__user_name(f.created_by),
           'updated_at', f.updated_at,
           'updated_by_name', public.fin__user_name(f.updated_by))
  FROM public.fin_patient_financing f
  LEFT JOIN public.patients pt ON pt.id = f.patient_id AND pt.clinic_id = f.clinic_id
  WHERE f.clinic_id = p_clinic AND f.id = p_id
$$;

-- Write envelope of the financing RPCs: { already_saved, record: FinancingJson, entry: EntryJson }.
CREATE OR REPLACE FUNCTION public.fin__financing_envelope(p_clinic uuid, p_id uuid, p_already boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'already_saved', p_already,
           'record', public.fin__financing_json(p_clinic, f.id, public.clinic_today()),
           'entry', public.fin__entry_json(p_clinic, f.entry_id, public.clinic_today()))
  FROM public.fin_patient_financing f
  WHERE f.clinic_id = p_clinic AND f.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Layout config validation (§2.7). Raises E_LAYOUT_CONFIG naming the first bad path, e.g. 'expense.bank_cols[2]'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__cfg_fail(p_path text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Sütun eşleştirmesi geçersiz: %.', coalesce(nullif(p_path, ''), 'config');
END;
$$;

CREATE OR REPLACE FUNCTION public.fin__cfg_obj(p_v jsonb, p_path text, p_required text[], p_optional text[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bad text;
  v_prefix text := CASE WHEN coalesce(p_path, '') = '' THEN '' ELSE p_path || '.' END;
BEGIN
  IF p_v IS NULL OR jsonb_typeof(p_v) <> 'object' THEN
    PERFORM public.fin__cfg_fail(p_path);
  END IF;
  SELECT k.name INTO v_bad
  FROM jsonb_object_keys(p_v) AS k(name)
  WHERE NOT (k.name = ANY (p_required || p_optional))
  ORDER BY k.name
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    PERFORM public.fin__cfg_fail(v_prefix || v_bad);
  END IF;
  SELECT r.name INTO v_bad
  FROM unnest(p_required) AS r(name)
  WHERE NOT (p_v ? r.name)
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    PERFORM public.fin__cfg_fail(v_prefix || v_bad);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin__cfg_int(p_v jsonb, p_path text, p_min integer, p_max integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.fin__json_int(p_v, p_min, p_max) IS NULL THEN
    PERFORM public.fin__cfg_fail(p_path);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin__cfg_str(p_v jsonb, p_path text, p_min integer, p_max integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.fin__json_text(p_v) IS NULL OR char_length(p_v #>> '{}') NOT BETWEEN p_min AND p_max THEN
    PERFORM public.fin__cfg_fail(p_path);
  END IF;
END;
$$;

-- Array of at most p_len items, each an integer in [p_min, p_max] (p_text false) or a string of p_min..p_max
-- characters (p_text true).
CREATE OR REPLACE FUNCTION public.fin__cfg_array(p_v jsonb, p_path text, p_len integer, p_text boolean,
                                                 p_min integer, p_max integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_i integer := 0;
BEGIN
  IF p_v IS NULL OR jsonb_typeof(p_v) <> 'array' OR jsonb_array_length(p_v) > p_len THEN
    PERFORM public.fin__cfg_fail(p_path);
  END IF;
  FOR v_item IN SELECT x.value FROM jsonb_array_elements(p_v) AS x(value)
  LOOP
    IF p_text THEN
      PERFORM public.fin__cfg_str(v_item, p_path || '[' || v_i || ']', p_min, p_max);
    ELSE
      PERFORM public.fin__cfg_int(v_item, p_path || '[' || v_i || ']', p_min, p_max);
    END IF;
    v_i := v_i + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin__layout_config(p_kind text, p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_c jsonb := p_config;
  v_k text;
  v_mode text;
  v_format text;
BEGIN
  IF p_kind = 'clinic_workbook' THEN
    PERFORM public.fin__cfg_obj(v_c, '',
      ARRAY['version', 'required_sheets', 'day_sheet_pattern', 'fx_sheet', 'fx_code_col', 'fx_rate_col',
            'first_row', 'receipt', 'expense', 'cash', 'receipt_text'], ARRAY[]::text[]);
    PERFORM public.fin__cfg_int(v_c -> 'version', 'version', 1, 1);
    PERFORM public.fin__cfg_array(v_c -> 'required_sheets', 'required_sheets', 10, true, 1, 100);
    PERFORM public.fin__cfg_str(v_c -> 'day_sheet_pattern', 'day_sheet_pattern', 1, 200);
    IF public.fin__regex_unsafe(v_c ->> 'day_sheet_pattern') THEN
      PERFORM public.fin__cfg_fail('day_sheet_pattern');
    END IF;
    PERFORM public.fin__cfg_str(v_c -> 'fx_sheet', 'fx_sheet', 1, 100);
    PERFORM public.fin__cfg_int(v_c -> 'fx_code_col', 'fx_code_col', 0, 255);
    PERFORM public.fin__cfg_int(v_c -> 'fx_rate_col', 'fx_rate_col', 0, 255);
    PERFORM public.fin__cfg_int(v_c -> 'first_row', 'first_row', 0, 10000);

    PERFORM public.fin__cfg_obj(v_c -> 'receipt', 'receipt',
      ARRAY['row_no_col', 'name_col', 'skip_name_pattern', 'try_cols', 'eur_cols', 'usd_cols', 'gbp_cols'],
      ARRAY[]::text[]);
    PERFORM public.fin__cfg_int(v_c #> '{receipt,row_no_col}', 'receipt.row_no_col', 0, 255);
    PERFORM public.fin__cfg_int(v_c #> '{receipt,name_col}', 'receipt.name_col', 0, 255);
    PERFORM public.fin__cfg_str(v_c #> '{receipt,skip_name_pattern}', 'receipt.skip_name_pattern', 0, 200);
    IF public.fin__regex_unsafe(v_c #>> '{receipt,skip_name_pattern}') THEN
      PERFORM public.fin__cfg_fail('receipt.skip_name_pattern');
    END IF;
    FOREACH v_k IN ARRAY ARRAY['try_cols', 'eur_cols', 'usd_cols', 'gbp_cols']
    LOOP
      PERFORM public.fin__cfg_array(v_c -> 'receipt' -> v_k, 'receipt.' || v_k, 10, false, 0, 255);
    END LOOP;

    PERFORM public.fin__cfg_obj(v_c -> 'expense', 'expense',
      ARRAY['desc_col', 'total_col', 'skip_desc_pattern', 'try_cols', 'eur_cols', 'usd_cols', 'gbp_cols',
            'bank_cols'], ARRAY[]::text[]);
    PERFORM public.fin__cfg_int(v_c #> '{expense,desc_col}', 'expense.desc_col', 0, 255);
    PERFORM public.fin__cfg_int(v_c #> '{expense,total_col}', 'expense.total_col', 0, 255);
    PERFORM public.fin__cfg_str(v_c #> '{expense,skip_desc_pattern}', 'expense.skip_desc_pattern', 0, 200);
    IF public.fin__regex_unsafe(v_c #>> '{expense,skip_desc_pattern}') THEN
      PERFORM public.fin__cfg_fail('expense.skip_desc_pattern');
    END IF;
    FOREACH v_k IN ARRAY ARRAY['try_cols', 'eur_cols', 'usd_cols', 'gbp_cols', 'bank_cols']
    LOOP
      PERFORM public.fin__cfg_array(v_c -> 'expense' -> v_k, 'expense.' || v_k, 10, false, 0, 255);
    END LOOP;

    PERFORM public.fin__cfg_obj(v_c -> 'cash', 'cash', ARRAY[]::text[], ARRAY['TRY', 'EUR', 'USD', 'GBP']);
    IF NOT (v_c -> 'cash' ? 'TRY') THEN
      PERFORM public.fin__cfg_fail('cash.TRY');
    END IF;
    FOR v_k IN SELECT k.name FROM jsonb_object_keys(v_c -> 'cash') AS k(name) ORDER BY k.name
    LOOP
      PERFORM public.fin__cfg_str(v_c -> 'cash' -> v_k, 'cash.' || v_k, 1, 200);
      IF public.fin__regex_unsafe(v_c -> 'cash' ->> v_k) THEN
        PERFORM public.fin__cfg_fail('cash.' || v_k);
      END IF;
    END LOOP;

    PERFORM public.fin__cfg_obj(v_c -> 'receipt_text', 'receipt_text', ARRAY['counterparty', 'description'],
                                ARRAY[]::text[]);
    PERFORM public.fin__cfg_str(v_c #> '{receipt_text,counterparty}', 'receipt_text.counterparty', 1, 200);
    -- 1..900: an empty description would make every workbook receipts row invalid in the review table.
    PERFORM public.fin__cfg_str(v_c #> '{receipt_text,description}', 'receipt_text.description', 1, 900);

  ELSIF p_kind = 'bank_table' THEN
    PERFORM public.fin__cfg_obj(v_c, '', ARRAY['version', 'mapping'], ARRAY['sheet_name', 'header_signature']);
    PERFORM public.fin__cfg_int(v_c -> 'version', 'version', 1, 1);
    IF coalesce(jsonb_typeof(v_c -> 'sheet_name'), 'null') <> 'null' THEN
      PERFORM public.fin__cfg_str(v_c -> 'sheet_name', 'sheet_name', 1, 100);
    END IF;
    IF coalesce(jsonb_typeof(v_c -> 'header_signature'), 'null') <> 'null' THEN
      PERFORM public.fin__cfg_array(v_c -> 'header_signature', 'header_signature', 40, true, 1, 80);
    END IF;

    PERFORM public.fin__cfg_obj(v_c -> 'mapping', 'mapping',
      ARRAY['header', 'date', 'description', 'amount', 'debit', 'credit', 'direction', 'balance', 'reference',
            'currency', 'mode', 'format'], ARRAY[]::text[]);
    PERFORM public.fin__cfg_int(v_c #> '{mapping,header}', 'mapping.header', 0, 10000);
    PERFORM public.fin__cfg_int(v_c #> '{mapping,date}', 'mapping.date', 0, 255);
    FOREACH v_k IN ARRAY ARRAY['description', 'amount', 'debit', 'credit', 'direction', 'balance', 'reference',
                               'currency']
    LOOP
      PERFORM public.fin__cfg_int(v_c -> 'mapping' -> v_k, 'mapping.' || v_k, -1, 255);
    END LOOP;
    v_mode := public.fin__json_text(v_c #> '{mapping,mode}');
    IF v_mode IS NULL OR v_mode NOT IN ('signed', 'split', 'direction', 'debit', 'credit') THEN
      PERFORM public.fin__cfg_fail('mapping.mode');
    END IF;
    v_format := public.fin__json_text(v_c #> '{mapping,format}');
    IF v_format IS NULL OR v_format NOT IN ('tr', 'en') THEN
      PERFORM public.fin__cfg_fail('mapping.format');
    END IF;
  ELSE
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;

  IF pg_column_size(v_c) > 32768 THEN
    PERFORM public.fin__cfg_fail('');
  END IF;
  RETURN v_c;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.1 fin_import_setup (read): everything the import, rules, layouts and financing screens need, no money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_setup()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_s public.fin_settings%ROWTYPE;
  v_ready boolean;
BEGIN
  SELECT * INTO v_s FROM public.fin_settings s WHERE s.clinic_id = v_clinic;

  v_ready := v_s.id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.fin_counterparties cp
                WHERE cp.clinic_id = v_clinic AND cp.id = v_s.financing_counterparty_id AND cp.is_active)
    AND EXISTS (SELECT 1 FROM public.fin_accounts a
                WHERE a.clinic_id = v_clinic AND a.id = v_s.financing_account_id AND a.is_active
                  AND a.kind IN ('bank', 'pos'))
    AND EXISTS (SELECT 1 FROM public.fin_categories c
                WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'fees' AND c.is_active)
    AND v_s.financing_receipts_source = 'clinic_excel';

  RETURN jsonb_build_object(
    'today', v_today,
    'current_month', to_char(v_today, 'YYYY-MM'),
    'can_write', public.has_permission('finance'),
    'settings', public.fin__settings_json(v_clinic),
    'financing_ready', coalesce(v_ready, false),
    'accounts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id,
               'version', a.version,
               'name', a.name,
               'kind', a.kind,
               'bank_name', a.bank_name,
               'import_key', a.import_key,
               'is_active', a.is_active,
               'sort_order', a.sort_order)
             ORDER BY a.sort_order, a.name COLLATE "tr-x-icu", a.id)
      FROM public.fin_accounts a
      WHERE a.clinic_id = v_clinic), '[]'::jsonb),
    'rules', coalesce((
      SELECT jsonb_agg(public.fin__rule_json(v_clinic, r.id) ORDER BY r.priority, r.created_at, r.id)
      FROM public.fin_classification_rules r
      WHERE r.clinic_id = v_clinic), '[]'::jsonb),
    'layouts', coalesce((
      SELECT jsonb_agg(public.fin__layout_json(v_clinic, l.id)
                       ORDER BY l.kind, l.sort_order, l.name COLLATE "tr-x-icu", l.id)
      FROM public.fin_import_layouts l
      WHERE l.clinic_id = v_clinic), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.2 Settings and account import keys (write). Master-data conventions of 0020 §3.1: no-op -> already_saved
--     before the version check, then the version, then the business rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_save_import_settings(
  p_version integer,
  p_financing_receipts_source text,
  p_default_block_days integer,
  p_financing_counterparty_id uuid,
  p_financing_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_settings%ROWTYPE;
  v_source text := coalesce(nullif(btrim(coalesce(p_financing_receipts_source, '')), ''), 'clinic_excel');
  v_cp public.fin_counterparties%ROWTYPE;
  v_acc public.fin_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.fin_settings s WHERE s.clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  IF (v_row.financing_receipts_source, v_row.default_block_days, v_row.financing_counterparty_id,
      v_row.financing_account_id)
     IS NOT DISTINCT FROM
     (v_source, p_default_block_days, p_financing_counterparty_id, p_financing_account_id) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__settings_json(v_clinic));
  END IF;

  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  IF v_source = 'dentos_payments' THEN
    RAISE EXCEPTION 'DentOS tahsilat kaynağı, hasta tahsilatları modülüyle (Faz 5) açılacak.';
  ELSIF v_source <> 'clinic_excel' THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;

  IF p_default_block_days IS NULL OR p_default_block_days NOT BETWEEN 0 AND 365 THEN
    RAISE EXCEPTION 'Bloke süresi 0 ile 365 gün arasında olmalı.';
  END IF;

  IF p_financing_counterparty_id IS NOT NULL
     AND p_financing_counterparty_id IS DISTINCT FROM v_row.financing_counterparty_id THEN
    SELECT * INTO v_cp FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.id = p_financing_counterparty_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Kişi / kurum bulunamadı.';
    END IF;
    IF NOT v_cp.is_active THEN
      RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
    END IF;
  END IF;

  IF p_financing_account_id IS NOT NULL
     AND p_financing_account_id IS DISTINCT FROM v_row.financing_account_id THEN
    SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = p_financing_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hesap bulunamadı.';
    END IF;
    IF NOT v_acc.is_active OR v_acc.kind NOT IN ('bank', 'pos') THEN
      RAISE EXCEPTION 'Bakiye hesabı banka veya POS türünde, aktif bir hesap olmalı.';
    END IF;
  END IF;

  UPDATE public.fin_settings s
  SET financing_receipts_source = v_source,
      default_block_days = p_default_block_days,
      financing_counterparty_id = p_financing_counterparty_id,
      financing_account_id = p_financing_account_id
  WHERE s.id = v_row.id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__settings_json(v_clinic));
END;
$$;

-- Writes fin_accounts.import_key: the exact legacy '<Bank>:<account>' string that prefixes known-bank row keys
-- and keys their balances (BI:10, BI:25, FI:39). fin_save_account keeps its 0020 signature.
CREATE OR REPLACE FUNCTION public.fin_set_account_import_key(p_id uuid, p_version integer, p_import_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_row public.fin_accounts%ROWTYPE;
  v_key text := nullif(btrim(coalesce(p_import_key, '')), '');
  v_other uuid;
BEGIN
  SELECT * INTO v_row FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  IF v_row.import_key IS NOT DISTINCT FROM v_key THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__account_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  IF v_key IS NOT NULL THEN
    IF char_length(v_key) > 200 OR v_key !~ '^[^:\s][^:]*:[^:]+$' THEN
      RAISE EXCEPTION 'İçe aktarma anahtarı "Banka:hesap" biçiminde ve en fazla 200 karakter olmalı.';
    END IF;
    IF v_row.kind NOT IN ('bank', 'pos') THEN
      RAISE EXCEPTION 'İçe aktarma anahtarı yalnızca banka veya POS hesabına verilebilir.';
    END IF;
    SELECT a.id INTO v_other
    FROM public.fin_accounts a
    WHERE a.clinic_id = v_clinic AND a.import_key = v_key AND a.id <> p_id
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'Bu içe aktarma anahtarı başka bir hesapta kullanılıyor.'
        USING ERRCODE = 'PT409', DETAIL = v_other::text;
    END IF;
  END IF;

  BEGIN
    UPDATE public.fin_accounts a SET import_key = v_key WHERE a.clinic_id = v_clinic AND a.id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Bu içe aktarma anahtarı başka bir hesapta kullanılıyor.' USING ERRCODE = 'PT409';
  END;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__account_json(v_clinic, p_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.3 fin_save_classification_rule (write). p_version = 0 creates; no delete (deactivate instead).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_save_classification_rule(
  p_id uuid,
  p_version integer,
  p_priority integer,
  p_scope text,
  p_match_kind text,
  p_pattern text,
  p_category_id uuid,
  p_subcategory text,
  p_counterparty_id uuid,
  p_requires_entitlement_month boolean,
  p_auto_select boolean,
  p_warning text,
  p_is_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_classification_rules%ROWTYPE;
  v_priority integer;
  v_scope text := coalesce(nullif(btrim(coalesce(p_scope, '')), ''), 'any');
  v_kind text := btrim(coalesce(p_match_kind, ''));
  v_pattern text := nullif(btrim(coalesce(p_pattern, '')), '');
  v_sub text := nullif(btrim(coalesce(p_subcategory, '')), '');
  v_ent boolean := coalesce(p_requires_entitlement_month, false);
  v_auto boolean := coalesce(p_auto_select, false);
  v_warning text := btrim(coalesce(p_warning, ''));
  v_active boolean := coalesce(p_is_active, true);
  v_cat public.fin_categories%ROWTYPE;
  v_cp public.fin_counterparties%ROWTYPE;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_priority := public.fin__sort_order(p_priority);
  IF v_scope NOT IN ('any', 'bank', 'clinic') OR v_kind NOT IN ('contains', 'starts_with', 'exact', 'regex', 'always') THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;
  IF (v_kind = 'always') <> (v_pattern IS NULL) OR char_length(v_pattern) > 300 THEN
    RAISE EXCEPTION 'Kural deseni 1-300 karakter olmalı; "her zaman" kuralında desen olmaz.';
  END IF;
  IF char_length(v_warning) > 300 THEN
    RAISE EXCEPTION 'Uyarı metni en fazla 300 karakter olabilir.';
  END IF;

  SELECT * INTO v_cat FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;
  IF p_counterparty_id IS NOT NULL THEN
    SELECT * INTO v_cp FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.id = p_counterparty_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Kişi / kurum bulunamadı.';
    END IF;
  END IF;

  -- Only rows of the caller's clinic are read or locked (0020 pattern).
  SELECT * INTO v_row FROM public.fin_classification_rules r WHERE r.clinic_id = v_clinic AND r.id = p_id FOR UPDATE;

  IF p_version = 0 THEN
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__rule_json(v_clinic, p_id));
    END IF;
    IF NOT v_cat.is_active THEN
      RAISE EXCEPTION 'Pasif kategori seçilemez.';
    END IF;
    IF p_counterparty_id IS NOT NULL AND NOT v_cp.is_active THEN
      RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
    END IF;
    INSERT INTO public.fin_classification_rules (id, clinic_id, priority, scope, match_kind, pattern, category_id,
                                                 subcategory, counterparty_id, requires_entitlement_month,
                                                 auto_select, warning, is_active, is_seed, created_by, updated_by)
    VALUES (p_id, v_clinic, v_priority, v_scope, v_kind, v_pattern, p_category_id, v_sub, p_counterparty_id, v_ent,
            v_auto, v_warning, v_active, false, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_classification_rules r WHERE r.id = p_id AND r.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__rule_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('already_saved', false, 'record', public.fin__rule_json(v_clinic, p_id));
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF (v_row.priority, v_row.scope, v_row.match_kind, v_row.pattern, v_row.category_id, v_row.subcategory,
      v_row.counterparty_id, v_row.requires_entitlement_month, v_row.auto_select, v_row.warning, v_row.is_active)
     IS NOT DISTINCT FROM
     (v_priority, v_scope, v_kind, v_pattern, p_category_id, v_sub, p_counterparty_id, v_ent, v_auto, v_warning,
      v_active) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__rule_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_category_id IS DISTINCT FROM v_row.category_id AND NOT v_cat.is_active THEN
    RAISE EXCEPTION 'Pasif kategori seçilemez.';
  END IF;
  IF p_counterparty_id IS NOT NULL AND p_counterparty_id IS DISTINCT FROM v_row.counterparty_id
     AND NOT v_cp.is_active THEN
    RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
  END IF;

  UPDATE public.fin_classification_rules r
  SET priority = v_priority, scope = v_scope, match_kind = v_kind, pattern = v_pattern, category_id = p_category_id,
      subcategory = v_sub, counterparty_id = p_counterparty_id, requires_entitlement_month = v_ent,
      auto_select = v_auto, warning = v_warning, is_active = v_active
  WHERE r.clinic_id = v_clinic AND r.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__rule_json(v_clinic, p_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.4 fin_save_import_layout (write). kind and key_label never change after create.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_save_import_layout(
  p_id uuid,
  p_version integer,
  p_kind text,
  p_name text,
  p_config jsonb,
  p_key_label text,
  p_account_id uuid,
  p_receipts_account_id uuid,
  p_bank_paid_account_id uuid,
  p_cash_paid_account_id uuid,
  p_is_default boolean,
  p_is_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_import_layouts%ROWTYPE;
  v_name text;
  v_config jsonb;
  v_label text := nullif(btrim(coalesce(p_key_label, '')), '');
  v_default boolean := coalesce(p_is_default, false);
  v_active boolean := coalesce(p_is_active, true);
  v_other uuid;
  v_acc public.fin_accounts%ROWTYPE;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('clinic_workbook', 'bank_table') THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;
  v_name := public.fin__name(p_name, 80);
  v_config := public.fin__layout_config(p_kind, p_config);

  IF p_kind = 'bank_table' THEN
    IF v_label IS NULL OR char_length(v_label) > 100 THEN
      RAISE EXCEPTION 'Banka + hesap etiketi 1-100 karakter olmalı.';
    END IF;
    IF p_account_id IS NULL OR p_receipts_account_id IS NOT NULL OR p_bank_paid_account_id IS NOT NULL
       OR p_cash_paid_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'Banka dökümü için banka veya POS türünde aktif bir hesap seçin.';
    END IF;
  ELSE
    IF v_label IS NOT NULL THEN
      RAISE EXCEPTION 'Geçersiz değer.';
    END IF;
    IF p_account_id IS NOT NULL OR p_receipts_account_id IS NULL OR p_bank_paid_account_id IS NULL
       OR p_cash_paid_account_id IS NULL THEN
      RAISE EXCEPTION 'Tahsilat, banka ve nakit hesaplarını seçin.';
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.fin_import_layouts l WHERE l.clinic_id = v_clinic AND l.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__layout_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF p_kind IS DISTINCT FROM v_row.kind OR v_label IS DISTINCT FROM v_row.key_label THEN
      RAISE EXCEPTION 'Bu alan değiştirilemez.';
    END IF;
    IF (v_row.name, v_row.config, v_row.account_id, v_row.receipts_account_id, v_row.bank_paid_account_id,
        v_row.cash_paid_account_id, v_row.is_default, v_row.is_active)
       IS NOT DISTINCT FROM
       (v_name, v_config, p_account_id, p_receipts_account_id, p_bank_paid_account_id, p_cash_paid_account_id,
        v_default, v_active) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__layout_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  -- Accounts: each newly chosen one must be active; the statement account is a bank or POS account (C10).
  IF p_kind = 'bank_table' THEN
    SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = p_account_id;
    IF NOT FOUND OR v_acc.kind NOT IN ('bank', 'pos')
       OR (NOT v_acc.is_active AND p_account_id IS DISTINCT FROM v_row.account_id) THEN
      RAISE EXCEPTION 'Banka dökümü için banka veya POS türünde aktif bir hesap seçin.';
    END IF;
  ELSE
    IF p_receipts_account_id IS DISTINCT FROM v_row.receipts_account_id THEN
      PERFORM public.fin__check_account(v_clinic, p_receipts_account_id);
    END IF;
    IF p_bank_paid_account_id IS DISTINCT FROM v_row.bank_paid_account_id THEN
      PERFORM public.fin__check_account(v_clinic, p_bank_paid_account_id);
    END IF;
    IF p_cash_paid_account_id IS DISTINCT FROM v_row.cash_paid_account_id THEN
      PERFORM public.fin__check_account(v_clinic, p_cash_paid_account_id);
    END IF;
  END IF;

  SELECT l.id INTO v_other
  FROM public.fin_import_layouts l
  WHERE l.clinic_id = v_clinic AND l.kind = p_kind AND l.id <> p_id
    AND public.fin__normalize_name(l.name) = public.fin__normalize_name(v_name)
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  IF p_kind = 'bank_table' AND p_version = 0 THEN
    SELECT l.id INTO v_other
    FROM public.fin_import_layouts l
    WHERE l.clinic_id = v_clinic AND l.kind = 'bank_table' AND l.id <> p_id
      AND regexp_replace(public.fin__fold(l.key_label), '\s', '', 'g')
          = regexp_replace(public.fin__fold(v_label), '\s', '', 'g')
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'Bu banka + hesap etiketi başka bir eşleştirmede kullanılıyor.'
        USING ERRCODE = 'PT409', DETAIL = v_other::text;
    END IF;
  END IF;

  -- One default per kind: clear the others first, in the same transaction.
  IF v_default THEN
    UPDATE public.fin_import_layouts l
    SET is_default = false
    WHERE l.clinic_id = v_clinic AND l.kind = p_kind AND l.id <> p_id AND l.is_default;
  END IF;

  IF p_version = 0 THEN
    BEGIN
      INSERT INTO public.fin_import_layouts (id, clinic_id, kind, name, config, key_label, account_id,
                                             receipts_account_id, bank_paid_account_id, cash_paid_account_id,
                                             is_default, is_active, created_by, updated_by)
      VALUES (p_id, v_clinic, p_kind, v_name, v_config, v_label, p_account_id, p_receipts_account_id,
              p_bank_paid_account_id, p_cash_paid_account_id, v_default, v_active, v_user, v_user)
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_import_layouts l WHERE l.id = p_id AND l.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__layout_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    BEGIN
      UPDATE public.fin_import_layouts l
      SET name = v_name, config = v_config, account_id = p_account_id, receipts_account_id = p_receipts_account_id,
          bank_paid_account_id = p_bank_paid_account_id, cash_paid_account_id = p_cash_paid_account_id,
          is_default = v_default, is_active = v_active
      WHERE l.clinic_id = v_clinic AND l.id = p_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu ad zaten kullanılıyor.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__layout_json(v_clinic, p_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.6 Debt suggestions for a bank outflow (port of debtCandidates, MT:4-13). Candidates: not cancelled, not a
--     financing fee entry, 'out' category, outstanding >= amount (C15: one bank row settles one debt, no
--     overpayment). Inlinable (no SET clause); only called from SECURITY DEFINER functions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__debt_candidates(p_clinic uuid, p_amount_cents bigint, p_date date, p_text text)
RETURNS TABLE (
  entry_id uuid,
  suggested boolean,
  score integer,
  reason text,
  counterparty_name text,
  description text,
  category_name text,
  report_bucket text,
  due_date date,
  amount_cents bigint,
  outstanding_cents bigint,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.id,
         (k.name_match AND abs(p_date - s.due_date) <= 45),
         ((CASE WHEN k.name_match THEN 100 ELSE 0 END)
          + (CASE WHEN s.outstanding_cents = p_amount_cents THEN 20 ELSE 0 END)
          + (CASE WHEN abs(p_date - s.due_date) <= 7 THEN 10 ELSE 0 END))::integer,
         CASE WHEN k.name_match
              THEN 'Kişi / kurum eşleşiyor'
                   || CASE WHEN s.outstanding_cents = p_amount_cents THEN ' · tutar aynı' ELSE ' · kısmi ödeme' END
              ELSE 'Elle kontrol edin' END,
         s.counterparty_name,
         s.description,
         s.category_name,
         s.report_bucket,
         s.due_date,
         s.amount_cents,
         s.outstanding_cents,
         s.created_at
  FROM public.fin__entries_state(p_clinic) s
  CROSS JOIN LATERAL (
    SELECT coalesce(count(*) > 0
                    AND bool_and(pg_catalog.strpos(public.fin__match_text(p_text), t.tok) > 0), false) AS name_match
    FROM pg_catalog.regexp_split_to_table(public.fin__match_text(s.counterparty_name), ' ') AS t(tok)
    WHERE pg_catalog.char_length(t.tok) >= 3 AND t.tok NOT IN ('banka', 'odeme', 'toplam')
  ) k
  WHERE s.direction = 'out'
    AND s.cancelled_at IS NULL
    AND s.outstanding_cents >= p_amount_cents
    AND NOT EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = s.id)
$$;

CREATE OR REPLACE FUNCTION public.fin_debt_candidates(
  p_amount_cents bigint,
  p_date date,
  p_text text,
  p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_limit integer := coalesce(p_limit, 50);
  v_total bigint;
  v_rows jsonb;
BEGIN
  PERFORM public.fin__amount(p_amount_cents);
  PERFORM public.fin__day(p_date);
  IF char_length(coalesce(p_text, '')) > 1000 OR v_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;

  WITH c AS (
    SELECT d.*, e.version AS entry_version, count(*) OVER () AS n
    FROM public.fin__debt_candidates(v_clinic, p_amount_cents, p_date, coalesce(p_text, '')) d
    JOIN public.fin_entries e ON e.clinic_id = v_clinic AND e.id = d.entry_id
  ),
  pg AS (
    SELECT c.*
    FROM c
    ORDER BY c.score DESC, c.due_date, c.created_at, c.entry_id
    LIMIT v_limit
  )
  SELECT coalesce(max(pg.n), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
                    'suggested', pg.suggested,
                    'score', pg.score,
                    'reason', pg.reason,
                    'entry', jsonb_build_object(
                      'id', pg.entry_id,
                      'version', pg.entry_version,
                      'counterparty_name', pg.counterparty_name,
                      'description', pg.description,
                      'category_name', pg.category_name,
                      'report_bucket', pg.report_bucket,
                      'due_date', pg.due_date,
                      'amount_cents', pg.amount_cents,
                      'outstanding_cents', pg.outstanding_cents))
                  ORDER BY pg.score DESC, pg.due_date, pg.created_at, pg.entry_id), '[]'::jsonb)
    INTO v_total, v_rows
  FROM pg;

  RETURN jsonb_build_object('total_count', v_total, 'candidates', v_rows);
END;
$$;

-- batch_duplicate (legacy IP:18, C9), computed over the WHOLE request so it never depends on row order: rows grouped by
-- '<day>|<amount_cents>' with their row_no and whether they are bank rows. Shared by fin_import_check and
-- fin_import_rows, so the codes the preflight reports are exactly the codes the commit enforces.
CREATE OR REPLACE FUNCTION public.fin__batch_dups(p_rows jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(jsonb_object_agg(d.k, d.v), '{}'::jsonb)
  FROM (
    SELECT x.k, jsonb_agg(jsonb_build_object('row_no', x.row_no, 'bank', x.bank) ORDER BY x.o) AS v
    FROM (
      SELECT r.o,
             public.fin__iso_date(public.fin__parse_day(public.fin__json_text(r.v -> 'date'))) || '|'
               || public.fin__json_int(r.v -> 'amount_cents', 1, 1000000000000)::text AS k,
             coalesce(public.fin__json_int(r.v -> 'row_no', 1, 1000000), r.o) AS row_no,
             coalesce(public.fin__json_text(r.v -> 'kind') IN ('bank_known', 'bank_table'), false) AS bank
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END)
             WITH ORDINALITY AS r(v, o)
      WHERE jsonb_typeof(r.v) = 'object'
    ) x
    WHERE x.k IS NOT NULL
    GROUP BY x.k
  ) d
$$;

-- The row_no of the first OTHER request row that makes this row a batch duplicate, else NULL: a bank row shares
-- its day and amount with any other row (bank or workbook); a workbook row shares them with a bank row (critique 9:
-- a workbook expense paid by bank plus the same statement line in one batch).
CREATE OR REPLACE FUNCTION public.fin__batch_dup_of(p_dups jsonb, p_key text, p_kind text, p_row_no bigint)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (SELECT e.v -> 'row_no'
          FROM jsonb_array_elements(coalesce(p_dups -> p_key, '[]'::jsonb)) WITH ORDINALITY AS e(v, o)
          WHERE (e.v ->> 'row_no')::bigint IS DISTINCT FROM p_row_no
            AND (p_kind IN ('bank_known', 'bank_table') OR (e.v ->> 'bank')::boolean)
          ORDER BY e.o
          LIMIT 1)
$$;

-- ---------------------------------------------------------------------------
-- 4.5 fin_import_check (write permission; reads only): the review-table preflight. Same warning definitions as
--     fin_import_rows step 5, plus the status of every key and the hard refusals shown early.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_check(p_month text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date := public.clinic_today();
  v_month date;
  v_m1 date;
  v_manual_n bigint;
  v_manual_total bigint;
  v_row jsonb;
  v_o bigint;
  v_row_no bigint;
  v_key text;
  v_kind text;
  v_entry_id uuid;
  v_date date;
  v_amount bigint;
  v_direction text;
  v_desc text;
  v_fp text;
  v_src public.fin_import_sources%ROWTYPE;
  v_pay public.fin_payments%ROWTYPE;
  v_status text;
  v_existing jsonb;
  v_warnings jsonb;
  v_errors jsonb;
  v_examples jsonb;
  v_dups jsonb;
  v_dup jsonb;
  v_dupkey text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF p_month IS NULL OR btrim(p_month) !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  v_month := public.fin__month(p_month);
  v_m1 := (v_month + interval '1 month')::date;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Kontrol için en fazla 2000 satır gönderilebilir.';
  END IF;
  IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Kontrol için en fazla 2000 satır gönderilebilir.';
  END IF;

  v_dups := public.fin__batch_dups(p_rows);

  -- Manual patient receipts of the month (legacy IP:24): no source key, live payments in the month.
  SELECT count(DISTINCT e.id)::bigint, coalesce(sum(p.amount_cents), 0)::bigint
    INTO v_manual_n, v_manual_total
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.entry_id = e.id
  WHERE e.clinic_id = v_clinic
    AND c.report_bucket = 'patient_receipts'
    AND e.source_key IS NULL
    AND p.voided_at IS NULL
    AND p.paid_on >= v_month AND p.paid_on < v_m1;

  FOR v_row, v_o IN
    SELECT r.v, r.o FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(v, o) ORDER BY r.o
  LOOP
    IF jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_row) AS k(name)
      WHERE k.name NOT IN ('row_no', 'key', 'kind', 'entry_id', 'date', 'amount_cents', 'direction', 'description',
                           'fingerprint')
    ) THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;

    IF coalesce(jsonb_typeof(v_row -> 'row_no'), 'null') = 'null' THEN
      v_row_no := v_o;
    ELSE
      v_row_no := public.fin__json_int(v_row -> 'row_no', 1, 1000000);
    END IF;
    v_key := public.fin__json_text(v_row -> 'key');
    v_kind := public.fin__json_text(v_row -> 'kind');
    v_date := public.fin__parse_day(public.fin__json_text(v_row -> 'date'));
    v_amount := public.fin__json_int(v_row -> 'amount_cents', 1, 1000000000000);
    v_direction := public.fin__json_text(v_row -> 'direction');
    v_desc := coalesce(public.fin__json_text(v_row -> 'description'), '');
    v_fp := public.fin__json_text(v_row -> 'fingerprint');
    v_entry_id := public.fin__json_uuid(v_row -> 'entry_id');
    IF v_row_no IS NULL OR v_key IS NULL OR v_kind IS NULL OR v_date IS NULL OR v_amount IS NULL THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    IF char_length(v_key) NOT BETWEEN 1 AND 800 OR v_kind NOT IN ('clinic_excel', 'bank_known', 'bank_table')
       OR char_length(v_desc) > 1000 THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    IF (coalesce(jsonb_typeof(v_row -> 'direction'), 'null') <> 'null' AND coalesce(v_direction, '') NOT IN ('in', 'out'))
       OR (coalesce(jsonb_typeof(v_row -> 'entry_id'), 'null') <> 'null' AND v_entry_id IS NULL)
       OR (coalesce(jsonb_typeof(v_row -> 'fingerprint'), 'null') <> 'null' AND v_fp IS NULL)
       OR (coalesce(jsonb_typeof(v_row -> 'description'), 'null') NOT IN ('null', 'string')) THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;

    -- Status of the key (one namespace, C15).
    v_status := 'new';
    v_existing := NULL;
    SELECT * INTO v_src FROM public.fin_import_sources s WHERE s.clinic_id = v_clinic AND s.source_key = v_key;
    IF FOUND THEN
      IF v_src.link_kind = 'entry' THEN
        v_status := CASE WHEN v_src.fingerprint IS NOT DISTINCT FROM v_fp THEN 'saved_same' ELSE 'saved_changed' END;
        SELECT jsonb_build_object(
                 'entry_id', e.id,
                 'amount_cents', e.amount_cents,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'paid_on', coalesce(p.paid_on, e.due_date),
                 'source_kind', v_src.source_kind,
                 'batch_id', v_src.batch_id)
          INTO v_existing
        FROM public.fin_entries e
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        LEFT JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.id = v_src.payment_id
        WHERE e.clinic_id = v_clinic AND e.id = v_src.entry_id;
      ELSE
        SELECT * INTO v_pay FROM public.fin_payments p WHERE p.clinic_id = v_clinic AND p.id = v_src.payment_id;
        IF v_pay.voided_at IS NOT NULL THEN
          v_status := 'match_voided';
        ELSIF v_pay.amount_cents = v_amount AND v_pay.paid_on = v_date THEN
          v_status := 'matched_same';
        ELSE
          v_status := 'matched_changed';
        END IF;
        SELECT jsonb_build_object(
                 'entry_id', e.id,
                 'amount_cents', v_pay.amount_cents,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'paid_on', v_pay.paid_on,
                 'source_kind', v_src.source_kind,
                 'batch_id', v_src.batch_id)
          INTO v_existing
        FROM public.fin_entries e
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        WHERE e.clinic_id = v_clinic AND e.id = v_src.entry_id;
      END IF;
    ELSIF v_entry_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = v_entry_id) THEN
      -- Only the caller's own clinic is looked at: an id of another clinic never shows (no existence oracle).
      v_status := 'id_taken';
    END IF;

    -- Hard refusals at save time, shown early.
    v_errors := '[]'::jsonb;
    IF NOT public.fin__source_key_ok(v_kind, v_key, v_date, v_direction)
       OR (v_entry_id IS NOT NULL AND v_entry_id IS DISTINCT FROM public.fin__import_id(v_clinic, v_key)) THEN
      v_errors := v_errors || to_jsonb('invalid_key'::text);
    END IF;
    IF v_date < v_month OR v_date >= v_m1 THEN
      v_errors := v_errors || to_jsonb('outside_month'::text);
    END IF;
    IF v_date > v_today THEN
      v_errors := v_errors || to_jsonb('future_date'::text);
    END IF;
    -- Voided financing rows no longer claim their loan's bank lines (fin_financing_void: "should not have been
    -- imported"), so those lines can be imported here again.
    IF public.fin__financing_marker(v_desc)
       OR EXISTS (SELECT 1 FROM public.fin_patient_financing f
                  WHERE f.clinic_id = v_clinic AND f.voided_at IS NULL AND strpos(v_desc, f.loan_key) > 0) THEN
      v_errors := v_errors || to_jsonb('financing_line'::text);
    END IF;
    IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND EXISTS (
      SELECT 1 FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic AND e.source_key = public.fin__receipts_key('dentos', v_date)
        AND e.cancelled_at IS NULL
    ) THEN
      v_errors := v_errors || to_jsonb('receipts_day_taken'::text);
    END IF;

    -- Warnings (C9), only for rows that can still be sent.
    v_warnings := '[]'::jsonb;
    v_dupkey := public.fin__iso_date(v_date) || '|' || v_amount::text;
    IF v_status IN ('new', 'match_voided', 'id_taken') THEN
      SELECT coalesce(jsonb_agg(x.obj ORDER BY x.recorded_at, x.id), '[]'::jsonb) INTO v_examples
      FROM (
        SELECT p.id, p.recorded_at,
               jsonb_build_object(
                 'entry_id', e.id,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'paid_on', p.paid_on,
                 'amount_cents', p.amount_cents,
                 'account_name', a.name) AS obj
        FROM public.fin_payments p
        JOIN public.fin_entries e ON e.clinic_id = p.clinic_id AND e.id = p.entry_id
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        JOIN public.fin_accounts a ON a.clinic_id = p.clinic_id AND a.id = p.account_id
        WHERE p.clinic_id = v_clinic
          AND p.voided_at IS NULL
          AND p.paid_on = v_date
          AND p.amount_cents = v_amount
          AND e.source_key IS DISTINCT FROM v_key
          AND p.bank_source_key IS DISTINCT FROM v_key
        ORDER BY p.recorded_at, p.id
        LIMIT 3
      ) x;
      IF jsonb_array_length(v_examples) > 0 THEN
        v_warnings := v_warnings || jsonb_build_array(
          jsonb_build_object('code', 'possible_duplicate', 'examples', v_examples));
      END IF;
      v_dup := public.fin__batch_dup_of(v_dups, v_dupkey, v_kind, v_row_no);
      IF v_dup IS NOT NULL THEN
        v_warnings := v_warnings || jsonb_build_array(
          jsonb_build_object('code', 'batch_duplicate', 'row_no', v_dup));
      END IF;
      IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND v_manual_n > 0 THEN
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'manual_receipt_overlap'));
      END IF;
    END IF;

    -- Debt suggestions are not computed here (one ledger scan per row); the review table asks fin_debt_candidates
    -- when the user opens the matcher of a selected bank outflow.
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'row_no', v_row_no,
      'key', v_key,
      'status', v_status,
      'existing', v_existing,
      'warnings', v_warnings,
      'errors', v_errors));
  END LOOP;

  RETURN jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'manual_receipts', jsonb_build_object('count', v_manual_n, 'total_cents', v_manual_total),
    'reconciliation', public.fin__receipt_reconciliation(v_clinic, v_month),
    'rows', v_out);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.7 fin_import_rows (write): the atomic commit of the review table (legacy POST /api/finance/import IR:11-39
--     plus the bank matches legacy sent one by one, RT:45-55). One transaction; any error refuses the batch.
--     Every per-row message is prefixed '<file> · <date> · <n>. seçili satır' and DETAIL = {row_no, key, ...}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_rows(p_rows jsonb, p_batch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_today date;
  v_batch_id uuid;
  v_month date;
  v_m1 date;
  v_files text[] := ARRAY[]::text[];
  v_layouts uuid[] := ARRAY[]::uuid[];
  v_owner uuid;
  v_stored jsonb;
  v_rows_n integer;
  v_manual_n bigint;
  v_dups jsonb;
  v_targets uuid[] := ARRAY[]::uuid[];
  v_new_payments uuid[] := ARRAY[]::uuid[];
  v_results jsonb := '[]'::jsonb;
  v_inserted integer := 0;
  v_matched integer := 0;
  v_skipped integer := 0;
  v_ack integer := 0;
  v_any_receipts boolean := false;
  v_rec jsonb;
  v_rec_out jsonb;
  v_result jsonb;
  v_item jsonb;
  -- per row
  v_row jsonb;
  v_o bigint;
  v_row_no integer;
  v_key text;
  v_kind text;
  v_file text;
  v_date date;
  v_amount bigint;
  v_direction text;
  v_desc text;
  v_account uuid;
  v_ack_codes text[];
  v_match jsonb;
  v_is_match boolean;
  v_m_entry uuid;
  v_m_version bigint;
  v_m_payment uuid;
  v_entry_id uuid;
  v_fp text;
  v_category uuid;
  v_sub text;
  v_ent_month text;
  v_cp uuid;
  v_cp_text text;
  v_ctx text;
  v_detail jsonb;
  v_dupkey text;
  v_is_batch_dup boolean;
  v_src public.fin_import_sources%ROWTYPE;
  v_has_src boolean;
  v_rebind boolean;
  v_pay public.fin_payments%ROWTYPE;
  v_in record;
  v_acc public.fin_accounts%ROWTYPE;
  v_target public.fin_entries%ROWTYPE;
  v_dir text;
  v_bucket text;
  v_codes text[];
  v_code text;
  v_status text;
  v_res_entry uuid;
  v_res_payment uuid;
  v_name text;
  v_constraint text;
BEGIN
  -- Step 1: lock, batch shape, replay.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_import:' || v_clinic::text, 0));
  v_today := public.clinic_today();
  PERFORM public.fin__set_ctx('import');

  IF p_batch IS NULL OR jsonb_typeof(p_batch) <> 'object' THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_batch) AS k(name)
             WHERE k.name NOT IN ('id', 'month', 'file_names', 'layout_ids')) THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  v_batch_id := public.fin__json_uuid(p_batch -> 'id');
  IF v_batch_id IS NULL OR coalesce(public.fin__json_text(p_batch -> 'month'), '') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  v_month := public.fin__parse_day((p_batch ->> 'month') || '-01');
  IF v_month IS NULL OR v_month > public.fin__month_start(v_today) THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  v_m1 := (v_month + interval '1 month')::date;

  IF coalesce(jsonb_typeof(p_batch -> 'file_names'), 'null') <> 'null' THEN
    IF jsonb_typeof(p_batch -> 'file_names') <> 'array' THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    IF jsonb_array_length(p_batch -> 'file_names') > 50 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_batch -> 'file_names') AS f(v)
      WHERE public.fin__json_text(f.v) IS NULL OR char_length(f.v #>> '{}') NOT BETWEEN 1 AND 200
    ) THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    SELECT coalesce(array_agg(f.v #>> '{}' ORDER BY f.o), ARRAY[]::text[]) INTO v_files
    FROM jsonb_array_elements(p_batch -> 'file_names') WITH ORDINALITY AS f(v, o);
  END IF;

  IF coalesce(jsonb_typeof(p_batch -> 'layout_ids'), 'null') <> 'null' THEN
    IF jsonb_typeof(p_batch -> 'layout_ids') <> 'array' THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    IF jsonb_array_length(p_batch -> 'layout_ids') > 50 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_batch -> 'layout_ids') AS f(v)
      WHERE public.fin__json_uuid(f.v) IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.fin_import_layouts l
                        WHERE l.clinic_id = v_clinic AND l.id = public.fin__json_uuid(f.v))
    ) THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    SELECT coalesce(array_agg(DISTINCT public.fin__json_uuid(f.v)), ARRAY[]::uuid[]) INTO v_layouts
    FROM jsonb_array_elements(p_batch -> 'layout_ids') AS f(v);
  END IF;

  SELECT b.clinic_id, b.result INTO v_owner, v_stored FROM public.fin_import_batches b WHERE b.id = v_batch_id;
  IF v_owner IS NOT NULL THEN
    IF v_owner = v_clinic THEN
      RETURN v_stored || jsonb_build_object('already_saved', true,
                                            'batch', public.fin__batch_json(v_clinic, v_batch_id));
    END IF;
    RAISE EXCEPTION 'Aktarım kaydedilemedi.' USING ERRCODE = 'PT409';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Bir aktarımda en az 1, en fazla 500 satır gönderilebilir.';
  END IF;
  v_rows_n := jsonb_array_length(p_rows);
  IF v_rows_n NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Bir aktarımda en az 1, en fazla 500 satır gönderilebilir.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(v)
    WHERE jsonb_typeof(r.v) = 'object' AND public.fin__json_text(r.v -> 'key') IS NOT NULL
    GROUP BY r.v ->> 'key'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Seçimde tekrarlanan kaynak satırı var.';
  END IF;
  v_dups := public.fin__batch_dups(p_rows);

  -- Manual patient receipts of the batch month (manual_receipt_overlap, legacy IP:24).
  SELECT count(DISTINCT e.id)::bigint INTO v_manual_n
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.entry_id = e.id
  WHERE e.clinic_id = v_clinic
    AND c.report_bucket = 'patient_receipts'
    AND e.source_key IS NULL
    AND p.voided_at IS NULL
    AND p.paid_on >= v_month AND p.paid_on < v_m1;

  FOR v_row, v_o IN
    SELECT r.v, r.o FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(v, o) ORDER BY r.o
  LOOP
    -- Context first, so every later message names the row.
    v_row_no := v_o::integer;
    IF jsonb_typeof(v_row) = 'object' AND public.fin__json_int(v_row -> 'row_no', 1, 1000000) IS NOT NULL THEN
      v_row_no := public.fin__json_int(v_row -> 'row_no', 1, 1000000)::integer;
    END IF;
    IF jsonb_typeof(v_row) = 'object' THEN
      v_file := public.fin__json_text(v_row -> 'file');
      v_date := public.fin__parse_day(public.fin__json_text(v_row -> 'date'));
      v_key := public.fin__json_text(v_row -> 'key');
    ELSE
      v_file := NULL;
      v_date := NULL;
      v_key := NULL;
    END IF;
    v_ctx := public.fin__row_ctx(v_file, v_date, v_row_no);
    v_detail := jsonb_build_object('row_no', v_row_no, 'key', v_key);

    -- Step 2: shape.
    IF jsonb_typeof(v_row) <> 'object' THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_row) AS k(name)
      WHERE k.name NOT IN ('row_no', 'key', 'kind', 'file', 'date', 'amount_cents', 'direction', 'currency',
                           'account_id', 'acknowledged', 'entry_id', 'fingerprint', 'category_id', 'subcategory',
                           'entitlement_month', 'counterparty_id', 'counterparty_text', 'description', 'match')
    ) OR public.fin__json_int(v_row -> 'row_no', 1, 1000000) IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    IF coalesce(jsonb_typeof(v_row -> 'file'), 'null') <> 'null'
       AND (v_file IS NULL OR char_length(v_file) > 200) THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    v_file := nullif(btrim(coalesce(v_file, '')), '');

    v_kind := public.fin__json_text(v_row -> 'kind');
    IF v_kind IS NULL OR v_key IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
    END IF;
    IF char_length(v_key) NOT BETWEEN 1 AND 800
       OR v_kind NOT IN ('clinic_excel', 'bank_known', 'bank_table')
       OR (v_kind = 'clinic_excel' AND left(v_key, 7) <> 'clinic:')
       OR (v_kind = 'bank_known' AND left(v_key, 5) <> 'bank:')
       OR (v_kind = 'bank_table' AND left(v_key, 11) <> 'bank-table:') THEN
      PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
    END IF;

    v_amount := public.fin__json_int(v_row -> 'amount_cents', 1, 1000000000000);
    IF v_amount IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'tutar', v_detail);
    END IF;
    IF v_date IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'işlem tarihi', v_detail);
    END IF;
    IF public.fin__json_text(v_row -> 'currency') IS DISTINCT FROM 'TRY' THEN
      PERFORM public.fin__row_raise(v_ctx,
        'Dövizli hareket TL olarak aktarılamaz; TL karşılığı olan bir döküm kullanın. Hiçbir kayıt aktarılmadı.',
        'P0001', v_detail);
    END IF;
    v_desc := public.fin__json_text(v_row -> 'description');
    IF v_desc IS NULL OR char_length(v_desc) > 1000 THEN
      PERFORM public.fin__row_field(v_ctx, 'açıklama', v_detail);
    END IF;
    v_direction := public.fin__json_text(v_row -> 'direction');
    IF v_direction IS NULL OR v_direction NOT IN ('in', 'out') THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    -- The key must mean this row: its template, its embedded day = the row day, receipts = inflow, expense = outflow.
    IF NOT public.fin__source_key_ok(v_kind, v_key, v_date, v_direction) THEN
      PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
    END IF;

    IF v_date < v_month OR v_date >= v_m1 THEN
      PERFORM public.fin__row_raise(v_ctx, 'satır seçilen aktarım ayının dışında. Hiçbir kayıt aktarılmadı.',
                                    'P0001', v_detail);
    END IF;
    IF v_date > v_today THEN
      PERFORM public.fin__row_raise(v_ctx, 'Ödeme tutarını ve tarihini kontrol edin. Hiçbir kayıt aktarılmadı.',
                                    'P0001', v_detail);
    END IF;

    -- Financing guard (IR:24): fee lines of patient financing belong to the financing upload. A voided financing row
    -- releases its loan's lines (fin_financing_void: "should not have been imported").
    IF public.fin__financing_marker(v_desc)
       OR EXISTS (SELECT 1 FROM public.fin_patient_financing f
                  WHERE f.clinic_id = v_clinic AND f.voided_at IS NULL AND strpos(v_desc, f.loan_key) > 0) THEN
      PERFORM public.fin__row_raise(v_ctx,
        'Hasta finansmanı kesintilerini finans ekranındaki Hasta finansmanı bölümünden yükleyin. Çift sayımı önlemek için bu aktarım durduruldu.',
        'P0001', v_detail);
    END IF;

    -- Daily receipts: workbook and DentOS daily totals are mutually exclusive per day (C13).
    IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND EXISTS (
      SELECT 1 FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic AND e.source_key = public.fin__receipts_key('dentos', v_date)
        AND e.cancelled_at IS NULL
    ) THEN
      PERFORM public.fin__row_raise(v_ctx,
        'Bu gün için DentOS günlük tahsilatı kayıtlı; klinik Excel tahsilatı ayrıca aktarılamaz. Hiçbir kayıt aktarılmadı.',
        'PT409', v_detail);
    END IF;

    v_account := public.fin__json_uuid(v_row -> 'account_id');
    IF v_account IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'hesap', v_detail);
    END IF;

    v_ack_codes := ARRAY[]::text[];
    IF coalesce(jsonb_typeof(v_row -> 'acknowledged'), 'null') <> 'null' THEN
      IF jsonb_typeof(v_row -> 'acknowledged') <> 'array' THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      IF jsonb_array_length(v_row -> 'acknowledged') > 10 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_row -> 'acknowledged') AS a(v) WHERE jsonb_typeof(a.v) <> 'string'
      ) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      SELECT coalesce(array_agg(a.v #>> '{}'), ARRAY[]::text[]) INTO v_ack_codes
      FROM jsonb_array_elements(v_row -> 'acknowledged') AS a(v);
    END IF;

    v_match := v_row -> 'match';
    v_is_match := coalesce(jsonb_typeof(v_match), 'null') <> 'null';
    v_m_entry := NULL;
    v_m_version := NULL;
    v_m_payment := NULL;
    v_entry_id := NULL;
    v_fp := NULL;
    v_category := NULL;
    v_sub := NULL;
    v_ent_month := NULL;
    v_cp := NULL;
    v_cp_text := NULL;
    IF v_is_match THEN
      IF jsonb_typeof(v_match) <> 'object' THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_match) AS k(name)
                 WHERE k.name NOT IN ('entry_id', 'version', 'payment_id')) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      v_m_entry := public.fin__json_uuid(v_match -> 'entry_id');
      v_m_version := public.fin__json_int(v_match -> 'version', 1, 2147483647);
      v_m_payment := public.fin__json_uuid(v_match -> 'payment_id');
      IF v_m_entry IS NULL OR v_m_version IS NULL THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(ARRAY['entry_id', 'fingerprint', 'category_id', 'subcategory', 'entitlement_month',
                                   'counterparty_id', 'counterparty_text']) AS f(name)
        WHERE coalesce(jsonb_typeof(v_row -> f.name), 'null') <> 'null'
      ) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
    ELSE
      v_entry_id := public.fin__json_uuid(v_row -> 'entry_id');
      -- The deterministic id (keys.ts importedEntryId), never an id of the client's choosing.
      IF v_entry_id IS NULL OR v_entry_id IS DISTINCT FROM public.fin__import_id(v_clinic, v_key) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      v_fp := public.fin__json_text(v_row -> 'fingerprint');
      IF v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
        PERFORM public.fin__row_field(v_ctx, 'parmak izi', v_detail);
      END IF;
      v_category := public.fin__json_uuid(v_row -> 'category_id');
      IF v_category IS NULL THEN
        PERFORM public.fin__row_field(v_ctx, 'kategori', v_detail);
      END IF;
      IF coalesce(jsonb_typeof(v_row -> 'subcategory'), 'null') NOT IN ('null', 'string')
         OR coalesce(jsonb_typeof(v_row -> 'entitlement_month'), 'null') NOT IN ('null', 'string')
         OR coalesce(jsonb_typeof(v_row -> 'counterparty_text'), 'null') NOT IN ('null', 'string') THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      v_sub := public.fin__json_text(v_row -> 'subcategory');
      v_ent_month := public.fin__json_text(v_row -> 'entitlement_month');
      v_cp_text := public.fin__json_text(v_row -> 'counterparty_text');
      IF coalesce(jsonb_typeof(v_row -> 'counterparty_id'), 'null') <> 'null' THEN
        v_cp := public.fin__json_uuid(v_row -> 'counterparty_id');
        IF v_cp IS NULL THEN
          PERFORM public.fin__row_field(v_ctx, 'işlem adı', v_detail);
        END IF;
      END IF;
    END IF;

    -- batch_duplicate looks at every other row of the request, whatever happens to it (legacy IP:18, order-free).
    v_dupkey := public.fin__iso_date(v_date) || '|' || v_amount::text;
    v_is_batch_dup := public.fin__batch_dup_of(v_dups, v_dupkey, v_kind, v_row_no) IS NOT NULL;

    -- Step 3: already imported or matched? (uniqueness only through fin_import_sources, C15)
    v_status := NULL;
    v_rebind := false;
    SELECT * INTO v_src
    FROM public.fin_import_sources s
    WHERE s.clinic_id = v_clinic AND s.source_key = v_key
    FOR UPDATE;
    v_has_src := FOUND;
    IF v_has_src THEN
      IF v_src.link_kind = 'entry' THEN
        IF v_is_match THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Bu banka satırı zaten kaydedilmiş veya başka borçla eşleşmiş. Yeni ödeme eklenmedi.', 'PT409', v_detail);
        END IF;
        IF v_src.fingerprint IS NOT DISTINCT FROM v_fp THEN
          v_status := 'skipped_same';
          v_res_entry := v_src.entry_id;
          v_res_payment := v_src.payment_id;
        ELSE
          SELECT coalesce(cp.name, e.counterparty_text) INTO v_name
          FROM public.fin_entries e
          LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
          WHERE e.clinic_id = v_clinic AND e.id = v_src.entry_id;
          PERFORM public.fin__row_raise(v_ctx,
            'Önceden aktarılan satır değişmiş: ' || coalesce(v_name, '') ||
            '. Mevcut kaydı finans listesinden düzeltin; yeniden eklenmedi. Hiçbir kayıt aktarılmadı.',
            'PT409', v_detail || jsonb_build_object('entry_id', v_src.entry_id));
        END IF;
      ELSE
        SELECT * INTO v_pay FROM public.fin_payments p WHERE p.clinic_id = v_clinic AND p.id = v_src.payment_id;
        IF v_pay.voided_at IS NULL THEN
          IF NOT v_is_match THEN
            IF v_pay.amount_cents = v_amount AND v_pay.paid_on = v_date THEN
              v_status := 'skipped_matched';
            ELSE
              PERFORM public.fin__row_raise(v_ctx,
                'Eşleşmiş banka satırının tutarı veya tarihi değişmiş; yeni kayıt eklenmedi. Hiçbir kayıt aktarılmadı.',
                'PT409', v_detail);
            END IF;
          ELSIF v_pay.entry_id = v_m_entry AND v_pay.amount_cents = v_amount AND v_pay.paid_on = v_date THEN
            v_status := 'skipped_matched';
          ELSE
            PERFORM public.fin__row_raise(v_ctx,
              'Bu banka satırı zaten kaydedilmiş veya başka borçla eşleşmiş. Yeni ödeme eklenmedi.', 'PT409', v_detail);
          END IF;
          v_res_entry := v_src.entry_id;
          v_res_payment := v_src.payment_id;
        ELSE
          v_rebind := true;   -- the matched payment was voided: this row re-binds the key (§2.5)
        END IF;
      END IF;
    END IF;

    IF v_status IS NOT NULL THEN
      -- Skipped rows end here: no warning check, not counted as acknowledged (IR:30).
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row_no, 'key', v_key, 'status', v_status, 'entry_id', v_res_entry, 'payment_id', v_res_payment));
      CONTINUE;
    END IF;

    -- Ids must be new (E_ID_TAKEN / E_PAYMENT_ID_TAKEN), checked across clinics without revealing anything (the
    -- ids are deterministic per clinic and key, so a hit means an id created outside this RPC).
    IF NOT v_is_match THEN
      IF EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_entry_id) THEN
        PERFORM public.fin__row_raise(v_ctx, 'Kayıt kaydedilemedi. Hiçbir kayıt aktarılmadı.', 'PT409', v_detail);
      END IF;
      IF EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.id = v_entry_id) THEN
        PERFORM public.fin__row_raise(v_ctx,
          'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.', 'PT409', v_detail);
      END IF;
    END IF;

    BEGIN
      -- Step 4: validate the new data.
      IF NOT v_is_match THEN
        SELECT * INTO v_in
        FROM public.fin__entry_input(v_clinic, v_category, v_sub, v_cp, v_cp_text, v_desc, v_date, v_amount,
                                     v_ent_month);
        IF NOT v_in.o_category_active THEN
          PERFORM public.fin__row_raise(v_ctx, 'Pasif kategori seçilemez. Hiçbir kayıt aktarılmadı.', 'P0001', v_detail);
        END IF;
        SELECT c.direction, c.report_bucket INTO v_dir, v_bucket
        FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = v_in.o_category_id;
        IF v_dir IS DISTINCT FROM v_direction THEN
          PERFORM public.fin__row_raise(v_ctx,
            'kategorinin yönü satırın giriş / çıkış yönüyle uyuşmuyor. Hiçbir kayıt aktarılmadı.', 'P0001', v_detail);
        END IF;
        -- A daily receipts key is a patient-receipts row (financing coverage and C13 read it by key).
        IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND v_bucket IS DISTINCT FROM 'patient_receipts' THEN
          PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
        END IF;
        IF NOT v_in.o_counterparty_active THEN
          PERFORM public.fin__row_raise(v_ctx, 'Pasif kişi / kurum seçilemez. Hiçbir kayıt aktarılmadı.', 'P0001',
                                        v_detail);
        END IF;
      ELSE
        IF v_kind NOT IN ('bank_known', 'bank_table') OR v_direction <> 'out' OR v_m_payment IS NULL THEN
          PERFORM public.fin__row_raise(v_ctx, 'Banka satırı veya ödeme tarihi geçersiz.', 'P0001', v_detail);
        END IF;
        IF v_m_entry = ANY (v_targets) THEN
          RAISE EXCEPTION 'Aynı borca bu aktarımda tek banka satırı eşleştirin; sonraki ödemeyi yenilenen kalan tutarla aktarın.'
            USING DETAIL = v_detail::text;
        END IF;
        v_targets := array_append(v_targets, v_m_entry);

        SELECT * INTO v_target FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = v_m_entry FOR UPDATE;
        IF NOT FOUND THEN
          PERFORM public.fin__row_raise(v_ctx, 'Borç bulunamadı.', 'PT404', v_detail);
        END IF;
        IF v_target.version IS DISTINCT FROM v_m_version::integer THEN
          PERFORM public.fin__row_raise(v_ctx, 'Borç başka ekranda değişti. Listeyi yenileyin.', 'PT409', v_detail);
        END IF;
        SELECT c.direction INTO v_dir
        FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = v_target.category_id;
        IF v_target.cancelled_at IS NOT NULL
           OR v_dir IS DISTINCT FROM 'out'
           OR EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = v_target.id)
           OR v_amount > v_target.amount_cents - public.fin__paid(v_target.id) THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Açık borcu ve kalan tutarı kontrol edin. Fazla ödeme eşleştirilemez.', 'P0001', v_detail);
        END IF;
        IF EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.id = v_m_payment) THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.', 'PT409', v_detail);
        END IF;
      END IF;

      PERFORM public.fin__check_account(v_clinic, v_account);
      IF v_kind <> 'clinic_excel' THEN
        SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = v_account;
        IF v_acc.kind NOT IN ('bank', 'pos') THEN
          PERFORM public.fin__row_raise(v_ctx,
            'banka satırı yalnızca banka veya POS türündeki bir hesaba işlenebilir. Hiçbir kayıt aktarılmadı.',
            'P0001', v_detail);
        END IF;
      END IF;

      -- Step 5: warnings re-detected now (C9); each must be acknowledged for this row.
      v_codes := ARRAY[]::text[];
      IF EXISTS (
        SELECT 1
        FROM public.fin_payments p
        JOIN public.fin_entries e ON e.clinic_id = p.clinic_id AND e.id = p.entry_id
        WHERE p.clinic_id = v_clinic
          AND p.voided_at IS NULL
          AND p.paid_on = v_date
          AND p.amount_cents = v_amount
          AND e.source_key IS DISTINCT FROM v_key
          AND p.bank_source_key IS DISTINCT FROM v_key
          AND NOT (p.id = ANY (v_new_payments))
      ) THEN
        v_codes := array_append(v_codes, 'possible_duplicate');
      END IF;
      IF v_is_batch_dup THEN
        v_codes := array_append(v_codes, 'batch_duplicate');
      END IF;
      IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND v_manual_n > 0 THEN
        v_codes := array_append(v_codes, 'manual_receipt_overlap');
      END IF;
      FOREACH v_code IN ARRAY v_codes
      LOOP
        IF NOT (v_code = ANY (v_ack_codes)) THEN
          PERFORM public.fin__row_raise(v_ctx,
            CASE v_code
              WHEN 'possible_duplicate' THEN 'Mevcut kayıtta aynı tarih ve tutar var'
              WHEN 'batch_duplicate' THEN 'Bu aktarımda aynı tarih ve tutarda başka bir satır var'
              ELSE 'Bu ay elle girilmiş tahsilatlar var. Tam dönem toplamları eşleşirse Excel esas alınır'
            END || '. Uyarıyı onaylayın veya satırı seçimden çıkarın. Hiçbir kayıt aktarılmadı.',
            'PT409', v_detail || jsonb_build_object('warning', v_code));
        END IF;
      END LOOP;
      IF cardinality(v_codes) > 0 THEN
        v_ack := v_ack + 1;
      END IF;

      -- Steps 6-7: write.
      IF v_is_match THEN
        INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, bank_source_key,
                                         bank_source_file, bank_source_description, recorded_by, updated_by)
        VALUES (v_m_payment, v_clinic, v_m_entry, v_date, v_amount, v_account, v_key, v_file, left(v_desc, 1000),
                v_user, v_user);
        PERFORM public.fin__bump_entry(v_clinic, v_m_entry);
        v_res_entry := v_m_entry;
        v_res_payment := v_m_payment;
        v_status := 'matched';
      ELSE
        INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                        description, due_date, amount_cents, entitlement_month, source_key,
                                        source_fingerprint, source_file, created_by, updated_by)
        VALUES (v_entry_id, v_clinic, v_in.o_category_id, v_in.o_subcategory, v_in.o_counterparty_id,
                v_in.o_counterparty_text, v_in.o_description, v_in.o_due_date, v_in.o_amount_cents,
                v_in.o_entitlement_month, v_key, v_fp, v_file, v_user, v_user);
        -- Imported rows are saved as paid in full on the row date (C16; IP:54 paid = amount).
        INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, recorded_by,
                                         updated_by)
        VALUES (v_entry_id, v_clinic, v_entry_id, v_date, v_amount, v_account, v_user, v_user);
        v_res_entry := v_entry_id;
        v_res_payment := v_entry_id;
        v_status := 'inserted';
        IF v_bucket = 'patient_receipts' THEN
          v_any_receipts := true;
        END IF;
      END IF;

      IF v_rebind THEN
        UPDATE public.fin_import_sources s
        SET link_kind = CASE WHEN v_is_match THEN 'payment_match' ELSE 'entry' END,
            entry_id = v_res_entry,
            payment_id = v_res_payment,
            fingerprint = CASE WHEN v_is_match THEN NULL ELSE v_fp END,
            file_name = v_file,
            batch_id = v_batch_id,
            txn_date = v_date,
            amount_cents = v_amount,
            rebind_count = s.rebind_count + 1,
            rebound_at = now(),
            rebound_by = v_user
        WHERE s.id = v_src.id;
      ELSE
        INSERT INTO public.fin_import_sources (clinic_id, source_key, source_kind, link_kind, fingerprint, file_name,
                                               entry_id, payment_id, batch_id, txn_date, amount_cents, origin,
                                               imported_by)
        VALUES (v_clinic, v_key, v_kind, CASE WHEN v_is_match THEN 'payment_match' ELSE 'entry' END,
                CASE WHEN v_is_match THEN NULL ELSE v_fp END, v_file, v_res_entry, v_res_payment, v_batch_id, v_date,
                v_amount, 'runtime', v_user);
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF coalesce(v_constraint, '') LIKE 'fin\_payments%' THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.', 'PT409', v_detail);
        END IF;
        PERFORM public.fin__row_raise(v_ctx, 'Kayıt kaydedilemedi. Hiçbir kayıt aktarılmadı.', 'PT409', v_detail);
      WHEN raise_exception THEN
        -- Messages of this RPC already carry the row context; shared 0020 helpers (fin__entry_input,
        -- fin__check_account, guard triggers) get it here, with the same SQLSTATE.
        IF left(SQLERRM, char_length(v_ctx) + 1) = v_ctx || ':' OR SQLERRM LIKE 'Aynı borca bu aktarımda%' THEN
          RAISE;
        END IF;
        PERFORM public.fin__row_raise(v_ctx, SQLERRM || ' Hiçbir kayıt aktarılmadı.', 'P0001', v_detail);
    END;

    v_new_payments := array_append(v_new_payments, v_res_payment);
    IF v_status = 'matched' THEN
      v_matched := v_matched + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row_no', v_row_no, 'key', v_key, 'status', v_status, 'entry_id', v_res_entry, 'payment_id', v_res_payment));
  END LOOP;

  -- Step 8: receipt reconciliation of the batch month (restores fin.ctx to 'import' when it returns).
  IF v_any_receipts THEN
    v_rec := public.fin__reconcile_receipts_month(v_clinic, v_month);
    v_rec_out := jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM'),
      'equivalent', v_rec -> 'equivalent',
      'through', v_rec -> 'through',
      'excluded_count', jsonb_array_length(v_rec -> 'excluded_ids'),
      'manual_total_cents', v_rec -> 'manual_total_cents',
      'imported_total_cents', v_rec -> 'imported_total_cents');
  END IF;

  -- Step 9: the batch row (the deferred FK of fin_import_sources.batch_id is satisfied at commit).
  v_result := jsonb_build_object(
    'inserted', v_inserted,
    'matched', v_matched,
    'skipped', v_skipped,
    'acknowledged', v_ack,
    'rows', v_results,
    'reconciliation', v_rec_out);
  BEGIN
    INSERT INTO public.fin_import_batches (id, clinic_id, kind, month, file_names, layout_ids, rows_sent, inserted,
                                           matched, skipped, acknowledged, result, created_by)
    VALUES (v_batch_id, v_clinic, 'rows', v_month, v_files, v_layouts, v_rows_n, v_inserted, v_matched, v_skipped,
            v_ack, v_result, v_user);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Aktarım kaydedilemedi.' USING ERRCODE = 'PT409';
  END;

  RETURN v_result || jsonb_build_object('already_saved', false,
                                        'batch', public.fin__batch_json(v_clinic, v_batch_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.8 fin_receipt_reconciliation (read): banner / PDF warning (legacy FP:64).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_receipt_reconciliation(p_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_m0 date;
  v_m1 date;
  v_r jsonb;
  v_applied uuid[];
  v_excluded uuid[];
  v_like text;
BEGIN
  v_m0 := public.fin__report_month(p_month, v_today);
  v_m1 := (v_m0 + interval '1 month')::date;
  v_like := 'clinic:' || to_char(v_m0, 'YYYY-MM') || '-%:receipts';
  v_r := public.fin__receipt_reconciliation(v_clinic, v_m0);

  SELECT coalesce(array_agg(e.id ORDER BY e.id), ARRAY[]::uuid[]) INTO v_applied
  FROM public.fin_entries e
  WHERE e.clinic_id = v_clinic AND e.reconciled_month = v_m0;
  SELECT coalesce(array_agg(x.v::uuid ORDER BY x.v::uuid), ARRAY[]::uuid[]) INTO v_excluded
  FROM jsonb_array_elements_text(v_r -> 'excluded_ids') AS x(v);

  RETURN v_r || jsonb_build_object(
    'applied_ids', to_jsonb(v_applied),
    'in_sync', v_applied = v_excluded,
    'manual_entries', coalesce((
      SELECT jsonb_agg(m.obj ORDER BY m.due_date, m.id)
      FROM (
        SELECT e.id, e.due_date,
               jsonb_build_object(
                 'id', e.id,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'due_date', e.due_date,
                 'paid_cents', pm.paid,
                 'is_cancelled', e.cancelled_at IS NOT NULL,
                 'excluded_from_totals', e.excluded_from_totals,
                 'exclusion_source', e.exclusion_source) AS obj
        FROM public.fin_entries e
        JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        CROSS JOIN LATERAL (
          SELECT sum(p.amount_cents)::bigint AS paid
          FROM public.fin_payments p
          WHERE p.entry_id = e.id AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1
        ) pm
        WHERE e.clinic_id = v_clinic AND c.report_bucket = 'patient_receipts' AND e.source_key IS NULL
          AND pm.paid IS NOT NULL
        ORDER BY e.due_date, e.id
        LIMIT 200
      ) m), '[]'::jsonb),
    'imported_entries', coalesce((
      SELECT jsonb_agg(m.obj ORDER BY m.due_date, m.id)
      FROM (
        SELECT e.id, e.due_date,
               jsonb_build_object(
                 'id', e.id,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'due_date', e.due_date,
                 'paid_cents', pm.paid,
                 'is_cancelled', e.cancelled_at IS NOT NULL,
                 'excluded_from_totals', e.excluded_from_totals,
                 'exclusion_source', e.exclusion_source) AS obj
        FROM public.fin_entries e
        JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        CROSS JOIN LATERAL (
          SELECT sum(p.amount_cents)::bigint AS paid
          FROM public.fin_payments p
          WHERE p.entry_id = e.id AND p.voided_at IS NULL AND p.paid_on >= v_m0 AND p.paid_on < v_m1
        ) pm
        WHERE e.clinic_id = v_clinic AND c.report_bucket = 'patient_receipts' AND e.source_key LIKE v_like
          AND pm.paid IS NOT NULL
        ORDER BY e.due_date, e.id
        LIMIT 200
      ) m), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.9 fin_import_balances (write): balances read from files (PDF headers, statement headers, workbook KASA cells),
--     mapped by import key and merged through the 0020 merge (every C17 rule lives there). p_dry_run previews.
--     Items: { kind: 'bank'|'cash', import_key, amount_cents, as_of, label, file_name, note }.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_balances(
  p_sources jsonb,
  p_base_updated_at timestamptz,
  p_initialize_banks boolean,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date;
  v_snap public.fin_balance_snapshots%ROWTYPE;
  v_has boolean;
  v_item jsonb;
  v_kind text;
  v_key text;
  v_label text;
  v_file text;
  v_acc public.fin_accounts%ROWTYPE;
  v_items jsonb := '[]'::jsonb;
  v_mapped jsonb := '[]'::jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_balance:' || v_clinic::text, 0));
  v_today := public.clinic_today();

  -- Base check (RT:97): the current snapshot as the client read it, by its exact updated_at.
  SELECT * INTO v_snap
  FROM public.fin_balance_snapshots s
  WHERE s.clinic_id = v_clinic AND s.day <= v_today
  ORDER BY s.day DESC
  LIMIT 1;
  v_has := FOUND;
  IF (v_has AND p_base_updated_at IS DISTINCT FROM v_snap.updated_at)
     OR (NOT v_has AND p_base_updated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Bakiye başka bir ekranda değişti. Listeyi yenileyip önizlemeyi kontrol edin.' USING ERRCODE = 'PT409';
  END IF;

  IF p_sources IS NULL OR jsonb_typeof(p_sources) <> 'array' THEN
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
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) AS k(name)
               WHERE k.name NOT IN ('kind', 'import_key', 'amount_cents', 'as_of', 'label', 'file_name', 'note')) THEN
      RAISE EXCEPTION 'Bakiye satırı geçersiz.';
    END IF;
    v_kind := public.fin__json_text(v_item -> 'kind');
    v_key := public.fin__json_text(v_item -> 'import_key');
    v_label := nullif(btrim(coalesce(public.fin__json_text(v_item -> 'label'), '')), '');
    v_file := nullif(btrim(coalesce(public.fin__json_text(v_item -> 'file_name'), '')), '');
    IF v_kind IS NULL OR v_kind NOT IN ('bank', 'cash') THEN
      RAISE EXCEPTION 'Geçersiz tür.';
    END IF;
    IF v_file IS NULL THEN
      RAISE EXCEPTION 'Dosyadan okunan bakiyede dosya adı eksik.';
    END IF;

    IF v_kind = 'bank' THEN
      SELECT * INTO v_acc
      FROM public.fin_accounts a
      WHERE a.clinic_id = v_clinic AND a.import_key = v_key AND a.is_active AND a.kind IN ('bank', 'pos');
      IF NOT FOUND THEN
        RAISE EXCEPTION '%: bu dosyanın hesabı bir finans hesabıyla eşleşmemiş. Ayarlar > Hesaplar bölümünden içe aktarma anahtarını tanımlayın.',
          coalesce(v_label, v_key, 'Banka');
      END IF;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kind', 'bank', 'account_id', v_acc.id, 'amount_cents', v_item -> 'amount_cents',
        'as_of', v_item -> 'as_of', 'label', v_label, 'file_name', v_file, 'note', v_item -> 'note'));
      v_mapped := v_mapped || jsonb_build_array(jsonb_build_object(
        'import_key', v_key, 'account_id', v_acc.id, 'account_name', v_acc.name));
    ELSE
      IF v_key IS DISTINCT FROM 'clinic-cash' THEN
        RAISE EXCEPTION 'Kasa bilgisi geçersiz.';
      END IF;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kind', 'cash', 'account_id', NULL::uuid, 'amount_cents', v_item -> 'amount_cents',
        'as_of', v_item -> 'as_of', 'label', v_label, 'file_name', v_file, 'note', v_item -> 'note'));
    END IF;
  END LOOP;

  v_result := public.fin_merge_balance_sources(
    CASE WHEN v_has THEN v_snap.id END,
    CASE WHEN v_has THEN v_snap.version ELSE 0 END,
    v_items,
    coalesce(p_initialize_banks, false),
    coalesce(p_dry_run, false));

  RETURN v_result || jsonb_build_object('mapped', v_mapped);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.10 Patient financing (Phase 4; legacy RT:56-74, RT:122-125, BF, BG). Every financing write runs with
--      fin.ctx = 'financing' so the lock triggers let it touch the fee entry and its payment.
-- ---------------------------------------------------------------------------

-- Fee entry description (RT:70; amounts formatted like JS b.commission/100: '1.5', '1000', '0.05'). The patient
-- name is NOT copied into the ledger (it would reach the accountant CSV, the full PDF and every entry screen); it
-- stays in fin_patient_financing and is shown through the financing screens only. The loan key in the reference is
-- all the reverse guard needs.
DROP FUNCTION IF EXISTS public.fin__financing_description(text, text, bigint, bigint, bigint);
CREATE OR REPLACE FUNCTION public.fin__financing_description(
  p_reference text, p_commission bigint, p_kkdf bigint, p_bsmv bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'Hasta finansmanı kesintileri · ' || p_reference
      || ' · Komisyon ' || pg_catalog.trim_scale(p_commission::numeric / 100)::text
      || ' TL, KKDF ' || pg_catalog.trim_scale(p_kkdf::numeric / 100)::text
      || ' TL, BSMV ' || pg_catalog.trim_scale(p_bsmv::numeric / 100)::text
      || ' TL. Brüt tahsilat klinik Excel’inde.'
$$;

-- Coverage rule (RT:66-68, C7): the day's receipts row of the configured source (exact key, non-cancelled,
-- patient_receipts bucket, live payments) must cover p_needed. Manual receipts never count.
CREATE OR REPLACE FUNCTION public.fin__financing_coverage(p_clinic uuid, p_day date, p_needed bigint)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_source text;
  v_key text;
  v_covered bigint;
BEGIN
  SELECT s.financing_receipts_source INTO v_source FROM public.fin_settings s WHERE s.clinic_id = p_clinic;
  v_key := public.fin__receipts_key(CASE WHEN v_source = 'dentos_payments' THEN 'dentos' ELSE 'clinic' END, p_day);

  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_covered
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.entry_id = e.id AND p.voided_at IS NULL
  WHERE e.clinic_id = p_clinic
    AND e.source_key = v_key
    AND e.cancelled_at IS NULL
    AND c.report_bucket = 'patient_receipts';

  IF v_covered < coalesce(p_needed, 0) THEN
    IF v_source = 'dentos_payments' THEN
      RAISE EXCEPTION '%: DentOS günlük tahsilatı eksik veya finansman toplamından düşük.', public.fin__iso_date(p_day)
        USING ERRCODE = 'PT409';
    END IF;
    RAISE EXCEPTION '%: klinik Excel günlük tahsilatı eksik veya finansman toplamından düşük. Önce güncel klinik Excel’ini aktarın.',
      public.fin__iso_date(p_day) USING ERRCODE = 'PT409';
  END IF;
END;
$$;

-- 4.10.1 Upload of financing statement lines (legacy financing import, RT:56-74). Items:
--   { id, entry_id, provider, reference, patient_name_raw, txn_date, currency, gross_cents, commission_cents,
--     kkdf_cents, bsmv_cents, blocked, expected_release, file }
-- The reference is normalised to '<branch>-<loan>-1' (BF:22); the key is '<provider>-finance:<ref>:<date>'.
CREATE OR REPLACE FUNCTION public.fin_financing_import(p_batch_id uuid, p_items jsonb, p_gross_confirmed boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_today date;
  v_owner uuid;
  v_stored jsonb;
  v_s public.fin_settings%ROWTYPE;
  v_fee_category uuid;
  v_fee_active boolean;
  v_n integer;
  v_raw jsonb;
  v_items jsonb := '[]'::jsonb;
  v_keys text[] := ARRAY[]::text[];
  v_files text[] := ARRAY[]::text[];
  v_ids uuid[] := ARRAY[]::uuid[];
  v_it jsonb;
  v_id uuid;
  v_entry_id uuid;
  v_provider text;
  v_reference text;
  v_name text;
  v_date date;
  v_gross bigint;
  v_comm bigint;
  v_kkdf bigint;
  v_bsmv bigint;
  v_blocked boolean;
  v_expected date;
  v_file text;
  v_key text;
  v_loan text;
  v_f public.fin_patient_financing%ROWTYPE;
  v_needed bigint;
  v_added integer := 0;
  v_skipped integer := 0;
  v_result jsonb;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_import:' || v_clinic::text, 0));
  v_today := public.clinic_today();
  PERFORM public.fin__set_ctx('financing');

  SELECT b.clinic_id, b.result INTO v_owner, v_stored FROM public.fin_import_batches b WHERE b.id = p_batch_id;
  IF v_owner IS NOT NULL THEN
    IF v_owner = v_clinic THEN
      RETURN v_stored || jsonb_build_object(
        'already_saved', true,
        'batch', public.fin__batch_json(v_clinic, p_batch_id),
        'items', coalesce((
          SELECT jsonb_agg(public.fin__financing_json(v_clinic, x.v::uuid, v_today) ORDER BY x.o)
          FROM jsonb_array_elements_text(coalesce(v_stored -> 'item_ids', '[]'::jsonb)) WITH ORDINALITY AS x(v, o)),
          '[]'::jsonb));
    END IF;
    RAISE EXCEPTION 'Aktarım kaydedilemedi.' USING ERRCODE = 'PT409';
  END IF;

  IF p_gross_confirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Brüt tutarların klinik Excel’inde olduğunu onaylayın.';
  END IF;

  -- Settings replace the legacy literals (provider counterparty text and account 'Banka', RT:70).
  SELECT * INTO v_s FROM public.fin_settings s WHERE s.clinic_id = v_clinic;
  IF v_s.id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.fin_counterparties cp
                    WHERE cp.clinic_id = v_clinic AND cp.id = v_s.financing_counterparty_id AND cp.is_active)
     OR NOT EXISTS (SELECT 1 FROM public.fin_accounts a
                    WHERE a.clinic_id = v_clinic AND a.id = v_s.financing_account_id AND a.is_active
                      AND a.kind IN ('bank', 'pos')) THEN
    RAISE EXCEPTION 'Hasta finansmanı ayarları eksik: banka kişi / kurum kaydını ve ödeme hesabını seçin.';
  END IF;
  IF v_s.financing_receipts_source <> 'clinic_excel' THEN
    RAISE EXCEPTION 'DentOS tahsilat kaynağı, hasta tahsilatları modülüyle (Faz 5) açılacak.';
  END IF;
  SELECT c.id, c.is_active INTO v_fee_category, v_fee_active
  FROM public.fin_categories c
  WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'fees';
  IF v_fee_category IS NULL OR NOT v_fee_active THEN
    RAISE EXCEPTION 'Faiz / banka masrafı sistem kategorisi bulunamadı veya pasif.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Bir seferde en az 1, en fazla 40 finansman aktarılabilir.';
  END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'Bir seferde en az 1, en fazla 40 finansman aktarılabilir.';
  END IF;

  -- Pass 1: shape of every item (BF:6, BF:18, BF:19, RT:16, RT:60, RT:61).
  FOR v_raw IN SELECT x.value FROM jsonb_array_elements(p_items) AS x(value)
  LOOP
    IF jsonb_typeof(v_raw) <> 'object' THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_raw) AS k(name)
      WHERE k.name NOT IN ('id', 'entry_id', 'provider', 'reference', 'patient_name_raw', 'txn_date', 'currency',
                           'gross_cents', 'commission_cents', 'kkdf_cents', 'bsmv_cents', 'blocked',
                           'expected_release', 'file')
    ) THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    v_id := public.fin__json_uuid(v_raw -> 'id');
    v_entry_id := public.fin__json_uuid(v_raw -> 'entry_id');
    IF v_id IS NULL OR v_entry_id IS NULL OR jsonb_typeof(v_raw -> 'blocked') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;

    IF public.fin__json_text(v_raw -> 'currency') IS DISTINCT FROM 'TRY' THEN
      RAISE EXCEPTION 'Yalnızca TL finansman aktarılabilir.';
    END IF;
    v_date := public.fin__parse_day(public.fin__json_text(v_raw -> 'txn_date'));
    IF v_date IS NULL THEN
      RAISE EXCEPTION 'Geçersiz tarih.';
    END IF;
    IF v_date > v_today THEN
      RAISE EXCEPTION 'İşlem tarihi gelecekte olamaz. Çözülme ayrı doğrulanır.';
    END IF;

    v_provider := public.fin__json_text(v_raw -> 'provider');
    v_reference := public.fin__json_text(v_raw -> 'reference');
    -- The provider is a server-side allow-list (the table CHECK too): a client-chosen namespace would let the same
    -- loan and day be imported twice under two keys.
    IF v_provider IS DISTINCT FROM 'burgan'
       OR coalesce(v_reference, '') !~ '^\d{1,10}-\d{7,20}-\d{1,10}$' THEN
      RAISE EXCEPTION 'Finansman referansı geçersiz.';
    END IF;
    v_reference := public.fin__loan_key(v_reference) || '-1';

    v_name := btrim(coalesce(public.fin__json_text(v_raw -> 'patient_name_raw'), ''));
    IF char_length(v_name) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Hasta adı 1-200 karakter olmalı.';
    END IF;

    v_gross := public.fin__json_int(v_raw -> 'gross_cents', 1, 1000000000000);
    IF v_gross IS NULL THEN
      RAISE EXCEPTION 'Tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
    END IF;
    v_comm := public.fin__json_int(v_raw -> 'commission_cents', 0, 1000000000000);
    v_kkdf := public.fin__json_int(v_raw -> 'kkdf_cents', 0, 1000000000000);
    v_bsmv := public.fin__json_int(v_raw -> 'bsmv_cents', 0, 1000000000000);
    IF v_comm IS NULL OR v_kkdf IS NULL OR v_bsmv IS NULL
       OR v_comm + v_kkdf + v_bsmv <= 0 OR v_comm + v_kkdf + v_bsmv >= v_gross THEN
      RAISE EXCEPTION 'Kesintileri kontrol edin.';
    END IF;

    v_blocked := (v_raw -> 'blocked')::boolean;
    v_expected := NULL;
    IF v_blocked THEN
      v_expected := public.fin__parse_day(public.fin__json_text(v_raw -> 'expected_release'));
      IF v_expected IS NULL THEN
        RAISE EXCEPTION 'Bloke için tahmini çözülme tarihi gerekli.';
      END IF;
      IF v_expected < v_date THEN
        RAISE EXCEPTION 'Bloke tarihi işlemden önce olamaz.';
      END IF;
    END IF;

    v_file := NULL;
    IF coalesce(jsonb_typeof(v_raw -> 'file'), 'null') <> 'null' THEN
      v_file := public.fin__json_text(v_raw -> 'file');
      IF v_file IS NULL OR char_length(v_file) > 200 THEN
        RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
      END IF;
      v_file := nullif(btrim(v_file), '');
    END IF;

    v_key := v_provider || '-finance:' || v_reference || ':' || public.fin__iso_date(v_date);
    -- Ids are the deterministic ones (keys.ts financingRowId / importedEntryId), never the client's choice.
    IF v_id IS DISTINCT FROM public.fin__import_id(v_clinic, 'financing|' || v_key)
       OR v_entry_id IS DISTINCT FROM public.fin__import_id(v_clinic, v_key) THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    IF v_key = ANY (v_keys) THEN
      RAISE EXCEPTION 'Tekrarlanan finansman seçildi.';
    END IF;
    v_keys := array_append(v_keys, v_key);
    IF v_file IS NOT NULL AND NOT (v_file = ANY (v_files)) THEN
      v_files := array_append(v_files, v_file);
    END IF;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', v_id, 'entry_id', v_entry_id, 'provider', v_provider, 'reference', v_reference, 'name', v_name,
      'date', v_date, 'gross', v_gross, 'commission', v_comm, 'kkdf', v_kkdf, 'bsmv', v_bsmv,
      'blocked', v_blocked, 'expected', v_expected, 'file', v_file, 'key', v_key));
  END LOOP;

  -- Pass 2: per item, in order (RT:62-70).
  FOR v_it IN SELECT x.value FROM jsonb_array_elements(v_items) AS x(value)
  LOOP
    v_id := (v_it ->> 'id')::uuid;
    v_entry_id := (v_it ->> 'entry_id')::uuid;
    v_provider := v_it ->> 'provider';
    v_reference := v_it ->> 'reference';
    v_name := v_it ->> 'name';
    v_date := (v_it ->> 'date')::date;
    v_gross := (v_it ->> 'gross')::bigint;
    v_comm := (v_it ->> 'commission')::bigint;
    v_kkdf := (v_it ->> 'kkdf')::bigint;
    v_bsmv := (v_it ->> 'bsmv')::bigint;
    v_blocked := (v_it ->> 'blocked')::boolean;
    v_expected := (v_it ->> 'expected')::date;
    v_file := v_it ->> 'file';
    v_key := v_it ->> 'key';
    v_loan := public.fin__loan_key(v_reference);

    -- Existing key (RT:62-63): a voided row keeps its key forever; equal amounts are skipped. Looked up by loan and
    -- day (the unique identity, fin_patient_financing_loan_day_key), which is the key for the one allowed provider.
    SELECT * INTO v_f FROM public.fin_patient_financing f
    WHERE f.clinic_id = v_clinic AND f.loan_key = v_loan AND f.txn_date = v_date;
    IF FOUND THEN
      IF v_f.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'Bu finansman daha önce iptal edildi; yeniden aktarılamaz.'
          USING ERRCODE = 'PT409', DETAIL = v_f.id::text;
      END IF;
      IF (v_f.gross_cents, v_f.commission_cents, v_f.kkdf_cents, v_f.bsmv_cents) = (v_gross, v_comm, v_kkdf, v_bsmv) THEN
        v_skipped := v_skipped + 1;
        v_ids := array_append(v_ids, v_f.id);
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'Önceden aktarılan finansmanın tutarı değişmiş. Yeni kayıt eklenmedi.'
        USING ERRCODE = 'PT409', DETAIL = v_f.id::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.fin_import_sources s WHERE s.clinic_id = v_clinic AND s.source_key = v_key)
       OR EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.id = v_id)
       OR EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_entry_id)
       OR EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.id = v_entry_id) THEN
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;

    -- Reverse guard (RT:65, C7): the loan's lines were already booked by a general bank import or a bank match.
    IF EXISTS (
         SELECT 1 FROM public.fin_entries e
         WHERE e.clinic_id = v_clinic
           AND strpos(e.description, v_loan) > 0
           AND NOT EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = e.id)
           AND EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.entry_id = e.id AND p.voided_at IS NULL))
       OR EXISTS (
         SELECT 1 FROM public.fin_payments p
         WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND strpos(p.bank_source_description, v_loan) > 0) THEN
      RAISE EXCEPTION 'Bu finansmana ait hareketler daha önce genel banka aktarımında kaydedilmiş. Çift sayımı önlemek için aktarım durduruldu: %',
        v_reference USING ERRCODE = 'PT409';
    END IF;

    -- Coverage, cumulative per day (RT:66-68): every request item of the day (skipped ones included) plus the
    -- live rows of the day that are not request items (by their key, i.e. the row itself; the loan/day index makes
    -- the key the row's identity).
    SELECT coalesce(sum((x.value ->> 'gross')::bigint), 0)::bigint INTO v_needed
    FROM jsonb_array_elements(v_items) AS x(value)
    WHERE (x.value ->> 'date')::date = v_date;
    v_needed := v_needed + coalesce((
      SELECT sum(f.gross_cents)::bigint
      FROM public.fin_patient_financing f
      WHERE f.clinic_id = v_clinic AND f.txn_date = v_date AND f.voided_at IS NULL
        AND NOT (f.source_key = ANY (v_keys))), 0);
    PERFORM public.fin__financing_coverage(v_clinic, v_date, v_needed);

    -- Write: realized fee entry + payment, the financing row, the key. The gross is never written (TB:9).
    BEGIN
      INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                      description, due_date, amount_cents, source_key, source_file,
                                      created_by, updated_by)
      VALUES (v_entry_id, v_clinic, v_fee_category, NULL, v_s.financing_counterparty_id, NULL,
              public.fin__financing_description(v_reference, v_comm, v_kkdf, v_bsmv),
              v_date, v_comm + v_kkdf + v_bsmv, v_key, v_file, v_user, v_user);
      INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, recorded_by,
                                       updated_by)
      VALUES (v_entry_id, v_clinic, v_entry_id, v_date, v_comm + v_kkdf + v_bsmv, v_s.financing_account_id,
              v_user, v_user);
      INSERT INTO public.fin_patient_financing (id, clinic_id, provider, reference, patient_name_raw, txn_date,
                                                currency, gross_cents, commission_cents, kkdf_cents, bsmv_cents,
                                                blocked, expected_release, source_file, entry_id,
                                                created_by, updated_by)
      VALUES (v_id, v_clinic, v_provider, v_reference, v_name, v_date, 'TRY', v_gross, v_comm, v_kkdf, v_bsmv,
              v_blocked, v_expected, v_file, v_entry_id, v_user, v_user);
      INSERT INTO public.fin_import_sources (clinic_id, source_key, source_kind, link_kind, fingerprint, file_name,
                                             entry_id, payment_id, batch_id, txn_date, amount_cents, origin,
                                             imported_by)
      VALUES (v_clinic, v_key, 'financing', 'entry', NULL, v_file, v_entry_id, v_entry_id, p_batch_id, v_date,
              v_comm + v_kkdf + v_bsmv, 'runtime', v_user);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END;
    v_added := v_added + 1;
    v_ids := array_append(v_ids, v_id);
  END LOOP;

  v_result := jsonb_build_object('added', v_added, 'skipped', v_skipped, 'item_ids', to_jsonb(v_ids));
  BEGIN
    INSERT INTO public.fin_import_batches (id, clinic_id, kind, month, file_names, layout_ids, rows_sent, inserted,
                                           matched, skipped, acknowledged, result, created_by)
    VALUES (p_batch_id, v_clinic, 'financing', NULL, v_files, ARRAY[]::uuid[], v_n, v_added, 0, v_skipped, 0,
            v_result, v_user);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Aktarım kaydedilemedi.' USING ERRCODE = 'PT409';
  END;

  RETURN v_result || jsonb_build_object(
    'already_saved', false,
    'batch', public.fin__batch_json(v_clinic, p_batch_id),
    'items', coalesce((
      SELECT jsonb_agg(public.fin__financing_json(v_clinic, x.id, v_today) ORDER BY x.o)
      FROM unnest(v_ids) WITH ORDINALITY AS x(id, o)), '[]'::jsonb));
END;
$$;

-- 4.10.2 Release of a blocked net amount (legacy release action, RT:122-124). No payment and no income are written.
CREATE OR REPLACE FUNCTION public.fin_financing_release(p_id uuid, p_version integer, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date := public.clinic_today();
  v_f public.fin_patient_financing%ROWTYPE;
BEGIN
  SELECT * INTO v_f FROM public.fin_patient_financing f WHERE f.clinic_id = v_clinic AND f.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_f.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş finansman değiştirilemez.';
  END IF;
  IF p_date IS NOT NULL AND v_f.released_on = p_date THEN
    RETURN public.fin__financing_envelope(v_clinic, p_id, true);
  END IF;
  IF p_version IS DISTINCT FROM v_f.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_date IS NULL OR NOT v_f.blocked OR v_f.released_on IS NOT NULL OR p_date > v_today OR p_date < v_f.txn_date THEN
    RAISE EXCEPTION 'Bloke kaydını ve çözülme tarihini kontrol edin.';
  END IF;

  PERFORM public.fin__set_ctx('financing');
  UPDATE public.fin_patient_financing f
  SET released_on = p_date, released_at = now(), released_by = public.current_app_user_id()
  WHERE f.id = p_id;

  RETURN public.fin__financing_envelope(v_clinic, p_id, false);
END;
$$;

-- 4.10.3 Correction path (new; legacy locked the fee entry with no way out, C7). Replaces every editable value;
-- the fee entry and its single payment follow the new fee, in an order that keeps paid <= amount at every step.
CREATE OR REPLACE FUNCTION public.fin_financing_correct(
  p_id uuid,
  p_version integer,
  p_gross_cents bigint,
  p_commission_cents bigint,
  p_kkdf_cents bigint,
  p_bsmv_cents bigint,
  p_blocked boolean,
  p_expected_release date,
  p_released_on date,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_today date;
  v_f public.fin_patient_financing%ROWTYPE;
  v_e public.fin_entries%ROWTYPE;
  v_blocked boolean := p_blocked;
  v_expected date;
  v_reason text;
  v_old_fee bigint;
  v_new_fee bigint;
  v_desc text;
  v_needed bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_import:' || v_clinic::text, 0));
  v_today := public.clinic_today();

  SELECT * INTO v_f FROM public.fin_patient_financing f WHERE f.clinic_id = v_clinic AND f.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_f.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş finansman değiştirilemez.';
  END IF;
  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = v_f.entry_id FOR UPDATE;

  IF v_blocked IS NULL THEN
    RAISE EXCEPTION 'Geçersiz değer.';
  END IF;
  v_expected := CASE WHEN v_blocked THEN p_expected_release END;

  IF (v_f.gross_cents, v_f.commission_cents, v_f.kkdf_cents, v_f.bsmv_cents, v_f.blocked, v_f.expected_release,
      v_f.released_on)
     IS NOT DISTINCT FROM
     (p_gross_cents, p_commission_cents, p_kkdf_cents, p_bsmv_cents, v_blocked, v_expected, p_released_on) THEN
    RETURN public.fin__financing_envelope(v_clinic, p_id, true);
  END IF;
  IF p_version IS DISTINCT FROM v_f.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);

  PERFORM public.fin__amount(p_gross_cents);
  IF p_commission_cents IS NULL OR p_kkdf_cents IS NULL OR p_bsmv_cents IS NULL
     OR p_commission_cents NOT BETWEEN 0 AND 1000000000000
     OR p_kkdf_cents NOT BETWEEN 0 AND 1000000000000
     OR p_bsmv_cents NOT BETWEEN 0 AND 1000000000000 THEN
    RAISE EXCEPTION 'Kesintileri kontrol edin.';
  END IF;
  v_new_fee := p_commission_cents + p_kkdf_cents + p_bsmv_cents;
  IF v_new_fee <= 0 OR v_new_fee >= p_gross_cents THEN
    RAISE EXCEPTION 'Kesintileri kontrol edin.';
  END IF;
  IF v_blocked AND v_expected IS NULL THEN
    RAISE EXCEPTION 'Bloke için tahmini çözülme tarihi gerekli.';
  END IF;
  IF v_blocked AND v_expected < v_f.txn_date THEN
    RAISE EXCEPTION 'Bloke tarihi işlemden önce olamaz.';
  END IF;
  IF p_released_on IS NOT NULL
     AND (NOT v_blocked OR p_released_on < v_f.txn_date OR p_released_on > v_today) THEN
    RAISE EXCEPTION 'Bloke kaydını ve çözülme tarihini kontrol edin.';
  END IF;

  -- A larger gross must still be covered by that day's receipts (with every other live row of the day).
  IF p_gross_cents > v_f.gross_cents THEN
    SELECT coalesce(sum(f.gross_cents), 0)::bigint INTO v_needed
    FROM public.fin_patient_financing f
    WHERE f.clinic_id = v_clinic AND f.txn_date = v_f.txn_date AND f.voided_at IS NULL AND f.id <> v_f.id;
    PERFORM public.fin__financing_coverage(v_clinic, v_f.txn_date, v_needed + p_gross_cents);
  END IF;

  PERFORM public.fin__set_ctx('financing');
  v_old_fee := v_f.commission_cents + v_f.kkdf_cents + v_f.bsmv_cents;
  v_desc := public.fin__financing_description(v_f.reference, p_commission_cents, p_kkdf_cents, p_bsmv_cents);
  IF v_new_fee < v_old_fee THEN
    UPDATE public.fin_payments p
    SET amount_cents = v_new_fee
    WHERE p.clinic_id = v_clinic AND p.entry_id = v_f.entry_id AND p.voided_at IS NULL;
    UPDATE public.fin_entries e
    SET amount_cents = v_new_fee, description = v_desc
    WHERE e.clinic_id = v_clinic AND e.id = v_f.entry_id;
  ELSIF v_new_fee > v_old_fee THEN
    UPDATE public.fin_entries e
    SET amount_cents = v_new_fee, description = v_desc
    WHERE e.clinic_id = v_clinic AND e.id = v_f.entry_id;
    UPDATE public.fin_payments p
    SET amount_cents = v_new_fee
    WHERE p.clinic_id = v_clinic AND p.entry_id = v_f.entry_id AND p.voided_at IS NULL;
  ELSIF v_desc IS DISTINCT FROM v_e.description THEN
    UPDATE public.fin_entries e
    SET description = v_desc
    WHERE e.clinic_id = v_clinic AND e.id = v_f.entry_id;
  END IF;

  UPDATE public.fin_patient_financing f
  SET gross_cents = p_gross_cents,
      commission_cents = p_commission_cents,
      kkdf_cents = p_kkdf_cents,
      bsmv_cents = p_bsmv_cents,
      blocked = v_blocked,
      expected_release = v_expected,
      released_on = p_released_on,
      released_at = CASE WHEN p_released_on IS NULL THEN NULL
                         WHEN p_released_on IS NOT DISTINCT FROM v_f.released_on THEN v_f.released_at
                         ELSE now() END,
      released_by = CASE WHEN p_released_on IS NULL THEN NULL
                         WHEN p_released_on IS NOT DISTINCT FROM v_f.released_on THEN v_f.released_by
                         ELSE v_user END,
      corrected_at = now(),
      corrected_by = v_user,
      correction_reason = v_reason
  WHERE f.id = p_id;

  RETURN public.fin__financing_envelope(v_clinic, p_id, false);
END;
$$;

-- 4.10.4 Void a line that should not have been imported: the fee payment is voided, the fee entry cancelled, the
-- row voided. Its key stays, so the line can never be imported again (E_FIN_VOIDED_KEY).
CREATE OR REPLACE FUNCTION public.fin_financing_void(p_id uuid, p_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_f public.fin_patient_financing%ROWTYPE;
  v_reason text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_import:' || v_clinic::text, 0));

  SELECT * INTO v_f FROM public.fin_patient_financing f WHERE f.clinic_id = v_clinic AND f.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_f.voided_at IS NOT NULL THEN
    RETURN public.fin__financing_envelope(v_clinic, p_id, true);
  END IF;
  IF p_version IS DISTINCT FROM v_f.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_reason := public.fin__reason(p_reason);

  PERFORM public.fin__set_ctx('financing');
  PERFORM 1 FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = v_f.entry_id FOR UPDATE;
  UPDATE public.fin_payments p
  SET voided_at = now(), voided_by = v_user, void_reason = v_reason
  WHERE p.clinic_id = v_clinic AND p.entry_id = v_f.entry_id AND p.voided_at IS NULL;
  UPDATE public.fin_entries e
  SET cancelled_at = now(), cancelled_by = v_user, cancel_reason = v_reason
  WHERE e.clinic_id = v_clinic AND e.id = v_f.entry_id AND e.cancelled_at IS NULL;
  UPDATE public.fin_patient_financing f
  SET voided_at = now(), voided_by = v_user, void_reason = v_reason
  WHERE f.id = p_id;

  RETURN public.fin__financing_envelope(v_clinic, p_id, false);
END;
$$;

-- 4.10.5 Link (or unlink with NULL) the clinic's patient record. Informational; allowed on voided rows too.
CREATE OR REPLACE FUNCTION public.fin_financing_link_patient(p_id uuid, p_version integer, p_patient_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_f public.fin_patient_financing%ROWTYPE;
BEGIN
  SELECT * INTO v_f FROM public.fin_patient_financing f WHERE f.clinic_id = v_clinic AND f.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_f.patient_id IS NOT DISTINCT FROM p_patient_id THEN
    RETURN public.fin__financing_envelope(v_clinic, p_id, true);
  END IF;
  IF p_version IS DISTINCT FROM v_f.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_patient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patients pt WHERE pt.id = p_patient_id AND pt.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hasta bulunamadı.';
  END IF;

  PERFORM public.fin__set_ctx('financing');
  UPDATE public.fin_patient_financing f SET patient_id = p_patient_id WHERE f.id = p_id;

  RETURN public.fin__financing_envelope(v_clinic, p_id, false);
END;
$$;

-- 4.10.6 Summary card / PDF block (legacy financing summary, BF:32-35). The blocked net is never liquidity (TB:9).
CREATE OR REPLACE FUNCTION public.fin_financing_summary(p_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_m0 date;
  v_m1 date;
  v_result jsonb;
BEGIN
  v_m0 := public.fin__report_month(p_month, v_today);
  v_m1 := (v_m0 + interval '1 month')::date;

  SELECT jsonb_build_object(
           'today', v_today,
           'month', to_char(v_m0, 'YYYY-MM'),
           'receipts_source', (SELECT s.financing_receipts_source FROM public.fin_settings s WHERE s.clinic_id = v_clinic),
           'gross_cents', coalesce(sum(f.gross_cents) FILTER (WHERE f.txn_date >= v_m0 AND f.txn_date < v_m1), 0)::bigint,
           'fee_cents', coalesce(sum(f.fee_cents) FILTER (WHERE f.txn_date >= v_m0 AND f.txn_date < v_m1), 0)::bigint,
           'monthly_count', count(*) FILTER (WHERE f.txn_date >= v_m0 AND f.txn_date < v_m1),
           'blocked_net_cents', coalesce(sum(f.net_cents) FILTER (
                                  WHERE f.blocked AND (f.released_on IS NULL OR f.released_on > v_today)), 0)::bigint,
           'blocked_count', count(*) FILTER (WHERE f.blocked AND (f.released_on IS NULL OR f.released_on > v_today)),
           'needs_check_count', count(*) FILTER (
                                  WHERE f.blocked AND f.released_on IS NULL AND f.expected_release <= v_today))
    INTO v_result
  FROM public.fin_patient_financing f
  WHERE f.clinic_id = v_clinic AND f.voided_at IS NULL AND f.txn_date <= v_today;

  RETURN v_result;
END;
$$;

-- 4.10.7 Financing list. Filters { month: 'YYYY-MM', status, query, patient_id }; status 'all' excludes voided.
CREATE OR REPLACE FUNCTION public.fin_financing_list(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_month date;
  v_m1 date;
  v_status text;
  v_query text;
  v_patient uuid;
  v_offset integer;
  v_limit integer;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_f) AS k(name)
             WHERE k.name NOT IN ('month', 'status', 'query', 'patient_id')) THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF nullif(v_f ->> 'month', '') IS NOT NULL THEN
    IF (v_f ->> 'month') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    v_month := public.fin__month(v_f ->> 'month');
    v_m1 := (v_month + interval '1 month')::date;
  END IF;
  v_status := coalesce(nullif(v_f ->> 'status', ''), 'all');
  IF v_status NOT IN ('all', 'unblocked', 'blocked', 'needs_check', 'released', 'voided') THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  v_query := nullif(btrim(coalesce(v_f ->> 'query', '')), '');
  IF char_length(v_query) > 100 THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF nullif(v_f ->> 'patient_id', '') IS NOT NULL THEN
    IF NOT public.fin__is_uuid(v_f ->> 'patient_id') THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    v_patient := (v_f ->> 'patient_id')::uuid;
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.fin__page(p_page) pg;

  WITH m AS (
    SELECT f.id, f.txn_date, f.created_at, f.gross_cents, f.fee_cents, f.net_cents
    FROM public.fin_patient_financing f
    LEFT JOIN public.patients pt ON pt.id = f.patient_id AND pt.clinic_id = f.clinic_id
    WHERE f.clinic_id = v_clinic
      AND (v_month IS NULL OR (f.txn_date >= v_month AND f.txn_date < v_m1))
      AND (v_patient IS NULL OR f.patient_id = v_patient)
      AND CASE v_status
            WHEN 'all' THEN f.voided_at IS NULL
            WHEN 'unblocked' THEN f.voided_at IS NULL AND NOT f.blocked
            WHEN 'blocked' THEN f.voided_at IS NULL AND f.blocked AND f.released_on IS NULL
            WHEN 'needs_check' THEN f.voided_at IS NULL AND f.blocked AND f.released_on IS NULL
                                    AND f.expected_release <= v_today
            WHEN 'released' THEN f.voided_at IS NULL AND f.released_on IS NOT NULL
            ELSE f.voided_at IS NOT NULL
          END
      AND (v_query IS NULL
           OR strpos(public.fin__tr_lower(f.patient_name_raw || ' ' || f.reference || ' ' || coalesce(pt.full_name, '')),
                     public.fin__tr_lower(v_query)) > 0)
  ),
  pg AS (
    SELECT m.id, m.txn_date, m.created_at
    FROM m
    ORDER BY m.txn_date DESC, m.created_at DESC, m.id
    OFFSET v_offset
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
           'today', v_today,
           'rows', coalesce((
             SELECT jsonb_agg(public.fin__financing_json(v_clinic, pg.id, v_today)
                              ORDER BY pg.txn_date DESC, pg.created_at DESC, pg.id)
             FROM pg), '[]'::jsonb),
           'total_count', (SELECT count(*)::bigint FROM m),
           'offset', v_offset,
           'limit', v_limit,
           'totals', jsonb_build_object(
             'gross_cents', (SELECT coalesce(sum(m.gross_cents), 0)::bigint FROM m),
             'fee_cents', (SELECT coalesce(sum(m.fee_cents), 0)::bigint FROM m),
             'net_cents', (SELECT coalesce(sum(m.net_cents), 0)::bigint FROM m)))
    INTO v_result;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.11 Import history (read).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_history(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_kind text;
  v_month date;
  v_from date;
  v_to date;
  v_offset integer;
  v_limit integer;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_f) AS k(name)
             WHERE k.name NOT IN ('kind', 'month', 'date_from', 'date_to')) THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  v_kind := nullif(v_f ->> 'kind', '');
  IF v_kind IS NOT NULL AND v_kind NOT IN ('rows', 'financing') THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  IF nullif(v_f ->> 'month', '') IS NOT NULL THEN
    IF (v_f ->> 'month') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    v_month := public.fin__month(v_f ->> 'month');
  END IF;
  IF nullif(v_f ->> 'date_from', '') IS NOT NULL THEN
    v_from := public.fin__parse_day(v_f ->> 'date_from');
    IF v_from IS NULL THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
  END IF;
  IF nullif(v_f ->> 'date_to', '') IS NOT NULL THEN
    v_to := public.fin__parse_day(v_f ->> 'date_to');
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
  END IF;
  IF v_from > v_to THEN
    RAISE EXCEPTION 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.fin__page(p_page) pg;

  WITH m AS (
    SELECT b.id, b.created_at
    FROM public.fin_import_batches b
    WHERE b.clinic_id = v_clinic
      AND (v_kind IS NULL OR b.kind = v_kind)
      AND (v_month IS NULL OR b.month = v_month)
      AND (v_from IS NULL OR (b.created_at AT TIME ZONE 'Europe/Istanbul')::date >= v_from)
      AND (v_to IS NULL OR (b.created_at AT TIME ZONE 'Europe/Istanbul')::date <= v_to)
  ),
  pg AS (
    SELECT m.id, m.created_at
    FROM m
    ORDER BY m.created_at DESC, m.id
    OFFSET v_offset
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
           'rows', coalesce((
             SELECT jsonb_agg(public.fin__batch_json(v_clinic, pg.id) ORDER BY pg.created_at DESC, pg.id)
             FROM pg), '[]'::jsonb),
           'total_count', (SELECT count(*)::bigint FROM m),
           'offset', v_offset,
           'limit', v_limit)
    INTO v_result;

  RETURN v_result;
END;
$$;

-- One batch with its current source rows (at most 500). A source re-bound by a later batch belongs to that batch;
-- the earlier batch's stored result still lists it.
CREATE OR REPLACE FUNCTION public.fin_import_batch(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fin_import_batches b WHERE b.clinic_id = v_clinic AND b.id = p_id) THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;

  RETURN jsonb_build_object(
    'batch', public.fin__batch_json(v_clinic, p_id),
    'sources', coalesce((
      SELECT jsonb_agg(x.obj ORDER BY x.txn_date, x.source_key)
      FROM (
        SELECT s.txn_date, s.source_key,
               jsonb_build_object(
                 'source_key', s.source_key,
                 'source_kind', s.source_kind,
                 'link_kind', s.link_kind,
                 'file_name', s.file_name,
                 'txn_date', s.txn_date,
                 'amount_cents', s.amount_cents,
                 'entry_id', s.entry_id,
                 'payment_id', s.payment_id,
                 'payment_is_voided', p.voided_at IS NOT NULL,
                 'rebind_count', s.rebind_count,
                 'rebound_at', s.rebound_at,
                 'entry', jsonb_build_object(
                   'counterparty_name', coalesce(cp.name, e.counterparty_text),
                   'category_name', c.name,
                   'status', CASE WHEN e.cancelled_at IS NOT NULL THEN 'cancelled'
                                  WHEN e.amount_cents - pd.paid > 0 THEN 'open'
                                  ELSE 'completed' END,
                   'amount_cents', e.amount_cents,
                   'outstanding_cents', CASE WHEN e.cancelled_at IS NOT NULL THEN 0::bigint
                                             ELSE e.amount_cents - pd.paid END)) AS obj
        FROM public.fin_import_sources s
        JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.entry_id
        JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        LEFT JOIN public.fin_payments p ON p.clinic_id = s.clinic_id AND p.id = s.payment_id
        CROSS JOIN LATERAL (SELECT public.fin__paid(e.id) AS paid) pd
        WHERE s.clinic_id = v_clinic AND s.batch_id = p_id
        ORDER BY s.txn_date, s.source_key
        LIMIT 500
      ) x), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.13 Seeds: the GENERIC keyword rules of legacy FI:10-21 as owner-editable rows. No person or company names
--      (owner decision 4): physician, laboratory / supplier and owner name rules are added by the owner (priority
--      60 is left free for physician rules, between transfers and loans as in FI:15). Runs once per clinic,
--      stamped in fin_settings.import_rules_seeded_at, so an edited or deactivated rule is never re-added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__seed_import_rules(p_clinic uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_settings uuid;
  v_seeded timestamptz;
BEGIN
  SELECT s.id, s.import_rules_seeded_at INTO v_settings, v_seeded
  FROM public.fin_settings s
  WHERE s.clinic_id = p_clinic
  FOR UPDATE;
  IF v_settings IS NULL OR v_seeded IS NOT NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.fin_classification_rules (id, clinic_id, priority, scope, match_kind, pattern, category_id,
                                               subcategory, counterparty_id, requires_entitlement_month,
                                               auto_select, warning, is_active, is_seed)
  SELECT gen_random_uuid(), p_clinic, r.priority, r.scope, r.match_kind, r.pattern, c.id, r.subcategory, NULL, false,
         r.auto_select, r.warning, true, true
  FROM (VALUES
    (5, 'clinic', 'regex', 'döviz bozdur'::text, 'other_expense', NULL::text, false,
     'Döviz bozdurma; faaliyet gideri değildir.'::text),
    (10, 'bank', 'always', NULL, 'patient_receipts', NULL, false,
     'Banka girişi: klinik Excel’indeki tahsilatı tekrar saymayın. POS / virman girişleri seçili değildir.'),
    (20, 'any', 'contains', 'teftiş defteri', 'other_expense', 'official_fee', true,
     'Resmi harç: vergi/SGK yerine diğer faaliyet giderinde izlenir.'),
    (30, 'any', 'regex', 'pos kullanım ücreti|fiziki pos.*hizmet bedeli|ö?kc hizmet bedeli', 'fees', NULL, true, ''),
    (40, 'any', 'regex',
     'komisyon|bsmv|kom\.|masraf|kesinti|bakım|bkm|donanım|eft ücret|havale ücret|fast ücret', 'fees', NULL, true, ''),
    (50, 'any', 'regex', 'hesaplararası|hesaplar arası', 'other_expense', NULL, false,
     'Hesaplar arası transfer; gider değildir.'),
    (70, 'any', 'regex', 'k.kartı ödeme|kredi|taksitli tahsilat', 'principal', NULL, false,
     'Kredi / kart ödemesi: anapara, faiz ve harcama ayrımı gerekli.'),
    (80, 'any', 'contains', 'kira', 'rent', NULL, true, ''),
    (90, 'any', 'contains', 'laboratuvar', 'lab', NULL, true, ''),
    (100, 'any', 'regex', 'maaş|yemek|mesai', 'personnel', NULL, true, ''),
    (110, 'any', 'regex', 'vergi|sgk', 'tax', NULL, true, ''),
    (10000, 'any', 'always', NULL, 'other_expense', NULL, false, 'Kategorisini kontrol edip seçin.')
  ) AS r(priority, scope, match_kind, pattern, bucket, subcategory, auto_select, warning)
  JOIN public.fin_categories c ON c.clinic_id = p_clinic AND c.is_system AND c.report_bucket = r.bucket;

  UPDATE public.fin_settings s SET import_rules_seeded_at = now() WHERE s.id = v_settings;
END;
$$;

-- 0020 seed + the rule seeds, so new clinics get both through the existing fin_seed_clinic trigger.
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

  -- p1 §1.4: 14 system categories (legacy FM:4-18; the partner-receivable category FM:13 is folded into the doctor
  -- bucket, FR:19).
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

  -- Phase 2: generic classification rules (once per clinic).
  PERFORM public.fin__seed_import_rules(p_clinic);
END;
$$;

DO $$
DECLARE
  v_clinic record;
BEGIN
  FOR v_clinic IN SELECT c.id FROM public.clinics c ORDER BY c.id
  LOOP
    PERFORM public.fin__seed_import_rules(v_clinic.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges: every fin_* function revoked from PUBLIC / anon / authenticated, public RPCs granted to
-- authenticated, internal helpers never; plus the 0020 self-checks (now over every fin_* table).
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

-- ---------------------------------------------------------------------------
-- 5.0 One key namespace for rows written before this migration (e.g. a legacy data load that ran first): every
--     keyed entry (entitlement keys aside) and every live bank-match payment gets its fin_import_sources row with
--     origin 'migration'. Rows already present are kept; on a fresh Phase 1 database nothing is inserted.
-- ---------------------------------------------------------------------------
INSERT INTO public.fin_import_sources (clinic_id, source_key, source_kind, link_kind, fingerprint, file_name, entry_id,
                                       payment_id, batch_id, txn_date, amount_cents, origin)
SELECT e.clinic_id, e.source_key, 'migration', 'entry', NULL, left(e.source_file, 200), e.id, NULL, NULL, NULL, NULL,
       'migration'
FROM public.fin_entries e
WHERE e.source_key IS NOT NULL AND e.source_key NOT LIKE 'entitlement:%'
ORDER BY e.created_at, e.id
ON CONFLICT (clinic_id, source_key) DO NOTHING;

INSERT INTO public.fin_import_sources (clinic_id, source_key, source_kind, link_kind, fingerprint, file_name, entry_id,
                                       payment_id, batch_id, txn_date, amount_cents, origin)
SELECT p.clinic_id, p.bank_source_key, 'migration', 'payment_match', NULL, left(p.bank_source_file, 200), p.entry_id,
       p.id, NULL, p.paid_on, p.amount_cents, 'migration'
FROM public.fin_payments p
WHERE p.bank_source_key IS NOT NULL AND p.voided_at IS NULL
ORDER BY p.recorded_at, p.id
ON CONFLICT (clinic_id, source_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5.1 Self-check specific to this migration. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  -- 1. Tables: RLS, exactly one SELECT policy <table>_select_finance, audit / no-delete / no-truncate triggers;
  --    fin_touch on the three versioned tables.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['fin_import_batches', 'fin_import_sources', 'fin_classification_rules', 'fin_import_layouts',
                    'fin_patient_financing']) AS t(tbl)
  WHERE to_regclass(format('public.%I', t.tbl)) IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t.tbl AND c.relrowsecurity)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tbl
                      AND p.policyname = t.tbl || '_select_finance' AND p.cmd = 'SELECT')
     OR EXISTS (
          SELECT 1
          FROM unnest(ARRAY['audit_row_change', 'fin_no_delete', 'fin_no_truncate']
                      || CASE WHEN t.tbl IN ('fin_classification_rules', 'fin_import_layouts', 'fin_patient_financing')
                              THEN ARRAY['fin_touch'] ELSE ARRAY[]::text[] END) AS g(name)
          WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tr
                            WHERE tr.tgrelid = format('public.%I', t.tbl)::regclass
                              AND tr.tgname = g.name AND NOT tr.tgisinternal));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 2/4 tablo kurulumu eksik: %', v_bad;
  END IF;

  -- 2. Guard and maintenance triggers; the reconciliation and consistency triggers are deferred.
  SELECT string_agg(x.tbl || '.' || x.trg, ', ') INTO v_bad
  FROM (VALUES
    ('fin_entries', 'fin_financing_lock', false),
    ('fin_payments', 'fin_financing_lock', false),
    ('fin_payments', 'fin_receipts_payments', true),
    ('fin_entries', 'fin_receipts_entries', true),
    ('fin_entries', 'fin_exclusion_source', false),
    ('fin_import_sources', 'fin_import_source_guard', false),
    ('fin_import_sources', 'fin_import_source_consistent', true),
    ('fin_import_batches', 'fin_batch_guard', false),
    ('fin_import_layouts', 'fin_layout_guard', false),
    ('fin_classification_rules', 'fin_rule_guard', false),
    ('fin_patient_financing', 'fin_financing_guard', false),
    ('fin_patient_financing', 'fin_financing_patient', false)
  ) AS x(tbl, trg, deferred)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid = format('public.%I', x.tbl)::regclass
      AND tr.tgname = x.trg
      AND NOT tr.tgisinternal
      AND (NOT x.deferred OR (tr.tgdeferrable AND tr.tginitdeferred))
  );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 2/4 tetikleyicileri eksik: %', v_bad;
  END IF;

  -- 3. Every clinic has its rule seeds.
  SELECT string_agg(c.id::text, ', ') INTO v_bad
  FROM public.clinics c
  WHERE NOT EXISTS (SELECT 1 FROM public.fin_settings s
                    WHERE s.clinic_id = c.id AND s.import_rules_seeded_at IS NOT NULL);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Aktarım kuralı varsayılanları eksik klinikler: %', v_bad;
  END IF;

  -- 4. One key namespace: every import key of an entry (entitlement keys aside) and every live bank match key has
  --    its fin_import_sources row. Empty on a fresh Phase 1 database; the legacy data migration must keep it.
  SELECT string_agg(k.key, ', ') INTO v_bad
  FROM (
    SELECT e.source_key AS key
    FROM public.fin_entries e
    WHERE e.source_key IS NOT NULL AND e.source_key NOT LIKE 'entitlement:%'
      AND NOT EXISTS (SELECT 1 FROM public.fin_import_sources s
                      WHERE s.clinic_id = e.clinic_id AND s.source_key = e.source_key
                        AND s.link_kind = 'entry' AND s.entry_id = e.id)
    UNION ALL
    SELECT p.bank_source_key
    FROM public.fin_payments p
    WHERE p.bank_source_key IS NOT NULL AND p.voided_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.fin_import_sources s
                      WHERE s.clinic_id = p.clinic_id AND s.source_key = p.bank_source_key
                        AND s.link_kind = 'payment_match' AND s.payment_id = p.id)
    LIMIT 20
  ) k;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Aktarım kaynağı kaydı eksik anahtarlar: %', v_bad;
  END IF;

  -- 5. Exclusion source: constraint present and validated, no excluded row without a source.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.fin_entries'::regclass
                   AND conname = 'fin_entries_exclusion_source_shape' AND convalidated)
     OR EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.excluded_from_totals AND e.exclusion_source IS NULL) THEN
    RAISE EXCEPTION 'fin_entries_exclusion_source_shape eksik veya doğrulanmamış.';
  END IF;

  -- 6. 0020 signatures unchanged (no accidental overload).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin_save_settings(integer,bigint,integer,text,text,uuid)',
    'public.fin_save_account(uuid,integer,text,text,text,boolean,integer)',
    'public.fin_merge_balance_sources(uuid,integer,jsonb,boolean,boolean)',
    'public.fin__entry_json(uuid,uuid,date)',
    'public.fin__settings_json(uuid)',
    'public.fin_audit_list(jsonb,jsonb)',
    'public.fin_export_manifest()',
    'public.fin__seed_clinic(uuid)',
    'public.fin__harden_privileges()',
    'public.fin__trg_touch()']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0020 fonksiyon imzaları değişmiş: %', v_bad;
  END IF;

  -- 7. One financing row per loan and day, whatever the provider (fin_patient_financing_loan_day_key).
  SELECT string_agg(d.clinic_id::text || ' ' || d.loan_key || ' ' || public.fin__iso_date(d.txn_date), ', ')
    INTO v_bad
  FROM (
    SELECT f.clinic_id, f.loan_key, f.txn_date
    FROM public.fin_patient_financing f
    GROUP BY f.clinic_id, f.loan_key, f.txn_date
    HAVING count(*) > 1
    LIMIT 20
  ) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Aynı finansman birden çok kez kayıtlı: %', v_bad;
  END IF;
  IF to_regclass('public.fin_patient_financing_loan_day_key') IS NULL THEN
    RAISE EXCEPTION 'fin_patient_financing_loan_day_key eksik.';
  END IF;
END $$;

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
