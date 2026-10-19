-- Hakediş v2.3: the part of a treatment paid with a Burgan Bank patient loan counts NET of the bank's fees in the
-- doctor's ciro (in the treatment's month; then the rule's financing deduction applies). The Macro import keeps the
-- payment day of every part paid in money; the hakediş calculation matches the transfer parts to the finance module's
-- patient financing rows when it computes (so a Burgan statement uploaded after the import still applies). Safe to
-- re-run.
--
-- Contract: hakedis_spec_v23_burgan.md on top of 0034_hakedis_override_unmarked.sql (0030 – 0033 are applied and
-- live, 0034 is applied right before this file; none is edited; the latest definition of every function replaced here
-- (0034's, else 0033's or 0031's) is copied with only the changes below). Requires 0022 (fin_patient_financing) and
-- 0034.
--
--  * No names, rates or amounts in this file.
--  * fin_hk_lines.paid_on (date, NULL allowed; CHECK fin_hk_lines_paid_on): the payment day of an imported part paid
--    in money: only on an imported cash / card / transfer line; a payment report line (macro_basis 'payment', the
--    orthodontist) always on its own day; a treatments report line in or before its treatment's month (a payment after
--    the month end is the 'unpaid' part). NULL on 'unpaid', manual and Burgan lines and on every line imported before
--    this file. Index idx_fin_hk_lines_paid_on (clinic_id, paid_on) of the live dated lines.
--  * fin_hk_import_macro (same signature, 0034 body): p_lines[] + paid_on (see the payload contract below), stored on
--    the line. Lines, carry-over, summary and dry run otherwise as 0034 (more lines when a transfer part is split per
--    payment day).
--  * Matching (fin__hk_financing_links, new internal helper; at compute time, never stored): a live line with method
--    'transfer', a paid_on and a positive TL amount belongs to the live (voided_at NULL) fin_patient_financing row of
--    the clinic of the same patient (fin__normalize_name of the row's patient_name_raw, or of the full name of the
--    DentOS patient the row is linked to (patient_id), equals fin__normalize_name of the line's patient_name) whose
--    txn_date is within 3 days of paid_on, the nearest (tie: the earliest txn_date, then the row id); never to another
--    row. Per financing row, its lines in (paid_on, treatment day (treatment_day, else day), created_at, id) order take
--    its gross_cents until it is used up: a line's financing part = min(its amount, what is left); the rest of the line
--    stays a transfer (a virtual split), a line after the gross is used up has none. Lines of every month take part (a
--    loan used for a later treatment with the same payment day: Macro's advance credit), so a month's figures follow
--    the order of every line of the loan. Lines imported before this file (paid_on NULL), manual lines, cash / card /
--    unpaid lines and negative lines never match. Doctor-less (clinic / outside) lines match too (they use the loan;
--    their figures only count in the clinic total).
--  * Calculation (fin__hk_eval_lines, fin__hk_compute; the TS computeMonth mirror follows the same rules): the line's
--    financing part F (financing_cents), its implant share (F when the whole line matched, else round(implant × F /
--    amount)) and, on an orthodontist's line, its lab share (likewise, at most F − implant share) go to the 'financing'
--    bucket, the rest of the line to its own method's bucket (the line counts once in lines_count). The bank's fee share
--    of a ciro_share rule's line: fee = round((F − implant share − lab share) × fee_cents / gross_cents of the
--    financing row) (rounded half away from zero, per line). ortho_lab_first takes no fee ("kesinti yok": the owner's
--    decision; tell the owner): its financing bucket keeps the whole eligible amount. Financing bucket of a rule: gross
--    / implant / lab / eligible (gross − implant − lab) as before, fee = Σ fee, deduction = round((eligible − fee) ×
--    deduct_financing_bp / 10000), base share = eligible − fee − deduction. Every other bucket, the ortho walk, lab
--    costs, pieces and the clinic_ciro_share base (the gross TL amount of every live line, clinic total) are
--    unchanged. A month without lines with paid_on gives the 0034 figures.
--  * Warnings (informational; the close is never blocked): FINANCING_MATCHED (ord 9: the month's lines with a
--    financing part) and FINANCING_UNMATCHED (ord 10: the month's live financing rows (txn_date in the month) that no
--    line of any month matched; for the preparer to check the patient names), only in a month with lines imported
--    with payment days (a live line of the month with a paid_on): a month imported before this file or never imported
--    lists no loans, so the loan history of other months stays finance-only.
--  * Privacy: fin_patient_financing stays finance-only. The month payload shows per line only the resolved method, the
--    financing part of the line's own amount and the fee share used; never the loan's reference, gross / net totals or
--    block / release data. fin__hk_strip_ledger (0031 body, same signature; callers without 'finance' /
--    'finance_readonly') also drops gross_cents from FINANCING_UNMATCHED: the preparer sees the count, the day and the
--    patient. hk_my_month: the doctor's own lines with their resolved method and fee share.
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400).
--
-- Payload contract (fin_hk_import_macro p_lines[]; the 0034 keys unchanged) + paid_on?: 'YYYY-MM-DD' | null (absent
-- = null; a payload without it is the 0034 payload and keeps its meaning):
--   basis 'payment'     optional; when given it must equal day; stored paid_on = day in any case.
--   basis 'production'  method 'unpaid': must be absent / null. Method 'cash' / 'card' / 'transfer': optional; when
--                       given a valid day not after the last day of the treatment's month (an advance before the
--                       treatment day is fine). The builder sends one 'transfer' line per (treatments row, payment
--                       day) with paid_on = that day and a positive amount (the day parts of a row add up to its
--                       transfer part of the month, refunds netted; each key unique, e.g. 't<row>:transfer:<day>');
--                       cash / card parts stay one line per method without paid_on (accepted when given, used for
--                       nothing). Several lines of one treatments row and method are accepted (they always were).
--   Errors (row position and day only, as 0033): 'Macro yüklemesi, <n>. satır (<DD.MM.YYYY>): ödeme tarihi geçersiz
--   (YYYY-AA-GG).' / '... ödeme raporu satırının ödeme tarihi kendi tarihi olmalı.' / '... ödenmemiş kısmın ödeme tarihi
--   olamaz.' / '... ödeme tarihi işlemin ayından sonra olamaz (ay sonundan sonraki ödemeler ödenmemiş sayılır).'
--
-- JSON shapes (changes against 0034; days 'YYYY-MM-DD'):
--   LineJson        + {paid_on} (every line record: fin_hk_month lines, fin_hk_save_line ...; null unless imported
--                   with a payment day).
--   fin_hk_month    lines[] + {resolved_method ('financing' when a part of the line is paid by a Burgan loan, else the
--                   line's method), financing_cents (that part of try_cents; = try_cents when the whole line matched,
--                   0 without a match), fee_cents (the bank's fee share used: 0 unless the line's rule is ciro_share)}
--                   next to resolved_segment (all three null on a voided line).
--   Component       by_method.financing + {fee} (always present on the financing key, 0 without Burgan-paid lines);
--                   by_method.financing.deduction = round((eligible − fee) × deduct_bp / 10000). Other keys unchanged.
--                   Statements closed before this file have no fee key (read as 0).
--   Warning         + {code: 'FINANCING_MATCHED', count (lines), gross_cents (Σ financing_cents), fee_cents (Σ
--                   fee_cents)} (ord 9; only when count > 0), + {code: 'FINANCING_UNMATCHED', count, financings:
--                   [{day (the loan's txn_date), patient (patient_name_raw, trimmed), gross_cents}] (by day, patient,
--                   id)} (ord 10; only when count > 0 and a live line of the month has a paid_on; without
--                   gross_cents for a caller without ledger access).
--   hk_my_month()   lines[] + {resolved_method, financing_cents, fee_cents}.
--
-- RUNBOOK (production is the only database):
--   1. Apply 0034 first. Quiet moment (a few seconds): fin_hk_lines gets a column, a constraint and an index in this
--      transaction. SQL editor → New query → paste this file ALONE → Run. One transaction; the self-checks at the end
--      (including a replay in a temporary clinic that is always rolled back) undo everything on any failure.
--   2. Deploy the web build (either order works: the 0034 import ignores paid_on; this file accepts payloads without
--      it).
--   3. Existing data: lines imported before this file have paid_on NULL and stay transfers until their range is
--      re-imported with the new build (the owner re-imports October). Closed months keep their statements (the frozen
--      breakdown); their live figures may differ once financing rows change (shown as "Kapanışta …").
--   Re-running 0030 – 0034 later puts back older bodies (and 0034's fin__hk_eval_lines result): re-run this file
--   afterwards.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Data: nothing must be undone (paid_on is ignored by the 0034 bodies; lines split per payment day are ordinary
--       transfer lines there).
--   (b) DROP FUNCTION public.fin__hk_eval_lines(uuid, date), public.fin__hk_financing_links(uuid, date); then re-run
--       the 0034 definitions of fin__hk_eval_lines, fin__hk_compute, fin__hk_month_json, fin_hk_import_macro and
--       hk_my_month, the 0033 definitions of fin__hk_line_json and fin__hk_macro_row and the 0031 definition of
--       fin__hk_strip_ledger. Then run SELECT public.fin__harden_privileges(); (the recreated fin__hk_eval_lines gets
--       PostgreSQL's default PUBLIC EXECUTE back; CREATE OR REPLACE keeps the ACL of the others, hk_my_month included).
--   (c) The column fin_hk_lines.paid_on, fin_hk_lines_paid_on and idx_fin_hk_lines_paid_on may stay (the 0034 bodies
--       never read or write them; the 0034 import leaves paid_on NULL) or be dropped. Statements of months closed after
--       this file keep the figures computed with it.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0034 live (the functions replaced here have the 0034 / 0033 / 0031 bodies and signatures, or this
--     file's on a re-run), the finance module's patient financing table, the expected columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_user_id', 'clinic_today', 'has_permission', 'fin_can_read',
                    'fin__require_write', 'fin__harden_privileges', 'fin__month_start', 'fin__normalize_name',
                    'fin__hk_doctor_name', 'fin__hk_round_div', 'fin__hk_iso_day', 'fin__hk_macro_text',
                    'fin__hk_segment', 'fin__hk_segment_src', 'fin__hk_child_age_limit', 'fin__hk_ortho_walk',
                    'fin__hk_eval_lab_costs', 'fin__hk_lab_alloc', 'fin__hk_ciro_lab_ids', 'fin__hk_month_row_json',
                    'fin__hk_statement_json', 'fin__hk_piece_json', 'fin__hk_lab_cost_json', 'fin__hk_adjustment_json',
                    'fin__hk_self_payee', 'fin__hk_payee_entry', 'fin__hk_fx_rate', 'fin__hk_require_prep_read',
                    'fin__hk_require_prep_write', 'fin__hk_close_lock', 'fin__hk_month_lock', 'fin_hk_month',
                    'fin_hk_close_month', 'fin_hk_save_line', 'fin_hk_save_lab_cost', 'fin_hk_save_proc_group',
                    'fin_hk_save_ext_doctor', 'grant_staff_permission']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0030 – 0034 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.fin__hk_line_json(uuid,uuid)',
    'public.fin__hk_strip_ledger(jsonb)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin__hk_macro_row(jsonb,boolean,integer,date,date)',
    'public.fin_hk_import_macro(uuid,date,date,jsonb,jsonb,text[],boolean)',
    'public.hk_my_month(date)',
    'public.fin__hk_round_div(numeric,numeric)',
    'public.fin__hk_segment_src(text,uuid,uuid,date,boolean,boolean,boolean)',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text,integer,uuid,boolean)',
    'public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date,boolean)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş fonksiyonları beklenen imzada değil (0034 uygulanmalı): %', v_missing;
  END IF;
  -- fin__hk_eval_lines: 0034's result (… segment_source) or this file's (… fee_cents) on a re-run.
  IF pg_get_function_result(to_regprocedure('public.fin__hk_eval_lines(uuid,date)')) NOT LIKE '%, segment_source text)'
     AND pg_get_function_result(to_regprocedure('public.fin__hk_eval_lines(uuid,date)')) NOT LIKE '%, fee_cents bigint)'
  THEN
    RAISE EXCEPTION 'fin__hk_eval_lines 0034 sürümünde değil (0034 uygulanmalı).';
  END IF;

  -- The bodies replaced below are 0034's (0033's / 0031's), or this file's, which keep these texts.
  SELECT string_agg(e.fn, ', ')
    INTO v_missing
  FROM (VALUES
    ('fin__hk_eval_lines', '%unmarked_default%'),
    ('fin__hk_compute', '%UNMARKED_AS_CHILD%'),
    ('fin__hk_month_json', '%segment_source%'),
    ('fin_hk_import_macro', '%returned_voided%'),
    ('hk_my_month', '%default_mode%'),
    ('fin__hk_line_json', '%macro_patient_no%'),
    ('fin__hk_macro_row', '%treatment_day%'),
    ('fin__hk_strip_ledger', '%NO_COUNTERPARTY%')
  ) AS e(fn, pat)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = e.fn AND p.prosrc LIKE e.pat
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Şu fonksiyonlar 0034 sürümünde değil: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_lines', 'id'), ('fin_hk_lines', 'clinic_id'), ('fin_hk_lines', 'source'), ('fin_hk_lines', 'day'),
    ('fin_hk_lines', 'method'), ('fin_hk_lines', 'patient_name'), ('fin_hk_lines', 'try_cents'),
    ('fin_hk_lines', 'implant_cents'), ('fin_hk_lines', 'voided_at'), ('fin_hk_lines', 'created_at'),
    ('fin_hk_lines', 'treatment_day'), ('fin_hk_lines', 'macro_basis'),
    ('fin_hk_pieces', 'macro_mode'), ('fin_hk_rules', 'unmarked_default'), ('fin_hk_patient_marks', 'is_adult'),
    ('fin_patient_financing', 'id'), ('fin_patient_financing', 'clinic_id'),
    ('fin_patient_financing', 'patient_name_raw'), ('fin_patient_financing', 'patient_id'),
    ('fin_patient_financing', 'txn_date'), ('fin_patient_financing', 'gross_cents'),
    ('fin_patient_financing', 'fee_cents'), ('fin_patient_financing', 'voided_at'),
    ('patients', 'id'), ('patients', 'clinic_id'), ('patients', 'full_name')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı (0022 ve 0034 uygulanmalı): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Lines: the payment day of an imported part paid in money (v2.3). Every existing row stays valid (NULL).
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_hk_lines
  ADD COLUMN IF NOT EXISTS paid_on date;
ALTER TABLE public.fin_hk_lines
  -- Only on an imported cash / card / transfer line: a payment report line on its own day, a treatments report line in
  -- or before its treatment's month (a payment after the month end is the 'unpaid' part).
  DROP CONSTRAINT IF EXISTS fin_hk_lines_paid_on,
  ADD CONSTRAINT fin_hk_lines_paid_on CHECK (
    paid_on IS NULL
    OR (source = 'import'
        AND method IN ('cash', 'card', 'transfer')
        AND paid_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'
        AND (macro_basis IS DISTINCT FROM 'payment' OR paid_on = day)
        AND (macro_basis IS DISTINCT FROM 'production'
             OR public.fin__month_start(paid_on) <= public.fin__month_start(day)))
  );
-- The matching looks up the live transfer lines of a patient by payment day (fin__hk_financing_links).
CREATE INDEX IF NOT EXISTS idx_fin_hk_lines_paid_on
  ON public.fin_hk_lines (clinic_id, paid_on) WHERE paid_on IS NOT NULL AND voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1.2 Row shapes (same signatures): LineJson + paid_on (0033 body); the payload of a caller without ledger access
--     (0031 body) + FINANCING_UNMATCHED without gross_cents.
-- ---------------------------------------------------------------------------
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
           'basis', l.macro_basis,
           'ext_doctor', l.ext_doctor,
           'procedure', l.procedure,
           'tooth', l.tooth,
           'treatment_day', l.treatment_day,
           'proc_group_id', l.proc_group_id,
           'proc_group_name', g.name,
           'macro_patient_no', l.macro_patient_no,
           'paid_on', l.paid_on,
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
  LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = l.clinic_id AND g.id = l.proc_group_id
  WHERE l.clinic_id = p_clinic AND l.id = p_id
$$;

-- Month payload without ledger data, for a caller without 'finance' / 'finance_readonly' (0031 body, same signature): no
-- counterparty ids on the payees or in the statement breakdowns, no NO_COUNTERPARTY warnings, statement entries null
-- (fin_entry_id stays); 0035 (v2.3): FINANCING_UNMATCHED lists the day and the patient of each financing, without
-- gross_cents.
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
      -- 0035 (v2.3): the day and the patient of an unmatched Burgan financing, never its amount.
      SELECT jsonb_agg(CASE WHEN (w.e ->> 'code') = 'FINANCING_UNMATCHED'
                            THEN w.e || jsonb_build_object('financings', coalesce((
                                   SELECT jsonb_agg(CASE WHEN jsonb_typeof(f.x) = 'object' THEN f.x - 'gross_cents'
                                                         ELSE f.x END
                                                    ORDER BY f.i)
                                   FROM jsonb_array_elements(
                                          CASE WHEN jsonb_typeof(w.e -> 'financings') = 'array'
                                               THEN w.e -> 'financings' ELSE '[]'::jsonb END)
                                          WITH ORDINALITY AS f(x, i)), '[]'::jsonb))
                            ELSE w.e END
                       ORDER BY w.o)
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

-- ---------------------------------------------------------------------------
-- 2. Internal helper (SECURITY INVOKER, never granted). Created before fin__hk_eval_lines, which calls it (SQL
--    function bodies are checked at creation).
-- ---------------------------------------------------------------------------

-- v2.3: the Burgan financing part of the live transfer lines that bear on month p_month (compute-time matching; see the
-- header for the rules):
--   fn    every live financing row of the clinic under each name it answers to: the normalized patient_name_raw and,
--         when linked, the normalized full name of its DentOS patient;
--   ml    the month's candidate lines (live, 'transfer', paid_on, amount > 0, day in the month);
--   rf    the financing rows in reach: within 3 days of a candidate line of the month of the same name, or dated in the
--         month (their lines are needed to list the unmatched ones);
--   al    every candidate line of any month that could belong to one of them (a name of the row, within 3 days);
--   pick  each line's financing row: the nearest of its name within 3 days (tie: the earliest txn_date, then id), kept
--         when it is one of rf (a line nearer to another row is that row's, never this one's);
--   cum   per row, its lines in (paid_on, treatment day, created_at, id) order take its gross amount until used up.
-- Returns every line (of any month) with a financing part > 0: its day, the row, the part and the row's gross / fee
-- (the fee share is computed by fin__hk_eval_lines from the line's eligible part). Callers keep the month's lines
-- (line_day) or look for a row without lines.
CREATE OR REPLACE FUNCTION public.fin__hk_financing_links(p_clinic uuid, p_month date)
RETURNS TABLE (line_id uuid, line_day date, financing_id uuid, financing_cents bigint, fin_gross_cents bigint,
               fin_fee_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH fn AS MATERIALIZED (
    SELECT f.id, f.txn_date, f.gross_cents, f.fee_cents, n.nn
    FROM public.fin_patient_financing f
    LEFT JOIN public.patients pt ON pt.clinic_id = f.clinic_id AND pt.id = f.patient_id
    CROSS JOIN LATERAL (
      SELECT public.fin__normalize_name(f.patient_name_raw) AS nn
      UNION
      SELECT public.fin__normalize_name(pt.full_name) WHERE pt.id IS NOT NULL
    ) n
    WHERE f.clinic_id = p_clinic
      AND f.voided_at IS NULL
      AND coalesce(n.nn, '') <> ''
  ),
  ml AS MATERIALIZED (
    SELECT l.paid_on, public.fin__normalize_name(l.patient_name) AS nn
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = p_clinic
      AND l.voided_at IS NULL
      AND l.method = 'transfer'
      AND l.paid_on IS NOT NULL
      AND l.try_cents > 0
      AND l.day >= public.fin__month_start(p_month)
      AND l.day < (public.fin__month_start(p_month) + interval '1 month')::date
  ),
  rf AS MATERIALIZED (
    SELECT DISTINCT fn.id
    FROM fn
    WHERE (fn.txn_date >= public.fin__month_start(p_month)
           AND fn.txn_date < (public.fin__month_start(p_month) + interval '1 month')::date)
       OR EXISTS (SELECT 1 FROM ml WHERE ml.nn = fn.nn AND abs(ml.paid_on - fn.txn_date) <= 3)
  ),
  rn AS MATERIALIZED (
    SELECT fn.nn, fn.txn_date
    FROM fn
    WHERE fn.id IN (SELECT rf.id FROM rf)
  ),
  al AS MATERIALIZED (
    SELECT l.id, l.day, coalesce(l.treatment_day, l.day) AS tday, l.paid_on, l.created_at, l.try_cents, x.nn
    FROM public.fin_hk_lines l
    CROSS JOIN LATERAL (SELECT public.fin__normalize_name(l.patient_name) AS nn) x
    WHERE l.clinic_id = p_clinic
      AND l.voided_at IS NULL
      AND l.method = 'transfer'
      AND l.paid_on IS NOT NULL
      AND l.try_cents > 0
      AND l.paid_on >= (SELECT min(rn.txn_date) - 3 FROM rn)
      AND l.paid_on <= (SELECT max(rn.txn_date) + 3 FROM rn)
      AND EXISTS (SELECT 1 FROM rn WHERE rn.nn = x.nn AND abs(l.paid_on - rn.txn_date) <= 3)
  ),
  pick AS (
    SELECT al.id, al.day, al.tday, al.paid_on, al.created_at, al.try_cents,
           f.id AS fid, f.gross_cents, f.fee_cents
    FROM al
    CROSS JOIN LATERAL (
      SELECT fn.id, fn.gross_cents, fn.fee_cents
      FROM fn
      WHERE fn.nn = al.nn AND abs(al.paid_on - fn.txn_date) <= 3
      ORDER BY abs(al.paid_on - fn.txn_date), fn.txn_date, fn.id
      LIMIT 1
    ) f
    WHERE f.id IN (SELECT rf.id FROM rf)
  ),
  cum AS (
    SELECT p.id, p.day, p.try_cents, p.fid, p.gross_cents, p.fee_cents,
           coalesce(sum(p.try_cents) OVER (PARTITION BY p.fid
                                           ORDER BY p.paid_on, p.tday, p.created_at, p.id
                                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS taken
    FROM pick p
  )
  SELECT c.id, c.day, c.fid, LEAST(c.try_cents, c.gross_cents - c.taken)::bigint, c.gross_cents, c.fee_cents
  FROM cum c
  WHERE c.taken < c.gross_cents
$$;

-- ---------------------------------------------------------------------------
-- 3. Line evaluation (0034 body). Changes: + the Burgan financing part of a transfer line (fin__hk_financing_links)
--    as resolved_method / financing_id / financing_cents / financing_implant_cents / financing_lab_cents / fee_cents
--    (last result columns). The segment and the rule lookup are unchanged. A new result column cannot be added by
--    CREATE OR REPLACE: the function is dropped first (its callers, fin__hk_compute, fin__hk_month_json and
--    hk_my_month, all replaced below, read its columns by name).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fin__hk_eval_lines(uuid, date);

-- Every live line of the month with its resolved segment, its rule (NULL = unruled), its lab part, the source of its
-- segment (0034) and (0035) its Burgan financing part with the bank's fee share.
CREATE OR REPLACE FUNCTION public.fin__hk_eval_lines(p_clinic uuid, p_month date)
RETURNS TABLE (line_id uuid, doctor_id uuid, patient_ref text, method text, try_cents bigint, implant_cents bigint,
               segment text, rule_id uuid, rule_kind text, payee_user_id uuid, lab_part_cents bigint,
               segment_source text, resolved_method text, financing_id uuid, financing_cents bigint,
               financing_implant_cents bigint, financing_lab_cents bigint, fee_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH ar AS (
    SELECT r.id, r.kind, r.doctor_id, r.segment, r.payee_user_id, r.unmarked_default
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = p_clinic
      AND r.kind IN ('ciro_share', 'ortho_lab_first')
      AND r.from_month <= public.fin__month_start(p_month)
      AND (r.to_month IS NULL OR r.to_month >= public.fin__month_start(p_month))
  ),
  -- 0034 (v2.2): doctors whose active child ciro_share rule counts unmarked patients as children.
  udf AS (
    SELECT DISTINCT ar.doctor_id
    FROM ar
    WHERE ar.kind = 'ciro_share' AND ar.segment = 'child' AND ar.unmarked_default
  ),
  walk AS (
    SELECT w.line_id, w.lab_part_cents
    FROM public.fin__hk_ortho_walk(p_clinic, p_month) w
  ),
  -- 0035 (v2.3): the Burgan financing part of the month's transfer lines (fin__hk_financing_links).
  fl AS (
    SELECT k.line_id, k.financing_id, k.financing_cents, k.fin_gross_cents, k.fin_fee_cents
    FROM public.fin__hk_financing_links(p_clinic, p_month) k
    WHERE k.line_day >= public.fin__month_start(p_month)
      AND k.line_day < (public.fin__month_start(p_month) + interval '1 month')::date
  ),
  ln AS (
    SELECT l.id, l.doctor_id, l.patient_ref, l.method, l.try_cents, l.implant_cents, l.created_at, l.day,
           public.fin__hk_segment(l.segment, l.doctor_id, l.day, m.own_doctor_id, m.birth_date, m.is_child,
                                  m.is_adult, u.doctor_id IS NOT NULL, lim.age_limit) AS seg,
           public.fin__hk_segment_src(l.segment, l.doctor_id, m.own_doctor_id, m.birth_date, m.is_child,
                                      m.is_adult, u.doctor_id IS NOT NULL) AS seg_src
    FROM public.fin_hk_lines l
    CROSS JOIN (SELECT public.fin__hk_child_age_limit(p_clinic) AS age_limit) lim
    LEFT JOIN LATERAL (
      -- 0033: the mark of the row's own key; a Macro key ('macro:' || file number) without one takes the mark keyed by
      -- the bare file number, else the mark of the normalized patient name (marks entered before the import).
      SELECT mk.own_doctor_id, mk.birth_date, mk.is_child, mk.is_adult
      FROM public.fin_hk_patient_marks mk
      WHERE mk.clinic_id = l.clinic_id
        AND (mk.patient_ref = l.patient_ref
             OR (l.patient_ref LIKE 'macro:%'
                 AND mk.patient_ref IN (substr(l.patient_ref, 7), public.fin__normalize_name(l.patient_name))))
      ORDER BY CASE WHEN mk.patient_ref = l.patient_ref THEN 0
                    WHEN mk.patient_ref = substr(l.patient_ref, 7) THEN 1
                    ELSE 2 END
      LIMIT 1
    ) m ON true
    LEFT JOIN udf u ON u.doctor_id = l.doctor_id
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
         (CASE WHEN x.kind = 'ortho_lab_first' THEN coalesce(w.lab_part_cents, 0) ELSE 0 END)::bigint,
         ln.seg_src,
         -- 0035 (v2.3): 'financing' when a part of the line is paid by a Burgan loan; that part, its implant and lab
         -- shares, and the bank's fee share of its eligible amount (a ciro_share rule's line only).
         CASE WHEN fp.fin > 0 THEN 'financing' ELSE ln.method END,
         k.financing_id,
         fp.fin,
         fp.fimp,
         fp.flab,
         (CASE WHEN x.kind = 'ciro_share' AND fp.fin > 0
               THEN public.fin__hk_round_div((fp.fin - fp.fimp - fp.flab)::numeric * k.fin_fee_cents,
                                             k.fin_gross_cents)
               ELSE 0 END)::bigint
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
  LEFT JOIN fl k ON k.line_id = ln.id
  -- The financing part F of the line; its implant share (all of F when the whole line matched, else pro rata) and its
  -- lab share (an orthodontist's line; pro rata, at most F minus the implant share).
  CROSS JOIN LATERAL (
    SELECT y.fin,
           y.fimp,
           LEAST(CASE WHEN y.fin = 0 THEN 0
                      WHEN y.fin = ln.try_cents THEN y.lab
                      ELSE public.fin__hk_round_div(y.lab::numeric * y.fin, ln.try_cents) END,
                 y.fin - y.fimp)::bigint AS flab
    FROM (SELECT coalesce(k.financing_cents, 0)::bigint AS fin,
                 (CASE WHEN k.financing_cents IS NULL THEN 0
                       WHEN k.financing_cents = ln.try_cents THEN ln.implant_cents
                       ELSE public.fin__hk_round_div(ln.implant_cents::numeric * k.financing_cents, ln.try_cents)
                  END)::bigint AS fimp,
                 (CASE WHEN x.kind = 'ortho_lab_first' THEN coalesce(w.lab_part_cents, 0) ELSE 0 END)::bigint AS lab) y
  ) fp
$$;

-- ---------------------------------------------------------------------------
-- 4. Calculation (0034 body, same signature). Changes: the buckets add up line parts (a line's financing part in the
--    'financing' bucket, the rest under its method; lines_count unchanged); the financing bucket's fee (Σ fee_cents),
--    its deduction on eligible − fee and its base share eligible − fee − deduction; by_method.financing + {fee};
--    warnings FINANCING_MATCHED (ord 9) and FINANCING_UNMATCHED (ord 10; only in a month that has live lines with a
--    payment day; before that, e.g. a month imported before this file or never imported, no warning). The clinic
--    total (clinic_ciro_share base) stays the gross of every live line. Without lines with a payment day the figures
--    are the 0034 ones.
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
           r.deduct_unpaid_bp, r.proc_group_id,
           public.fin__hk_doctor_name(r.doctor_id) AS doctor_name
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = p_clinic
      AND r.from_month <= v_month
      AND (r.to_month IS NULL OR r.to_month >= v_month)
  ),
  ev AS MATERIALIZED (
    SELECT * FROM public.fin__hk_eval_lines(p_clinic, v_month)
  ),
  -- 0035 (v2.3): a line's Burgan financing part goes to the 'financing' bucket with its implant / lab shares and the
  -- bank's fee share; the rest of the line stays under its own method. n: every line counts once (in the financing
  -- bucket when it has a financing part).
  evp AS MATERIALIZED (
    SELECT ev.rule_id, 'financing'::text AS method, ev.financing_cents AS try_cents,
           ev.financing_implant_cents AS implant_cents, ev.financing_lab_cents AS lab_part_cents, ev.fee_cents,
           1 AS n
    FROM ev
    WHERE ev.financing_cents > 0
    UNION ALL
    SELECT ev.rule_id, ev.method, ev.try_cents - ev.financing_cents, ev.implant_cents - ev.financing_implant_cents,
           ev.lab_part_cents - ev.financing_lab_cents, 0::bigint,
           CASE WHEN ev.financing_cents > 0 THEN 0 ELSE 1 END
    FROM ev
    WHERE ev.try_cents <> ev.financing_cents
  ),
  -- 0035 (v2.3): the financing rows with a line of any month (a row dated in the month without one:
  -- FINANCING_UNMATCHED, only in a month that has live lines with a payment day; before that, e.g. a month imported
  -- before this file or never imported, no warning).
  fink AS MATERIALIZED (
    SELECT DISTINCT k.financing_id
    FROM public.fin__hk_financing_links(p_clinic, v_month) k
  ),
  -- 0032 (v1.4): the month's live lab costs with their rule; Σ per ciro_share rule (ortho costs stay with the walk).
  lcost AS MATERIALIZED (
    SELECT * FROM public.fin__hk_eval_lab_costs(p_clinic, v_month)
  ),
  lab_rule AS (
    SELECT l.rule_id, sum(l.amount_cents)::bigint AS total
    FROM lcost l
    WHERE l.rule_kind = 'ciro_share'
    GROUP BY l.rule_id
  ),
  -- 0033: 'unpaid' = the part of a treatment not paid by the end of its month (imported production lines).
  meth (ord, method) AS (
    VALUES (1, 'cash'), (2, 'card'), (3, 'transfer'), (4, 'financing'), (5, 'unpaid')
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
             WHEN 'unpaid' THEN ar.deduct_unpaid_bp
             ELSE ar.deduct_financing_bp
           END AS bp,
           coalesce(s.gross, 0)::bigint AS gross,
           coalesce(s.implant, 0)::bigint AS implant,
           coalesce(s.lab, 0)::bigint AS lab,
           coalesce(s.fee, 0)::bigint AS fee,
           coalesce(s.n, 0)::bigint AS n
    FROM ar
    CROSS JOIN meth
    LEFT JOIN LATERAL (
      SELECT sum(ev.try_cents) AS gross,
             sum(ev.implant_cents) AS implant,
             sum(ev.lab_part_cents) AS lab,
             sum(ev.fee_cents) AS fee,
             sum(ev.n) AS n
      FROM evp ev
      WHERE ev.rule_id = ar.id AND ev.method = meth.method
    ) s ON true
    WHERE ar.kind IN ('ciro_share', 'ortho_lab_first')
      -- 0033: the 'unpaid' bucket only for a rule with an unpaid deduction or unpaid lines (else the 0032 keys).
      AND (meth.method <> 'unpaid' OR ar.deduct_unpaid_bp <> 0 OR s.n > 0)
  ),
  bucket_d AS (
    SELECT b.rule_id, b.ord, b.method, b.bp, b.gross, b.implant, b.lab, b.n, b.fee,
           b.gross - b.implant - b.lab AS eligible,
           -- 0035 (v2.3): the deduction of the financing bucket is taken from its eligible amount net of the fee.
           round((b.gross - b.implant - b.lab - b.fee)::numeric * b.bp / 10000)::bigint AS deduction
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
             'deduction', b.deduction)
             -- 0035 (v2.3): the bank's fee share on the financing key (0 without Burgan-paid lines).
             || CASE WHEN b.method = 'financing' THEN jsonb_build_object('fee', b.fee) ELSE '{}'::jsonb END)
             AS by_method,
           sum(b.eligible - b.fee - b.deduction)::bigint AS base,
           sum(b.n)::bigint AS n
    FROM bucket_d b
    GROUP BY b.rule_id
  ),
  -- 0033: the month's live pieces with a doctor; implant type = no group (a manual piece) or an is_implant group.
  pcl AS MATERIALIZED (
    SELECT p.doctor_id, p.proc_group_id, coalesce(g.is_implant, true) AS implant_type, p.qty
    FROM public.fin_hk_pieces p
    LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = p.clinic_id AND g.id = p.proc_group_id
    WHERE p.clinic_id = p_clinic AND p.voided_at IS NULL AND p.day >= v_month AND p.day < v_next
      AND p.doctor_id IS NOT NULL
  ),
  -- implant_piece: the doctor's implant-type pieces (0032: every piece of the doctor; the same without groups).
  pcs AS (
    SELECT p.doctor_id, sum(p.qty)::bigint AS qty, count(*)::bigint AS n
    FROM pcl p
    WHERE p.implant_type
    GROUP BY p.doctor_id
  ),
  -- 0033, procedure_piece: the doctor's pieces of one group.
  pcg AS (
    SELECT p.doctor_id, p.proc_group_id, sum(p.qty)::bigint AS qty, count(*)::bigint AS n
    FROM pcl p
    WHERE p.proc_group_id IS NOT NULL
    GROUP BY p.doctor_id, p.proc_group_id
  ),
  -- 0033: group names and their order (a doctor's procedure_piece components by group name).
  pgrp AS (
    SELECT g.id, g.name, row_number() OVER (ORDER BY g.name COLLATE "tr-x-icu", g.id) AS rk
    FROM public.fin_hk_proc_groups g
    WHERE g.clinic_id = p_clinic
  ),
  gross AS (
    SELECT coalesce(sum(l.try_cents), 0)::bigint AS total, count(*)::bigint AS n
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = p_clinic AND l.voided_at IS NULL AND l.day >= v_month AND l.day < v_next
  ),
  walk AS MATERIALIZED (
    SELECT * FROM public.fin__hk_ortho_walk(p_clinic, v_month)
  ),
  -- 0032 (v1.4): costs deducted from a ciro_share rule in their own month (left out of the walk too).
  xc AS MATERIALIZED (
    SELECT x.lab_cost_id FROM public.fin__hk_ciro_lab_ids(p_clinic, v_next) x
  ),
  -- Per-patient lab figures of the ortho doctors, to date (months <= this month; 0032: without xc).
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
      AND c.id NOT IN (SELECT xc.lab_cost_id FROM xc)
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
           CASE ar.kind WHEN 'ciro_share' THEN 1 WHEN 'ortho_lab_first' THEN 2 WHEN 'implant_piece' THEN 3
                        WHEN 'procedure_piece' THEN 3 ELSE 4 END
             AS kind_ord,
           -- 0033: a doctor's procedure_piece components after the implant_piece one, by group name.
           CASE WHEN ar.kind = 'procedure_piece' THEN coalesce(gr.rk, 0)
                ELSE CASE ar.segment WHEN 'standard' THEN 1 WHEN 'child' THEN 2 WHEN 'own' THEN 3 ELSE 0 END
           END AS seg_ord,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN sh.by_method END AS by_method,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN lx.base
                WHEN ar.kind = 'clinic_ciro_share' THEN g.total
           END AS base_cents,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first')
                  THEN round(lx.base::numeric * ar.share_bp / 10000)::bigint
                WHEN ar.kind = 'implant_piece' THEN coalesce(pc.qty, 0) * ar.piece_cents
                WHEN ar.kind = 'procedure_piece' THEN coalesce(pq.qty, 0) * ar.piece_cents
                ELSE round(g.total::numeric * ar.share_bp / 10000)::bigint
           END AS amount_cents,
           CASE WHEN ar.kind = 'implant_piece' THEN coalesce(pc.qty, 0)
                WHEN ar.kind = 'procedure_piece' THEN coalesce(pq.qty, 0)
           END AS qty,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN coalesce(sh.n, 0)
                WHEN ar.kind = 'implant_piece' THEN coalesce(pc.n, 0)
                WHEN ar.kind = 'procedure_piece' THEN coalesce(pq.n, 0)
                ELSE g.n
           END AS lines_count,
           CASE WHEN ar.kind = 'ortho_lab_first' THEN coalesce(lp.items, '[]'::jsonb) END AS lab_patients,
           coalesce(sh.base, 0) AS ciro_after,
           lr.total AS lab_total,
           lx.lab_cents,
           ar.proc_group_id,
           gr.name AS proc_group_name
    FROM ar
    CROSS JOIN gross g
    LEFT JOIN rule_sum sh ON sh.rule_id = ar.id
    LEFT JOIN pcs pc ON ar.kind = 'implant_piece' AND pc.doctor_id = ar.doctor_id
    LEFT JOIN pcg pq ON ar.kind = 'procedure_piece' AND pq.doctor_id = ar.doctor_id
                    AND pq.proc_group_id = ar.proc_group_id
    LEFT JOIN pgrp gr ON ar.kind = 'procedure_piece' AND gr.id = ar.proc_group_id
    LEFT JOIN lab_pat lp ON ar.kind = 'ortho_lab_first' AND lp.doctor_id = ar.doctor_id
    LEFT JOIN lab_rule lr ON ar.kind = 'ciro_share' AND lr.rule_id = ar.id
    -- 0032 (v1.4), ciro_share with lab costs of the month (else lab_cents NULL and the 0031 base): C = Σ(eligible −
    -- deduction), L = Σ lab costs; lab_cents = L when L <= 0, else min(L, max(C, 0)); base = C − lab_cents.
    CROSS JOIN LATERAL (
      SELECT y.lab_cents, coalesce(sh.base, 0) - coalesce(y.lab_cents, 0) AS base
      FROM (SELECT CASE WHEN lr.rule_id IS NULL THEN NULL::bigint
                        WHEN lr.total <= 0 THEN lr.total
                        ELSE LEAST(lr.total, GREATEST(coalesce(sh.base, 0), 0))
                   END AS lab_cents) y
    ) lx
    WHERE ar.kind IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'procedure_piece', 'clinic_ciro_share')
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
  cj0 AS (
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
             'lab_patients', c.lab_patients)
           -- 0032 (v1.4): only on a ciro_share component with lab costs of the month.
           || CASE WHEN c.lab_cents IS NOT NULL
                   THEN jsonb_build_object('lab_cents', c.lab_cents, 'lab_excess_cents', c.lab_total - c.lab_cents)
                   ELSE '{}'::jsonb END
           -- 0033: only on a procedure_piece component.
           || CASE WHEN c.kind = 'procedure_piece'
                   THEN jsonb_build_object('proc_group_id', c.proc_group_id, 'proc_group_name', c.proc_group_name)
                   ELSE '{}'::jsonb END AS j
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
  -- 0032 (v1.4): the payee's minimum_monthly floor (one rule per payee and month through fin_hk_save_rule's overlap
  -- check; the highest should rows ever overlap). When the other components add up to less, a last component
  -- {rule_id, kind 'minimum_topup', amount_cents = floor − Σ} makes the total the floor (a payee with only a floor
  -- gets it whole); none when Σ >= floor.
  comp_sum AS (
    SELECT c.payee_user_id, sum(c.amount_cents)::bigint AS total
    FROM cj0 c
    GROUP BY c.payee_user_id
  ),
  floor_rule AS (
    SELECT DISTINCT ON (ar.payee_user_id) ar.payee_user_id, ar.id, ar.piece_cents
    FROM ar
    WHERE ar.kind = 'minimum_monthly'
    ORDER BY ar.payee_user_id, ar.piece_cents DESC, ar.id
  ),
  cj AS (
    SELECT c.payee_user_id, c.amount_cents, c.kind_ord, c.sort_name, c.seg_ord, c.sort_id, c.j
    FROM cj0 c
    UNION ALL
    SELECT f.payee_user_id,
           f.piece_cents - coalesce(s.total, 0),
           7,
           NULL::text,
           0,
           f.id,
           jsonb_build_object(
             'rule_id', f.id,
             'kind', 'minimum_topup',
             'amount_cents', f.piece_cents - coalesce(s.total, 0))
    FROM floor_rule f
    LEFT JOIN comp_sum s ON s.payee_user_id = f.payee_user_id
    WHERE coalesce(s.total, 0) < f.piece_cents
  ),
  -- payroll_only: only fixed_monthly / adjustments (/ minimum_topup, 0032) components. Such a payee without a doctors
  -- row is staff (paid through the personnel bucket at close) and its counterparty is the staff counterparty linked to
  -- the user.
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
      AND ev.doctor_id IS NOT NULL   -- 0033: a clinic / outside line counts only in the clinic total
    GROUP BY ev.doctor_id
    UNION ALL
    SELECT 2,
           public.fin__hk_doctor_name(pc.doctor_id),
           jsonb_build_object(
             'code', 'UNRULED_PIECES',
             'doctor_id', pc.doctor_id,
             'doctor_name', public.fin__hk_doctor_name(pc.doctor_id),
             'qty', pc.qty)
    -- 0033: implant-type pieces covered neither by the doctor's implant_piece rule nor by a procedure_piece rule of
    -- their group (0032: the doctor's pieces without an implant_piece rule; the same without groups).
    FROM (
      SELECT p.doctor_id, sum(p.qty)::bigint AS qty
      FROM pcl p
      WHERE p.implant_type
        AND NOT EXISTS (SELECT 1 FROM ar WHERE ar.kind = 'implant_piece' AND ar.doctor_id = p.doctor_id)
        AND NOT EXISTS (SELECT 1 FROM ar
                        WHERE ar.kind = 'procedure_piece' AND ar.doctor_id = p.doctor_id
                          AND ar.proc_group_id = p.proc_group_id)
      GROUP BY p.doctor_id
    ) pc
    WHERE pc.qty <> 0
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
    UNION ALL
    -- 0032 (v1.4): the month's lab costs of a doctor without a rule to deduct them from (not 0 in sum).
    SELECT 5,
           public.fin__hk_doctor_name(l.doctor_id),
           jsonb_build_object(
             'code', 'UNRULED_LAB',
             'doctor_id', l.doctor_id,
             'doctor_name', public.fin__hk_doctor_name(l.doctor_id),
             'lab_cents', sum(l.amount_cents)::bigint)
    FROM lcost l
    WHERE l.rule_id IS NULL
    GROUP BY l.doctor_id
    HAVING sum(l.amount_cents) <> 0
    UNION ALL
    -- 0032 (v1.4): a ciro_share rule's lab costs above its ciro after the method deductions (the excess stays with
    -- the clinic).
    SELECT 6,
           c.doctor_name,
           jsonb_build_object(
             'code', 'LAB_OVER_CIRO',
             'doctor_id', c.doctor_id,
             'doctor_name', c.doctor_name,
             'rule_id', c.rule_id,
             'segment', c.segment,
             'lab_cents', c.lab_total,
             'ciro_after_deductions_cents', c.ciro_after,
             'excess_cents', c.lab_total - c.lab_cents)
    FROM comp c
    WHERE c.lab_cents IS NOT NULL
      AND c.lab_total - c.lab_cents > 0
    UNION ALL
    -- 0033: the month's live imported pieces without a doctor that the preparer has not marked "Hakediş yok" (one
    -- warning, per group; the close is not blocked).
    SELECT 7,
           NULL::text,
           jsonb_build_object(
             'code', 'UNASSIGNED_PIECES',
             'count', sum(u.qty)::bigint,
             'groups', jsonb_agg(jsonb_build_object('proc_group_id', u.proc_group_id, 'name', u.name, 'count', u.qty)
                                 ORDER BY u.name COLLATE "tr-x-icu", u.proc_group_id))
    FROM (
      SELECT p.proc_group_id, g.name, sum(p.qty)::bigint AS qty
      FROM public.fin_hk_pieces p
      LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = p.clinic_id AND g.id = p.proc_group_id
      WHERE p.clinic_id = p_clinic AND p.voided_at IS NULL AND p.day >= v_month AND p.day < v_next
        AND p.doctor_id IS NULL AND NOT p.assigned_none
      GROUP BY p.proc_group_id, g.name
    ) u
    HAVING count(*) > 0
    UNION ALL
    -- 0034 (v2.2): per doctor, the lines counted as a child's only because the patient has no child / adult
    -- information and the doctor's child rule counts unmarked patients as children (informational: an adult patient
    -- needs an adult mark; the close is not blocked).
    SELECT 8,
           public.fin__hk_doctor_name(ev.doctor_id),
           jsonb_build_object(
             'code', 'UNMARKED_AS_CHILD',
             'doctor_id', ev.doctor_id,
             'doctor_name', public.fin__hk_doctor_name(ev.doctor_id),
             'patients', count(DISTINCT ev.patient_ref),
             'lines', count(*))
    FROM ev
    WHERE ev.segment_source = 'unmarked_default'
    GROUP BY ev.doctor_id
    UNION ALL
    -- 0035 (v2.3): the month's lines with a Burgan financing part (informational).
    SELECT 9,
           NULL::text,
           jsonb_build_object(
             'code', 'FINANCING_MATCHED',
             'count', count(*),
             'gross_cents', sum(ev.financing_cents)::bigint,
             'fee_cents', sum(ev.fee_cents)::bigint)
    FROM ev
    WHERE ev.financing_cents > 0
    HAVING count(*) > 0
    UNION ALL
    -- 0035 (v2.3): the month's live financing rows that no transfer line of any month matched, in a month with lines
    -- imported with payment days (a live line of the month with a paid_on, which only an import after this file
    -- sets; a month imported before this file or never imported lists nothing, so its loans are never read here), so
    -- the preparer can check the patient names (the amount is left out for a caller without ledger access:
    -- fin__hk_strip_ledger).
    SELECT 10,
           NULL::text,
           jsonb_build_object(
             'code', 'FINANCING_UNMATCHED',
             'count', count(*),
             'financings', jsonb_agg(jsonb_build_object(
                             'day', f.txn_date,
                             'patient', btrim(f.patient_name_raw),
                             'gross_cents', f.gross_cents)
                             ORDER BY f.txn_date, btrim(f.patient_name_raw) COLLATE "tr-x-icu", f.id))
    FROM public.fin_patient_financing f
    WHERE f.clinic_id = p_clinic AND f.voided_at IS NULL AND f.txn_date >= v_month AND f.txn_date < v_next
      AND NOT EXISTS (SELECT 1 FROM fink k WHERE k.financing_id = f.id)
      AND EXISTS (SELECT 1 FROM public.fin_hk_lines l
                  WHERE l.clinic_id = p_clinic AND l.voided_at IS NULL AND l.paid_on IS NOT NULL
                    AND l.day >= v_month AND l.day < v_next)
    HAVING count(*) > 0
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
             SELECT jsonb_agg(w.w ORDER BY w.ord, w.sort_name COLLATE "tr-x-icu", (w.w ->> 'payee_user_id')::uuid,
                                           (w.w ->> 'doctor_id')::uuid,
                                           CASE (w.w ->> 'segment') WHEN 'standard' THEN 1 WHEN 'child' THEN 2
                                                                    WHEN 'own' THEN 3 ELSE 0 END)
             FROM warn w), '[]'::jsonb))
    INTO v_result;

  RETURN v_result;
END;
$$;

-- One month for the Hakediş screens (0034 body, same signature) + 0035: lines[] + {resolved_method, financing_cents,
-- fee_cents} (null on a voided line). The payload of a caller without ledger access still goes through
-- fin__hk_strip_ledger.
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
  v_c jsonb;
  v_lab jsonb;
  v_lab_totals jsonb;
  v_result jsonb;
BEGIN
  v_c := public.fin__hk_compute(p_clinic, v_month);

  -- 0032 (v1.4): doctor × lab rows of the month, then their sums per lab (fin__hk_lab_alloc over these payees).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'doctor_id', s.doctor_id,
           'doctor_name', s.doctor_name,
           'lab_name', s.lab_name,
           'cost_cents', s.cost_cents,
           'deducted_cents', s.deducted_cents,
           'count', s.n)
           ORDER BY s.doctor_name COLLATE "tr-x-icu", s.doctor_id, s.lab_name COLLATE "tr-x-icu",
                    s.lab_name COLLATE "C"), '[]'::jsonb)
    INTO v_lab
  FROM (
    SELECT a.doctor_id,
           public.fin__hk_doctor_name(a.doctor_id) AS doctor_name,
           a.lab_name,
           sum(a.cost_cents)::bigint AS cost_cents,
           sum(a.deducted_cents)::bigint AS deducted_cents,
           sum(a.n)::bigint AS n
    FROM public.fin__hk_lab_alloc(p_clinic, v_month, v_c -> 'payees') a
    GROUP BY a.doctor_id, a.lab_name
  ) s;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'lab_name', t.lab_name,
           'cost_cents', t.cost_cents,
           'deducted_cents', t.deducted_cents,
           'count', t.n)
           ORDER BY t.lab_name COLLATE "tr-x-icu", t.lab_name COLLATE "C"), '[]'::jsonb)
    INTO v_lab_totals
  FROM (
    SELECT r ->> 'lab_name' AS lab_name,
           sum((r ->> 'cost_cents')::bigint)::bigint AS cost_cents,
           sum((r ->> 'deducted_cents')::bigint)::bigint AS deducted_cents,
           sum((r ->> 'count')::bigint)::bigint AS n
    FROM jsonb_array_elements(v_lab) r
    GROUP BY r ->> 'lab_name'
  ) t;

  v_result := v_c
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
                                 'segment_source', ev.segment_source,
                                 'rule_id', ev.rule_id,
                                 'rule_kind', ev.rule_kind,
                                 'payee_user_id', ev.payee_user_id,
                                 'lab_part', ev.lab_part_cents,
                                 'resolved_method', ev.resolved_method,
                                 'financing_cents', ev.financing_cents,
                                 'fee_cents', ev.fee_cents)
                            ORDER BY l.day, l.created_at, l.id)
           FROM public.fin_hk_lines l
           LEFT JOIN public.fin__hk_eval_lines(p_clinic, v_month) ev ON ev.line_id = l.id
           WHERE l.clinic_id = p_clinic AND l.day >= v_month AND l.day < v_next), '[]'::jsonb),
         'pieces', coalesce((
           SELECT jsonb_agg(public.fin__hk_piece_json(p_clinic, p.id) ORDER BY p.day, p.created_at, p.id)
           FROM public.fin_hk_pieces p
           WHERE p.clinic_id = p_clinic AND p.day >= v_month AND p.day < v_next), '[]'::jsonb),
         'lab_costs', coalesce((
           SELECT jsonb_agg(public.fin__hk_lab_cost_json(p_clinic, c.id)
                            || jsonb_build_object(
                                 'resolved_segment', ec.segment,
                                 'segment_source', ec.segment_source,
                                 'rule_id', ec.rule_id)
                            ORDER BY c.day, c.created_at, c.id)
           FROM public.fin_hk_lab_costs c
           LEFT JOIN public.fin__hk_eval_lab_costs(p_clinic, v_month) ec ON ec.lab_cost_id = c.id
           WHERE c.clinic_id = p_clinic AND c.day >= v_month AND c.day < v_next), '[]'::jsonb),
         'lab_summary', v_lab,
         'lab_totals', v_lab_totals,
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
-- 5. Macro import (SECURITY DEFINER RPC, search_path = public; granted to authenticated by fin__harden_privileges).
-- ---------------------------------------------------------------------------

-- One element of fin_hk_import_macro's p_lines / p_pieces (0033 body, same signature) + 0035 (v2.3): paid_on (see the
-- payload contract in the header): validated and returned ({..., paid_on}; null on a piece, an 'unpaid' part and a
-- line without it; a payment report line's own day).
CREATE OR REPLACE FUNCTION public.fin__hk_macro_row(p_e jsonb, p_is_line boolean, p_n integer, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_label text := p_n::text || '. ' || CASE WHEN p_is_line THEN 'satır' ELSE 'işlem' END;
  v_key text;
  v_day date;
  v_tday date;
  v_basis text;
  v_ext text;
  v_name text;
  v_no text;
  v_proc text;
  v_tooth text;
  v_method text;
  v_currency text;
  v_num numeric;
  v_amount bigint;
  v_qty integer := 1;
  v_paid date;
BEGIN
  IF jsonb_typeof(p_e) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: kayıt biçimi geçersiz.', v_label;
  END IF;
  IF jsonb_typeof(p_e -> 'key') = 'string' THEN
    v_key := left(p_e ->> 'key', 100);
  END IF;
  IF jsonb_typeof(p_e -> 'day') = 'string' THEN
    v_day := public.fin__hk_iso_day(p_e ->> 'day');
  END IF;
  IF v_day IS NULL THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: tarih geçersiz (YYYY-AA-GG).', v_label;
  END IF;
  IF jsonb_typeof(p_e -> 'patient_name') = 'string' THEN
    v_name := btrim(p_e ->> 'patient_name');
  END IF;
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Macro yüklemesi, % (%): hasta adı boş olamaz ve en fazla 200 karakter olabilir.',
      v_label, to_char(v_day, 'DD.MM.YYYY');
  END IF;
  v_label := v_label || ' (' || to_char(v_day, 'DD.MM.YYYY') || ')';
  IF v_day < p_from OR v_day > p_to THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: tarih seçilen aralığın dışında.', v_label;
  END IF;
  IF jsonb_typeof(p_e -> 'ext_doctor') = 'string' THEN
    v_ext := regexp_replace(btrim(p_e ->> 'ext_doctor'), '\s+', ' ', 'g');
  END IF;
  IF v_ext IS NULL OR char_length(v_ext) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: Macro hekim adı boş olamaz ve en fazla 120 karakter olabilir.', v_label;
  END IF;
  v_no := public.fin__hk_macro_text(p_e -> 'patient_no');
  IF char_length(v_no) > 50 THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: hasta dosya numarası en fazla 50 karakter olabilir.', v_label;
  END IF;
  v_proc := public.fin__hk_macro_text(p_e -> 'procedure');
  IF char_length(v_proc) > 200 THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: işlem adı en fazla 200 karakter olabilir.', v_label;
  END IF;
  v_tooth := public.fin__hk_macro_text(p_e -> 'tooth');
  IF char_length(v_tooth) > 200 THEN
    RAISE EXCEPTION 'Macro yüklemesi, %: diş bilgisi en fazla 200 karakter olabilir.', v_label;
  END IF;

  IF p_is_line THEN
    v_basis := p_e ->> 'basis';
    IF v_basis IS NULL OR v_basis NOT IN ('production', 'payment') THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: satır türü geçersiz (işlem / ödeme).', v_label;
    END IF;
    IF jsonb_typeof(p_e -> 'treatment_day') = 'string' THEN
      v_tday := public.fin__hk_iso_day(p_e ->> 'treatment_day');
      IF v_tday IS NULL THEN
        RAISE EXCEPTION 'Macro yüklemesi, %: işlem tarihi geçersiz (YYYY-AA-GG).', v_label;
      END IF;
    END IF;
    IF v_basis = 'production' THEN
      IF v_tday IS NOT NULL AND v_tday <> v_day THEN
        RAISE EXCEPTION 'Macro yüklemesi, %: işlem raporu satırının tarihi işlem tarihi olmalı.', v_label;
      END IF;
      v_tday := v_day;
    END IF;
    v_method := p_e ->> 'method';
    IF v_method IS NULL OR v_method NOT IN ('cash', 'card', 'transfer', 'unpaid')
       OR (v_basis = 'payment' AND v_method = 'unpaid') THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: ödeme şekli geçersiz.', v_label;
    END IF;
    -- 0035 (v2.3): the payment day of a part paid in money (optional; a payment report line: its own day).
    IF jsonb_typeof(p_e -> 'paid_on') = 'string' THEN
      v_paid := public.fin__hk_iso_day(p_e ->> 'paid_on');
      IF v_paid IS NULL THEN
        RAISE EXCEPTION 'Macro yüklemesi, %: ödeme tarihi geçersiz (YYYY-AA-GG).', v_label;
      END IF;
    ELSIF jsonb_typeof(p_e -> 'paid_on') IS NOT NULL AND jsonb_typeof(p_e -> 'paid_on') <> 'null' THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: ödeme tarihi geçersiz (YYYY-AA-GG).', v_label;
    END IF;
    IF v_basis = 'payment' THEN
      IF v_paid IS NOT NULL AND v_paid <> v_day THEN
        RAISE EXCEPTION 'Macro yüklemesi, %: ödeme raporu satırının ödeme tarihi kendi tarihi olmalı.', v_label;
      END IF;
      v_paid := v_day;
    ELSIF v_paid IS NOT NULL AND v_method = 'unpaid' THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: ödenmemiş kısmın ödeme tarihi olamaz.', v_label;
    ELSIF v_paid IS NOT NULL AND public.fin__month_start(v_paid) > public.fin__month_start(v_day) THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: ödeme tarihi işlemin ayından sonra olamaz (ay sonundan sonraki ödemeler ödenmemiş sayılır).',
        v_label;
    END IF;
    v_currency := upper(btrim(coalesce(p_e ->> 'currency', 'TRY')));
    IF v_currency NOT IN ('TRY', 'EUR', 'USD', 'GBP') THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: para birimi geçersiz.', v_label;
    END IF;
    IF jsonb_typeof(p_e -> 'amount_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: tutar geçersiz.', v_label;
    END IF;
    v_num := (p_e ->> 'amount_cents')::numeric;
    IF v_num <> trunc(v_num) OR v_num = 0 OR abs(v_num) > 1000000000000 THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: tutar 0 olamaz, kuruş olarak tam sayı olmalı ve en fazla 10.000.000.000 olabilir.',
        v_label;
    END IF;
    v_amount := v_num::bigint;
  ELSIF jsonb_typeof(p_e -> 'qty') IS NOT NULL AND jsonb_typeof(p_e -> 'qty') <> 'null' THEN
    IF jsonb_typeof(p_e -> 'qty') <> 'number' THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: adet geçersiz.', v_label;
    END IF;
    v_num := (p_e ->> 'qty')::numeric;
    IF v_num <> trunc(v_num) OR v_num = 0 OR v_num NOT BETWEEN -1000 AND 1000 THEN
      RAISE EXCEPTION 'Macro yüklemesi, %: adet 0 olamaz ve -1000 ile 1000 arasında olmalı.', v_label;
    END IF;
    v_qty := v_num::integer;
  END IF;

  RETURN jsonb_build_object(
    'n', p_n,
    'key', v_key,
    'basis', v_basis,
    'day', v_day,
    'treatment_day', v_tday,
    'ext_doctor', v_ext,
    'ext_norm', public.fin__normalize_name(v_ext),
    'patient_name', v_name,
    'patient_no', v_no,
    'procedure', v_proc,
    'proc_norm', public.fin__normalize_name(v_proc),
    'tooth', v_tooth,
    'method', v_method,
    'currency', v_currency,
    'amount_cents', v_amount,
    'paid_on', v_paid,
    'qty', v_qty);
END;
$$;

-- Macro import of a day range (0034 body, same signature) + 0035 (v2.3): a line's paid_on (fin__hk_macro_row) is stored
-- on it. The rest is 0034's (summary, carry-over and dry run unchanged).
CREATE OR REPLACE FUNCTION public.fin_hk_import_macro(
  p_batch_id uuid,
  p_from date,
  p_to date,
  p_lines jsonb,
  p_pieces jsonb,
  p_files text[],
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_dry boolean := coalesce(p_dry_run, false);
  v_in_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_in_pieces jsonb := coalesce(p_pieces, '[]'::jsonb);
  v_files text[];
  v_batch public.fin_hk_import_batches%ROWTYPE;
  v_m date;
  v_closed date;
  v_l jsonb;
  v_p jsonb;
  v_fl jsonb;
  v_fp jsonb;
  v_bad text;
  v_detail jsonb;
  v_bridge jsonb;
  v_summary jsonb;
  v_carried integer := 0;
  v_returned integer := 0;
  v_void_lines integer := 0;
  v_void_pieces integer := 0;
  v_replaced integer := 0;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Tarih aralığı seçilmeli.';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
  END IF;
  IF p_from < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Geçersiz tarih.';
  END IF;
  IF p_to > v_today THEN
    RAISE EXCEPTION 'Bitiş tarihi bugünden sonra olamaz.';
  END IF;
  IF p_to - p_from > 365 THEN
    RAISE EXCEPTION 'Bir yüklemede en fazla 366 günlük aralık seçilebilir.';
  END IF;
  IF jsonb_typeof(v_in_lines) <> 'array' OR jsonb_typeof(v_in_pieces) <> 'array' THEN
    RAISE EXCEPTION 'Yükleme verisi geçersiz.';
  END IF;
  IF jsonb_array_length(v_in_lines) > 20000 OR jsonb_array_length(v_in_pieces) > 20000 THEN
    RAISE EXCEPTION 'Bir yüklemede en fazla 20.000 satır ve 20.000 işlem olabilir.';
  END IF;
  IF cardinality(coalesce(p_files, '{}'::text[])) > 10
     OR EXISTS (SELECT 1 FROM unnest(coalesce(p_files, '{}'::text[])) AS f(x)
                WHERE f.x IS NULL OR char_length(btrim(f.x)) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'Dosya adları geçersiz.';
  END IF;
  SELECT coalesce(array_agg(btrim(f.x) ORDER BY f.o), '{}'::text[])
    INTO v_files
  FROM unnest(coalesce(p_files, '{}'::text[])) WITH ORDINALITY AS f(x, o);

  -- One import of the clinic at a time; the close lock and the range's month locks shared (as a line write), so a
  -- close / reopen in progress is waited for and no month of the range is closed until this commits.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_hk_import:' || v_clinic::text, 0));
  PERFORM pg_advisory_xact_lock_shared(public.fin__hk_close_lock(v_clinic));
  FOR v_m IN
    SELECT g::date
    FROM generate_series(public.fin__month_start(p_from)::timestamp, public.fin__month_start(p_to)::timestamp,
                         interval '1 month') AS g
  LOOP
    PERFORM pg_advisory_xact_lock_shared(public.fin__hk_month_lock(v_clinic, v_m));
  END LOOP;

  -- Retry of a saved import: its summary, nothing written. An id of another clinic looks taken.
  SELECT * INTO v_batch FROM public.fin_hk_import_batches b WHERE b.id = p_batch_id;
  IF v_batch.id IS NOT NULL THEN
    IF v_batch.clinic_id IS DISTINCT FROM v_clinic THEN
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    RETURN v_batch.stats || jsonb_build_object('already_saved', true, 'dry_run', v_dry);
  END IF;

  -- Closed months: none in the range, none after it (a write before a closed month would change its ortho walk).
  SELECT min(m.month) INTO v_closed
  FROM public.fin_hk_months m
  WHERE m.clinic_id = v_clinic AND m.status = 'closed' AND m.month >= public.fin__month_start(p_from);
  IF v_closed IS NOT NULL AND v_closed <= public.fin__month_start(p_to) THEN
    RAISE EXCEPTION 'Seçilen aralıkta kapatılmış bir ay var (%). Macro yüklemesi yalnızca açık aylara yapılabilir.',
      to_char(v_closed, 'MM.YYYY');
  END IF;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'Seçilen aralıktan sonraki bir ay kapatıldı (%). Kapatılmış aydan önceki günler artık yüklenemez.',
      to_char(v_closed, 'MM.YYYY');
  END IF;

  -- Rows, validated (fin__hk_macro_row raises on the first bad one).
  SELECT coalesce(jsonb_agg(public.fin__hk_macro_row(x.e, true, x.o::integer, p_from, p_to) ORDER BY x.o), '[]'::jsonb)
    INTO v_l
  FROM jsonb_array_elements(v_in_lines) WITH ORDINALITY AS x(e, o);
  SELECT coalesce(jsonb_agg(public.fin__hk_macro_row(x.e, false, x.o::integer, p_from, p_to) ORDER BY x.o),
                  '[]'::jsonb)
    INTO v_p
  FROM jsonb_array_elements(v_in_pieces) WITH ORDINALITY AS x(e, o);

  -- Every Macro doctor of the payload must be mapped (fin_hk_save_ext_doctor).
  SELECT string_agg(u.shown, ', ' ORDER BY u.shown COLLATE "tr-x-icu", u.norm),
         jsonb_agg(u.shown ORDER BY u.shown COLLATE "tr-x-icu", u.norm)
    INTO v_bad, v_detail
  FROM (
    SELECT z.r ->> 'ext_norm' AS norm, min(z.r ->> 'ext_doctor') AS shown
    FROM (SELECT jsonb_array_elements(v_l) AS r
          UNION ALL
          SELECT jsonb_array_elements(v_p)) z
    GROUP BY z.r ->> 'ext_norm'
  ) u
  WHERE NOT EXISTS (SELECT 1 FROM public.fin_hk_ext_doctors d WHERE d.clinic_id = v_clinic AND d.ext_name = u.norm);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Eşleştirilmemiş Macro hekimleri: %. Her biri için DentOS hekimi, Klinik, Dışarıdan hekim ya da Yok say seçin, sonra yeniden deneyin.',
      v_bad USING DETAIL = jsonb_build_object('unmapped_ext_doctors', v_detail)::text;
  END IF;

  -- Basis: the orthodontist (an active ortho_lab_first rule in the line's month) is paid on her payments, every other
  -- doctor on production; clinic / outside lines are production.
  SELECT string_agg(DISTINCT y.msg, '; ' ORDER BY y.msg)
    INTO v_bad
  FROM (
    SELECT CASE
             WHEN d.mode <> 'doctor' AND (r ->> 'basis') = 'payment' THEN
               format('%s: ödeme raporu satırları yalnızca ortodonti kuralı olan DentOS hekimi için yüklenir',
                      d.display_name)
             WHEN d.mode = 'doctor' AND (r ->> 'basis') = 'payment' AND NOT o.ortho THEN
               format('%s (%s): bu ay ortodonti (önce lab) kuralı yok, ödeme bazlı satır yüklenemez', d.display_name,
                      to_char((r ->> 'day')::date, 'MM.YYYY'))
             WHEN d.mode = 'doctor' AND (r ->> 'basis') = 'production' AND o.ortho THEN
               format('%s (%s): ortodonti (önce lab) kuralı var, satırları ödeme raporundan yüklenir', d.display_name,
                      to_char((r ->> 'day')::date, 'MM.YYYY'))
           END AS msg
    FROM jsonb_array_elements(v_l) r
    JOIN public.fin_hk_ext_doctors d ON d.clinic_id = v_clinic AND d.ext_name = (r ->> 'ext_norm')
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.fin_hk_rules q
        WHERE q.clinic_id = v_clinic
          AND q.kind = 'ortho_lab_first'
          AND q.doctor_id = d.doctor_id
          AND q.from_month <= public.fin__month_start((r ->> 'day')::date)
          AND (q.to_month IS NULL OR q.to_month >= public.fin__month_start((r ->> 'day')::date))) AS ortho
    ) o
    WHERE d.mode <> 'ignore'
  ) y
  WHERE y.msg IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Macro satırları hekim kurallarına uymuyor: %.', v_bad;
  END IF;

  -- Foreign currencies need a rate on or before the line's day.
  SELECT string_agg(format('%s (%s)', m.currency, to_char(m.day, 'DD.MM.YYYY')), ', ' ORDER BY m.currency),
         jsonb_agg(jsonb_build_object('currency', m.currency, 'day', m.day) ORDER BY m.currency)
    INTO v_bad, v_detail
  FROM (
    SELECT f.currency, min(f.day) AS day
    FROM (
      SELECT DISTINCT (r ->> 'currency') AS currency, (r ->> 'day')::date AS day
      FROM jsonb_array_elements(v_l) r
      JOIN public.fin_hk_ext_doctors d
        ON d.clinic_id = v_clinic AND d.ext_name = (r ->> 'ext_norm') AND d.mode <> 'ignore'
      WHERE (r ->> 'currency') <> 'TRY'
    ) f
    LEFT JOIN LATERAL public.fin__hk_fx_rate(v_clinic, f.currency, f.day) q ON true
    WHERE q.o_rate IS NULL
    GROUP BY f.currency
  ) m;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Döviz kuru bulunamadı: %. Bu günde veya öncesinde kayıtlı kur yok; kuru klinik sahibi veya finans yetkilisi Finans ayarları > Döviz kurları ekranından girsin, sonra yeniden yükleyin.',
      v_bad USING DETAIL = jsonb_build_object('missing_fx', v_detail)::text;
  END IF;

  -- Patient keys already known by name: a file number of the payload whose 'macro:' key nothing uses yet (no mark,
  -- live lab cost, or live line / piece that this import does not replace) takes the only other key its normalized
  -- name has there, when that key is the name itself or the bare file number (a reception "Hasta no") and the
  -- payload pairs the name and the number one to one; so marks and lab costs entered before the patient's first
  -- import (the orthodontist's lab-first walk included) keep applying. {'macro:<no>': key} of the numbers that take
  -- another key.
  WITH pay AS (
    SELECT DISTINCT public.fin__normalize_name(x.r ->> 'patient_name') AS nn, x.r ->> 'patient_no' AS pno
    FROM (SELECT jsonb_array_elements(v_l) AS r
          UNION ALL
          SELECT jsonb_array_elements(v_p)) x
    JOIN public.fin_hk_ext_doctors d
      ON d.clinic_id = v_clinic AND d.ext_name = (x.r ->> 'ext_norm') AND d.mode <> 'ignore'
    WHERE x.r ->> 'patient_no' IS NOT NULL
  ),
  one AS (
    SELECT p.nn, p.pno
    FROM pay p
    WHERE NOT EXISTS (SELECT 1 FROM pay q WHERE q.nn = p.nn AND q.pno <> p.pno)
      AND NOT EXISTS (SELECT 1 FROM pay q WHERE q.pno = p.pno AND q.nn <> p.nn)
  ),
  known AS MATERIALIZED (
    SELECT public.fin__normalize_name(m.patient_name) AS nn, m.patient_ref AS ref
    FROM public.fin_hk_patient_marks m
    WHERE m.clinic_id = v_clinic
    UNION
    SELECT public.fin__normalize_name(c.patient_name), c.patient_ref
    FROM public.fin_hk_lab_costs c
    WHERE c.clinic_id = v_clinic AND c.voided_at IS NULL
    UNION
    SELECT public.fin__normalize_name(l.patient_name), l.patient_ref
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL
      AND NOT (l.source = 'import' AND l.day BETWEEN p_from AND p_to)
    UNION
    SELECT public.fin__normalize_name(p.patient_name), p.patient_ref
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL
      AND NOT (p.source = 'import' AND p.day BETWEEN p_from AND p_to)
  )
  SELECT coalesce(jsonb_object_agg('macro:' || o.pno, k.ref), '{}'::jsonb)
    INTO v_bridge
  FROM one o
  CROSS JOIN LATERAL (
    SELECT min(kn.ref) AS ref, count(*) AS n
    FROM known kn
    WHERE kn.nn = o.nn
  ) k
  WHERE k.n = 1
    AND k.ref IN (o.nn, o.pno)
    AND NOT EXISTS (SELECT 1 FROM known kn WHERE kn.ref = 'macro:' || o.pno);

  -- Final lines: doctor (mapping), group (active groups by normalized operation name), TL amount, implant part,
  -- patient key. Ignored Macro doctors' rows are left out.
  WITH grp AS (
    SELECT DISTINCT ON (o.op) o.op, g.id, g.name, g.is_implant
    FROM public.fin_hk_proc_groups g
    CROSS JOIN LATERAL unnest(g.op_names) AS o(op)
    WHERE g.clinic_id = v_clinic AND g.is_active
    ORDER BY o.op, g.normalized_name, g.id
  ),
  ln AS (
    SELECT x.n, x.basis, x.day, x.treatment_day, x.ext_doctor, x.ext_norm, x.patient_name, x.patient_no, x.procedure,
           x.proc_norm, x.tooth, x.method, x.currency, x.amount_cents, x.paid_on, d.mode, d.doctor_id,
           public.fin__normalize_name(x.patient_name) AS nn,
           CASE WHEN x.patient_no IS NOT NULL
                THEN coalesce(v_bridge ->> ('macro:' || x.patient_no), 'macro:' || x.patient_no)
                ELSE public.fin__normalize_name(x.patient_name) END AS base_ref
    FROM jsonb_to_recordset(v_l) AS x(n integer, basis text, day date, treatment_day date, ext_doctor text,
                                      ext_norm text, patient_name text, patient_no text, procedure text,
                                      proc_norm text, tooth text, method text, currency text, amount_cents bigint,
                                      paid_on date)
    JOIN public.fin_hk_ext_doctors d ON d.clinic_id = v_clinic AND d.ext_name = x.ext_norm
    WHERE d.mode <> 'ignore'
  ),
  pn AS (
    SELECT public.fin__normalize_name(x.patient_name) AS nn,
           CASE WHEN x.patient_no IS NOT NULL
                THEN coalesce(v_bridge ->> ('macro:' || x.patient_no), 'macro:' || x.patient_no)
                ELSE public.fin__normalize_name(x.patient_name) END AS base_ref
    FROM jsonb_to_recordset(v_p) AS x(ext_norm text, patient_name text, patient_no text)
    JOIN public.fin_hk_ext_doctors d ON d.clinic_id = v_clinic AND d.ext_name = x.ext_norm
    WHERE d.mode <> 'ignore'
  ),
  -- A payment line has no patient number: it takes the only key known for its normalized name (marks, live lab
  -- costs, live lines / pieces that this import does not replace, this import's production lines and pieces), else
  -- the normalized name.
  need AS (
    SELECT DISTINCT ln.nn FROM ln WHERE ln.basis = 'payment' AND ln.patient_no IS NULL
  ),
  cand AS (
    SELECT DISTINCT c.nn, c.ref
    FROM (
      SELECT public.fin__normalize_name(l.patient_name) AS nn, l.patient_ref AS ref
      FROM public.fin_hk_lines l
      WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL
        AND NOT (l.source = 'import' AND l.day BETWEEN p_from AND p_to)
      UNION ALL
      SELECT public.fin__normalize_name(p.patient_name), p.patient_ref
      FROM public.fin_hk_pieces p
      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL
        AND NOT (p.source = 'import' AND p.day BETWEEN p_from AND p_to)
      UNION ALL
      SELECT public.fin__normalize_name(m.patient_name), m.patient_ref
      FROM public.fin_hk_patient_marks m
      WHERE m.clinic_id = v_clinic
      UNION ALL
      SELECT public.fin__normalize_name(c.patient_name), c.patient_ref
      FROM public.fin_hk_lab_costs c
      WHERE c.clinic_id = v_clinic AND c.voided_at IS NULL
      UNION ALL
      SELECT ln.nn, ln.base_ref FROM ln WHERE ln.basis = 'production'
      UNION ALL
      SELECT pn.nn, pn.base_ref FROM pn
    ) c
    WHERE c.nn IN (SELECT need.nn FROM need)
  ),
  uref AS (
    SELECT cand.nn, min(cand.ref) AS ref
    FROM cand
    GROUP BY cand.nn
    HAVING count(*) = 1
  ),
  fxr AS (
    SELECT f.currency, f.day, q.o_rate AS rate, q.o_rate_on AS rate_on
    FROM (SELECT DISTINCT ln.currency, ln.day FROM ln WHERE ln.currency <> 'TRY') f
    LEFT JOIN LATERAL public.fin__hk_fx_rate(v_clinic, f.currency, f.day) q ON true
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'n', ln.n,
           'basis', ln.basis,
           'day', ln.day,
           'treatment_day', ln.treatment_day,
           'ext_doctor', ln.ext_doctor,
           'ext_norm', ln.ext_norm,
           'mode', ln.mode,
           'doctor_id', CASE WHEN ln.mode = 'doctor' THEN ln.doctor_id END,
           'patient_name', ln.patient_name,
           'patient_ref', CASE WHEN ln.basis = 'payment' AND ln.patient_no IS NULL THEN coalesce(u.ref, ln.nn)
                               ELSE ln.base_ref END,
           'patient_no', ln.patient_no,
           'procedure', ln.procedure,
           'proc_norm', ln.proc_norm,
           'tooth', ln.tooth,
           'proc_group_id', g.id,
           'proc_group_name', g.name,
           'method', ln.method,
           'currency', ln.currency,
           'amount_cents', ln.amount_cents,
           'paid_on', ln.paid_on,
           'try_cents', t.try_cents,
           'implant_cents', CASE WHEN coalesce(g.is_implant, false) THEN t.try_cents ELSE 0 END,
           'rate', f.rate,
           'rate_on', f.rate_on)
           ORDER BY ln.n), '[]'::jsonb)
    INTO v_fl
  FROM ln
  LEFT JOIN grp g ON g.op = ln.proc_norm
  LEFT JOIN uref u ON u.nn = ln.nn
  LEFT JOIN fxr f ON f.currency = ln.currency AND f.day = ln.day
  CROSS JOIN LATERAL (
    SELECT CASE WHEN ln.currency = 'TRY' THEN ln.amount_cents
                ELSE round(ln.amount_cents::numeric * f.rate)::bigint END AS try_cents
  ) t;

  -- Rows by position and day only (never the patient's name: error texts reach the server log).
  SELECT string_agg(format('%s (%s)', r ->> 'n', to_char((r ->> 'day')::date, 'DD.MM.YYYY')),
                    ', ' ORDER BY (r ->> 'n')::integer)
    INTO v_bad
  FROM jsonb_array_elements(v_fl) r
  WHERE (r ->> 'try_cents')::bigint = 0 OR abs((r ->> 'try_cents')::bigint) > 1000000000000;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Dövizli satırın TL karşılığı 0 veya 10.000.000.000 TL''den büyük çıkıyor: %.', v_bad;
  END IF;

  -- Final pieces: every row with its mapping and group; stored = a row of a grouped operation of a DentOS doctor, the
  -- clinic (without a doctor: unassigned) or (0034) an outside doctor (without a doctor, "Hakediş yok"); the Macro
  -- default (mode, the mapped DentOS doctor) goes with every stored row.
  WITH grp AS (
    SELECT DISTINCT ON (o.op) o.op, g.id, g.name, g.is_implant
    FROM public.fin_hk_proc_groups g
    CROSS JOIN LATERAL unnest(g.op_names) AS o(op)
    WHERE g.clinic_id = v_clinic AND g.is_active
    ORDER BY o.op, g.normalized_name, g.id
  ),
  pc AS (
    SELECT x.n, x.day, x.ext_doctor, x.ext_norm, x.patient_name, x.patient_no, x.procedure, x.proc_norm, x.tooth,
           x.qty, d.mode, d.doctor_id
    FROM jsonb_to_recordset(v_p) AS x(n integer, day date, ext_doctor text, ext_norm text, patient_name text,
                                      patient_no text, procedure text, proc_norm text, tooth text, qty integer)
    JOIN public.fin_hk_ext_doctors d ON d.clinic_id = v_clinic AND d.ext_name = x.ext_norm
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'n', pc.n,
           'day', pc.day,
           'ext_doctor', pc.ext_doctor,
           'ext_norm', pc.ext_norm,
           'mode', pc.mode,
           'stored', pc.mode IN ('doctor', 'clinic', 'outside') AND g.id IS NOT NULL,
           'doctor_id', CASE WHEN pc.mode = 'doctor' THEN pc.doctor_id END,
           'patient_name', pc.patient_name,
           'patient_ref', CASE WHEN pc.patient_no IS NOT NULL
                               THEN coalesce(v_bridge ->> ('macro:' || pc.patient_no), 'macro:' || pc.patient_no)
                               ELSE public.fin__normalize_name(pc.patient_name) END,
           'patient_no', pc.patient_no,
           'procedure', pc.procedure,
           'proc_norm', pc.proc_norm,
           'tooth', pc.tooth,
           'qty', pc.qty,
           'proc_group_id', g.id,
           'proc_group_name', g.name,
           'assigned_none', pc.mode = 'outside',
           'macro_doctor_id', CASE WHEN pc.mode = 'doctor' THEN pc.doctor_id END,
           'assigned', false,
           'carried', false,
           'returned_voided', false)
           ORDER BY pc.n), '[]'::jsonb)
    INTO v_fp
  FROM pc
  LEFT JOIN grp g ON g.op = pc.proc_norm;

  -- 0034 (v2.1): the preparer's choice of a replaced piece of ANY Macro doctor (an assigned old row: another doctor
  -- than the Macro default, "Hakediş yok", the doctor of a clinic piece) goes to the same new row (same day, Macro
  -- doctor, patient (its file number, else its key: a key may change when a mark is added), operation and tooth;
  -- duplicates matched in order against the live old rows); its assigned flag is recomputed against the new row's
  -- default. A changed Macro doctor is another key: the new default applies. A new row whose key has no live old row
  -- left but a row voided by a user (not by an import) comes back live and is listed (returned_voided).
  WITH nw AS (
    SELECT (r ->> 'n')::integer AS n,
           row_number() OVER (PARTITION BY r ->> 'day', r ->> 'ext_norm',
                                           coalesce('no:' || (r ->> 'patient_no'), 'ref:' || (r ->> 'patient_ref')),
                                           r ->> 'proc_norm', coalesce(r ->> 'tooth', '')
                              ORDER BY (r ->> 'n')::integer) AS k,
           (r ->> 'day')::date AS day, r ->> 'ext_norm' AS ext_norm,
           coalesce('no:' || (r ->> 'patient_no'), 'ref:' || (r ->> 'patient_ref')) AS ref,
           r ->> 'proc_norm' AS proc_norm, coalesce(r ->> 'tooth', '') AS tooth,
           (r ->> 'macro_doctor_id')::uuid AS def_doctor, (r ->> 'mode') = 'outside' AS def_none
    FROM jsonb_array_elements(v_fp) r
    WHERE (r ->> 'stored')::boolean
  ),
  od AS (
    SELECT p.day, public.fin__normalize_name(p.ext_doctor) AS ext_norm,
           coalesce('no:' || p.macro_patient_no, 'ref:' || p.patient_ref) AS ref,
           public.fin__normalize_name(p.procedure) AS proc_norm, coalesce(p.tooth, '') AS tooth, p.doctor_id,
           p.assigned_none, p.assigned,
           row_number() OVER (PARTITION BY p.day, public.fin__normalize_name(p.ext_doctor),
                                           coalesce('no:' || p.macro_patient_no, 'ref:' || p.patient_ref),
                                           public.fin__normalize_name(p.procedure), coalesce(p.tooth, '')
                              ORDER BY p.created_at, p.id) AS k
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.voided_at IS NULL AND p.day BETWEEN p_from AND p_to
  ),
  mt AS (
    SELECT nw.n, od.doctor_id, od.assigned_none,
           (od.doctor_id, od.assigned_none) IS DISTINCT FROM (nw.def_doctor, nw.def_none) AS assigned
    FROM nw
    JOIN od ON od.day = nw.day AND od.ext_norm = nw.ext_norm AND od.ref = nw.ref AND od.proc_norm = nw.proc_norm
           AND od.tooth = nw.tooth AND od.k = nw.k
    WHERE od.assigned
  ),
  -- Keys of the range's imported pieces voided by a user (an import voids with 'Yeniden yüklendi').
  vo AS (
    SELECT DISTINCT p.day, public.fin__normalize_name(p.ext_doctor) AS ext_norm,
           coalesce('no:' || p.macro_patient_no, 'ref:' || p.patient_ref) AS ref,
           public.fin__normalize_name(p.procedure) AS proc_norm, coalesce(p.tooth, '') AS tooth
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.voided_at IS NOT NULL
      AND p.void_reason IS DISTINCT FROM 'Yeniden yüklendi' AND p.day BETWEEN p_from AND p_to
  ),
  rv AS (
    SELECT nw.n
    FROM nw
    WHERE NOT EXISTS (SELECT 1 FROM od
                      WHERE od.day = nw.day AND od.ext_norm = nw.ext_norm AND od.ref = nw.ref
                        AND od.proc_norm = nw.proc_norm AND od.tooth = nw.tooth AND od.k = nw.k)
      AND EXISTS (SELECT 1 FROM vo
                  WHERE vo.day = nw.day AND vo.ext_norm = nw.ext_norm AND vo.ref = nw.ref
                    AND vo.proc_norm = nw.proc_norm AND vo.tooth = nw.tooth)
  )
  SELECT coalesce(jsonb_agg(CASE WHEN mt.n IS NOT NULL
                                 THEN r.e || jsonb_build_object('doctor_id', mt.doctor_id,
                                                                'assigned_none', mt.assigned_none,
                                                                'assigned', mt.assigned,
                                                                'carried', true)
                                 WHEN rv.n IS NOT NULL
                                 THEN r.e || jsonb_build_object('returned_voided', true)
                                 ELSE r.e END
                            ORDER BY (r.e ->> 'n')::integer), '[]'::jsonb),
         count(mt.n),
         count(rv.n)
    INTO v_fp, v_carried, v_returned
  FROM jsonb_array_elements(v_fp) AS r(e)
  LEFT JOIN mt ON mt.n = (r.e ->> 'n')::integer
  LEFT JOIN rv ON rv.n = (r.e ->> 'n')::integer;

  -- Summary (without the replaced counts, added by the write block).
  SELECT jsonb_build_object(
    'batch_id', p_batch_id,
    'from', p_from,
    'to', p_to,
    'files', to_jsonb(v_files),
    'lines', (SELECT count(*) FROM jsonb_array_elements(v_fl)),
    'pieces', (SELECT count(*) FROM jsonb_array_elements(v_fp) r WHERE (r ->> 'stored')::boolean),
    'try_total_cents', (SELECT coalesce(sum((r ->> 'try_cents')::bigint), 0) FROM jsonb_array_elements(v_fl) r),
    'implant_total_cents', (SELECT coalesce(sum((r ->> 'implant_cents')::bigint), 0)
                            FROM jsonb_array_elements(v_fl) r),
    'skipped_lines', (SELECT count(*)
                      FROM jsonb_array_elements(v_l) r
                      JOIN public.fin_hk_ext_doctors d
                        ON d.clinic_id = v_clinic AND d.ext_name = (r ->> 'ext_norm') AND d.mode = 'ignore'),
    -- 0034: ignored Macro doctors only (an outside doctor's grouped rows are stored as "Hakediş yok").
    'skipped_pieces', (SELECT count(*) FROM jsonb_array_elements(v_fp) r
                       WHERE (r ->> 'mode') = 'ignore'),
    'ungrouped_pieces', (SELECT count(*) FROM jsonb_array_elements(v_fp) r
                         WHERE (r ->> 'mode') IN ('doctor', 'clinic', 'outside')
                           AND (r -> 'proc_group_id') = 'null'::jsonb),
    'outside_pieces', (SELECT count(*) FROM jsonb_array_elements(v_fp) r
                       WHERE (r ->> 'stored')::boolean AND (r ->> 'mode') = 'outside'),
    'unassigned_pieces', (SELECT coalesce(sum((r ->> 'qty')::integer), 0)
                          FROM jsonb_array_elements(v_fp) r
                          WHERE (r ->> 'stored')::boolean AND (r -> 'doctor_id') = 'null'::jsonb
                            AND NOT (r ->> 'assigned_none')::boolean),
    'carried_assignments', v_carried,
    'returned_voided', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'n', (r ->> 'n')::integer,
               'day', r ->> 'day',
               'ext_doctor', r ->> 'ext_doctor',
               'patient_name', r ->> 'patient_name',
               'patient_no', r ->> 'patient_no',
               'procedure', r ->> 'procedure',
               'tooth', r ->> 'tooth',
               'proc_group_name', r ->> 'proc_group_name',
               'qty', (r ->> 'qty')::integer)
               ORDER BY r ->> 'day', (r ->> 'n')::integer)
      FROM jsonb_array_elements(v_fp) r
      WHERE (r ->> 'returned_voided')::boolean), '[]'::jsonb),
    'returned_voided_count', v_returned,
    'doctors', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'ext_doctor', d.display_name,
               'ext_name', d.ext_name,
               'mode', d.mode,
               'doctor_id', d.doctor_id,
               'doctor_name', public.fin__hk_doctor_name(d.doctor_id),
               'lines', coalesce(ls.n, 0),
               'payment_lines', coalesce(ls.n_pay, 0),
               'skipped_lines', coalesce(sk.n, 0),
               'gross_cents', coalesce(ls.gross, 0),
               'gross_by_method', jsonb_build_object(
                 'cash', coalesce(ls.cash, 0),
                 'card', coalesce(ls.card, 0),
                 'transfer', coalesce(ls.transfer, 0),
                 'unpaid', coalesce(ls.unpaid, 0)),
               'implant_cents', coalesce(ls.implant, 0),
               'pieces', coalesce(ps.n, 0),
               'pieces_qty', coalesce(ps.qty, 0),
               'pieces_by_group', coalesce(pg.items, '[]'::jsonb),
               'unassigned_pieces', coalesce(ps.unassigned, 0),
               'ungrouped_pieces', coalesce(ps.ungrouped, 0),
               'skipped_pieces', coalesce(ps.skipped, 0),
               'outside_pieces', coalesce(ps.outside, 0),
               'returned_voided', coalesce(ps.returned, 0),
               'carried_assignments', coalesce(ps.carried, 0))
               ORDER BY d.display_name COLLATE "tr-x-icu", d.ext_name)
      FROM public.fin_hk_ext_doctors d
      LEFT JOIN (
        SELECT r ->> 'ext_norm' AS ext_norm,
               count(*) AS n,
               count(*) FILTER (WHERE (r ->> 'basis') = 'payment') AS n_pay,
               sum((r ->> 'try_cents')::bigint) AS gross,
               sum((r ->> 'try_cents')::bigint) FILTER (WHERE (r ->> 'method') = 'cash') AS cash,
               sum((r ->> 'try_cents')::bigint) FILTER (WHERE (r ->> 'method') = 'card') AS card,
               sum((r ->> 'try_cents')::bigint) FILTER (WHERE (r ->> 'method') = 'transfer') AS transfer,
               sum((r ->> 'try_cents')::bigint) FILTER (WHERE (r ->> 'method') = 'unpaid') AS unpaid,
               sum((r ->> 'implant_cents')::bigint) AS implant
        FROM jsonb_array_elements(v_fl) r
        GROUP BY r ->> 'ext_norm'
      ) ls ON ls.ext_norm = d.ext_name
      LEFT JOIN (
        SELECT r ->> 'ext_norm' AS ext_norm, count(*) AS n
        FROM jsonb_array_elements(v_l) r
        GROUP BY r ->> 'ext_norm'
      ) sk ON sk.ext_norm = d.ext_name AND d.mode = 'ignore'
      LEFT JOIN (
        SELECT r ->> 'ext_norm' AS ext_norm,
               count(*) FILTER (WHERE (r ->> 'stored')::boolean) AS n,
               sum((r ->> 'qty')::integer) FILTER (WHERE (r ->> 'stored')::boolean) AS qty,
               sum((r ->> 'qty')::integer) FILTER (WHERE (r ->> 'stored')::boolean
                                                     AND (r -> 'doctor_id') = 'null'::jsonb
                                                     AND NOT (r ->> 'assigned_none')::boolean) AS unassigned,
               count(*) FILTER (WHERE (r ->> 'mode') IN ('doctor', 'clinic', 'outside')
                                  AND (r -> 'proc_group_id') = 'null'::jsonb) AS ungrouped,
               count(*) FILTER (WHERE (r ->> 'mode') = 'ignore') AS skipped,
               count(*) FILTER (WHERE (r ->> 'stored')::boolean AND (r ->> 'mode') = 'outside') AS outside,
               count(*) FILTER (WHERE (r ->> 'returned_voided')::boolean) AS returned,
               count(*) FILTER (WHERE (r ->> 'carried')::boolean) AS carried
        FROM jsonb_array_elements(v_fp) r
        GROUP BY r ->> 'ext_norm'
      ) ps ON ps.ext_norm = d.ext_name
      LEFT JOIN (
        SELECT y.ext_norm,
               jsonb_agg(jsonb_build_object('proc_group_id', y.gid, 'name', y.gname, 'count', y.qty)
                         ORDER BY y.gname COLLATE "tr-x-icu", y.gid) AS items
        FROM (
          SELECT r ->> 'ext_norm' AS ext_norm, (r ->> 'proc_group_id')::uuid AS gid, r ->> 'proc_group_name' AS gname,
                 sum((r ->> 'qty')::integer) AS qty
          FROM jsonb_array_elements(v_fp) r
          WHERE (r ->> 'stored')::boolean
          GROUP BY r ->> 'ext_norm', (r ->> 'proc_group_id')::uuid, r ->> 'proc_group_name'
        ) y
        GROUP BY y.ext_norm
      ) pg ON pg.ext_norm = d.ext_name
      WHERE d.clinic_id = v_clinic
        AND d.ext_name IN (SELECT r ->> 'ext_norm' FROM jsonb_array_elements(v_l) r
                           UNION
                           SELECT r ->> 'ext_norm' FROM jsonb_array_elements(v_p) r)), '[]'::jsonb),
    'operations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'name', o.shown,
               'normalized', o.proc_norm,
               'proc_group_id', g.id,
               'proc_group_name', g.name,
               'is_implant', g.is_implant,
               'lines', o.n_lines,
               'pieces', o.n_pieces)
               ORDER BY o.shown COLLATE "tr-x-icu", o.proc_norm)
      FROM (
        SELECT z.proc_norm,
               min(z.shown) AS shown,
               count(*) FILTER (WHERE z.is_line) AS n_lines,
               count(*) FILTER (WHERE NOT z.is_line) AS n_pieces
        FROM (
          SELECT r ->> 'proc_norm' AS proc_norm, r ->> 'procedure' AS shown, true AS is_line
          FROM jsonb_array_elements(v_l) r
          UNION ALL
          SELECT r ->> 'proc_norm', r ->> 'procedure', false
          FROM jsonb_array_elements(v_p) r
        ) z
        WHERE z.proc_norm IS NOT NULL
        GROUP BY z.proc_norm
      ) o
      LEFT JOIN LATERAL (
        SELECT q.id, q.name, q.is_implant
        FROM public.fin_hk_proc_groups q
        WHERE q.clinic_id = v_clinic AND q.is_active AND o.proc_norm = ANY (q.op_names)
        ORDER BY q.normalized_name, q.id
        LIMIT 1
      ) g ON true), '[]'::jsonb),
    'fx', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'currency', f.currency,
               'rate', f.rate,
               'rate_day', f.rate_on,
               'lines', f.n,
               'first_day', f.d1,
               'last_day', f.d2)
               ORDER BY f.currency, f.rate_on)
      FROM (
        SELECT r ->> 'currency' AS currency, (r ->> 'rate')::numeric AS rate, (r ->> 'rate_on')::date AS rate_on,
               count(*) AS n, min((r ->> 'day')::date) AS d1, max((r ->> 'day')::date) AS d2
        FROM jsonb_array_elements(v_fl) r
        WHERE (r ->> 'currency') <> 'TRY'
        GROUP BY r ->> 'currency', (r ->> 'rate')::numeric, (r ->> 'rate_on')::date
      ) f), '[]'::jsonb),
    'fx_warnings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'currency', w.currency,
               'day', w.day,
               'rate_day', w.rate_on,
               'rate', w.rate,
               'age_days', w.day - w.rate_on)
               ORDER BY w.currency, w.day)
      FROM (
        SELECT DISTINCT r ->> 'currency' AS currency, (r ->> 'day')::date AS day, (r ->> 'rate_on')::date AS rate_on,
               (r ->> 'rate')::numeric AS rate
        FROM jsonb_array_elements(v_fl) r
        WHERE (r ->> 'currency') <> 'TRY' AND (r ->> 'day')::date - (r ->> 'rate_on')::date > 7
      ) w), '[]'::jsonb))
    INTO v_summary;

  -- Writes. A dry run raises PT998 at the end of this block, which rolls every write of it back (the variables keep
  -- their values).
  BEGIN
    UPDATE public.fin_hk_lines l
    SET voided_at = now(), voided_by = v_user, void_reason = 'Yeniden yüklendi'
    WHERE l.clinic_id = v_clinic AND l.source = 'import' AND l.voided_at IS NULL AND l.day BETWEEN p_from AND p_to;
    GET DIAGNOSTICS v_void_lines = ROW_COUNT;
    UPDATE public.fin_hk_pieces p
    SET voided_at = now(), voided_by = v_user, void_reason = 'Yeniden yüklendi'
    WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.voided_at IS NULL AND p.day BETWEEN p_from AND p_to;
    GET DIAGNOSTICS v_void_pieces = ROW_COUNT;

    INSERT INTO public.fin_hk_lines (id, clinic_id, source, batch_id, day, doctor_id, patient_ref, patient_name,
                                     method, currency, amount_cents, try_cents, implant_cents, description,
                                     ext_doctor, procedure, tooth, treatment_day, proc_group_id, macro_patient_no,
                                     macro_basis, paid_on, created_by, updated_by)
    SELECT gen_random_uuid(), v_clinic, 'import', p_batch_id, x.day, x.doctor_id, x.patient_ref, x.patient_name,
           x.method, x.currency, x.amount_cents, x.try_cents, x.implant_cents, '',
           x.ext_doctor, x.procedure, x.tooth, x.treatment_day, x.proc_group_id, x.patient_no,
           x.basis, x.paid_on, v_user, v_user
    FROM jsonb_to_recordset(v_fl) AS x(n integer, basis text, day date, treatment_day date, ext_doctor text,
                                       doctor_id uuid, patient_name text, patient_ref text, patient_no text,
                                       procedure text, tooth text, proc_group_id uuid, method text, currency text,
                                       amount_cents bigint, try_cents bigint, implant_cents bigint, paid_on date)
    ORDER BY x.n;

    INSERT INTO public.fin_hk_pieces (id, clinic_id, source, batch_id, day, doctor_id, patient_ref, patient_name, qty,
                                      description, proc_group_id, ext_doctor, procedure, tooth, macro_patient_no,
                                      assigned_none, macro_mode, macro_doctor_id, assigned, created_by, updated_by)
    SELECT gen_random_uuid(), v_clinic, 'import', p_batch_id, x.day, x.doctor_id, x.patient_ref, x.patient_name,
           x.qty, '', x.proc_group_id, x.ext_doctor, x.procedure, x.tooth, x.patient_no, x.assigned_none, x.mode,
           x.macro_doctor_id, x.assigned, v_user, v_user
    FROM jsonb_to_recordset(v_fp) AS x(n integer, stored boolean, day date, ext_doctor text, doctor_id uuid,
                                       patient_name text, patient_ref text, patient_no text, procedure text,
                                       tooth text, qty integer, proc_group_id uuid, assigned_none boolean,
                                       mode text, macro_doctor_id uuid, assigned boolean)
    WHERE x.stored
    ORDER BY x.n;

    SELECT count(*) INTO v_replaced
    FROM public.fin_hk_import_batches b
    WHERE b.clinic_id = v_clinic AND b.replaced_by_batch IS NULL AND b.from_day >= p_from AND b.to_day <= p_to;
    v_summary := v_summary || jsonb_build_object(
      'replaced_lines', v_void_lines,
      'replaced_pieces', v_void_pieces,
      'replaced_batches', v_replaced);

    INSERT INTO public.fin_hk_import_batches (id, clinic_id, from_day, to_day, file_names, stats, created_by,
                                              updated_by)
    VALUES (p_batch_id, v_clinic, p_from, p_to, v_files, v_summary, v_user, v_user);
    UPDATE public.fin_hk_import_batches b
    SET replaced_by_batch = p_batch_id
    WHERE b.clinic_id = v_clinic AND b.id <> p_batch_id AND b.replaced_by_batch IS NULL
      AND b.from_day >= p_from AND b.to_day <= p_to;

    IF v_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'PT998', MESSAGE = 'fin_hk_import_macro_dry_run';
    END IF;
  EXCEPTION WHEN SQLSTATE 'PT998' THEN
    NULL;   -- dry run: every write of the block is rolled back
  END;

  RETURN v_summary || jsonb_build_object('already_saved', false, 'dry_run', v_dry);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Self-service (0034 body, same signature): the caller's own lines + {resolved_method, financing_cents, fee_cents}.
-- ---------------------------------------------------------------------------
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
  v_lab_summary jsonb := '[]'::jsonb;
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
         coalesce(array_agg(DISTINCT r.doctor_id) FILTER (WHERE r.kind IN ('implant_piece', 'procedure_piece')),
                  '{}'::uuid[])
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
             'counted', coalesce(ev.payee_user_id = v_user, false),
             -- 0035 (v2.3): "Finansman (Burgan)" with the bank's fee share of the line.
             'resolved_method', ev.resolved_method,
             'financing_cents', ev.financing_cents,
             'fee_cents', ev.fee_cents)
             -- 0033: an imported line shows its Macro operation and tooth.
             || CASE WHEN l.source = 'import'
                     THEN jsonb_build_object('procedure', l.procedure, 'tooth', l.tooth)
                     ELSE '{}'::jsonb END
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
             -- 0033: a grouped piece shows its group, Macro operation and tooth.
             || CASE WHEN pc.proc_group_id IS NOT NULL
                     THEN jsonb_build_object('proc_group_name', g.name, 'procedure', pc.procedure, 'tooth', pc.tooth)
                     ELSE '{}'::jsonb END
             -- 0034 (v2.1): an imported piece shows its Macro doctor and default, and whether the performing doctor
             -- was chosen in DentOS.
             || CASE WHEN pc.source = 'import'
                     THEN jsonb_build_object('ext_doctor', pc.ext_doctor,
                                             'macro_doctor_id', pc.macro_doctor_id,
                                             'macro_doctor_name', public.fin__hk_doctor_name(pc.macro_doctor_id),
                                             'assigned', pc.assigned,
                                             'default_mode', coalesce(pc.macro_mode, 'clinic'))
                     ELSE '{}'::jsonb END
             ORDER BY pc.day, pc.created_at, pc.id), '[]'::jsonb)
      INTO v_pieces
    FROM public.fin_hk_pieces pc
    LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = pc.clinic_id AND g.id = pc.proc_group_id
    WHERE pc.clinic_id = v_clinic AND pc.voided_at IS NULL AND pc.day >= v_month AND pc.day < v_next
      AND pc.doctor_id = ANY (v_piece_doctors)
      -- 0033: the pieces the caller's own rules count: implant-type pieces of an implant_piece rule's doctor, the
      -- group's pieces of a procedure_piece rule's doctor (0032: every piece of an implant_piece rule's doctor).
      AND EXISTS (
        SELECT 1
        FROM public.fin_hk_rules r
        WHERE r.clinic_id = v_clinic AND r.payee_user_id = v_user AND r.doctor_id = pc.doctor_id
          AND r.from_month <= v_month AND (r.to_month IS NULL OR r.to_month >= v_month)
          AND ((r.kind = 'implant_piece' AND (pc.proc_group_id IS NULL OR coalesce(g.is_implant, false)))
               OR (r.kind = 'procedure_piece' AND r.proc_group_id = pc.proc_group_id)));
  END IF;

  -- Lab cost rows of the patients listed in the caller's own ortho components (to date; 0032 (v1.4): without the
  -- costs deducted from a ciro_share rule in their own month, as the walk) and, 0032 (v1.4), the month's lab costs
  -- counted under the caller's own ciro_share rules (fin__hk_eval_lab_costs).
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
    AND ((EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_payees) py
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(py -> 'components') = 'array' THEN py -> 'components' ELSE '[]'::jsonb END) k
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(k -> 'lab_patients') = 'array' THEN k -> 'lab_patients' ELSE '[]'::jsonb END) lp
            WHERE (k ->> 'kind') = 'ortho_lab_first'
              AND (k ->> 'doctor_id') = c.doctor_id::text
              AND (lp ->> 'patient_ref') = c.patient_ref)
          AND c.id NOT IN (SELECT x.lab_cost_id FROM public.fin__hk_ciro_lab_ids(v_clinic, v_next) x))
         OR c.id IN (SELECT ec.lab_cost_id
                     FROM public.fin__hk_eval_lab_costs(v_clinic, v_month) ec
                     WHERE ec.rule_kind = 'ciro_share' AND ec.payee_user_id = v_user));

  -- 0032 (v1.4): the caller's doctor × lab rows of the month (cost, deducted from the caller's own payee object,
  -- count), as fin_hk_month's lab_summary.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'doctor_id', s.doctor_id,
           'doctor_name', s.doctor_name,
           'lab_name', s.lab_name,
           'cost_cents', s.cost_cents,
           'deducted_cents', s.deducted_cents,
           'count', s.n)
           ORDER BY s.doctor_name COLLATE "tr-x-icu", s.doctor_id, s.lab_name COLLATE "tr-x-icu",
                    s.lab_name COLLATE "C"), '[]'::jsonb)
    INTO v_lab_summary
  FROM (
    SELECT a.doctor_id,
           public.fin__hk_doctor_name(a.doctor_id) AS doctor_name,
           a.lab_name,
           sum(a.cost_cents)::bigint AS cost_cents,
           sum(a.deducted_cents)::bigint AS deducted_cents,
           sum(a.n)::bigint AS n
    FROM public.fin__hk_lab_alloc(v_clinic, v_month, v_payees) a
    WHERE a.payee_user_id = v_user
    GROUP BY a.doctor_id, a.lab_name
  ) s;

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
    'lab_summary', v_lab_summary,
    'statement', v_statement,
    'entitlement', v_entitlement);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs (fin_hk_*) granted to authenticated, internals (fin__hk_*, incl. the new fin__hk_financing_links and
--    the recreated fin__hk_eval_lines) never; plus its self-checks over every fin_* function (no overloads) and table.
--    hk_my_month keeps its ACL (CREATE OR REPLACE); repeated for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_month(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_n integer;
  v_j jsonb;
  v_doc uuid := '00000000-0000-0000-0000-00000000000a';
  v_row text;
  v_sqls text[];
  v_msgs text[];
  v_i integer;
  v_err text;
  v_fail text[] := '{}'::text[];
BEGIN
  -- 1. Signatures: the new helper and the replaced functions exist once (no overload); fin__hk_eval_lines ends with
  --    the financing columns.
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin__hk_line_json(uuid,uuid)',
    'public.fin__hk_strip_ledger(jsonb)',
    'public.fin__hk_financing_links(uuid,date)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin__hk_macro_row(jsonb,boolean,integer,date,date)',
    'public.fin_hk_import_macro(uuid,date,date,jsonb,jsonb,text[],boolean)',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fin__hk_line_json', 'fin__hk_strip_ledger', 'fin__hk_financing_links',
                             'fin__hk_eval_lines', 'fin__hk_compute', 'fin__hk_month_json', 'fin__hk_macro_row',
                             'fin_hk_import_macro', 'hk_my_month')) <> 9 THEN
    RAISE EXCEPTION 'Hakediş v2.3 fonksiyon imzaları beklenen gibi değil: %', coalesce(v_bad, 'aşırı yükleme var');
  END IF;
  IF pg_get_function_result(to_regprocedure('public.fin__hk_eval_lines(uuid,date)'))
       NOT LIKE '%, segment_source text, resolved_method text, financing_id uuid, financing_cents bigint, '
                || 'financing_implant_cents bigint, financing_lab_cents bigint, fee_cents bigint)' THEN
    RAISE EXCEPTION 'fin__hk_eval_lines finansman sütunlarını döndürmüyor.';
  END IF;

  -- 2. The helpers stay internal (SECURITY INVOKER, not callable from the API); the RPCs keep SECURITY DEFINER +
  --    search_path, callable by authenticated, never by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__hk_line_json', 'fin__hk_strip_ledger', 'fin__hk_financing_links', 'fin__hk_eval_lines',
                      'fin__hk_compute', 'fin__hk_month_json', 'fin__hk_macro_row')
    AND (p.prosecdef
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç hakediş fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_hk_import_macro', 'hk_my_month', 'fin_hk_month', 'fin_hk_close_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v2.3 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. The column, its constraint and index.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                 WHERE c.table_schema = 'public' AND c.table_name = 'fin_hk_lines' AND c.column_name = 'paid_on'
                   AND c.data_type = 'date' AND c.is_nullable = 'YES')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_lines'::regclass AND c.conname = 'fin_hk_lines_paid_on'
                      AND c.contype = 'c' AND c.convalidated)
     OR to_regclass('public.idx_fin_hk_lines_paid_on') IS NULL THEN
    RAISE EXCEPTION 'fin_hk_lines.paid_on / fin_hk_lines_paid_on / idx_fin_hk_lines_paid_on beklenen gibi değil.';
  END IF;

  -- 4. The payload's payment day (fin__hk_macro_row): kept on a part paid in money, the own day of a payment report
  --    line (given or not), absent → null, an advance before the treatment day accepted; refused on an 'unpaid' part,
  --    after the treatment's month, off a payment report line's day, or malformed. A piece ignores the key.
  v_row := '{"basis": "production", "day": "2024-04-10", "ext_doctor": "Dr", "patient_name": "Hasta", '
           || '"method": "transfer", "currency": "TRY", "amount_cents": 100';
  IF public.fin__hk_macro_row((v_row || ', "paid_on": "2024-04-05"}')::jsonb, true, 1, DATE '2024-04-01',
                              DATE '2024-04-30') ->> 'paid_on' IS DISTINCT FROM '2024-04-05'
     OR public.fin__hk_macro_row((v_row || ', "paid_on": "2024-03-20"}')::jsonb, true, 1, DATE '2024-04-01',
                                 DATE '2024-04-30') ->> 'paid_on' IS DISTINCT FROM '2024-03-20'
     OR public.fin__hk_macro_row((v_row || ', "paid_on": "2024-04-30"}')::jsonb, true, 1, DATE '2024-04-01',
                                 DATE '2024-04-30') ->> 'paid_on' IS DISTINCT FROM '2024-04-30'
     OR public.fin__hk_macro_row((v_row || ', "paid_on": null}')::jsonb, true, 1, DATE '2024-04-01',
                                 DATE '2024-04-30') -> 'paid_on' IS DISTINCT FROM 'null'::jsonb
     OR public.fin__hk_macro_row((v_row || '}')::jsonb, true, 1, DATE '2024-04-01', DATE '2024-04-30') -> 'paid_on'
          IS DISTINCT FROM 'null'::jsonb
     OR public.fin__hk_macro_row(('{"basis": "payment", "day": "2024-04-09", "treatment_day": "2024-03-01", '
                                  || '"ext_doctor": "Dr", "patient_name": "Hasta", "method": "cash", '
                                  || '"amount_cents": -100}')::jsonb, true, 1, DATE '2024-04-01', DATE '2024-04-30')
          ->> 'paid_on' IS DISTINCT FROM '2024-04-09'
     OR public.fin__hk_macro_row(('{"basis": "payment", "day": "2024-04-09", "ext_doctor": "Dr", '
                                  || '"patient_name": "Hasta", "method": "transfer", "amount_cents": 100, '
                                  || '"paid_on": "2024-04-09"}')::jsonb, true, 1, DATE '2024-04-01', DATE '2024-04-30')
          ->> 'paid_on' IS DISTINCT FROM '2024-04-09'
     OR public.fin__hk_macro_row(('{"day": "2024-04-10", "ext_doctor": "Dr", "patient_name": "Hasta", '
                                  || '"paid_on": "2024-04-10"}')::jsonb, false, 1, DATE '2024-04-01',
                                 DATE '2024-04-30') -> 'paid_on' IS DISTINCT FROM 'null'::jsonb THEN
    v_fail := array_append(v_fail, 'ödeme tarihi (geçerli satırlar)');
  END IF;
  v_sqls := ARRAY[
    replace(v_row, '"transfer"', '"unpaid"') || ', "paid_on": "2024-04-05"}',
    v_row || ', "paid_on": "2024-05-01"}',
    '{"basis": "payment", "day": "2024-04-10", "ext_doctor": "Dr", "patient_name": "Hasta", "method": "transfer", '
      || '"amount_cents": 100, "paid_on": "2024-04-09"}',
    v_row || ', "paid_on": "2024-02-30"}',
    v_row || ', "paid_on": 20240405}'];
  v_msgs := ARRAY[
    'Macro yüklemesi, 1. satır (10.04.2024): ödenmemiş kısmın ödeme tarihi olamaz.',
    'Macro yüklemesi, 1. satır (10.04.2024): ödeme tarihi işlemin ayından sonra olamaz (ay sonundan sonraki ödemeler ödenmemiş sayılır).',
    'Macro yüklemesi, 1. satır (10.04.2024): ödeme raporu satırının ödeme tarihi kendi tarihi olmalı.',
    'Macro yüklemesi, 1. satır (10.04.2024): ödeme tarihi geçersiz (YYYY-AA-GG).',
    'Macro yüklemesi, 1. satır (10.04.2024): ödeme tarihi geçersiz (YYYY-AA-GG).'];
  FOR v_i IN 1 .. cardinality(v_sqls)
  LOOP
    v_err := NULL;
    BEGIN
      PERFORM public.fin__hk_macro_row(v_sqls[v_i]::jsonb, true, 1, DATE '2024-04-01', DATE '2024-04-30');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
      v_fail := array_append(v_fail, 'ödeme tarihi reddi: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
    END IF;
  END LOOP;

  -- 5. A caller without ledger access: no NO_COUNTERPARTY, FINANCING_UNMATCHED without amounts, FINANCING_MATCHED
  --    as it is.
  v_j := public.fin__hk_strip_ledger(jsonb_build_object(
           'payees', '[]'::jsonb,
           'statements', '[]'::jsonb,
           'warnings', jsonb_build_array(
             jsonb_build_object('code', 'NO_COUNTERPARTY', 'payee_user_id', v_doc),
             jsonb_build_object('code', 'FINANCING_MATCHED', 'count', 1, 'gross_cents', 100, 'fee_cents', 20),
             jsonb_build_object('code', 'FINANCING_UNMATCHED', 'count', 1, 'financings', jsonb_build_array(
               jsonb_build_object('day', '2024-04-05', 'patient', 'Hasta', 'gross_cents', 100))))));
  IF (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
       jsonb_build_object('code', 'FINANCING_MATCHED', 'count', 1, 'gross_cents', 100, 'fee_cents', 20),
       jsonb_build_object('code', 'FINANCING_UNMATCHED', 'count', 1, 'financings', jsonb_build_array(
         jsonb_build_object('day', '2024-04-05', 'patient', 'Hasta')))) THEN
    v_fail := array_append(v_fail, 'defter verisi olmadan uyarılar: ' || left(v_j::text, 500));
  END IF;

  -- 6. An empty computation (runs every query of the engine once) is still the 0030 result; no links.
  v_j := public.fin__hk_compute(gen_random_uuid(), DATE '2024-01-15');
  IF v_j IS DISTINCT FROM jsonb_build_object('month', DATE '2024-01-01', 'payees', '[]'::jsonb,
                                             'clinic_total_cents', 0, 'warnings', '[]'::jsonb) THEN
    v_fail := array_append(v_fail, 'boş klinik hesabı: ' || left(v_j::text, 300));
  END IF;
  SELECT count(*) INTO v_n FROM public.fin__hk_financing_links(gen_random_uuid(), DATE '2024-01-15');
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, 'boş klinik finansman eşleşmesi');
  END IF;

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'Hakediş v2.3 yapı denetimi: %', array_to_string(v_fail, ' | ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.2 Replay inside a block that is always rolled back: temporary clinic 'p35-test-hk-selfcheck-<random>' with an
--     owner (finance), doctor A (ciro_share standard 50 %: card 11 %, transfer 9 %, financing 13 %, unpaid 11 %),
--     the orthodontist O (ortho_lab_first 50 %, no deductions), M (clinic_ciro_share 3 %), a reception user R
--     ('hakedis_prepare'), Macro doctors 'Dr. Bir' (A), 'Dr. Orto' (O) and 'KLİNİK' (clinic), an implant group, a lab
--     cost of O's patient and twelve Burgan financing rows inserted the way the finance import writes them (a fee
--     entry and the row; one voided, one linked to a DentOS patient whose statement name differs, one in June, a
--     month without lines). Made-up names, references, rates and amounts only; auth.uid() is simulated through
--     request.jwt.claims (and request.jwt.claim.sub / .role), as in 0030 – 0034. Month checks run as R (no ledger
--     data) unless noted otherwise.
--     April – May 2024, the same Macro lines twice: first without payment days (a 0034 payload: every production
--     transfer stays a transfer, the orthodontist's payment line still dated), then with them: a matched line, a line
--     beyond the gross (split) and a later-month line after it (none left), the ±3 day window (4 days: no; 3 days:
--     yes), the nearest of two financings and a tie (the earlier one), the fee pro rata (rounded per line), an implant
--     line (no fee), the orthodontist's line (lab part, no fee), a clinic line (matched, no fee), a voided financing
--     (ignored), a line without a payment day (never matched), the management share's base (gross),
--     FINANCING_MATCHED / FINANCING_UNMATCHED (amounts only for finance; none in a month without a line with a
--     payment day), the doctor's own view, the payload refusal and the paid_on constraint on a manual line. Nothing
--     survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p35-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_a_auth uuid := gen_random_uuid();
  v_a_doc uuid := gen_random_uuid();
  v_o uuid := gen_random_uuid();
  v_o_doc uuid := gen_random_uuid();
  v_m uuid := gen_random_uuid();
  v_m_doc uuid := gen_random_uuid();
  v_r uuid := gen_random_uuid();
  v_r_auth uuid := gen_random_uuid();
  v_pt uuid := gen_random_uuid();
  v_g_imp uuid := gen_random_uuid();
  v_b1 uuid := gen_random_uuid();
  v_b2 uuid := gen_random_uuid();
  v_b3 uuid := gen_random_uuid();
  v_cat uuid;
  v_fin jsonb;
  v_lines jsonb;
  v_plain jsonb;
  v_j jsonb;
  v_x jsonb;
  v_w jsonb;
  v_err text;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P35', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p35-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p35-sc-a-' || v_tag || '@example.invalid', true),
      (v_o, v_clinic, gen_random_uuid(), 'doctor', 'Öz denetim Hekim O', 'p35-sc-o-' || v_tag || '@example.invalid',
       true),
      (v_m, v_clinic, gen_random_uuid(), 'doctor', 'Öz denetim Hekim M', 'p35-sc-m-' || v_tag || '@example.invalid',
       true),
      (v_r, v_clinic, v_r_auth, 'reception', 'Öz denetim Banko', 'p35-sc-r-' || v_tag || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_a_doc, v_clinic, v_a), (v_o_doc, v_clinic, v_o), (v_m_doc, v_clinic, v_m);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own);
    -- The DentOS patient one financing row is linked to (its statement spells the name otherwise).
    INSERT INTO public.patients (id, clinic_id, full_name, phone) VALUES (v_pt, v_clinic, 'Hasta Yedi', '5300000035');

    -- Owner: 'hakedis_prepare' for R, the implant group, the Macro doctor mapping, the rules, O's lab cost.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;
    PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');
    PERFORM public.fin_hk_save_proc_group(v_g_imp, 0, 'İmplant', true, ARRAY['İmplant Uygulaması'], true, '');
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Bir', 'doctor', v_a_doc);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Orto', 'doctor', v_o_doc);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'KLİNİK', 'clinic', NULL);
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_a, v_a_doc, 'ciro_share', 'standard', 5000, NULL,
                                    0, 1100, 900, 1300, DATE '2024-01-01', NULL, '', 1100);
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_o, v_o_doc, 'ortho_lab_first', NULL, 5000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_m, NULL, 'clinic_ciro_share', NULL, 300, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-04-01', v_o_doc, 'Hasta Beş', NULL,
                                        'Lab Bir', 320000, '');

    -- Burgan financing rows (made up; the fee is commission + KKDF + BSMV), each with its realized fee entry.
    SELECT c.id INTO v_cat
    FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.report_bucket = 'fees' AND c.is_system;
    SELECT jsonb_agg(jsonb_build_object('ref', x.ref, 'nm', x.nm, 'd', x.d, 'g', x.g, 'c', x.c, 'k', x.k, 'b', x.b,
                                        'v', x.v, 'pt', x.pt) ORDER BY x.ref)
      INTO v_fin
    FROM (VALUES
      ('1-1000001-1', 'HASTA BİR', DATE '2024-04-05', 6400000, 1024001, 128000, 128000, false, NULL::uuid),
      ('1-1000002-1', 'HASTA İKİ', DATE '2024-04-24', 1280000, 204800, 25600, 25600, false, NULL),
      ('1-1000003-1', 'HASTA ÜÇ', DATE '2024-04-12', 1920000, 307200, 38400, 38400, false, NULL),
      ('1-1000004-1', 'HASTA ÜÇ', DATE '2024-04-14', 1920000, 384000, 48000, 48000, false, NULL),
      ('1-1000005-1', 'HASTA DÖRT', DATE '2024-04-08', 3200000, 512000, 64000, 64000, false, NULL),
      ('1-1000006-1', 'HASTA BEŞ', DATE '2024-04-09', 1280000, 204800, 25600, 25600, false, NULL),
      ('1-1000007-1', 'HASTA ALTI', DATE '2024-04-11', 640000, 102400, 12800, 12800, true, NULL),
      ('1-1000008-1', 'H. YEDİ', DATE '2024-04-16', 640000, 51200, 6400, 6400, false, v_pt),
      ('1-1000009-1', 'HASTA SEKİZ', DATE '2024-04-17', 640000, 102400, 12800, 12800, false, NULL),
      ('1-1000010-1', 'HASTA DOKUZ', DATE '2024-04-25', 960000, 153600, 19200, 19200, false, NULL),
      ('1-1000011-1', 'HASTA ON', DATE '2024-04-18', 640000, 102400, 12800, 12800, false, NULL),
      -- June: no line of that month (never imported).
      ('1-1000012-1', 'HASTA YİRMİ', DATE '2024-06-12', 640000, 102400, 12800, 12800, false, NULL)
    ) AS x(ref, nm, d, g, c, k, b, v, pt);
    INSERT INTO public.fin_entries (id, clinic_id, category_id, counterparty_text, description, due_date, amount_cents,
                                    created_by, updated_by)
    SELECT md5(v_tag || x.ref)::uuid, v_clinic, v_cat, 'Öz denetim finansman', 'Öz denetim finansman kesintisi', x.d,
           x.c + x.k + x.b, v_own, v_own
    FROM jsonb_to_recordset(v_fin) AS x(ref text, nm text, d date, g bigint, c bigint, k bigint, b bigint, v boolean,
                                        pt uuid);
    INSERT INTO public.fin_patient_financing (id, clinic_id, provider, reference, patient_name_raw, patient_id,
                                              txn_date, currency, gross_cents, commission_cents, kkdf_cents,
                                              bsmv_cents, blocked, expected_release, entry_id, voided_at, voided_by,
                                              void_reason, created_by, updated_by)
    SELECT md5(v_tag || 'f' || x.ref)::uuid, v_clinic, 'burgan', x.ref, x.nm, x.pt, x.d, 'TRY', x.g, x.c, x.k, x.b,
           false, NULL, md5(v_tag || x.ref)::uuid,
           CASE WHEN x.v THEN now() END, CASE WHEN x.v THEN v_own END, CASE WHEN x.v THEN 'Öz denetim iptali' END,
           v_own, v_own
    FROM jsonb_to_recordset(v_fin) AS x(ref text, nm text, d date, g bigint, c bigint, k bigint, b bigint, v boolean,
                                        pt uuid);

    -- The Macro lines of April – May (made up). Production lines of A (one per treatment and method; the transfer
    -- parts with their payment day), a clinic line, the orthodontist's payment line (no paid_on: its own day).
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'key', x.k, 'basis', x.basis, 'day', x.d, 'treatment_day', x.td, 'ext_doctor', x.ext,
             'patient_name', x.pat, 'patient_no', x.pno, 'procedure', x.op, 'tooth', x.tooth, 'method', x.m,
             'currency', 'TRY', 'amount_cents', x.amt, 'paid_on', x.paid)) ORDER BY x.n)
      INTO v_lines
    FROM (VALUES
      (1, 'l1', 'production', '2024-04-05', NULL::text, 'Dr. Bir', 'Hasta Bir', '2001', 'Dolgu', '16', 'transfer',
       3840000, '2024-04-05'),
      (2, 'l1b', 'production', '2024-04-10', NULL, 'Dr. Bir', 'Hasta Bir', '2001', 'Kanal Tedavisi', '26',
       'transfer', 3840000, '2024-04-05'),
      (3, 'l11', 'production', '2024-04-05', NULL, 'Dr. Bir', 'Hasta Bir', '2001', 'Dolgu', '16', 'cash', 640000,
       NULL),
      (4, 'l2', 'production', '2024-04-20', NULL, 'Dr. Bir', 'Hasta İki', '2002', 'Dolgu', '11', 'transfer', 640000,
       '2024-04-20'),
      (5, 'l2b', 'production', '2024-04-27', NULL, 'Dr. Bir', 'Hasta İki', '2002', 'Dolgu', '12', 'transfer',
       1280000, '2024-04-27'),
      (6, 'l3', 'production', '2024-04-14', NULL, 'Dr. Bir', 'Hasta Üç', '2003', 'Dolgu', '21', 'transfer', 1280000,
       '2024-04-14'),
      (7, 'l3c', 'production', '2024-04-13', NULL, 'Dr. Bir', 'Hasta Üç', '2003', 'Dolgu', '22', 'transfer', 640000,
       '2024-04-13'),
      (8, 'l4', 'production', '2024-04-08', NULL, 'Dr. Bir', 'Hasta Dört', '2004', 'İmplant Uygulaması', '36',
       'transfer', 3200000, '2024-04-08'),
      (9, 'l6', 'production', '2024-04-11', NULL, 'Dr. Bir', 'Hasta Altı', '2006', 'Dolgu', '31', 'transfer',
       640000, '2024-04-11'),
      (10, 'l7', 'production', '2024-04-16', NULL, 'Dr. Bir', 'Hasta Yedi', '2007', 'Dolgu', '32', 'transfer',
       640000, '2024-04-16'),
      (11, 'l10', 'production', '2024-04-18', NULL, 'Dr. Bir', 'Hasta On', '2010', 'Dolgu', '33', 'transfer',
       640000, NULL),
      (12, 'l12', 'production', '2024-05-03', NULL, 'Dr. Bir', 'Hasta Bir', '2001', 'Dolgu', '17', 'transfer',
       640000, '2024-04-05'),
      (13, 'l8', 'production', '2024-04-17', NULL, 'KLİNİK', 'Hasta Sekiz', '2008', 'Dolgu', '41', 'transfer',
       640000, '2024-04-17'),
      (14, 'l5', 'payment', '2024-04-09', '2024-04-02', 'Dr. Orto', 'Hasta Beş', NULL, 'Tel Tedavisi', NULL,
       'transfer', 1280000, NULL)
    ) AS x(n, k, basis, d, td, ext, pat, pno, op, tooth, m, amt, paid);
    SELECT jsonb_agg(t.e - 'paid_on' ORDER BY t.o) INTO v_plain
    FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(e, o);

    -- R: the 0034 payload (no payment days). A: cash 640.000 + transfer 16.640.000 − implant 3.200.000 = 13.440.000
    -- − 9 % = 12.230.400 → base 12.870.400 × 50 % = 6.435.200; the financing bucket empty (fee 0). O's payment line is
    -- dated (its own day) and matched; no fee. 9 April financings without a line (listed: the month has a dated line,
    -- O's).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_import_macro(v_b1, DATE '2024-04-01', DATE '2024-05-31', v_plain, '[]'::jsonb,
                                      ARRAY['tedavi.xls'], false);
    IF (v_j ->> 'lines')::integer IS DISTINCT FROM 14
       OR (SELECT string_agg(l.macro_basis || ':' || l.paid_on::text, ',')
           FROM public.fin_hk_lines l
           WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL AND l.paid_on IS NOT NULL)
          IS DISTINCT FROM 'payment:2024-04-09' THEN
      v_fail := array_append(v_fail, 'ödeme tarihsiz yükleme: ' || left(v_j::text, 800));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-04-01');
    SELECT p INTO v_x FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_a::text;
    SELECT w INTO v_w FROM jsonb_array_elements(v_j -> 'warnings') w WHERE (w ->> 'code') = 'FINANCING_UNMATCHED';
    IF (v_x ->> 'total_cents')::bigint IS DISTINCT FROM 6435200
       OR (v_x #> '{components,0,by_method,financing}') IS DISTINCT FROM jsonb_build_object(
            'gross', 0, 'implant', 0, 'lab', 0, 'eligible', 0, 'deduct_bp', 1300, 'deduction', 0, 'fee', 0)
       OR (v_x #> '{components,0,by_method,transfer}') IS DISTINCT FROM jsonb_build_object(
            'gross', 16640000, 'implant', 3200000, 'lab', 0, 'eligible', 13440000, 'deduct_bp', 900,
            'deduction', 1209600)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w
                      WHERE w = jsonb_build_object('code', 'FINANCING_MATCHED', 'count', 1, 'gross_cents', 1280000,
                                                   'fee_cents', 0))
       OR (v_w ->> 'count')::integer IS DISTINCT FROM 9
       OR (SELECT string_agg(f ->> 'day', ',' ORDER BY o)
           FROM jsonb_array_elements(v_w -> 'financings') WITH ORDINALITY AS y(f, o))
          IS DISTINCT FROM '2024-04-05,2024-04-08,2024-04-12,2024-04-14,2024-04-16,2024-04-17,2024-04-18,2024-04-24,'
                           || '2024-04-25'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                  WHERE NOT (l ->> 'is_voided')::boolean AND (l ->> 'basis') = 'production'
                    AND ((l ->> 'resolved_method') IS DISTINCT FROM (l ->> 'method')
                         OR (l ->> 'financing_cents')::bigint <> 0 OR (l ->> 'fee_cents')::bigint <> 0))
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_o::text AND (p ->> 'total_cents')::bigint = 480000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_m::text AND (p ->> 'total_cents')::bigint = 576000) THEN
      v_fail := array_append(v_fail, 'nisan (ödeme tarihi olmadan): ' || left(v_j::text, 2500));
    END IF;

    -- R: the same lines with their payment days (re-import of the range).
    v_j := public.fin_hk_import_macro(v_b2, DATE '2024-04-01', DATE '2024-05-31', v_lines, '[]'::jsonb,
                                      ARRAY['tedavi.xls'], false);
    IF (v_j ->> 'lines')::integer IS DISTINCT FROM 14
       OR (v_j ->> 'replaced_lines')::integer IS DISTINCT FROM 14
       OR (SELECT count(*) FROM public.fin_hk_lines l
           WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL AND l.paid_on IS NOT NULL) <> 12 THEN
      v_fail := array_append(v_fail, 'ödeme tarihli yükleme: ' || left(v_j::text, 800));
    END IF;

    -- April as R. A: cash 640.000; transfer 1.280.000 (beyond the first loan's gross) + 640.000 (4 days off) + 640.000
    -- (voided financing) + 640.000 (no payment day) = 3.200.000 − 9 % = 2.912.000; financing 13.440.000 − implant
    -- 3.200.000 = 10.240.000, fee 768.001 + 512.000 (the first loan, rounded per line) + 256.000 + 320.000 (25 %, the
    -- nearer loan) + 128.000 (20 %, the tie's earlier loan) + 0 (implant) + 64.000 (linked patient) = 2.048.001, − 13 %
    -- of 8.191.999 = 1.064.960 → 7.127.039; base 10.679.039 × 50 % = 5.339.519,5 → 5.339.520. O: financing, lab
    -- 320.000, no fee → 480.000. M: 3 % of the gross 19.200.000 = 576.000.
    v_j := public.fin_hk_month(DATE '2024-04-01');
    SELECT p INTO v_x FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_a::text;
    IF (v_x ->> 'total_cents')::bigint IS DISTINCT FROM 5339520
       OR (v_x #>> '{components,0,base_cents}')::bigint IS DISTINCT FROM 10679039
       OR (v_x #>> '{components,0,lines_count}')::integer IS DISTINCT FROM 11
       OR (v_x #> '{components,0,by_method,financing}') IS DISTINCT FROM jsonb_build_object(
            'gross', 13440000, 'implant', 3200000, 'lab', 0, 'eligible', 10240000, 'deduct_bp', 1300,
            'deduction', 1064960, 'fee', 2048001)
       OR (v_x #> '{components,0,by_method,transfer}') IS DISTINCT FROM jsonb_build_object(
            'gross', 3200000, 'implant', 0, 'lab', 0, 'eligible', 3200000, 'deduct_bp', 900, 'deduction', 288000)
       OR (v_x #> '{components,0,by_method,cash}') IS DISTINCT FROM jsonb_build_object(
            'gross', 640000, 'implant', 0, 'lab', 0, 'eligible', 640000, 'deduct_bp', 0, 'deduction', 0)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_o::text AND (p ->> 'total_cents')::bigint = 480000
                        AND (p #> '{components,0,by_method,financing}') = jsonb_build_object(
                              'gross', 1280000, 'implant', 0, 'lab', 320000, 'eligible', 960000, 'deduct_bp', 0,
                              'deduction', 0, 'fee', 0))
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_m::text AND (p ->> 'total_cents')::bigint = 576000
                        AND (p #>> '{components,0,base_cents}')::bigint = 19200000)
       OR (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 19200000
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('code', 'FINANCING_MATCHED', 'count', 9, 'gross_cents', 15360000,
                               'fee_cents', 2048001),
            jsonb_build_object('code', 'FINANCING_UNMATCHED', 'count', 2, 'financings', jsonb_build_array(
              jsonb_build_object('day', '2024-04-18', 'patient', 'HASTA ON'),
              jsonb_build_object('day', '2024-04-25', 'patient', 'HASTA DOKUZ')))) THEN
      v_fail := array_append(v_fail, 'nisan (ödeme tarihli): ' || left(v_j::text, 2500));
    END IF;
    IF (SELECT string_agg(concat_ws(':', l ->> 'patient_name', l ->> 'day', l ->> 'method', l ->> 'resolved_method',
                                    l ->> 'financing_cents', l ->> 'fee_cents', coalesce(l ->> 'paid_on', '-')),
                          ', ' ORDER BY (l ->> 'patient_name') COLLATE "C", l ->> 'day', l ->> 'method')
        FROM jsonb_array_elements(v_j -> 'lines') l
        WHERE NOT (l ->> 'is_voided')::boolean)
       IS DISTINCT FROM
         'Hasta Altı:2024-04-11:transfer:transfer:0:0:2024-04-11, '
         || 'Hasta Beş:2024-04-09:transfer:financing:1280000:0:2024-04-09, '
         || 'Hasta Bir:2024-04-05:cash:cash:0:0:-, '
         || 'Hasta Bir:2024-04-05:transfer:financing:3840000:768001:2024-04-05, '
         || 'Hasta Bir:2024-04-10:transfer:financing:2560000:512000:2024-04-05, '
         || 'Hasta Dört:2024-04-08:transfer:financing:3200000:0:2024-04-08, '
         || 'Hasta On:2024-04-18:transfer:transfer:0:0:-, '
         || 'Hasta Sekiz:2024-04-17:transfer:financing:640000:0:2024-04-17, '
         || 'Hasta Yedi:2024-04-16:transfer:financing:640000:64000:2024-04-16, '
         || 'Hasta Üç:2024-04-13:transfer:financing:640000:128000:2024-04-13, '
         || 'Hasta Üç:2024-04-14:transfer:financing:1280000:320000:2024-04-14, '
         || 'Hasta İki:2024-04-20:transfer:transfer:0:0:2024-04-20, '
         || 'Hasta İki:2024-04-27:transfer:financing:1280000:256000:2024-04-27' THEN
      v_fail := array_append(v_fail, 'nisan satırları: ' || left((v_j -> 'lines')::text, 2500));
    END IF;
    -- The preparer's payload carries no loan data: no reference, net amount or block / release field.
    IF v_j::text ~ '1-10000[0-9]{2}-1' OR strpos(v_j::text, 'net_cents') > 0
       OR strpos(v_j::text, 'expected_release') > 0 OR strpos(v_j::text, 'released_on') > 0 THEN
      v_fail := array_append(v_fail, 'hazırlayıcıya finansman verisi gitti');
    END IF;
    -- The nearest loan, and the earlier one of a tie (the internal evaluation names the rows).
    IF (SELECT string_agg(l.day::text || ':' || coalesce(e.financing_id::text, '-'), ',' ORDER BY l.day)
        FROM public.fin__hk_eval_lines(v_clinic, DATE '2024-04-01') e
        JOIN public.fin_hk_lines l ON l.clinic_id = v_clinic AND l.id = e.line_id
        WHERE l.patient_name = 'Hasta Üç')
       IS DISTINCT FROM '2024-04-13:' || md5(v_tag || 'f1-1000003-1')::uuid::text
                        || ',2024-04-14:' || md5(v_tag || 'f1-1000004-1')::uuid::text THEN
      v_fail := array_append(v_fail, 'en yakın finansman');
    END IF;

    -- May as R: the first loan was used up in April, so the May line paid on its day stays a transfer: A 640.000 −
    -- 9 % (57.600) × 50 % = 291.200; M 3 % of 640.000 = 19.200; no warning.
    v_j := public.fin_hk_month(DATE '2024-05-01');
    IF (v_j -> 'warnings') IS DISTINCT FROM '[]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'total_cents')::bigint = 291200)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_m::text AND (p ->> 'total_cents')::bigint = 19200)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                      WHERE NOT (l ->> 'is_voided')::boolean AND (l ->> 'day') = '2024-05-03'
                        AND (l ->> 'paid_on') = '2024-04-05' AND (l ->> 'resolved_method') = 'transfer'
                        AND (l ->> 'financing_cents')::bigint = 0) THEN
      v_fail := array_append(v_fail, 'mayıs: ' || left(v_j::text, 1500));
    END IF;

    -- June as R: the live financing row of June is not listed (no line of June has a payment day: a month never
    -- imported shows no loan, its patient name included).
    v_j := public.fin_hk_month(DATE '2024-06-01');
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w WHERE (w ->> 'code') = 'FINANCING_UNMATCHED')
       OR strpos(v_j::text, 'YİRMİ') > 0 THEN
      v_fail := array_append(v_fail, 'haziran (hazırlayıcı): ' || left(v_j::text, 1500));
    END IF;

    -- R: a part not paid by the month end has no payment day (refused, nothing written).
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_import_macro(v_b3, DATE '2024-04-01', DATE '2024-05-31',
                                         jsonb_build_array(jsonb_build_object(
                                           'key', 'u1', 'basis', 'production', 'day', '2024-04-05',
                                           'ext_doctor', 'Dr. Bir', 'patient_name', 'Hasta Bir', 'method', 'unpaid',
                                           'currency', 'TRY', 'amount_cents', 64000, 'paid_on', '2024-04-05')),
                                         '[]'::jsonb, ARRAY['tedavi.xls'], true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Macro yüklemesi, 1. satır (05.04.2024): ödenmemiş kısmın ödeme tarihi olamaz.' THEN
      v_fail := array_append(v_fail, 'ödenmemiş kısmın ödeme tarihi: ' || coalesce(v_err, '-'));
    END IF;

    -- Owner (finance): the unmatched financings with their amounts.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-04-01');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w
                   WHERE w = jsonb_build_object('code', 'FINANCING_UNMATCHED', 'count', 2, 'financings',
                               jsonb_build_array(
                                 jsonb_build_object('day', '2024-04-18', 'patient', 'HASTA ON', 'gross_cents', 640000),
                                 jsonb_build_object('day', '2024-04-25', 'patient', 'HASTA DOKUZ',
                                                    'gross_cents', 960000)))) THEN
      v_fail := array_append(v_fail, 'finans: eşleşmeyen finansmanlar: ' || left((v_j -> 'warnings')::text, 1500));
    END IF;
    -- Finance too: June's financing row is not listed (no line of June has a payment day).
    v_j := public.fin_hk_month(DATE '2024-06-01');
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w WHERE (w ->> 'code') = 'FINANCING_UNMATCHED')
       OR strpos(v_j::text, 'YİRMİ') > 0 THEN
      v_fail := array_append(v_fail, 'finans: haziran: ' || left(v_j::text, 1500));
    END IF;

    -- A manual line never carries a payment day (fin_hk_lines_paid_on).
    v_err := NULL;
    BEGIN
      INSERT INTO public.fin_hk_lines (id, clinic_id, source, day, doctor_id, patient_ref, patient_name, method,
                                       amount_cents, try_cents, paid_on, created_by, updated_by)
      VALUES (gen_random_uuid(), v_clinic, 'manual', DATE '2024-04-05', v_a_doc, 'hasta bir', 'Hasta Bir', 'transfer',
              100, 100, DATE '2024-04-05', v_own, v_own);
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_err = CONSTRAINT_NAME;
    END;
    IF v_err IS DISTINCT FROM 'fin_hk_lines_paid_on' THEN
      v_fail := array_append(v_fail, 'elle girilen satırda ödeme tarihi: ' || coalesce(v_err, '-'));
    END IF;

    -- A's own view: "Finansman (Burgan)" lines with the fee share, the same total.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-04-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 5339520
       OR (v_j #>> '{payees,0,components,0,by_method,financing,fee}')::bigint IS DISTINCT FROM 2048001
       OR jsonb_array_length(v_j -> 'lines') <> 11
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                      WHERE (l ->> 'day') = '2024-04-10' AND (l ->> 'resolved_method') = 'financing'
                        AND (l ->> 'financing_cents')::bigint = 2560000 AND (l ->> 'fee_cents')::bigint = 512000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                      WHERE (l ->> 'patient_name') = 'Hasta Altı' AND (l ->> 'resolved_method') = 'transfer'
                        AND (l ->> 'fee_cents')::bigint = 0) THEN
      v_fail := array_append(v_fail, 'hekim A nisan: ' || left(v_j::text, 1500));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v2.3): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p35_selfcheck_rollback';
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

-- Make the API see the new and replaced functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
