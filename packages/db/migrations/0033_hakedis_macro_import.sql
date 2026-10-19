-- Hakediş v2: the Macro import (treatments and payments reports of Boğaziçisoft Macro Dental), procedure groups and
-- per-piece rates, and the part of a treatment still unpaid at the end of its month deducted like a card payment.
-- Production-based ciro for every doctor except the orthodontist (payment-based, lab-first as before). Safe to re-run.
--
-- Contract: hakedis_spec_v2_macro.md on top of 0032_hakedis_bank_split.sql (0030, 0031 and 0032 are applied and live;
-- not edited; their bodies are the latest definition of every fin_hk function and are copied here with only the
-- changes below). Requires 0023 (fx_rates), 0030, 0031 and 0032.
--
--  * No names, rates or amounts in this file: Macro doctor mappings, procedure groups, piece rates and the unpaid
--    deduction are rows the owner / the reception enter.
--  * fin_hk_proc_groups (new): a named group of Macro operation names (op_names, stored normalized with
--    fin__normalize_name, each unique across the clinic's groups, enforced by fin_hk_save_proc_group under a per-clinic
--    lock), is_implant, is_active. Saved by fin_hk_save_proc_group ('finance' or 'hakedis_prepare': the owner decided
--    the reception maps the names). Turning is_implant on is refused while a doctor of one of the group's
--    procedure_piece rules has an implant_piece rule in the same months (the implants would be paid twice). Changing a
--    group never rewrites saved lines / pieces; a re-import of the range does.
--  * fin_hk_ext_doctors (new): a Macro doctor name (ext_name = fin__normalize_name, unique; display_name as typed) and
--    its mode: 'doctor' (a DentOS doctor: doctor_id), 'clinic' (the clinic's own revenue: lines without a doctor,
--    counted only in the clinic total, its pieces wait for the performing doctor), 'outside' (an outside doctor: lines
--    without a doctor in the clinic total, no pieces), 'ignore' (rows not imported). fin_hk_save_ext_doctor ('finance'
--    or 'hakedis_prepare'). A mapping change affects later imports only.
--  * fin_hk_import_batches (new): one row per import (client-supplied id = p_batch_id): from_day / to_day, file names,
--    the summary (stats) and replaced_by_batch (set when a later import of a range covering this one replaced it).
--    Only replaced_by_batch changes after the insert (fin_hk_batch_guard).
--  * fin_hk_lines: method 'unpaid' (import only: the part of a treatment not paid by the end of its month); doctor_id
--    NULL only on an imported line with ext_doctor (Macro doctor mapped to 'clinic' / 'outside'; the RPC checks the
--    mapping); new columns ext_doctor, procedure, tooth, treatment_day, proc_group_id, macro_patient_no, macro_basis
--    ('production': day = treatment_day; 'payment': the orthodontist's payment day, treatment_day = the treatment's),
--    all NULL on manual / Burgan lines.
--  * fin_hk_pieces: doctor_id NULL only on an imported piece (Macro doctor mapped to 'clinic': unassigned until the
--    preparer chooses the performing doctor or marks it assigned_none = "Hakediş yok"); new columns batch_id,
--    proc_group_id, ext_doctor, procedure, tooth, macro_patient_no, assigned_none. An imported piece always has a
--    group (rows of operations without a group are not stored); a manual piece has none (a legacy implant piece).
--  * fin_hk_rules: deduct_unpaid_bp (0..10000; ciro_share only, else 0) and kind procedure_piece (payee = the doctor's
--    own user, doctor_id, proc_group_id, piece_cents > 0; no segment / share / deductions; overlap per (kind, doctor,
--    group)). An implant_piece rule and a procedure_piece rule of an is_implant group of the same doctor may not share
--    a month (refused either way); fin_hk_save_rule gets p_deduct_unpaid_bp / p_proc_group_id as two trailing
--    parameters with DEFAULT NULL (the 0032 function is dropped and recreated: callers that send the 15 parameters
--    of 0032 keep working, an omitted unpaid deduction keeps the saved one of a ciro_share rule).
--  * fin_hk_import_macro(p_batch_id, p_from, p_to, p_lines, p_pieces, p_files, p_dry_run DEFAULT false) ('finance'
--    or 'hakedis_prepare'; idempotent on p_batch_id): validates every row (shape, days in [p_from, p_to], p_to <=
--    today, amounts, methods, currencies), refuses a range in a closed month or before a later closed month, refuses
--    unmapped Macro doctors (DETAIL {"unmapped_ext_doctors": [...]}) and currencies without a rate on or before the
--    line's day (DETAIL {"missing_fx": [...]}), checks the basis (payment lines only for a doctor with an active
--    ortho_lab_first rule in the payment's month, production lines never for one; clinic / outside lines production
--    only), maps the operation names to the active groups, converts foreign amounts with fx_rates (latest rate on or
--    before the line's day, manual before workbook; FX warnings when older than 7 days), sets implant_cents = the TL
--    amount for an implant group, sets patient_ref = 'macro:' || patient_no, else the normalized name (see "Patient
--    keys" below for the key a patient already known by name keeps; a payment line without a number reuses the only
--    key of a mark, a live lab cost, a live line / piece of the same normalized name, or of a production line / piece
--    of this import), voids ('Yeniden yüklendi') the live imported lines and pieces whose day is in [p_from, p_to],
--    carries the preparer's assignment of a replaced unassigned clinic piece over to the same new row (same day,
--    Macro doctor, patient file number (else key), operation, tooth; duplicates in order), inserts the new rows and
--    the batch. p_dry_run: the same work in a block that is rolled back, the same summary (the exclusive import lock
--    is held meanwhile, so a dry run briefly holds up piece assignments too).
--  * fin_hk_assign_piece(p_id, p_version, p_doctor_id, p_none) ('finance' or 'hakedis_prepare', open months): the
--    performing doctor of an imported clinic piece (an unassigned or "Hakediş yok" piece, or one whose Macro doctor
--    is mapped to 'clinic'), or "Hakediş yok" (p_none, no doctor), or back to unassigned. The pieces of a Macro
--    doctor mapped to a DentOS doctor are refused (corrected in Macro and re-imported: a re-import would put them back
--    under the mapped doctor). Takes the clinic's import lock shared first, so a running import (which reads the
--    assignments it carries over, then voids the rows) is waited for and never loses a saved assignment.
--  * fin_hk_save_line / fin_hk_save_piece refuse to edit an imported row (the next import of its range would void it;
--    the doctor of a piece is chosen with fin_hk_assign_piece). Voiding stays allowed.
--  * Patient keys. Imported rows are keyed 'macro:' || D. NO, but a patient the clinic already knows under another
--    key keeps it: a payload file number whose 'macro:' key nothing uses yet (no mark, live lab cost, or live line /
--    piece outside the range) takes the only other key its normalized name has there, when that key is the name or
--    the bare file number and the payload has one file number for that name (and one name for that number), so marks
--    and the orthodontist's lab costs entered before the import keep applying. A new key entered by hand (a new mark
--    at the reception or in finance, a new lab cost, manual line or piece, or a changed name / number) goes through
--    fin__hk_resolve_ref: a typed Macro file number becomes the key of the live imported rows with that number, an
--    empty key the only key of the live imported rows of the name (the doctor's rows first), else as before
--    (fin_hk_save_mark, hk_save_mark, fin_hk_save_lab_cost, fin_hk_save_line, fin_hk_save_piece; an unchanged key
--    stays). fin__hk_eval_lines / fin__hk_eval_lab_costs: a row keyed 'macro:N' without a mark of its own key takes
--    the mark keyed 'N', else the mark of its normalized patient name (other keys: the exact mark only, as 0032).
--  * fin__hk_compute (0032 body): a ciro_share / ortho rule's 'unpaid' bucket uses deduct_unpaid_bp and appears in
--    by_method only when the rule has a deduct_unpaid_bp or 'unpaid' lines in the month (0032 keys otherwise);
--    procedure_piece = Σ qty of the month's live pieces of (doctor, group) × piece_cents (component + {proc_group_id,
--    proc_group_name}, after the doctor's implant_piece, by group name); implant_piece counts only pieces of an
--    is_implant group or without a group; UNRULED_PIECES = implant-type pieces covered neither by an implant_piece
--    rule nor by a procedure_piece rule of their group; lines without a doctor count only in the clinic total
--    (clinic_ciro_share) and never in UNRULED_LINES; new warning UNASSIGNED_PIECES (does not block the close). Months
--    without the new data give the 0032 result.
--  * Row shapes: RuleJson + {deduct_unpaid_bp, proc_group_id, proc_group_name}; LineJson + {basis, ext_doctor,
--    procedure, tooth, treatment_day, proc_group_id, proc_group_name, macro_patient_no}; PieceJson + {batch_id,
--    proc_group_id, proc_group_name, proc_group_is_implant, ext_doctor, procedure, tooth, macro_patient_no,
--    assigned_none, is_unassigned}; fin_hk_reference + {proc_groups, ext_doctors, import_batches}; fin__hk_parts
--    'işlem başı <group> <qty> × <piece> = <amount>'; hk_my_month pieces of the caller's procedure_piece rules too
--    (+ {proc_group_name, procedure, tooth} on a grouped piece), imported lines + {procedure, tooth}.
--  * fin_audit_list / fin_export_manifest include the three new tables.
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). The UI shows error.message verbatim; fin_hk_import_macro puts the unmapped names / missing
-- rates as JSON in DETAIL (PostgREST 'details'). Its row errors name the row's position in p_lines / p_pieces
-- ('<n>. satır' / '<n>. işlem') and its day, never the patient (error texts reach the server log); the page shows
-- the patient of that row from its own payload.
--
-- JSON shapes (changes against 0032; months are 'YYYY-MM-01', days 'YYYY-MM-DD'):
--   RuleJson        + {deduct_unpaid_bp, proc_group_id, proc_group_name}; kind 'procedure_piece': segment null,
--                   share_bp null, piece_cents = the amount per piece, deductions 0.
--   LineJson        method 'unpaid'; doctor_id / doctor_name null on a clinic / outside line; + {basis ('production' |
--                   'payment' | null), ext_doctor, procedure, tooth, treatment_day, proc_group_id, proc_group_name,
--                   macro_patient_no} (null on manual lines).
--   PieceJson       doctor_id null on an unassigned or "Hakediş yok" piece; + {batch_id, proc_group_id,
--                   proc_group_name, proc_group_is_implant, ext_doctor, procedure, tooth, macro_patient_no,
--                   assigned_none, is_unassigned}.
--   ProcGroupJson   {id, version, name, is_implant, op_names, is_active, note, created_at, created_by_name, updated_at,
--                   updated_by_name}
--   ExtDoctorJson   {id, version, ext_name (normalized), display_name, mode, doctor_id, doctor_name, created_at,
--                   created_by_name, updated_at, updated_by_name}
--   ImportBatchJson {id, version, from_day, to_day, file_names, lines, pieces, replaced_by_batch, created_at,
--                   created_by_name}
--   Component       by_method + 'unpaid': {gross, implant, lab, eligible, deduct_bp, deduction} (see above);
--                   kind 'procedure_piece': {rule_id, kind, doctor_id, doctor_name, segment: null, share_bp: null,
--                   piece_cents, by_method: null, base_cents: null, amount_cents, qty, lines_count (piece rows),
--                   lab_patients: null, proc_group_id, proc_group_name}.
--   Warning         + {code: 'UNASSIGNED_PIECES', count (Σ qty), groups: [{proc_group_id, name, count}]} (ord 7, last;
--                   one per month). UNRULED_PIECES qty = the uncovered implant-type pieces.
--   fin_hk_reference()  + {proc_groups: [ProcGroupJson] (by name), ext_doctors: [ExtDoctorJson] (by display name),
--                       import_batches: [ImportBatchJson] (last 30, newest first)}.
--   fin_hk_save_proc_group(), fin_hk_save_ext_doctor(), fin_hk_assign_piece()  {already_saved, record}
--   fin_hk_import_macro()  ImportSummary + {already_saved, dry_run}:
--     {batch_id, from, to, files, lines, pieces, try_total_cents, implant_total_cents, skipped_lines (ignored Macro
--      doctors), skipped_pieces (ignored / outside doctors), ungrouped_pieces (rows of operations without a group, not
--      stored), unassigned_pieces (Σ qty of stored pieces without a doctor), carried_assignments, replaced_lines,
--      replaced_pieces, replaced_batches,
--      doctors: [{ext_doctor (display), ext_name, mode, doctor_id, doctor_name, lines, payment_lines, skipped_lines,
--                 gross_cents, gross_by_method: {cash, card, transfer, unpaid}, implant_cents, pieces (stored rows),
--                 pieces_qty, pieces_by_group: [{proc_group_id, name, count (Σ qty)}], unassigned_pieces,
--                 ungrouped_pieces, skipped_pieces}] (every Macro doctor of the payload, by display name),
--      operations: [{name, normalized, proc_group_id, proc_group_name, is_implant, lines, pieces}] (every operation
--                   name of the payload, ignored rows included, by name),
--      fx: [{currency, rate, rate_day, lines, first_day, last_day}],
--      fx_warnings: [{currency, day, rate_day, rate, age_days}] (rate older than 7 days)}.
--     A retry with a saved p_batch_id returns the saved summary with already_saved true (nothing is written).
--   fin_hk_import_macro p_lines[]:  {key?, basis: 'production' | 'payment', day, treatment_day?, ext_doctor,
--                   patient_name, patient_no?, procedure?, tooth?, method: 'cash' | 'card' | 'transfer' | 'unpaid'
--                   ('unpaid' production only), currency: 'TRY' | 'USD' | 'EUR' | 'GBP', amount_cents (integer <> 0)}
--   fin_hk_import_macro p_pieces[]: {key?, day, ext_doctor, patient_name, patient_no?, procedure?, tooth?, qty? (default
--                   1, integer <> 0, -1000..1000)}
--   hk_my_month()   pieces[] + {proc_group_name, procedure, tooth} on a grouped piece; lines[] + {procedure, tooth} on
--                   an imported line.
--
-- RUNBOOK (production is the only database):
--   1. Quiet moment (a few seconds): fin_hk_rules, fin_hk_lines and fin_hk_pieces get new columns and constraints in
--      this transaction, so hakediş writes wait until it commits. SQL editor → New query → paste this file ALONE →
--      Run. One transaction; the self-checks at the end (including a replay in a temporary clinic that is always
--      rolled back) undo everything on any failure.
--   2. Deploy the web build with the Macro import pages afterwards (until step 1 the new calls fail with the RPC error;
--      the existing pages keep working: fin_hk_save_rule still accepts the 0032 parameters).
--   3. Reception / finance: map the Macro doctor names (Macro hekim eşleştirme), create the procedure groups (İşlem
--      grupları), owner: the 'Ödenmemiş (ay sonu)' deduction on the ciro_share rules and the procedure_piece rules.
--   Re-running 0030, 0031 or 0032 later puts back older bodies (and 0032's 15-parameter fin_hk_save_rule next to this
--   file's, which fin__harden_privileges refuses as an overload, so such a re-run fails and rolls back): re-run this
--   file instead, or DROP FUNCTION the 17-parameter fin_hk_save_rule first and re-run this file after it.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Imported data first, as far as the guard allows (fin_hk_guard refuses an update of a row in a closed month or
--       in an open month before a closed one):
--         UPDATE public.fin_hk_lines t SET voided_at = now(), void_reason = 'Geri alındı'
--         WHERE t.source = 'import' AND t.voided_at IS NULL
--           AND NOT EXISTS (SELECT 1 FROM public.fin_hk_months m
--                           WHERE m.clinic_id = t.clinic_id AND m.status = 'closed'
--                             AND m.month >= date_trunc('month', t.day)::date);
--       and the same UPDATE of public.fin_hk_pieces; then DELETE FROM public.fin_hk_rules WHERE kind =
--       'procedure_piece' (fin__trg_no_delete allows row deletes from the SQL editor). Imported rows in closed months,
--       and in open months before a closed one, stay live and frozen with their statements. Lines of method 'unpaid'
--       and rows without a doctor cannot stay under the 0032 constraints: if (d) must restore those, remove such rows
--       with a DELETE from the SQL editor (fin__trg_no_delete allows it; fin_hk_guard does not fire on DELETE).
--   (b) DROP FUNCTION public.fin_hk_save_rule(uuid, integer, uuid, uuid, text, text, integer, bigint, integer, integer,
--       integer, integer, date, date, text, integer, uuid), then re-run the 0032 definitions of fin_hk_save_rule,
--       fin__hk_compute, fin__hk_parts, fin__hk_eval_lab_costs and hk_my_month, the 0031 definitions of
--       fin_hk_reference, fin_hk_save_line, fin_hk_save_piece, fin_hk_save_mark, fin_hk_save_lab_cost, fin_audit_list
--       and fin_export_manifest, and the 0030 definitions of fin__hk_rule_json, fin__hk_line_json,
--       fin__hk_piece_json, fin__hk_eval_lines and hk_save_mark. Then run SELECT public.fin__harden_privileges(); (the
--       dropped and recreated fin_hk_save_rule gets PostgreSQL's default PUBLIC / anon EXECUTE back; CREATE OR
--       REPLACE keeps the ACL of the other functions, hk_my_month and hk_save_mark included).
--   (c) DROP FUNCTION fin_hk_import_macro, fin_hk_save_proc_group, fin_hk_save_ext_doctor, fin_hk_assign_piece and the
--       fin__hk_* helpers new here (fin__hk_iso_day, fin__hk_macro_text, fin__hk_macro_row, fin__hk_fx_rate,
--       fin__hk_resolve_ref, fin__hk_proc_group_json, fin__hk_ext_doctor_json, fin__hk_import_batch_json,
--       fin__trg_hk_batch_guard).
--   (d) Only then drop the new columns / constraints of fin_hk_rules, fin_hk_lines and fin_hk_pieces and the three new
--       tables, and restore the 0032 rule kind constraints and the 0030 method CHECK (or keep them: supersets).
--   Statements and entry descriptions written by closes after this file keep their procedure_piece parts.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0023 / 0030 / 0031 / 0032 live (the functions replaced here have the 0032 / 0031 / 0030 bodies and
--     signatures), expected columns, and the three new tables in the expected shape when a re-run finds them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'grant_staff_permission', 'fin__require_write', 'fin__require_read',
                    'fin_can_read', 'fin__harden_privileges', 'fin__month_start', 'fin__day', 'fin__normalize_name',
                    'fin__reason', 'fin__user_name', 'fin__page', 'fin__trg_touch', 'fin__trg_no_delete',
                    'audit_row_change', 'fin__hk_tl', 'fin__hk_pct', 'fin__hk_doctor_name', 'fin__hk_eval_lines',
                    'fin__hk_ortho_walk', 'fin__hk_rule_json', 'fin__hk_line_json', 'fin__hk_piece_json',
                    'fin__hk_compute', 'fin__hk_parts', 'fin__hk_strip_ledger', 'fin__hk_require_prep_read',
                    'fin__hk_require_prep_write', 'fin__hk_month_json', 'fin__hk_check_open', 'fin__hk_close_lock',
                    'fin__hk_month_lock', 'fin__hk_desc', 'fin__hk_patient_name', 'fin__hk_patient_ref',
                    'fin__hk_lab_names', 'fin__hk_settings_json', 'fin__hk_month_row_json', 'fin__trg_hk_refs',
                    'fin__trg_hk_guard', 'fin__hk_bank_note', 'fin__hk_round_div', 'fin__hk_eval_lab_costs',
                    'fin__hk_ciro_lab_ids', 'fin__hk_lab_alloc', 'fin_hk_reference', 'fin_hk_month',
                    'fin_hk_save_rule', 'fin_hk_save_line', 'fin_hk_save_piece', 'fin_hk_close_month',
                    'fin_audit_list', 'fin_export_manifest', 'hk_my_months', 'hk_my_month', 'fin__hk_segment',
                    'fin__hk_child_age_limit', 'fin__hk_birth_date', 'fin__hk_can_mark', 'fin__hk_mark_locked',
                    'fin__hk_mark_json', 'fin__hk_mark_desk_json', 'fin__hk_lab_cost_json', 'fin_hk_save_mark',
                    'fin_hk_save_lab_cost', 'hk_save_mark']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0030, 0031 ve 0032 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_parts(jsonb,uuid)',
    'public.fin__hk_rule_json(uuid,uuid)',
    'public.fin__hk_line_json(uuid,uuid)',
    'public.fin__hk_piece_json(uuid,uuid)',
    'public.fin__hk_check_open(uuid,date)',
    'public.fin__hk_close_lock(uuid)',
    'public.fin__hk_month_lock(uuid,date)',
    'public.fin_hk_reference()',
    'public.fin_hk_save_line(uuid,integer,date,uuid,text,text,text,text,bigint,bigint,bigint,text,text)',
    'public.fin_hk_save_piece(uuid,integer,date,uuid,text,text,integer,text)',
    'public.fin_audit_list(jsonb,jsonb)',
    'public.fin_export_manifest()',
    'public.hk_my_month(date)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_eval_lab_costs(uuid,date)',
    'public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date)',
    'public.fin_hk_save_lab_cost(uuid,integer,date,uuid,text,text,text,bigint,text)',
    'public.hk_save_mark(uuid,integer,text,text,uuid,date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş fonksiyonları beklenen imzada değil (0032 uygulanmalı): %', v_missing;
  END IF;
  -- fin_hk_save_rule: the 0032 signature, or this file's (re-run).
  IF to_regprocedure('public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,'
                     || 'integer,date,date,text)') IS NULL
     AND to_regprocedure('public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,'
                         || 'integer,integer,date,date,text,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION 'fin_hk_save_rule beklenen imzada değil (0032 uygulanmalı).';
  END IF;

  -- The bodies replaced below are 0032's (on a re-run this file's, which keep these texts).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fin__hk_compute'
                   AND p.prosrc LIKE '%minimum_topup%' AND p.prosrc LIKE '%public.fin__hk_eval_lab_costs(%'
                   AND p.prosrc LIKE '%BANK_OVER_TOTAL%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin__hk_parts'
                      AND p.prosrc LIKE '%taban maaş tamamlaması%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_save_rule'
                      AND p.prosrc LIKE '%Taban maaş kuralında hekim seçilmez.%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'hk_my_month'
                      AND p.prosrc LIKE '%public.fin__hk_lab_alloc(%') THEN
    RAISE EXCEPTION 'fin__hk_compute / fin__hk_parts / fin_hk_save_rule / hk_my_month 0032 sürümünde değil.';
  END IF;
  -- ... these 0031 bodies ...
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fin_hk_reference'
                   AND p.prosrc LIKE '%public.fin__hk_require_prep_read()%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_save_line'
                      AND p.prosrc LIKE '%public.fin__hk_require_prep_write()%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_save_piece'
                      AND p.prosrc LIKE '%public.fin__hk_require_prep_write()%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_audit_list'
                      AND p.prosrc LIKE '%fin_hk_adjustments%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_export_manifest'
                      AND p.prosrc LIKE '%fin_hk_adjustments%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_save_mark'
                      AND p.prosrc LIKE '%public.fin__hk_require_prep_write()%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin_hk_save_lab_cost'
                      AND p.prosrc LIKE '%public.fin__hk_require_prep_write()%') THEN
    RAISE EXCEPTION 'fin_hk_reference / fin_hk_save_line / fin_hk_save_piece / fin_hk_save_mark / fin_hk_save_lab_cost / fin_audit_list / fin_export_manifest 0031 sürümünde değil.';
  END IF;
  -- ... and these 0032 / 0030 bodies (the mark lookups and the reception mark).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fin__hk_eval_lab_costs'
                   AND p.prosrc LIKE '%public.fin__hk_segment(NULL::text%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fin__hk_eval_lines'
                      AND p.prosrc LIKE '%public.fin__hk_ortho_walk(p_clinic, p_month)%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'hk_save_mark'
                      AND p.prosrc LIKE '%public.fin__hk_mark_locked(%') THEN
    RAISE EXCEPTION 'fin__hk_eval_lab_costs / fin__hk_eval_lines / hk_save_mark beklenen sürümde değil.';
  END IF;

  -- 0032 applied: the rule kind constraints know minimum_monthly.
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_check'
         AND pg_get_constraintdef(c.oid) LIKE '%minimum_monthly%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_shape'
         AND pg_get_constraintdef(c.oid) LIKE '%minimum_monthly%') THEN
    RAISE EXCEPTION 'Önce 0032 uygulanmalı (taban maaş kural türü).';
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_rules', 'id'), ('fin_hk_rules', 'clinic_id'), ('fin_hk_rules', 'payee_user_id'),
    ('fin_hk_rules', 'doctor_id'), ('fin_hk_rules', 'kind'), ('fin_hk_rules', 'segment'), ('fin_hk_rules', 'share_bp'),
    ('fin_hk_rules', 'piece_cents'), ('fin_hk_rules', 'deduct_cash_bp'), ('fin_hk_rules', 'deduct_card_bp'),
    ('fin_hk_rules', 'deduct_transfer_bp'), ('fin_hk_rules', 'deduct_financing_bp'), ('fin_hk_rules', 'from_month'),
    ('fin_hk_rules', 'to_month'),
    ('fin_hk_lines', 'id'), ('fin_hk_lines', 'clinic_id'), ('fin_hk_lines', 'source'), ('fin_hk_lines', 'source_key'),
    ('fin_hk_lines', 'batch_id'), ('fin_hk_lines', 'day'), ('fin_hk_lines', 'doctor_id'),
    ('fin_hk_lines', 'patient_ref'), ('fin_hk_lines', 'patient_name'), ('fin_hk_lines', 'method'),
    ('fin_hk_lines', 'currency'), ('fin_hk_lines', 'amount_cents'), ('fin_hk_lines', 'try_cents'),
    ('fin_hk_lines', 'implant_cents'), ('fin_hk_lines', 'voided_at'),
    ('fin_hk_pieces', 'id'), ('fin_hk_pieces', 'clinic_id'), ('fin_hk_pieces', 'source'), ('fin_hk_pieces', 'day'),
    ('fin_hk_pieces', 'doctor_id'), ('fin_hk_pieces', 'patient_ref'), ('fin_hk_pieces', 'patient_name'),
    ('fin_hk_pieces', 'qty'), ('fin_hk_pieces', 'voided_at'),
    ('fin_hk_months', 'month'), ('fin_hk_months', 'status'),
    ('fin_hk_patient_marks', 'patient_ref'), ('fin_hk_patient_marks', 'patient_name'),
    ('fin_hk_lab_costs', 'doctor_id'), ('fin_hk_lab_costs', 'patient_ref'), ('fin_hk_lab_costs', 'patient_name'),
    ('fin_hk_lab_costs', 'voided_at'),
    ('fx_rates', 'clinic_id'), ('fx_rates', 'currency'), ('fx_rates', 'rate'), ('fx_rates', 'rate_on'),
    ('fx_rates', 'source'), ('fx_rates', 'updated_at')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı: %', v_missing;
  END IF;

  -- A re-run finds the new tables of this file: they must have its columns.
  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_proc_groups', 'normalized_name'), ('fin_hk_proc_groups', 'is_implant'), ('fin_hk_proc_groups', 'op_names'),
    ('fin_hk_proc_groups', 'is_active'), ('fin_hk_proc_groups', 'version'),
    ('fin_hk_ext_doctors', 'ext_name'), ('fin_hk_ext_doctors', 'display_name'), ('fin_hk_ext_doctors', 'mode'),
    ('fin_hk_ext_doctors', 'doctor_id'), ('fin_hk_ext_doctors', 'version'),
    ('fin_hk_import_batches', 'from_day'), ('fin_hk_import_batches', 'to_day'),
    ('fin_hk_import_batches', 'file_names'), ('fin_hk_import_batches', 'stats'),
    ('fin_hk_import_batches', 'replaced_by_batch'), ('fin_hk_import_batches', 'version')
  ) AS e(tbl, col)
  WHERE to_regclass('public.' || e.tbl) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut Macro yükleme tabloları beklenen yapıda değil: %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 New tables (same treatment as every fin_hk_* table: clinic_id RESTRICT, UNIQUE (clinic_id, id), client-supplied
--     ids, version bumped by fin_touch, never deleted, RLS SELECT for finance / finance_readonly holders only, no write
--     privileges, audit_row_change). Created before the columns that reference them.
-- ---------------------------------------------------------------------------

-- Procedure groups: Macro operation names (normalized, fin__normalize_name) counted as pieces of the group. One name
-- belongs to at most one group of the clinic (fin_hk_save_proc_group, under a per-clinic lock).
CREATE TABLE IF NOT EXISTS public.fin_hk_proc_groups (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  normalized_name text NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 80),
  is_implant boolean NOT NULL DEFAULT false,
  op_names text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(op_names) <= 500 AND array_position(op_names, NULL) IS NULL),
  is_active boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, normalized_name)
);

-- Macro doctor names and how their rows are imported. ext_name = fin__normalize_name of the name in the reports.
CREATE TABLE IF NOT EXISTS public.fin_hk_ext_doctors (
  id uuid PRIMARY KEY,                      -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  ext_name text NOT NULL CHECK (char_length(ext_name) BETWEEN 1 AND 120),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  mode text NOT NULL CHECK (mode IN ('doctor', 'clinic', 'outside', 'ignore')),
  doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,     -- same clinic: fin_hk_refs
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, ext_name),
  CONSTRAINT fin_hk_ext_doctors_mode_shape CHECK ((mode = 'doctor') = (doctor_id IS NOT NULL))
);

-- One row per Macro import: the range it replaced, the file names and the summary returned to the preparer.
CREATE TABLE IF NOT EXISTS public.fin_hk_import_batches (
  id uuid PRIMARY KEY,                      -- client-supplied (p_batch_id)
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  from_day date NOT NULL CHECK (from_day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  to_day date NOT NULL CHECK (to_day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  file_names text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(file_names) <= 10 AND array_position(file_names, NULL) IS NULL),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
  replaced_by_batch uuid,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT fin_hk_import_batches_range CHECK (to_day >= from_day),
  CONSTRAINT fin_hk_import_batches_replaced FOREIGN KEY (clinic_id, replaced_by_batch)
    REFERENCES public.fin_hk_import_batches (clinic_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_fin_hk_import_batches_created
  ON public.fin_hk_import_batches (clinic_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 1.2 Existing tables: rules (deduct_unpaid_bp, procedure_piece), lines (method 'unpaid', doctor-less import lines,
--     Macro columns), pieces (unassigned import pieces, Macro columns). Every existing row stays valid (the new
--     columns are NULL / 0 / false on them).
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_hk_rules
  ADD COLUMN IF NOT EXISTS deduct_unpaid_bp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proc_group_id uuid;
ALTER TABLE public.fin_hk_rules
  DROP CONSTRAINT IF EXISTS fin_hk_rules_deduct_unpaid_range,
  ADD CONSTRAINT fin_hk_rules_deduct_unpaid_range CHECK (deduct_unpaid_bp BETWEEN 0 AND 10000),
  DROP CONSTRAINT IF EXISTS fin_hk_rules_proc_group_fkey,
  ADD CONSTRAINT fin_hk_rules_proc_group_fkey FOREIGN KEY (clinic_id, proc_group_id)
    REFERENCES public.fin_hk_proc_groups (clinic_id, id) ON DELETE RESTRICT;

-- Rule kind procedure_piece: the kind CHECK (one single-column CHECK on kind, 0032 named it fin_hk_rules_kind_check)
-- and the shape CHECK are recreated; every kind of 0032 keeps its shape plus proc_group_id NULL and (all but
-- ciro_share) deduct_unpaid_bp = 0.
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
             'minimum_monthly', 'procedure_piece')
  ),
  -- Which fields each kind uses; deductions only before a percentage of ciro, the unpaid deduction only on ciro_share.
  ADD CONSTRAINT fin_hk_rules_kind_shape CHECK (
    (kind = 'ciro_share' AND doctor_id IS NOT NULL AND segment IS NOT NULL AND share_bp IS NOT NULL
       AND piece_cents IS NULL AND proc_group_id IS NULL)
    OR (kind = 'ortho_lab_first' AND doctor_id IS NOT NULL AND segment IS NULL AND share_bp IS NOT NULL
       AND piece_cents IS NULL AND proc_group_id IS NULL AND deduct_unpaid_bp = 0)
    OR (kind = 'implant_piece' AND doctor_id IS NOT NULL AND segment IS NULL AND share_bp IS NULL
       AND piece_cents IS NOT NULL AND proc_group_id IS NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0
       AND deduct_unpaid_bp = 0)
    OR (kind = 'procedure_piece' AND doctor_id IS NOT NULL AND segment IS NULL AND share_bp IS NULL
       AND piece_cents IS NOT NULL AND proc_group_id IS NOT NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0
       AND deduct_unpaid_bp = 0)
    OR (kind = 'clinic_ciro_share' AND doctor_id IS NULL AND segment IS NULL AND share_bp IS NOT NULL
       AND piece_cents IS NULL AND proc_group_id IS NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0
       AND deduct_unpaid_bp = 0)
    OR (kind IN ('fixed_monthly', 'bank_portion', 'minimum_monthly') AND doctor_id IS NULL AND segment IS NULL
       AND share_bp IS NULL AND piece_cents IS NOT NULL AND proc_group_id IS NULL
       AND deduct_cash_bp = 0 AND deduct_card_bp = 0 AND deduct_transfer_bp = 0 AND deduct_financing_bp = 0
       AND deduct_unpaid_bp = 0)
  );
CREATE INDEX IF NOT EXISTS idx_fin_hk_rules_proc_group
  ON public.fin_hk_rules (clinic_id, proc_group_id) WHERE proc_group_id IS NOT NULL;

-- Lines: method 'unpaid' (the method CHECK, inline in 0030 and so generated-named, is recreated as
-- fin_hk_lines_method_check), doctor-less import lines, Macro columns.
DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'method'
    WHERE c.conrelid = 'public.fin_hk_lines'::regclass
      AND c.contype = 'c'
      AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.fin_hk_lines DROP CONSTRAINT %I', v_con);
  END LOOP;
END $$;

ALTER TABLE public.fin_hk_lines
  ALTER COLUMN doctor_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS ext_doctor text,
  ADD COLUMN IF NOT EXISTS procedure text,
  ADD COLUMN IF NOT EXISTS tooth text,
  ADD COLUMN IF NOT EXISTS treatment_day date,
  ADD COLUMN IF NOT EXISTS proc_group_id uuid,
  ADD COLUMN IF NOT EXISTS macro_patient_no text,
  ADD COLUMN IF NOT EXISTS macro_basis text;
ALTER TABLE public.fin_hk_lines
  ADD CONSTRAINT fin_hk_lines_method_check CHECK (method IN ('cash', 'card', 'transfer', 'financing', 'unpaid')),
  DROP CONSTRAINT IF EXISTS fin_hk_lines_macro_values,
  ADD CONSTRAINT fin_hk_lines_macro_values CHECK (
    (ext_doctor IS NULL OR char_length(btrim(ext_doctor)) BETWEEN 1 AND 120)
    AND (procedure IS NULL OR char_length(btrim(procedure)) BETWEEN 1 AND 200)
    AND (tooth IS NULL OR char_length(btrim(tooth)) BETWEEN 1 AND 200)
    AND (treatment_day IS NULL OR treatment_day BETWEEN DATE '2000-01-01' AND DATE '2100-12-31')
    AND (macro_patient_no IS NULL OR char_length(btrim(macro_patient_no)) BETWEEN 1 AND 50)
    AND (macro_basis IS NULL OR macro_basis IN ('production', 'payment'))
  ),
  -- Doctor-less lines, 'unpaid' and the Macro columns exist only on imported lines; a production line is dated on its
  -- treatment day.
  DROP CONSTRAINT IF EXISTS fin_hk_lines_import_shape,
  ADD CONSTRAINT fin_hk_lines_import_shape CHECK (
    (doctor_id IS NOT NULL OR (source = 'import' AND ext_doctor IS NOT NULL))
    AND (method <> 'unpaid' OR (source = 'import' AND macro_basis = 'production'))
    AND (source = 'import'
         OR (ext_doctor IS NULL AND procedure IS NULL AND tooth IS NULL AND treatment_day IS NULL
             AND proc_group_id IS NULL AND macro_patient_no IS NULL AND macro_basis IS NULL))
    AND (macro_basis IS DISTINCT FROM 'production' OR treatment_day = day)
  ),
  DROP CONSTRAINT IF EXISTS fin_hk_lines_proc_group_fkey,
  ADD CONSTRAINT fin_hk_lines_proc_group_fkey FOREIGN KEY (clinic_id, proc_group_id)
    REFERENCES public.fin_hk_proc_groups (clinic_id, id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_fin_hk_lines_import_day
  ON public.fin_hk_lines (clinic_id, day) WHERE source = 'import' AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_hk_lines_batch
  ON public.fin_hk_lines (clinic_id, batch_id) WHERE batch_id IS NOT NULL;

-- Pieces: unassigned / "Hakediş yok" import pieces, Macro columns.
ALTER TABLE public.fin_hk_pieces
  ALTER COLUMN doctor_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS proc_group_id uuid,
  ADD COLUMN IF NOT EXISTS ext_doctor text,
  ADD COLUMN IF NOT EXISTS procedure text,
  ADD COLUMN IF NOT EXISTS tooth text,
  ADD COLUMN IF NOT EXISTS macro_patient_no text,
  ADD COLUMN IF NOT EXISTS assigned_none boolean NOT NULL DEFAULT false;
ALTER TABLE public.fin_hk_pieces
  DROP CONSTRAINT IF EXISTS fin_hk_pieces_macro_values,
  ADD CONSTRAINT fin_hk_pieces_macro_values CHECK (
    (ext_doctor IS NULL OR char_length(btrim(ext_doctor)) BETWEEN 1 AND 120)
    AND (procedure IS NULL OR char_length(btrim(procedure)) BETWEEN 1 AND 200)
    AND (tooth IS NULL OR char_length(btrim(tooth)) BETWEEN 1 AND 200)
    AND (macro_patient_no IS NULL OR char_length(btrim(macro_patient_no)) BETWEEN 1 AND 50)
  ),
  -- A piece without a doctor is an imported one (unassigned, or "Hakediş yok" = assigned_none); the Macro columns
  -- exist only on imported pieces.
  DROP CONSTRAINT IF EXISTS fin_hk_pieces_import_shape,
  ADD CONSTRAINT fin_hk_pieces_import_shape CHECK (
    (doctor_id IS NOT NULL OR source = 'import')
    AND (NOT assigned_none OR (source = 'import' AND doctor_id IS NULL))
    AND (source = 'import'
         OR (batch_id IS NULL AND proc_group_id IS NULL AND ext_doctor IS NULL AND procedure IS NULL
             AND tooth IS NULL AND macro_patient_no IS NULL))
  ),
  DROP CONSTRAINT IF EXISTS fin_hk_pieces_proc_group_fkey,
  ADD CONSTRAINT fin_hk_pieces_proc_group_fkey FOREIGN KEY (clinic_id, proc_group_id)
    REFERENCES public.fin_hk_proc_groups (clinic_id, id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_fin_hk_pieces_import_day
  ON public.fin_hk_pieces (clinic_id, day) WHERE source = 'import' AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_hk_pieces_batch
  ON public.fin_hk_pieces (clinic_id, batch_id) WHERE batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1.3 Triggers, RLS and audit of the new tables (as 0030 §1.4 / §1.5). fin_hk_batch_guard: a batch is history, only
--     replaced_by_batch is set later (fin_touch keeps version / updated_*).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin__trg_hk_batch_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['replaced_by_batch', 'version', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['replaced_by_batch', 'version', 'updated_at', 'updated_by'])
     OR (OLD.replaced_by_batch IS NOT NULL AND NEW.replaced_by_batch IS DISTINCT FROM OLD.replaced_by_batch) THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['fin_hk_proc_groups', 'fin_hk_ext_doctors', 'fin_hk_import_batches']
  LOOP
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

DROP TRIGGER IF EXISTS fin_hk_batch_guard ON public.fin_hk_import_batches;
CREATE TRIGGER fin_hk_batch_guard
  BEFORE UPDATE ON public.fin_hk_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_batch_guard();

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (SECURITY INVOKER, never granted; called from the SECURITY DEFINER RPCs). Created before the SQL
--    functions that call them (SQL function bodies are checked at creation).
-- ---------------------------------------------------------------------------

-- A 'YYYY-MM-DD' text as a date from 2000-01-01 to 2100-12-31, else NULL (never raises: no cast of an invalid day).
CREATE OR REPLACE FUNCTION public.fin__hk_iso_day(p text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_y integer;
  v_m integer;
  v_d integer;
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  v_y := substr(p, 1, 4)::integer;
  v_m := substr(p, 6, 2)::integer;
  v_d := substr(p, 9, 2)::integer;
  IF v_y NOT BETWEEN 2000 AND 2100 OR v_m NOT BETWEEN 1 AND 12 OR v_d < 1 THEN
    RETURN NULL;
  END IF;
  IF v_d > extract(day FROM (make_date(v_y, v_m, 1) + interval '1 month' - interval '1 day'))::integer THEN
    RETURN NULL;
  END IF;
  RETURN make_date(v_y, v_m, v_d);
END;
$$;

-- A Macro text cell of the import payload: a JSON string (trimmed, NULL when empty) or a number (as written, without
-- trailing zeros: 1001 → '1001'); anything else NULL.
CREATE OR REPLACE FUNCTION public.fin__hk_macro_text(p jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF jsonb_typeof(p) = 'string' THEN
    RETURN nullif(btrim(p #>> '{}'), '');
  END IF;
  IF jsonb_typeof(p) = 'number' THEN
    RETURN trim_scale((p #>> '{}')::numeric)::text;
  END IF;
  RETURN NULL;
END;
$$;

-- One element of fin_hk_import_macro's p_lines (p_is_line) or p_pieces, validated and normalized; raises with the
-- element's position (p_n, 1-based) and, once known, its day (never the patient's name: error texts reach the server
-- log). Returns
-- {n, key, basis, day, treatment_day, ext_doctor, ext_norm, patient_name, patient_no, procedure, proc_norm, tooth,
--  method, currency, amount_cents, qty} (line-only keys null on a piece, qty 1 on a line).
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
    'qty', v_qty);
END;
$$;

-- The clinic's reference rate of a currency for a day (as pp__fx_lookup, 0023): greatest rate_on <= p_on; same day:
-- manual before workbook, then the later update, then id. No row when none is known.
CREATE OR REPLACE FUNCTION public.fin__hk_fx_rate(p_clinic uuid, p_currency text, p_on date)
RETURNS TABLE (o_rate numeric, o_rate_on date)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT r.rate, r.rate_on
  FROM public.fx_rates r
  WHERE r.clinic_id = p_clinic AND r.currency = p_currency AND r.rate_on <= p_on
  ORDER BY r.rate_on DESC, (r.source = 'manual') DESC, r.updated_at DESC, r.id DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_proc_group_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', g.id,
           'version', g.version,
           'name', g.name,
           'is_implant', g.is_implant,
           'op_names', to_jsonb(g.op_names),
           'is_active', g.is_active,
           'note', g.note,
           'created_at', g.created_at,
           'created_by_name', public.fin__user_name(g.created_by),
           'updated_at', g.updated_at,
           'updated_by_name', public.fin__user_name(g.updated_by))
  FROM public.fin_hk_proc_groups g
  WHERE g.clinic_id = p_clinic AND g.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_ext_doctor_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', d.id,
           'version', d.version,
           'ext_name', d.ext_name,
           'display_name', d.display_name,
           'mode', d.mode,
           'doctor_id', d.doctor_id,
           'doctor_name', public.fin__hk_doctor_name(d.doctor_id),
           'created_at', d.created_at,
           'created_by_name', public.fin__user_name(d.created_by),
           'updated_at', d.updated_at,
           'updated_by_name', public.fin__user_name(d.updated_by))
  FROM public.fin_hk_ext_doctors d
  WHERE d.clinic_id = p_clinic AND d.id = p_id
$$;

-- An import batch for fin_hk_reference (the counts from its summary, not the whole summary).
CREATE OR REPLACE FUNCTION public.fin__hk_import_batch_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', b.id,
           'version', b.version,
           'from_day', b.from_day,
           'to_day', b.to_day,
           'file_names', to_jsonb(b.file_names),
           'lines', b.stats -> 'lines',
           'pieces', b.stats -> 'pieces',
           'replaced_by_batch', b.replaced_by_batch,
           'created_at', b.created_at,
           'created_by_name', public.fin__user_name(b.created_by))
  FROM public.fin_hk_import_batches b
  WHERE b.clinic_id = p_clinic AND b.id = p_id
$$;

-- The patient key of a manual entry (a mark at the reception or in finance, a lab cost, a manual line or piece) when
-- its key is new (a new row, or a changed name / number): fin__hk_patient_ref, except that a patient the Macro import
-- already knows gets the key of its live imported lines / pieces:
--   * a typed key equal to a Macro file number (bare or 'macro:' || number) of live imported rows → their key, when
--     they have exactly one;
--   * no key → the only key the live imported rows of the normalized name have (those of p_doctor when it has any),
--     else the normalized name.
-- Anything else: the typed key, else the normalized name (fin__hk_patient_ref, which also checks the length).
CREATE OR REPLACE FUNCTION public.fin__hk_resolve_ref(p_clinic uuid, p_ref text, p_name text, p_doctor uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_typed text := nullif(btrim(coalesce(p_ref, '')), '');
  v_keys text[];
  v_mine text[];
BEGIN
  IF v_typed IS NOT NULL THEN
    SELECT array_agg(DISTINCT k.ref ORDER BY k.ref)
      INTO v_keys
    FROM (
      SELECT l.patient_ref AS ref
      FROM public.fin_hk_lines l
      WHERE l.clinic_id = p_clinic AND l.source = 'import' AND l.voided_at IS NULL
        AND (l.macro_patient_no = v_typed OR 'macro:' || l.macro_patient_no = v_typed)
      UNION ALL
      SELECT p.patient_ref
      FROM public.fin_hk_pieces p
      WHERE p.clinic_id = p_clinic AND p.source = 'import' AND p.voided_at IS NULL
        AND (p.macro_patient_no = v_typed OR 'macro:' || p.macro_patient_no = v_typed)
    ) k;
    IF cardinality(v_keys) = 1 THEN
      RETURN v_keys[1];
    END IF;
    RETURN public.fin__hk_patient_ref(v_typed, p_name);
  END IF;

  SELECT array_agg(DISTINCT k.ref ORDER BY k.ref) FILTER (WHERE k.doctor_id = p_doctor),
         array_agg(DISTINCT k.ref ORDER BY k.ref)
    INTO v_mine, v_keys
  FROM (
    SELECT l.patient_ref AS ref, l.doctor_id
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = p_clinic AND l.source = 'import' AND l.voided_at IS NULL
      AND public.fin__normalize_name(l.patient_name) = public.fin__normalize_name(p_name)
    UNION ALL
    SELECT p.patient_ref, p.doctor_id
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = p_clinic AND p.source = 'import' AND p.voided_at IS NULL
      AND public.fin__normalize_name(p.patient_name) = public.fin__normalize_name(p_name)
  ) k;
  IF cardinality(v_mine) > 0 THEN
    v_keys := v_mine;
  END IF;
  IF cardinality(v_keys) = 1 THEN
    RETURN v_keys[1];
  END IF;
  RETURN public.fin__hk_patient_ref(NULL, p_name);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Row shapes (0030 bodies, same signatures) + the 0033 columns (see the header). Without the new data the added
--    keys are null / 0 / false.
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
           'deduct_unpaid_bp', r.deduct_unpaid_bp,
           'proc_group_id', r.proc_group_id,
           'proc_group_name', g.name,
           'from_month', r.from_month,
           'to_month', r.to_month,
           'note', r.note,
           'created_at', r.created_at,
           'created_by_name', public.fin__user_name(r.created_by),
           'updated_at', r.updated_at,
           'updated_by_name', public.fin__user_name(r.updated_by))
  FROM public.fin_hk_rules r
  LEFT JOIN public.users pu ON pu.id = r.payee_user_id
  LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = r.clinic_id AND g.id = r.proc_group_id
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
           'basis', l.macro_basis,
           'ext_doctor', l.ext_doctor,
           'procedure', l.procedure,
           'tooth', l.tooth,
           'treatment_day', l.treatment_day,
           'proc_group_id', l.proc_group_id,
           'proc_group_name', g.name,
           'macro_patient_no', l.macro_patient_no,
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
           'batch_id', p.batch_id,
           'proc_group_id', p.proc_group_id,
           'proc_group_name', g.name,
           'proc_group_is_implant', g.is_implant,
           'ext_doctor', p.ext_doctor,
           'procedure', p.procedure,
           'tooth', p.tooth,
           'macro_patient_no', p.macro_patient_no,
           'assigned_none', p.assigned_none,
           'is_unassigned', p.doctor_id IS NULL AND NOT p.assigned_none,
           'is_voided', p.voided_at IS NOT NULL,
           'voided_at', p.voided_at,
           'voided_by_name', public.fin__user_name(p.voided_by),
           'void_reason', p.void_reason,
           'created_at', p.created_at,
           'created_by_name', public.fin__user_name(p.created_by),
           'updated_at', p.updated_at,
           'updated_by_name', public.fin__user_name(p.updated_by))
  FROM public.fin_hk_pieces p
  LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = p.clinic_id AND g.id = p.proc_group_id
  WHERE p.clinic_id = p_clinic AND p.id = p_id
$$;

-- Components of a payee as short Turkish parts for the ledger entry description, '; '-joined (NULL when none), 0032
-- body + 0033: 'işlem başı <group> <qty> × <piece> = <amount>' for a procedure_piece component (the doctor is named
-- only when the rule's doctor is not the payee's own doctors row, as for the other kinds).
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
                 WHEN 'procedure_piece' THEN
                   'işlem başı ' || coalesce(o.c ->> 'proc_group_name', '') || d.doc || ' ' || (o.c ->> 'qty')
                   || ' × ' || public.fin__hk_tl((o.c ->> 'piece_cents')::bigint)
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

-- ---------------------------------------------------------------------------
-- 3.1 Mark lookup of the line and lab cost evaluation (0030 / 0032 bodies, same signatures). Change: a row keyed
--     'macro:N' (a Macro import key) without a mark of its own key takes the mark keyed 'N' (a reception "Hasta no"),
--     else the mark of its normalized patient name (a mark entered by name before the patient's first import), in
--     that order. Rows of any other key take the mark of their key only, as before.
-- ---------------------------------------------------------------------------

-- Every live line of the month with its resolved segment, its rule (NULL = unruled) and its lab part (0030 body)
-- + 0033: the Macro key mark fallback above.
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
           public.fin__hk_segment(l.segment, l.doctor_id, l.day, m.own_doctor_id, m.birth_date, m.is_child,
                                  lim.age_limit) AS seg
    FROM public.fin_hk_lines l
    CROSS JOIN (SELECT public.fin__hk_child_age_limit(p_clinic) AS age_limit) lim
    LEFT JOIN LATERAL (
      -- 0033: the mark of the row's own key; a Macro key ('macro:' || file number) without one takes the mark keyed by
      -- the bare file number, else the mark of the normalized patient name (marks entered before the import).
      SELECT mk.own_doctor_id, mk.birth_date, mk.is_child
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

-- Every live lab cost of the month with its resolved segment and rule (0032 body) + 0033: the Macro key mark fallback
-- above (a lab cost entered after the patient's import carries its Macro key).
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
    LEFT JOIN LATERAL (
      -- 0033: the mark of the row's own key; a Macro key ('macro:' || file number) without one takes the mark keyed by
      -- the bare file number, else the mark of the normalized patient name (marks entered before the import).
      SELECT mk.own_doctor_id, mk.birth_date, mk.is_child
      FROM public.fin_hk_patient_marks mk
      WHERE mk.clinic_id = c.clinic_id
        AND (mk.patient_ref = c.patient_ref
             OR (c.patient_ref LIKE 'macro:%'
                 AND mk.patient_ref IN (substr(c.patient_ref, 7), public.fin__normalize_name(c.patient_name))))
      ORDER BY CASE WHEN mk.patient_ref = c.patient_ref THEN 0
                    WHEN mk.patient_ref = substr(c.patient_ref, 7) THEN 1
                    ELSE 2 END
      LIMIT 1
    ) m ON true
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

-- ---------------------------------------------------------------------------
-- 4. Calculation (0032 body, same signature). Changes: method 'unpaid' with the rule's deduct_unpaid_bp (bucket only
--    for a rule with an unpaid deduction or unpaid lines in the month); kind procedure_piece = Σ qty of the month's
--    live pieces of (doctor, group) × piece_cents (+ proc_group_id / proc_group_name, after the doctor's
--    implant_piece component, by group name); implant_piece counts the implant-type pieces only (no group or an
--    is_implant group); UNRULED_PIECES = implant-type pieces covered neither by an implant_piece rule nor by a
--    procedure_piece rule of their group; a line without a doctor counts only in the clinic total (clinic_ciro_share)
--    and never in UNRULED_LINES; warning UNASSIGNED_PIECES (last). Without unpaid deductions, unpaid lines,
--    procedure groups, procedure_piece rules and doctor-less rows the result is the 0032 one.
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
      -- 0033: the 'unpaid' bucket only for a rule with an unpaid deduction or unpaid lines (else the 0032 keys).
      AND (meth.method <> 'unpaid' OR ar.deduct_unpaid_bp <> 0 OR s.n > 0)
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

-- ---------------------------------------------------------------------------
-- 5.0 Existing RPCs (0030 / 0031 / 0032 bodies; CREATE OR REPLACE keeps the ACL).
-- ---------------------------------------------------------------------------

-- Everything the Hakediş screens need besides the month figures (0031) + 0033: proc_groups, ext_doctors and the last
-- 30 import_batches (counts only); procedure_piece rules sort with the implant rules.
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
                                            WHEN 'implant_piece' THEN 3 WHEN 'procedure_piece' THEN 3 ELSE 4 END,
                                r.from_month DESC, r.id)
      FROM public.fin_hk_rules r
      LEFT JOIN public.users pu ON pu.id = r.payee_user_id
      WHERE r.clinic_id = v_clinic), '[]'::jsonb),
    'months', coalesce((
      SELECT jsonb_agg(public.fin__hk_month_row_json(v_clinic, m.month) ORDER BY m.month DESC)
      FROM public.fin_hk_months m
      WHERE m.clinic_id = v_clinic), '[]'::jsonb),
    'lab_names', public.fin__hk_lab_names(v_clinic),
    'settings', public.fin__hk_settings_json(v_clinic),
    -- 0033: procedure groups (inactive ones too), the Macro doctor mapping and the last imports.
    'proc_groups', coalesce((
      SELECT jsonb_agg(public.fin__hk_proc_group_json(v_clinic, g.id) ORDER BY g.name COLLATE "tr-x-icu", g.id)
      FROM public.fin_hk_proc_groups g
      WHERE g.clinic_id = v_clinic), '[]'::jsonb),
    'ext_doctors', coalesce((
      SELECT jsonb_agg(public.fin__hk_ext_doctor_json(v_clinic, d.id)
                       ORDER BY d.display_name COLLATE "tr-x-icu", d.ext_name)
      FROM public.fin_hk_ext_doctors d
      WHERE d.clinic_id = v_clinic), '[]'::jsonb),
    'import_batches', coalesce((
      SELECT jsonb_agg(public.fin__hk_import_batch_json(v_clinic, b.id) ORDER BY b.created_at DESC, b.id)
      FROM (SELECT x.id, x.created_at
            FROM public.fin_hk_import_batches x
            WHERE x.clinic_id = v_clinic
            ORDER BY x.created_at DESC, x.id
            LIMIT 30) b), '[]'::jsonb));
END;
$$;

-- Payee rule (finance writers only; 0032 body) + 0033: kind procedure_piece and the unpaid deduction. Fields by kind:
--   ciro_share         doctor, segment, share_bp, deductions, deduct_unpaid_bp (0033)
--   ortho_lab_first    doctor, share_bp, deductions (no segment, no unpaid deduction)
--   implant_piece      doctor, piece_cents (no share, no deductions)
--   procedure_piece    doctor (payee = the doctor's own user), proc_group_id, piece_cents (0033)
--   clinic_ciro_share  share_bp only (no doctor, no segment, no deductions)
--   fixed_monthly      piece_cents = monthly net salary only; payee any user of the clinic (0031)
--   bank_portion       piece_cents = the fixed monthly amount paid by bank only; payee any user of the clinic (0032)
--   minimum_monthly    piece_cents = the monthly floor only; payee any user of the clinic (0032)
-- p_deduct_unpaid_bp / p_proc_group_id (0033) are trailing parameters with DEFAULT NULL, so a caller of the 0032
-- signature keeps working: an omitted unpaid deduction keeps the saved one of a ciro_share rule (0 for a new rule or
-- another kind). The 0032 function is dropped first (a new parameter list would be an overload).
-- Overlap: as 0032, procedure_piece per (kind, doctor, group); an implant_piece rule and a procedure_piece rule of an
-- is_implant group of the same doctor may not share a month. Months: any day of the month is accepted and stored as
-- its first day. Under a per-clinic lock.
DROP FUNCTION IF EXISTS public.fin_hk_save_rule(uuid, integer, uuid, uuid, text, text, integer, bigint, integer, integer,
                                                integer, integer, date, date, text);
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
  p_note text,
  p_deduct_unpaid_bp integer DEFAULT NULL,
  p_proc_group_id uuid DEFAULT NULL)
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
  v_unpaid integer;
  v_group public.fin_hk_proc_groups%ROWTYPE;
  v_cross uuid;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_kind IS NULL
     OR p_kind NOT IN ('ciro_share', 'ortho_lab_first', 'implant_piece', 'clinic_ciro_share', 'fixed_monthly',
                       'bank_portion', 'minimum_monthly', 'procedure_piece') THEN
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
  ELSIF p_kind = 'procedure_piece' THEN
    IF p_share_bp IS NOT NULL THEN
      RAISE EXCEPTION 'İşlem başı ücret kuralında pay oranı girilmez.';
    END IF;
    IF p_piece_cents IS NULL OR p_piece_cents NOT BETWEEN 1 AND 1000000000000 THEN
      RAISE EXCEPTION 'İşlem başı tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.';
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
  IF p_kind IN ('implant_piece', 'clinic_ciro_share', 'fixed_monthly', 'bank_portion', 'minimum_monthly',
                'procedure_piece')
     AND (v_cash <> 0 OR v_card <> 0 OR v_transfer <> 0 OR v_financing <> 0) THEN
    RAISE EXCEPTION 'Kesinti oranları yalnızca ciro payı ve ortodonti kurallarında girilir.';
  END IF;
  -- 0033: the 'unpaid' deduction (ciro_share only; NULL = keep the saved one, set below) and the procedure group
  -- (procedure_piece only).
  IF p_deduct_unpaid_bp IS NOT NULL AND p_deduct_unpaid_bp NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Kesinti oranları %%0 ile %%100 arasında olmalı.';
  END IF;
  IF p_kind <> 'ciro_share' AND coalesce(p_deduct_unpaid_bp, 0) <> 0 THEN
    RAISE EXCEPTION 'Ödenmemiş (ay sonu) kesintisi yalnızca ciro payı kuralında girilir.';
  END IF;
  IF p_kind = 'procedure_piece' THEN
    IF p_proc_group_id IS NULL THEN
      RAISE EXCEPTION 'İşlem grubu seçilmeli.';
    END IF;
    SELECT * INTO v_group FROM public.fin_hk_proc_groups g WHERE g.clinic_id = v_clinic AND g.id = p_proc_group_id;
    IF v_group.id IS NULL THEN
      RAISE EXCEPTION 'İşlem grubu bulunamadı.';
    END IF;
  ELSIF p_proc_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'İşlem grubu yalnızca işlem başı ücret kuralında seçilir.';
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
  -- 0033: a procedure_piece rule pays the doctor who performs the pieces.
  IF p_kind = 'procedure_piece' AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic AND d.user_id = p_payee_user_id
  ) THEN
    RAISE EXCEPTION 'İşlem başı ücret kuralında hakediş alan kişi işlemi yapan hekimin kendisi olmalı.';
  END IF;

  -- Serialises rule saves per clinic, so two overlapping rules cannot both pass the check below.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_hk_rules:' || v_clinic::text, 0));

  -- Only rows of the caller's clinic are read or locked (an id of another clinic looks unknown here).
  SELECT * INTO v_row FROM public.fin_hk_rules r WHERE r.clinic_id = v_clinic AND r.id = p_id FOR UPDATE;
  -- 0033: an omitted unpaid deduction keeps the saved one of a ciro_share rule (callers of the 0032 signature), else 0.
  v_unpaid := coalesce(p_deduct_unpaid_bp,
                       CASE WHEN p_kind = 'ciro_share' AND v_row.kind = 'ciro_share' THEN v_row.deduct_unpaid_bp END,
                       0);

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_rule_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.payee_user_id, v_row.doctor_id, v_row.kind, v_row.segment, v_row.share_bp, v_row.piece_cents,
        v_row.deduct_cash_bp, v_row.deduct_card_bp, v_row.deduct_transfer_bp, v_row.deduct_financing_bp,
        v_row.from_month, v_row.to_month, v_row.note, v_row.deduct_unpaid_bp, v_row.proc_group_id)
       IS NOT DISTINCT FROM
       (p_payee_user_id, p_doctor_id, p_kind, p_segment, p_share_bp, p_piece_cents,
        v_cash, v_card, v_transfer, v_financing, v_from, v_to, v_note, v_unpaid, p_proc_group_id) THEN
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
  -- 0033: a newly chosen group must be active; an unchanged one is kept even if deactivated since.
  IF p_kind = 'procedure_piece' AND (v_row.id IS NULL OR v_row.proc_group_id IS DISTINCT FROM p_proc_group_id)
     AND NOT v_group.is_active THEN
    RAISE EXCEPTION 'Pasif işlem grubu seçilemez.';
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
              ELSE r.doctor_id IS NOT DISTINCT FROM p_doctor_id AND r.segment IS NOT DISTINCT FROM p_segment
                   AND r.proc_group_id IS NOT DISTINCT FROM p_proc_group_id END)
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
  IF v_other IS NOT NULL AND p_kind = 'procedure_piece' THEN
    RAISE EXCEPTION 'Bu hekim ve işlem grubu için bu aylarla çakışan başka bir işlem başı ücret kuralı var. Önce onun bitiş ayını girin.'
      USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Aynı tür, hekim ve hasta grubu için bu aylarla çakışan başka bir kural var. Önce onun bitiş ayını girin.'
      USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;
  -- 0033: a doctor's implant pieces are paid by an implant_piece rule or by a procedure_piece rule of an implant
  -- group, never by both in the same month.
  IF p_kind = 'procedure_piece' AND v_group.is_implant THEN
    SELECT r.id INTO v_cross
    FROM public.fin_hk_rules r
    WHERE r.clinic_id = v_clinic
      AND r.kind = 'implant_piece'
      AND r.doctor_id = p_doctor_id
      AND r.from_month <= coalesce(v_to, DATE '9999-12-01')
      AND v_from <= coalesce(r.to_month, DATE '9999-12-01')
    ORDER BY r.from_month, r.id
    LIMIT 1;
    IF v_cross IS NOT NULL THEN
      RAISE EXCEPTION 'Bu hekimin bu aylarla çakışan implant (adet başı) kuralı var; implant grubu için ayrıca işlem başı ücret tanımlanamaz. Önce birinin bitiş ayını girin.'
        USING ERRCODE = 'PT409', DETAIL = v_cross::text;
    END IF;
  ELSIF p_kind = 'implant_piece' THEN
    SELECT r.id INTO v_cross
    FROM public.fin_hk_rules r
    JOIN public.fin_hk_proc_groups g ON g.clinic_id = r.clinic_id AND g.id = r.proc_group_id
    WHERE r.clinic_id = v_clinic
      AND r.kind = 'procedure_piece'
      AND r.doctor_id = p_doctor_id
      AND g.is_implant
      AND r.from_month <= coalesce(v_to, DATE '9999-12-01')
      AND v_from <= coalesce(r.to_month, DATE '9999-12-01')
    ORDER BY r.from_month, r.id
    LIMIT 1;
    IF v_cross IS NOT NULL THEN
      RAISE EXCEPTION 'Bu hekimin bu aylarla çakışan, implant grubu için işlem başı ücret kuralı var; ayrıca implant (adet başı) kuralı tanımlanamaz. Önce birinin bitiş ayını girin.'
        USING ERRCODE = 'PT409', DETAIL = v_cross::text;
    END IF;
  END IF;

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_rules (id, clinic_id, payee_user_id, doctor_id, kind, segment, share_bp, piece_cents,
                                     deduct_cash_bp, deduct_card_bp, deduct_transfer_bp, deduct_financing_bp,
                                     from_month, to_month, note, deduct_unpaid_bp, proc_group_id, created_by,
                                     updated_by)
    VALUES (p_id, v_clinic, p_payee_user_id, p_doctor_id, p_kind, p_segment, p_share_bp, p_piece_cents,
            v_cash, v_card, v_transfer, v_financing, v_from, v_to, v_note, v_unpaid, p_proc_group_id, v_user, v_user)
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
        note = v_note,
        deduct_unpaid_bp = v_unpaid,
        proc_group_id = p_proc_group_id
    WHERE r.clinic_id = v_clinic AND r.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_rule_json(v_clinic, p_id));
END;
$$;

-- Revenue line (0031 body) + 0033: an imported line is refused (voiding stays allowed); a new patient key is
-- resolved against the Macro import (fin__hk_resolve_ref).
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
  -- 0033: a new patient key (a new row, or a changed name / number) is resolved against the Macro import
  -- (fin__hk_resolve_ref: the key of the patient's live imported rows); an unchanged key stays.
  IF v_row.id IS NULL OR v_row.patient_ref IS DISTINCT FROM v_ref THEN
    v_ref := public.fin__hk_resolve_ref(v_clinic, p_patient_ref, v_name, p_doctor_id);
  END IF;

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
    -- 0033: the next import of its range voids an imported line; it is corrected in Macro, not here.
    IF v_row.source = 'import' THEN
      RAISE EXCEPTION 'Macro''dan yüklenen satır burada değiştirilemez. Macro''da düzeltip aralığı yeniden yükleyin ya da satırı iptal edin.';
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

-- Pieces (0031 body) + 0033: an imported piece is refused (its doctor: fin_hk_assign_piece; voiding stays allowed); a
-- new patient key is resolved against the Macro import (fin__hk_resolve_ref).
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
  -- 0033: a new patient key (a new row, or a changed name / number) is resolved against the Macro import
  -- (fin__hk_resolve_ref: the key of the patient's live imported rows); an unchanged key stays.
  IF v_row.id IS NULL OR v_row.patient_ref IS DISTINCT FROM v_ref THEN
    v_ref := public.fin__hk_resolve_ref(v_clinic, p_patient_ref, v_name, p_doctor_id);
  END IF;

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
    -- 0033: an imported piece gets its doctor through fin_hk_assign_piece; the rest is corrected in Macro.
    IF v_row.source = 'import' THEN
      RAISE EXCEPTION 'Macro''dan yüklenen işlem burada değiştirilemez; hekimini "Ata" ile seçin. Başka bir düzeltme için Macro''da düzeltip aralığı yeniden yükleyin ya da işlemi iptal edin.';
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

-- Patient mark, every field (0031 body) + 0033: a new patient key is resolved against the Macro import
-- (fin__hk_resolve_ref), so a mark entered by name or by Macro file number after the patient's import lands on the
-- key of the imported rows.
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
  -- 0033: a new patient key (a new row, or a changed name / number) is resolved against the Macro import
  -- (fin__hk_resolve_ref: the key of the patient's live imported rows); an unchanged key stays.
  IF v_row.id IS NULL OR v_row.patient_ref IS DISTINCT FROM v_ref THEN
    v_ref := public.fin__hk_resolve_ref(v_clinic, p_patient_ref, v_name, NULL);
  END IF;

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

-- Lab cost (0031 body) + 0033: a new patient key is resolved against the Macro import (fin__hk_resolve_ref, the
-- doctor's imported rows first), so the orthodontist's lab-first walk finds the imported payments of the patient.
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
  -- 0033: a new patient key (a new row, or a changed name / number) is resolved against the Macro import
  -- (fin__hk_resolve_ref: the key of the patient's live imported rows); an unchanged key stays.
  IF v_row.id IS NULL OR v_row.patient_ref IS DISTINCT FROM v_ref THEN
    v_ref := public.fin__hk_resolve_ref(v_clinic, p_patient_ref, v_name, p_doctor_id);
  END IF;

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

-- Reception mark (0030 body, Hasta işaretleri) + 0033: a new patient key is resolved against the Macro import
-- (fin__hk_resolve_ref), as fin_hk_save_mark.
CREATE OR REPLACE FUNCTION public.hk_save_mark(
  p_id uuid,
  p_version integer,
  p_patient_ref text,
  p_patient_name text,
  p_own_doctor_id uuid,
  p_birth_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
  v_user uuid := public.current_app_user_id();
  v_finance boolean := public.has_permission('finance');
  v_month date := public.fin__month_start(public.clinic_today());
  v_row public.fin_hk_patient_marks%ROWTYPE;
  v_name text;
  v_ref text;
  v_birth date;
  v_other uuid;
  v_locked boolean;
  v_n integer;
BEGIN
  IF v_clinic IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.fin__hk_can_mark() THEN
    RAISE EXCEPTION 'Hasta işaretlerini değiştirme yetkiniz yok.' USING ERRCODE = '42501';
  END IF;
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

  SELECT * INTO v_row FROM public.fin_hk_patient_marks m WHERE m.clinic_id = v_clinic AND m.id = p_id FOR UPDATE;
  -- 0033: a new patient key (a new row, or a changed name / number) is resolved against the Macro import
  -- (fin__hk_resolve_ref: the key of the patient's live imported rows); an unchanged key stays.
  IF v_row.id IS NULL OR v_row.patient_ref IS DISTINCT FROM v_ref THEN
    v_ref := public.fin__hk_resolve_ref(v_clinic, p_patient_ref, v_name, NULL);
  END IF;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true,
                              'record', public.fin__hk_mark_desk_json(v_clinic, p_id, v_finance));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.patient_ref, v_row.patient_name, v_row.own_doctor_id, v_row.birth_date)
       IS NOT DISTINCT FROM (v_ref, v_name, p_own_doctor_id, v_birth) THEN
      RETURN jsonb_build_object('already_saved', true,
                                'record', public.fin__hk_mark_desk_json(v_clinic, p_id, v_finance));
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

  IF NOT v_finance THEN
    -- A newly chosen own doctor must be one of hk_marks_access().doctors; an unchanged one on the same patient key is
    -- kept even if the rule ended since; a changed key is a new choice for the patient it arrives at. Another doctor
    -- would move that doctor's lines of the patient out of their child segment.
    IF p_own_doctor_id IS NOT NULL
       AND (p_own_doctor_id IS DISTINCT FROM v_row.own_doctor_id OR v_row.patient_ref IS DISTINCT FROM v_ref)
       AND NOT EXISTS (
      SELECT 1
      FROM public.fin_hk_rules r
      WHERE r.clinic_id = v_clinic
        AND r.kind = 'ciro_share'
        AND r.segment = 'own'
        AND r.doctor_id = p_own_doctor_id
        AND r.from_month <= v_month
        AND (r.to_month IS NULL OR r.to_month >= v_month)
    ) THEN
      RAISE EXCEPTION 'Bu hekim için bu ay "hekimin kendi hastası" kuralı yok; seçilemez.';
    END IF;

    PERFORM pg_advisory_xact_lock_shared(public.fin__hk_close_lock(v_clinic));
    IF v_row.id IS NOT NULL AND v_row.patient_ref IS DISTINCT FROM v_ref THEN
      -- A changed patient key: the mark leaves the old key and arrives at the new one (its child flag goes with it).
      v_locked := public.fin__hk_mark_locked(v_clinic, v_row.patient_ref, v_row.own_doctor_id, NULL,
                                             v_row.birth_date, NULL, v_row.is_child, false)
                  OR public.fin__hk_mark_locked(v_clinic, v_ref, NULL, p_own_doctor_id,
                                                NULL, v_birth, false, v_row.is_child);
    ELSE
      v_locked := public.fin__hk_mark_locked(v_clinic, v_ref, v_row.own_doctor_id, p_own_doctor_id,
                                             v_row.birth_date, v_birth, v_row.is_child, v_row.is_child);
    END IF;
    IF v_locked THEN
      RAISE EXCEPTION 'Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.';
    END IF;
  END IF;

  IF p_version = 0 THEN
    BEGIN
      INSERT INTO public.fin_hk_patient_marks (id, clinic_id, patient_ref, patient_name, own_doctor_id, birth_date,
                                               created_by, updated_by)
      VALUES (p_id, v_clinic, v_ref, v_name, p_own_doctor_id, v_birth, v_user, v_user)
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu hasta için zaten bir işaret kaydı var.' USING ERRCODE = 'PT409';
    END;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_patient_marks m WHERE m.id = p_id AND m.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true,
                                  'record', public.fin__hk_mark_desk_json(v_clinic, p_id, v_finance));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    BEGIN
      UPDATE public.fin_hk_patient_marks m
      SET patient_ref = v_ref,
          patient_name = v_name,
          own_doctor_id = p_own_doctor_id,
          birth_date = v_birth
      WHERE m.clinic_id = v_clinic AND m.id = p_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu hasta için zaten bir işaret kaydı var.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN jsonb_build_object('already_saved', false,
                            'record', public.fin__hk_mark_desk_json(v_clinic, p_id, v_finance));
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. New RPCs (SECURITY DEFINER, search_path = public, granted to authenticated by fin__harden_privileges). Every one
--    starts with fin__hk_require_prep_write(): 'finance' or 'hakedis_prepare' (the owner decided the reception maps
--    the Macro names and uploads the reports); the caller's clinic only.
-- ---------------------------------------------------------------------------

-- Procedure group: name (1..80, unique normalized), is_implant, Macro operation names (each 1..200, stored
-- normalized, de-duplicated and sorted; at most 500; none in another group of the clinic), is_active, note. Under a
-- per-clinic lock. Turning is_implant on is refused while a doctor of one of the group's procedure_piece rules has an
-- implant_piece rule in the same months.
CREATE OR REPLACE FUNCTION public.fin_hk_save_proc_group(
  p_id uuid,
  p_version integer,
  p_name text,
  p_is_implant boolean,
  p_op_names text[],
  p_is_active boolean,
  p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_proc_groups%ROWTYPE;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_norm text;
  v_implant boolean := coalesce(p_is_implant, false);
  v_active boolean := coalesce(p_is_active, true);
  v_ops text[];
  v_note text;
  v_bad text;
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Grup adı boş olamaz ve en fazla 80 karakter olabilir.';
  END IF;
  v_norm := public.fin__normalize_name(v_name);
  IF cardinality(coalesce(p_op_names, '{}'::text[])) > 500 THEN
    RAISE EXCEPTION 'Bir grupta en fazla 500 işlem adı olabilir.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_op_names, '{}'::text[])) AS o(x)
             WHERE o.x IS NULL OR char_length(btrim(o.x)) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'İşlem adları boş olamaz ve en fazla 200 karakter olabilir.';
  END IF;
  SELECT coalesce(array_agg(DISTINCT public.fin__normalize_name(o.x) COLLATE "C"
                            ORDER BY public.fin__normalize_name(o.x) COLLATE "C"), '{}'::text[])
    INTO v_ops
  FROM unnest(coalesce(p_op_names, '{}'::text[])) AS o(x);
  IF char_length(btrim(coalesce(p_note, ''))) > 500 THEN
    RAISE EXCEPTION 'Not en fazla 500 karakter olabilir.';
  END IF;
  v_note := btrim(coalesce(p_note, ''));

  -- Serialises group saves per clinic, so two groups cannot take the same operation name.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_hk_proc_groups:' || v_clinic::text, 0));

  SELECT * INTO v_row FROM public.fin_hk_proc_groups g WHERE g.clinic_id = v_clinic AND g.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_proc_group_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.name, v_row.is_implant, v_row.op_names, v_row.is_active, v_row.note)
       IS NOT DISTINCT FROM (v_name, v_implant, v_ops, v_active, v_note) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_proc_group_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  SELECT g.id INTO v_other
  FROM public.fin_hk_proc_groups g
  WHERE g.clinic_id = v_clinic AND g.normalized_name = v_norm AND g.id <> p_id;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu adla başka bir işlem grubu var.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  SELECT string_agg(format('"%s" (%s)', o.op, g.name), ', ' ORDER BY o.op COLLATE "C", g.name COLLATE "C")
    INTO v_bad
  FROM public.fin_hk_proc_groups g
  CROSS JOIN LATERAL unnest(g.op_names) AS o(op)
  WHERE g.clinic_id = v_clinic AND g.id <> p_id AND o.op = ANY (v_ops);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Bu işlem adları başka bir grupta: %. Önce o gruptan çıkarın.', v_bad USING ERRCODE = 'PT409';
  END IF;

  -- A procedure_piece rule of this group next to an implant_piece rule of the same doctor in the same months would pay
  -- the group's pieces twice once the group counts as implant.
  IF v_implant AND NOT coalesce(v_row.is_implant, false) THEN
    SELECT string_agg(DISTINCT public.fin__hk_doctor_name(r.doctor_id), ', '
                      ORDER BY public.fin__hk_doctor_name(r.doctor_id))
      INTO v_bad
    FROM public.fin_hk_rules r
    JOIN public.fin_hk_rules i
      ON i.clinic_id = r.clinic_id AND i.kind = 'implant_piece' AND i.doctor_id = r.doctor_id
     AND i.from_month <= coalesce(r.to_month, DATE '9999-12-01')
     AND r.from_month <= coalesce(i.to_month, DATE '9999-12-01')
    WHERE r.clinic_id = v_clinic AND r.kind = 'procedure_piece' AND r.proc_group_id = p_id;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Bu grubun işlem başı ücret kuralı olan ve aynı aylarda implant (adet başı) kuralı da olan hekim var: %. Grup implant sayılırsa implantlar iki kez ödenir; önce kurallardan birinin bitiş ayını girin.',
        v_bad USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_proc_groups (id, clinic_id, name, normalized_name, is_implant, op_names, is_active, note,
                                           created_by, updated_by)
    VALUES (p_id, v_clinic, v_name, v_norm, v_implant, v_ops, v_active, v_note, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_proc_groups g WHERE g.id = p_id AND g.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_proc_group_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_proc_groups g
    SET name = v_name,
        normalized_name = v_norm,
        is_implant = v_implant,
        op_names = v_ops,
        is_active = v_active,
        note = v_note
    WHERE g.clinic_id = v_clinic AND g.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_proc_group_json(v_clinic, p_id));
END;
$$;

-- Macro doctor mapping: the name as in the reports (unique after fin__normalize_name) → 'doctor' (a DentOS doctor of
-- the clinic), 'clinic', 'outside' or 'ignore'. A change affects later imports only.
CREATE OR REPLACE FUNCTION public.fin_hk_save_ext_doctor(
  p_id uuid,
  p_version integer,
  p_ext_name text,
  p_mode text,
  p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_hk_ext_doctors%ROWTYPE;
  v_display text := regexp_replace(btrim(coalesce(p_ext_name, '')), '\s+', ' ', 'g');
  v_name text;
  v_other uuid;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF char_length(v_display) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Macro hekim adı boş olamaz ve en fazla 120 karakter olabilir.';
  END IF;
  v_name := public.fin__normalize_name(v_display);
  IF p_mode IS NULL OR p_mode NOT IN ('doctor', 'clinic', 'outside', 'ignore') THEN
    RAISE EXCEPTION 'Geçersiz eşleştirme türü.';
  END IF;
  IF p_mode = 'doctor' THEN
    IF p_doctor_id IS NULL THEN
      RAISE EXCEPTION 'DentOS hekimi seçilmeli.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic) THEN
      RAISE EXCEPTION 'Hekim bulunamadı.';
    END IF;
  ELSIF p_doctor_id IS NOT NULL THEN
    RAISE EXCEPTION 'Hekim yalnızca "DentOS hekimi" eşleştirmesinde seçilir.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('fin_hk_ext_doctors:' || v_clinic::text, 0));

  SELECT * INTO v_row FROM public.fin_hk_ext_doctors d WHERE d.clinic_id = v_clinic AND d.id = p_id FOR UPDATE;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_ext_doctor_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.display_name, v_row.mode, v_row.doctor_id) IS NOT DISTINCT FROM (v_display, p_mode, p_doctor_id) THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_ext_doctor_json(v_clinic, p_id));
    END IF;
    IF p_version IS DISTINCT FROM v_row.version THEN
      RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  SELECT d.id INTO v_other
  FROM public.fin_hk_ext_doctors d
  WHERE d.clinic_id = v_clinic AND d.ext_name = v_name AND d.id <> p_id;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Bu Macro hekim adı zaten eşleştirilmiş.' USING ERRCODE = 'PT409', DETAIL = v_other::text;
  END IF;

  IF p_version = 0 THEN
    INSERT INTO public.fin_hk_ext_doctors (id, clinic_id, ext_name, display_name, mode, doctor_id, created_by,
                                           updated_by)
    VALUES (p_id, v_clinic, v_name, v_display, p_mode, p_doctor_id, v_user, v_user)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_hk_ext_doctors d WHERE d.id = p_id AND d.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_ext_doctor_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    UPDATE public.fin_hk_ext_doctors d
    SET ext_name = v_name,
        display_name = v_display,
        mode = p_mode,
        doctor_id = p_doctor_id
    WHERE d.clinic_id = v_clinic AND d.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_ext_doctor_json(v_clinic, p_id));
END;
$$;

-- Doctor of an imported clinic piece: the performing doctor (p_doctor_id), "Hakediş yok" (p_none, no doctor: counted
-- for nobody, no warning) or neither (back to unassigned). Live imported pieces of open months only, and only clinic
-- pieces: an unassigned or "Hakediş yok" piece, or one whose Macro doctor is (still) mapped to 'clinic'. A piece of a
-- Macro doctor mapped to a DentOS doctor is corrected in Macro and re-imported (a re-import puts it back under the
-- mapped doctor; the assignments of clinic pieces are carried over). Waits for a running import of the clinic.
CREATE OR REPLACE FUNCTION public.fin_hk_assign_piece(
  p_id uuid,
  p_version integer,
  p_doctor_id uuid,
  p_none boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__hk_require_prep_write();
  v_row public.fin_hk_pieces%ROWTYPE;
  v_none boolean := coalesce(p_none, false);
BEGIN
  -- A running Macro import of the clinic is waited for (it voids and re-inserts import pieces and carries the
  -- assignments it read); an import waits for this assignment, so it is never lost.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('fin_hk_import:' || v_clinic::text, 0));

  SELECT * INTO v_row FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'İptal edilmiş kayıt değiştirilemez.';
  END IF;
  IF v_row.source <> 'import' THEN
    RAISE EXCEPTION 'Yalnızca Macro''dan yüklenen işlemlere hekim atanır.';
  END IF;
  -- Clinic pieces only (the re-import carries only their assignments; other Macro doctors' pieces come back under
  -- their mapped doctor).
  IF v_row.doctor_id IS NOT NULL AND NOT v_row.assigned_none AND NOT EXISTS (
    SELECT 1 FROM public.fin_hk_ext_doctors d
    WHERE d.clinic_id = v_clinic AND d.ext_name = public.fin__normalize_name(v_row.ext_doctor) AND d.mode = 'clinic')
  THEN
    RAISE EXCEPTION 'Yalnızca Macro''da klinik adına gelen işlemlere hekim atanır; diğerleri Macro''da düzeltilip yeniden yüklenir.';
  END IF;
  IF v_none AND p_doctor_id IS NOT NULL THEN
    RAISE EXCEPTION 'Hekim seçildiğinde "Hakediş yok" seçilemez.';
  END IF;
  IF p_doctor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  IF (v_row.doctor_id, v_row.assigned_none) IS NOT DISTINCT FROM (p_doctor_id, v_none) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_piece_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public.fin__hk_check_open(v_clinic, v_row.day);

  UPDATE public.fin_hk_pieces p
  SET doctor_id = p_doctor_id,
      assigned_none = v_none
  WHERE p.clinic_id = v_clinic AND p.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_piece_json(v_clinic, p_id));
END;
$$;

-- Macro import of a day range (see the header for the payload, the checks and the summary). Order: arguments, the
-- clinic's import lock (exclusive; fin_hk_assign_piece takes it shared, so an assignment saved while this runs is
-- waited for and an assignment never commits between the carry-over read and the void below) then its close lock and
-- the range's month locks (shared, as a line write), the saved batch (retry), closed months, rows, Macro doctor
-- mapping, basis against the ortho rules, rates, the patient keys already known by name, the final rows and the
-- summary; then, in a block that p_dry_run rolls back, the replaced rows voided, the new rows and the batch inserted
-- and the batches whose range lies inside this one marked replaced.
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
           x.proc_norm, x.tooth, x.method, x.currency, x.amount_cents, d.mode, d.doctor_id,
           public.fin__normalize_name(x.patient_name) AS nn,
           CASE WHEN x.patient_no IS NOT NULL
                THEN coalesce(v_bridge ->> ('macro:' || x.patient_no), 'macro:' || x.patient_no)
                ELSE public.fin__normalize_name(x.patient_name) END AS base_ref
    FROM jsonb_to_recordset(v_l) AS x(n integer, basis text, day date, treatment_day date, ext_doctor text,
                                      ext_norm text, patient_name text, patient_no text, procedure text,
                                      proc_norm text, tooth text, method text, currency text, amount_cents bigint)
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

  -- Final pieces: every row with its mapping and group; stored = a DentOS doctor's or the clinic's row of a grouped
  -- operation (the clinic's without a doctor: unassigned).
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
           'stored', pc.mode IN ('doctor', 'clinic') AND g.id IS NOT NULL,
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
           'assigned_none', false,
           'carried', false)
           ORDER BY pc.n), '[]'::jsonb)
    INTO v_fp
  FROM pc
  LEFT JOIN grp g ON g.op = pc.proc_norm;

  -- The preparer's assignment of a replaced unassigned clinic piece goes to the same new row (same day, Macro doctor,
  -- patient (its file number, else its key: a key may change when a mark is added), operation and tooth; duplicates
  -- matched in order). Only clinic pieces are assigned (fin_hk_assign_piece).
  WITH nw AS (
    SELECT (r ->> 'n')::integer AS n,
           row_number() OVER (PARTITION BY r ->> 'day', r ->> 'ext_norm',
                                           coalesce('no:' || (r ->> 'patient_no'), 'ref:' || (r ->> 'patient_ref')),
                                           r ->> 'proc_norm', coalesce(r ->> 'tooth', '')
                              ORDER BY (r ->> 'n')::integer) AS k,
           (r ->> 'day')::date AS day, r ->> 'ext_norm' AS ext_norm,
           coalesce('no:' || (r ->> 'patient_no'), 'ref:' || (r ->> 'patient_ref')) AS ref,
           r ->> 'proc_norm' AS proc_norm, coalesce(r ->> 'tooth', '') AS tooth
    FROM jsonb_array_elements(v_fp) r
    WHERE (r ->> 'stored')::boolean AND (r ->> 'mode') = 'clinic'
  ),
  od AS (
    SELECT p.day, public.fin__normalize_name(p.ext_doctor) AS ext_norm,
           coalesce('no:' || p.macro_patient_no, 'ref:' || p.patient_ref) AS ref,
           public.fin__normalize_name(p.procedure) AS proc_norm, coalesce(p.tooth, '') AS tooth, p.doctor_id,
           p.assigned_none,
           row_number() OVER (PARTITION BY p.day, public.fin__normalize_name(p.ext_doctor),
                                           coalesce('no:' || p.macro_patient_no, 'ref:' || p.patient_ref),
                                           public.fin__normalize_name(p.procedure), coalesce(p.tooth, '')
                              ORDER BY p.created_at, p.id) AS k
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.voided_at IS NULL AND p.day BETWEEN p_from AND p_to
  ),
  mt AS (
    SELECT nw.n, od.doctor_id, od.assigned_none
    FROM nw
    JOIN od ON od.day = nw.day AND od.ext_norm = nw.ext_norm AND od.ref = nw.ref AND od.proc_norm = nw.proc_norm
           AND od.tooth = nw.tooth AND od.k = nw.k
    WHERE od.doctor_id IS NOT NULL OR od.assigned_none
  )
  SELECT coalesce(jsonb_agg(CASE WHEN mt.n IS NOT NULL
                                 THEN r.e || jsonb_build_object('doctor_id', mt.doctor_id,
                                                                'assigned_none', mt.assigned_none,
                                                                'carried', true)
                                 ELSE r.e END
                            ORDER BY (r.e ->> 'n')::integer), '[]'::jsonb),
         count(mt.n)
    INTO v_fp, v_carried
  FROM jsonb_array_elements(v_fp) AS r(e)
  LEFT JOIN mt ON mt.n = (r.e ->> 'n')::integer;

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
    'skipped_pieces', (SELECT count(*) FROM jsonb_array_elements(v_fp) r
                       WHERE (r ->> 'mode') IN ('outside', 'ignore')),
    'ungrouped_pieces', (SELECT count(*) FROM jsonb_array_elements(v_fp) r
                         WHERE (r ->> 'mode') IN ('doctor', 'clinic') AND (r -> 'proc_group_id') = 'null'::jsonb),
    'unassigned_pieces', (SELECT coalesce(sum((r ->> 'qty')::integer), 0)
                          FROM jsonb_array_elements(v_fp) r
                          WHERE (r ->> 'stored')::boolean AND (r -> 'doctor_id') = 'null'::jsonb
                            AND NOT (r ->> 'assigned_none')::boolean),
    'carried_assignments', v_carried,
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
               'skipped_pieces', coalesce(ps.skipped, 0))
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
               count(*) FILTER (WHERE (r ->> 'mode') IN ('doctor', 'clinic')
                                  AND (r -> 'proc_group_id') = 'null'::jsonb) AS ungrouped,
               count(*) FILTER (WHERE (r ->> 'mode') IN ('outside', 'ignore')) AS skipped
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
                                     macro_basis, created_by, updated_by)
    SELECT gen_random_uuid(), v_clinic, 'import', p_batch_id, x.day, x.doctor_id, x.patient_ref, x.patient_name,
           x.method, x.currency, x.amount_cents, x.try_cents, x.implant_cents, '',
           x.ext_doctor, x.procedure, x.tooth, x.treatment_day, x.proc_group_id, x.patient_no,
           x.basis, v_user, v_user
    FROM jsonb_to_recordset(v_fl) AS x(n integer, basis text, day date, treatment_day date, ext_doctor text,
                                       doctor_id uuid, patient_name text, patient_ref text, patient_no text,
                                       procedure text, tooth text, proc_group_id uuid, method text, currency text,
                                       amount_cents bigint, try_cents bigint, implant_cents bigint)
    ORDER BY x.n;

    INSERT INTO public.fin_hk_pieces (id, clinic_id, source, batch_id, day, doctor_id, patient_ref, patient_name, qty,
                                      description, proc_group_id, ext_doctor, procedure, tooth, macro_patient_no,
                                      assigned_none, created_by, updated_by)
    SELECT gen_random_uuid(), v_clinic, 'import', p_batch_id, x.day, x.doctor_id, x.patient_ref, x.patient_name,
           x.qty, '', x.proc_group_id, x.ext_doctor, x.procedure, x.tooth, x.patient_no, x.assigned_none, v_user,
           v_user
    FROM jsonb_to_recordset(v_fp) AS x(n integer, stored boolean, day date, ext_doctor text, doctor_id uuid,
                                       patient_name text, patient_ref text, patient_no text, procedure text,
                                       tooth text, qty integer, proc_group_id uuid, assigned_none boolean)
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
-- 6. Self-service (0032 body, same signature; still only the caller's own data).
-- ---------------------------------------------------------------------------

-- One month of the caller (0032 body) + 0033: pieces are those the caller's own rules count (implant-type pieces of an
-- implant_piece rule's doctor, the group's pieces of a procedure_piece rule's doctor), a grouped piece with
-- {proc_group_name, procedure, tooth}; an imported line with {procedure, tooth}. A caller without any rule gets
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
             'counted', coalesce(ev.payee_user_id = v_user, false))
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
-- 7. 0031 functions replaced with the same signature (CREATE OR REPLACE keeps the ACL; no overload):
--    fin_hk_proc_groups, fin_hk_ext_doctors and fin_hk_import_batches join the 'Finans geçmişi' entity filter and the
--    owner JSON export. Bodies otherwise verbatim.
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
       'fin_hk_months', 'fin_hk_statements', 'fin_hk_adjustments', 'fin_hk_proc_groups', 'fin_hk_ext_doctors',
       'fin_hk_import_batches') THEN
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

-- Owner JSON export manifest (0031) + the three 0033 tables.
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
      jsonb_build_object('name', 'fin_hk_proc_groups', 'row_count',
        (SELECT count(*) FROM public.fin_hk_proc_groups t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_ext_doctors', 'row_count',
        (SELECT count(*) FROM public.fin_hk_ext_doctors t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'fin_hk_import_batches', 'row_count',
        (SELECT count(*) FROM public.fin_hk_import_batches t WHERE t.clinic_id = v_clinic)),
      jsonb_build_object('name', 'audit_logs', 'filter', 'entity_type LIKE ''fin\_%''', 'row_count',
        (SELECT count(*) FROM public.audit_logs t WHERE t.clinic_id = v_clinic AND left(t.entity_type, 4) = 'fin_'))));
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs (fin_hk_*, incl. the new fin_hk_import_macro, fin_hk_save_proc_group, fin_hk_save_ext_doctor,
--    fin_hk_assign_piece and the recreated fin_hk_save_rule) granted to authenticated, internals (fin__hk_*,
--    fin__trg_*) never; plus its self-checks over every fin_* function (no overloads) and table (incl. the three new
--    ones). hk_my_month and hk_save_mark keep their 0030 ACL (CREATE OR REPLACE); repeated here for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_month(date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hk_save_mark(uuid, integer, text, text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_save_mark(uuid, integer, text, text, uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_j jsonb;
  v_doc uuid := '00000000-0000-0000-0000-00000000000a';
  v_cases jsonb[];
  v_flags boolean[];
  v_msgs text[];
  v_i integer;
  v_err text;
BEGIN
  -- 1. Signatures (no accidental overload; fin__harden_privileges refuses overloads of fin_* too).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin__hk_iso_day(text)',
    'public.fin__hk_macro_text(jsonb)',
    'public.fin__hk_macro_row(jsonb,boolean,integer,date,date)',
    'public.fin__hk_fx_rate(uuid,text,date)',
    'public.fin__hk_resolve_ref(uuid,text,text,uuid)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_eval_lab_costs(uuid,date)',
    'public.fin__hk_proc_group_json(uuid,uuid)',
    'public.fin__hk_ext_doctor_json(uuid,uuid)',
    'public.fin__hk_import_batch_json(uuid,uuid)',
    'public.fin__trg_hk_batch_guard()',
    'public.fin__hk_rule_json(uuid,uuid)',
    'public.fin__hk_line_json(uuid,uuid)',
    'public.fin__hk_piece_json(uuid,uuid)',
    'public.fin__hk_parts(jsonb,uuid)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin_hk_reference()',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text,integer,uuid)',
    'public.fin_hk_save_line(uuid,integer,date,uuid,text,text,text,text,bigint,bigint,bigint,text,text)',
    'public.fin_hk_save_piece(uuid,integer,date,uuid,text,text,integer,text)',
    'public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date)',
    'public.fin_hk_save_lab_cost(uuid,integer,date,uuid,text,text,text,bigint,text)',
    'public.hk_save_mark(uuid,integer,text,text,uuid,date)',
    'public.fin_hk_save_proc_group(uuid,integer,text,boolean,text[],boolean,text)',
    'public.fin_hk_save_ext_doctor(uuid,integer,text,text,uuid)',
    'public.fin_hk_assign_piece(uuid,integer,uuid,boolean)',
    'public.fin_hk_import_macro(uuid,date,date,jsonb,jsonb,text[],boolean)',
    'public.hk_my_month(date)',
    'public.fin_audit_list(jsonb,jsonb)',
    'public.fin_export_manifest()']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL
     OR to_regprocedure('public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,'
                        || 'integer,integer,date,date,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v2 fonksiyon imzaları beklenen gibi değil: %', coalesce(v_bad, 'fin_hk_save_rule (0032)');
  END IF;

  -- 2. The helpers added or replaced here stay internal (SECURITY INVOKER except the trigger function, not callable
  --    from the API); the RPCs keep SECURITY DEFINER + search_path, callable by authenticated, never by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__hk_iso_day', 'fin__hk_macro_text', 'fin__hk_macro_row', 'fin__hk_fx_rate',
                      'fin__hk_resolve_ref', 'fin__hk_proc_group_json', 'fin__hk_ext_doctor_json',
                      'fin__hk_import_batch_json', 'fin__hk_rule_json', 'fin__hk_line_json', 'fin__hk_piece_json',
                      'fin__hk_eval_lines', 'fin__hk_eval_lab_costs', 'fin__hk_parts', 'fin__hk_compute',
                      'fin__trg_hk_batch_guard')
    AND ((p.prosecdef AND p.proname <> 'fin__trg_hk_batch_guard')
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç hakediş fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_hk_import_macro', 'fin_hk_save_proc_group', 'fin_hk_save_ext_doctor', 'fin_hk_assign_piece',
                      'fin_hk_save_rule', 'fin_hk_reference', 'fin_hk_save_line', 'fin_hk_save_piece',
                      'fin_hk_save_mark', 'fin_hk_save_lab_cost', 'hk_save_mark', 'fin_audit_list',
                      'fin_export_manifest', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v2 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Tables and constraints: the three new tables (RLS, SELECT only), rule kind procedure_piece and its shape,
  --    method 'unpaid', doctor-less import rows, the group foreign keys.
  SELECT string_agg(c.relname, ', ') INTO v_bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('fin_hk_proc_groups', 'fin_hk_ext_doctors', 'fin_hk_import_batches')
    AND (NOT c.relrowsecurity
         OR has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
         OR has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         OR NOT has_table_privilege('authenticated', c.oid, 'SELECT'));
  IF v_bad IS NOT NULL
     OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname IN ('fin_hk_proc_groups', 'fin_hk_ext_doctors', 'fin_hk_import_batches')) <> 3 THEN
    RAISE EXCEPTION 'Macro yükleme tabloları veya yetkileri beklenen gibi değil: %', coalesce(v_bad, '-');
  END IF;
  IF (SELECT count(*)
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'kind'
      WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.contype = 'c' AND c.conkey = ARRAY[a.attnum]) <> 1
     OR (SELECT count(*)
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'method'
         WHERE c.conrelid = 'public.fin_hk_lines'::regclass AND c.contype = 'c' AND c.conkey = ARRAY[a.attnum]) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_check'
                      AND pg_get_constraintdef(c.oid) LIKE '%minimum_monthly%'
                      AND pg_get_constraintdef(c.oid) LIKE '%procedure_piece%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_kind_shape'
                      AND pg_get_constraintdef(c.oid) LIKE '%procedure_piece%'
                      AND pg_get_constraintdef(c.oid) LIKE '%proc_group_id%'
                      AND pg_get_constraintdef(c.oid) LIKE '%deduct_unpaid_bp%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_lines'::regclass AND c.conname = 'fin_hk_lines_method_check'
                      AND pg_get_constraintdef(c.oid) LIKE '%unpaid%' AND pg_get_constraintdef(c.oid) LIKE '%financing%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_lines'::regclass AND c.conname = 'fin_hk_lines_import_shape')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_pieces'::regclass AND c.conname = 'fin_hk_pieces_import_shape')
     OR (SELECT count(*) FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.conname IN ('fin_hk_rules_proc_group_fkey', 'fin_hk_lines_proc_group_fkey',
                             'fin_hk_pieces_proc_group_fkey')
           AND c.confrelid = 'public.fin_hk_proc_groups'::regclass) <> 3
     OR EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name IN ('fin_hk_lines', 'fin_hk_pieces')
                  AND c.column_name = 'doctor_id' AND c.is_nullable = 'NO') THEN
    RAISE EXCEPTION 'Hakediş v2 tablo kısıtları beklenen gibi değil.';
  END IF;

  -- 4. Entry description of a procedure_piece component (the doctor named only for another payee's doctor; a 0 part
  --    left out).
  v_j := jsonb_build_object('components', jsonb_build_array(
           jsonb_build_object('kind', 'procedure_piece', 'doctor_id', v_doc, 'doctor_name', 'D',
                              'proc_group_name', 'Grup', 'qty', 3, 'piece_cents', 12345, 'amount_cents', 37035),
           jsonb_build_object('kind', 'procedure_piece', 'doctor_id', v_doc, 'doctor_name', 'D',
                              'proc_group_name', 'Sıfır', 'qty', 0, 'piece_cents', 100, 'amount_cents', 0)));
  IF public.fin__hk_parts(v_j, v_doc) IS DISTINCT FROM 'işlem başı Grup 3 × 123,45 TL = 370,35 TL'
     OR public.fin__hk_parts(v_j, NULL) IS DISTINCT FROM 'işlem başı Grup D 3 × 123,45 TL = 370,35 TL'
     OR public.fin__hk_description(v_j, DATE '2024-02-01', v_doc)
          IS DISTINCT FROM 'DentOS hakediş 2024-02: işlem başı Grup 3 × 123,45 TL = 370,35 TL' THEN
    RAISE EXCEPTION 'İşlem başı ücret açıklaması beklenen gibi değil: %', coalesce(public.fin__hk_parts(v_j, NULL), '-');
  END IF;

  -- 5. An empty computation (runs every query of the engine once) is still the 0030 result.
  v_j := public.fin__hk_compute(gen_random_uuid(), DATE '2024-01-15');
  IF v_j IS DISTINCT FROM jsonb_build_object('month', DATE '2024-01-01', 'payees', '[]'::jsonb,
                                             'clinic_total_cents', 0, 'warnings', '[]'::jsonb) THEN
    RAISE EXCEPTION 'Boş klinik hesabı beklenen gibi değil: %', left(v_j::text, 300);
  END IF;

  -- 6. Import helpers: ISO days, Macro text cells, one valid line / piece and the row errors.
  IF public.fin__hk_iso_day('2024-02-29') IS DISTINCT FROM DATE '2024-02-29'
     OR public.fin__hk_iso_day('2023-02-29') IS NOT NULL
     OR public.fin__hk_iso_day('2024-13-01') IS NOT NULL
     OR public.fin__hk_iso_day('2024-04-31') IS NOT NULL
     OR public.fin__hk_iso_day('2024-1-05') IS NOT NULL
     OR public.fin__hk_iso_day('1999-12-31') IS NOT NULL
     OR public.fin__hk_iso_day('2024-02-05T00:00') IS NOT NULL
     OR public.fin__hk_iso_day(NULL) IS NOT NULL
     OR public.fin__hk_macro_text('"  12 "'::jsonb) IS DISTINCT FROM '12'
     OR public.fin__hk_macro_text('1001'::jsonb) IS DISTINCT FROM '1001'
     OR public.fin__hk_macro_text('1001.50'::jsonb) IS DISTINCT FROM '1001.5'
     OR public.fin__hk_macro_text('"  "'::jsonb) IS NOT NULL
     OR public.fin__hk_macro_text('null'::jsonb) IS NOT NULL
     OR public.fin__hk_macro_text('true'::jsonb) IS NOT NULL
     OR public.fin__hk_macro_text(NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.fin__hk_fx_rate(gen_random_uuid(), 'USD', DATE '2024-01-01'))
     -- A clinic without imported rows: the key of fin__hk_patient_ref.
     OR public.fin__hk_resolve_ref(gen_random_uuid(), NULL, ' Hasta  BİR ', NULL) IS DISTINCT FROM 'hasta bir'
     OR public.fin__hk_resolve_ref(gen_random_uuid(), ' 1001 ', 'Hasta Bir', v_doc) IS DISTINCT FROM '1001' THEN
    RAISE EXCEPTION 'Macro yükleme yardımcıları beklenen gibi değil.';
  END IF;
  IF public.fin__hk_macro_row(
       '{"key": "k1", "basis": "production", "day": "2024-02-05", "ext_doctor": "  Dr.   X ", "patient_name": " Hasta ",
         "patient_no": 1001, "procedure": " Diş  Çekimi ", "tooth": 18, "method": "cash", "currency": "usd",
         "amount_cents": 1234}'::jsonb, true, 3, DATE '2024-02-01', DATE '2024-02-29')
       IS DISTINCT FROM
       '{"n": 3, "key": "k1", "basis": "production", "day": "2024-02-05", "treatment_day": "2024-02-05",
         "ext_doctor": "Dr. X", "ext_norm": "dr. x", "patient_name": "Hasta", "patient_no": "1001",
         "procedure": "Diş  Çekimi", "proc_norm": "diş çekimi", "tooth": "18", "method": "cash", "currency": "USD",
         "amount_cents": 1234, "qty": 1}'::jsonb
     OR public.fin__hk_macro_row(
          '{"day": "2024-02-05", "ext_doctor": "K", "patient_name": "H", "procedure": "P", "qty": 2}'::jsonb, false, 1,
          DATE '2024-02-01', DATE '2024-02-29')
          IS DISTINCT FROM
          '{"n": 1, "key": null, "basis": null, "day": "2024-02-05", "treatment_day": null, "ext_doctor": "K",
            "ext_norm": "k", "patient_name": "H", "patient_no": null, "procedure": "P", "proc_norm": "p",
            "tooth": null, "method": null, "currency": null, "amount_cents": null, "qty": 2}'::jsonb THEN
    RAISE EXCEPTION 'Macro satırı beklenen gibi çözülmedi.';
  END IF;
  v_cases := ARRAY[
    '{"basis": "production", "day": "2024-02-30", "ext_doctor": "K", "patient_name": "H", "method": "cash",
      "amount_cents": 1}',
    '{"basis": "production", "day": "2024-03-05", "ext_doctor": "K", "patient_name": "H", "method": "cash",
      "amount_cents": 1}',
    '{"basis": "production", "day": "2024-02-05", "ext_doctor": "K", "patient_name": "H", "method": "cash",
      "amount_cents": 12.5}',
    '{"basis": "payment", "day": "2024-02-05", "ext_doctor": "K", "patient_name": "H", "method": "unpaid",
      "amount_cents": 1}',
    '{"day": "2024-02-05", "ext_doctor": "K", "patient_name": "H", "procedure": "P", "qty": 0}',
    '[1]',
    '{"basis": "production", "day": "2024-02-05", "treatment_day": "2024-02-04", "ext_doctor": "K",
      "patient_name": "H", "method": "cash", "amount_cents": 1}',
    '{"basis": "production", "day": "2024-02-05", "ext_doctor": "K", "patient_name": "H", "method": "cash",
      "currency": "JPY", "amount_cents": 1}',
    '{"basis": "production", "day": "2024-02-05", "patient_name": "H", "method": "cash", "amount_cents": 1}',
    '{"basis": "production", "day": "2024-02-05", "ext_doctor": "K", "method": "cash", "amount_cents": 1}',
    '{"basis": "production", "day": "2024-02-05", "ext_doctor": "K", "patient_name": "H", "method": "cash",
      "amount_cents": 0}']::jsonb[];
  v_flags := ARRAY[true, true, true, true, false, true, true, true, true, true, true];
  v_msgs := ARRAY[
    'Macro yüklemesi, 1. satır: tarih geçersiz (YYYY-AA-GG).',
    'Macro yüklemesi, 1. satır (05.03.2024): tarih seçilen aralığın dışında.',
    'Macro yüklemesi, 1. satır (05.02.2024): tutar 0 olamaz, kuruş olarak tam sayı olmalı ve en fazla 10.000.000.000 olabilir.',
    'Macro yüklemesi, 1. satır (05.02.2024): ödeme şekli geçersiz.',
    'Macro yüklemesi, 1. işlem (05.02.2024): adet 0 olamaz ve -1000 ile 1000 arasında olmalı.',
    'Macro yüklemesi, 1. satır: kayıt biçimi geçersiz.',
    'Macro yüklemesi, 1. satır (05.02.2024): işlem raporu satırının tarihi işlem tarihi olmalı.',
    'Macro yüklemesi, 1. satır (05.02.2024): para birimi geçersiz.',
    'Macro yüklemesi, 1. satır (05.02.2024): Macro hekim adı boş olamaz ve en fazla 120 karakter olabilir.',
    'Macro yüklemesi, 1. satır (05.02.2024): hasta adı boş olamaz ve en fazla 200 karakter olabilir.',
    'Macro yüklemesi, 1. satır (05.02.2024): tutar 0 olamaz, kuruş olarak tam sayı olmalı ve en fazla 10.000.000.000 olabilir.'];
  FOR v_i IN 1 .. cardinality(v_cases)
  LOOP
    v_err := NULL;
    BEGIN
      PERFORM public.fin__hk_macro_row(v_cases[v_i], v_flags[v_i], 1, DATE '2024-02-01', DATE '2024-02-29');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
      RAISE EXCEPTION 'Macro satırı doğrulaması (%): %', v_i, coalesce(v_err, '-');
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9.2 Replay inside a block that is always rolled back: temporary clinic 'p33-test-hk-selfcheck-<random>' with an
--     owner (finance, doctors row, clinic_ciro_share), doctors A (ciro_share with card / transfer / unpaid
--     deductions), O (ortho_lab_first), S (procedure_piece on two groups) and B (implant_piece + procedure_piece on a
--     non-implant group), a reception user R ('hakedis_prepare') and an assistant Q without permissions. Made-up names,
--     operation names and amounts only; auth.uid() is simulated through request.jwt.claims (and
--     request.jwt.claim.sub / .role), as in 0030 – 0032. Covered: group and Macro doctor saves (normalization, retry,
--     clashes, validation, the implant flip refused), procedure_piece / unpaid rule saves (0032 callers keep the unpaid
--     deduction, overlap, implant cross refusals, validation, refused for R), import refusals (permission, unmapped
--     doctor with DETAIL, missing rate with DETAIL, basis against the ortho rule, day out of range, future end), the dry
--     run (summary, nothing written), the import (lines, FX, implant part, patient keys, doctor-less rows, pieces by
--     group, unassigned), the retry, the February figures (unpaid bucket, procedure pieces, implant-type pieces,
--     clinic total incl. doctor-less lines, UNRULED_PIECES, UNASSIGNED_PIECES), assignment (retry, version, "Hakediş
--     yok", manual piece and doctor-mapped piece refused, the assigned clinic piece changed again), imported rows not
--     editable, the re-import (replaced rows and batch, carried assignment, new figures), the close (procedure piece
--     descriptions), closed-month refusals, March patient keys (marks by name before and after the import, the name
--     fallback, the exact Macro-key mark first, manual lines as 0032, O's lab cost entered before the import taken
--     first from the imported payment), hk_my_month of S, B and A, fin_hk_reference. Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p33-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_own_doc uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_a_auth uuid := gen_random_uuid();
  v_a_doc uuid := gen_random_uuid();
  v_o uuid := gen_random_uuid();
  v_o_auth uuid := gen_random_uuid();
  v_o_doc uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_s_auth uuid := gen_random_uuid();
  v_s_doc uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_b_auth uuid := gen_random_uuid();
  v_b_doc uuid := gen_random_uuid();
  v_r uuid := gen_random_uuid();
  v_r_auth uuid := gen_random_uuid();
  v_q uuid := gen_random_uuid();
  v_q_auth uuid := gen_random_uuid();
  v_g_imp uuid := gen_random_uuid();
  v_g_ext uuid := gen_random_uuid();
  v_g_sin uuid := gen_random_uuid();
  v_rule_a uuid := gen_random_uuid();
  v_batch_dry uuid := gen_random_uuid();
  v_batch1 uuid := gen_random_uuid();
  v_batch2 uuid := gen_random_uuid();
  v_piece_m uuid := gen_random_uuid();
  v_piece_k uuid;
  v_piece_s uuid;
  v_batch3 uuid := gen_random_uuid();
  v_lab uuid := gen_random_uuid();
  v_line_id uuid;
  v_lines jsonb;
  v_pieces jsonb;
  v_sqls text[];
  v_msgs text[];
  v_i integer;
  v_j jsonb;
  v_p jsonb;
  v_c jsonb;
  v_w jsonb;
  v_err text;
  v_state text;
  v_det text;
  v_ver integer;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P33', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p33-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p33-sc-a-' || v_tag || '@example.invalid', true),
      (v_o, v_clinic, v_o_auth, 'doctor', 'Öz denetim Hekim O', 'p33-sc-o-' || v_tag || '@example.invalid', true),
      (v_s, v_clinic, v_s_auth, 'doctor', 'Öz denetim Hekim S', 'p33-sc-s-' || v_tag || '@example.invalid', true),
      (v_b, v_clinic, v_b_auth, 'doctor', 'Öz denetim Hekim B', 'p33-sc-b-' || v_tag || '@example.invalid', true),
      (v_r, v_clinic, v_r_auth, 'reception', 'Öz denetim Banko', 'p33-sc-r-' || v_tag || '@example.invalid', true),
      (v_q, v_clinic, v_q_auth, 'assistant', 'Öz denetim Asistan Q', 'p33-sc-q-' || v_tag || '@example.invalid',
       true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_own_doc, v_clinic, v_own), (v_a_doc, v_clinic, v_a), (v_o_doc, v_clinic, v_o), (v_s_doc, v_clinic, v_s),
      (v_b_doc, v_clinic, v_b);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own);
    -- A USD reference rate 17 days before the dollar line (stale: FX warning).
    INSERT INTO public.fx_rates (clinic_id, currency, rate, rate_on, source, created_by, updated_by)
    VALUES (v_clinic, 'USD', 30.5, DATE '2024-01-20', 'manual', v_own, v_own);

    -- Owner: 'hakedis_prepare' for R; the rules that need no group.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;
    PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');

    v_j := public.fin_hk_save_rule(v_rule_a, 0, v_a, v_a_doc, 'ciro_share', 'standard', 2000, NULL,
                                   0, 1500, 800, 0, DATE '2024-01-01', NULL, '', 1500, NULL);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,deduct_unpaid_bp}')::integer IS DISTINCT FROM 1500
       OR (v_j #> '{record,proc_group_id}') IS DISTINCT FROM 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'ödenmemiş kesintili ciro kuralı: ' || left(v_j::text, 300));
    END IF;
    -- A caller of the 0032 signature (15 parameters) keeps the saved unpaid deduction.
    v_j := public.fin_hk_save_rule(v_rule_a, 1, v_a, v_a_doc, 'ciro_share', 'standard', 2000, NULL,
                                   0, 1500, 800, 0, DATE '2024-01-01', NULL, '');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false)
       OR (v_j #>> '{record,deduct_unpaid_bp}')::integer IS DISTINCT FROM 1500 THEN
      v_fail := array_append(v_fail, '0032 imzasıyla ciro kuralı: ' || left(v_j::text, 300));
    END IF;
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_o, v_o_doc, 'ortho_lab_first', NULL, 4500, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_b, v_b_doc, 'implant_piece', NULL, NULL, 34567,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_own, NULL, 'clinic_ciro_share', NULL, 500, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');

    -- R: procedure groups and the Macro doctor mapping (no rules).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_save_proc_group(v_g_imp, 0, ' İmplant ', true,
                                         ARRAY['İmplant  Uygulaması', 'implant uygulaması'], true, '');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,name}') IS DISTINCT FROM 'İmplant'
       OR (v_j #> '{record,op_names}') IS DISTINCT FROM '["implant uygulaması"]'::jsonb
       OR NOT coalesce((v_j #>> '{record,is_implant}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'implant grubu: ' || left(v_j::text, 300));
    END IF;
    PERFORM public.fin_hk_save_proc_group(v_g_ext, 0, 'Çekim', false, ARRAY['Diş Çekimi'], true, '');
    PERFORM public.fin_hk_save_proc_group(v_g_sin, 0, 'Sinüs', false, ARRAY['Sinüs Lifting'], true, '');
    v_j := public.fin_hk_save_proc_group(v_g_ext, 0, 'Çekim', false, ARRAY['Diş Çekimi'], true, '');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'işlem grubu tekrar deneme: ' || left(v_j::text, 300));
    END IF;
    v_sqls := ARRAY[
      'SELECT public.fin_hk_save_proc_group(gen_random_uuid(), 0, ''Başka'', false, ARRAY[''DİŞ  ÇEKİMİ''], true, '''')',
      'SELECT public.fin_hk_save_proc_group(gen_random_uuid(), 0, ''çekim'', false, ARRAY[]::text[], true, '''')',
      'SELECT public.fin_hk_save_proc_group(gen_random_uuid(), 0, ''  '', false, ARRAY[]::text[], true, '''')',
      'SELECT public.fin_hk_save_proc_group(gen_random_uuid(), 0, ''Boş'', false, ARRAY['' ''], true, '''')'];
    v_msgs := ARRAY[
      'Bu işlem adları başka bir grupta: "diş çekimi" (Çekim). Önce o gruptan çıkarın.',
      'Bu adla başka bir işlem grubu var.',
      'Grup adı boş olamaz ve en fazla 80 karakter olabilir.',
      'İşlem adları boş olamaz ve en fazla 200 karakter olabilir.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'işlem grubu doğrulaması: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    v_j := public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, ' Dr.  Alfa ', 'doctor', v_a_doc);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,ext_name}') IS DISTINCT FROM 'dr. alfa'
       OR (v_j #>> '{record,display_name}') IS DISTINCT FROM 'Dr. Alfa'
       OR (v_j #>> '{record,doctor_name}') IS DISTINCT FROM 'Öz denetim Hekim A' THEN
      v_fail := array_append(v_fail, 'Macro hekim eşleştirmesi: ' || left(v_j::text, 300));
    END IF;
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Orto', 'doctor', v_o_doc);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Cerrah', 'doctor', v_s_doc);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Beta', 'doctor', v_b_doc);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'KLİNİK', 'clinic', NULL);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dış Cerrah', 'outside', NULL);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Eski Hekim', 'ignore', NULL);
    v_sqls := ARRAY[
      'SELECT public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, ''X'', ''doctor'', NULL)',
      format('SELECT public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, ''X'', ''clinic'', %L)', v_a_doc),
      'SELECT public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, ''X'', ''hekim'', NULL)',
      'SELECT public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, ''dr. ALFA'', ''clinic'', NULL)',
      'SELECT public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, '' '', ''clinic'', NULL)'];
    v_msgs := ARRAY[
      'DentOS hekimi seçilmeli.',
      'Hekim yalnızca "DentOS hekimi" eşleştirmesinde seçilir.',
      'Geçersiz eşleştirme türü.',
      'Bu Macro hekim adı zaten eşleştirilmiş.',
      'Macro hekim adı boş olamaz ve en fazla 120 karakter olabilir.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'Macro hekim doğrulaması: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, v_s_doc, 'procedure_piece', NULL, NULL, 100,
                                      0, 0, 0, 0, DATE '2030-01-01', NULL, '', NULL, v_g_ext);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı işlem başı kuralı: ' || coalesce(v_state, '-'));
    END IF;
    -- B's manual implant (a legacy piece without a group).
    PERFORM public.fin_hk_save_piece(v_piece_m, 0, DATE '2024-02-16', v_b_doc, 'Hasta On', NULL, 1, '');

    -- Owner: procedure_piece rules (S on the extraction and implant groups, B on the sinus group), refusals.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, v_s_doc, 'procedure_piece', NULL, NULL, 12345,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, v_g_ext);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,kind}') IS DISTINCT FROM 'procedure_piece'
       OR (v_j #>> '{record,proc_group_id}') IS DISTINCT FROM v_g_ext::text
       OR (v_j #>> '{record,proc_group_name}') IS DISTINCT FROM 'Çekim'
       OR (v_j #>> '{record,piece_cents}')::bigint IS DISTINCT FROM 12345
       OR (v_j #>> '{record,deduct_unpaid_bp}')::integer IS DISTINCT FROM 0 THEN
      v_fail := array_append(v_fail, 'işlem başı ücret kuralı: ' || left(v_j::text, 300));
    END IF;
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, v_s_doc, 'procedure_piece', NULL, NULL, 23456,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, v_g_imp);
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_b, v_b_doc, 'procedure_piece', NULL, NULL, 11111,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, v_g_sin);
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2024-06-01'', DATE ''2024-08-01'', '''', NULL, %L)', v_s, v_s_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''implant_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2024-01-01'', NULL, '''')', v_s, v_s_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2024-01-01'', NULL, '''', NULL, %L)', v_b, v_b_doc, v_g_imp)];
    v_msgs := ARRAY[
      'Bu hekim ve işlem grubu için bu aylarla çakışan başka bir işlem başı ücret kuralı var. Önce onun bitiş ayını girin.',
      'Bu hekimin bu aylarla çakışan, implant grubu için işlem başı ücret kuralı var; ayrıca implant (adet başı) kuralı tanımlanamaz. Önce birinin bitiş ayını girin.',
      'Bu hekimin bu aylarla çakışan implant (adet başı) kuralı var; implant grubu için ayrıca işlem başı ücret tanımlanamaz. Önce birinin bitiş ayını girin.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      v_state := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
      END;
      IF v_state IS DISTINCT FROM 'PT409' OR v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'işlem başı çakışma: ' || v_sqls[v_i] || ' / ' || coalesce(v_state, '-') || ' '
                                       || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''')', v_s, v_s_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_a, v_s_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, 2500, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_s, v_s_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 0, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_s, v_s_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''ciro_share'', ''child'', 2000, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_a, v_a_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''ortho_lab_first'', NULL, 2000, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', 100, NULL)', v_o, v_o_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''ciro_share'', ''child'', 2000, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', 10001, NULL)', v_a, v_a_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', ''standard'', NULL, '
             '100, 0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_s, v_s_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 100, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_s, v_s_doc, v_g_ext),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L)', v_s, v_s_doc, gen_random_uuid())];
    v_msgs := ARRAY[
      'İşlem grubu seçilmeli.',
      'İşlem başı ücret kuralında hakediş alan kişi işlemi yapan hekimin kendisi olmalı.',
      'İşlem başı ücret kuralında pay oranı girilmez.',
      'İşlem başı tutar 0,01 TL ile 10.000.000.000 TL arasında olmalı.',
      'İşlem grubu yalnızca işlem başı ücret kuralında seçilir.',
      'Ödenmemiş (ay sonu) kesintisi yalnızca ciro payı kuralında girilir.',
      'Kesinti oranları %0 ile %100 arasında olmalı.',
      'Hasta grubu yalnızca ciro payı kuralında seçilir.',
      'Kesinti oranları yalnızca ciro payı ve ortodonti kurallarında girilir.',
      'İşlem grubu bulunamadı.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'işlem başı doğrulaması: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- R: the sinus group cannot become an implant group while B has a sinus procedure_piece rule and an implant_piece
    -- rule in the same months.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_state := NULL;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_proc_group(v_g_sin, 1, 'Sinüs', true, ARRAY['Sinüs Lifting'], true, '');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM 'PT409' OR position('Öz denetim Hekim B' IN coalesce(v_err, '')) = 0 THEN
      v_fail := array_append(v_fail, 'implant grubuna çevirme: ' || coalesce(v_state, '-') || ' ' || coalesce(v_err, '-'));
    END IF;

    -- The February reports (made up): A production (cash + unpaid, a dollar card payment, an implant by transfer, an
    -- unpaid treatment of 'Hasta Üç'), O's payment of 'hasta  üç' (key from A's lines), the clinic's and the outside
    -- doctor's production, an ignored doctor's row; pieces of S, B, A, the clinic, the outside and the ignored doctor.
    SELECT jsonb_agg(jsonb_build_object(
             'key', x.k, 'basis', x.basis, 'day', x.d, 'treatment_day', x.td, 'ext_doctor', x.ext,
             'patient_name', x.pat, 'patient_no', x.pno, 'procedure', x.op, 'tooth', x.tooth, 'method', x.m,
             'currency', x.cur, 'amount_cents', x.amt) ORDER BY x.k)
      INTO v_lines
    FROM (VALUES
      ('l1', 'production', '2024-02-05', NULL, 'Dr. Alfa', 'Hasta Bir', '1001', 'Dolgu', '16', 'cash', 'TRY', 300000),
      ('l2', 'production', '2024-02-05', NULL, 'Dr. Alfa', 'Hasta Bir', '1001', 'Dolgu', '16', 'unpaid', 'TRY', 500000),
      ('l3', 'production', '2024-02-06', NULL, 'DR.  ALFA', 'Hasta İki', '1002', 'Kanal Tedavisi', '36', 'card', 'USD',
       10000),
      ('l4', 'production', '2024-02-07', NULL, 'Dr. Alfa', 'Hasta Üç', '1003', 'İmplant Uygulaması', '46', 'transfer',
       'TRY', 210000),
      ('l5', 'production', '2024-02-08', NULL, 'Dr. Alfa', 'Hasta Üç', '1003', 'Dolgu', '47', 'unpaid', 'TRY', 110000),
      ('l6', 'payment', '2024-02-10', '2024-01-20', 'Dr. Orto', 'hasta  üç', NULL, 'Tel Tedavisi', NULL, 'cash', 'TRY',
       165000),
      ('l7', 'production', '2024-02-12', NULL, 'KLİNİK', 'Hasta Dört', '1004', 'Diş Çekimi', '18', 'cash', 'TRY', 70000),
      ('l8', 'production', '2024-02-13', NULL, 'Dış Cerrah', 'Hasta Beş', '1005', 'İmplant Uygulaması', '36', 'card',
       'TRY', 90000),
      ('l9', 'production', '2024-02-14', NULL, 'Eski Hekim', 'Hasta Altı', '1006', 'Dolgu', '26', 'cash', 'TRY', 50000)
    ) AS x(k, basis, d, td, ext, pat, pno, op, tooth, m, cur, amt);
    SELECT jsonb_agg(jsonb_build_object(
             'key', x.k, 'day', x.d, 'ext_doctor', x.ext, 'patient_name', x.pat, 'patient_no', x.pno,
             'procedure', x.op, 'tooth', x.tooth, 'qty', 1) ORDER BY x.k)
      INTO v_pieces
    FROM (VALUES
      ('p01', '2024-02-05', 'Dr. Cerrah', 'Hasta Yedi', '1007', 'Diş Çekimi', '38'),
      ('p02', '2024-02-05', 'Dr. Cerrah', 'Hasta Yedi', '1007', 'Diş Çekimi', '48'),
      ('p03', '2024-02-09', 'Dr. Cerrah', 'Hasta Sekiz', '1008', 'İmplant Uygulaması', '36'),
      ('p04', '2024-02-09', 'Dr. Cerrah', 'Hasta Sekiz', '1008', 'Bilinmeyen İşlem', NULL),
      ('p05', '2024-02-12', 'KLİNİK', 'Hasta Dört', '1004', 'Diş Çekimi', '18'),
      ('p06', '2024-02-13', 'Dış Cerrah', 'Hasta Beş', '1005', 'İmplant Uygulaması', '36'),
      ('p07', '2024-02-15', 'Dr. Beta', 'Hasta Dokuz', '1009', 'İmplant Uygulaması', '11'),
      ('p08', '2024-02-15', 'Dr. Beta', 'Hasta Dokuz', '1009', 'Diş Çekimi', '12'),
      ('p09', '2024-02-14', 'Eski Hekim', 'Hasta Altı', '1006', 'Diş Çekimi', '28'),
      ('p10', '2024-02-07', 'Dr. Alfa', 'Hasta Üç', '1003', 'İmplant Uygulaması', '46')
    ) AS x(k, d, ext, pat, pno, op, tooth);

    -- Import refusals (R), nothing written by any of them.
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', DATE ''2024-02-29'', %L, '
             '''[]''::jsonb, ARRAY[]::text[], true)',
             v_lines || jsonb_build_array(jsonb_build_object(
               'basis', 'production', 'day', '2024-02-05', 'ext_doctor', 'Yeni Hekim', 'patient_name', 'Hasta Bir',
               'method', 'cash', 'currency', 'TRY', 'amount_cents', 100))),
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', DATE ''2024-02-29'', %L, '
             '''[]''::jsonb, ARRAY[]::text[], true)',
             v_lines || jsonb_build_array(jsonb_build_object(
               'basis', 'production', 'day', '2024-02-05', 'ext_doctor', 'Dr. Alfa', 'patient_name', 'Hasta Bir',
               'method', 'cash', 'currency', 'EUR', 'amount_cents', 100))),
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', DATE ''2024-02-29'', %L, '
             '''[]''::jsonb, ARRAY[]::text[], false)',
             jsonb_build_array(jsonb_build_object(
               'basis', 'payment', 'day', '2024-02-05', 'ext_doctor', 'Dr. Alfa', 'patient_name', 'Hasta Bir',
               'method', 'cash', 'currency', 'TRY', 'amount_cents', 100))),
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', DATE ''2024-02-29'', %L, '
             '''[]''::jsonb, ARRAY[]::text[], false)',
             jsonb_build_array(jsonb_build_object(
               'basis', 'production', 'day', '2024-02-05', 'ext_doctor', 'Dr. Orto', 'patient_name', 'Hasta Bir',
               'method', 'cash', 'currency', 'TRY', 'amount_cents', 100))),
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-06'', DATE ''2024-02-29'', %L, '
             '''[]''::jsonb, ARRAY[]::text[], false)', v_lines),
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', %L, ''[]''::jsonb, '
             '''[]''::jsonb, ARRAY[]::text[], true)', public.clinic_today() + 1),
      'SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-10'', DATE ''2024-02-01'', ''[]''::jsonb, '
        || '''[]''::jsonb, ARRAY[]::text[], true)',
      'SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2023-01-01'', DATE ''2024-02-01'', ''[]''::jsonb, '
        || '''[]''::jsonb, ARRAY[]::text[], true)'];
    v_msgs := ARRAY[
      'Eşleştirilmemiş Macro hekimleri: Yeni Hekim. Her biri için DentOS hekimi, Klinik, Dışarıdan hekim ya da Yok say seçin, sonra yeniden deneyin.',
      'Döviz kuru bulunamadı: EUR (05.02.2024). Bu günde veya öncesinde kayıtlı kur yok; kuru klinik sahibi veya finans yetkilisi Finans ayarları > Döviz kurları ekranından girsin, sonra yeniden yükleyin.',
      'Macro satırları hekim kurallarına uymuyor: Dr. Alfa (02.2024): bu ay ortodonti (önce lab) kuralı yok, ödeme bazlı satır yüklenemez.',
      'Macro satırları hekim kurallarına uymuyor: Dr. Orto (02.2024): ortodonti (önce lab) kuralı var, satırları ödeme raporundan yüklenir.',
      'Macro yüklemesi, 1. satır (05.02.2024): tarih seçilen aralığın dışında.',
      'Bitiş tarihi bugünden sonra olamaz.',
      'Başlangıç tarihi bitiş tarihinden sonra olamaz.',
      'Bir yüklemede en fazla 366 günlük aralık seçilebilir.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      v_det := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i]
         OR (v_i = 1 AND nullif(v_det, '')::jsonb IS DISTINCT FROM '{"unmapped_ext_doctors": ["Yeni Hekim"]}'::jsonb)
         OR (v_i = 2 AND nullif(v_det, '')::jsonb
                         IS DISTINCT FROM '{"missing_fx": [{"currency": "EUR", "day": "2024-02-05"}]}'::jsonb) THEN
        v_fail := array_append(v_fail, 'Macro yükleme reddi ' || v_i || ': ' || coalesce(v_err, '-') || ' / '
                                       || coalesce(v_det, '-'));
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_q_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_q_auth::text, true);
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', DATE ''2024-02-29'', %L, '
             '%L, ARRAY[]::text[], true)', v_lines, v_pieces),
      'SELECT public.fin_hk_save_proc_group(gen_random_uuid(), 0, ''Q'', false, ARRAY[]::text[], true, '''')',
      'SELECT public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, ''Q'', ''ignore'', NULL)',
      format('SELECT public.fin_hk_assign_piece(%L, 1, NULL, true)', v_piece_m)];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_state := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      END;
      IF v_state IS DISTINCT FROM '42501' THEN
        v_fail := array_append(v_fail, 'yetkisiz Macro işlemi: ' || v_sqls[v_i] || ' / ' || coalesce(v_state, '-'));
      END IF;
    END LOOP;

    -- R: dry run. Stored: 8 lines (the ignored doctor's left out), 7 pieces (S's unknown operation, the outside and
    -- the ignored doctor's pieces left out); 1.750.000 TL cents in all, implant parts 210.000 + 90.000; the dollar line
    -- at 30,5 with a 17-day-old rate. Nothing is written.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_import_macro(v_batch_dry, DATE '2024-02-01', DATE '2024-02-29', v_lines, v_pieces,
                                      ARRAY['islem.xls', ' odeme.xls '], true);
    SELECT d INTO v_p FROM jsonb_array_elements(v_j -> 'doctors') d WHERE (d ->> 'ext_name') = 'dr. alfa';
    SELECT d INTO v_c FROM jsonb_array_elements(v_j -> 'doctors') d WHERE (d ->> 'ext_name') = 'klinik';
    IF NOT coalesce((v_j ->> 'dry_run')::boolean, false)
       OR coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j ->> 'batch_id') IS DISTINCT FROM v_batch_dry::text
       OR (v_j -> 'files') IS DISTINCT FROM '["islem.xls", "odeme.xls"]'::jsonb
       OR (v_j ->> 'lines')::integer IS DISTINCT FROM 8
       OR (v_j ->> 'pieces')::integer IS DISTINCT FROM 7
       OR (v_j ->> 'try_total_cents')::bigint IS DISTINCT FROM 1750000
       OR (v_j ->> 'implant_total_cents')::bigint IS DISTINCT FROM 300000
       OR (v_j ->> 'skipped_lines')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'skipped_pieces')::integer IS DISTINCT FROM 2
       OR (v_j ->> 'ungrouped_pieces')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'unassigned_pieces')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'carried_assignments')::integer IS DISTINCT FROM 0
       OR (v_j ->> 'replaced_lines')::integer IS DISTINCT FROM 0
       OR (v_j ->> 'replaced_pieces')::integer IS DISTINCT FROM 0
       OR (v_j ->> 'replaced_batches')::integer IS DISTINCT FROM 0
       OR jsonb_array_length(v_j -> 'doctors') <> 7
       OR (v_j -> 'fx_warnings') IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
            'currency', 'USD', 'day', DATE '2024-02-06', 'rate_day', DATE '2024-01-20', 'rate', 30.5, 'age_days', 17))
       OR v_p IS NULL
       OR (v_p ->> 'lines')::integer IS DISTINCT FROM 5
       OR (v_p -> 'gross_by_method') IS DISTINCT FROM '{"cash": 300000, "card": 305000, "transfer": 210000,
                                                          "unpaid": 610000}'::jsonb
       OR (v_p ->> 'implant_cents')::bigint IS DISTINCT FROM 210000
       OR (v_p ->> 'pieces')::integer IS DISTINCT FROM 1
       OR (v_p ->> 'doctor_id') IS DISTINCT FROM v_a_doc::text
       OR v_c IS NULL
       OR (v_c ->> 'mode') IS DISTINCT FROM 'clinic'
       OR (v_c ->> 'gross_cents')::bigint IS DISTINCT FROM 70000
       OR (v_c ->> 'unassigned_pieces')::integer IS DISTINCT FROM 1
       OR (v_c -> 'pieces_by_group') IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
            'proc_group_id', v_g_ext, 'name', 'Çekim', 'count', 1))
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'eski hekim' AND (d ->> 'mode') = 'ignore'
                        AND (d ->> 'lines')::integer = 0 AND (d ->> 'skipped_lines')::integer = 1
                        AND (d ->> 'skipped_pieces')::integer = 1)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'dış cerrah' AND (d ->> 'mode') = 'outside'
                        AND (d ->> 'gross_cents')::bigint = 90000 AND (d ->> 'implant_cents')::bigint = 90000
                        AND (d ->> 'pieces')::integer = 0 AND (d ->> 'skipped_pieces')::integer = 1)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'operations') o
                      WHERE (o ->> 'normalized') = 'implant uygulaması' AND (o ->> 'proc_group_id') = v_g_imp::text
                        AND (o ->> 'lines')::integer = 2 AND (o ->> 'pieces')::integer = 4)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'operations') o
                      WHERE (o ->> 'name') = 'Bilinmeyen İşlem' AND (o -> 'proc_group_id') = 'null'::jsonb
                        AND (o ->> 'pieces')::integer = 1)
       OR EXISTS (SELECT 1 FROM public.fin_hk_lines l WHERE l.clinic_id = v_clinic)
       OR EXISTS (SELECT 1 FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.source = 'import')
       OR EXISTS (SELECT 1 FROM public.fin_hk_import_batches b WHERE b.clinic_id = v_clinic) THEN
      v_fail := array_append(v_fail, 'Macro deneme yüklemesi: ' || left(v_j::text, 1500));
    END IF;

    -- R: the import, then its retry.
    v_j := public.fin_hk_import_macro(v_batch1, DATE '2024-02-01', DATE '2024-02-29', v_lines, v_pieces,
                                      ARRAY['islem.xls', 'odeme.xls'], false);
    IF coalesce((v_j ->> 'dry_run')::boolean, true)
       OR coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j ->> 'lines')::integer IS DISTINCT FROM 8
       OR (v_j ->> 'pieces')::integer IS DISTINCT FROM 7
       OR (v_j ->> 'try_total_cents')::bigint IS DISTINCT FROM 1750000
       OR (SELECT count(*) FROM public.fin_hk_lines l
           WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL AND l.source = 'import' AND l.batch_id = v_batch1) <> 8
       OR (SELECT count(*) FROM public.fin_hk_pieces p
           WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.source = 'import' AND p.batch_id = v_batch1) <> 7
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_lines l
                      WHERE l.clinic_id = v_clinic AND l.currency = 'USD' AND l.amount_cents = 10000
                        AND l.try_cents = 305000 AND l.method = 'card' AND l.doctor_id = v_a_doc
                        AND l.ext_doctor = 'DR. ALFA' AND l.patient_ref = 'macro:1002' AND l.macro_patient_no = '1002')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_lines l
                      WHERE l.clinic_id = v_clinic AND l.method = 'transfer' AND l.implant_cents = 210000
                        AND l.try_cents = 210000 AND l.proc_group_id = v_g_imp AND l.macro_basis = 'production'
                        AND l.treatment_day = DATE '2024-02-07' AND l.day = DATE '2024-02-07')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_lines l
                      WHERE l.clinic_id = v_clinic AND l.doctor_id = v_o_doc AND l.macro_basis = 'payment'
                        AND l.patient_ref = 'macro:1003' AND l.patient_name = 'hasta  üç'
                        AND l.day = DATE '2024-02-10' AND l.treatment_day = DATE '2024-01-20'
                        AND l.macro_patient_no IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_lines l
                      WHERE l.clinic_id = v_clinic AND l.doctor_id IS NULL AND l.ext_doctor = 'KLİNİK'
                        AND l.try_cents = 70000 AND l.proc_group_id = v_g_ext AND l.implant_cents = 0)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_lines l
                      WHERE l.clinic_id = v_clinic AND l.doctor_id IS NULL AND l.ext_doctor = 'Dış Cerrah'
                        AND l.try_cents = 90000 AND l.implant_cents = 90000)
       OR (SELECT count(*) FROM public.fin_hk_lines l WHERE l.clinic_id = v_clinic AND l.method = 'unpaid') <> 2
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.doctor_id IS NULL
                        AND NOT p.assigned_none AND p.proc_group_id = v_g_ext AND p.patient_ref = 'macro:1004')
       OR (SELECT count(*) FROM public.fin_hk_pieces p
           WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.doctor_id = v_s_doc) <> 3
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_import_batches b
                      WHERE b.clinic_id = v_clinic AND b.id = v_batch1 AND b.from_day = DATE '2024-02-01'
                        AND b.to_day = DATE '2024-02-29' AND (b.stats ->> 'lines')::integer = 8
                        AND b.replaced_by_batch IS NULL) THEN
      v_fail := array_append(v_fail, 'Macro yüklemesi: ' || left(v_j::text, 1000));
    END IF;
    v_j := public.fin_hk_import_macro(v_batch1, DATE '2024-02-01', DATE '2024-02-29', v_lines, v_pieces,
                                      ARRAY['islem.xls', 'odeme.xls'], false);
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false)
       OR (v_j ->> 'lines')::integer IS DISTINCT FROM 8
       OR (SELECT count(*) FROM public.fin_hk_lines l WHERE l.clinic_id = v_clinic) <> 8
       OR (SELECT count(*) FROM public.fin_hk_import_batches b WHERE b.clinic_id = v_clinic) <> 1 THEN
      v_fail := array_append(v_fail, 'Macro yüklemesi tekrar deneme: ' || left(v_j::text, 500));
    END IF;

    -- February as R. A: cash 300.000; card 305.000 − 15 % = 259.250; transfer 210.000 all implant → 0; unpaid 610.000
    -- − 15 % = 518.500; base 1.077.750 × 20 % = 215.550. O: 165.000 × 45 % = 74.250 (no 'unpaid' bucket). S: 2 ×
    -- 12.345 + 1 × 23.456 = 48.146. B: implant 2 (a group piece + the manual one) × 34.567 = 69.134, sinus 0. Owner:
    -- 5 % of 1.750.000 (every line, the clinic's and the outside doctor's too) = 87.500. Warnings: A's implant piece
    -- (UNRULED_PIECES), the clinic's piece (UNASSIGNED_PIECES); no UNRULED_LINES for the doctor-less lines.
    v_w := jsonb_build_object('code', 'UNRULED_PIECES', 'doctor_id', v_a_doc, 'doctor_name', 'Öz denetim Hekim A',
                              'qty', 1);
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 1750000
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
            v_w,
            jsonb_build_object('code', 'UNASSIGNED_PIECES', 'count', 1, 'groups', jsonb_build_array(
              jsonb_build_object('proc_group_id', v_g_ext, 'name', 'Çekim', 'count', 1))))
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_own::text AND (p ->> 'total_cents')::bigint = 87500)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                      WHERE (l ->> 'ext_doctor') = 'KLİNİK' AND (l -> 'doctor_id') = 'null'::jsonb
                        AND (l -> 'rule_id') = 'null'::jsonb AND (l ->> 'basis') = 'production'
                        AND (l ->> 'procedure') = 'Diş Çekimi' AND (l ->> 'proc_group_name') = 'Çekim'
                        AND (l ->> 'tooth') = '18' AND (l ->> 'macro_patient_no') = '1004')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p -> 'doctor_id') = 'null'::jsonb AND (p ->> 'is_unassigned')::boolean
                        AND (p ->> 'proc_group_name') = 'Çekim' AND (p ->> 'ext_doctor') = 'KLİNİK'
                        AND (p ->> 'batch_id') = v_batch1::text) THEN
      v_fail := array_append(v_fail, 'şubat (hazırlayıcı): ' || left(v_j::text, 1500));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_a::text;
    v_c := v_p #> '{components,0}';
    IF (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 215550
       OR (v_c ->> 'base_cents')::bigint IS DISTINCT FROM 1077750
       OR (v_c #>> '{by_method,unpaid,gross}')::bigint IS DISTINCT FROM 610000
       OR (v_c #>> '{by_method,unpaid,deduction}')::bigint IS DISTINCT FROM 91500
       OR (v_c #>> '{by_method,unpaid,deduct_bp}')::integer IS DISTINCT FROM 1500
       OR (v_c #>> '{by_method,transfer,eligible}')::bigint IS DISTINCT FROM 0
       OR (v_c #>> '{by_method,card,deduction}')::bigint IS DISTINCT FROM 45750 THEN
      v_fail := array_append(v_fail, 'şubat A: ' || coalesce(left(v_p::text, 800), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_o::text;
    IF (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 74250
       OR coalesce((v_p #> '{components,0,by_method}') ? 'unpaid', true)
       OR (v_p #>> '{components,0,by_method,cash,gross}')::bigint IS DISTINCT FROM 165000 THEN
      v_fail := array_append(v_fail, 'şubat O: ' || coalesce(left(v_p::text, 800), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_s::text;
    IF (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 48146
       OR (SELECT string_agg((c ->> 'kind') || ':' || (c ->> 'proc_group_name') || ':' || (c ->> 'qty') || ':'
                             || (c ->> 'amount_cents'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_p -> 'components') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'procedure_piece:Çekim:2:24690,procedure_piece:İmplant:1:23456'
       OR (v_p #>> '{components,0,proc_group_id}') IS DISTINCT FROM v_g_ext::text
       OR (v_p #>> '{components,0,lines_count}')::integer IS DISTINCT FROM 2 THEN
      v_fail := array_append(v_fail, 'şubat S: ' || coalesce(left(v_p::text, 800), '-'));
    END IF;
    SELECT p INTO v_p FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_b::text;
    IF (v_p ->> 'total_cents')::bigint IS DISTINCT FROM 69134
       OR (SELECT string_agg((c ->> 'kind') || ':' || (c ->> 'qty') || ':' || (c ->> 'amount_cents'), ','
                             ORDER BY o)
           FROM jsonb_array_elements(v_p -> 'components') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'implant_piece:2:69134,procedure_piece:0:0'
       OR (v_p #> '{components,0}') ? 'proc_group_id' THEN
      v_fail := array_append(v_fail, 'şubat B: ' || coalesce(left(v_p::text, 800), '-'));
    END IF;

    -- R: the clinic's piece goes to S (retry, stale version, both doctor and "Hakediş yok", a manual piece refused).
    SELECT p.id INTO v_piece_k
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.voided_at IS NULL AND p.doctor_id IS NULL;
    v_j := public.fin_hk_assign_piece(v_piece_k, 1, v_s_doc, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,doctor_id}') IS DISTINCT FROM v_s_doc::text
       OR coalesce((v_j #>> '{record,is_unassigned}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'işlem atama: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_assign_piece(v_piece_k, 1, v_s_doc, false);
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'işlem atama tekrar deneme: ' || left(v_j::text, 500));
    END IF;
    -- A piece of a Macro doctor mapped to a DentOS doctor (S's extraction) is not assigned here.
    SELECT p.id, p.version INTO v_piece_s, v_ver
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.source = 'import' AND p.voided_at IS NULL AND p.ext_doctor = 'Dr. Cerrah'
      AND p.tooth = '38';
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_assign_piece(%L, 1, NULL, true)', v_piece_k),
      format('SELECT public.fin_hk_assign_piece(%L, 2, %L, true)', v_piece_k, v_s_doc),
      format('SELECT public.fin_hk_assign_piece(%L, 1, %L, false)', v_piece_m, v_s_doc),
      format('SELECT public.fin_hk_assign_piece(%L, 2, %L, false)', v_piece_k, gen_random_uuid()),
      format('SELECT public.fin_hk_assign_piece(%L, %s, %L, false)', v_piece_s, v_ver, v_b_doc),
      format('SELECT public.fin_hk_assign_piece(%L, %s, NULL, true)', v_piece_s, v_ver)];
    v_msgs := ARRAY[
      'Kayıt başka bir ekranda değişti. Listeyi yenileyin.',
      'Hekim seçildiğinde "Hakediş yok" seçilemez.',
      'Yalnızca Macro''dan yüklenen işlemlere hekim atanır.',
      'Hekim bulunamadı.',
      'Yalnızca Macro''da klinik adına gelen işlemlere hekim atanır; diğerleri Macro''da düzeltilip yeniden yüklenir.',
      'Yalnızca Macro''da klinik adına gelen işlemlere hekim atanır; diğerleri Macro''da düzeltilip yeniden yüklenir.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'işlem atama doğrulaması: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    -- The assigned clinic piece can still be changed: "Hakediş yok", then back to S.
    v_j := public.fin_hk_assign_piece(v_piece_k, 2, NULL, true);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #> '{record,doctor_id}') IS DISTINCT FROM 'null'::jsonb
       OR NOT coalesce((v_j #>> '{record,assigned_none}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'atanmış klinik işlemini değiştirme: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_assign_piece(v_piece_k, (v_j #>> '{record,version}')::integer, v_s_doc, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,doctor_id}') IS DISTINCT FROM v_s_doc::text
       OR coalesce((v_j #>> '{record,assigned_none}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'klinik işlemini yeniden atama: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(v_w)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'total_cents')::bigint = 60491) THEN
      v_fail := array_append(v_fail, 'atamadan sonra şubat: ' || left(v_j::text, 1000));
    END IF;

    -- Imported rows are not edited through the manual forms.
    SELECT l.id, l.version INTO v_line_id, v_ver
    FROM public.fin_hk_lines l
    WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL AND l.method = 'cash' AND l.patient_ref = 'macro:1001';
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_save_line(%L, %s, DATE ''2024-02-05'', %L, ''Hasta Bir'', NULL, ''cash'', ''TRY'', '
             '400000, NULL, NULL, NULL, '''')', v_line_id, v_ver, v_a_doc),
      format('SELECT public.fin_hk_save_piece(%L, 2, DATE ''2024-02-12'', %L, ''Hasta Dört'', NULL, 1, '''')',
             v_piece_k, v_s_doc)];
    v_msgs := ARRAY[
      'Macro''dan yüklenen satır burada değiştirilemez. Macro''da düzeltip aralığı yeniden yükleyin ya da satırı iptal edin.',
      'Macro''dan yüklenen işlem burada değiştirilemez; hekimini "Ata" ile seçin. Başka bir düzeltme için Macro''da düzeltip aralığı yeniden yükleyin ya da işlemi iptal edin.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'Macro kaydı düzenleme: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- R: re-import of February with more of 'Hasta Bir' paid (cash 400.000, unpaid 400.000). The batch-1 rows are
    -- voided, batch 1 is replaced, S keeps the clinic's piece. A: cash 400.000 + card 259.250 + unpaid 510.000 −
    -- 76.500 = 1.092.750 × 20 % = 218.550; the clinic total is unchanged.
    v_lines := jsonb_set(jsonb_set(v_lines, '{0,amount_cents}', '400000'::jsonb), '{1,amount_cents}', '400000'::jsonb);
    v_j := public.fin_hk_import_macro(v_batch2, DATE '2024-02-01', DATE '2024-02-29', v_lines, v_pieces,
                                      ARRAY['islem.xls', 'odeme.xls'], false);
    IF (v_j ->> 'replaced_lines')::integer IS DISTINCT FROM 8
       OR (v_j ->> 'replaced_pieces')::integer IS DISTINCT FROM 7
       OR (v_j ->> 'replaced_batches')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'carried_assignments')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'unassigned_pieces')::integer IS DISTINCT FROM 0
       OR (SELECT count(*) FROM public.fin_hk_lines l
           WHERE l.clinic_id = v_clinic AND l.voided_at IS NOT NULL AND l.void_reason = 'Yeniden yüklendi'
             AND l.batch_id = v_batch1) <> 8
       OR (SELECT count(*) FROM public.fin_hk_lines l WHERE l.clinic_id = v_clinic AND l.voided_at IS NULL) <> 8
       OR (SELECT count(*) FROM public.fin_hk_pieces p
           WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.source = 'import') <> 7
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_batch2
                        AND p.ext_doctor = 'KLİNİK' AND p.doctor_id = v_s_doc)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_import_batches b
                      WHERE b.clinic_id = v_clinic AND b.id = v_batch1 AND b.replaced_by_batch = v_batch2) THEN
      v_fail := array_append(v_fail, 'Macro yeniden yükleme: ' || left(v_j::text, 1000));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j ->> 'clinic_total_cents')::bigint IS DISTINCT FROM 1750000
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(v_w)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'total_cents')::bigint = 218550)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'total_cents')::bigint = 60491) THEN
      v_fail := array_append(v_fail, 'yeniden yüklemeden sonra şubat: ' || left(v_j::text, 1000));
    END IF;
    v_j := public.fin_hk_reference();
    IF jsonb_array_length(v_j -> 'proc_groups') <> 3
       OR jsonb_array_length(v_j -> 'ext_doctors') <> 7
       OR jsonb_array_length(v_j -> 'import_batches') <> 2
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'import_batches') b
                      WHERE (b ->> 'id') = v_batch2::text AND (b ->> 'lines')::integer = 8
                        AND (b -> 'replaced_by_batch') = 'null'::jsonb
                        AND (b -> 'file_names') = '["islem.xls", "odeme.xls"]'::jsonb)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'import_batches') b
                      WHERE (b ->> 'id') = v_batch1::text AND (b ->> 'replaced_by_batch') = v_batch2::text)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                      WHERE (r ->> 'kind') = 'procedure_piece' AND (r ->> 'proc_group_name') = 'Sinüs')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                      WHERE (r ->> 'id') = v_rule_a::text AND (r ->> 'deduct_unpaid_bp')::integer = 1500) THEN
      v_fail := array_append(v_fail, 'hakediş referansı: ' || left(v_j::text, 1000));
    END IF;

    -- Owner: February closed (A's implant piece accepted as unruled). Procedure pieces in the descriptions.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_close_month(DATE '2024-02-01', 0, true);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR jsonb_array_length(v_j -> 'statements') <> 5
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.doctor_id = v_s_doc
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || cp.id::text || ':2024-02'
                        AND e.amount_cents = 60491
                        AND e.description = 'DentOS hakediş 2024-02: işlem başı Çekim 3 × 123,45 TL = 370,35 TL; '
                                            || 'işlem başı İmplant 1 × 234,56 TL = 234,56 TL')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.doctor_id = v_b_doc
                      WHERE e.clinic_id = v_clinic AND e.cancelled_at IS NULL
                        AND e.source_key = 'entitlement:' || cp.id::text || ':2024-02'
                        AND e.amount_cents = 69134
                        AND e.description = 'DentOS hakediş 2024-02: implant 2 × 345,67 TL = 691,34 TL') THEN
      v_fail := array_append(v_fail, 'şubat kapatma: ' || left(v_j::text, 1000));
    END IF;

    -- R after the close: no import into February or before it, no assignment there.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    SELECT p.id, p.version INTO v_piece_k, v_ver
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_batch2 AND p.ext_doctor = 'KLİNİK';
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-02-01'', DATE ''2024-02-29'', %L, '
             '%L, ARRAY[]::text[], true)', v_lines, v_pieces),
      'SELECT public.fin_hk_import_macro(gen_random_uuid(), DATE ''2024-01-01'', DATE ''2024-01-31'', ''[]''::jsonb, '
        || '''[]''::jsonb, ARRAY[]::text[], false)',
      format('SELECT public.fin_hk_assign_piece(%L, %s, NULL, true)', v_piece_k, v_ver)];
    v_msgs := ARRAY[
      'Seçilen aralıkta kapatılmış bir ay var (02.2024). Macro yüklemesi yalnızca açık aylara yapılabilir.',
      'Seçilen aralıktan sonraki bir ay kapatıldı (02.2024). Kapatılmış aydan önceki günler artık yüklenemez.',
      'Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'kapalı ay Macro: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- March (R), patient keys. Before the import: a reception mark by name for 'Hasta Yirmi' (a child by birth date)
    -- and for 'Hasta Yirmi Dört', and O's lab cost for 'Hasta Yirmi Beş'. The import keeps the name keys of 'Hasta
    -- Yirmi' and 'Hasta Yirmi Beş' (their 'macro:' keys are unused), so the child mark applies and O's lab is taken
    -- first from the imported payment (90.000 − 30.000 = 60.000 × 45 % = 27.000; TL cents). After it: a reception mark by name
    -- lands on the Macro key ('Hasta Yirmi Bir'); a mark typed with the name as its key applies to the Macro line
    -- through the name fallback ('Hasta Yirmi İki'); an exact Macro-key mark wins over a name mark ('Hasta Yirmi Üç');
    -- manual lines keep the 0032 lookup (a typed key 'X-24' takes no name mark) and a new manual line of an imported
    -- patient gets the Macro key.
    PERFORM public.hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Yirmi', NULL, DATE '2016-05-01');
    PERFORM public.hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Yirmi Dört', NULL, DATE '2016-05-01');
    PERFORM public.fin_hk_save_lab_cost(v_lab, 0, DATE '2024-03-02', v_o_doc, 'Hasta Yirmi Beş', NULL, 'Lab Bir',
                                        30000, '');
    SELECT jsonb_agg(jsonb_build_object(
             'key', x.k, 'basis', x.basis, 'day', x.d, 'treatment_day', x.td, 'ext_doctor', x.ext,
             'patient_name', x.pat, 'patient_no', x.pno, 'procedure', x.op, 'tooth', x.tooth, 'method', 'cash',
             'currency', 'TRY', 'amount_cents', 90000) ORDER BY x.k)
      INTO v_lines
    FROM (VALUES
      ('m1', 'production', '2024-03-04', NULL, 'Dr. Alfa', 'Hasta Yirmi', '1020', 'Dolgu', '21'),
      ('m2', 'production', '2024-03-05', NULL, 'Dr. Alfa', 'Hasta Yirmi Bir', '1021', 'Dolgu', '22'),
      ('m3', 'production', '2024-03-06', NULL, 'Dr. Alfa', 'Hasta Yirmi İki', '1022', 'Dolgu', '23'),
      ('m4', 'production', '2024-03-07', NULL, 'Dr. Alfa', 'Hasta Yirmi Üç', '1023', 'Dolgu', '24'),
      ('m5', 'payment', '2024-03-08', '2024-02-20', 'Dr. Orto', 'Hasta Yirmi Beş', '1025', 'Tel Tedavisi', NULL)
    ) AS x(k, basis, d, td, ext, pat, pno, op, tooth);
    v_j := public.fin_hk_import_macro(v_batch3, DATE '2024-03-01', DATE '2024-03-31', v_lines, '[]'::jsonb,
                                      ARRAY['mart.xls'], false);
    IF (v_j ->> 'lines')::integer IS DISTINCT FROM 5 THEN
      v_fail := array_append(v_fail, 'mart Macro yüklemesi: ' || left(v_j::text, 500));
    END IF;
    v_j := public.hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Yirmi Bir', NULL, DATE '2016-05-01');
    IF (v_j #>> '{record,patient_ref}') IS DISTINCT FROM 'macro:1021' THEN
      v_fail := array_append(v_fail, 'yüklemeden sonra adla işaret: ' || left(v_j::text, 500));
    END IF;
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, 'hasta yirmi iki', 'Hasta Yirmi İki', NULL, false, '',
                                    DATE '2016-05-01');
    PERFORM public.hk_save_mark(gen_random_uuid(), 0, NULL, 'Hasta Yirmi Üç', NULL, NULL);
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, 'hasta yirmi üç', 'Hasta Yirmi Üç', NULL, false, '',
                                    DATE '2016-05-01');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-09', v_a_doc, 'Hasta Yirmi Dört', 'X-24',
                                    'cash', 'TRY', 50000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-10', v_a_doc, 'Hasta Yirmi Dört', NULL,
                                    'cash', 'TRY', 50000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-03-11', v_a_doc, 'hasta  yirmi bir', NULL,
                                    'cash', 'TRY', 50000, NULL, NULL, NULL, '');
    v_j := public.fin_hk_month(DATE '2024-03-01');
    IF (SELECT string_agg((l ->> 'patient_ref') || '=' || (l ->> 'resolved_segment'), ', ' ORDER BY o)
        FROM jsonb_array_elements(v_j -> 'lines') WITH ORDINALITY AS x(l, o))
       IS DISTINCT FROM 'hasta yirmi=child, macro:1021=child, macro:1022=child, macro:1023=standard, '
                        || 'hasta yirmi beş=standard, X-24=standard, hasta yirmi dört=child, macro:1021=child'
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                      WHERE (l ->> 'patient_ref') = 'hasta yirmi beş' AND (l ->> 'lab_part')::bigint = 30000
                        AND (l ->> 'macro_patient_no') = '1025' AND (l ->> 'basis') = 'payment')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_o::text AND (p ->> 'total_cents')::bigint = 27000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_lab_costs c
                      WHERE c.clinic_id = v_clinic AND c.id = v_lab AND c.patient_ref = 'hasta yirmi beş') THEN
      v_fail := array_append(v_fail, 'mart hasta anahtarları: ' || left(v_j::text, 1500));
    END IF;

    -- Self-service. S: the frozen components and the four pieces its rules count (with group / operation / tooth).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_s_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 60491
       OR jsonb_array_length(v_j -> 'pieces') <> 4
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p WHERE NOT (p ? 'proc_group_name'))
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'proc_group_name') = 'İmplant' AND (p ->> 'procedure') = 'İmplant Uygulaması'
                        AND (p ->> 'tooth') = '36')
       OR (v_j -> 'lines') IS DISTINCT FROM '[]'::jsonb
       OR position(v_b_doc::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim S şubat: ' || left(v_j::text, 1000));
    END IF;
    -- B: the implant-type pieces only (the group's and the manual one), not the extraction.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_b_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF jsonb_array_length(v_j -> 'pieces') <> 2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p WHERE (p ->> 'proc_group_name') = 'Çekim')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'id') = v_piece_m::text AND NOT (p ? 'proc_group_name')) THEN
      v_fail := array_append(v_fail, 'hekim B şubat: ' || left(v_j::text, 1000));
    END IF;
    -- A: five counted lines, the unpaid ones and the Macro operation; no pieces (no piece rule).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 218550
       OR jsonb_array_length(v_j -> 'lines') <> 5
       OR (SELECT count(*) FROM jsonb_array_elements(v_j -> 'lines') l
           WHERE (l ->> 'method') = 'unpaid' AND (l ->> 'counted')::boolean) <> 2
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'lines') l
                      WHERE (l ->> 'procedure') = 'Kanal Tedavisi' AND (l ->> 'tooth') = '36'
                        AND (l ->> 'currency') = 'USD' AND (l ->> 'try_cents')::bigint = 305000)
       OR (v_j -> 'pieces') IS DISTINCT FROM '[]'::jsonb
       OR position('KLİNİK' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A şubat: ' || left(v_j::text, 1000));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v2 Macro): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p33_selfcheck_rollback';
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
