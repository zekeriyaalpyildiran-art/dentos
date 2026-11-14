-- 0042_perio_charts.sql — periodontal charts (perio chart) on the patient card.
--
-- Owner 2026-11-14: periodontal measurements are recorded in DentOS, per patient, one chart per examination, so later
-- examinations can be compared. Six sites per tooth (vestibular and palatal / lingual: distal, middle, mesial):
-- probing depth, gingival recession (positive = margin apical to the CEJ, negative = hyperplasia), bleeding on
-- probing, plaque; per tooth: missing, implant, mobility, furcation.
--
--   perio_charts  one row per examination: patient (FK only, KVKK), exam_date, note, data (the whole chart as jsonb,
--                 shape owned by apps/web/src/lib/clinical/perio.ts), summary (figures the web computed from data at
--                 save time: BOP %, plaque %, mean PD / CAL, deep sites; shown in the list without loading data),
--                 version (optimistic lock), soft delete (deleted_at / deleted_by).
--
-- Reads and writes only through the perio_chart_* RPCs below (SECURITY DEFINER, search_path = public). Read: every
-- active staff member of the clinic (clin__require_read, same as implants). Write and delete: clin_can_write()
-- (owner, admin, doctor, assistant, or the 'clinical' permission). The table is not exposed to the API roles.
-- Audited with audit_row_change() (0019). Safe to re-run. Rollback at the bottom.

BEGIN;

CREATE TABLE IF NOT EXISTS public.perio_charts (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  exam_date date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  updated_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.users(id)
);
CREATE INDEX IF NOT EXISTS perio_charts_patient
  ON public.perio_charts (clinic_id, patient_id, exam_date DESC, created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE public.perio_charts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.perio_charts FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_row_change ON public.perio_charts;
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.perio_charts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

-- ---------------------------------------------------------------------------
-- Internals (never granted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.perio__raise(p_key text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_msg text;
BEGIN
  CASE p_key
    WHEN 'PE_DATE' THEN v_msg := 'Geçerli bir muayene tarihi girin; bugünden sonra olamaz.';
    WHEN 'PE_NOTE' THEN v_msg := 'Not en fazla 1000 karakter olabilir.';
    WHEN 'PE_DATA' THEN v_msg := 'Ölçüm verisi okunamadı. Sayfayı yenileyip tekrar deneyin.';
    WHEN 'PE_PATIENT' THEN v_msg := 'Ölçümün hastası değiştirilemez.';
    ELSE v_msg := 'Beklenmeyen hata: ' || coalesce(p_key, '(boş)');
  END CASE;
  RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = 'P0001', HINT = coalesce(p_key, '');
END;
$$;

CREATE OR REPLACE FUNCTION public.perio__json(p_id uuid, p_with_data boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', c.id,
    'patient_id', c.patient_id,
    'exam_date', c.exam_date,
    'note', c.note,
    'summary', c.summary,
    'version', c.version,
    'created_by_name', cu.full_name,
    'updated_by_name', uu.full_name,
    'created_at', c.created_at,
    'updated_at', c.updated_at
  ) || CASE WHEN p_with_data THEN jsonb_build_object('data', c.data) ELSE '{}'::jsonb END
  FROM public.perio_charts c
  LEFT JOIN public.users cu ON cu.id = c.created_by
  LEFT JOIN public.users uu ON uu.id = c.updated_by
  WHERE c.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Charts of a patient, newest first, without the chart data; plus the teeth with an active implant record
-- (patient_implants, not failed) so a new chart can start with them marked.
CREATE OR REPLACE FUNCTION public.perio_chart_list(p_patient_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
BEGIN
  IF p_patient_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.patients p WHERE p.id = p_patient_id AND p.clinic_id = v_clinic
  ) THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  RETURN jsonb_build_object(
    'can_write', public.clin_can_write(),
    'today', public.clinic_today(),
    'rows', coalesce((
      SELECT jsonb_agg(public.perio__json(c.id, false) ORDER BY c.exam_date DESC, c.created_at DESC)
      FROM public.perio_charts c
      WHERE c.clinic_id = v_clinic AND c.patient_id = p_patient_id AND c.deleted_at IS NULL
    ), '[]'::jsonb),
    'implant_teeth', coalesce((
      SELECT jsonb_agg(DISTINCT pi.tooth_fdi)
      FROM public.patient_implants pi
      WHERE pi.clinic_id = v_clinic AND pi.patient_id = p_patient_id
        AND pi.deleted_at IS NULL AND pi.status <> 'failed'
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.perio_chart_get(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
BEGIN
  IF p_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.perio_charts c WHERE c.id = p_id AND c.clinic_id = v_clinic AND c.deleted_at IS NULL
  ) THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  RETURN public.perio__json(p_id, true);
END;
$$;

-- Create (p_id not in the table yet: the client makes the id when the form opens and reuses it for retries; a retry
-- of a create that already went through finds version 1 and p_version 0 and gets CL_ALREADY_SAVED_CHANGED unless the
-- data is identical) or update (p_version must match).
CREATE OR REPLACE FUNCTION public.perio_chart_save(p_id uuid, p_patient_id uuid, p_version integer, p_exam_date date,
                                                   p_note text, p_data jsonb, p_summary jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_user uuid := public.current_app_user_id();
  v_row public.perio_charts%ROWTYPE;
  v_note text := btrim(coalesce(p_note, ''));
BEGIN
  IF p_id IS NULL THEN
    PERFORM public.perio__raise('PE_DATA');
  END IF;
  IF p_patient_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.patients p WHERE p.id = p_patient_id AND p.clinic_id = v_clinic
  ) THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF p_exam_date IS NULL OR p_exam_date > public.clinic_today() OR p_exam_date < DATE '2000-01-01' THEN
    PERFORM public.perio__raise('PE_DATE');
  END IF;
  IF char_length(v_note) > 1000 THEN
    PERFORM public.perio__raise('PE_NOTE');
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' OR jsonb_typeof(p_data -> 'teeth') IS DISTINCT FROM 'object'
     OR octet_length(p_data::text) > 120000
     OR (p_summary IS NOT NULL AND (jsonb_typeof(p_summary) <> 'object' OR octet_length(p_summary::text) > 4000)) THEN
    PERFORM public.perio__raise('PE_DATA');
  END IF;

  SELECT * INTO v_row FROM public.perio_charts c WHERE c.id = p_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.perio_charts (id, clinic_id, patient_id, exam_date, note, data, summary, version,
                                     created_by, updated_by)
    VALUES (p_id, v_clinic, p_patient_id, p_exam_date, v_note, p_data, coalesce(p_summary, '{}'::jsonb), 1,
            v_user, v_user);
    RETURN public.perio__json(p_id, true);
  END IF;

  IF v_row.clinic_id <> v_clinic OR v_row.deleted_at IS NOT NULL THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF v_row.patient_id <> p_patient_id THEN
    PERFORM public.perio__raise('PE_PATIENT');
  END IF;
  IF coalesce(p_version, 0) <> v_row.version THEN
    -- A retried create whose first attempt went through: same content is fine, anything else is a conflict.
    IF coalesce(p_version, 0) = 0 AND v_row.version = 1 AND v_row.data = p_data AND v_row.exam_date = p_exam_date
       AND v_row.note = v_note THEN
      RETURN public.perio__json(p_id, true);
    END IF;
    PERFORM public.clin__raise(CASE WHEN coalesce(p_version, 0) = 0 THEN 'CL_ALREADY_SAVED_CHANGED'
                                    ELSE 'CL_VERSION' END);
  END IF;

  UPDATE public.perio_charts
     SET exam_date = p_exam_date, note = v_note, data = p_data, summary = coalesce(p_summary, '{}'::jsonb),
         version = version + 1, updated_by = v_user, updated_at = now()
   WHERE id = p_id;
  RETURN public.perio__json(p_id, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.perio_chart_delete(p_id uuid, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_row public.perio_charts%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.perio_charts c WHERE c.id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.clinic_id <> v_clinic OR v_row.deleted_at IS NOT NULL THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF coalesce(p_version, 0) <> v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  UPDATE public.perio_charts
     SET deleted_at = now(), deleted_by = public.current_app_user_id(), version = version + 1, updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: RPCs to authenticated only; internals to nobody.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.perio__raise(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.perio__json(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.perio_chart_list(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.perio_chart_get(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.perio_chart_save(uuid, uuid, integer, date, text, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.perio_chart_delete(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.perio_chart_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.perio_chart_get(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.perio_chart_save(uuid, uuid, integer, date, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.perio_chart_delete(uuid, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- Self-checks
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'perio\_chart\_%'
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0042: SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'perio\_%' GROUP BY p.proname HAVING count(*) > 1) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0042: birden fazla sürüm: %', v_bad;
  END IF;

  IF has_table_privilege('authenticated', 'public.perio_charts', 'SELECT')
     OR has_table_privilege('anon', 'public.perio_charts', 'SELECT') THEN
    RAISE EXCEPTION '0042: perio_charts API rollerine açık';
  END IF;
  IF has_function_privilege('anon', 'public.perio_chart_list(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.perio__json(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '0042: fonksiyon yetkileri hatalı';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.perio_chart_save(uuid, uuid, integer, date, text, jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0042: perio_chart_save authenticated için açık değil';
  END IF;
END $$;

COMMIT;

-- Rollback (only while no chart worth keeping exists):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.perio_chart_delete(uuid, integer), public.perio_chart_save(uuid, uuid, integer,
--     date, text, jsonb, jsonb), public.perio_chart_get(uuid), public.perio_chart_list(uuid),
--     public.perio__json(uuid, boolean), public.perio__raise(text);
--   DROP TABLE IF EXISTS public.perio_charts;
--   COMMIT;
