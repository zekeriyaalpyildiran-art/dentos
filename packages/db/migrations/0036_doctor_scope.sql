-- Doctor scope (owner's decision 2026-10-20): a user with the role 'doctor' sees and changes only the lab orders (lab
-- işleri) of their own doctor record, enforced on the server: in every lab RPC and in the row level security of
-- lab_orders and its child tables. Every other role (owner, admin, assistant, reception) and every holder of
-- 'finance' / 'finance_readonly' keeps the whole clinic's lab orders, exactly as before. Safe to re-run.
--
-- Contract: on top of 0035_hakedis_burgan_net.sql (0001 – 0035 are applied and live; none is edited). No later file
-- replaces a clin_* function or a lab policy, so the latest definition of every function replaced here is 0026's; it
-- is copied with only the changes below and keeps its signature (clin__harden_privileges refuses overloads). The web
-- part of the same decision (the doctor's menu without CRM, İmplantlar, Raporlar and Ekip, and those routes closed
-- to doctors) is UI-only, like the assistants' closure of 2026-10-16; see "Not changed" below.
--
--  * Who is scoped: clin_can_view_all_lab_orders() (new, granted, SECURITY DEFINER) is false only for an active user
--    whose role is 'doctor' and who holds neither 'finance' nor 'finance_readonly' (a finance holder already sees
--    every lab cost and the hakediş lab costs of every doctor, and posts the lab payables of every order; tell the
--    owner). It is false without a session too (fail closed). 'stock_cost_view' and 'clinical' exempt nobody.
--  * Own record: clin_my_doctor_id() (new, granted, SECURITY DEFINER) = doctors.id of the caller (doctors.user_id =
--    current_app_user_id(), same clinic; doctors.user_id is unique), NULL without one. A scoped user without a doctor
--    record sees no order and cannot create one (CL_LAB_NO_DOCTOR). lab_orders.doctor_id is NOT NULL (0009); an
--    order without a doctor would be invisible to every scoped user all the same (NULL never equals).
--  * clin__lab_order_visible(doctor_id) (new internal, SECURITY INVOKER, never granted) = clin_can_view_all_lab_orders()
--    OR doctor_id = clin_my_doctor_id(); NULL counts as false.
--  * Reads: clin_lab_order_list returns and counts (tiles) only visible orders, so a doctor_id filter naming another
--    doctor returns nothing; clin_lab_order_detail raises CL_NOT_FOUND (PT404) for an order that is not visible,
--    exactly as for a missing one. clin__lab_json open_order_count (clin_save_lab's response) counts only visible
--    orders.
--  * Writes: clin_lab_order_save refuses, for a scoped user, any p_doctor_id other than the caller's own doctor record
--    (create, retry and edit, so no order is created for or moved to another doctor): new key CL_LAB_OWN_DOCTOR
--    (42501). Its edit branch, clin_lab_order_set_status, clin_lab_order_delete_draft, clin_lab_order_set_cost and
--    clin_lab_cost_post find (and lock) only a visible order: another doctor's order raises CL_NOT_FOUND before any
--    version check and is never locked. The checks in front of them are unchanged (CL_SESSION, CL_WRITE,
--    CL_LAB_COST_FORBIDDEN, CL_FINANCE, CL_PAYABLE_OFF).
--  * Row level security (direct PostgREST reads: the "açık iş" counts of the labs directory, the owner's export):
--    the one SELECT policy of lab_orders, lab_order_items, lab_order_events and lab_order_costs is dropped and
--    recreated under its 0026 name, with the 0026 terms AND (clin_can_view_all_lab_orders() OR the order's doctor is
--    clin_my_doctor_id()). Table privileges are unchanged (SELECT only for authenticated; writes only through the
--    RPCs). Exactly one policy per table stays (checked).
--  * Flags (clin__flags, in every clinical read response) + lab_own_only (NOT clin_can_view_all_lab_orders()) and
--    my_doctor_id (clin_my_doctor_id()). Backwards compatible.
--  * Not changed: labs (the lab directory stays visible to every staff member), implants and their RPCs, clinical
--    settings, audit logs (lab rows owner / admin only, 0020; lab cost rows gated, 0026), the hakediş lab costs
--    (fin_hk_lab_costs; hk_my_* return only the caller's own rows). CRM, Raporlar and Ekip get no server-side role
--    check: doctors keep calling crm_work_list (the Görevler count), staff_task_list / staff_task_action,
--    crm_set_reminder_outcome (agenda and patient card) and crm_phone_matches (patient form), and the patient card
--    keeps the clin_implant_* RPCs; the tables behind those sections (leads, users, patients, patient_implants) are
--    readable clinic-wide for the pages doctors still use, so a role check on the RPCs would break those pages and
--    hide no data. Closing those sections is the job of the menu and the section layouts (web).
--
-- Error contract (as 0026): RAISE USING MESSAGE = <Turkish text>, ERRCODE = 42501 (403), PT404 (404), PT409 (409) or
-- P0001 (400), HINT = key. New keys (42501): CL_LAB_OWN_DOCTOR 'Hekim hesabıyla yalnızca kendi adınıza lab işi
-- açabilir veya düzenleyebilirsiniz.', CL_LAB_NO_DOCTOR 'Hesabınıza bağlı hekim kaydı bulunamadı. Lab işi açmak için
-- klinik yöneticisine başvurun.'
--
-- RUNBOOK (production is the only database):
--   1. 0035 is applied. SQL editor -> New query -> paste this file ALONE -> Run. One transaction of a few seconds;
--      the four lab tables are locked until COMMIT (policies are replaced), so run it when nobody is saving a lab
--      job. The self-checks at the end (including a replay in a temporary clinic that is always rolled back) undo
--      everything on any failure. The replay writes no lab order number (lab_order_number_seq is not used).
--   2. Deploy the web build (either order works: the web build hides the doctor filter and fixes the doctor field by
--      the role until the server's flags arrive; until this file is applied, a doctor's lab page shows the full list
--      with the Hekim filter, because the server's flags carry no lab_own_only and the server does not scope).
--   3. Doctors reload open tabs.
--   Re-running 0026 later (documented there as safe to re-run) drops these policies and puts back the unscoped
--   bodies, flags and error list: re-run this file afterwards.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Re-run from 0026: the §4.1 / 4.2 policy block (it drops and recreates the one SELECT policy of each of the
--       eight clinical tables) and the definitions of clin__raise, clin__flags, clin__lab_json,
--       clin_lab_order_save, clin_lab_order_set_status, clin_lab_order_delete_draft, clin_lab_order_set_cost,
--       clin_lab_cost_post, clin_lab_order_list and clin_lab_order_detail.
--   (b) DROP FUNCTION public.clin__lab_order_visible(uuid), public.clin_can_view_all_lab_orders(),
--       public.clin_my_doctor_id();   (only after (a): the policies and bodies of this file use them)
--   (c) SELECT public.clin__harden_privileges();
--   Data: nothing to undo (no table, column or row is changed by this file).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preflight: 0035 live; the 0026 functions replaced here with their 0026 signatures and bodies (or this file's
--    on a re-run); the columns and the one 0026 policy of each lab table; doctors.user_id unique.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regprocedure('public.fin__hk_financing_links(uuid,date)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = 'fin_hk_lines' AND c.column_name = 'paid_on') THEN
    RAISE EXCEPTION 'Önce 0035 uygulanmalı (fin__hk_financing_links / fin_hk_lines.paid_on bulunamadı).';
  END IF;

  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today', 'has_permission',
                    'stock__check_patient_refs', 'clin__require_read', 'clin__require_write', 'clin_can_write',
                    'clin_can_view_lab_costs', 'clin_can_edit_lab_costs', 'clin__lab_order_rows',
                    'clin__lab_order_json', 'clin__lab_items', 'clin__lab_items_norm', 'clin__lab_items_stored',
                    'clin__lab_items_replace', 'clin__cost_live_entry', 'clin__post_lab_cost',
                    'clin__payable_enabled', 'clin__lab_transition_ok', 'clin__lab_status_label', 'clin__day',
                    'clin__page', 'clin__j_text', 'clin__j_uuid', 'clin__j_bool', 'clin__j_codes', 'clin__tr_lower',
                    'stock_can_operate', 'stock_can_view_costs']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0019, 0024 ve 0026 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.clin__raise(text,text,text)',
    'public.clin__flags()',
    'public.clin__lab_json(uuid,uuid,boolean)',
    'public.clin__lab_order_json(uuid,uuid,boolean,boolean)',
    'public.clin__lab_order_rows(uuid,date,boolean,boolean,boolean)',
    'public.clin__harden_privileges()',
    'public.clin_lab_order_save(uuid,integer,uuid,uuid,uuid,text,text,jsonb,uuid,boolean,text)',
    'public.clin_lab_order_set_status(uuid,integer,text,text,text)',
    'public.clin_lab_order_delete_draft(uuid,integer)',
    'public.clin_lab_order_set_cost(uuid,integer,bigint,text)',
    'public.clin_lab_cost_post(uuid,integer)',
    'public.clin_lab_order_list(jsonb,jsonb)',
    'public.clin_lab_order_detail(uuid)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Klinik fonksiyonları beklenen imzada değil (0026 uygulanmalı): %', v_missing;
  END IF;

  -- The bodies replaced below are 0026's, or this file's on a re-run (which keep these texts).
  SELECT string_agg(e.fn, ', ')
    INTO v_missing
  FROM (VALUES
    ('clin__raise', '%CL_HISTORY%'),
    ('clin__flags', '%can_view_material_costs%'),
    ('clin__lab_json', '%open_order_count%'),
    ('clin_lab_order_save', '%CL_ALREADY_SAVED_CHANGED%'),
    ('clin_lab_order_set_status', '%finance_entry_open%'),
    ('clin_lab_order_delete_draft', '%CL_LAB_NOT_DRAFT%'),
    ('clin_lab_order_set_cost', '%CL_LAB_COST_PAID%'),
    ('clin_lab_cost_post', '%CL_PAYABLE_DONE%'),
    ('clin_lab_order_list', '%delivered_30d%'),
    ('clin_lab_order_detail', '%lab_cost_payable_enabled%')
  ) AS e(fn, pat)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = e.fn AND p.prosrc LIKE e.pat
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Şu fonksiyonlar 0026 sürümünde değil: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('doctors', 'id'), ('doctors', 'clinic_id'), ('doctors', 'user_id'),
    ('lab_orders', 'id'), ('lab_orders', 'clinic_id'), ('lab_orders', 'doctor_id'), ('lab_orders', 'created_by'),
    ('lab_order_items', 'lab_order_id'), ('lab_order_items', 'clinic_id'),
    ('lab_order_events', 'lab_order_id'), ('lab_order_events', 'clinic_id'),
    ('lab_order_costs', 'lab_order_id'), ('lab_order_costs', 'clinic_id')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı: %', v_missing;
  END IF;

  -- One doctor record per user (0001 UNIQUE): clin_my_doctor_id() answers with one row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.doctors'::regclass AND i.indisunique AND i.indnatts = 1 AND i.indpred IS NULL
      AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a
                         WHERE a.attrelid = 'public.doctors'::regclass AND a.attname = 'user_id')
  ) THEN
    RAISE EXCEPTION 'doctors.user_id tekil değil; hekim kapsamı kurulamaz.';
  END IF;

  -- Each lab table has exactly its 0026 SELECT policy (another permissive policy would bypass the scope below).
  SELECT string_agg(format('%s.%s', p.tablename, p.policyname), ', ')
    INTO v_missing
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename IN ('lab_orders', 'lab_order_items', 'lab_order_events', 'lab_order_costs')
    AND (p.tablename::text, p.policyname::text) NOT IN (('lab_orders', 'lab_orders_clinic_isolation'),
                                            ('lab_order_items', 'lab_order_items_clinic_isolation'),
                                            ('lab_order_events', 'lab_order_events_select'),
                                            ('lab_order_costs', 'lab_order_costs_select'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Lab tablolarında beklenmeyen RLS politikaları var (0026 dışı): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Scope helpers. clin_can_view_all_lab_orders / clin_my_doctor_id answer only for the caller and are granted
--    (RLS and the UI use them; clin__harden_privileges below). clin__lab_order_visible is internal (never granted,
--    SECURITY INVOKER, inlinable) and only ever called from the SECURITY DEFINER lab RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clin_can_view_all_lab_orders()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() <> 'doctor', false)
      OR coalesce(public.has_permission('finance'), false)
      OR coalesce(public.has_permission('finance_readonly'), false)
$$;

CREATE OR REPLACE FUNCTION public.clin_my_doctor_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.id
  FROM public.doctors d
  WHERE d.user_id = public.current_app_user_id() AND d.clinic_id = public.current_clinic_id()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.clin__lab_order_visible(p_doctor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(public.clin_can_view_all_lab_orders() OR p_doctor_id = public.clin_my_doctor_id(), false)
$$;

-- ---------------------------------------------------------------------------
-- 2. Error texts (0026 body, same signature) + CL_LAB_OWN_DOCTOR and CL_LAB_NO_DOCTOR. Internal: never granted.
-- ---------------------------------------------------------------------------
-- Error contract §1.1: one place for every Turkish text; the key travels in HINT. '%s' is replaced by p_arg.
CREATE OR REPLACE FUNCTION public.clin__raise(p_key text, p_arg text DEFAULT NULL, p_detail text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_msg text;
  v_code text := 'P0001';
BEGIN
  CASE p_key
    WHEN 'CL_SESSION' THEN v_msg := 'Oturum bulunamadı. Lütfen yeniden giriş yapın.'; v_code := '42501';
    WHEN 'CL_WRITE' THEN v_msg := 'Bu hesap klinik kayıt oluşturamaz veya değiştiremez.'; v_code := '42501';
    WHEN 'CL_RESTORE_OWNER' THEN v_msg := 'Silinen kaydı yalnız klinik sahibi geri alabilir.'; v_code := '42501';
    WHEN 'CL_DELETED_VIEW' THEN v_msg := 'Silinen kayıtları yalnız klinik sahibi veya yönetici görebilir.'; v_code := '42501';
    WHEN 'CL_FINANCE_LINK' THEN v_msg := 'Laboratuvarı finans kaydına bağlamak için finans yetkisi gerekir.'; v_code := '42501';
    WHEN 'CL_LAB_COST_FORBIDDEN' THEN v_msg := 'Lab maliyeti için maliyet veya finans yetkisi gerekir.'; v_code := '42501';
    WHEN 'CL_FINANCE' THEN v_msg := 'Bu işlemi yalnız finans yetkisi olan kişi yapabilir.'; v_code := '42501';
    WHEN 'CL_FILTER' THEN v_msg := 'Filtre değerleri geçersiz.';
    WHEN 'CL_NOT_FOUND' THEN v_msg := 'Kayıt bulunamadı.'; v_code := 'PT404';
    WHEN 'CL_ID_TAKEN' THEN v_msg := 'Kayıt kaydedilemedi. Formu kapatıp yeniden açın.'; v_code := 'PT409';
    WHEN 'CL_VERSION' THEN v_msg := 'Kayıt başka bir ekranda değişti. Listeyi yenileyip tekrar açın.'; v_code := 'PT409';
    WHEN 'CL_BRAND_NAME' THEN v_msg := 'Marka adı 1–80 karakter olmalı.';
    WHEN 'CL_BRAND_TAKEN' THEN v_msg := 'Bu isimde bir implant markası zaten kayıtlı.'; v_code := 'PT409';
    WHEN 'CL_BRAND' THEN v_msg := 'İmplant markası bulunamadı veya pasif. Tanımlardan etkin bir marka seçin.';
    WHEN 'CL_BRAND_STOCK_MISMATCH' THEN v_msg := 'Seçilen marka, stoktan düşülen kartın markası (%s) ile aynı olmalı.';
    WHEN 'CL_ALREADY_SAVED_CHANGED' THEN v_msg := 'Bu kayıt önceki denemede kaydedildi; sonraki değişiklikler işlenmedi. Kaydı açıp düzenleyin.'; v_code := 'PT409';
    WHEN 'CL_LAB_NAME' THEN v_msg := 'Laboratuvar adı 1–120 karakter olmalı.';
    WHEN 'CL_LAB_TAKEN' THEN v_msg := 'Bu isimde bir laboratuvar zaten kayıtlı.'; v_code := 'PT409';
    WHEN 'CL_LAB_FIELDS' THEN v_msg := 'Telefon, e-posta ve not alanlarını kontrol edin.';
    WHEN 'CL_LAB' THEN v_msg := 'Laboratuvar bulunamadı veya pasif. Tanımlardan etkin bir laboratuvar seçin.';
    WHEN 'CL_FIN_COUNTERPARTY' THEN v_msg := 'Finans kaydı bulunamadı, pasif veya laboratuvar türünde değil.';
    WHEN 'CL_TOOTH' THEN v_msg := 'Geçerli bir diş numarası girin (FDI 11–18, 21–28, 31–38, 41–48).';
    WHEN 'CL_TOOTH_TAKEN' THEN v_msg := 'Bu hastanın bu dişinde etkin bir implant kaydı var. Önceki implantı “Başarısız / çıkarıldı” olarak işaretleyin veya o kaydı düzeltin.'; v_code := 'PT409';
    WHEN 'CL_IMPLANT_SIZE' THEN v_msg := 'İmplant çapını ve boyunu kontrol edin.';
    WHEN 'CL_TORQUE' THEN v_msg := 'Tork 0–200 Ncm arasında olmalıdır.';
    WHEN 'CL_PLACED_ON' THEN v_msg := 'Geçerli bir uygulama tarihi girin; bugünden sonra olamaz.';
    WHEN 'CL_PLACED_ON_STOCK' THEN v_msg := 'Stoktan düşülen implantın uygulama tarihi son 30 gün içinde olmalı. Daha eski kayıtlar için “Stok dışı” seçin.';
    WHEN 'CL_CONTROL_DATE' THEN v_msg := 'Kontrol tarihi uygulama tarihinden önce olamaz.';
    WHEN 'CL_STATUS' THEN v_msg := 'İmplant durumunu seçin.';
    WHEN 'CL_MODEL' THEN v_msg := 'Model en fazla 150 karakter olabilir.';
    WHEN 'CL_NOTES' THEN v_msg := 'Not en fazla 4000 karakter olabilir.';
    WHEN 'CL_LOT_TEXT' THEN v_msg := 'Lot / seri numarası en fazla 60 karakter olabilir.';
    WHEN 'CL_SOURCE' THEN v_msg := 'İmplantın stoktan mı düşüleceğini yoksa stok dışı mı olduğunu seçin.';
    WHEN 'CL_SOURCE_NOTE' THEN v_msg := 'Stok dışı implant için kısa bir açıklama yazın (3–200 karakter).';
    WHEN 'CL_STOCK_ARGS' THEN v_msg := 'Stoktan düşülecek implantın lot / seri kaydını ve alındığı yeri seçin.';
    WHEN 'CL_EXTERNAL_ARGS' THEN v_msg := 'Stok dışı implantta stok kaydı seçilmez; lot / seri numarasını elle yazın.';
    WHEN 'CL_ITEM_LEVEL' THEN v_msg := 'Seçilen stok kartı A grubu (tekil takip) değil. İmplant yalnız A grubu karttan düşülebilir.';
    WHEN 'CL_DOCTOR_REQUIRED' THEN v_msg := 'Uygulayan hekimi seçin.';
    WHEN 'CL_IMPLANT_STOCK_FIELDS' THEN v_msg := 'Stoktan düşülmüş implantta hekim, randevu ve lot / seri değiştirilemez. Kaydı iptal edip doğru bilgilerle yeniden girin.'; v_code := 'PT409';
    WHEN 'CL_IMPLANT_DELETED' THEN v_msg := 'Bu implant kaydı iptal edilmiş.'; v_code := 'PT409';
    WHEN 'CL_IMPLANT_ACTIVE' THEN v_msg := 'Bu implant kaydı zaten etkin.'; v_code := 'PT409';
    WHEN 'CL_IMPLANT_LINKED' THEN v_msg := 'Bu stok çıkışı etkin bir implant kaydına bağlı. Düzeltme veya iade için önce implant kaydını iptal edin.'; v_code := 'PT409';
    WHEN 'CL_REASON' THEN v_msg := 'İptal nedenini yazın (3–500 karakter).';
    WHEN 'CL_IMPLANT_RESTORE_PENDING' THEN v_msg := 'Bu implant için açılmış stok düzeltme talebi bekliyor. Önce stok sorumlusu talebi reddetmeli.'; v_code := 'PT409';
    WHEN 'CL_IMPLANT_RESTORE_STOCK' THEN v_msg := 'Stok çıkışı düzeltilmiş veya iade edilmiş implant geri alınamaz. Doğru bilgilerle yeni kayıt girin.'; v_code := 'PT409';
    WHEN 'CL_LAB_ORDER_FIELDS' THEN v_msg := 'Hasta, hekim, laboratuvar ve beklenen dönüş tarihi zorunludur.';
    WHEN 'CL_LAB_OWN_DOCTOR' THEN v_msg := 'Hekim hesabıyla yalnızca kendi adınıza lab işi açabilir veya düzenleyebilirsiniz.'; v_code := '42501';
    WHEN 'CL_LAB_NO_DOCTOR' THEN v_msg := 'Hesabınıza bağlı hekim kaydı bulunamadı. Lab işi açmak için klinik yöneticisine başvurun.'; v_code := '42501';
    WHEN 'CL_LAB_ITEMS' THEN v_msg := 'Her kalem için tür ve 1–99 adet girin (en fazla 30 kalem).';
    WHEN 'CL_LAB_DATES' THEN v_msg := 'Dönüş, geliş veya teslim tarihi gönderimden önce olamaz.';
    WHEN 'CL_LAB_DELIVERED_DATE' THEN v_msg := 'Hastaya teslim tarihi kliniğe gelişten önce olamaz.';
    WHEN 'CL_LAB_FUTURE' THEN v_msg := 'Gönderim, geliş ve teslim tarihleri bugünden sonra olamaz.';
    WHEN 'CL_LAB_STATUS' THEN v_msg := 'Geçerli bir durum seçin.';
    WHEN 'CL_LAB_TRANSITION' THEN v_msg := 'İş “%s” durumundayken seçilen duruma geçilemez.'; v_code := 'PT409';
    WHEN 'CL_LAB_LOCKED' THEN v_msg := 'Kliniğe gelmiş, teslim edilmiş veya iptal edilmiş işte yalnızca not değiştirilebilir.'; v_code := 'PT409';
    WHEN 'CL_LAB_PATIENT_LOCKED' THEN v_msg := 'Laboratuvara gönderilmiş işin hastası değiştirilemez.'; v_code := 'PT409';
    WHEN 'CL_LAB_NOT_DRAFT' THEN v_msg := 'Yalnızca taslak siparişler silinebilir.'; v_code := 'PT409';
    WHEN 'CL_LAB_NOTE' THEN v_msg := 'Açıklama en fazla 500 karakter olabilir; iptal için 3–500 karakter yazın.';
    WHEN 'CL_LAB_COST' THEN v_msg := 'Geçerli bir tutar girin (0,01 – 10.000.000 TL).';
    WHEN 'CL_LAB_COST_DRAFT' THEN v_msg := 'Taslak sipariş için finans borcu oluşturulamaz. Önce işi laboratuvara gönderildi olarak işaretleyin.'; v_code := 'PT409';
    WHEN 'CL_LAB_COST_POSTED' THEN v_msg := 'Bu maliyet finansa borç olarak işlendi; değişikliği finans yetkilisi yapabilir.'; v_code := 'PT409';
    WHEN 'CL_LAB_COST_PAID' THEN v_msg := 'Bu borca ödeme kaydedilmiş; tutar ödenenden aza indirilemez veya silinemez. Finans ekranından kontrol edin.'; v_code := 'PT409';
    WHEN 'CL_PAYABLE_OFF' THEN v_msg := 'Lab maliyetinden borç oluşturma ayarı kapalı.'; v_code := 'PT409';
    WHEN 'CL_PAYABLE_DONE' THEN v_msg := 'Bu maliyet zaten finansa işlendi.'; v_code := 'PT409';
    WHEN 'CL_FIN_CATEGORY' THEN v_msg := 'Finans ayarlarında etkin “Laboratuvar” sistem kategorisi bulunamadı.'; v_code := 'PT409';
    WHEN 'CL_TREATMENT_PLAN' THEN v_msg := 'Tedavi planı bulunamadı veya bu hastaya ait değil.';
    WHEN 'CL_HISTORY' THEN v_msg := 'Klinik geçmiş kayıtları değiştirilemez veya silinemez.'; v_code := '42501';
    ELSE v_msg := 'Beklenmeyen hata: ' || coalesce(p_key, '(boş)');
  END CASE;

  v_msg := replace(v_msg, '%s', coalesce(p_arg, ''));

  IF p_detail IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = coalesce(p_key, '');
  ELSE
    RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = coalesce(p_key, ''), DETAIL = p_detail;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Read internals (0026 bodies, same signatures; internal, never granted). clin__flags + lab_own_only and
--    my_doctor_id; clin__lab_json counts only the open orders the caller may see (clin_save_lab's response).
-- ---------------------------------------------------------------------------
-- Flags carried by every read response (§1.2), so the UI never re-derives roles.
CREATE OR REPLACE FUNCTION public.clin__flags()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'can_write', public.clin_can_write(),
    'can_operate_stock', coalesce(public.stock_can_operate(), false),
    'can_view_lab_costs', public.clin_can_view_lab_costs(),
    'can_edit_lab_costs', public.clin_can_edit_lab_costs(),
    'can_finance', coalesce(public.has_permission('finance'), false),
    'can_view_deleted', coalesce(public.current_app_role() IN ('owner', 'admin'), false),
    'can_restore', coalesce(public.current_app_role() = 'owner', false),
    'can_view_material_costs', coalesce(public.stock_can_view_costs(), false),
    'lab_own_only', NOT public.clin_can_view_all_lab_orders(),
    'my_doctor_id', public.clin_my_doctor_id())
$$;

CREATE OR REPLACE FUNCTION public.clin__lab_json(p_clinic uuid, p_id uuid, p_fin_read boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'note', l.note,
           'fin_counterparty_id', l.fin_counterparty_id, 'is_active', l.is_active, 'version', l.version,
           'open_order_count', (SELECT count(*) FROM public.lab_orders o
                                WHERE o.lab_id = l.id AND o.clinic_id = l.clinic_id
                                  AND o.status::text NOT IN ('delivered', 'cancelled')
                                  AND public.clin__lab_order_visible(o.doctor_id)))
         || CASE WHEN p_fin_read THEN pg_catalog.jsonb_build_object('fin_counterparty_name', fc.name)
                 ELSE '{}'::jsonb END
  FROM public.labs l
  LEFT JOIN public.fin_counterparties fc ON fc.id = l.fin_counterparty_id
  WHERE l.id = p_id AND l.clinic_id = p_clinic
$$;

-- ---------------------------------------------------------------------------
-- 4. Lab write RPCs (0026 §5.7 – §5.11 bodies, same signatures; SECURITY DEFINER, SET search_path = public, granted
--    to authenticated only by clin__harden_privileges). Changes: the own-doctor rule of clin_lab_order_save and the
--    visibility of the order in every row lock (another doctor's order: CL_NOT_FOUND).
-- ---------------------------------------------------------------------------
-- 5.7 Lab order create (p_version NULL, client id, idempotent) or edit. Status changes go through 5.8 (p_submit is
--     honoured on create only). Ready / delivered / cancelled orders: only the notes may change.
CREATE OR REPLACE FUNCTION public.clin_lab_order_save(
  p_id uuid,
  p_version integer,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_lab_id uuid,
  p_due_date text,
  p_notes text,
  p_items jsonb,
  p_treatment_plan_id uuid DEFAULT NULL,
  p_submit boolean DEFAULT false,
  p_sent_on text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_can_cost boolean := public.clin_can_view_lab_costs();
  v_fin_read boolean := coalesce(public.has_permission('finance'), false)
                        OR coalesce(public.has_permission('finance_readonly'), false);
  v_notes text := btrim(coalesce(p_notes, ''));
  v_due date;
  v_items jsonb;
  v_row public.lab_orders%ROWTYPE;
  v_status text;
  v_sent date;
  v_num bigint;
  v_order_number text;
  v_items_changed boolean;
BEGIN
  IF p_patient_id IS NULL OR p_doctor_id IS NULL OR p_lab_id IS NULL OR btrim(coalesce(p_due_date, '')) = '' THEN
    PERFORM public.clin__raise('CL_LAB_ORDER_FIELDS');
  END IF;
  v_due := public.clin__day(p_due_date, 'CL_LAB_ORDER_FIELDS');
  -- 0036: a doctor (clin_can_view_all_lab_orders() false) works only under their own doctor record: on create, on a
  -- retry and on edit (no order is created for or moved to another doctor).
  IF NOT public.clin_can_view_all_lab_orders() THEN
    IF public.clin_my_doctor_id() IS NULL THEN
      PERFORM public.clin__raise('CL_LAB_NO_DOCTOR');
    END IF;
    IF p_doctor_id IS DISTINCT FROM public.clin_my_doctor_id() THEN
      PERFORM public.clin__raise('CL_LAB_OWN_DOCTOR');
    END IF;
  END IF;
  IF char_length(v_notes) > 4000 THEN
    PERFORM public.clin__raise('CL_NOTES');
  END IF;

  IF p_version IS NULL THEN
    -- Create: the strict item rules always apply.
    v_items := public.clin__lab_items(p_items);
    IF p_id IS NULL THEN
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END IF;
    SELECT * INTO v_row FROM public.lab_orders o WHERE o.id = p_id;
    IF FOUND THEN
      IF v_row.clinic_id = v_clinic AND v_row.created_by IS NOT DISTINCT FROM v_actor
         AND v_row.patient_id = p_patient_id THEN
        -- Retry of the same create (lost response): "already saved" only when this call asks for exactly what is
        -- stored; a retry with other values (e.g. "Taslak kaydet" lost, then "Gönder") must not report success.
        IF (v_row.doctor_id, v_row.lab_id, v_row.due_date, v_row.treatment_plan_id, coalesce(v_row.notes, ''))
             IS NOT DISTINCT FROM (p_doctor_id, p_lab_id, v_due, p_treatment_plan_id, v_notes)
           AND v_items IS NOT DISTINCT FROM public.clin__lab_items_stored(p_id)
           AND (v_row.status::text = 'draft') = NOT coalesce(p_submit, false) THEN
          RETURN jsonb_build_object('ok', true,
                                    'order', public.clin__lab_order_json(v_clinic, p_id, v_can_cost, v_fin_read),
                                    'already_saved', true);
        END IF;
        PERFORM public.clin__raise('CL_ALREADY_SAVED_CHANGED', NULL, p_id::text);
      END IF;
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END IF;

    PERFORM public.stock__check_patient_refs(v_clinic, p_patient_id, NULL, p_doctor_id);
    IF NOT EXISTS (SELECT 1 FROM public.labs l WHERE l.id = p_lab_id AND l.clinic_id = v_clinic AND l.is_active) THEN
      PERFORM public.clin__raise('CL_LAB');
    END IF;
    IF p_treatment_plan_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.treatment_plans tp
      WHERE tp.id = p_treatment_plan_id AND tp.clinic_id = v_clinic AND tp.patient_id = p_patient_id
    ) THEN
      PERFORM public.clin__raise('CL_TREATMENT_PLAN');
    END IF;

    IF coalesce(p_submit, false) THEN
      v_sent := coalesce(public.clin__day(p_sent_on, 'CL_LAB_DATES'), v_today);
      IF v_sent > v_today THEN
        PERFORM public.clin__raise('CL_LAB_FUTURE');
      END IF;
      IF v_due < v_sent THEN
        PERFORM public.clin__raise('CL_LAB_DATES');
      END IF;
      v_status := 'submitted';
    ELSE
      v_status := 'draft';
      v_sent := NULL;
    END IF;

    v_num := nextval('public.lab_order_number_seq');
    v_order_number := 'LAB-' || to_char(v_today, 'YYMM') || '-'
                      || lpad(v_num::text, greatest(5, char_length(v_num::text)), '0');

    BEGIN
      INSERT INTO public.lab_orders (id, clinic_id, patient_id, doctor_id, treatment_plan_id, order_number, status,
                                     due_date, notes, lab_id, sent_on, version, created_by, updated_by)
      VALUES (p_id, v_clinic, p_patient_id, p_doctor_id, p_treatment_plan_id, v_order_number,
              v_status::public.lab_order_status, v_due, nullif(v_notes, ''), p_lab_id, v_sent, 1, v_actor, v_actor);
    EXCEPTION WHEN unique_violation THEN
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END;
    PERFORM public.clin__lab_items_replace(v_clinic, p_id, v_items);
    INSERT INTO public.lab_order_events (clinic_id, lab_order_id, from_status, to_status, on_date, note, actor_user_id)
    VALUES (v_clinic, p_id, NULL, v_status::public.lab_order_status, coalesce(v_sent, v_today), '', v_actor);

    RETURN jsonb_build_object('ok', true,
                              'order', public.clin__lab_order_json(v_clinic, p_id, v_can_cost, v_fin_read),
                              'already_saved', false);
  END IF;

  -- Edit. 0036: another doctor's order is not found (and not locked) for a doctor.
  SELECT * INTO v_row FROM public.lab_orders o
  WHERE o.id = p_id AND o.clinic_id = v_clinic AND public.clin__lab_order_visible(o.doctor_id)
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  v_status := v_row.status::text;
  -- Unchanged items are compared without validation (old rows may predate the item rules); only changed items
  -- must pass clin__lab_items.
  v_items := public.clin__lab_items_norm(p_items);
  v_items_changed := v_items IS NULL OR v_items IS DISTINCT FROM public.clin__lab_items_stored(p_id);
  IF v_items_changed THEN
    v_items := public.clin__lab_items(p_items);
  END IF;

  IF v_status IN ('ready', 'delivered', 'cancelled') THEN
    -- Only the notes may change (an old order without a lab may get one).
    IF p_patient_id IS DISTINCT FROM v_row.patient_id OR p_doctor_id IS DISTINCT FROM v_row.doctor_id
       OR (v_row.lab_id IS NOT NULL AND p_lab_id IS DISTINCT FROM v_row.lab_id)
       OR v_due IS DISTINCT FROM v_row.due_date OR p_treatment_plan_id IS DISTINCT FROM v_row.treatment_plan_id
       OR v_items_changed THEN
      PERFORM public.clin__raise('CL_LAB_LOCKED');
    END IF;
  END IF;
  IF p_patient_id IS DISTINCT FROM v_row.patient_id AND v_status <> 'draft' THEN
    PERFORM public.clin__raise('CL_LAB_PATIENT_LOCKED');
  END IF;

  IF p_patient_id IS DISTINCT FROM v_row.patient_id OR p_doctor_id IS DISTINCT FROM v_row.doctor_id THEN
    PERFORM public.stock__check_patient_refs(
      v_clinic,
      CASE WHEN p_patient_id IS DISTINCT FROM v_row.patient_id THEN p_patient_id END,
      NULL,
      CASE WHEN p_doctor_id IS DISTINCT FROM v_row.doctor_id THEN p_doctor_id END);
  END IF;
  IF p_lab_id IS DISTINCT FROM v_row.lab_id AND NOT EXISTS (
    SELECT 1 FROM public.labs l WHERE l.id = p_lab_id AND l.clinic_id = v_clinic AND l.is_active
  ) THEN
    PERFORM public.clin__raise('CL_LAB');
  END IF;
  IF p_treatment_plan_id IS NOT NULL
     AND (p_treatment_plan_id IS DISTINCT FROM v_row.treatment_plan_id OR p_patient_id IS DISTINCT FROM v_row.patient_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.treatment_plans tp
       WHERE tp.id = p_treatment_plan_id AND tp.clinic_id = v_clinic AND tp.patient_id = p_patient_id
     ) THEN
    PERFORM public.clin__raise('CL_TREATMENT_PLAN');
  END IF;
  -- CR:21 on change only (a back-filled sent_on later than an old due date is kept).
  IF v_due IS DISTINCT FROM v_row.due_date AND v_row.sent_on IS NOT NULL AND v_due < v_row.sent_on THEN
    PERFORM public.clin__raise('CL_LAB_DATES');
  END IF;

  IF v_items_changed
     OR (p_patient_id, p_doctor_id, p_lab_id, v_due, p_treatment_plan_id, v_notes)
        IS DISTINCT FROM
        (v_row.patient_id, v_row.doctor_id, v_row.lab_id, v_row.due_date, v_row.treatment_plan_id,
         coalesce(v_row.notes, '')) THEN
    UPDATE public.lab_orders
    SET patient_id = p_patient_id, doctor_id = p_doctor_id, lab_id = p_lab_id, due_date = v_due,
        treatment_plan_id = p_treatment_plan_id, notes = nullif(v_notes, ''), version = version + 1,
        updated_by = v_actor, updated_at = now()
    WHERE id = v_row.id;
    IF v_items_changed THEN
      PERFORM public.clin__lab_items_replace(v_clinic, p_id, v_items);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true,
                            'order', public.clin__lab_order_json(v_clinic, p_id, v_can_cost, v_fin_read),
                            'already_saved', false);
END;
$$;

-- 5.8 Status change along the §1.5 matrix, with its business day (default today, never in the future) and an
--     event row. Only delivered orders carry delivery_date ("Hastaya teslim").
CREATE OR REPLACE FUNCTION public.clin_lab_order_set_status(p_lab_order_id uuid, p_version integer, p_status text,
                                                            p_on text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_can_cost boolean := public.clin_can_view_lab_costs();
  v_fin_read boolean := coalesce(public.has_permission('finance'), false)
                        OR coalesce(public.has_permission('finance_readonly'), false);
  v_row public.lab_orders%ROWTYPE;
  v_old text;
  v_new text := btrim(coalesce(p_status, ''));
  v_on date;
  v_note text := btrim(coalesce(p_note, ''));
  v_received date;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  -- 0036: another doctor's order is not found (and not locked) for a doctor.
  SELECT * INTO v_row FROM public.lab_orders o
  WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic AND public.clin__lab_order_visible(o.doctor_id)
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  IF v_new NOT IN ('draft', 'submitted', 'in_progress', 'try_in', 'revision', 'ready', 'delivered', 'cancelled') THEN
    PERFORM public.clin__raise('CL_LAB_STATUS');
  END IF;
  v_old := v_row.status::text;
  IF NOT public.clin__lab_transition_ok(v_old, v_new) THEN
    PERFORM public.clin__raise('CL_LAB_TRANSITION', public.clin__lab_status_label(v_old));
  END IF;

  v_on := coalesce(public.clin__day(p_on, 'CL_LAB_DATES'), v_today);
  IF v_on > v_today THEN
    PERFORM public.clin__raise('CL_LAB_FUTURE');
  END IF;
  IF char_length(v_note) > 500 OR (v_new = 'cancelled' AND char_length(v_note) < 3) THEN
    PERFORM public.clin__raise('CL_LAB_NOTE');
  END IF;

  -- Dates (CR:21-22).
  IF v_new = 'submitted' THEN
    IF v_on > v_row.due_date THEN
      PERFORM public.clin__raise('CL_LAB_DATES');
    END IF;
  ELSIF v_new IN ('in_progress', 'try_in', 'revision', 'ready', 'delivered')
        AND v_row.sent_on IS NOT NULL AND v_on < v_row.sent_on THEN
    PERFORM public.clin__raise('CL_LAB_DATES');
  END IF;
  IF v_new = 'delivered' THEN
    v_received := coalesce(v_row.received_on, v_on);
    IF v_on < v_received THEN
      PERFORM public.clin__raise('CL_LAB_DELIVERED_DATE');
    END IF;
  END IF;

  UPDATE public.lab_orders
  SET status = v_new::public.lab_order_status,
      sent_on = CASE WHEN v_new = 'submitted' THEN v_on ELSE sent_on END,
      last_try_in_on = CASE WHEN v_new = 'try_in' THEN v_on ELSE last_try_in_on END,
      revision_count = CASE WHEN v_new = 'revision' THEN least(revision_count + 1, 999) ELSE revision_count END,
      received_on = CASE WHEN v_new = 'revision' AND v_old = 'ready' THEN NULL
                         WHEN v_new = 'ready' AND v_old <> 'delivered' THEN v_on
                         WHEN v_new = 'delivered' THEN v_received
                         ELSE received_on END,
      delivery_date = CASE WHEN v_new = 'delivered' THEN v_on
                           WHEN v_new IN ('in_progress', 'try_in', 'revision', 'ready') THEN NULL
                           ELSE delivery_date END,
      cancelled_at = CASE WHEN v_new = 'cancelled' THEN now() ELSE cancelled_at END,
      cancel_reason = CASE WHEN v_new = 'cancelled' THEN v_note ELSE cancel_reason END,
      version = version + 1, updated_by = v_actor, updated_at = now()
  WHERE id = v_row.id;

  INSERT INTO public.lab_order_events (clinic_id, lab_order_id, from_status, to_status, on_date, note, actor_user_id)
  VALUES (v_clinic, v_row.id, v_row.status, v_new::public.lab_order_status, v_on, v_note, v_actor);

  -- A posted cost is not touched by a cancel; finance is told by the UI.
  IF v_new = 'cancelled' AND EXISTS (
    SELECT 1 FROM public.lab_order_costs c JOIN public.fin_entries e ON e.id = c.fin_entry_id
    WHERE c.lab_order_id = v_row.id AND e.cancelled_at IS NULL
  ) THEN
    v_warnings := v_warnings || to_jsonb('finance_entry_open'::text);
  END IF;

  RETURN jsonb_build_object('ok', true,
                            'order', public.clin__lab_order_json(v_clinic, v_row.id, v_can_cost, v_fin_read),
                            'warnings', v_warnings);
END;
$$;

-- 5.9 Draft delete (items, events and an unposted cost cascade; audit rows are written).
CREATE OR REPLACE FUNCTION public.clin_lab_order_delete_draft(p_lab_order_id uuid, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_row public.lab_orders%ROWTYPE;
BEGIN
  -- 0036: another doctor's order is not found (and not locked) for a doctor.
  SELECT * INTO v_row FROM public.lab_orders o
  WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic AND public.clin__lab_order_visible(o.doctor_id)
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  IF v_row.status::text <> 'draft' THEN
    PERFORM public.clin__raise('CL_LAB_NOT_DRAFT');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.lab_order_costs c JOIN public.fin_entries e ON e.id = c.fin_entry_id
    WHERE c.lab_order_id = v_row.id AND e.cancelled_at IS NULL
  ) THEN
    PERFORM public.clin__raise('CL_LAB_COST_POSTED');
  END IF;

  DELETE FROM public.lab_orders WHERE id = v_row.id AND clinic_id = v_clinic;
  RETURN jsonb_build_object('ok', true, 'deleted_id', v_row.id);
END;
$$;

-- 5.10 Lab cost (D2 / D3). NULL amount removes the cost. A posted cost is changed only by a 'finance' holder and
--      never below what has been paid; the finance entry follows (amount, or cancel on removal). A new or changed
--      unposted cost is posted at once only when the setting is on AND the caller holds 'finance'.
CREATE OR REPLACE FUNCTION public.clin_lab_order_set_cost(p_lab_order_id uuid, p_cost_version integer,
                                                          p_amount_cents bigint, p_note text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_actor uuid := public.current_app_user_id();
  v_fin boolean := coalesce(public.has_permission('finance'), false);
  v_fin_read boolean := coalesce(public.has_permission('finance'), false)
                        OR coalesce(public.has_permission('finance_readonly'), false);
  v_order public.lab_orders%ROWTYPE;
  v_cost public.lab_order_costs%ROWTYPE;
  v_note text := btrim(coalesce(p_note, ''));
  v_entry uuid;
  v_paid bigint;
  v_changed boolean := false;
  v_json jsonb;
BEGIN
  IF NOT public.clin_can_edit_lab_costs() THEN
    PERFORM public.clin__raise('CL_LAB_COST_FORBIDDEN');
  END IF;
  -- 0036: another doctor's order is not found (and not locked) for a doctor.
  SELECT * INTO v_order FROM public.lab_orders o
  WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic AND public.clin__lab_order_visible(o.doctor_id)
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  v_entry := public.clin__cost_live_entry(v_clinic, v_order.id);
  SELECT * INTO v_cost FROM public.lab_order_costs c
  WHERE c.lab_order_id = v_order.id AND c.clinic_id = v_clinic
  FOR UPDATE;
  IF v_cost.lab_order_id IS NULL THEN
    IF p_cost_version IS NOT NULL THEN
      PERFORM public.clin__raise('CL_VERSION');
    END IF;
  ELSIF p_cost_version IS DISTINCT FROM v_cost.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  IF char_length(v_note) > 500 THEN
    PERFORM public.clin__raise('CL_LAB_NOTE');
  END IF;
  IF p_amount_cents IS NOT NULL AND p_amount_cents NOT BETWEEN 1 AND 1000000000 THEN
    PERFORM public.clin__raise('CL_LAB_COST');
  END IF;

  IF v_entry IS NOT NULL THEN
    -- Posted.
    IF NOT v_fin THEN
      PERFORM public.clin__raise('CL_LAB_COST_POSTED');
    END IF;
    SELECT coalesce(sum(fp.amount_cents), 0)::bigint INTO v_paid
    FROM public.fin_payments fp WHERE fp.entry_id = v_entry AND fp.voided_at IS NULL;
    IF p_amount_cents IS NULL THEN
      IF v_paid > 0 THEN
        PERFORM public.clin__raise('CL_LAB_COST_PAID');
      END IF;
      UPDATE public.fin_entries
      SET cancelled_at = now(), cancelled_by = v_actor,
          cancel_reason = 'Lab maliyeti kaldırıldı (' || v_order.order_number || ')'
      WHERE id = v_entry AND clinic_id = v_clinic AND cancelled_at IS NULL;
      DELETE FROM public.lab_order_costs WHERE lab_order_id = v_order.id AND clinic_id = v_clinic;
    ELSE
      IF p_amount_cents < v_paid THEN
        PERFORM public.clin__raise('CL_LAB_COST_PAID');
      END IF;
      IF p_amount_cents <> v_cost.amount_cents THEN
        -- 0020 fin__trg_touch bumps version / updated_*; fin_paid_within_amount is the backstop.
        UPDATE public.fin_entries SET amount_cents = p_amount_cents
        WHERE id = v_entry AND clinic_id = v_clinic AND cancelled_at IS NULL;
      END IF;
      IF p_amount_cents <> v_cost.amount_cents OR v_note <> v_cost.note THEN
        UPDATE public.lab_order_costs
        SET amount_cents = p_amount_cents, note = v_note, version = version + 1, updated_by = v_actor, updated_at = now()
        WHERE lab_order_id = v_order.id AND clinic_id = v_clinic;
      END IF;
    END IF;
  ELSE
    -- Not posted.
    IF p_amount_cents IS NULL THEN
      DELETE FROM public.lab_order_costs WHERE lab_order_id = v_order.id AND clinic_id = v_clinic;
    ELSIF v_cost.lab_order_id IS NULL THEN
      INSERT INTO public.lab_order_costs (lab_order_id, clinic_id, amount_cents, note, version, updated_by)
      VALUES (v_order.id, v_clinic, p_amount_cents, v_note, 1, v_actor);
      v_changed := true;
    ELSIF p_amount_cents <> v_cost.amount_cents OR v_note <> v_cost.note THEN
      UPDATE public.lab_order_costs
      SET amount_cents = p_amount_cents, note = v_note, version = version + 1, updated_by = v_actor, updated_at = now()
      WHERE lab_order_id = v_order.id AND clinic_id = v_clinic;
      v_changed := true;
    END IF;
    -- Automatic post only for a job that went to the lab and is not cancelled, and only when the finance 'lab'
    -- category exists; otherwise the cost is saved and stays 'awaiting_finance' for an explicit clin_lab_cost_post
    -- (which reports CL_LAB_COST_DRAFT / CL_FIN_CATEGORY), so a finance setup gap never loses the amount.
    IF v_changed AND v_fin AND public.clin__payable_enabled(v_clinic)
       AND v_order.status::text NOT IN ('draft', 'cancelled')
       AND EXISTS (SELECT 1 FROM public.fin_categories k
                   WHERE k.clinic_id = v_clinic AND k.report_bucket = 'lab' AND k.is_system AND k.is_active) THEN
      PERFORM public.clin__post_lab_cost(v_clinic, v_order.id, v_actor);
    END IF;
  END IF;

  v_json := public.clin__lab_order_json(v_clinic, v_order.id, true, v_fin_read);
  RETURN jsonb_build_object('ok', true, 'cost', v_json -> 'cost', 'payable_state', v_json #> '{cost,payable_state}');
END;
$$;

-- 5.11 Post a cost to finance as a payable ('finance' holders, setting on, one post per cost).
CREATE OR REPLACE FUNCTION public.clin_lab_cost_post(p_lab_order_id uuid, p_cost_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_actor uuid := public.current_app_user_id();
  v_order public.lab_orders%ROWTYPE;
  v_cost public.lab_order_costs%ROWTYPE;
  v_entry uuid;
  v_json jsonb;
BEGIN
  IF NOT coalesce(public.has_permission('finance'), false) THEN
    PERFORM public.clin__raise('CL_FINANCE');
  END IF;
  IF NOT public.clin__payable_enabled(v_clinic) THEN
    PERFORM public.clin__raise('CL_PAYABLE_OFF');
  END IF;
  -- 0036: another doctor's order is not found (and not locked) for a doctor.
  SELECT * INTO v_order FROM public.lab_orders o
  WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic AND public.clin__lab_order_visible(o.doctor_id)
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  v_entry := public.clin__cost_live_entry(v_clinic, v_order.id);
  SELECT * INTO v_cost FROM public.lab_order_costs c
  WHERE c.lab_order_id = v_order.id AND c.clinic_id = v_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF p_cost_version IS DISTINCT FROM v_cost.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  IF v_entry IS NOT NULL THEN
    PERFORM public.clin__raise('CL_PAYABLE_DONE');
  END IF;

  v_entry := public.clin__post_lab_cost(v_clinic, v_order.id, v_actor);
  v_json := public.clin__lab_order_json(v_clinic, v_order.id, true, true);
  RETURN jsonb_build_object('ok', true, 'cost', v_json -> 'cost', 'payable_state', 'posted', 'fin_entry_id', v_entry);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Lab read RPCs (0026 §6.7 – §6.8 bodies, same signatures). Changes: the list (rows, total and tile counts) only
--    over the orders the caller may see; the detail of another doctor's order is CL_NOT_FOUND.
-- ---------------------------------------------------------------------------
-- 6.7 Lab order list with the late filter and the tile counts (CW:37).
CREATE OR REPLACE FUNCTION public.clin_lab_order_list(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_today date := public.clinic_today();
  v_can_cost boolean := public.clin_can_view_lab_costs();
  v_can_fin boolean := coalesce(public.has_permission('finance'), false);
  v_fin_read boolean := coalesce(public.has_permission('finance'), false)
                        OR coalesce(public.has_permission('finance_readonly'), false);
  v_payable boolean := public.clin__payable_enabled(v_clinic);
  -- 0036: a doctor lists and counts only the orders of their own doctor record (none without one).
  v_all boolean := public.clin_can_view_all_lab_orders();
  v_own uuid := public.clin_my_doctor_id();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_status text[];
  v_late boolean;
  v_lab uuid;
  v_patient uuid;
  v_doctor uuid;
  v_from date;
  v_to date;
  v_pending boolean;
  v_offset integer;
  v_limit integer;
  v_rows jsonb;
  v_total bigint;
  v_counts jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_f) AS k(k_name)
    WHERE k.k_name NOT IN ('q', 'status', 'late', 'lab_id', 'patient_id', 'doctor_id', 'sent_from', 'sent_to',
                           'payable_pending')
  ) THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  v_q := public.clin__j_text(v_f, 'q');
  IF char_length(v_q) > 100 THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  v_q := public.clin__tr_lower(v_q);
  v_status := public.clin__j_codes(v_f, 'status', ARRAY['draft', 'submitted', 'in_progress', 'try_in', 'revision',
                                                         'ready', 'delivered', 'cancelled']);
  v_late := coalesce(public.clin__j_bool(v_f, 'late'), false);
  v_lab := public.clin__j_uuid(v_f, 'lab_id');
  v_patient := public.clin__j_uuid(v_f, 'patient_id');
  v_doctor := public.clin__j_uuid(v_f, 'doctor_id');
  v_from := public.clin__day(public.clin__j_text(v_f, 'sent_from'), 'CL_FILTER');
  v_to := public.clin__day(public.clin__j_text(v_f, 'sent_to'), 'CL_FILTER');
  v_pending := coalesce(public.clin__j_bool(v_f, 'payable_pending'), false);
  IF v_pending AND NOT v_can_fin THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.clin__page(p_page, 200) pg;

  WITH a AS (
    SELECT r.* FROM public.clin__lab_order_rows(v_clinic, v_today, v_can_cost, v_fin_read, v_payable) r
    WHERE v_all OR r.doctor_id = v_own
  ), f AS (
    SELECT a.*,
           row_number() OVER (
             ORDER BY CASE WHEN v_late THEN a.due_date END ASC,
                      a.created_at DESC, a.id) AS rn
    FROM a
    WHERE (v_q IS NULL OR strpos(a.search, v_q) > 0)
      AND (v_status IS NULL OR a.status = ANY (v_status))
      AND (NOT v_late OR a.is_late)
      AND (v_lab IS NULL OR a.lab_id = v_lab)
      AND (v_patient IS NULL OR a.patient_id = v_patient)
      AND (v_doctor IS NULL OR a.doctor_id = v_doctor)
      AND (v_from IS NULL OR a.sent_on >= v_from)
      AND (v_to IS NULL OR a.sent_on <= v_to)
      AND (NOT v_pending OR a.payable_state = 'awaiting_finance')
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(f.j ORDER BY f.rn) FROM f WHERE f.rn > v_offset AND f.rn <= v_offset + v_limit),
                  '[]'::jsonb),
         (SELECT jsonb_build_object(
                   'draft', count(*) FILTER (WHERE a.status = 'draft'),
                   'at_lab', count(*) FILTER (WHERE a.status IN ('submitted', 'in_progress')),
                   'late', count(*) FILTER (WHERE a.is_late),
                   'try_in', count(*) FILTER (WHERE a.status = 'try_in'),
                   'revision', count(*) FILTER (WHERE a.status = 'revision'),
                   'arrived', count(*) FILTER (WHERE a.status = 'ready'),
                   'delivered_30d', count(*) FILTER (WHERE a.status = 'delivered' AND a.delivery_date >= v_today - 30))
                 || CASE WHEN v_can_fin
                         THEN jsonb_build_object('payable_pending',
                                                 count(*) FILTER (WHERE a.payable_state = 'awaiting_finance'))
                         ELSE '{}'::jsonb END
          FROM a)
    INTO v_total, v_rows, v_counts;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'counts', v_counts, 'today', v_today,
                            'flags', public.clin__flags());
END;
$$;

-- 6.8 Lab order detail: order, items, status history (oldest first), payable switch.
CREATE OR REPLACE FUNCTION public.clin_lab_order_detail(p_lab_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_can_cost boolean := public.clin_can_view_lab_costs();
  v_fin_read boolean := coalesce(public.has_permission('finance'), false)
                        OR coalesce(public.has_permission('finance_readonly'), false);
  v_order jsonb;
  v_items jsonb;
  v_events jsonb;
BEGIN
  -- 0036: another doctor's order reads as missing for a doctor.
  IF NOT EXISTS (SELECT 1 FROM public.lab_orders o
                 WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic
                   AND public.clin__lab_order_visible(o.doctor_id)) THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  v_order := public.clin__lab_order_json(v_clinic, p_lab_order_id, v_can_cost, v_fin_read);
  IF v_order IS NULL THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'item_type', i.item_type, 'tooth_number', coalesce(i.tooth_number, ''),
           'material', coalesce(i.material, ''), 'color_code', coalesce(i.color_code, ''),
           'quantity', coalesce(i.quantity, 1), 'description', coalesce(i.description, ''))
           ORDER BY i.created_at, i.id), '[]'::jsonb)
    INTO v_items
  FROM public.lab_order_items i
  WHERE i.lab_order_id = p_lab_order_id AND i.clinic_id = v_clinic;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'from_status', e.from_status::text, 'to_status', e.to_status::text, 'on_date', e.on_date,
           'note', e.note, 'actor_name', u.full_name, 'created_at', e.created_at)
           ORDER BY e.created_at, e.id), '[]'::jsonb)
    INTO v_events
  FROM public.lab_order_events e
  LEFT JOIN public.users u ON u.id = e.actor_user_id
  WHERE e.lab_order_id = p_lab_order_id AND e.clinic_id = v_clinic;

  RETURN jsonb_build_object('order', v_order, 'items', v_items, 'events', v_events,
                            'settings', jsonb_build_object('lab_cost_payable_enabled',
                                                           public.clin__payable_enabled(v_clinic)),
                            'today', public.clinic_today(), 'flags', public.clin__flags());
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Row level security (0026 §4.1, replaced by name). Each lab table keeps exactly one permissive SELECT policy for
--    authenticated: its 0026 terms AND (the caller may see every order OR the order belongs to the caller's doctor
--    record); the child rows follow their order. Table privileges are not touched (SELECT only, 0026 §4.2).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS lab_orders_clinic_isolation ON public.lab_orders;
CREATE POLICY lab_orders_clinic_isolation ON public.lab_orders
  FOR SELECT TO authenticated
  USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND ((SELECT public.clin_can_view_all_lab_orders()) OR doctor_id = (SELECT public.clin_my_doctor_id()))
  );

DROP POLICY IF EXISTS lab_order_items_clinic_isolation ON public.lab_order_items;
CREATE POLICY lab_order_items_clinic_isolation ON public.lab_order_items
  FOR SELECT TO authenticated
  USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND ((SELECT public.clin_can_view_all_lab_orders())
         OR EXISTS (SELECT 1 FROM public.lab_orders o
                    WHERE o.id = lab_order_items.lab_order_id AND o.clinic_id = lab_order_items.clinic_id
                      AND o.doctor_id = (SELECT public.clin_my_doctor_id())))
  );

DROP POLICY IF EXISTS lab_order_events_select ON public.lab_order_events;
CREATE POLICY lab_order_events_select ON public.lab_order_events
  FOR SELECT TO authenticated
  USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND ((SELECT public.clin_can_view_all_lab_orders())
         OR EXISTS (SELECT 1 FROM public.lab_orders o
                    WHERE o.id = lab_order_events.lab_order_id AND o.clinic_id = lab_order_events.clinic_id
                      AND o.doctor_id = (SELECT public.clin_my_doctor_id())))
  );

DROP POLICY IF EXISTS lab_order_costs_select ON public.lab_order_costs;
CREATE POLICY lab_order_costs_select ON public.lab_order_costs
  FOR SELECT TO authenticated
  USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND (SELECT public.clin_can_view_lab_costs())
    AND ((SELECT public.clin_can_view_all_lab_orders())
         OR EXISTS (SELECT 1 FROM public.lab_orders o
                    WHERE o.id = lab_order_costs.lab_order_id AND o.clinic_id = lab_order_costs.clinic_id
                      AND o.doctor_id = (SELECT public.clin_my_doctor_id())))
  );

-- ---------------------------------------------------------------------------
-- 7. Privileges. clin__harden_privileges() (0026 §4.4): every clin_* function loses EXECUTE from PUBLIC, anon and
--    authenticated; public RPCs and helpers (single underscore: the two new helpers included, which RLS needs) are
--    granted to authenticated, internals (clin__lab_order_visible) never; then its checks (no overloads, definer +
--    search_path on every public one, no definer internal, table privileges). Losing PUBLIC also keeps 0029's rule
--    that the backup role executes no SECURITY DEFINER function but backup_heartbeat.
-- ---------------------------------------------------------------------------
SELECT public.clin__harden_privileges();

-- ---------------------------------------------------------------------------
-- 8.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_err text;
  v_state text;
  v_hint text;
BEGIN
  -- 1. The new functions with their signatures; each replaced one once (clin__harden_privileges refuses overloads).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.clin_can_view_all_lab_orders()',
    'public.clin_my_doctor_id()',
    'public.clin__lab_order_visible(uuid)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hekim kapsamı fonksiyonları bulunamadı: %', v_bad;
  END IF;

  -- 2. The two helpers: SECURITY DEFINER + search_path, callable by authenticated (RLS), never by anon. The internal:
  --    SECURITY INVOKER, callable by nobody from the API.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('clin_can_view_all_lab_orders', 'clin_my_doctor_id')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hekim kapsamı yardımcılarının yetkileri beklenen gibi değil: %', v_bad;
  END IF;
  IF (SELECT p.prosecdef
             OR has_function_privilege('anon', p.oid, 'EXECUTE')
             OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.clin__lab_order_visible(uuid)')) THEN
    RAISE EXCEPTION 'clin__lab_order_visible API''ye açık veya SECURITY DEFINER.';
  END IF;
  -- 0029: the backup role executes no SECURITY DEFINER function of this file.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentos_backup') THEN
    SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'clin\_%' AND p.prosecdef
      AND has_function_privilege('dentos_backup', p.oid, 'EXECUTE');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'dentos_backup şu SECURITY DEFINER klinik fonksiyonlarını çalıştırabiliyor: %', v_bad;
    END IF;
  END IF;

  -- 3. Every replaced body carries the scope.
  SELECT string_agg(e.fn, ', ') INTO v_bad
  FROM (VALUES
    ('clin__raise', '%CL_LAB_OWN_DOCTOR%'),
    ('clin__raise', '%CL_LAB_NO_DOCTOR%'),
    ('clin__raise', '%CL_HISTORY%'),
    ('clin__flags', '%lab_own_only%'),
    ('clin__flags', '%can_view_material_costs%'),
    ('clin__lab_json', '%clin__lab_order_visible%'),
    ('clin_lab_order_save', '%CL_LAB_OWN_DOCTOR%'),
    ('clin_lab_order_save', '%clin__lab_order_visible%'),
    ('clin_lab_order_set_status', '%clin__lab_order_visible%'),
    ('clin_lab_order_delete_draft', '%clin__lab_order_visible%'),
    ('clin_lab_order_set_cost', '%clin__lab_order_visible%'),
    ('clin_lab_cost_post', '%clin__lab_order_visible%'),
    ('clin_lab_order_list', '%clin_my_doctor_id%'),
    ('clin_lab_order_detail', '%clin__lab_order_visible%')
  ) AS e(fn, pat)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = e.fn AND p.prosrc LIKE e.pat
  );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Şu fonksiyonlarda hekim kapsamı yok: %', v_bad;
  END IF;

  -- 4. RLS on; exactly one permissive SELECT policy for authenticated on each lab table, with the scope.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['lab_orders', 'lab_order_items', 'lab_order_events', 'lab_order_costs']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tbl
                      AND p.cmd = 'SELECT' AND p.permissive = 'PERMISSIVE'
                      AND p.roles = ARRAY['authenticated']::name[]
                      AND p.qual ILIKE '%current_clinic_id%'
                      AND p.qual ILIKE '%clin_can_view_all_lab_orders%'
                      AND p.qual ILIKE '%clin_my_doctor_id%'
                      AND (t.tbl <> 'lab_order_costs' OR p.qual ILIKE '%clin_can_view_lab_costs%'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: lab tablolarının RLS politikası beklenen gibi değil: %', v_bad;
  END IF;

  -- 5. The new error keys (text, 403, key in HINT).
  BEGIN
    PERFORM public.clin__raise('CL_LAB_OWN_DOCTOR');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
  END;
  IF v_err IS DISTINCT FROM 'Hekim hesabıyla yalnızca kendi adınıza lab işi açabilir veya düzenleyebilirsiniz.'
     OR v_state IS DISTINCT FROM '42501' OR v_hint IS DISTINCT FROM 'CL_LAB_OWN_DOCTOR' THEN
    RAISE EXCEPTION 'CL_LAB_OWN_DOCTOR beklenen gibi değil: % / % / %', v_err, v_state, v_hint;
  END IF;
  v_err := NULL;
  v_state := NULL;
  v_hint := NULL;
  BEGIN
    PERFORM public.clin__raise('CL_LAB_NO_DOCTOR');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'Hesabınıza bağlı hekim kaydı bulunamadı.%'
     OR v_state IS DISTINCT FROM '42501' OR v_hint IS DISTINCT FROM 'CL_LAB_NO_DOCTOR' THEN
    RAISE EXCEPTION 'CL_LAB_NO_DOCTOR beklenen gibi değil: % / % / %', v_err, v_state, v_hint;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.2 Replay inside a block that is always rolled back: temporary clinic 'p36-test-selfcheck-<random>' with the
--     owner O, doctor A ('stock_cost_view'), doctor B, doctor N (no doctor record), doctor F ('finance') and an
--     assistant S; one patient, one lab; A's orders A1 and A2 (drafts), B's orders B1 (draft) and B2 (sent, with a
--     cost), A1 with a cost; one item and one history row each. Written directly with made-up order numbers, so
--     lab_order_number_seq is never used. auth.uid() is simulated through request.jwt.claims (and
--     request.jwt.claim.sub / .role), as in 0030 – 0035. Checked: the stored policy expressions evaluated for each
--     person (orders, items, history, costs), every lab RPC for A (another doctor's order: not listed, not counted,
--     not found, not changed; no order for or moved to another doctor; the own order: retry, edit, status, delete,
--     cost), N (nothing), S, F and O (every order, as before), and the session-less answers. Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p36-test-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_today date := public.clinic_today();
  v_due text := to_char(public.clinic_today() + 7, 'YYYY-MM-DD');
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_a_auth uuid := gen_random_uuid();
  v_a_doc uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_b_auth uuid := gen_random_uuid();
  v_b_doc uuid := gen_random_uuid();
  v_n uuid := gen_random_uuid();
  v_n_auth uuid := gen_random_uuid();
  v_f uuid := gen_random_uuid();
  v_f_auth uuid := gen_random_uuid();
  v_f_doc uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_s_auth uuid := gen_random_uuid();
  v_pt uuid := gen_random_uuid();
  v_lab uuid := gen_random_uuid();
  v_oa1 uuid := gen_random_uuid();
  v_oa2 uuid := gen_random_uuid();
  v_ob1 uuid := gen_random_uuid();
  v_ob2 uuid := gen_random_uuid();
  v_all uuid[];
  v_items jsonb := '[{"item_type": "crown", "tooth_number": "36", "material": "zirconium", "color_code": "",
                      "quantity": 1, "description": ""}]';
  v_u record;
  v_p record;
  v_ids uuid[];
  v_want uuid[];
  v_j jsonb;
  v_sqls text[];
  v_keys text[];
  v_states text[];
  v_i integer;
  v_err text;
  v_state text;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  v_all := ARRAY[v_oa1, v_oa2, v_ob1, v_ob2];
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P36', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p36-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p36-sc-a-' || v_tag || '@example.invalid', true),
      (v_b, v_clinic, v_b_auth, 'doctor', 'Öz denetim Hekim B', 'p36-sc-b-' || v_tag || '@example.invalid', true),
      (v_n, v_clinic, v_n_auth, 'doctor', 'Öz denetim Hekim N', 'p36-sc-n-' || v_tag || '@example.invalid', true),
      (v_f, v_clinic, v_f_auth, 'doctor', 'Öz denetim Hekim F', 'p36-sc-f-' || v_tag || '@example.invalid', true),
      (v_s, v_clinic, v_s_auth, 'assistant', 'Öz denetim asistan', 'p36-sc-s-' || v_tag || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_a_doc, v_clinic, v_a), (v_b_doc, v_clinic, v_b), (v_f_doc, v_clinic, v_f);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_a, 'stock_cost_view', v_own), (v_clinic, v_f, 'finance', v_own);
    INSERT INTO public.patients (id, clinic_id, full_name, phone) VALUES (v_pt, v_clinic, 'Öz denetim hasta', '5300000036');
    INSERT INTO public.labs (id, clinic_id, name, name_key) VALUES (v_lab, v_clinic, 'Öz denetim lab', 'x');
    INSERT INTO public.lab_orders (id, clinic_id, patient_id, doctor_id, order_number, status, due_date, sent_on, lab_id,
                                   lab_name, version, created_by, updated_by) VALUES
      (v_oa1, v_clinic, v_pt, v_a_doc, 'LAB-P36-' || v_tag || '-1', 'draft', v_today + 7, NULL, v_lab, 'x', 1, v_a, v_a),
      (v_oa2, v_clinic, v_pt, v_a_doc, 'LAB-P36-' || v_tag || '-2', 'draft', v_today + 7, NULL, v_lab, 'x', 1, v_a, v_a),
      (v_ob1, v_clinic, v_pt, v_b_doc, 'LAB-P36-' || v_tag || '-3', 'draft', v_today + 7, NULL, v_lab, 'x', 1, v_b, v_b),
      (v_ob2, v_clinic, v_pt, v_b_doc, 'LAB-P36-' || v_tag || '-4', 'submitted', v_today + 7, v_today - 1, v_lab, 'x', 1,
       v_b, v_b);
    INSERT INTO public.lab_order_items (clinic_id, lab_order_id, item_type, tooth_number, material, quantity)
    SELECT v_clinic, x.id, 'crown', '36', 'zirconium', 1 FROM unnest(v_all) AS x(id);
    INSERT INTO public.lab_order_events (clinic_id, lab_order_id, from_status, to_status, on_date, note, actor_user_id)
    SELECT v_clinic, x.id, NULL::public.lab_order_status, 'draft'::public.lab_order_status, v_today - 1, '', v_own
    FROM unnest(v_all) AS x(id);
    INSERT INTO public.lab_order_costs (lab_order_id, clinic_id, amount_cents, note, version, updated_by) VALUES
      (v_oa1, v_clinic, 20000, '', 1, v_own), (v_ob2, v_clinic, 10000, '', 1, v_own);

    -- Row level security: the stored policy expressions, evaluated for each person (orders / items / history use the
    -- order list, costs the cost list). Costs stay gated by clin_can_view_lab_costs (B and S see none, as before).
    FOR v_u IN
      SELECT * FROM (VALUES
        ('A', v_a_auth, ARRAY[v_oa1, v_oa2], ARRAY[v_oa1]),
        ('B', v_b_auth, ARRAY[v_ob1, v_ob2], ARRAY[]::uuid[]),
        ('N', v_n_auth, ARRAY[]::uuid[], ARRAY[]::uuid[]),
        ('S', v_s_auth, v_all, ARRAY[]::uuid[]),
        ('F', v_f_auth, v_all, ARRAY[v_oa1, v_ob2]),
        ('O', v_own_auth, v_all, ARRAY[v_oa1, v_ob2])
      ) AS x(who, auth_id, orders, costs)
    LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_u.auth_id, 'role', 'authenticated')::text,
                         true);
      PERFORM set_config('request.jwt.claim.sub', v_u.auth_id::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      IF auth.uid() IS DISTINCT FROM v_u.auth_id THEN
        RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
      END IF;
      FOR v_p IN
        SELECT p.tablename::text AS tbl, p.qual
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename IN ('lab_orders', 'lab_order_items', 'lab_order_events', 'lab_order_costs')
      LOOP
        EXECUTE format('SELECT coalesce(array_agg(DISTINCT %s), ''{}''::uuid[]) FROM public.%I WHERE %s',
                       CASE WHEN v_p.tbl = 'lab_orders' THEN 'id' ELSE 'lab_order_id' END, v_p.tbl, v_p.qual)
          INTO v_ids;
        v_want := CASE WHEN v_p.tbl = 'lab_order_costs' THEN v_u.costs ELSE v_u.orders END;
        IF NOT (v_ids @> v_want AND v_ids <@ v_want) THEN
          v_fail := array_append(v_fail, format('RLS %s / %s: %s satır, beklenen %s', v_u.who, v_p.tbl,
                                                cardinality(v_ids), cardinality(v_want)));
        END IF;
      END LOOP;
    END LOOP;

    -- Doctor A ('stock_cost_view', no finance): own record only.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF public.clin_can_view_all_lab_orders() OR public.clin_my_doctor_id() IS DISTINCT FROM v_a_doc
       OR public.clin__lab_order_visible(v_b_doc) OR NOT public.clin__lab_order_visible(v_a_doc)
       OR public.clin__lab_order_visible(NULL) THEN
      v_fail := array_append(v_fail, 'hekim A kapsam yardımcıları');
    END IF;

    -- Refusals: another doctor's order is not found / not changed; nothing for or moved to another doctor; a create
    -- retry with another person's order id is CL_ID_TAKEN (no data); cost posting keeps its finance check first.
    v_sqls := ARRAY[
      format('SELECT public.clin_lab_order_detail(%L)', v_ob1),
      format('SELECT public.clin_lab_order_save(%L, NULL, %L, %L, %L, %L, %L, %L::jsonb)',
             gen_random_uuid(), v_pt, v_b_doc, v_lab, v_due, '', v_items),
      format('SELECT public.clin_lab_order_save(%L, NULL, %L, %L, %L, %L, %L, %L::jsonb)',
             v_ob1, v_pt, v_a_doc, v_lab, v_due, '', v_items),
      format('SELECT public.clin_lab_order_save(%L, 1, %L, %L, %L, %L, %L, %L::jsonb)',
             v_ob1, v_pt, v_a_doc, v_lab, v_due, 'x', v_items),
      format('SELECT public.clin_lab_order_save(%L, 1, %L, %L, %L, %L, %L, %L::jsonb)',
             v_ob1, v_pt, v_b_doc, v_lab, v_due, 'x', v_items),
      format('SELECT public.clin_lab_order_save(%L, 1, %L, %L, %L, %L, %L, %L::jsonb)',
             v_oa1, v_pt, v_b_doc, v_lab, v_due, '', v_items),
      format('SELECT public.clin_lab_order_set_status(%L, 1, %L)', v_ob1, 'submitted'),
      format('SELECT public.clin_lab_order_set_status(%L, 1, %L, NULL, %L)', v_ob2, 'cancelled', 'Öz denetim'),
      format('SELECT public.clin_lab_order_delete_draft(%L, 1)', v_ob1),
      format('SELECT public.clin_lab_order_set_cost(%L, 1, 15000)', v_ob2),
      format('SELECT public.clin_lab_order_set_cost(%L, NULL, 15000)', v_ob1),
      format('SELECT public.clin_lab_cost_post(%L, 1)', v_ob2)];
    v_keys := ARRAY['CL_NOT_FOUND', 'CL_LAB_OWN_DOCTOR', 'CL_ID_TAKEN', 'CL_NOT_FOUND', 'CL_LAB_OWN_DOCTOR',
                    'CL_LAB_OWN_DOCTOR', 'CL_NOT_FOUND', 'CL_NOT_FOUND', 'CL_NOT_FOUND', 'CL_NOT_FOUND', 'CL_NOT_FOUND',
                    'CL_FINANCE'];
    v_states := ARRAY['PT404', '42501', 'PT409', 'PT404', '42501', '42501', 'PT404', 'PT404', 'PT404', 'PT404',
                      'PT404', '42501'];
    FOR v_i IN 1 .. cardinality(v_sqls) LOOP
      v_err := NULL;
      v_state := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
      END;
      IF v_err IS DISTINCT FROM v_keys[v_i] OR v_state IS DISTINCT FROM v_states[v_i] THEN
        v_fail := array_append(v_fail, format('hekim A ret %s: %s / %s (beklenen %s / %s)', v_i, coalesce(v_err, '-'),
                                              coalesce(v_state, 'hata yok'), v_keys[v_i], v_states[v_i]));
      END IF;
    END LOOP;
    -- Nothing of B's changed.
    IF (SELECT string_agg(o.status::text || ':' || o.version || ':' || o.doctor_id::text, ',' ORDER BY o.order_number)
        FROM public.lab_orders o WHERE o.id IN (v_ob1, v_ob2))
       IS DISTINCT FROM 'draft:1:' || v_b_doc || ',submitted:1:' || v_b_doc
       OR (SELECT c.amount_cents FROM public.lab_order_costs c WHERE c.lab_order_id = v_ob2) IS DISTINCT FROM 10000
       OR EXISTS (SELECT 1 FROM public.lab_order_costs c WHERE c.lab_order_id = v_ob1)
       OR (SELECT count(*) FROM public.lab_orders o WHERE o.clinic_id = v_clinic) <> 4 THEN
      v_fail := array_append(v_fail, 'hekim A başka hekimin işini değiştirdi');
    END IF;

    -- A's list: own orders only, own tile counts; a filter or search for B's order finds nothing.
    v_j := public.clin_lab_order_list('{}'::jsonb, NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rows') r WHERE (r ->> 'doctor_id')::uuid <> v_a_doc)
       OR (v_j #>> '{counts,draft}')::integer IS DISTINCT FROM 2
       OR (v_j #>> '{counts,at_lab}')::integer IS DISTINCT FROM 0
       OR (v_j #>> '{flags,lab_own_only}')::boolean IS DISTINCT FROM true
       OR (v_j #>> '{flags,my_doctor_id}')::uuid IS DISTINCT FROM v_a_doc THEN
      v_fail := array_append(v_fail, 'hekim A liste: ' || left(v_j::text, 600));
    END IF;
    v_j := public.clin_lab_order_list(jsonb_build_object('doctor_id', v_b_doc), NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 0 OR jsonb_array_length(v_j -> 'rows') <> 0 THEN
      v_fail := array_append(v_fail, 'hekim A, B filtresi: ' || left(v_j::text, 300));
    END IF;
    v_j := public.clin_lab_order_list(jsonb_build_object('q', 'LAB-P36-' || v_tag || '-3'), NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 0 THEN
      v_fail := array_append(v_fail, 'hekim A, B işinin aranması: ' || left(v_j::text, 300));
    END IF;

    -- A's own order: detail, create retry ("already saved"), edit, status, cost, draft delete.
    v_j := public.clin_lab_order_detail(v_oa1);
    IF (v_j #>> '{order,doctor_id}')::uuid IS DISTINCT FROM v_a_doc OR jsonb_array_length(v_j -> 'items') <> 1
       OR jsonb_array_length(v_j -> 'events') <> 1 OR (v_j #>> '{order,cost,amount_cents}')::bigint IS DISTINCT FROM 20000
       OR (v_j #>> '{flags,lab_own_only}')::boolean IS DISTINCT FROM true THEN
      v_fail := array_append(v_fail, 'hekim A kendi işinin detayı: ' || left(v_j::text, 600));
    END IF;
    v_j := public.clin_lab_order_save(v_oa2, NULL, v_pt, v_a_doc, v_lab, v_due, '', v_items);
    IF (v_j ->> 'already_saved')::boolean IS DISTINCT FROM true OR (v_j #>> '{order,id}')::uuid IS DISTINCT FROM v_oa2 THEN
      v_fail := array_append(v_fail, 'hekim A yeniden deneme: ' || left(v_j::text, 300));
    END IF;
    v_j := public.clin_lab_order_save(v_oa1, 1, v_pt, v_a_doc, v_lab, v_due, 'Öz denetim notu', v_items);
    IF (v_j #>> '{order,version}')::integer IS DISTINCT FROM 2 OR v_j #>> '{order,notes}' IS DISTINCT FROM 'Öz denetim notu'
       OR (v_j #>> '{order,doctor_id}')::uuid IS DISTINCT FROM v_a_doc THEN
      v_fail := array_append(v_fail, 'hekim A düzenleme: ' || left(v_j::text, 300));
    END IF;
    v_j := public.clin_lab_order_set_status(v_oa1, 2, 'submitted');
    IF v_j #>> '{order,status}' IS DISTINCT FROM 'submitted' OR (v_j #>> '{order,version}')::integer IS DISTINCT FROM 3 THEN
      v_fail := array_append(v_fail, 'hekim A durum: ' || left(v_j::text, 300));
    END IF;
    v_j := public.clin_lab_order_set_cost(v_oa1, 1, 25000, '');
    IF (v_j #>> '{cost,amount_cents}')::bigint IS DISTINCT FROM 25000 THEN
      v_fail := array_append(v_fail, 'hekim A maliyet: ' || left(v_j::text, 300));
    END IF;
    v_j := public.clin_lab_order_delete_draft(v_oa2, 1);
    IF (v_j ->> 'deleted_id')::uuid IS DISTINCT FROM v_oa2 OR EXISTS (SELECT 1 FROM public.lab_orders WHERE id = v_oa2) THEN
      v_fail := array_append(v_fail, 'hekim A taslak silme: ' || left(v_j::text, 300));
    END IF;
    -- The labs directory response counts A's open orders only (A1; B1 and B2 are B's).
    IF (public.clin__lab_json(v_clinic, v_lab, false) ->> 'open_order_count')::integer IS DISTINCT FROM 1 THEN
      v_fail := array_append(v_fail, 'hekim A açık iş sayısı: ' || (public.clin__lab_json(v_clinic, v_lab, false))::text);
    END IF;

    -- Doctor B: own orders, untouched.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_b_auth::text, true);
    v_j := public.clin_lab_order_list('{}'::jsonb, NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rows') r WHERE (r ->> 'doctor_id')::uuid <> v_b_doc)
       OR (v_j #>> '{counts,draft}')::integer IS DISTINCT FROM 1 OR (v_j #>> '{counts,at_lab}')::integer IS DISTINCT FROM 1 THEN
      v_fail := array_append(v_fail, 'hekim B liste: ' || left(v_j::text, 600));
    END IF;

    -- Doctor N (no doctor record): nothing to see, nothing to create.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_n_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_n_auth::text, true);
    v_j := public.clin_lab_order_list('{}'::jsonb, NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 0 OR (v_j #>> '{counts,at_lab}')::integer IS DISTINCT FROM 0
       OR (v_j #>> '{flags,lab_own_only}')::boolean IS DISTINCT FROM true
       OR (v_j -> 'flags' -> 'my_doctor_id') IS DISTINCT FROM 'null'::jsonb
       OR public.clin_my_doctor_id() IS NOT NULL OR public.clin__lab_order_visible(v_a_doc)
       OR public.clin__lab_order_visible(NULL)
       OR (public.clin__lab_json(v_clinic, v_lab, false) ->> 'open_order_count')::integer IS DISTINCT FROM 0 THEN
      v_fail := array_append(v_fail, 'kayıtsız hekim liste: ' || left(v_j::text, 600));
    END IF;
    v_sqls := ARRAY[
      format('SELECT public.clin_lab_order_save(%L, NULL, %L, %L, %L, %L, %L, %L::jsonb)',
             gen_random_uuid(), v_pt, v_a_doc, v_lab, v_due, '', v_items),
      format('SELECT public.clin_lab_order_detail(%L)', v_oa1)];
    v_keys := ARRAY['CL_LAB_NO_DOCTOR', 'CL_NOT_FOUND'];
    v_states := ARRAY['42501', 'PT404'];
    FOR v_i IN 1 .. cardinality(v_sqls) LOOP
      v_err := NULL;
      v_state := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
      END;
      IF v_err IS DISTINCT FROM v_keys[v_i] OR v_state IS DISTINCT FROM v_states[v_i] THEN
        v_fail := array_append(v_fail, format('kayıtsız hekim ret %s: %s / %s', v_i, coalesce(v_err, '-'),
                                              coalesce(v_state, 'hata yok')));
      END IF;
    END LOOP;

    -- Assistant S: every order, as before (list, counts, search, doctor filter, detail, status change).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_s_auth::text, true);
    v_j := public.clin_lab_order_list('{}'::jsonb, NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 3 OR (v_j #>> '{counts,draft}')::integer IS DISTINCT FROM 1
       OR (v_j #>> '{counts,at_lab}')::integer IS DISTINCT FROM 2
       OR (v_j #>> '{flags,lab_own_only}')::boolean IS DISTINCT FROM false
       OR NOT public.clin_can_view_all_lab_orders() OR NOT public.clin__lab_order_visible(NULL)
       OR (public.clin__lab_json(v_clinic, v_lab, false) ->> 'open_order_count')::integer IS DISTINCT FROM 3 THEN
      v_fail := array_append(v_fail, 'asistan liste: ' || left(v_j::text, 600));
    END IF;
    IF (public.clin_lab_order_list(jsonb_build_object('q', 'LAB-P36-' || v_tag || '-3'), NULL) ->> 'total')::integer
         IS DISTINCT FROM 1
       OR (public.clin_lab_order_list(jsonb_build_object('doctor_id', v_a_doc), NULL) ->> 'total')::integer
         IS DISTINCT FROM 1 THEN
      v_fail := array_append(v_fail, 'asistan arama / hekim filtresi');
    END IF;
    v_j := public.clin_lab_order_detail(v_ob1);
    IF (v_j #>> '{order,id}')::uuid IS DISTINCT FROM v_ob1 THEN
      v_fail := array_append(v_fail, 'asistan detay: ' || left(v_j::text, 300));
    END IF;
    v_j := public.clin_lab_order_set_status(v_ob1, 1, 'submitted');
    IF v_j #>> '{order,status}' IS DISTINCT FROM 'submitted' THEN
      v_fail := array_append(v_fail, 'asistan durum: ' || left(v_j::text, 300));
    END IF;

    -- Doctor F ('finance'): every order and every cost, as before.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_f_auth::text, true);
    v_j := public.clin_lab_order_list('{}'::jsonb, NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 3 OR (v_j #>> '{flags,lab_own_only}')::boolean IS DISTINCT FROM false
       OR (v_j #>> '{flags,my_doctor_id}')::uuid IS DISTINCT FROM v_f_doc
       OR (public.clin_lab_order_detail(v_ob2) #>> '{order,cost,amount_cents}')::bigint IS DISTINCT FROM 10000 THEN
      v_fail := array_append(v_fail, 'finans yetkili hekim: ' || left(v_j::text, 600));
    END IF;

    -- Owner: every order, as before.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.clin_lab_order_list('{}'::jsonb, NULL);
    IF (v_j ->> 'total')::integer IS DISTINCT FROM 3 OR (v_j #>> '{flags,lab_own_only}')::boolean IS DISTINCT FROM false
       OR (public.clin_lab_order_detail(v_oa1) #>> '{order,cost,amount_cents}')::bigint IS DISTINCT FROM 25000 THEN
      v_fail := array_append(v_fail, 'sahip: ' || left(v_j::text, 600));
    END IF;

    -- No session: nothing (fail closed).
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    IF public.clin_can_view_all_lab_orders() OR public.clin_my_doctor_id() IS NOT NULL
       OR public.clin__lab_order_visible(v_a_doc) OR public.clin__lab_order_visible(NULL) THEN
      v_fail := array_append(v_fail, 'oturumsuz kapsam');
    END IF;

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hekim kapsamı): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p36_selfcheck_rollback';
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

-- Make the API see the replaced functions and policies now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
