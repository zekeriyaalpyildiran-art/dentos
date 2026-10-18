-- Hakediş v1.3 + v1.4: the bank / cash split of a payee's monthly amount (v1.3); lab costs deducted from every
-- doctor's ciro, a minimum (floor) monthly amount and the doctor × lab summary of the month (v1.4). Part of some
-- payees' monthly total (hakediş or payroll) is paid by bank as an official salary, the rest in cash. The bank part is
-- PART OF the total, never on top of it. Safe to re-run.
--
-- Contract: hakedis_spec_v13.md + hakedis_spec_v14.md on top of 0031_hakedis_payroll.sql (applied and live; not
-- edited; its bodies are the latest definition of every fin_hk function and are copied here with only the changes
-- below). Requires 0030 and 0031.
--
--  * No names, rates or amounts in this file: bank amounts, floors and lab costs are rows the owner / the reception
--    enter.
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
--    warnings get the payee id (v1.4: then the doctor id and the segment) as last sort keys (only ties of equal names
--    were unordered before).
--  * Month close (fin_hk_close_month itself changes only for v1.4, below): the entry descriptions (fin__hk_description
--    for the physician entitlement, fin__hk_payroll_description for the staff payroll entry) end with
--    ' · Bankadan <bank> · Elden <cash>' when the payee has bank_cents (the breakdown before it is cut so the whole
--    text stays <= 1000 characters); the statement breakdown (the payee object) carries bank_cents / cash_cents.
--  * Self-service: fin__hk_self_payee keeps bank_cents / cash_cents, so hk_my_month shows them in the caller's own
--    payee object; hk_my_months adds them to every month row (closed: from the statement breakdown).
--  * 'hakedis_prepare' callers see bank_cents / cash_cents and BANK_OVER_TOTAL in fin_hk_month: hakediş data, not
--    ledger data (fin__hk_strip_ledger, not replaced, removes only counterparty ids, NO_COUNTERPARTY and entries).
--
--  v1.4 (hakedis_spec_v14.md):
--  * Lab costs of a ciro_share doctor: every live fin_hk_lab_costs row of the month resolves to a rule exactly like a
--    revenue line of the same doctor and patient on the cost's day (fin__hk_eval_lab_costs, no manual segment): the
--    doctor's active ortho_lab_first rule, else ciro_share of the segment from the patient mark (own / child by age on
--    that day / is_child / standard), else the doctor's ciro_share 'standard', else none. Per ciro_share rule with
--    such rows: C = Σ_method (eligible − deduction) (the 0031 base), L = Σ the rows' amounts,
--    lab_cents = L when L <= 0, else min(L, max(C, 0)); base = C − lab_cents (a lab cost never takes the base below 0;
--    a C already negative from corrections stays as it is); amount = round(base × share_bp / 10000). The rest
--    (L − lab_cents) stays with the clinic, no carry-forward: warning LAB_OVER_CIRO. by_method is unchanged.
--  * Ortho (ortho_lab_first): the lab-first walk is unchanged for its own costs, which are not deducted a second time.
--    fin__hk_ortho_walk (0030 body + one filter) and every ortho lab figure to date (fin__hk_compute lab_patients,
--    fin__hk_lab_alloc, hk_my_month's ortho rows) leave out a lab cost that resolved to a ciro_share rule in its own
--    month (fin__hk_ciro_lab_ids): it was deducted there, so a doctor moving from ciro_share to ortho_lab_first does
--    not recover it again. A cost that was unruled in its own month (e.g. dated before the ortho rule) is still
--    recovered. Doctors who only ever had ortho rules get the 0031 figures. The test reads the rules and marks as they
--    are now, not what a closed statement froze: a month closed before this file did not deduct its ciro_share costs,
--    yet they are left out of a later walk too (RUNBOOK 0).
--  * Reception's closed-month mark lock (fin__hk_closed_lines, 0030 body + a lab cost test): hk_save_mark,
--    fin_hk_save_mark without 'finance' and the marks' 'locked' flag now also count a live lab cost in a closed month,
--    since lab costs resolve their segment from the mark. The refusal text is unchanged.
--  * Lab costs with no rule (a doctor with only implant_piece rules, or none, or no matching / standard ciro_share):
--    deducted nowhere, warning UNRULED_LAB per doctor when their sum is not 0. Neither lab warning blocks the close.
--  * Rule kind minimum_monthly (UI "Taban maaş (hangisi yüksekse)"): payee = any active user, no doctor / segment /
--    share / deductions, piece_cents = the floor (> 0), from_month / to_month, overlap per (clinic, kind, payee) like
--    fixed_monthly / bank_portion. Payee total = max(Σ the other components, floor): when the floor applies the payee
--    gets a last component {rule_id, kind: 'minimum_topup', amount_cents: floor − Σ the others}; none when Σ >= floor.
--    A payee with only a floor gets it whole. bank_cents / cash_cents use the final total. A payee without a doctors
--    row whose components are only fixed_monthly / adjustments / minimum_topup is staff (payroll entry at close); the
--    close's staff messages for a cancelled or a 0 payroll entry name the taban maaş rule next to the salary rule.
--  * Entry descriptions (fin__hk_parts): 'taban maaş tamamlaması <amount>' for a minimum_topup component.
--  * fin_hk_month (finance and prep): lab_costs[] + {resolved_segment, rule_id} (null for a voided row or a row
--    without a rule); lab_summary (doctor × lab rows of the month) and lab_totals (per lab), from fin__hk_lab_alloc.
--  * Self-service: hk_my_month lab_costs also lists the month's lab costs counted under the caller's own ciro_share
--    rules (the ortho rows to date as before); lab_summary = the caller's own doctor × lab rows. The payee object (and
--    so the frozen statement breakdown) carries lab_cents / lab_excess_cents / minimum_topup components.
--  * Outputs for months without lab costs on ciro_share doctors and without minimum_monthly rules are those of v1.3.
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
--  v1.4:
--   RuleJson        kind 'minimum_monthly': doctor_id null, segment null, share_bp null, piece_cents = the floor,
--                   deductions 0.
--   Component       ciro_share + {lab_cents, lab_excess_cents} only when live lab costs of the month resolve to the
--                   rule (lab_cents = what was deducted, lab_excess_cents = L − lab_cents); base_cents is then
--                   C − lab_cents. New component {rule_id, kind: 'minimum_topup', amount_cents}, after adjustments.
--                   ortho_lab_first: by_method lab and lab_patients without the costs that resolved to a ciro_share
--                   rule in their own month (same keys).
--   Warning         + {code: 'UNRULED_LAB', doctor_id, doctor_name, lab_cents} (ord 5, by doctor name, doctor id)
--                   + {code: 'LAB_OVER_CIRO', doctor_id, doctor_name, rule_id, segment, lab_cents (L),
--                      ciro_after_deductions_cents (C), excess_cents (L − deducted)} (ord 6, by doctor name, doctor id,
--                      segment standard / child / own). Order of every warning: kind (UNRULED_LINES, UNRULED_PIECES,
--                   NO_COUNTERPARTY, BANK_OVER_TOTAL, UNRULED_LAB, LAB_OVER_CIRO), name, payee id, doctor id, segment.
--   fin_hk_month(), fin_hk_close_month(), fin_hk_reopen_month()
--                   lab_costs[] + {resolved_segment, rule_id};
--                   + lab_summary: [{doctor_id, doctor_name, lab_name, cost_cents, deducted_cents, count}] by doctor
--                     name, doctor id, lab name; + lab_totals: [{lab_name, cost_cents, deducted_cents, count}] by lab
--                     name. cost_cents = Σ live costs of the month, count = their rows; deducted_cents = ciro_share:
--                     each rule's lab_cents shared over its labs by their cost; ortho: per patient the lab part
--                     recovered from this month's payments shared over the patient's labs by their costs to date
--                     (a row with cost 0 / count 0 when only an earlier cost was recovered); 0 for unruled costs.
--                     Shares: cumulative rounding in lab name order (COLLATE "C"), exact sums.
--   hk_my_month()   lab_costs[] (same keys) also the month's costs counted under the caller's ciro_share rules;
--                   + lab_summary: the caller's rows (same shape as above, deducted from the caller's own payee).
--
-- RUNBOOK (production is the only database):
--   0. Before step 1 (owner, Finans → Hakediş): close every finished month whose figures must stay as they were. A
--      closed month keeps its statements and ledger entries; only open months (and a reopened month at its next close)
--      are recomputed with the lab deduction. Exception: a doctor who had a ciro_share rule in such a closed month and
--      an ortho_lab_first rule later. Those lab costs were not deducted at that close (0031), and from step 1 the
--      ortho walk leaves them out too. Reopen and re-close that month after step 1 so it deducts them, or check that
--      this SELECT returns no rows before step 1:
--        SELECT clinic_id, doctor_id FROM public.fin_hk_rules WHERE kind IN ('ciro_share', 'ortho_lab_first')
--        GROUP BY clinic_id, doctor_id HAVING count(DISTINCT kind) > 1;
--   1. Quiet moment (a second): fin_hk_rules gets its kind constraints replaced in this transaction. SQL editor → New
--      query → paste this file ALONE → Run. One transaction; the self-checks at the end (including a replay in a
--      temporary clinic that is always rolled back) undo everything on any failure.
--   2. Deploy the web build with the bank / cash split, the floor and the lab summary afterwards (until step 1 a
--      bank_portion / minimum_monthly rule is refused with "Geçersiz kural türü." and the payloads carry none of the
--      new keys). From step 1 on, the open months of ciro_share doctors with lab costs show the deducted figures.
--   Re-running 0031 later puts back its fin__hk_compute / fin__hk_parts / descriptions / fin__hk_month_json /
--   fin_hk_save_rule / fin_hk_close_month / hk_my_months / hk_my_month bodies and its kind constraints (it fails while
--   a bank_portion or minimum_monthly rule exists): re-run this file afterwards (also after re-running 0030, which
--   puts back fin__hk_ortho_walk / fin__hk_closed_lines too).
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) DELETE FROM public.fin_hk_rules WHERE kind IN ('bank_portion', 'minimum_monthly'); (fin__trg_no_delete allows
--       row deletes from the SQL editor). The 0031 calculation ignores such rows (every branch filters by kind), but
--       the 0031 kind constraints of (d) refuse them.
--   (b) Re-run the 0031 definitions of fin__hk_parts, fin__hk_description, fin__hk_payroll_description,
--       fin__hk_compute, fin__hk_month_json, fin_hk_save_rule, fin_hk_close_month, hk_my_months and hk_my_month, and
--       the 0030 definitions of fin__hk_self_payee, fin__hk_ortho_walk and fin__hk_closed_lines.
--   (c) Only then DROP FUNCTION public.fin__hk_lab_alloc(uuid, date, jsonb), public.fin__hk_ciro_lab_ids(uuid, date),
--       public.fin__hk_eval_lab_costs(uuid, date), public.fin__hk_round_div(numeric, numeric),
--       public.fin__hk_bank_note(jsonb); (the 0032 bodies call them).
--   (d) Restore the 0031 fin_hk_rules_kind_check / fin_hk_rules_kind_shape (0031 §1.2), or keep these (a superset).
--   Statements and entry descriptions written by closes after this file keep their bank / cash / lab / floor parts
--   (extra breakdown keys and components, text); the next close of a reopened month rewrites the description.

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
                    'hk_my_months', 'hk_my_month', 'fin__hk_segment', 'fin__hk_child_age_limit',
                    'fin__hk_lab_cost_json', 'fin__hk_line_json', 'fin__hk_piece_json', 'fin__hk_adjustment_json',
                    'fin__hk_statement_json', 'fin__hk_month_row_json', 'fin__user_name', 'fin__hk_closed_lines',
                    'fin__hk_mark_locked', 'fin__hk_mark_desk_json', 'hk_save_mark', 'hk_marks_list',
                    'fin_hk_save_mark']) AS f(fn)
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
    'public.fin__hk_segment(text,uuid,date,uuid,date,boolean,integer)',
    'public.fin__hk_child_age_limit(uuid)',
    'public.fin__hk_ortho_walk(uuid,date)',
    'public.fin__hk_closed_lines(uuid,text,uuid)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin__hk_payee_entry(uuid,uuid,date)',
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
  -- v1.4 replaces these 0031 bodies too (on a re-run this file's, which keep these texts).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fin__hk_month_json'
                   AND p.prosrc LIKE '%public.fin__hk_strip_ledger(%'
                   AND p.prosrc LIKE '%public.fin__hk_adjustment_json(%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_close_month'
                      AND p.prosrc LIKE '%public.fin__hk_payroll_description(%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'hk_my_month'
                      AND p.prosrc LIKE '%public.fin__hk_payee_entry(%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin__hk_parts'
                      AND p.prosrc LIKE '%''sabit maaş '' || %') THEN
    RAISE EXCEPTION 'fin__hk_month_json / fin_hk_close_month / hk_my_month / fin__hk_parts 0031 sürümünde değil.';
  END IF;
  -- ... and these 0030 bodies (on a re-run this file's, which keep these texts).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fin__hk_ortho_walk'
                   AND p.prosrc LIKE '%lab_to_month%' AND p.prosrc LIKE '%RETURN NEXT%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin__hk_closed_lines'
                      AND p.prosrc LIKE '%public.fin_hk_lines l%') THEN
    RAISE EXCEPTION 'fin__hk_ortho_walk / fin__hk_closed_lines 0030 sürümünde değil.';
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
    ('fin_hk_statements', 'superseded_at'),
    ('fin_hk_lab_costs', 'id'), ('fin_hk_lab_costs', 'clinic_id'), ('fin_hk_lab_costs', 'day'),
    ('fin_hk_lab_costs', 'doctor_id'), ('fin_hk_lab_costs', 'patient_ref'), ('fin_hk_lab_costs', 'lab_name'),
    ('fin_hk_lab_costs', 'amount_cents'), ('fin_hk_lab_costs', 'voided_at'), ('fin_hk_lab_costs', 'created_at'),
    ('fin_hk_patient_marks', 'patient_ref'), ('fin_hk_patient_marks', 'own_doctor_id'),
    ('fin_hk_patient_marks', 'birth_date'), ('fin_hk_patient_marks', 'is_child')
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
-- 1.1 Schema: rule kinds bank_portion (the monthly bank amount in piece_cents) and minimum_monthly (the monthly floor
--     in piece_cents). The kind CHECK (a single-column CHECK on kind; 0031 named it fin_hk_rules_kind_check) and the
--     shape CHECK are recreated with the new kinds.
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
    kind IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share', 'fixed_monthly', 'bank_portion',
             'minimum_monthly')
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
    OR (kind = 'minimum_monthly' AND doctor_id IS NULL AND segment IS NULL AND share_bp IS NULL
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

-- v1.4: round(p_num / p_den) half away from zero, exact (integer arithmetic with div, so a quotient just below or above
-- .5 is never rounded the wrong way, whatever the size); 0 when p_den is 0 or either argument is NULL.
CREATE OR REPLACE FUNCTION public.fin__hk_round_div(p_num numeric, p_den numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_num IS NULL OR p_den IS NULL OR p_den = 0 THEN 0::bigint
              ELSE (sign(p_num) * sign(p_den) * div(2 * abs(p_num) + abs(p_den), 2 * abs(p_den)))::bigint
         END
$$;

-- v1.4: every live lab cost of the month with its resolved segment and rule (NULL = unruled), resolved like a revenue
-- line of the same doctor and patient on the cost's day (fin__hk_eval_lines, without a manual segment):
--   segment: fin__hk_segment(NULL, ...): 'own' when the patient mark names the cost's doctor, else 'child' by the
--            mark's birth date on the cost's day (without a birth date: the mark's child flag), else 'standard';
--   rule:    the doctor's active ortho_lab_first rule, else ciro_share (doctor, segment), else ciro_share 'standard'.
-- A cost under an ortho_lab_first rule is recovered by the lab-first walk only (never deducted again); a cost under a
-- ciro_share rule is deducted from that rule's base in its month and never recovered by a later walk
-- (fin__hk_ciro_lab_ids).
CREATE OR REPLACE FUNCTION public.fin__hk_eval_lab_costs(p_clinic uuid, p_month date)
RETURNS TABLE (lab_cost_id uuid, doctor_id uuid, patient_ref text, lab_name text, amount_cents bigint,
               segment text, rule_id uuid, rule_kind text, payee_user_id uuid)
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
  lc AS (
    SELECT c.id, c.doctor_id, c.patient_ref, c.lab_name, c.amount_cents,
           public.fin__hk_segment(NULL::text, c.doctor_id, c.day, m.own_doctor_id, m.birth_date, m.is_child,
                                  lim.age_limit) AS seg
    FROM public.fin_hk_lab_costs c
    CROSS JOIN (SELECT public.fin__hk_child_age_limit(p_clinic) AS age_limit) lim
    LEFT JOIN public.fin_hk_patient_marks m ON m.clinic_id = c.clinic_id AND m.patient_ref = c.patient_ref
    WHERE c.clinic_id = p_clinic
      AND c.voided_at IS NULL
      AND c.day >= public.fin__month_start(p_month)
      AND c.day < (public.fin__month_start(p_month) + interval '1 month')::date
  )
  SELECT lc.id,
         lc.doctor_id,
         lc.patient_ref,
         lc.lab_name,
         lc.amount_cents,
         lc.seg,
         x.id,
         x.kind,
         x.payee_user_id
  FROM lc
  LEFT JOIN LATERAL (
    SELECT ar.id, ar.kind, ar.payee_user_id
    FROM ar
    WHERE ar.doctor_id = lc.doctor_id
      AND (ar.kind = 'ortho_lab_first' OR ar.segment = lc.seg OR ar.segment = 'standard')
    ORDER BY CASE WHEN ar.kind = 'ortho_lab_first' THEN 0 WHEN ar.segment = lc.seg THEN 1 ELSE 2 END, ar.id
    LIMIT 1
  ) x ON true
$$;

-- v1.4: the live lab costs dated before p_next that resolved to a ciro_share rule in their own month
-- (fin__hk_eval_lab_costs of each month with costs): deducted from that rule's base there, so the ortho lab-first
-- walk and every ortho lab figure to date leave them out (a doctor moving from ciro_share to ortho_lab_first does not
-- recover them a second time). A cost that was unruled in its own month is not listed: a later walk still recovers it.
CREATE OR REPLACE FUNCTION public.fin__hk_ciro_lab_ids(p_clinic uuid, p_next date)
RETURNS TABLE (lab_cost_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT e.lab_cost_id
  FROM (
    SELECT DISTINCT public.fin__month_start(c.day) AS m
    FROM public.fin_hk_lab_costs c
    WHERE c.clinic_id = p_clinic
      AND c.voided_at IS NULL
      AND c.day < p_next
  ) mm
  CROSS JOIN LATERAL public.fin__hk_eval_lab_costs(p_clinic, mm.m) e
  WHERE e.rule_kind = 'ciro_share'
$$;

-- v1.4: the month's lab costs by (payee, doctor, lab) for fin_hk_month (summed per doctor × lab: lab_summary /
-- lab_totals) and hk_my_month (the caller's rows). cost_cents / n: Σ / count of the live costs of the month (payee =
-- the payee of the rule each cost resolves to, NULL without one). deducted_cents: what the month's figures took off:
--   ciro_share       the rule's lab_cents as found in p_payees (the compute payees, or the caller's own payee objects;
--                    a component without lab_cents counts 0), shared over the rule's labs by their month cost;
--   ortho_lab_first  per (doctor, patient) the lab part recovered from this month's payments (fin__hk_ortho_walk),
--                    shared over the patient's labs by their live costs up to the end of the month (without the costs
--                    deducted from a ciro_share rule in their own month, as the walk); payee = the doctor's active
--                    ortho rule (the one fin__hk_eval_lines counts its lines under);
--   unruled          0.
-- Shares: cumulative rounding in lab name order (COLLATE "C"), share_i = round(D × W_i / W) − round(D × W_(i-1) / W)
-- with W_i the running and W the total weight (fin__hk_round_div; 0 when W = 0), so they add up to D exactly. Rows
-- with no cost row and nothing deducted are left out.
CREATE OR REPLACE FUNCTION public.fin__hk_lab_alloc(p_clinic uuid, p_month date, p_payees jsonb)
RETURNS TABLE (payee_user_id uuid, doctor_id uuid, lab_name text, cost_cents bigint, deducted_cents bigint,
               n bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH lc AS MATERIALIZED (
    SELECT * FROM public.fin__hk_eval_lab_costs(p_clinic, p_month)
  ),
  -- What each ciro_share rule deducted (its component's lab_cents).
  ded AS (
    SELECT (k ->> 'rule_id')::uuid AS rule_id, sum((k ->> 'lab_cents')::bigint)::bigint AS cents
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payees) = 'array' THEN p_payees ELSE '[]'::jsonb END) py
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(py -> 'components') = 'array' THEN py -> 'components' ELSE '[]'::jsonb END) k
    WHERE (k ->> 'kind') = 'ciro_share'
      AND jsonb_typeof(k -> 'lab_cents') = 'number'
      AND jsonb_typeof(k -> 'rule_id') = 'string'
    GROUP BY (k ->> 'rule_id')::uuid
  ),
  cw AS (
    SELECT lc.rule_id, lc.payee_user_id, lc.doctor_id, lc.lab_name, sum(lc.amount_cents)::bigint AS w
    FROM lc
    WHERE lc.rule_kind = 'ciro_share'
    GROUP BY lc.rule_id, lc.payee_user_id, lc.doctor_id, lc.lab_name
  ),
  cwr AS (
    SELECT cw.payee_user_id,
           cw.doctor_id,
           cw.lab_name,
           cw.w,
           coalesce(dd.cents, 0)::bigint AS d,
           sum(cw.w) OVER (PARTITION BY cw.rule_id ORDER BY cw.lab_name COLLATE "C") AS cum,
           sum(cw.w) OVER (PARTITION BY cw.rule_id) AS tot
    FROM cw
    LEFT JOIN ded dd ON dd.rule_id = cw.rule_id
  ),
  orule AS (
    SELECT DISTINCT ON (r.doctor_id) r.doctor_id, r.payee_user_id
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = p_clinic
      AND r.kind = 'ortho_lab_first'
      AND r.from_month <= public.fin__month_start(p_month)
      AND (r.to_month IS NULL OR r.to_month >= public.fin__month_start(p_month))
    ORDER BY r.doctor_id, r.id
  ),
  -- Costs the walk leaves out (deducted from a ciro_share rule in their own month).
  xc AS MATERIALIZED (
    SELECT ci.lab_cost_id
    FROM public.fin__hk_ciro_lab_ids(p_clinic, (public.fin__month_start(p_month) + interval '1 month')::date) ci
  ),
  -- Lab part recovered from this month's payments, per (doctor, patient).
  orec AS (
    SELECT w.doctor_id, w.patient_ref, sum(w.lab_part_cents)::bigint AS cents
    FROM public.fin__hk_ortho_walk(p_clinic, p_month) w
    WHERE w.line_day >= public.fin__month_start(p_month)
    GROUP BY w.doctor_id, w.patient_ref
  ),
  ow AS (
    SELECT c.doctor_id, c.patient_ref, c.lab_name, sum(c.amount_cents)::bigint AS w
    FROM public.fin_hk_lab_costs c
    JOIN orec o ON o.doctor_id = c.doctor_id AND o.patient_ref = c.patient_ref AND o.cents <> 0
    WHERE c.clinic_id = p_clinic
      AND c.voided_at IS NULL
      AND c.day < (public.fin__month_start(p_month) + interval '1 month')::date
      AND c.id NOT IN (SELECT xc.lab_cost_id FROM xc)
    GROUP BY c.doctor_id, c.patient_ref, c.lab_name
  ),
  owr AS (
    SELECT ow.doctor_id,
           ow.lab_name,
           ow.w,
           o.cents AS d,
           sum(ow.w) OVER (PARTITION BY ow.doctor_id, ow.patient_ref ORDER BY ow.lab_name COLLATE "C") AS cum,
           sum(ow.w) OVER (PARTITION BY ow.doctor_id, ow.patient_ref) AS tot
    FROM ow
    JOIN orec o ON o.doctor_id = ow.doctor_id AND o.patient_ref = ow.patient_ref
  ),
  x AS (
    SELECT lc.payee_user_id, lc.doctor_id, lc.lab_name, lc.amount_cents AS cost, 0::bigint AS taken, 1 AS n
    FROM lc
    UNION ALL
    SELECT cwr.payee_user_id,
           cwr.doctor_id,
           cwr.lab_name,
           0::bigint,
           public.fin__hk_round_div(cwr.d * cwr.cum, cwr.tot)
             - public.fin__hk_round_div(cwr.d * (cwr.cum - cwr.w), cwr.tot),
           0
    FROM cwr
    UNION ALL
    SELECT r.payee_user_id,
           owr.doctor_id,
           owr.lab_name,
           0::bigint,
           public.fin__hk_round_div(owr.d * owr.cum, owr.tot)
             - public.fin__hk_round_div(owr.d * (owr.cum - owr.w), owr.tot),
           0
    FROM owr
    JOIN orule r ON r.doctor_id = owr.doctor_id
  )
  SELECT x.payee_user_id, x.doctor_id, x.lab_name, sum(x.cost)::bigint, sum(x.taken)::bigint, sum(x.n)::bigint
  FROM x
  GROUP BY x.payee_user_id, x.doctor_id, x.lab_name
  HAVING sum(x.n) > 0 OR sum(x.taken) <> 0
$$;

-- Whether the patient key has a live line or lab cost in a closed month (v1.4: lab costs resolve their segment from
-- the mark): of the doctor p_doctor, or of any doctor when NULL (0030 body + the lab cost test, same signature). Read
-- by fin__hk_mark_locked (hk_save_mark, fin_hk_save_mark without 'finance') and the marks' 'locked' flag
-- (fin__hk_mark_desk_json); the refusal text stays 'Bu hastanın kapanmış ayda ödemesi var; ...'.
CREATE OR REPLACE FUNCTION public.fin__hk_closed_lines(p_clinic uuid, p_ref text, p_doctor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.fin_hk_lines l
    JOIN public.fin_hk_months mo
      ON mo.clinic_id = l.clinic_id AND mo.month = public.fin__month_start(l.day) AND mo.status = 'closed'
    WHERE l.clinic_id = p_clinic
      AND l.patient_ref = p_ref
      AND l.voided_at IS NULL
      AND (p_doctor IS NULL OR l.doctor_id = p_doctor))
  OR EXISTS (
    SELECT 1
    FROM public.fin_hk_lab_costs c
    JOIN public.fin_hk_months mo
      ON mo.clinic_id = c.clinic_id AND mo.month = public.fin__month_start(c.day) AND mo.status = 'closed'
    WHERE c.clinic_id = p_clinic
      AND c.patient_ref = p_ref
      AND c.voided_at IS NULL
      AND (p_doctor IS NULL OR c.doctor_id = p_doctor))
$$;

-- Ortho lab-first walk for the month p_month (0030 body, same signature): for every doctor with an active
-- ortho_lab_first rule in that month and every patient key of that doctor, all live lines with day before the next
-- month in (day, created_at, id) order. Available lab = live lab costs of (doctor, patient) whose month is <= the
-- line's month, minus what earlier lines already recovered; lab part = max(min(try − implant, available), 0). v1.4: a
-- cost that resolved to a ciro_share rule in its own month (fin__hk_ciro_lab_ids) is not available: it was deducted
-- from that rule's base. A cost that was unruled in its own month (e.g. before the ortho rule) still is. Returns one
-- row per walked line (all months); the lab part of a line does not depend on p_month, only on the lines before it
-- and on the rules of the costs' own months.
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
    -- 0032 (v1.4): the live costs dated before the next month that resolved to a ciro_share rule in their own month
    -- (deducted from that rule's base there), once per call.
    WITH xc AS MATERIALIZED (
      SELECT x.lab_cost_id FROM public.fin__hk_ciro_lab_ids(p_clinic, v_next) x
    )
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
              AND c.day < (public.fin__month_start(l.day) + interval '1 month')::date
              AND c.id NOT IN (SELECT xc.lab_cost_id FROM xc))::bigint AS lab_to_month
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

-- Components of a payee as short Turkish parts for the ledger entry description, '; '-joined (NULL when none), 0031
-- body: the 0030 kinds as '<label> × <base> = <amount>' (zero amounts left out; the doctor is named only when the
-- rule's doctor is not the payee's own doctors row), 'sabit maaş <amount>', from the adjustments 'prim <Σ bonus>' /
-- 'diğer <Σ other>' (zero sums left out) and, 0032, 'taban maaş tamamlaması <amount>' for a minimum_topup component
-- (the base of a ciro_share part is the base after its lab costs).
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
             WHEN 'minimum_topup' THEN
               'taban maaş tamamlaması ' || public.fin__hk_tl((o.c ->> 'amount_cents')::bigint)
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

-- Ledger entry description of a doctor payee (fin_entries.description, <= 1000 characters, 0031), e.g.
-- 'DentOS hakediş 2026-11: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL · Bankadan 100,00 TL · Elden 150,00 TL',
-- 'DentOS hakediş 2026-11: ciro payı (standart) %25 × 1.000,00 TL = 250,00 TL; taban maaş tamamlaması 50,00 TL'.
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
--    get the payee id, the doctor id and the segment as last sort keys. v1.4: a ciro_share rule's lab costs of the
--    month come off its base (never below 0; lab_cents / lab_excess_cents on its component, LAB_OVER_CIRO for the
--    excess), lab costs without a rule give UNRULED_LAB, a minimum_monthly floor adds a last minimum_topup component;
--    an ortho rule's lab_patients leave out the costs deducted from a ciro_share rule in their own month (as the
--    walk). Without lab costs on ciro_share rules and without floors, components and totals are the 0031 ones.
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
           CASE ar.kind WHEN 'ciro_share' THEN 1 WHEN 'ortho_lab_first' THEN 2 WHEN 'implant_piece' THEN 3 ELSE 4 END
             AS kind_ord,
           CASE ar.segment WHEN 'standard' THEN 1 WHEN 'child' THEN 2 WHEN 'own' THEN 3 ELSE 0 END AS seg_ord,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN sh.by_method END AS by_method,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN lx.base
                WHEN ar.kind = 'clinic_ciro_share' THEN g.total
           END AS base_cents,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first')
                  THEN round(lx.base::numeric * ar.share_bp / 10000)::bigint
                WHEN ar.kind = 'implant_piece' THEN coalesce(pc.qty, 0) * ar.piece_cents
                ELSE round(g.total::numeric * ar.share_bp / 10000)::bigint
           END AS amount_cents,
           CASE WHEN ar.kind = 'implant_piece' THEN coalesce(pc.qty, 0) END AS qty,
           CASE WHEN ar.kind IN ('ciro_share', 'ortho_lab_first') THEN coalesce(sh.n, 0)
                WHEN ar.kind = 'implant_piece' THEN coalesce(pc.n, 0)
                ELSE g.n
           END AS lines_count,
           CASE WHEN ar.kind = 'ortho_lab_first' THEN coalesce(lp.items, '[]'::jsonb) END AS lab_patients,
           coalesce(sh.base, 0) AS ciro_after,
           lr.total AS lab_total,
           lx.lab_cents
    FROM ar
    CROSS JOIN gross g
    LEFT JOIN rule_sum sh ON sh.rule_id = ar.id
    LEFT JOIN pcs pc ON ar.kind = 'implant_piece' AND pc.doctor_id = ar.doctor_id
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

-- Month payload of fin_hk_month / fin_hk_close_month / fin_hk_reopen_month (0031 body, same signature): compute +
-- month row + can_prepare, ledger_visible, statements, lines, pieces, lab costs and the month's adjustments; a caller
-- without finance / finance_readonly ('hakedis_prepare' only) gets it without ledger data (fin__hk_strip_ledger).
-- v1.4: lab_costs[] + {resolved_segment, rule_id} (fin__hk_eval_lab_costs; null for a voided row or a row without a
-- rule), lab_summary (doctor × lab) and lab_totals (per lab): hakediş data, kept for 'hakedis_prepare' callers.
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
           SELECT jsonb_agg(public.fin__hk_lab_cost_json(p_clinic, c.id)
                            || jsonb_build_object(
                                 'resolved_segment', ec.segment,
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
-- 4. Finance RPCs (0031 bodies, same signatures; CREATE OR REPLACE keeps the ACL).
-- ---------------------------------------------------------------------------

-- Payee rule (finance writers only, 0030 / 0031) + kinds bank_portion and minimum_monthly. Fields by kind:
--   ciro_share         doctor, segment, share_bp, deductions
--   ortho_lab_first    doctor, share_bp, deductions (no segment)
--   implant_piece      doctor, piece_cents (no share, no deductions)
--   clinic_ciro_share  share_bp only (no doctor, no segment, no deductions)
--   fixed_monthly      piece_cents = monthly net salary only; payee any user of the clinic (0031)
--   bank_portion       piece_cents = the fixed monthly amount paid by bank only; payee any user of the clinic (0032)
--   minimum_monthly    piece_cents = the monthly floor only; payee any user of the clinic (0032, v1.4)
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
                       'bank_portion', 'minimum_monthly') THEN
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
  ELSIF p_kind = 'minimum_monthly' THEN
    IF p_doctor_id IS NOT NULL THEN
      RAISE EXCEPTION 'Taban maaş kuralında hekim seçilmez.';
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
  ELSIF p_kind = 'minimum_monthly' THEN
    IF p_share_bp IS NOT NULL THEN
      RAISE EXCEPTION 'Taban maaş kuralında pay oranı girilmez.';
    END IF;
    IF p_piece_cents IS NULL OR p_piece_cents NOT BETWEEN 1 AND 1000000000000 THEN
      RAISE EXCEPTION 'Aylık taban tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
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
  IF p_kind IN ('implant_piece', 'clinic_ciro_share', 'fixed_monthly', 'bank_portion', 'minimum_monthly')
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

  -- Payee: a staff member of the clinic with a doctors row, or the owner; for fixed_monthly, bank_portion and
  -- minimum_monthly any user of the clinic (active when newly chosen, checked below).
  SELECT * INTO v_payee FROM public.users u WHERE u.id = p_payee_user_id AND u.clinic_id = v_clinic;
  IF v_payee.id IS NULL THEN
    RAISE EXCEPTION 'Hakediş alacak kişi bulunamadı.';
  END IF;
  IF p_kind NOT IN ('fixed_monthly', 'bank_portion', 'minimum_monthly') AND v_payee.role::text <> 'owner'
     AND NOT EXISTS (
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

  -- Overlap: fixed_monthly, bank_portion and minimum_monthly per payee (0031 / 0032: every person has a salary /
  -- bank amount / floor of their own), the other kinds per (kind, doctor, segment) whoever the payee is.
  SELECT r.id INTO v_other
  FROM public.fin_hk_rules r
  WHERE r.clinic_id = v_clinic
    AND r.id <> p_id
    AND r.kind = p_kind
    AND (CASE WHEN p_kind IN ('fixed_monthly', 'bank_portion', 'minimum_monthly')
                THEN r.payee_user_id = p_payee_user_id
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
  IF v_other IS NOT NULL AND p_kind = 'minimum_monthly' THEN
    RAISE EXCEPTION 'Bu kişi için bu aylarla çakışan başka bir taban maaş kuralı var. Önce onun bitiş ayını girin.'
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

-- Month close (finance writers, 0031 body, same signature). v1.4: a payee without a doctors row whose components are
-- only fixed_monthly / adjustments / minimum_topup is staff (payroll entry); the staff messages for a cancelled
-- payroll entry and for a 0 total name the taban maaş rule too (a floor keeps the total above 0). LAB_OVER_CIRO,
-- UNRULED_LAB and BANK_OVER_TOTAL do not block the close (only UNRULED_LINES / UNRULED_PIECES without
-- p_accept_unruled, as before).
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
    -- 0031: a payee without a doctors row whose components are only fixed_monthly / adjustments (0032: or
    -- minimum_topup) is staff: one payroll entry in the personnel bucket under the staff counterparty linked to the
    -- user.
    v_staff := v_doctor IS NULL AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(v_p -> 'components') = 'array' THEN v_p -> 'components' ELSE '[]'::jsonb END) k
      WHERE (k ->> 'kind') IS DISTINCT FROM 'fixed_monthly' AND (k ->> 'kind') IS DISTINCT FROM 'adjustments'
        AND (k ->> 'kind') IS DISTINCT FROM 'minimum_topup');
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
          RAISE EXCEPTION '% için bu ayın maaş kaydı zaten var (%), yeni hesaplanan tutar ise 0. Tutar yanlışsa sabit maaş / taban maaş kuralını / prim satırlarını düzeltin. Tutar gerçekten 0 ise kaydı Finans ekranında iptal edin, sonra ayı kapatın. İptal geri alınamaz; bu kişiye aynı ay için yeniden maaş kaydı açılamaz.',
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
          RAISE EXCEPTION '% için bu ayın maaş kaydı iptal edilmiş; iptal geri alınamadığı için aynı ay için yeni maaş kaydı açılamaz. Ayı kapatmak için bu kişinin bu ayki tutarını 0 yapın (sabit maaş / taban maaş kurallarının aylarını düzeltin, prim / diğer satırlarını iptal edin); ödenecek tutarı Finans ekranında ayrı bir personel gideri olarak girin.',
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
-- 5. Self-service (0031 bodies, same signatures; still only the caller's own data). hk_my_month's payee object comes
--    through fin__hk_self_payee, which now keeps bank_cents / cash_cents (and every component but the clinic share
--    whole, so lab_cents / lab_excess_cents / minimum_topup too).
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

-- One month of the caller (0031 body, same signature): own payee object (frozen statement breakdown when closed, live
-- estimate otherwise), the lines counted under the caller's own ciro_share / ortho rules plus the unruled lines of the
-- caller's own doctors row, the pieces of the caller's implant rule doctors, lab costs and the caller's own statement /
-- entry. v1.4: lab_costs also lists the month's costs counted under the caller's own ciro_share rules (the ortho rows
-- to date as before, without the costs deducted from a ciro_share rule in their own month; same keys), and lab_summary
-- the caller's doctor × lab rows of the month. A caller without any rule gets {has_rules: false}.
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
-- 6. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs granted to authenticated, internals (fin__hk_*, incl. the new fin__hk_bank_note, fin__hk_round_div,
--    fin__hk_eval_lab_costs, fin__hk_ciro_lab_ids and fin__hk_lab_alloc, and the replaced fin__hk_ortho_walk and
--    fin__hk_closed_lines) never; plus its self-checks. hk_my_months / hk_my_month keep their
--    0030 ACL (CREATE OR REPLACE); repeated here for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_months() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_months() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hk_my_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_month(date) TO authenticated;

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
    'public.fin__hk_round_div(numeric,numeric)',
    'public.fin__hk_eval_lab_costs(uuid,date)',
    'public.fin__hk_ciro_lab_ids(uuid,date)',
    'public.fin__hk_lab_alloc(uuid,date,jsonb)',
    'public.fin__hk_ortho_walk(uuid,date)',
    'public.fin__hk_closed_lines(uuid,text,uuid)',
    'public.fin__hk_self_payee(jsonb)',
    'public.fin__hk_parts(jsonb,uuid)',
    'public.fin__hk_description(jsonb,date,uuid)',
    'public.fin__hk_payroll_description(jsonb,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin_hk_month(date)',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text)',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.hk_my_months()',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v1.3 / v1.4 fonksiyon imzaları beklenen gibi değil: %', v_bad;
  END IF;

  -- 2. The helpers replaced or added here stay internal (SECURITY INVOKER, not callable from the API); the RPCs keep
  --    SECURITY DEFINER + search_path, callable by authenticated, never by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__hk_bank_note', 'fin__hk_self_payee', 'fin__hk_description', 'fin__hk_payroll_description',
                      'fin__hk_compute', 'fin__hk_round_div', 'fin__hk_eval_lab_costs', 'fin__hk_lab_alloc',
                      'fin__hk_parts', 'fin__hk_month_json', 'fin__hk_ciro_lab_ids', 'fin__hk_ortho_walk',
                      'fin__hk_closed_lines')
    AND (p.prosecdef
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç hakediş fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_hk_save_rule', 'fin_hk_close_month', 'fin_hk_month', 'hk_my_months', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v1.3 / v1.4 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Rule kind constraints with bank_portion and minimum_monthly (one single-column CHECK on kind).
  IF (SELECT count(*)
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'kind'
      WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.contype = 'c' AND c.conkey = ARRAY[a.attnum]) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_check'
                      AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%'
                      AND pg_get_constraintdef(c.oid) LIKE '%bank_portion%'
                      AND pg_get_constraintdef(c.oid) LIKE '%minimum_monthly%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_shape'
                      AND pg_get_constraintdef(c.oid) LIKE '%fixed_monthly%'
                      AND pg_get_constraintdef(c.oid) LIKE '%bank_portion%'
                      AND pg_get_constraintdef(c.oid) LIKE '%minimum_monthly%') THEN
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

  -- 7. v1.4 helpers: exact half-away-from-zero division (also where a numeric division would round a quotient just
  --    below .5 up); an empty clinic has no lab rows, no ciro-deducted costs, no walk and nothing closed.
  IF public.fin__hk_round_div(5, 2) IS DISTINCT FROM 3
     OR public.fin__hk_round_div(4, 2) IS DISTINCT FROM 2
     OR public.fin__hk_round_div(-5, 2) IS DISTINCT FROM -3
     OR public.fin__hk_round_div(5, -2) IS DISTINCT FROM -3
     OR public.fin__hk_round_div(-5, -2) IS DISTINCT FROM 3
     OR public.fin__hk_round_div(1, 3) IS DISTINCT FROM 0
     OR public.fin__hk_round_div(2, 3) IS DISTINCT FROM 1
     OR public.fin__hk_round_div(0, 3) IS DISTINCT FROM 0
     OR public.fin__hk_round_div(7, 0) IS DISTINCT FROM 0
     OR public.fin__hk_round_div(NULL, 3) IS DISTINCT FROM 0
     OR public.fin__hk_round_div(750000000, 40000) IS DISTINCT FROM 18750
     OR public.fin__hk_round_div(1000000000000499999999999999999, 1000000000000000000) IS DISTINCT FROM 1000000000000
     OR public.fin__hk_round_div(1000000000000500000000000000000, 1000000000000000000) IS DISTINCT FROM 1000000000001
     OR EXISTS (SELECT 1 FROM public.fin__hk_eval_lab_costs(gen_random_uuid(), DATE '2024-01-01'))
     OR EXISTS (SELECT 1 FROM public.fin__hk_lab_alloc(gen_random_uuid(), DATE '2024-01-01', '[]'::jsonb))
     OR EXISTS (SELECT 1 FROM public.fin__hk_ciro_lab_ids(gen_random_uuid(), DATE '2024-02-01'))
     OR EXISTS (SELECT 1 FROM public.fin__hk_ortho_walk(gen_random_uuid(), DATE '2024-01-01'))
     OR public.fin__hk_closed_lines(gen_random_uuid(), 'hasta', NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'fin__hk_round_div / laboratuvar yardımcıları beklenen gibi değil.';
  END IF;

  -- 8. v1.4 descriptions: 'taban maaş tamamlaması' for a minimum_topup component (with the bank note after it); a
  --    ciro_share part shows the base after its lab costs. The own payee object keeps lab_cents / lab_excess_cents and
  --    the minimum_topup component as they are.
  IF public.fin__hk_description(
       jsonb_build_object('total_cents', 30000, 'components', jsonb_build_array(
         jsonb_build_object('kind', 'ciro_share', 'doctor_id', v_doc, 'doctor_name', 'D', 'segment', 'child',
                            'share_bp', 2500, 'base_cents', 80000, 'amount_cents', 20000, 'lab_cents', 20000,
                            'lab_excess_cents', 0),
         jsonb_build_object('rule_id', v_doc, 'kind', 'minimum_topup', 'amount_cents', 10000))),
       DATE '2024-03-01', v_doc)
       IS DISTINCT FROM 'DentOS hakediş 2024-03: ciro payı (çocuk) %25 × 800,00 TL = 200,00 TL; taban maaş '
                        || 'tamamlaması 100,00 TL'
     OR public.fin__hk_payroll_description(
          jsonb_build_object('total_cents', 100000, 'bank_cents', 70000, 'cash_cents', 30000, 'components',
            jsonb_build_array(jsonb_build_object('rule_id', v_doc, 'kind', 'minimum_topup', 'amount_cents', 100000))),
          DATE '2024-03-01')
          IS DISTINCT FROM 'DentOS maaş 2024-03: taban maaş tamamlaması 1.000,00 TL · Bankadan 700,00 TL · Elden '
                           || '300,00 TL'
     OR public.fin__hk_self_payee(
          '{"payee_user_id": "u", "payee_name": "n", "total_cents": 5, "bank_cents": null, "cash_cents": null,
            "components": [{"kind": "ciro_share", "rule_id": "r", "base_cents": 0, "amount_cents": 0, "lab_cents": 3,
                            "lab_excess_cents": 2},
                           {"kind": "minimum_topup", "rule_id": "m", "amount_cents": 5}]}'::jsonb)
          IS DISTINCT FROM
          '{"payee_user_id": "u", "payee_name": "n", "total_cents": 5, "bank_cents": null, "cash_cents": null,
            "components": [{"kind": "ciro_share", "rule_id": "r", "base_cents": 0, "amount_cents": 0, "lab_cents": 3,
                            "lab_excess_cents": 2},
                           {"kind": "minimum_topup", "rule_id": "m", "amount_cents": 5}]}'::jsonb THEN
    RAISE EXCEPTION 'Taban maaş / laboratuvar açıklaması veya kendi hakediş nesnesi beklenen gibi değil.';
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
--     note). v1.4, in March (after the January re-close; January / February figures are not touched) with doctors C
--     (ciro_share standard with card / transfer deductions, child and own) and O (ortho_lab_first) and the owner's
--     doctors row without rules: minimum_monthly save / retry / overlap / validation / refused for R; lab costs
--     resolved by patient mark (child by birth date, own, standard fallback of a doctor without a child rule), a voided
--     cost and costs of February / April ignored; C's standard rule in the shape of the owner's example (made-up
--     figures: deductions, then the month's lab costs, then the share), C's child rule floored at 0 with
--     LAB_OVER_CIRO, the owner's costs as UNRULED_LAB, O's walk unchanged; floors below / equal / above the rest and
--     with the bank split; lab cost rows with their rule, lab_summary / lab_totals for R; the March close (top-up and
--     bank notes in the descriptions, a staff payee with only a floor on the payroll path); hk_my_month of A, C, O
--     and Z (own lab rows and summary only). v1.4 review: doctor T moving from ciro_share (May) to ortho_lab_first
--     (June): a cost deducted from May's ciro is not recovered again by the June walk (lab parts, lab_patients,
--     lab_summary, hk_my_month), an April cost without a rule is; the reception's closed-month mark lock counts a lab
--     cost in the closed March of a patient without a line there (hk_save_mark, fin_hk_save_mark, hk_marks_list
--     'locked'), not of another doctor, and the owner may still change the mark. Nothing survives.
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
  v_dc uuid := gen_random_uuid();
  v_dc_auth uuid := gen_random_uuid();
  v_dc_doc uuid := gen_random_uuid();
  v_do uuid := gen_random_uuid();
  v_do_auth uuid := gen_random_uuid();
  v_do_doc uuid := gen_random_uuid();
  v_dt uuid := gen_random_uuid();
  v_dt_auth uuid := gen_random_uuid();
  v_dt_doc uuid := gen_random_uuid();
  v_rule_tc uuid := gen_random_uuid();
  v_rule_to uuid := gen_random_uuid();
  v_mark uuid := gen_random_uuid();
  v_rule_cs uuid := gen_random_uuid();
  v_rule_cc uuid := gen_random_uuid();
  v_rule_co uuid := gen_random_uuid();
  v_rule_o uuid := gen_random_uuid();
  v_rule_am uuid := gen_random_uuid();
  v_rule_zm uuid := gen_random_uuid();
  v_rule_as uuid;
  v_lab_void uuid := gen_random_uuid();
  v_cp_dc uuid;
  v_cp_z uuid;
  v_l jsonb;
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
      (v_x, v_clinic, NULL, 'assistant', 'Öz denetim Eski', 'p32-sc-x-' || v_tag || '@example.invalid', false),
      (v_dc, v_clinic, v_dc_auth, 'doctor', 'Öz denetim Hekim C', 'p32-sc-c-' || v_tag || '@example.invalid', true),
      (v_do, v_clinic, v_do_auth, 'doctor', 'Öz denetim Hekim O', 'p32-sc-o-' || v_tag || '@example.invalid', true),
      (v_dt, v_clinic, v_dt_auth, 'doctor', 'Öz denetim Hekim T', 'p32-sc-t-' || v_tag || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_own_doc, v_clinic, v_own), (v_a_doc, v_clinic, v_a), (v_b_doc, v_clinic, v_b), (v_dc_doc, v_clinic, v_dc),
      (v_do_doc, v_clinic, v_do), (v_dt_doc, v_clinic, v_dt);
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

    -- ---- v1.4 (hakedis_spec_v14.md), March 2024. Owner: rules from March (C: standard 20 % with 8 % card and
    -- transfer deductions, child 40 %, own 50 %; O: ortho_lab_first 40 %), floors (A 420 TL, B 250 TL, S 21.000 TL,
    -- Z 10.000 TL) and two marks ('Hasta Beş' a child by birth date, 'Hasta Altı' C's own patient). Made-up figures.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.fin_hk_save_rule(v_rule_cs, 0, v_dc, v_dc_doc, 'ciro_share', 'standard', 2000, NULL,
                                    0, 800, 800, 0, DATE '2024-03-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_cc, 0, v_dc, v_dc_doc, 'ciro_share', 'child', 4000, NULL,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_co, 0, v_dc, v_dc_doc, 'ciro_share', 'own', 5000, NULL,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_o, 0, v_do, v_do_doc, 'ortho_lab_first', NULL, 4000, NULL,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    v_j := public.fin_hk_save_rule(v_rule_am, 0, v_a, NULL, 'minimum_monthly', NULL, NULL, 42000,
                                   0, 0, 0, 0, DATE '2024-03-15', NULL, '');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,kind}') IS DISTINCT FROM 'minimum_monthly'
       OR (v_j #>> '{record,payee_user_id}') IS DISTINCT FROM v_a::text
       OR (v_j #>> '{record,piece_cents}')::bigint IS DISTINCT FROM 42000
       OR (v_j #>> '{record,from_month}') IS DISTINCT FROM '2024-03-01'
       OR (v_j #> '{record,doctor_id}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #> '{record,share_bp}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #> '{record,segment}') IS DISTINCT FROM 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'taban maaş kuralı: ' || left(v_j::text, 300));
    END IF;
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_b, NULL, 'minimum_monthly', NULL, NULL, 25000,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, NULL, 'minimum_monthly', NULL, NULL, 2100000,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    PERFORM public.fin_hk_save_rule(v_rule_zm, 0, v_z, NULL, 'minimum_monthly', NULL, NULL, 1000000,
                                    0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    v_j := public.fin_hk_save_rule(v_rule_zm, 0, v_z, NULL, 'minimum_monthly', NULL, NULL, 1000000,
                                   0, 0, 0, 0, DATE '2024-03-01', NULL, '');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'taban maaş tekrar deneme: ' || left(v_j::text, 300));
    END IF;
    -- Z's floor and bank amount share months (different kinds); a second floor of Z in them is refused.
    v_state := NULL;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_z, NULL, 'minimum_monthly', NULL, NULL, 100,
                                      0, 0, 0, 0, DATE '2024-06-01', DATE '2024-08-01', '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM 'PT409'
       OR v_err IS DISTINCT FROM 'Bu kişi için bu aylarla çakışan başka bir taban maaş kuralı var. Önce onun bitiş ayını girin.' THEN
      v_fail := array_append(v_fail, 'aynı kişiye çakışan taban maaş: ' || coalesce(v_state, '-') || ' '
                                     || coalesce(v_err, '-'));
    END IF;
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''minimum_monthly'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z, v_b_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''minimum_monthly'', ''standard'', NULL, '
             '100, 0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''minimum_monthly'', NULL, 2500, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''minimum_monthly'', NULL, NULL, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''minimum_monthly'', NULL, NULL, 0, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''minimum_monthly'', NULL, NULL, 100, '
             '0, 0, 100, 0, DATE ''2030-01-01'', NULL, '''')', v_z),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, NULL, ''minimum_monthly'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_x)];
    v_msgs := ARRAY[
      'Taban maaş kuralında hekim seçilmez.',
      'Hasta grubu yalnızca ciro payı kuralında seçilir.',
      'Taban maaş kuralında pay oranı girilmez.',
      'Aylık taban tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.',
      'Aylık taban tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.',
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
        v_fail := array_append(v_fail, 'taban maaş doğrulaması: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Beş', NULL, false, '', DATE '2016-05-01');
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Altı', v_dc_doc, false, '', NULL);
    SELECT r.id INTO v_rule_as
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = v_clinic AND r.kind = 'ciro_share' AND r.doctor_id = v_a_doc AND r.segment = 'standard';

    -- R: no floor rules; the March lines and lab costs (one voided; one in February, one in April).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_z, NULL, 'minimum_monthly', NULL, NULL, 100,
                                      0, 0, 0, 0, DATE '2030-01-01', NULL, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı taban maaş kuralı: ' || coalesce(v_state, '-'));
    END IF;
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-04', v_dc_doc, 'Hasta Üç', NULL, 'card', 'TRY',
                                    60000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-05', v_dc_doc, 'Hasta Üç', NULL, 'transfer',
                                    'TRY', 50000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-06', v_dc_doc, 'Hasta Üç', NULL, 'cash', 'TRY',
                                    130000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-07', v_dc_doc, 'Hasta Beş', NULL, 'cash', 'TRY',
                                    20000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-08', v_dc_doc, 'Hasta Altı', NULL, 'cash',
                                    'TRY', 60000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-09', v_a_doc, 'Hasta İki', NULL, 'cash', 'TRY',
                                    100000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-09', v_b_doc, 'Hasta Bir', NULL, 'cash', 'TRY',
                                    100000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-12', v_do_doc, 'Hasta Yedi', NULL, 'cash',
                                    'TRY', 25000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-01', v_do_doc, 'Hasta Yedi', NULL,
                                        'Lab Bir', 30000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-02', v_do_doc, 'Hasta Yedi', NULL,
                                        'Lab İki', 10000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-04', v_dc_doc, 'Hasta Üç', NULL, 'Lab Bir',
                                        30000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-05', v_dc_doc, 'Hasta Dört', NULL,
                                        'Lab İki', 20000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-06', v_dc_doc, 'Hasta Beş', NULL, 'Lab Bir',
                                        21000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-07', v_dc_doc, 'Hasta Beş', NULL, 'Lab İki',
                                        14000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-08', v_dc_doc, 'Hasta Altı', NULL,
                                        'Lab İki', 10000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-09', v_a_doc, 'Hasta Beş', NULL, 'Lab Bir',
                                        12300, '');
    PERFORM public.fin_hk_save_lab_cost(v_lab_void, 0, DATE '2024-03-10', v_dc_doc, 'Hasta Üç', NULL, 'Lab Bir',
                                        99900, '');
    PERFORM public.fin_hk_void_lab_cost(v_lab_void, 1, 'Yanlış giriş');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-11', v_own_doc, 'Hasta Sekiz', NULL,
                                        'Lab Bir', 45600, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-02-20', v_dc_doc, 'Hasta Üç', NULL, 'Lab Bir',
                                        11100, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-04-05', v_dc_doc, 'Hasta Üç', NULL, 'Lab Bir',
                                        77700, '');

    -- March as R. C standard (the owner's example shape): card 600 − 8 % = 552, transfer 500 − 8 % = 460, cash
    -- 1.300 → 2.312 after deductions; lab 300 + 200 (the voided 999 and the February / April costs not counted) →
    -- 1.812 × 20 % = 362,40. C child: 200 after deductions, lab 210 + 140 = 350 → base 0 (deducted 200, 150 left with
    -- the clinic: LAB_OVER_CIRO). C own: 600 − lab 100 = 500 × 50 % = 250. A: 1.000 − lab 123 ('Hasta Beş' is a child,
    -- A has no child rule: standard) = 877 × 30 % = 263,10, floor 420 → top-up 156,90, bank 350, cash 70. B: 250 =
    -- floor (no top-up). S: salary above the floor. Z: only the floor, bank 9.876, cash 124. O: lab first, 250 paid,
    -- all lab → base 0 (its costs not deducted again). The owner's own cost: UNRULED_LAB.
    v_l := jsonb_build_array(
      jsonb_build_object('doctor_id', v_a_doc, 'doctor_name', 'Öz denetim Hekim A', 'lab_name', 'Lab Bir',
                         'cost_cents', 12300, 'deducted_cents', 12300, 'count', 1),
      jsonb_build_object('doctor_id', v_dc_doc, 'doctor_name', 'Öz denetim Hekim C', 'lab_name', 'Lab Bir',
                         'cost_cents', 51000, 'deducted_cents', 42000, 'count', 2),
      jsonb_build_object('doctor_id', v_dc_doc, 'doctor_name', 'Öz denetim Hekim C', 'lab_name', 'Lab İki',
                         'cost_cents', 44000, 'deducted_cents', 38000, 'count', 3),
      jsonb_build_object('doctor_id', v_do_doc, 'doctor_name', 'Öz denetim Hekim O', 'lab_name', 'Lab Bir',
                         'cost_cents', 30000, 'deducted_cents', 18750, 'count', 1),
      jsonb_build_object('doctor_id', v_do_doc, 'doctor_name', 'Öz denetim Hekim O', 'lab_name', 'Lab İki',
                         'cost_cents', 10000, 'deducted_cents', 6250, 'count', 1),
      jsonb_build_object('doctor_id', v_own_doc, 'doctor_name', 'Öz denetim sahip', 'lab_name', 'Lab Bir',
                         'cost_cents', 45600, 'deducted_cents', 0, 'count', 1));
    v_w := jsonb_build_object('code', 'LAB_OVER_CIRO', 'doctor_id', v_dc_doc, 'doctor_name', 'Öz denetim Hekim C',
                              'rule_id', v_rule_cc, 'segment', 'child', 'lab_cents', 35000,
                              'ciro_after_deductions_cents', 20000, 'excess_cents', 15000);
    v_j := public.fin_hk_month(DATE '2024-03-01');
    IF coalesce((v_j ->> 'ledger_visible')::boolean, true)
       OR (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 545000
       OR jsonb_array_length(v_j -> 'payees') <> 6
       OR position('counterparty_id' IN v_j::text) > 0
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('code', 'UNRULED_LAB', 'doctor_id', v_own_doc, 'doctor_name', 'Öz denetim sahip',
                               'lab_cents', 45600),
            v_w)
       OR (v_j -> 'lab_summary') IS DISTINCT FROM v_l
       OR (v_j -> 'lab_totals') IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('lab_name', 'Lab Bir', 'cost_cents', 138900, 'deducted_cents', 73050, 'count', 5),
            jsonb_build_object('lab_name', 'Lab İki', 'cost_cents', 54000, 'deducted_cents', 44250, 'count', 4))
       OR (SELECT string_agg((c ->> 'patient_name') || '/' || coalesce(c ->> 'resolved_segment', '-') || '/'
                             || CASE (c ->> 'rule_id') WHEN v_rule_cs::text THEN 'cs' WHEN v_rule_cc::text THEN 'cc'
                                                       WHEN v_rule_co::text THEN 'co' WHEN v_rule_o::text THEN 'o'
                                                       WHEN v_rule_as::text THEN 'as'
                                                       ELSE coalesce(c ->> 'rule_id', '-') END,
                             ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'lab_costs') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'Hasta Yedi/standard/o,Hasta Yedi/standard/o,Hasta Üç/standard/cs,Hasta Dört/standard/cs,'
                           || 'Hasta Beş/child/cc,Hasta Beş/child/cc,Hasta Altı/own/co,Hasta Beş/child/as,Hasta Üç/-/-,'
                           || 'Hasta Sekiz/standard/-' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart: ' || left(v_j::text, 1500));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_dc::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 61240
       OR (v_p -> 'bank_cents') IS DISTINCT FROM 'null'::jsonb
       OR (SELECT string_agg(concat_ws(':', c ->> 'segment', c ->> 'base_cents', c ->> 'amount_cents',
                                       c ->> 'lab_cents', c ->> 'lab_excess_cents'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_p -> 'components') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'standard:181200:36240:50000:0,child:0:0:20000:15000,own:50000:25000:10000:0'
       OR (v_p #> '{components,0,by_method}') IS DISTINCT FROM jsonb_build_object(
            'cash', jsonb_build_object('gross', 130000, 'implant', 0, 'lab', 0, 'eligible', 130000, 'deduct_bp', 0,
                                       'deduction', 0),
            'card', jsonb_build_object('gross', 60000, 'implant', 0, 'lab', 0, 'eligible', 60000, 'deduct_bp', 800,
                                       'deduction', 4800),
            'transfer', jsonb_build_object('gross', 50000, 'implant', 0, 'lab', 0, 'eligible', 50000, 'deduct_bp', 800,
                                           'deduction', 4000),
            'financing', jsonb_build_object('gross', 0, 'implant', 0, 'lab', 0, 'eligible', 0, 'deduct_bp', 0,
                                            'deduction', 0)) THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart C: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_a::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 42000
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 35000
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM 7000
       OR jsonb_array_length(v_p -> 'components') <> 2
       OR (v_p #>> '{components,0,kind}') IS DISTINCT FROM 'ciro_share'
       OR (v_p #>> '{components,0,base_cents}')::bigint IS DISTINCT FROM 87700
       OR (v_p #>> '{components,0,amount_cents}')::bigint IS DISTINCT FROM 26310
       OR (v_p #>> '{components,0,lab_cents}')::bigint IS DISTINCT FROM 12300
       OR (v_p #>> '{components,0,lab_excess_cents}')::bigint IS DISTINCT FROM 0
       OR (v_p #> '{components,1}') IS DISTINCT FROM jsonb_build_object('rule_id', v_rule_am, 'kind', 'minimum_topup',
                                                                       'amount_cents', 15690) THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart A: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_b::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 25000
       OR jsonb_array_length(v_p -> 'components') <> 1
       OR (v_p #> '{components,0}') ? 'lab_cents' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart B: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_s::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 2345600
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 1900000
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM 445600
       OR (SELECT string_agg(c ->> 'kind', ',' ORDER BY o)
           FROM jsonb_array_elements(v_p -> 'components') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'fixed_monthly' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart S: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_z::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 1000000
       OR (v_p ->> 'bank_cents')::bigint IS DISTINCT FROM 987600
       OR (v_p ->> 'cash_cents')::bigint IS DISTINCT FROM 12400
       OR (v_p -> 'components') IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('rule_id', v_rule_zm, 'kind', 'minimum_topup', 'amount_cents', 1000000)) THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart Z: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_do::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 0
       OR jsonb_array_length(v_p -> 'components') <> 1
       OR (v_p #>> '{components,0,kind}') IS DISTINCT FROM 'ortho_lab_first'
       OR (v_p #> '{components,0}') ? 'lab_cents'
       OR (v_p #>> '{components,0,by_method,cash,lab}')::bigint IS DISTINCT FROM 25000
       OR (v_p #>> '{components,0,base_cents}')::bigint IS DISTINCT FROM 0
       OR jsonb_array_length(v_p #> '{components,0,lab_patients}') <> 1
       OR (v_p #>> '{components,0,lab_patients,0,lab_total_cents}')::bigint IS DISTINCT FROM 40000
       OR (v_p #>> '{components,0,lab_patients,0,recovered_cents}')::bigint IS DISTINCT FROM 25000
       OR (v_p #>> '{components,0,lab_patients,0,remaining_cents}')::bigint IS DISTINCT FROM 15000 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı mart O: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;

    -- February as R: C's cost there has no rule of that month (UNRULED_LAB, after the v1.3 bank warnings).
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
         jsonb_build_object('code', 'BANK_OVER_TOTAL', 'payee_user_id', v_z, 'payee_name', 'Öz denetim Asistan Z',
                            'bank_cents', 987600, 'total_cents', 0),
         jsonb_build_object('code', 'BANK_OVER_TOTAL', 'payee_user_id', v_a, 'payee_name', 'Öz denetim Hekim A',
                            'bank_cents', 35000, 'total_cents', 0),
         jsonb_build_object('code', 'UNRULED_LAB', 'doctor_id', v_dc_doc, 'doctor_name', 'Öz denetim Hekim C',
                            'lab_cents', 11100))
       OR (v_j -> 'lab_summary') IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('doctor_id', v_dc_doc, 'doctor_name', 'Öz denetim Hekim C', 'lab_name', 'Lab Bir',
                               'cost_cents', 11100, 'deducted_cents', 0, 'count', 1))
       OR (v_j #> '{lab_costs,0,rule_id}') IS DISTINCT FROM 'null'::jsonb
       OR (v_j #>> '{lab_costs,0,resolved_segment}') IS DISTINCT FROM 'standard' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı şubat laboratuvar: ' || left(v_j::text, 900));
    END IF;

    -- The owner: NO_COUNTERPARTY for Z and C ('missing'; none for O, total 0), then the lab warnings. Close: the floor
    -- and bank notes in the descriptions, Z (no doctors row, only a floor) on the payroll path, O (0) without an entry.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-03-01');
    IF (SELECT string_agg(coalesce(w ->> 'payee_name', w ->> 'doctor_name') || ':' || (w ->> 'code'), ','
                          ORDER BY o)
        FROM jsonb_array_elements(v_j -> 'warnings') WITH ORDINALITY AS x(w, o))
       IS DISTINCT FROM 'Öz denetim Asistan Z:NO_COUNTERPARTY,Öz denetim Hekim C:NO_COUNTERPARTY,'
                        || 'Öz denetim sahip:UNRULED_LAB,Öz denetim Hekim C:LAB_OVER_CIRO'
       OR (v_j #> '{warnings,3}') IS DISTINCT FROM v_w
       OR (v_j -> 'lab_summary') IS DISTINCT FROM v_l THEN
      v_fail := array_append(v_fail, 'sahip mart uyarıları: ' || left((v_j -> 'warnings')::text, 900));
    END IF;
    v_j := public.fin_hk_close_month(DATE '2024-03-01', 0, false);
    SELECT cp.id INTO v_cp_dc
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_dc_doc;
    SELECT cp.id INTO v_cp_z FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_z;
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR jsonb_array_length(v_j -> 'statements') <> 6
       OR (v_j -> 'lab_summary') IS DISTINCT FROM v_l
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_z::text AND (st ->> 'total_cents')::bigint = 1000000
                        AND (st #>> '{breakdown,components,0,kind}') = 'minimum_topup'
                        AND (st #>> '{breakdown,cash_cents}')::bigint = 12400)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_do::text AND (st ->> 'total_cents')::bigint = 0
                        AND (st -> 'fin_entry_id') = 'null'::jsonb)
       OR v_cp_dc IS NULL OR v_cp_z IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || v_cp_a::text || ':2024-03' AND e.amount_cents = 42000
                        AND e.description = 'DentOS hakediş 2024-03: ciro payı (standart) %30 × 877,00 TL = 263,10 TL; '
                                            || 'taban maaş tamamlaması 156,90 TL · Bankadan 350,00 TL · Elden 70,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || v_cp_b::text || ':2024-03' AND e.amount_cents = 25000
                        AND e.description = 'DentOS hakediş 2024-03: ciro payı (standart) %25 × 1.000,00 TL = '
                                            || '250,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || v_cp_dc::text || ':2024-03' AND e.amount_cents = 61240
                        AND e.description = 'DentOS hakediş 2024-03: ciro payı (standart) %20 × 1.812,00 TL = '
                                            || '362,40 TL; ciro payı (kendi hastası) %50 × 500,00 TL = 250,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'payroll:' || v_cp_s::text || ':2024-03' AND e.amount_cents = 2345600
                        AND e.description = 'DentOS maaş 2024-03: sabit maaş 23.456,00 TL · Bankadan 19.000,00 TL · '
                                            || 'Elden 4.456,00 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'payroll:' || v_cp_z::text || ':2024-03' AND e.amount_cents = 1000000
                        AND e.description = 'DentOS maaş 2024-03: taban maaş tamamlaması 10.000,00 TL · Bankadan '
                                            || '9.876,00 TL · Elden 124,00 TL')
       OR (SELECT count(*) FROM public.fin_entries e
           WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%')) <> 8
       OR EXISTS (SELECT 1 FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_do_doc)
    THEN
      v_fail := array_append(v_fail, 'mart kapatma: ' || left(v_j::text, 900));
    END IF;

    -- Self-service after the close. A: the floor top-up and the lab-deducted base in the frozen breakdown, the own
    -- lab row and summary only.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-03-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 42000
       OR (v_j #>> '{payees,0,cash_cents}')::bigint IS DISTINCT FROM 7000
       OR (v_j #>> '{payees,0,components,0,lab_cents}')::bigint IS DISTINCT FROM 12300
       OR (v_j #> '{payees,0,components,1}') IS DISTINCT FROM jsonb_build_object(
            'rule_id', v_rule_am, 'kind', 'minimum_topup', 'amount_cents', 15690)
       OR (v_j -> 'lab_summary') IS DISTINCT FROM jsonb_build_array(v_l -> 0)
       OR jsonb_array_length(v_j -> 'lab_costs') <> 1
       OR (v_j #>> '{lab_costs,0,amount_cents}')::bigint IS DISTINCT FROM 12300
       OR (v_j #>> '{lab_costs,0,lab_name}') IS DISTINCT FROM 'Lab Bir'
       OR (v_j #>> '{entitlement,amount_cents}')::bigint IS DISTINCT FROM 42000
       OR position(v_dc_doc::text IN v_j::text) > 0
       OR position(v_do_doc::text IN v_j::text) > 0
       OR position(v_own_doc::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A mart: ' || left(v_j::text, 900));
    END IF;

    -- C: every own lab row of the month (not the voided one, not February / April), the own summary.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dc_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_dc_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-03-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 61240
       OR (SELECT string_agg(concat_ws(':', c ->> 'segment', c ->> 'lab_cents', c ->> 'lab_excess_cents'), ','
                             ORDER BY o)
           FROM jsonb_array_elements(v_j #> '{payees,0,components}') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'standard:50000:0,child:20000:15000,own:10000:0'
       OR (SELECT string_agg(c ->> 'amount_cents', ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'lab_costs') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM '30000,20000,21000,14000,10000'
       OR (v_j -> 'lab_summary') IS DISTINCT FROM jsonb_build_array(v_l -> 1, v_l -> 2)
       OR (v_j #>> '{entitlement,amount_cents}')::bigint IS DISTINCT FROM 61240
       OR position(v_a_doc::text IN v_j::text) > 0
       OR position(v_do_doc::text IN v_j::text) > 0
       OR position(v_own_doc::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim C mart: ' || left(v_j::text, 900));
    END IF;

    -- O: the ortho rows to date as before, the own summary (the lab part recovered this month, by lab).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_do_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_do_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-03-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 0
       OR (v_j #> '{payees,0,components,0}') ? 'lab_cents'
       OR (SELECT string_agg((c ->> 'lab_name') || ':' || (c ->> 'amount_cents'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'lab_costs') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'Lab Bir:30000,Lab İki:10000'
       OR (v_j -> 'lab_summary') IS DISTINCT FROM jsonb_build_array(v_l -> 3, v_l -> 4)
       OR (v_j -> 'entitlement') IS DISTINCT FROM 'null'::jsonb
       OR position(v_dc_doc::text IN v_j::text) > 0
       OR position(v_a_doc::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim O mart: ' || left(v_j::text, 900));
    END IF;

    -- Z: only the floor, paid through the payroll entry.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_z_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_z_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-03-01');
    IF (v_j #> '{payees,0}') IS DISTINCT FROM jsonb_build_object(
         'payee_user_id', v_z, 'payee_name', 'Öz denetim Asistan Z', 'total_cents', 1000000, 'bank_cents', 987600,
         'cash_cents', 12400, 'components', jsonb_build_array(
           jsonb_build_object('rule_id', v_rule_zm, 'kind', 'minimum_topup', 'amount_cents', 1000000)))
       OR (v_j -> 'lab_summary') IS DISTINCT FROM '[]'::jsonb
       OR (v_j -> 'lab_costs') IS DISTINCT FROM '[]'::jsonb
       OR (v_j #>> '{entitlement,amount_cents}')::bigint IS DISTINCT FROM 1000000 THEN
      v_fail := array_append(v_fail, 'asistan Z mart: ' || left(v_j::text, 900));
    END IF;
    v_j := public.hk_my_months();
    IF DATE '2024-03-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'months') m
                       WHERE (m ->> 'month') = '2024-03-01' AND (m ->> 'status') = 'closed'
                         AND (m ->> 'total_cents')::bigint = 1000000 AND (m ->> 'bank_cents')::bigint = 987600
                         AND (m ->> 'cash_cents')::bigint = 12400) THEN
      v_fail := array_append(v_fail, 'asistan Z aylar mart: ' || left(v_j::text, 500));
    END IF;

    -- ---- v1.4 review (1): T moves from ciro_share (May 2024 only, 30 %) to ortho_lab_first (from June, 40 %).
    -- 'Hasta Dokuz' pays in May and June; its May cost is deducted from May's ciro and not recovered again in June.
    -- 'Hasta On Bir' has a May cost (ciro) and a June cost (ortho) and pays in June: only the June cost is recovered.
    -- 'Hasta On' has an April cost (T has no rule in April: unruled) and pays in June: the walk recovers it.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.fin_hk_save_rule(v_rule_tc, 0, v_dt, v_dt_doc, 'ciro_share', 'standard', 3000, NULL,
                                    0, 0, 0, 0, DATE '2024-05-01', DATE '2024-05-01', '');
    PERFORM public.fin_hk_save_rule(v_rule_to, 0, v_dt, v_dt_doc, 'ortho_lab_first', NULL, 4000, NULL,
                                    0, 0, 0, 0, DATE '2024-06-01', NULL, '');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-04-10', v_dt_doc, 'Hasta On', NULL, 'Lab Bir',
                                        10000, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-05-06', v_dt_doc, 'Hasta Dokuz', NULL, 'cash',
                                    'TRY', 100000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-05-07', v_dt_doc, 'Hasta Dokuz', NULL,
                                        'Lab İki', 20000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-05-08', v_dt_doc, 'Hasta On Bir', NULL,
                                        'Lab İki', 6000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-06-03', v_dt_doc, 'Hasta On Bir', NULL,
                                        'Lab Bir', 5000, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-06-10', v_dt_doc, 'Hasta Dokuz', NULL, 'cash',
                                    'TRY', 40000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-06-11', v_dt_doc, 'Hasta On Bir', NULL, 'cash',
                                    'TRY', 50000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-06-12', v_dt_doc, 'Hasta On', NULL, 'cash', 'TRY',
                                    30000, NULL, NULL, NULL, '');

    -- April: T's cost has no rule (UNRULED_LAB). May: 1.000 − lab 200 − 60 = 740 × 30 % = 222.
    v_j := public.fin_hk_month(DATE '2024-04-01');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w
                   WHERE w = jsonb_build_object('code', 'UNRULED_LAB', 'doctor_id', v_dt_doc,
                                                'doctor_name', 'Öz denetim Hekim T', 'lab_cents', 10000)) THEN
      v_fail := array_append(v_fail, 'hekim değişimi nisan T: ' || left((v_j -> 'warnings')::text, 600));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-05-01');
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_dt::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 22200
       OR jsonb_array_length(v_p -> 'components') <> 1
       OR (v_p #>> '{components,0,rule_id}') IS DISTINCT FROM v_rule_tc::text
       OR (v_p #>> '{components,0,base_cents}')::bigint IS DISTINCT FROM 74000
       OR (v_p #>> '{components,0,lab_cents}')::bigint IS DISTINCT FROM 26000
       OR (v_p #>> '{components,0,lab_excess_cents}')::bigint IS DISTINCT FROM 0
       OR (SELECT jsonb_agg(r) FROM jsonb_array_elements(v_j -> 'lab_summary') r
           WHERE (r ->> 'doctor_id') = v_dt_doc::text)
          IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('doctor_id', v_dt_doc, 'doctor_name', 'Öz denetim Hekim T', 'lab_name', 'Lab İki',
                               'cost_cents', 26000, 'deducted_cents', 26000, 'count', 2)) THEN
      v_fail := array_append(v_fail, 'hekim değişimi mayıs T: ' || coalesce(left(v_p::text, 900), '-'));
    END IF;

    -- June (ortho): lab parts 0 (May 'Hasta Dokuz'), 0 (June 'Hasta Dokuz'), 50 ('Hasta On Bir', only its June cost),
    -- 100 ('Hasta On', its April cost); base 1.200 − 150 = 1.050 × 40 % = 420. 'Hasta Dokuz' is not listed to recover;
    -- the June summary shows only Lab Bir (cost 50, deducted 150).
    v_j := public.fin_hk_month(DATE '2024-06-01');
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_dt::text;
    IF v_p IS NULL
       OR (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 42000
       OR jsonb_array_length(v_p -> 'components') <> 1
       OR (v_p #>> '{components,0,rule_id}') IS DISTINCT FROM v_rule_to::text
       OR (v_p #>> '{components,0,by_method,cash,gross}')::bigint IS DISTINCT FROM 120000
       OR (v_p #>> '{components,0,by_method,cash,lab}')::bigint IS DISTINCT FROM 15000
       OR (v_p #>> '{components,0,base_cents}')::bigint IS DISTINCT FROM 105000
       OR (v_p #> '{components,0}') ? 'lab_cents'
       OR (SELECT string_agg(concat_ws(':', lp ->> 'patient_name', lp ->> 'lab_total_cents', lp ->> 'recovered_cents',
                                       lp ->> 'remaining_cents'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_p #> '{components,0,lab_patients}') WITH ORDINALITY AS x(lp, o))
          IS DISTINCT FROM 'Hasta On:10000:10000:0,Hasta On Bir:5000:5000:0'
       OR (SELECT string_agg(w.lab_part_cents::text, ',' ORDER BY w.line_day)
           FROM public.fin__hk_ortho_walk(v_clinic, DATE '2024-06-01') w
           WHERE w.doctor_id = v_dt_doc) IS DISTINCT FROM '0,0,5000,10000'
       OR (SELECT count(*)
           FROM public.fin__hk_ciro_lab_ids(v_clinic, DATE '2024-07-01') x
           JOIN public.fin_hk_lab_costs c ON c.id = x.lab_cost_id
           WHERE c.doctor_id = v_dt_doc) <> 2
       OR (SELECT jsonb_agg(r) FROM jsonb_array_elements(v_j -> 'lab_summary') r
           WHERE (r ->> 'doctor_id') = v_dt_doc::text)
          IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('doctor_id', v_dt_doc, 'doctor_name', 'Öz denetim Hekim T', 'lab_name', 'Lab Bir',
                               'cost_cents', 5000, 'deducted_cents', 15000, 'count', 1)) THEN
      v_fail := array_append(v_fail, 'hekim değişimi haziran T: ' || coalesce(left(v_p::text, 900), '-') || ' / '
                                     || left((v_j -> 'lab_summary')::text, 600));
    END IF;

    -- T's own June: the ortho rows to date without the May costs, the own lines with their lab parts.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dt_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_dt_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-06-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 42000
       OR (SELECT string_agg((c ->> 'day') || ':' || (c ->> 'amount_cents'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'lab_costs') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM '2024-04-10:10000,2024-06-03:5000'
       OR (SELECT string_agg((l ->> 'patient_name') || ':' || (l ->> 'lab_part'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'lines') WITH ORDINALITY AS x(l, o))
          IS DISTINCT FROM 'Hasta Dokuz:0,Hasta On Bir:5000,Hasta On:10000'
       OR (v_j -> 'lab_summary') IS DISTINCT FROM jsonb_build_array(
            jsonb_build_object('doctor_id', v_dt_doc, 'doctor_name', 'Öz denetim Hekim T', 'lab_name', 'Lab Bir',
                               'cost_cents', 5000, 'deducted_cents', 15000, 'count', 1)) THEN
      v_fail := array_append(v_fail, 'hekim T haziran: ' || left(v_j::text, 900));
    END IF;

    -- ---- v1.4 review (2): the reception's closed-month mark lock counts lab costs. 'Hasta Dört' has only a lab cost
    -- (C, ciro_share) in the closed March and no line there. R creates its mark without own doctor / birth date
    -- (nothing moves); the mark is locked for R, who is refused the own doctor C (the cost's doctor), a birth date and
    -- the child flag; another own doctor (no line / cost of that doctor in a closed month) is not locked. The owner
    -- (finance writer) may still change it.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.hk_save_mark(v_mark, 0, NULL, 'Hasta Dört', NULL, NULL);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR NOT coalesce((v_j #>> '{record,locked}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'kapalı ay laboratuvar kilidi işaret: ' || left(v_j::text, 500));
    END IF;
    SELECT m.version INTO v_ver FROM public.fin_hk_patient_marks m WHERE m.clinic_id = v_clinic AND m.id = v_mark;
    v_sqls := ARRAY[
      format('SELECT public.hk_save_mark(%L, %s, NULL, ''Hasta Dört'', %L, NULL)', v_mark, v_ver, v_dc_doc),
      format('SELECT public.hk_save_mark(%L, %s, NULL, ''Hasta Dört'', NULL, DATE ''2016-05-01'')', v_mark, v_ver),
      format('SELECT public.fin_hk_save_mark(%L, %s, NULL, ''Hasta Dört'', NULL, false, '''', DATE ''2016-05-01'')',
             v_mark, v_ver),
      format('SELECT public.fin_hk_save_mark(%L, %s, NULL, ''Hasta Dört'', NULL, true, '''', NULL)', v_mark, v_ver),
      format('SELECT public.fin_hk_save_mark(%L, %s, NULL, ''Hasta Dört'', %L, false, '''', NULL)', v_mark, v_ver,
             v_dc_doc)];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM 'Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.' THEN
        v_fail := array_append(v_fail, 'kapalı ay laboratuvar kilidi: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    v_j := public.fin_hk_save_mark(v_mark, v_ver, NULL, 'Hasta Dört', v_b_doc, false, '', NULL);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,own_doctor_id}') IS DISTINCT FROM v_b_doc::text THEN
      v_fail := array_append(v_fail, 'kapalı ay laboratuvar kilidi başka hekim: ' || left(v_j::text, 500));
    END IF;
    v_j := public.hk_marks_list('Hasta Dört');
    IF jsonb_array_length(v_j) <> 1
       OR (v_j #>> '{0,id}') IS DISTINCT FROM v_mark::text
       OR NOT coalesce((v_j #>> '{0,locked}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'kapalı ay laboratuvar kilidi listesi: ' || left(v_j::text, 500));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    SELECT m.version INTO v_ver FROM public.fin_hk_patient_marks m WHERE m.clinic_id = v_clinic AND m.id = v_mark;
    v_j := public.hk_save_mark(v_mark, v_ver, NULL, 'Hasta Dört', v_dc_doc, DATE '2016-05-01');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,own_doctor_id}') IS DISTINCT FROM v_dc_doc::text
       OR coalesce((v_j #>> '{record,locked}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'kapalı ay laboratuvar kilidi sahip: ' || left(v_j::text, 500));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v1.3 / v1.4): %', array_to_string(v_fail, ' | ');
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
