-- Finance import: payments settle the open debts they pay (owner decision 2026-10-21). Future payables entered by
-- hand (lab invoices, the SGK premium, withholding tax) feed the cash projection; when the payment later arrives
-- through "Dosyadan aktar" (bank statement or the clinic workbook) it must settle that debt instead of becoming a
-- second expense. The review now gets the open-debt candidates of every eligible outflow in one call and pre-selects
-- a strong match, a clinic workbook expense row (paid in cash or by bank) can settle a debt like a bank row, a
-- payment slightly below the debt can close the rest of it in the same save, and a row saved as a new expense next to
-- a matching open debt needs an explicit per-row confirmation, enforced here. Safe to re-run.
--
-- Contract: spec_debt_automatch.md on top of 0036_doctor_scope.sql (0001 – 0036 are applied and live; none is
-- edited). fin_import_check and fin_import_rows are copied from their latest definition (0022) with only the changes
-- below and keep their signatures (fin__harden_privileges refuses overloads). fin__debt_candidates and
-- fin_debt_candidates (the full list behind "Açık borçları göster") are not changed.
--
--  * No names or amounts of the clinic in this file; the self-checks use made-up ones.
--  * Amount rule (fin__debt_kind, new internal): payment A against a debt's outstanding O: 'exact' A = O; 'near'
--    A < O and O − A ≤ min(2 % of O, 1.000,00 TL); 'partial' A < O by more; 'higher' A > O and A − O ≤ min(2 % of O,
--    1.000,00 TL) (a near miss: never matchable, the payment would overpay the debt); NULL otherwise.
--  * Open debts (fin__debt_open_entries, new internal): the candidate set of fin__debt_candidates: 'out' entries of
--    the clinic, not cancelled, outstanding > 0, never a patient financing fee entry. The clinic is always the
--    caller's (another clinic's debts are never read).
--  * Strong candidate of a row: exact or near, |row date − due date| ≤ 45 days, the entry not excluded from totals,
--    and one of: every name token of the debt's person / institution in the row text (the fin__debt_candidates rule),
--    the debt's counterparty master = the row's counterparty_id, the debt's category = the row's category_id.
--    Pre-selection (fin_debt_candidates_batch): a row with exactly one strong candidate gets it, unless the debt is
--    also the only strong candidate of other rows of the call: then the row with the closest |date − due date| wins,
--    exact before near; a tie that remains pre-selects the debt for none of them (the user chooses; the open-debt
--    confirmation below still applies).
--  * Open-debt confirmation (fin__open_debts, new internal; the same rule in fin_import_check and fin_import_rows):
--    an unsaved outflow row that is a bank row ('bank:' / 'bank-table:', direction 'out') or a clinic workbook expense
--    row ('clinic:<day>:expense:<n>'; never ':receipts'), sent as a NEW entry, while an open debt is exact or near for
--    it within 45 days of its due date (any category, any name, excluded entries included). A matched row never needs
--    the confirmation. A debt that rows of the same request match (match / match_entry_id) counts for no row only when
--    nothing of it stays open: their payments reach its outstanding, or one of them closes the rest (close_remainder).
--    Otherwise the other rows are compared with what stays open after those payments, and that rest is the
--    outstanding the warning and the refusal name (a partial payment never hides the rest of the debt).
--  * fin_import_check: new warning code 'open_debt' (with the debts) on such rows whose status is new / match_voided /
--    id_taken (not on financing lines); the other codes and statuses are unchanged. Optional row keys match_entry_id
--    (the review's chosen debt of that row) and close_remainder (that row closes the rest of the debt), so the
--    preflight reports exactly what the save enforces.
--  * fin_import_rows: a match is accepted for clinic workbook expense rows as for bank rows: the payment is written on
--    the debt with the row's account (cash or the bank-paid account; bank rows still need a bank / POS account), the
--    row date, bank_source_key / bank_source_file / bank_source_description = the row's key / file / description, and
--    the key is bound to that payment (fin_import_sources link_kind 'payment_match', source_kind 'clinic_excel'), so a
--    re-import shows matched_same / skipped_matched. Version check, one row per debt, no overpayment and the financing
--    exclusion are unchanged. New row flags close_remainder and ack_open_debt (below). acknowledged counts a row
--    whose open-debt confirmation was given as well.
--  * close_remainder: with a match and a payment below the debt's outstanding, the rest of the debt is cancelled in
--    the same save exactly like fin_cancel_entry ('Kalan planı iptal et': cancelled_at / cancelled_by /
--    cancel_reason, audited by audit_row_change), reason 'Aktarımda kalan kapatıldı (<file> · satır <row_no>)'
--    (<file> 'Dosya' when the row has none). Refused without a match or when the payment equals the outstanding.
--  * fin_import_sources_link (same name, re-created): a payment_match may also have source_kind 'clinic_excel' with an
--    expense key; daily receipts keys still never.
--
-- Error contract (as 0020 / 0022): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400); per-row import errors are '<file> · <YYYY-MM-DD> · <n>. seçili satır: <text>' with DETAIL =
-- {row_no, key, ...}. New texts:
--   fin_debt_candidates_batch: 'Borç önerisi için en az 1, en fazla 500 satır gönderilebilir.' / 'Filtre değerleri
--     geçersiz.' (P0001); no finance write permission: 'Bu işlem için finans yetkisi gerekir.' (42501).
--   fin_import_check: a match_entry_id that is not a uuid or a close_remainder that is not a boolean: 'Filtre
--     değerleri geçersiz.' (P0001).
--   fin_import_rows (per row): 'Aynı veya yakın tutarda açık borç var: <kişi / kurum> · vade <GG.AA.YYYY> · kalan
--     <1.234,56 TL>. Satırı bu borca eşleştirin veya yeni gider olarak kaydetmeyi onaylayın (ödeme iki kez sayılır).
--     Hiçbir kayıt aktarılmadı.' (PT409, DETAIL + {warning: 'open_debt', entry_id}); 'Kalan borcu kapatma yalnızca
--     mevcut borca eşleştirilen satırda seçilebilir. Hiçbir kayıt aktarılmadı.' (P0001); 'Ödeme borcun kalanını
--     tamamen kapatıyor; kalan borç kapatma seçilemez. Hiçbir kayıt aktarılmadı.' (P0001); 'Klinik Excel dosyasında
--     yalnızca gider satırları açık borca eşleştirilebilir. Hiçbir kayıt aktarılmadı.' (P0001); a close_remainder /
--     ack_open_debt that is not a boolean: the usual 'alan geçersiz. ...' (P0001).
--
-- Payload contract (days 'YYYY-MM-DD', amounts integer cents):
--   fin_debt_candidates_batch(p_rows jsonb) (finance write permission; reads only): 1..500 objects
--     {row_no: 1..1000000 (unique), amount_cents: 1..1e12 (the payment, positive), date, text?: string ≤ 1000 | null
--     (the narration), category_id?: uuid | null (the row's classified category), counterparty_id?: uuid | null (the
--     row's chosen counterparty master)}; no other keys. The review sends every unsaved eligible outflow row.
--   fin_import_check p_rows[] + match_entry_id?: uuid | null + close_remainder?: boolean | null (absent = false; read
--     only with match_entry_id).
--   fin_import_rows p_rows[] + close_remainder?: boolean | null (absent = false; only with match) + ack_open_debt?:
--     boolean | null (absent = false; ignored on a matched row). A clinic workbook expense row may now carry match
--     {entry_id, version, payment_id} (then, as for bank rows, no entry_id / fingerprint / category_id / subcategory /
--     entitlement_month / counterparty_id / counterparty_text).
--
-- JSON shapes:
--   fin_debt_candidates_batch → {rows: [{row_no, preselect_entry_id: uuid | null, strong_count, total_count (the
--     matchable candidates before the limit), candidates: [Candidate] (≤ 5: strong first, then score, exact / near /
--     partial, closest due date, due date, created, id), higher: Candidate | null (the closest 'higher' near miss
--     within 45 days)}] in request order}.
--   Candidate = the fin_debt_candidates item {suggested, score, reason, entry: {id, version, counterparty_name,
--     description, category_name, report_bucket, due_date, amount_cents, outstanding_cents}} with suggested / score as
--     there (name match within 45 days; 100 name + 20 exact + 10 within 7 days; 0 / false for 'higher'), a new reason
--     text ('Tutar aynı' | 'Tutar yakın, kalan <TL>' | 'Kısmi ödeme' | 'Ödeme borçtan <TL> fazla', then
--     'kişi / kurum eşleşiyor' | 'aynı kişi / kurum', 'aynı kategori', 'vade günü' | 'vadeden <n> gün önce / sonra' |
--     'vade 45 günden uzak', 'toplam dışı kayıt', joined with ' · '), + {kind: 'exact' | 'near' | 'partial' |
--     'higher', strong, days (|row date − due date|), remainder_cents (outstanding − amount, ≥ 0), excess_cents
--     (amount − outstanding, ≥ 0)} and entry + {excluded_from_totals}.
--   fin_import_check rows[].warnings[] + {code: 'open_debt', debts: [{entry_id, version, counterparty_name,
--     category_name, due_date, amount_cents, outstanding_cents, kind: 'exact' | 'near', days}] (1..3: closest due
--     date first, exact before near, then due date, id; outstanding_cents and kind after the payments of the
--     request's partly matched rows, see above)}.
--   fin_import_rows rows[] + remainder_closed_cents (only on a row whose remainder was closed: the cancelled rest).
--
-- RUNBOOK (production is the only database):
--   1. 0036 is applied. SQL editor → New query → paste this file ALONE → Run. One transaction of a few seconds:
--      fin_import_sources is locked while its link constraint is re-created, so run it when nobody is saving an
--      import. The self-checks at the end (including a replay in two temporary clinics that is always rolled back)
--      undo everything on any failure.
--   2. Deploy the web build right after. Until then the old review keeps working, except that a row saved as a new
--      expense next to a matching open debt is refused with the open-debt message (the old build cannot send
--      ack_open_debt; match the row to the debt or deselect it), and the old review lists 'open_debt' as an
--      unknown warning.
--   Re-running 0022 later (documented there as safe to re-run) puts back the old fin_import_check / fin_import_rows:
--   re-run this file afterwards.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Re-run from 0022 the definitions of fin_import_check and fin_import_rows.
--   (b) DROP FUNCTION public.fin_debt_candidates_batch(jsonb), public.fin__open_debts(uuid, jsonb),
--       public.fin__debt_match(uuid, jsonb), public.fin__debt_open_entries(uuid), public.fin__debt_kind(bigint,
--       bigint);   (only after (a): the bodies of this file use them)
--   (c) SELECT public.fin__harden_privileges(); NOTIFY pgrst, 'reload schema';
--   (d) Data: nothing must be undone. Workbook rows matched to debts are ordinary payments with their import source
--       (the 0022 bodies read them as matched rows: matched_same / skipped_matched); closed remainders are ordinary
--       cancellations. Keep the re-created fin_import_sources_link while any source has source_kind 'clinic_excel'
--       and link_kind 'payment_match'; with none, the 0022 constraint may be put back (DROP CONSTRAINT
--       fin_import_sources_link, then ADD CONSTRAINT fin_import_sources_link CHECK ((link_kind = 'entry') OR
--       (link_kind = 'payment_match' AND payment_id IS NOT NULL AND source_kind IN ('bank_known', 'bank_table',
--       'migration')))).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preflight: 0036 live; the functions this file calls or replaces with their 0022 (0020 / 0030) signatures; the
--    replaced bodies are 0022's, or this file's on a re-run (which keep these texts); the 0022 link constraint.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regprocedure('public.clin_my_doctor_id()') IS NULL THEN
    RAISE EXCEPTION 'Önce 0036 uygulanmalı (clin_my_doctor_id bulunamadı).';
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.current_clinic_id()',
    'public.current_app_user_id()',
    'public.clinic_today()',
    'public.has_permission(text)',
    'public.fin__require_write()',
    'public.fin__harden_privileges()',
    'public.fin__entries_state(uuid)',
    'public.fin__match_text(text)',
    'public.fin__json_text(jsonb)',
    'public.fin__json_int(jsonb,bigint,bigint)',
    'public.fin__json_uuid(jsonb)',
    'public.fin__parse_day(text)',
    'public.fin__iso_date(date)',
    'public.fin__row_raise(text,text,text,jsonb)',
    'public.fin__row_field(text,text,jsonb)',
    'public.fin__reason(text)',
    'public.fin__paid(uuid)',
    'public.fin__hk_tl(bigint)',
    'public.fin__month_start(date)',
    'public.fin__import_id(uuid,text)',
    'public.fin__bump_entry(uuid,uuid)',
    'public.fin__debt_candidates(uuid,bigint,date,text)',
    'public.fin_debt_candidates(bigint,date,text,integer)',
    'public.fin_import_check(text,jsonb)',
    'public.fin_import_rows(jsonb,jsonb)',
    'public.fin_create_entry(uuid,uuid,text,uuid,text,text,date,bigint,text,boolean,uuid)',
    'public.fin_set_exclusion(uuid,integer,boolean,text)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Finans fonksiyonları beklenen imzada değil (0020, 0022 ve 0030 uygulanmalı): %', v_missing;
  END IF;

  SELECT string_agg(e.fn, ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_import_check', '%manual_receipt_overlap%'),
    ('fin_import_check', '%fin__receipt_reconciliation(v_clinic, v_month)%'),
    ('fin_import_rows', '%Aynı borca bu aktarımda tek banka satırı eşleştirin%'),
    ('fin_import_rows', '%fin__reconcile_receipts_month(v_clinic, v_month)%'),
    ('fin__debt_candidates', '%fin_patient_financing%'),
    ('fin_debt_candidates', '%total_count%')
  ) AS e(fn, pat)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = e.fn AND p.prosrc LIKE e.pat
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Şu fonksiyonlar 0022 sürümünde değil: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_entries', 'id'), ('fin_entries', 'clinic_id'), ('fin_entries', 'version'), ('fin_entries', 'cancelled_at'),
    ('fin_entries', 'cancelled_by'), ('fin_entries', 'cancel_reason'), ('fin_entries', 'excluded_from_totals'),
    ('fin_payments', 'bank_source_key'), ('fin_payments', 'bank_source_file'),
    ('fin_payments', 'bank_source_description'),
    ('fin_import_sources', 'source_key'), ('fin_import_sources', 'source_kind'), ('fin_import_sources', 'link_kind'),
    ('fin_import_sources', 'payment_id'), ('fin_patient_financing', 'entry_id')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı: %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conrelid = 'public.fin_import_sources'::regclass AND c.conname = 'fin_import_sources_link'
                   AND c.contype = 'c') THEN
    RAISE EXCEPTION 'fin_import_sources_link bulunamadı (0022 uygulanmalı).';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. fin_import_sources_link: a clinic workbook EXPENSE key may now be bound to the payment it made on an existing
--    debt (payment_match, bank_source_key = the key; checked by fin_import_source_consistent as for bank rows). Daily
--    receipts keys never. Re-created under its 0022 name; the existing rows are validated.
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_import_sources DROP CONSTRAINT IF EXISTS fin_import_sources_link;
ALTER TABLE public.fin_import_sources ADD CONSTRAINT fin_import_sources_link CHECK (
  (link_kind = 'entry')
  OR (link_kind = 'payment_match' AND payment_id IS NOT NULL
      AND (source_kind IN ('bank_known', 'bank_table', 'migration')
           OR (source_kind = 'clinic_excel' AND source_key ~ '^clinic:\d{4}-\d{2}-\d{2}:expense:[1-9]\d{0,4}$'))));

-- ---------------------------------------------------------------------------
-- 2. Internal helpers. Never granted; LANGUAGE sql without a SET clause, so they stay inlinable; only called from
--    SECURITY DEFINER functions; every name in them is schema-qualified.
-- ---------------------------------------------------------------------------

-- Amount rule of a payment against a debt's outstanding (see the header): 'exact' | 'near' | 'partial' | 'higher' |
-- NULL. The margin min(2 % of the outstanding, 1.000,00 TL) is compared without rounding ((O − A) × 50 ≤ O).
CREATE OR REPLACE FUNCTION public.fin__debt_kind(p_amount_cents bigint, p_outstanding_cents bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN p_amount_cents IS NULL OR p_outstanding_cents IS NULL OR p_amount_cents < 1 OR p_outstanding_cents < 1
             THEN NULL
           WHEN p_outstanding_cents = p_amount_cents THEN 'exact'
           WHEN p_outstanding_cents > p_amount_cents THEN
             CASE WHEN p_outstanding_cents - p_amount_cents <= 100000
                       AND (p_outstanding_cents - p_amount_cents) * 50 <= p_outstanding_cents
                  THEN 'near'
                  ELSE 'partial' END
           WHEN p_amount_cents - p_outstanding_cents <= 100000
                AND (p_amount_cents - p_outstanding_cents) * 50 <= p_outstanding_cents
             THEN 'higher'
         END
$$;

-- The open debts a payment may settle: the candidate set of fin__debt_candidates (open 'out' entries of the clinic,
-- not cancelled, outstanding > 0, never a patient financing fee entry), with the entry version a match must carry.
CREATE OR REPLACE FUNCTION public.fin__debt_open_entries(p_clinic uuid)
RETURNS TABLE (
  entry_id uuid,
  version integer,
  category_id uuid,
  counterparty_key text,
  counterparty_name text,
  description text,
  category_name text,
  report_bucket text,
  due_date date,
  amount_cents bigint,
  outstanding_cents bigint,
  excluded_from_totals boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.id,
         e.version,
         s.category_id,
         s.counterparty_key,
         s.counterparty_name,
         s.description,
         s.category_name,
         s.report_bucket,
         s.due_date,
         s.amount_cents,
         s.outstanding_cents,
         s.excluded_from_totals,
         s.created_at
  FROM public.fin__entries_state(p_clinic) s
  JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.id
  WHERE s.direction = 'out'
    AND s.cancelled_at IS NULL
    AND s.outstanding_cents > 0
    AND NOT EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = s.id)
$$;

-- Debt suggestions of a whole review batch in one ledger scan (fin_debt_candidates_batch). p_rows: the caller's
-- validated rows [{o, amount_cents, day, txt, category_id, counterparty_id}]. One row per (request row, open debt)
-- whose amount kind is exact / near / partial, or higher within 45 days of the due date; strong, suggested, score and
-- reason as described in the header.
CREATE OR REPLACE FUNCTION public.fin__debt_match(p_clinic uuid, p_rows jsonb)
RETURNS TABLE (
  o bigint,
  entry_id uuid,
  version integer,
  kind text,
  days integer,
  remainder_cents bigint,
  name_match boolean,
  same_counterparty boolean,
  same_category boolean,
  strong boolean,
  suggested boolean,
  score integer,
  reason text,
  counterparty_name text,
  description text,
  category_name text,
  report_bucket text,
  due_date date,
  amount_cents bigint,
  outstanding_cents bigint,
  excluded_from_totals boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH r AS (
    SELECT x.o, x.amount_cents, x.day, public.fin__match_text(coalesce(x.txt, '')) AS mtext, x.category_id,
           x.counterparty_id
    FROM pg_catalog.jsonb_to_recordset(
           CASE WHEN pg_catalog.jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END)
           AS x(o bigint, amount_cents bigint, day date, txt text, category_id uuid, counterparty_id uuid)
    WHERE x.o IS NOT NULL AND x.amount_cents > 0 AND x.day IS NOT NULL
  ),
  d AS (
    SELECT s.*,
           ARRAY(SELECT t.tok
                 FROM pg_catalog.regexp_split_to_table(public.fin__match_text(s.counterparty_name), ' ') AS t(tok)
                 WHERE pg_catalog.char_length(t.tok) >= 3 AND t.tok NOT IN ('banka', 'odeme', 'toplam')) AS toks
    FROM public.fin__debt_open_entries(p_clinic) s
  ),
  pr AS (
    SELECT r.o, r.amount_cents AS row_cents, r.mtext, r.category_id AS row_category,
           r.counterparty_id AS row_counterparty, r.day - d.due_date AS diff, d.*, k.kind
    FROM r
    CROSS JOIN d
    CROSS JOIN LATERAL (SELECT public.fin__debt_kind(r.amount_cents, d.outstanding_cents) AS kind) k
    WHERE k.kind IS NOT NULL
      AND (k.kind <> 'higher' OR pg_catalog.abs(r.day - d.due_date) <= 45)
  ),
  m AS (
    SELECT pr.*,
           pg_catalog.abs(pr.diff) AS days,
           (pg_catalog.cardinality(pr.toks) > 0
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(pr.toks) AS t(tok)
                            WHERE pg_catalog.strpos(pr.mtext, t.tok) = 0)) AS name_match,
           coalesce(pr.counterparty_key = 'id:' || pr.row_counterparty::text, false) AS same_counterparty,
           coalesce(pr.category_id = pr.row_category, false) AS same_category
    FROM pr
  )
  SELECT m.o,
         m.entry_id,
         m.version,
         m.kind,
         m.days,
         m.outstanding_cents - m.row_cents,
         m.name_match,
         m.same_counterparty,
         m.same_category,
         (m.kind IN ('exact', 'near') AND m.days <= 45 AND NOT m.excluded_from_totals
          AND (m.name_match OR m.same_counterparty OR m.same_category)),
         (m.kind <> 'higher' AND m.name_match AND m.days <= 45),
         (CASE WHEN m.kind = 'higher' THEN 0
               ELSE (CASE WHEN m.name_match THEN 100 ELSE 0 END)
                    + (CASE WHEN m.kind = 'exact' THEN 20 ELSE 0 END)
                    + (CASE WHEN m.days <= 7 THEN 10 ELSE 0 END) END)::integer,
         pg_catalog.concat_ws(' · ',
           CASE m.kind
             WHEN 'exact' THEN 'Tutar aynı'
             WHEN 'near' THEN 'Tutar yakın, kalan ' || public.fin__hk_tl(m.outstanding_cents - m.row_cents)
             WHEN 'partial' THEN 'Kısmi ödeme'
             ELSE 'Ödeme borçtan ' || public.fin__hk_tl(m.row_cents - m.outstanding_cents) || ' fazla'
           END,
           CASE WHEN m.name_match THEN 'kişi / kurum eşleşiyor'
                WHEN m.same_counterparty THEN 'aynı kişi / kurum' END,
           CASE WHEN m.same_category THEN 'aynı kategori' END,
           CASE WHEN m.diff = 0 THEN 'vade günü'
                WHEN m.days > 45 THEN 'vade 45 günden uzak'
                WHEN m.diff < 0 THEN 'vadeden ' || m.days::text || ' gün önce'
                ELSE 'vadeden ' || m.days::text || ' gün sonra' END,
           CASE WHEN m.excluded_from_totals THEN 'toplam dışı kayıt' END),
         m.counterparty_name,
         m.description,
         m.category_name,
         m.report_bucket,
         m.due_date,
         m.amount_cents,
         m.outstanding_cents,
         m.excluded_from_totals,
         m.created_at
  FROM m
$$;

-- Open-debt confirmation (owner decision 3), shared by fin_import_check and fin_import_rows so the preflight reports
-- exactly what the save enforces. p_rows: the raw request rows of either RPC (read leniently; malformed rows are
-- refused by the caller). Result: {'<ordinality>': [debt, ...]} for every eligible row with at least one open debt
-- that is exact or near for it within 45 days of the due date (see the header), at most 3 per row, the closest due
-- date first (exact before near, then due date, id). The rows of the request that match a debt ('match' of
-- fin_import_rows, 'match_entry_id' of fin_import_check) pay into it: when their payments reach its outstanding or
-- one of them closes the rest ('close_remainder'), the debt counts for no row; otherwise every other row is compared
-- with what stays open, which is also the outstanding reported. A matched row is never eligible.
CREATE OR REPLACE FUNCTION public.fin__open_debts(p_clinic uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT x.o, x.v
    FROM pg_catalog.jsonb_array_elements(
           CASE WHEN pg_catalog.jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END)
           WITH ORDINALITY AS x(v, o)
    WHERE pg_catalog.jsonb_typeof(x.v) = 'object'
  ),
  -- Per matched debt: the payments of the request on it and whether a row closes its rest.
  paid AS (
    SELECT y.entry_id,
           pg_catalog.sum(y.amount_cents)::bigint AS paid_cents,
           pg_catalog.bool_or(y.closes) AS closes
    FROM (
      SELECT coalesce(public.fin__json_uuid(q.v -> 'match' -> 'entry_id'),
                      public.fin__json_uuid(q.v -> 'match_entry_id')) AS entry_id,
             public.fin__json_int(q.v -> 'amount_cents', 1, 1000000000000) AS amount_cents,
             coalesce(q.v -> 'close_remainder', 'false'::jsonb) = 'true'::jsonb AS closes
      FROM q
    ) y
    WHERE y.entry_id IS NOT NULL
    GROUP BY y.entry_id
  ),
  -- The open debts as they stand after those payments; a debt with nothing left open drops out.
  d AS (
    SELECT e.entry_id, e.version, e.counterparty_name, e.category_name, e.due_date, e.amount_cents,
           e.outstanding_cents - coalesce(p.paid_cents, 0) AS outstanding_cents
    FROM public.fin__debt_open_entries(p_clinic) e
    LEFT JOIN paid p ON p.entry_id = e.entry_id
    WHERE NOT coalesce(p.closes, false)
      AND e.outstanding_cents > coalesce(p.paid_cents, 0)
  ),
  r AS (
    SELECT y.o, y.amount_cents, y.day
    FROM (
      SELECT q.o,
             public.fin__json_int(q.v -> 'amount_cents', 1, 1000000000000) AS amount_cents,
             public.fin__parse_day(public.fin__json_text(q.v -> 'date')) AS day,
             public.fin__json_text(q.v -> 'kind') AS kind,
             public.fin__json_text(q.v -> 'key') AS key,
             public.fin__json_text(q.v -> 'direction') AS direction,
             (coalesce(pg_catalog.jsonb_typeof(q.v -> 'match'), 'null') <> 'null'
              OR coalesce(pg_catalog.jsonb_typeof(q.v -> 'match_entry_id'), 'null') <> 'null') AS matched
      FROM q
    ) y
    WHERE NOT y.matched
      AND y.amount_cents IS NOT NULL
      AND y.day IS NOT NULL
      AND ((y.kind IN ('bank_known', 'bank_table') AND y.direction = 'out')
           OR (y.kind = 'clinic_excel' AND coalesce(y.key ~ '^clinic:\d{4}-\d{2}-\d{2}:expense:', false)
               AND coalesce(y.direction, 'out') = 'out'))
  ),
  h AS (
    SELECT r.o, d.entry_id, d.version, d.counterparty_name, d.category_name, d.due_date, d.amount_cents,
           d.outstanding_cents, k.kind, pg_catalog.abs(r.day - d.due_date) AS days,
           pg_catalog.row_number() OVER (
             PARTITION BY r.o
             ORDER BY pg_catalog.abs(r.day - d.due_date), CASE WHEN k.kind = 'exact' THEN 0 ELSE 1 END, d.due_date,
                      d.entry_id) AS rn
    FROM r
    JOIN d
      ON d.outstanding_cents BETWEEN r.amount_cents AND r.amount_cents + 100000
     AND d.due_date BETWEEN r.day - 45 AND r.day + 45
    CROSS JOIN LATERAL (SELECT public.fin__debt_kind(r.amount_cents, d.outstanding_cents) AS kind) k
    WHERE k.kind IN ('exact', 'near')
  )
  SELECT coalesce(pg_catalog.jsonb_object_agg(g.o::text, g.debts), '{}'::jsonb)
  FROM (
    SELECT h.o,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'entry_id', h.entry_id,
             'version', h.version,
             'counterparty_name', h.counterparty_name,
             'category_name', h.category_name,
             'due_date', h.due_date,
             'amount_cents', h.amount_cents,
             'outstanding_cents', h.outstanding_cents,
             'kind', h.kind,
             'days', h.days) ORDER BY h.rn) AS debts
    FROM h
    WHERE h.rn <= 3
    GROUP BY h.o
  ) g
$$;

-- ---------------------------------------------------------------------------
-- 3. fin_debt_candidates_batch (write permission; reads only): the review's automatic debt suggestions for every
--    eligible outflow row at once, with the pre-selection of section 2 and the 'higher' near miss (owner decisions
--    1, 2 and 6). fin_debt_candidates stays the full list of one row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_debt_candidates_batch(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_bad boolean;
  v_rows jsonb;
  v_out jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Borç önerisi için en az 1, en fazla 500 satır gönderilebilir.';
  END IF;
  IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Borç önerisi için en az 1, en fazla 500 satır gönderilebilir.';
  END IF;

  SELECT coalesce(bool_or(
           jsonb_typeof(q.v) <> 'object'
           OR EXISTS (SELECT 1
                      FROM jsonb_object_keys(CASE WHEN jsonb_typeof(q.v) = 'object' THEN q.v ELSE '{}'::jsonb END)
                             AS k(name)
                      WHERE k.name NOT IN ('row_no', 'amount_cents', 'date', 'text', 'category_id', 'counterparty_id'))
           OR public.fin__json_int(q.v -> 'row_no', 1, 1000000) IS NULL
           OR public.fin__json_int(q.v -> 'amount_cents', 1, 1000000000000) IS NULL
           OR public.fin__parse_day(public.fin__json_text(q.v -> 'date')) IS NULL
           OR coalesce(jsonb_typeof(q.v -> 'text'), 'null') NOT IN ('null', 'string')
           OR char_length(coalesce(public.fin__json_text(q.v -> 'text'), '')) > 1000
           OR (coalesce(jsonb_typeof(q.v -> 'category_id'), 'null') <> 'null'
               AND public.fin__json_uuid(q.v -> 'category_id') IS NULL)
           OR (coalesce(jsonb_typeof(q.v -> 'counterparty_id'), 'null') <> 'null'
               AND public.fin__json_uuid(q.v -> 'counterparty_id') IS NULL)), true)
         OR count(DISTINCT public.fin__json_int(q.v -> 'row_no', 1, 1000000)) <> count(*)
    INTO v_bad
  FROM jsonb_array_elements(p_rows) AS q(v);
  IF v_bad THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'o', public.fin__json_int(q.v -> 'row_no', 1, 1000000),
           'amount_cents', public.fin__json_int(q.v -> 'amount_cents', 1, 1000000000000),
           'day', public.fin__parse_day(public.fin__json_text(q.v -> 'date')),
           'txt', coalesce(public.fin__json_text(q.v -> 'text'), ''),
           'category_id', public.fin__json_uuid(q.v -> 'category_id'),
           'counterparty_id', public.fin__json_uuid(q.v -> 'counterparty_id')) ORDER BY q.o)
    INTO v_rows
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS q(v, o);

  WITH p AS (
    SELECT m.*,
           CASE m.kind WHEN 'exact' THEN 0 WHEN 'near' THEN 1 WHEN 'partial' THEN 2 ELSE 3 END AS kind_rank,
           jsonb_build_object(
             'suggested', m.suggested,
             'score', m.score,
             'reason', m.reason,
             'kind', m.kind,
             'strong', m.strong,
             'days', m.days,
             'remainder_cents', greatest(m.remainder_cents, 0),
             'excess_cents', greatest(- m.remainder_cents, 0),
             'entry', jsonb_build_object(
               'id', m.entry_id,
               'version', m.version,
               'counterparty_name', m.counterparty_name,
               'description', m.description,
               'category_name', m.category_name,
               'report_bucket', m.report_bucket,
               'due_date', m.due_date,
               'amount_cents', m.amount_cents,
               'outstanding_cents', m.outstanding_cents,
               'excluded_from_totals', m.excluded_from_totals)) AS obj
    FROM public.fin__debt_match(v_clinic, v_rows) m
  ),
  -- Rows with exactly one strong candidate; a debt that is the only strong candidate of several rows goes to the
  -- closest one (|date − due date|, then exact before near), and to none of them on a remaining tie.
  one AS (
    SELECT s.o, s.entry_id, s.days, s.kind_rank
    FROM (SELECT p.o, p.entry_id, p.days, p.kind_rank, count(*) OVER (PARTITION BY p.o) AS n
          FROM p
          WHERE p.strong) s
    WHERE s.n = 1
  ),
  pre AS (
    SELECT w.o, w.entry_id
    FROM (SELECT one.o, one.entry_id,
                 rank() OVER (PARTITION BY one.entry_id ORDER BY one.days, one.kind_rank) AS rk,
                 count(*) OVER (PARTITION BY one.entry_id, one.days, one.kind_rank) AS ties
          FROM one) w
    WHERE w.rk = 1 AND w.ties = 1
  ),
  ranked AS (
    SELECT p.o, p.strong, p.obj,
           row_number() OVER (PARTITION BY p.o
                              ORDER BY p.strong DESC, p.score DESC, p.kind_rank, p.days, p.due_date, p.created_at,
                                       p.entry_id) AS rn
    FROM p
    WHERE p.kind <> 'higher'
  ),
  cand AS (
    SELECT ranked.o,
           count(*) AS total_n,
           count(*) FILTER (WHERE ranked.strong) AS strong_n,
           jsonb_agg(ranked.obj ORDER BY ranked.rn) FILTER (WHERE ranked.rn <= 5) AS list
    FROM ranked
    GROUP BY ranked.o
  ),
  hi AS (
    SELECT DISTINCT ON (p.o) p.o, p.obj
    FROM p
    WHERE p.kind = 'higher'
    ORDER BY p.o, p.days, p.remainder_cents DESC, p.due_date, p.entry_id
  )
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
           'row_no', r.o,
           'preselect_entry_id', pre.entry_id,
           'strong_count', coalesce(cand.strong_n, 0),
           'total_count', coalesce(cand.total_n, 0),
           'candidates', coalesce(cand.list, '[]'::jsonb),
           'higher', hi.obj) ORDER BY r.n), '[]'::jsonb))
    INTO v_out
  FROM (SELECT (x.v ->> 'o')::bigint AS o, x.n
        FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS x(v, n)) r
  LEFT JOIN cand ON cand.o = r.o
  LEFT JOIN hi ON hi.o = r.o
  LEFT JOIN pre ON pre.o = r.o;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. fin_import_check (0022 body; same signature): + warning 'open_debt' {debts} on unsaved eligible outflow rows
--    (fin__open_debts) and the optional row keys match_entry_id (the review's chosen debt of that row) and
--    close_remainder (that row closes the rest of the debt). Everything else as in 0022.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_check(p_month text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_today date := public.clinic_today();
  v_month date;
  v_m1 date;
  v_manual_n bigint;
  v_manual_total bigint;
  v_row jsonb;
  v_o bigint;
  v_row_no bigint;
  v_key text;
  v_kind text;
  v_entry_id uuid;
  v_date date;
  v_amount bigint;
  v_direction text;
  v_desc text;
  v_fp text;
  v_src public.fin_import_sources%ROWTYPE;
  v_pay public.fin_payments%ROWTYPE;
  v_status text;
  v_existing jsonb;
  v_warnings jsonb;
  v_errors jsonb;
  v_examples jsonb;
  v_dups jsonb;
  v_dup jsonb;
  v_dupkey text;
  v_out jsonb := '[]'::jsonb;
  v_open jsonb;
BEGIN
  IF p_month IS NULL OR btrim(p_month) !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Filtre değerleri geçersiz.';
  END IF;
  v_month := public.fin__month(p_month);
  v_m1 := (v_month + interval '1 month')::date;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Kontrol için en fazla 2000 satır gönderilebilir.';
  END IF;
  IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Kontrol için en fazla 2000 satır gönderilebilir.';
  END IF;

  v_dups := public.fin__batch_dups(p_rows);

  -- Open debts (owner decision 2026-10-21): per unsaved outflow row that would be saved as a new entry, the open
  -- debts it most likely settles (fin__open_debts: one ledger scan for the whole request, the rule fin_import_rows
  -- enforces with ack_open_debt). A row with match_entry_id is a match: its debt counts for no row once nothing
  -- of it stays open (paid in full, or close_remainder), otherwise with the rest it leaves open.
  v_open := public.fin__open_debts(v_clinic, p_rows);

  -- Manual patient receipts of the month (legacy IP:24): no source key, live payments in the month.
  SELECT count(DISTINCT e.id)::bigint, coalesce(sum(p.amount_cents), 0)::bigint
    INTO v_manual_n, v_manual_total
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.entry_id = e.id
  WHERE e.clinic_id = v_clinic
    AND c.report_bucket = 'patient_receipts'
    AND e.source_key IS NULL
    AND p.voided_at IS NULL
    AND p.paid_on >= v_month AND p.paid_on < v_m1;

  FOR v_row, v_o IN
    SELECT r.v, r.o FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(v, o) ORDER BY r.o
  LOOP
    IF jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_row) AS k(name)
      WHERE k.name NOT IN ('row_no', 'key', 'kind', 'entry_id', 'date', 'amount_cents', 'direction', 'description',
                           'fingerprint', 'match_entry_id', 'close_remainder')
    ) THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;

    IF coalesce(jsonb_typeof(v_row -> 'row_no'), 'null') = 'null' THEN
      v_row_no := v_o;
    ELSE
      v_row_no := public.fin__json_int(v_row -> 'row_no', 1, 1000000);
    END IF;
    v_key := public.fin__json_text(v_row -> 'key');
    v_kind := public.fin__json_text(v_row -> 'kind');
    v_date := public.fin__parse_day(public.fin__json_text(v_row -> 'date'));
    v_amount := public.fin__json_int(v_row -> 'amount_cents', 1, 1000000000000);
    v_direction := public.fin__json_text(v_row -> 'direction');
    v_desc := coalesce(public.fin__json_text(v_row -> 'description'), '');
    v_fp := public.fin__json_text(v_row -> 'fingerprint');
    v_entry_id := public.fin__json_uuid(v_row -> 'entry_id');
    IF v_row_no IS NULL OR v_key IS NULL OR v_kind IS NULL OR v_date IS NULL OR v_amount IS NULL THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    IF char_length(v_key) NOT BETWEEN 1 AND 800 OR v_kind NOT IN ('clinic_excel', 'bank_known', 'bank_table')
       OR char_length(v_desc) > 1000 THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;
    IF (coalesce(jsonb_typeof(v_row -> 'direction'), 'null') <> 'null' AND coalesce(v_direction, '') NOT IN ('in', 'out'))
       OR (coalesce(jsonb_typeof(v_row -> 'entry_id'), 'null') <> 'null' AND v_entry_id IS NULL)
       OR (coalesce(jsonb_typeof(v_row -> 'fingerprint'), 'null') <> 'null' AND v_fp IS NULL)
       OR (coalesce(jsonb_typeof(v_row -> 'description'), 'null') NOT IN ('null', 'string'))
       OR (coalesce(jsonb_typeof(v_row -> 'match_entry_id'), 'null') <> 'null'
           AND public.fin__json_uuid(v_row -> 'match_entry_id') IS NULL)
       OR coalesce(jsonb_typeof(v_row -> 'close_remainder'), 'null') NOT IN ('null', 'boolean') THEN
      RAISE EXCEPTION 'Filtre değerleri geçersiz.';
    END IF;

    -- Status of the key (one namespace, C15).
    v_status := 'new';
    v_existing := NULL;
    SELECT * INTO v_src FROM public.fin_import_sources s WHERE s.clinic_id = v_clinic AND s.source_key = v_key;
    IF FOUND THEN
      IF v_src.link_kind = 'entry' THEN
        v_status := CASE WHEN v_src.fingerprint IS NOT DISTINCT FROM v_fp THEN 'saved_same' ELSE 'saved_changed' END;
        SELECT jsonb_build_object(
                 'entry_id', e.id,
                 'amount_cents', e.amount_cents,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'paid_on', coalesce(p.paid_on, e.due_date),
                 'source_kind', v_src.source_kind,
                 'batch_id', v_src.batch_id)
          INTO v_existing
        FROM public.fin_entries e
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        LEFT JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.id = v_src.payment_id
        WHERE e.clinic_id = v_clinic AND e.id = v_src.entry_id;
      ELSE
        SELECT * INTO v_pay FROM public.fin_payments p WHERE p.clinic_id = v_clinic AND p.id = v_src.payment_id;
        IF v_pay.voided_at IS NOT NULL THEN
          v_status := 'match_voided';
        ELSIF v_pay.amount_cents = v_amount AND v_pay.paid_on = v_date THEN
          v_status := 'matched_same';
        ELSE
          v_status := 'matched_changed';
        END IF;
        SELECT jsonb_build_object(
                 'entry_id', e.id,
                 'amount_cents', v_pay.amount_cents,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'paid_on', v_pay.paid_on,
                 'source_kind', v_src.source_kind,
                 'batch_id', v_src.batch_id)
          INTO v_existing
        FROM public.fin_entries e
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        WHERE e.clinic_id = v_clinic AND e.id = v_src.entry_id;
      END IF;
    ELSIF v_entry_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = v_entry_id) THEN
      -- Only the caller's own clinic is looked at: an id of another clinic never shows (no existence oracle).
      v_status := 'id_taken';
    END IF;

    -- Hard refusals at save time, shown early.
    v_errors := '[]'::jsonb;
    IF NOT public.fin__source_key_ok(v_kind, v_key, v_date, v_direction)
       OR (v_entry_id IS NOT NULL AND v_entry_id IS DISTINCT FROM public.fin__import_id(v_clinic, v_key)) THEN
      v_errors := v_errors || to_jsonb('invalid_key'::text);
    END IF;
    IF v_date < v_month OR v_date >= v_m1 THEN
      v_errors := v_errors || to_jsonb('outside_month'::text);
    END IF;
    IF v_date > v_today THEN
      v_errors := v_errors || to_jsonb('future_date'::text);
    END IF;
    -- Voided financing rows no longer claim their loan's bank lines (fin_financing_void: "should not have been
    -- imported"), so those lines can be imported here again.
    IF public.fin__financing_marker(v_desc)
       OR EXISTS (SELECT 1 FROM public.fin_patient_financing f
                  WHERE f.clinic_id = v_clinic AND f.voided_at IS NULL AND strpos(v_desc, f.loan_key) > 0) THEN
      v_errors := v_errors || to_jsonb('financing_line'::text);
    END IF;
    IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND EXISTS (
      SELECT 1 FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic AND e.source_key = public.fin__receipts_key('dentos', v_date)
        AND e.cancelled_at IS NULL
    ) THEN
      v_errors := v_errors || to_jsonb('receipts_day_taken'::text);
    END IF;

    -- Warnings (C9), only for rows that can still be sent.
    v_warnings := '[]'::jsonb;
    v_dupkey := public.fin__iso_date(v_date) || '|' || v_amount::text;
    IF v_status IN ('new', 'match_voided', 'id_taken') THEN
      SELECT coalesce(jsonb_agg(x.obj ORDER BY x.recorded_at, x.id), '[]'::jsonb) INTO v_examples
      FROM (
        SELECT p.id, p.recorded_at,
               jsonb_build_object(
                 'entry_id', e.id,
                 'counterparty_name', coalesce(cp.name, e.counterparty_text),
                 'paid_on', p.paid_on,
                 'amount_cents', p.amount_cents,
                 'account_name', a.name) AS obj
        FROM public.fin_payments p
        JOIN public.fin_entries e ON e.clinic_id = p.clinic_id AND e.id = p.entry_id
        LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
        JOIN public.fin_accounts a ON a.clinic_id = p.clinic_id AND a.id = p.account_id
        WHERE p.clinic_id = v_clinic
          AND p.voided_at IS NULL
          AND p.paid_on = v_date
          AND p.amount_cents = v_amount
          AND e.source_key IS DISTINCT FROM v_key
          AND p.bank_source_key IS DISTINCT FROM v_key
        ORDER BY p.recorded_at, p.id
        LIMIT 3
      ) x;
      IF jsonb_array_length(v_examples) > 0 THEN
        v_warnings := v_warnings || jsonb_build_array(
          jsonb_build_object('code', 'possible_duplicate', 'examples', v_examples));
      END IF;
      v_dup := public.fin__batch_dup_of(v_dups, v_dupkey, v_kind, v_row_no);
      IF v_dup IS NOT NULL THEN
        v_warnings := v_warnings || jsonb_build_array(
          jsonb_build_object('code', 'batch_duplicate', 'row_no', v_dup));
      END IF;
      IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND v_manual_n > 0 THEN
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'manual_receipt_overlap'));
      END IF;
      -- open_debt: saved as a new entry, this payment would be counted next to the open debt it most likely
      -- settles (not on financing lines, which are refused anyway).
      IF v_open ? v_o::text AND NOT (v_errors ? 'financing_line') THEN
        v_warnings := v_warnings || jsonb_build_array(
          jsonb_build_object('code', 'open_debt', 'debts', v_open -> v_o::text));
      END IF;
    END IF;

    -- Debt suggestions are not computed here; the review table asks fin_debt_candidates_batch for every eligible
    -- outflow at once and fin_debt_candidates for the full list of one row.
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'row_no', v_row_no,
      'key', v_key,
      'status', v_status,
      'existing', v_existing,
      'warnings', v_warnings,
      'errors', v_errors));
  END LOOP;

  RETURN jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'manual_receipts', jsonb_build_object('count', v_manual_n, 'total_cents', v_manual_total),
    'reconciliation', public.fin__receipt_reconciliation(v_clinic, v_month),
    'rows', v_out);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. fin_import_rows (0022 body; same signature): + a match on clinic workbook expense rows (with the row's account,
--    date and key, as for bank rows), + close_remainder (cancels the rest of the matched debt like fin_cancel_entry),
--    + ack_open_debt (a new outflow entry next to a matching open debt is refused without it; PT409), + per row result
--    remainder_closed_cents. Everything else as in 0022.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_import_rows(p_rows jsonb, p_batch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_today date;
  v_batch_id uuid;
  v_month date;
  v_m1 date;
  v_files text[] := ARRAY[]::text[];
  v_layouts uuid[] := ARRAY[]::uuid[];
  v_owner uuid;
  v_stored jsonb;
  v_rows_n integer;
  v_manual_n bigint;
  v_dups jsonb;
  v_targets uuid[] := ARRAY[]::uuid[];
  v_new_payments uuid[] := ARRAY[]::uuid[];
  v_results jsonb := '[]'::jsonb;
  v_inserted integer := 0;
  v_matched integer := 0;
  v_skipped integer := 0;
  v_ack integer := 0;
  v_any_receipts boolean := false;
  v_rec jsonb;
  v_rec_out jsonb;
  v_result jsonb;
  v_item jsonb;
  -- per row
  v_row jsonb;
  v_o bigint;
  v_row_no integer;
  v_key text;
  v_kind text;
  v_file text;
  v_date date;
  v_amount bigint;
  v_direction text;
  v_desc text;
  v_account uuid;
  v_ack_codes text[];
  v_match jsonb;
  v_is_match boolean;
  v_m_entry uuid;
  v_m_version bigint;
  v_m_payment uuid;
  v_entry_id uuid;
  v_fp text;
  v_category uuid;
  v_sub text;
  v_ent_month text;
  v_cp uuid;
  v_cp_text text;
  v_ctx text;
  v_detail jsonb;
  v_dupkey text;
  v_is_batch_dup boolean;
  v_src public.fin_import_sources%ROWTYPE;
  v_has_src boolean;
  v_rebind boolean;
  v_pay public.fin_payments%ROWTYPE;
  v_in record;
  v_acc public.fin_accounts%ROWTYPE;
  v_target public.fin_entries%ROWTYPE;
  v_dir text;
  v_bucket text;
  v_codes text[];
  v_code text;
  v_status text;
  v_res_entry uuid;
  v_res_payment uuid;
  v_name text;
  v_constraint text;
  v_open jsonb;
  v_open_debt jsonb;
  v_close boolean;
  v_ack_open boolean;
  v_outstanding bigint;
  v_closed bigint;
BEGIN
  -- Step 1: lock, batch shape, replay.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_import:' || v_clinic::text, 0));
  v_today := public.clinic_today();
  PERFORM public.fin__set_ctx('import');

  IF p_batch IS NULL OR jsonb_typeof(p_batch) <> 'object' THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_batch) AS k(name)
             WHERE k.name NOT IN ('id', 'month', 'file_names', 'layout_ids')) THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  v_batch_id := public.fin__json_uuid(p_batch -> 'id');
  IF v_batch_id IS NULL OR coalesce(public.fin__json_text(p_batch -> 'month'), '') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  v_month := public.fin__parse_day((p_batch ->> 'month') || '-01');
  IF v_month IS NULL OR v_month > public.fin__month_start(v_today) THEN
    RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
  END IF;
  v_m1 := (v_month + interval '1 month')::date;

  IF coalesce(jsonb_typeof(p_batch -> 'file_names'), 'null') <> 'null' THEN
    IF jsonb_typeof(p_batch -> 'file_names') <> 'array' THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    IF jsonb_array_length(p_batch -> 'file_names') > 50 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_batch -> 'file_names') AS f(v)
      WHERE public.fin__json_text(f.v) IS NULL OR char_length(f.v #>> '{}') NOT BETWEEN 1 AND 200
    ) THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    SELECT coalesce(array_agg(f.v #>> '{}' ORDER BY f.o), ARRAY[]::text[]) INTO v_files
    FROM jsonb_array_elements(p_batch -> 'file_names') WITH ORDINALITY AS f(v, o);
  END IF;

  IF coalesce(jsonb_typeof(p_batch -> 'layout_ids'), 'null') <> 'null' THEN
    IF jsonb_typeof(p_batch -> 'layout_ids') <> 'array' THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    IF jsonb_array_length(p_batch -> 'layout_ids') > 50 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_batch -> 'layout_ids') AS f(v)
      WHERE public.fin__json_uuid(f.v) IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.fin_import_layouts l
                        WHERE l.clinic_id = v_clinic AND l.id = public.fin__json_uuid(f.v))
    ) THEN
      RAISE EXCEPTION 'Aktarım bilgileri geçersiz.';
    END IF;
    SELECT coalesce(array_agg(DISTINCT public.fin__json_uuid(f.v)), ARRAY[]::uuid[]) INTO v_layouts
    FROM jsonb_array_elements(p_batch -> 'layout_ids') AS f(v);
  END IF;

  SELECT b.clinic_id, b.result INTO v_owner, v_stored FROM public.fin_import_batches b WHERE b.id = v_batch_id;
  IF v_owner IS NOT NULL THEN
    IF v_owner = v_clinic THEN
      RETURN v_stored || jsonb_build_object('already_saved', true,
                                            'batch', public.fin__batch_json(v_clinic, v_batch_id));
    END IF;
    RAISE EXCEPTION 'Aktarım kaydedilemedi.' USING ERRCODE = 'PT409';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Bir aktarımda en az 1, en fazla 500 satır gönderilebilir.';
  END IF;
  v_rows_n := jsonb_array_length(p_rows);
  IF v_rows_n NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Bir aktarımda en az 1, en fazla 500 satır gönderilebilir.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(v)
    WHERE jsonb_typeof(r.v) = 'object' AND public.fin__json_text(r.v -> 'key') IS NOT NULL
    GROUP BY r.v ->> 'key'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Seçimde tekrarlanan kaynak satırı var.';
  END IF;
  v_dups := public.fin__batch_dups(p_rows);
  -- Open debts of the new outflow rows (owner decision 2026-10-21), computed once before any write over the whole
  -- request (fin__open_debts, the rule of fin_import_check's open_debt): a debt that a row of this request matches
  -- counts for no row once nothing of it stays open (paid in full, or close_remainder), otherwise with the rest it
  -- leaves open.
  v_open := public.fin__open_debts(v_clinic, p_rows);

  -- Manual patient receipts of the batch month (manual_receipt_overlap, legacy IP:24).
  SELECT count(DISTINCT e.id)::bigint INTO v_manual_n
  FROM public.fin_entries e
  JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
  JOIN public.fin_payments p ON p.clinic_id = e.clinic_id AND p.entry_id = e.id
  WHERE e.clinic_id = v_clinic
    AND c.report_bucket = 'patient_receipts'
    AND e.source_key IS NULL
    AND p.voided_at IS NULL
    AND p.paid_on >= v_month AND p.paid_on < v_m1;

  FOR v_row, v_o IN
    SELECT r.v, r.o FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(v, o) ORDER BY r.o
  LOOP
    -- Context first, so every later message names the row.
    v_row_no := v_o::integer;
    IF jsonb_typeof(v_row) = 'object' AND public.fin__json_int(v_row -> 'row_no', 1, 1000000) IS NOT NULL THEN
      v_row_no := public.fin__json_int(v_row -> 'row_no', 1, 1000000)::integer;
    END IF;
    IF jsonb_typeof(v_row) = 'object' THEN
      v_file := public.fin__json_text(v_row -> 'file');
      v_date := public.fin__parse_day(public.fin__json_text(v_row -> 'date'));
      v_key := public.fin__json_text(v_row -> 'key');
    ELSE
      v_file := NULL;
      v_date := NULL;
      v_key := NULL;
    END IF;
    v_ctx := public.fin__row_ctx(v_file, v_date, v_row_no);
    v_detail := jsonb_build_object('row_no', v_row_no, 'key', v_key);

    -- Step 2: shape.
    IF jsonb_typeof(v_row) <> 'object' THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_row) AS k(name)
      WHERE k.name NOT IN ('row_no', 'key', 'kind', 'file', 'date', 'amount_cents', 'direction', 'currency',
                           'account_id', 'acknowledged', 'entry_id', 'fingerprint', 'category_id', 'subcategory',
                           'entitlement_month', 'counterparty_id', 'counterparty_text', 'description', 'match',
                           'close_remainder', 'ack_open_debt')
    ) OR public.fin__json_int(v_row -> 'row_no', 1, 1000000) IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    IF coalesce(jsonb_typeof(v_row -> 'file'), 'null') <> 'null'
       AND (v_file IS NULL OR char_length(v_file) > 200) THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    v_file := nullif(btrim(coalesce(v_file, '')), '');

    v_kind := public.fin__json_text(v_row -> 'kind');
    IF v_kind IS NULL OR v_key IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
    END IF;
    IF char_length(v_key) NOT BETWEEN 1 AND 800
       OR v_kind NOT IN ('clinic_excel', 'bank_known', 'bank_table')
       OR (v_kind = 'clinic_excel' AND left(v_key, 7) <> 'clinic:')
       OR (v_kind = 'bank_known' AND left(v_key, 5) <> 'bank:')
       OR (v_kind = 'bank_table' AND left(v_key, 11) <> 'bank-table:') THEN
      PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
    END IF;

    v_amount := public.fin__json_int(v_row -> 'amount_cents', 1, 1000000000000);
    IF v_amount IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'tutar', v_detail);
    END IF;
    IF v_date IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'işlem tarihi', v_detail);
    END IF;
    IF public.fin__json_text(v_row -> 'currency') IS DISTINCT FROM 'TRY' THEN
      PERFORM public.fin__row_raise(v_ctx,
        'Dövizli hareket TL olarak aktarılamaz; TL karşılığı olan bir döküm kullanın. Hiçbir kayıt aktarılmadı.',
        'P0001', v_detail);
    END IF;
    v_desc := public.fin__json_text(v_row -> 'description');
    IF v_desc IS NULL OR char_length(v_desc) > 1000 THEN
      PERFORM public.fin__row_field(v_ctx, 'açıklama', v_detail);
    END IF;
    v_direction := public.fin__json_text(v_row -> 'direction');
    IF v_direction IS NULL OR v_direction NOT IN ('in', 'out') THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    -- The key must mean this row: its template, its embedded day = the row day, receipts = inflow, expense = outflow.
    IF NOT public.fin__source_key_ok(v_kind, v_key, v_date, v_direction) THEN
      PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
    END IF;

    IF v_date < v_month OR v_date >= v_m1 THEN
      PERFORM public.fin__row_raise(v_ctx, 'satır seçilen aktarım ayının dışında. Hiçbir kayıt aktarılmadı.',
                                    'P0001', v_detail);
    END IF;
    IF v_date > v_today THEN
      PERFORM public.fin__row_raise(v_ctx, 'Ödeme tutarını ve tarihini kontrol edin. Hiçbir kayıt aktarılmadı.',
                                    'P0001', v_detail);
    END IF;

    -- Financing guard (IR:24): fee lines of patient financing belong to the financing upload. A voided financing row
    -- releases its loan's lines (fin_financing_void: "should not have been imported").
    IF public.fin__financing_marker(v_desc)
       OR EXISTS (SELECT 1 FROM public.fin_patient_financing f
                  WHERE f.clinic_id = v_clinic AND f.voided_at IS NULL AND strpos(v_desc, f.loan_key) > 0) THEN
      PERFORM public.fin__row_raise(v_ctx,
        'Hasta finansmanı kesintilerini finans ekranındaki Hasta finansmanı bölümünden yükleyin. Çift sayımı önlemek için bu aktarım durduruldu.',
        'P0001', v_detail);
    END IF;

    -- Daily receipts: workbook and DentOS daily totals are mutually exclusive per day (C13).
    IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND EXISTS (
      SELECT 1 FROM public.fin_entries e
      WHERE e.clinic_id = v_clinic AND e.source_key = public.fin__receipts_key('dentos', v_date)
        AND e.cancelled_at IS NULL
    ) THEN
      PERFORM public.fin__row_raise(v_ctx,
        'Bu gün için DentOS günlük tahsilatı kayıtlı; klinik Excel tahsilatı ayrıca aktarılamaz. Hiçbir kayıt aktarılmadı.',
        'PT409', v_detail);
    END IF;

    v_account := public.fin__json_uuid(v_row -> 'account_id');
    IF v_account IS NULL THEN
      PERFORM public.fin__row_field(v_ctx, 'hesap', v_detail);
    END IF;

    v_ack_codes := ARRAY[]::text[];
    IF coalesce(jsonb_typeof(v_row -> 'acknowledged'), 'null') <> 'null' THEN
      IF jsonb_typeof(v_row -> 'acknowledged') <> 'array' THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      IF jsonb_array_length(v_row -> 'acknowledged') > 10 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_row -> 'acknowledged') AS a(v) WHERE jsonb_typeof(a.v) <> 'string'
      ) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      SELECT coalesce(array_agg(a.v #>> '{}'), ARRAY[]::text[]) INTO v_ack_codes
      FROM jsonb_array_elements(v_row -> 'acknowledged') AS a(v);
    END IF;

    -- close_remainder / ack_open_debt (owner decision 2026-10-21): booleans, absent or null = false.
    IF coalesce(jsonb_typeof(v_row -> 'close_remainder'), 'null') NOT IN ('null', 'boolean')
       OR coalesce(jsonb_typeof(v_row -> 'ack_open_debt'), 'null') NOT IN ('null', 'boolean') THEN
      PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
    END IF;
    v_close := coalesce((v_row ->> 'close_remainder')::boolean, false);
    v_ack_open := coalesce((v_row ->> 'ack_open_debt')::boolean, false);

    v_match := v_row -> 'match';
    v_is_match := coalesce(jsonb_typeof(v_match), 'null') <> 'null';
    v_m_entry := NULL;
    v_m_version := NULL;
    v_m_payment := NULL;
    v_outstanding := NULL;
    v_closed := NULL;
    v_entry_id := NULL;
    v_fp := NULL;
    v_category := NULL;
    v_sub := NULL;
    v_ent_month := NULL;
    v_cp := NULL;
    v_cp_text := NULL;
    IF v_is_match THEN
      IF jsonb_typeof(v_match) <> 'object' THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_match) AS k(name)
                 WHERE k.name NOT IN ('entry_id', 'version', 'payment_id')) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      v_m_entry := public.fin__json_uuid(v_match -> 'entry_id');
      v_m_version := public.fin__json_int(v_match -> 'version', 1, 2147483647);
      v_m_payment := public.fin__json_uuid(v_match -> 'payment_id');
      IF v_m_entry IS NULL OR v_m_version IS NULL THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(ARRAY['entry_id', 'fingerprint', 'category_id', 'subcategory', 'entitlement_month',
                                   'counterparty_id', 'counterparty_text']) AS f(name)
        WHERE coalesce(jsonb_typeof(v_row -> f.name), 'null') <> 'null'
      ) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
    ELSE
      IF v_close THEN
        PERFORM public.fin__row_raise(v_ctx,
          'Kalan borcu kapatma yalnızca mevcut borca eşleştirilen satırda seçilebilir. Hiçbir kayıt aktarılmadı.',
          'P0001', v_detail);
      END IF;
      v_entry_id := public.fin__json_uuid(v_row -> 'entry_id');
      -- The deterministic id (keys.ts importedEntryId), never an id of the client's choosing.
      IF v_entry_id IS NULL OR v_entry_id IS DISTINCT FROM public.fin__import_id(v_clinic, v_key) THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      v_fp := public.fin__json_text(v_row -> 'fingerprint');
      IF v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
        PERFORM public.fin__row_field(v_ctx, 'parmak izi', v_detail);
      END IF;
      v_category := public.fin__json_uuid(v_row -> 'category_id');
      IF v_category IS NULL THEN
        PERFORM public.fin__row_field(v_ctx, 'kategori', v_detail);
      END IF;
      IF coalesce(jsonb_typeof(v_row -> 'subcategory'), 'null') NOT IN ('null', 'string')
         OR coalesce(jsonb_typeof(v_row -> 'entitlement_month'), 'null') NOT IN ('null', 'string')
         OR coalesce(jsonb_typeof(v_row -> 'counterparty_text'), 'null') NOT IN ('null', 'string') THEN
        PERFORM public.fin__row_field(v_ctx, 'alan', v_detail);
      END IF;
      v_sub := public.fin__json_text(v_row -> 'subcategory');
      v_ent_month := public.fin__json_text(v_row -> 'entitlement_month');
      v_cp_text := public.fin__json_text(v_row -> 'counterparty_text');
      IF coalesce(jsonb_typeof(v_row -> 'counterparty_id'), 'null') <> 'null' THEN
        v_cp := public.fin__json_uuid(v_row -> 'counterparty_id');
        IF v_cp IS NULL THEN
          PERFORM public.fin__row_field(v_ctx, 'işlem adı', v_detail);
        END IF;
      END IF;
    END IF;

    -- batch_duplicate looks at every other row of the request, whatever happens to it (legacy IP:18, order-free).
    v_dupkey := public.fin__iso_date(v_date) || '|' || v_amount::text;
    v_is_batch_dup := public.fin__batch_dup_of(v_dups, v_dupkey, v_kind, v_row_no) IS NOT NULL;

    -- Step 3: already imported or matched? (uniqueness only through fin_import_sources, C15)
    v_status := NULL;
    v_rebind := false;
    SELECT * INTO v_src
    FROM public.fin_import_sources s
    WHERE s.clinic_id = v_clinic AND s.source_key = v_key
    FOR UPDATE;
    v_has_src := FOUND;
    IF v_has_src THEN
      IF v_src.link_kind = 'entry' THEN
        IF v_is_match THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Bu banka satırı zaten kaydedilmiş veya başka borçla eşleşmiş. Yeni ödeme eklenmedi.', 'PT409', v_detail);
        END IF;
        IF v_src.fingerprint IS NOT DISTINCT FROM v_fp THEN
          v_status := 'skipped_same';
          v_res_entry := v_src.entry_id;
          v_res_payment := v_src.payment_id;
        ELSE
          SELECT coalesce(cp.name, e.counterparty_text) INTO v_name
          FROM public.fin_entries e
          LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = e.clinic_id AND cp.id = e.counterparty_id
          WHERE e.clinic_id = v_clinic AND e.id = v_src.entry_id;
          PERFORM public.fin__row_raise(v_ctx,
            'Önceden aktarılan satır değişmiş: ' || coalesce(v_name, '') ||
            '. Mevcut kaydı finans listesinden düzeltin; yeniden eklenmedi. Hiçbir kayıt aktarılmadı.',
            'PT409', v_detail || jsonb_build_object('entry_id', v_src.entry_id));
        END IF;
      ELSE
        SELECT * INTO v_pay FROM public.fin_payments p WHERE p.clinic_id = v_clinic AND p.id = v_src.payment_id;
        IF v_pay.voided_at IS NULL THEN
          IF NOT v_is_match THEN
            IF v_pay.amount_cents = v_amount AND v_pay.paid_on = v_date THEN
              v_status := 'skipped_matched';
            ELSE
              PERFORM public.fin__row_raise(v_ctx,
                'Eşleşmiş banka satırının tutarı veya tarihi değişmiş; yeni kayıt eklenmedi. Hiçbir kayıt aktarılmadı.',
                'PT409', v_detail);
            END IF;
          ELSIF v_pay.entry_id = v_m_entry AND v_pay.amount_cents = v_amount AND v_pay.paid_on = v_date THEN
            v_status := 'skipped_matched';
          ELSE
            PERFORM public.fin__row_raise(v_ctx,
              'Bu banka satırı zaten kaydedilmiş veya başka borçla eşleşmiş. Yeni ödeme eklenmedi.', 'PT409', v_detail);
          END IF;
          v_res_entry := v_src.entry_id;
          v_res_payment := v_src.payment_id;
        ELSE
          v_rebind := true;   -- the matched payment was voided: this row re-binds the key (§2.5)
        END IF;
      END IF;
    END IF;

    IF v_status IS NOT NULL THEN
      -- Skipped rows end here: no warning check, not counted as acknowledged (IR:30).
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row_no, 'key', v_key, 'status', v_status, 'entry_id', v_res_entry, 'payment_id', v_res_payment));
      CONTINUE;
    END IF;

    -- Ids must be new (E_ID_TAKEN / E_PAYMENT_ID_TAKEN), checked across clinics without revealing anything (the
    -- ids are deterministic per clinic and key, so a hit means an id created outside this RPC).
    IF NOT v_is_match THEN
      IF EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_entry_id) THEN
        PERFORM public.fin__row_raise(v_ctx, 'Kayıt kaydedilemedi. Hiçbir kayıt aktarılmadı.', 'PT409', v_detail);
      END IF;
      IF EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.id = v_entry_id) THEN
        PERFORM public.fin__row_raise(v_ctx,
          'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.', 'PT409', v_detail);
      END IF;
    END IF;

    BEGIN
      -- Step 4: validate the new data.
      IF NOT v_is_match THEN
        SELECT * INTO v_in
        FROM public.fin__entry_input(v_clinic, v_category, v_sub, v_cp, v_cp_text, v_desc, v_date, v_amount,
                                     v_ent_month);
        IF NOT v_in.o_category_active THEN
          PERFORM public.fin__row_raise(v_ctx, 'Pasif kategori seçilemez. Hiçbir kayıt aktarılmadı.', 'P0001', v_detail);
        END IF;
        SELECT c.direction, c.report_bucket INTO v_dir, v_bucket
        FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = v_in.o_category_id;
        IF v_dir IS DISTINCT FROM v_direction THEN
          PERFORM public.fin__row_raise(v_ctx,
            'kategorinin yönü satırın giriş / çıkış yönüyle uyuşmuyor. Hiçbir kayıt aktarılmadı.', 'P0001', v_detail);
        END IF;
        -- A daily receipts key is a patient-receipts row (financing coverage and C13 read it by key).
        IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND v_bucket IS DISTINCT FROM 'patient_receipts' THEN
          PERFORM public.fin__row_field(v_ctx, 'kaynak anahtarı', v_detail);
        END IF;
        IF NOT v_in.o_counterparty_active THEN
          PERFORM public.fin__row_raise(v_ctx, 'Pasif kişi / kurum seçilemez. Hiçbir kayıt aktarılmadı.', 'P0001',
                                        v_detail);
        END IF;
      ELSE
        -- Bank outflows and (owner decision 2026-10-21) clinic workbook expense rows, paid in cash or by bank, settle
        -- open debts; daily receipts never do.
        IF v_kind = 'clinic_excel' AND (right(v_key, 9) = ':receipts' OR v_direction <> 'out') THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Klinik Excel dosyasında yalnızca gider satırları açık borca eşleştirilebilir. Hiçbir kayıt aktarılmadı.',
            'P0001', v_detail);
        END IF;
        IF v_kind NOT IN ('bank_known', 'bank_table', 'clinic_excel') OR v_direction <> 'out'
           OR v_m_payment IS NULL THEN
          PERFORM public.fin__row_raise(v_ctx, 'Banka satırı veya ödeme tarihi geçersiz.', 'P0001', v_detail);
        END IF;
        IF v_m_entry = ANY (v_targets) THEN
          RAISE EXCEPTION 'Aynı borca bu aktarımda tek banka satırı eşleştirin; sonraki ödemeyi yenilenen kalan tutarla aktarın.'
            USING DETAIL = v_detail::text;
        END IF;
        v_targets := array_append(v_targets, v_m_entry);

        SELECT * INTO v_target FROM public.fin_entries e WHERE e.clinic_id = v_clinic AND e.id = v_m_entry FOR UPDATE;
        IF NOT FOUND THEN
          PERFORM public.fin__row_raise(v_ctx, 'Borç bulunamadı.', 'PT404', v_detail);
        END IF;
        IF v_target.version IS DISTINCT FROM v_m_version::integer THEN
          PERFORM public.fin__row_raise(v_ctx, 'Borç başka ekranda değişti. Listeyi yenileyin.', 'PT409', v_detail);
        END IF;
        SELECT c.direction INTO v_dir
        FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = v_target.category_id;
        IF v_target.cancelled_at IS NOT NULL
           OR v_dir IS DISTINCT FROM 'out'
           OR EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = v_target.id)
           OR v_amount > v_target.amount_cents - public.fin__paid(v_target.id) THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Açık borcu ve kalan tutarı kontrol edin. Fazla ödeme eşleştirilemez.', 'P0001', v_detail);
        END IF;
        -- close_remainder: only a payment below the remaining amount leaves something to close.
        v_outstanding := v_target.amount_cents - public.fin__paid(v_target.id);
        IF v_close AND v_amount >= v_outstanding THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Ödeme borcun kalanını tamamen kapatıyor; kalan borç kapatma seçilemez. Hiçbir kayıt aktarılmadı.',
            'P0001', v_detail);
        END IF;
        IF EXISTS (SELECT 1 FROM public.fin_payments p WHERE p.id = v_m_payment) THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.', 'PT409', v_detail);
        END IF;
      END IF;

      PERFORM public.fin__check_account(v_clinic, v_account);
      IF v_kind <> 'clinic_excel' THEN
        SELECT * INTO v_acc FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.id = v_account;
        IF v_acc.kind NOT IN ('bank', 'pos') THEN
          PERFORM public.fin__row_raise(v_ctx,
            'banka satırı yalnızca banka veya POS türündeki bir hesaba işlenebilir. Hiçbir kayıt aktarılmadı.',
            'P0001', v_detail);
        END IF;
      END IF;

      -- Step 5: warnings re-detected now (C9); each must be acknowledged for this row.
      v_codes := ARRAY[]::text[];
      IF EXISTS (
        SELECT 1
        FROM public.fin_payments p
        JOIN public.fin_entries e ON e.clinic_id = p.clinic_id AND e.id = p.entry_id
        WHERE p.clinic_id = v_clinic
          AND p.voided_at IS NULL
          AND p.paid_on = v_date
          AND p.amount_cents = v_amount
          AND e.source_key IS DISTINCT FROM v_key
          AND p.bank_source_key IS DISTINCT FROM v_key
          AND NOT (p.id = ANY (v_new_payments))
      ) THEN
        v_codes := array_append(v_codes, 'possible_duplicate');
      END IF;
      IF v_is_batch_dup THEN
        v_codes := array_append(v_codes, 'batch_duplicate');
      END IF;
      IF v_kind = 'clinic_excel' AND right(v_key, 9) = ':receipts' AND v_manual_n > 0 THEN
        v_codes := array_append(v_codes, 'manual_receipt_overlap');
      END IF;
      FOREACH v_code IN ARRAY v_codes
      LOOP
        IF NOT (v_code = ANY (v_ack_codes)) THEN
          PERFORM public.fin__row_raise(v_ctx,
            CASE v_code
              WHEN 'possible_duplicate' THEN 'Mevcut kayıtta aynı tarih ve tutar var'
              WHEN 'batch_duplicate' THEN 'Bu aktarımda aynı tarih ve tutarda başka bir satır var'
              ELSE 'Bu ay elle girilmiş tahsilatlar var. Tam dönem toplamları eşleşirse Excel esas alınır'
            END || '. Uyarıyı onaylayın veya satırı seçimden çıkarın. Hiçbir kayıt aktarılmadı.',
            'PT409', v_detail || jsonb_build_object('warning', v_code));
        END IF;
      END LOOP;
      -- open_debt (owner decision 2026-10-21): a new outflow entry next to an open debt of the same or a slightly
      -- higher remaining amount due within 45 days would count the payment twice; saved only with the row's
      -- ack_open_debt. A matched row never needs it.
      v_open_debt := CASE WHEN v_is_match THEN NULL ELSE v_open -> v_o::text -> 0 END;
      IF v_open_debt IS NOT NULL AND NOT v_ack_open THEN
        PERFORM public.fin__row_raise(v_ctx,
          'Aynı veya yakın tutarda açık borç var: ' || coalesce(v_open_debt ->> 'counterparty_name', '')
          || ' · vade ' || to_char((v_open_debt ->> 'due_date')::date, 'DD.MM.YYYY')
          || ' · kalan ' || public.fin__hk_tl((v_open_debt ->> 'outstanding_cents')::bigint)
          || '. Satırı bu borca eşleştirin veya yeni gider olarak kaydetmeyi onaylayın (ödeme iki kez sayılır). '
          || 'Hiçbir kayıt aktarılmadı.',
          'PT409', v_detail || jsonb_build_object('warning', 'open_debt', 'entry_id', v_open_debt -> 'entry_id'));
      END IF;
      IF cardinality(v_codes) > 0 OR v_open_debt IS NOT NULL THEN
        v_ack := v_ack + 1;
      END IF;

      -- Steps 6-7: write.
      IF v_is_match THEN
        INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, bank_source_key,
                                         bank_source_file, bank_source_description, recorded_by, updated_by)
        VALUES (v_m_payment, v_clinic, v_m_entry, v_date, v_amount, v_account, v_key, v_file, left(v_desc, 1000),
                v_user, v_user);
        PERFORM public.fin__bump_entry(v_clinic, v_m_entry);
        v_res_entry := v_m_entry;
        v_res_payment := v_m_payment;
        v_status := 'matched';
        -- close_remainder: 'Kalan planı iptal et' of fin_cancel_entry in the same save (same columns, audited by
        -- audit_row_change), so no remainder stays in the plan.
        IF v_close THEN
          UPDATE public.fin_entries e
          SET cancelled_at = now(),
              cancelled_by = public.current_app_user_id(),
              cancel_reason = public.fin__reason('Aktarımda kalan kapatıldı (' || coalesce(v_file, 'Dosya')
                                                 || ' · satır ' || v_row_no::text || ')')
          WHERE e.clinic_id = v_clinic AND e.id = v_m_entry;
          v_closed := v_outstanding - v_amount;
        END IF;
      ELSE
        INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                        description, due_date, amount_cents, entitlement_month, source_key,
                                        source_fingerprint, source_file, created_by, updated_by)
        VALUES (v_entry_id, v_clinic, v_in.o_category_id, v_in.o_subcategory, v_in.o_counterparty_id,
                v_in.o_counterparty_text, v_in.o_description, v_in.o_due_date, v_in.o_amount_cents,
                v_in.o_entitlement_month, v_key, v_fp, v_file, v_user, v_user);
        -- Imported rows are saved as paid in full on the row date (C16; IP:54 paid = amount).
        INSERT INTO public.fin_payments (id, clinic_id, entry_id, paid_on, amount_cents, account_id, recorded_by,
                                         updated_by)
        VALUES (v_entry_id, v_clinic, v_entry_id, v_date, v_amount, v_account, v_user, v_user);
        v_res_entry := v_entry_id;
        v_res_payment := v_entry_id;
        v_status := 'inserted';
        IF v_bucket = 'patient_receipts' THEN
          v_any_receipts := true;
        END IF;
      END IF;

      IF v_rebind THEN
        UPDATE public.fin_import_sources s
        SET link_kind = CASE WHEN v_is_match THEN 'payment_match' ELSE 'entry' END,
            entry_id = v_res_entry,
            payment_id = v_res_payment,
            fingerprint = CASE WHEN v_is_match THEN NULL ELSE v_fp END,
            file_name = v_file,
            batch_id = v_batch_id,
            txn_date = v_date,
            amount_cents = v_amount,
            rebind_count = s.rebind_count + 1,
            rebound_at = now(),
            rebound_by = v_user
        WHERE s.id = v_src.id;
      ELSE
        INSERT INTO public.fin_import_sources (clinic_id, source_key, source_kind, link_kind, fingerprint, file_name,
                                               entry_id, payment_id, batch_id, txn_date, amount_cents, origin,
                                               imported_by)
        VALUES (v_clinic, v_key, v_kind, CASE WHEN v_is_match THEN 'payment_match' ELSE 'entry' END,
                CASE WHEN v_is_match THEN NULL ELSE v_fp END, v_file, v_res_entry, v_res_payment, v_batch_id, v_date,
                v_amount, 'runtime', v_user);
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF coalesce(v_constraint, '') LIKE 'fin\_payments%' THEN
          PERFORM public.fin__row_raise(v_ctx,
            'Bu ödeme numarası başka bir kayda ait. Sayfayı yenileyip tekrar deneyin.', 'PT409', v_detail);
        END IF;
        PERFORM public.fin__row_raise(v_ctx, 'Kayıt kaydedilemedi. Hiçbir kayıt aktarılmadı.', 'PT409', v_detail);
      WHEN raise_exception THEN
        -- Messages of this RPC already carry the row context; shared 0020 helpers (fin__entry_input,
        -- fin__check_account, guard triggers) get it here, with the same SQLSTATE.
        IF left(SQLERRM, char_length(v_ctx) + 1) = v_ctx || ':' OR SQLERRM LIKE 'Aynı borca bu aktarımda%' THEN
          RAISE;
        END IF;
        PERFORM public.fin__row_raise(v_ctx, SQLERRM || ' Hiçbir kayıt aktarılmadı.', 'P0001', v_detail);
    END;

    v_new_payments := array_append(v_new_payments, v_res_payment);
    IF v_status = 'matched' THEN
      v_matched := v_matched + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row_no', v_row_no, 'key', v_key, 'status', v_status, 'entry_id', v_res_entry, 'payment_id', v_res_payment)
      || CASE WHEN v_closed IS NOT NULL THEN jsonb_build_object('remainder_closed_cents', v_closed)
              ELSE '{}'::jsonb END);
  END LOOP;

  -- Step 8: receipt reconciliation of the batch month (restores fin.ctx to 'import' when it returns).
  IF v_any_receipts THEN
    v_rec := public.fin__reconcile_receipts_month(v_clinic, v_month);
    v_rec_out := jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM'),
      'equivalent', v_rec -> 'equivalent',
      'through', v_rec -> 'through',
      'excluded_count', jsonb_array_length(v_rec -> 'excluded_ids'),
      'manual_total_cents', v_rec -> 'manual_total_cents',
      'imported_total_cents', v_rec -> 'imported_total_cents');
  END IF;

  -- Step 9: the batch row (the deferred FK of fin_import_sources.batch_id is satisfied at commit).
  v_result := jsonb_build_object(
    'inserted', v_inserted,
    'matched', v_matched,
    'skipped', v_skipped,
    'acknowledged', v_ack,
    'rows', v_results,
    'reconciliation', v_rec_out);
  BEGIN
    INSERT INTO public.fin_import_batches (id, clinic_id, kind, month, file_names, layout_ids, rows_sent, inserted,
                                           matched, skipped, acknowledged, result, created_by)
    VALUES (v_batch_id, v_clinic, 'rows', v_month, v_files, v_layouts, v_rows_n, v_inserted, v_matched, v_skipped,
            v_ack, v_result, v_user);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Aktarım kaydedilemedi.' USING ERRCODE = 'PT409';
  END;

  RETURN v_result || jsonb_build_object('already_saved', false,
                                        'batch', public.fin__batch_json(v_clinic, v_batch_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges. fin__harden_privileges() (0022): every fin_* function revoked from PUBLIC / anon / authenticated,
--    public RPCs (fin_debt_candidates_batch, fin_import_check, fin_import_rows) granted to authenticated, internals
--    (fin__debt_kind, fin__debt_open_entries, fin__debt_match, fin__open_debts) never; plus its self-checks over every
--    fin_* function (no overloads) and table.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

-- ---------------------------------------------------------------------------
-- 7.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_j jsonb;
  v_n integer;
  v_fail text[] := '{}'::text[];
BEGIN
  -- 1. Signatures: the new functions and the replaced / kept ones exist once (no overload).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin__debt_kind(bigint,bigint)',
    'public.fin__debt_open_entries(uuid)',
    'public.fin__debt_match(uuid,jsonb)',
    'public.fin__open_debts(uuid,jsonb)',
    'public.fin_debt_candidates_batch(jsonb)',
    'public.fin_import_check(text,jsonb)',
    'public.fin_import_rows(jsonb,jsonb)',
    'public.fin__debt_candidates(uuid,bigint,date,text)',
    'public.fin_debt_candidates(bigint,date,text,integer)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fin__debt_kind', 'fin__debt_open_entries', 'fin__debt_match', 'fin__open_debts',
                             'fin_debt_candidates_batch', 'fin_import_check', 'fin_import_rows',
                             'fin__debt_candidates', 'fin_debt_candidates')) <> 9 THEN
    RAISE EXCEPTION 'Borç eşleştirme fonksiyon imzaları beklenen gibi değil: %', coalesce(v_bad, 'aşırı yükleme var');
  END IF;

  -- 2. The helpers stay internal (SECURITY INVOKER, not callable from the API); the RPCs keep SECURITY DEFINER +
  --    search_path, callable by authenticated, never by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__debt_kind', 'fin__debt_open_entries', 'fin__debt_match', 'fin__open_debts')
    AND (p.prosecdef
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç borç eşleştirme fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_debt_candidates_batch', 'fin_import_check', 'fin_import_rows', 'fin_debt_candidates')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Aktarım RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. The link constraint: validated, with the clinic workbook expense keys.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conrelid = 'public.fin_import_sources'::regclass AND c.conname = 'fin_import_sources_link'
                   AND c.contype = 'c' AND c.convalidated
                   AND pg_get_constraintdef(c.oid) LIKE '%clinic_excel%expense%') THEN
    RAISE EXCEPTION 'fin_import_sources_link beklenen gibi değil.';
  END IF;

  -- 4. The amount rule at its edges (1.000,00 TL = 100000 cents; 2 % of the outstanding).
  SELECT string_agg(format('%s / %s → %s (beklenen %s)', x.a, x.o, coalesce(public.fin__debt_kind(x.a, x.o), 'NULL'),
                           coalesce(x.k, 'NULL')), ', ')
    INTO v_bad
  FROM (VALUES
    (100000::bigint, 100000::bigint, 'exact'),
    (4181800, 4200000, 'near'),
    (5900000, 6000000, 'near'),
    (5899999, 6000000, 'partial'),
    (980000, 1000000, 'near'),
    (979999, 1000000, 'partial'),
    (1, 2, 'partial'),
    (3020000, 3000000, 'higher'),
    (6100000, 6000000, 'higher'),
    (6100001, 6000000, NULL),
    (1020000, 1000000, 'higher'),
    (1020001, 1000000, NULL),
    (2, 1, NULL),
    (1, 1, 'exact'),
    (NULL, 100, NULL),
    (100, NULL, NULL),
    (100, 0, NULL),
    (0, 100, NULL)
  ) AS x(a, o, k)
  WHERE public.fin__debt_kind(x.a, x.o) IS DISTINCT FROM x.k;
  IF v_bad IS NOT NULL THEN
    v_fail := array_append(v_fail, 'tutar kuralı: ' || v_bad);
  END IF;

  -- 5. A clinic without debts: no open debt, no suggestion (runs every query of the helpers once).
  v_j := public.fin__open_debts(gen_random_uuid(), jsonb_build_array(jsonb_build_object(
           'kind', 'bank_known', 'key', 'bank:A:B:2024-01-02:1', 'date', '2024-01-02', 'amount_cents', 100,
           'direction', 'out')));
  IF v_j IS DISTINCT FROM '{}'::jsonb OR public.fin__open_debts(gen_random_uuid(), 'null'::jsonb) <> '{}'::jsonb THEN
    v_fail := array_append(v_fail, 'boş klinik açık borç: ' || coalesce(v_j::text, '-'));
  END IF;
  SELECT count(*) INTO v_n
  FROM public.fin__debt_match(gen_random_uuid(), jsonb_build_array(jsonb_build_object(
         'o', 1, 'amount_cents', 100, 'day', '2024-01-02', 'txt', 'x', 'category_id', NULL, 'counterparty_id', NULL)));
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, 'boş klinik borç önerisi');
  END IF;

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'Borç eşleştirme yapı denetimi: %', array_to_string(v_fail, ' | ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7.2 Replay inside a block that is always rolled back: temporary clinic 'p37-test-selfcheck-<random>' with an owner
--     O ('finance'), a 'finance_readonly' assistant R and a reception user B (no finance), and a second temporary
--     clinic with one debt (another clinic's data). Made-up names, keys and amounts only; every day lies in the
--     previous month; auth.uid() is simulated through request.jwt.claims (and request.jwt.claim.sub / .role), as in
--     0030 – 0036. Debts entered by O through fin_create_entry: Lab Alfa 12.500 TL (lab, linked to its counterparty
--     master), Vergi Dairesi 42.000 (tax), SGK 30.000 (tax), Kira Beta 20.000 (rent), Tedarik Gama 7.000 (other),
--     Ortak Delta 4.000 twice (supplies), Hariç Epsilon 3.500 (excluded from totals), Fazla Teta 1.000 (other) and a
--     patient financing fee entry of 1.200 with its financing row.
--     Checked: fin_debt_candidates_batch (exact / near / partial / higher, strong by name, by counterparty master or
--     by category, an excluded debt never strong, the closer of two rows pre-selected, a tie and two strong
--     candidates pre-selecting nothing, the financing entry and the other clinic's debt never listed, the reason
--     texts, validation, finance_readonly and reception refused); fin_debt_candidates unchanged; fin_import_check's
--     open_debt (bank, bank table and workbook expense rows; never on inflows, receipts, a debt below the payment,
--     a financing entry or another clinic's debt; match_entry_id); fin_import_rows: the workbook cash row matched
--     (payment on the debt with the cash account, no new entry, key bound, re-import matched_same / skipped_matched),
--     bank rows matched, close_remainder (the rest cancelled like fin_cancel_entry and audited; refused without a
--     match and when nothing would be left), the open-debt confirmation (refused without it, saved and counted with
--     it, ignored on a matched row), the 0022 refusals (overpayment, two rows on one debt, stale version, financing
--     entry, another clinic's debt, bank row on a cash account) and the receipts row refused; a partial match in the
--     same request (two more debts, Sigorta Kappa 50.000 and Muhasebe Mu 80.000: the other row is compared with the
--     rest left open, in the preflight and in the save, refused without the confirmation and saved with it; a
--     close_remainder or full match settles the debt for the other rows; close_remainder of the preflight must be a
--     boolean); then the deferred import-source checks are fired before the rollback. Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p37-test-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_today date := public.clinic_today();
  v_m0 date;
  v_month text;
  v_clinic uuid := gen_random_uuid();
  v_clinic2 uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_ro uuid := gen_random_uuid();
  v_ro_auth uuid := gen_random_uuid();
  v_rc uuid := gen_random_uuid();
  v_rc_auth uuid := gen_random_uuid();
  v_cp_lab uuid := gen_random_uuid();
  v_bank uuid;
  v_cash uuid;
  v_cat_lab uuid;
  v_cat_tax uuid;
  v_cat_rent uuid;
  v_cat_other uuid;
  v_cat_sup uuid;
  v_cat_fees uuid;
  v_cat2_lab uuid;
  v_e_lab uuid := gen_random_uuid();
  v_e_tax uuid := gen_random_uuid();
  v_e_sgk uuid := gen_random_uuid();
  v_e_rent uuid := gen_random_uuid();
  v_e_tie uuid := gen_random_uuid();
  v_e_m1 uuid := gen_random_uuid();
  v_e_m2 uuid := gen_random_uuid();
  v_e_exc uuid := gen_random_uuid();
  v_e_over uuid := gen_random_uuid();
  v_e_fin uuid := gen_random_uuid();
  v_e_other uuid := gen_random_uuid();
  v_e_kap uuid := gen_random_uuid();
  v_e_mu uuid := gen_random_uuid();
  v_e_x uuid;
  v_p_lab uuid := gen_random_uuid();
  v_p_tax uuid := gen_random_uuid();
  v_p_tie uuid := gen_random_uuid();
  v_k_lab text;
  v_k_tax text;
  v_k_tie text;
  v_k_sgk text;
  v_k_ack text;
  v_k_r1 text;
  v_kk text[];
  v_bank_key text;
  v_brow jsonb;
  v_crow jsonb;
  v_rows jsonb;
  v_j jsonb;
  v_x jsonb;
  v_payloads jsonb[];
  v_msgs text[];
  v_states text[];
  v_i integer;
  v_err text;
  v_state text;
  v_detail text;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  -- Day n of the previous month is v_m0 + (n - 1): every row is in one import month and not in the future.
  v_m0 := (public.fin__month_start(v_today) - interval '1 month')::date;
  v_month := to_char(v_m0, 'YYYY-MM');
  v_bank_key := 'bank:Ornek:hesap1:';
  v_k_lab := 'clinic:' || public.fin__iso_date(v_m0 + 11) || ':expense:1';
  v_k_tax := v_bank_key || public.fin__iso_date(v_m0 + 19) || ':t2';
  v_k_tie := v_bank_key || public.fin__iso_date(v_m0 + 13) || ':t3';
  v_k_sgk := v_bank_key || public.fin__iso_date(v_m0 + 14) || ':t4';
  v_k_ack := v_bank_key || public.fin__iso_date(v_m0 + 8) || ':t5';
  v_k_r1 := v_bank_key || public.fin__iso_date(v_m0 + 21) || ':r1';
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES
      (v_clinic, 'Öz denetim P37', v_slug), (v_clinic2, 'Öz denetim P37 B', v_slug || '-b');
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p37-sc-own-' || v_tag || '@example.invalid', true),
      (v_ro, v_clinic, v_ro_auth, 'assistant', 'Öz denetim izleyici', 'p37-sc-ro-' || v_tag || '@example.invalid',
       true),
      (v_rc, v_clinic, v_rc_auth, 'reception', 'Öz denetim banko', 'p37-sc-rc-' || v_tag || '@example.invalid', true);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own), (v_clinic, v_ro, 'finance_readonly', v_own);
    INSERT INTO public.fin_counterparties (id, clinic_id, name, normalized_name, kind, note, is_active) VALUES
      (v_cp_lab, v_clinic, 'Lab Alfa', public.fin__normalize_name('Lab Alfa'), 'lab', '', true);

    SELECT a.id INTO v_bank FROM public.fin_accounts a
    WHERE a.clinic_id = v_clinic AND a.kind = 'bank' AND a.is_active ORDER BY a.sort_order, a.id LIMIT 1;
    SELECT a.id INTO v_cash FROM public.fin_accounts a
    WHERE a.clinic_id = v_clinic AND a.kind = 'cash' AND a.is_active ORDER BY a.sort_order, a.id LIMIT 1;
    SELECT c.id INTO v_cat_lab FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'lab';
    SELECT c.id INTO v_cat_tax FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'tax';
    SELECT c.id INTO v_cat_rent FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'rent';
    SELECT c.id INTO v_cat_other FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'other_expense';
    SELECT c.id INTO v_cat_sup FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'supplies';
    SELECT c.id INTO v_cat_fees FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.is_system AND c.report_bucket = 'fees';
    SELECT c.id INTO v_cat2_lab FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic2 AND c.is_system AND c.report_bucket = 'lab';
    IF v_bank IS NULL OR v_cash IS NULL OR v_cat_lab IS NULL OR v_cat_tax IS NULL OR v_cat_rent IS NULL
       OR v_cat_other IS NULL OR v_cat_sup IS NULL OR v_cat_fees IS NULL OR v_cat2_lab IS NULL THEN
      RAISE EXCEPTION 'Öz denetim: yeni kliniğin finans tohumları (hesaplar / sistem kategorileri) eksik.';
    END IF;

    -- The other clinic's debt: the same name as a debt of this clinic, the amount of row 11 below.
    INSERT INTO public.fin_entries (id, clinic_id, category_id, counterparty_text, description, due_date, amount_cents)
    VALUES (v_e_other, v_clinic2, v_cat2_lab, 'Lab Alfa', 'Öz denetim başka klinik', v_m0 + 11, 990000);

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;

    -- The debts entered by hand (planned, nothing paid). 'Lab Alfa' resolves to its counterparty master.
    PERFORM public.fin_create_entry(v_e_lab, v_cat_lab, NULL, NULL, 'Lab Alfa', 'Öz denetim lab faturası',
                                    v_m0 + 11, 1250000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_tax, v_cat_tax, NULL, NULL, 'Vergi Dairesi', 'Öz denetim stopaj',
                                    v_m0 + 19, 4200000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_sgk, v_cat_tax, NULL, NULL, 'SGK', 'Öz denetim SGK primi',
                                    v_m0 + 14, 3000000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_rent, v_cat_rent, NULL, NULL, 'Kira Beta', 'Öz denetim kira',
                                    v_m0 + 9, 2000000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_tie, v_cat_other, NULL, NULL, 'Tedarik Gama', 'Öz denetim tedarik',
                                    v_m0 + 15, 700000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_m1, v_cat_sup, NULL, NULL, 'Ortak Delta', 'Öz denetim sarf 1',
                                    v_m0 + 4, 400000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_m2, v_cat_sup, NULL, NULL, 'Ortak Delta', 'Öz denetim sarf 2',
                                    v_m0 + 6, 400000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_exc, v_cat_other, NULL, NULL, 'Hariç Epsilon', 'Öz denetim toplam dışı',
                                    v_m0 + 7, 350000, NULL, false, NULL);
    PERFORM public.fin_set_exclusion(v_e_exc, 1, true, 'Öz denetim toplam dışı');
    PERFORM public.fin_create_entry(v_e_over, v_cat_other, NULL, NULL, 'Fazla Teta', 'Öz denetim küçük borç',
                                    v_m0 + 21, 100000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_fin, v_cat_fees, NULL, NULL, 'Finansman Eta', 'Öz denetim finansman kesintisi',
                                    v_m0 + 2, 120000, NULL, false, NULL);
    INSERT INTO public.fin_patient_financing (id, clinic_id, provider, reference, patient_name_raw, patient_id,
                                              txn_date, currency, gross_cents, commission_cents, kkdf_cents,
                                              bsmv_cents, blocked, expected_release, entry_id, created_by, updated_by)
    VALUES (gen_random_uuid(), v_clinic, 'burgan', '1-3700001-1', 'HASTA ETA', NULL, v_m0 + 2, 'TRY', 2000000,
            100000, 10000, 10000, false, NULL, v_e_fin, v_own, v_own);
    IF (SELECT e.counterparty_id FROM public.fin_entries e WHERE e.id = v_e_lab) IS DISTINCT FROM v_cp_lab THEN
      RAISE EXCEPTION 'Öz denetim: Lab Alfa borcu kişi / kurum kaydına bağlanmadı.';
    END IF;

    -- fin_debt_candidates_batch: twelve outflow rows of one review.
    v_rows := jsonb_build_array(
      jsonb_build_object('row_no', 1, 'amount_cents', 1250000, 'date', v_m0 + 11, 'text', 'LAB ALFA NAKIT ODEME',
                         'category_id', v_cat_lab),
      jsonb_build_object('row_no', 2, 'amount_cents', 4181800, 'date', v_m0 + 19, 'text', 'VERGI DAIRESI ODEME',
                         'category_id', v_cat_tax),
      jsonb_build_object('row_no', 3, 'amount_cents', 3020000, 'date', v_m0 + 14, 'text', 'SGK PRIM ODEMESI',
                         'category_id', v_cat_tax),
      jsonb_build_object('row_no', 4, 'amount_cents', 2000000, 'date', v_m0 + 8, 'text', 'KIRA BETA ODEME',
                         'category_id', v_cat_rent),
      jsonb_build_object('row_no', 5, 'amount_cents', 2000000, 'date', v_m0 + 13, 'text', 'KIRA BETA ODEME',
                         'category_id', v_cat_rent),
      jsonb_build_object('row_no', 6, 'amount_cents', 700000, 'date', v_m0 + 13, 'text', 'TEDARIK GAMA',
                         'category_id', v_cat_other),
      jsonb_build_object('row_no', 7, 'amount_cents', 700000, 'date', v_m0 + 17, 'text', 'TEDARIK GAMA',
                         'category_id', v_cat_other),
      jsonb_build_object('row_no', 8, 'amount_cents', 400000, 'date', v_m0 + 5, 'text', 'ORTAK DELTA',
                         'category_id', v_cat_sup),
      jsonb_build_object('row_no', 9, 'amount_cents', 350000, 'date', v_m0 + 7, 'text', 'HARIC EPSILON',
                         'category_id', v_cat_other),
      jsonb_build_object('row_no', 10, 'amount_cents', 120000, 'date', v_m0 + 2, 'text', 'FINANSMAN ETA',
                         'category_id', v_cat_fees),
      jsonb_build_object('row_no', 11, 'amount_cents', 990000, 'date', v_m0 + 11, 'text', 'LAB ALFA ODEME',
                         'category_id', v_cat_lab),
      jsonb_build_object('row_no', 12, 'amount_cents', 1250000, 'date', v_m0 + 12, 'text', 'NAKIT ODEME',
                         'counterparty_id', v_cp_lab));
    v_j := public.fin_debt_candidates_batch(v_rows);
    SELECT jsonb_object_agg(t.x ->> 'row_no', t.x) INTO v_x FROM jsonb_array_elements(v_j -> 'rows') AS t(x);
    IF (SELECT string_agg(t.x ->> 'row_no', ',' ORDER BY t.n)
        FROM jsonb_array_elements(v_j -> 'rows') WITH ORDINALITY AS t(x, n))
         IS DISTINCT FROM '1,2,3,4,5,6,7,8,9,10,11,12'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rows') AS t(x)
                  WHERE jsonb_array_length(t.x -> 'candidates') > 5) THEN
      v_fail := array_append(v_fail, 'öneri satırları: ' || left(v_j::text, 500));
    END IF;
    -- 1: the workbook cash payment of Lab Alfa: exact, strong (name + category), pre-selected; the closer of rows 1
    --    and 12 (both have it as their only strong candidate).
    IF v_x #>> '{1,preselect_entry_id}' IS DISTINCT FROM v_e_lab::text
       OR v_x #>> '{1,candidates,0,entry,id}' IS DISTINCT FROM v_e_lab::text
       OR (v_x #>> '{1,candidates,0,entry,version}')::integer IS DISTINCT FROM 1
       OR v_x #>> '{1,candidates,0,kind}' IS DISTINCT FROM 'exact'
       OR (v_x #>> '{1,candidates,0,strong}')::boolean IS DISTINCT FROM true
       OR v_x #>> '{1,candidates,0,reason}'
            IS DISTINCT FROM 'Tutar aynı · kişi / kurum eşleşiyor · aynı kategori · vade günü'
       OR (v_x #>> '{1,strong_count}')::integer IS DISTINCT FROM 1
       OR (v_x #>> '{1,total_count}')::integer IS DISTINCT FROM 4
       OR v_x #> '{1,higher}' IS DISTINCT FROM 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'öneri 1 (tam tutar): ' || left((v_x -> '1')::text, 700));
    END IF;
    -- 2: 182,00 TL below the tax debt: near, strong, pre-selected.
    IF v_x #>> '{2,preselect_entry_id}' IS DISTINCT FROM v_e_tax::text
       OR v_x #>> '{2,candidates,0,kind}' IS DISTINCT FROM 'near'
       OR (v_x #>> '{2,candidates,0,remainder_cents}')::bigint IS DISTINCT FROM 18200
       OR (v_x #>> '{2,candidates,0,excess_cents}')::bigint IS DISTINCT FROM 0
       OR v_x #>> '{2,candidates,0,reason}' IS DISTINCT FROM
            'Tutar yakın, kalan 182,00 TL · kişi / kurum eşleşiyor · aynı kategori · vade günü'
       OR (v_x #>> '{2,total_count}')::integer IS DISTINCT FROM 1 THEN
      v_fail := array_append(v_fail, 'öneri 2 (yakın tutar): ' || left((v_x -> '2')::text, 700));
    END IF;
    -- 3: 200,00 TL above the SGK debt: only the 'higher' near miss, never a candidate, nothing pre-selected.
    IF v_x #>> '{3,preselect_entry_id}' IS NOT NULL
       OR (v_x #>> '{3,strong_count}')::integer IS DISTINCT FROM 0
       OR v_x #>> '{3,higher,entry,id}' IS DISTINCT FROM v_e_sgk::text
       OR v_x #>> '{3,higher,kind}' IS DISTINCT FROM 'higher'
       OR (v_x #>> '{3,higher,excess_cents}')::bigint IS DISTINCT FROM 20000
       OR (v_x #>> '{3,higher,strong}')::boolean IS DISTINCT FROM false
       OR v_x #>> '{3,higher,reason}' IS DISTINCT FROM
            'Ödeme borçtan 200,00 TL fazla · kişi / kurum eşleşiyor · aynı kategori · vade günü'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x #> '{3,candidates}') AS c(v)
                  WHERE c.v #>> '{entry,id}' = v_e_sgk::text) THEN
      v_fail := array_append(v_fail, 'öneri 3 (borçtan fazla): ' || left((v_x -> '3')::text, 700));
    END IF;
    -- 4 / 5: one debt as the only strong candidate of two rows: the closer row (1 day) gets it, the other none.
    IF v_x #>> '{4,preselect_entry_id}' IS DISTINCT FROM v_e_rent::text
       OR v_x #>> '{5,preselect_entry_id}' IS NOT NULL
       OR (v_x #>> '{5,strong_count}')::integer IS DISTINCT FROM 1
       OR v_x #>> '{5,candidates,0,entry,id}' IS DISTINCT FROM v_e_rent::text
       OR (v_x #>> '{5,candidates,0,strong}')::boolean IS DISTINCT FROM true THEN
      v_fail := array_append(v_fail,
                             'öneri 4 / 5 (yakın satır): ' || left((v_x -> '4')::text || (v_x -> '5')::text, 900));
    END IF;
    -- 6 / 7: the same distance on both sides of the due date: a tie, nothing pre-selected.
    IF v_x #>> '{6,preselect_entry_id}' IS NOT NULL
       OR v_x #>> '{7,preselect_entry_id}' IS NOT NULL
       OR (v_x #>> '{6,strong_count}')::integer IS DISTINCT FROM 1
       OR (v_x #>> '{7,strong_count}')::integer IS DISTINCT FROM 1
       OR v_x #>> '{6,candidates,0,entry,id}' IS DISTINCT FROM v_e_tie::text
       OR v_x #>> '{7,candidates,0,entry,id}' IS DISTINCT FROM v_e_tie::text THEN
      v_fail := array_append(v_fail, 'öneri 6 / 7 (eşitlik): ' || left((v_x -> '6')::text || (v_x -> '7')::text, 900));
    END IF;
    -- 8: two strong candidates: nothing pre-selected; the earlier due date first.
    IF v_x #>> '{8,preselect_entry_id}' IS NOT NULL
       OR (v_x #>> '{8,strong_count}')::integer IS DISTINCT FROM 2
       OR v_x #>> '{8,candidates,0,entry,id}' IS DISTINCT FROM v_e_m1::text
       OR v_x #>> '{8,candidates,1,entry,id}' IS DISTINCT FROM v_e_m2::text
       OR jsonb_array_length(v_x #> '{8,candidates}') <> 5
       OR (v_x #>> '{8,total_count}')::integer IS DISTINCT FROM 7 THEN
      v_fail := array_append(v_fail, 'öneri 8 (iki güçlü aday): ' || left((v_x -> '8')::text, 700));
    END IF;
    -- 9: an excluded debt is listed but never strong.
    IF v_x #>> '{9,preselect_entry_id}' IS NOT NULL
       OR (v_x #>> '{9,strong_count}')::integer IS DISTINCT FROM 0
       OR v_x #>> '{9,candidates,0,entry,id}' IS DISTINCT FROM v_e_exc::text
       OR v_x #>> '{9,candidates,0,kind}' IS DISTINCT FROM 'exact'
       OR (v_x #>> '{9,candidates,0,strong}')::boolean IS DISTINCT FROM false
       OR (v_x #>> '{9,candidates,0,entry,excluded_from_totals}')::boolean IS DISTINCT FROM true
       OR v_x #>> '{9,candidates,0,reason}' NOT LIKE '% · toplam dışı kayıt' THEN
      v_fail := array_append(v_fail, 'öneri 9 (toplam dışı): ' || left((v_x -> '9')::text, 700));
    END IF;
    -- 10: the financing fee entry is never a candidate (the eight other debts are).
    IF (v_x #>> '{10,total_count}')::integer IS DISTINCT FROM 8
       OR v_x #> '{10,higher}' IS DISTINCT FROM 'null'::jsonb
       OR strpos(v_j::text, v_e_fin::text) > 0 THEN
      v_fail := array_append(v_fail, 'öneri 10 (finansman): ' || left((v_x -> '10')::text, 700));
    END IF;
    -- 11: another clinic's debt of the same name and amount is never listed; this clinic's Lab Alfa is a partial.
    IF v_x #>> '{11,candidates,0,entry,id}' IS DISTINCT FROM v_e_lab::text
       OR v_x #>> '{11,candidates,0,kind}' IS DISTINCT FROM 'partial'
       OR (v_x #>> '{11,candidates,0,strong}')::boolean IS DISTINCT FROM false
       OR (v_x #>> '{11,total_count}')::integer IS DISTINCT FROM 4
       OR strpos(v_j::text, v_e_other::text) > 0 THEN
      v_fail := array_append(v_fail, 'öneri 11 (başka klinik): ' || left((v_x -> '11')::text, 700));
    END IF;
    -- 12: strong through the counterparty master alone (no name, no category); row 1 is closer.
    IF v_x #>> '{12,preselect_entry_id}' IS NOT NULL
       OR (v_x #>> '{12,strong_count}')::integer IS DISTINCT FROM 1
       OR v_x #>> '{12,candidates,0,entry,id}' IS DISTINCT FROM v_e_lab::text
       OR (v_x #>> '{12,candidates,0,strong}')::boolean IS DISTINCT FROM true
       OR v_x #>> '{12,candidates,0,reason}'
            IS DISTINCT FROM 'Tutar aynı · aynı kişi / kurum · vadeden 1 gün sonra' THEN
      v_fail := array_append(v_fail, 'öneri 12 (kişi / kurum kaydı): ' || left((v_x -> '12')::text, 700));
    END IF;

    -- fin_debt_candidates (the full list of one row) is unchanged: same keys, same score and reason.
    v_j := public.fin_debt_candidates(2000000, v_m0 + 8, 'KIRA BETA ODEME', 50);
    IF v_j #>> '{candidates,0,entry,id}' IS DISTINCT FROM v_e_rent::text
       OR (v_j #>> '{candidates,0,suggested}')::boolean IS DISTINCT FROM true
       OR (v_j #>> '{candidates,0,score}')::integer IS DISTINCT FROM 130
       OR v_j #>> '{candidates,0,reason}' IS DISTINCT FROM 'Kişi / kurum eşleşiyor · tutar aynı'
       OR (SELECT array_agg(k.name ORDER BY k.name) FROM jsonb_object_keys(v_j #> '{candidates,0}') AS k(name))
            IS DISTINCT FROM ARRAY['entry', 'reason', 'score', 'suggested']
       OR (v_j ->> 'total_count')::integer IS DISTINCT FROM 3 THEN
      v_fail := array_append(v_fail, 'fin_debt_candidates: ' || left(v_j::text, 700));
    END IF;

    -- Validation of the batch call.
    v_payloads := ARRAY[
      '[]'::jsonb,
      (SELECT jsonb_agg(jsonb_build_object('row_no', g.n, 'amount_cents', 100, 'date', v_m0))
       FROM generate_series(1, 501) AS g(n)),
      jsonb_build_array(jsonb_build_object('row_no', 1, 'amount_cents', 100, 'date', v_m0),
                        jsonb_build_object('row_no', 1, 'amount_cents', 200, 'date', v_m0)),
      jsonb_build_array(jsonb_build_object('row_no', 1, 'amount_cents', 100, 'date', v_m0, 'key', 'x')),
      jsonb_build_array(jsonb_build_object('row_no', 1, 'amount_cents', 0, 'date', v_m0)),
      jsonb_build_array(jsonb_build_object('row_no', 1, 'amount_cents', 100, 'date', '2024-02-30')),
      jsonb_build_array(jsonb_build_object('row_no', 1, 'amount_cents', 100, 'date', v_m0, 'category_id', 'x')),
      jsonb_build_array(jsonb_build_object('row_no', 1, 'amount_cents', 100, 'date', v_m0, 'text', 5)),
      '{"row_no": 1}'::jsonb];
    FOR v_i IN 1 .. cardinality(v_payloads)
    LOOP
      v_err := NULL;
      BEGIN
        PERFORM public.fin_debt_candidates_batch(v_payloads[v_i]);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM (CASE WHEN v_i IN (1, 2, 9)
                                      THEN 'Borç önerisi için en az 1, en fazla 500 satır gönderilebilir.'
                                      ELSE 'Filtre değerleri geçersiz.' END) THEN
        v_fail := array_append(v_fail, format('öneri doğrulama %s: %s', v_i, coalesce(v_err, 'reddedilmedi')));
      END IF;
    END LOOP;

    -- Permissions: finance_readonly and reception cannot ask (finance writers only).
    FOR v_i IN 1 .. 2
    LOOP
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', CASE WHEN v_i = 1 THEN v_ro_auth ELSE v_rc_auth END,
                                           'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', (CASE WHEN v_i = 1 THEN v_ro_auth ELSE v_rc_auth END)::text, true);
      v_err := NULL;
      v_state := NULL;
      BEGIN
        PERFORM public.fin_debt_candidates_batch(jsonb_build_array(jsonb_build_object(
                  'row_no', 1, 'amount_cents', 1250000, 'date', v_m0 + 11)));
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      END;
      IF v_state IS DISTINCT FROM '42501' OR v_err IS DISTINCT FROM 'Bu işlem için finans yetkisi gerekir.' THEN
        v_fail := array_append(v_fail, format('öneri yetkisi %s: %s / %s', CASE WHEN v_i = 1 THEN 'finance_readonly'
                                                                               ELSE 'banko' END,
                                              coalesce(v_state, '-'), coalesce(v_err, 'reddedilmedi')));
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);

    -- fin_import_check: open_debt on the unsaved outflows that would duplicate an open debt.
    v_brow := jsonb_build_object('kind', 'bank_known', 'direction', 'out');
    v_rows := jsonb_build_array(
      v_brow || jsonb_build_object('row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 8) || ':c1',
                                   'date', v_m0 + 8, 'amount_cents', 2000000),
      jsonb_build_object('row_no', 2, 'key', v_k_lab, 'kind', 'clinic_excel', 'date', v_m0 + 11,
                         'amount_cents', 1250000, 'direction', 'out'),
      v_brow || jsonb_build_object('row_no', 3, 'key', v_bank_key || public.fin__iso_date(v_m0 + 8) || ':c3',
                                   'date', v_m0 + 8, 'amount_cents', 2000000, 'direction', 'in'),
      v_brow || jsonb_build_object('row_no', 4, 'key', v_bank_key || public.fin__iso_date(v_m0 + 14) || ':c4',
                                   'date', v_m0 + 14, 'amount_cents', 3020000),
      jsonb_build_object('row_no', 5, 'key', 'bank-table:' || md5('p37a' || v_tag) || md5('p37b' || v_tag),
                         'kind', 'bank_table', 'date', v_m0 + 19, 'amount_cents', 4181800, 'direction', 'out'),
      v_brow || jsonb_build_object('row_no', 6, 'key', v_bank_key || public.fin__iso_date(v_m0 + 7) || ':c6',
                                   'date', v_m0 + 7, 'amount_cents', 350000),
      v_brow || jsonb_build_object('row_no', 7, 'key', v_bank_key || public.fin__iso_date(v_m0 + 2) || ':c7',
                                   'date', v_m0 + 2, 'amount_cents', 120000),
      v_brow || jsonb_build_object('row_no', 8, 'key', v_bank_key || public.fin__iso_date(v_m0 + 11) || ':c8',
                                   'date', v_m0 + 11, 'amount_cents', 990000),
      jsonb_build_object('row_no', 9, 'key', 'clinic:' || public.fin__iso_date(v_m0 + 11) || ':receipts',
                         'kind', 'clinic_excel', 'date', v_m0 + 11, 'amount_cents', 2000000, 'direction', 'in'),
      v_brow || jsonb_build_object('row_no', 10, 'key', v_bank_key || public.fin__iso_date(v_m0 + 5) || ':c10',
                                   'date', v_m0 + 5, 'amount_cents', 400000));
    v_j := public.fin_import_check(v_month, v_rows);
    SELECT jsonb_object_agg(t.x ->> 'row_no', t.x) INTO v_x FROM jsonb_array_elements(v_j -> 'rows') AS t(x);
    SELECT string_agg(format('%s: %s ≠ %s', e.n, coalesce(a.got, '-'), coalesce(e.want, '-')), ', ')
      INTO v_err
    FROM (VALUES (1, v_e_rent::text), (2, v_e_lab::text), (3, NULL), (4, NULL), (5, v_e_tax::text),
                 (6, v_e_exc::text), (7, NULL), (8, NULL), (9, NULL), (10, v_e_m1::text || '+' || v_e_m2::text))
           AS e(n, want)
    LEFT JOIN LATERAL (
      SELECT string_agg(d.v ->> 'entry_id', '+' ORDER BY d.o) AS got
      FROM jsonb_array_elements(v_x #> ARRAY[e.n::text, 'warnings']) AS w(v)
      CROSS JOIN LATERAL jsonb_array_elements(w.v -> 'debts') WITH ORDINALITY AS d(v, o)
      WHERE w.v ->> 'code' = 'open_debt'
    ) a ON true
    WHERE a.got IS DISTINCT FROM e.want;
    IF v_err IS NOT NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rows') AS t(x) WHERE t.x ->> 'status' <> 'new')
       OR (SELECT w.v -> 'debts' -> 0 FROM jsonb_array_elements(v_x #> '{2,warnings}') AS w(v)
           WHERE w.v ->> 'code' = 'open_debt')
            IS DISTINCT FROM jsonb_build_object('entry_id', v_e_lab, 'version', 1, 'counterparty_name', 'Lab Alfa',
                                                'category_name', 'Laboratuvar', 'due_date', v_m0 + 11,
                                                'amount_cents', 1250000, 'outstanding_cents', 1250000,
                                                'kind', 'exact', 'days', 0)
       OR (SELECT w.v #>> '{debts,0,kind}' FROM jsonb_array_elements(v_x #> '{5,warnings}') AS w(v)
           WHERE w.v ->> 'code' = 'open_debt') IS DISTINCT FROM 'near' THEN
      v_fail := array_append(v_fail, 'kontrol open_debt: ' || coalesce(v_err, '') || ' ' || left(v_j::text, 900));
    END IF;
    -- A row with match_entry_id is a match: no open_debt for it, and the debt it pays in full counts for no other row.
    v_j := public.fin_import_check(v_month, jsonb_build_array(
             v_brow || jsonb_build_object('row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 8) || ':c1',
                                          'date', v_m0 + 8, 'amount_cents', 2000000),
             v_brow || jsonb_build_object('row_no', 2, 'key', v_bank_key || public.fin__iso_date(v_m0 + 13) || ':c2',
                                          'date', v_m0 + 13, 'amount_cents', 2000000, 'match_entry_id', v_e_rent)));
    IF jsonb_array_length(v_j -> 'rows') <> 2 OR strpos(v_j::text, 'open_debt') > 0 THEN
      v_fail := array_append(v_fail, 'kontrol match_entry_id: ' || left(v_j::text, 700));
    END IF;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_import_check(v_month, jsonb_build_array(
                v_brow || jsonb_build_object('row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 8) || ':c1',
                                             'date', v_m0 + 8, 'amount_cents', 2000000, 'match_entry_id', 'x')));
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Filtre değerleri geçersiz.' THEN
      v_fail := array_append(v_fail, 'kontrol match_entry_id doğrulaması: ' || coalesce(v_err, 'reddedilmedi'));
    END IF;

    -- fin_import_rows refusals (each call is refused as a whole and leaves nothing).
    v_brow := jsonb_build_object('kind', 'bank_known', 'file', 'oz-denetim-ekstre.pdf', 'direction', 'out',
                                 'currency', 'TRY', 'account_id', v_bank, 'acknowledged', '[]'::jsonb,
                                 'description', 'Öz denetim banka satırı');
    v_crow := jsonb_build_object('kind', 'clinic_excel', 'file', 'oz-denetim.xlsx', 'direction', 'out',
                                 'currency', 'TRY', 'account_id', v_cash, 'acknowledged', '[]'::jsonb,
                                 'description', 'Öz denetim klinik satırı');
    v_payloads := ARRAY[
      -- 1. close_remainder on a new entry.
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_k_r1, 'date', v_m0 + 21, 'amount_cents', 150000,
        'entry_id', public.fin__import_id(v_clinic, v_k_r1), 'fingerprint', md5(v_k_r1) || md5(v_k_r1 || '#'),
        'category_id', v_cat_other, 'counterparty_text', 'Öz denetim', 'close_remainder', true)),
      -- 2. close_remainder when the payment equals the outstanding.
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 9) || ':r2', 'date', v_m0 + 9,
        'amount_cents', 2000000, 'close_remainder', true,
        'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 3. overpayment (0022).
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 21) || ':r3', 'date', v_m0 + 21,
        'amount_cents', 150000,
        'match', jsonb_build_object('entry_id', v_e_over, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 4. two rows on one debt (0022).
      jsonb_build_array(
        v_brow || jsonb_build_object(
          'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 9) || ':r4a', 'date', v_m0 + 9,
          'amount_cents', 500000,
          'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid())),
        v_brow || jsonb_build_object(
          'row_no', 2, 'key', v_bank_key || public.fin__iso_date(v_m0 + 10) || ':r4b', 'date', v_m0 + 10,
          'amount_cents', 600000,
          'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 5. stale version (0022).
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 9) || ':r5', 'date', v_m0 + 9,
        'amount_cents', 500000,
        'match', jsonb_build_object('entry_id', v_e_rent, 'version', 7, 'payment_id', gen_random_uuid()))),
      -- 6. the financing fee entry (0022).
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 2) || ':r6', 'date', v_m0 + 2,
        'amount_cents', 120000,
        'match', jsonb_build_object('entry_id', v_e_fin, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 7. another clinic's debt (0022).
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 11) || ':r7', 'date', v_m0 + 11,
        'amount_cents', 990000,
        'match', jsonb_build_object('entry_id', v_e_other, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 8. a daily receipts row of the workbook.
      jsonb_build_array(v_crow || jsonb_build_object(
        'row_no', 1, 'key', 'clinic:' || public.fin__iso_date(v_m0 + 11) || ':receipts', 'date', v_m0 + 11,
        'amount_cents', 100000, 'direction', 'in',
        'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 9. a bank row on the cash account (0022).
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 9) || ':r9', 'date', v_m0 + 9,
        'amount_cents', 100000, 'account_id', v_cash,
        'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 10 / 11. flags that are not booleans.
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 9) || ':r10', 'date', v_m0 + 9,
        'amount_cents', 100000, 'close_remainder', 'evet',
        'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid()))),
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_bank_key || public.fin__iso_date(v_m0 + 9) || ':r11', 'date', v_m0 + 9,
        'amount_cents', 100000, 'ack_open_debt', 1,
        'match', jsonb_build_object('entry_id', v_e_rent, 'version', 1, 'payment_id', gen_random_uuid()))),
      -- 12. a new bank expense next to the rent debt of the same amount, without the confirmation.
      jsonb_build_array(v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_k_ack, 'date', v_m0 + 8, 'amount_cents', 2000000, 'description', 'KIRA BETA ODEME',
        'entry_id', public.fin__import_id(v_clinic, v_k_ack), 'fingerprint', md5(v_k_ack) || md5(v_k_ack || '#'),
        'category_id', v_cat_rent, 'counterparty_text', 'Kira Beta')),
      -- 13. a new workbook cash expense next to the lab debt of the same amount, without the confirmation.
      jsonb_build_array(v_crow || jsonb_build_object(
        'row_no', 1, 'key', v_k_lab, 'date', v_m0 + 11, 'amount_cents', 1250000,
        'entry_id', public.fin__import_id(v_clinic, v_k_lab), 'fingerprint', md5(v_k_lab) || md5(v_k_lab || '#'),
        'category_id', v_cat_lab, 'counterparty_text', 'Lab Alfa'))];
    v_msgs := ARRAY[
      'Kalan borcu kapatma yalnızca mevcut borca eşleştirilen satırda seçilebilir. Hiçbir kayıt aktarılmadı.',
      'Ödeme borcun kalanını tamamen kapatıyor; kalan borç kapatma seçilemez. Hiçbir kayıt aktarılmadı.',
      'Açık borcu ve kalan tutarı kontrol edin. Fazla ödeme eşleştirilemez.',
      'Aynı borca bu aktarımda tek banka satırı eşleştirin; sonraki ödemeyi yenilenen kalan tutarla aktarın.',
      'Borç başka ekranda değişti. Listeyi yenileyin.',
      'Açık borcu ve kalan tutarı kontrol edin. Fazla ödeme eşleştirilemez.',
      'Borç bulunamadı.',
      'Klinik Excel dosyasında yalnızca gider satırları açık borca eşleştirilebilir. Hiçbir kayıt aktarılmadı.',
      'banka satırı yalnızca banka veya POS türündeki bir hesaba işlenebilir.',
      'alan geçersiz.',
      'alan geçersiz.',
      'Aynı veya yakın tutarda açık borç var: Kira Beta · vade ' || to_char(v_m0 + 9, 'DD.MM.YYYY')
        || ' · kalan 20.000,00 TL. Satırı bu borca eşleştirin veya yeni gider olarak kaydetmeyi onaylayın (ödeme iki '
        || 'kez sayılır). Hiçbir kayıt aktarılmadı.',
      'Aynı veya yakın tutarda açık borç var: Lab Alfa · vade ' || to_char(v_m0 + 11, 'DD.MM.YYYY')
        || ' · kalan 12.500,00 TL.'];
    v_states := ARRAY['P0001', 'P0001', 'P0001', 'P0001', 'PT409', 'P0001', 'PT404', 'P0001', 'P0001', 'P0001',
                      'P0001', 'PT409', 'PT409'];
    FOR v_i IN 1 .. cardinality(v_payloads)
    LOOP
      v_err := NULL;
      v_state := NULL;
      v_detail := NULL;
      BEGIN
        PERFORM public.fin_import_rows(v_payloads[v_i], jsonb_build_object('id', gen_random_uuid(), 'month', v_month));
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
      END;
      IF v_err IS NULL OR strpos(v_err, v_msgs[v_i]) = 0 OR v_state IS DISTINCT FROM v_states[v_i]
         OR (v_i = 12 AND (nullif(v_detail, '')::jsonb ->> 'warning' IS DISTINCT FROM 'open_debt'
                           OR nullif(v_detail, '')::jsonb ->> 'entry_id' IS DISTINCT FROM v_e_rent::text)) THEN
        v_fail := array_append(v_fail, format('aktarım reddi %s: %s / %s / %s', v_i, coalesce(v_state, '-'),
                                              coalesce(v_err, 'reddedilmedi'), coalesce(v_detail, '-')));
      END IF;
    END LOOP;

    -- One save: the workbook cash payment of Lab Alfa matched, the tax payment matched with its remainder closed,
    -- a bank payment matched with an (ignored) confirmation, and the SGK payment above its debt as a new entry (a
    -- near miss above the debt needs no confirmation).
    v_j := public.fin_import_rows(jsonb_build_array(
             v_crow || jsonb_build_object(
               'row_no', 1, 'key', v_k_lab, 'date', v_m0 + 11, 'amount_cents', 1250000,
               'description', 'Lab Alfa nakit ödeme',
               'match', jsonb_build_object('entry_id', v_e_lab, 'version', 1, 'payment_id', v_p_lab)),
             v_brow || jsonb_build_object(
               'row_no', 2, 'key', v_k_tax, 'date', v_m0 + 19, 'amount_cents', 4181800,
               'description', 'VERGI DAIRESI ODEME', 'close_remainder', true,
               'match', jsonb_build_object('entry_id', v_e_tax, 'version', 1, 'payment_id', v_p_tax)),
             v_brow || jsonb_build_object(
               'row_no', 3, 'key', v_k_tie, 'date', v_m0 + 13, 'amount_cents', 700000,
               'description', 'TEDARIK GAMA', 'ack_open_debt', true,
               'match', jsonb_build_object('entry_id', v_e_tie, 'version', 1, 'payment_id', v_p_tie)),
             v_brow || jsonb_build_object(
               'row_no', 4, 'key', v_k_sgk, 'date', v_m0 + 14, 'amount_cents', 3020000,
               'description', 'SGK PRIM ODEMESI', 'entry_id', public.fin__import_id(v_clinic, v_k_sgk),
               'fingerprint', md5(v_k_sgk) || md5(v_k_sgk || '#'), 'category_id', v_cat_tax,
               'counterparty_text', 'SGK PRIM ODEMESI')),
           jsonb_build_object('id', gen_random_uuid(), 'month', v_month,
                              'file_names', jsonb_build_array('oz-denetim.xlsx', 'oz-denetim-ekstre.pdf')));
    IF (v_j ->> 'inserted')::integer IS DISTINCT FROM 1
       OR (v_j ->> 'matched')::integer IS DISTINCT FROM 3
       OR (v_j ->> 'skipped')::integer IS DISTINCT FROM 0
       OR (v_j ->> 'acknowledged')::integer IS DISTINCT FROM 0
       OR v_j #>> '{rows,0,status}' IS DISTINCT FROM 'matched'
       OR v_j #>> '{rows,0,entry_id}' IS DISTINCT FROM v_e_lab::text
       OR v_j #>> '{rows,0,payment_id}' IS DISTINCT FROM v_p_lab::text
       OR (v_j #> '{rows,0}') ? 'remainder_closed_cents'
       OR v_j #>> '{rows,1,status}' IS DISTINCT FROM 'matched'
       OR (v_j #>> '{rows,1,remainder_closed_cents}')::bigint IS DISTINCT FROM 18200
       OR v_j #>> '{rows,2,status}' IS DISTINCT FROM 'matched'
       OR v_j #>> '{rows,3,status}' IS DISTINCT FROM 'inserted'
       OR v_j #>> '{rows,3,entry_id}' IS DISTINCT FROM public.fin__import_id(v_clinic, v_k_sgk)::text THEN
      v_fail := array_append(v_fail, 'aktarım: ' || left(v_j::text, 1200));
    END IF;
    -- The workbook row: a payment on the hand-entered debt (cash account, row day, key), no new entry, key bound.
    IF NOT EXISTS (SELECT 1 FROM public.fin_payments p
                   WHERE p.id = v_p_lab AND p.clinic_id = v_clinic AND p.entry_id = v_e_lab AND p.account_id = v_cash
                     AND p.paid_on = v_m0 + 11 AND p.amount_cents = 1250000 AND p.voided_at IS NULL
                     AND p.bank_source_key = v_k_lab AND p.bank_source_file = 'oz-denetim.xlsx')
       OR EXISTS (SELECT 1 FROM public.fin_entries e
                  WHERE e.id = public.fin__import_id(v_clinic, v_k_lab)
                     OR (e.clinic_id = v_clinic AND e.source_key = v_k_lab))
       OR NOT EXISTS (SELECT 1 FROM public.fin_import_sources s
                      WHERE s.clinic_id = v_clinic AND s.source_key = v_k_lab AND s.source_kind = 'clinic_excel'
                        AND s.link_kind = 'payment_match' AND s.entry_id = v_e_lab AND s.payment_id = v_p_lab
                        AND s.fingerprint IS NULL)
       OR (SELECT s.status FROM public.fin__entries_state(v_clinic) s WHERE s.id = v_e_lab)
            IS DISTINCT FROM 'completed' THEN
      v_fail := array_append(v_fail, 'klinik Excel nakit satırı borca işlenmedi');
    END IF;
    -- The tax payment: matched, and the rest of the debt cancelled like fin_cancel_entry (audited).
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_e_tax AND e.cancelled_at IS NOT NULL AND e.cancelled_by = v_own
                     AND e.cancel_reason = 'Aktarımda kalan kapatıldı (oz-denetim-ekstre.pdf · satır 2)')
       OR (SELECT (s.status, s.paid_cents, s.outstanding_cents)::text FROM public.fin__entries_state(v_clinic) s
           WHERE s.id = v_e_tax) IS DISTINCT FROM '(cancelled,4181800,0)'
       OR NOT EXISTS (SELECT 1 FROM public.fin_payments p
                      WHERE p.id = v_p_tax AND p.entry_id = v_e_tax AND p.account_id = v_bank
                        AND p.bank_source_key = v_k_tax)
       OR NOT EXISTS (SELECT 1 FROM public.audit_logs al
                      WHERE al.clinic_id = v_clinic AND al.entity_type = 'fin_entries' AND al.entity_id = v_e_tax
                        AND al.action = 'update' AND al.user_id = v_own
                        AND al.changes ->> 'cancel_reason'
                              = 'Aktarımda kalan kapatıldı (oz-denetim-ekstre.pdf · satır 2)') THEN
      v_fail := array_append(v_fail, 'kalan borç kapatılmadı');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.fin_payments p
                   WHERE p.id = v_p_tie AND p.entry_id = v_e_tie AND p.amount_cents = 700000)
       OR (SELECT s.outstanding_cents FROM public.fin__entries_state(v_clinic) s WHERE s.id = v_e_sgk)
            IS DISTINCT FROM 3000000::bigint
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = public.fin__import_id(v_clinic, v_k_sgk) AND e.amount_cents = 3020000
                        AND e.source_key = v_k_sgk) THEN
      v_fail := array_append(v_fail, 'banka eşleşmesi / yeni gider kaydı');
    END IF;

    -- Re-import of the matched workbook row: the preflight shows it matched, the save skips it.
    v_j := public.fin_import_check(v_month, jsonb_build_array(jsonb_build_object(
             'row_no', 1, 'key', v_k_lab, 'kind', 'clinic_excel', 'date', v_m0 + 11, 'amount_cents', 1250000,
             'direction', 'out', 'fingerprint', md5(v_k_lab) || md5(v_k_lab || '#'))));
    IF v_j #>> '{rows,0,status}' IS DISTINCT FROM 'matched_same'
       OR jsonb_array_length(v_j #> '{rows,0,warnings}') <> 0
       OR v_j #>> '{rows,0,existing,entry_id}' IS DISTINCT FROM v_e_lab::text THEN
      v_fail := array_append(v_fail, 'yeniden kontrol: ' || left(v_j::text, 700));
    END IF;
    v_j := public.fin_import_rows(jsonb_build_array(v_crow || jsonb_build_object(
             'row_no', 1, 'key', v_k_lab, 'date', v_m0 + 11, 'amount_cents', 1250000,
             'description', 'Lab Alfa nakit ödeme', 'entry_id', public.fin__import_id(v_clinic, v_k_lab),
             'fingerprint', md5(v_k_lab) || md5(v_k_lab || '#'), 'category_id', v_cat_lab,
             'counterparty_text', 'Lab Alfa')),
           jsonb_build_object('id', gen_random_uuid(), 'month', v_month));
    IF v_j #>> '{rows,0,status}' IS DISTINCT FROM 'skipped_matched'
       OR (v_j ->> 'skipped')::integer IS DISTINCT FROM 1
       OR v_j #>> '{rows,0,payment_id}' IS DISTINCT FROM v_p_lab::text THEN
      v_fail := array_append(v_fail, 'yeniden aktarım: ' || left(v_j::text, 700));
    END IF;

    -- The confirmation given: the new expense is saved next to the open rent debt and counted as acknowledged.
    v_j := public.fin_import_rows(jsonb_build_array(v_brow || jsonb_build_object(
             'row_no', 1, 'key', v_k_ack, 'date', v_m0 + 8, 'amount_cents', 2000000, 'description', 'KIRA BETA ODEME',
             'entry_id', public.fin__import_id(v_clinic, v_k_ack), 'fingerprint', md5(v_k_ack) || md5(v_k_ack || '#'),
             'category_id', v_cat_rent, 'counterparty_text', 'Kira Beta', 'ack_open_debt', true)),
           jsonb_build_object('id', gen_random_uuid(), 'month', v_month));
    IF v_j #>> '{rows,0,status}' IS DISTINCT FROM 'inserted'
       OR (v_j ->> 'acknowledged')::integer IS DISTINCT FROM 1
       OR (SELECT s.outstanding_cents FROM public.fin__entries_state(v_clinic) s WHERE s.id = v_e_rent)
            IS DISTINCT FROM 2000000::bigint THEN
      v_fail := array_append(v_fail, 'açık borç onayı: ' || left(v_j::text, 700));
    END IF;

    -- A partial match leaves the rest of its debt open (fin__open_debts): another row of the same request that is
    -- exact or near for that rest needs the confirmation, in the preflight (match_entry_id) as in the save. Kappa:
    -- 300 TL matched and a new 49.400 TL row, near the 49.700 TL left (and near the 50.000 TL before); Mu: 10.000 TL
    -- matched and a new 70.000 TL row, exact for the 70.000 TL left (only a partial payment of the 80.000 TL before).
    PERFORM public.fin_create_entry(v_e_kap, v_cat_other, NULL, NULL, 'Sigorta Kappa', 'Öz denetim sigorta',
                                    v_m0 + 20, 5000000, NULL, false, NULL);
    PERFORM public.fin_create_entry(v_e_mu, v_cat_other, NULL, NULL, 'Muhasebe Mu', 'Öz denetim muhasebe',
                                    v_m0 + 21, 8000000, NULL, false, NULL);
    SELECT array_agg(v_bank_key || public.fin__iso_date(v_m0 + x.d) || ':' || x.s ORDER BY x.n) INTO v_kk
    FROM (VALUES (1, 18, 'k1a'), (2, 19, 'k1b'), (3, 20, 'k2a'), (4, 21, 'k2b'), (5, 22, 'k3a'), (6, 22, 'k3b'),
                 (7, 22, 'k4a'), (8, 23, 'k4b')) AS x(n, d, s);
    v_payloads := ARRAY[
      jsonb_build_array(
        v_brow || jsonb_build_object(
          'row_no', 1, 'key', v_kk[1], 'date', v_m0 + 18, 'amount_cents', 30000,
          'match', jsonb_build_object('entry_id', v_e_kap, 'version', 1, 'payment_id', gen_random_uuid())),
        v_brow || jsonb_build_object(
          'row_no', 2, 'key', v_kk[2], 'date', v_m0 + 19, 'amount_cents', 4940000,
          'entry_id', public.fin__import_id(v_clinic, v_kk[2]), 'fingerprint', md5(v_kk[2]) || md5(v_kk[2] || '#'),
          'category_id', v_cat_other, 'counterparty_text', 'Öz denetim gider')),
      jsonb_build_array(
        v_brow || jsonb_build_object(
          'row_no', 1, 'key', v_kk[3], 'date', v_m0 + 20, 'amount_cents', 1000000,
          'match', jsonb_build_object('entry_id', v_e_mu, 'version', 1, 'payment_id', gen_random_uuid())),
        v_brow || jsonb_build_object(
          'row_no', 2, 'key', v_kk[4], 'date', v_m0 + 21, 'amount_cents', 7000000,
          'entry_id', public.fin__import_id(v_clinic, v_kk[4]), 'fingerprint', md5(v_kk[4]) || md5(v_kk[4] || '#'),
          'category_id', v_cat_other, 'counterparty_text', 'Öz denetim gider'))];
    v_msgs := ARRAY[
      'Aynı veya yakın tutarda açık borç var: Sigorta Kappa · vade ' || to_char(v_m0 + 20, 'DD.MM.YYYY')
        || ' · kalan 49.700,00 TL.',
      'Aynı veya yakın tutarda açık borç var: Muhasebe Mu · vade ' || to_char(v_m0 + 21, 'DD.MM.YYYY')
        || ' · kalan 70.000,00 TL.'];
    FOR v_i IN 1 .. 2
    LOOP
      v_e_x := CASE WHEN v_i = 1 THEN v_e_kap ELSE v_e_mu END;
      -- The preflight of the same rows (the review sends the match as match_entry_id): open_debt with the rest.
      SELECT jsonb_agg(jsonb_build_object('row_no', r.v -> 'row_no', 'key', r.v -> 'key', 'kind', r.v -> 'kind',
                                          'date', r.v -> 'date', 'amount_cents', r.v -> 'amount_cents',
                                          'direction', r.v -> 'direction')
                       || CASE WHEN r.v ? 'match' THEN jsonb_build_object('match_entry_id', r.v #> '{match,entry_id}')
                               ELSE '{}'::jsonb END
                       ORDER BY r.o)
        INTO v_rows
      FROM jsonb_array_elements(v_payloads[v_i]) WITH ORDINALITY AS r(v, o);
      v_j := public.fin_import_check(v_month, v_rows);
      v_x := (SELECT w.v -> 'debts' FROM jsonb_array_elements(v_j #> '{rows,1,warnings}') AS w(v)
              WHERE w.v ->> 'code' = 'open_debt');
      IF v_x #>> '{0,entry_id}' IS DISTINCT FROM v_e_x::text
         OR (v_x #>> '{0,outstanding_cents}')::bigint IS DISTINCT FROM (CASE WHEN v_i = 1 THEN 4970000 ELSE 7000000 END)
         OR (v_x #>> '{0,amount_cents}')::bigint IS DISTINCT FROM (CASE WHEN v_i = 1 THEN 5000000 ELSE 8000000 END)
         OR v_x #>> '{0,kind}' IS DISTINCT FROM (CASE WHEN v_i = 1 THEN 'near' ELSE 'exact' END)
         OR jsonb_array_length(v_x) IS DISTINCT FROM 1
         OR strpos((v_j #> '{rows,0}')::text, 'open_debt') > 0 THEN
        v_fail := array_append(v_fail, format('kısmi eşleşme kontrolü %s: %s', v_i, left(v_j::text, 700)));
      END IF;
      -- The save: refused without the confirmation (the refusal names the rest), saved with it.
      v_err := NULL;
      v_state := NULL;
      v_detail := NULL;
      BEGIN
        PERFORM public.fin_import_rows(v_payloads[v_i], jsonb_build_object('id', gen_random_uuid(), 'month', v_month));
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
      END;
      IF v_err IS NULL OR strpos(v_err, v_msgs[v_i]) = 0 OR v_state IS DISTINCT FROM 'PT409'
         OR nullif(v_detail, '')::jsonb ->> 'warning' IS DISTINCT FROM 'open_debt'
         OR nullif(v_detail, '')::jsonb ->> 'entry_id' IS DISTINCT FROM v_e_x::text
         OR nullif(v_detail, '')::jsonb ->> 'row_no' IS DISTINCT FROM '2' THEN
        v_fail := array_append(v_fail, format('kısmi eşleşme reddi %s: %s / %s / %s', v_i, coalesce(v_state, '-'),
                                              coalesce(v_err, 'reddedilmedi'), coalesce(v_detail, '-')));
      END IF;
      v_j := public.fin_import_rows(jsonb_set(v_payloads[v_i], '{1,ack_open_debt}', 'true'::jsonb),
                                    jsonb_build_object('id', gen_random_uuid(), 'month', v_month));
      IF (v_j ->> 'matched')::integer IS DISTINCT FROM 1
         OR (v_j ->> 'inserted')::integer IS DISTINCT FROM 1
         OR (v_j ->> 'acknowledged')::integer IS DISTINCT FROM 1
         OR (SELECT s.outstanding_cents FROM public.fin__entries_state(v_clinic) s WHERE s.id = v_e_x)
              IS DISTINCT FROM (CASE WHEN v_i = 1 THEN 4970000 ELSE 7000000 END)::bigint THEN
        v_fail := array_append(v_fail, format('kısmi eşleşme onayı %s: %s', v_i, left(v_j::text, 700)));
      END IF;
    END LOOP;

    -- A match that leaves nothing open settles its debt for every other row of the request, without a confirmation:
    -- Kappa's 49.700 TL paid with 49.500 TL and close_remainder next to a new 49.700 TL row, Mu's 70.000 TL paid in
    -- full next to a new 70.000 TL row.
    v_payloads := ARRAY[jsonb_build_array(
      v_brow || jsonb_build_object(
        'row_no', 1, 'key', v_kk[5], 'date', v_m0 + 22, 'amount_cents', 4950000, 'close_remainder', true,
        'match', jsonb_build_object('entry_id', v_e_kap,
                                    'version', (SELECT e.version FROM public.fin_entries e WHERE e.id = v_e_kap),
                                    'payment_id', gen_random_uuid())),
      v_brow || jsonb_build_object(
        'row_no', 2, 'key', v_kk[6], 'date', v_m0 + 22, 'amount_cents', 4970000,
        'entry_id', public.fin__import_id(v_clinic, v_kk[6]), 'fingerprint', md5(v_kk[6]) || md5(v_kk[6] || '#'),
        'category_id', v_cat_other, 'counterparty_text', 'Öz denetim gider'),
      v_brow || jsonb_build_object(
        'row_no', 3, 'key', v_kk[7], 'date', v_m0 + 22, 'amount_cents', 7000000,
        'match', jsonb_build_object('entry_id', v_e_mu,
                                    'version', (SELECT e.version FROM public.fin_entries e WHERE e.id = v_e_mu),
                                    'payment_id', gen_random_uuid())),
      v_brow || jsonb_build_object(
        'row_no', 4, 'key', v_kk[8], 'date', v_m0 + 23, 'amount_cents', 7000000,
        'entry_id', public.fin__import_id(v_clinic, v_kk[8]), 'fingerprint', md5(v_kk[8]) || md5(v_kk[8] || '#'),
        'category_id', v_cat_other, 'counterparty_text', 'Öz denetim gider'))];
    SELECT jsonb_agg(jsonb_build_object('row_no', r.v -> 'row_no', 'key', r.v -> 'key', 'kind', r.v -> 'kind',
                                        'date', r.v -> 'date', 'amount_cents', r.v -> 'amount_cents',
                                        'direction', r.v -> 'direction')
                     || CASE WHEN r.v ? 'match' THEN jsonb_build_object('match_entry_id', r.v #> '{match,entry_id}')
                             ELSE '{}'::jsonb END
                     || CASE WHEN r.v ? 'close_remainder'
                             THEN jsonb_build_object('close_remainder', r.v -> 'close_remainder')
                             ELSE '{}'::jsonb END
                     ORDER BY r.o)
      INTO v_rows
    FROM jsonb_array_elements(v_payloads[1]) WITH ORDINALITY AS r(v, o);
    v_j := public.fin_import_check(v_month, v_rows);
    IF jsonb_array_length(v_j -> 'rows') IS DISTINCT FROM 4 OR strpos(v_j::text, 'open_debt') > 0 THEN
      v_fail := array_append(v_fail, 'kalanı kapatan / tam eşleşme kontrolü: ' || left(v_j::text, 700));
    END IF;
    v_err := NULL;
    BEGIN
      PERFORM public.fin_import_check(v_month, jsonb_set(v_rows, '{0,close_remainder}', '"evet"'::jsonb));
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'Filtre değerleri geçersiz.' THEN
      v_fail := array_append(v_fail, 'kontrol close_remainder doğrulaması: ' || coalesce(v_err, 'reddedilmedi'));
    END IF;
    v_j := public.fin_import_rows(v_payloads[1], jsonb_build_object('id', gen_random_uuid(), 'month', v_month));
    IF (v_j ->> 'matched')::integer IS DISTINCT FROM 2
       OR (v_j ->> 'inserted')::integer IS DISTINCT FROM 2
       OR (v_j ->> 'acknowledged')::integer IS DISTINCT FROM 0
       OR (v_j #>> '{rows,0,remainder_closed_cents}')::bigint IS DISTINCT FROM 20000
       OR (SELECT s.status FROM public.fin__entries_state(v_clinic) s WHERE s.id = v_e_kap)
            IS DISTINCT FROM 'cancelled'
       OR (SELECT s.status FROM public.fin__entries_state(v_clinic) s WHERE s.id = v_e_mu)
            IS DISTINCT FROM 'completed' THEN
      v_fail := array_append(v_fail, 'kalanı kapatan / tam eşleşme: ' || left(v_j::text, 700));
    END IF;

    -- The deferred checks (fin_import_source_consistent: each key equals its payment's or entry's key; the batch
    -- foreign key) run now instead of at a COMMIT that never comes; a failure aborts the migration with its message.
    EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (borç eşleştirme): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p37_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;

  IF EXISTS (SELECT 1 FROM public.clinics c WHERE c.slug IN (v_slug, v_slug || '-b')) THEN
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
