-- Hakediş v2.4: the month close deducts what was already booked for the payee and the month on other entries (cash
-- paid during the month, the bank salary imported early next month, ...) and writes only the remainder as the open
-- hakediş / payroll entry, so a payment booked under the person and the hakediş month is no longer counted twice. The
-- Personel bucket carries the salary month like Hekim hakedişi, every payee can get a counterparty (cari) linked to
-- them in one step, and import rules get a month suggestion. The bank / cash split of a payee's amount is shown only to
-- finance holders; Hakedişim is closed to reception, assistants and admins. Safe to re-run.
--
-- Contract: spec_hakedis_netting + its visibility addendum (owner decisions 2026-10-21) on top of 0036_doctor_scope.sql
-- (0001 – 0036 are applied and live; none is edited). The latest definition of every function replaced here (0020's,
-- 0022's, 0030's, 0032's, 0034's or 0035's) is copied with only the changes below and keeps its signature, except
-- fin_save_classification_rule (one
-- trailing parameter; the 0022 signature is dropped first, as 0034 did for fin_hk_save_rule, since
-- fin__harden_privileges refuses overloads). Independent of 0037 (fin_import_rows, fin_import_check and the debt
-- candidates are not touched here).
--
--  * Definitions. Payee P, month M, cari C(P): the counterparty linked to P (a doctor: fin_counterparties.doctor_id of
--    P's doctors row; staff: staff_user_id). Keyed entry K(P, M): source_key 'entitlement:<C>:<YYYY-MM>' (doctors) or
--    'payroll:<C>:<YYYY-MM>' (staff), as before. Other entries O(P, M) (fin__hk_other_sums): entries of the clinic
--    under C, or typed as C's name (fin__entries_state rule: no counterparty id, the normalized text = C's normalized
--    name; an advance typed before C existed counts), entitlement_month = M, an outgoing category of the 'doctor' or
--    'personnel' bucket, other than K, not excluded from totals, not a patient financing entry. booked(E) = amount,
--    for a cancelled entry what was paid on it; paid(E) = its live payments.
--  * Month on Personel: fin__trg_entry_guard, fin__entry_input and fin__trg_rule_guard accept entitlement_month /
--    requires_entitlement_month on the 'personnel' bucket too; the message becomes 'Hakediş / maaş ayı yalnızca hekim
--    hakedişi ve personel kayıtlarında kullanılabilir.'. Subcategories, a rule's counterparty (still only with
--    requires_entitlement_month) and the dashboard's past-period split (doctor bucket only, fin__live_payments) are
--    unchanged. The payroll entry of a close keeps entitlement_month NULL (fin__trg_payroll_entry_guard locks it, and
--    an older web build sends no month for it).
--  * Rules: fin_classification_rules.entitlement_month_default text NOT NULL DEFAULT 'none' ('none' | 'same' |
--    'previous' | 'from_text'; anything but 'none' only with requires_entitlement_month). fin_save_classification_rule
--    + p_entitlement_month_default text DEFAULT 'none' (NULL / blank = 'none'; a call without it saves 'none').
--    RuleJson + entitlement_month_default. The suggestion is applied in the browser (review table), never here.
--  * Counterparties: fin__hk_ensure_counterparty (new internal helper, the 0032 close lines moved unchanged: the linked
--    counterparty; else an unlinked one of the payee's kind with the payee's name is linked; else one is created; any
--    other name clash is refused with the 0032 messages) serves the close and fin_hk_ensure_counterparties() (new RPC,
--    finance writers): every user with a hakediş rule (any kind and month, bank_portion included) or a live adjustment;
--    a physician counterparty for a doctors row, a staff counterparty without one when every rule of the payee is
--    fixed_monthly / bank_portion / minimum_monthly (the close's payroll path), else 'no_doctor'. Idempotent; one
--    payee's refusal is reported ('error') and does not stop the others. Takes the clinic's close lock.
--  * Close (fin_hk_close_month, 0032 body): per payee other_booked = Σ booked(O), target = total − other_booked
--    (fin__hk_net_entry).
--      K live:      amount := max(target, paid(K)); when that is 0 (nothing paid on K, target ≤ 0) K's remainder is
--                   cancelled as fin_cancel_entry does, reason 'Hakediş ayrı kayıtlarla ödendi'.
--      K missing:   created only when target > 0, amount target (staff: Personel as in 0032; doctors: Hekim hakedişi as
--                   fin_add_entitlement writes it: past_physician_debt for a past month, entitlement_month M, due on
--                   the 1st).
--      K cancelled: target > paid(K) reopens it with amount target when the netting cancelled it (only the netting
--                   may: fin.ctx 'hk_netting' in fin__trg_entry_guard); cancelled by a person, the 0032 refusal stays.
--    No longer refused: a computed total below what was paid, and a 0 total with a live entry. overpaid = max(0,
--    paid(K) + other_booked − total) is recorded and shown (OVERPAID); the owner decides the offset, nothing is
--    moved. The statement keeps other_booked_cents, other_paid_cents, overpaid_cents, counterparty_id (C at the close,
--    NULL when the payee had none) and entry_kind ('entitlement' | 'payroll'); fin_entry_id is NULL when no K was
--    needed. The pre-close refusal for a live entry of an earlier statement now covers payees missing from the
--    computation only (a 0 total is netted); the "entry under another counterparty" refusal also runs for a 0 total.
--    Every other check, message and lock is unchanged.
--  * After the close: trigger fin_hk_net_sync (AFTER INSERT OR UPDATE OF amount_cents, cancelled_at, counterparty_id,
--    counterparty_text, entitlement_month, excluded_from_totals, category_id ON fin_entries; fin__trg_hk_net_sync →
--    fin__hk_net_sync): an entry whose old or new (counterparty, month) belongs to a statement in force of a closed
--    month (written by this file's close: entry_kind set) re-nets that statement with the close's rule (K created,
--    resized, its remainder cancelled or reopened) and updates its netting figures. The entry's counterparty is its id,
--    or for free text the counterparty with that normalized name. A statement re-nets only while its counterparty is
--    unlinked or still linked to its payee; a statement closed without a counterparty is bound to the counterparty the
--    payee is linked to now (same kind), unless another statement in force of the month already nets it. Hakediş /
--    payroll entries ('entitlement:' / 'payroll:' keys) never start a sync (no recursion; a finance user's edit of K
--    stays until the next sync or close). A K cancelled by a person is left as it is and nothing is refused (the views
--    show the live Kalan). Payments on a live entry change no booked amount (paid figures are read live); a payment
--    voided or corrected on a cancelled other entry changes its booked amount (what was paid on it) and re-nets through
--    trigger fin_hk_net_sync_payment (AFTER UPDATE OF amount_cents, voided_at ON fin_payments;
--    fin__trg_hk_net_sync_payment; no INSERT: no payment is added to a cancelled entry). Takes the clinic's close lock
--    and the month lock shared first (as fin__hk_check_open), so it waits for a close / reopen in progress and then
--    sees its result.
--  * Reopen: fin_hk_reopen_month is unchanged. A reopen + re-close with the same data writes no entry (the netting is
--    a function of the data); months reopened stay unsynced until closed again.
--  * Views (live; ledger data): StatementJson + {other_booked_cents, other_paid_cents, other_count, paid_cents (Ödenen
--    = paid(K) + Σ paid(O)), remaining_cents (Kalan = total − Ödenen, negative = overpaid), overpaid_cents}; the
--    'entry' object stays K's own. fin_hk_month: a closed month + warnings OVERPAID; an open month payees[] +
--    paid_so_far (Σ paid(O) + paid(K) if one exists) and booked_so_far (Σ booked(O) + paid(K): what a close would
--    deduct, unpaid planned entries included). hk_my_months: months[].paid_cents = Ödenen (open months: paid
--    so far), remaining_cents = Kalan (closed months), + other_paid_cents, overpaid_cents. hk_my_month: statement +
--    {paid_cents, remaining_cents, other_booked_cents, other_paid_cents, overpaid_cents}, top-level paid_so_far.
--  * Privacy: fin__hk_strip_ledger (callers without 'finance' / 'finance_readonly': the preparer) removes the new
--    statement keys, payees[].paid_so_far / booked_so_far and OVERPAID, and nulls statements[].fin_entry_id (a positive
--    total without a keyed entry now means "paid by other entries"). hk_my_* read only the caller's own statement and
--    entries; a statement whose counterparty was linked to another person since shows the figures of its last sync
--    (fin__hk_statement_paid), never that person's entries.
--  * Visibility (owner decision 2026-10-21; the computation is unchanged). The bank / cash split (bank_cents /
--    cash_cents of a payee or a frozen statement breakdown, BANK_OVER_TOTAL, a bank_portion rule's amount and note)
--    is finance data:
--      'finance' / 'finance_readonly' holders: unchanged everywhere (fin_hk_month, fin_hk_close_month,
--                   fin_hk_reopen_month, fin_hk_reference, fin_hk_save_rule).
--      preparer ('hakedis_prepare' without them): fin__hk_strip_ledger also removes payees[].bank_cents / cash_cents,
--                   statements[].breakdown.bank_cents / cash_cents and the BANK_OVER_TOTAL warnings; fin__hk_rule_json
--                   (fin_hk_reference's rules) gives a bank_portion rule piece_cents NULL and note '' (the rule, its
--                   payee and months stay). Lines, pieces, marks, lab costs, adjustments, totals, salaries
--                   (fixed_monthly / minimum_monthly amounts) are unchanged.
--      payee's own view: hk_my_months drops months[].bank_cents / cash_cents; hk_my_month's payees[]
--                   (fin__hk_self_payee) drop bank_cents / cash_cents; total, Ödenen and Kalan stay.
--    hk_my_months / hk_my_month refuse the roles the web closes Hakedişim to (SECTIONS_CLOSED_FOR['/hakedisim']:
--    reception, assistant, admin) whatever their permissions, right after the session check (42501); doctors and the
--    owner keep their own data. Nothing else (RLS, grants, tables) changes: the hakediş tables stay readable by
--    finance holders only (0030 / 0031 / 0033 policies).
--  * Limits: a counterparty created or renamed after a close changes which free-text entries count for it; the
--    statement follows at the next sync of that payee and month (any change of one of its entries) or at a re-close.
--    A counterparty relinked to another person leaves the earlier payee's statement at the figures of its last sync;
--    unlinking it (Cariler) lets it re-net again.
--
-- Error contract (as 0020): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or the
-- default P0001 (400). New texts (P0001): 'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında
-- kullanılabilir.' (replaces 'Hakediş ayı yalnızca hekim hakedişi kayıtlarında kullanılabilir.'), 'Hakediş ayı önerisi
-- geçersiz.', 'Hakediş ayı önerisi yalnızca "hakediş ayı gerekli" kurallarında seçilebilir.'. New text (42501):
-- 'Hakedişim yalnızca hekimlere ve klinik sahibine açıktır.' (hk_my_months / hk_my_month for reception, assistants and
-- admins). Close: the refusals "yeni hakediş / maaş tutarı (...) bundan az olamaz" and "... kaydı zaten var (...), yeni
-- hesaplanan tutar ise 0" are gone; every other text is unchanged.
--
-- JSON shapes (changes; amounts in kuruş):
--   RuleJson            + {entitlement_month_default: 'none' | 'same' | 'previous' | 'from_text'}.
--   HkRuleJson          (fin__hk_rule_json: fin_hk_reference rules[], fin_hk_save_rule record) kind 'bank_portion':
--                       piece_cents null and note '' for a caller without 'finance' / 'finance_readonly'.
--   fin_save_classification_rule(..., p_is_active, p_entitlement_month_default text DEFAULT 'none').
--   StatementJson       + {other_booked_cents, other_paid_cents, other_count, paid_cents, remaining_cents,
--                       overpaid_cents} (live; absent for a caller without ledger access; other_count null when the
--                       counterparty is linked to another person since and the stored figures are shown).
--   fin_hk_month        closed: warnings[] + {code: 'OVERPAID', payee_user_id, payee_name, overpaid_cents} (after the
--                       computed warnings, by payee name; finance readers only). open: payees[] + {paid_so_far,
--                       booked_so_far} (finance readers only). Preparer: statements[].fin_entry_id null; − payees[]
--                       bank_cents / cash_cents, − statements[].breakdown.bank_cents / cash_cents, − BANK_OVER_TOTAL.
--   hk_my_months()      months[] + {other_paid_cents, overpaid_cents (null when open)} − {bank_cents, cash_cents};
--                       paid_cents = Ödenen; remaining_cents = total − Ödenen when closed (may be negative), null when
--                       open. Refused (42501) for reception, assistants and admins.
--   hk_my_month(p)      statement (closed) + {paid_cents, remaining_cents, other_booked_cents, other_paid_cents,
--                       overpaid_cents}; + paid_so_far (open: what was paid for the month so far; null when closed);
--                       payees[] − {bank_cents, cash_cents}. Refused (42501) for reception, assistants and admins.
--   fin_hk_ensure_counterparties() → [{payee_user_id, payee_name, kind: 'physician' | 'staff' | null, counterparty_id,
--                       counterparty_name, is_active, status: 'existing' | 'linked' | 'created' | 'no_doctor' |
--                       'error', message (no_doctor / error: the Turkish refusal, else null)}] by payee name.
--
-- RUNBOOK (production is the only database):
--   1. 0036 is applied. Quiet moment (a few seconds): fin_entries and fin_payments get a trigger each,
--      fin_hk_statements five columns and fin_classification_rules one in this transaction. SQL editor → New query →
--      paste this file ALONE → Run. One transaction; the self-checks at the end (including a replay in a temporary
--      clinic that is always rolled back) undo everything on any failure.
--   2. Deploy the web build (database first: the new web saves rules with p_entitlement_month_default; an older web
--      build keeps working, its rule saves write 'none').
--   3. Hakediş → "Hakediş carilerini hazırla" (fin_hk_ensure_counterparties) before the import rules that name the
--      payees' caris are set up. No month has been closed yet, so no statement needs a migration.
--   Re-running 0020, 0022, 0030, 0032, 0034 or 0035 later puts back older bodies: re-run this file afterwards.
--   Rollback after COMMIT, in this order (SQL editor):
--   (a) Data: UPDATE public.fin_classification_rules SET entitlement_month_default = 'none' (the 0022 rule save would
--       otherwise hit the CHECK when it clears requires_entitlement_month); personnel rules with
--       requires_entitlement_month and personnel entries with an entitlement_month are refused by the 0020 / 0022
--       guards on their next save: set requires_entitlement_month = false, counterparty_id = NULL on those rules and
--       entitlement_month = NULL on those entries first (payroll entries have none). Hakediş / payroll entries keep
--       the netted amounts; one the netting cancelled stays cancelled (the 0032 close then refuses that payee with
--       its cancelled-entry message).
--   (b) DROP TRIGGER fin_hk_net_sync ON public.fin_entries; DROP TRIGGER fin_hk_net_sync_payment ON
--       public.fin_payments; then re-run the 0020 definitions of fin__trg_entry_guard and fin__entry_input, the 0022
--       ones of fin__trg_rule_guard and fin__rule_json, the 0030 ones of fin__trg_hk_statement_guard and
--       fin__hk_statement_json, the 0032 ones of fin_hk_close_month, hk_my_months and fin__hk_self_payee, the 0034 one
--       of fin__hk_rule_json and the 0035 ones of fin__hk_strip_ledger, fin__hk_month_json and hk_my_month (this puts
--       the bank / cash split back for the preparer and the payees' own views); DROP FUNCTION
--       public.fin_save_classification_rule(uuid, integer, integer, text, text, text, uuid, text, uuid, boolean,
--       boolean, text, boolean, text) and re-run the 0022 definition; then DROP FUNCTION
--       public.fin_hk_ensure_counterparties(), public.fin__trg_hk_net_sync(), public.fin__trg_hk_net_sync_payment(),
--       public.fin__hk_net_sync(uuid, uuid, date), public.fin__hk_net_entry(uuid, date, uuid, boolean, bigint, text),
--       public.fin__hk_ensure_counterparty(uuid, uuid, text, uuid, boolean, uuid), public.fin__hk_payee_paid(uuid,
--       uuid, date), public.fin__hk_statement_paid(uuid, uuid), public.fin__hk_other_sums(uuid, uuid, date, uuid).
--       Then SELECT public.fin__harden_privileges(); and the hk_my_months / hk_my_month grants of 0032 (REVOKE FROM
--       PUBLIC, anon; GRANT TO authenticated).
--   (c) The new columns, constraints and index may stay (the older bodies never read them; a 0032 close writes the
--       column defaults) or be dropped after (b).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1.0 Preflight: 0036 live; the functions replaced here with their latest bodies and signatures (or this file's on a
--     re-run); the expected columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regprocedure('public.clin_my_doctor_id()') IS NULL
     OR to_regprocedure('public.clin__lab_order_visible(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Önce 0036 uygulanmalı (clin_my_doctor_id / clin__lab_order_visible bulunamadı).';
  END IF;

  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today', 'has_permission',
                    'fin_can_read', 'fin__require_write', 'fin__harden_privileges', 'fin__month_start', 'fin__month',
                    'fin__day', 'fin__paid', 'fin__set_ctx', 'fin__ctx', 'fin__normalize_name', 'fin__user_name',
                    'fin__hk_close_lock', 'fin__hk_month_lock', 'fin__hk_compute', 'fin__hk_payee_entry',
                    'fin__hk_description', 'fin__hk_payroll_description', 'fin__hk_tl', 'fin__hk_self_payee',
                    'fin__hk_month_row_json', 'fin__hk_require_prep_read', 'fin_hk_month', 'fin_hk_reopen_month',
                    'fin_add_entitlement', 'fin_cancel_entry', 'fin_create_entry', 'fin_edit_entry',
                    'fin_record_payment', 'fin_correct_payment', 'fin_void_payment', 'fin_set_exclusion',
                    'fin_save_counterparty', 'fin_hk_save_rule', 'fin_hk_save_line',
                    'grant_staff_permission']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önce 0020 – 0036 uygulanmalı; eksik fonksiyonlar: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.fin__trg_entry_guard()',
    'public.fin__entry_input(uuid,uuid,text,uuid,text,text,date,bigint,text)',
    'public.fin__trg_rule_guard()',
    'public.fin__rule_json(uuid,uuid)',
    'public.fin__trg_hk_statement_guard()',
    'public.fin__hk_statement_json(uuid,uuid)',
    'public.fin__hk_strip_ledger(jsonb)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin__hk_rule_json(uuid,uuid)',
    'public.fin__hk_self_payee(jsonb)',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.fin_hk_reopen_month(date,integer)',
    'public.hk_my_months()',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Fonksiyonlar beklenen imzada değil (0036 uygulanmalı): %', v_missing;
  END IF;
  -- fin_save_classification_rule: the 0022 signature, or this file's on a re-run; never both.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fin_save_classification_rule') <> 1
     OR (to_regprocedure('public.fin_save_classification_rule(uuid,integer,integer,text,text,text,uuid,text,uuid,'
                         || 'boolean,boolean,text,boolean)') IS NULL
         AND to_regprocedure('public.fin_save_classification_rule(uuid,integer,integer,text,text,text,uuid,text,uuid,'
                             || 'boolean,boolean,text,boolean,text)') IS NULL) THEN
    RAISE EXCEPTION 'fin_save_classification_rule beklenen imzada değil (0022 uygulanmalı).';
  END IF;

  -- The bodies replaced below are the latest ones (0020 / 0022 / 0030 / 0032 / 0034 / 0035), or this file's, which
  -- keep these texts (hk_my_months below).
  SELECT string_agg(e.fn, ', ')
    INTO v_missing
  FROM (VALUES
    ('fin__trg_entry_guard', '%geri açılamaz%'),
    ('fin__entry_input', '%o_entitlement_month%'),
    ('fin__trg_rule_guard', '%fin__regex_unsafe%'),
    ('fin__rule_json', '%requires_entitlement_month%'),
    ('fin_save_classification_rule', '%requires_entitlement_month%'),
    ('fin__trg_hk_statement_guard', '%superseded_by%'),
    ('fin__hk_statement_json', '%outstanding_cents%'),
    ('fin__hk_strip_ledger', '%FINANCING_UNMATCHED%'),
    ('fin__hk_month_json', '%financing_cents%'),
    ('fin_hk_close_month', '%minimum_topup%'),
    ('fin__hk_rule_json', '%unmarked_default%'),
    ('fin__hk_self_payee', '%clinic_ciro_share%'),
    ('hk_my_month', '%financing_cents%')
  ) AS e(fn, pat)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = e.fn AND p.prosrc LIKE e.pat
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Şu fonksiyonlar beklenen sürümde değil (0035 / 0036 uygulanmalı): %', v_missing;
  END IF;
  -- hk_my_months: the 0032 body (bank / cash split) or this file's (no split since the owner decision of 2026-10-21;
  -- Ödenen with the other entries).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'hk_my_months'
                   AND (p.prosrc LIKE '%cash_cents%' OR p.prosrc LIKE '%other_paid_cents%')) THEN
    RAISE EXCEPTION 'Şu fonksiyonlar beklenen sürümde değil (0035 / 0036 uygulanmalı): hk_my_months';
  END IF;

  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ')
    INTO v_missing
  FROM (VALUES
    ('fin_entries', 'counterparty_id'), ('fin_entries', 'counterparty_text'), ('fin_entries', 'entitlement_month'),
    ('fin_entries', 'cancelled_at'), ('fin_payments', 'amount_cents'), ('fin_payments', 'voided_at'),
    ('fin_entries', 'cancel_reason'), ('fin_entries', 'excluded_from_totals'), ('fin_entries', 'source_key'),
    ('fin_categories', 'report_bucket'), ('fin_categories', 'is_system'), ('fin_counterparties', 'doctor_id'),
    ('fin_counterparties', 'staff_user_id'), ('fin_counterparties', 'normalized_name'),
    ('fin_classification_rules', 'requires_entitlement_month'), ('fin_classification_rules', 'counterparty_id'),
    ('fin_hk_statements', 'fin_entry_id'), ('fin_hk_statements', 'breakdown'),
    ('fin_hk_statements', 'superseded_at'), ('fin_hk_rules', 'kind'), ('fin_hk_rules', 'payee_user_id'),
    ('fin_hk_adjustments', 'voided_at'), ('fin_patient_financing', 'entry_id')
  ) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı: %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Schema. Rules: the review table's month suggestion. Statements: the netting figures of the close (kept up to
--     date after it by fin__hk_net_sync), the counterparty netted against and the kind of the keyed entry. Every
--     existing row stays valid (defaults; no statement has been written in production yet).
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_classification_rules
  ADD COLUMN IF NOT EXISTS entitlement_month_default text NOT NULL DEFAULT 'none';
ALTER TABLE public.fin_classification_rules
  DROP CONSTRAINT IF EXISTS fin_classification_rules_month_default,
  DROP CONSTRAINT IF EXISTS fin_classification_rules_month_default_req,
  ADD CONSTRAINT fin_classification_rules_month_default
    CHECK (entitlement_month_default IN ('none', 'same', 'previous', 'from_text')),
  ADD CONSTRAINT fin_classification_rules_month_default_req
    CHECK (entitlement_month_default = 'none' OR requires_entitlement_month);

ALTER TABLE public.fin_hk_statements
  ADD COLUMN IF NOT EXISTS other_booked_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_paid_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overpaid_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counterparty_id uuid,
  ADD COLUMN IF NOT EXISTS entry_kind text;
ALTER TABLE public.fin_hk_statements
  DROP CONSTRAINT IF EXISTS fin_hk_statements_netting,
  DROP CONSTRAINT IF EXISTS fin_hk_statements_entry_kind,
  DROP CONSTRAINT IF EXISTS fin_hk_statements_counterparty_fkey,
  ADD CONSTRAINT fin_hk_statements_netting
    CHECK (other_booked_cents >= 0 AND other_paid_cents >= 0 AND overpaid_cents >= 0),
  ADD CONSTRAINT fin_hk_statements_entry_kind
    CHECK (entry_kind IS NULL OR entry_kind IN ('entitlement', 'payroll')),
  ADD CONSTRAINT fin_hk_statements_counterparty_fkey
    FOREIGN KEY (clinic_id, counterparty_id) REFERENCES public.fin_counterparties (clinic_id, id) ON DELETE RESTRICT;
-- fin__hk_net_sync finds the statements in force of a counterparty's month.
CREATE INDEX IF NOT EXISTS idx_fin_hk_statements_counterparty
  ON public.fin_hk_statements (clinic_id, counterparty_id, month)
  WHERE superseded_at IS NULL AND counterparty_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1.2 The hakediş month on Personel too (salary month). Same signatures; SECURITY DEFINER trigger functions are
--     never granted. Subcategories and the rule counterparty check are unchanged.
-- ---------------------------------------------------------------------------

-- Entry guard (0020 body, same signature): + the personnel bucket for entitlement_month; + the netting may
-- reopen a hakediş / payroll entry it cancelled itself (fin.ctx 'hk_netting', reason 'Hakediş ayrı kayıtlarla
-- ödendi'). Every other cancelled entry stays closed, as before.
CREATE OR REPLACE FUNCTION public.fin__trg_entry_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text;
BEGIN
  SELECT c.report_bucket INTO v_bucket
  FROM public.fin_categories c
  WHERE c.clinic_id = NEW.clinic_id AND c.id = NEW.category_id;
  IF v_bucket IS NULL THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;

  IF v_bucket = 'doctor' THEN
    NEW.subcategory := coalesce(NEW.subcategory, 'current_physician');
    IF NEW.subcategory NOT IN ('current_physician', 'past_physician_debt') THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF v_bucket = 'other_expense' THEN
    IF NEW.subcategory IS NOT NULL AND NEW.subcategory <> 'official_fee' THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF NEW.subcategory IS NOT NULL THEN
    RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
  END IF;

  -- 0038: the Personel bucket carries the salary month too.
  IF NEW.entitlement_month IS NOT NULL AND v_bucket NOT IN ('doctor', 'personnel') THEN
    RAISE EXCEPTION 'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında kullanılabilir.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.cancelled_at IS NOT NULL
       AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
            OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
            OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason)
       -- 0038: only the hakediş netting reopens what it cancelled itself (fin__hk_net_entry: a hakediş / payroll
       -- entry whose remainder it cancelled when other entries covered the month, once an amount is payable again).
       AND NOT (public.fin__ctx() = 'hk_netting'
                AND NEW.cancelled_at IS NULL AND NEW.cancelled_by IS NULL AND NEW.cancel_reason IS NULL
                AND OLD.cancel_reason = 'Hakediş ayrı kayıtlarla ödendi'
                AND (OLD.source_key LIKE 'entitlement:%' OR OLD.source_key LIKE 'payroll:%')) THEN
      RAISE EXCEPTION 'İptal edilmiş kayıt geri açılamaz.';
    END IF;
    IF NEW.source_key IS DISTINCT FROM OLD.source_key
       OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
       OR NEW.source_file IS DISTINCT FROM OLD.source_file
       OR NEW.legacy_id IS DISTINCT FROM OLD.legacy_id THEN
      RAISE EXCEPTION 'Bu alan değiştirilemez.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Entry input of fin_create_entry / fin_edit_entry / fin_import_rows (0020 body, same signature): + the personnel
-- bucket for the entitlement month.
CREATE OR REPLACE FUNCTION public.fin__entry_input(
  p_clinic uuid,
  p_category_id uuid,
  p_subcategory text,
  p_counterparty_id uuid,
  p_counterparty_text text,
  p_description text,
  p_due_date date,
  p_amount_cents bigint,
  p_entitlement_month text,
  OUT o_category_id uuid,
  OUT o_bucket text,
  OUT o_category_active boolean,
  OUT o_subcategory text,
  OUT o_counterparty_id uuid,
  OUT o_counterparty_text text,
  OUT o_counterparty_active boolean,
  OUT o_description text,
  OUT o_due_date date,
  OUT o_amount_cents bigint,
  OUT o_entitlement_month date)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_text text := nullif(btrim(coalesce(p_counterparty_text, '')), '');
  v_match uuid;
BEGIN
  o_amount_cents := public.fin__amount(p_amount_cents);
  o_due_date := public.fin__day(p_due_date);
  o_description := btrim(coalesce(p_description, ''));
  IF char_length(o_description) > 1000 THEN
    RAISE EXCEPTION 'Açıklama en fazla 1000 karakter olabilir.';
  END IF;

  IF (p_counterparty_id IS NULL) = (v_text IS NULL) OR char_length(v_text) > 200 THEN
    RAISE EXCEPTION 'Kişi / kurum seçin veya yazın (en fazla 200 karakter).';
  END IF;
  IF p_counterparty_id IS NOT NULL THEN
    SELECT cp.id, cp.is_active INTO o_counterparty_id, o_counterparty_active
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = p_clinic AND cp.id = p_counterparty_id;
    IF o_counterparty_id IS NULL THEN
      RAISE EXCEPTION 'Kişi / kurum bulunamadı.';
    END IF;
  ELSE
    SELECT cp.id INTO v_match
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = p_clinic AND cp.is_active AND cp.normalized_name = public.fin__normalize_name(v_text)
    LIMIT 1;
    IF v_match IS NOT NULL THEN
      o_counterparty_id := v_match;
    ELSE
      o_counterparty_text := v_text;
    END IF;
    o_counterparty_active := true;
  END IF;

  SELECT c.id, c.report_bucket, c.is_active INTO o_category_id, o_bucket, o_category_active
  FROM public.fin_categories c
  WHERE c.clinic_id = p_clinic AND c.id = p_category_id;
  IF o_category_id IS NULL THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;

  o_subcategory := nullif(btrim(coalesce(p_subcategory, '')), '');
  IF o_bucket = 'doctor' THEN
    o_subcategory := coalesce(o_subcategory, 'current_physician');
    IF o_subcategory NOT IN ('current_physician', 'past_physician_debt') THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF o_bucket = 'other_expense' THEN
    IF o_subcategory IS NOT NULL AND o_subcategory <> 'official_fee' THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  ELSIF o_subcategory IS NOT NULL THEN
    RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
  END IF;

  o_entitlement_month := public.fin__month(p_entitlement_month);
  -- 0038: the Personel bucket carries the salary month too.
  IF o_entitlement_month IS NOT NULL AND o_bucket NOT IN ('doctor', 'personnel') THEN
    RAISE EXCEPTION 'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında kullanılabilir.';
  END IF;
END;
$$;

-- Rule guard (0022 body, same signature): + the personnel bucket for requires_entitlement_month. A configured
-- counterparty still needs requires_entitlement_month (message unchanged).
CREATE OR REPLACE FUNCTION public.fin__trg_rule_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text;
BEGIN
  SELECT c.report_bucket INTO v_bucket
  FROM public.fin_categories c
  WHERE c.clinic_id = NEW.clinic_id AND c.id = NEW.category_id;
  IF v_bucket IS NULL THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;
  IF NEW.subcategory IS NOT NULL THEN
    IF (v_bucket = 'doctor' AND NEW.subcategory NOT IN ('current_physician', 'past_physician_debt'))
       OR (v_bucket = 'other_expense' AND NEW.subcategory <> 'official_fee')
       OR v_bucket NOT IN ('doctor', 'other_expense') THEN
      RAISE EXCEPTION 'Alt tür bu kategoriye uygun değil.';
    END IF;
  END IF;
  -- 0038: the Personel bucket carries the salary month too.
  IF NEW.requires_entitlement_month AND v_bucket NOT IN ('doctor', 'personnel') THEN
    RAISE EXCEPTION 'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında kullanılabilir.';
  END IF;
  -- A configured counterparty is the fingerprint counterparty of entitlement rows only (legacy IP:54); every other
  -- imported row keeps its narration as counterparty_text (critique 16).
  IF NEW.counterparty_id IS NOT NULL AND NOT NEW.requires_entitlement_month THEN
    RAISE EXCEPTION 'Kişi / kurum yalnızca hakediş ayı gerekli hekim kurallarında seçilebilir.';
  END IF;
  IF NEW.match_kind = 'regex' AND public.fin__regex_unsafe(NEW.pattern) THEN
    RAISE EXCEPTION 'Desen tarayıcıyı kilitleyebilecek bir yapı içeriyor (iç içe tekrar, geri başvuru veya geriye bakış).';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1.3 Rules: the month suggestion. RuleJson (0022 body) + entitlement_month_default; fin_save_classification_rule
--     (0022 body) + a trailing parameter: the 0022 signature is dropped first (no overloads; the grants come back
--     with fin__harden_privileges below).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fin__rule_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', r.id,
           'version', r.version,
           'priority', r.priority,
           'scope', r.scope,
           'match_kind', r.match_kind,
           'pattern', r.pattern,
           'category_id', r.category_id,
           'category_name', c.name,
           'report_bucket', c.report_bucket,
           'direction', c.direction,
           'category_is_active', c.is_active,
           'subcategory', r.subcategory,
           'counterparty_id', r.counterparty_id,
           'counterparty_name', cp.name,
           'requires_entitlement_month', r.requires_entitlement_month,
           'entitlement_month_default', r.entitlement_month_default,
           'auto_select', r.auto_select,
           'warning', r.warning,
           'is_active', r.is_active,
           'is_seed', r.is_seed,
           'created_by', r.created_by,
           'created_by_name', public.fin__user_name(r.created_by),
           'created_at', r.created_at,
           'updated_by', r.updated_by,
           'updated_by_name', public.fin__user_name(r.updated_by),
           'updated_at', r.updated_at)
  FROM public.fin_classification_rules r
  JOIN public.fin_categories c ON c.clinic_id = r.clinic_id AND c.id = r.category_id
  LEFT JOIN public.fin_counterparties cp ON cp.clinic_id = r.clinic_id AND cp.id = r.counterparty_id
  WHERE r.clinic_id = p_clinic AND r.id = p_id
$$;

DROP FUNCTION IF EXISTS public.fin_save_classification_rule(uuid, integer, integer, text, text, text, uuid, text,
                                                          uuid, boolean, boolean, text, boolean);
CREATE OR REPLACE FUNCTION public.fin_save_classification_rule(
  p_id uuid,
  p_version integer,
  p_priority integer,
  p_scope text,
  p_match_kind text,
  p_pattern text,
  p_category_id uuid,
  p_subcategory text,
  p_counterparty_id uuid,
  p_requires_entitlement_month boolean,
  p_auto_select boolean,
  p_warning text,
  p_is_active boolean,
  p_entitlement_month_default text DEFAULT 'none')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_row public.fin_classification_rules%ROWTYPE;
  v_priority integer;
  v_scope text := coalesce(nullif(btrim(coalesce(p_scope, '')), ''), 'any');
  v_kind text := btrim(coalesce(p_match_kind, ''));
  v_pattern text := nullif(btrim(coalesce(p_pattern, '')), '');
  v_sub text := nullif(btrim(coalesce(p_subcategory, '')), '');
  v_ent boolean := coalesce(p_requires_entitlement_month, false);
  v_auto boolean := coalesce(p_auto_select, false);
  v_warning text := btrim(coalesce(p_warning, ''));
  v_active boolean := coalesce(p_is_active, true);
  v_month_default text := coalesce(nullif(btrim(coalesce(p_entitlement_month_default, '')), ''), 'none');
  v_cat public.fin_categories%ROWTYPE;
  v_cp public.fin_counterparties%ROWTYPE;
  v_n integer;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Kayıt numarası eksik.';
  END IF;
  IF p_version IS NULL OR p_version < 0 THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  v_priority := public.fin__sort_order(p_priority);
  IF v_scope NOT IN ('any', 'bank', 'clinic') OR v_kind NOT IN ('contains', 'starts_with', 'exact', 'regex', 'always') THEN
    RAISE EXCEPTION 'Geçersiz tür.';
  END IF;
  IF (v_kind = 'always') <> (v_pattern IS NULL) OR char_length(v_pattern) > 300 THEN
    RAISE EXCEPTION 'Kural deseni 1-300 karakter olmalı; "her zaman" kuralında desen olmaz.';
  END IF;
  IF char_length(v_warning) > 300 THEN
    RAISE EXCEPTION 'Uyarı metni en fazla 300 karakter olabilir.';
  END IF;
  -- 0038: the review table's month suggestion, only where the month is required.
  IF v_month_default NOT IN ('none', 'same', 'previous', 'from_text') THEN
    RAISE EXCEPTION 'Hakediş ayı önerisi geçersiz.';
  END IF;
  IF v_month_default <> 'none' AND NOT v_ent THEN
    RAISE EXCEPTION 'Hakediş ayı önerisi yalnızca "hakediş ayı gerekli" kurallarında seçilebilir.';
  END IF;

  SELECT * INTO v_cat FROM public.fin_categories c WHERE c.clinic_id = v_clinic AND c.id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kategori bulunamadı.';
  END IF;
  IF p_counterparty_id IS NOT NULL THEN
    SELECT * INTO v_cp FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.id = p_counterparty_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Kişi / kurum bulunamadı.';
    END IF;
  END IF;

  -- Only rows of the caller's clinic are read or locked (0020 pattern).
  SELECT * INTO v_row FROM public.fin_classification_rules r WHERE r.clinic_id = v_clinic AND r.id = p_id FOR UPDATE;

  IF p_version = 0 THEN
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('already_saved', true, 'record', public.fin__rule_json(v_clinic, p_id));
    END IF;
    IF NOT v_cat.is_active THEN
      RAISE EXCEPTION 'Pasif kategori seçilemez.';
    END IF;
    IF p_counterparty_id IS NOT NULL AND NOT v_cp.is_active THEN
      RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
    END IF;
    INSERT INTO public.fin_classification_rules (id, clinic_id, priority, scope, match_kind, pattern, category_id,
                                                 subcategory, counterparty_id, requires_entitlement_month,
                                                 auto_select, warning, is_active, is_seed, created_by, updated_by,
                                                 entitlement_month_default)
    VALUES (p_id, v_clinic, v_priority, v_scope, v_kind, v_pattern, p_category_id, v_sub, p_counterparty_id, v_ent,
            v_auto, v_warning, v_active, false, v_user, v_user, v_month_default)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.fin_classification_rules r WHERE r.id = p_id AND r.clinic_id = v_clinic) THEN
        RETURN jsonb_build_object('already_saved', true, 'record', public.fin__rule_json(v_clinic, p_id));
      END IF;
      RAISE EXCEPTION 'Kayıt kaydedilemedi.' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('already_saved', false, 'record', public.fin__rule_json(v_clinic, p_id));
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı.' USING ERRCODE = 'PT404';
  END IF;
  IF (v_row.priority, v_row.scope, v_row.match_kind, v_row.pattern, v_row.category_id, v_row.subcategory,
      v_row.counterparty_id, v_row.requires_entitlement_month, v_row.auto_select, v_row.warning, v_row.is_active,
      v_row.entitlement_month_default)
     IS NOT DISTINCT FROM
     (v_priority, v_scope, v_kind, v_pattern, p_category_id, v_sub, p_counterparty_id, v_ent, v_auto, v_warning,
      v_active, v_month_default) THEN
    RETURN jsonb_build_object('already_saved', true, 'record', public.fin__rule_json(v_clinic, p_id));
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'Kayıt başka bir ekranda değişti. Listeyi yenileyin.' USING ERRCODE = 'PT409';
  END IF;
  IF p_category_id IS DISTINCT FROM v_row.category_id AND NOT v_cat.is_active THEN
    RAISE EXCEPTION 'Pasif kategori seçilemez.';
  END IF;
  IF p_counterparty_id IS NOT NULL AND p_counterparty_id IS DISTINCT FROM v_row.counterparty_id
     AND NOT v_cp.is_active THEN
    RAISE EXCEPTION 'Pasif kişi / kurum seçilemez.';
  END IF;

  UPDATE public.fin_classification_rules r
  SET priority = v_priority, scope = v_scope, match_kind = v_kind, pattern = v_pattern, category_id = p_category_id,
      subcategory = v_sub, counterparty_id = p_counterparty_id, requires_entitlement_month = v_ent,
      auto_select = v_auto, warning = v_warning, is_active = v_active, entitlement_month_default = v_month_default
  WHERE r.clinic_id = v_clinic AND r.id = p_id;

  RETURN jsonb_build_object('already_saved', false, 'record', public.fin__rule_json(v_clinic, p_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Netting internals (SECURITY INVOKER, never granted; called only from the SECURITY DEFINER close, trigger and
--    views, so they run as the function owner there).
-- ---------------------------------------------------------------------------

-- The payee's other entries O(P, M) of a month: under p_counterparty_id, or typed as its name (the fin__entries_state
-- rule: no counterparty id, the normalized text equal to the counterparty's normalized name, active or not; so an
-- advance typed before the payee's counterparty existed counts), entitlement_month = the month, an outgoing category of
-- the Hekim hakedişi / Personel bucket, not the keyed entry p_exclude (K), not excluded from totals, not a patient
-- financing entry (fin_patient_financing.entry_id, or a financing import key). booked = the amount, for a cancelled
-- entry what was paid on it; paid = its live payments. Always one row (zeros without a counterparty).
CREATE OR REPLACE FUNCTION public.fin__hk_other_sums(p_clinic uuid, p_counterparty_id uuid, p_month date,
                                                     p_exclude uuid)
RETURNS TABLE (booked_cents bigint, paid_cents bigint, entries integer)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(sum(CASE WHEN o.cancelled THEN o.paid ELSE o.amount END), 0)::bigint,
         coalesce(sum(o.paid), 0)::bigint,
         count(*)::integer
  FROM (
    SELECT e.amount_cents AS amount,
           e.cancelled_at IS NOT NULL AS cancelled,
           public.fin__paid(e.id) AS paid
    FROM public.fin_entries e
    JOIN public.fin_categories c ON c.clinic_id = e.clinic_id AND c.id = e.category_id
    WHERE e.clinic_id = p_clinic
      -- Two index paths (idx_fin_entries_counterparty, idx_fin_entries_counterparty_text).
      AND (e.counterparty_id = p_counterparty_id
           OR (e.counterparty_id IS NULL
               AND public.fin__normalize_name(e.counterparty_text) = (
                 SELECT cp.normalized_name FROM public.fin_counterparties cp
                 WHERE cp.clinic_id = p_clinic AND cp.id = p_counterparty_id)))
      AND e.entitlement_month = public.fin__month_start(p_month)
      AND c.direction = 'out'
      AND c.report_bucket IN ('doctor', 'personnel')
      AND e.id IS DISTINCT FROM p_exclude
      AND NOT e.excluded_from_totals
      AND NOT coalesce(e.source_key ~ '^[a-z][a-z0-9_]*-finance:', false)
      AND NOT EXISTS (SELECT 1 FROM public.fin_patient_financing f WHERE f.entry_id = e.id)
  ) o
$$;

-- Live payment figures of a statement: what was paid on its keyed entry, and the payee's other entries of the month
-- under the counterparty the close netted against (a statement written before this file: the keyed entry's). A
-- counterparty linked to another person since (Cariler) is not read live: that person's entries are not this payee's
-- (fin__hk_net_sync no longer re-nets this statement either), so the figures stored at its last sync are returned
-- (other_count NULL: not counted). Unlinked, or still the payee's, it is read live.
CREATE OR REPLACE FUNCTION public.fin__hk_statement_paid(p_clinic uuid, p_id uuid)
RETURNS TABLE (entry_paid_cents bigint, other_booked_cents bigint, other_paid_cents bigint, other_count integer)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN s.fin_entry_id IS NULL THEN 0::bigint ELSE public.fin__paid(s.fin_entry_id) END,
         CASE WHEN c.moved THEN s.other_booked_cents ELSE o.booked_cents END,
         CASE WHEN c.moved THEN s.other_paid_cents ELSE o.paid_cents END,
         CASE WHEN c.moved THEN NULL::integer ELSE o.entries END
  FROM public.fin_hk_statements s
  LEFT JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
  CROSS JOIN LATERAL (
    SELECT coalesce(s.counterparty_id, e.counterparty_id) AS id,
           coalesce((SELECT coalesce(d.user_id, cp.staff_user_id) <> s.payee_user_id
                     FROM public.fin_counterparties cp
                     LEFT JOIN public.doctors d ON d.clinic_id = cp.clinic_id AND d.id = cp.doctor_id
                     WHERE cp.clinic_id = s.clinic_id AND cp.id = coalesce(s.counterparty_id, e.counterparty_id)),
                    false) AS moved
  ) c
  CROSS JOIN LATERAL public.fin__hk_other_sums(s.clinic_id, CASE WHEN c.moved THEN NULL ELSE c.id END, s.month,
                                               s.fin_entry_id) o
  WHERE s.clinic_id = p_clinic AND s.id = p_id
$$;

-- The same for a payee's month without a statement in force (an open month): the keyed entry under the payee's
-- counterparty now (fin__hk_payee_entry: physician counterparty with a doctors row, else the staff one) and the other
-- entries under that counterparty.
CREATE OR REPLACE FUNCTION public.fin__hk_payee_paid(p_clinic uuid, p_user uuid, p_month date)
RETURNS TABLE (entry_id uuid, entry_paid_cents bigint, other_booked_cents bigint, other_paid_cents bigint,
               other_count integer)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT k.id,
         CASE WHEN k.id IS NULL THEN 0::bigint ELSE public.fin__paid(k.id) END,
         o.booked_cents,
         o.paid_cents,
         o.entries
  FROM (SELECT public.fin__hk_payee_entry(p_clinic, p_user, p_month) AS id) k
  CROSS JOIN LATERAL public.fin__hk_other_sums(
    p_clinic,
    CASE WHEN EXISTS (SELECT 1 FROM public.doctors d WHERE d.clinic_id = p_clinic AND d.user_id = p_user)
         THEN (SELECT cp.id
               FROM public.doctors d
               JOIN public.fin_counterparties cp ON cp.clinic_id = d.clinic_id AND cp.doctor_id = d.id
               WHERE d.clinic_id = p_clinic AND d.user_id = p_user
               LIMIT 1)
         ELSE (SELECT cp.id
               FROM public.fin_counterparties cp
               WHERE cp.clinic_id = p_clinic AND cp.staff_user_id = p_user
               LIMIT 1)
    END,
    p_month,
    k.id) o
$$;

-- The payee's hakediş counterparty (0038; the 0032 close lines, moved unchanged): the one linked to the payee's doctors
-- row (physician) or, for staff, to the user ('existing', also when inactive: the caller decides); else an unlinked
-- counterparty of the payee's kind with the payee's name is linked ('linked'); else one is created ('created'). Any
-- other name clash is refused with the 0032 messages. A payee who is neither (no doctors row, not on the payroll path)
-- is refused with the close's message.
CREATE OR REPLACE FUNCTION public.fin__hk_ensure_counterparty(
  p_clinic uuid,
  p_payee uuid,
  p_name text,
  p_doctor uuid,
  p_staff boolean,
  p_user uuid,
  OUT o_counterparty_id uuid,
  OUT o_is_active boolean,
  OUT o_status text)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_payee uuid := p_payee;
  v_name text := p_name;
  v_doctor uuid := p_doctor;
  v_staff boolean := coalesce(p_staff, false);
  v_user uuid := p_user;
  v_cp uuid;
  v_cp_active boolean;
  v_other uuid;
  v_other_kind text;
  v_other_doctor uuid;
  v_other_staff uuid;
  v_other_active boolean;
BEGIN
  IF v_doctor IS NULL AND NOT v_staff THEN
    RAISE EXCEPTION '% için hekim kaydı yok, hakediş cari kaydı açılamadı. Önce Ekip ekranından hekim kaydını ekleyin.',
      v_name;
  END IF;

  IF v_doctor IS NOT NULL THEN
    SELECT cp.id, cp.is_active INTO v_cp, v_cp_active
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_doctor;
  ELSIF v_staff THEN
    SELECT cp.id, cp.is_active INTO v_cp, v_cp_active
    FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_payee;
  END IF;
  o_status := 'existing';

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
    o_status := CASE WHEN v_other IS NOT NULL THEN 'linked' ELSE 'created' END;
  END IF;

  o_counterparty_id := v_cp;
  o_is_active := v_cp_active;
END;
$$;

-- Nets one payee's month; the close and fin__hk_net_sync use this one rule. K = the entry keyed 'payroll:' (p_payroll)
-- or 'entitlement:' || counterparty || ':' || month (locked); target = p_total_cents − booked(O).
--   K missing:   created when target > 0, amount target. Staff: Personel, no subcategory / month, as the 0032 close.
--                Doctors: Hekim hakedişi as fin_add_entitlement writes it (past_physician_debt for a month before the
--                current one, entitlement_month, due on the 1st), without its session checks (the close checked the
--                counterparty; the trigger may run in a session without one).
--   K live:      amount := max(target, paid(K)); when that is 0 its remainder is cancelled as fin_cancel_entry does
--                (reason 'Hakediş ayrı kayıtlarla ödendi'). The description follows p_description (NULL keeps it).
--   K cancelled: when target > paid(K), reopened with amount target if the netting cancelled it (fin.ctx 'hk_netting',
--                accepted by fin__trg_entry_guard only for that reason on a hakediş / payroll key); cancelled by a
--                person it is left as it is and o_blocked is set (the close refuses, the sync does not).
-- o_overpaid_cents = max(0, paid(K) + booked(O) − p_total_cents); o_entry_id = K (NULL when none is needed).
CREATE OR REPLACE FUNCTION public.fin__hk_net_entry(
  p_clinic uuid,
  p_month date,
  p_counterparty_id uuid,
  p_payroll boolean,
  p_total_cents bigint,
  p_description text,
  OUT o_entry_id uuid,
  OUT o_other_booked_cents bigint,
  OUT o_other_paid_cents bigint,
  OUT o_overpaid_cents bigint,
  OUT o_blocked boolean)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_month date := public.fin__month_start(p_month);
  v_user uuid := public.current_app_user_id();
  v_key text;
  v_e public.fin_entries%ROWTYPE;
  v_paid bigint := 0;
  v_target bigint;
  v_new bigint;
  v_category uuid;
  v_category_active boolean;
  v_prev text;
BEGIN
  o_blocked := false;
  v_key := CASE WHEN p_payroll THEN 'payroll:' ELSE 'entitlement:' END || p_counterparty_id::text || ':'
           || to_char(v_month, 'YYYY-MM');

  SELECT * INTO v_e FROM public.fin_entries e WHERE e.clinic_id = p_clinic AND e.source_key = v_key FOR UPDATE;
  SELECT o.booked_cents, o.paid_cents INTO o_other_booked_cents, o_other_paid_cents
  FROM public.fin__hk_other_sums(p_clinic, p_counterparty_id, v_month, v_e.id) o;
  IF v_e.id IS NOT NULL THEN
    v_paid := public.fin__paid(v_e.id);
  END IF;
  v_target := p_total_cents - o_other_booked_cents;
  o_entry_id := v_e.id;
  o_overpaid_cents := greatest(0, v_paid + o_other_booked_cents - p_total_cents);

  IF v_e.id IS NULL THEN
    IF v_target > 0 THEN
      o_entry_id := gen_random_uuid();
      IF p_payroll THEN
        SELECT c.id INTO v_category
        FROM public.fin_categories c
        WHERE c.clinic_id = p_clinic AND c.report_bucket = 'personnel' AND c.is_system AND c.is_active;
        IF v_category IS NULL THEN
          RAISE EXCEPTION 'Personel gider kategorisi bulunamadı veya pasif. Finans → Kategoriler ekranında "Personel" kategorisini aktifleştirin, sonra ayı kapatın.';
        END IF;
        INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                        description, due_date, amount_cents, entitlement_month, source_key,
                                        created_by, updated_by)
        VALUES (o_entry_id, p_clinic, v_category, NULL, p_counterparty_id, NULL,
                coalesce(p_description, ''), v_month, v_target, NULL, v_key, v_user, v_user);
      ELSE
        SELECT c.id, c.is_active INTO v_category, v_category_active
        FROM public.fin_categories c
        WHERE c.clinic_id = p_clinic AND c.report_bucket = 'doctor' AND c.is_system;
        IF v_category IS NULL OR NOT v_category_active THEN
          RAISE EXCEPTION 'Hekim hakedişi kategorisi bulunamadı veya pasif.';
        END IF;
        INSERT INTO public.fin_entries (id, clinic_id, category_id, subcategory, counterparty_id, counterparty_text,
                                        description, due_date, amount_cents, entitlement_month, source_key,
                                        created_by, updated_by)
        VALUES (o_entry_id, p_clinic, v_category,
                CASE WHEN v_month < public.fin__month_start(public.clinic_today()) THEN 'past_physician_debt'
                     ELSE 'current_physician' END,
                p_counterparty_id, NULL, coalesce(p_description, ''), v_month, v_target, v_month, v_key,
                v_user, v_user);
      END IF;
    END IF;
  ELSIF v_e.cancelled_at IS NOT NULL THEN
    IF v_target > v_paid THEN
      IF v_e.cancel_reason = 'Hakediş ayrı kayıtlarla ödendi' THEN
        v_prev := public.fin__set_ctx('hk_netting');
        UPDATE public.fin_entries e
        SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, amount_cents = v_target,
            description = coalesce(p_description, e.description)
        WHERE e.clinic_id = p_clinic AND e.id = v_e.id;
        PERFORM public.fin__set_ctx(v_prev);
      ELSE
        o_blocked := true;
      END IF;
    END IF;
  ELSE
    v_new := greatest(v_target, v_paid);
    IF v_new = 0 THEN
      UPDATE public.fin_entries e
      SET cancelled_at = now(), cancelled_by = v_user, cancel_reason = 'Hakediş ayrı kayıtlarla ödendi',
          description = coalesce(p_description, e.description)
      WHERE e.clinic_id = p_clinic AND e.id = v_e.id;
    ELSIF v_e.amount_cents IS DISTINCT FROM v_new
          OR v_e.description IS DISTINCT FROM coalesce(p_description, v_e.description) THEN
      UPDATE public.fin_entries e
      SET amount_cents = v_new, description = coalesce(p_description, e.description)
      WHERE e.clinic_id = p_clinic AND e.id = v_e.id;
    END IF;
  END IF;
END;
$$;

-- Statement guard (0030 body, same signature; SECURITY DEFINER trigger function, never granted): + the netting
-- columns of a statement in force (see above).
CREATE OR REPLACE FUNCTION public.fin__trg_hk_statement_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 0038: the netting figures of a statement in force follow its payee's other entries (fin__hk_net_sync), which also
  -- binds its counterparty and links a keyed entry once (NULL → value). Everything else stays frozen; a superseded
  -- statement stays as it is.
  IF (to_jsonb(NEW) - ARRAY['superseded_at', 'superseded_by', 'other_booked_cents', 'other_paid_cents',
                            'overpaid_cents', 'counterparty_id', 'fin_entry_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_at', 'superseded_by', 'other_booked_cents',
                                             'other_paid_cents', 'overpaid_cents', 'counterparty_id', 'fin_entry_id'])
     OR (OLD.superseded_at IS NOT NULL
         AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
              OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
              OR (NEW.other_booked_cents, NEW.other_paid_cents, NEW.overpaid_cents, NEW.counterparty_id,
                  NEW.fin_entry_id)
                 IS DISTINCT FROM (OLD.other_booked_cents, OLD.other_paid_cents, OLD.overpaid_cents,
                                   OLD.counterparty_id, OLD.fin_entry_id)))
     OR (OLD.counterparty_id IS NOT NULL AND NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id)
     OR (OLD.fin_entry_id IS NOT NULL AND NEW.fin_entry_id IS DISTINCT FROM OLD.fin_entry_id) THEN
    RAISE EXCEPTION 'Bu alan değiştirilemez.';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Month close (finance writers, 0032 body, same signature). 0038: the payee's other entries of the month are
--    deducted (fin__hk_net_entry); counterparty link / create moved to fin__hk_ensure_counterparty; an overpayment
--    is recorded on the statement instead of refused. Locks, version check, unruled / negative checks unchanged.
-- ---------------------------------------------------------------------------

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
  v_entry uuid;
  v_entry_amount bigint;
  v_entry_cancelled boolean;
  v_entry_desc text;
  v_desc text;
  v_staff boolean;
  v_prefix text;
  v_other_booked bigint;
  v_other_paid bigint;
  v_overpaid bigint;
  v_blocked boolean;
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
  -- amount: missing from the computation (rule moved to another payee or ended). 0038: a payee with a 0 total is
  -- netted in the loop below (its unpaid entry's remainder is cancelled), no longer refused here.
  SELECT string_agg(DISTINCT coalesce(u.full_name, '?'), ', ' ORDER BY coalesce(u.full_name, '?'))
    INTO v_bad
  FROM public.fin_hk_statements s
  JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id AND e.cancelled_at IS NULL
  LEFT JOIN public.users u ON u.id = s.payee_user_id
  WHERE s.clinic_id = v_clinic AND s.month = v_month
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_c -> 'payees') p
      WHERE (p ->> 'payee_user_id')::uuid = s.payee_user_id);
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
    v_other_booked := 0;
    v_other_paid := 0;
    v_overpaid := 0;
    v_blocked := false;

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

    -- 0038: a 0 total no longer refuses a live entry of the month: the netting below cancels its unpaid remainder (or
    -- keeps what was paid on it, an overpayment). A counterparty is linked / created only for a payable total, as
    -- before.
    IF v_total > 0 THEN
      IF v_doctor IS NULL AND NOT v_staff THEN
        RAISE EXCEPTION '% için hekim kaydı yok, hakediş cari kaydı açılamadı. Önce Ekip ekranından hekim kaydını ekleyin.',
          v_name;
      END IF;

      IF v_cp IS NULL THEN
        -- 0038: the 0032 lines (an unlinked counterparty of the payee's kind with the payee's name is linked, else one
        -- is created; any other name clash is refused) moved unchanged to fin__hk_ensure_counterparty.
        SELECT c.o_counterparty_id, c.o_is_active INTO v_cp, v_cp_active
        FROM public.fin__hk_ensure_counterparty(v_clinic, v_payee, v_name, v_doctor, v_staff, v_user) c;
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
    END IF;

    -- A live entry of this payee linked by any earlier statement of the month must be the one found above (same
    -- counterparty key); one under another counterparty (doctor relinked since, or a staff payee who got a doctors
    -- row) would be a second payable. Every earlier statement is checked, so a later statement without an entry
    -- cannot hide an older live one. 0038: for a 0 total too.
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

    -- 0038: the payee's other entries of the month (same counterparty, entitlement month, Hekim hakedişi / Personel,
    -- not excluded; fin__hk_net_entry) are deducted: the keyed entry keeps total − their booked amount, at least what
    -- was paid on it; it is created only when that is positive and its unpaid remainder is cancelled when nothing is
    -- left. An overpayment is recorded on the statement (OVERPAID), never refused.
    IF v_cp IS NOT NULL THEN
      IF v_staff THEN
        v_desc := public.fin__hk_payroll_description(v_p, v_month);
      ELSE
        v_desc := public.fin__hk_description(v_p, v_month, v_doctor);
      END IF;

      SELECT n.o_entry_id, n.o_other_booked_cents, n.o_other_paid_cents, n.o_overpaid_cents, n.o_blocked
        INTO v_entry, v_other_booked, v_other_paid, v_overpaid, v_blocked
      FROM public.fin__hk_net_entry(v_clinic, v_month, v_cp, v_staff, v_total, v_desc) n;
      -- Cancelled by a person (not by the netting) with an amount still payable: the 0032 refusal.
      IF v_blocked THEN
        IF v_staff THEN
          RAISE EXCEPTION '% için bu ayın maaş kaydı iptal edilmiş; iptal geri alınamadığı için aynı ay için yeni maaş kaydı açılamaz. Ayı kapatmak için bu kişinin bu ayki tutarını 0 yapın (sabit maaş / taban maaş kurallarının aylarını düzeltin, prim / diğer satırlarını iptal edin); ödenecek tutarı Finans ekranında ayrı bir personel gideri olarak girin.',
            v_name;
        END IF;
        RAISE EXCEPTION '% için bu ayın hakediş kaydı iptal edilmiş; iptal geri alınamadığı için aynı ay için yeni kayıt açılamaz. Ayı kapatmak için Cariler ekranında hekimi yeni bir hekim carisine bağlayın (eski cariyi bağlantısız bırakıp adını değiştirin).',
          v_name;
      END IF;
    ELSE
      v_entry := NULL;
    END IF;

    INSERT INTO public.fin_hk_statements (clinic_id, month, payee_user_id, total_cents, breakdown, fin_entry_id,
                                          created_by, other_booked_cents, other_paid_cents, overpaid_cents,
                                          counterparty_id, entry_kind)
    VALUES (v_clinic, v_month, v_payee, v_total, v_p, v_entry, v_user, v_other_booked, v_other_paid, v_overpaid,
            v_cp, CASE WHEN v_staff THEN 'payroll' ELSE 'entitlement' END);
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
-- 4. After the close: an entry booked, changed, cancelled or excluded under a payee's counterparty (or typed as its
--    name) and a closed month re-nets that month's statement with the close's rule; so does a payment voided or
--    corrected on such an entry once it is cancelled (its booked amount is what was paid on it).
-- ---------------------------------------------------------------------------

-- Re-nets the statements in force of closed months written by this file's close (entry_kind set) that an entry under
-- p_counterparty_id with entitlement month p_month belongs to: a statement netted against that counterparty while it
-- is unlinked or still linked to the statement's payee (one linked to another person since re-nets nothing of the
-- earlier payee: that person's entries are not the earlier payee's, fin__hk_statement_paid then shows the figures of
-- the last sync); and a statement closed without a counterparty, of the payee the counterparty is linked to now and
-- of its kind (payroll: staff; entitlement: physician), when no statement in force of that month nets the
-- counterparty already (it is then bound to it). Same rule as the close (fin__hk_net_entry with the statement's total,
-- entry kind and the close's description); the statement's netting figures follow and a keyed entry created here is
-- linked. A keyed entry cancelled by a person is left as it is (nothing is refused here). The clinic's close lock and
-- the month lock are taken shared first, as fin__hk_check_open: a close / reopen in progress is waited for and its
-- result seen.
CREATE OR REPLACE FUNCTION public.fin__hk_net_sync(p_clinic uuid, p_counterparty_id uuid, p_month date)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_month date := public.fin__month_start(p_month);
  v_payee uuid;
  v_is_staff boolean;
  v_s public.fin_hk_statements%ROWTYPE;
  v_doctor uuid;
  v_desc text;
  v_net record;
BEGIN
  IF p_clinic IS NULL OR p_counterparty_id IS NULL OR v_month IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(public.fin__hk_close_lock(p_clinic));
  PERFORM pg_advisory_xact_lock_shared(public.fin__hk_month_lock(p_clinic, v_month));

  -- The person the counterparty belongs to now (NULL: unlinked) and its kind.
  SELECT coalesce(d.user_id, cp.staff_user_id), cp.staff_user_id IS NOT NULL INTO v_payee, v_is_staff
  FROM public.fin_counterparties cp
  LEFT JOIN public.doctors d ON d.clinic_id = cp.clinic_id AND d.id = cp.doctor_id
  WHERE cp.clinic_id = p_clinic AND cp.id = p_counterparty_id;

  FOR v_s IN
    SELECT s.*
    FROM public.fin_hk_statements s
    JOIN public.fin_hk_months m ON m.clinic_id = s.clinic_id AND m.month = s.month AND m.status = 'closed'
    WHERE s.clinic_id = p_clinic AND s.month = v_month AND s.superseded_at IS NULL AND s.entry_kind IS NOT NULL
      AND ((s.counterparty_id = p_counterparty_id AND (v_payee IS NULL OR s.payee_user_id = v_payee))
           OR (s.counterparty_id IS NULL AND v_payee IS NOT NULL AND s.payee_user_id = v_payee
               AND (s.entry_kind = 'payroll') = v_is_staff
               AND NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s2
                               WHERE s2.clinic_id = s.clinic_id AND s2.month = s.month AND s2.superseded_at IS NULL
                                 AND s2.counterparty_id = p_counterparty_id)))
    ORDER BY s.id
    FOR UPDATE OF s
  LOOP
    IF v_s.entry_kind = 'payroll' THEN
      v_desc := public.fin__hk_payroll_description(v_s.breakdown, v_month);
    ELSE
      v_doctor := NULL;
      SELECT d.id INTO v_doctor FROM public.doctors d WHERE d.user_id = v_s.payee_user_id AND d.clinic_id = p_clinic;
      v_desc := public.fin__hk_description(v_s.breakdown, v_month, v_doctor);
    END IF;

    SELECT * INTO v_net
    FROM public.fin__hk_net_entry(p_clinic, v_month, p_counterparty_id, v_s.entry_kind = 'payroll', v_s.total_cents,
                                  v_desc);

    UPDATE public.fin_hk_statements s
    SET other_booked_cents = v_net.o_other_booked_cents,
        other_paid_cents = v_net.o_other_paid_cents,
        overpaid_cents = v_net.o_overpaid_cents,
        counterparty_id = p_counterparty_id,
        fin_entry_id = coalesce(s.fin_entry_id, v_net.o_entry_id)
    WHERE s.clinic_id = p_clinic AND s.id = v_s.id
      AND (s.other_booked_cents, s.other_paid_cents, s.overpaid_cents, s.counterparty_id, s.fin_entry_id)
          IS DISTINCT FROM (v_net.o_other_booked_cents, v_net.o_other_paid_cents, v_net.o_overpaid_cents,
                            p_counterparty_id, coalesce(s.fin_entry_id, v_net.o_entry_id));
  END LOOP;
END;
$$;

-- Trigger function (SECURITY DEFINER, never granted). An entry whose old or new (counterparty, entitlement month) is
-- set re-nets that month (fin__hk_net_sync; nothing happens for an open month). The counterparty is the entry's, or
-- for free text the one with that normalized name (as fin__hk_other_sums counts it). A hakediş / payroll entry is the
-- keyed entry of its own month, never another entry of it: its changes (the close, the netting itself, a finance
-- user's edit) start no sync, so the netting never recurses.
CREATE OR REPLACE FUNCTION public.fin__trg_hk_net_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_cp uuid;
  v_new_cp uuid;
BEGIN
  IF coalesce(NEW.source_key LIKE 'entitlement:%' OR NEW.source_key LIKE 'payroll:%', false) THEN
    RETURN NULL;
  END IF;
  -- Separate statements: OLD is not assigned on INSERT.
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.amount_cents, NEW.cancelled_at, NEW.counterparty_id, NEW.counterparty_text, NEW.entitlement_month,
        NEW.excluded_from_totals, NEW.category_id)
       IS NOT DISTINCT FROM
       (OLD.amount_cents, OLD.cancelled_at, OLD.counterparty_id, OLD.counterparty_text, OLD.entitlement_month,
        OLD.excluded_from_totals, OLD.category_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF NEW.entitlement_month IS NOT NULL THEN
    v_new_cp := coalesce(NEW.counterparty_id, (
      SELECT cp.id FROM public.fin_counterparties cp
      WHERE cp.clinic_id = NEW.clinic_id AND cp.normalized_name = public.fin__normalize_name(NEW.counterparty_text)));
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.entitlement_month IS NOT NULL THEN
      v_old_cp := coalesce(OLD.counterparty_id, (
        SELECT cp.id FROM public.fin_counterparties cp
        WHERE cp.clinic_id = OLD.clinic_id AND cp.normalized_name = public.fin__normalize_name(OLD.counterparty_text)));
    END IF;
    IF v_old_cp IS NOT NULL
       AND (v_old_cp, OLD.entitlement_month) IS DISTINCT FROM (v_new_cp, NEW.entitlement_month) THEN
      PERFORM public.fin__hk_net_sync(OLD.clinic_id, v_old_cp, OLD.entitlement_month);
    END IF;
  END IF;
  IF v_new_cp IS NOT NULL THEN
    PERFORM public.fin__hk_net_sync(NEW.clinic_id, v_new_cp, NEW.entitlement_month);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS fin_hk_net_sync ON public.fin_entries;
CREATE TRIGGER fin_hk_net_sync
  AFTER INSERT OR UPDATE OF amount_cents, cancelled_at, counterparty_id, counterparty_text, entitlement_month,
                            excluded_from_totals, category_id ON public.fin_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_net_sync();

-- Trigger function (SECURITY DEFINER, never granted). A payment voided or corrected on a CANCELLED entry changes that
-- entry's booked amount (what was paid on it; fin_void_payment / fin_correct_payment stay allowed there, 0020 C1), so
-- it re-nets the entry's month as an entry change does. On a live entry booked is the amount and nothing is re-netted
-- (Ödenen is read live). Not on INSERT: fin__trg_payment_guard refuses a payment on a cancelled entry. A hakediş /
-- payroll entry starts no sync (no recursion); an entry without a month (a patient financing entry has none) neither.
-- The entry row is locked first by the payment RPCs, then the netting's locks, as for an entry change.
CREATE OR REPLACE FUNCTION public.fin__trg_hk_net_sync_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_e record;
  v_cp uuid;
BEGIN
  IF (NEW.amount_cents, NEW.voided_at IS NULL) IS NOT DISTINCT FROM (OLD.amount_cents, OLD.voided_at IS NULL) THEN
    RETURN NULL;
  END IF;
  SELECT e.clinic_id, e.counterparty_id, e.counterparty_text, e.entitlement_month, e.cancelled_at, e.source_key
    INTO v_e
  FROM public.fin_entries e
  WHERE e.clinic_id = NEW.clinic_id AND e.id = NEW.entry_id;
  IF v_e.cancelled_at IS NULL OR v_e.entitlement_month IS NULL
     OR coalesce(v_e.source_key LIKE 'entitlement:%' OR v_e.source_key LIKE 'payroll:%', false) THEN
    RETURN NULL;
  END IF;
  v_cp := coalesce(v_e.counterparty_id, (
    SELECT cp.id FROM public.fin_counterparties cp
    WHERE cp.clinic_id = v_e.clinic_id AND cp.normalized_name = public.fin__normalize_name(v_e.counterparty_text)));
  IF v_cp IS NOT NULL THEN
    PERFORM public.fin__hk_net_sync(v_e.clinic_id, v_cp, v_e.entitlement_month);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS fin_hk_net_sync_payment ON public.fin_payments;
CREATE TRIGGER fin_hk_net_sync_payment
  AFTER UPDATE OF amount_cents, voided_at ON public.fin_payments
  FOR EACH ROW EXECUTE FUNCTION public.fin__trg_hk_net_sync_payment();

-- ---------------------------------------------------------------------------
-- 5. "Hakediş carilerini hazırla" (finance writers): the counterparty of every payee, so import rules can name it.
-- ---------------------------------------------------------------------------

-- Every user of the clinic with a hakediş rule (any kind and month) or a live adjustment, by name: a physician
-- counterparty for a doctors row; a staff counterparty without one when every rule of the payee is fixed_monthly /
-- bank_portion / minimum_monthly (the close's payroll path), else 'no_doctor' with the close's message. The
-- counterparty comes from fin__hk_ensure_counterparty ('existing' / 'linked' / 'created'); its refusal for one payee
-- is reported ('error', message) and does not stop the others. Idempotent. Takes the clinic's close lock, as a close
-- links and creates the same counterparties.
CREATE OR REPLACE FUNCTION public.fin_hk_ensure_counterparties()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.fin__require_write();
  v_user uuid := public.current_app_user_id();
  v_p record;
  v_doctor uuid;
  v_staff boolean;
  v_cp uuid;
  v_active boolean;
  v_status text;
  v_err text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(public.fin__hk_close_lock(v_clinic));

  FOR v_p IN
    SELECT u.id, u.full_name
    FROM public.users u
    WHERE u.clinic_id = v_clinic
      AND (EXISTS (SELECT 1 FROM public.fin_hk_rules r WHERE r.clinic_id = v_clinic AND r.payee_user_id = u.id)
           OR EXISTS (SELECT 1 FROM public.fin_hk_adjustments a
                      WHERE a.clinic_id = v_clinic AND a.payee_user_id = u.id AND a.voided_at IS NULL))
    ORDER BY u.full_name COLLATE "tr-x-icu", u.id
  LOOP
    v_doctor := NULL;
    v_cp := NULL;
    v_active := NULL;
    v_status := NULL;
    v_err := NULL;

    SELECT d.id INTO v_doctor FROM public.doctors d WHERE d.user_id = v_p.id AND d.clinic_id = v_clinic;
    v_staff := v_doctor IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.fin_hk_rules r
      WHERE r.clinic_id = v_clinic AND r.payee_user_id = v_p.id
        AND r.kind NOT IN ('fixed_monthly', 'bank_portion', 'minimum_monthly'));

    IF v_doctor IS NULL AND NOT v_staff THEN
      v_status := 'no_doctor';
      v_err := format('%s için hekim kaydı yok, hakediş cari kaydı açılamadı. Önce Ekip ekranından hekim kaydını ekleyin.',
                      v_p.full_name);
    ELSE
      BEGIN
        SELECT c.o_counterparty_id, c.o_is_active, c.o_status INTO v_cp, v_active, v_status
        FROM public.fin__hk_ensure_counterparty(v_clinic, v_p.id, v_p.full_name, v_doctor, v_staff, v_user) c;
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        v_status := 'error';
        v_cp := NULL;
        v_active := NULL;
      END;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'payee_user_id', v_p.id,
      'payee_name', v_p.full_name,
      'kind', CASE WHEN v_doctor IS NOT NULL THEN 'physician' WHEN v_staff THEN 'staff' END,
      'counterparty_id', v_cp,
      'counterparty_name', (SELECT cp.name FROM public.fin_counterparties cp
                            WHERE cp.clinic_id = v_clinic AND cp.id = v_cp),
      'is_active', v_active,
      'status', v_status,
      'message', v_err));
  END LOOP;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Views (same signatures): Ödenen / Kalan with the payee's other entries, read live; payments stay ledger data
--    (fin__hk_strip_ledger); hk_my_* stay the caller's own. Visibility (owner decision 2026-10-21): the bank / cash
--    split (bank_cents / cash_cents, BANK_OVER_TOTAL, a bank_portion rule's amount and note) reaches only
--    'finance' / 'finance_readonly' holders; the payee's own view (hk_my_*) shows total, Ödenen and Kalan only;
--    hk_my_* refuse reception, assistants and admins.
-- ---------------------------------------------------------------------------

-- RuleJson of fin_hk_reference and fin_hk_save_rule (0034 body, same signature) + 0038: no bank_portion amount or
-- note for a caller without 'finance' / 'finance_readonly'.
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
           -- 0038 (owner decision 2026-10-21): a bank_portion rule's amount and note are the bank / cash split, finance
           -- data: NULL / '' for a caller without 'finance' / 'finance_readonly' (the preparer keeps the rule, its
           -- payee and months). Every other kind as before.
           'piece_cents', CASE WHEN r.kind = 'bank_portion' AND NOT coalesce(public.fin_can_read(), false) THEN NULL
                               ELSE r.piece_cents END,
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
           'note', CASE WHEN r.kind = 'bank_portion' AND NOT coalesce(public.fin_can_read(), false) THEN ''
                        ELSE r.note END,
           'created_at', r.created_at,
           'created_by_name', public.fin__user_name(r.created_by),
           'updated_at', r.updated_at,
           'updated_by_name', public.fin__user_name(r.updated_by))
  FROM public.fin_hk_rules r
  LEFT JOIN public.users pu ON pu.id = r.payee_user_id
  LEFT JOIN public.fin_hk_proc_groups g ON g.clinic_id = r.clinic_id AND g.id = r.proc_group_id
  WHERE r.clinic_id = p_clinic AND r.id = p_id
$$;

-- StatementJson (0030 body, same signature) + the live payment figures (0038).
CREATE OR REPLACE FUNCTION public.fin__hk_statement_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'id', s.id,
           'month', s.month,
           'payee_user_id', s.payee_user_id,
           'payee_name', u.full_name,
           'total_cents', s.total_cents,
           'breakdown', s.breakdown,
           'fin_entry_id', s.fin_entry_id,
           'entry', CASE WHEN e.id IS NULL THEN NULL
                         ELSE jsonb_build_object(
                                'id', e.id,
                                'version', e.version,
                                'amount_cents', e.amount_cents,
                                'paid_cents', public.fin__paid(e.id),
                                'outstanding_cents', CASE WHEN e.cancelled_at IS NOT NULL THEN 0
                                                          ELSE e.amount_cents - public.fin__paid(e.id) END,
                                'is_cancelled', e.cancelled_at IS NOT NULL)
                    END,
           'created_at', s.created_at,
           'created_by_name', public.fin__user_name(s.created_by),
           'superseded_at', s.superseded_at,
           -- 0038 (live): the payee's other entries of the month; Ödenen = paid on the keyed entry + on the others,
           -- Kalan = total − Ödenen (negative: overpaid); overpaid = paid on the keyed entry + booked on the others −
           -- total, at least 0.
           'other_booked_cents', x.other_booked_cents,
           'other_paid_cents', x.other_paid_cents,
           'other_count', x.other_count,
           'paid_cents', x.entry_paid_cents + x.other_paid_cents,
           'remaining_cents', s.total_cents - x.entry_paid_cents - x.other_paid_cents,
           'overpaid_cents', greatest(0, x.entry_paid_cents + x.other_booked_cents - s.total_cents))
  FROM public.fin_hk_statements s
  LEFT JOIN public.users u ON u.id = s.payee_user_id
  LEFT JOIN public.fin_entries e ON e.clinic_id = s.clinic_id AND e.id = s.fin_entry_id
  CROSS JOIN LATERAL public.fin__hk_statement_paid(s.clinic_id, s.id) x
  WHERE s.clinic_id = p_clinic AND s.id = p_id
$$;

-- The payload of a caller without ledger access (0035 body, same signature) + 0038: no payment figure (statement
-- keys, fin_entry_id, payees[].paid_so_far, booked_so_far, OVERPAID) and no bank / cash split
-- (payees[] and statements[].breakdown bank_cents / cash_cents, BANK_OVER_TOTAL).
CREATE OR REPLACE FUNCTION public.fin__hk_strip_ledger(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p || jsonb_build_object(
    'payees', coalesce((
      -- 0038: what was paid / booked so far in an open month is ledger data; the bank / cash split (bank_cents /
      -- cash_cents) is finance data (owner decision 2026-10-21: the preparer sees the totals, not the split).
      SELECT jsonb_agg(x.e - ARRAY['counterparty_id', 'paid_so_far', 'booked_so_far', 'bank_cents', 'cash_cents']
                       ORDER BY x.o)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p -> 'payees') = 'array' THEN p -> 'payees' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS x(e, o)), '[]'::jsonb),
    'warnings', coalesce((
      -- 0035 (v2.3): the day and the patient of an unmatched Burgan financing, never its amount.
      SELECT jsonb_agg(CASE WHEN (w.e ->> 'code') = 'FINANCING_UNMATCHED'
                            THEN w.e || jsonb_build_object('financings', coalesce((
                                   SELECT jsonb_agg(CASE WHEN jsonb_typeof(f.x) = 'object' THEN f.x - 'gross_cents'
                                                         ELSE f.x END
                                                    ORDER BY f.i)
                                   FROM jsonb_array_elements(
                                          CASE WHEN jsonb_typeof(w.e -> 'financings') = 'array'
                                               THEN w.e -> 'financings' ELSE '[]'::jsonb END)
                                          WITH ORDINALITY AS f(x, i)), '[]'::jsonb))
                            ELSE w.e END
                       ORDER BY w.o)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p -> 'warnings') = 'array' THEN p -> 'warnings' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS w(e, o)
      -- 0038: OVERPAID is ledger data; BANK_OVER_TOTAL carries a payee's bank amount (finance data).
      WHERE (w.e ->> 'code') IS DISTINCT FROM 'NO_COUNTERPARTY'
        AND (w.e ->> 'code') IS DISTINCT FROM 'OVERPAID'
        AND (w.e ->> 'code') IS DISTINCT FROM 'BANK_OVER_TOTAL'), '[]'::jsonb),
    'statements', coalesce((
      -- 0038: and so are a statement's payment figures, and its keyed entry's id: since the netting a positive total
      -- without one means "paid by other entries", and the id appears when the sync creates the entry later.
      SELECT jsonb_agg((s.e - ARRAY['other_booked_cents', 'other_paid_cents', 'other_count', 'paid_cents',
                                    'remaining_cents', 'overpaid_cents'])
                       || jsonb_build_object(
                         'entry', NULL::jsonb,
                         'fin_entry_id', NULL::jsonb,
                         'breakdown', CASE WHEN jsonb_typeof(s.e -> 'breakdown') = 'object'
                                           -- 0038: and the frozen bank / cash split (finance data).
                                           THEN (s.e -> 'breakdown') - ARRAY['counterparty_id', 'bank_cents',
                                                                              'cash_cents']
                                           ELSE s.e -> 'breakdown' END)
                       ORDER BY s.o)
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p -> 'statements') = 'array' THEN p -> 'statements' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS s(e, o)), '[]'::jsonb))
$$;

-- Month payload of fin_hk_month / fin_hk_close_month / fin_hk_reopen_month (0035 body, same signature) + 0038:
-- OVERPAID (closed months) and payees[].{paid_so_far, booked_so_far} (open months).
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
                                 'lab_part', ev.lab_part_cents,
                                 'resolved_method', ev.resolved_method,
                                 'financing_cents', ev.financing_cents,
                                 'fee_cents', ev.fee_cents)
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
  -- 0038: a closed month warns of every statement paid above its total (OVERPAID, live, in the statements' order:
  -- the owner decides the offset); an open month shows per payee what was paid for it so far (the keyed entry and
  -- the payee's other entries, fin__hk_payee_paid) and what is booked for it so far (the other entries' booked amount,
  -- unpaid planned ones included, + what was paid on the keyed entry: what the close deducts); finance readers only.
  IF (v_result ->> 'status') = 'closed' THEN
    v_result := v_result || jsonb_build_object('warnings', coalesce(v_result -> 'warnings', '[]'::jsonb) || coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'code', 'OVERPAID',
               'payee_user_id', t.st -> 'payee_user_id',
               'payee_name', t.st -> 'payee_name',
               'overpaid_cents', (t.st ->> 'overpaid_cents')::bigint)
               ORDER BY t.o)
      FROM jsonb_array_elements(v_result -> 'statements') WITH ORDINALITY AS t(st, o)
      WHERE (t.st ->> 'overpaid_cents')::bigint > 0), '[]'::jsonb));
  ELSIF v_ledger THEN
    v_result := v_result || jsonb_build_object('payees', coalesce((
      SELECT jsonb_agg(p.e || jsonb_build_object(
               'paid_so_far', x.entry_paid_cents + x.other_paid_cents,
               'booked_so_far', x.entry_paid_cents + x.other_booked_cents)
               ORDER BY p.o)
      FROM jsonb_array_elements(v_result -> 'payees') WITH ORDINALITY AS p(e, o)
      CROSS JOIN LATERAL public.fin__hk_payee_paid(p_clinic, (p.e ->> 'payee_user_id')::uuid, v_month) x),
      '[]'::jsonb));
  END IF;

  IF NOT v_ledger THEN
    v_result := public.fin__hk_strip_ledger(v_result);
  END IF;
  RETURN v_result;
END;
$$;

-- The caller's months (0032 body, same signature) + 0038: paid_cents = Ödenen with the caller's other entries,
-- remaining_cents = Kalan (closed months), other_paid_cents, overpaid_cents; no bank_cents / cash_cents (owner
-- decision 2026-10-21); reception, assistants and admins refused.
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
  v_stmt uuid;
  v_entry_paid bigint;
  v_other_booked bigint;
  v_other_paid bigint;
  v_overpaid bigint;
  v_paid bigint;
  v_remaining bigint;
  v_months jsonb := '[]'::jsonb;
BEGIN
  IF v_clinic IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı. Lütfen yeniden giriş yapın.' USING ERRCODE = '42501';
  END IF;
  -- 0038: Hakedişim is for the payees (doctors and the owner), as the web menu (SECTIONS_CLOSED_FOR['/hakedisim']):
  -- reception, assistants and admins are refused whatever permissions they hold (finance holders use the finance
  -- views).
  IF coalesce(public.current_app_role() IN ('reception', 'assistant', 'admin'), false) THEN
    RAISE EXCEPTION 'Hakedişim yalnızca hekimlere ve klinik sahibine açıktır.' USING ERRCODE = '42501';
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
    v_stmt := NULL;
    v_overpaid := NULL;
    v_paid := 0;
    v_remaining := NULL;

    SELECT m.status INTO v_status FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = v_m;
    v_status := coalesce(v_status, 'open');

    IF v_status = 'closed' THEN
      SELECT s.id, s.total_cents, s.fin_entry_id INTO v_stmt, v_total, v_entry
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
        SELECT (p ->> 'total_cents')::bigint INTO v_total
        FROM jsonb_array_elements(public.fin__hk_compute(v_clinic, v_m) -> 'payees') p
        WHERE (p ->> 'payee_user_id') = v_user::text;
      END IF;
      v_entry := public.fin__hk_payee_entry(v_clinic, v_user, v_m);
    END IF;
    v_total := coalesce(v_total, 0);

    -- 0038 (live): Ödenen = paid on the keyed entry + on the caller's other entries of the month (the statement's
    -- counterparty when closed, else the caller's own now); Kalan = total − Ödenen for a closed month (negative:
    -- overpaid).
    IF v_stmt IS NOT NULL THEN
      SELECT x.entry_paid_cents, x.other_booked_cents, x.other_paid_cents
        INTO v_entry_paid, v_other_booked, v_other_paid
      FROM public.fin__hk_statement_paid(v_clinic, v_stmt) x;
    ELSE
      SELECT x.entry_paid_cents, x.other_booked_cents, x.other_paid_cents
        INTO v_entry_paid, v_other_booked, v_other_paid
      FROM public.fin__hk_payee_paid(v_clinic, v_user, v_m) x;
    END IF;
    v_paid := v_entry_paid + v_other_paid;
    IF v_status = 'closed' THEN
      v_remaining := v_total - v_paid;
      v_overpaid := greatest(0, v_entry_paid + v_other_booked - v_total);
    END IF;

    -- 0038 (owner decision 2026-10-21): total, Ödenen and Kalan only; the bank / cash split stays in the finance
    -- views (the total is computed as before).
    v_months := v_months || jsonb_build_array(jsonb_build_object(
      'month', v_m,
      'status', v_status,
      'is_estimate', v_status <> 'closed',
      'total_cents', v_total,
      'paid_cents', v_paid,
      'remaining_cents', v_remaining,
      'other_paid_cents', v_other_paid,
      'overpaid_cents', v_overpaid));
  END LOOP;

  RETURN jsonb_build_object('has_rules', true, 'today', v_today, 'current_month', v_current, 'months', v_months);
END;
$$;

-- The caller's own payee object of hk_my_month (0032 body, same signature) + 0038: without bank_cents / cash_cents.
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
           -- 0038 (owner decision 2026-10-21): no bank / cash split in the payee's own view; it stays in the finance
           -- views.
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

-- The caller's own month (0035 body, same signature) + 0038: statement.{paid_cents, remaining_cents,
-- other_booked_cents, other_paid_cents, overpaid_cents} (closed), paid_so_far (open); payees[] without the
-- bank / cash split (fin__hk_self_payee); reception, assistants and admins refused.
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
  v_stmt_id uuid;
  v_paid_so_far bigint;
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
  -- 0038: Hakedişim is for the payees (doctors and the owner), as the web menu (SECTIONS_CLOSED_FOR['/hakedisim']):
  -- reception, assistants and admins are refused whatever permissions they hold (finance holders use the finance
  -- views).
  IF coalesce(public.current_app_role() IN ('reception', 'assistant', 'admin'), false) THEN
    RAISE EXCEPTION 'Hakedişim yalnızca hekimlere ve klinik sahibine açıktır.' USING ERRCODE = '42501';
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
    SELECT s.id, s.total_cents, s.created_at, s.fin_entry_id, s.breakdown
      INTO v_stmt_id, v_stmt_total, v_stmt_at, v_stmt_entry, v_stmt_breakdown
    FROM public.fin_hk_statements s
    WHERE s.clinic_id = v_clinic AND s.month = v_month AND s.payee_user_id = v_user AND s.superseded_at IS NULL;
    IF v_stmt_breakdown IS NOT NULL THEN
      v_payees := jsonb_build_array(public.fin__hk_self_payee(v_stmt_breakdown));
      -- 0038 (live): Ödenen / Kalan with the caller's other entries of the month, as fin_hk_month's statements.
      SELECT jsonb_build_object('total_cents', v_stmt_total, 'closed_at', v_stmt_at,
                                'paid_cents', x.entry_paid_cents + x.other_paid_cents,
                                'remaining_cents', v_stmt_total - x.entry_paid_cents - x.other_paid_cents,
                                'other_booked_cents', x.other_booked_cents,
                                'other_paid_cents', x.other_paid_cents,
                                'overpaid_cents', greatest(0, x.entry_paid_cents + x.other_booked_cents
                                                              - v_stmt_total))
        INTO v_statement
      FROM public.fin__hk_statement_paid(v_clinic, v_stmt_id) x;
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
    -- 0038: what was paid for the month so far (the keyed entry and the caller's other entries).
    SELECT x.entry_paid_cents + x.other_paid_cents INTO v_paid_so_far
    FROM public.fin__hk_payee_paid(v_clinic, v_user, v_month) x;
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
             'counted', coalesce(ev.payee_user_id = v_user, false),
             -- 0035 (v2.3): "Finansman (Burgan)" with the bank's fee share of the line.
             'resolved_method', ev.resolved_method,
             'financing_cents', ev.financing_cents,
             'fee_cents', ev.fee_cents)
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
    'entitlement', v_entitlement,
    'paid_so_far', v_paid_so_far);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges: fin__harden_privileges (0022) revokes and re-grants every fin_* function: the public RPCs (fin_*,
--    incl. the new fin_hk_ensure_counterparties and the recreated fin_save_classification_rule) granted to
--    authenticated, internals (fin__*, incl. the new helpers and trigger functions) never; plus its self-checks over
--    every fin_* function (no overloads) and table. hk_my_months / hk_my_month keep their ACL (CREATE OR REPLACE);
--    repeated for a re-run.
-- ---------------------------------------------------------------------------
SELECT public.fin__harden_privileges();

REVOKE EXECUTE ON FUNCTION public.hk_my_months() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_months() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hk_my_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_my_month(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8.1 Structural self-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_j jsonb;
  v_r record;
  v_fail text[] := '{}'::text[];
BEGIN
  -- 1. Signatures: the new and replaced functions exist once (no overload).
  SELECT string_agg(f.sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.fin__trg_entry_guard()',
    'public.fin__entry_input(uuid,uuid,text,uuid,text,text,date,bigint,text)',
    'public.fin__trg_rule_guard()',
    'public.fin__rule_json(uuid,uuid)',
    'public.fin_save_classification_rule(uuid,integer,integer,text,text,text,uuid,text,uuid,boolean,boolean,text,'
      || 'boolean,text)',
    'public.fin__hk_other_sums(uuid,uuid,date,uuid)',
    'public.fin__hk_statement_paid(uuid,uuid)',
    'public.fin__hk_payee_paid(uuid,uuid,date)',
    'public.fin__hk_ensure_counterparty(uuid,uuid,text,uuid,boolean,uuid)',
    'public.fin__hk_net_entry(uuid,date,uuid,boolean,bigint,text)',
    'public.fin__trg_hk_statement_guard()',
    'public.fin_hk_close_month(date,integer,boolean)',
    'public.fin__hk_net_sync(uuid,uuid,date)',
    'public.fin__trg_hk_net_sync()',
    'public.fin__trg_hk_net_sync_payment()',
    'public.fin_hk_ensure_counterparties()',
    'public.fin__hk_statement_json(uuid,uuid)',
    'public.fin__hk_strip_ledger(jsonb)',
    'public.fin__hk_month_json(uuid,date,date)',
    'public.fin__hk_rule_json(uuid,uuid)',
    'public.fin__hk_self_payee(jsonb)',
    'public.hk_my_months()',
    'public.hk_my_month(date)']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_bad IS NOT NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fin__trg_entry_guard', 'fin__entry_input', 'fin__trg_rule_guard', 'fin__rule_json',
                             'fin_save_classification_rule', 'fin__hk_other_sums', 'fin__hk_statement_paid',
                             'fin__hk_payee_paid', 'fin__hk_ensure_counterparty', 'fin__hk_net_entry',
                             'fin__trg_hk_statement_guard', 'fin_hk_close_month', 'fin__hk_net_sync',
                             'fin__trg_hk_net_sync', 'fin__trg_hk_net_sync_payment', 'fin_hk_ensure_counterparties',
                             'fin__hk_statement_json', 'fin__hk_strip_ledger', 'fin__hk_month_json',
                             'fin__hk_rule_json', 'fin__hk_self_payee', 'hk_my_months', 'hk_my_month')) <> 23 THEN
    RAISE EXCEPTION 'Hakediş v2.4 fonksiyon imzaları beklenen gibi değil: %', coalesce(v_bad, 'aşırı yükleme var');
  END IF;

  -- 2. The helpers stay internal (SECURITY INVOKER, not callable from the API); the trigger functions are SECURITY
  --    DEFINER and not callable either; the RPCs keep SECURITY DEFINER + search_path, callable by authenticated, never
  --    by anon.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__entry_input', 'fin__rule_json', 'fin__hk_other_sums', 'fin__hk_statement_paid',
                      'fin__hk_payee_paid', 'fin__hk_ensure_counterparty', 'fin__hk_net_entry', 'fin__hk_net_sync',
                      'fin__hk_statement_json', 'fin__hk_strip_ledger', 'fin__hk_month_json', 'fin__hk_rule_json',
                      'fin__hk_self_payee')
    AND (p.prosecdef
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç hakediş fonksiyonları API''ye açık veya SECURITY DEFINER: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin__trg_entry_guard', 'fin__trg_rule_guard', 'fin__trg_hk_statement_guard',
                      'fin__trg_hk_net_sync', 'fin__trg_hk_net_sync_payment')
    AND (NOT p.prosecdef
         OR p.prorettype <> 'trigger'::regtype
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Tetik fonksiyonları beklenen gibi değil: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fin_save_classification_rule', 'fin_hk_close_month', 'fin_hk_ensure_counterparties',
                      'fin_hk_month', 'fin_hk_reopen_month', 'hk_my_months', 'hk_my_month')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig))
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Hakediş v2.4 RPC yetkileri beklenen gibi değil: %', v_bad;
  END IF;

  -- 3. Columns, constraints, index and the triggers.
  SELECT string_agg(format('%s.%s', e.tbl, e.col), ', ') INTO v_bad
  FROM (VALUES
    ('fin_classification_rules', 'entitlement_month_default', 'text', 'NO'),
    ('fin_hk_statements', 'other_booked_cents', 'bigint', 'NO'),
    ('fin_hk_statements', 'other_paid_cents', 'bigint', 'NO'),
    ('fin_hk_statements', 'overpaid_cents', 'bigint', 'NO'),
    ('fin_hk_statements', 'counterparty_id', 'uuid', 'YES'),
    ('fin_hk_statements', 'entry_kind', 'text', 'YES')
  ) AS e(tbl, col, typ, nul)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col AND c.data_type = e.typ
      AND c.is_nullable = e.nul);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Yeni sütunlar beklenen gibi değil: %', v_bad;
  END IF;
  SELECT string_agg(e.con, ', ') INTO v_bad
  FROM (VALUES
    ('public.fin_classification_rules', 'fin_classification_rules_month_default', 'c'),
    ('public.fin_classification_rules', 'fin_classification_rules_month_default_req', 'c'),
    ('public.fin_hk_statements', 'fin_hk_statements_netting', 'c'),
    ('public.fin_hk_statements', 'fin_hk_statements_entry_kind', 'c'),
    ('public.fin_hk_statements', 'fin_hk_statements_counterparty_fkey', 'f')
  ) AS e(tbl, con, typ)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = e.tbl::regclass AND c.conname = e.con AND c.contype = e.typ::"char" AND c.convalidated);
  IF v_bad IS NOT NULL OR to_regclass('public.idx_fin_hk_statements_counterparty') IS NULL THEN
    RAISE EXCEPTION 'Yeni kısıtlar / indeks beklenen gibi değil: %',
      coalesce(v_bad, 'idx_fin_hk_statements_counterparty');
  END IF;
  SELECT t.tgenabled, pg_get_triggerdef(t.oid) AS def INTO v_r
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.fin_entries'::regclass AND t.tgname = 'fin_hk_net_sync' AND NOT t.tgisinternal;
  IF v_r.def IS NULL
     OR v_r.tgenabled <> 'O'
     OR v_r.def NOT LIKE '%AFTER INSERT OR UPDATE OF % ON % FOR EACH ROW EXECUTE FUNCTION %'
     OR v_r.def NOT LIKE '%fin__trg_hk_net_sync()'
     OR EXISTS (SELECT 1
                FROM unnest(ARRAY['amount_cents', 'cancelled_at', 'counterparty_id', 'counterparty_text',
                                  'entitlement_month', 'excluded_from_totals', 'category_id']) AS c(col)
                WHERE strpos(split_part(v_r.def, ' ON ', 1), c.col) = 0) THEN
    RAISE EXCEPTION 'fin_hk_net_sync tetiği beklenen gibi değil: %', coalesce(v_r.def, '-');
  END IF;
  SELECT t.tgenabled, pg_get_triggerdef(t.oid) AS def INTO v_r
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.fin_payments'::regclass AND t.tgname = 'fin_hk_net_sync_payment' AND NOT t.tgisinternal;
  IF v_r.def IS NULL
     OR v_r.tgenabled <> 'O'
     OR v_r.def NOT LIKE '%AFTER UPDATE OF % ON % FOR EACH ROW EXECUTE FUNCTION %'
     OR v_r.def NOT LIKE '%fin__trg_hk_net_sync_payment()'
     OR EXISTS (SELECT 1
                FROM unnest(ARRAY['amount_cents', 'voided_at']) AS c(col)
                WHERE strpos(split_part(v_r.def, ' ON ', 1), c.col) = 0) THEN
    RAISE EXCEPTION 'fin_hk_net_sync_payment tetiği beklenen gibi değil: %', coalesce(v_r.def, '-');
  END IF;

  -- 4. A caller without ledger access: no payment figure of a statement, no keyed entry id, no paid_so_far /
  --    booked_so_far, no OVERPAID; and (owner decision 2026-10-21) no bank / cash split: payees' and frozen
  --    breakdowns' bank_cents / cash_cents and BANK_OVER_TOTAL left out; everything else as 0035.
  v_j := public.fin__hk_strip_ledger(jsonb_build_object(
           'payees', jsonb_build_array(jsonb_build_object('payee_user_id', 1, 'total_cents', 5, 'counterparty_id', 2,
                                                          'paid_so_far', 3, 'booked_so_far', 4, 'bank_cents', 6,
                                                          'cash_cents', -1)),
           'warnings', jsonb_build_array(
             jsonb_build_object('code', 'OVERPAID', 'payee_user_id', 1, 'payee_name', 'X', 'overpaid_cents', 4),
             jsonb_build_object('code', 'BANK_OVER_TOTAL', 'payee_user_id', 1, 'payee_name', 'X', 'bank_cents', 6,
                                'total_cents', 5),
             jsonb_build_object('code', 'UNRULED_LAB', 'doctor_id', 3, 'lab_cents', 9)),
           'statements', jsonb_build_array(jsonb_build_object(
             'id', 7, 'total_cents', 5, 'fin_entry_id', 8, 'entry', jsonb_build_object('paid_cents', 1),
             'breakdown', jsonb_build_object('counterparty_id', 2, 'total_cents', 5, 'bank_cents', 6,
                                             'cash_cents', -1),
             'other_booked_cents', 1, 'other_paid_cents', 1, 'other_count', 1, 'paid_cents', 1,
             'remaining_cents', 4, 'overpaid_cents', 0))));
  IF v_j IS DISTINCT FROM jsonb_build_object(
       'payees', jsonb_build_array(jsonb_build_object('payee_user_id', 1, 'total_cents', 5)),
       'warnings', jsonb_build_array(jsonb_build_object('code', 'UNRULED_LAB', 'doctor_id', 3, 'lab_cents', 9)),
       'statements', jsonb_build_array(jsonb_build_object(
         'id', 7, 'total_cents', 5, 'fin_entry_id', NULL, 'entry', NULL,
         'breakdown', jsonb_build_object('total_cents', 5)))) THEN
    v_fail := array_append(v_fail, 'defter verisi olmadan: ' || left(v_j::text, 500));
  END IF;

  -- 5. The netting sums of an unknown clinic / counterparty: one row of zeros.
  SELECT concat_ws(':', count(*), coalesce(sum(o.booked_cents), -1), coalesce(sum(o.paid_cents), -1),
                   coalesce(sum(o.entries), -1))
    INTO v_bad
  FROM public.fin__hk_other_sums(gen_random_uuid(), gen_random_uuid(), DATE '2024-01-15', NULL) o;
  IF v_bad IS DISTINCT FROM '1:0:0:0' THEN
    v_fail := array_append(v_fail, 'boş netleştirme toplamı: ' || coalesce(v_bad, '-'));
  END IF;

  -- 6. The payee's own payee object (hk_my_month): total and components, no bank / cash split (owner decision
  --    2026-10-21).
  v_j := public.fin__hk_self_payee(jsonb_build_object(
           'payee_user_id', 1, 'payee_name', 'X', 'doctor_id', 3, 'counterparty_id', 2, 'total_cents', 5,
           'bank_cents', 6, 'cash_cents', -1,
           'components', jsonb_build_array(jsonb_build_object('kind', 'fixed_monthly', 'amount_cents', 5))));
  IF v_j IS DISTINCT FROM jsonb_build_object(
       'payee_user_id', 1, 'payee_name', 'X', 'total_cents', 5,
       'components', jsonb_build_array(jsonb_build_object('kind', 'fixed_monthly', 'amount_cents', 5))) THEN
    v_fail := array_append(v_fail, 'kendi hakediş nesnesi: ' || left(v_j::text, 500));
  END IF;

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'Hakediş v2.4 yapı denetimi: %', array_to_string(v_fail, ' | ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.2 Replay inside a block that is always rolled back: temporary clinic 'p38-test-hk-selfcheck-<random>' with an
--     owner (finance), doctors A and B (ciro share 50 %), doctor D (a rule, no lines; a supplier counterparty with
--     the same name), assistant S (fixed salary + bank amount) and a reception user R ('hakedis_prepare'). Made-up
--     names and amounts only; auth.uid() is simulated through request.jwt.claims (and request.jwt.claim.sub / .role),
--     as in 0030 – 0036. Covered: fin_hk_ensure_counterparties (refused for R; created / linked / error, then
--     existing: idempotent); the month on Personel accepted, refused on Kira (entry RPC, guard trigger, rule);
--     the rule month suggestion (save, retry, change, an older client's call, validation); paid_so_far /
--     booked_so_far of an open month (finance only; A's own view); the January close netting A's cash advance, an
--     advance typed with A's name before A's counterparty existed, B's advance and S's bank salary booked under the
--     month (another month's advance, an excluded entry and another payee's entries ignored); after the close the typed
--     name changed (re-netted), an entry added, edited and cancelled (A), the keyed entry paid in full and then
--     overpaid (amount kept, OVERPAID, nothing refused), B's month covered by another entry (keyed entry cancelled) and
--     that entry excluded (reopened), S's cash advance; reopen + re-close changing no entry; February closed without a
--     keyed entry (target 0) and one created by the sync; a payment on a cancelled February entry corrected and voided
--     (re-netted); the views of the owner, R (no payment figure, no keyed entry id) and the doctors (own figures only);
--     a keyed entry cancelled by a person left as it is by the sync; A's counterparty relinked to D (no re-net of A's
--     statement, D's statement not bound, stored figures shown), then unlinked (re-nets A's statement again).
--     Visibility (owner decision 2026-10-21): with a January bank amount for A above A's total, the owner (finance)
--     sees the split in payees, BANK_OVER_TOTAL, the frozen statement breakdown and the bank_portion rules; R
--     ('hakedis_prepare' without finance) sees no bank_cents / cash_cents, no BANK_OVER_TOTAL and bank_portion rules
--     without amount or note (the salary rule keeps its amount); A's own views carry no split; hk_my_months /
--     hk_my_month refuse S (assistant), R (reception) and an admin M, not the owner. Nothing survives.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_slug text := 'p38-test-hk-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_tag text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_clinic uuid := gen_random_uuid();
  v_own uuid := gen_random_uuid();
  v_own_auth uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_a_auth uuid := gen_random_uuid();
  v_a_doc uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_b_auth uuid := gen_random_uuid();
  v_b_doc uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();
  v_d_doc uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_s_auth uuid := gen_random_uuid();
  v_r uuid := gen_random_uuid();
  v_r_auth uuid := gen_random_uuid();
  v_m uuid := gen_random_uuid();
  v_m_auth uuid := gen_random_uuid();
  v_rule_ab uuid := gen_random_uuid();
  v_auths uuid[];
  v_cp_b uuid := gen_random_uuid();
  v_cp_x uuid := gen_random_uuid();
  v_cp_a uuid;
  v_cp_s uuid;
  v_cat_doc uuid;
  v_cat_per uuid;
  v_cat_rent uuid;
  v_cash uuid;
  v_bank uuid;
  v_k_a uuid;
  v_k_b uuid;
  v_k_s uuid;
  v_k_a2 uuid;
  v_e_a1 uuid := gen_random_uuid();
  v_e_a2 uuid := gen_random_uuid();
  v_e_a3 uuid := gen_random_uuid();
  v_e_ax uuid := gen_random_uuid();
  v_e_af1 uuid := gen_random_uuid();
  v_e_af2 uuid := gen_random_uuid();
  v_e_am uuid := gen_random_uuid();
  v_e_at uuid := gen_random_uuid();
  v_e_ap uuid := gen_random_uuid();
  v_e_ar uuid := gen_random_uuid();
  v_e_sm uuid := gen_random_uuid();
  v_pay_ap uuid := gen_random_uuid();
  v_cp_row public.fin_counterparties%ROWTYPE;
  v_k_a2_desc text;
  v_e_b1 uuid := gen_random_uuid();
  v_e_b2 uuid := gen_random_uuid();
  v_e_s1 uuid := gen_random_uuid();
  v_e_s2 uuid := gen_random_uuid();
  v_rule uuid := gen_random_uuid();
  v_ver integer;
  v_n integer;
  v_snap text;
  v_j jsonb;
  v_x jsonb;
  v_err text;
  v_state text;
  v_sqls text[];
  v_msgs text[];
  v_i integer;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P38', v_slug);
    INSERT INTO public.users (id, clinic_id, auth_user_id, role, full_name, email, is_active) VALUES
      (v_own, v_clinic, v_own_auth, 'owner', 'Öz denetim sahip', 'p38-sc-own-' || v_tag || '@example.invalid', true),
      (v_a, v_clinic, v_a_auth, 'doctor', 'Öz denetim Hekim A', 'p38-sc-a-' || v_tag || '@example.invalid', true),
      (v_b, v_clinic, v_b_auth, 'doctor', 'Öz denetim Hekim B', 'p38-sc-b-' || v_tag || '@example.invalid', true),
      (v_d, v_clinic, gen_random_uuid(), 'doctor', 'Öz denetim Hekim D', 'p38-sc-d-' || v_tag || '@example.invalid',
       true),
      (v_s, v_clinic, v_s_auth, 'assistant', 'Öz denetim Asistan S',
       'p38-sc-s-' || v_tag || '@example.invalid', true),
      (v_r, v_clinic, v_r_auth, 'reception', 'Öz denetim Banko', 'p38-sc-r-' || v_tag || '@example.invalid', true),
      (v_m, v_clinic, v_m_auth, 'admin', 'Öz denetim Yönetici M', 'p38-sc-m-' || v_tag || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES
      (v_a_doc, v_clinic, v_a), (v_b_doc, v_clinic, v_b), (v_d_doc, v_clinic, v_d);
    INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by) VALUES
      (v_clinic, v_own, 'finance', v_own);
    -- An unlinked physician counterparty with B's name (linked by the RPC) and a supplier with D's name (a clash).
    INSERT INTO public.fin_counterparties (id, clinic_id, name, normalized_name, kind, note, is_active, created_by,
                                           updated_by) VALUES
      (v_cp_b, v_clinic, 'Öz denetim Hekim B', public.fin__normalize_name('Öz denetim Hekim B'), 'physician', '', true,
       v_own, v_own),
      (v_cp_x, v_clinic, 'Öz denetim Hekim D', public.fin__normalize_name('Öz denetim Hekim D'), 'supplier', '', true,
       v_own, v_own);

    SELECT c.id INTO v_cat_doc FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.report_bucket = 'doctor' AND c.is_system;
    SELECT c.id INTO v_cat_per FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.report_bucket = 'personnel' AND c.is_system;
    SELECT c.id INTO v_cat_rent FROM public.fin_categories c
    WHERE c.clinic_id = v_clinic AND c.report_bucket = 'rent' AND c.is_system;
    SELECT a.id INTO v_cash FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.kind = 'cash' AND a.is_active;
    SELECT a.id INTO v_bank FROM public.fin_accounts a WHERE a.clinic_id = v_clinic AND a.kind = 'bank' AND a.is_active;
    IF v_cat_doc IS NULL OR v_cat_per IS NULL OR v_cat_rent IS NULL OR v_cash IS NULL OR v_bank IS NULL THEN
      RAISE EXCEPTION 'Öz denetim: finans kategorileri / hesapları oluşmadı.';
    END IF;

    -- Owner: 'hakedis_prepare' for R; rules; January lines A 2.000.000 → 1.000.000, B 1.000.000 → 500.000; February
    -- A 400.000 → 200.000; S 3.000.000 salary with a 2.000.000 bank amount; D a rule without lines (0).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF auth.uid() IS DISTINCT FROM v_own_auth THEN
      RAISE EXCEPTION 'Öz denetim: auth.uid() oturum taklidini okumuyor (request.jwt.claims / request.jwt.claim.sub).';
    END IF;
    PERFORM public.grant_staff_permission(v_r, 'hakedis_prepare');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_a, v_a_doc, 'ciro_share', 'standard', 5000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_b, v_b_doc, 'ciro_share', 'standard', 5000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_d, v_d_doc, 'ciro_share', 'standard', 5000, NULL,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, NULL, 'fixed_monthly', NULL, NULL, 3000000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_rule(gen_random_uuid(), 0, v_s, NULL, 'bank_portion', NULL, NULL, 2000000,
                                    0, 0, 0, 0, DATE '2024-01-01', NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-01-10', v_a_doc, 'Hasta Bir', NULL, 'cash', 'TRY',
                                    2000000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-01-11', v_b_doc, 'Hasta İki', NULL, 'cash', 'TRY',
                                    1000000, NULL, NULL, NULL, '');
    PERFORM public.fin_hk_save_line(gen_random_uuid(), 0, DATE '2024-02-10', v_a_doc, 'Hasta Üç', NULL, 'cash', 'TRY',
                                    400000, NULL, NULL, NULL, '');

    -- R: "Hakediş carilerini hazırla" is for finance writers.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_state := NULL;
    BEGIN
      PERFORM public.fin_hk_ensure_counterparties();
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      v_fail := array_append(v_fail, 'hazırlayıcı cari hazırlama: ' || coalesce(v_state, '-'));
    END IF;

    -- Owner: an advance for January typed with A's name before A has a counterparty (stays free text; counted with
    -- A's counterparty once it exists, as fin__entries_state counts it).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    PERFORM public.fin_create_entry(v_e_at, v_cat_doc, NULL, NULL, 'Öz denetim Hekim A', 'Öz denetim yazılı avans',
                                    DATE '2024-01-18', 60000, '2024-01', true, v_cash);
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_e_at AND e.counterparty_id IS NULL
                     AND e.counterparty_text = 'Öz denetim Hekim A') THEN
      v_fail := array_append(v_fail, 'yazılı ad ile avans');
    END IF;

    -- Owner: S and A created, B's counterparty linked, D refused (another kind with the name); then all existing.
    v_j := public.fin_hk_ensure_counterparties();
    SELECT cp.id INTO v_cp_a FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_a_doc;
    SELECT cp.id INTO v_cp_s FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.staff_user_id = v_s;
    IF (SELECT string_agg(concat_ws(':', x ->> 'payee_name', x ->> 'kind', x ->> 'status'), ',' ORDER BY o)
        FROM jsonb_array_elements(v_j) WITH ORDINALITY AS t(x, o))
       IS DISTINCT FROM 'Öz denetim Asistan S:staff:created,Öz denetim Hekim A:physician:created,'
                        || 'Öz denetim Hekim B:physician:linked,Öz denetim Hekim D:physician:error'
       OR v_cp_a IS NULL OR v_cp_s IS NULL
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j) x
                      WHERE (x ->> 'payee_user_id') = v_b::text AND (x ->> 'counterparty_id') = v_cp_b::text
                        AND (x ->> 'counterparty_name') = 'Öz denetim Hekim B' AND (x ->> 'is_active')::boolean
                        AND (x -> 'message') = 'null'::jsonb)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j) x
                      WHERE (x ->> 'payee_user_id') = v_d::text AND (x -> 'counterparty_id') = 'null'::jsonb
                        AND (x ->> 'message') = '"Öz denetim Hekim D" adlı başka bir cari kaydı var. Cariler ekranında '
                                                || 'bu hekime bağlayın veya adını değiştirin, sonra ayı kapatın.')
       OR NOT EXISTS (SELECT 1 FROM public.fin_counterparties cp
                      WHERE cp.id = v_cp_b AND cp.doctor_id = v_b_doc AND cp.kind = 'physician')
       OR NOT EXISTS (SELECT 1 FROM public.fin_counterparties cp
                      WHERE cp.id = v_cp_s AND cp.kind = 'staff' AND cp.name = 'Öz denetim Asistan S')
       OR EXISTS (SELECT 1 FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic AND cp.doctor_id = v_d_doc)
    THEN
      v_fail := array_append(v_fail, 'cari hazırlama: ' || left(v_j::text, 1500));
    END IF;
    v_j := public.fin_hk_ensure_counterparties();
    IF (SELECT string_agg(concat_ws(':', x ->> 'payee_name', x ->> 'status', x ->> 'counterparty_id'), ','
                          ORDER BY o)
        FROM jsonb_array_elements(v_j) WITH ORDINALITY AS t(x, o))
       IS DISTINCT FROM 'Öz denetim Asistan S:existing:' || v_cp_s::text || ',Öz denetim Hekim A:existing:'
                        || v_cp_a::text || ',Öz denetim Hekim B:existing:' || v_cp_b::text
                        || ',Öz denetim Hekim D:error'
       OR (SELECT count(*) FROM public.fin_counterparties cp WHERE cp.clinic_id = v_clinic) <> 4 THEN
      v_fail := array_append(v_fail, 'cari hazırlama tekrar: ' || left(v_j::text, 1500));
    END IF;

    -- Entries booked under the payees' counterparties before the January close (all paid in full on their day): A's
    -- cash advance for January, an advance for February, an entry excluded from totals; B's advance; S's bank salary
    -- for January paid in February (Personel with the month).
    PERFORM public.fin_create_entry(v_e_a1, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim avans', DATE '2024-01-20',
                                    300000, '2024-01', true, v_cash);
    PERFORM public.fin_create_entry(v_e_af1, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim şubat avansı',
                                    DATE '2024-01-25', 50000, '2024-02', true, v_cash);
    PERFORM public.fin_create_entry(v_e_ax, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim hariç', DATE '2024-01-21',
                                    70000, '2024-01', true, v_cash);
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_ax;
    PERFORM public.fin_set_exclusion(v_e_ax, v_ver, true, 'Öz denetim: toplam dışı');
    PERFORM public.fin_create_entry(v_e_b1, v_cat_doc, NULL, v_cp_b, NULL, 'Öz denetim avans', DATE '2024-01-22',
                                    100000, '2024-01', true, v_cash);
    PERFORM public.fin_create_entry(v_e_s1, v_cat_per, NULL, v_cp_s, NULL, 'Öz denetim banka maaşı', DATE '2024-02-05',
                                    2000000, '2024-01', true, v_bank);
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_e_s1 AND e.entitlement_month = DATE '2024-01-01' AND e.subcategory IS NULL
                     AND e.category_id = v_cat_per AND public.fin__paid(e.id) = 2000000) THEN
      v_fail := array_append(v_fail, 'personel kaydında maaş ayı');
    END IF;

    -- Refusals: the month on another bucket (RPC, guard trigger, rule), the suggestion without a required month or
    -- with an unknown value. One message per statement.
    v_sqls := ARRAY[
      format('SELECT public.fin_create_entry(gen_random_uuid(), %L, NULL, NULL, ''Öz denetim kira'', ''Kira'', '
             'DATE ''2024-01-05'', 1000, ''2024-01'', false, NULL)', v_cat_rent),
      format('INSERT INTO public.fin_entries (id, clinic_id, category_id, counterparty_text, description, due_date, '
             'amount_cents, entitlement_month, created_by, updated_by) VALUES (gen_random_uuid(), %L, %L, '
             '''Öz denetim kira'', '''', DATE ''2024-01-05'', 1000, DATE ''2024-01-01'', %L, %L)',
             v_clinic, v_cat_rent, v_own, v_own),
      format('SELECT public.fin_save_classification_rule(gen_random_uuid(), 0, 100, ''any'', ''contains'', '
             '''OZDENETIM KIRA'', %L, NULL, NULL, true, false, '''', true, ''none'')', v_cat_rent),
      format('SELECT public.fin_save_classification_rule(gen_random_uuid(), 0, 100, ''bank'', ''contains'', '
             '''OZDENETIM MAAS'', %L, NULL, %L, true, false, '''', true, ''xyz'')', v_cat_per, v_cp_s),
      format('SELECT public.fin_save_classification_rule(gen_random_uuid(), 0, 100, ''bank'', ''contains'', '
             '''OZDENETIM MAAS'', %L, NULL, NULL, false, false, '''', true, ''same'')', v_cat_per)];
    v_msgs := ARRAY[
      'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında kullanılabilir.',
      'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında kullanılabilir.',
      'Hakediş / maaş ayı yalnızca hekim hakedişi ve personel kayıtlarında kullanılabilir.',
      'Hakediş ayı önerisi geçersiz.',
      'Hakediş ayı önerisi yalnızca "hakediş ayı gerekli" kurallarında seçilebilir.'];
    FOR v_i IN 1 .. cardinality(v_sqls)
    LOOP
      v_err := NULL;
      BEGIN
        EXECUTE v_sqls[v_i];
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      END;
      IF v_err IS DISTINCT FROM v_msgs[v_i] THEN
        v_fail := array_append(v_fail, 'ret ' || v_i || ': ' || coalesce(v_err, '-'));
      END IF;
    END LOOP;

    -- The rule month suggestion: saved, retried (already saved), changed, then an older client's call (no parameter:
    -- 'none').
    v_j := public.fin_save_classification_rule(v_rule, 0, 100, 'bank', 'contains', 'OZDENETIM MAAS', v_cat_per, NULL,
                                               v_cp_s, true, false, '', true, 'previous');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,entitlement_month_default}') IS DISTINCT FROM 'previous'
       OR NOT coalesce((v_j #>> '{record,requires_entitlement_month}')::boolean, false)
       OR (v_j #>> '{record,counterparty_id}') IS DISTINCT FROM v_cp_s::text
       OR (v_j #>> '{record,report_bucket}') IS DISTINCT FROM 'personnel' THEN
      v_fail := array_append(v_fail, 'kural ay önerisi: ' || left(v_j::text, 600));
    END IF;
    v_j := public.fin_save_classification_rule(v_rule, 0, 100, 'bank', 'contains', 'OZDENETIM MAAS', v_cat_per, NULL,
                                               v_cp_s, true, false, '', true, 'previous');
    IF NOT coalesce((v_j ->> 'already_saved')::boolean, false) THEN
      v_fail := array_append(v_fail, 'kural ay önerisi tekrar: ' || left(v_j::text, 300));
    END IF;
    v_j := public.fin_save_classification_rule(v_rule, 1, 100, 'bank', 'contains', 'OZDENETIM MAAS', v_cat_per, NULL,
                                               v_cp_s, true, false, '', true, 'from_text');
    IF coalesce((v_j ->> 'already_saved')::boolean, true)
       OR (v_j #>> '{record,entitlement_month_default}') IS DISTINCT FROM 'from_text'
       OR (v_j #>> '{record,version}')::integer IS DISTINCT FROM 2 THEN
      v_fail := array_append(v_fail, 'kural ay önerisi değişikliği: ' || left(v_j::text, 300));
    END IF;
    v_j := public.fin_save_classification_rule(v_rule, 2, 100, 'bank', 'contains', 'OZDENETIM MAAS', v_cat_per, NULL,
                                               v_cp_s, true, false, '', true);
    IF (v_j #>> '{record,entitlement_month_default}') IS DISTINCT FROM 'none' THEN
      v_fail := array_append(v_fail, 'kural ay önerisi (eski istemci): ' || left(v_j::text, 300));
    END IF;

    -- Visibility (owner decision 2026-10-21). Owner: A gets a bank amount of 1.200.000 for January only, above A's
    -- January total (BANK_OVER_TOTAL; a bank_portion rule is no component: totals unchanged). The owner's rules carry
    -- the bank amounts and the note.
    PERFORM public.fin_hk_save_rule(v_rule_ab, 0, v_a, NULL, 'bank_portion', NULL, NULL, 1200000, 0, 0, 0, 0,
                                    DATE '2024-01-01', DATE '2024-01-01', 'Öz denetim banka notu');
    v_j := public.fin_hk_reference();
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                   WHERE (r ->> 'id') = v_rule_ab::text AND (r ->> 'piece_cents')::bigint = 1200000
                     AND (r ->> 'note') = 'Öz denetim banka notu')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                      WHERE (r ->> 'payee_user_id') = v_s::text AND (r ->> 'kind') = 'bank_portion'
                        AND (r ->> 'piece_cents')::bigint = 2000000) THEN
      v_fail := array_append(v_fail, 'banka tutarlı kurallar (finans): ' || left((v_j -> 'rules')::text, 2000));
    END IF;

    -- January, open. Owner: paid / booked so far per payee (A's typed advance counted; A's excluded entry and February
    -- advance not). A: the same in the own view. R: none.
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'open'
       OR (SELECT string_agg(concat_ws(':', p ->> 'payee_name', p ->> 'total_cents', p ->> 'paid_so_far',
                                       p ->> 'booked_so_far'), ',' ORDER BY o)
           FROM jsonb_array_elements(v_j -> 'payees') WITH ORDINALITY AS t(p, o))
          IS DISTINCT FROM 'Öz denetim Asistan S:3000000:2000000:2000000,Öz denetim Hekim A:1000000:360000:360000,'
                           || 'Öz denetim Hekim B:500000:100000:100000,Öz denetim Hekim D:0:0:0' THEN
      v_fail := array_append(v_fail, 'açık ocak (finans): ' || left((v_j -> 'payees')::text, 1500));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                   WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'bank_cents')::bigint = 1200000
                     AND (p ->> 'cash_cents')::bigint = -200000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'bank_cents')::bigint = 2000000
                        AND (p ->> 'cash_cents')::bigint = 1000000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w
                      WHERE (w ->> 'code') = 'BANK_OVER_TOTAL' AND (w ->> 'payee_user_id') = v_a::text
                        AND (w ->> 'bank_cents')::bigint = 1200000 AND (w ->> 'total_cents')::bigint = 1000000) THEN
      v_fail := array_append(v_fail, 'açık ocak banka / elden ayrımı (finans): ' || left(v_j::text, 2000));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j ->> 'paid_so_far')::bigint IS DISTINCT FROM 360000
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 1000000
       OR position('"bank_cents"' IN v_j::text) > 0 OR position('"cash_cents"' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'açık ocak (hekim A): ' || left(v_j::text, 800));
    END IF;
    v_j := public.hk_my_months();
    IF NOT coalesce((v_j ->> 'has_rules')::boolean, false)
       OR position('"bank_cents"' IN v_j::text) > 0 OR position('"cash_cents"' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'açık aylar (hekim A): ' || left(v_j::text, 800));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF coalesce((v_j ->> 'ledger_visible')::boolean, true)
       OR position('paid_so_far' IN v_j::text) > 0 OR position('booked_so_far' IN v_j::text) > 0
       OR position('"bank_cents"' IN v_j::text) > 0 OR position('"cash_cents"' IN v_j::text) > 0
       OR position('BANK_OVER_TOTAL' IN v_j::text) > 0
       OR jsonb_array_length(v_j -> 'payees') <> 4
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'total_cents')::bigint = 1000000) THEN
      v_fail := array_append(v_fail, 'açık ocak (hazırlayıcı): ' || left(v_j::text, 800));
    END IF;
    v_j := public.fin_hk_reference();
    IF coalesce((v_j ->> 'ledger_visible')::boolean, true)
       OR (SELECT count(*) FROM jsonb_array_elements(v_j -> 'rules') r
           WHERE (r ->> 'kind') = 'bank_portion' AND (r -> 'piece_cents') = 'null'::jsonb AND (r ->> 'note') = ''
             AND (r ->> 'from_month') = '2024-01-01') <> 2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                  WHERE (r ->> 'kind') = 'bank_portion' AND (r -> 'piece_cents') IS DISTINCT FROM 'null'::jsonb)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                      WHERE (r ->> 'id') = v_rule_ab::text AND (r ->> 'to_month') = '2024-01-01')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'rules') r
                      WHERE (r ->> 'payee_user_id') = v_s::text AND (r ->> 'kind') = 'fixed_monthly'
                        AND (r ->> 'piece_cents')::bigint = 3000000)
       OR position('Öz denetim banka notu' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'kurallar (hazırlayıcı): ' || left((v_j -> 'rules')::text, 2000));
    END IF;

    -- January close (owner): A 1.000.000 − 300.000 − 60.000 (typed) → 640.000; B 500.000 − 100.000 → 400.000; S
    -- 3.000.000 − 2.000.000 → payroll 1.000.000; D 0 without a counterparty: no entry.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_j := public.fin_hk_close_month(DATE '2024-01-01', 0, false);
    SELECT e.id INTO v_k_a FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND e.source_key = 'entitlement:' || v_cp_a::text || ':2024-01';
    SELECT e.id INTO v_k_b FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND e.source_key = 'entitlement:' || v_cp_b::text || ':2024-01';
    SELECT e.id INTO v_k_s FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND e.source_key = 'payroll:' || v_cp_s::text || ':2024-01';
    SELECT st INTO v_x FROM jsonb_array_elements(v_j -> 'statements') st WHERE (st ->> 'payee_user_id') = v_a::text;
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_k_a AND e.amount_cents = 640000 AND e.cancelled_at IS NULL
                        AND e.category_id = v_cat_doc AND e.subcategory = 'past_physician_debt'
                        AND e.entitlement_month = DATE '2024-01-01' AND e.due_date = DATE '2024-01-01'
                        AND e.description LIKE 'DentOS hakediş 2024-01: %')
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_k_b AND e.amount_cents = 400000 AND e.cancelled_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_k_s AND e.amount_cents = 1000000 AND e.cancelled_at IS NULL
                        AND e.category_id = v_cat_per AND e.entitlement_month IS NULL
                        AND e.description LIKE 'DentOS maaş 2024-01: %· Bankadan 20.000,00 TL · Elden 10.000,00 TL')
       OR (SELECT count(*) FROM public.fin_entries e
           WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%')) <> 3
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NULL
                        AND s.payee_user_id = v_a AND s.fin_entry_id = v_k_a AND s.counterparty_id = v_cp_a
                        AND s.entry_kind = 'entitlement' AND s.total_cents = 1000000
                        AND s.other_booked_cents = 360000 AND s.other_paid_cents = 360000 AND s.overpaid_cents = 0)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NULL
                        AND s.payee_user_id = v_s AND s.fin_entry_id = v_k_s AND s.counterparty_id = v_cp_s
                        AND s.entry_kind = 'payroll' AND s.other_booked_cents = 2000000)
       OR EXISTS (SELECT 1 FROM public.fin_hk_statements s
                  WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_d
                    AND (s.fin_entry_id IS NOT NULL OR s.counterparty_id IS NOT NULL))
       OR (v_x ->> 'paid_cents')::bigint IS DISTINCT FROM 360000
       OR (v_x ->> 'remaining_cents')::bigint IS DISTINCT FROM 640000
       OR (v_x ->> 'other_booked_cents')::bigint IS DISTINCT FROM 360000
       OR (v_x ->> 'other_count')::integer IS DISTINCT FROM 2
       OR (v_x ->> 'overpaid_cents')::bigint IS DISTINCT FROM 0
       OR (v_x #>> '{entry,amount_cents}')::bigint IS DISTINCT FROM 640000
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w WHERE (w ->> 'code') = 'OVERPAID') THEN
      v_fail := array_append(v_fail, 'ocak kapatma: ' || left(v_j::text, 2500));
    END IF;
    IF (v_x #>> '{breakdown,bank_cents}')::bigint IS DISTINCT FROM 1200000
       OR (v_x #>> '{breakdown,cash_cents}')::bigint IS DISTINCT FROM -200000
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'warnings') w
                      WHERE (w ->> 'code') = 'BANK_OVER_TOTAL' AND (w ->> 'payee_user_id') = v_a::text) THEN
      v_fail := array_append(v_fail, 'ocak kapatma banka / elden ayrımı (finans): ' || left(v_x::text, 1500));
    END IF;

    -- After the close (A): the typed advance's name changed to someone else's: no longer A's, re-netted (700.000).
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_at;
    PERFORM public.fin_edit_entry(v_e_at, v_ver, v_cat_doc, NULL, NULL, 'Öz denetim başka kişi',
                                  'Öz denetim yazılı avans', DATE '2024-01-18', 60000, '2024-01');
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_a AND e.amount_cents = 700000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-01-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 300000
                        AND s.other_paid_cents = 300000) THEN
      v_fail := array_append(v_fail, 'kapanış sonrası yazılı ad değişikliği');
    END IF;

    -- After the close (A): an entry added (500.000), its amount raised above what was paid (450.000), its remainder
    -- cancelled (back to 500.000: the paid part stays booked).
    PERFORM public.fin_create_entry(v_e_a2, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim ek ödeme', DATE '2024-01-31',
                                    200000, '2024-01', true, v_cash);
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_a AND e.amount_cents = 500000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-01-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 500000) THEN
      v_fail := array_append(v_fail, 'kapanış sonrası ekleme');
    END IF;
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_a2;
    PERFORM public.fin_edit_entry(v_e_a2, v_ver, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim ek ödeme',
                                  DATE '2024-01-31', 250000, '2024-01');
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_a AND e.amount_cents = 450000) THEN
      v_fail := array_append(v_fail, 'kapanış sonrası düzeltme');
    END IF;
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_a2;
    PERFORM public.fin_cancel_entry(v_e_a2, v_ver, 'Öz denetim: kalan iptal');
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_a AND e.amount_cents = 500000
                                                       AND e.cancelled_at IS NULL) THEN
      v_fail := array_append(v_fail, 'kapanış sonrası iptal');
    END IF;

    -- A's keyed entry paid in full, then another 300.000 booked for January: the amount stays what was paid, 300.000
    -- overpaid (statement and OVERPAID), nothing refused.
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_k_a;
    PERFORM public.fin_record_payment(v_k_a, v_ver, gen_random_uuid(), DATE '2024-02-01', 500000, v_cash);
    PERFORM public.fin_create_entry(v_e_a3, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim mükerrer', DATE '2024-02-02',
                                    300000, '2024-01', true, v_cash);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    SELECT st INTO v_x FROM jsonb_array_elements(v_j -> 'statements') st WHERE (st ->> 'payee_user_id') = v_a::text;
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_k_a AND e.amount_cents = 500000 AND e.cancelled_at IS NULL
                     AND public.fin__paid(e.id) = 500000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-01-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 800000 AND s.overpaid_cents = 300000)
       OR (v_x ->> 'paid_cents')::bigint IS DISTINCT FROM 1300000
       OR (v_x ->> 'remaining_cents')::bigint IS DISTINCT FROM -300000
       OR (v_x ->> 'other_paid_cents')::bigint IS DISTINCT FROM 800000
       OR (v_x ->> 'other_count')::integer IS DISTINCT FROM 3
       OR (v_x ->> 'overpaid_cents')::bigint IS DISTINCT FROM 300000
       OR (SELECT jsonb_agg(w) FROM jsonb_array_elements(v_j -> 'warnings') w WHERE (w ->> 'code') = 'OVERPAID')
          IS DISTINCT FROM jsonb_build_array(jsonb_build_object('code', 'OVERPAID', 'payee_user_id', v_a,
                                                                'payee_name', 'Öz denetim Hekim A',
                                                                'overpaid_cents', 300000)) THEN
      v_fail := array_append(v_fail, 'fazla ödeme: ' || left(v_j::text, 2500));
    END IF;

    -- B: another 400.000 booked for January covers the month: the unpaid keyed entry's remainder is cancelled; that
    -- entry excluded from totals reopens it (400.000).
    PERFORM public.fin_create_entry(v_e_b2, v_cat_doc, NULL, v_cp_b, NULL, 'Öz denetim yanlış kişi', DATE '2024-01-28',
                                    400000, '2024-01', true, v_cash);
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_k_b AND e.cancelled_at IS NOT NULL
                     AND e.cancel_reason = 'Hakediş ayrı kayıtlarla ödendi')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_b AND s.month = DATE '2024-01-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 500000 AND s.overpaid_cents = 0
                        AND s.fin_entry_id = v_k_b) THEN
      v_fail := array_append(v_fail, 'kalanı iptal edilen hakediş kaydı');
    END IF;
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_b2;
    PERFORM public.fin_set_exclusion(v_e_b2, v_ver, true, 'Öz denetim: yanlış kişi');
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_k_b AND e.cancelled_at IS NULL AND e.cancelled_by IS NULL AND e.cancel_reason IS NULL
                     AND e.amount_cents = 400000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_b AND s.month = DATE '2024-01-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 100000) THEN
      v_fail := array_append(v_fail, 'yeniden açılan hakediş kaydı');
    END IF;

    -- S: a cash advance for January (Personel): payroll 500.000; A's and B's entries untouched; another clinic sees
    -- nothing of A's counterparty.
    PERFORM public.fin_create_entry(v_e_s2, v_cat_per, NULL, v_cp_s, NULL, 'Öz denetim elden maaş', DATE '2024-01-31',
                                    500000, '2024-01', true, v_cash);
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_s AND e.amount_cents = 500000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_a AND e.amount_cents = 500000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e WHERE e.id = v_k_b AND e.amount_cents = 400000)
       OR (SELECT o.booked_cents + o.paid_cents + o.entries
           FROM public.fin__hk_other_sums(gen_random_uuid(), v_cp_a, DATE '2024-01-01', NULL) o) <> 0 THEN
      v_fail := array_append(v_fail, 'personel avansı / başka kişi / başka klinik');
    END IF;

    -- Reopen + re-close: no keyed entry changes (amount, state, version, description), the new statements carry the
    -- same figures. While open: A paid so far = 500.000 (keyed) + 800.000 (others).
    SELECT string_agg(concat_ws(':', e.id, e.amount_cents, e.cancelled_at IS NULL, e.version, md5(e.description)),
                      ',' ORDER BY e.id)
      INTO v_snap
    FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%');
    SELECT m.version INTO v_ver
    FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    PERFORM public.fin_hk_reopen_month(DATE '2024-01-01', v_ver);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'open'
       OR (v_j -> 'statements') IS DISTINCT FROM '[]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'paid_so_far')::bigint = 1300000) THEN
      v_fail := array_append(v_fail, 'yeniden açılan ocak: ' || left(v_j::text, 1500));
    END IF;
    SELECT m.version INTO v_ver
    FROM public.fin_hk_months m WHERE m.clinic_id = v_clinic AND m.month = DATE '2024-01-01';
    v_j := public.fin_hk_close_month(DATE '2024-01-01', v_ver, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR v_snap IS DISTINCT FROM (
            SELECT string_agg(concat_ws(':', e.id, e.amount_cents, e.cancelled_at IS NULL, e.version,
                                        md5(e.description)), ',' ORDER BY e.id)
            FROM public.fin_entries e
            WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%'))
       OR (SELECT string_agg(concat_ws(':', u.full_name, s.fin_entry_id IN (v_k_a, v_k_b, v_k_s),
                                       s.other_booked_cents, s.other_paid_cents, s.overpaid_cents), ','
                             ORDER BY u.full_name COLLATE "C")
           FROM public.fin_hk_statements s
           JOIN public.users u ON u.id = s.payee_user_id
           WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NULL
             AND s.payee_user_id IN (v_a, v_b, v_s))
          IS DISTINCT FROM 'Öz denetim Asistan S:true:2500000:2500000:0,Öz denetim Hekim A:true:800000:800000:300000,'
                           || 'Öz denetim Hekim B:true:100000:100000:0'
       OR (SELECT count(*) FROM public.fin_hk_statements s
           WHERE s.clinic_id = v_clinic AND s.month = DATE '2024-01-01' AND s.superseded_at IS NOT NULL
             AND s.payee_user_id IN (v_a, v_b, v_s)) <> 3 THEN
      v_fail := array_append(v_fail, 'yeniden kapatma: ' || left(v_j::text, 1500));
    END IF;

    -- February: A 200.000 fully booked (50.000 advance + 150.000) → statement without a keyed entry; S payroll
    -- 3.000.000. Then the 150.000 excluded: the sync creates A's keyed entry (150.000) and links it.
    PERFORM public.fin_create_entry(v_e_af2, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim şubat ödemesi',
                                    DATE '2024-02-15', 150000, '2024-02', true, v_cash);
    v_j := public.fin_hk_close_month(DATE '2024-02-01', 0, false);
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR EXISTS (SELECT 1 FROM public.fin_entries e
                  WHERE e.clinic_id = v_clinic AND e.source_key = 'entitlement:' || v_cp_a::text || ':2024-02')
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.fin_entry_id IS NULL AND s.counterparty_id = v_cp_a
                        AND s.total_cents = 200000 AND s.other_booked_cents = 200000 AND s.overpaid_cents = 0)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_b AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.fin_entry_id IS NULL AND s.counterparty_id = v_cp_b
                        AND s.total_cents = 0)
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.clinic_id = v_clinic AND e.source_key = 'payroll:' || v_cp_s::text || ':2024-02'
                        AND e.amount_cents = 3000000)
       OR (SELECT count(*) FROM public.fin_entries e
           WHERE e.clinic_id = v_clinic AND (e.source_key LIKE 'entitlement:%' OR e.source_key LIKE 'payroll:%')) <> 4
    THEN
      v_fail := array_append(v_fail, 'şubat kapatma: ' || left(v_j::text, 1500));
    END IF;
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_af2;
    PERFORM public.fin_set_exclusion(v_e_af2, v_ver, true, 'Öz denetim: toplam dışı');
    SELECT e.id INTO v_k_a2 FROM public.fin_entries e
    WHERE e.clinic_id = v_clinic AND e.source_key = 'entitlement:' || v_cp_a::text || ':2024-02'
      AND e.amount_cents = 150000 AND e.cancelled_at IS NULL AND e.category_id = v_cat_doc
      AND e.subcategory = 'past_physician_debt' AND e.entitlement_month = DATE '2024-02-01'
      AND e.due_date = DATE '2024-02-01' AND e.description LIKE 'DentOS hakediş 2024-02: %';
    IF v_k_a2 IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.fin_entry_id = v_k_a2 AND s.other_booked_cents = 50000) THEN
      v_fail := array_append(v_fail, 'şubat kapanış sonrası hakediş kaydı');
    END IF;

    -- February (A): a planned 40.000 (K 110.000), 10.000 paid on it (no change), its remainder cancelled (booked
    -- 10.000: K 140.000), that payment corrected to 4.000 (K 146.000) and voided (K 150.000): the payment trigger
    -- re-nets.
    PERFORM public.fin_create_entry(v_e_ap, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim planlı şubat', DATE '2024-02-20',
                                    40000, '2024-02', false, NULL);
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_ap;
    PERFORM public.fin_record_payment(v_e_ap, v_ver, v_pay_ap, DATE '2024-02-21', 10000, v_cash);
    SELECT concat_ws(':', e.amount_cents, e.cancelled_at IS NULL) INTO v_snap
    FROM public.fin_entries e WHERE e.id = v_k_a2;
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_ap;
    PERFORM public.fin_cancel_entry(v_e_ap, v_ver, 'Öz denetim: kalan iptal');
    v_snap := v_snap || ',' || (SELECT concat_ws(':', e.amount_cents, e.cancelled_at IS NULL)
                                FROM public.fin_entries e WHERE e.id = v_k_a2);
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_ap;
    PERFORM public.fin_correct_payment(v_e_ap, v_ver, v_pay_ap, DATE '2024-02-21', 4000, v_cash);
    v_snap := v_snap || ',' || (SELECT concat_ws(':', e.amount_cents, s.other_booked_cents)
                                FROM public.fin_entries e
                                JOIN public.fin_hk_statements s ON s.clinic_id = e.clinic_id AND s.fin_entry_id = e.id
                                WHERE e.id = v_k_a2 AND s.superseded_at IS NULL);
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_ap;
    PERFORM public.fin_void_payment(v_e_ap, v_ver, v_pay_ap, 'Öz denetim: ödeme geri alındı');
    v_snap := v_snap || ',' || (SELECT concat_ws(':', e.amount_cents, s.other_booked_cents, s.other_paid_cents)
                                FROM public.fin_entries e
                                JOIN public.fin_hk_statements s ON s.clinic_id = e.clinic_id AND s.fin_entry_id = e.id
                                WHERE e.id = v_k_a2 AND s.superseded_at IS NULL);
    IF v_snap IS DISTINCT FROM '110000:true,140000:true,146000:54000,150000:50000:50000' THEN
      v_fail := array_append(v_fail, 'iptal edilmiş kayıtta ödeme düzeltme / iptali: ' || coalesce(v_snap, '-'));
    END IF;

    -- March (open): A 10.000 paid so far; S a planned (unpaid) 700.000 salary: booked so far, not paid.
    PERFORM public.fin_create_entry(v_e_am, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim mart avansı', DATE '2024-03-05',
                                    10000, '2024-03', true, v_cash);
    PERFORM public.fin_create_entry(v_e_sm, v_cat_per, NULL, v_cp_s, NULL, 'Öz denetim planlı maaş', DATE '2024-04-05',
                                    700000, '2024-03', false, NULL);
    v_j := public.fin_hk_month(DATE '2024-03-01');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                   WHERE (p ->> 'payee_user_id') = v_a::text AND (p ->> 'paid_so_far')::bigint = 10000
                     AND (p ->> 'booked_so_far')::bigint = 10000)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'payees') p
                      WHERE (p ->> 'payee_user_id') = v_s::text AND (p ->> 'paid_so_far')::bigint = 0
                        AND (p ->> 'booked_so_far')::bigint = 700000) THEN
      v_fail := array_append(v_fail, 'açık mart (finans): ' || left((v_j -> 'payees')::text, 1000));
    END IF;

    -- R (no ledger access): no payment figure in a closed or an open month.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_r_auth::text, true);
    v_j := public.fin_hk_month(DATE '2024-01-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'closed'
       OR position('paid_cents' IN v_j::text) > 0 OR position('other_booked' IN v_j::text) > 0
       OR position('overpaid' IN v_j::text) > 0 OR position('OVERPAID' IN v_j::text) > 0
       OR position('paid_so_far' IN v_j::text) > 0
       OR position('"bank_cents"' IN v_j::text) > 0 OR position('"cash_cents"' IN v_j::text) > 0
       OR position('BANK_OVER_TOTAL' IN v_j::text) > 0
       OR position(v_k_a::text IN v_j::text) > 0
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_a::text AND (st -> 'entry') = 'null'::jsonb
                        AND (st -> 'fin_entry_id') = 'null'::jsonb) THEN
      v_fail := array_append(v_fail, 'hazırlayıcı kapalı ocak: ' || left(v_j::text, 1500));
    END IF;
    v_j := public.fin_hk_month(DATE '2024-03-01');
    IF position('paid_so_far' IN v_j::text) > 0 OR position('booked_so_far' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hazırlayıcı açık mart');
    END IF;

    -- A: own figures (January overpaid, February partly paid, March paid so far), nothing of B or S.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j -> 'statement') IS DISTINCT FROM jsonb_build_object(
         'total_cents', 1000000, 'closed_at', v_j #> '{statement,closed_at}', 'paid_cents', 1300000,
         'remaining_cents', -300000, 'other_booked_cents', 800000, 'other_paid_cents', 800000, 'overpaid_cents', 300000)
       OR (v_j #>> '{entitlement,amount_cents}')::bigint IS DISTINCT FROM 500000
       OR (v_j #>> '{entitlement,paid_cents}')::bigint IS DISTINCT FROM 500000
       OR (v_j -> 'paid_so_far') IS DISTINCT FROM 'null'::jsonb
       OR position(v_b::text IN v_j::text) > 0 OR position(v_s::text IN v_j::text) > 0
       OR position(v_cp_b::text IN v_j::text) > 0 OR position(v_cp_s::text IN v_j::text) > 0
       OR (v_j #>> '{payees,0,total_cents}')::bigint IS DISTINCT FROM 1000000
       OR position('"bank_cents"' IN v_j::text) > 0 OR position('"cash_cents"' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A ocak: ' || left(v_j::text, 1500));
    END IF;
    v_j := public.hk_my_month(DATE '2024-03-01');
    IF (v_j ->> 'status') IS DISTINCT FROM 'open'
       OR (v_j ->> 'paid_so_far')::bigint IS DISTINCT FROM 10000
       OR (v_j -> 'statement') IS DISTINCT FROM 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'hekim A mart: ' || left(v_j::text, 800));
    END IF;
    v_j := public.hk_my_months();
    IF DATE '2024-01-01' >= (public.fin__month_start(public.clinic_today()) - interval '59 months')::date
       AND ((SELECT concat_ws(':', m ->> 'status', m ->> 'total_cents', m ->> 'paid_cents', m ->> 'remaining_cents',
                              m ->> 'other_paid_cents', m ->> 'overpaid_cents')
             FROM jsonb_array_elements(v_j -> 'months') m WHERE (m ->> 'month') = '2024-01-01')
              IS DISTINCT FROM 'closed:1000000:1300000:-300000:800000:300000'
            OR (SELECT concat_ws(':', m ->> 'status', m ->> 'total_cents', m ->> 'paid_cents', m ->> 'remaining_cents',
                                 m ->> 'other_paid_cents', m ->> 'overpaid_cents')
                FROM jsonb_array_elements(v_j -> 'months') m WHERE (m ->> 'month') = '2024-02-01')
              IS DISTINCT FROM 'closed:200000:50000:150000:50000:0'
            OR (SELECT concat_ws(':', m ->> 'status', m ->> 'paid_cents', coalesce(m ->> 'remaining_cents', '-'),
                                 coalesce(m ->> 'overpaid_cents', '-'))
                FROM jsonb_array_elements(v_j -> 'months') m WHERE (m ->> 'month') = '2024-03-01')
              IS DISTINCT FROM 'open:10000:-:-') THEN
      v_fail := array_append(v_fail, 'hekim A aylar: ' || left(v_j::text, 1500));
    END IF;
    IF position('"bank_cents"' IN v_j::text) > 0 OR position('"cash_cents"' IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim A aylar (banka / elden): ' || left(v_j::text, 1500));
    END IF;

    -- B: own January (100.000 paid on another entry, the excluded one not counted).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_b_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-01-01');
    IF (v_j #>> '{statement,paid_cents}')::bigint IS DISTINCT FROM 100000
       OR (v_j #>> '{statement,remaining_cents}')::bigint IS DISTINCT FROM 400000
       OR (v_j #>> '{statement,overpaid_cents}')::bigint IS DISTINCT FROM 0
       OR position(v_a::text IN v_j::text) > 0 OR position(v_cp_a::text IN v_j::text) > 0 THEN
      v_fail := array_append(v_fail, 'hekim B ocak: ' || left(v_j::text, 1500));
    END IF;

    -- Hakedişim (owner decision 2026-10-21): S (assistant, a payee with rules), R (reception) and M (admin) are
    -- refused by hk_my_months / hk_my_month (42501, one message, before any figure is read); the owner is not (no
    -- rules of the owner's own here: has_rules false).
    v_auths := ARRAY[v_s_auth, v_r_auth, v_m_auth];
    FOR v_i IN 1 .. cardinality(v_auths)
    LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auths[v_i], 'role', 'authenticated')::text,
                         true);
      PERFORM set_config('request.jwt.claim.sub', v_auths[v_i]::text, true);
      v_state := NULL;
      v_err := NULL;
      BEGIN
        PERFORM public.hk_my_months();
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
      END;
      IF v_state IS DISTINCT FROM '42501'
         OR v_err IS DISTINCT FROM 'Hakedişim yalnızca hekimlere ve klinik sahibine açıktır.' THEN
        v_fail := array_append(v_fail, 'hakedişim aylar reddi ' || v_i || ': ' || coalesce(v_state, '-') || ' '
                                       || coalesce(v_err, '-'));
      END IF;
      v_state := NULL;
      v_err := NULL;
      BEGIN
        PERFORM public.hk_my_month(DATE '2024-01-01');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
      END;
      IF v_state IS DISTINCT FROM '42501'
         OR v_err IS DISTINCT FROM 'Hakedişim yalnızca hekimlere ve klinik sahibine açıktır.' THEN
        v_fail := array_append(v_fail, 'hakedişim ay reddi ' || v_i || ': ' || coalesce(v_state, '-') || ' '
                                       || coalesce(v_err, '-'));
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    v_err := NULL;
    BEGIN
      v_j := public.hk_my_months();
      v_x := public.hk_my_month(DATE '2024-01-01');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NOT NULL
       OR coalesce((v_j ->> 'has_rules')::boolean, true) OR coalesce((v_x ->> 'has_rules')::boolean, true) THEN
      v_fail := array_append(v_fail, 'hakedişim (sahip): ' || coalesce(v_err, left(v_j::text, 300)));
    END IF;

    -- Owner: S's January payroll entry cancelled by hand; an entry excluded afterwards (more to pay) is saved, the
    -- cancelled entry stays as it is, the statement follows.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_k_s;
    PERFORM public.fin_cancel_entry(v_k_s, v_ver, 'Öz denetim elle iptal');
    v_err := NULL;
    BEGIN
      SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_s2;
      PERFORM public.fin_set_exclusion(v_e_s2, v_ver, true, 'Öz denetim: toplam dışı');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_k_s AND e.cancelled_at IS NOT NULL AND e.cancel_reason = 'Öz denetim elle iptal'
                        AND e.amount_cents = 500000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_s AND s.month = DATE '2024-01-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 2000000) THEN
      v_fail := array_append(v_fail, 'elle iptal edilen maaş kaydı: ' || coalesce(v_err, '-'));
    END IF;
    -- Only the netting reopens a cancelled entry (fin.ctx 'hk_netting'); any other update is refused as before.
    v_err := NULL;
    BEGIN
      UPDATE public.fin_entries e SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL
      WHERE e.id = v_k_s;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS DISTINCT FROM 'İptal edilmiş kayıt geri açılamaz.' THEN
      v_fail := array_append(v_fail, 'iptal geri alma: ' || coalesce(v_err, '-'));
    END IF;

    -- A's counterparty relinked to D (Cariler), who closed February at 0 without a counterparty; then an entry under it
    -- for February: A's statement is not re-netted (keyed entry unchanged; the stored figures shown, not D's entry),
    -- D's statement is not bound to it. Unlinked afterwards: an edit of that entry re-nets A's statement again.
    SELECT e.description INTO v_k_a2_desc FROM public.fin_entries e WHERE e.id = v_k_a2;
    SELECT * INTO v_cp_row FROM public.fin_counterparties cp WHERE cp.id = v_cp_a;
    PERFORM public.fin_save_counterparty(v_cp_a, v_cp_row.version, v_cp_row.name, 'physician', v_d_doc,
                                         v_cp_row.report_group_id, v_cp_row.note, true);
    PERFORM public.fin_create_entry(v_e_ar, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim D ödemesi', DATE '2024-02-26',
                                    30000, '2024-02', true, v_cash);
    v_j := public.fin_hk_month(DATE '2024-02-01');
    SELECT st INTO v_x FROM jsonb_array_elements(v_j -> 'statements') st WHERE (st ->> 'payee_user_id') = v_a::text;
    IF NOT EXISTS (SELECT 1 FROM public.fin_counterparties cp WHERE cp.id = v_cp_a AND cp.doctor_id = v_d_doc)
       OR NOT EXISTS (SELECT 1 FROM public.fin_entries e
                      WHERE e.id = v_k_a2 AND e.amount_cents = 150000 AND e.cancelled_at IS NULL
                        AND e.description = v_k_a2_desc)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.counterparty_id = v_cp_a AND s.fin_entry_id = v_k_a2
                        AND s.other_booked_cents = 50000 AND s.other_paid_cents = 50000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_d AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.counterparty_id IS NULL AND s.fin_entry_id IS NULL)
       OR (v_x ->> 'other_booked_cents')::bigint IS DISTINCT FROM 50000
       OR (v_x ->> 'other_paid_cents')::bigint IS DISTINCT FROM 50000
       OR (v_x -> 'other_count') IS DISTINCT FROM 'null'::jsonb
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j -> 'statements') st
                      WHERE (st ->> 'payee_user_id') = v_d::text AND (st ->> 'paid_cents')::bigint = 0
                        AND (st ->> 'other_booked_cents')::bigint = 0) THEN
      v_fail := array_append(v_fail, 'başka hekime bağlanan cari: ' || left(v_j::text, 2500));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_a_auth::text, true);
    v_j := public.hk_my_month(DATE '2024-02-01');
    IF (v_j #>> '{statement,paid_cents}')::bigint IS DISTINCT FROM 50000
       OR (v_j #>> '{statement,other_paid_cents}')::bigint IS DISTINCT FROM 50000
       OR (v_j #>> '{statement,remaining_cents}')::bigint IS DISTINCT FROM 150000 THEN
      v_fail := array_append(v_fail, 'başka hekime bağlanan cari (hekim A): ' || left(v_j::text, 1500));
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own_auth, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_own_auth::text, true);
    SELECT * INTO v_cp_row FROM public.fin_counterparties cp WHERE cp.id = v_cp_a;
    PERFORM public.fin_save_counterparty(v_cp_a, v_cp_row.version, v_cp_row.name, 'physician', NULL,
                                         v_cp_row.report_group_id, v_cp_row.note, true);
    SELECT e.version INTO v_ver FROM public.fin_entries e WHERE e.id = v_e_ar;
    PERFORM public.fin_edit_entry(v_e_ar, v_ver, v_cat_doc, NULL, v_cp_a, NULL, 'Öz denetim D ödemesi',
                                  DATE '2024-02-26', 35000, '2024-02');
    IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                   WHERE e.id = v_k_a2 AND e.amount_cents = 115000 AND e.cancelled_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_a AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.other_booked_cents = 85000 AND s.other_paid_cents = 80000)
       OR NOT EXISTS (SELECT 1 FROM public.fin_hk_statements s
                      WHERE s.clinic_id = v_clinic AND s.payee_user_id = v_d AND s.month = DATE '2024-02-01'
                        AND s.superseded_at IS NULL AND s.counterparty_id IS NULL AND s.fin_entry_id IS NULL) THEN
      v_fail := array_append(v_fail, 'bağlantısı kaldırılan cari');
    END IF;

    SELECT count(*) INTO v_n FROM public.fin_hk_statements s WHERE s.clinic_id = v_clinic AND s.superseded_at IS NULL;
    IF v_n < 7 THEN
      v_fail := array_append(v_fail, 'geçerli hesap dökümü sayısı: ' || v_n);
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (hakediş v2.4): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'p38_selfcheck_rollback';
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
