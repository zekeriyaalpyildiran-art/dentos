-- Hakediş v1 (physician entitlements): revenue lines per doctor, implant pieces, patient marks, lab costs per lab,
-- dated payee rules, the monthly calculation, month close into the 0020 entitlement ledger entry, and the doctor's
-- own read-only view (Hakedişim). Safe to re-run.
--
-- Contract: hakedis_spec.md §1 (+ v1.1 item 1: the lab name picker reads only active lab counterparties and names
-- already used). Requires 0019, 0020 and 0022 (fin__harden_privileges over every fin_* table, fin__trg_touch,
-- fin_audit_list / fin_export_manifest bodies extended below). Independent of 0029 (no object of it is used).
--
--  * No names, rates or amounts in this file: every rate is a rule row the owner enters (basis points and cents).
--  * Seven tables fin_hk_*: rules, lines (revenue), pieces (implants placed), patient_marks, lab_costs, months,
--    statements. Same treatment as every fin_* table: clinic_id RESTRICT, UNIQUE (clinic_id, id), client-supplied
--    uuids, version bumped by fin_touch, nothing deleted (fin_no_delete / fin_no_truncate), RLS SELECT for finance /
--    finance_readonly holders only, no write privileges, audit_row_change (the 0020 audit_logs fin_% gate hides the
--    rows from everyone else). Doctor / payee references are checked to be in the row's clinic (fin_hk_refs).
--  * Closed months: a line, piece or lab cost whose day falls in a closed month, or in any month before a closed
--    month, cannot be created, edited or voided (a write into a month changes the ortho lab-first walk of every later
--    month). RPC check + fin_hk_guard trigger; writes are serialised with every close / reopen of the clinic through
--    a per-clinic advisory lock. A month is reopened only while no later month is closed. Marks and rules change at
--    any time; a closed month keeps its statements.
--  * fin__hk_compute(clinic, month) is the single source of truth of the calculation (mirrored in apps/web
--    lib/hakedis.ts computeMonth). Money is integer cents, rounding is round(numeric) = half away from zero.
--      - segment of a line: line.segment, else 'own' when the patient mark names the line's doctor, else 'child' when
--        the mark says child, else 'standard';
--      - rule of a line: the doctor's active ortho_lab_first rule, else ciro_share for (doctor, segment), else
--        ciro_share 'standard', else unruled (warning, not paid);
--      - ciro_share / ortho_lab_first: per method bucket S = Σ (try − implant − lab part), D = round(S × deduct_bp /
--        10000), base = Σ (S − D), amount = round(base × share_bp / 10000);
--      - ortho_lab_first lab part: per (doctor, patient) all live lines up to the month in (day, created_at, id)
--        order; available lab = Σ live lab costs of months <= the line's month − already recovered; lab part =
--        max(min(try − implant, available), 0);
--      - implant_piece: Σ qty of live pieces of the month × piece_cents;
--      - clinic_ciro_share: round(Σ try of every live line of the month (gross) × share_bp / 10000).
--  * Internal helpers are named fin__hk_* (not fin_hk__*): fin__harden_privileges() grants every fin_* function whose
--    name does not start with fin__ to authenticated, so an internal fin_hk__* would have become a callable RPC.
--    Like every fin__* helper they are SECURITY INVOKER (fail closed; the harden self-check refuses a SECURITY
--    DEFINER internal); only the fin__trg_hk_* trigger functions are SECURITY DEFINER.
--  * Finance RPCs fin_hk_* (SECURITY DEFINER, search_path = public, granted to authenticated by
--    fin__harden_privileges): fin__require_read for reads, fin__require_write for writes; reopening a month also
--    needs the owner role. Self-service hk_my_months / hk_my_month need only an active session and return nothing
--    but the caller's own payee figures, own lines / pieces / lab costs and own entitlement entry.
--  * Month close writes one statement per payee and creates or updates the payee's entitlement entry
--    ('entitlement:<counterparty>:<YYYY-MM>', created through fin_add_entitlement), creating or linking the
--    physician counterparty when missing. A live entry left by an earlier close of the month that the new close does
--    not account for (payee dropped out or now 0, or the entry sits under another counterparty) is refused.
--  * fin_audit_list accepts the seven tables as entity filters; fin_export_manifest lists them (owner JSON export).
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). The UI shows error.message verbatim.
--
-- JSON shapes (all months are 'YYYY-MM-01' dates):
--   RuleJson      {id, version, payee_user_id, payee_name, payee_is_active, doctor_id, doctor_name, kind, segment,
--                  share_bp, piece_cents, deduct_cash_bp, deduct_card_bp, deduct_transfer_bp, deduct_financing_bp,
--                  from_month, to_month, note, created_at, created_by_name, updated_at, updated_by_name}
--   LineJson      {id, version, source, source_key, batch_id, day, doctor_id, doctor_name, patient_ref, patient_name,
--                  method, currency, amount_cents, try_cents, implant_cents, segment, description, is_voided,
--                  voided_at, voided_by_name, void_reason, created_at, created_by_name, updated_at, updated_by_name}
--   PieceJson     {id, version, source, source_key, day, doctor_id, doctor_name, patient_ref, patient_name, qty,
--                  description, is_voided, voided_at, voided_by_name, void_reason, created_at, created_by_name,
--                  updated_at, updated_by_name}
--   MarkJson      {id, version, patient_ref, patient_name, own_doctor_id, own_doctor_name, is_child, note,
--                  created_at, created_by_name, updated_at, updated_by_name}
--   LabCostJson   {id, version, day, doctor_id, doctor_name, patient_ref, patient_name, lab_name, amount_cents,
--                  description, is_voided, voided_at, voided_by_name, void_reason, created_at, created_by_name,
--                  updated_at, updated_by_name}
--   MonthRowJson  {month_id, month, status, version (0 = no row yet), closed_at, closed_by_name, reopened_at,
--                  reopened_by_name}
--   Compute       {month, payees: [Payee], clinic_total_cents, warnings: [Warning]}
--   Payee         {payee_user_id, payee_name, doctor_id, counterparty_id, total_cents, components: [Component]}
--   Component     {rule_id, kind, doctor_id, doctor_name, segment, share_bp, piece_cents,
--                  by_method: {cash|card|transfer|financing: {gross, implant, lab, eligible, deduct_bp, deduction}}
--                  (ciro_share / ortho_lab_first, else null), base_cents (null for implant_piece), amount_cents,
--                  qty (implant_piece only), lines_count, lab_patients (ortho_lab_first only:
--                  [{patient_ref, patient_name, lab_total_cents, recovered_cents, remaining_cents}])}
--   Warning       {code: 'UNRULED_LINES', doctor_id, doctor_name, count, try_cents}
--                 | {code: 'UNRULED_PIECES', doctor_id, doctor_name, qty}
--                 | {code: 'NO_COUNTERPARTY', payee_user_id, payee_name, reason: 'no_doctor' | 'missing' | 'inactive'}
--   StatementJson {id, month, payee_user_id, payee_name, total_cents, breakdown (Payee), fin_entry_id,
--                  entry: {id, version, amount_cents, paid_cents, outstanding_cents, is_cancelled} | null,
--                  created_at, created_by_name, superseded_at}
--   fin_hk_reference()  {today, current_month, can_write, is_owner, doctors: [{id, name, user_id, specialty,
--                        is_active}], payees: [{user_id, name, role, is_active, doctor_id}], rules: [RuleJson],
--                        months: [MonthRowJson], lab_names: [text]}
--   fin_hk_month(), fin_hk_close_month(), fin_hk_reopen_month()
--                       Compute + MonthRowJson + {today, current_month, can_write, is_owner, is_closable,
--                       statements: [StatementJson] (active only), lines: [LineJson + {resolved_segment, rule_id,
--                       rule_kind, payee_user_id, lab_part}], pieces: [PieceJson], lab_costs: [LabCostJson]}
--                       (close / reopen add already_saved)
--   fin_hk_save_*(), fin_hk_void_*()  {already_saved, record}
--   fin_hk_marks()      [MarkJson]
--   hk_my_months()      {has_rules, today, current_month, months: [{month, status, is_estimate, total_cents,
--                        paid_cents, remaining_cents (closed months only, else null)}]} newest first
--   hk_my_month()       {has_rules: false} | {has_rules: true, today, current_month, month, status, is_estimate,
--                        payees: [Payee without doctor_id / counterparty_id; a clinic_ciro_share component carries
--                        only rule_id, kind, share_bp, base_cents, amount_cents],
--                        lines: [{id, day, patient_name, method, currency, amount_cents, try_cents, implant_cents,
--                        segment, lab_part, counted}] (lines counted under the caller's own rules, counted = true,
--                        plus the caller's own doctor's unruled lines, counted = false; never a line counted under
--                        another payee's rule), pieces: [{id, day, patient_name, qty, description}],
--                        lab_costs: [{id, day, patient_name, lab_name, amount_cents}],
--                        statement: {total_cents, closed_at} | null,
--                        entitlement: {amount_cents, paid_cents, remaining_cents, is_cancelled} | null}
--
-- RUNBOOK (production is the only database):
--   1. SQL editor → New query → paste this file ALONE → Run. One transaction; the self-checks at the end (including a
--      replay in a temporary clinic that is always rolled back) undo everything on any failure.
--   2. Deploy the web build with the Hakediş pages afterwards (before step 1 they show the RPC error).
--   Rollback after COMMIT: DROP FUNCTION the fin_hk_* / fin__hk_* / fin__trg_hk_* / hk_my_* functions, DROP TABLE the
--   seven fin_hk_* tables (statements first), re-run 0022's fin_audit_list / fin_export_manifest definitions.
--   Entitlement entries created by a month close stay in the ledger (they are ordinary 0020 entries).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0019 / 0020 / 0022 live, expected columns, and any fin_hk_* table left by an earlier run
--     must already have the shape created below (CREATE TABLE IF NOT EXISTS would otherwise skip an old shape).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'audit_row_change', 'fin__require_read', 'fin__require_write',
                    'fin__harden_privileges', 'fin__normalize_name', 'fin__month_start', 'fin__reason', 'fin__day',
                    'fin__note', 'fin__user_name', 'fin__paid', 'fin__page', 'fin__trg_touch', 'fin__trg_no_delete',
                    'fin_can_read', 'fin_add_entitlement', 'fin_cancel_entry', 'fin_audit_list',
                    'fin_export_manifest']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0019, 0020 ve 0022 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() / auth.jwt() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  SELECT string_agg(t.tbl, ', ')
    INTO v_missing
  FROM unnest(ARRAY['clinics', 'users', 'doctors', 'audit_logs', 'staff_permissions', 'fin_entries', 'fin_payments',
                    'fin_counterparties', 'fin_categories', 'fin_import_batches', 'fin_patient_financing'])
    AS t(tbl)
  WHERE to_regclass(format('public.%I', t.tbl)) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen tablolar bulunamadı (0020 ve 0022 uygulanmalı): %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('clinics', 'id'), ('clinics', 'name'), ('clinics', 'slug'),
    ('users', 'id'), ('users', 'clinic_id'), ('users', 'auth_user_id'), ('users', 'role'), ('users', 'full_name'),
    ('users', 'email'), ('users', 'is_active'),
    ('doctors', 'id'), ('doctors', 'clinic_id'), ('doctors', 'user_id'), ('doctors', 'specialty'),
    ('fin_counterparties', 'id'), ('fin_counterparties', 'clinic_id'), ('fin_counterparties', 'name'),
    ('fin_counterparties', 'normalized_name'), ('fin_counterparties', 'kind'), ('fin_counterparties', 'doctor_id'),
    ('fin_counterparties', 'note'), ('fin_counterparties', 'is_active'),
    ('fin_entries', 'id'), ('fin_entries', 'clinic_id'), ('fin_entries', 'category_id'),
    ('fin_entries', 'counterparty_id'), ('fin_entries', 'counterparty_text'), ('fin_entries', 'description'),
    ('fin_entries', 'amount_cents'), ('fin_entries', 'cancelled_at'), ('fin_entries', 'source_key'),
    ('fin_entries', 'version'),
    ('fin_categories', 'id'), ('fin_categories', 'clinic_id'), ('fin_categories', 'report_bucket')
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
    ('fin_hk_rules', 'id'), ('fin_hk_rules', 'clinic_id'), ('fin_hk_rules', 'payee_user_id'),
    ('fin_hk_rules', 'doctor_id'), ('fin_hk_rules', 'kind'), ('fin_hk_rules', 'segment'), ('fin_hk_rules', 'share_bp'),
    ('fin_hk_rules', 'piece_cents'), ('fin_hk_rules', 'deduct_cash_bp'), ('fin_hk_rules', 'deduct_card_bp'),
    ('fin_hk_rules', 'deduct_transfer_bp'), ('fin_hk_rules', 'deduct_financing_bp'), ('fin_hk_rules', 'from_month'),
    ('fin_hk_rules', 'to_month'), ('fin_hk_rules', 'note'), ('fin_hk_rules', 'version'),
    ('fin_hk_rules', 'created_by'), ('fin_hk_rules', 'created_at'), ('fin_hk_rules', 'updated_by'),
    ('fin_hk_rules', 'updated_at'),
    ('fin_hk_lines', 'id'), ('fin_hk_lines', 'clinic_id'), ('fin_hk_lines', 'source'), ('fin_hk_lines', 'source_key'),
    ('fin_hk_lines', 'batch_id'), ('fin_hk_lines', 'day'), ('fin_hk_lines', 'doctor_id'),
    ('fin_hk_lines', 'patient_ref'), ('fin_hk_lines', 'patient_name'), ('fin_hk_lines', 'method'),
    ('fin_hk_lines', 'currency'), ('fin_hk_lines', 'amount_cents'), ('fin_hk_lines', 'try_cents'),
    ('fin_hk_lines', 'implant_cents'), ('fin_hk_lines', 'segment'), ('fin_hk_lines', 'description'),
    ('fin_hk_lines', 'voided_at'), ('fin_hk_lines', 'voided_by'), ('fin_hk_lines', 'void_reason'),
    ('fin_hk_lines', 'version'), ('fin_hk_lines', 'created_by'), ('fin_hk_lines', 'created_at'),
    ('fin_hk_lines', 'updated_by'), ('fin_hk_lines', 'updated_at'),
    ('fin_hk_pieces', 'id'), ('fin_hk_pieces', 'clinic_id'), ('fin_hk_pieces', 'source'),
    ('fin_hk_pieces', 'source_key'), ('fin_hk_pieces', 'day'), ('fin_hk_pieces', 'doctor_id'),
    ('fin_hk_pieces', 'patient_ref'), ('fin_hk_pieces', 'patient_name'), ('fin_hk_pieces', 'qty'),
    ('fin_hk_pieces', 'description'), ('fin_hk_pieces', 'voided_at'), ('fin_hk_pieces', 'voided_by'),
    ('fin_hk_pieces', 'void_reason'), ('fin_hk_pieces', 'version'), ('fin_hk_pieces', 'created_by'),
    ('fin_hk_pieces', 'created_at'), ('fin_hk_pieces', 'updated_by'), ('fin_hk_pieces', 'updated_at'),
    ('fin_hk_patient_marks', 'id'), ('fin_hk_patient_marks', 'clinic_id'), ('fin_hk_patient_marks', 'patient_ref'),
    ('fin_hk_patient_marks', 'patient_name'), ('fin_hk_patient_marks', 'own_doctor_id'),
    ('fin_hk_patient_marks', 'is_child'), ('fin_hk_patient_marks', 'note'), ('fin_hk_patient_marks', 'version'),
    ('fin_hk_patient_marks', 'created_by'), ('fin_hk_patient_marks', 'created_at'),
    ('fin_hk_patient_marks', 'updated_by'), ('fin_hk_patient_marks', 'updated_at'),
    ('fin_hk_lab_costs', 'id'), ('fin_hk_lab_costs', 'clinic_id'), ('fin_hk_lab_costs', 'day'),
    ('fin_hk_lab_costs', 'doctor_id'), ('fin_hk_lab_costs', 'patient_ref'), ('fin_hk_lab_costs', 'patient_name'),
    ('fin_hk_lab_costs', 'lab_name'), ('fin_hk_lab_costs', 'amount_cents'), ('fin_hk_lab_costs', 'description'),
    ('fin_hk_lab_costs', 'voided_at'), ('fin_hk_lab_costs', 'voided_by'), ('fin_hk_lab_costs', 'void_reason'),
    ('fin_hk_lab_costs', 'version'), ('fin_hk_lab_costs', 'created_by'), ('fin_hk_lab_costs', 'created_at'),
    ('fin_hk_lab_costs', 'updated_by'), ('fin_hk_lab_costs', 'updated_at'),
    ('fin_hk_months', 'id'), ('fin_hk_months', 'clinic_id'), ('fin_hk_months', 'month'), ('fin_hk_months', 'status'),
    ('fin_hk_months', 'closed_at'), ('fin_hk_months', 'closed_by'), ('fin_hk_months', 'reopened_at'),
    ('fin_hk_months', 'reopened_by'), ('fin_hk_months', 'version'), ('fin_hk_months', 'created_by'),
    ('fin_hk_months', 'created_at'), ('fin_hk_months', 'updated_by'), ('fin_hk_months', 'updated_at'),
    ('fin_hk_statements', 'id'), ('fin_hk_statements', 'clinic_id'), ('fin_hk_statements', 'month'),
    ('fin_hk_statements', 'payee_user_id'), ('fin_hk_statements', 'total_cents'), ('fin_hk_statements', 'breakdown'),
    ('fin_hk_statements', 'fin_entry_id'), ('fin_hk_statements', 'created_by'), ('fin_hk_statements', 'created_at'),
    ('fin_hk_statements', 'superseded_at'), ('fin_hk_statements', 'superseded_by')
  ) AS e(tbl, col)
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut fin_hk_* tabloları beklenen yapıda değil: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Pure helpers (no table access). Internal: never granted.
-- ---------------------------------------------------------------------------

-- '1.234,56 TL' (Turkish grouping). Used in error texts and in the ledger entry description.
CREATE OR REPLACE FUNCTION public.fin__hk_tl(p_cents bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_cents < 0 THEN '-' ELSE '' END
      || pg_catalog.regexp_replace((pg_catalog.abs(p_cents) / 100)::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
      || ',' || pg_catalog.lpad((pg_catalog.abs(p_cents) % 100)::text, 2, '0')
      || ' TL'
$$;

-- Basis points as a Turkish percentage: 2500 → '%25', 1250 → '%12,5'.
CREATE OR REPLACE FUNCTION public.fin__hk_pct(p_bp integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT '%' || pg_catalog.replace(
           pg_catalog.rtrim(pg_catalog.rtrim(pg_catalog.round(p_bp::numeric / 100, 2)::text, '0'), '.'), '.', ',')
$$;

-- Patient name of a line / piece / mark / lab cost: trimmed, 1..200 characters.
CREATE OR REPLACE FUNCTION public.fin__hk_patient_name(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR char_length(btrim(p)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Hasta adı boş olamaz ve en fazla 200 karakter olabilir.';
  END IF;
  RETURN btrim(p);
END;
$$;

-- Stable patient key: the given key (trimmed), or for manual entry the normalized name (fin__normalize_name), so the
-- same patient typed with other spacing / case keeps one key.
CREATE OR REPLACE FUNCTION public.fin__hk_patient_ref(p_ref text, p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_ref text := coalesce(nullif(btrim(coalesce(p_ref, '')), ''), public.fin__normalize_name(p_name));
BEGIN
  IF v_ref IS NULL OR char_length(v_ref) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Hasta anahtarı boş olamaz ve en fazla 200 karakter olabilir.';
  END IF;
  RETURN v_ref;
END;
$$;

-- Description of a line / piece / lab cost: trimmed, NULL → '', at most 500 characters.
CREATE OR REPLACE FUNCTION public.fin__hk_desc(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF char_length(btrim(coalesce(p, ''))) > 500 THEN
    RAISE EXCEPTION 'Açıklama en fazla 500 karakter olabilir.';
  END IF;
  RETURN btrim(coalesce(p, ''));
END;
$$;

-- Advisory lock key of one clinic month. Line / piece / lab cost writes take it shared, close / reopen exclusive (after
-- the clinic's close lock below), so a write cannot slip into a month while it is being closed. Built from numbers
-- only (no DateStyle dependence).
CREATE OR REPLACE FUNCTION public.fin__hk_month_lock(p_clinic uuid, p_month date)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.hashtextextended(
           'fin_hk_month:' || p_clinic::text || ':'
           || (EXTRACT(YEAR FROM p_month)::integer * 100 + EXTRACT(MONTH FROM p_month)::integer)::text,
           0)
$$;

-- Advisory lock key of one clinic's month closes. A write into month N changes the ortho lab-first walk of every later
-- month, so a line / piece / lab cost write must be serialised with a close or reopen of any month of the clinic, not
-- only of its own: writes take it shared (fin__hk_check_open), close / reopen exclusive, always before the month lock.
CREATE OR REPLACE FUNCTION public.fin__hk_close_lock(p_clinic uuid)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.hashtextextended('fin_hk_close:' || p_clinic::text, 0)
$$;

-- ---------------------------------------------------------------------------
-- 1.2 Tables
-- ---------------------------------------------------------------------------

-- Payee rules, dated by month (from_month .. to_month inclusive, to_month NULL = open-ended). Never deleted: a rule
-- ends by setting to_month. No two rules of the same (kind, doctor, segment) overlap in months (fin_hk_save_rule,
-- under an advisory lock), whoever the payee is.
CREATE TABLE IF NOT EXISTS public.fin_hk_rules (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  payee_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,   -- same clinic: fin_hk_refs
  doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,              -- same clinic: fin_hk_refs
  kind text NOT NULL CHECK (kind IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share')),
  segment text CHECK (segment IS NULL OR segment IN ('standard', 'child', 'own')),
  share_bp integer CHECK (share_bp IS NULL OR share_bp BETWEEN 1 AND 10000),
  piece_cents bigint CHECK (piece_cents IS NULL OR piece_cents BETWEEN 1 AND 1000000000000),
  deduct_cash_bp integer NOT NULL DEFAULT 0 CHECK (deduct_cash_bp BETWEEN 0 AND 10000),
  deduct_card_bp integer NOT NULL DEFAULT 0 CHECK (deduct_card_bp BETWEEN 0 AND 10000),
  deduct_transfer_bp integer NOT NULL DEFAULT 0 CHECK (deduct_transfer_bp BETWEEN 0 AND 10000),
  deduct_financing_bp integer NOT NULL DEFAULT 0 CHECK (deduct_financing_bp BETWEEN 0 AND 10000),
  from_month date NOT NULL CHECK (EXTRACT(DAY FROM from_month) = 1
                                  AND from_month BETWEEN DATE '2000-01-01' AND DATE '2100-12-01'),
  to_month date CHECK (to_month IS NULL OR (EXTRACT(DAY FROM to_month) = 1 AND to_month <= DATE '2100-12-01')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_hk_rules_month_range CHECK (to_month IS NULL OR to_month >= from_month),
  -- Which fields each kind uses; deductions only before a percentage of ciro.
  CONSTRAINT fin_hk_rules_kind_shape CHECK (
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
  )
);
CREATE INDEX IF NOT EXISTS idx_fin_hk_rules_kind_doctor ON public.fin_hk_rules (clinic_id, kind, doctor_id);
CREATE INDEX IF NOT EXISTS idx_fin_hk_rules_payee ON public.fin_hk_rules (clinic_id, payee_user_id);

-- Revenue lines: one payment (or correction, negative) per doctor and patient. amount in the original currency,
-- try_cents its TL value; implant_cents is the implant part of the TL value, left out of the doctor's ciro.
-- source / source_key / batch_id are for later feeders (Macro export, Burgan release); manual entry has no key.
CREATE TABLE IF NOT EXISTS public.fin_hk_lines (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'burgan')),
  source_key text CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 800),
  batch_id uuid,
  day date NOT NULL CHECK (day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  doctor_id uuid NOT NULL REFERENCES public.doctors(id) ON DELETE RESTRICT,     -- same clinic: fin_hk_refs
  patient_ref text NOT NULL CHECK (char_length(patient_ref) BETWEEN 1 AND 200),
  patient_name text NOT NULL CHECK (char_length(btrim(patient_name)) BETWEEN 1 AND 200),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'financing')),
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency IN ('TRY', 'EUR', 'USD', 'GBP')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND amount_cents BETWEEN -1000000000000 AND 1000000000000),
  try_cents bigint NOT NULL CHECK (try_cents <> 0 AND try_cents BETWEEN -1000000000000 AND 1000000000000),
  implant_cents bigint NOT NULL DEFAULT 0,
  segment text CHECK (segment IS NULL OR segment IN ('standard', 'child', 'own')),   -- manual override
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  voided_at timestamptz,
  voided_by uuid REFERENCES public.users(id),
  void_reason text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_hk_lines_sign CHECK ((amount_cents > 0) = (try_cents > 0)),
  CONSTRAINT fin_hk_lines_try CHECK (currency <> 'TRY' OR try_cents = amount_cents),
  CONSTRAINT fin_hk_lines_implant CHECK (
    implant_cents = 0 OR ((implant_cents > 0) = (try_cents > 0) AND abs(implant_cents) <= abs(try_cents))
  ),
  CONSTRAINT fin_hk_lines_void_shape CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 3 AND 500)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_hk_lines_source_key
  ON public.fin_hk_lines (clinic_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_hk_lines_day ON public.fin_hk_lines (clinic_id, day);
CREATE INDEX IF NOT EXISTS idx_fin_hk_lines_doctor_day ON public.fin_hk_lines (clinic_id, doctor_id, day);
CREATE INDEX IF NOT EXISTS idx_fin_hk_lines_patient ON public.fin_hk_lines (clinic_id, patient_ref);

-- Implants placed (qty; a negative qty is a correction), paid per piece to the placing doctor's implant_piece rule.
CREATE TABLE IF NOT EXISTS public.fin_hk_pieces (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'clinical')),
  source_key text CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 800),
  day date NOT NULL CHECK (day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  doctor_id uuid NOT NULL REFERENCES public.doctors(id) ON DELETE RESTRICT,     -- same clinic: fin_hk_refs
  patient_ref text NOT NULL CHECK (char_length(patient_ref) BETWEEN 1 AND 200),
  patient_name text NOT NULL CHECK (char_length(btrim(patient_name)) BETWEEN 1 AND 200),
  qty integer NOT NULL CHECK (qty <> 0 AND qty BETWEEN -1000 AND 1000),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  voided_at timestamptz,
  voided_by uuid REFERENCES public.users(id),
  void_reason text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_hk_pieces_void_shape CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 3 AND 500)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_hk_pieces_source_key
  ON public.fin_hk_pieces (clinic_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_hk_pieces_doctor_day ON public.fin_hk_pieces (clinic_id, doctor_id, day);
CREATE INDEX IF NOT EXISTS idx_fin_hk_pieces_day ON public.fin_hk_pieces (clinic_id, day);

-- Patient marks: own-portfolio patient of a doctor and / or child patient. One per patient key.
CREATE TABLE IF NOT EXISTS public.fin_hk_patient_marks (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_ref text NOT NULL CHECK (char_length(patient_ref) BETWEEN 1 AND 200),
  patient_name text NOT NULL CHECK (char_length(btrim(patient_name)) BETWEEN 1 AND 200),
  own_doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,          -- same clinic: fin_hk_refs
  is_child boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, patient_ref)
);

-- Lab costs per lab invoice / charge for one patient, recovered from the doctor's share by an ortho_lab_first rule
-- (for other doctors they are information only). TL cents; a negative amount is a correction.
CREATE TABLE IF NOT EXISTS public.fin_hk_lab_costs (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  day date NOT NULL CHECK (day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  doctor_id uuid NOT NULL REFERENCES public.doctors(id) ON DELETE RESTRICT,     -- same clinic: fin_hk_refs
  patient_ref text NOT NULL CHECK (char_length(patient_ref) BETWEEN 1 AND 200),
  patient_name text NOT NULL CHECK (char_length(btrim(patient_name)) BETWEEN 1 AND 200),
  lab_name text NOT NULL CHECK (char_length(btrim(lab_name)) BETWEEN 1 AND 120),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND amount_cents BETWEEN -1000000000000 AND 1000000000000),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  voided_at timestamptz,
  voided_by uuid REFERENCES public.users(id),
  void_reason text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_hk_lab_costs_void_shape CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 3 AND 500)
  )
);
CREATE INDEX IF NOT EXISTS idx_fin_hk_lab_costs_day ON public.fin_hk_lab_costs (clinic_id, day);
CREATE INDEX IF NOT EXISTS idx_fin_hk_lab_costs_patient ON public.fin_hk_lab_costs (clinic_id, doctor_id, patient_ref);

-- Month status. A month without a row is open; the row is created by the first close.
CREATE TABLE IF NOT EXISTS public.fin_hk_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1 AND month BETWEEN DATE '2000-01-01' AND DATE '2100-12-01'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid REFERENCES public.users(id),
  reopened_at timestamptz,
  reopened_by uuid REFERENCES public.users(id),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, month),
  CONSTRAINT fin_hk_months_closed_shape CHECK (status = 'open' OR closed_at IS NOT NULL)
);

-- Statements written by a month close: the computed payee object frozen as breakdown, the linked entitlement entry.
-- A reopen or a later close supersedes them (rows are kept); one active statement per (month, payee).
CREATE TABLE IF NOT EXISTS public.fin_hk_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  payee_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,   -- same clinic: fin_hk_refs
  total_cents bigint NOT NULL CHECK (total_cents BETWEEN 0 AND 1000000000000),
  breakdown jsonb NOT NULL CHECK (jsonb_typeof(breakdown) = 'object'),
  fin_entry_id uuid,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  superseded_by uuid REFERENCES public.users(id),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, fin_entry_id) REFERENCES public.fin_entries (clinic_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_hk_statements_active_key
  ON public.fin_hk_statements (clinic_id, month, payee_user_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_hk_statements_payee ON public.fin_hk_statements (clinic_id, payee_user_id, month);
CREATE INDEX IF NOT EXISTS idx_fin_hk_statements_entry
  ON public.fin_hk_statements (fin_entry_id) WHERE fin_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1.3 Internal helpers that read tables (SECURITY INVOKER, never granted).
-- ---------------------------------------------------------------------------

-- Display name of a doctors row (users.full_name).
CREATE OR REPLACE FUNCTION public.fin__hk_doctor_name(p_doctor uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT u.full_name
  FROM public.doctors d
  JOIN public.users u ON u.id = d.user_id
  WHERE d.id = p_doctor
$$;

-- Refuses a write into a closed month, or into an open month before a closed one (the write would change the closed
-- month's ortho lab-first walk, its statement and its ledger entry staying frozen). Takes the clinic's close lock and
-- the month lock shared first, so it waits for a close / reopen in progress and then sees its result.
CREATE OR REPLACE FUNCTION public.fin__hk_check_open(p_clinic uuid, p_day date)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_month date := public.fin__month_start(p_day);
BEGIN
  IF v_month IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(public.fin__hk_close_lock(p_clinic));
  PERFORM pg_advisory_xact_lock_shared(public.fin__hk_month_lock(p_clinic, v_month));
  IF EXISTS (
    SELECT 1 FROM public.fin_hk_months m
    WHERE m.clinic_id = p_clinic AND m.month = v_month AND m.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fin_hk_months m
    WHERE m.clinic_id = p_clinic AND m.month > v_month AND m.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Bu aydan sonraki bir ay kapatıldı. Düzeltmeyi son kapatılan aydan sonraki bir aya düzeltme satırı olarak girin.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1.4 Guard triggers (SECURITY DEFINER, never granted; EXECUTE is not checked when a trigger fires). The RPCs check
--     the same rules first so the user sees the specific message; the triggers are the backstop for the SQL editor,
--     later feeders and RPC bugs.
-- ---------------------------------------------------------------------------

-- Doctor / payee references must belong to the row's clinic (doctors and users have no (clinic_id, id) key to point a
-- composite foreign key at).
CREATE OR REPLACE FUNCTION public.fin__trg_hk_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_doctor uuid;
  v_user uuid;
BEGIN
  FOREACH v_doctor IN ARRAY ARRAY[(v_row ->> 'doctor_id')::uuid, (v_row ->> 'own_doctor_id')::uuid]
  LOOP
    IF v_doctor IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.doctors d WHERE d.id = v_doctor AND d.clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'Hekim bulunamadı.';
    END IF;
  END LOOP;

  v_user := (v_row ->> 'payee_user_id')::uuid;
  IF v_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_user AND u.clinic_id = NEW.clinic_id
  ) THEN
    RAISE EXCEPTION 'Kişi bulunamadı.';
  END IF;
  RETURN NEW;
END;
$$;

-- Lines, pieces and lab costs: nothing is written into a closed month (old and new day on an edit), a voided row is
-- frozen, a row cannot be inserted voided, feeder keys are immutable.
CREATE OR REPLACE FUNCTION public.fin__trg_hk_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_old jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt eklenemez.';
    END IF;
    PERFORM public.fin__hk_check_open(NEW.clinic_id, NEW.day);
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  IF OLD.voided_at IS NOT NULL THEN
    IF v_new IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
    END IF;
    RETURN NEW;
  END IF;

  IF (v_new ->> 'source') IS DISTINCT FROM (v_old ->> 'source')
     OR (v_new ->> 'source_key') IS DISTINCT FROM (v_old ->> 'source_key')
     OR (v_new ->> 'batch_id') IS DISTINCT FROM (v_old ->> 'batch_id') THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;

  PERFORM public.fin__hk_check_open(OLD.clinic_id, OLD.day);
  IF NEW.day IS DISTINCT FROM OLD.day THEN
    PERFORM public.fin__hk_check_open(NEW.clinic_id, NEW.day);
  END IF;
  RETURN NEW;
END;
$$;

-- Statements are history: only the supersede stamp may be set, once.
CREATE OR REPLACE FUNCTION public.fin__trg_hk_statement_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['superseded_at', 'superseded_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_at', 'superseded_by'])
     OR (OLD.superseded_at IS NOT NULL
         AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
              OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by)) THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger wiring. BEFORE triggers fire in name order: fin_hk_guard, fin_hk_refs, then fin_touch (version / stamps).
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_hk_rules', 'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks',
                             'fin_hk_lab_costs', 'fin_hk_months']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_touch ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_touch()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['fin_hk_rules', 'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks',
                             'fin_hk_lab_costs', 'fin_hk_months', 'fin_hk_statements']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_delete ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_no_delete BEFORE DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.fin__trg_no_delete()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['fin_hk_rules', 'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks',
                             'fin_hk_lab_costs', 'fin_hk_statements']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_hk_refs ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_hk_refs BEFORE INSERT OR UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_refs()', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY ARRAY['fin_hk_lines', 'fin_hk_pieces', 'fin_hk_lab_costs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_hk_guard ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER fin_hk_guard BEFORE INSERT OR UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_guard()', v_t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS fin_hk_statement_guard ON public.fin_hk_statements;
CREATE TRIGGER fin_hk_statement_guard
  BEFORE UPDATE ON public.fin_hk_statements
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_statement_guard();

-- ---------------------------------------------------------------------------
-- 1.5 RLS (SELECT only, for finance / finance_readonly holders of the caller's clinic), no write privileges, and
--     audit_row_change() on the seven tables. The 0020 audit_logs policies already restrict every fin_% entity to
--     finance holders, so doctors' figures and patient names in these audit rows are visible only to them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_hk_rules', 'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks',
                             'fin_hk_lab_costs', 'fin_hk_months', 'fin_hk_statements']
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
-- 2. Calculation internals (SECURITY INVOKER, never granted; called only from the SECURITY DEFINER RPCs below, so
--    they run as the function owner there). Mirrored by computeMonth in apps/web/src/lib/hakedis.ts.
-- ---------------------------------------------------------------------------

-- Ortho lab-first walk for the month p_month: for every doctor with an active ortho_lab_first rule in that month and
-- every patient key of that doctor, all live lines with day before the next month in (day, created_at, id) order.
-- Available lab = live lab costs of (doctor, patient) whose month is <= the line's month, minus what earlier lines
-- already recovered; lab part = max(min(try − implant, available), 0). A cost dated later in the same month still
-- counts for that month's payments; a cost of a later month is recovered from later payments only. Returns one row
-- per walked line (all months); the lab part of a line does not depend on p_month, only on the lines before it.
CREATE OR REPLACE FUNCTION public.fin__hk_ortho_walk(p_clinic uuid, p_month date)
RETURNS TABLE (doctor_id uuid, patient_ref text, line_id uuid, line_day date, lab_part_cents bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_month date := public.fin__month_start(p_month);
  v_next date := (public.fin__month_start(p_month) + interval '1 month')::date;
  v_line record;
  v_doctor uuid;
  v_ref text;
  v_consumed bigint := 0;
  v_part bigint;
BEGIN
  FOR v_line IN
    SELECT l.id AS id,
           l.doctor_id AS doc,
           l.patient_ref AS ref,
           l.day AS day,
           l.try_cents - l.implant_cents AS e,
           (SELECT coalesce(sum(c.amount_cents), 0)
            FROM public.fin_hk_lab_costs c
            WHERE c.clinic_id = l.clinic_id
              AND c.doctor_id = l.doctor_id
              AND c.patient_ref = l.patient_ref
              AND c.voided_at IS NULL
              AND c.day < (public.fin__month_start(l.day) + interval '1 month')::date)::bigint AS lab_to_month
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = p_clinic
      AND l.voided_at IS NULL
      AND l.day < v_next
      AND l.doctor_id IN (
        SELECT r.doctor_id
        FROM public.fin_hk_rules r
        WHERE r.clinic_id = p_clinic
          AND r.kind = 'ortho_lab_first'
          AND r.from_month <= v_month
          AND (r.to_month IS NULL OR r.to_month >= v_month))
    ORDER BY l.doctor_id, l.patient_ref, l.day, l.created_at, l.id
  LOOP
    IF v_doctor IS DISTINCT FROM v_line.doc OR v_ref IS DISTINCT FROM v_line.ref THEN
      v_doctor := v_line.doc;
      v_ref := v_line.ref;
      v_consumed := 0;
    END IF;
    v_part := GREATEST(LEAST(v_line.e, v_line.lab_to_month - v_consumed), 0);
    v_consumed := v_consumed + v_part;

    doctor_id := v_line.doc;
    patient_ref := v_line.ref;
    line_id := v_line.id;
    line_day := v_line.day;
    lab_part_cents := v_part;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Every live line of the month with its resolved segment, its rule (NULL = unruled) and its lab part.
--   segment: line.segment, else 'own' when the patient mark names the line's doctor, else 'child' when the mark says
--            child, else 'standard';
--   rule:    the doctor's active ortho_lab_first rule, else ciro_share (doctor, segment), else ciro_share 'standard'.
CREATE OR REPLACE FUNCTION public.fin__hk_eval_lines(p_clinic uuid, p_month date)
RETURNS TABLE (line_id uuid, doctor_id uuid, patient_ref text, method text, try_cents bigint, implant_cents bigint,
               segment text, rule_id uuid, rule_kind text, payee_user_id uuid, lab_part_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH ar AS (
    SELECT r.id, r.kind, r.doctor_id, r.segment, r.payee_user_id
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = p_clinic
      AND r.kind IN ('ciro_share', 'ortho_lab_first')
      AND r.from_month <= public.fin__month_start(p_month)
      AND (r.to_month IS NULL OR r.to_month >= public.fin__month_start(p_month))
  ),
  walk AS (
    SELECT w.line_id, w.lab_part_cents
    FROM public.fin__hk_ortho_walk(p_clinic, p_month) w
  ),
  ln AS (
    SELECT l.id, l.doctor_id, l.patient_ref, l.method, l.try_cents, l.implant_cents, l.created_at, l.day,
           coalesce(l.segment,
                    CASE WHEN m.own_doctor_id = l.doctor_id THEN 'own'
                         WHEN m.is_child THEN 'child'
                         ELSE 'standard' END) AS seg
    FROM public.fin_hk_lines l
    LEFT JOIN public.fin_hk_patient_marks m ON m.clinic_id = l.clinic_id AND m.patient_ref = l.patient_ref
    WHERE l.clinic_id = p_clinic
      AND l.voided_at IS NULL
      AND l.day >= public.fin__month_start(p_month)
      AND l.day < (public.fin__month_start(p_month) + interval '1 month')::date
  )
  SELECT ln.id,
         ln.doctor_id,
         ln.patient_ref,
         ln.method,
         ln.try_cents,
         ln.implant_cents,
         ln.seg,
         x.id,
         x.kind,
         x.payee_user_id,
         (CASE WHEN x.kind = 'ortho_lab_first' THEN coalesce(w.lab_part_cents, 0) ELSE 0 END)::bigint
  FROM ln
  LEFT JOIN LATERAL (
    SELECT ar.id, ar.kind, ar.payee_user_id
    FROM ar
    WHERE ar.doctor_id = ln.doctor_id
      AND (ar.kind = 'ortho_lab_first' OR ar.segment = ln.seg OR ar.segment = 'standard')
    ORDER BY CASE WHEN ar.kind = 'ortho_lab_first' THEN 0 WHEN ar.segment = ln.seg THEN 1 ELSE 2 END, ar.id
    LIMIT 1
  ) x ON true
  LEFT JOIN walk w ON w.line_id = ln.id
$$;

-- The month's figures for every payee (see the header for the shape). Single source of truth: the finance page, the
-- month close (statements, ledger amounts) and the doctor's own view all read it.
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
  ),
  payee AS (
    SELECT c.payee_user_id,
           u.full_name AS payee_name,
           pd.id AS payee_doctor_id,
           cp.id AS counterparty_id,
           cp.is_active AS counterparty_is_active,
           sum(c.amount_cents)::bigint AS total,
           jsonb_agg(jsonb_build_object(
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
             'lab_patients', c.lab_patients)
             ORDER BY c.kind_ord, c.doctor_name COLLATE "tr-x-icu", c.seg_ord, c.rule_id) AS components
    FROM comp c
    JOIN public.users u ON u.id = c.payee_user_id
    LEFT JOIN public.doctors pd ON pd.user_id = c.payee_user_id AND pd.clinic_id = p_clinic
    LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = p_clinic AND cp.doctor_id = pd.id
    GROUP BY c.payee_user_id, u.full_name, pd.id, cp.id, cp.is_active
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
             'reason', CASE WHEN p.payee_doctor_id IS NULL THEN 'no_doctor'
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

-- The caller's own payee object for hk_my_month: a clinic_ciro_share component keeps only its rate, base and amount
-- (no line counts of the whole clinic); the payee's doctor / counterparty ids are dropped.
CREATE OR REPLACE FUNCTION public.fin__hk_self_payee(p_payee jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'payee_user_id', p_payee -> 'payee_user_id',
           'payee_name', p_payee -> 'payee_name',
           'total_cents', p_payee -> 'total_cents',
           'components', coalesce((
             SELECT jsonb_agg(
                      CASE WHEN (o.c ->> 'kind') = 'clinic_ciro_share'
                           THEN jsonb_build_object(
                                  'rule_id', o.c -> 'rule_id',
                                  'kind', o.c -> 'kind',
                                  'share_bp', o.c -> 'share_bp',
                                  'base_cents', o.c -> 'base_cents',
                                  'amount_cents', o.c -> 'amount_cents')
                           ELSE o.c END
                      ORDER BY o.ord)
             FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(p_payee -> 'components') = 'array' THEN p_payee -> 'components'
                         ELSE '[]'::jsonb END) WITH ORDINALITY AS o(c, ord)), '[]'::jsonb))
$$;

-- Short Turkish breakdown for the ledger entry (fin_entries.description, <= 1000 characters), e.g.
-- 'DentOS hakediş 2026-11: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL; implant 2 × 100,00 TL = 200,00 TL'.
-- Zero components are left out; the doctor is named only when the rule's doctor is not the payee's own doctors row.
CREATE OR REPLACE FUNCTION public.fin__hk_description(p_payee jsonb, p_month date, p_payee_doctor uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT left('DentOS hakediş ' || to_char(p_month, 'YYYY-MM') || ': '
              || coalesce(string_agg(
                   CASE (y.c ->> 'kind')
                     WHEN 'implant_piece' THEN
                       'implant' || y.doc || ' ' || (y.c ->> 'qty') || ' × '
                       || public.fin__hk_tl((y.c ->> 'piece_cents')::bigint)
                     WHEN 'clinic_ciro_share' THEN
                       'yönetim payı ' || public.fin__hk_pct((y.c ->> 'share_bp')::integer) || ' × '
                       || public.fin__hk_tl((y.c ->> 'base_cents')::bigint)
                     WHEN 'ortho_lab_first' THEN
                       'ortodonti (önce lab)' || y.doc || ' ' || public.fin__hk_pct((y.c ->> 'share_bp')::integer)
                       || ' × ' || public.fin__hk_tl((y.c ->> 'base_cents')::bigint)
                     ELSE
                       'ciro payı' || y.doc || ' ('
                       || CASE (y.c ->> 'segment') WHEN 'child' THEN 'çocuk' WHEN 'own' THEN 'kendi hastası'
                                                   ELSE 'standart' END
                       || ') ' || public.fin__hk_pct((y.c ->> 'share_bp')::integer) || ' × '
                       || public.fin__hk_tl((y.c ->> 'base_cents')::bigint)
                   END || ' = ' || public.fin__hk_tl((y.c ->> 'amount_cents')::bigint),
                   '; ' ORDER BY y.ord), 'tutar yok'),
              1000)
  FROM (
    SELECT o.ord,
           o.c,
           CASE WHEN (o.c ->> 'doctor_id') IS NOT NULL
                     AND (o.c ->> 'doctor_id') IS DISTINCT FROM p_payee_doctor::text
                THEN ' ' || coalesce((o.c ->> 'doctor_name'), '')
                ELSE '' END AS doc
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_payee -> 'components') = 'array' THEN p_payee -> 'components'
                ELSE '[]'::jsonb END) WITH ORDINALITY AS o(c, ord)
    WHERE coalesce((o.c ->> 'amount_cents')::bigint, 0) <> 0
  ) y
$$;

-- Known lab names for the lab cost picker (owner decision v1.1 item 1): the ACTIVE finance counterparties of kind 'lab'
-- (the curated Cariler list) plus names already used in live fin_hk_lab_costs (so history still shows). Ledger entry
-- texts and the clinical labs directory are not read (they hold non-lab text and labs the owner excluded). Distinct by
-- fin__normalize_name, keeping the counterparty's spelling; strings only.
CREATE OR REPLACE FUNCTION public.fin__hk_lab_names(p_clinic uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(n.name ORDER BY n.name COLLATE "tr-x-icu"), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (public.fin__normalize_name(s.name)) s.name
    FROM (
      SELECT 1 AS pri, btrim(cp.name) AS name
      FROM public.fin_counterparties cp
      WHERE cp.clinic_id = p_clinic AND cp.kind = 'lab' AND cp.is_active
      UNION ALL
      SELECT 2, btrim(c.lab_name)
      FROM public.fin_hk_lab_costs c
      WHERE c.clinic_id = p_clinic AND c.voided_at IS NULL
    ) s
    WHERE s.name IS NOT NULL AND char_length(s.name) BETWEEN 1 AND 120
    ORDER BY public.fin__normalize_name(s.name), s.pri, s.name
  ) n
$$;

-- ---------------------------------------------------------------------------
-- 3. Row shapes (internal, see the header).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__hk_rule_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', r.id,
           'version', r.version,
           'payee_user_id', r.payee_user_id,
           'payee_name', pu.full_name,
           'payee_is_active', coalesce(pu.is_active, false),
           'doctor_id', r.doctor_id,
           'doctor_name', public.fin__hk_doctor_name(r.doctor_id),
           'kind', r.kind,
           'segment', r.segment,
           'share_bp', r.share_bp,
           'piece_cents', r.piece_cents,
           'deduct_cash_bp', r.deduct_cash_bp,
           'deduct_card_bp', r.deduct_card_bp,
           'deduct_transfer_bp', r.deduct_transfer_bp,
           'deduct_financing_bp', r.deduct_financing_bp,
           'from_month', r.from_month,
           'to_month', r.to_month,
           'note', r.note,
           'created_at', r.created_at,
           'created_by_name', public.fin__user_name(r.created_by),
           'updated_at', r.updated_at,
           'updated_by_name', public.fin__user_name(r.updated_by))
  FROM public.fin_hk_rules r
  LEFT JOIN public.users pu ON pu.id = r.payee_user_id
  WHERE r.clinic_id = p_clinic AND r.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_line_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', l.id,
           'version', l.version,
           'source', l.source,
           'source_key', l.source_key,
           'batch_id', l.batch_id,
           'day', l.day,
           'doctor_id', l.doctor_id,
           'doctor_name', public.fin__hk_doctor_name(l.doctor_id),
           'patient_ref', l.patient_ref,
           'patient_name', l.patient_name,
           'method', l.method,
           'currency', l.currency,
           'amount_cents', l.amount_cents,
           'try_cents', l.try_cents,
           'implant_cents', l.implant_cents,
           'segment', l.segment,
           'description', l.description,
           'is_voided', l.voided_at IS NOT NULL,
           'voided_at', l.voided_at,
           'voided_by_name', public.fin__user_name(l.voided_by),
           'void_reason', l.void_reason,
           'created_at', l.created_at,
           'created_by_name', public.fin__user_name(l.created_by),
           'updated_at', l.updated_at,
           'updated_by_name', public.fin__user_name(l.updated_by))
  FROM public.fin_hk_lines l
  WHERE l.clinic_id = p_clinic AND l.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_piece_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', p.id,
           'version', p.version,
           'source', p.source,
           'source_key', p.source_key,
           'day', p.day,
           'doctor_id', p.doctor_id,
           'doctor_name', public.fin__hk_doctor_name(p.doctor_id),
           'patient_ref', p.patient_ref,
           'patient_name', p.patient_name,
           'qty', p.qty,
           'description', p.description,
           'is_voided', p.voided_at IS NOT NULL,
           'voided_at', p.voided_at,
           'voided_by_name', public.fin__user_name(p.voided_by),
           'void_reason', p.void_reason,
           'created_at', p.created_at,
           'created_by_name', public.fin__user_name(p.created_by),
           'updated_at', p.updated_at,
           'updated_by_name', public.fin__user_name(p.updated_by))
  FROM public.fin_hk_pieces p
  WHERE p.clinic_id = p_clinic AND p.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_mark_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', m.id,
           'version', m.version,
           'patient_ref', m.patient_ref,
           'patient_name', m.patient_name,
           'own_doctor_id', m.own_doctor_id,
           'own_doctor_name', public.fin__hk_doctor_name(m.own_doctor_id),
           'is_child', m.is_child,
           'note', m.note,
           'created_at', m.created_at,
           'created_by_name', public.fin__user_name(m.created_by),
           'updated_at', m.updated_at,
           'updated_by_name', public.fin__user_name(m.updated_by))
  FROM public.fin_hk_patient_marks m
  WHERE m.clinic_id = p_clinic AND m.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_lab_cost_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', c.id,
           'version', c.version,
           'day', c.day,
           'doctor_id', c.doctor_id,
           'doctor_name', public.fin__hk_doctor_name(c.doctor_id),
           'patient_ref', c.patient_ref,
           'patient_name', c.patient_name,
           'lab_name', c.lab_name,
           'amount_cents', c.amount_cents,
           'description', c.description,
           'is_voided', c.voided_at IS NOT NULL,
           'voided_at', c.voided_at,
           'voided_by_name', public.fin__user_name(c.voided_by),
           'void_reason', c.void_reason,
           'created_at', c.created_at,
           'created_by_name', public.fin__user_name(c.created_by),
           'updated_at', c.updated_at,
           'updated_by_name', public.fin__user_name(c.updated_by))
  FROM public.fin_hk_lab_costs c
  WHERE c.clinic_id = p_clinic AND c.id = p_id
$$;

-- Month status row; a month without a row is open with version 0 (the version fin_hk_close_month expects then).
CREATE OR REPLACE FUNCTION public.fin__hk_month_row_json(p_clinic uuid, p_month date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'month_id', m.id,
           'month', public.fin__month_start(p_month),
           'status', coalesce(m.status, 'open'),
           'version', coalesce(m.version, 0),
           'closed_at', m.closed_at,
           'closed_by_name', public.fin__user_name(m.closed_by),
           'reopened_at', m.reopened_at,
           'reopened_by_name', public.fin__user_name(m.reopened_by))
  FROM (SELECT 1) AS one
  LEFT JOIN public.fin_hk_months m ON m.clinic_id = p_clinic AND m.month = public.fin__month_start(p_month)
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_statement_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', s.id,
           'month', s.month,
           'payee_user_id', s.payee_user_id,
           'payee_name', u.full_name,
           'total_cents', s.total_cents,
           'breakdown', s.breakdown,
           'fin_entry_id', s.fin_entry_id,
           'entry', CASE WHEN e.id IS NULL THEN NULL
                         ELSE jsonb_build_object(
                                'id', e.id,
                                'version', e.version,
                                'amount_cents', e.amount_cents,
                                'paid_cents', public.fin__paid(e.id),
                                'outstanding_cents', CASE WHEN e.cancelled_at IS NOT NULL THEN 0
                                                          ELSE e.amount_cents - public.fin__paid(e.id) END,
                                'is_cancelled', e.cancelled_at IS NOT NULL)
                    END,
           'created_at', s.created_at,
           'created_by_name', public.fin__user_name(s.created_by),
           'superseded_at', s.superseded_at)
  FROM public.fin_hk_statements s
  LEFT JOIN public.users u ON u.id = s.payee_user_id
  LEFT JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
  WHERE s.clinic_id = p_clinic AND s.id = p_id
$$;

-- Month payload of fin_hk_month / fin_hk_close_month / fin_hk_reopen_month: the computation, the month status, the
-- active statements and every line / piece / lab cost dated in the month (voided ones included, flagged).
CREATE OR REPLACE FUNCTION public.fin__hk_month_json(p_clinic uuid, p_month date, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_month date := public.fin__month_start(p_month);
  v_next date := (public.fin__month_start(p_month) + interval '1 month')::date;
BEGIN
  RETURN public.fin__hk_compute(p_clinic, v_month)
    || public.fin__hk_month_row_json(p_clinic, v_month)
    || jsonb_build_object(
         'today', p_today,
         'current_month', public.fin__month_start(p_today),
         'can_write', public.has_permission('finance'),
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
           WHERE c.clinic_id = p_clinic AND c.day >= v_month AND c.day < v_next), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Finance RPCs fin_hk_* (SECURITY DEFINER, search_path = public, clinic from the session). Reads start with
--    fin__require_read() (finance or finance_readonly), writes with fin__require_write() ('finance').
--    Save RPCs (0020 §3.1 rules): p_id is the client uuid, p_version = 0 means create; a create retry with an id
--    already in the clinic → already_saved, an id of another clinic → 'Kayıt kaydedilemedi.' (PT409). Update: not
--    found → PT404, no-op → already_saved (checked before the version), else the version must match (PT409).
--    Each returns { already_saved, record }.
-- ---------------------------------------------------------------------------

-- Everything the Hakediş screens need besides the month figures. Inactive doctors and payees are included (flagged).
CREATE OR REPLACE FUNCTION public.fin_hk_reference()
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
    'current_month', public.fin__month_start(v_today),
    'can_write', public.has_permission('finance'),
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
    -- Payees: staff with a doctors row, plus the owner (management share). Reception has no hakediş.
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
      WHERE u.clinic_id = v_clinic
        AND (d.id IS NOT NULL OR u.role::text = 'owner')), '[]'::jsonb),
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
    'lab_names', public.fin__hk_lab_names(v_clinic));
END;
$$;

-- One month: figures, status, statements, lines (with resolved segment, rule and lab part), pieces, lab costs.
-- NULL → the current month; any day of a month means that month.
CREATE OR REPLACE FUNCTION public.fin_hk_month(p_month date)
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
  RETURN public.fin__hk_month_json(v_clinic, public.fin__month_start(public.fin__day(coalesce(p_month, v_today))),
                                   v_today);
END;
$$;

-- Patient marks (own-portfolio doctor / child), sorted by patient name.
CREATE OR REPLACE FUNCTION public.fin_hk_marks()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(public.fin__hk_mark_json(v_clinic, m.id) ORDER BY m.patient_name COLLATE "tr-x-icu", m.id)
    FROM public.fin_hk_patient_marks m
    WHERE m.clinic_id = v_clinic), '[]'::jsonb);
END;
$$;

-- Payee rule. Fields by kind:
--   ciro_share         doctor, segment, share_bp, deductions
--   ortho_lab_first    doctor, share_bp, deductions (no segment)
--   implant_piece      doctor, piece_cents (no share, no deductions)
--   clinic_ciro_share  share_bp only (no doctor, no segment, no deductions)
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
  IF p_kind IS NULL OR p_kind NOT IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share') THEN
    RAISE EXCEPTION 'Geçersiz kural türü.';
  END IF;

  IF p_kind = 'clinic_ciro_share' THEN
    IF p_doctor_id IS NOT NULL THEN
      RAISE EXCEPTION 'Yönetim payı kuralında hekim seçilmez.';
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
  IF p_kind IN ('implant_piece', 'clinic_ciro_share') AND (v_cash <> 0 OR v_card <> 0 OR v_transfer <> 0
                                                            OR v_financing <> 0) THEN
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

  -- Payee: a staff member of the clinic with a doctors row, or the owner.
  SELECT * INTO v_payee FROM public.users u WHERE u.id = p_payee_user_id AND u.clinic_id = v_clinic;
  IF v_payee.id IS NULL THEN
    RAISE EXCEPTION 'Hakediş alacak kişi bulunamadı.';
  END IF;
  IF v_payee.role::text <> 'owner' AND NOT EXISTS (
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

  SELECT r.id INTO v_other
  FROM public.fin_hk_rules r
  WHERE r.clinic_id = v_clinic
    AND r.id <> p_id
    AND r.kind = p_kind
    AND r.doctor_id IS NOT DISTINCT FROM p_doctor_id
    AND r.segment IS NOT DISTINCT FROM p_segment
    AND r.from_month <= coalesce(v_to, DATE '9999-12-01')
    AND v_from <= coalesce(r.to_month, DATE '9999-12-01')
  ORDER BY r.from_month, r.id
  LIMIT 1;
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

-- Revenue line (manual entry). TRY: try_cents may be NULL (= amount) and must equal the amount; other currencies need
-- the TL value. A negative amount is a correction line (TL value and implant part carry the same sign). patient_ref
-- NULL → normalized patient name. Not in a closed month (old and new day), never a future day.
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
  v_clinic uuid := public.fin__require_write();
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

-- Voids a line (reason 3..500). Already voided → already_saved. Not in a closed month.
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
  v_clinic uuid := public.fin__require_write();
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

-- Implants placed (qty, negative = correction). Not in a closed month, never a future day.
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
  v_clinic uuid := public.fin__require_write();
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
  v_clinic uuid := public.fin__require_write();
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

-- Patient mark (one per patient key). Changes apply to every month that is computed afterwards; closed months keep
-- their statements.
CREATE OR REPLACE FUNCTION public.fin_hk_save_mark(
  p_id uuid,
  p_version integer,
  p_patient_ref text,
  p_patient_name text,
  p_own_doctor_id uuid,
  p_is_child boolean,
  p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_patient_marks%ROWTYPE;
  v_name text;
  v_ref text;
  v_child boolean := coalesce(p_is_child, false);
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
  v_name := public.fin__hk_patient_name(p_patient_name);
  v_ref := public.fin__hk_patient_ref(p_patient_ref, v_name);
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
    IF (v_row.patient_ref, v_row.patient_name, v_row.own_doctor_id, v_row.is_child, v_row.note)
       IS NOT DISTINCT FROM (v_ref, v_name, p_own_doctor_id, v_child, v_note) THEN
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

  IF p_version = 0 THEN
    BEGIN
      INSERT INTO public.fin_hk_patient_marks (id, clinic_id, patient_ref, patient_name, own_doctor_id, is_child, note,
                                               created_by, updated_by)
      VALUES (p_id, v_clinic, v_ref, v_name, p_own_doctor_id, v_child, v_note, v_user, v_user)
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

-- Lab cost per lab invoice / charge for one patient (TL cents, negative = correction). The lab name is chosen from
-- fin_hk_reference().lab_names or typed. Not in a closed month, never a future day.
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
  v_clinic uuid := public.fin__require_write();
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
  v_clinic uuid := public.fin__require_write();
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

-- Month close (finance write). Only a month before the current one; version = month row version (0 = no row).
-- Refuses unruled lines / pieces unless p_accept_unruled, and any negative payee total. A non-cancelled entry linked
-- by an earlier statement of this month (a close before a reopen) that this close does not account for is refused:
-- its payee has no payable amount now (dropped out of the calculation because the rule moved or ended, or total 0),
-- or the payee's entry now lives under another counterparty (doctor relinked). The ledger would otherwise owe it on
-- top of the new figures. Then, per payee:
--   * total > 0: physician counterparty of the payee's doctors row (created, or an unlinked physician counterparty of
--     the same name is linked, when missing); entitlement entry 'entitlement:<cp>:<YYYY-MM>' created through
--     fin_add_entitlement, or its amount / description updated (never below what is already paid; a cancelled entry
--     is refused);
--   * total = 0: no entry (an existing non-cancelled entry for that month is refused: it can only be cancelled; a
--     cancelled entry is final and blocks a later non-zero close of that month for that payee);
--   * a statement (the computed payee object) linked to the entry. Earlier active statements are superseded.
-- Every refusal rolls the whole close back (supersede stamps, created / linked counterparties, entries).
-- Already closed → the month payload with already_saved = true.
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
    IF v_doctor IS NOT NULL THEN
      SELECT cp.id, cp.is_active INTO v_cp, v_cp_active
      FROM public.fin_counterparties cp
      WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_doctor;
    END IF;
    IF v_cp IS NOT NULL THEN
      SELECT e.id, e.amount_cents, e.cancelled_at IS NOT NULL, e.description
        INTO v_entry, v_entry_amount, v_entry_cancelled, v_entry_desc
      FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic
        AND e.source_key = 'entitlement:' || v_cp::text || ':' || to_char(v_month, 'YYYY-MM')
      FOR UPDATE;
    END IF;

    IF v_total = 0 THEN
      IF v_entry IS NOT NULL AND NOT v_entry_cancelled THEN
        RAISE EXCEPTION '% için bu ayın hakediş kaydı zaten var (%), yeni hesaplanan tutar ise 0. Tutar yanlışsa satırları / kuralları düzeltin. Tutar gerçekten 0 ise kaydı Finans ekranında iptal edin, sonra ayı kapatın. İptal geri alınamaz; bu hekime aynı ay için yeniden hakediş kaydı açılamaz.',
          v_name, public.fin__hk_tl(v_entry_amount);
      END IF;
      v_entry := NULL;
    ELSE
      IF v_doctor IS NULL THEN
        RAISE EXCEPTION '% için hekim kaydı yok, hakediş cari kaydı açılamadı. Önce Ekip ekranından hekim kaydını ekleyin.',
          v_name;
      END IF;

      IF v_cp IS NULL THEN
        -- An unlinked physician counterparty with the payee's name is linked; any other name clash is refused.
        SELECT cp.id, cp.kind, cp.doctor_id, cp.is_active
          INTO v_other, v_other_kind, v_other_doctor, v_other_active
        FROM public.fin_counterparties cp
        WHERE cp.clinic_id = v_clinic AND cp.normalized_name = public.fin__normalize_name(v_name);
        IF v_other IS NOT NULL THEN
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
          AND e.source_key = 'entitlement:' || v_cp::text || ':' || to_char(v_month, 'YYYY-MM')
        FOR UPDATE;
      END IF;

      IF NOT coalesce(v_cp_active, false) THEN
        RAISE EXCEPTION '% için hekim cari kaydı pasif. Cariler ekranından aktifleştirin, sonra ayı kapatın.', v_name;
      END IF;

      -- A live entry of this payee linked by any earlier statement of the month must be the one found above (same
      -- counterparty key); one under another counterparty (doctor relinked since) would be a second payable. Every
      -- earlier statement is checked, so a later statement without an entry cannot hide an older live one.
      IF EXISTS (
        SELECT 1
        FROM public.fin_hk_statements s
        JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
        WHERE s.clinic_id = v_clinic AND s.month = v_month AND s.payee_user_id = v_payee
          AND e.cancelled_at IS NULL AND e.id IS DISTINCT FROM v_entry
      ) THEN
        RAISE EXCEPTION '% için bu ayın hakediş kaydı başka bir cari kaydında duruyor. Önce o kaydı Finans ekranında düzeltin veya iptal edin, sonra ayı kapatın.',
          v_name;
      END IF;

      v_desc := public.fin__hk_description(v_p, v_month, v_doctor);

      IF v_entry IS NULL THEN
        v_entry := gen_random_uuid();
        PERFORM public.fin_add_entitlement(v_entry, v_cp, to_char(v_month, 'YYYY-MM'), v_total, 0, NULL, NULL, v_desc);
      ELSIF v_entry_cancelled THEN
        RAISE EXCEPTION '% için bu ayın hakediş kaydı iptal edilmiş; iptal geri alınamadığı için aynı ay için yeni kayıt açılamaz. Ayı kapatmak için Cariler ekranında hekimi yeni bir hekim carisine bağlayın (eski cariyi bağlantısız bırakıp adını değiştirin).',
          v_name;
      ELSE
        v_paid := public.fin__paid(v_entry);
        IF v_total < v_paid THEN
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

-- Reopen a closed month: clinic owner with 'finance' only, and only while no later month is closed (writes into this
-- month would change the later month's ortho walk). Statements are superseded (rows kept); ledger entries stay as they
-- are: the next close updates their amount, and refuses a live entry of an earlier statement that it does not account
-- for (payee no longer payable, or the entry under another counterparty). Already open → the month payload with
-- already_saved = true.
CREATE OR REPLACE FUNCTION public.fin_hk_reopen_month(
  p_month date,
  p_version integer)
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
BEGIN
  IF public.current_app_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Kapatılmış ayı yalnızca klinik sahibi yeniden açabilir.' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Geçersiz tarih.';
  END IF;
  v_month := public.fin__month_start(public.fin__day(p_month));

  -- Same order as fin_hk_close_month: the clinic's close lock, then the month lock.
  PERFORM pg_advisory_xact_lock(public.fin__hk_close_lock(v_clinic));
  PERFORM pg_advisory_xact_lock(public.fin__hk_month_lock(v_clinic, v_month));

  SELECT * INTO v_row FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = v_month FOR UPDATE;
  IF v_row.id IS NULL OR v_row.status = 'open' THEN
    RETURN public.fin__hk_month_json(v_clinic, v_month, v_today) || jsonb_build_object('already_saved', true);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fin_hk_months m
    WHERE m.clinic_id = v_clinic AND m.month > v_month AND m.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Önce sonraki kapalı ayları yeniden açın.';
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.fin_hk_months m
  SET status = 'open', reopened_at = now(), reopened_by = v_user
  WHERE m.clinic_id = v_clinic AND m.id = v_row.id;

  UPDATE public.fin_hk_statements s
  SET superseded_at = now(), superseded_by = v_user
  WHERE s.clinic_id = v_clinic AND s.month = v_month AND s.superseded_at IS NULL;

  RETURN public.fin__hk_month_json(v_clinic, v_month, v_today) || jsonb_build_object('already_saved', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Self-service RPCs (Hakedişim). Any active staff member; no finance permission. SECURITY DEFINER, but every
--    query is limited to the caller (payee_user_id = current_app_user_id()): never another payee's figures or rates,
--    other doctors' lines, warnings, or ledger data beyond the caller's own entitlement entry.
-- ---------------------------------------------------------------------------

-- The caller's months, newest first: from the earliest month of the caller's rules (at most 60 months back) to the
-- current month. Closed months show the statement total and the linked entry's paid / remaining; open months the
-- live estimate (and what is already paid on the month's entitlement entry, if one exists).
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
  v_cp uuid;
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

  SELECT cp.id INTO v_cp
  FROM public.doctors d
  JOIN public.fin_counterparties cp ON cp.clinic_id = d.clinic_id AND cp.doctor_id = d.id
  WHERE d.clinic_id = v_clinic AND d.user_id = v_user;

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
      ) THEN
        SELECT (p ->> 'total_cents')::bigint INTO v_total
        FROM jsonb_array_elements(public.fin__hk_compute(v_clinic, v_m) -> 'payees') p
        WHERE (p ->> 'payee_user_id') = v_user::text;
      END IF;
      IF v_cp IS NOT NULL THEN
        SELECT e.id INTO v_entry
        FROM public.fin_entries e
        WHERE e.clinic_id = v_clinic
          AND e.source_key = 'entitlement:' || v_cp::text || ':' || to_char(v_m, 'YYYY-MM');
      END IF;
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

-- One month of the caller: own payee object (frozen statement breakdown when the month is closed, live estimate
-- otherwise), the lines counted under the caller's own ciro_share / ortho rules (counted = true) plus the unruled lines
-- of the caller's own doctors row (counted = false; they carry no other payee's figures), never a line counted under
-- another payee's rule (even of a doctor named in one of the caller's rules); the pieces of the caller's implant rule
-- doctors, the lab costs of the caller's ortho patients, and the caller's own statement / entitlement entry. A caller
-- without any rule gets {has_rules: false}.
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
  v_cp uuid;
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
    IF v_active THEN
      SELECT coalesce(jsonb_agg(public.fin__hk_self_payee(p)), '[]'::jsonb) INTO v_payees
      FROM jsonb_array_elements(public.fin__hk_compute(v_clinic, v_month) -> 'payees') p
      WHERE (p ->> 'payee_user_id') = v_user::text;
    END IF;
    SELECT cp.id INTO v_cp
    FROM public.doctors d
    JOIN public.fin_counterparties cp ON cp.clinic_id = d.clinic_id AND cp.doctor_id = d.id
    WHERE d.clinic_id = v_clinic AND d.user_id = v_user;
    IF v_cp IS NOT NULL THEN
      SELECT e.id INTO v_entry
      FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic
        AND e.source_key = 'entitlement:' || v_cp::text || ':' || to_char(v_month, 'YYYY-MM');
    END IF;
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
-- 6. 0022 functions replaced with the same signature (CREATE OR REPLACE keeps the ACL; no overload): the seven
--    fin_hk_* tables join the 'Finans geçmişi' entity filter and the owner JSON export. Bodies otherwise verbatim.
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
       'fin_hk_months', 'fin_hk_statements') THEN
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

-- Owner JSON export manifest (0020 §3.8, 0022) + the seven tables of this part.
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
      jsonb_build_object('name', 'audit_logs', 'filter', 'entity_type LIKE ''fin\_%''', 'row_count',
        (SELECT count(*) FROM public.audit_logs t WHERE t.clinic_id = v_clinic AND left(t.entity_type, 4) = 'fin_'))));
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs (fin_hk_*) granted to authenticated, internals (fin__hk_*, fin__trg_hk_*) never; plus its
--    self-checks over every fin_* function and table. The hk_* self-service RPCs are outside its name pattern.
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
BEGIN
  -- 1. Tables: RLS, exactly one SELECT policy <table>_select_finance, audit / no-delete / no-truncate triggers,
  --    fin_touch on the versioned tables, fin_hk_refs / fin_hk_guard / fin_hk_statement_guard where they belong.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['fin_hk_rules', 'fin_hk_lines', 'fin_hk_pieces', 'fin_hk_patient_marks', 'fin_hk_lab_costs',
                    'fin_hk_months', 'fin_hk_statements']) AS t(tbl)
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t.tbl AND c.relrowsecurity)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tbl
                      AND p.policyname = t.tbl || '_select_finance' AND p.cmd = 'SELECT')
     OR EXISTS (
          SELECT 1
          FROM unnest(ARRAY['audit_row_change', 'fin_no_delete', 'fin_no_truncate']
                      || CASE WHEN t.tbl <> 'fin_hk_statements' THEN ARRAY['fin_touch']
                              ELSE ARRAY['fin_hk_statement_guard'] END
                      || CASE WHEN t.tbl <> 'fin_hk_months' THEN ARRAY['fin_hk_refs'] ELSE ARRAY[]::text[] END
                      || CASE WHEN t.tbl IN ('fin_hk_lines', 'fin_hk_pieces', 'fin_hk_lab_costs')
                              THEN ARRAY['fin_hk_guard'] ELSE ARRAY[]::text[] END) AS g(name)
          WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tr
                            WHERE tr.tgrelid = format('public.%I', t.tbl)::regclass
                              AND tr.tgname = g.name AND NOT tr.tgisinternal));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş tablo kurulumu eksik: %', v_bad;
  END IF;

  -- 2. Public RPC signatures (no accidental overload; fin__harden_privileges refuses overloads of fin_* too).
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
    'public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text)',
    'public.fin_hk_save_lab_cost(uuid,integer,date,uuid,text,text,text,bigint,text)',
    'public.fin_hk_void_lab_cost(uuid,integer,text)',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.fin_hk_reopen_month(date,integer)',
    'public.hk_my_months()',
    'public.hk_my_month(date)',
    'public.fin_audit_list(jsonb,jsonb)',
    'public.fin_export_manifest()',
    'public.fin__harden_privileges()',
    'public.fin__trg_touch()',
    'public.fin_add_entitlement(uuid,uuid,text,bigint,bigint,date,uuid,text)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş fonksiyon imzaları beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Self-service RPCs: one version each, SECURITY DEFINER + search_path, EXECUTE for authenticated only.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hk_my_months', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR p.proacl IS NULL
         OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'hk_* yetkileri beklenen gibi değil: %', v_bad;
  END IF;
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('hk_my_months', 'hk_my_month')
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'hk_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- 4. No fin_hk__* name exists (fin__harden_privileges would grant it as a public RPC).
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_hk\_\_%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'fin_hk__* adlı iç fonksiyon API''ye açılır; fin__hk_* kullanılmalı: %', v_bad;
  END IF;

  -- 5. Pure helpers and an empty computation (runs every query of the engine once).
  IF public.fin__hk_tl(-123456) IS DISTINCT FROM '-1.234,56 TL'
     OR public.fin__hk_tl(5) IS DISTINCT FROM '0,05 TL'
     OR public.fin__hk_pct(2500) IS DISTINCT FROM '%25'
     OR public.fin__hk_pct(1250) IS DISTINCT FROM '%12,5'
     OR public.fin__hk_pct(1) IS DISTINCT FROM '%0,01'
     OR round((-5)::numeric * 1000 / 10000) IS DISTINCT FROM (-1)::numeric
     OR round((5)::numeric * 1000 / 10000) IS DISTINCT FROM (1)::numeric
     OR public.fin__hk_patient_ref(NULL, '  Öz  Denetim ') IS DISTINCT FROM 'öz denetim' THEN
    RAISE EXCEPTION 'Hakediş yardımcı fonksiyonları beklenen sonucu vermiyor.';
  END IF;
  v_j := public.fin__hk_compute(gen_random_uuid(), DATE '2024-01-15');
  IF v_j IS DISTINCT FROM jsonb_build_object('month', DATE '2024-01-01', 'payees', '[]'::jsonb,
                                             'clinic_total_cents', 0, 'warnings', '[]'::jsonb) THEN
    RAISE EXCEPTION 'Boş klinik hesabı beklenen gibi değil: %', left(v_j::text, 300);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.2 Replay inside a block that is always rolled back: temporary clinic 'p30-test-hk-selfcheck-<random>' with an
--     owner (finance holder, also a doctors row) and three doctors A (ortho, lab first), B (ciro share standard /
--     child, implants) and C (no rule). Made-up rates and amounts only. auth.uid() is simulated through
--     request.jwt.claims (and request.jwt.claim.sub / .role for older auth.uid() bodies), as in 0027. Every RPC path
--     that matters runs once here (rules, overlap, lines, marks, pieces, lab costs, month figures, close with and
--     without unruled lines, lock, reopen, re-close updating the ledger amount, doctor self-service and its
--     boundary incl. a line of B counted under the owner's rule, month order of close / reopen / writes, a payee
--     dropping out on re-close), so a runtime error or a wrong figure fails the migration instead of production.
--     Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p30-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
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
  v_c uuid := gen_random_uuid();
  v_c_doc uuid := gen_random_uuid();
  v_rule_bs uuid := gen_random_uuid();
  v_rule_bc uuid := gen_random_uuid();
  v_rule_bi uuid := gen_random_uuid();
  v_rule_a uuid := gen_random_uuid();
  v_rule_o uuid := gen_random_uuid();
  v_rule_ob uuid := gen_random_uuid();
  v_l1 uuid := gen_random_uuid();
  v_l2 uuid := gen_random_uuid();
  v_l3 uuid := gen_random_uuid();
  v_l4 uuid := gen_random_uuid();
  v_l5 uuid := gen_random_uuid();
  v_l6 uuid := gen_random_uuid();
  v_l7 uuid := gen_random_uuid();
  v_l8 uuid := gen_random_uuid();
  v_j jsonb;
  v_err text;
  v_state text;
  v_n bigint;
  v_ver integer;
  v_entry_b uuid;
  v_entry_a uuid;
  v_ver_e integer;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P30', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p30-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p30-sc-a-' || v_tag || '@example.invalid', true),
      (v_b, v_clinic, v_b_auth, 'doctor', 'Öz denetim Hekim B', 'p30-sc-b-' || v_tag || '@example.invalid', true),
      (v_c, v_clinic, NULL, 'doctor', 'Öz denetim Hekim C', 'p30-sc-c-' || v_tag || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_own_doc, v_clinic, v_own), (v_a_doc, v_clinic, v_a), (v_b_doc, v_clinic, v_b), (v_c_doc, v_clinic, v_c);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by)
    VALUES (v_clinic, v_own, 'finance', v_own);

    -- From here on the caller is the owner (finance holder).
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;

    -- Rules (made-up rates).
    PERFORM public.fin_hk_save_rule(v_rule_bs, 0, v_b, v_b_doc, 'ciro_share', 'standard', 2500, NULL,
                                    0, 1500, 500, 800, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_bc, 0, v_b, v_b_doc, 'ciro_share', 'child', 4000, NULL,
                                    0, 1500, 500, 800, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_bi, 0, v_b, v_b_doc, 'implant_piece', NULL, NULL, 150000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_a, 0, v_a, v_a_doc, 'ortho_lab_first', NULL, 5000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_o, 0, v_own, NULL, 'clinic_ciro_share', NULL, 300, NULL,
                                    0, 0, 0, 0, DATE '2024-01-15', NULL, '');

    -- Overlapping rule of the same (kind, doctor, segment) → PT409.
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_b, v_b_doc, 'ciro_share', 'standard', 2000, NULL,
                                      0, 0, 0, 0, DATE '2024-06-01', NULL, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM 'PT409' THEN
      v_fail := array_append(v_fail, 'çakışan kural: ' || coalesce(v_state, '-'));
    END IF;

    -- Child mark, lines, pieces, lab costs.
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Çocuk', NULL, true, '');
    PERFORM public.fin_hk_save_line(v_l1, 0, DATE '2024-01-08', v_b_doc, 'Hasta Bir', NULL, 'card', 'TRY',
                                    80000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(v_l2, 0, DATE '2024-01-09', v_b_doc, 'Hasta Çocuk', NULL, 'transfer', 'TRY',
                                    60000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(v_l3, 0, DATE '2024-01-10', v_b_doc, 'Hasta Bir', NULL, 'cash', NULL,
                                    100000, NULL, 40000, NULL, 'implant içerir');
    PERFORM public.fin_hk_save_line(v_l4, 0, DATE '2024-01-05', v_a_doc, 'Hasta Orto', NULL, 'cash', 'TRY',
                                    3000000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(v_l5, 0, DATE '2024-01-12', v_c_doc, 'Hasta Diğer', NULL, 'cash', 'TRY',
                                    10000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(v_l6, 0, DATE '2024-02-03', v_a_doc, 'Hasta Orto', NULL, 'cash', 'TRY',
                                    1000000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_piece(gen_random_uuid(), 0, DATE '2024-01-10', v_b_doc, 'Hasta Bir', NULL, 3, '');
    PERFORM public.fin_hk_save_piece(gen_random_uuid(), 0, DATE '2024-01-15', v_b_doc, 'Hasta Bir', NULL, -1,
                                     'düzeltme');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-01-20', v_a_doc, 'Hasta Orto', NULL,
                                        'Lab Bir', 1200000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-01-25', v_a_doc, 'Hasta Orto', NULL,
                                        'Lab İki', 800000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-02-10', v_a_doc, 'Hasta Orto', NULL,
                                        'Lab Bir', 400000, '');

    -- Idempotent create retry.
    v_j := public.fin_hk_save_line(v_l1, 0, DATE '2024-01-08', v_b_doc, 'Hasta Bir', NULL, 'card', 'TRY',
                                   80000, NULL, NULL, NULL, '');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'satır tekrar deneme already_saved değil');
    END IF;

    -- Lab names for the picker: distinct, two labs.
    v_j := public.fin_hk_reference();
    IF v_j -> 'lab_names' IS DISTINCT FROM '["Lab Bir", "Lab İki"]'::jsonb
       OR jsonb_array_length(v_j -> 'rules') <> 5 THEN
      v_fail := array_append(v_fail, 'referans: ' || left(v_j::text, 300));
    END IF;

    -- January: B standard card 80000 − 15 % = 68000 + cash 100000 − implant 40000 = 60000 → base 128000 × 25 % =
    -- 32000; B child transfer 60000 − 5 % = 57000 × 40 % = 22800; B implants (3 − 1) × 1500 TL = 300000;
    -- A lab costs 2000000 (dated after the payment, same month) recovered from 3000000 → base 1000000 × 50 % =
    -- 500000; owner 3 % of the gross 3250000 = 97500; C unruled.
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 3250000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_b::text) IS DISTINCT FROM 354800
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_a::text) IS DISTINCT FROM 500000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_own::text) IS DISTINCT FROM 97500
       OR (SELECT (c #>> '{by_method,card,deduction}')::bigint
           FROM jsonb_array_elements(v_j -> 'payees') p
           CROSS JOIN LATERAL jsonb_array_elements(p -> 'components') c
           WHERE (c ->> 'rule_id') = v_rule_bs::text) IS DISTINCT FROM 12000
       OR (SELECT (c ->> 'qty')::bigint
           FROM jsonb_array_elements(v_j -> 'payees') p
           CROSS JOIN LATERAL jsonb_array_elements(p -> 'components') c
           WHERE (c ->> 'rule_id') = v_rule_bi::text) IS DISTINCT FROM 2
       OR (SELECT count(*) FROM jsonb_array_elements(v_j -> 'warnings') w
           WHERE (w ->> 'code') = 'UNRULED_LINES' AND (w ->> 'doctor_id') = v_c_doc::text
             AND (w ->> 'try_cents')::bigint = 10000 AND (w ->> 'count')::bigint = 1) <> 1
       OR (SELECT (l ->> 'lab_part')::bigint FROM jsonb_array_elements(v_j -> 'lines') l
           WHERE (l ->> 'id') = v_l4::text) IS DISTINCT FROM 2000000
       OR (SELECT l ->> 'resolved_segment' FROM jsonb_array_elements(v_j -> 'lines') l
           WHERE (l ->> 'id') = v_l2::text) IS DISTINCT FROM 'child'
       OR (SELECT l ->> 'rule_id' FROM jsonb_array_elements(v_j -> 'lines') l
           WHERE (l ->> 'id') = v_l5::text) IS NOT NULL
       OR (v_j ->> 'status') IS DISTINCT FROM 'open' OR (v_j ->> 'version')::integer IS DISTINCT FROM 0 THEN
      v_fail := array_append(v_fail, 'ocak hesabı: ' || left(v_j::text, 800));
    END IF;

    -- February: the February lab cost (dated after the payment) is recovered from the February payment only:
    -- 1000000 − 400000 = 600000 × 50 % = 300000; owner 3 % of 1000000 = 30000.
    v_j := public.fin_hk_month(DATE '2024-02-20');
    IF (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
        WHERE (p ->> 'payee_user_id') = v_a::text) IS DISTINCT FROM 300000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_own::text) IS DISTINCT FROM 30000
       OR (SELECT (p ->> 'total_cents')::bigint FROM jsonb_array_elements(v_j -> 'payees') p
           WHERE (p ->> 'payee_user_id') = v_b::text) IS DISTINCT FROM 0
       OR (SELECT (l ->> 'lab_part')::bigint FROM jsonb_array_elements(v_j -> 'lines') l
           WHERE (l ->> 'id') = v_l6::text) IS DISTINCT FROM 400000 THEN
      v_fail := array_append(v_fail, 'şubat hesabı: ' || left(v_j::text, 800));
    END IF;

    -- Close refuses unruled lines without acceptance, and a stale version.
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-01-01', 0, false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'Kuralı olmayan hekim satırları var:%' THEN
      v_fail := array_append(v_fail, 'kuralsız satırla kapatma: ' || coalesce(v_err, '-'));
    END IF;
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-01-01', 7, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM 'PT409' THEN
      v_fail := array_append(v_fail, 'eski sürümle kapatma: ' || coalesce(v_state, '-'));
    END IF;

    -- Close: three statements, three physician counterparties created, entitlement entries with the totals.
    v_j := public.fin_hk_close_month(DATE '2024-01-01', 0, true);
    SELECT count(*) INTO v_n
    FROM public.fin_hk_statements s
    JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
    WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NULL
      AND e.source_key LIKE 'entitlement:%:2024-01'
      AND e.amount_cents = s.total_cents
      AND ((s.payee_user_id = v_b AND s.total_cents = 354800)
           OR (s.payee_user_id = v_a AND s.total_cents = 500000)
           OR (s.payee_user_id = v_own AND s.total_cents = 97500));
    IF v_n <> 3 OR (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR coalesce((v_j ->> 'already_saved')::boolean, true)
       OR jsonb_array_length(v_j -> 'statements') <> 3 THEN
      v_fail := array_append(v_fail, 'ay kapatma: ' || v_n || ' / ' || left(v_j::text, 500));
    END IF;
    SELECT count(*) INTO v_n
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.kind = 'physician' AND cp.is_active
      AND cp.doctor_id IN (v_own_doc, v_a_doc, v_b_doc) AND cp.note = 'Hakediş için otomatik oluşturuldu';
    IF v_n <> 3 THEN
      v_fail := array_append(v_fail, 'hekim cari kayıtları ' || v_n);
    END IF;
    SELECT s.fin_entry_id INTO v_entry_b
    FROM public.fin_hk_statements s
    WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.payee_user_id = v_b
      AND s.superseded_at IS NULL;

    -- Closed month: no new line, no void.
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-01-20', v_b_doc, 'Hasta Bir', NULL, 'cash',
                                      'TRY', 5000, NULL, NULL, NULL, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.' THEN
      v_fail := array_append(v_fail, 'kapalı aya satır: ' || coalesce(v_err, '-'));
    END IF;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_void_line(v_l1, (SELECT l.version FROM public.fin_hk_lines l WHERE l.id = v_l1),
                                      'öz denetim');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.' THEN
      v_fail := array_append(v_fail, 'kapalı ayda iptal: ' || coalesce(v_err, '-'));
    END IF;

    -- Reopen (owner), a correction line, close again: the same ledger entry gets the new amount.
    -- B standard card 80000 − 20000 = 60000 − 15 % = 51000 + cash 60000 → base 111000 × 25 % = 27750;
    -- B total 27750 + 22800 + 300000 = 350550; owner 3 % of 3230000 = 96900.
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_j := public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    IF (v_j ->> 'status') IS DISTINCT FROM 'open' OR jsonb_array_length(v_j -> 'statements') <> 0 THEN
      v_fail := array_append(v_fail, 'yeniden açma: ' || left(v_j::text, 300));
    END IF;
    PERFORM public.fin_hk_save_line(v_l7, 0, DATE '2024-01-28', v_b_doc, 'Hasta Bir', NULL, 'card', 'TRY',
                                    -20000, NULL, NULL, NULL, 'düzeltme');
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_j := public.fin_hk_close_month(DATE '2024-01-01', v_ver, true);
    SELECT count(*) INTO v_n
    FROM public.fin_hk_statements s
    JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
    WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NULL
      AND e.amount_cents = s.total_cents
      AND ((s.payee_user_id = v_b AND s.total_cents = 350550 AND s.fin_entry_id = v_entry_b)
           OR (s.payee_user_id = v_a AND s.total_cents = 500000)
           OR (s.payee_user_id = v_own AND s.total_cents = 96900));
    IF v_n <> 3 OR (v_j ->> 'status') IS DISTINCT FROM 'closed' THEN
      v_fail := array_append(v_fail, 'yeniden kapatma: ' || v_n || ' / ' || left(v_j::text, 500));
    END IF;
    SELECT count(*) INTO v_n
    FROM public.fin_hk_statements s
    WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NOT NULL;
    IF v_n <> 3 THEN
      v_fail := array_append(v_fail, 'eski dökümler ' || v_n);
    END IF;

    -- March: an 'own' ciro rule on doctor B paid to the owner, and one line of B in that segment. It is counted under
    -- the owner's rule, so doctor B's own view must not show it (nor the owner's rule).
    PERFORM public.fin_hk_save_rule(v_rule_ob, 0, v_own, v_b_doc, 'ciro_share', 'own', 3000, NULL,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    PERFORM public.fin_hk_save_line(v_l8, 0, DATE '2024-03-05', v_b_doc, 'Hasta Sahip Portföy', NULL, 'cash', 'TRY',
                                    50000, NULL, NULL, 'own', '');

    -- Doctor B: only own figures, own lines and own entry; no finance read.
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_b_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_b_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR jsonb_array_length(v_j -> 'payees') <> 1
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 350550
       OR (v_j #>> '{statement,total_cents}')::bigint IS DISTINCT FROM 350550
       OR (v_j #>> '{entitlement,remaining_cents}')::bigint IS DISTINCT FROM 350550
       OR jsonb_array_length(v_j -> 'lines') <> 4
       OR jsonb_array_length(v_j -> 'pieces') <> 2
       OR jsonb_array_length(v_j -> 'lab_costs') <> 0
       OR position(v_a::text IN v_j::text) > 0
       OR position(v_a_doc::text IN v_j::text) > 0
       OR position(v_own::text IN v_j::text) > 0
       OR position(v_c_doc::text IN v_j::text) > 0
       OR position('Hasta Orto' IN v_j::text) > 0
       OR position('Hasta Diğer' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim B ocak: ' || left(v_j::text, 800));
    END IF;
    -- March: B's line under the owner's 'own' rule is not listed (B's rules are active, B's total is 0).
    v_j := public.hk_my_month(DATE '2024-03-01');
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR jsonb_array_length(v_j -> 'lines') <> 0
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 0
       OR position('Hasta Sahip Portföy' IN v_j::text) > 0
       OR position(v_own::text IN v_j::text) > 0
       OR position(v_rule_ob::text IN v_j::text) > 0
       OR position(v_l8::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim B mart: ' || left(v_j::text, 800));
    END IF;
    -- The 2024 rows are asserted only while they are inside hk_my_months' 60-month window, so a re-run of this file
    -- after 2028-12 still passes.
    v_j := public.hk_my_months();
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR (DATE '2024-01-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                           WHERE (m ->> 'month') = '2024-01-01' AND (m ->> 'status') = 'closed'
                             AND (m ->> 'total_cents')::bigint = 350550 AND (m ->> 'paid_cents')::bigint = 0
                             AND (m ->> 'remaining_cents')::bigint = 350550))
       OR (DATE '2024-02-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                           WHERE (m ->> 'month') = '2024-02-01' AND (m ->> 'status') = 'open'
                             AND (m ->> 'total_cents')::bigint = 0 AND (m ->> 'remaining_cents') IS NULL)) THEN
      v_fail := array_append(v_fail, 'hekim B aylar: ' || left(v_j::text, 500));
    END IF;
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_month(DATE '2024-01-01');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'hekim finans okuması: ' || coalesce(v_state, '-'));
    END IF;

    -- Doctor A (ortho, February still open): live estimate, own lab costs and per-patient lab totals.
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 300000
       OR NOT coalesce((v_j ->> 'is_estimate')::boolean, false)
       OR jsonb_array_length(v_j -> 'lines') <> 1
       OR (v_j #>> '{lines,0,lab_part}')::bigint IS DISTINCT FROM 400000
       OR jsonb_array_length(v_j -> 'lab_costs') <> 3
       OR (v_j #>> '{payees,0,components,0,lab_patients,0,lab_total_cents}')::bigint IS DISTINCT FROM 2400000
       OR (v_j #>> '{payees,0,components,0,lab_patients,0,remaining_cents}')::bigint IS DISTINCT FROM 0
       OR position(v_b::text IN v_j::text) > 0
       OR position(v_own::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A şubat: ' || left(v_j::text, 800));
    END IF;

    -- Back to the owner. February closes after January (A 300000, B 0, owner 30000); then January cannot be reopened
    -- while February is closed, and nothing is written into an earlier open month (it would change the ortho walk of
    -- the closed months after it).
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_close_month(DATE '2024-02-01', 0, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed' OR jsonb_array_length(v_j -> 'statements') <> 3 THEN
      v_fail := array_append(v_fail, 'şubat kapatma: ' || left(v_j::text, 500));
    END IF;
    v_err := NULL;
    BEGIN
      SELECT m.version INTO v_ver
      FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
      PERFORM public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Önce sonraki kapalı ayları yeniden açın.' THEN
      v_fail := array_append(v_fail, 'sonraki ay kapalıyken yeniden açma: ' || coalesce(v_err, '-'));
    END IF;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2023-12-15', v_b_doc, 'Hasta Bir', NULL, 'cash',
                                      'TRY', 5000, NULL, NULL, NULL, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'Bu aydan sonraki bir ay kapatıldı.%' THEN
      v_fail := array_append(v_fail, 'kapalı aydan önceki aya satır: ' || coalesce(v_err, '-'));
    END IF;

    -- A payee dropping out: reopen February, end doctor A's ortho rule in January, close again → refused while A's
    -- February entry is live (the ledger would owe it on top of the new figures). Once it is cancelled the close goes
    -- through with no statement for A.
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-02-01';
    PERFORM public.fin_hk_reopen_month(DATE '2024-02-01', v_ver);
    PERFORM public.fin_hk_save_rule(v_rule_a, (SELECT r.version FROM public.fin_hk_rules r WHERE r.id = v_rule_a),
                                    v_a, v_a_doc, 'ortho_lab_first', NULL, 5000, NULL, 0, 0, 0, 0,
                                    DATE '2024-01-01', DATE '2024-01-01', '');
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-02-01';
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_close_month(DATE '2024-02-01', v_ver, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'Şu kişiler için bu ayın hakediş kaydı zaten var%Öz denetim Hekim A%' THEN
      v_fail := array_append(v_fail, 'düşen kişiyle yeniden kapatma: ' || coalesce(v_err, '-'));
    END IF;
    SELECT e.id, e.version INTO v_entry_a, v_ver_e
    FROM public.fin_hk_statements s
    JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
    WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-02-01' AND s.payee_user_id = v_a
    LIMIT 1;
    IF v_entry_a IS NULL THEN
      v_fail := array_append(v_fail, 'hekim A şubat hakediş kaydı yok');
    ELSE
      PERFORM public.fin_cancel_entry(v_entry_a, v_ver_e, 'öz denetim');
    END IF;
    v_j := public.fin_hk_close_month(DATE '2024-02-01', v_ver, true);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR jsonb_array_length(v_j -> 'statements') <> 2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                  WHERE (st ->> 'payee_user_id') = v_a::text) THEN
      v_fail := array_append(v_fail, 'iptal sonrası yeniden kapatma: ' || left(v_j::text, 500));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p30_selfcheck_rollback';
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

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
