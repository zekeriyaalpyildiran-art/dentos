-- Hakediş v1.3: the bank / cash split of a payee's monthly amount. Part of some payees' monthly total (hakediş or
-- payroll) is paid by bank as an official salary, the rest in cash. The bank part is PART OF the total, never on top of
-- it: totals, statements' totals and everything written to the ledger stay as in 0031. Safe to re-run.
--
-- Contract: hakedis_spec_v13.md on top of 0031_hakedis_payroll.sql (applied and live; not edited; its bodies are the
-- latest definition of every fin_hk function and are copied here with only the changes below). Requires 0030 and 0031.
--
--  * No names, rates or amounts in this file: bank amounts are rule rows the owner enters.
--  * Rule kind bank_portion (UI "Bankadan ödenen sabit tutar"): payee = any active user of the clinic (staff or
--    doctor), no doctor / segment / share / deductions, piece_cents = the fixed monthly amount paid by bank (> 0),
--    from_month / to_month. Overlap per (clinic, kind, payee) like fixed_monthly. Saved by fin_hk_save_rule (finance
--    writers only, as every rule); the fin_hk_rules kind and shape CHECKs are recreated with the new kind (every
--    existing kind and row stays valid).
--  * fin__hk_compute: bank_portion is NOT a component and does not change total_cents. Every payee object gets
--    bank_cents (the active bank_portion amount of the month, null when none) and cash_cents (total_cents - bank_cents,
--    null when bank_cents is null). A payee with a bank_portion rule and no component still appears (total 0, no
--    components, cash_cents negative). Warning BANK_OVER_TOTAL when bank_cents > total_cents (the bank pays more than
--    earned; amounts are not changed, the month close is not blocked). Everything else is the 0031 result; the
--    warnings get the payee id as a last sort key (only ties of equal names were unordered before).
--  * Month close: fin_hk_close_month is not replaced. The entry descriptions (fin__hk_description for the physician
--    entitlement, fin__hk_payroll_description for the staff payroll entry) end with ' · Bankadan <bank> · Elden <cash>'
--    when the payee has bank_cents (the breakdown before it is cut so the whole text stays <= 1000 characters); the
--    statement breakdown (the payee object) carries bank_cents / cash_cents.
--  * Self-service: fin__hk_self_payee keeps bank_cents / cash_cents, so hk_my_month (not replaced) shows them in the
--    caller's own payee object; hk_my_months adds them to every month row (closed: from the statement breakdown).
--  * 'hakedis_prepare' callers see bank_cents / cash_cents and BANK_OVER_TOTAL in fin_hk_month: hakediş data, not
--    ledger data (fin__hk_strip_ledger, not replaced, removes only counterparty ids, NO_COUNTERPARTY and entries).
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). The UI shows error.message verbatim.
--
-- JSON shapes (changes against 0031; months are 'YYYY-MM-01' dates):
--   RuleJson        kind 'bank_portion': doctor_id null, segment null, share_bp null, piece_cents = the monthly bank
--                   amount, deductions 0.
--   Payee           + {bank_cents: bigint | null, cash_cents: bigint | null}. Payees of fin_hk_month /
--                   fin_hk_close_month / fin_hk_reopen_month, statements[].breakdown (closes from now on; older
--                   breakdowns have no such keys) and hk_my_month payees[] (null when the breakdown lacks them).
--                   A bank-only payee: total_cents 0, components [], counterparty_id as a payroll-only payee (the
--                   physician counterparty with a doctors row, else the staff counterparty linked to the user).
--   Warning         + {code: 'BANK_OVER_TOTAL', payee_user_id, payee_name, bank_cents, total_cents}, after the
--                   NO_COUNTERPARTY warnings, by payee name then payee id. Kept for 'hakedis_prepare' callers.
--   hk_my_months()  months[] + {bank_cents, cash_cents} (null when the caller has no bank_portion amount that month).
--
-- RUNBOOK (production is the only database):
--   1. Quiet moment (a second): fin_hk_rules gets its kind constraints replaced in this transaction. SQL editor → New
--      query → paste this file ALONE → Run. One transaction; the self-checks at the end (including a replay in a
--      temporary clinic that is always rolled back) undo everything on any failure.
--   2. Deploy the web build with the bank / cash split afterwards (until step 1 a bank_portion rule is refused with
--      "Geçersiz kural türü." and the payloads carry no bank_cents / cash_cents).
--   Re-running 0031 later puts back its fin__hk_compute / descriptions / fin_hk_save_rule / hk_my_months bodies and its
--   kind constraints (it fails while a bank_portion rule exists): re-run this file afterwards.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) DELETE FROM public.fin_hk_rules WHERE kind = 'bank_portion'; (fin__trg_no_delete allows row deletes from the
--       SQL editor). The 0031 functions ignore such rows in the calculation, but the 0031 kind constraints of (d)
--       refuse them.
--   (b) Re-run the 0031 definitions of fin__hk_compute, fin__hk_description, fin__hk_payroll_description,
--       fin_hk_save_rule and hk_my_months, and the 0030 definition of fin__hk_self_payee.
--   (c) Only then DROP FUNCTION public.fin__hk_bank_note(jsonb); (the 0032 descriptions call it).
--   (d) Restore the 0031 fin_hk_rules_kind_check / fin_hk_rules_kind_shape (0031 §1.2), or keep these (a superset).
--   Statements and entry descriptions written by closes after this file keep their bank / cash parts (extra breakdown
--   keys, text); the next close of a reopened month rewrites the description.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0030 / 0031 live (the functions replaced here have the 0031 bodies and signatures), expected columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'grant_staff_permission', 'fin__require_write', 'fin_can_read',
                    'fin__harden_privileges', 'fin__month_start', 'fin__day', 'fin__paid', 'fin__normalize_name',
                    'fin_add_entitlement', 'fin__hk_tl', 'fin__hk_pct', 'fin__hk_doctor_name', 'fin__hk_eval_lines',
                    'fin__hk_ortho_walk', 'fin__hk_rule_json', 'fin__hk_compute', 'fin__hk_self_payee',
                    'fin__hk_parts', 'fin__hk_description', 'fin__hk_payroll_description', 'fin__hk_payee_entry',
                    'fin__hk_strip_ledger', 'fin__hk_require_prep_read', 'fin__hk_require_prep_write',
                    'fin__hk_month_json', 'fin_hk_reference', 'fin_hk_month', 'fin_hk_save_rule', 'fin_hk_save_line',
                    'fin_hk_save_adjustment', 'fin_hk_void_adjustment', 'fin_hk_close_month', 'fin_hk_reopen_month',
                    'hk_my_months', 'hk_my_month']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0030 ve 0031 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_self_payee(jsonb)',
    'public.fin__hk_parts(jsonb,uuid)',
    'public.fin__hk_description(jsonb,date,uuid)',
    'public.fin__hk_payroll_description(jsonb,date)',
    'public.fin__hk_strip_ledger(jsonb)',
    'public.fin__hk_tl(bigint)',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text)',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.hk_my_months()',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş fonksiyonları beklenen imzada değil (0031 uygulanmalı): %', v_missing;
  END IF;

  -- 0031 applied: its table, column and rule kind constraints exist.
  IF to_regclass('public.fin_hk_adjustments') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'fin_counterparties' AND c.column_name = 'staff_user_id')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_check'
         AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_shape'
         AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.staff_permissions'::regclass AND c.conname = 'staff_permissions_permission_check'
         AND pg_get_constraintdef(c.oid) LIKE '%hakedis_prepare%') THEN
    RAISE EXCEPTION 'Önce 0031 uygulanmalı (fin_hk_adjustments, sabit aylık maaş kural türü, hakedis_prepare yetkisi).';
  END IF;

  -- The bodies replaced below are 0031's (on a re-run this file's, which keep these texts).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fin__hk_compute'
                   AND p.prosrc LIKE '%public.fin_hk_adjustments a%' AND p.prosrc LIKE '%payroll_only%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_save_rule'
                      AND p.prosrc LIKE '%Sabit aylık maaş kuralında hekim seçilmez.%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'hk_my_months'
                      AND p.prosrc LIKE '%public.fin__hk_payee_entry(%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin__hk_payroll_description'
                      AND p.prosrc LIKE '%DentOS maaş %') THEN
    RAISE EXCEPTION 'fin__hk_compute / fin_hk_save_rule / hk_my_months / fin__hk_payroll_description 0031 sürümünde değil.';
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_rules', 'id'), ('fin_hk_rules', 'clinic_id'), ('fin_hk_rules', 'payee_user_id'),
    ('fin_hk_rules', 'doctor_id'), ('fin_hk_rules', 'kind'), ('fin_hk_rules', 'segment'), ('fin_hk_rules', 'share_bp'),
    ('fin_hk_rules', 'piece_cents'), ('fin_hk_rules', 'deduct_cash_bp'), ('fin_hk_rules', 'deduct_card_bp'),
    ('fin_hk_rules', 'deduct_transfer_bp'), ('fin_hk_rules', 'deduct_financing_bp'), ('fin_hk_rules', 'from_month'),
    ('fin_hk_rules', 'to_month'),
    ('fin_hk_statements', 'total_cents'), ('fin_hk_statements', 'breakdown'), ('fin_hk_statements', 'fin_entry_id'),
    ('fin_hk_statements', 'superseded_at')
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
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Schema: rule kind bank_portion (the monthly bank amount in piece_cents). The kind CHECK (a single-column CHECK
--     on kind; 0031 named it fin_hk_rules_kind_check) and the shape CHECK are recreated with the new kind.
-- ---------------------------------------------------------------------------
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
    kind IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share', 'fixed_monthly', 'bank_portion')
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
    OR (kind = 'bank_portion' AND doctor_id IS NULL AND segment IS NULL AND share_bp IS NULL
       AND piece_cents IS NOT NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0)
  );

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (SECURITY INVOKER, never granted; called from the SECURITY DEFINER RPCs). Created before the
--    descriptions that call them (SQL function bodies are checked at creation).
-- ---------------------------------------------------------------------------

-- ' · Bankadan <bank> · Elden <cash>' for a payee object with a bank_cents number (cash = cash_cents, or total_cents -
-- bank_cents when cash_cents is missing), else NULL. Appended to the ledger entry descriptions.
CREATE OR REPLACE FUNCTION public.fin__hk_bank_note(p_payee jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN jsonb_typeof(p_payee -> 'bank_cents') = 'number' THEN
           ' · Bankadan ' || public.fin__hk_tl((p_payee ->> 'bank_cents')::bigint)
           || ' · Elden ' || public.fin__hk_tl(coalesce((p_payee ->> 'cash_cents')::bigint,
                                                        (p_payee ->> 'total_cents')::bigint
                                                        - (p_payee ->> 'bank_cents')::bigint))
         END
$$;

-- The caller's own payee object for hk_my_month (0030, same signature): a clinic_ciro_share component keeps only its
-- rate, base and amount (no line counts of the whole clinic); the payee's doctor / counterparty ids are dropped.
-- 0032: bank_cents / cash_cents kept (null for a statement breakdown written before 0032).
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
           'bank_cents', p_payee -> 'bank_cents',
           'cash_cents', p_payee -> 'cash_cents',
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

-- Ledger entry description of a doctor payee (fin_entries.description, <= 1000 characters, 0031), e.g.
-- 'DentOS hakediş 2026-11: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL · Bankadan 100,00 TL · Elden 150,00 TL'.
-- Same text as 0031 for a payee without bank_cents.
CREATE OR REPLACE FUNCTION public.fin__hk_description(p_payee jsonb, p_month date, p_payee_doctor uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT left('DentOS hakediş ' || to_char(p_month, 'YYYY-MM') || ': '
              || coalesce(public.fin__hk_parts(p_payee, p_payee_doctor), 'tutar yok'),
              1000 - coalesce(char_length(public.fin__hk_bank_note(p_payee)), 0))
         || coalesce(public.fin__hk_bank_note(p_payee), '')
$$;

-- Ledger entry description of a staff payee (0031), e.g.
-- 'DentOS maaş 2026-11: sabit maaş 100,00 TL; prim 10,00 TL · Bankadan 80,00 TL · Elden 30,00 TL'.
CREATE OR REPLACE FUNCTION public.fin__hk_payroll_description(p_payee jsonb, p_month date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT left('DentOS maaş ' || to_char(p_month, 'YYYY-MM') || ': '
              || coalesce(public.fin__hk_parts(p_payee, NULL), 'tutar yok'),
              1000 - coalesce(char_length(public.fin__hk_bank_note(p_payee)), 0))
         || coalesce(public.fin__hk_bank_note(p_payee), '')
$$;

-- ---------------------------------------------------------------------------
-- 3. Calculation (0031 body, same signature). Changes: every payee gets bank_cents (its active bank_portion amount,
--    null when none) and cash_cents (total - bank, null when bank is null); a payee with a bank_portion rule and no
--    component appears with total 0 and no components; BANK_OVER_TOTAL when bank_cents > total_cents; the warnings
--    get the payee id as a last sort key. Components and totals are the 0031 ones.
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
  -- 0032: the payee's active bank_portion amount (one rule per payee and month through fin_hk_save_rule's overlap
  -- check; summed should rows ever overlap). Not a component: the total stays the sum of the components.
  bank AS (
    SELECT ar.payee_user_id, sum(ar.piece_cents)::bigint AS cents
    FROM ar
    WHERE ar.kind = 'bank_portion'
    GROUP BY ar.payee_user_id
  ),
  -- Every payee with components (+ its bank amount), and every payee with only a bank_portion rule: total 0, no
  -- components, counterparty as a payroll-only payee (physician counterparty with a doctors row, else the staff
  -- counterparty linked to the user).
  payee_b AS (
    SELECT p.payee_user_id, p.payee_name, p.payee_doctor_id, p.counterparty_id, p.total, p.components,
           b.cents AS bank
    FROM payee p
    LEFT JOIN bank b ON b.payee_user_id = p.payee_user_id
    UNION ALL
    SELECT b.payee_user_id,
           u.full_name,
           pd.id,
           CASE WHEN pd.id IS NOT NULL THEN cp.id ELSE sc.id END,
           0::bigint,
           '[]'::jsonb,
           b.cents
    FROM bank b
    JOIN public.users u ON u.id = b.payee_user_id
    LEFT JOIN public.doctors pd ON pd.user_id = b.payee_user_id AND pd.clinic_id = p_clinic
    LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = p_clinic AND cp.doctor_id = pd.id
    LEFT JOIN public.fin_counterparties sc ON sc.clinic_id = p_clinic AND sc.staff_user_id = b.payee_user_id
    WHERE NOT EXISTS (SELECT 1 FROM payee p WHERE p.payee_user_id = b.payee_user_id)
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
    UNION ALL
    -- 0032: the bank pays more than the payee earned this month (amounts unchanged; the close is not blocked).
    SELECT 4,
           p.payee_name,
           jsonb_build_object(
             'code', 'BANK_OVER_TOTAL',
             'payee_user_id', p.payee_user_id,
             'payee_name', p.payee_name,
             'bank_cents', p.bank,
             'total_cents', p.total)
    FROM payee_b p
    WHERE p.bank > p.total
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
                      'bank_cents', p.bank,
                      'cash_cents', p.total - p.bank,
                      'components', p.components)
                    ORDER BY p.payee_name COLLATE "tr-x-icu", p.payee_user_id)
             FROM payee_b p), '[]'::jsonb),
           'clinic_total_cents', (SELECT g.total FROM gross g),
           'warnings', coalesce((
             SELECT jsonb_agg(w.w ORDER BY w.ord, w.sort_name COLLATE "tr-x-icu", (w.w ->> 'payee_user_id')::uuid)
             FROM warn w), '[]'::jsonb))
    INTO v_result;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Finance RPCs (0031 bodies, same signatures; CREATE OR REPLACE keeps the ACL).
-- ---------------------------------------------------------------------------

-- Payee rule (finance writers only, 0030 / 0031) + kind bank_portion. Fields by kind:
--   ciro_share         doctor, segment, share_bp, deductions
--   ortho_lab_first    doctor, share_bp, deductions (no segment)
--   implant_piece      doctor, piece_cents (no share, no deductions)
--   clinic_ciro_share  share_bp only (no doctor, no segment, no deductions)
--   fixed_monthly      piece_cents = monthly net salary only; payee any user of the clinic (0031)
--   bank_portion       piece_cents = the fixed monthly amount paid by bank only; payee any user of the clinic (0032)
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
     OR p_kind NOT IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share', 'fixed_monthly',
                       'bank_portion') THEN
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
  ELSIF p_kind = 'bank_portion' THEN
    IF p_doctor_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bankadan ödenen sabit tutar kuralında hekim seçilmez.';
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
  ELSIF p_kind = 'bank_portion' THEN
    IF p_share_bp IS NOT NULL THEN
      RAISE EXCEPTION 'Bankadan ödenen sabit tutar kuralında pay oranı girilmez.';
    END IF;
    IF p_piece_cents IS NULL OR p_piece_cents NOT BETWEEN 1 AND 1000000000000 THEN
      RAISE EXCEPTION 'Aylık bankadan ödenen tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
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
  IF p_kind IN ('implant_piece', 'clinic_ciro_share', 'fixed_monthly', 'bank_portion')
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

  -- Payee: a staff member of the clinic with a doctors row, or the owner; for fixed_monthly and bank_portion any user
  -- of the clinic (active when newly chosen, checked below).
  SELECT * INTO v_payee FROM public.users u WHERE u.id = p_payee_user_id AND u.clinic_id = v_clinic;
  IF v_payee.id IS NULL THEN
    RAISE EXCEPTION 'Hakediş alacak kişi bulunamadı.';
  END IF;
  IF p_kind NOT IN ('fixed_monthly', 'bank_portion') AND v_payee.role::text <> 'owner' AND NOT EXISTS (
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

  -- Overlap: fixed_monthly and bank_portion per payee (0031 / 0032: every person has a salary / bank amount of their
  -- own), the other kinds per (kind, doctor, segment) whoever the payee is.
  SELECT r.id INTO v_other
  FROM public.fin_hk_rules r
  WHERE r.clinic_id = v_clinic
    AND r.id <> p_id
    AND r.kind = p_kind
    AND (CASE WHEN p_kind IN ('fixed_monthly', 'bank_portion') THEN r.payee_user_id = p_payee_user_id
              ELSE r.doctor_id IS NOT DISTINCT FROM p_doctor_id AND r.segment IS NOT DISTINCT FROM p_segment END)
    AND r.from_month <= coalesce(v_to, DATE '9999-12-01')
    AND v_from <= coalesce(r.to_month, DATE '9999-12-01')
  ORDER BY r.from_month, r.id
  LIMIT 1;
  IF v_other IS NOT NULL AND p_kind = 'fixed_monthly' THEN
    RAISE EXCEPTION 'Bu kişi için bu aylarla çakışan başka bir sabit aylık maaş kuralı var. Önce onun bitiş ayını girin.'
      USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;
  IF v_other IS NOT NULL AND p_kind = 'bank_portion' THEN
    RAISE EXCEPTION 'Bu kişi için bu aylarla çakışan başka bir bankadan ödenen sabit tutar kuralı var. Önce onun bitiş ayını girin.'
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

-- ---------------------------------------------------------------------------
-- 5. Self-service (0031 body, same signature; still only the caller's own data). hk_my_month is not replaced: its
--    payee object comes through fin__hk_self_payee, which now keeps bank_cents / cash_cents.
-- ---------------------------------------------------------------------------

-- The caller's months, newest first (0031) + bank_cents / cash_cents per month: closed months from the statement
-- breakdown (null for a breakdown written before 0032), open months from the live estimate.
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
  v_bank bigint;
  v_cash bigint;
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
    v_bank := NULL;
    v_cash := NULL;

    SELECT m.status INTO v_status FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = v_m;
    v_status := coalesce(v_status, 'open');

    IF v_status = 'closed' THEN
      SELECT s.total_cents, s.fin_entry_id, (s.breakdown ->> 'bank_cents')::bigint,
             (s.breakdown ->> 'cash_cents')::bigint
        INTO v_total, v_entry, v_bank, v_cash
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
        SELECT (p ->> 'total_cents')::bigint, (p ->> 'bank_cents')::bigint, (p ->> 'cash_cents')::bigint
          INTO v_total, v_bank, v_cash
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
      'remaining_cents', v_remaining,
      'bank_cents', v_bank,
      'cash_cents', CASE WHEN v_bank IS NOT NULL THEN coalesce(v_cash, v_total - v_bank) END));
  END LOOP;

  RETURN jsonb_build_object('has_rules', true, 'today', v_today, 'current_month', v_current, 'months', v_months);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs granted to authenticated, internals (fin__hk_*, incl. the new fin__hk_bank_note) never; plus its
--    self-checks. hk_my_months keeps its 0030 ACL (CREATE OR REPLACE); repeated here for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_months() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_months() TO authenticated;

-- ---------------------------------------------------------------------------
-- 7.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_j jsonb;
  v_t text;
  v_doc uuid := '00000000-0000-0000-0000-00000000000a';
BEGIN
  -- 1. Signatures (no accidental overload; fin__harden_privileges refuses overloads of fin_* too).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin__hk_bank_note(jsonb)',
    'public.fin__hk_self_payee(jsonb)',
    'public.fin__hk_description(jsonb,date,uuid)',
    'public.fin__hk_payroll_description(jsonb,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text)',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.hk_my_months()',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v1.3 fonksiyon imzaları beklenen gibi değil: %', v_bad;
  END IF;

  -- 2. The helpers replaced or added here stay internal (SECURITY INVOKER, not callable from the API); the RPCs keep
  --    SECURITY DEFINER + search_path, callable by authenticated, never by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__hk_bank_note', 'fin__hk_self_payee', 'fin__hk_description', 'fin__hk_payroll_description',
                      'fin__hk_compute')
    AND (p.prosecdef
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç hakediş fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_hk_save_rule', 'hk_my_months', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v1.3 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Rule kind constraints with bank_portion (one single-column CHECK on kind).
  IF (SELECT count(*)
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'kind'
      WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.contype = 'c' AND c.conkey = ARRAY[a.attnum]) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_check'
                      AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%'
                      AND pg_get_constraintdef(c.oid) LIKE '%bank_portion%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_shape'
                      AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%'
                      AND pg_get_constraintdef(c.oid) LIKE '%bank_portion%') THEN
    RAISE EXCEPTION 'fin_hk_rules tür kısıtları beklenen gibi değil.';
  END IF;

  -- 4. Entry descriptions: the 0031 texts without bank_cents (also a JSON null); the bank note with bank_cents (cash
  --    from cash_cents, else total - bank; negative cash); the breakdown cut so the note fits in 1000 characters.
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
     OR public.fin__hk_description(v_j #- '{components,3}' #- '{components,3}'
                                   || jsonb_build_object('bank_cents', NULL::bigint, 'cash_cents', NULL::bigint),
                                   DATE '2024-01-01', NULL)
          IS DISTINCT FROM 'DentOS hakediş 2024-01: ciro payı D (standart) %25 × 1.000,00 TL = 250,00 TL; '
                           || 'implant D 2 × 100,00 TL = 200,00 TL'
     OR public.fin__hk_payroll_description(jsonb_build_object('components', '[]'::jsonb), DATE '2024-01-01')
          IS DISTINCT FROM 'DentOS maaş 2024-01: tutar yok'
     OR public.fin__hk_description(
          jsonb_build_object('total_cents', 25000, 'bank_cents', 30000, 'cash_cents', -5000,
                             'components', jsonb_build_array(v_j #> '{components,0}')),
          DATE '2024-01-01', v_doc)
          IS DISTINCT FROM 'DentOS hakediş 2024-01: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL'
                           || ' · Bankadan 300,00 TL · Elden -50,00 TL'
     OR public.fin__hk_payroll_description(
          jsonb_build_object('total_cents', 0, 'bank_cents', 100, 'cash_cents', -100, 'components', '[]'::jsonb),
          DATE '2024-01-01')
          IS DISTINCT FROM 'DentOS maaş 2024-01: tutar yok · Bankadan 1,00 TL · Elden -1,00 TL'
     OR public.fin__hk_payroll_description(
          jsonb_build_object('total_cents', 330000, 'bank_cents', 200000, 'components', jsonb_build_array(
            v_j #> '{components,3}', jsonb_build_object('kind', 'adjustments', 'amount_cents', 30000, 'items',
              jsonb_build_array(jsonb_build_object('kind', 'bonus', 'amount_cents', 30000))))),
          DATE '2024-02-01')
          IS DISTINCT FROM 'DentOS maaş 2024-02: sabit maaş 3.000,00 TL; prim 300,00 TL · Bankadan 2.000,00 TL · '
                           || 'Elden 1.300,00 TL' THEN
    RAISE EXCEPTION 'Hakediş kayıt açıklaması beklenen gibi değil.';
  END IF;
  v_j := jsonb_build_object('total_cents', 6000000, 'bank_cents', 100, 'cash_cents', 5999900, 'components',
                            (SELECT jsonb_agg(jsonb_build_object('kind', 'fixed_monthly', 'amount_cents', 100000))
                             FROM generate_series(1, 60)));
  v_t := public.fin__hk_payroll_description(v_j, DATE '2024-01-01');
  IF char_length(v_t) <> 1000
     OR public.fin__hk_bank_note(v_j) IS DISTINCT FROM ' · Bankadan 1,00 TL · Elden 59.999,00 TL'
     OR right(v_t, 40) IS DISTINCT FROM ' · Bankadan 1,00 TL · Elden 59.999,00 TL'
     OR left(v_t, 45) IS DISTINCT FROM 'DentOS maaş 2024-01: sabit maaş 1.000,00 TL; '
     OR left(v_t, 960) IS DISTINCT FROM left(public.fin__hk_payroll_description(v_j - 'bank_cents', DATE '2024-01-01'),
                                             960)
     OR char_length(public.fin__hk_payroll_description(v_j - 'bank_cents', DATE '2024-01-01')) <> 1000
     OR position('Bankadan' IN public.fin__hk_payroll_description(v_j - 'bank_cents', DATE '2024-01-01')) > 0 THEN
    RAISE EXCEPTION 'Banka notlu hakediş açıklaması 1000 karakteri aşıyor veya kesilmiş: %', left(v_t, 200);
  END IF;

  -- 5. The own payee object keeps bank_cents / cash_cents (null when missing); the ledger strip keeps them and the
  --    BANK_OVER_TOTAL warning.
  IF public.fin__hk_self_payee(
       '{"payee_user_id": "u", "payee_name": "n", "doctor_id": "d", "counterparty_id": "c", "total_cents": 1,
         "bank_cents": 2, "cash_cents": -1, "components": []}'::jsonb)
       IS DISTINCT FROM '{"payee_user_id": "u", "payee_name": "n", "total_cents": 1, "bank_cents": 2, "cash_cents": -1,
                          "components": []}'::jsonb
     OR public.fin__hk_self_payee('{"payee_user_id": "u", "payee_name": "n", "total_cents": 1, "components": []}'::jsonb)
          IS DISTINCT FROM '{"payee_user_id": "u", "payee_name": "n", "total_cents": 1, "bank_cents": null,
                             "cash_cents": null, "components": []}'::jsonb THEN
    RAISE EXCEPTION 'Kendi hakediş nesnesi beklenen gibi değil.';
  END IF;
  IF public.fin__hk_strip_ledger(
       '{"month": "2024-01-01",
         "payees": [{"payee_user_id": "u", "counterparty_id": "c", "total_cents": 0, "bank_cents": 5,
                     "cash_cents": -5}],
         "warnings": [{"code": "NO_COUNTERPARTY", "payee_user_id": "u"},
                      {"code": "BANK_OVER_TOTAL", "payee_user_id": "u", "bank_cents": 5, "total_cents": 0}],
         "statements": [{"id": "s", "fin_entry_id": null, "entry": null,
                         "breakdown": {"counterparty_id": "c", "total_cents": 0, "bank_cents": 5, "cash_cents": -5}}]}'::jsonb)
     IS DISTINCT FROM
       '{"month": "2024-01-01",
         "payees": [{"payee_user_id": "u", "total_cents": 0, "bank_cents": 5, "cash_cents": -5}],
         "warnings": [{"code": "BANK_OVER_TOTAL", "payee_user_id": "u", "bank_cents": 5, "total_cents": 0}],
         "statements": [{"id": "s", "fin_entry_id": null, "entry": null,
                         "breakdown": {"total_cents": 0, "bank_cents": 5, "cash_cents": -5}}]}'::jsonb THEN
    RAISE EXCEPTION 'Hakediş defter verisi ayıklaması banka / elden bilgisini değiştirdi.';
  END IF;

  -- 6. An empty computation (runs every query of the engine once) is still the 0030 result.
  v_j := public.fin__hk_compute(gen_random_uuid(), DATE '2024-01-15');
  IF v_j IS DISTINCT FROM jsonb_build_object('month', DATE '2024-01-01', 'payees', '[]'::jsonb,
                                             'clinic_total_cents', 0, 'warnings', '[]'::jsonb) THEN
    RAISE EXCEPTION 'Boş klinik hesabı beklenen gibi değil: %', left(v_j::text, 300);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7.2 Replay inside a block that is always rolled back: temporary clinic 'p32-test-hk-selfcheck-<random>' with an
--     owner (finance, doctors row), doctors A (ciro share + bank amount) and B (ciro share only), a reception user R
--     ('hakedis_prepare'), assistants S (fixed salary + bonus + bank amount) and Z (bank amount only) and an inactive
--     user X. Made-up names and amounts only. auth.uid() is simulated through request.jwt.claims (and
--     request.jwt.claim.sub / .role), as in 0030 / 0031. Covered: bank_portion save, retry, per-payee overlap,
--     validation, refused for R; bank / cash figures, unchanged totals and BANK_OVER_TOTAL for R (prep, no ledger data)
--     and the owner; the month close with the bank / cash note in the entitlement and payroll descriptions, amounts =
--     totals, a bank-only payee with a 0 statement and no entry; statements' breakdowns for R; hk_my_month /
--     hk_my_months of A, B, Z and S (own data only); a re-close after a bank amount change (same entry and amount, new
--     note). Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p32-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
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
  v_z uuid := gen_random_uuid();
  v_z_auth uuid := gen_random_uuid();
  v_x uuid := gen_random_uuid();
  v_rule_sb uuid := gen_random_uuid();
  v_rule_zb uuid := gen_random_uuid();
  v_cp_a uuid;
  v_cp_b uuid;
  v_cp_s uuid;
  v_entry_s uuid;
  v_sqls text[];
  v_msgs text[];
  v_i integer;
  v_j jsonb;
  v_p jsonb;
  v_w jsonb;
  v_err text;
  v_state text;
  v_ver integer;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P32', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p32-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p32-sc-a-' || v_tag || '@example.invalid', true),
      (v_b, v_clinic, v_b_auth, 'doctor', 'Öz denetim Hekim B', 'p32-sc-b-' || v_tag || '@example.invalid', true),
      (v_r, v_clinic, v_r_auth, 'reception', 'Öz denetim Banko', 'p32-sc-r-' || v_tag || '@example.invalid', true),
      (v_s, v_clinic, v_s_auth, 'assistant', 'Öz denetim Asistan S', 'p32-sc-s-' || v_tag || '@example.invalid',
       true),
      (v_z, v_clinic, v_z_auth, 'assistant', 'Öz denetim Asistan Z', 'p32-sc-z-' || v_tag || '@example.invalid',
       true),
      (v_x, v_clinic, NULL, 'assistant', 'Öz denetim Eski', 'p32-sc-x-' || v_tag || '@example.invalid', false);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_own_doc, v_clinic, v_own), (v_a_doc, v_clinic, v_a), (v_b_doc, v_clinic, v_b);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own);

    -- Owner: 'hakedis_prepare' for R; rules. A's bank amount (any day of the month → its first day).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;
    PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');

    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_a, v_a_doc, 'ciro_share', 'standard', 3000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_b, v_b_doc, 'ciro_share', 'standard', 2500, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, NULL, 'fixed_monthly', NULL, NULL, 2345600,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    v_j := public.fin_hk_save_rule(gen_random_uuid(), 0, v_a, NULL, 'bank_portion', NULL, NULL, 35000,
                                   0, 0, 0, 0, DATE '2024-01-20', NULL, '');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,kind}') IS DISTINCT FROM 'bank_portion'
       OR (v_j #>> '{record,payee_user_id}') IS DISTINCT FROM v_a::text
       OR (v_j #>> '{record,piece_cents}')::bigint IS DISTINCT FROM 35000
       OR (v_j #>> '{record,from_month}') IS DISTINCT FROM '2024-01-01'
       OR (v_j #> '{record,doctor_id}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #> '{record,share_bp}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #> '{record,segment}') IS DISTINCT FROM 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'bankadan ödenen tutar kuralı: ' || left(v_j::text, 300));
    END IF;

    -- S: a salary and a bank amount in the same months (different kinds); Z: only a bank amount, in S's months too
    -- (the overlap is per payee). A repeated save is already_saved; a second bank amount of S in its months is not.
    PERFORM public.fin_hk_save_rule(v_rule_sb, 0, v_s, NULL, 'bank_portion', NULL, NULL, 1876500,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_zb, 0, v_z, NULL, 'bank_portion', NULL, NULL, 987600,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    v_j := public.fin_hk_save_rule(v_rule_zb, 0, v_z, NULL, 'bank_portion', NULL, NULL, 987600,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'bankadan ödenen tutar tekrar deneme: ' || left(v_j::text, 300));
    END IF;
    v_state := NULL;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, NULL, 'bank_portion', NULL, NULL, 100,
                                      0, 0, 0, 0, DATE '2024-06-01', DATE '2024-08-01', '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM 'PT409'
       OR v_err IS DISTINCT FROM 'Bu kişi için bu aylarla çakışan başka bir bankadan ödenen sabit tutar kuralı var. Önce onun bitiş ayını girin.' THEN
      v_fail := array_append(v_fail, 'aynı kişiye çakışan bankadan ödenen tutar: ' || coalesce(v_state, '-') || ' '
                                     || coalesce(v_err, '-'));
    END IF;

    -- Validation, one message per call.
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''bank_portion'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z, v_b_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''bank_portion'', ''standard'', NULL, '
             '100, 0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''bank_portion'', NULL, 2500, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''bank_portion'', NULL, NULL, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''bank_portion'', NULL, NULL, 0, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''bank_portion'', NULL, NULL, 100, '
             '0, 100, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''bank_portion'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_x)];
    v_msgs := ARRAY[
      'Bankadan ödenen sabit tutar kuralında hekim seçilmez.',
      'Hasta grubu yalnızca ciro payı kuralında seçilir.',
      'Bankadan ödenen sabit tutar kuralında pay oranı girilmez.',
      'Aylık bankadan ödenen tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.',
      'Aylık bankadan ödenen tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.',
      'Kesinti oranları yalnızca ciro payı ve ortodonti kurallarında girilir.',
      'Pasif personel seçilemez.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'bankadan ödenen tutar doğrulaması: ' || v_sqls[v_i] || ' / '
                                       || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- R ('hakedis_prepare'): no rule writes; enters the lines and S's bonus.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_z, NULL, 'bank_portion', NULL, NULL, 100,
                                      0, 0, 0, 0, DATE '2030-01-01', NULL, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı bankadan ödenen tutar kuralı: ' || coalesce(v_state, '-'));
    END IF;
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-01-10', v_b_doc, 'Hasta Bir', NULL, 'cash', 'TRY',
                                    100000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-01-11', v_a_doc, 'Hasta İki', NULL, 'cash', 'TRY',
                                    200000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_adjustment(gen_random_uuid(), 0, DATE '2024-01-15', v_s, 'bonus', 123400, 'Ocak primi');

    -- January as R: A 30 % of 200000 = 60000, bank 35000, cash 25000; B 25000 without a bank amount (keys null); S
    -- salary 2345600 + bonus 123400 = 2469000, bank 1876500, cash 592500; Z bank only: total 0, no components, cash
    -- -987600 and the only warning R sees (NO_COUNTERPARTY is ledger data). Totals as without the bank amounts.
    v_w := jsonb_build_object('code', 'BANK_OVER_TOTAL', 'payee_user_id', v_z, 'payee_name', 'Öz denetim Asistan Z',
                              'bank_cents', 987600, 'total_cents', 0);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF coalesce((v_j ->> 'ledger_visible')::boolean, true)
       OR (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 300000
       OR jsonb_array_length(v_j -> 'payees') <> 4
       OR position('counterparty_id' IN v_j::text) > 0
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(v_w) THEN
      v_fail := array_append(v_fail, 'hazırlayıcı ocak: ' || left(v_j::text, 900));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_a::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 60000
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 35000
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM 25000
       OR jsonb_array_length(v_p -> 'components') <> 1 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı ocak A: ' || coalesce(left(v_p::text, 500), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_b::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 25000
       OR NOT (v_p ? 'bank_cents') OR NOT (v_p ? 'cash_cents')
       OR jsonb_typeof(v_p -> 'bank_cents') IS DISTINCT FROM 'null'
       OR jsonb_typeof(v_p -> 'cash_cents') IS DISTINCT FROM 'null' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı ocak B: ' || coalesce(left(v_p::text, 500), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_s::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 2469000
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 1876500
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM 592500
       OR (SELECT string_agg(c ->> 'kind', ',' ORDER BY o)
           FROM jsonb_array_elements(v_p -> 'components') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'fixed_monthly,adjustments' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı ocak S: ' || coalesce(left(v_p::text, 500), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_z::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 0
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 987600
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM -987600
       OR (v_p -> 'components') IS DISTINCT FROM '[]'::jsonb
       OR (v_p -> 'doctor_id') IS DISTINCT FROM 'null'::jsonb
       OR (v_p ->> 'payee_name') IS DISTINCT FROM 'Öz denetim Asistan Z' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı ocak Z: ' || coalesce(left(v_p::text, 500), '-'));
    END IF;

    -- The owner: NO_COUNTERPARTY ('missing') for A, B and S, none for Z (total 0), then BANK_OVER_TOTAL.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF NOT coalesce((v_j ->> 'ledger_visible')::boolean, false)
       OR (SELECT string_agg(w ->> 'code', ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'warnings') WITH ORDINALITY AS x(w, o))
          IS DISTINCT FROM 'NO_COUNTERPARTY,NO_COUNTERPARTY,NO_COUNTERPARTY,BANK_OVER_TOTAL'
       OR (v_j #> '{warnings,3}') IS DISTINCT FROM v_w
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w
                  WHERE (w ->> 'code') = 'NO_COUNTERPARTY' AND (w ->> 'payee_user_id') = v_z::text)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_z::text AND (p -> 'counterparty_id') = 'null'::jsonb) THEN
      v_fail := array_append(v_fail, 'sahip ocak uyarıları: ' || left((v_j -> 'warnings')::text, 800));
    END IF;

    -- Close (BANK_OVER_TOTAL does not block): the entries carry the bank / cash note, amounts = totals; Z gets a 0
    -- statement with the bank figures, no entry and no counterparty.
    v_j := public.fin_hk_close_month(DATE '2024-01-01', 0, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR jsonb_array_length(v_j -> 'statements') <> 4
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_z::text AND (st ->> 'total_cents')::bigint = 0
                        AND (st -> 'fin_entry_id') = 'null'::jsonb
                        AND (st #>> '{breakdown,bank_cents}')::bigint = 987600
                        AND (st #>> '{breakdown,cash_cents}')::bigint = -987600)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_a::text AND (st ->> 'total_cents')::bigint = 60000
                        AND (st #>> '{breakdown,bank_cents}')::bigint = 35000
                        AND (st #>> '{breakdown,cash_cents}')::bigint = 25000
                        AND (st #>> '{entry,amount_cents}')::bigint = 60000) THEN
      v_fail := array_append(v_fail, 'ocak kapatma: ' || left(v_j::text, 900));
    END IF;
    SELECT cp.id INTO v_cp_a FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_a_doc;
    SELECT cp.id INTO v_cp_b FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_b_doc;
    SELECT cp.id INTO v_cp_s FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_s;
    SELECT e.id INTO v_entry_s
    FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic
      AND e.source_key = 'payroll:' || v_cp_s::text || ':2024-01'
      AND e.amount_cents = 2469000 AND e.cancelled_at IS NULL
      AND e.description = 'DentOS maaş 2024-01: sabit maaş 23.456,00 TL; prim 1.234,00 TL · Bankadan 18.765,00 TL · '
                          || 'Elden 5.925,00 TL';
    IF v_entry_s IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || v_cp_a::text || ':2024-01'
                        AND e.amount_cents = 60000
                        AND e.description = 'DentOS hakediş 2024-01: ciro payı (standart) %30 × 2.000,00 TL = '
                                            || '600,00 TL · Bankadan 350,00 TL · Elden 250,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || v_cp_b::text || ':2024-01'
                        AND e.amount_cents = 25000
                        AND e.description = 'DentOS hakediş 2024-01: ciro payı (standart) %25 × 1.000,00 TL = '
                                            || '250,00 TL')
       OR (SELECT count(*) FROM public.fin_entries e
           WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%')) <> 3
       OR EXISTS (SELECT 1 FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_z)
    THEN
      v_fail := array_append(v_fail, 'ocak kayıtları');
    END IF;

    -- R after the close: the statements' breakdowns keep bank / cash, still without ledger data.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR position('counterparty_id' IN v_j::text) > 0
       OR position('paid_cents' IN v_j::text) > 0
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(v_w)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_s::text AND (st -> 'entry') = 'null'::jsonb
                        AND (st ->> 'fin_entry_id') = v_entry_s::text
                        AND (st #>> '{breakdown,bank_cents}')::bigint = 1876500
                        AND (st #>> '{breakdown,cash_cents}')::bigint = 592500) THEN
      v_fail := array_append(v_fail, 'hazırlayıcı kapalı ocak: ' || left(v_j::text, 900));
    END IF;

    -- February (open, no lines) as R: A earns 0 with a bank amount, so BANK_OVER_TOTAL for Z and A (by name); B (0,
    -- no bank amount) and S (bank below the salary) get none.
    v_j := public.fin_hk_month(DATE '2024-02-01');
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_s::text;
    IF (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
         v_w,
         jsonb_build_object('code', 'BANK_OVER_TOTAL', 'payee_user_id', v_a, 'payee_name', 'Öz denetim Hekim A',
                            'bank_cents', 35000, 'total_cents', 0))
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 2345600
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 1876500
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM 469100 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı şubat: ' || left(v_j::text, 900));
    END IF;

    -- Self-service. A: own bank / cash in the frozen breakdown and the month list, nothing of the others.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 60000
       OR (v_j #>> '{payees,0,bank_cents}')::bigint IS DISTINCT FROM 35000
       OR (v_j #>> '{payees,0,cash_cents}')::bigint IS DISTINCT FROM 25000
       OR (v_j #>> '{entitlement,amount_cents}')::bigint IS DISTINCT FROM 60000
       OR position(v_b::text IN v_j::text) > 0
       OR position(v_s::text IN v_j::text) > 0
       OR position(v_z::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A ocak: ' || left(v_j::text, 800));
    END IF;
    v_j := public.hk_my_months();
    IF DATE '2024-02-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
       AND (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                        WHERE (m ->> 'month') = '2024-01-01' AND (m ->> 'status') = 'closed'
                          AND (m ->> 'total_cents')::bigint = 60000 AND (m ->> 'bank_cents')::bigint = 35000
                          AND (m ->> 'cash_cents')::bigint = 25000)
            OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                           WHERE (m ->> 'month') = '2024-02-01' AND (m ->> 'status') = 'open'
                             AND (m ->> 'total_cents')::bigint = 0 AND (m ->> 'bank_cents')::bigint = 35000
                             AND (m ->> 'cash_cents')::bigint = -35000)) THEN
      v_fail := array_append(v_fail, 'hekim A aylar: ' || left(v_j::text, 500));
    END IF;

    -- B: the keys are there, null.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_b_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 25000
       OR NOT coalesce((v_j #> '{payees,0}') ? 'bank_cents', false)
       OR NOT coalesce((v_j #> '{payees,0}') ? 'cash_cents', false)
       OR (v_j #> '{payees,0,bank_cents}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #> '{payees,0,cash_cents}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #>> '{entitlement,amount_cents}')::bigint IS DISTINCT FROM 25000 THEN
      v_fail := array_append(v_fail, 'hekim B ocak: ' || left(v_j::text, 800));
    END IF;
    v_j := public.hk_my_months();
    IF DATE '2024-01-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                       WHERE (m ->> 'month') = '2024-01-01' AND (m ->> 'total_cents')::bigint = 25000
                         AND (m -> 'bank_cents') = 'null'::jsonb AND (m -> 'cash_cents') = 'null'::jsonb) THEN
      v_fail := array_append(v_fail, 'hekim B aylar: ' || left(v_j::text, 500));
    END IF;

    -- Z (bank amount only): a 0 month with the bank figures and no entry.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_z_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_z_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR jsonb_array_length(v_j -> 'payees') <> 1
       OR (v_j #> '{payees,0}') IS DISTINCT FROM jsonb_build_object(
            'payee_user_id', v_z, 'payee_name', 'Öz denetim Asistan Z', 'total_cents', 0, 'bank_cents', 987600,
            'cash_cents', -987600, 'components', '[]'::jsonb)
       OR (v_j #>> '{statement,total_cents}')::bigint IS DISTINCT FROM 0
       OR (v_j -> 'entitlement') IS DISTINCT FROM 'null'::jsonb
       OR position(v_a::text IN v_j::text) > 0
       OR position(v_s::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'asistan Z ocak: ' || left(v_j::text, 800));
    END IF;
    v_j := public.hk_my_months();
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR (DATE '2024-01-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                           WHERE (m ->> 'month') = '2024-01-01' AND (m ->> 'status') = 'closed'
                             AND (m ->> 'total_cents')::bigint = 0 AND (m ->> 'paid_cents')::bigint = 0
                             AND (m ->> 'bank_cents')::bigint = 987600
                             AND (m ->> 'cash_cents')::bigint = -987600)) THEN
      v_fail := array_append(v_fail, 'asistan Z aylar: ' || left(v_j::text, 500));
    END IF;

    -- S: the open February estimate.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_s_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'open'
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 2345600
       OR (v_j #>> '{payees,0,bank_cents}')::bigint IS DISTINCT FROM 1876500
       OR (v_j #>> '{payees,0,cash_cents}')::bigint IS DISTINCT FROM 469100
       OR position(v_z::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'asistan S şubat: ' || left(v_j::text, 800));
    END IF;

    -- Re-close after S's bank amount changed: the same entry keeps its amount (the total), gets the new note; the
    -- statement's breakdown the new figures.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    PERFORM public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    v_j := public.fin_hk_save_rule(v_rule_sb, 1, v_s, NULL, 'bank_portion', NULL, NULL, 1900000,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,piece_cents}')::bigint IS DISTINCT FROM 1900000 THEN
      v_fail := array_append(v_fail, 'bankadan ödenen tutar düzeltme: ' || left(v_j::text, 300));
    END IF;
    SELECT m.version INTO v_ver FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_j := public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_entry_s AND e.amount_cents = 2469000 AND e.cancelled_at IS NULL
                        AND e.description = 'DentOS maaş 2024-01: sabit maaş 23.456,00 TL; prim 1.234,00 TL · '
                                            || 'Bankadan 19.000,00 TL · Elden 5.690,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.payee_user_id = v_s
                        AND s.superseded_at IS NULL AND s.fin_entry_id = v_entry_s AND s.total_cents = 2469000
                        AND (s.breakdown ->> 'bank_cents')::bigint = 1900000
                        AND (s.breakdown ->> 'cash_cents')::bigint = 569000)
       OR (SELECT count(*) FROM public.fin_entries e
           WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%')) <> 3
    THEN
      v_fail := array_append(v_fail, 'banka tutarı değişince yeniden kapatma: ' || left(v_j::text, 500));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v1.3): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p32_selfcheck_rollback';
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

-- Make the API see the replaced functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
