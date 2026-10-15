-- Phase 5: patient payments (Hasta ödemeleri), offers vs collections, FX rates. Safe to re-run.
--
-- Contract: spec_parts/p5_patient_payments.md (schema §2, balance rules §3, RPCs §5). Requires 0019, 0020, 0021
-- and 0022. The migration number 0024 belongs to the inventory workflow; nothing here touches stock tables.
--
--  1. fx_rates (new): clinic reference rates, TL per 1 unit of EUR / USD / GBP, one row per (currency, day, source).
--     Filled by manual entry and by the owner's workbook import ('GÜNCEL DÖVİZ'); no external rate API. Written only
--     by pp_fx_save_rates; never deleted by app users.
--  2. treatment_plans: quote currency, quote rate (+ day, source, fx_rates row) and a generated TL quote. A guard
--     trigger normalises the quote fields, ignores the client's quote_fx_source, refuses a currency change while
--     counted payments exist and refuses lowering the total below what has been credited to the plan.
--  3. payments: currency, original amount (amount, unchanged meaning for every existing row), rate used, TL amount,
--     plan currency + plan rate + the amount credited to the plan, method checked, received_by stamped server-side,
--     paid_on = Istanbul business date, void (never delete) and legacy_id. Existing rows become TRY at rate 1 with
--     TL = amount; bad old rows are reported with NOTICE, never rewritten (0019 pattern). payments_insert_guard
--     (0019) is replaced by pp_record_payment + the pp_payment_guard trigger.
--  4. RLS: payments SELECT only for the owner and finance / finance_readonly holders (closes the item 0019 left
--     open); no client writes on payments or fx_rates. Reception and doctors read one plan / one patient through
--     pp_plan_account / pp_patient_account.
--  5. RPCs: pp_record_payment, pp_void_payment, pp_fx_rates, pp_fx_save_rates, pp_plan_account, pp_patient_account,
--     pp_can_void (any active staff; voiding, FX writes and back-dating need owner or 'finance'), and the finance-only
--     reads fin_patient_offers, fin_patient_receipts_compare, fin_fx_history. Nothing here writes to any fin_* table
--     (owner decision 1): the ledger comparison is informational and read-only.
--  6. crm_source_report: collections now sum the TL amount of counted payments (voided and foreign rows were wrong).
--  7. pp__harden_privileges(): pp_* granted to authenticated, pp__* never; fin__harden_privileges() and
--     crm__harden_privileges() re-run; data self-checks; NOTIFY pgrst.
--
-- Review fixes (beyond the spec): staff without owner / 'finance' rights may use a payment rate only within 10 % of
-- the clinic's registered rate for the day (pp__rate_guard: E_FX_NO_REF / E_FX_RANGE); a converted amount of 0 cents
-- is refused (E_AMOUNT_SMALL); a plan with items cannot change currency (E_PLAN_CURRENCY_ITEMS) and a new foreign
-- currency needs a new quote rate (E_QUOTE_FX_REQUIRED); app users cannot set treatment_plans.legacy_id; the applied
-- amount uses exact integer division (helper and CHECK), matching the TS BigInt mirror for any magnitude.
--
-- Error contract (as 0020 / 0021): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or
-- the default P0001 (400); HINT carries the key (E_*), DETAIL a machine value where noted. The UI shows the message.
--
-- Deploy: apply this file, then deploy the Phase 5 web build immediately. In between, the old plan page cannot
-- record payments (INSERT revoked) and shows empty payment lists to staff without finance read.

BEGIN;

-- ---------------------------------------------------------------------------
-- 2.0 Preflight: 0019-0022 live, expected columns and types, any object left by an earlier run of this file has
--     the shape created below. Then the pre-migration payment totals are captured for the self-check (§2.6).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'audit_row_change', 'fin__require_read', 'fin__require_write',
                    'fin__harden_privileges', 'fin__live_payments', 'fin__page', 'fin__reason', 'fin__user_name',
                    'fin__tr_lower', 'fin__report_month', 'fin__month_start', 'crm__harden_privileges',
                    'crm_source_report', 'crm__require_staff', 'crm__can_read_money', 'crm__month',
                    'crm__raise']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0019-0022 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() / auth.jwt() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  SELECT string_agg(t.tbl, ', ')
    INTO v_missing
  FROM unnest(ARRAY['payments', 'treatment_plans', 'patients', 'doctors', 'users', 'clinics', 'audit_logs',
                    'fin_entries', 'fin_payments', 'fin_categories', 'leads', 'crm_ad_spend']) AS t(tbl)
  WHERE to_regclass(format('public.%I', t.tbl)) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen tablolar bulunamadı: %', v_missing;
  END IF;

  -- Existing columns used here, with their types (udt_name).
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.typ, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('payments', 'id', 'uuid'), ('payments', 'clinic_id', 'uuid'), ('payments', 'treatment_plan_id', 'uuid'),
    ('payments', 'patient_id', 'uuid'), ('payments', 'amount', 'numeric'), ('payments', 'status', 'payment_status'),
    ('payments', 'payment_method', 'text'), ('payments', 'transaction_id', 'text'), ('payments', 'notes', 'text'),
    ('payments', 'created_at', 'timestamptz'), ('payments', 'paid_at', 'timestamptz'), ('payments', 'due_date', 'date'),
    ('treatment_plans', 'id', 'uuid'), ('treatment_plans', 'clinic_id', 'uuid'),
    ('treatment_plans', 'patient_id', 'uuid'), ('treatment_plans', 'doctor_id', 'uuid'),
    ('treatment_plans', 'title', 'text'), ('treatment_plans', 'total_cost', 'numeric'),
    ('treatment_plans', 'status', 'treatment_status'), ('treatment_plans', 'created_at', 'timestamptz'),
    ('treatment_plans', 'updated_at', 'timestamptz'),
    ('patients', 'id', 'uuid'), ('patients', 'clinic_id', 'uuid'), ('patients', 'full_name', 'text'),
    ('doctors', 'id', 'uuid'), ('doctors', 'clinic_id', 'uuid'), ('doctors', 'user_id', 'uuid'),
    ('users', 'id', 'uuid'), ('users', 'clinic_id', 'uuid'), ('users', 'full_name', 'text'),
    ('audit_logs', 'clinic_id', 'uuid'), ('audit_logs', 'user_id', 'uuid'), ('audit_logs', 'entity_type', 'text'),
    ('audit_logs', 'entity_id', 'uuid'), ('audit_logs', 'action', 'text'), ('audit_logs', 'created_at', 'timestamptz'),
    ('fin_entries', 'id', 'uuid'), ('fin_entries', 'clinic_id', 'uuid'), ('fin_entries', 'source_key', 'text')
  ) AS e(tbl, col, typ)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.typ;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut tablolar beklenen yapıda değil: %', v_missing;
  END IF;

  -- Columns this file adds: when one exists already (earlier run) it must have exactly this shape, otherwise
  -- ADD COLUMN IF NOT EXISTS would skip an old shape silently.
  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('treatment_plans', 'currency', 'text', 'NEVER'), ('treatment_plans', 'quote_fx_rate', 'numeric', 'NEVER'),
    ('treatment_plans', 'quote_fx_on', 'date', 'NEVER'), ('treatment_plans', 'quote_fx_source', 'text', 'NEVER'),
    ('treatment_plans', 'quote_fx_rate_id', 'uuid', 'NEVER'), ('treatment_plans', 'legacy_id', 'text', 'NEVER'),
    ('treatment_plans', 'quote_total_try_cents', 'int8', 'ALWAYS'),
    ('payments', 'currency', 'text', 'NEVER'), ('payments', 'fx_rate', 'numeric', 'NEVER'),
    ('payments', 'fx_rate_source', 'text', 'NEVER'), ('payments', 'fx_rate_id', 'uuid', 'NEVER'),
    ('payments', 'amount_try_cents', 'int8', 'NEVER'), ('payments', 'plan_currency', 'text', 'NEVER'),
    ('payments', 'plan_fx_rate', 'numeric', 'NEVER'), ('payments', 'plan_fx_rate_source', 'text', 'NEVER'),
    ('payments', 'plan_fx_rate_id', 'uuid', 'NEVER'), ('payments', 'applied_plan_cents', 'int8', 'NEVER'),
    ('payments', 'payment_method_raw', 'text', 'NEVER'), ('payments', 'received_by', 'uuid', 'NEVER'),
    ('payments', 'paid_on', 'date', 'NEVER'), ('payments', 'voided_at', 'timestamptz', 'NEVER'),
    ('payments', 'voided_by', 'uuid', 'NEVER'), ('payments', 'void_reason', 'text', 'NEVER'),
    ('payments', 'legacy_id', 'text', 'NEVER'), ('payments', 'amount_cents', 'int8', 'ALWAYS')
  ) AS e(tbl, col, typ, gen)
  JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text <> e.typ OR c.is_generated::text <> e.gen;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önceki çalıştırmadan kalan sütunlar beklenen yapıda değil: %', v_missing;
  END IF;

  SELECT string_agg(format('fx_rates.%s', e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('id', 'uuid'), ('clinic_id', 'uuid'), ('currency', 'text'), ('rate', 'numeric'), ('rate_on', 'date'),
    ('source', 'text'), ('source_file', 'text'), ('note', 'text'), ('version', 'int4'), ('created_by', 'uuid'),
    ('created_at', 'timestamptz'), ('updated_by', 'uuid'), ('updated_at', 'timestamptz')
  ) AS e(col, typ)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'fx_rates' AND c.column_name = e.col
  WHERE to_regclass('public.fx_rates') IS NOT NULL
    AND c.udt_name::text IS DISTINCT FROM e.typ;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mevcut fx_rates tablosu beklenen yapıda değil: %', v_missing;
  END IF;

  -- Magnitudes that would overflow the bigint cent columns below (round(x * 100) and the TL quote at rate <= 1000).
  IF EXISTS (SELECT 1 FROM public.payments WHERE abs(amount) >= 1000000000000000) THEN
    RAISE EXCEPTION 'payments: tutarı 10^15 veya üzerinde satır var; önce elle düzeltilmeli.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.treatment_plans WHERE abs(total_cost) >= 1000000000000) THEN
    RAISE EXCEPTION 'treatment_plans: toplamı 10^12 veya üzerinde plan var; önce elle düzeltilmeli.';
  END IF;
END $$;

-- Pre-migration figures for the self-check (§2.6 item 4), kept in transaction-local settings. On a re-run the
-- TL amount already stored is used, so foreign rows recorded since the first run compare like for like.
DO $$
DECLARE
  v_has_try boolean;
  v_has_void boolean;
  v_sum numeric;
  v_rows bigint;
BEGIN
  v_has_try := EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'amount_try_cents');
  v_has_void := EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'voided_at');
  EXECUTE format(
    'SELECT coalesce(sum(%s), 0), (SELECT count(*) FROM public.payments)
       FROM public.payments p
      WHERE p.status = ''paid'' AND p.amount > 0 %s',
    CASE WHEN v_has_try THEN 'coalesce(p.amount_try_cents, round(p.amount * 100))' ELSE 'round(p.amount * 100)' END,
    CASE WHEN v_has_void THEN 'AND p.voided_at IS NULL' ELSE '' END)
    INTO v_sum, v_rows;
  PERFORM set_config('pp.mig_try_sum', v_sum::text, true);
  PERFORM set_config('pp.mig_rows', v_rows::text, true);
END $$;

-- Counts of old rows that the new rules would flag. Reported, never rewritten.
DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.payments WHERE amount <= 0;
  RAISE NOTICE 'payments: tutarı 0 veya negatif satır: %', v_n;
  SELECT count(*) INTO v_n FROM public.payments WHERE amount <> round(amount, 2);
  RAISE NOTICE 'payments: 2''den fazla ondalık basamaklı tutar: %', v_n;
  SELECT count(*) INTO v_n FROM public.payments WHERE status IS DISTINCT FROM 'paid';
  RAISE NOTICE 'payments: durumu ''paid'' olmayan (eski kayıt) satır: %', v_n;
  SELECT count(*) INTO v_n FROM public.payments
  WHERE payment_method IS NULL OR payment_method NOT IN ('cash', 'card', 'transfer', 'financing');
  RAISE NOTICE 'payments: ödeme yöntemi boş veya listede olmayan satır (ham değer payment_method_raw''a taşınır): %', v_n;
  SELECT count(*) INTO v_n FROM public.treatment_plans
  WHERE total_cost < 0 OR total_cost <> round(total_cost, 2) OR total_cost > 10000000000;
  RAISE NOTICE 'treatment_plans: toplamı negatif, 10.000.000.000 üzeri veya 2''den fazla ondalıklı plan: %', v_n;
  SELECT count(*) INTO v_n
  FROM public.payments p
  JOIN public.treatment_plans tp ON tp.id = p.treatment_plan_id
  WHERE p.patient_id IS DISTINCT FROM tp.patient_id;
  RAISE NOTICE 'payments: hastası planın hastasından farklı satır (Hesap sekmesinde plan ve tahsilat toplamları '
               'ayrışır; SQL editöründe düzeltin): %', v_n;
END $$;

-- ---------------------------------------------------------------------------
-- 2.1 Helpers. Internal pp__* are never granted and run as their caller (SECURITY INVOKER); called from a pp_* /
--     fin_* RPC they run as its owner. LANGUAGE sql ones without a SET clause stay inlinable, so every name in
--     them is schema-qualified.
-- ---------------------------------------------------------------------------

-- Error contract §1.1. One place for every Turkish text; the key travels in HINT.
CREATE OR REPLACE FUNCTION public.pp__raise(p_key text, p_arg text DEFAULT NULL, p_detail text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_msg text;
  v_code text := 'P0001';
BEGIN
  CASE p_key
    WHEN 'E_SESSION' THEN v_msg := 'Oturum bulunamadı. Lütfen yeniden giriş yapın.'; v_code := '42501';
    WHEN 'E_READ' THEN v_msg := 'Finans verilerini görme yetkiniz yok.'; v_code := '42501';
    WHEN 'E_VOID_ROLE' THEN v_msg := 'Ödemeyi yalnızca klinik sahibi veya finans yetkilisi iptal edebilir.'; v_code := '42501';
    WHEN 'E_BACKDATE_ROLE' THEN v_msg := 'Geçmiş tarihli ödemeyi yalnızca klinik sahibi veya finans yetkilisi kaydedebilir.'; v_code := '42501';
    WHEN 'E_FX_ROLE' THEN v_msg := 'Kur kaydı için klinik sahibi veya finans yetkisi gerekir.'; v_code := '42501';
    WHEN 'E_PAYMENT_DIRECT' THEN v_msg := 'Ödemeler yalnızca ödeme ekranından kaydedilir.'; v_code := '42501';
    WHEN 'E_PLAN_NOT_FOUND' THEN v_msg := 'Tedavi planı bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PATIENT_NOT_FOUND' THEN v_msg := 'Hasta bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PAYMENT_NOT_FOUND' THEN v_msg := 'Ödeme bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PAYMENT_ID_TAKEN' THEN v_msg := 'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.'; v_code := 'PT409';
    WHEN 'E_PAYMENT_VOIDED' THEN v_msg := 'Bu ödeme zaten iptal edilmiş.'; v_code := 'PT409';
    WHEN 'E_OVERPAY' THEN v_msg := 'Ödeme planın kalan tutarını aşıyor. Kalan: ' || coalesce(p_arg, '');
    WHEN 'E_PLAN_CANCELLED' THEN v_msg := 'İptal edilmiş plana ödeme eklenemez.';
    WHEN 'E_AMOUNT' THEN v_msg := 'Tutar 0,01 ile 10.000.000.000 arasında olmalı.';
    WHEN 'E_CURRENCY' THEN v_msg := 'Geçersiz para birimi.';
    WHEN 'E_METHOD' THEN v_msg := 'Ödeme yöntemini seçin.';
    WHEN 'E_FX_RATE' THEN v_msg := 'Kur 0''dan büyük, en fazla 1000 ve en fazla 6 ondalık basamaklı olmalı.';
    WHEN 'E_FX_REQUIRED' THEN v_msg := 'Dövizli ödeme için kuru girin.';
    WHEN 'E_PLAN_FX_REQUIRED' THEN v_msg := 'Plan para birimi için ödeme gününün kurunu girin.';
    WHEN 'E_FX_TRY' THEN v_msg := 'TL için kur girilmez.';
    WHEN 'E_PAID_ON_FUTURE' THEN v_msg := 'Ödeme tarihi bugünden sonra olamaz.';
    WHEN 'E_FX_DATE_FUTURE' THEN v_msg := 'Kur tarihi bugünden sonra olamaz.';
    WHEN 'E_DATE' THEN v_msg := 'Geçersiz tarih.';
    WHEN 'E_NOTE' THEN v_msg := 'Not en fazla 500 karakter olabilir.';
    WHEN 'E_REASON' THEN v_msg := 'Gerekçe en az 3, en fazla 500 karakter olmalı.';
    WHEN 'E_PLAN_CURRENCY_LOCKED' THEN v_msg := 'Ödeme alınmış planın para birimi değiştirilemez.';
    WHEN 'E_PLAN_PATIENT_LOCKED' THEN v_msg := 'Ödeme kaydı olan planın hastası değiştirilemez.';
    WHEN 'E_PLAN_CURRENCY_ITEMS' THEN
      v_msg := 'Kalemi olan planın para birimi değiştirilemez; kalem fiyatları planın para biriminde girildi.';
    WHEN 'E_QUOTE_FX_REQUIRED' THEN v_msg := 'Yeni para birimi için teklif kurunu girin.';
    WHEN 'E_AMOUNT_SMALL' THEN v_msg := 'Tutar, kur dönüşümünden sonra en az 0,01 olmalı.';
    WHEN 'E_FX_NO_REF' THEN
      v_msg := 'Kayıtlı ' || coalesce(p_arg, '') || ' kuru yok. Dövizli ödeme için kuru klinik sahibi veya finans '
               || 'yetkilisi Finans ayarları > Döviz kurları ekranından kaydetmeli.';
      v_code := '42501';
    WHEN 'E_FX_RANGE' THEN
      v_msg := 'Kur, kayıtlı kurdan (' || coalesce(p_arg, '') || ') %10''dan fazla farklı. Farklı kuru yalnızca '
               || 'klinik sahibi veya finans yetkilisi kaydedebilir.';
      v_code := '42501';
    WHEN 'E_PLAN_TOTAL_BELOW_PAID' THEN
      v_msg := 'Plan toplamı, plana yansıyan tahsilatın (' || coalesce(p_arg, '') || ') altına inemez.';
    WHEN 'E_PLAN_TOTAL' THEN v_msg := 'Plan toplamı 0 ile 10.000.000.000 arasında ve en fazla 2 ondalık basamaklı olmalı.';
    WHEN 'E_PAYMENT_LOCKED' THEN v_msg := 'Ödeme kayıtları değiştirilemez; yanlış ödemeyi iptal edin.';
    WHEN 'E_PAYMENT_DELETE' THEN v_msg := 'Ödeme kayıtları silinemez; iptal edin.';
    WHEN 'E_PAYMENT_LEGACY_INVALID' THEN v_msg := 'Bu eski kayıt geçersiz tutar içeriyor; düzeltme için yöneticiye başvurun.';
    WHEN 'E_FX_DELETE' THEN v_msg := 'Kur kayıtları silinemez.';
    WHEN 'E_IMMUTABLE' THEN v_msg := 'Bu alan değiştirilemez.';
    WHEN 'E_FILTER' THEN v_msg := 'Filtre değerleri geçersiz.';
    ELSE v_msg := 'Beklenmeyen hata: ' || coalesce(p_key, '(boş)');
  END CASE;

  IF p_detail IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = coalesce(p_key, '');
  ELSE
    RAISE EXCEPTION USING MESSAGE = v_msg, ERRCODE = v_code, HINT = coalesce(p_key, ''), DETAIL = p_detail;
  END IF;
END;
$$;

-- Currency code: upper-trimmed, one of the four (E_CURRENCY).
CREATE OR REPLACE FUNCTION public.pp__currency(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := upper(btrim(coalesce(p, '')));
BEGIN
  IF v NOT IN ('TRY', 'EUR', 'USD', 'GBP') THEN
    PERFORM public.pp__raise('E_CURRENCY');
  END IF;
  RETURN v;
END;
$$;

-- Rate, TL per 1 unit: 0 < r <= 1000, at most 6 decimals (E_FX_RATE).
CREATE OR REPLACE FUNCTION public.pp__rate(p numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR p <= 0 OR p > 1000 OR p <> round(p, 6) THEN
    PERFORM public.pp__raise('E_FX_RATE');
  END IF;
  RETURN round(p, 6);
END;
$$;

-- Exact money math, half away from zero (critique 11). Mirrors of lib/patient-payments.ts tryCents / appliedCents.
CREATE OR REPLACE FUNCTION public.pp__try_cents(p_cents bigint, p_rate numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.round(p_cents * p_rate)::bigint
$$;

-- Exact integer arithmetic, (2·try·10^6 + R) div (2·R) with R = rate·10^6 (an integer, at most 6 decimals): the
-- same formula as the BigInt mirror. Plain numeric division keeps only ~16 significant digits, which mis-rounds a
-- quotient like 500999999.4999999995 (see the self-check golden value 'A07 sınır'). Positive inputs only.
CREATE OR REPLACE FUNCTION public.pp__applied_cents(p_try_cents bigint, p_plan_rate numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.div(2 * p_try_cents::numeric * 1000000 + pg_catalog.round(p_plan_rate * 1000000),
                        2 * pg_catalog.round(p_plan_rate * 1000000))::bigint
$$;

-- Rate as the JSON string every RPC returns ("49.000000").
CREATE OR REPLACE FUNCTION public.pp__rate_text(p numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (pg_catalog.round(p, 6)::numeric(12, 6))::text
$$;

-- '1.234,56 EUR' (Turkish grouping, currency code). Used inside error texts.
CREATE OR REPLACE FUNCTION public.pp__money_text(p_cents bigint, p_currency text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_cents < 0 THEN '-' ELSE '' END
      || pg_catalog.regexp_replace((pg_catalog.abs(p_cents) / 100)::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
      || ',' || pg_catalog.lpad((pg_catalog.abs(p_cents) % 100)::text, 2, '0')
      || ' ' || coalesce(p_currency, '')
$$;

-- SQL editor / service role: no JWT user and not an API role (same test as 0020 fin__trg_no_delete).
CREATE OR REPLACE FUNCTION public.pp__is_backend()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid() IS NULL
     AND coalesce(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated')
     AND coalesce(pg_catalog.current_setting('role', true), '') NOT IN ('anon', 'authenticated')
$$;

-- First statement of every pp_* RPC: the caller's clinic (active staff), or E_SESSION.
CREATE OR REPLACE FUNCTION public.pp__require_staff()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL THEN
    PERFORM public.pp__raise('E_SESSION');
  END IF;
  RETURN v_clinic;
END;
$$;

-- Same predicate as 0019 payments_insert_guard: the owner or a 'finance' holder may record another day.
CREATE OR REPLACE FUNCTION public.pp__can_backdate()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false) OR coalesce(public.has_permission('finance'), false)
$$;

-- Granted: answers only for the caller. Gates voiding, FX writes and back-dating.
CREATE OR REPLACE FUNCTION public.pp_can_void()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false) OR coalesce(public.has_permission('finance'), false)
$$;

-- ---------------------------------------------------------------------------
-- 2.2 fx_rates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency IN ('EUR', 'USD', 'GBP')),
  rate numeric NOT NULL CHECK (rate > 0 AND rate <= 1000 AND rate = round(rate, 6)),
  rate_on date NOT NULL CHECK (rate_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  source text NOT NULL CHECK (source IN ('workbook', 'manual')),
  source_file text CHECK (source_file IS NULL OR char_length(source_file) <= 200),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, currency, rate_on, source)
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup ON public.fx_rates (clinic_id, currency, rate_on DESC);

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fx_rates_select_staff" ON public.fx_rates;
CREATE POLICY "fx_rates_select_staff" ON public.fx_rates
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT public.current_clinic_id()));
REVOKE ALL ON public.fx_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fx_rates TO authenticated;

-- Latest reference rate for a day: greatest rate_on <= p_on; same day: manual over workbook, then the later
-- update, then id. No row for TRY or when nothing is known. SETOF (at most one row) so it joins with LEFT JOIN.
CREATE OR REPLACE FUNCTION public.pp__fx_lookup(p_clinic uuid, p_currency text, p_on date)
RETURNS SETOF public.fx_rates
LANGUAGE sql
STABLE
AS $$
  SELECT r.*
  FROM public.fx_rates r
  WHERE r.clinic_id = p_clinic AND r.currency = p_currency AND r.rate_on <= p_on
  ORDER BY r.rate_on DESC, (r.source = 'manual') DESC, r.updated_at DESC, r.id DESC
  LIMIT 1
$$;

-- Source of a rate the client sent with the id of the suggested fx_rates row: that row's source when it is this
-- clinic's row for the same currency with the same rate; otherwise 'entered' (typed or edited by the user).
CREATE OR REPLACE FUNCTION public.pp__rate_source(p_clinic uuid, p_currency text, p_rate numeric, p_rate_id uuid)
RETURNS TABLE (o_source text, o_id uuid, o_rate_on date)
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(r.source, 'entered'), r.id, r.rate_on
  FROM (SELECT 1) AS one
  LEFT JOIN public.fx_rates r
    ON r.clinic_id = p_clinic AND r.id = p_rate_id AND r.currency = p_currency AND r.rate = p_rate
$$;

-- Payment rates of staff without owner / 'finance' rights (review fix): a reference rate must exist for the day
-- (pp__fx_lookup, latest on or before it) and the rate used may differ from it by at most 10 %, decided exactly:
-- |rate − ref| × 10 > ref is refused. Otherwise a foreign payment could be recorded at any rate, e.g. EUR cash at
-- 0,000001 (TL value 0, invisible to every TL control) or a TRY plan credited 1000× (owner decision 2 keeps the rate
-- editable; the owner and finance holders keep free entry). A stale reference only blocks, it never lets through.
CREATE OR REPLACE FUNCTION public.pp__rate_guard(p_clinic uuid, p_currency text, p_rate numeric, p_on date)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_ref numeric;
BEGIN
  SELECT r.rate INTO v_ref FROM public.pp__fx_lookup(p_clinic, p_currency, p_on) r;
  IF v_ref IS NULL THEN
    PERFORM public.pp__raise('E_FX_NO_REF', p_currency);
  END IF;
  IF abs(p_rate - v_ref) * 10 > v_ref THEN
    PERFORM public.pp__raise('E_FX_RANGE', '1 ' || p_currency || ' = ' || replace(public.pp__rate_text(v_ref), '.', ','),
                             public.pp__rate_text(v_ref));
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.3 treatment_plans: quote currency and rate. Existing rows get TRY, rate 1, source 'none'.
-- ---------------------------------------------------------------------------
ALTER TABLE public.treatment_plans
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'TRY',
  ADD COLUMN IF NOT EXISTS quote_fx_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quote_fx_on date,
  ADD COLUMN IF NOT EXISTS quote_fx_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS quote_fx_rate_id uuid,
  ADD COLUMN IF NOT EXISTS legacy_id text;

-- Generated, so the TL quote can never drift from the total or the rate (owner decision 2).
ALTER TABLE public.treatment_plans
  ADD COLUMN IF NOT EXISTS quote_total_try_cents bigint
    GENERATED ALWAYS AS ((round(total_cost * quote_fx_rate * 100))::bigint) STORED;

DO $$
BEGIN
  -- Target of the (clinic_id, treatment_plan_id) key on payments.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.treatment_plans'::regclass AND conname = 'treatment_plans_clinic_id_id_key') THEN
    ALTER TABLE public.treatment_plans ADD CONSTRAINT treatment_plans_clinic_id_id_key UNIQUE (clinic_id, id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS treatment_plans_clinic_legacy_id_key
  ON public.treatment_plans (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.4 payments: new columns, backfill of existing rows, then NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'TRY',
  ADD COLUMN IF NOT EXISTS fx_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_rate_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS fx_rate_id uuid,
  ADD COLUMN IF NOT EXISTS amount_try_cents bigint,
  ADD COLUMN IF NOT EXISTS plan_currency text,
  ADD COLUMN IF NOT EXISTS plan_fx_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS plan_fx_rate_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS plan_fx_rate_id uuid,
  ADD COLUMN IF NOT EXISTS applied_plan_cents bigint,
  ADD COLUMN IF NOT EXISTS payment_method_raw text,
  ADD COLUMN IF NOT EXISTS received_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paid_on date,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS legacy_id text;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS amount_cents bigint GENERATED ALWAYS AS ((round(amount * 100))::bigint) STORED;

-- 0019's payments_amount_positive is NOT VALID when old rows break it, and every UPDATE re-checks it, so the
-- backfill below would abort on such a row. It is dropped here only in that case and re-added (same name, same
-- rule, NOT VALID + validate when clean) by the constraint loop further down, inside this same transaction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_amount_positive'
               AND NOT convalidated) THEN
    ALTER TABLE public.payments DROP CONSTRAINT payments_amount_positive;
  END IF;
END $$;

-- Backfill (idempotent: only rows not yet migrated, amount_try_cents IS NULL marks them). One UPDATE, so each old
-- row gets exactly one audit entry. Money does not change: TRY, rate 1, TL = amount, plan currency TRY (every
-- existing plan is TRY after §2.3). paid_on is the Istanbul date of paid_at / created_at (critique 14).
-- received_by: the user of the 0019 'create' audit row when there is one (same clinic), else NULL ("Bilinmiyor").
-- payment_method: listed values stay; any other non-NULL value moves verbatim to payment_method_raw (no relabel).
WITH firsts AS MATERIALIZED (
  SELECT DISTINCT ON (a.entity_id) a.entity_id, a.clinic_id, a.user_id
  FROM public.audit_logs a
  JOIN public.users u ON u.id = a.user_id AND u.clinic_id = a.clinic_id
  WHERE a.entity_type = 'payments' AND a.action = 'create' AND a.user_id IS NOT NULL
  ORDER BY a.entity_id, a.created_at, a.id
),
todo AS MATERIALIZED (
  SELECT p.id, f.user_id
  FROM public.payments p
  LEFT JOIN firsts f ON f.entity_id = p.id AND f.clinic_id = p.clinic_id
  WHERE p.amount_try_cents IS NULL OR p.plan_currency IS NULL OR p.applied_plan_cents IS NULL OR p.paid_on IS NULL
)
UPDATE public.payments p
SET paid_on = coalesce(p.paid_on, (coalesce(p.paid_at, p.created_at) AT TIME ZONE 'Europe/Istanbul')::date),
    amount_try_cents = coalesce(p.amount_try_cents, round(p.amount * 100)::bigint),
    plan_currency = coalesce(p.plan_currency, 'TRY'),
    applied_plan_cents = coalesce(p.applied_plan_cents, round(p.amount * 100)::bigint),
    received_by = coalesce(p.received_by, CASE WHEN p.amount_try_cents IS NULL THEN t.user_id END),
    payment_method_raw = CASE WHEN p.amount_try_cents IS NULL
                                   AND p.payment_method IS NOT NULL
                                   AND p.payment_method NOT IN ('cash', 'card', 'transfer', 'financing')
                              THEN p.payment_method ELSE p.payment_method_raw END,
    payment_method = CASE WHEN p.amount_try_cents IS NULL
                               AND p.payment_method IS NOT NULL
                               AND p.payment_method NOT IN ('cash', 'card', 'transfer', 'financing')
                          THEN NULL ELSE p.payment_method END
FROM todo t
WHERE t.id = p.id;

ALTER TABLE public.payments
  ALTER COLUMN amount_try_cents SET NOT NULL,
  ALTER COLUMN plan_currency SET NOT NULL,
  ALTER COLUMN applied_plan_cents SET NOT NULL,
  ALTER COLUMN paid_on SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_clinic_legacy_id_key
  ON public.payments (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_plan_counts
  ON public.payments (clinic_id, treatment_plan_id) WHERE voided_at IS NULL AND status = 'paid';
CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON public.payments (clinic_id, paid_on);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON public.payments (clinic_id, patient_id, paid_on DESC);

-- ---------------------------------------------------------------------------
-- 2.3 / 2.4 CHECK constraints: added NOT VALID, validated only when no live row breaks them; otherwise a NOTICE
--     and the rule applies to new and changed rows only (0019 pattern). payments_amount_positive keeps its 0019
--     name and rule; it is re-added here only if the backfill step above had to drop it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c record;
  v_bad bigint;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('treatment_plans', 'treatment_plans_currency_check',
       $c$currency IN ('TRY', 'EUR', 'USD', 'GBP')$c$),
      ('treatment_plans', 'treatment_plans_quote_fx_check',
       $c$quote_fx_rate > 0 AND quote_fx_rate <= 1000 AND quote_fx_rate = round(quote_fx_rate, 6)
          AND ((currency = 'TRY' AND quote_fx_rate = 1 AND quote_fx_on IS NULL
                AND quote_fx_source = 'none' AND quote_fx_rate_id IS NULL)
            OR (currency <> 'TRY' AND quote_fx_on IS NOT NULL
                AND quote_fx_source IN ('workbook', 'manual', 'entered')))$c$),
      ('treatment_plans', 'treatment_plans_total_scale',
       $c$total_cost >= 0 AND total_cost = round(total_cost, 2) AND total_cost <= 10000000000$c$),
      ('payments', 'payments_amount_positive',
       $c$amount > 0$c$),
      ('payments', 'payments_currency_check',
       $c$currency IN ('TRY', 'EUR', 'USD', 'GBP') AND plan_currency IN ('TRY', 'EUR', 'USD', 'GBP')$c$),
      ('payments', 'payments_amount_scale',
       $c$amount = round(amount, 2) AND amount <= 10000000000$c$),
      ('payments', 'payments_fx_shape',
       $c$fx_rate > 0 AND fx_rate <= 1000 AND fx_rate = round(fx_rate, 6)
          AND plan_fx_rate > 0 AND plan_fx_rate <= 1000 AND plan_fx_rate = round(plan_fx_rate, 6)
          AND (currency <> 'TRY' OR (fx_rate = 1 AND fx_rate_source = 'none' AND fx_rate_id IS NULL))
          AND (currency = 'TRY' OR fx_rate_source IN ('workbook', 'manual', 'entered'))
          AND (plan_currency <> 'TRY'
               OR (plan_fx_rate = 1 AND plan_fx_rate_source = 'none' AND plan_fx_rate_id IS NULL))
          AND (plan_currency = 'TRY' OR plan_fx_rate_source IN ('workbook', 'manual', 'entered'))
          AND (plan_currency <> currency
               OR (plan_fx_rate = fx_rate AND plan_fx_rate_source = fx_rate_source
                   AND plan_fx_rate_id IS NOT DISTINCT FROM fx_rate_id))$c$),
      ('payments', 'payments_try_amount',
       $c$amount_try_cents = round(amount * fx_rate * 100)$c$),
      ('payments', 'payments_applied_amount',
       $c$applied_plan_cents = CASE WHEN currency = plan_currency THEN round(amount * 100)
                                    ELSE div(2 * amount_try_cents::numeric * 1000000 + round(plan_fx_rate * 1000000),
                                             2 * round(plan_fx_rate * 1000000)) END$c$),
      ('payments', 'payments_method_check',
       $c$payment_method IS NULL OR payment_method IN ('cash', 'card', 'transfer', 'financing')$c$),
      ('payments', 'payments_void_shape',
       $c$(voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
          OR (voided_at IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 3 AND 500)$c$),
      ('payments', 'payments_paid_on_range',
       $c$paid_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'$c$),
      ('payments', 'payments_texts_length',
       $c$(payment_method_raw IS NULL OR char_length(payment_method_raw) <= 500)
          AND (legacy_id IS NULL OR char_length(legacy_id) <= 200)$c$)
    ) AS t(tbl, conname, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = format('public.%I', c.tbl)::regclass AND conname = c.conname) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.conname, c.expr);
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE NOT coalesce((%s), true)', c.tbl, c.expr) INTO v_bad;
    IF v_bad > 0 THEN
      RAISE NOTICE '%: % satır % kuralına uymuyor; kural şimdilik yalnızca yeni ve değişen satırlara uygulanıyor.',
        c.tbl, v_bad, c.conname;
    ELSE
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c.tbl, c.conname);
    END IF;
  END LOOP;
END $$;

-- Composite keys: a payment's plan and every referenced rate row belong to the same clinic. NO ACTION (checked at
-- statement end), so a clinic delete that cascades into both sides still works.
DO $$
DECLARE
  c record;
  v_bad bigint;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('treatment_plans', 'treatment_plans_quote_fx_rate_fkey', 'clinic_id, quote_fx_rate_id', 'fx_rates',
       $c$quote_fx_rate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fx_rates r
          WHERE r.clinic_id = t.clinic_id AND r.id = t.quote_fx_rate_id)$c$),
      ('payments', 'payments_fx_rate_fkey', 'clinic_id, fx_rate_id', 'fx_rates',
       $c$fx_rate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fx_rates r
          WHERE r.clinic_id = t.clinic_id AND r.id = t.fx_rate_id)$c$),
      ('payments', 'payments_plan_fx_rate_fkey', 'clinic_id, plan_fx_rate_id', 'fx_rates',
       $c$plan_fx_rate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fx_rates r
          WHERE r.clinic_id = t.clinic_id AND r.id = t.plan_fx_rate_id)$c$),
      ('payments', 'payments_plan_clinic_fkey', 'clinic_id, treatment_plan_id', 'treatment_plans',
       $c$NOT EXISTS (SELECT 1 FROM public.treatment_plans r
          WHERE r.clinic_id = t.clinic_id AND r.id = t.treatment_plan_id)$c$)
    ) AS x(tbl, conname, cols, ref, bad_expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = format('public.%I', c.tbl)::regclass AND conname = c.conname) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES public.%I (clinic_id, id) NOT VALID',
                     c.tbl, c.conname, c.cols, c.ref);
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE %s', c.tbl, c.bad_expr) INTO v_bad;
    IF v_bad > 0 THEN
      RAISE NOTICE '%: % satır % anahtarına uymuyor; kural şimdilik yalnızca yeni ve değişen satırlara uygulanıyor.',
        c.tbl, v_bad, c.conname;
    ELSE
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c.tbl, c.conname);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- §3 Plan figures: the single source for every read RPC, the record RPC and the plan guard trigger.
--    counts (§1.5) := status = 'paid' AND voided_at IS NULL AND amount > 0, written inline everywhere so the
--    partial index idx_payments_plan_counts applies.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pp__plans_state(p_clinic uuid)
RETURNS TABLE (
  plan_id uuid,
  clinic_id uuid,
  patient_id uuid,
  doctor_id uuid,
  title text,
  status text,
  created_at timestamptz,
  currency text,
  total_cents bigint,
  quote_fx_rate numeric,
  quote_fx_on date,
  quote_fx_source text,
  quote_total_try_cents bigint,
  applied_cents bigint,
  remaining_cents bigint,
  collected_try_cents bigint,
  counted_count bigint,
  voided_count bigint,
  legacy_count bigint,
  last_paid_on date
)
LANGUAGE sql
STABLE
AS $$
  SELECT tp.id,
         tp.clinic_id,
         tp.patient_id,
         tp.doctor_id,
         tp.title,
         tp.status::text,
         tp.created_at,
         tp.currency,
         pg_catalog.round(tp.total_cost * 100)::bigint,
         tp.quote_fx_rate,
         tp.quote_fx_on,
         tp.quote_fx_source,
         tp.quote_total_try_cents,
         coalesce(a.applied, 0)::bigint,
         CASE WHEN tp.status::text = 'cancelled' THEN 0::bigint
              ELSE pg_catalog.round(tp.total_cost * 100)::bigint - coalesce(a.applied, 0)::bigint END,
         coalesce(a.try_cents, 0)::bigint,
         coalesce(a.n, 0)::bigint,
         coalesce(a.voided, 0)::bigint,
         coalesce(a.legacy, 0)::bigint,
         a.last_paid_on
  FROM public.treatment_plans tp
  LEFT JOIN LATERAL (
    SELECT sum(p.applied_plan_cents) FILTER (WHERE p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0
                                               AND p.plan_currency = tp.currency) AS applied,
           sum(p.amount_try_cents) FILTER (WHERE p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0) AS try_cents,
           count(*) FILTER (WHERE p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0) AS n,
           count(*) FILTER (WHERE p.voided_at IS NOT NULL) AS voided,
           count(*) FILTER (WHERE p.voided_at IS NULL AND p.status IS DISTINCT FROM 'paid') AS legacy,
           max(p.paid_on) FILTER (WHERE p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0) AS last_paid_on
    FROM public.payments p
    WHERE p.clinic_id = tp.clinic_id AND p.treatment_plan_id = tp.id
  ) a ON true
  WHERE tp.clinic_id = p_clinic
$$;

CREATE OR REPLACE FUNCTION public.pp__plan_state(p_clinic uuid, p_plan uuid)
RETURNS TABLE (
  plan_id uuid,
  clinic_id uuid,
  patient_id uuid,
  doctor_id uuid,
  title text,
  status text,
  created_at timestamptz,
  currency text,
  total_cents bigint,
  quote_fx_rate numeric,
  quote_fx_on date,
  quote_fx_source text,
  quote_total_try_cents bigint,
  applied_cents bigint,
  remaining_cents bigint,
  collected_try_cents bigint,
  counted_count bigint,
  voided_count bigint,
  legacy_count bigint,
  last_paid_on date
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.* FROM public.pp__plans_state(p_clinic) s WHERE s.plan_id = p_plan
$$;

-- PaymentJson (§5.1). Rates are strings, money integer cents next to its currency.
CREATE OR REPLACE FUNCTION public.pp__payment_obj(p public.payments)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'plan_id', p.treatment_plan_id,
    'patient_id', p.patient_id,
    'paid_on', p.paid_on,
    'recorded_at', coalesce(p.paid_at, p.created_at),
    'status', p.status,
    'counts', coalesce(p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0, false),
    'currency', p.currency,
    'amount_cents', p.amount_cents,
    'fx_rate', public.pp__rate_text(p.fx_rate),
    'fx_rate_source', p.fx_rate_source,
    'fx_rate_on', CASE WHEN p.fx_rate_source IN ('workbook', 'manual')
                       THEN (SELECT r.rate_on FROM public.fx_rates r
                             WHERE r.clinic_id = p.clinic_id AND r.id = p.fx_rate_id)
                       WHEN p.fx_rate_source = 'entered' THEN p.paid_on END,
    'amount_try_cents', p.amount_try_cents,
    'plan_currency', p.plan_currency,
    'plan_fx_rate', public.pp__rate_text(p.plan_fx_rate),
    'plan_fx_rate_source', p.plan_fx_rate_source,
    'plan_fx_rate_on', CASE WHEN p.plan_fx_rate_source IN ('workbook', 'manual')
                            THEN (SELECT r.rate_on FROM public.fx_rates r
                                  WHERE r.clinic_id = p.clinic_id AND r.id = p.plan_fx_rate_id)
                            WHEN p.plan_fx_rate_source = 'entered' THEN p.paid_on END,
    'applied_plan_cents', p.applied_plan_cents,
    'method', p.payment_method,
    'method_raw', p.payment_method_raw,
    'note', p.notes,
    'received_by_name', public.fin__user_name(p.received_by),
    'voided_at', p.voided_at,
    'voided_by_name', public.fin__user_name(p.voided_by),
    'void_reason', p.void_reason,
    'legacy_status', CASE WHEN p.status IS DISTINCT FROM 'paid' THEN coalesce(p.status::text, 'pending') END
  )
$$;

-- Plan object of pp_plan_account (§5.5).
CREATE OR REPLACE FUNCTION public.pp__plan_json(p_clinic uuid, p_plan uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', tp.id,
    'title', tp.title,
    'status', tp.status,
    'patient_id', tp.patient_id,
    'patient_name', pt.full_name,
    'doctor_id', tp.doctor_id,
    'created_at', tp.created_at,
    'currency', tp.currency,
    'total_cents', pg_catalog.round(tp.total_cost * 100)::bigint,
    'quote_fx_rate', public.pp__rate_text(tp.quote_fx_rate),
    'quote_fx_on', tp.quote_fx_on,
    'quote_fx_source', tp.quote_fx_source,
    'quote_fx_rate_id', tp.quote_fx_rate_id,
    'quote_total_try_cents', tp.quote_total_try_cents)
  FROM public.treatment_plans tp
  LEFT JOIN public.patients pt ON pt.clinic_id = tp.clinic_id AND pt.id = tp.patient_id
  WHERE tp.clinic_id = p_clinic AND tp.id = p_plan
$$;

-- Totals object of pp_plan_account (§5.5). The TL estimate of the remaining amount uses the latest known rate
-- on p_today and is never quote TL minus collected TL (§3).
CREATE OR REPLACE FUNCTION public.pp__plan_totals_json(p_clinic uuid, p_plan uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'currency', s.currency,
    'total_cents', s.total_cents,
    'applied_cents', s.applied_cents,
    'remaining_cents', s.remaining_cents,
    'collected_try_cents', s.collected_try_cents,
    'by_currency', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', x.currency, 'amount_cents', x.amount_cents,
                                          'try_cents', x.try_cents, 'count', x.n)
                       ORDER BY (x.currency <> 'TRY'), x.currency)
      FROM (SELECT p.currency, sum(p.amount_cents)::bigint AS amount_cents,
                   sum(p.amount_try_cents)::bigint AS try_cents, count(*) AS n
            FROM public.payments p
            WHERE p.clinic_id = p_clinic AND p.treatment_plan_id = p_plan
              AND p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0
            GROUP BY p.currency) x), '[]'::jsonb),
    'remaining_try_estimate',
      CASE WHEN s.currency = 'TRY'
             THEN jsonb_build_object('cents', s.remaining_cents, 'rate', '1.000000', 'rate_on', NULL, 'source', 'none')
           WHEN r.id IS NULL THEN NULL
           ELSE jsonb_build_object('cents', pg_catalog.round(s.remaining_cents * r.rate)::bigint,
                                   'rate', public.pp__rate_text(r.rate), 'rate_on', r.rate_on, 'source', r.source)
      END,
    'voided_count', s.voided_count,
    'legacy_count', s.legacy_count,
    'last_paid_on', s.last_paid_on)
  FROM public.pp__plan_state(p_clinic, p_plan) s
  LEFT JOIN LATERAL public.pp__fx_lookup(p_clinic, s.currency, p_today) r ON true
$$;

-- ---------------------------------------------------------------------------
-- Guard triggers (SECURITY DEFINER, never granted; EXECUTE is not checked when a trigger fires). RPCs check the
-- same rules first so the user sees the specific message; these are the backstop for direct table writes.
-- ---------------------------------------------------------------------------

-- fx_rates: version / timestamps; the key columns never change.
CREATE OR REPLACE FUNCTION public.pp__trg_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.rate_on IS DISTINCT FROM OLD.rate_on
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM public.pp__raise('E_IMMUTABLE');
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := coalesce(public.current_app_user_id(), NEW.updated_by);
  RETURN NEW;
END;
$$;

-- payments and fx_rates are never deleted by app users (owner decision 3). The SQL editor / service role may
-- delete rows (test cleanup, clinic cascade); TRUNCATE is always refused.
CREATE OR REPLACE FUNCTION public.pp__trg_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND public.pp__is_backend() THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'fx_rates' THEN
    PERFORM public.pp__raise('E_FX_DELETE');
  ELSE
    PERFORM public.pp__raise('E_PAYMENT_DELETE');
  END IF;
  RETURN NULL;
END;
$$;

-- payments: inserted only by pp_record_payment (pp.ctx = 'record'); afterwards only the void columns may change,
-- once, from NULL to set, inside pp_void_payment (pp.ctx = 'void'). PostgREST cannot set pp.ctx.
-- amount_cents is generated and therefore not compared here.
CREATE OR REPLACE FUNCTION public.pp__trg_payment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx text := coalesce(current_setting('pp.ctx', true), '');
BEGIN
  IF public.pp__is_backend() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_ctx <> 'record' THEN
      PERFORM public.pp__raise('E_PAYMENT_DIRECT');
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'amount_cents'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'amount_cents']) THEN
    PERFORM public.pp__raise('E_PAYMENT_LOCKED');
  END IF;

  IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.voided_by IS NOT DISTINCT FROM OLD.voided_by
     AND NEW.void_reason IS NOT DISTINCT FROM OLD.void_reason THEN
    RETURN NEW;
  END IF;

  IF OLD.voided_at IS NOT NULL THEN
    PERFORM public.pp__raise('E_PAYMENT_VOIDED');
  END IF;
  IF v_ctx <> 'void' OR NEW.voided_at IS NULL THEN
    PERFORM public.pp__raise('E_PAYMENT_LOCKED');
  END IF;
  RETURN NEW;
END;
$$;

-- treatment_plans: plan writes stay direct table writes (0007 policies), so the quote rules live here (§2.3).
CREATE OR REPLACE FUNCTION public.pp__trg_plan_money()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date;
  v_src text;
  v_src_id uuid;
  v_src_on date;
  v_applied bigint;
BEGIN
  -- SQL editor / service role (legacy data loads): CHECK constraints still apply.
  IF public.pp__is_backend() THEN
    RETURN NEW;
  END IF;

  -- legacy_id is written only by the legacy load (§9, service role). An app user can neither claim one (which would
  -- make the load's ON CONFLICT (clinic_id, legacy_id) DO NOTHING skip the real legacy plan) nor change one.
  IF TG_OP = 'INSERT' THEN
    NEW.legacy_id := NULL;
  ELSE
    NEW.legacy_id := OLD.legacy_id;
  END IF;

  NEW.currency := public.pp__currency(NEW.currency);

  IF TG_OP = 'UPDATE' AND NEW.currency IS DISTINCT FROM OLD.currency THEN
    -- A plan whose payments are all voided may change currency.
    IF EXISTS (
         SELECT 1 FROM public.payments p
         WHERE p.clinic_id = OLD.clinic_id AND p.treatment_plan_id = OLD.id
           AND p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0) THEN
      PERFORM public.pp__raise('E_PLAN_CURRENCY_LOCKED');
    END IF;
    -- Item prices and the total are numbers in the plan currency; a currency change would relabel them 1:1
    -- (₺8.500 becoming €8.500). Only a plan without items may change currency; its typed total is shown with it.
    IF EXISTS (SELECT 1 FROM public.treatment_items ti
               WHERE ti.clinic_id = OLD.clinic_id AND ti.treatment_plan_id = OLD.id) THEN
      PERFORM public.pp__raise('E_PLAN_CURRENCY_ITEMS');
    END IF;
    -- The old quote rate belongs to the old currency (TRY's is 1): a new foreign currency needs its own rate.
    IF NEW.currency <> 'TRY' AND NEW.quote_fx_rate IS NOT DISTINCT FROM OLD.quote_fx_rate THEN
      PERFORM public.pp__raise('E_QUOTE_FX_REQUIRED');
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.total_cost IS DISTINCT FROM OLD.total_cost THEN
    IF NEW.total_cost IS NULL OR NEW.total_cost < 0 OR NEW.total_cost > 10000000000
       OR NEW.total_cost <> round(NEW.total_cost, 2) THEN
      PERFORM public.pp__raise('E_PLAN_TOTAL');
    END IF;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.quote_fx_rate IS DISTINCT FROM OLD.quote_fx_rate
     OR NEW.quote_fx_rate_id IS DISTINCT FROM OLD.quote_fx_rate_id
     OR NEW.quote_fx_on IS DISTINCT FROM OLD.quote_fx_on THEN
    IF NEW.currency = 'TRY' THEN
      NEW.quote_fx_rate := 1;
      NEW.quote_fx_on := NULL;
      NEW.quote_fx_source := 'none';
      NEW.quote_fx_rate_id := NULL;
    ELSE
      NEW.quote_fx_rate := public.pp__rate(NEW.quote_fx_rate);
      SELECT s.o_source, s.o_id, s.o_rate_on INTO v_src, v_src_id, v_src_on
      FROM public.pp__rate_source(NEW.clinic_id, NEW.currency, NEW.quote_fx_rate, NEW.quote_fx_rate_id) s;
      v_today := public.clinic_today();
      IF v_src_id IS NOT NULL THEN
        NEW.quote_fx_source := v_src;
        NEW.quote_fx_rate_id := v_src_id;
        NEW.quote_fx_on := v_src_on;
      ELSE
        NEW.quote_fx_source := 'entered';
        NEW.quote_fx_rate_id := NULL;
        NEW.quote_fx_on := coalesce(NEW.quote_fx_on, v_today);
      END IF;
      IF NEW.quote_fx_on > v_today THEN
        PERFORM public.pp__raise('E_FX_DATE_FUTURE');
      END IF;
      IF NEW.quote_fx_on < DATE '2000-01-01' THEN
        PERFORM public.pp__raise('E_DATE');
      END IF;
    END IF;
  ELSE
    -- The client's quote_fx_source is always ignored.
    NEW.quote_fx_source := OLD.quote_fx_source;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- payments.patient_id is copied from the plan when the payment is recorded; keep them aligned.
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id AND EXISTS (
       SELECT 1 FROM public.payments p
       WHERE p.clinic_id = OLD.clinic_id AND p.treatment_plan_id = OLD.id) THEN
    PERFORM public.pp__raise('E_PLAN_PATIENT_LOCKED');
  END IF;

  IF NEW.total_cost < OLD.total_cost THEN
    SELECT s.applied_cents INTO v_applied FROM public.pp__plan_state(OLD.clinic_id, OLD.id) s;
    IF round(NEW.total_cost * 100) < coalesce(v_applied, 0) THEN
      PERFORM public.pp__raise('E_PLAN_TOTAL_BELOW_PAID', public.pp__money_text(v_applied, NEW.currency),
                               v_applied::text);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger wiring. payments_insert_guard (0019) is dropped as a trigger; its function stays (0019 grants it).
DROP TRIGGER IF EXISTS payments_insert_guard ON public.payments;

DROP TRIGGER IF EXISTS pp_payment_guard ON public.payments;
CREATE TRIGGER pp_payment_guard
  BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.pp__trg_payment_guard();

DROP TRIGGER IF EXISTS pp_no_delete ON public.payments;
CREATE TRIGGER pp_no_delete
  BEFORE DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.pp__trg_no_delete();
DROP TRIGGER IF EXISTS pp_no_truncate ON public.payments;
CREATE TRIGGER pp_no_truncate
  BEFORE TRUNCATE ON public.payments
  FOR EACH STATEMENT EXECUTE FUNCTION public.pp__trg_no_delete();

DROP TRIGGER IF EXISTS pp_plan_money ON public.treatment_plans;
CREATE TRIGGER pp_plan_money
  BEFORE INSERT OR UPDATE ON public.treatment_plans
  FOR EACH ROW EXECUTE FUNCTION public.pp__trg_plan_money();

DROP TRIGGER IF EXISTS pp_touch ON public.fx_rates;
CREATE TRIGGER pp_touch
  BEFORE UPDATE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION public.pp__trg_touch();
DROP TRIGGER IF EXISTS pp_no_delete ON public.fx_rates;
CREATE TRIGGER pp_no_delete
  BEFORE DELETE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION public.pp__trg_no_delete();
DROP TRIGGER IF EXISTS pp_no_truncate ON public.fx_rates;
CREATE TRIGGER pp_no_truncate
  BEFORE TRUNCATE ON public.fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION public.pp__trg_no_delete();

-- Audit (0019 audit_row_change). payments and treatment_plans already have it; re-created so a re-run converges.
DROP TRIGGER IF EXISTS audit_row_change ON public.fx_rates;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
DROP TRIGGER IF EXISTS audit_row_change ON public.payments;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
DROP TRIGGER IF EXISTS audit_row_change ON public.treatment_plans;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.treatment_plans
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

-- ---------------------------------------------------------------------------
-- 2.5 payments RLS and privileges: SELECT only for the owner and finance / finance_readonly holders of the clinic;
--     no client writes at all (pp_record_payment / pp_void_payment are the only writers).
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_pol record;
BEGIN
  FOR v_pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payments'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.payments', v_pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "payments_select_owner_finance" ON public.payments
  FOR SELECT TO authenticated
  USING (
    clinic_id = (SELECT public.current_clinic_id())
    AND (
      (SELECT public.current_app_role()) = 'owner'
      OR (SELECT public.has_permission('finance'))
      OR (SELECT public.has_permission('finance_readonly'))
    )
  );

REVOKE ALL ON public.payments FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.payments FROM authenticated;
GRANT SELECT ON public.payments TO authenticated;

-- ---------------------------------------------------------------------------
-- §5 RPCs for any active staff member (pp_*).
-- ---------------------------------------------------------------------------

-- Idempotent retry of pp_record_payment (§5.1 step 2): NULL when p_id is unused; the saved envelope when this
-- clinic already holds p_id with the same payload; E_PAYMENT_ID_TAKEN otherwise (also for another clinic's id,
-- with nothing about that row revealed).
CREATE OR REPLACE FUNCTION public.pp__record_replay(
  p_clinic uuid, p_id uuid, p_plan_id uuid, p_amount_cents bigint, p_currency text, p_method text,
  p_paid_on date, p_fx_rate numeric, p_plan_fx_rate numeric, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_p public.payments%ROWTYPE;
  v_cur text := upper(btrim(coalesce(p_currency, '')));
BEGIN
  SELECT * INTO v_p FROM public.payments WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_p.clinic_id <> p_clinic THEN
    PERFORM public.pp__raise('E_PAYMENT_ID_TAKEN');
  END IF;
  IF coalesce(
       v_p.treatment_plan_id = p_plan_id
       AND v_p.amount_cents = p_amount_cents
       AND v_p.currency = v_cur
       AND v_p.payment_method IS NOT DISTINCT FROM nullif(btrim(coalesce(p_method, '')), '')
       AND (p_paid_on IS NULL OR v_p.paid_on = p_paid_on)
       AND v_p.fx_rate = coalesce(p_fx_rate, CASE WHEN v_cur = 'TRY' THEN 1 END)
       AND ((p_plan_fx_rate IS NULL AND (v_p.plan_currency = 'TRY' OR v_p.plan_currency = v_p.currency))
            OR v_p.plan_fx_rate = p_plan_fx_rate)
       AND v_p.notes IS NOT DISTINCT FROM nullif(btrim(coalesce(p_note, '')), ''),
       false) THEN
    RETURN jsonb_build_object(
      'already_saved', true,
      'payment', public.pp__payment_obj(v_p),
      'account', public.pp__plan_totals_json(p_clinic, v_p.treatment_plan_id, public.clinic_today()));
  END IF;
  PERFORM public.pp__raise('E_PAYMENT_ID_TAKEN');
  RETURN NULL;
END;
$$;

-- §5.1 Record a payment. Any active staff member; paid_on other than today only for the owner / finance (0019).
CREATE OR REPLACE FUNCTION public.pp_record_payment(
  p_id uuid,
  p_plan_id uuid,
  p_amount_cents bigint,
  p_currency text,
  p_method text,
  p_paid_on date,
  p_fx_rate numeric,
  p_fx_rate_id uuid,
  p_plan_fx_rate numeric,
  p_plan_fx_rate_id uuid,
  p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.pp__require_staff();
  v_today date := public.clinic_today();
  v_plan public.treatment_plans%ROWTYPE;
  v_existing jsonb;
  v_cur text;
  v_method text;
  v_note text;
  v_on date;
  v_fx numeric;
  v_fx_src text;
  v_fx_id uuid;
  v_pfx numeric;
  v_pfx_src text;
  v_pfx_id uuid;
  v_try bigint;
  v_applied bigint;
  v_remaining bigint;
  v_payment jsonb;
BEGIN
  IF p_id IS NULL THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  -- 2. Idempotency (before the plan lookup, so an id of another clinic is always 409).
  v_existing := public.pp__record_replay(v_clinic, p_id, p_plan_id, p_amount_cents, p_currency, p_method,
                                         p_paid_on, p_fx_rate, p_plan_fx_rate, p_note);
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- 3. Lock the plan: two desks cannot both take the last euro.
  SELECT * INTO v_plan FROM public.treatment_plans
  WHERE clinic_id = v_clinic AND id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pp__raise('E_PLAN_NOT_FOUND');
  END IF;
  -- A retry with the same id may have committed while this call waited for the lock.
  v_existing := public.pp__record_replay(v_clinic, p_id, p_plan_id, p_amount_cents, p_currency, p_method,
                                         p_paid_on, p_fx_rate, p_plan_fx_rate, p_note);
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;
  IF v_plan.status::text = 'cancelled' THEN
    PERFORM public.pp__raise('E_PLAN_CANCELLED');
  END IF;

  -- 4. Inputs.
  IF p_amount_cents IS NULL OR p_amount_cents < 1 OR p_amount_cents > 1000000000000 THEN
    PERFORM public.pp__raise('E_AMOUNT');
  END IF;
  v_cur := public.pp__currency(p_currency);
  v_method := nullif(btrim(coalesce(p_method, '')), '');
  IF v_method IS NULL OR v_method NOT IN ('cash', 'card', 'transfer', 'financing') THEN
    PERFORM public.pp__raise('E_METHOD');
  END IF;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF char_length(v_note) > 500 THEN
    PERFORM public.pp__raise('E_NOTE');
  END IF;

  -- 5. Business date.
  v_on := coalesce(p_paid_on, v_today);
  IF v_on > v_today THEN
    PERFORM public.pp__raise('E_PAID_ON_FUTURE');
  END IF;
  IF v_on < DATE '2000-01-01' THEN
    PERFORM public.pp__raise('E_DATE');
  END IF;
  IF v_on <> v_today AND NOT public.pp__can_backdate() THEN
    PERFORM public.pp__raise('E_BACKDATE_ROLE');
  END IF;

  -- 6. Rates (§3 table). Payment currency X = v_cur, plan currency C = v_plan.currency.
  IF v_cur = 'TRY' THEN
    IF p_fx_rate IS NOT NULL AND p_fx_rate <> 1 THEN
      PERFORM public.pp__raise('E_FX_TRY');
    END IF;
    v_fx := 1;
    v_fx_src := 'none';
    v_fx_id := NULL;
  ELSE
    IF p_fx_rate IS NULL THEN
      PERFORM public.pp__raise('E_FX_REQUIRED');
    END IF;
    v_fx := public.pp__rate(p_fx_rate);
    SELECT s.o_source, s.o_id INTO v_fx_src, v_fx_id
    FROM public.pp__rate_source(v_clinic, v_cur, v_fx, p_fx_rate_id) s;
  END IF;

  IF v_plan.currency = 'TRY' THEN
    IF p_plan_fx_rate IS NOT NULL AND p_plan_fx_rate <> 1 THEN
      PERFORM public.pp__raise('E_FX_TRY');
    END IF;
    v_pfx := 1;
    v_pfx_src := 'none';
    v_pfx_id := NULL;
  ELSIF v_plan.currency = v_cur THEN
    IF p_plan_fx_rate IS NOT NULL AND p_plan_fx_rate <> v_fx THEN
      PERFORM public.pp__raise('E_FX_RATE');
    END IF;
    v_pfx := v_fx;
    v_pfx_src := v_fx_src;
    v_pfx_id := v_fx_id;
  ELSE
    IF p_plan_fx_rate IS NULL THEN
      PERFORM public.pp__raise('E_PLAN_FX_REQUIRED');
    END IF;
    v_pfx := public.pp__rate(p_plan_fx_rate);
    SELECT s.o_source, s.o_id INTO v_pfx_src, v_pfx_id
    FROM public.pp__rate_source(v_clinic, v_plan.currency, v_pfx, p_plan_fx_rate_id) s;
  END IF;

  -- 6b. Staff without owner / finance rights: every foreign rate used must be within 10 % of the clinic's reference
  --     rate for the payment day (pp__rate_guard). Same predicate as voiding and back-dating (pp_can_void).
  IF NOT public.pp_can_void() THEN
    IF v_cur <> 'TRY' THEN
      PERFORM public.pp__rate_guard(v_clinic, v_cur, v_fx, v_on);
    END IF;
    IF v_plan.currency NOT IN ('TRY', v_cur) THEN
      PERFORM public.pp__rate_guard(v_clinic, v_plan.currency, v_pfx, v_on);
    END IF;
  END IF;

  -- 7. Amounts and the overpayment rule (remaining is always in the plan currency). A converted value of 0 cents
  --    would count nowhere and pass the overpay check on a fully paid plan, so it is refused.
  v_try := public.pp__try_cents(p_amount_cents, v_fx);
  v_applied := CASE WHEN v_cur = v_plan.currency THEN p_amount_cents
                    ELSE public.pp__applied_cents(v_try, v_pfx) END;
  IF v_try < 1 OR v_applied < 1 THEN
    PERFORM public.pp__raise('E_AMOUNT_SMALL');
  END IF;
  SELECT s.remaining_cents INTO v_remaining FROM public.pp__plan_state(v_clinic, v_plan.id) s;
  IF v_applied > v_remaining THEN
    PERFORM public.pp__raise('E_OVERPAY', public.pp__money_text(v_remaining, v_plan.currency), v_remaining::text);
  END IF;

  -- 8. Insert (patient from the plan, receiver and timestamps from the server).
  PERFORM set_config('pp.ctx', 'record', true);
  BEGIN
    INSERT INTO public.payments (
      id, clinic_id, treatment_plan_id, patient_id, amount, status, payment_method, notes, created_at, paid_at,
      paid_on, currency, fx_rate, fx_rate_source, fx_rate_id, amount_try_cents, plan_currency, plan_fx_rate,
      plan_fx_rate_source, plan_fx_rate_id, applied_plan_cents, received_by)
    VALUES (
      p_id, v_clinic, v_plan.id, v_plan.patient_id, round(p_amount_cents::numeric / 100, 2), 'paid', v_method, v_note,
      now(), now(), v_on, v_cur, v_fx, v_fx_src, v_fx_id, v_try, v_plan.currency, v_pfx, v_pfx_src, v_pfx_id,
      v_applied, public.current_app_user_id());
  EXCEPTION WHEN unique_violation THEN
    PERFORM set_config('pp.ctx', '', true);
    PERFORM public.pp__raise('E_PAYMENT_ID_TAKEN');
  END;
  PERFORM set_config('pp.ctx', '', true);

  SELECT public.pp__payment_obj(p) INTO v_payment FROM public.payments p WHERE p.clinic_id = v_clinic AND p.id = p_id;
  RETURN jsonb_build_object(
    'already_saved', false,
    'payment', v_payment,
    'account', public.pp__plan_totals_json(v_clinic, v_plan.id, v_today));
END;
$$;

-- §5.2 Void a payment with a reason: owner or 'finance' only. Never deleted, never edited.
CREATE OR REPLACE FUNCTION public.pp_void_payment(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.pp__require_staff();
  v_today date := public.clinic_today();
  v_reason text;
  v_p public.payments%ROWTYPE;
  v_payment jsonb;
BEGIN
  IF NOT public.pp_can_void() THEN
    PERFORM public.pp__raise('E_VOID_ROLE');
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.pp__raise('E_REASON');
  END IF;
  v_reason := btrim(p_reason);

  SELECT * INTO v_p FROM public.payments WHERE clinic_id = v_clinic AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pp__raise('E_PAYMENT_NOT_FOUND');
  END IF;

  IF v_p.voided_at IS NOT NULL THEN
    IF v_p.void_reason = v_reason THEN
      RETURN jsonb_build_object(
        'already_saved', true,
        'payment', public.pp__payment_obj(v_p),
        'account', public.pp__plan_totals_json(v_clinic, v_p.treatment_plan_id, v_today));
    END IF;
    PERFORM public.pp__raise('E_PAYMENT_VOIDED');
  END IF;

  PERFORM set_config('pp.ctx', 'void', true);
  BEGIN
    UPDATE public.payments
    SET voided_at = now(), voided_by = public.current_app_user_id(), void_reason = v_reason
    WHERE clinic_id = v_clinic AND id = p_id;
  EXCEPTION WHEN check_violation THEN
    -- An old row that breaks a NOT VALID rule (amount <= 0, more than 2 decimals) cannot be changed by the app.
    PERFORM set_config('pp.ctx', '', true);
    PERFORM public.pp__raise('E_PAYMENT_LEGACY_INVALID');
  END;
  PERFORM set_config('pp.ctx', '', true);

  SELECT public.pp__payment_obj(p) INTO v_payment FROM public.payments p WHERE p.clinic_id = v_clinic AND p.id = p_id;
  RETURN jsonb_build_object(
    'already_saved', false,
    'payment', v_payment,
    'account', public.pp__plan_totals_json(v_clinic, v_p.treatment_plan_id, v_today));
END;
$$;

-- §5.3 Latest known rate per currency for a day (prefill of the payment and plan forms). Any staff member.
CREATE OR REPLACE FUNCTION public.pp_fx_rates(p_on date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.pp__require_staff();
  v_today date := public.clinic_today();
  v_on date;
BEGIN
  v_on := least(coalesce(p_on, v_today), v_today);
  RETURN jsonb_build_object(
    'as_of', v_on,
    'today', v_today,
    'rates', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'currency', c.cur, 'id', r.id, 'rate', public.pp__rate_text(r.rate), 'rate_on', r.rate_on,
               'source', r.source, 'is_on_day', r.rate_on = v_on, 'age_days', v_on - r.rate_on)
             ORDER BY c.ord)
      FROM unnest(ARRAY['EUR', 'USD', 'GBP']) WITH ORDINALITY AS c(cur, ord)
      CROSS JOIN LATERAL public.pp__fx_lookup(v_clinic, c.cur, v_on) r), '[]'::jsonb));
END;
$$;

-- §5.4 Save reference rates (manual entry or the workbook import). Owner or 'finance'. Items:
-- [{currency, rate: "49.85", rate_on: "YYYY-MM-DD", note?}], 1..10, strict keys. Re-sending the same items is a
-- no-op ('unchanged'). Payments and plans keep their own copy of a rate, so a correction never changes money.
CREATE OR REPLACE FUNCTION public.pp_fx_save_rates(p_items jsonb, p_source text, p_file text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.pp__require_staff();
  v_today date := public.clinic_today();
  v_user uuid := public.current_app_user_id();
  v_source text;
  v_file text;
  v_item jsonb;
  v_cur text;
  v_rate_txt text;
  v_rate numeric;
  v_on date;
  v_has_note boolean;
  v_note text;
  v_row public.fx_rates%ROWTYPE;
  v_action text;
  v_seen text[] := '{}'::text[];
  v_saved jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.pp_can_void() THEN
    PERFORM public.pp__raise('E_FX_ROLE');
  END IF;

  v_source := btrim(coalesce(p_source, ''));
  IF v_source NOT IN ('manual', 'workbook') THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;
  v_file := nullif(btrim(coalesce(p_file, '')), '');
  IF char_length(v_file) > 200 THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;
  -- Type first, then length: SQL does not promise short-circuit evaluation of OR.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 10 THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  -- One writer per clinic at a time, so the select-then-insert below cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('fx_rates:' || v_clinic::text, 0));

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      PERFORM public.pp__raise('E_FILTER');
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) AS k(name)
               WHERE k.name NOT IN ('currency', 'rate', 'rate_on', 'note'))
       OR NOT (v_item ? 'currency' AND v_item ? 'rate' AND v_item ? 'rate_on') THEN
      PERFORM public.pp__raise('E_FILTER');
    END IF;

    IF jsonb_typeof(v_item -> 'currency') <> 'string' THEN
      PERFORM public.pp__raise('E_CURRENCY');
    END IF;
    v_cur := upper(btrim(v_item ->> 'currency'));
    IF v_cur NOT IN ('EUR', 'USD', 'GBP') THEN
      PERFORM public.pp__raise('E_CURRENCY');
    END IF;

    -- Strings preferred ("49.876543"); a JSON number is parsed by jsonb as an exact numeric, never a float.
    IF jsonb_typeof(v_item -> 'rate') NOT IN ('string', 'number') THEN
      PERFORM public.pp__raise('E_FX_RATE');
    END IF;
    v_rate_txt := btrim(v_item ->> 'rate');
    IF v_rate_txt !~ '^[0-9]{1,4}(\.[0-9]{1,20})?$' THEN
      PERFORM public.pp__raise('E_FX_RATE');
    END IF;
    v_rate := public.pp__rate(v_rate_txt::numeric);

    IF jsonb_typeof(v_item -> 'rate_on') <> 'string' OR (v_item ->> 'rate_on') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      PERFORM public.pp__raise('E_DATE');
    END IF;
    BEGIN
      v_on := (v_item ->> 'rate_on')::date;
    EXCEPTION WHEN data_exception THEN
      PERFORM public.pp__raise('E_DATE');
    END;
    IF v_on > v_today THEN
      PERFORM public.pp__raise('E_FX_DATE_FUTURE');
    END IF;
    IF v_on < DATE '2000-01-01' THEN
      PERFORM public.pp__raise('E_DATE');
    END IF;

    v_has_note := v_item ? 'note' AND jsonb_typeof(v_item -> 'note') <> 'null';
    v_note := NULL;
    IF v_has_note THEN
      IF jsonb_typeof(v_item -> 'note') <> 'string' THEN
        PERFORM public.pp__raise('E_NOTE');
      END IF;
      v_note := nullif(btrim(v_item ->> 'note'), '');
      IF char_length(v_note) > 500 THEN
        PERFORM public.pp__raise('E_NOTE');
      END IF;
    END IF;

    IF (v_cur || ':' || v_on::text) = ANY (v_seen) THEN
      PERFORM public.pp__raise('E_FILTER');
    END IF;
    v_seen := v_seen || (v_cur || ':' || v_on::text);

    SELECT * INTO v_row FROM public.fx_rates
    WHERE clinic_id = v_clinic AND currency = v_cur AND rate_on = v_on AND source = v_source
    FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.fx_rates (clinic_id, currency, rate, rate_on, source, source_file, note, created_by, updated_by)
      VALUES (v_clinic, v_cur, v_rate, v_on, v_source, v_file, v_note, v_user, v_user)
      RETURNING * INTO v_row;
      v_action := 'inserted';
    ELSIF v_row.rate <> v_rate
          OR v_row.source_file IS DISTINCT FROM v_file
          OR (v_has_note AND v_row.note IS DISTINCT FROM v_note) THEN
      UPDATE public.fx_rates
      SET rate = v_rate,
          source_file = v_file,
          note = CASE WHEN v_has_note THEN v_note ELSE note END
      WHERE clinic_id = v_clinic AND id = v_row.id
      RETURNING * INTO v_row;
      v_action := 'updated';
    ELSE
      v_action := 'unchanged';
    END IF;

    v_saved := v_saved || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'currency', v_row.currency, 'rate_on', v_row.rate_on,
      'rate', public.pp__rate_text(v_row.rate), 'source', v_row.source, 'action', v_action));
  END LOOP;

  RETURN jsonb_build_object('today', v_today, 'saved', v_saved);
END;
$$;

-- §5.5 One plan's account: figures, payments (voided included, newest first, cap 500). Any staff member.
CREATE OR REPLACE FUNCTION public.pp_plan_account(p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.pp__require_staff();
  v_today date := public.clinic_today();
  v_count bigint;
  v_payments jsonb;
BEGIN
  IF p_plan_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.treatment_plans WHERE clinic_id = v_clinic AND id = p_plan_id) THEN
    PERFORM public.pp__raise('E_PLAN_NOT_FOUND');
  END IF;

  SELECT count(*) INTO v_count FROM public.payments WHERE clinic_id = v_clinic AND treatment_plan_id = p_plan_id;

  SELECT coalesce(jsonb_agg(public.pp__payment_obj(x.pr) ORDER BY x.rn), '[]'::jsonb)
    INTO v_payments
  FROM (
    SELECT p AS pr,
           row_number() OVER (ORDER BY p.paid_on DESC, coalesce(p.paid_at, p.created_at) DESC, p.id) AS rn
    FROM public.payments p
    WHERE p.clinic_id = v_clinic AND p.treatment_plan_id = p_plan_id
  ) x
  WHERE x.rn <= 500;

  RETURN jsonb_build_object(
    'today', v_today,
    'can_void', public.pp_can_void(),
    'can_backdate', public.pp__can_backdate(),
    'plan', public.pp__plan_json(v_clinic, p_plan_id),
    'totals', public.pp__plan_totals_json(v_clinic, p_plan_id, v_today),
    'payments', v_payments,
    'truncated', v_count > 500);
END;
$$;

-- §5.6 One patient's account. Remaining is never offset across currencies; the TL estimate uses today's latest
-- rates and is NULL when a needed rate is missing. Any staff member (patient-level figures, legacy TD:6).
CREATE OR REPLACE FUNCTION public.pp_patient_account(p_patient_id uuid, p_include_voided boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.pp__require_staff();
  v_today date := public.clinic_today();
  v_name text;
  v_incl boolean := coalesce(p_include_voided, false);
  v_summary jsonb;
  v_plans jsonb;
  v_payments jsonb;
  v_pay_count bigint;
  v_voided bigint;
BEGIN
  SELECT pt.full_name INTO v_name FROM public.patients pt WHERE pt.clinic_id = v_clinic AND pt.id = p_patient_id;
  IF NOT FOUND THEN
    PERFORM public.pp__raise('E_PATIENT_NOT_FOUND');
  END IF;

  WITH pl AS MATERIALIZED (
    SELECT s.* FROM public.pp__plans_state(v_clinic) s WHERE s.patient_id = p_patient_id
  ),
  cur AS MATERIALIZED (
    SELECT pl.currency,
           sum(pl.total_cents)::bigint AS quoted_cents,
           sum(pl.applied_cents)::bigint AS applied_cents,
           sum(pl.remaining_cents)::bigint AS remaining_cents,
           sum(pl.quote_total_try_cents)::bigint AS quoted_try_cents
    FROM pl
    WHERE pl.status <> 'cancelled'
    GROUP BY pl.currency
  ),
  est AS MATERIALIZED (
    SELECT cur.currency, cur.remaining_cents, r.rate, r.rate_on,
           CASE WHEN cur.currency = 'TRY' THEN cur.remaining_cents
                WHEN r.rate IS NULL THEN NULL
                ELSE round(cur.remaining_cents * r.rate)::bigint END AS try_cents
    FROM cur
    LEFT JOIN LATERAL public.pp__fx_lookup(v_clinic, cur.currency, v_today) r ON true
  ),
  pay AS MATERIALIZED (
    SELECT p.currency, p.amount_cents, p.amount_try_cents, tp.status::text AS plan_status
    FROM public.payments p
    JOIN public.treatment_plans tp ON tp.clinic_id = p.clinic_id AND tp.id = p.treatment_plan_id
    WHERE p.clinic_id = v_clinic AND p.patient_id = p_patient_id
      AND p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0
  )
  SELECT jsonb_build_object(
    'by_currency', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', cur.currency, 'quoted_cents', cur.quoted_cents,
                                          'applied_cents', cur.applied_cents, 'remaining_cents', cur.remaining_cents,
                                          'quoted_try_cents', cur.quoted_try_cents)
                       ORDER BY (cur.currency <> 'TRY'), cur.currency)
      FROM cur), '[]'::jsonb),
    'collected', jsonb_build_object(
      'try_cents', (SELECT coalesce(sum(pay.amount_try_cents), 0)::bigint FROM pay),
      'by_currency', coalesce((
        SELECT jsonb_agg(jsonb_build_object('currency', x.currency, 'amount_cents', x.amount_cents,
                                            'try_cents', x.try_cents, 'count', x.n)
                         ORDER BY (x.currency <> 'TRY'), x.currency)
        FROM (SELECT pay.currency, sum(pay.amount_cents)::bigint AS amount_cents,
                     sum(pay.amount_try_cents)::bigint AS try_cents, count(*) AS n
              FROM pay GROUP BY pay.currency) x), '[]'::jsonb),
      'cancelled_plans_try_cents',
        (SELECT coalesce(sum(pay.amount_try_cents), 0)::bigint FROM pay WHERE pay.plan_status = 'cancelled')),
    'remaining_try_estimate', jsonb_build_object(
      'cents', CASE WHEN EXISTS (SELECT 1 FROM est WHERE est.try_cents IS NULL AND est.remaining_cents <> 0)
                    THEN NULL
                    ELSE (SELECT coalesce(sum(est.try_cents), 0)::bigint FROM est) END,
      'rates', coalesce((
        SELECT jsonb_agg(jsonb_build_object('currency', est.currency, 'rate', public.pp__rate_text(est.rate),
                                            'rate_on', est.rate_on)
                         ORDER BY est.currency)
        FROM est WHERE est.currency <> 'TRY' AND est.rate IS NOT NULL), '[]'::jsonb),
      'missing_rates', coalesce((
        SELECT jsonb_agg(est.currency ORDER BY est.currency)
        FROM est WHERE est.currency <> 'TRY' AND est.rate IS NULL AND est.remaining_cents <> 0), '[]'::jsonb)),
    'plans', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', y.plan_id, 'title', y.title, 'status', y.status, 'created_at', y.created_at,
               'currency', y.currency, 'total_cents', y.total_cents,
               'quote_fx_rate', public.pp__rate_text(y.quote_fx_rate), 'quote_fx_on', y.quote_fx_on,
               'quote_total_try_cents', y.quote_total_try_cents, 'applied_cents', y.applied_cents,
               'remaining_cents', y.remaining_cents, 'collected_try_cents', y.collected_try_cents,
               'last_paid_on', y.last_paid_on)
             ORDER BY y.rn)
      FROM (SELECT pl.*, row_number() OVER (ORDER BY pl.created_at DESC, pl.plan_id) AS rn FROM pl) y
      WHERE y.rn <= 200), '[]'::jsonb),
    'plans_truncated', (SELECT count(*) FROM pl) > 200)
    INTO v_summary;

  SELECT count(*) FILTER (WHERE p.voided_at IS NOT NULL),
         count(*) FILTER (WHERE v_incl OR p.voided_at IS NULL)
    INTO v_voided, v_pay_count
  FROM public.payments p
  WHERE p.clinic_id = v_clinic AND p.patient_id = p_patient_id;

  SELECT coalesce(jsonb_agg(public.pp__payment_obj(x.pr) || jsonb_build_object('plan_title', x.plan_title)
                            ORDER BY x.rn), '[]'::jsonb)
    INTO v_payments
  FROM (
    SELECT p AS pr, tp.title AS plan_title,
           row_number() OVER (ORDER BY p.paid_on DESC, coalesce(p.paid_at, p.created_at) DESC, p.id) AS rn
    FROM public.payments p
    LEFT JOIN public.treatment_plans tp ON tp.clinic_id = p.clinic_id AND tp.id = p.treatment_plan_id
    WHERE p.clinic_id = v_clinic AND p.patient_id = p_patient_id
      AND (v_incl OR p.voided_at IS NULL)
  ) x
  WHERE x.rn <= 500;

  RETURN jsonb_build_object(
    'today', v_today,
    'can_void', public.pp_can_void(),
    'patient', jsonb_build_object('id', p_patient_id, 'full_name', v_name)
  ) || v_summary || jsonb_build_object(
    'payments', v_payments,
    'payments_truncated', v_pay_count > 500,
    'voided_count', v_voided);
END;
$$;

-- ---------------------------------------------------------------------------
-- §5.7, §5.8, §5.10 Finance-only reads (fin__require_read: finance or finance_readonly; role alone gives nothing).
-- None of them writes anything (owner decision 1).
-- ---------------------------------------------------------------------------

-- §5.7 'Teklifler ve tahsilat'. Totals cover the whole filter, not the page.
CREATE OR REPLACE FUNCTION public.fin_patient_offers(p_filters jsonb, p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_only boolean;
  v_cur text;
  v_query text;
  v_from date;
  v_to date;
  v_sort text;
  v_offset integer;
  v_limit integer;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_f) AS k(name)
             WHERE k.name NOT IN ('status', 'only_remaining', 'currency', 'query', 'from_month', 'to_month', 'sort')) THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  v_status := coalesce(nullif(v_f ->> 'status', ''), 'active');
  IF v_status NOT IN ('open', 'active', 'cancelled', 'all') THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  IF v_f ? 'only_remaining' AND jsonb_typeof(v_f -> 'only_remaining') <> 'null' THEN
    IF jsonb_typeof(v_f -> 'only_remaining') <> 'boolean' THEN
      PERFORM public.pp__raise('E_FILTER');
    END IF;
    v_only := (v_f ->> 'only_remaining')::boolean;
  ELSE
    v_only := true;
  END IF;

  v_cur := nullif(upper(btrim(coalesce(v_f ->> 'currency', ''))), '');
  IF v_cur IS NOT NULL AND v_cur NOT IN ('TRY', 'EUR', 'USD', 'GBP') THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  v_query := nullif(btrim(coalesce(v_f ->> 'query', '')), '');
  IF char_length(v_query) > 100 THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  IF nullif(btrim(coalesce(v_f ->> 'from_month', '')), '') IS NOT NULL THEN
    IF btrim(v_f ->> 'from_month') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      PERFORM public.pp__raise('E_FILTER');
    END IF;
    v_from := (btrim(v_f ->> 'from_month') || '-01')::date;
  END IF;
  IF nullif(btrim(coalesce(v_f ->> 'to_month', '')), '') IS NOT NULL THEN
    IF btrim(v_f ->> 'to_month') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      PERFORM public.pp__raise('E_FILTER');
    END IF;
    v_to := ((btrim(v_f ->> 'to_month') || '-01')::date + interval '1 month')::date;
  END IF;
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_from >= v_to THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  v_sort := coalesce(nullif(v_f ->> 'sort', ''), 'created_desc');
  IF v_sort NOT IN ('created_desc', 'remaining_try_desc', 'last_payment_desc') THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;

  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.fin__page(p_page) pg;

  WITH rt AS MATERIALIZED (
    SELECT c.cur, r.rate, r.rate_on
    FROM unnest(ARRAY['EUR', 'USD', 'GBP']) AS c(cur)
    CROSS JOIN LATERAL public.pp__fx_lookup(v_clinic, c.cur, v_today) r
  ),
  m AS MATERIALIZED (
    SELECT s.*,
           pt.full_name AS patient_name,
           du.full_name AS doctor_name,
           (s.created_at AT TIME ZONE 'Europe/Istanbul')::date AS created_on,
           CASE WHEN s.currency = 'TRY' THEN s.remaining_cents
                WHEN rt.rate IS NULL THEN NULL
                ELSE round(s.remaining_cents * rt.rate)::bigint END AS est_try_cents
    FROM public.pp__plans_state(v_clinic) s
    LEFT JOIN public.patients pt ON pt.clinic_id = v_clinic AND pt.id = s.patient_id
    LEFT JOIN public.doctors d ON d.clinic_id = v_clinic AND d.id = s.doctor_id
    LEFT JOIN public.users du ON du.id = d.user_id
    LEFT JOIN rt ON rt.cur = s.currency
    WHERE CASE v_status
            WHEN 'open' THEN s.status NOT IN ('completed', 'cancelled')
            WHEN 'active' THEN s.status <> 'cancelled'
            WHEN 'cancelled' THEN s.status = 'cancelled'
            ELSE true
          END
      AND (NOT v_only OR v_status = 'cancelled' OR s.remaining_cents > 0)
      AND (v_cur IS NULL OR s.currency = v_cur)
      AND (v_query IS NULL
           OR strpos(public.fin__tr_lower(coalesce(pt.full_name, '') || ' ' || coalesce(s.title, '')),
                     public.fin__tr_lower(v_query)) > 0)
      AND (v_from IS NULL OR (s.created_at AT TIME ZONE 'Europe/Istanbul')::date >= v_from)
      AND (v_to IS NULL OR (s.created_at AT TIME ZONE 'Europe/Istanbul')::date < v_to)
  ),
  ordered AS (
    SELECT m.*,
           row_number() OVER (
             ORDER BY CASE WHEN v_sort = 'remaining_try_desc' THEN m.est_try_cents END DESC NULLS LAST,
                      CASE WHEN v_sort = 'last_payment_desc' THEN m.last_paid_on END DESC NULLS LAST,
                      m.created_at DESC, m.plan_id) AS rn
    FROM m
  )
  SELECT jsonb_build_object(
    'today', v_today,
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'plan_id', o.plan_id, 'plan_title', o.title, 'patient_id', o.patient_id,
               'patient_name', o.patient_name, 'doctor_name', o.doctor_name, 'status', o.status,
               'created_on', o.created_on, 'currency', o.currency, 'total_cents', o.total_cents,
               'quote_fx_rate', public.pp__rate_text(o.quote_fx_rate),
               'quote_total_try_cents', o.quote_total_try_cents, 'applied_cents', o.applied_cents,
               'remaining_cents', o.remaining_cents, 'collected_try_cents', o.collected_try_cents,
               'remaining_try_estimate_cents', o.est_try_cents, 'last_paid_on', o.last_paid_on)
             ORDER BY o.rn)
      FROM ordered o
      WHERE o.rn > v_offset AND o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total_count', (SELECT count(*) FROM m),
    'offset', v_offset,
    'limit', v_limit,
    'totals', jsonb_build_object(
      'count', (SELECT count(*) FROM m),
      'by_currency', coalesce((
        SELECT jsonb_agg(jsonb_build_object('currency', x.currency, 'total_cents', x.total_cents,
                                            'applied_cents', x.applied_cents, 'remaining_cents', x.remaining_cents,
                                            'quote_try_cents', x.quote_try_cents)
                         ORDER BY (x.currency <> 'TRY'), x.currency)
        FROM (SELECT m.currency, sum(m.total_cents)::bigint AS total_cents, sum(m.applied_cents)::bigint AS applied_cents,
                     sum(m.remaining_cents)::bigint AS remaining_cents,
                     sum(m.quote_total_try_cents)::bigint AS quote_try_cents
              FROM m GROUP BY m.currency) x), '[]'::jsonb),
      'quote_try_cents', (SELECT coalesce(sum(m.quote_total_try_cents), 0)::bigint FROM m),
      'collected_try_cents', (SELECT coalesce(sum(m.collected_try_cents), 0)::bigint FROM m),
      'remaining_try_estimate_cents',
        CASE WHEN EXISTS (SELECT 1 FROM m WHERE m.est_try_cents IS NULL AND m.remaining_cents <> 0) THEN NULL
             ELSE (SELECT coalesce(sum(m.est_try_cents), 0)::bigint FROM m) END,
      'rates', coalesce((
        SELECT jsonb_agg(jsonb_build_object('currency', rt.cur, 'rate', public.pp__rate_text(rt.rate),
                                            'rate_on', rt.rate_on) ORDER BY rt.cur)
        FROM rt), '[]'::jsonb),
      'missing_rates', coalesce((
        SELECT jsonb_agg(DISTINCT m.currency)
        FROM m WHERE m.currency <> 'TRY' AND m.est_try_cents IS NULL AND m.remaining_cents <> 0), '[]'::jsonb)))
    INTO v_result;

  RETURN v_result;
END;
$$;

-- §5.8 DentOS patient payments vs the ledger's patient receipts, per Istanbul business day of one month.
-- Informational and read-only: DentOS payments never reach fin_entries / fin_payments (owner decision 1).
-- Ledger side = the 0020 month figure base (fin__live_payments, bucket patient_receipts, not excluded).
CREATE OR REPLACE FUNCTION public.fin_patient_receipts_compare(p_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_today date := public.clinic_today();
  v_m0 date;
  v_m1 date;
  v_result jsonb;
BEGIN
  v_m0 := public.fin__report_month(p_month, v_today);
  v_m1 := (v_m0 + interval '1 month')::date;

  WITH d AS MATERIALIZED (
    SELECT p.paid_on AS day, p.currency, p.payment_method AS method, p.amount_cents, p.amount_try_cents
    FROM public.payments p
    WHERE p.clinic_id = v_clinic
      AND p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0
      AND p.paid_on >= v_m0 AND p.paid_on < v_m1
  ),
  l AS MATERIALIZED (
    SELECT lp.paid_on AS day, lp.amount_cents, coalesce(e.source_key LIKE 'clinic:%', false) AS workbook
    FROM public.fin__live_payments(v_clinic, v_today) lp
    JOIN public.fin_entries e ON e.clinic_id = v_clinic AND e.id = lp.entry_id
    WHERE lp.report_bucket = 'patient_receipts'
      AND NOT lp.excluded_from_totals
      AND lp.paid_on >= v_m0 AND lp.paid_on < v_m1
  ),
  days AS MATERIALIZED (
    SELECT x.day,
           (SELECT coalesce(sum(d.amount_try_cents), 0)::bigint FROM d WHERE d.day = x.day) AS dentos_try_cents,
           (SELECT count(*) FROM d WHERE d.day = x.day) AS dentos_count,
           (SELECT coalesce(sum(l.amount_cents), 0)::bigint FROM l WHERE l.day = x.day) AS ledger_cents,
           (SELECT coalesce(sum(l.amount_cents), 0)::bigint FROM l WHERE l.day = x.day AND l.workbook)
             AS ledger_workbook_cents
    FROM (SELECT d.day FROM d UNION SELECT l.day FROM l) x
  ),
  shown AS MATERIALIZED (
    SELECT days.*,
           days.ledger_cents - days.dentos_try_cents AS diff_cents,
           abs(days.ledger_cents - days.dentos_try_cents) > 100 AS flag
    FROM days
    WHERE days.dentos_try_cents <> 0 OR days.ledger_cents <> 0
  )
  SELECT jsonb_build_object(
    'month', to_char(v_m0, 'YYYY-MM'),
    'today', v_today,
    'days', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'day', s.day,
               'dentos_try_cents', s.dentos_try_cents,
               'dentos_count', s.dentos_count,
               'dentos_by_currency', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('currency', y.currency, 'amount_cents', y.amount_cents)
                                  ORDER BY (y.currency <> 'TRY'), y.currency)
                 FROM (SELECT d.currency, sum(d.amount_cents)::bigint AS amount_cents
                       FROM d WHERE d.day = s.day GROUP BY d.currency) y), '[]'::jsonb),
               'dentos_by_method', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('method', y.method, 'try_cents', y.try_cents)
                                  ORDER BY y.method NULLS LAST)
                 FROM (SELECT d.method, sum(d.amount_try_cents)::bigint AS try_cents
                       FROM d WHERE d.day = s.day GROUP BY d.method) y), '[]'::jsonb),
               'ledger_cents', s.ledger_cents,
               'ledger_workbook_cents', s.ledger_workbook_cents,
               'ledger_other_cents', s.ledger_cents - s.ledger_workbook_cents,
               'diff_cents', s.diff_cents,
               'flag', s.flag)
             ORDER BY s.day)
      FROM shown s), '[]'::jsonb),
    'totals', jsonb_build_object(
      'dentos_try_cents', (SELECT coalesce(sum(d.amount_try_cents), 0)::bigint FROM d),
      'dentos_count', (SELECT count(*) FROM d),
      'dentos_by_currency', coalesce((
        SELECT jsonb_agg(jsonb_build_object('currency', y.currency, 'amount_cents', y.amount_cents,
                                            'try_cents', y.try_cents)
                         ORDER BY (y.currency <> 'TRY'), y.currency)
        FROM (SELECT d.currency, sum(d.amount_cents)::bigint AS amount_cents,
                     sum(d.amount_try_cents)::bigint AS try_cents
              FROM d GROUP BY d.currency) y), '[]'::jsonb),
      'dentos_by_method', coalesce((
        SELECT jsonb_agg(jsonb_build_object('method', y.method, 'try_cents', y.try_cents) ORDER BY y.method NULLS LAST)
        FROM (SELECT d.method, sum(d.amount_try_cents)::bigint AS try_cents FROM d GROUP BY d.method) y), '[]'::jsonb),
      'ledger_cents', (SELECT coalesce(sum(l.amount_cents), 0)::bigint FROM l),
      'ledger_workbook_cents', (SELECT coalesce(sum(l.amount_cents), 0)::bigint FROM l WHERE l.workbook),
      'ledger_other_cents', (SELECT coalesce(sum(l.amount_cents), 0)::bigint FROM l WHERE NOT l.workbook),
      'diff_cents', (SELECT coalesce(sum(l.amount_cents), 0)::bigint FROM l)
                    - (SELECT coalesce(sum(d.amount_try_cents), 0)::bigint FROM d),
      'flagged_days', (SELECT count(*) FROM shown WHERE shown.flag)))
    INTO v_result;

  RETURN v_result;
END;
$$;

-- §5.10 Rate history, newest rate_on first, optionally one currency, paged (fin__page).
CREATE OR REPLACE FUNCTION public.fin_fx_history(p_currency text, p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_read();
  v_cur text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_offset integer;
  v_limit integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_cur IS NOT NULL AND v_cur NOT IN ('EUR', 'USD', 'GBP') THEN
    PERFORM public.pp__raise('E_FILTER');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.fin__page(p_page) pg;

  SELECT count(*) INTO v_total
  FROM public.fx_rates r
  WHERE r.clinic_id = v_clinic AND (v_cur IS NULL OR r.currency = v_cur);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'currency', x.currency, 'rate', public.pp__rate_text(x.rate), 'rate_on', x.rate_on,
           'source', x.source, 'source_file', x.source_file, 'note', x.note,
           'updated_by_name', public.fin__user_name(x.updated_by), 'updated_at', x.updated_at)
         ORDER BY x.rate_on DESC, x.currency, x.source, x.id), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT r.*
    FROM public.fx_rates r
    WHERE r.clinic_id = v_clinic AND (v_cur IS NULL OR r.currency = v_cur)
    ORDER BY r.rate_on DESC, r.currency, r.source, r.id
    OFFSET v_offset
    LIMIT v_limit
  ) x;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'total_count', v_total,
                            'offset', v_offset, 'limit', v_limit);
END;
$$;

-- ---------------------------------------------------------------------------
-- §5.9 crm_source_report (0021): same signature and body; only the collections sub-select changes so it sums the
--      TL amount of counted payments (it added foreign amounts as TL and counted voided rows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_source_report(p_from_month text, p_to_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.crm__require_staff();
  v_money boolean := public.crm__can_read_money();
  v_from date;
  v_to date;
  v_result jsonb;
BEGIN
  IF p_from_month IS NOT NULL AND btrim(p_from_month) <> '' THEN
    v_from := public.crm__month(p_from_month, 'E_FILTER');
  END IF;
  IF p_to_month IS NOT NULL AND btrim(p_to_month) <> '' THEN
    v_to := public.crm__month(p_to_month, 'E_FILTER');
  END IF;
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_from > v_to THEN
    PERFORM public.crm__raise('E_FILTER');
  END IF;

  WITH pop AS MATERIALIZED (
    SELECT l.id, l.source, l.stage, l.loss_reason, l.patient_id
    FROM public.leads l
    WHERE l.clinic_id = v_clinic AND l.deleted_at IS NULL AND l.stage <> 'archived'
      AND (v_from IS NULL OR date_trunc('month', l.created_at AT TIME ZONE 'Europe/Istanbul')::date >= v_from)
      AND (v_to IS NULL OR date_trunc('month', l.created_at AT TIME ZONE 'Europe/Istanbul')::date <= v_to)
  ),
  srcs AS (
    SELECT x.source, x.ord
    FROM unnest(ARRAY['instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other'])
         WITH ORDINALITY AS x(source, ord)
    UNION ALL
    SELECT DISTINCT pop.source, 100::bigint
    FROM pop
    WHERE pop.source IS NULL
       OR pop.source NOT IN ('instagram_meta', 'google', 'whatsapp', 'phone_call', 'referral', 'walk_in', 'other')
  ),
  bs AS (
    SELECT s.source, s.ord,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source) AS leads,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source
              AND pop.stage IN ('appointment_booked', 'appointment_attended', 'offer_given', 'treatment_started',
                                'treatment_completed')) AS booked,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source
              AND pop.stage IN ('treatment_started', 'treatment_completed')) AS won,
           (SELECT count(*) FROM pop WHERE pop.source IS NOT DISTINCT FROM s.source AND pop.stage = 'lost') AS lost
    FROM srcs s
  ),
  mny AS (
    SELECT bs.source,
           CASE WHEN v_money THEN (
             SELECT coalesce(sum(p.amount_try_cents), 0)::bigint
             FROM public.payments p
             WHERE p.clinic_id = v_clinic AND p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0
               AND p.patient_id IN (SELECT DISTINCT pop.patient_id FROM pop
                                    WHERE pop.source IS NOT DISTINCT FROM bs.source AND pop.patient_id IS NOT NULL)
           ) END AS collections_cents,
           CASE WHEN v_money THEN coalesce((
             SELECT jsonb_agg(jsonb_build_object('currency', a.currency, 'amount_cents', a.total) ORDER BY a.currency)
             FROM (SELECT sp.currency, sum(sp.amount_cents)::bigint AS total
                   FROM public.crm_ad_spend sp
                   WHERE sp.clinic_id = v_clinic AND sp.source = bs.source
                     AND (v_from IS NULL OR sp.month >= v_from) AND (v_to IS NULL OR sp.month <= v_to)
                   GROUP BY sp.currency) a), '[]'::jsonb) END AS ad_spend,
           CASE WHEN v_money THEN (
             SELECT sum(sp.amount_cents)
             FROM public.crm_ad_spend sp
             WHERE sp.clinic_id = v_clinic AND sp.source = bs.source AND sp.currency = 'TRY'
               AND (v_from IS NULL OR sp.month >= v_from) AND (v_to IS NULL OR sp.month <= v_to)
           ) END AS try_spend
    FROM bs
  )
  SELECT jsonb_build_object(
    'from_month', to_char(v_from, 'YYYY-MM'),
    'to_month', to_char(v_to, 'YYYY-MM'),
    'money_visible', v_money,
    'totals', (SELECT jsonb_build_object(
                 'leads', count(*),
                 'booked', count(*) FILTER (WHERE pop.stage IN ('appointment_booked', 'appointment_attended',
                                              'offer_given', 'treatment_started', 'treatment_completed')),
                 'won', count(*) FILTER (WHERE pop.stage IN ('treatment_started', 'treatment_completed')),
                 'lost', count(*) FILTER (WHERE pop.stage = 'lost'))
               FROM pop),
    'by_source', coalesce((
      SELECT jsonb_agg(
               jsonb_build_object('source', bs.source, 'leads', bs.leads, 'booked', bs.booked, 'won', bs.won,
                                  'lost', bs.lost)
               || CASE WHEN v_money THEN jsonb_build_object(
                    'collections_cents', m.collections_cents,
                    'ad_spend', m.ad_spend,
                    'multiplier', CASE WHEN coalesce(m.try_spend, 0) > 0
                                       THEN round(m.collections_cents::numeric / m.try_spend, 2) END)
                  ELSE '{}'::jsonb END
               ORDER BY bs.ord, bs.source NULLS LAST)
      FROM bs JOIN mny m ON m.source IS NOT DISTINCT FROM bs.source), '[]'::jsonb),
    'loss_reasons', coalesce((
      SELECT jsonb_agg(jsonb_build_object('loss_reason', x.loss_reason, 'count', x.n) ORDER BY x.n DESC, x.loss_reason)
      FROM (SELECT pop.loss_reason, count(*) AS n FROM pop WHERE pop.stage = 'lost' GROUP BY pop.loss_reason) x),
      '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2.6 Function privileges and self-checks (0020 / 0021 pattern). Runs as the migration owner; never granted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pp__harden_privileges()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_public text[] := ARRAY['pp_record_payment', 'pp_void_payment', 'pp_fx_rates', 'pp_fx_save_rates',
                           'pp_plan_account', 'pp_patient_account', 'pp_can_void'];
  v_f record;
  v_bad text;
BEGIN
  FOR v_f IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'pp\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_f.sig);
    IF v_f.proname = ANY (v_public) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_f.sig);
    END IF;
  END LOOP;

  -- Every public RPC exists; no other single-underscore pp_ function exists.
  SELECT string_agg(x.fn, ', ') INTO v_bad
  FROM unnest(v_public) AS x(fn)
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = x.fn);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'pp_* fonksiyonları eksik: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'pp\_%' AND p.proname NOT LIKE 'pp\_\_%'
    AND NOT (p.proname = ANY (v_public));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Listede olmayan pp_* fonksiyonu: %', v_bad;
  END IF;

  -- No overloads.
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'pp\_%'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'pp_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- Every public RPC is SECURITY DEFINER with search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY (v_public)
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  -- Internal helpers fail closed: only trigger functions may be SECURITY DEFINER.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'pp\_\_%'
    AND p.prosecdef AND p.prorettype <> 'trigger'::regtype;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar SECURITY DEFINER olmamalı: %', v_bad;
  END IF;

  -- No internal helper is callable from the API, and anon can call nothing.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'pp\_%'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR (p.proname LIKE 'pp\_\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar API''ye açık: %', v_bad;
  END IF;

  -- payments and fx_rates: RLS on, SELECT only for authenticated (no table or column write privilege), nothing
  -- for anon.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['payments', 'fx_rates']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR has_table_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_any_column_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE')
     OR has_table_privilege('anon', format('public.%I', t.tbl), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', t.tbl), 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Tablo yetkileri beklenen gibi değil: %', v_bad;
  END IF;
END;
$$;

SELECT public.pp__harden_privileges();
SELECT public.fin__harden_privileges();
SELECT public.crm__harden_privileges();

-- Migration-specific self-checks. Any failure RAISEs and rolls the whole migration back.
DO $$
DECLARE
  v_bad text;
  v_sum numeric;
  v_rows bigint;
BEGIN
  -- 1. Money unchanged: TL total of counting rows equals the pre-migration total; no row added or lost.
  SELECT coalesce(sum(p.amount_try_cents), 0) INTO v_sum
  FROM public.payments p
  WHERE p.status = 'paid' AND p.voided_at IS NULL AND p.amount > 0;
  IF v_sum IS DISTINCT FROM current_setting('pp.mig_try_sum')::numeric THEN
    RAISE EXCEPTION 'Öz denetim: tahsilat TL toplamı değişti (% -> %).', current_setting('pp.mig_try_sum'), v_sum;
  END IF;
  SELECT count(*) INTO v_rows FROM public.payments;
  IF v_rows IS DISTINCT FROM current_setting('pp.mig_rows')::bigint THEN
    RAISE EXCEPTION 'Öz denetim: ödeme satır sayısı değişti (% -> %).', current_setting('pp.mig_rows'), v_rows;
  END IF;

  -- 2. Backfill complete.
  SELECT count(*) INTO v_rows FROM public.payments
  WHERE amount_try_cents IS NULL OR plan_currency IS NULL OR applied_plan_cents IS NULL OR paid_on IS NULL;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'Öz denetim: % ödeme satırında yeni sütunlar boş.', v_rows;
  END IF;

  -- 3. Triggers present and enabled; the 0019 insert guard trigger is gone.
  SELECT string_agg(format('%s.%s', e.tbl, e.tg), ', ') INTO v_bad
  FROM (VALUES
    ('payments', 'pp_payment_guard'), ('payments', 'pp_no_delete'), ('payments', 'pp_no_truncate'),
    ('payments', 'audit_row_change'), ('fx_rates', 'pp_no_delete'), ('fx_rates', 'pp_no_truncate'),
    ('fx_rates', 'pp_touch'), ('fx_rates', 'audit_row_change'), ('treatment_plans', 'pp_plan_money'),
    ('treatment_plans', 'audit_row_change')
  ) AS e(tbl, tg)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = format('public.%I', e.tbl)::regclass AND t.tgname = e.tg AND t.tgenabled <> 'D'
  );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: eksik veya kapalı tetikleyiciler: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.payments'::regclass
             AND tgname = 'payments_insert_guard') THEN
    RAISE EXCEPTION 'Öz denetim: payments_insert_guard tetikleyicisi hâlâ var.';
  END IF;

  -- 4. Policies: exactly one SELECT policy on payments and on fx_rates, no write policy.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['payments', 'fx_rates']) AS t(tbl)
  WHERE (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd <> 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: RLS politika yapısı beklenen gibi değil: %', v_bad;
  END IF;

  -- 5. Golden values of the money math (acceptance A07 and the worked example of §3).
  SELECT string_agg(g.label, ', ') INTO v_bad
  FROM (VALUES
    ('A07 11,00x1,005', public.pp__try_cents(1100, 1.005), 1106::bigint),
    ('A07 25,00x1,015', public.pp__try_cents(2500, 1.015), 2538::bigint),
    ('A07 USD try', public.pp__try_cents(10000, 45.123456), 451235::bigint),
    ('A07 USD applied', public.pp__applied_cents(451235, 49.5), 9116::bigint),
    ('A07 sınır', public.pp__applied_cents(500999998999, 999.999999), 500999999::bigint),
    ('A07 yarım', public.pp__applied_cents(25, 50), 1::bigint),
    ('§3 EUR 300x49', public.pp__try_cents(30000, 49), 1470000::bigint),
    ('§3 TRY 10000/50', public.pp__applied_cents(1000000, 50), 20000::bigint),
    ('§3 kalan 500x50', public.pp__try_cents(50000, 50), 2500000::bigint)
  ) AS g(label, got, expected)
  WHERE g.got IS DISTINCT FROM g.expected;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: tutar hesapları: %', v_bad;
  END IF;

  SELECT string_agg(format('%s -> %s', g.c, public.pp__money_text(g.c, g.cur)), '; ') INTO v_bad
  FROM (VALUES
    (123456::bigint, 'EUR', '1.234,56 EUR'),
    (50000::bigint, 'EUR', '500,00 EUR'),
    (1000000::bigint, 'TRY', '10.000,00 TRY'),
    (5::bigint, 'TRY', '0,05 TRY'),
    (100000000000::bigint, 'USD', '1.000.000.000,00 USD'),
    (-2550::bigint, 'GBP', '-25,50 GBP')
  ) AS g(c, cur, expected)
  WHERE public.pp__money_text(g.c, g.cur) IS DISTINCT FROM g.expected;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: tutar metni: %', v_bad;
  END IF;

  IF public.pp__rate_text(49) <> '49.000000' OR public.pp__rate_text(1) <> '1.000000'
     OR public.pp__rate_text(45.123456) <> '45.123456' THEN
    RAISE EXCEPTION 'Öz denetim: kur metni hatalı.';
  END IF;
END $$;

-- 6. Worked example of §3 replayed on real tables inside a block that is always rolled back (SQL editor writes,
--    so the guard triggers are bypassed and the CHECK constraints alone must accept the rows). Uses the first
--    existing plan's clinic, patient and doctor; skipped when there is none. Dated 2000-01-03 so live rates
--    never interfere with the lookup.
DO $$
DECLARE
  v_src record;
  v_fx uuid := gen_random_uuid();
  v_plan uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_day date := DATE '2000-01-03';
  s record;
  v_j jsonb;
BEGIN
  SELECT tp.clinic_id, tp.patient_id, tp.doctor_id INTO v_src
  FROM public.treatment_plans tp ORDER BY tp.created_at, tp.id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.fx_rates (id, clinic_id, currency, rate, rate_on, source, note)
    VALUES (v_fx, v_src.clinic_id, 'EUR', 48, v_day, 'manual', 'Öz denetim');

    INSERT INTO public.treatment_plans (id, clinic_id, patient_id, doctor_id, title, total_cost, status, currency,
                                        quote_fx_rate, quote_fx_on, quote_fx_source, quote_fx_rate_id)
    VALUES (v_plan, v_src.clinic_id, v_src.patient_id, v_src.doctor_id, 'Öz denetim planı', 1000, 'approved', 'EUR',
            48, v_day, 'manual', v_fx);

    INSERT INTO public.payments (id, clinic_id, treatment_plan_id, patient_id, amount, status, payment_method,
                                 paid_at, paid_on, currency, fx_rate, fx_rate_source, amount_try_cents, plan_currency,
                                 plan_fx_rate, plan_fx_rate_source, applied_plan_cents)
    VALUES (v_p1, v_src.clinic_id, v_plan, v_src.patient_id, 300.00, 'paid', 'cash', now(), v_day, 'EUR', 49,
            'entered', 1470000, 'EUR', 49, 'entered', 30000),
           (v_p2, v_src.clinic_id, v_plan, v_src.patient_id, 10000.00, 'paid', 'card', now(), v_day, 'TRY', 1,
            'none', 1000000, 'EUR', 50, 'entered', 20000);

    SELECT * INTO s FROM public.pp__plan_state(v_src.clinic_id, v_plan);
    IF s.quote_total_try_cents <> 4800000 OR s.applied_cents <> 50000 OR s.remaining_cents <> 50000
       OR s.collected_try_cents <> 2470000 OR s.counted_count <> 2 THEN
      RAISE EXCEPTION 'Öz denetim: örnek plan hesapları hatalı: %', to_jsonb(s);
    END IF;

    v_j := public.pp__plan_totals_json(v_src.clinic_id, v_plan, v_day);
    IF (v_j -> 'remaining_try_estimate' ->> 'cents')::bigint IS DISTINCT FROM 2400000
       OR v_j -> 'remaining_try_estimate' ->> 'rate' IS DISTINCT FROM '48.000000'
       OR jsonb_array_length(v_j -> 'by_currency') <> 2 THEN
      RAISE EXCEPTION 'Öz denetim: örnek plan özeti hatalı: %', v_j;
    END IF;

    -- A voided payment no longer counts.
    UPDATE public.payments SET voided_at = now(), void_reason = 'Öz denetim iptali' WHERE id = v_p1;
    SELECT * INTO s FROM public.pp__plan_state(v_src.clinic_id, v_plan);
    IF s.applied_cents <> 20000 OR s.collected_try_cents <> 1000000 OR s.voided_count <> 1 THEN
      RAISE EXCEPTION 'Öz denetim: iptal sonrası hesaplar hatalı: %', to_jsonb(s);
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'pp_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;
END $$;

-- Make the API see the new table, columns and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
