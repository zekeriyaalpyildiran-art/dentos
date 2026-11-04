-- 0039_hakedis_mgmt_receipts.sql — the management share (clinic_ciro_share) is computed on the month's patient receipts.
--
-- Owner 2026-11-04: "toplam tahsilat olsun". Until now the base of a clinic_ciro_share rule (and the month's
-- clinic_total_cents) was the gross TL amount of every live hakediş line of the month: the Macro treatments of the
-- month by treatment day (unpaid included) plus the orthodontist's payments. It is now the month's patient receipts in
-- Finans, the dashboard figure "Brüt hasta tahsilatı (blokeli dahil)": live payments of a patient_receipts category
-- paid in the month, entries excluded from totals left out (fin__dashboard, 0020). Nothing else changes: the doctors'
-- ciro_share bases, pieces, deductions, lab costs, floors and the netting are computed as before.
--
-- Only fin__hk_compute is replaced (0035 body, same signature, the gross CTE swapped). A closed month keeps its stored
-- statement; open months follow Finans (a receipt booked or excluded later changes the open month's base). Every
-- caller (month view, hk_my_month, close, netting) reads the base through fin__hk_compute, so all agree.
--
-- Self-check: for every clinic, the computed clinic_total_cents of the current and the previous month equals the
-- dashboard receipts figure.

BEGIN;

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
  -- 0039: the management share's base is the month's patient receipts, the Finans figure "Brüt hasta tahsilatı
  -- (blokeli dahil)" (fin__dashboard: live payments of the patient_receipts bucket paid in the month, not excluded from
  -- totals), no longer the gross of the month's hakediş lines. n = the number of those payments.
  gross AS (
    SELECT coalesce(sum(lp.amount_cents), 0)::bigint AS total, count(*)::bigint AS n
    FROM public.fin__live_payments(p_clinic, public.clinic_today()) lp
    WHERE lp.report_bucket = 'patient_receipts'
      AND NOT lp.excluded_from_totals
      AND lp.paid_on >= v_month
      AND lp.paid_on < v_next
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

-- Self-check (rolls the migration back on failure).
DO $chk$
DECLARE
  v record;
  v_m date;
  v_today date := public.clinic_today();
  v_expected bigint;
  v_got bigint;
BEGIN
  FOR v IN SELECT c.id FROM public.clinics c LOOP
    FOREACH v_m IN ARRAY ARRAY[public.fin__month_start(v_today),
                               (public.fin__month_start(v_today) - interval '1 month')::date] LOOP
      SELECT coalesce(sum(lp.amount_cents), 0)::bigint INTO v_expected
      FROM public.fin__live_payments(v.id, v_today) lp
      WHERE NOT lp.excluded_from_totals
        AND lp.report_bucket = 'patient_receipts'
        AND lp.paid_on >= v_m
        AND lp.paid_on < (v_m + interval '1 month')::date;
      v_got := (public.fin__hk_compute(v.id, v_m) ->> 'clinic_total_cents')::bigint;
      IF v_got IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION '0039 self-check: clinic % month %: management base % <> receipts %', v.id, v_m, v_got, v_expected;
      END IF;
    END LOOP;
  END LOOP;
END
$chk$;

COMMIT;
