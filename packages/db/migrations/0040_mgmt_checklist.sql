-- 0040_mgmt_checklist.sql — "Yönetim" checklist for the administrative manager (idari işler müdürü).
--
-- Owner 2026-11-06: the clinic hires an idari işler müdürü (role admin) who runs stock & purchasing, kasa / finance,
-- staff and patient flow. Their daily / weekly / monthly routine lives in DentOS as a checklist; the owner sees what
-- was done, by whom and when, and what was missed.
--
--   mgmt_checklist_items  the routine (template): title, area, frequency and when it is due.
--                         daily   → shown on the days in `weekdays` (ISO 1 = Monday … 7 = Sunday), due that day;
--                         weekly  → one per ISO week, due on `weekday`;
--                         monthly → one per month, due on `month_day` (clamped to the month's last day).
--   mgmt_checklist_marks  one row per item and period (period_start = the day / Monday / first of month): who marked
--                         it done, when, and a note. Unmarking deletes the row (owner, or the person who marked it).
--
-- Only the owner and admins use it (mgmt__require). Every read and write goes through the RPCs below; the tables are
-- not exposed to the API roles. Default items are seeded once per clinic that has none.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mgmt_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 1000),
  area text NOT NULL DEFAULT 'genel' CHECK (area IN ('stok', 'finans', 'personel', 'hasta', 'genel')),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  weekday smallint CHECK (weekday BETWEEN 1 AND 7),
  month_day smallint CHECK (month_day BETWEEN 1 AND 31),
  link_href text CHECK (link_href IS NULL OR (link_href ~ '^/[^/]' AND char_length(link_href) <= 200)),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id),
  updated_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The day the item starts to count (missed-item report); set from clinic_today() on create.
  active_from date NOT NULL,
  UNIQUE (clinic_id, id),
  CHECK (frequency <> 'daily' OR (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ '{1,2,3,4,5,6,7}'::smallint[])),
  CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CHECK ((frequency = 'monthly') = (month_day IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mgmt_checklist_items_clinic ON public.mgmt_checklist_items (clinic_id, is_active, sort_order);

CREATE TABLE IF NOT EXISTS public.mgmt_checklist_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  period_start date NOT NULL,
  done_by uuid NOT NULL REFERENCES public.users(id),
  done_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  UNIQUE (item_id, period_start),
  FOREIGN KEY (clinic_id, item_id) REFERENCES public.mgmt_checklist_items (clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mgmt_checklist_marks_clinic ON public.mgmt_checklist_marks (clinic_id, period_start);

ALTER TABLE public.mgmt_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mgmt_checklist_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mgmt_checklist_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mgmt_checklist_marks FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The caller's clinic when they are an active owner or admin; raises otherwise.
CREATE OR REPLACE FUNCTION public.mgmt__require()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
  v_role text := public.current_app_role();
BEGIN
  IF v_clinic IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Yönetim panelini yalnızca klinik sahibi ve yöneticiler kullanabilir.' USING ERRCODE = '42501';
  END IF;
  RETURN v_clinic;
END;
$$;

-- Start of the period an item's date falls in.
CREATE OR REPLACE FUNCTION public.mgmt__period_start(p_frequency text, p_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_frequency
    WHEN 'daily' THEN p_date
    WHEN 'weekly' THEN (p_date - (extract(isodow FROM p_date)::int - 1))
    ELSE date_trunc('month', p_date)::date
  END
$$;

-- Due day of an item in the period starting at p_period (daily: the day itself).
CREATE OR REPLACE FUNCTION public.mgmt__due_date(p_frequency text, p_weekday smallint, p_month_day smallint,
                                                 p_period date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_frequency
    WHEN 'daily' THEN p_period
    WHEN 'weekly' THEN p_period + (p_weekday - 1)
    ELSE least(p_period + (p_month_day - 1), ((p_period + interval '1 month')::date - 1))
  END
$$;

CREATE OR REPLACE FUNCTION public.mgmt__user_name(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.full_name FROM public.users u WHERE u.id = p_user
$$;

CREATE OR REPLACE FUNCTION public.mgmt__item_json(i public.mgmt_checklist_items)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'title', i.title, 'detail', i.detail, 'area', i.area, 'frequency', i.frequency,
    'weekdays', to_jsonb(i.weekdays), 'weekday', i.weekday, 'month_day', i.month_day, 'link_href', i.link_href,
    'sort_order', i.sort_order, 'is_active', i.is_active, 'active_from', i.active_from)
$$;

-- ---------------------------------------------------------------------------
-- Board: the items of a day with the state of their current period, plus the owner's summary of the last 14 days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mgmt_checklist_board(p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.mgmt__require();
  v_today date := public.clinic_today();
  v_date date := coalesce(p_date, public.clinic_today());
  v_from date := public.clinic_today() - 14;
  v_items jsonb;
  v_missed jsonb;
  v_expected integer;
  v_done integer;
BEGIN
  IF v_date > v_today OR v_date < v_today - 60 THEN
    RAISE EXCEPTION 'Tarih bugün ile son 60 gün arasında olmalı.' USING ERRCODE = '22023';
  END IF;

  -- Items of the day: daily ones only on their weekdays; weekly / monthly ones every day of their period.
  SELECT coalesce(jsonb_agg(
           public.mgmt__item_json(i) || jsonb_build_object(
             'period_start', p.ps,
             'due_date', p.due,
             'done', m.id IS NOT NULL,
             'done_at', m.done_at,
             'done_by', m.done_by,
             'done_by_name', public.mgmt__user_name(m.done_by),
             'note', coalesce(m.note, ''))
           ORDER BY CASE i.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END, i.sort_order, i.title),
         '[]'::jsonb)
    INTO v_items
  FROM public.mgmt_checklist_items i
  CROSS JOIN LATERAL (SELECT public.mgmt__period_start(i.frequency, v_date) AS ps) p0
  CROSS JOIN LATERAL (SELECT p0.ps, public.mgmt__due_date(i.frequency, i.weekday, i.month_day, p0.ps) AS due) p
  LEFT JOIN public.mgmt_checklist_marks m ON m.item_id = i.id AND m.period_start = p.ps
  WHERE i.clinic_id = v_clinic
    AND i.is_active
    AND (i.frequency <> 'daily' OR extract(isodow FROM v_date)::smallint = ANY (i.weekdays));

  -- Expected occurrences whose due day lies in [today - 14, today - 1] and that started counting by then.
  WITH days AS (
    SELECT d::date AS d FROM generate_series(v_from, v_today - 1, interval '1 day') d
  ), occ AS (
    SELECT DISTINCT i.id, i.title, i.area, i.frequency, i.link_href,
           public.mgmt__period_start(i.frequency, d.d) AS ps,
           public.mgmt__due_date(i.frequency, i.weekday, i.month_day, public.mgmt__period_start(i.frequency, d.d)) AS due
    FROM public.mgmt_checklist_items i
    CROSS JOIN days d
    WHERE i.clinic_id = v_clinic AND i.is_active
  ), due AS (
    SELECT o.*, m.id AS mark_id
    FROM occ o
    JOIN public.mgmt_checklist_items i ON i.id = o.id
    LEFT JOIN public.mgmt_checklist_marks m ON m.item_id = o.id AND m.period_start = o.ps
    WHERE o.due BETWEEN v_from AND v_today - 1
      AND o.due >= i.active_from
      AND (o.frequency <> 'daily' OR extract(isodow FROM o.due)::smallint = ANY (i.weekdays))
  )
  SELECT count(*)::int, count(mark_id)::int,
         coalesce((SELECT jsonb_agg(jsonb_build_object('item_id', x.id, 'title', x.title, 'area', x.area,
                                                       'frequency', x.frequency, 'period_start', x.ps,
                                                       'due_date', x.due, 'link_href', x.link_href)
                                    ORDER BY x.due DESC, x.title)
                   FROM (SELECT * FROM due WHERE mark_id IS NULL ORDER BY due DESC, title LIMIT 100) x), '[]'::jsonb)
    INTO v_expected, v_done, v_missed
  FROM due;

  RETURN jsonb_build_object(
    'today', v_today,
    'date', v_date,
    'role', public.current_app_role(),
    'items', v_items,
    'summary', jsonb_build_object('from', v_from, 'to', v_today - 1, 'expected', v_expected, 'done', v_done,
                                  'missed', v_missed));
END;
$$;

-- Every item (active and passive) for the settings list.
CREATE OR REPLACE FUNCTION public.mgmt_checklist_items_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.mgmt__require();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(public.mgmt__item_json(i)
                     ORDER BY i.is_active DESC, CASE i.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END,
                              i.sort_order, i.title)
    FROM public.mgmt_checklist_items i WHERE i.clinic_id = v_clinic), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- Mark / unmark an item for the period of p_date (today or the previous 7 days, so a late entry is still possible;
-- done_at records when it was actually marked).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mgmt_checklist_mark(p_item_id uuid, p_date date, p_done boolean, p_note text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.mgmt__require();
  v_me uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_item public.mgmt_checklist_items;
  v_ps date;
  v_mark public.mgmt_checklist_marks;
  v_note text := btrim(coalesce(p_note, ''));
BEGIN
  IF p_date IS NULL OR p_date > v_today OR p_date < v_today - 7 THEN
    RAISE EXCEPTION 'Yalnızca bugün ve son 7 gün işaretlenebilir.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.mgmt_checklist_items WHERE id = p_item_id AND clinic_id = v_clinic;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Madde bulunamadı.' USING ERRCODE = 'P0002';
  END IF;
  v_ps := public.mgmt__period_start(v_item.frequency, p_date);
  SELECT * INTO v_mark FROM public.mgmt_checklist_marks WHERE item_id = v_item.id AND period_start = v_ps FOR UPDATE;

  IF p_done THEN
    IF NOT v_item.is_active THEN
      RAISE EXCEPTION 'Pasif madde işaretlenemez.' USING ERRCODE = '22023';
    END IF;
    IF v_item.frequency = 'daily' AND NOT (extract(isodow FROM p_date)::smallint = ANY (v_item.weekdays)) THEN
      RAISE EXCEPTION 'Bu madde o gün yapılmıyor.' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_note) > 1000 THEN
      RAISE EXCEPTION 'Not en fazla 1000 karakter olabilir.' USING ERRCODE = '22023';
    END IF;
    IF v_mark.id IS NULL THEN
      INSERT INTO public.mgmt_checklist_marks (clinic_id, item_id, period_start, done_by, note)
      VALUES (v_clinic, v_item.id, v_ps, v_me, v_note);
    ELSIF v_mark.done_by = v_me OR public.current_app_role() = 'owner' THEN
      -- Same mark: only the note changes (who and when stay as first marked).
      UPDATE public.mgmt_checklist_marks SET note = v_note WHERE id = v_mark.id;
    ELSE
      RAISE EXCEPTION 'Bu madde başka biri tarafından işaretlenmiş.' USING ERRCODE = '42501';
    END IF;
  ELSIF v_mark.id IS NOT NULL THEN
    IF v_mark.done_by <> v_me AND public.current_app_role() <> 'owner' THEN
      RAISE EXCEPTION 'İşareti yalnızca işaretleyen kişi veya klinik sahibi kaldırabilir.' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.mgmt_checklist_marks WHERE id = v_mark.id;
  END IF;

  RETURN jsonb_build_object('item_id', v_item.id, 'period_start', v_ps, 'done', p_done);
END;
$$;

-- ---------------------------------------------------------------------------
-- Create / edit an item (p_item.id null → new). Items are never deleted, only set passive (history stays).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mgmt_checklist_save_item(p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.mgmt__require();
  v_me uuid := public.current_app_user_id();
  v_id uuid := nullif(p_item ->> 'id', '')::uuid;
  v_freq text := p_item ->> 'frequency';
  v_weekdays smallint[];
  v_weekday smallint;
  v_month_day smallint;
  v_link text := nullif(btrim(coalesce(p_item ->> 'link_href', '')), '');
  v_row public.mgmt_checklist_items;
BEGIN
  IF v_freq IS NULL OR v_freq NOT IN ('daily', 'weekly', 'monthly') THEN
    RAISE EXCEPTION 'Sıklık günlük, haftalık veya aylık olmalı.' USING ERRCODE = '22023';
  END IF;
  IF v_freq = 'daily' THEN
    SELECT coalesce(array_agg(DISTINCT x::smallint ORDER BY x::smallint), '{}')
      INTO v_weekdays FROM jsonb_array_elements_text(coalesce(p_item -> 'weekdays', '[]'::jsonb)) x;
    IF cardinality(v_weekdays) = 0 THEN
      RAISE EXCEPTION 'Günlük madde için en az bir gün seçin.' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_weekdays := '{1,2,3,4,5,6}';
  END IF;
  IF v_freq = 'weekly' THEN
    v_weekday := (p_item ->> 'weekday')::smallint;
    IF v_weekday IS NULL THEN
      RAISE EXCEPTION 'Haftalık madde için gün seçin.' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_freq = 'monthly' THEN
    v_month_day := (p_item ->> 'month_day')::smallint;
    IF v_month_day IS NULL THEN
      RAISE EXCEPTION 'Aylık madde için ayın gününü seçin.' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.mgmt_checklist_items
      (clinic_id, title, detail, area, frequency, weekdays, weekday, month_day, link_href, sort_order, is_active,
       created_by, updated_by, active_from)
    VALUES (v_clinic, btrim(p_item ->> 'title'), btrim(coalesce(p_item ->> 'detail', '')),
            coalesce(p_item ->> 'area', 'genel'), v_freq, v_weekdays, v_weekday, v_month_day, v_link,
            coalesce((p_item ->> 'sort_order')::int, 0), true, v_me, v_me, public.clinic_today())
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.mgmt_checklist_items SET
      title = btrim(p_item ->> 'title'),
      detail = btrim(coalesce(p_item ->> 'detail', '')),
      area = coalesce(p_item ->> 'area', area),
      frequency = v_freq,
      weekdays = v_weekdays,
      weekday = v_weekday,
      month_day = v_month_day,
      link_href = v_link,
      sort_order = coalesce((p_item ->> 'sort_order')::int, sort_order),
      -- Turning an item on again starts its count afresh (the passive days are not "missed").
      active_from = CASE WHEN NOT is_active AND coalesce((p_item ->> 'is_active')::boolean, is_active)
                         THEN public.clinic_today() ELSE active_from END,
      is_active = coalesce((p_item ->> 'is_active')::boolean, is_active),
      updated_by = v_me,
      updated_at = now()
    WHERE id = v_id AND clinic_id = v_clinic
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Madde bulunamadı.' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN public.mgmt__item_json(v_row);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mgmt__require() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mgmt__user_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mgmt__item_json(public.mgmt_checklist_items) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mgmt__period_start(text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mgmt__due_date(text, smallint, smallint, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mgmt_checklist_board(date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mgmt_checklist_items_list() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mgmt_checklist_mark(uuid, date, boolean, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mgmt_checklist_save_item(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mgmt_checklist_board(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mgmt_checklist_items_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mgmt_checklist_mark(uuid, date, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mgmt_checklist_save_item(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Default routine (owner-approved workflow 2026-11-06), seeded once for every clinic without items.
-- ---------------------------------------------------------------------------
INSERT INTO public.mgmt_checklist_items
  (clinic_id, title, detail, area, frequency, weekdays, weekday, month_day, link_href, sort_order, active_from)
SELECT c.id, s.title, s.detail, s.area, s.frequency, s.weekdays::smallint[], s.weekday, s.month_day, s.link_href,
       s.sort_order, public.clinic_today()
FROM public.clinics c
CROSS JOIN (VALUES
  -- Günlük — sabah
  ('Bugünün ve yarının ajandasını kontrol et', 'Boş saatler, çakışmalar, hekim izinleri.', 'hasta', 'daily', '{1,2,3,4,5,6}', NULL::smallint, NULL::smallint, '/appointments', 10),
  ('Yarınki randevuların hatırlatması yapıldı mı', 'CRM · Bugün listesindeki hatırlatmalar bitmiş olmalı; ulaşılamayanlar için not.', 'hasta', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/crm/today', 20),
  ('CRM · Bugün listesini dağıt ve takip et', 'Geciken aramalar ve yeni başvurular sahiplenildi mi.', 'hasta', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/crm/today', 30),
  ('Kritik stok ve oda taleplerine bak', 'Kritik kartlar için sipariş; bekleyen oda taleplerini onayla / teslim et.', 'stok', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/inventory', 40),
  ('Lab''dan gelen / gecikmiş işleri kontrol et', 'Gelen işler hastaya randevulandı mı, geciken işler için lab arandı mı.', 'hasta', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/lab', 50),
  -- Günlük — gün içi
  ('Personele görev ver, açık görevleri takip et', 'Gecikmiş görevler Görevler sayfasında.', 'personel', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/tasks', 60),
  ('Hasta şikayet ve taleplerini kapat', 'Gün içinde gelen şikayetler not ile kapatılsın.', 'hasta', 'daily', '{1,2,3,4,5,6}', NULL, NULL, NULL, 70),
  -- Günlük — akşam kapanış
  ('Günün tahsilatları Finans''a girildi mi', 'Ajandada işlem gören hastaların ödemeleri eksiksiz.', 'finans', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/finance', 80),
  ('Kasa kapanışı: nakit + POS mutabakatı', 'Kasa sayımı, POS gün sonu ve Finans tutarı aynı mı; fark varsa nota yaz.', 'finans', 'daily', '{1,2,3,4,5,6}', NULL, NULL, '/finance', 90),
  -- Haftalık
  ('Haftalık stok siparişi', 'Kritik ve azalan kartlar için tedarikçi siparişi.', 'stok', 'weekly', '{1,2,3,4,5,6}', 1::smallint, NULL, '/inventory', 110),
  ('Personel izin ve vardiya planı (gelecek hafta)', 'İzinler, mesai ve hekim günleri netleşsin.', 'personel', 'weekly', '{1,2,3,4,5,6}', 4::smallint, NULL, NULL, 120),
  ('Oda sayımlarını kontrol et', 'Sayımı eksik kalan oda / kart var mı.', 'stok', 'weekly', '{1,2,3,4,5,6}', 5::smallint, NULL, '/inventory', 130),
  ('CRM dönüşüm raporuna bak', 'Başvuru → randevu → tedavi dönüşümü, kaybedilenlerin nedeni.', 'hasta', 'weekly', '{1,2,3,4,5,6}', 6::smallint, NULL, '/reports', 140),
  -- Aylık
  ('Banka ekstrelerini yükle ve eşleştir', 'Eşleşmeyen hareket kalmasın.', 'finans', 'monthly', '{1,2,3,4,5,6}', NULL, 3::smallint, '/finance', 210),
  ('Tedarikçi ödemelerini planla / öde', 'Vadesi gelen borçlar Finans''ta.', 'finans', 'monthly', '{1,2,3,4,5,6}', NULL, 5::smallint, '/finance', 220),
  ('Hakedişi hazırla ve klinik sahibine onaya gönder', 'Kapanışı klinik sahibi yapar.', 'finans', 'monthly', '{1,2,3,4,5,6}', NULL, 7::smallint, '/hakedis', 230),
  ('Ay sonu stok sayımı', 'Depo ve tüm odalar.', 'stok', 'monthly', '{1,2,3,4,5,6}', NULL, 28::smallint, '/inventory', 240)
) AS s(title, detail, area, frequency, weekdays, weekday, month_day, link_href, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.mgmt_checklist_items x WHERE x.clinic_id = c.id);

-- Self-check (rolls the migration back on failure).
DO $chk$
DECLARE
  v_bad integer;
BEGIN
  IF public.mgmt__period_start('weekly', DATE '2026-11-08') <> DATE '2026-11-02'
     OR public.mgmt__period_start('weekly', DATE '2026-11-02') <> DATE '2026-11-02'
     OR public.mgmt__period_start('monthly', DATE '2026-11-30') <> DATE '2026-11-01'
     OR public.mgmt__due_date('monthly', NULL, 31::smallint, DATE '2026-02-01') <> DATE '2026-02-28'
     OR public.mgmt__due_date('weekly', 5::smallint, NULL, DATE '2026-11-02') <> DATE '2026-11-06' THEN
    RAISE EXCEPTION '0040 self-check: period / due date helpers';
  END IF;
  SELECT count(*) INTO v_bad FROM public.clinics c
  WHERE NOT EXISTS (SELECT 1 FROM public.mgmt_checklist_items i WHERE i.clinic_id = c.id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '0040 self-check: % clinic(s) without checklist items', v_bad;
  END IF;
  IF has_table_privilege('authenticated', 'public.mgmt_checklist_items', 'SELECT')
     OR has_table_privilege('authenticated', 'public.mgmt_checklist_marks', 'SELECT') THEN
    RAISE EXCEPTION '0040 self-check: checklist tables readable by authenticated';
  END IF;
END
$chk$;

COMMIT;
