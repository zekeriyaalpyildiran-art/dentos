-- Ajanda: double-booking guard on appointments, honest SMS reminders. Safe to re-run.
--
-- Requires 0004 (appointments, reminders), 0014 (their policies) and 0021 (appointments index
-- idx_appointments_clinic_scheduled_start, appointments.lead_id, leads.patient_id / deleted_at, and the crm__check_slot
-- rule and lock order this file mirrors). No crm_* / fin_* / stock_* / clin_* / plt_* object is changed or called (the
-- trigger only row-locks leads, as crm_appointment_sync does); every object created here is named appt_* / appt__* or
-- appointments_*.
--
--  1. Preflight: column shapes, enum labels, no foreign appt__* overloads.
--  2. reminders: no SMS gateway exists (0021: "No SMS is ever sent"), yet appointments/new queued one 'sms' row per
--     booking that the Hatırlatmalar page showed as "Bekleniyor". Every pending, never-sent SMS row is closed as
--     status 'failed' with error_message 'SMS gönderilmedi - otomatik SMS etkin değil' (reminder_status has no
--     cancelled / not-sent label; no row is deleted, the history stays; the page shows these rows as "Gönderilmedi").
--     anon / authenticated lose INSERT on reminders, so a browser tab with the old bundle cannot queue new ones (the
--     old bundle only logs that failure; the appointment itself is saved before it). UPDATE stays for the old
--     cancel / reschedule helpers.
--  3. Trigger appt_slot_guard (BEFORE INSERT / UPDATE OF start_time, end_time, doctor_id, chair_id, status, clinic_id)
--     with appt__trg_slot_guard(): the rule of the booking pages and of crm__check_slot, now enforced for every write:
--       - end_time must be after start_time (E_SLOT_ORDER, 400) whenever the times are set or changed;
--       - two 'scheduled' appointments of the same doctor (E_SLOT_DOCTOR, 409) or the same chair (E_SLOT_CHAIR, 409)
--         must not overlap; [start, end) is half-open, so back-to-back bookings are fine.
--     Serialised per clinic with the advisory lock key of crm__check_slot, so concurrent bookings from the agenda and
--     the CRM queue behind each other and the second one sees the first.
--     Lock order: the patient's leads first (FOR UPDATE, ordered as crm_appointment_sync locks them), then the advisory
--     lock. crm_resolve_call (0021) locks its lead and then takes the advisory lock in crm__check_slot; without the
--     lead lock here, an agenda booking would hold the advisory lock while its AFTER trigger crm_appointment_sync waits
--     for the same lead, and the two bookings would deadlock (40P01).
--  4. appt__slot_conflicts(): report of overlapping scheduled appointments already in the table (SQL editor only).
--  5. Exclusion constraints appointments_no_double_doctor / appointments_no_double_chair (btree_gist, partial on
--     status = 'scheduled'): the hard backstop behind the trigger (e.g. REPEATABLE READ writers, a disabled trigger).
--     EXCLUDE cannot be added NOT VALID, so the data is checked first: a constraint is added only when no existing
--     conflict of its kind remains; otherwise the conflicts are listed in NOTICEs and the constraint is skipped (the
--     trigger still protects every new or changed appointment). Re-run this file after resolving them.
--  6. Privileges: the appt__* functions are internals (EXECUTE revoked from PUBLIC / anon / authenticated /
--     service_role; a trigger function needs no EXECUTE grant to fire).
--  7. Self-checks (RAISE rolls everything back), including a rolled-back replay in a temporary clinic.
--
-- Deliberate choices:
--   * A conflict is between two 'scheduled' appointments only, exactly as the web pages and crm__check_slot (0021)
--     have always checked. A cancelled appointment never blocks; a completed or no-show one frees its slot, so the
--     doctor can see the next patient after an early finish or a no-show. Blocking those would also make the existing
--     history fail the constraint.
--   * Only real changes are re-checked: a notes-only or status-only change (other than back to 'scheduled') of a row
--     that already overlaps another legacy row still saves; moving it or re-opening it into a conflict does not.
--   * Applies to SQL editor / service writes too (a later data import must not create double bookings either).
--
-- Error contract (as 0020-0027): RAISE USING MESSAGE = <Turkish text>, ERRCODE = PT409 (409) or P0001 (400),
-- HINT = key (E_SLOT_DOCTOR, E_SLOT_CHAIR, E_SLOT_ORDER: the same keys and texts as crm__raise), DETAIL = id of the
-- appointment it collides with. The web app maps these keys, and 23P01 with the constraint names above, to Turkish
-- texts (apps/web/src/lib/appointments/errors.ts).
--
-- RUNBOOK (production is the only database):
--   0. Quiet time: the trigger creation and the constraint check briefly block writes to appointments.
--   1. SQL editor -> New query -> paste this file ALONE -> Run. One transaction; any self-check failure rolls
--      everything back. The dashboard editor shows only the last statement's result, not the NOTICEs, so the file
--      ends (after COMMIT) with a one-row summary: durum ('Tamam' or what is missing), tetikleyici (true),
--      cakisma_kisitlari (the exclusion constraints that exist), mevcut_cakismalar (overlapping planned appointments
--      still in the table), kapatilan_sms (SMS rows marked "Gönderilmedi", all runs together).
--   2. If durum is not 'Tamam' (mevcut_cakismalar > 0, a constraint missing): SELECT * FROM
--      public.appt__slot_conflicts(); cancel or move one appointment of each pair in the app, then run this file
--      again (the missing constraint is added then; nothing else changes).
--   3. Deploy the web build of branch feat/ajanda-fixes and ask everyone to reload open tabs. Either order works: the
--      old build keeps booking (a double booking now fails with the generic "Randevu oluşturulurken hata oluştu"), and
--      the new build works on the old database (no reminder rows, browser-side overlap check only).
--   Rollback after COMMIT: DROP TRIGGER appt_slot_guard ON public.appointments; ALTER TABLE public.appointments
--   DROP CONSTRAINT IF EXISTS appointments_no_double_doctor, DROP CONSTRAINT IF EXISTS appointments_no_double_chair;
--   DROP FUNCTION public.appt__trg_slot_guard(), public.appt__slot_conflicts(); GRANT INSERT ON public.reminders TO
--   authenticated. The closed reminder rows stay closed (they were never sent).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Preflight
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_vals text[];
BEGIN
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.typ, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('appointments', 'id', 'uuid'), ('appointments', 'clinic_id', 'uuid'), ('appointments', 'patient_id', 'uuid'),
    ('appointments', 'doctor_id', 'uuid'), ('appointments', 'chair_id', 'uuid'),
    ('appointments', 'start_time', 'timestamptz'), ('appointments', 'end_time', 'timestamptz'),
    ('appointments', 'status', 'appointment_status'), ('appointments', 'notes', 'text'),
    ('appointments', 'lead_id', 'uuid'),
    ('leads', 'id', 'uuid'), ('leads', 'clinic_id', 'uuid'), ('leads', 'patient_id', 'uuid'),
    ('leads', 'created_at', 'timestamptz'), ('leads', 'deleted_at', 'timestamptz'),
    ('reminders', 'id', 'uuid'), ('reminders', 'clinic_id', 'uuid'), ('reminders', 'appointment_id', 'uuid'),
    ('reminders', 'reminder_type', 'text'), ('reminders', 'sent_at', 'timestamptz'),
    ('reminders', 'status', 'reminder_status'), ('reminders', 'error_message', 'text'),
    ('doctors', 'id', 'uuid'), ('doctors', 'clinic_id', 'uuid'), ('doctors', 'user_id', 'uuid'),
    ('doctors', 'specialty', 'text'),
    ('users', 'id', 'uuid'), ('users', 'clinic_id', 'uuid'), ('users', 'role', 'user_role'),
    ('users', 'full_name', 'text'), ('users', 'email', 'text'), ('users', 'is_active', 'bool'),
    ('chairs', 'id', 'uuid'), ('chairs', 'clinic_id', 'uuid'), ('chairs', 'name', 'text'),
    ('clinics', 'id', 'uuid'), ('clinics', 'name', 'text'), ('clinics', 'slug', 'text'),
    ('patients', 'id', 'uuid'), ('patients', 'clinic_id', 'uuid'), ('patients', 'full_name', 'text'),
    ('patients', 'phone', 'text')
  ) AS e(tbl, col, typ)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name::text = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.typ;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı veya türü farklı: %', v_missing;
  END IF;

  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) INTO v_vals
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'appointment_status';
  IF v_vals IS DISTINCT FROM ARRAY['scheduled', 'completed', 'cancelled', 'no_show'] THEN
    RAISE EXCEPTION 'appointment_status beklenen değerlerde değil: %', v_vals;
  END IF;

  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) INTO v_vals
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'reminder_status';
  IF v_vals IS DISTINCT FROM ARRAY['pending', 'sent', 'failed'] THEN
    RAISE EXCEPTION 'reminder_status beklenen değerlerde değil: %', v_vals;
  END IF;

  IF to_regclass('public.idx_appointments_clinic_scheduled_start') IS NULL THEN
    RAISE EXCEPTION 'idx_appointments_clinic_scheduled_start bulunamadı; önce 0021 uygulanmalı.';
  END IF;

  IF to_regprocedure('pg_catalog.hashtextextended(text, bigint)') IS NULL THEN
    RAISE EXCEPTION 'hashtextextended(text, bigint) bulunamadı (PostgreSQL 11+ gerekli).';
  END IF;

  -- Only the two functions of this file may carry the appt__ prefix (no overloads, no foreign objects).
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_missing
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'appt\_\_%'
    AND (p.proname NOT IN ('appt__trg_slot_guard', 'appt__slot_conflicts') OR p.pronargs <> 0);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenmeyen appt__ fonksiyonları var: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. reminders: close the never-sent SMS rows (history kept), no new client inserts.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_closed bigint;
  v_other bigint;
BEGIN
  -- A tab with the old bundle must not queue a new row between this update and the REVOKE (released at COMMIT).
  LOCK TABLE public.reminders IN SHARE ROW EXCLUSIVE MODE;

  UPDATE public.reminders
  SET status = 'failed',
      error_message = 'SMS gönderilmedi - otomatik SMS etkin değil'
  WHERE status = 'pending' AND reminder_type = 'sms' AND sent_at IS NULL;
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RAISE NOTICE 'Hatırlatmalar: % bekleyen SMS kaydı "Gönderilmedi" olarak kapatıldı; hiçbir kayıt silinmedi.', v_closed;

  SELECT count(*) INTO v_other FROM public.reminders WHERE status = 'pending';
  IF v_other > 0 THEN
    RAISE NOTICE 'Hatırlatmalar: SMS dışında % bekleyen kayıt var; bu dosya onlara dokunmadı.', v_other;
  END IF;
END $$;

REVOKE INSERT ON public.reminders FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Slot guard trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.appt__trg_slot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_other uuid;
  v_times_changed boolean := true;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Nothing that decides a slot changed (e.g. notes, reminder outcome): no check, no lock.
    IF NEW.start_time IS NOT DISTINCT FROM OLD.start_time
       AND NEW.end_time IS NOT DISTINCT FROM OLD.end_time
       AND NEW.doctor_id IS NOT DISTINCT FROM OLD.doctor_id
       AND NEW.chair_id IS NOT DISTINCT FROM OLD.chair_id
       AND NEW.clinic_id IS NOT DISTINCT FROM OLD.clinic_id
       AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    v_times_changed := NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.end_time IS DISTINCT FROM OLD.end_time;
  END IF;

  IF v_times_changed AND NEW.end_time <= NEW.start_time THEN
    RAISE EXCEPTION USING MESSAGE = 'Bitiş saati başlangıç saatinden sonra olmalı.', ERRCODE = 'P0001',
      HINT = 'E_SLOT_ORDER';
  END IF;

  -- Only planned appointments hold a slot (cancelled / completed / no_show free it).
  IF NEW.status IS DISTINCT FROM 'scheduled'::public.appointment_status THEN
    RETURN NEW;
  END IF;

  -- Leads before the advisory lock, the order of crm_resolve_call (lead, then crm__check_slot). These are exactly the
  -- rows the AFTER trigger crm_appointment_sync (0021) locks, in its order; it then finds them already held. Without
  -- this, an agenda booking (advisory lock, then the lead in the sync trigger) and a CRM booking for the same lead
  -- (lead, then advisory lock) can deadlock. A multi-row statement (SQL editor) still locks the leads of its later
  -- rows after the advisory lock; the app writes one appointment per statement.
  PERFORM 1
  FROM public.leads l
  WHERE l.clinic_id = NEW.clinic_id
    AND l.deleted_at IS NULL
    AND (l.patient_id = NEW.patient_id OR l.id = NEW.lead_id)
  ORDER BY l.created_at, l.id
  FOR UPDATE;

  -- Same key as crm__check_slot (0021): CRM bookings and direct writes of one clinic queue behind each other. The
  -- queries below run after the lock with a fresh snapshot (READ COMMITTED), so they see a booking committed meanwhile.
  PERFORM pg_advisory_xact_lock(hashtextextended('appointments.slot:' || NEW.clinic_id::text, 0));

  SELECT a.id INTO v_other
  FROM public.appointments a
  WHERE a.clinic_id = NEW.clinic_id
    AND a.status = 'scheduled'
    AND a.id <> NEW.id
    AND a.doctor_id = NEW.doctor_id
    AND a.start_time < NEW.end_time
    AND a.end_time > NEW.start_time
  ORDER BY a.start_time, a.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'Seçilen hekimin bu saatte başka bir randevusu var.', ERRCODE = 'PT409',
      HINT = 'E_SLOT_DOCTOR', DETAIL = v_other::text;
  END IF;

  SELECT a.id INTO v_other
  FROM public.appointments a
  WHERE a.clinic_id = NEW.clinic_id
    AND a.status = 'scheduled'
    AND a.id <> NEW.id
    AND a.chair_id = NEW.chair_id
    AND a.start_time < NEW.end_time
    AND a.end_time > NEW.start_time
  ORDER BY a.start_time, a.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'Seçilen koltuk bu saatte dolu.', ERRCODE = 'PT409',
      HINT = 'E_SLOT_CHAIR', DETAIL = v_other::text;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appt_slot_guard ON public.appointments;
CREATE TRIGGER appt_slot_guard
  BEFORE INSERT OR UPDATE OF start_time, end_time, doctor_id, chair_id, status, clinic_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.appt__trg_slot_guard();

-- ---------------------------------------------------------------------------
-- 4. Conflict report (SQL editor): every scheduled appointment that overlaps an earlier-starting scheduled one of the
--    same doctor ('hekim') or chair ('koltuk'), with one appointment it overlaps. No patient data. Window functions
--    keep it O(n log n); the partner lookup runs only for conflicting rows.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.appt__slot_conflicts();
CREATE FUNCTION public.appt__slot_conflicts()
RETURNS TABLE (
  kind text,
  clinic_id uuid,
  resource_name text,
  appointment_id uuid,
  start_time timestamptz,
  end_time timestamptz,
  overlaps_id uuid,
  overlaps_start timestamptz,
  overlaps_end timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH s AS (
    SELECT a.id, a.clinic_id, a.doctor_id, a.chair_id, a.start_time, a.end_time
    FROM public.appointments a
    WHERE a.status = 'scheduled' AND a.start_time < a.end_time
  ),
  d AS (
    SELECT s.*,
           max(s.end_time) OVER (PARTITION BY s.doctor_id ORDER BY s.start_time, s.id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM s
  ),
  c AS (
    SELECT s.*,
           max(s.end_time) OVER (PARTITION BY s.chair_id ORDER BY s.start_time, s.id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM s
  )
  SELECT x.kind, x.clinic_id, x.resource_name, x.appointment_id, x.start_time, x.end_time,
         x.overlaps_id, x.overlaps_start, x.overlaps_end
  FROM (
    SELECT 'hekim'::text AS kind, d.clinic_id, coalesce(u.full_name, doc.specialty, d.doctor_id::text) AS resource_name,
           d.id AS appointment_id, d.start_time, d.end_time,
           o.id AS overlaps_id, o.start_time AS overlaps_start, o.end_time AS overlaps_end
    FROM d
    LEFT JOIN LATERAL (
      SELECT b.id, b.start_time, b.end_time
      FROM public.appointments b
      WHERE b.doctor_id = d.doctor_id AND b.status = 'scheduled' AND b.start_time < b.end_time
        AND (b.start_time, b.id) < (d.start_time, d.id) AND b.end_time > d.start_time
      ORDER BY b.start_time DESC, b.id DESC
      LIMIT 1
    ) o ON true
    LEFT JOIN public.doctors doc ON doc.id = d.doctor_id
    LEFT JOIN public.users u ON u.id = doc.user_id
    WHERE d.start_time < d.prev_end
    UNION ALL
    SELECT 'koltuk'::text, c.clinic_id, coalesce(ch.name, c.chair_id::text),
           c.id, c.start_time, c.end_time,
           o.id, o.start_time, o.end_time
    FROM c
    LEFT JOIN LATERAL (
      SELECT b.id, b.start_time, b.end_time
      FROM public.appointments b
      WHERE b.chair_id = c.chair_id AND b.status = 'scheduled' AND b.start_time < b.end_time
        AND (b.start_time, b.id) < (c.start_time, c.id) AND b.end_time > c.start_time
      ORDER BY b.start_time DESC, b.id DESC
      LIMIT 1
    ) o ON true
    LEFT JOIN public.chairs ch ON ch.id = c.chair_id
    WHERE c.start_time < c.prev_end
  ) x
  ORDER BY x.kind, x.start_time, x.appointment_id
$$;

-- ---------------------------------------------------------------------------
-- 5. Exclusion constraints, only where the existing data allows them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_doctor bigint;
  v_chair bigint;
  v_bad_order bigint;
  v_list text;
BEGIN
  SELECT count(*) INTO v_bad_order
  FROM public.appointments a
  WHERE a.status = 'scheduled' AND a.end_time <= a.start_time;
  IF v_bad_order > 0 THEN
    RAISE NOTICE 'Bitişi başlangıcından önce veya ona eşit % planlı randevu var; çakışma kurallarının dışında kalırlar, saatlerini düzeltin.',
      v_bad_order;
  END IF;

  -- No booking may slip in between the data check and the constraint (released at COMMIT).
  LOCK TABLE public.appointments IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) FILTER (WHERE x.kind = 'hekim'), count(*) FILTER (WHERE x.kind = 'koltuk')
    INTO v_doctor, v_chair
  FROM public.appt__slot_conflicts() x;

  IF v_doctor + v_chair > 0 THEN
    SELECT string_agg(
             format('%s %s: %s (%s-%s) ile %s (%s-%s)', x.kind, x.resource_name, x.appointment_id,
                    to_char(x.start_time AT TIME ZONE 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI'),
                    to_char(x.end_time AT TIME ZONE 'Europe/Istanbul', 'HH24:MI'), x.overlaps_id,
                    to_char(x.overlaps_start AT TIME ZONE 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI'),
                    to_char(x.overlaps_end AT TIME ZONE 'Europe/Istanbul', 'HH24:MI')),
             '; ')
      INTO v_list
    FROM (SELECT * FROM public.appt__slot_conflicts() LIMIT 20) x;
    RAISE NOTICE 'Mevcut planlı randevularda çakışma var: % hekim, % koltuk. İlk 20: %', v_doctor, v_chair, v_list;
    RAISE NOTICE 'Tam liste: SELECT * FROM public.appt__slot_conflicts(); Her çiftten birini iptal edin veya taşıyın, sonra bu dosyayı yeniden çalıştırın. O zamana kadar appt_slot_guard yeni ve değişen randevularda çift kaydı engelliyor.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist') THEN
      RAISE NOTICE 'btree_gist eklentisi bu sunucuda yok; çakışma kısıtları eklenmedi. appt_slot_guard tetikleyicisi korumaya devam ediyor.';
      RETURN;
    END IF;
    -- Supabase keeps extensions in the 'extensions' schema.
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
    ELSE
      CREATE EXTENSION IF NOT EXISTS btree_gist;
    END IF;
  END IF;

  IF v_doctor > 0 THEN
    RAISE NOTICE 'appointments_no_double_doctor eklenmedi (% hekim çakışması).', v_doctor;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_no_double_doctor') THEN
    BEGIN
      ALTER TABLE public.appointments ADD CONSTRAINT appointments_no_double_doctor
        EXCLUDE USING gist (doctor_id WITH =, tstzrange(start_time, end_time, '[)') WITH &&)
        WHERE (status = 'scheduled' AND start_time < end_time);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE NOTICE 'appointments_no_double_doctor eklenemedi: mevcut satırlar çakışıyor (%).', SQLERRM;
    END;
  END IF;

  IF v_chair > 0 THEN
    RAISE NOTICE 'appointments_no_double_chair eklenmedi (% koltuk çakışması).', v_chair;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_no_double_chair') THEN
    BEGIN
      ALTER TABLE public.appointments ADD CONSTRAINT appointments_no_double_chair
        EXCLUDE USING gist (chair_id WITH =, tstzrange(start_time, end_time, '[)') WITH &&)
        WHERE (status = 'scheduled' AND start_time < end_time);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE NOTICE 'appointments_no_double_chair eklenemedi: mevcut satırlar çakışıyor (%).', SQLERRM;
    END;
  END IF;

  RAISE NOTICE 'Çakışma kısıtları: hekim %, koltuk %.',
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.appointments'::regclass
                        AND conname = 'appointments_no_double_doctor') THEN 'var' ELSE 'YOK' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.appointments'::regclass
                        AND conname = 'appointments_no_double_chair') THEN 'var' ELSE 'YOK' END;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Privileges: internals only.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.appt__trg_slot_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.appt__slot_conflicts() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Self-checks (any failure rolls back the whole file)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.appointments'::regclass AND t.tgname = 'appt_slot_guard' AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Öz denetim: appt_slot_guard tetikleyicisi yok veya kapalı.';
  END IF;

  -- Only the trigger function is SECURITY DEFINER; both pin search_path.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'appt\_\_%'
    AND ((p.prosecdef AND p.prorettype <> 'trigger'::regtype)
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: appt__ fonksiyonları beklenen gibi değil (SECURITY DEFINER / search_path): %', v_bad;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'appt\_\_%'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: appt__ fonksiyonları istemciye açık: %', v_bad;
  END IF;

  IF has_table_privilege('anon', 'public.reminders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reminders', 'INSERT') THEN
    RAISE EXCEPTION 'Öz denetim: istemciler reminders tablosuna hâlâ kayıt ekleyebiliyor.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.reminders WHERE status = 'pending' AND reminder_type = 'sms' AND sent_at IS NULL) THEN
    RAISE EXCEPTION 'Öz denetim: bekleyen SMS hatırlatması kaldı.';
  END IF;

  -- RLS stays on for both tables (this file adds no policy).
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.appointments'::regclass)
     OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.reminders'::regclass) THEN
    RAISE EXCEPTION 'Öz denetim: appointments / reminders için RLS kapalı.';
  END IF;

  -- Constraints that exist have the expected shape (exclusion on a tstzrange, partial on scheduled rows).
  SELECT string_agg(c.conname, ', ') INTO v_bad
  FROM pg_constraint c
  WHERE c.conrelid = 'public.appointments'::regclass
    AND c.conname IN ('appointments_no_double_doctor', 'appointments_no_double_chair')
    AND (c.contype <> 'x'
         OR pg_get_constraintdef(c.oid) NOT ILIKE '%tstzrange%'
         OR pg_get_constraintdef(c.oid) NOT ILIKE '%scheduled%'
         OR pg_get_constraintdef(c.oid) NOT ILIKE
              CASE c.conname WHEN 'appointments_no_double_doctor' THEN '%(doctor\_id WITH =%' ELSE '%(chair\_id WITH =%' END);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: çakışma kısıtı beklenen biçimde değil: %', v_bad;
  END IF;
END $$;

-- Replay inside a block that is always rolled back: a temporary clinic 'p28-test-selfcheck-<random>' with a synthetic
-- patient, two doctors and two chairs, far in the future. Checks the doctor / chair / order rules on INSERT and
-- UPDATE, back-to-back bookings, freed slots (cancelled, completed) and re-opening into a conflict. Nothing survives.
DO $$
DECLARE
  v_clinic uuid := gen_random_uuid();
  v_slug text := 'p28-test-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_patient uuid := gen_random_uuid();
  v_u1 uuid := gen_random_uuid();
  v_u2 uuid := gen_random_uuid();
  v_d1 uuid := gen_random_uuid();
  v_d2 uuid := gen_random_uuid();
  v_c1 uuid := gen_random_uuid();
  v_c2 uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_t0 timestamptz := date_trunc('day', now()) + interval '400 days' + interval '10 hours';
  v_hint text;
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim 0028', v_slug);
    INSERT INTO public.patients (id, clinic_id, full_name, phone)
    VALUES (v_patient, v_clinic, 'Öz denetim hasta', '5000000098');
    INSERT INTO public.users (id, clinic_id, role, full_name, email, is_active)
    VALUES (v_u1, v_clinic, 'doctor', 'Öz denetim hekim 1', 'p28-selfcheck-1-' || left(v_slug, 40) || '@example.invalid', true),
           (v_u2, v_clinic, 'doctor', 'Öz denetim hekim 2', 'p28-selfcheck-2-' || left(v_slug, 40) || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES (v_d1, v_clinic, v_u1), (v_d2, v_clinic, v_u2);
    INSERT INTO public.chairs (id, clinic_id, name)
    VALUES (v_c1, v_clinic, 'Öz denetim koltuk 1'), (v_c2, v_clinic, 'Öz denetim koltuk 2');

    -- A: doctor 1, chair 1, 10:00-10:30.
    INSERT INTO public.appointments (id, clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
    VALUES (v_a, v_clinic, v_patient, v_d1, v_c1, v_t0, v_t0 + interval '30 minutes', 'scheduled');

    -- Same doctor, other chair, 10:15-10:45: refused (E_SLOT_DOCTOR).
    BEGIN
      INSERT INTO public.appointments (clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
      VALUES (v_clinic, v_patient, v_d1, v_c2, v_t0 + interval '15 minutes', v_t0 + interval '45 minutes', 'scheduled');
      v_fail := array_append(v_fail, 'aynı hekime çakışan randevu kabul edildi');
    EXCEPTION
      WHEN SQLSTATE 'PT409' THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'E_SLOT_DOCTOR' THEN
          v_fail := array_append(v_fail, 'hekim çakışması anahtarı: ' || coalesce(v_hint, '-'));
        END IF;
      WHEN exclusion_violation THEN
        v_fail := array_append(v_fail, 'hekim çakışmasını tetikleyici değil kısıt yakaladı');
    END;

    -- Other doctor, same chair, 10:15-10:45: refused (E_SLOT_CHAIR).
    BEGIN
      INSERT INTO public.appointments (clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
      VALUES (v_clinic, v_patient, v_d2, v_c1, v_t0 + interval '15 minutes', v_t0 + interval '45 minutes', 'scheduled');
      v_fail := array_append(v_fail, 'dolu koltuğa çakışan randevu kabul edildi');
    EXCEPTION
      WHEN SQLSTATE 'PT409' THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'E_SLOT_CHAIR' THEN
          v_fail := array_append(v_fail, 'koltuk çakışması anahtarı: ' || coalesce(v_hint, '-'));
        END IF;
      WHEN exclusion_violation THEN
        v_fail := array_append(v_fail, 'koltuk çakışmasını tetikleyici değil kısıt yakaladı');
    END;

    -- B: back-to-back on the same doctor and chair, 10:30-11:00: accepted.
    INSERT INTO public.appointments (id, clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
    VALUES (v_b, v_clinic, v_patient, v_d1, v_c1, v_t0 + interval '30 minutes', v_t0 + interval '60 minutes', 'scheduled');

    -- End before start: refused (E_SLOT_ORDER).
    BEGIN
      INSERT INTO public.appointments (clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
      VALUES (v_clinic, v_patient, v_d2, v_c2, v_t0 + interval '3 hours', v_t0 + interval '2 hours', 'scheduled');
      v_fail := array_append(v_fail, 'bitişi başlangıcından önce olan randevu kabul edildi');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_SLOT_ORDER' THEN
        v_fail := array_append(v_fail, 'saat sırası anahtarı: ' || coalesce(v_hint, '-'));
      END IF;
    END;

    -- A notes-only change saves.
    UPDATE public.appointments SET notes = 'Öz denetim' WHERE id = v_a;

    -- Moving B into A (10:20-11:00): refused on UPDATE.
    BEGIN
      UPDATE public.appointments SET start_time = v_t0 + interval '20 minutes' WHERE id = v_b;
      v_fail := array_append(v_fail, 'çakışmaya taşınan randevu kabul edildi');
    EXCEPTION WHEN SQLSTATE 'PT409' THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_SLOT_DOCTOR' THEN
        v_fail := array_append(v_fail, 'taşıma çakışması anahtarı: ' || coalesce(v_hint, '-'));
      END IF;
    END;

    -- A cancelled frees chair 1 at 10:00-10:30 for doctor 2.
    UPDATE public.appointments SET status = 'cancelled' WHERE id = v_a;
    INSERT INTO public.appointments (clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
    VALUES (v_clinic, v_patient, v_d2, v_c1, v_t0, v_t0 + interval '30 minutes', 'scheduled');

    -- B completed frees doctor 1 at 10:40-10:50.
    UPDATE public.appointments SET status = 'completed' WHERE id = v_b;
    INSERT INTO public.appointments (clinic_id, patient_id, doctor_id, chair_id, start_time, end_time, status)
    VALUES (v_clinic, v_patient, v_d1, v_c2, v_t0 + interval '40 minutes', v_t0 + interval '50 minutes', 'scheduled');

    -- Re-opening A (chair 1, 10:00-10:30) collides with doctor 2's booking on chair 1.
    BEGIN
      UPDATE public.appointments SET status = 'scheduled' WHERE id = v_a;
      v_fail := array_append(v_fail, 'çakışmaya yeniden açılan randevu kabul edildi');
    EXCEPTION WHEN SQLSTATE 'PT409' THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_SLOT_CHAIR' THEN
        v_fail := array_append(v_fail, 'yeniden açma anahtarı: ' || coalesce(v_hint, '-'));
      END IF;
    END;

    IF EXISTS (SELECT 1 FROM public.appt__slot_conflicts() x WHERE x.clinic_id = v_clinic) THEN
      v_fail := array_append(v_fail, 'çakışma raporu sahte çakışma gösteriyor');
    END IF;

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (randevu çakışması): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'appt_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Summary for the SQL editor (read-only; it shows the result of this last statement, not the NOTICEs above). Runs only
-- when everything above was committed.
SELECT
  CASE
    WHEN s.mevcut_cakismalar > 0 THEN
      'Çakışan planlı randevu var: SELECT * FROM public.appt__slot_conflicts(); ile bakın, düzeltip dosyayı yeniden çalıştırın.'
    WHEN s.kisit_sayisi < 2 THEN
      'Çakışma kısıtı eksik (sunucuda btree_gist eklentisi olmayabilir). Tetikleyici yine de çift randevuyu engelliyor.'
    ELSE 'Tamam'
  END AS durum,
  s.tetikleyici,
  s.cakisma_kisitlari,
  s.mevcut_cakismalar,
  s.kapatilan_sms
FROM (
  SELECT
    EXISTS (SELECT 1 FROM pg_trigger t
            WHERE t.tgrelid = 'public.appointments'::regclass AND t.tgname = 'appt_slot_guard'
              AND NOT t.tgisinternal AND t.tgenabled <> 'D') AS tetikleyici,
    coalesce((SELECT string_agg(c.conname::text, ', ' ORDER BY c.conname) FROM pg_constraint c
              WHERE c.conrelid = 'public.appointments'::regclass
                AND c.conname IN ('appointments_no_double_doctor', 'appointments_no_double_chair')), 'YOK')
      AS cakisma_kisitlari,
    (SELECT count(*) FROM pg_constraint c
     WHERE c.conrelid = 'public.appointments'::regclass
       AND c.conname IN ('appointments_no_double_doctor', 'appointments_no_double_chair')) AS kisit_sayisi,
    (SELECT count(*) FROM public.appt__slot_conflicts()) AS mevcut_cakismalar,
    (SELECT count(*) FROM public.reminders
     WHERE status = 'failed' AND error_message = 'SMS gönderilmedi - otomatik SMS etkin değil') AS kapatilan_sms
) s;
