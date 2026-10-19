-- Hakediş v2.1 + v2.2: the performing doctor of ANY imported procedure piece is chosen in DentOS (kept across
-- re-imports; an outside doctor's pieces are stored as "Hakediş yok"), and a doctor's child ciro_share rule can count
-- the unmarked patients as children, with an explicit adult mark on the patient. Safe to re-run.
--
-- Contract: hakedis_spec_v21_override.md and hakedis_spec_v22_unmarked.md on top of 0033_hakedis_macro_import.sql
-- (0030, 0031, 0032 and 0033 are applied and live; not edited; the latest definition of every function replaced here
-- (0033's, else 0032's or 0030's) is copied with only the changes below). Requires 0033.
--
--  * No names, rates or amounts in this file.
--
-- v2.1, the performing doctor of an imported piece:
--  * fin_hk_pieces: macro_mode ('doctor' | 'clinic' | 'outside'; NULL on manual / clinical pieces) and macro_doctor_id
--    (the DentOS doctor a 'doctor' Macro name was mapped to; FK doctors, same clinic through fin_hk_refs) = the
--    piece's Macro default, stored at import (a later mapping change does not move it); assigned = the preparer chose
--    something else than that default (another doctor, "Hakediş yok", the doctor of a clinic piece). CHECK
--    fin_hk_pieces_override_shape: macro_mode / macro_doctor_id / assigned only on imported pieces, macro_doctor_id
--    exactly on 'doctor' pieces (an imported piece without macro_mode is tolerated: rows written by the 0033 import
--    body after a rollback, filled by the next run of this file).
--    Backfill (once: imported pieces with macro_mode NULL; idempotent): a piece without a doctor or "Hakediş yok" was
--    a clinic piece; else the current mapping of its Macro name decides ('doctor' with the same doctor: 'doctor';
--    'clinic': 'clinic'), else the row itself (never assigned, i.e. version 1 (live) / 2 (voided): the import's
--    doctor, 'doctor'; else 'clinic'). 'doctor': macro_doctor_id = doctor_id, assigned false; 'clinic': assigned =
--    doctor_id IS NOT NULL OR assigned_none. Only these three columns change (no figure moves), so the backfill
--    bypasses fin_hk_guard (closed months, voided rows) and fin_touch (version / updated_* stay); fin_hk_refs and the
--    audit trigger run. Both triggers are enabled again in the same transaction (checked below).
--  * fin_hk_assign_piece(p_id, p_version, p_doctor_id, p_none) (same signature; 'finance' or 'hakedis_prepare'; open
--    months; the import lock, version, closed-month, doctor-in-clinic and "both" checks and the already_saved retry
--    kept): ANY live imported piece. p_doctor_id → that doctor; p_none → no doctor, "Hakediş yok"; neither → the Macro
--    default ('doctor': macro_doctor_id; 'clinic': unassigned; 'outside': "Hakediş yok"). assigned = the result
--    differs from the default. The 0033 refusal ("Yalnızca Macro'da klinik adına gelen ...") is gone. Only the piece
--    moves: the revenue lines stay with the Macro doctor.
--  * fin_hk_import_macro (same signature, 0033 body): an outside doctor's rows of a grouped operation are stored
--    (doctor NULL, assigned_none true: "Hakediş yok"); macro_mode / macro_doctor_id stored on every new piece; the
--    carry-over covers every Macro doctor mode: a new row takes doctor_id / assigned_none of the live old row with the
--    same key (day, Macro doctor, patient file number (else key), operation, tooth; duplicates in order) when that row
--    is assigned (its assigned recomputed against the new default). A changed Macro doctor is another key: the new
--    default applies (a fix in Macro wins). A new row whose key has no live old row left but a row voided by a user
--    (void_reason other than 'Yeniden yüklendi') is stored live (no automatic void) and listed in returned_voided.
--  * Compute unchanged (pieces count by doctor_id; UNASSIGNED_PIECES = doctor NULL and not "Hakediş yok").
--
-- v2.2, unmarked patients and the adult mark:
--  * fin_hk_rules.unmarked_default (boolean, default false; CHECK fin_hk_rules_unmarked_default: only on a ciro_share
--    rule of segment 'child'): "İşaretsiz hastalar bu gruba girer".
--  * fin_hk_patient_marks.is_adult (boolean, default false; CHECK fin_hk_patient_marks_child_adult: not both).
--  * The segment of a line (and of a lab cost on its day), in ONE place (fin__hk_segment_src, mapped by
--    fin__hk_segment): the line's own segment ('line'); the mark's own doctor = the line's doctor ('own'); the mark's
--    birth date ('birth_date': child while younger than the clinic's limit); the child flag ('child_mark'); the adult
--    flag ('adult_mark' → standard); no child / adult information (no mark, or a mark with only another doctor as own
--    doctor) → 'child' when the line's doctor has an active child ciro_share rule with unmarked_default in the month
--    ('unmarked_default'), else 'standard' ('none'). Without the new flags the result is the 0030 one; a doctor
--    without a child rule falls back to the standard rule as before.
--  * fin_hk_save_rule + trailing p_unmarked_default boolean DEFAULT NULL (finance writers only; refused on any other
--    kind / segment; NULL keeps the saved flag of a child ciro_share rule, else false). fin_hk_save_mark + trailing
--    p_is_adult boolean DEFAULT NULL (finance and hakedis_prepare; refused together with p_is_child; NULL keeps the
--    saved flag unless the patient is now a child). Both 0033 functions are dropped and recreated (a new parameter
--    list would be an overload); callers of the 0033 parameter lists keep working. hk_save_mark (reception) keeps its
--    contract (birth date / own doctor only; the flags move with a changed patient key).
--  * The closed-month lock of a mark change by a caller without 'finance' (fin__hk_mark_locked, now with the adult
--    flag before / after; hk_save_mark, fin_hk_save_mark) treats is_adult like is_child.
--  * fin__hk_eval_lines / fin__hk_eval_lab_costs (0033 bodies): + the adult flag and the doctor's unmarked default,
--    + a last column segment_source (dropped and recreated: a new result column). fin__hk_compute: warning
--    UNMARKED_AS_CHILD per doctor (informational; never blocks the close).
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400).
--
-- JSON shapes (changes against 0033; days 'YYYY-MM-DD'):
--   PieceJson       + {macro_doctor_id, macro_doctor_name, assigned, default_mode ('doctor' | 'clinic' | 'outside' |
--                   'manual')} (fin_hk_month pieces, every piece RPC record). An outside doctor's piece: doctor_id
--                   null, assigned_none true, is_unassigned false, default_mode 'outside'.
--   RuleJson        + {unmarked_default}.
--   MarkJson        + {is_adult} (fin_hk_marks, fin_hk_save_mark); reception MarkDeskJson + {is_adult} (hk_marks_list,
--                   hk_save_mark).
--   fin_hk_month    lines[] and lab_costs[] + {segment_source: 'line' | 'own' | 'birth_date' | 'child_mark' |
--                   'adult_mark' | 'unmarked_default' | 'none'} next to resolved_segment (null where resolved_segment
--                   is null: a voided row).
--   Warning         + {code: 'UNMARKED_AS_CHILD', doctor_id, doctor_name, patients (distinct patient keys), lines} (ord
--                   8, after UNASSIGNED_PIECES; one per doctor with lines whose segment_source is 'unmarked_default').
--   fin_hk_import_macro()  ImportSummary changes: pieces (stored rows) and pieces_by_group include the outside doctors'
--                   rows; skipped_pieces = rows of ignored Macro doctors only; ungrouped_pieces = rows of an
--                   operation without a group of a 'doctor' / 'clinic' / 'outside' Macro doctor; carried_assignments =
--                   new rows that took an assigned old row's choice (every mode); + outside_pieces (stored rows of
--                   outside doctors, "Hakediş yok"), + returned_voided: [{n, day, ext_doctor, patient_name, patient_no,
--                   procedure, tooth, proc_group_name, qty}] (by day, n), + returned_voided_count;
--                   doctors[] + {outside_pieces, returned_voided (count), carried_assignments}.
--   hk_my_month()   pieces[] + {ext_doctor, macro_doctor_id, macro_doctor_name, assigned, default_mode} on an imported
--                   piece (the caller's own pieces only, as before: an overridden piece moves to the chosen doctor).
--
-- RUNBOOK (production is the only database):
--   1. Quiet moment (a few seconds): fin_hk_pieces, fin_hk_rules and fin_hk_patient_marks get new columns and
--      constraints in this transaction. SQL editor → New query → paste this file ALONE → Run. One transaction; the
--      self-checks at the end (including a replay in a temporary clinic that is always rolled back) undo everything on
--      any failure.
--   2. Deploy the web build afterwards (until step 1 the new parameters fail with the RPC error; the existing pages
--      keep working: fin_hk_save_rule and fin_hk_save_mark still accept the 0033 parameters).
--   Re-running 0030 – 0033 later puts back older bodies and the 0033 fin_hk_save_rule / fin_hk_save_mark next to
--   this file's (fin__harden_privileges refuses the overload, so such a re-run fails and rolls back): re-run this file
--   instead.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Data: nothing must be undone (outside doctors' pieces are "Hakediş yok" rows, overrides are plain doctor_id
--       values; both stay valid under 0033).
--   (b) DROP FUNCTION public.fin_hk_save_rule(uuid, integer, uuid, uuid, text, text, integer, bigint, integer,
--       integer, integer, integer, date, date, text, integer, uuid, boolean), public.fin_hk_save_mark(uuid, integer,
--       text, text, uuid, boolean, text, date, boolean), public.fin__hk_segment(text, uuid, date, uuid, date, boolean,
--       boolean, boolean, integer), public.fin__hk_mark_locked(uuid, text, uuid, uuid, date, date, boolean, boolean,
--       boolean, boolean), public.fin__hk_segment_src(text, uuid, uuid, date, boolean, boolean, boolean),
--       public.fin__hk_eval_lines(uuid, date), public.fin__hk_eval_lab_costs(uuid, date); then re-run the 0030
--       definitions of fin__hk_segment, fin__hk_mark_locked, fin__trg_hk_refs, fin__hk_mark_json and
--       fin__hk_mark_desk_json, the 0032 definition of fin__hk_month_json and the 0033 definitions of
--       fin__hk_rule_json, fin__hk_piece_json, fin__hk_eval_lines, fin__hk_eval_lab_costs, fin__hk_compute,
--       fin_hk_save_rule, fin_hk_save_mark, hk_save_mark, fin_hk_assign_piece, fin_hk_import_macro and hk_my_month.
--       Then run SELECT public.fin__harden_privileges(); (the recreated functions get PostgreSQL's default PUBLIC
--       EXECUTE back; CREATE OR REPLACE keeps the ACL of the others, hk_save_mark and hk_my_month included).
--   (c) Then DROP CONSTRAINT fin_hk_patient_marks_child_adult and fin_hk_rules_unmarked_default (the 0033
--       fin_hk_save_mark would otherwise fail when it sets the child flag of a patient marked adult, and the 0033
--       fin_hk_save_rule when it changes the kind or segment of a rule with unmarked_default), or clear the adult
--       flags and the unmarked_default flags (UPDATE public.fin_hk_patient_marks SET is_adult = false WHERE is_adult;
--       UPDATE public.fin_hk_rules SET unmarked_default = false WHERE unmarked_default;), which is harmless: the 0033
--       bodies ignore both flags. The other new columns and fin_hk_pieces_override_shape may stay (the 0033 bodies
--       ignore them; an imported piece without macro_mode is allowed) or be dropped: fin_hk_pieces_override_shape and
--       the columns fin_hk_pieces.macro_mode / macro_doctor_id / assigned, fin_hk_rules.unmarked_default,
--       fin_hk_patient_marks.is_adult. Statements of months closed after this file keep the figures computed with it.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0033 live (the functions replaced here have the 0033 bodies and signatures, or this file's on a
--     re-run), the expected columns and the triggers the backfill bypasses.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_user_id', 'clinic_today', 'has_permission',
                    'grant_staff_permission', 'fin__require_write', 'fin__harden_privileges', 'fin__month_start',
                    'fin__normalize_name', 'fin__reason', 'fin__user_name', 'audit_row_change', 'fin__hk_age',
                    'fin__hk_doctor_name', 'fin__hk_child_age_limit', 'fin__hk_birth_date', 'fin__hk_patient_name',
                    'fin__hk_patient_ref', 'fin__hk_closed_lines', 'fin__hk_close_lock', 'fin__hk_check_open',
                    'fin__hk_require_prep_write', 'fin__hk_require_prep_read', 'fin__hk_resolve_ref',
                    'fin__hk_ortho_walk', 'fin__hk_lab_alloc', 'fin__hk_ciro_lab_ids', 'fin__hk_strip_ledger',
                    'fin__hk_lab_cost_json', 'fin__hk_statement_json', 'fin__hk_adjustment_json',
                    'fin__hk_month_row_json', 'fin__hk_self_payee', 'fin__hk_payee_entry', 'fin__hk_can_mark',
                    'fin__hk_macro_row', 'fin__hk_fx_rate', 'fin_hk_month', 'fin_hk_marks', 'fin_hk_close_month',
                    'fin_hk_void_piece', 'fin_hk_save_line', 'fin_hk_save_lab_cost', 'fin_hk_save_proc_group',
                    'fin_hk_save_ext_doctor']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0030 – 0033 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.fin__trg_hk_refs()',
    'public.fin__hk_rule_json(uuid,uuid)',
    'public.fin__hk_piece_json(uuid,uuid)',
    'public.fin__hk_mark_json(uuid,uuid)',
    'public.fin__hk_mark_desk_json(uuid,uuid,boolean)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_eval_lab_costs(uuid,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.hk_save_mark(uuid,integer,text,text,uuid,date)',
    'public.fin_hk_assign_piece(uuid,integer,uuid,boolean)',
    'public.fin_hk_import_macro(uuid,date,date,jsonb,jsonb,text[],boolean)',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş fonksiyonları beklenen imzada değil (0033 uygulanmalı): %', v_missing;
  END IF;
  -- The four signatures this file changes: 0033's (0030's), or this file's on a re-run.
  IF (to_regprocedure('public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,'
                      || 'integer,integer,date,date,text,integer,uuid)') IS NULL
      AND to_regprocedure('public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,'
                          || 'integer,integer,date,date,text,integer,uuid,boolean)') IS NULL)
     OR (to_regprocedure('public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date)') IS NULL
         AND to_regprocedure('public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date,boolean)') IS NULL)
     OR (to_regprocedure('public.fin__hk_segment(text,uuid,date,uuid,date,boolean,integer)') IS NULL
         AND to_regprocedure('public.fin__hk_segment(text,uuid,date,uuid,date,boolean,boolean,boolean,integer)')
             IS NULL)
     OR (to_regprocedure('public.fin__hk_mark_locked(uuid,text,uuid,uuid,date,date,boolean,boolean)') IS NULL
         AND to_regprocedure('public.fin__hk_mark_locked(uuid,text,uuid,uuid,date,date,boolean,boolean,boolean,'
                             || 'boolean)') IS NULL) THEN
    RAISE EXCEPTION 'fin_hk_save_rule / fin_hk_save_mark / fin__hk_segment / fin__hk_mark_locked beklenen imzada değil (0033 uygulanmalı).';
  END IF;

  -- The bodies replaced below are 0033's (0032's / 0030's), or this file's, which keep these texts.
  SELECT string_agg(e.fn, ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_import_macro', '%carried_assignments%'),
    ('fin_hk_assign_piece', '%fin_hk_import:%'),
    ('fin__hk_compute', '%UNASSIGNED_PIECES%'),
    ('fin__hk_eval_lines', '%substr(l.patient_ref, 7)%'),
    ('fin__hk_eval_lab_costs', '%substr(c.patient_ref, 7)%'),
    ('fin__hk_rule_json', '%proc_group_name%'),
    ('fin__hk_piece_json', '%assigned_none%'),
    ('fin__hk_month_json', '%lab_totals%'),
    ('fin_hk_save_rule', '%procedure_piece%'),
    ('fin_hk_save_mark', '%fin__hk_resolve_ref(%'),
    ('hk_save_mark', '%fin__hk_resolve_ref(%'),
    ('hk_my_month', '%procedure_piece%'),
    ('fin__trg_hk_refs', '%own_doctor_id%'),
    ('fin__hk_mark_json', '%is_child%'),
    ('fin__hk_mark_desk_json', '%is_child%')
  ) AS e(fn, pat)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = e.fn AND p.prosrc LIKE e.pat
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Şu fonksiyonlar 0033 sürümünde değil: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_hk_pieces', 'source'), ('fin_hk_pieces', 'doctor_id'), ('fin_hk_pieces', 'assigned_none'),
    ('fin_hk_pieces', 'ext_doctor'), ('fin_hk_pieces', 'procedure'), ('fin_hk_pieces', 'tooth'),
    ('fin_hk_pieces', 'macro_patient_no'), ('fin_hk_pieces', 'proc_group_id'), ('fin_hk_pieces', 'batch_id'),
    ('fin_hk_pieces', 'version'), ('fin_hk_pieces', 'voided_at'), ('fin_hk_pieces', 'void_reason'),
    ('fin_hk_ext_doctors', 'ext_name'), ('fin_hk_ext_doctors', 'mode'), ('fin_hk_ext_doctors', 'doctor_id'),
    ('fin_hk_rules', 'kind'), ('fin_hk_rules', 'segment'), ('fin_hk_rules', 'deduct_unpaid_bp'),
    ('fin_hk_rules', 'proc_group_id'),
    ('fin_hk_patient_marks', 'own_doctor_id'), ('fin_hk_patient_marks', 'birth_date'),
    ('fin_hk_patient_marks', 'is_child'),
    ('fin_hk_import_batches', 'stats')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı (0033 uygulanmalı): %', v_missing;
  END IF;

  -- The backfill below disables these two triggers of fin_hk_pieces for its one UPDATE.
  IF (SELECT count(*) FROM pg_trigger t
      WHERE t.tgrelid = 'public.fin_hk_pieces'::regclass AND t.tgname IN ('fin_hk_guard', 'fin_touch')
        AND NOT t.tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'fin_hk_pieces tetikleyicileri (fin_hk_guard, fin_touch) beklenen gibi değil.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Guard trigger (0030 body, same signature; SECURITY DEFINER trigger function, never granted): doctor / payee
--     references of the row's clinic, + 0034: fin_hk_pieces.macro_doctor_id.
-- ---------------------------------------------------------------------------
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
  -- 0034: + the Macro default doctor of an imported piece (fin_hk_pieces.macro_doctor_id).
  FOREACH v_doctor IN ARRAY ARRAY[(v_row ->> 'doctor_id')::uuid, (v_row ->> 'own_doctor_id')::uuid,
                                  (v_row ->> 'macro_doctor_id')::uuid]
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

-- ---------------------------------------------------------------------------
-- 1.2 Tables. Pieces: the Macro default of an imported piece and the override flag (v2.1); rules: the unmarked
--     default of a child ciro_share rule; marks: the adult flag (v2.2). Every existing row stays valid (the new
--     columns are NULL / false on it until the backfill below).
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_hk_pieces
  ADD COLUMN IF NOT EXISTS macro_mode text,
  -- Same clinic: fin_hk_refs (1.1 above).
  ADD COLUMN IF NOT EXISTS macro_doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assigned boolean NOT NULL DEFAULT false;

-- Backfill of the imported pieces saved before this file (once: rows with macro_mode NULL; a re-run finds none). See
-- the header for the rules. fin_hk_guard (closed months, voided rows) and fin_touch (version / updated_*) are off for
-- this one UPDATE only: no figure changes, and a client's saved version stays valid.
ALTER TABLE public.fin_hk_pieces DISABLE TRIGGER fin_hk_guard, DISABLE TRIGGER fin_touch;
UPDATE public.fin_hk_pieces p
SET macro_mode = b.mode,
    macro_doctor_id = CASE WHEN b.mode = 'doctor' THEN p.doctor_id END,
    assigned = CASE WHEN b.mode = 'clinic' THEN p.doctor_id IS NOT NULL OR p.assigned_none ELSE false END
FROM (
  SELECT x.id,
         CASE WHEN x.doctor_id IS NULL OR x.assigned_none THEN 'clinic'
              WHEN d.mode = 'doctor' AND d.doctor_id = x.doctor_id THEN 'doctor'
              WHEN d.mode = 'clinic' THEN 'clinic'
              -- Never assigned (only fin_hk_assign_piece and a void update an imported piece): the import's doctor.
              WHEN x.version <= CASE WHEN x.voided_at IS NULL THEN 1 ELSE 2 END THEN 'doctor'
              ELSE 'clinic'
         END AS mode
  FROM public.fin_hk_pieces x
  LEFT JOIN public.fin_hk_ext_doctors d
    ON d.clinic_id = x.clinic_id AND d.ext_name = public.fin__normalize_name(x.ext_doctor)
  WHERE x.source = 'import' AND x.macro_mode IS NULL
) b
WHERE p.id = b.id;
ALTER TABLE public.fin_hk_pieces ENABLE TRIGGER fin_hk_guard, ENABLE TRIGGER fin_touch;

ALTER TABLE public.fin_hk_pieces
  -- The Macro default exists only on imported pieces; a DentOS doctor exactly on a 'doctor' one.
  DROP CONSTRAINT IF EXISTS fin_hk_pieces_override_shape,
  ADD CONSTRAINT fin_hk_pieces_override_shape CHECK (
    (macro_mode IS NULL OR macro_mode IN ('doctor', 'clinic', 'outside'))
    AND (source = 'import' OR (macro_mode IS NULL AND macro_doctor_id IS NULL AND NOT assigned))
    AND (macro_doctor_id IS NULL OR macro_mode = 'doctor')
    AND (macro_mode IS DISTINCT FROM 'doctor' OR macro_doctor_id IS NOT NULL)
  );

-- "İşaretsiz hastalar bu gruba girer": only on a ciro_share rule of the child segment.
ALTER TABLE public.fin_hk_rules
  ADD COLUMN IF NOT EXISTS unmarked_default boolean NOT NULL DEFAULT false;
ALTER TABLE public.fin_hk_rules
  DROP CONSTRAINT IF EXISTS fin_hk_rules_unmarked_default,
  ADD CONSTRAINT fin_hk_rules_unmarked_default CHECK (
    NOT unmarked_default OR (kind = 'ciro_share' AND segment = 'child')
  );

-- The adult mark; child and adult are exclusive (a birth date still decides first).
ALTER TABLE public.fin_hk_patient_marks
  ADD COLUMN IF NOT EXISTS is_adult boolean NOT NULL DEFAULT false;
ALTER TABLE public.fin_hk_patient_marks
  DROP CONSTRAINT IF EXISTS fin_hk_patient_marks_child_adult,
  ADD CONSTRAINT fin_hk_patient_marks_child_adult CHECK (NOT (is_child AND is_adult));

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (SECURITY INVOKER, never granted). Created before the SQL functions that call them (SQL
--    function bodies are checked at creation).
-- ---------------------------------------------------------------------------

-- v2.2: where the segment of a revenue line / lab cost comes from: the ONLY place of the order (fin__hk_segment maps
-- the source to the segment; fin__hk_eval_lines / fin__hk_eval_lab_costs return both):
--   'line'              the line's own segment;
--   'own'               the patient mark names the line's doctor as the patient's own doctor;
--   'birth_date'        the mark's birth date (child while younger than the clinic's limit on the day);
--   'child_mark'        the mark's child flag;
--   'adult_mark'        the mark's adult flag (→ standard);
--   'unmarked_default'  no child / adult information and the doctor's active child ciro_share rule counts unmarked
--                       patients as children (fin_hk_rules.unmarked_default; → child);
--   'none'              no child / adult information (→ standard).
-- A row without a mark passes NULLs; a doctor-less row (p_doctor NULL) is never 'own'.
CREATE OR REPLACE FUNCTION public.fin__hk_segment_src(
  p_line_segment text,
  p_doctor uuid,
  p_own_doctor uuid,
  p_birth date,
  p_is_child boolean,
  p_is_adult boolean,
  p_unmarked_child boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_line_segment IS NOT NULL THEN 'line'
              WHEN p_own_doctor = p_doctor THEN 'own'
              WHEN p_birth IS NOT NULL THEN 'birth_date'
              WHEN coalesce(p_is_child, false) THEN 'child_mark'
              WHEN coalesce(p_is_adult, false) THEN 'adult_mark'
              WHEN coalesce(p_unmarked_child, false) THEN 'unmarked_default'
              ELSE 'none'
         END
$$;

-- Segment of a revenue line / lab cost (0030 body, new signature: + p_is_adult, p_unmarked_child): the source from
-- fin__hk_segment_src mapped to the segment ('birth_date': 'child' while younger than the clinic's limit on the day,
-- else 'standard'). With p_is_adult and p_unmarked_child false (or NULL) it is the 0030 result. The 0030 function is
-- dropped first (a new parameter list would be an overload); its only callers are the two evaluations below.
DROP FUNCTION IF EXISTS public.fin__hk_segment(text, uuid, date, uuid, date, boolean, integer);
CREATE OR REPLACE FUNCTION public.fin__hk_segment(
  p_line_segment text,
  p_doctor uuid,
  p_day date,
  p_own_doctor uuid,
  p_birth date,
  p_is_child boolean,
  p_is_adult boolean,
  p_unmarked_child boolean,
  p_child_age_limit integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE public.fin__hk_segment_src(p_line_segment, p_doctor, p_own_doctor, p_birth, p_is_child, p_is_adult,
                                         p_unmarked_child)
           WHEN 'line' THEN p_line_segment
           WHEN 'own' THEN 'own'
           WHEN 'birth_date' THEN
             CASE WHEN public.fin__hk_age(p_birth, p_day) < p_child_age_limit THEN 'child' ELSE 'standard' END
           WHEN 'child_mark' THEN 'child'
           WHEN 'unmarked_default' THEN 'child'
           ELSE 'standard'
         END
$$;

-- Lock of a mark change by a caller without 'finance' (0030 body, new signature: + p_adult_before, p_adult_after): a
-- new own doctor is locked when the old or the new own doctor has a live line / lab cost of the patient in a closed
-- month; a new birth date, child flag or (0034) adult flag when the patient has any. Dropped first (overload); callers:
-- fin_hk_save_mark and hk_save_mark below.
DROP FUNCTION IF EXISTS public.fin__hk_mark_locked(uuid, text, uuid, uuid, date, date, boolean, boolean);
CREATE OR REPLACE FUNCTION public.fin__hk_mark_locked(
  p_clinic uuid,
  p_ref text,
  p_own_before uuid,
  p_own_after uuid,
  p_birth_before date,
  p_birth_after date,
  p_child_before boolean,
  p_child_after boolean,
  p_adult_before boolean,
  p_adult_after boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (p_own_before IS DISTINCT FROM p_own_after
          AND ((p_own_before IS NOT NULL AND public.fin__hk_closed_lines(p_clinic, p_ref, p_own_before))
               OR (p_own_after IS NOT NULL AND public.fin__hk_closed_lines(p_clinic, p_ref, p_own_after))))
      OR ((p_birth_before IS DISTINCT FROM p_birth_after
           OR coalesce(p_child_before, false) IS DISTINCT FROM coalesce(p_child_after, false)
           OR coalesce(p_adult_before, false) IS DISTINCT FROM coalesce(p_adult_after, false))
          AND public.fin__hk_closed_lines(p_clinic, p_ref, NULL))
$$;

-- ---------------------------------------------------------------------------
-- 3. Row shapes (same signatures): RuleJson + unmarked_default (0033 body); PieceJson + {macro_doctor_id,
--    macro_doctor_name, assigned, default_mode} (0033 body); MarkJson / reception MarkDeskJson + is_adult (0030
--    bodies). Without the new data the added keys are null / false ('manual' for a manual or clinical piece).
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
           'unmarked_default', r.unmarked_default,
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
           'macro_doctor_id', p.macro_doctor_id,
           'macro_doctor_name', public.fin__hk_doctor_name(p.macro_doctor_id),
           'assigned', p.assigned,
           'default_mode', CASE WHEN p.source <> 'import' THEN 'manual' ELSE coalesce(p.macro_mode, 'clinic') END,
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
           'birth_date', m.birth_date,
           'is_child', m.is_child,
           'is_adult', m.is_adult,
           'note', m.note,
           'created_at', m.created_at,
           'created_by_name', public.fin__user_name(m.created_by),
           'updated_at', m.updated_at,
           'updated_by_name', public.fin__user_name(m.updated_by))
  FROM public.fin_hk_patient_marks m
  WHERE m.clinic_id = p_clinic AND m.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.fin__hk_mark_desk_json(p_clinic uuid, p_id uuid, p_finance boolean)
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
           'birth_date', m.birth_date,
           'is_child', m.is_child,
           'is_adult', m.is_adult,
           'locked', NOT coalesce(p_finance, false) AND public.fin__hk_closed_lines(p_clinic, m.patient_ref, NULL))
  FROM public.fin_hk_patient_marks m
  WHERE m.clinic_id = p_clinic AND m.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- 3.1 Line and lab cost evaluation (0033 bodies). Changes: the mark's adult flag and the doctor's unmarked default
--     (an active child ciro_share rule of the line's doctor in the month with unmarked_default) go to fin__hk_segment;
--     a last result column segment_source (fin__hk_segment_src). The rule lookup is unchanged. A new result column
--     cannot be added by CREATE OR REPLACE: both are dropped first (their callers, fin__hk_compute,
--     fin__hk_month_json, fin__hk_ciro_lab_ids, fin__hk_lab_alloc and hk_my_month, read their columns by name).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fin__hk_eval_lines(uuid, date);
DROP FUNCTION IF EXISTS public.fin__hk_eval_lab_costs(uuid, date);

-- Every live line of the month with its resolved segment, its rule (NULL = unruled), its lab part and (0034) the
-- source of its segment.
CREATE OR REPLACE FUNCTION public.fin__hk_eval_lines(p_clinic uuid, p_month date)
RETURNS TABLE (line_id uuid, doctor_id uuid, patient_ref text, method text, try_cents bigint, implant_cents bigint,
               segment text, rule_id uuid, rule_kind text, payee_user_id uuid, lab_part_cents bigint,
               segment_source text)
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
         ln.seg_src
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

-- Every live lab cost of the month with its resolved segment, its rule and (0034) the source of its segment.
CREATE OR REPLACE FUNCTION public.fin__hk_eval_lab_costs(p_clinic uuid, p_month date)
RETURNS TABLE (lab_cost_id uuid, doctor_id uuid, patient_ref text, lab_name text, amount_cents bigint,
               segment text, rule_id uuid, rule_kind text, payee_user_id uuid, segment_source text)
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
  lc AS (
    SELECT c.id, c.doctor_id, c.patient_ref, c.lab_name, c.amount_cents,
           public.fin__hk_segment(NULL::text, c.doctor_id, c.day, m.own_doctor_id, m.birth_date, m.is_child,
                                  m.is_adult, u.doctor_id IS NOT NULL, lim.age_limit) AS seg,
           public.fin__hk_segment_src(NULL::text, c.doctor_id, m.own_doctor_id, m.birth_date, m.is_child,
                                      m.is_adult, u.doctor_id IS NOT NULL) AS seg_src
    FROM public.fin_hk_lab_costs c
    CROSS JOIN (SELECT public.fin__hk_child_age_limit(p_clinic) AS age_limit) lim
    LEFT JOIN LATERAL (
      -- 0033: the mark of the row's own key; a Macro key ('macro:' || file number) without one takes the mark keyed by
      -- the bare file number, else the mark of the normalized patient name (marks entered before the import).
      SELECT mk.own_doctor_id, mk.birth_date, mk.is_child, mk.is_adult
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
    LEFT JOIN udf u ON u.doctor_id = c.doctor_id
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
         x.payee_user_id,
         lc.seg_src
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
-- 4. Calculation (0033 body, same signature). Change: warning UNMARKED_AS_CHILD {doctor_id, doctor_name, patients,
--    lines} (ord 8, after UNASSIGNED_PIECES), one per doctor with lines whose segment comes from the unmarked default.
--    The figures follow fin__hk_eval_lines (the segments); pieces still count by doctor_id. Without unmarked defaults
--    and adult marks the result is the 0033 one.
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

-- One month for the Hakediş screens (0032 body, same signature) + 0034: lines[] and lab_costs[] + segment_source.
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
-- 5. RPCs (SECURITY DEFINER, search_path = public; fin_* granted to authenticated by fin__harden_privileges).
-- ---------------------------------------------------------------------------

-- Payee rule (finance writers only; 0033 body) + 0034: p_unmarked_default ("İşaretsiz hastalar bu gruba girer"),
-- only on a ciro_share rule of the child segment (refused elsewhere). A trailing parameter with DEFAULT NULL, so a
-- caller of the 0033 signature keeps working: an omitted flag keeps the saved one of a child ciro_share rule (false
-- for a new rule or any other kind / segment). Every 0033 check is kept. The 0033 function is dropped first (a new
-- parameter list would be an overload).
DROP FUNCTION IF EXISTS public.fin_hk_save_rule(uuid, integer, uuid, uuid, text, text, integer, bigint, integer, integer,
                                                integer, integer, date, date, text, integer, uuid);
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
  p_proc_group_id uuid DEFAULT NULL,
  p_unmarked_default boolean DEFAULT NULL)
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
  v_unmarked boolean;
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
  -- 0034 (v2.2): unmarked patients count as children only on a ciro_share rule of the child segment (NULL = keep the
  -- saved flag, set below).
  IF coalesce(p_unmarked_default, false) AND NOT (p_kind = 'ciro_share' AND p_segment = 'child') THEN
    RAISE EXCEPTION '"İşaretsiz hastalar bu gruba girer" yalnızca çocuk hasta grubunun ciro payı kuralında seçilir.';
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
  -- 0034: an omitted flag keeps the saved one of a child ciro_share rule (callers of the 0033 signature), else false.
  v_unmarked := coalesce(p_unmarked_default,
                         CASE WHEN p_kind = 'ciro_share' AND p_segment = 'child'
                                   AND v_row.kind = 'ciro_share' AND v_row.segment = 'child'
                              THEN v_row.unmarked_default END,
                         false);

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_rule_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.payee_user_id, v_row.doctor_id, v_row.kind, v_row.segment, v_row.share_bp, v_row.piece_cents,
        v_row.deduct_cash_bp, v_row.deduct_card_bp, v_row.deduct_transfer_bp, v_row.deduct_financing_bp,
        v_row.from_month, v_row.to_month, v_row.note, v_row.deduct_unpaid_bp, v_row.proc_group_id,
        v_row.unmarked_default)
       IS NOT DISTINCT FROM
       (p_payee_user_id, p_doctor_id, p_kind, p_segment, p_share_bp, p_piece_cents,
        v_cash, v_card, v_transfer, v_financing, v_from, v_to, v_note, v_unpaid, p_proc_group_id, v_unmarked) THEN
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
                                     from_month, to_month, note, deduct_unpaid_bp, proc_group_id, unmarked_default,
                                     created_by, updated_by)
    VALUES (p_id, v_clinic, p_payee_user_id, p_doctor_id, p_kind, p_segment, p_share_bp, p_piece_cents,
            v_cash, v_card, v_transfer, v_financing, v_from, v_to, v_note, v_unpaid, p_proc_group_id, v_unmarked,
            v_user, v_user)
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
        proc_group_id = p_proc_group_id,
        unmarked_default = v_unmarked
    WHERE r.clinic_id = v_clinic AND r.id = p_id;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_rule_json(v_clinic, p_id));
END;
$$;

-- Patient mark, every field ('finance' or 'hakedis_prepare'; 0033 body) + 0034: p_is_adult (refused together with
-- p_is_child; an omitted flag keeps the saved one unless the patient is now marked a child); the closed-month lock of
-- a caller without 'finance' covers the adult flag. Trailing DEFAULT NULL parameter: callers of the 0033 signature keep
-- working. The 0033 function is dropped first (overload).
DROP FUNCTION IF EXISTS public.fin_hk_save_mark(uuid, integer, text, text, uuid, boolean, text, date);
CREATE OR REPLACE FUNCTION public.fin_hk_save_mark(
  p_id uuid,
  p_version integer,
  p_patient_ref text,
  p_patient_name text,
  p_own_doctor_id uuid,
  p_is_child boolean,
  p_note text,
  p_birth_date date,
  p_is_adult boolean DEFAULT NULL)
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
  v_adult boolean;
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
  -- 0034 (v2.2): child and adult are exclusive (a birth date still decides first).
  IF coalesce(p_is_child, false) AND coalesce(p_is_adult, false) THEN
    RAISE EXCEPTION 'Hasta aynı anda çocuk ve yetişkin olarak işaretlenemez.';
  END IF;
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
  -- 0034: an omitted adult flag keeps the saved one (callers of the 0033 signature), unless the patient is now marked
  -- a child.
  v_adult := CASE WHEN v_child THEN false ELSE coalesce(p_is_adult, v_row.is_adult, false) END;

  IF p_version = 0 AND v_row.id IS NOT NULL THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_mark_json(v_clinic, p_id));
  END IF;
  IF p_version > 0 THEN
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
    END IF;
    IF (v_row.patient_ref, v_row.patient_name, v_row.own_doctor_id, v_row.birth_date, v_row.is_child, v_row.note,
        v_row.is_adult)
       IS NOT DISTINCT FROM (v_ref, v_name, p_own_doctor_id, v_birth, v_child, v_note, v_adult) THEN
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
  -- line in a closed month (a changed patient key: the mark leaves the old key and arrives at the new one); 0034: the
  -- adult flag too.
  IF NOT v_finance THEN
    PERFORM pg_advisory_xact_lock_shared(public.fin__hk_close_lock(v_clinic));
    IF v_row.id IS NOT NULL AND v_row.patient_ref IS DISTINCT FROM v_ref THEN
      v_locked := public.fin__hk_mark_locked(v_clinic, v_row.patient_ref, v_row.own_doctor_id, NULL,
                                             v_row.birth_date, NULL, v_row.is_child, false, v_row.is_adult, false)
                  OR public.fin__hk_mark_locked(v_clinic, v_ref, NULL, p_own_doctor_id, NULL, v_birth, false, v_child,
                                                false, v_adult);
    ELSE
      v_locked := public.fin__hk_mark_locked(v_clinic, v_ref, v_row.own_doctor_id, p_own_doctor_id,
                                             v_row.birth_date, v_birth, coalesce(v_row.is_child, false), v_child,
                                             coalesce(v_row.is_adult, false), v_adult);
    END IF;
    IF v_locked THEN
      RAISE EXCEPTION 'Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.';
    END IF;
  END IF;

  IF p_version = 0 THEN
    BEGIN
      INSERT INTO public.fin_hk_patient_marks (id, clinic_id, patient_ref, patient_name, own_doctor_id, birth_date,
                                               is_child, note, is_adult, created_by, updated_by)
      VALUES (p_id, v_clinic, v_ref, v_name, p_own_doctor_id, v_birth, v_child, v_note, v_adult, v_user, v_user)
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
          is_adult = v_adult,
          note = v_note
      WHERE m.clinic_id = v_clinic AND m.id = p_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Bu hasta için zaten bir işaret kaydı var.' USING ERRCODE = 'PT409';
    END;
  END IF;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_mark_json(v_clinic, p_id));
END;
$$;

-- Reception mark (0033 body, same contract: birth date / own doctor only) + 0034: the closed-month lock covers the
-- adult flag that moves with a changed patient key.
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
      -- A changed patient key: the mark leaves the old key and arrives at the new one (its child and, 0034, adult
      -- flags go with it).
      v_locked := public.fin__hk_mark_locked(v_clinic, v_row.patient_ref, v_row.own_doctor_id, NULL,
                                             v_row.birth_date, NULL, v_row.is_child, false, v_row.is_adult, false)
                  OR public.fin__hk_mark_locked(v_clinic, v_ref, NULL, p_own_doctor_id,
                                                NULL, v_birth, false, v_row.is_child, false, v_row.is_adult);
    ELSE
      v_locked := public.fin__hk_mark_locked(v_clinic, v_ref, v_row.own_doctor_id, p_own_doctor_id,
                                             v_row.birth_date, v_birth, v_row.is_child, v_row.is_child,
                                             v_row.is_adult, v_row.is_adult);
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

-- Performing doctor of an imported piece (0033 body, same signature) + 0034 (v2.1): any live imported piece of an
-- open month, whatever its Macro doctor's mode: a DentOS doctor (p_doctor_id), "Hakediş yok" (p_none) or neither (back
-- to its Macro default: the mapped doctor, unassigned, or "Hakediş yok" for an outside doctor's piece); assigned =
-- the result differs from the default (a re-import carries it). Only the piece moves (the revenue lines stay with the
-- Macro doctor). Waits for a running import of the clinic.
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
  v_def_doctor uuid;
  v_def_none boolean;
  v_doctor uuid;
  v_new_none boolean;
  v_assigned boolean;
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
  IF v_none AND p_doctor_id IS NOT NULL THEN
    RAISE EXCEPTION 'Hekim seçildiğinde "Hakediş yok" seçilemez.';
  END IF;
  IF p_doctor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctors d WHERE d.id = p_doctor_id AND d.clinic_id = v_clinic
  ) THEN
    RAISE EXCEPTION 'Hekim bulunamadı.';
  END IF;
  -- 0034 (v2.1): any imported piece. Its Macro default (stored at import, not the current mapping): a DentOS doctor's
  -- piece → that doctor, a clinic piece → unassigned, an outside doctor's piece → "Hakediş yok". Neither a doctor nor
  -- "Hakediş yok" = back to that default; assigned = the result differs from it.
  v_def_doctor := CASE WHEN v_row.macro_mode = 'doctor' THEN v_row.macro_doctor_id END;
  v_def_none := coalesce(v_row.macro_mode = 'outside', false);
  IF p_doctor_id IS NOT NULL THEN
    v_doctor := p_doctor_id;
    v_new_none := false;
  ELSIF v_none THEN
    v_doctor := NULL;
    v_new_none := true;
  ELSE
    v_doctor := v_def_doctor;
    v_new_none := v_def_none;
  END IF;
  v_assigned := (v_doctor, v_new_none) IS DISTINCT FROM (v_def_doctor, v_def_none);
  IF (v_row.doctor_id, v_row.assigned_none, v_row.assigned) IS NOT DISTINCT FROM (v_doctor, v_new_none, v_assigned) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__hk_piece_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public.fin__hk_check_open(v_clinic, v_row.day);

  UPDATE public.fin_hk_pieces p
  SET doctor_id = v_doctor,
      assigned_none = v_new_none,
      assigned = v_assigned
  WHERE p.clinic_id = v_clinic AND p.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__hk_piece_json(v_clinic, p_id));
END;
$$;

-- Macro import of a day range (0033 body, same signature) + 0034 (v2.1): an outside doctor's grouped rows are stored
-- as "Hakediş yok"; every new piece keeps its Macro default (macro_mode, macro_doctor_id); the carry-over covers every
-- Macro doctor mode (assigned old rows); a row voided by a user that comes back is stored live and listed
-- (returned_voided); summary keys as in the header. The rest is 0033's.
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
-- 6. Self-service (0033 body, same signature; still only the caller's own pieces: an overridden piece moves to the
--    chosen doctor). + 0034: {ext_doctor, macro_doctor_id, macro_doctor_name, assigned, default_mode} on an imported
--    piece.
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
--    public RPCs (fin_hk_*, incl. the recreated fin_hk_save_rule and fin_hk_save_mark) granted to authenticated,
--    internals (fin__hk_*, incl. the new fin__hk_segment_src and the recreated fin__hk_segment, fin__hk_mark_locked,
--    fin__hk_eval_lines and fin__hk_eval_lab_costs) never; plus its self-checks over every fin_* function (no
--    overloads) and table. hk_my_month and hk_save_mark keep their ACL (CREATE OR REPLACE); repeated for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_month(date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hk_save_mark(uuid, integer, text, text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_save_mark(uuid, integer, text, text, uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_n integer;
  v_j jsonb;
  v_doc uuid := '00000000-0000-0000-0000-00000000000a';
  v_other uuid := '00000000-0000-0000-0000-00000000000b';
  v_day date := DATE '2024-04-09';
BEGIN
  -- 1. Signatures: the new and recreated ones exist, the replaced parameter lists are gone (no overload), the two
  --    evaluations end with segment_source.
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin__trg_hk_refs()',
    'public.fin__hk_segment_src(text,uuid,uuid,date,boolean,boolean,boolean)',
    'public.fin__hk_segment(text,uuid,date,uuid,date,boolean,boolean,boolean,integer)',
    'public.fin__hk_mark_locked(uuid,text,uuid,uuid,date,date,boolean,boolean,boolean,boolean)',
    'public.fin__hk_rule_json(uuid,uuid)',
    'public.fin__hk_piece_json(uuid,uuid)',
    'public.fin__hk_mark_json(uuid,uuid)',
    'public.fin__hk_mark_desk_json(uuid,uuid,boolean)',
    'public.fin__hk_eval_lines(uuid,date)',
    'public.fin__hk_eval_lab_costs(uuid,date)',
    'public.fin__hk_compute(uuid,date)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,integer,integer,date,date,text,integer,uuid,boolean)',
    'public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date,boolean)',
    'public.hk_save_mark(uuid,integer,text,text,uuid,date)',
    'public.fin_hk_assign_piece(uuid,integer,uuid,boolean)',
    'public.fin_hk_import_macro(uuid,date,date,jsonb,jsonb,text[],boolean)',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL
     OR to_regprocedure('public.fin_hk_save_rule(uuid,integer,uuid,uuid,text,text,integer,bigint,integer,integer,'
                        || 'integer,integer,date,date,text,integer,uuid)') IS NOT NULL
     OR to_regprocedure('public.fin_hk_save_mark(uuid,integer,text,text,uuid,boolean,text,date)') IS NOT NULL
     OR to_regprocedure('public.fin__hk_segment(text,uuid,date,uuid,date,boolean,integer)') IS NOT NULL
     OR to_regprocedure('public.fin__hk_mark_locked(uuid,text,uuid,uuid,date,date,boolean,boolean)') IS NOT NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('hk_save_mark', 'hk_my_month')) <> 2 THEN
    RAISE EXCEPTION 'Hakediş v2.1 / v2.2 fonksiyon imzaları beklenen gibi değil: %',
      coalesce(v_bad, 'eski imza duruyor');
  END IF;
  IF pg_get_function_result(to_regprocedure('public.fin__hk_eval_lines(uuid,date)')) NOT LIKE '%, segment_source text)'
     OR pg_get_function_result(to_regprocedure('public.fin__hk_eval_lab_costs(uuid,date)'))
          NOT LIKE '%, segment_source text)' THEN
    RAISE EXCEPTION 'fin__hk_eval_lines / fin__hk_eval_lab_costs segment_source döndürmüyor.';
  END IF;

  -- 2. The helpers added or replaced here stay internal (SECURITY INVOKER except the trigger function, not callable
  --    from the API); the RPCs keep SECURITY DEFINER + search_path, callable by authenticated, never by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__trg_hk_refs', 'fin__hk_segment_src', 'fin__hk_segment', 'fin__hk_mark_locked',
                      'fin__hk_rule_json', 'fin__hk_piece_json', 'fin__hk_mark_json', 'fin__hk_mark_desk_json',
                      'fin__hk_eval_lines', 'fin__hk_eval_lab_costs', 'fin__hk_compute', 'fin__hk_month_json')
    AND ((p.prosecdef AND p.proname <> 'fin__trg_hk_refs')
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç hakediş fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_hk_save_rule', 'fin_hk_save_mark', 'hk_save_mark', 'fin_hk_assign_piece',
                      'fin_hk_import_macro', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v2.1 / v2.2 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Columns and constraints; the backfill done (no imported piece without its Macro default) and the two triggers
  --    it bypassed enabled again, with the other two.
  SELECT count(*) INTO v_n
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND ((c.table_name = 'fin_hk_pieces' AND c.column_name IN ('macro_mode', 'macro_doctor_id', 'assigned'))
         OR (c.table_name = 'fin_hk_rules' AND c.column_name = 'unmarked_default')
         OR (c.table_name = 'fin_hk_patient_marks' AND c.column_name = 'is_adult'))
    AND (c.is_nullable = 'NO') = (c.column_name IN ('assigned', 'unmarked_default', 'is_adult'));
  IF v_n <> 5
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_pieces'::regclass AND c.conname = 'fin_hk_pieces_override_shape')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_rules'::regclass AND c.conname = 'fin_hk_rules_unmarked_default')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.fin_hk_patient_marks'::regclass
                      AND c.conname = 'fin_hk_patient_marks_child_adult')
     OR NOT EXISTS (SELECT 1
                    FROM pg_constraint c
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'macro_doctor_id'
                    WHERE c.conrelid = 'public.fin_hk_pieces'::regclass AND c.contype = 'f'
                      AND c.conkey = ARRAY[a.attnum] AND c.confrelid = 'public.doctors'::regclass)
     OR EXISTS (SELECT 1 FROM public.fin_hk_pieces p WHERE p.source = 'import' AND p.macro_mode IS NULL)
     OR (SELECT count(*) FROM pg_trigger t
         WHERE t.tgrelid = 'public.fin_hk_pieces'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
           AND t.tgname IN ('fin_hk_guard', 'fin_touch', 'fin_hk_refs', 'audit_row_change')) <> 4 THEN
    RAISE EXCEPTION 'Hakediş v2.1 / v2.2 tablo değişiklikleri beklenen gibi değil.';
  END IF;

  -- 4. The segment order (v2.2), in one place: the line's segment, own, birth date (beats both flags), child flag,
  --    adult flag, the doctor's unmarked default; another doctor's own alone is no information.
  IF public.fin__hk_segment_src(NULL, v_doc, NULL, NULL, NULL, NULL, true) IS DISTINCT FROM 'unmarked_default'
     OR public.fin__hk_segment(NULL, v_doc, v_day, NULL, NULL, NULL, NULL, true, 14) IS DISTINCT FROM 'child'
     OR public.fin__hk_segment_src(NULL, v_doc, NULL, NULL, false, false, false) IS DISTINCT FROM 'none'
     OR public.fin__hk_segment(NULL, v_doc, v_day, NULL, NULL, false, false, false, 14) IS DISTINCT FROM 'standard'
     OR public.fin__hk_segment_src(NULL, v_doc, NULL, NULL, false, true, true) IS DISTINCT FROM 'adult_mark'
     OR public.fin__hk_segment(NULL, v_doc, v_day, NULL, NULL, false, true, true, 14) IS DISTINCT FROM 'standard'
     OR public.fin__hk_segment_src(NULL, v_doc, NULL, NULL, true, false, true) IS DISTINCT FROM 'child_mark'
     OR public.fin__hk_segment(NULL, v_doc, v_day, NULL, NULL, true, false, false, 14) IS DISTINCT FROM 'child'
     OR public.fin__hk_segment_src(NULL, v_doc, NULL, DATE '2018-05-01', false, true, true)
          IS DISTINCT FROM 'birth_date'
     OR public.fin__hk_segment(NULL, v_doc, v_day, NULL, DATE '2018-05-01', false, true, false, 14)
          IS DISTINCT FROM 'child'
     OR public.fin__hk_segment(NULL, v_doc, v_day, NULL, DATE '2000-01-01', true, false, true, 14)
          IS DISTINCT FROM 'standard'
     OR public.fin__hk_segment(NULL, v_doc, v_day, v_doc, DATE '2018-05-01', false, true, true, 14)
          IS DISTINCT FROM 'own'
     OR public.fin__hk_segment_src(NULL, v_doc, v_doc, NULL, true, false, true) IS DISTINCT FROM 'own'
     OR public.fin__hk_segment(NULL, v_doc, v_day, v_other, NULL, false, false, true, 14) IS DISTINCT FROM 'child'
     OR public.fin__hk_segment_src(NULL, v_doc, v_other, NULL, false, false, true) IS DISTINCT FROM 'unmarked_default'
     OR public.fin__hk_segment(NULL, v_doc, v_day, v_other, NULL, false, false, false, 14) IS DISTINCT FROM 'standard'
     OR public.fin__hk_segment('standard', v_doc, v_day, v_doc, NULL, true, false, true, 14) IS DISTINCT FROM 'standard'
     OR public.fin__hk_segment_src('own', v_doc, NULL, NULL, false, false, true) IS DISTINCT FROM 'line'
     OR public.fin__hk_segment(NULL, NULL, v_day, NULL, NULL, false, false, false, 14) IS DISTINCT FROM 'standard' THEN
    RAISE EXCEPTION 'Hasta grubu sırası (v2.2) beklenen gibi değil.';
  END IF;
  -- Without an adult flag and an unmarked default the result is the 0030 one, for every combination.
  SELECT count(*) INTO v_n
  FROM (VALUES (NULL::text), ('standard'), ('child'), ('own')) AS ls(s)
  CROSS JOIN (VALUES (NULL::uuid), (v_doc), (v_other)) AS od(o)
  CROSS JOIN (VALUES (NULL::date), (DATE '2000-01-01'), (DATE '2018-05-01'), (DATE '2010-04-10')) AS bd(b)
  CROSS JOIN (VALUES (NULL::boolean), (false), (true)) AS ch(c)
  CROSS JOIN (VALUES (NULL::boolean), (false)) AS ad(a)
  CROSS JOIN (VALUES (NULL::uuid), (v_doc)) AS dr(d)
  WHERE public.fin__hk_segment(ls.s, dr.d, v_day, od.o, bd.b, ch.c, ad.a, ad.a, 14)
        IS DISTINCT FROM coalesce(ls.s,
                                  CASE WHEN od.o = dr.d THEN 'own'
                                       WHEN bd.b IS NOT NULL THEN
                                         CASE WHEN public.fin__hk_age(bd.b, v_day) < 14 THEN 'child'
                                              ELSE 'standard' END
                                       WHEN coalesce(ch.c, false) THEN 'child'
                                       ELSE 'standard' END);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'Yeni işaretler olmadan hasta grubu 0030 sonucundan farklı (% durum).', v_n;
  END IF;

  -- 5. An empty computation (runs every query of the engine once) is still the 0030 result.
  v_j := public.fin__hk_compute(gen_random_uuid(), DATE '2024-01-15');
  IF v_j IS DISTINCT FROM jsonb_build_object('month', DATE '2024-01-01', 'payees', '[]'::jsonb,
                                             'clinic_total_cents', 0, 'warnings', '[]'::jsonb) THEN
    RAISE EXCEPTION 'Boş klinik hesabı beklenen gibi değil: %', left(v_j::text, 300);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.2 Replay inside a block that is always rolled back: temporary clinic 'p34-test-hk-selfcheck-<random>' with an
--     owner (finance), surgeons S (Macro 'Dr. Cerrah', procedure_piece on an implant group) and T (procedure_piece on
--     the same group; Macro 'Dr. Tek' later), doctors A (ciro_share standard + child) and P (ciro_share standard +
--     child with unmarked_default), a reception user R ('hakedis_prepare') and an assistant Q without permissions.
--     Made-up names, operation names and amounts only; auth.uid() is simulated through request.jwt.claims (and
--     request.jwt.claim.sub / .role), as in 0030 – 0033. Month checks run as R (no ledger data, so no
--     NO_COUNTERPARTY before a close creates the counterparties).
--     v2.1 (February): the import (an outside doctor's piece stored as "Hakediş yok", an ignored doctor's skipped, an
--     operation without a group not stored, the Macro defaults stored), overrides by R and the owner (a doctor-mode
--     piece to T, "Hakediş yok" and back, the Macro doctor itself is no override, the outside piece and the clinic
--     piece to T), refusals (version, both, unknown doctor, Q and S without the permission), the figures moving
--     between S and T, a user void, the dry run and the re-import (carried overrides of the doctor / clinic / outside
--     modes, the voided piece returned and listed), the self views of T and S, a re-import with the Macro doctor
--     fixed in Macro (not carried, the new default), the close and the closed-month refusal.
--     v2.2 (March): the flag (saved, kept by a caller of the 0033 signature, refused on other kinds / segments and for
--     R), marks (adult by R, kept by a 0033-signature caller and by the reception RPC, child + adult refused), lines
--     and lab costs of P and A through every step of the order with their sources, the figures, UNMARKED_AS_CHILD,
--     the flag off and on again, the close and the closed-month lock of a new adult mark for R (the owner may).
--     Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p34-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_s_auth uuid := gen_random_uuid();
  v_s_doc uuid := gen_random_uuid();
  v_t uuid := gen_random_uuid();
  v_t_auth uuid := gen_random_uuid();
  v_t_doc uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_a_auth uuid := gen_random_uuid();
  v_a_doc uuid := gen_random_uuid();
  v_pd uuid := gen_random_uuid();
  v_pd_auth uuid := gen_random_uuid();
  v_pd_doc uuid := gen_random_uuid();
  v_r uuid := gen_random_uuid();
  v_r_auth uuid := gen_random_uuid();
  v_q uuid := gen_random_uuid();
  v_q_auth uuid := gen_random_uuid();
  v_g_imp uuid := gen_random_uuid();
  v_rule_pc uuid := gen_random_uuid();
  v_b1 uuid := gen_random_uuid();
  v_b_dry uuid := gen_random_uuid();
  v_b2 uuid := gen_random_uuid();
  v_b3 uuid := gen_random_uuid();
  v_m2 uuid := gen_random_uuid();
  v_p1 uuid;
  v_p2 uuid;
  v_p3 uuid;
  v_p4 uuid;
  v_p7 uuid;
  v_pieces jsonb;
  v_sqls text[];
  v_msgs text[];
  v_i integer;
  v_j jsonb;
  v_x jsonb;
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
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P34', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p34-sc-own-' || v_tag || '@example.invalid', true),
      (v_s, v_clinic, v_s_auth, 'doctor', 'Öz denetim Hekim S', 'p34-sc-s-' || v_tag || '@example.invalid', true),
      (v_t, v_clinic, v_t_auth, 'doctor', 'Öz denetim Hekim T', 'p34-sc-t-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p34-sc-a-' || v_tag || '@example.invalid', true),
      (v_pd, v_clinic, v_pd_auth, 'doctor', 'Öz denetim Hekim P', 'p34-sc-p-' || v_tag || '@example.invalid', true),
      (v_r, v_clinic, v_r_auth, 'reception', 'Öz denetim Banko', 'p34-sc-r-' || v_tag || '@example.invalid', true),
      (v_q, v_clinic, v_q_auth, 'assistant', 'Öz denetim Asistan Q', 'p34-sc-q-' || v_tag || '@example.invalid',
       true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_s_doc, v_clinic, v_s), (v_t_doc, v_clinic, v_t), (v_a_doc, v_clinic, v_a), (v_pd_doc, v_clinic, v_pd);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own);

    -- Owner: 'hakedis_prepare' for R, the implant group, the Macro doctor mapping and the rules.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;
    PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');
    PERFORM public.fin_hk_save_proc_group(v_g_imp, 0, 'İmplant', true, ARRAY['İmplant Uygulaması'], true, '');
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Cerrah', 'doctor', v_s_doc);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'KLİNİK', 'clinic', NULL);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dış Cerrah', 'outside', NULL);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Eski Hekim', 'ignore', NULL);
    -- 0033 parameter lists (17 / 15 arguments) keep working.
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, v_s_doc, 'procedure_piece', NULL, NULL, 10000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, v_g_imp);
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_t, v_t_doc, 'procedure_piece', NULL, NULL, 20000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, v_g_imp);
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_a, v_a_doc, 'ciro_share', 'standard', 2000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_a, v_a_doc, 'ciro_share', 'child', 3000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_pd, v_pd_doc, 'ciro_share', 'standard', 2000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    v_j := public.fin_hk_save_rule(v_rule_pc, 0, v_pd, v_pd_doc, 'ciro_share', 'child', 4000, NULL,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, NULL, true);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR NOT coalesce((v_j #>> '{record,unmarked_default}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'işaretsiz varsayılanlı çocuk kuralı: ' || left(v_j::text, 300));
    END IF;
    -- A caller of the 0033 signature (17 parameters) keeps the saved flag.
    v_j := public.fin_hk_save_rule(v_rule_pc, 1, v_pd, v_pd_doc, 'ciro_share', 'child', 4000, NULL,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, NULL);
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false)
       OR NOT coalesce((v_j #>> '{record,unmarked_default}')::boolean, false) THEN
      v_fail := array_append(v_fail, '0033 imzasıyla çocuk kuralı: ' || left(v_j::text, 300));
    END IF;
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''ciro_share'', ''standard'', 2000, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, NULL, true)', v_pd, v_pd_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''ortho_lab_first'', NULL, 2000, NULL, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, NULL, true)', v_a, v_a_doc),
      format('SELECT public.fin_hk_save_rule(gen_random_uuid(), 0, %L, %L, ''procedure_piece'', NULL, NULL, 100, '
             '0, 0, 0, 0, DATE ''2030-01-01'', NULL, '''', NULL, %L, true)', v_s, v_s_doc, v_g_imp)];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM
           '"İşaretsiz hastalar bu gruba girer" yalnızca çocuk hasta grubunun ciro payı kuralında seçilir.' THEN
        v_fail := array_append(v_fail, 'işaretsiz varsayılan reddi: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- The February treatments report (made up): S's two implants of 'Hasta Bir', the clinic's, the outside doctor's,
    -- the ignored doctor's, S's filling (no group) and S's implant of 'Hasta Altı'.
    SELECT jsonb_agg(jsonb_build_object(
             'key', x.k, 'day', x.d, 'ext_doctor', x.ext, 'patient_name', x.pat, 'patient_no', x.pno,
             'procedure', x.op, 'tooth', x.tooth, 'qty', 1) ORDER BY x.k)
      INTO v_pieces
    FROM (VALUES
      ('p1', '2024-02-05', 'Dr. Cerrah', 'Hasta Bir', '1001', 'İmplant Uygulaması', '36'),
      ('p2', '2024-02-05', 'Dr. Cerrah', 'Hasta Bir', '1001', 'İmplant Uygulaması', '46'),
      ('p3', '2024-02-06', 'KLİNİK', 'Hasta İki', '1002', 'İmplant Uygulaması', '11'),
      ('p4', '2024-02-07', 'Dış Cerrah', 'Hasta Üç', '1003', 'İmplant Uygulaması', '21'),
      ('p5', '2024-02-08', 'Eski Hekim', 'Hasta Dört', '1004', 'İmplant Uygulaması', '31'),
      ('p6', '2024-02-09', 'Dr. Cerrah', 'Hasta Beş', '1005', 'Dolgu', '16'),
      ('p7', '2024-02-10', 'Dr. Cerrah', 'Hasta Altı', '1006', 'İmplant Uygulaması', '15')
    ) AS x(k, d, ext, pat, pno, op, tooth);

    -- R: the import. Stored: S's 3 implants, the clinic's (unassigned) and the outside doctor's ("Hakediş yok").
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_import_macro(v_b1, DATE '2024-02-01', DATE '2024-02-29', '[]'::jsonb, v_pieces,
                                      ARRAY['islem.xls'], false);
    IF (v_j ->> 'pieces')::integer IS DISTINCT FROM 5
       OR (v_j ->> 'skipped_pieces')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'ungrouped_pieces')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'outside_pieces')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'unassigned_pieces')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'carried_assignments')::integer IS DISTINCT FROM 0
       OR (v_j ->> 'returned_voided_count')::integer IS DISTINCT FROM 0
       OR (v_j -> 'returned_voided') IS DISTINCT FROM '[]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'dış cerrah' AND (d ->> 'mode') = 'outside'
                        AND (d ->> 'pieces')::integer = 1 AND (d ->> 'outside_pieces')::integer = 1
                        AND (d ->> 'skipped_pieces')::integer = 0 AND (d ->> 'unassigned_pieces')::integer = 0)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'eski hekim' AND (d ->> 'mode') = 'ignore'
                        AND (d ->> 'pieces')::integer = 0 AND (d ->> 'skipped_pieces')::integer = 1)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'dr. cerrah' AND (d ->> 'pieces')::integer = 3
                        AND (d ->> 'ungrouped_pieces')::integer = 1 AND (d ->> 'outside_pieces')::integer = 0
                        AND (d ->> 'returned_voided')::integer = 0 AND (d ->> 'carried_assignments')::integer = 0)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.ext_doctor = 'Dış Cerrah'
                        AND p.doctor_id IS NULL AND p.assigned_none AND p.macro_mode = 'outside'
                        AND p.macro_doctor_id IS NULL AND NOT p.assigned)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.tooth = '36'
                        AND p.doctor_id = v_s_doc AND p.macro_mode = 'doctor' AND p.macro_doctor_id = v_s_doc
                        AND NOT p.assigned AND NOT p.assigned_none)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.ext_doctor = 'KLİNİK'
                        AND p.doctor_id IS NULL AND NOT p.assigned_none AND p.macro_mode = 'clinic'
                        AND p.macro_doctor_id IS NULL AND NOT p.assigned)
       OR EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                  WHERE p.clinic_id = v_clinic AND p.ext_doctor = 'Eski Hekim') THEN
      v_fail := array_append(v_fail, 'Macro yüklemesi: ' || left(v_j::text, 1500));
    END IF;
    SELECT p.id INTO v_p1 FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.tooth = '36';
    SELECT p.id INTO v_p2 FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.tooth = '46';
    SELECT p.id INTO v_p3 FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.tooth = '11';
    SELECT p.id INTO v_p4 FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.tooth = '21';
    SELECT p.id INTO v_p7 FROM public.fin_hk_pieces p WHERE p.clinic_id = v_clinic AND p.tooth = '15';

    -- February as R: S 3 × 100,00 = 300,00 TL; the clinic's piece unassigned; the Macro defaults in the piece rows.
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(
         jsonb_build_object('code', 'UNASSIGNED_PIECES', 'count', 1, 'groups', jsonb_build_array(
           jsonb_build_object('proc_group_id', v_g_imp, 'name', 'İmplant', 'count', 1))))
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'total_cents')::bigint = 30000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'id') = v_p4::text AND (p ->> 'default_mode') = 'outside'
                        AND (p ->> 'assigned_none')::boolean AND NOT (p ->> 'is_unassigned')::boolean
                        AND NOT (p ->> 'assigned')::boolean AND (p -> 'macro_doctor_id') = 'null'::jsonb)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'id') = v_p1::text AND (p ->> 'default_mode') = 'doctor'
                        AND (p ->> 'macro_doctor_id') = v_s_doc::text
                        AND (p ->> 'macro_doctor_name') = 'Öz denetim Hekim S' AND NOT (p ->> 'assigned')::boolean)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'id') = v_p3::text AND (p ->> 'default_mode') = 'clinic'
                        AND (p ->> 'is_unassigned')::boolean) THEN
      v_fail := array_append(v_fail, 'şubat (yüklemeden sonra): ' || left(v_j::text, 1500));
    END IF;

    -- R: S's piece of 'Hasta Bir' (tooth 36) was placed by T (retry); the other one "Hakediş yok", then back to the
    -- Macro doctor (again: already saved; choosing the Macro doctor itself is no override); the outside doctor's piece
    -- to T.
    v_j := public.fin_hk_assign_piece(v_p1, 1, v_t_doc, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,doctor_id}') IS DISTINCT FROM v_t_doc::text
       OR NOT coalesce((v_j #>> '{record,assigned}')::boolean, false)
       OR (v_j #>> '{record,macro_doctor_id}') IS DISTINCT FROM v_s_doc::text
       OR (v_j #>> '{record,default_mode}') IS DISTINCT FROM 'doctor' THEN
      v_fail := array_append(v_fail, 'Macro hekiminin işlemini değiştirme: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_assign_piece(v_p1, 1, v_t_doc, false);
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'hekim değiştirme tekrar deneme: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_assign_piece(v_p2, 1, NULL, true);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #> '{record,doctor_id}') IS DISTINCT FROM 'null'::jsonb
       OR NOT coalesce((v_j #>> '{record,assigned_none}')::boolean, false)
       OR NOT coalesce((v_j #>> '{record,assigned}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'Macro hekiminin işlemi hakediş yok: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_assign_piece(v_p2, (v_j #>> '{record,version}')::integer, NULL, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,doctor_id}') IS DISTINCT FROM v_s_doc::text
       OR coalesce((v_j #>> '{record,assigned_none}')::boolean, true)
       OR coalesce((v_j #>> '{record,assigned}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'Macro hekimine dönme: ' || left(v_j::text, 500));
    END IF;
    v_ver := (v_j #>> '{record,version}')::integer;
    v_j := public.fin_hk_assign_piece(v_p2, v_ver, NULL, false);
    v_x := public.fin_hk_assign_piece(v_p2, v_ver, v_s_doc, false);
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false)
       OR NOT coalesce((v_x ->> 'already_saved')::boolean, false)
       OR coalesce((v_x #>> '{record,assigned}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'Macro hekimine dönme tekrar: ' || left(v_j::text, 300) || ' / '
                                     || left(v_x::text, 300));
    END IF;
    v_j := public.fin_hk_assign_piece(v_p4, 1, v_t_doc, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,doctor_id}') IS DISTINCT FROM v_t_doc::text
       OR coalesce((v_j #>> '{record,assigned_none}')::boolean, true)
       OR NOT coalesce((v_j #>> '{record,assigned}')::boolean, false)
       OR (v_j #>> '{record,default_mode}') IS DISTINCT FROM 'outside' THEN
      v_fail := array_append(v_fail, 'dışarıdan hekimin işlemini atama: ' || left(v_j::text, 500));
    END IF;
    v_sqls := ARRAY[
      format('SELECT public.fin_hk_assign_piece(%L, 1, NULL, true)', v_p1),
      format('SELECT public.fin_hk_assign_piece(%L, 2, %L, true)', v_p1, v_t_doc),
      format('SELECT public.fin_hk_assign_piece(%L, 2, %L, false)', v_p1, gen_random_uuid())];
    v_msgs := ARRAY[
      'Kayıt başka bir ekranda değişti. Listeyi yenileyin.',
      'Hekim seçildiğinde "Hakediş yok" seçilemez.',
      'Hekim bulunamadı.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'işlem hekimi doğrulaması: ' || v_sqls[v_i] || ' / ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- Q (no permission) and S (a doctor) cannot choose; the owner (finance) can: the clinic's piece to T.
    FOREACH v_x IN ARRAY ARRAY[jsonb_build_object('a', v_q_auth), jsonb_build_object('a', v_s_auth)]
    LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x ->> 'a', 'role', 'authenticated')::text,
                         true);
      PERFORM set_config('request.jwt.claim.sub', v_x ->> 'a', true);
      v_state := NULL;
      BEGIN
        PERFORM public.fin_hk_assign_piece(v_p3, 1, v_t_doc, false);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      END;
      IF v_state IS DISTINCT FROM '42501' THEN
        v_fail := array_append(v_fail, 'yetkisiz işlem hekimi seçimi: ' || coalesce(v_state, '-'));
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_assign_piece(v_p3, 1, v_t_doc, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,doctor_id}') IS DISTINCT FROM v_t_doc::text
       OR NOT coalesce((v_j #>> '{record,assigned}')::boolean, false)
       OR (v_j #>> '{record,default_mode}') IS DISTINCT FROM 'clinic' THEN
      v_fail := array_append(v_fail, 'klinik işlemini atama (finans): ' || left(v_j::text, 500));
    END IF;

    -- February as R: S keeps 2 pieces (200,00 TL), T has 3 (3 × 200,00 = 600,00 TL), no warning.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j -> 'warnings') IS DISTINCT FROM '[]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'total_cents')::bigint = 20000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_t::text AND (p ->> 'total_cents')::bigint = 60000) THEN
      v_fail := array_append(v_fail, 'şubat (seçimlerden sonra): ' || left(v_j::text, 1500));
    END IF;

    -- R voids S's piece of 'Hasta Altı' by hand. The dry run of the same file: 4 live rows replaced, the 3 overrides
    -- carried (doctor, clinic and outside modes), the voided piece back and listed; nothing written.
    PERFORM public.fin_hk_void_piece(v_p7, 1, 'Hatalı kayıt');
    v_w := jsonb_build_array(jsonb_build_object(
             'n', 7, 'day', '2024-02-10', 'ext_doctor', 'Dr. Cerrah', 'patient_name', 'Hasta Altı',
             'patient_no', '1006', 'procedure', 'İmplant Uygulaması', 'tooth', '15', 'proc_group_name', 'İmplant',
             'qty', 1));
    v_j := public.fin_hk_import_macro(v_b_dry, DATE '2024-02-01', DATE '2024-02-29', '[]'::jsonb, v_pieces,
                                      ARRAY['islem.xls'], true);
    IF NOT coalesce((v_j ->> 'dry_run')::boolean, false)
       OR (v_j ->> 'pieces')::integer IS DISTINCT FROM 5
       OR (v_j ->> 'replaced_pieces')::integer IS DISTINCT FROM 4
       OR (v_j ->> 'carried_assignments')::integer IS DISTINCT FROM 3
       OR (v_j ->> 'returned_voided_count')::integer IS DISTINCT FROM 1
       OR (v_j -> 'returned_voided') IS DISTINCT FROM v_w
       OR (v_j ->> 'unassigned_pieces')::integer IS DISTINCT FROM 0
       OR (SELECT count(*) FROM public.fin_hk_pieces p
           WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_b1) <> 4
       OR EXISTS (SELECT 1 FROM public.fin_hk_import_batches b WHERE b.clinic_id = v_clinic AND b.id = v_b_dry) THEN
      v_fail := array_append(v_fail, 'Macro deneme yeniden yüklemesi: ' || left(v_j::text, 1500));
    END IF;

    -- R: the re-import. The overrides stay; the voided piece is live again with its Macro default.
    v_j := public.fin_hk_import_macro(v_b2, DATE '2024-02-01', DATE '2024-02-29', '[]'::jsonb, v_pieces,
                                      ARRAY['islem.xls'], false);
    IF (v_j ->> 'replaced_pieces')::integer IS DISTINCT FROM 4
       OR (v_j ->> 'carried_assignments')::integer IS DISTINCT FROM 3
       OR (v_j ->> 'returned_voided_count')::integer IS DISTINCT FROM 1
       OR (v_j -> 'returned_voided') IS DISTINCT FROM v_w
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'dr. cerrah' AND (d ->> 'returned_voided')::integer = 1
                        AND (d ->> 'carried_assignments')::integer = 1)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'klinik' AND (d ->> 'carried_assignments')::integer = 1)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'doctors') d
                      WHERE (d ->> 'ext_name') = 'dış cerrah' AND (d ->> 'carried_assignments')::integer = 1
                        AND (d ->> 'outside_pieces')::integer = 1)
       OR (SELECT count(*) FROM public.fin_hk_pieces p
           WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.source = 'import') <> 5
       OR (SELECT count(*) FROM public.fin_hk_pieces p
           WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_b2) <> 5
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.tooth = '36'
                        AND p.doctor_id = v_t_doc AND p.assigned AND p.macro_mode = 'doctor'
                        AND p.macro_doctor_id = v_s_doc)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.tooth = '46'
                        AND p.doctor_id = v_s_doc AND NOT p.assigned)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.tooth = '11'
                        AND p.doctor_id = v_t_doc AND p.assigned AND p.macro_mode = 'clinic')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.tooth = '21'
                        AND p.doctor_id = v_t_doc AND NOT p.assigned_none AND p.assigned
                        AND p.macro_mode = 'outside')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.tooth = '15'
                        AND p.doctor_id = v_s_doc AND NOT p.assigned) THEN
      v_fail := array_append(v_fail, 'Macro yeniden yüklemesi: ' || left(v_j::text, 1500));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF (v_j -> 'warnings') IS DISTINCT FROM '[]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'total_cents')::bigint = 20000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_t::text AND (p ->> 'total_cents')::bigint = 60000) THEN
      v_fail := array_append(v_fail, 'şubat (yeniden yüklemeden sonra): ' || left(v_j::text, 1500));
    END IF;

    -- Self views: T sees the three pieces chosen for T (S's with 'Macro: S'), S its two.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_t_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_t_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 60000
       OR jsonb_array_length(v_j -> 'pieces') <> 3
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'tooth') = '36' AND (p ->> 'assigned')::boolean
                        AND (p ->> 'macro_doctor_name') = 'Öz denetim Hekim S' AND (p ->> 'default_mode') = 'doctor'
                        AND (p ->> 'ext_doctor') = 'Dr. Cerrah')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                      WHERE (p ->> 'tooth') = '21' AND (p ->> 'assigned')::boolean
                        AND (p ->> 'default_mode') = 'outside') THEN
      v_fail := array_append(v_fail, 'hekim T şubat: ' || left(v_j::text, 1000));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_s_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 20000
       OR jsonb_array_length(v_j -> 'pieces') <> 2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'pieces') p
                  WHERE (p ->> 'tooth') = '36' OR (p ->> 'assigned')::boolean) THEN
      v_fail := array_append(v_fail, 'hekim S şubat: ' || left(v_j::text, 1000));
    END IF;

    -- R: Macro fixed: S's piece of tooth 36 now under 'Dr. Tek' (mapped to T). Another key: not carried, T by
    -- default; the clinic and outside overrides still carried; nothing returned.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    PERFORM public.fin_hk_save_ext_doctor(gen_random_uuid(), 0, 'Dr. Tek', 'doctor', v_t_doc);
    v_pieces := jsonb_set(v_pieces, '{0,ext_doctor}', '"Dr. Tek"'::jsonb);
    v_j := public.fin_hk_import_macro(v_b3, DATE '2024-02-01', DATE '2024-02-29', '[]'::jsonb, v_pieces,
                                      ARRAY['islem.xls'], false);
    IF (v_j ->> 'replaced_pieces')::integer IS DISTINCT FROM 5
       OR (v_j ->> 'carried_assignments')::integer IS DISTINCT FROM 2
       OR (v_j ->> 'returned_voided_count')::integer IS DISTINCT FROM 0
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_b3 AND p.tooth = '36'
                        AND p.ext_doctor = 'Dr. Tek' AND p.doctor_id = v_t_doc AND NOT p.assigned
                        AND p.macro_mode = 'doctor' AND p.macro_doctor_id = v_t_doc)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_b3 AND p.tooth = '11'
                        AND p.doctor_id = v_t_doc AND p.assigned)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_pieces p
                      WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_b3 AND p.tooth = '21'
                        AND p.doctor_id = v_t_doc AND p.assigned) THEN
      v_fail := array_append(v_fail, 'Macro düzeltmesinden sonra yükleme: ' || left(v_j::text, 1500));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-02-01');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                   WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'total_cents')::bigint = 20000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_t::text AND (p ->> 'total_cents')::bigint = 60000) THEN
      v_fail := array_append(v_fail, 'şubat (Macro düzeltmesinden sonra): ' || left(v_j::text, 1500));
    END IF;

    -- Owner: February closed; R can no longer choose there.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_close_month(DATE '2024-02-01', 0, true);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed' THEN
      v_fail := array_append(v_fail, 'şubat kapatma: ' || left(v_j::text, 500));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    SELECT p.id, p.version INTO v_p3, v_ver
    FROM public.fin_hk_pieces p
    WHERE p.clinic_id = v_clinic AND p.voided_at IS NULL AND p.batch_id = v_b3 AND p.tooth = '11';
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_assign_piece(v_p3, v_ver, NULL, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Bu ay kapatıldı. Düzeltmeyi açık bir aya düzeltme satırı olarak girin.' THEN
      v_fail := array_append(v_fail, 'kapalı ayda işlem hekimi: ' || coalesce(v_err, '-'));
    END IF;

    -- v2.2, March (R). R cannot save a rule (the flag is the owner's). Marks: adult (kept by a caller of the 0033
    -- signature and shown at the reception), child, birth date with the adult flag, own doctor P with the adult flag,
    -- only another doctor (A) as own doctor, birth date with the child flag; child + adult refused.
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_save_rule(v_rule_pc, 1, v_pd, v_pd_doc, 'ciro_share', 'child', 4000, NULL,
                                      0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, NULL, false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı işaretsiz varsayılan: ' || coalesce(v_state, '-'));
    END IF;
    v_j := public.fin_hk_save_mark(v_m2, 0, NULL, 'Çocuk İki', NULL, false, '', NULL, true);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR NOT coalesce((v_j #>> '{record,is_adult}')::boolean, false)
       OR coalesce((v_j #>> '{record,is_child}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'yetişkin işareti: ' || left(v_j::text, 500));
    END IF;
    v_j := public.fin_hk_save_mark(v_m2, 1, NULL, 'Çocuk İki', NULL, false, '', NULL);
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false)
       OR NOT coalesce((v_j #>> '{record,is_adult}')::boolean, false)
       OR NOT coalesce((public.fin__hk_mark_desk_json(v_clinic, v_m2, false) ->> 'is_adult')::boolean, false) THEN
      v_fail := array_append(v_fail, '0033 imzasıyla yetişkin işareti: ' || left(v_j::text, 500));
    END IF;
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Üç', NULL, true, '', NULL, NULL);
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Dört', NULL, false, '', DATE '2018-05-01', true);
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Beş', v_pd_doc, false, '', NULL, true);
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Altı', v_a_doc, false, '', NULL, NULL);
    PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Sekiz', NULL, true, '', DATE '2000-01-01', NULL);
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Dokuz', NULL, true, '', NULL, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Hasta aynı anda çocuk ve yetişkin olarak işaretlenemez.' THEN
      v_fail := array_append(v_fail, 'çocuk ve yetişkin birlikte: ' || coalesce(v_err, '-'));
    END IF;

    -- Lines (1.000,00 TL cash each, one per day) of P and A, and three lab costs.
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, x.d, x.doc, x.pat, NULL, 'cash', 'TRY', 100000, NULL, NULL,
                                    x.seg, '')
    FROM (VALUES
      (DATE '2024-03-04', v_pd_doc, 'Çocuk Bir', NULL::text),
      (DATE '2024-03-05', v_pd_doc, 'Çocuk İki', NULL),
      (DATE '2024-03-06', v_pd_doc, 'Çocuk Üç', NULL),
      (DATE '2024-03-07', v_pd_doc, 'Çocuk Dört', NULL),
      (DATE '2024-03-08', v_pd_doc, 'Çocuk Beş', NULL),
      (DATE '2024-03-09', v_pd_doc, 'Çocuk Altı', NULL),
      (DATE '2024-03-11', v_pd_doc, 'Çocuk Sekiz', NULL),
      (DATE '2024-03-12', v_pd_doc, 'Çocuk Yedi', 'standard'),
      (DATE '2024-03-13', v_a_doc, 'Çocuk Bir', NULL),
      (DATE '2024-03-14', v_a_doc, 'Çocuk Üç', NULL)
    ) AS x(d, doc, pat, seg);
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-05', v_pd_doc, 'Çocuk Bir', NULL,
                                        'Lab Bir', 10000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-06', v_pd_doc, 'Çocuk İki', NULL,
                                        'Lab Bir', 5000, '');
    PERFORM public.fin_hk_save_lab_cost(gen_random_uuid(), 0, DATE '2024-03-13', v_a_doc, 'Çocuk Bir', NULL,
                                        'Lab Bir', 7000, '');

    -- March as R. P: child 'Çocuk Bir', 'Çocuk Üç', 'Çocuk Dört', 'Çocuk Altı' 400.000 − lab 10.000 = 390.000 × 40 %
    -- = 156.000; standard (with the own line) 400.000 − lab 5.000 = 395.000 × 20 % = 79.000; total 235.000. A (no
    -- flag): standard 100.000 − 7.000 = 93.000 × 20 % = 18.600 + child 100.000 × 30 % = 30.000 = 48.600. Warning:
    -- 2 lines / 2 patients of P from the unmarked default.
    v_w := jsonb_build_object('code', 'UNMARKED_AS_CHILD', 'doctor_id', v_pd_doc, 'doctor_name', 'Öz denetim Hekim P',
                              'patients', 2, 'lines', 2);
    v_j := public.fin_hk_month(DATE '2024-03-01');
    SELECT p INTO v_x FROM jsonb_array_elements(v_j -> 'payees') p WHERE (p ->> 'payee_user_id') = v_pd::text;
    IF (SELECT string_agg((l ->> 'patient_name') || ':' || (l ->> 'resolved_segment') || ':'
                          || (l ->> 'segment_source'), ', ' ORDER BY o)
        FROM jsonb_array_elements(v_j -> 'lines') WITH ORDINALITY AS x(l, o))
       IS DISTINCT FROM 'Çocuk Bir:child:unmarked_default, Çocuk İki:standard:adult_mark, Çocuk Üç:child:child_mark, '
                        || 'Çocuk Dört:child:birth_date, Çocuk Beş:own:own, Çocuk Altı:child:unmarked_default, '
                        || 'Çocuk Sekiz:standard:birth_date, Çocuk Yedi:standard:line, Çocuk Bir:standard:none, '
                        || 'Çocuk Üç:child:child_mark'
       OR (SELECT string_agg((c ->> 'patient_name') || ':' || (c ->> 'resolved_segment') || ':'
                             || (c ->> 'segment_source'), ', ' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'lab_costs') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'Çocuk Bir:child:unmarked_default, Çocuk İki:standard:adult_mark, Çocuk Bir:standard:none'
       OR (v_j #>> '{lab_costs,0,rule_id}') IS DISTINCT FROM v_rule_pc::text
       OR (v_j -> 'warnings') IS DISTINCT FROM jsonb_build_array(v_w)
       OR (v_x ->> 'total_cents')::bigint IS DISTINCT FROM 235000
       OR (SELECT string_agg((c ->> 'segment') || ':' || (c ->> 'lines_count') || ':' || (c ->> 'amount_cents'), ','
                             ORDER BY o)
           FROM jsonb_array_elements(v_x -> 'components') WITH ORDINALITY AS x(c, o))
          IS DISTINCT FROM 'standard:4:79000,child:4:156000'
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'total_cents')::bigint = 48600) THEN
      v_fail := array_append(v_fail, 'mart (işaretsiz varsayılan açık): ' || left(v_j::text, 2000));
    END IF;

    -- The reception RPC keeps the adult flag (it sets the birth date only; an adult birth date decides first).
    v_j := public.hk_save_mark(v_m2, 1, NULL, 'Çocuk İki', NULL, DATE '1990-01-01');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR NOT coalesce((v_j #>> '{record,is_adult}')::boolean, false)
       OR (v_j #>> '{record,birth_date}') IS DISTINCT FROM '1990-01-01' THEN
      v_fail := array_append(v_fail, 'banko işareti yetişkin bayrağı: ' || left(v_j::text, 500));
    END IF;

    -- Owner: the flag off. 'Çocuk Bir' and 'Çocuk Altı' are standard ('none'), no warning; P: child 200.000 × 40 %
    -- = 80.000 + standard 600.000 − 15.000 = 585.000 × 20 % = 117.000 = 197.000. Then on again.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_save_rule(v_rule_pc, 1, v_pd, v_pd_doc, 'ciro_share', 'child', 4000, NULL,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, NULL, false);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR coalesce((v_j #>> '{record,unmarked_default}')::boolean, true) THEN
      v_fail := array_append(v_fail, 'işaretsiz varsayılanı kapatma: ' || left(v_j::text, 300));
    END IF;
    v_ver := (v_j #>> '{record,version}')::integer;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-03-01');
    IF (SELECT string_agg((l ->> 'patient_name') || ':' || (l ->> 'resolved_segment') || ':'
                          || (l ->> 'segment_source'), ', ' ORDER BY o)
        FROM jsonb_array_elements(v_j -> 'lines') WITH ORDINALITY AS x(l, o))
       IS DISTINCT FROM 'Çocuk Bir:standard:none, Çocuk İki:standard:birth_date, Çocuk Üç:child:child_mark, '
                        || 'Çocuk Dört:child:birth_date, Çocuk Beş:own:own, Çocuk Altı:standard:none, '
                        || 'Çocuk Sekiz:standard:birth_date, Çocuk Yedi:standard:line, Çocuk Bir:standard:none, '
                        || 'Çocuk Üç:child:child_mark'
       OR (v_j -> 'warnings') IS DISTINCT FROM '[]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_pd::text AND (p ->> 'total_cents')::bigint = 197000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'total_cents')::bigint = 48600) THEN
      v_fail := array_append(v_fail, 'mart (işaretsiz varsayılan kapalı): ' || left(v_j::text, 2000));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_save_rule(v_rule_pc, v_ver, v_pd, v_pd_doc, 'ciro_share', 'child', 4000, NULL,
                                   0, 0, 0, 0, DATE '2024-01-01', NULL, '', NULL, NULL, true);
    IF NOT coalesce((v_j #>> '{record,unmarked_default}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'işaretsiz varsayılanı yeniden açma: ' || left(v_j::text, 300));
    END IF;

    -- Owner: March closed. R cannot give 'Çocuk Bir' (lines in the closed month) a new adult mark; the owner can.
    v_j := public.fin_hk_close_month(DATE '2024-03-01', 0, true);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed' THEN
      v_fail := array_append(v_fail, 'mart kapatma: ' || left(v_j::text, 500));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_err := NULL;
    BEGIN
      PERFORM public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Bir', NULL, false, '', NULL, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Bu hastanın kapanmış ayda ödemesi var; değişikliği klinik sahibi yapabilir.' THEN
      v_fail := array_append(v_fail, 'kapalı ayda yetişkin işareti (hazırlayıcı): ' || coalesce(v_err, '-'));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_save_mark(gen_random_uuid(), 0, NULL, 'Çocuk Bir', NULL, false, '', NULL, true);
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR NOT coalesce((v_j #>> '{record,is_adult}')::boolean, false) THEN
      v_fail := array_append(v_fail, 'kapalı ayda yetişkin işareti (sahip): ' || left(v_j::text, 500));
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v2.1 / v2.2): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p34_selfcheck_rollback';
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
