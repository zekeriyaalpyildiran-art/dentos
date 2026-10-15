-- Phase 8: Purchasing, room requests and stock reports (satın alma, oda talepleri, tüketim raporu). Safe to re-run.
--
-- Contract: spec_parts/p8_purchasing.md (wins on names, JSON shapes and error keys). Requires 0019 (permissions),
-- 0020 (finance ledger) and 0024_stock_core.sql (live). Number 0026 belongs to another workflow and is never used
-- here; 0025 was free when this file was written.
--
--  1. Preflight: 0024 / 0020 objects and columns used here exist with their live types; tables left by an earlier
--     run have the shape created below; no ledger row points at a purchase line / room request that does not exist.
--  2. New tables (RLS on, exactly one SELECT policy each, no client write privilege anywhere):
--       stock_settings (one row per clinic; no row = defaults), stock_po_counters (gapless SP-<year>-<0001> numbers;
--       no client access at all), purchase_orders (no money column), purchase_order_items (usage units, received <=
--       ordered), purchase_order_item_costs (prices; cost viewers only), stock_room_requests.
--     stock_movements.po_item_id / request_id (0024 hook columns) get their foreign keys and type checks.
--  3. Replaced 0024 objects (same signatures except stock__receive_line): stock__raise (Phase 8 keys appended, every
--     0024 branch verbatim), stock__ledger (po_item_id / request_id extras), stock__receive_line (DROP + CREATE with a
--     trailing p_po_item uuid DEFAULT NULL; the 18-argument callers keep working), stock__purge_test_clinic (new
--     tables), stock__harden_privileges (new tables), audit cost guard (also hides purchase_order_item_costs).
--  4. Guard triggers on the new tables (state machines, immutable keys, TRUNCATE refused) and open-reference
--     triggers: a card / supplier / location cannot be deactivated while an open order or room request uses it.
--  5. Write RPCs: stock_po_save, stock_po_transition, stock_po_receive, stock_room_request_create,
--     stock_room_request_action, stock_save_settings. Read RPCs: stock_po_list, stock_po_detail,
--     stock_reorder_suggestions, stock_room_request_list, stock_work_counts, stock_settings_get,
--     stock_consumption_report. Every one is SECURITY DEFINER, returns one jsonb value and carries the
--     stock__flags(); cost keys are absent (never 0) for non cost viewers; stored replay results carry no cost key.
--  6. Finance payable link (owner decision: OFF). A received order writes one planned fin_entries row only when a
--     'finance' holder enabled stock_settings.po_payable_enabled; the hook never blocks a receipt (skipped_* state).
--  7. Self-checks (RAISE rolls everything back) and a rolled-back replay of suggestion -> order -> receipt -> close
--     -> room request delivery -> refused correction, on a fixed day.
--
-- Error contract (as 0024): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or P0001
-- (400); HINT = key, DETAIL a machine value where noted; list rows are prefixed '<n>. satır: ' with DETAIL = n.
--
-- Deviations from analysis_plan.json Phase 8 (spec §15, all deliberate):
--   * RPC names start with stock_ (stock_po_save / stock_po_transition / stock_po_receive / stock_room_request_* /
--     stock_consumption_report) so stock__harden_privileges() covers them; no po_* / room_request_* functions.
--   * Reorder suggestions are an RPC, never a view (a view runs with its owner's rights and bypasses the cost gate).
--   * No total / price column on purchase_orders / purchase_order_items (managers without cost view read them);
--     prices live in purchase_order_item_costs and totals are computed in cost-gated reads.
--   * The payable is controlled by a finance-only setting (default OFF), not by the owner.
--   * 'complete' is dropped (the last receipt sets 'received'); 'close' short-closes a partially received order.
--   * Room requests: deliver straight from pending, partial delivery, requester cancel.
--   * "Creator cannot approve" also blocks the last content editor.
-- Additions beyond the contract text (backwards compatible):
--   * Internal cores so the RPCs and the rolled-back self-check run exactly the same code (there is no session in
--     the SQL editor): writes stock__po_save_core, stock__po_transition_core, stock__po_receive_core,
--     stock__rq_create_core, stock__rq_action_core, stock__save_settings_core; reads stock__po_list_core,
--     stock__reorder_core (+ stock__reorder_rows), stock__rq_list_core, stock__work_counts_core,
--     stock__consumption_core; helpers stock__po_actions, stock__po_self_blocked, stock__po_remaining,
--     stock__po_qty_label, stock__settings_json. Every RPC is gate -> (op key) -> core -> || stock__flags().
--   * stock_period_report (0024) is unchanged for one release; the new report page uses stock_consumption_report.
--   * PO save / room request create lock the cards (and the supplier / target location) FOR SHARE, so a concurrent
--     deactivation cannot slip past the open-reference triggers.
--   * Status is checked before the version in transitions / edits / request actions (a processed record answers
--     E_PO_STATE / E_PO_EDIT_STATE / E_RQ_STATE rather than E_VERSION); both are 409.
--   * An edit that resends the stored (already past) expected date is accepted; a new past date is E_PO_DATE.
--   * stock_room_request_list counts ignore the status filter but follow location / card / mine, so the status
--     chips match the list (stock_po_list counts stay clinic-wide, as the contract says).
--   * stock_consumption_report counts a corrected delivery transfer's re-entry as a room delivery (it follows the
--     re-entry's source movement), and carries every cost key in by_category for cost viewers.
--   * stock_settings also gets the TRUNCATE guard.
-- Review fixes (after the first draft; none of this was ever applied):
--   * stock_po_receive takes a trailing p_version integer DEFAULT NULL (the web build always sends it): a receipt
--     saved meanwhile (for example one whose response was lost) answers E_VERSION, so the same goods are never
--     received twice (a PO receipt cannot be corrected). Without p_version the contract behaviour is unchanged.
--   * purchase_orders.content_editors uuid[]: everyone who changed the supplier or the lines of a pending order;
--     with the approval rule ON none of them (nor the creator) may approve (closes "B rewrites, A touches, B
--     approves"). content_edited_by stays the last editor for display. E_PO_SELF_APPROVE therefore says "hazırlayan
--     veya içeriğini değiştiren" instead of "en son değiştiren".
--   * stock_room_requests.ref_no is numbered per clinic (UNIQUE (clinic_id, ref_no), gapless, under a per-clinic
--     advisory lock) instead of one global identity, so "Talep #n" reveals nothing about other clinics.
--   * Correction requests on PO receipts are refused at insert (trigger stock_corr_po_link, E_CORR_ORDER) and
--     stock__history_rows (same signature, 0024 body plus "AND m.po_item_id IS NULL") no longer offers the button.
--   * stock_save_settings writes nothing when no value changes (no version bump, no audit row, no E_VERSION for
--     a concurrent finance / owner edit).
--   * A unique violation on the order header maps to E_ID_TAKEN only for the primary key; the number counter heals
--     itself when it lags behind existing orders (for example after an import through legacy_id).
--   * Busy 0024 tables are touched last: the stock_movements constraints / indexes, the open-reference triggers on
--     stock_items / suppliers / stock_locations, the stock_correction_requests trigger and the audit_logs policy run
--     just before the self-checks, under lock_timeout = 5s.
--   * The self-check's payable-ON probe only WARNs when the entry is not created (the feature ships OFF; acceptance
--     FP-4 / FP-5 cover it), and a wrong 'created' row still fails.
--
-- RUNBOOK (apply and deploy together; production is the only database):
--   0. Nothing in the Phase 7 screens depends on Phase 8. The Phase 8 web build shows "Satın alma modülü
--      güncelleniyor; lütfen daha sonra tekrar deneyin." while these RPCs are missing, and hides the new tabs.
--   1. Apply this file in the SQL editor (one transaction; any self-check failure rolls everything back).
--   2. Deploy the Phase 8 web build. Ask everyone to reload open tabs.
--   3. Smoke test as the owner: suggestions list; create a PO from suggestions; approve; "Sipariş verildi"; receive one
--      line partly (B lot + expiry), then the rest -> "Teslim alındı", payable_state "Finans kaydı kapalı"; an
--      assistant creates a room request, the stock manager delivers it (FEFO lots move from Ana Depo); the report for
--      this month shows the receipt and the delivery; the CSV opens in Excel with Turkish characters.
--   4. Leave the payable setting OFF (owner decision). The approval rule stays OFF unless the owner turns it on.
--   5. Acceptance (spec §13) runs later, only in temporary 'p8-test-po-...' clinics; stock__purge_test_clinic now
--      also removes their purchase / room request / settings rows.
--   6. Locks: apply in a quiet window and apply 0025 and 0026 one at a time. The run sets lock_timeout = 5s; if it
--      fails with "canceling statement due to lock timeout" nothing was applied, run it again a little later. Until
--      COMMIT the last part holds strong locks on stock_movements, stock_items, suppliers, stock_locations,
--      stock_correction_requests and audit_logs (a few seconds), so stock and audited writes wait for it.
--   7. The rolled-back self-check uses up a few stock_movements.ref_no identity values (0024 did the same); movement
--      numbers therefore have small gaps after every run. Room request and order numbers are not affected.
--   8. After 0025 never re-apply 0024: it would bring back the 0024 bodies of stock__raise, stock__ledger,
--      stock__history_rows, stock__purge_test_clinic, stock__harden_privileges and an 18-argument
--      stock__receive_line (its harden check then refuses the overload and the run rolls back). Later changes to
--      these objects start from the 0025 bodies in a new migration.

BEGIN;

-- Never queue for minutes behind a long reader while holding locks (runbook step 6).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Preflight. Nothing is changed before every check passes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_n bigint;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today', 'has_permission',
                    'audit_row_change', 'stock__apply', 'stock__ledger', 'stock__receive_line', 'stock__allocate_out',
                    'stock__fefo', 'stock__raise', 'stock__row_raise', 'stock__harden_privileges',
                    'stock__purge_test_clinic', 'stock__op_begin', 'stock__op_finish', 'stock__item_for_move',
                    'stock__location_active', 'stock__default_location', 'stock__sync_item', 'stock__move_result',
                    'stock__levels', 'stock__resolve_core', 'stock__flags', 'stock__add_constraint', 'stock__q',
                    'stock__qty', 'stock__to_usage', 'stock__reason', 'stock__day', 'stock__page', 'stock__j_text',
                    'stock__j_uuid', 'stock__j_num', 'stock__j_bigint', 'stock__j_bool', 'stock__keys_ok',
                    'stock__is_editor', 'stock__tr_lower', 'stock__require_staff', 'stock__require_operate',
                    'stock__require_manage', 'stock_can_operate', 'stock_can_manage', 'stock_can_view_costs',
                    'stock__trg_movements_immutable', 'stock__history_rows', 'stock__corr_json']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 7 (0024) / Faz 0 eksik, önce 0019 ve 0024 uygulanmalı: %', v_missing;
  END IF;

  -- stock__receive_line: the 0024 signature (first run) or the Phase 8 one (re-run), nothing else.
  IF to_regprocedure('public.stock__receive_line(uuid, uuid, uuid, date, boolean, uuid, uuid, numeric, text, numeric, '
                     || 'text, text, text, bigint, text, uuid, text, text)') IS NULL
     AND to_regprocedure('public.stock__receive_line(uuid, uuid, uuid, date, boolean, uuid, uuid, numeric, text, '
                         || 'numeric, text, text, text, bigint, text, uuid, text, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'stock__receive_line beklenen imzada değil (0024 sürümü bekleniyor).';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'stock__receive_line';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'stock__receive_line fonksiyonunun % sürümü var; tek sürüm bekleniyor.', v_n;
  END IF;

  -- stock__history_rows is replaced below with the same signature (0026 relies on it).
  IF to_regprocedure('public.stock__history_rows(uuid, uuid, boolean, boolean)') IS NULL THEN
    RAISE EXCEPTION 'stock__history_rows beklenen imzada değil (0024 sürümü bekleniyor).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  FOREACH v_missing IN ARRAY ARRAY['clinics', 'users', 'stock_items', 'stock_batches', 'stock_batch_costs',
                                   'stock_balances', 'stock_movements', 'stock_locations', 'suppliers',
                                   'stock_item_costs', 'stock_correction_requests', 'stock_operations',
                                   'fin_entries', 'fin_categories', 'fin_counterparties', 'fin_payments', 'audit_logs']
  LOOP
    IF to_regclass(format('public.%I', v_missing)) IS NULL THEN
      RAISE EXCEPTION 'Beklenen tablo yok: % (0020 / 0024 uygulanmalı).', v_missing;
    END IF;
  END LOOP;

  -- Existing columns used here, with their live types (udt_name).
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('stock_movements', 'po_item_id', 'uuid'), ('stock_movements', 'request_id', 'uuid'),
    ('stock_movements', 'movement_type', 'text'), ('stock_movements', 'quantity', 'numeric'),
    ('stock_movements', 'effective_at', 'timestamptz'), ('stock_movements', 'source_movement_id', 'uuid'),
    ('stock_movements', 'correction_request_id', 'uuid'), ('stock_movements', 'operation_key', 'uuid'),
    ('stock_items', 'units_per_purchase', 'numeric'), ('stock_items', 'min_qty', 'numeric'),
    ('stock_items', 'max_qty', 'numeric'), ('stock_items', 'tracking_level', 'text'),
    ('stock_items', 'needs_review', 'bool'), ('stock_items', 'is_active', 'bool'), ('stock_items', 'supplier_id', 'uuid'),
    ('stock_items', 'purchase_unit', 'text'), ('stock_items', 'usage_unit', 'text'), ('stock_items', 'brand', 'text'),
    ('stock_items', 'category', 'text'), ('stock_items', 'item_code', 'text'), ('stock_items', 'item_name', 'text'),
    ('stock_items', 'preferred_location_id', 'uuid'),
    ('stock_locations', 'kind', 'text'), ('stock_locations', 'is_default_warehouse', 'bool'),
    ('stock_locations', 'is_active', 'bool'), ('stock_locations', 'name', 'text'),
    ('suppliers', 'fin_counterparty_id', 'uuid'), ('suppliers', 'is_active', 'bool'), ('suppliers', 'name', 'text'),
    ('suppliers', 'phone', 'text'), ('suppliers', 'email', 'text'),
    ('stock_batch_costs', 'unit_cost_cents', 'int8'), ('stock_item_costs', 'last_unit_cost_cents', 'int8'),
    ('stock_correction_requests', 'status', 'text'), ('stock_correction_requests', 'movement_id', 'uuid'),
    ('fin_entries', 'id', 'uuid'), ('fin_entries', 'clinic_id', 'uuid'), ('fin_entries', 'category_id', 'uuid'),
    ('fin_entries', 'counterparty_id', 'uuid'), ('fin_entries', 'counterparty_text', 'text'),
    ('fin_entries', 'description', 'text'), ('fin_entries', 'due_date', 'date'),
    ('fin_entries', 'amount_cents', 'int8'), ('fin_entries', 'currency', 'bpchar'),
    ('fin_entries', 'source_key', 'text'), ('fin_entries', 'created_by', 'uuid'), ('fin_entries', 'updated_by', 'uuid'),
    ('fin_categories', 'id', 'uuid'), ('fin_categories', 'clinic_id', 'uuid'), ('fin_categories', 'name', 'text'),
    ('fin_categories', 'direction', 'text'), ('fin_categories', 'profit_class', 'text'),
    ('fin_categories', 'report_bucket', 'text'), ('fin_categories', 'is_system', 'bool'),
    ('fin_categories', 'is_active', 'bool'),
    ('fin_counterparties', 'id', 'uuid'), ('fin_counterparties', 'is_active', 'bool'),
    ('users', 'full_name', 'text'), ('clinics', 'slug', 'text')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı veya türü farklı: %', v_missing;
  END IF;

  -- The payable hook relies on fin_entries' partial unique (clinic_id, source_key) index (0020) as its arbiter.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'fin_entries'
                                            AND indexname = 'fin_entries_source_key') THEN
    RAISE EXCEPTION 'fin_entries_source_key dizini yok; 0020 uygulanmalı.';
  END IF;
  -- Composite foreign keys into finance need UNIQUE (clinic_id, id).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.fin_entries'::regclass AND c.contype = 'u'
                   AND pg_get_constraintdef(c.oid) = 'UNIQUE (clinic_id, id)')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.fin_categories'::regclass
                      AND c.contype = 'u' AND pg_get_constraintdef(c.oid) = 'UNIQUE (clinic_id, id)') THEN
    RAISE EXCEPTION 'fin_entries / fin_categories üzerinde UNIQUE (clinic_id, id) yok; 0020 uygulanmalı.';
  END IF;

  -- New tables left by an earlier run must have every column created below, with the same type.
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('stock_settings', 'clinic_id', 'uuid'), ('stock_settings', 'id', 'uuid'),
    ('stock_settings', 'po_creator_cannot_approve', 'bool'), ('stock_settings', 'po_payable_enabled', 'bool'),
    ('stock_settings', 'po_payable_due_days', 'int4'), ('stock_settings', 'po_payable_category_id', 'uuid'),
    ('stock_settings', 'version', 'int4'), ('stock_settings', 'updated_by', 'uuid'),
    ('stock_settings', 'updated_at', 'timestamptz'),
    ('stock_po_counters', 'clinic_id', 'uuid'), ('stock_po_counters', 'order_year', 'int2'),
    ('stock_po_counters', 'last_no', 'int4'),
    ('purchase_orders', 'id', 'uuid'), ('purchase_orders', 'clinic_id', 'uuid'), ('purchase_orders', 'order_year', 'int2'),
    ('purchase_orders', 'order_seq', 'int4'), ('purchase_orders', 'order_number', 'text'),
    ('purchase_orders', 'supplier_id', 'uuid'), ('purchase_orders', 'status', 'text'),
    ('purchase_orders', 'expected_date', 'date'), ('purchase_orders', 'note', 'text'),
    ('purchase_orders', 'created_by', 'uuid'), ('purchase_orders', 'created_at', 'timestamptz'),
    ('purchase_orders', 'content_edited_by', 'uuid'), ('purchase_orders', 'content_editors', '_uuid'),
    ('purchase_orders', 'approved_by', 'uuid'),
    ('purchase_orders', 'approved_at', 'timestamptz'), ('purchase_orders', 'ordered_by', 'uuid'),
    ('purchase_orders', 'ordered_at', 'timestamptz'), ('purchase_orders', 'received_at', 'timestamptz'),
    ('purchase_orders', 'closed_short', 'bool'), ('purchase_orders', 'closed_by', 'uuid'),
    ('purchase_orders', 'close_reason', 'text'), ('purchase_orders', 'cancelled_by', 'uuid'),
    ('purchase_orders', 'cancelled_at', 'timestamptz'), ('purchase_orders', 'cancel_reason', 'text'),
    ('purchase_orders', 'fin_entry_id', 'uuid'), ('purchase_orders', 'payable_state', 'text'),
    ('purchase_orders', 'version', 'int4'), ('purchase_orders', 'updated_by', 'uuid'),
    ('purchase_orders', 'updated_at', 'timestamptz'), ('purchase_orders', 'legacy_id', 'text'),
    ('purchase_order_items', 'id', 'uuid'), ('purchase_order_items', 'clinic_id', 'uuid'),
    ('purchase_order_items', 'order_id', 'uuid'), ('purchase_order_items', 'line_no', 'int2'),
    ('purchase_order_items', 'stock_item_id', 'uuid'), ('purchase_order_items', 'qty_ordered', 'numeric'),
    ('purchase_order_items', 'qty_received', 'numeric'), ('purchase_order_items', 'units_per_purchase', 'numeric'),
    ('purchase_order_items', 'note', 'text'), ('purchase_order_items', 'created_at', 'timestamptz'),
    ('purchase_order_items', 'updated_at', 'timestamptz'), ('purchase_order_items', 'legacy_id', 'text'),
    ('purchase_order_item_costs', 'po_item_id', 'uuid'), ('purchase_order_item_costs', 'id', 'uuid'),
    ('purchase_order_item_costs', 'clinic_id', 'uuid'), ('purchase_order_item_costs', 'unit_price_cents', 'int8'),
    ('purchase_order_item_costs', 'updated_by', 'uuid'), ('purchase_order_item_costs', 'updated_at', 'timestamptz'),
    ('stock_room_requests', 'id', 'uuid'), ('stock_room_requests', 'ref_no', 'int8'),
    ('stock_room_requests', 'clinic_id', 'uuid'), ('stock_room_requests', 'stock_item_id', 'uuid'),
    ('stock_room_requests', 'location_id', 'uuid'), ('stock_room_requests', 'quantity', 'numeric'),
    ('stock_room_requests', 'delivered_qty', 'numeric'), ('stock_room_requests', 'status', 'text'),
    ('stock_room_requests', 'note', 'text'), ('stock_room_requests', 'requested_by', 'uuid'),
    ('stock_room_requests', 'created_at', 'timestamptz'), ('stock_room_requests', 'approved_by', 'uuid'),
    ('stock_room_requests', 'approved_at', 'timestamptz'), ('stock_room_requests', 'delivered_by', 'uuid'),
    ('stock_room_requests', 'delivered_at', 'timestamptz'), ('stock_room_requests', 'source_location_id', 'uuid'),
    ('stock_room_requests', 'delivery_operation_key', 'uuid'), ('stock_room_requests', 'rejected_by', 'uuid'),
    ('stock_room_requests', 'rejected_at', 'timestamptz'), ('stock_room_requests', 'reject_reason', 'text'),
    ('stock_room_requests', 'cancelled_by', 'uuid'), ('stock_room_requests', 'cancelled_at', 'timestamptz'),
    ('stock_room_requests', 'version', 'int4'), ('stock_room_requests', 'updated_at', 'timestamptz'),
    ('stock_room_requests', 'legacy_id', 'text')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önceki çalıştırmadan kalan satın alma tabloları beklenen yapıda değil: %', v_missing;
  END IF;

  -- The ledger hook columns: empty on the first run; on a re-run every value points at an existing row.
  IF to_regclass('public.purchase_order_items') IS NULL THEN
    SELECT count(*) INTO v_n FROM public.stock_movements m WHERE m.po_item_id IS NOT NULL;
  ELSE
    EXECUTE 'SELECT count(*) FROM public.stock_movements m WHERE m.po_item_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.purchase_order_items i
                               WHERE i.id = m.po_item_id AND i.clinic_id = m.clinic_id)' INTO v_n;
  END IF;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'stock_movements: % satırda po_item_id dolu fakat sipariş satırı yok.', v_n;
  END IF;
  IF to_regclass('public.stock_room_requests') IS NULL THEN
    SELECT count(*) INTO v_n FROM public.stock_movements m WHERE m.request_id IS NOT NULL;
  ELSE
    EXECUTE 'SELECT count(*) FROM public.stock_movements m WHERE m.request_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.stock_room_requests r
                               WHERE r.id = m.request_id AND r.clinic_id = m.clinic_id)' INTO v_n;
  END IF;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'stock_movements: % satırda request_id dolu fakat oda talebi yok.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.stock_movements m
  WHERE (m.po_item_id IS NOT NULL AND m.movement_type <> 'receive')
     OR (m.request_id IS NOT NULL AND m.movement_type <> 'transfer');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'stock_movements: % satırda po_item_id / request_id hareket türüyle uyuşmuyor.', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Schema. clinic_id plus composite foreign keys into the clinic's own rows (P1 pattern); UNIQUE (clinic_id, id)
--    where other rows point at them; no client write privilege (§3 below).
-- ---------------------------------------------------------------------------

-- 2.1 stock_settings: one row per clinic; no row = defaults (stock__settings). id mirrors clinic_id because
--     audit_logs.entity_id is NOT NULL.
CREATE TABLE IF NOT EXISTS public.stock_settings (
  clinic_id uuid PRIMARY KEY REFERENCES public.clinics(id) ON DELETE CASCADE,
  id uuid GENERATED ALWAYS AS (clinic_id) STORED,
  po_creator_cannot_approve boolean NOT NULL DEFAULT false,
  po_payable_enabled boolean NOT NULL DEFAULT false,                -- owner decision: OFF
  po_payable_due_days integer NOT NULL DEFAULT 30 CHECK (po_payable_due_days BETWEEN 0 AND 365),
  po_payable_category_id uuid,                                      -- NULL = the system 'supplies' category
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_settings_category_fkey
    FOREIGN KEY (clinic_id, po_payable_category_id) REFERENCES public.fin_categories (clinic_id, id)
);

-- 2.2 stock_po_counters: per clinic and year; the row lock serialises creates, a rolled-back create rolls the
--     counter back, so committed numbers have no gaps. No client access at all.
CREATE TABLE IF NOT EXISTS public.stock_po_counters (
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  order_year smallint NOT NULL CHECK (order_year BETWEEN 2000 AND 2200),
  last_no integer NOT NULL CHECK (last_no >= 1),
  PRIMARY KEY (clinic_id, order_year)
);

-- 2.3 purchase_orders (SCH:217-236). No money column: managers without cost view read this table.
--     lpad() truncates longer strings, hence the CASE (numbers >= 10 000 print in full).
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id uuid PRIMARY KEY,                                              -- client-supplied
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  order_year smallint NOT NULL CHECK (order_year BETWEEN 2000 AND 2200),
  order_seq integer NOT NULL CHECK (order_seq >= 1),
  order_number text GENERATED ALWAYS AS (
    'SP-' || order_year::text || '-'
    || CASE WHEN order_seq < 10000 THEN lpad(order_seq::text, 4, '0') ELSE order_seq::text END) STORED,
  supplier_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'ordered', 'partially_received', 'received', 'cancelled')),
  expected_date date CHECK (expected_date IS NULL OR expected_date BETWEEN DATE '2000-01-01' AND DATE '2200-12-31'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  content_edited_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,   -- last supplier / line editor (display)
  content_editors uuid[] NOT NULL DEFAULT '{}'::uuid[],                    -- every such editor (approval rule)
  approved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  ordered_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  ordered_at timestamptz,
  received_at timestamptz,
  closed_short boolean NOT NULL DEFAULT false,
  closed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  close_reason text,
  cancelled_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancel_reason text,
  fin_entry_id uuid,
  payable_state text NOT NULL DEFAULT 'none' CHECK (payable_state IN
    ('none', 'disabled', 'created', 'skipped_unpriced', 'skipped_zero', 'skipped_no_category', 'skipped_error')),
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, order_year, order_seq),
  CONSTRAINT purchase_orders_supplier_fkey
    FOREIGN KEY (clinic_id, supplier_id) REFERENCES public.suppliers (clinic_id, id),
  CONSTRAINT purchase_orders_fin_entry_fkey
    FOREIGN KEY (clinic_id, fin_entry_id) REFERENCES public.fin_entries (clinic_id, id),
  CONSTRAINT po_approved_shape CHECK (status IN ('pending', 'cancelled')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT po_ordered_shape CHECK (status NOT IN ('ordered', 'partially_received', 'received') OR ordered_at IS NOT NULL),
  CONSTRAINT po_received_shape CHECK ((status = 'received') = (received_at IS NOT NULL)),
  CONSTRAINT po_cancel_shape CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND char_length(btrim(cancel_reason)) BETWEEN 3 AND 500))),
  CONSTRAINT po_close_shape CHECK ((NOT closed_short AND close_reason IS NULL AND closed_by IS NULL)
    OR (closed_short AND status = 'received' AND closed_by IS NOT NULL
        AND char_length(btrim(close_reason)) BETWEEN 3 AND 500)),
  CONSTRAINT po_payable_shape CHECK ((payable_state = 'created') = (fin_entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_key ON public.purchase_orders (clinic_id, order_number);
CREATE INDEX IF NOT EXISTS purchase_orders_status ON public.purchase_orders (clinic_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier ON public.purchase_orders (clinic_id, supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_legacy_key ON public.purchase_orders (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- 2.4 purchase_order_items (SCH:238-251): one line per card, quantities in usage units.
CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 20),
  stock_item_id uuid NOT NULL,
  qty_ordered numeric(14,4) NOT NULL CHECK (qty_ordered > 0 AND qty_ordered <= 1000000),
  qty_received numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  units_per_purchase numeric(14,4) NOT NULL CHECK (units_per_purchase > 0),   -- card factor when the line was saved
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  CONSTRAINT po_items_item_key UNIQUE (order_id, stock_item_id),
  CONSTRAINT po_items_line_key UNIQUE (order_id, line_no) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT po_items_received_le CHECK (qty_received <= qty_ordered),
  CONSTRAINT purchase_order_items_order_fkey
    FOREIGN KEY (clinic_id, order_id) REFERENCES public.purchase_orders (clinic_id, id),
  CONSTRAINT purchase_order_items_item_fkey
    FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id)
);
CREATE INDEX IF NOT EXISTS purchase_order_items_item ON public.purchase_order_items (clinic_id, stock_item_id);
CREATE INDEX IF NOT EXISTS purchase_order_items_order ON public.purchase_order_items (order_id, line_no);

-- 2.5 purchase_order_item_costs (cost-gated). No row = unpriced line ("Fiyat girilmemiş"). Cents per USAGE unit.
CREATE TABLE IF NOT EXISTS public.purchase_order_item_costs (
  po_item_id uuid PRIMARY KEY,
  id uuid GENERATED ALWAYS AS (po_item_id) STORED,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 100000000000),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_item_costs_item_fkey
    FOREIGN KEY (clinic_id, po_item_id) REFERENCES public.purchase_order_items (clinic_id, id) ON DELETE CASCADE
);

-- 2.6 stock_room_requests (SCH:193-215; acted_by split per decision). Quantities in usage units.
CREATE TABLE IF NOT EXISTS public.stock_room_requests (
  id uuid PRIMARY KEY,                                              -- client-supplied
  ref_no bigint NOT NULL CHECK (ref_no >= 1),                      -- "Talep #n", per clinic (stock__rq_create_core)
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  stock_item_id uuid NOT NULL,
  location_id uuid NOT NULL,                                        -- target room / sterilization area
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  delivered_qty numeric(14,4) CHECK (delivered_qty IS NULL OR (delivered_qty > 0 AND delivered_qty <= quantity)),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'delivered', 'rejected', 'cancelled')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  requested_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  delivered_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  delivered_at timestamptz,
  source_location_id uuid,                                          -- the default warehouse at delivery time
  delivery_operation_key uuid,                                      -- = the deliver call's operation key
  rejected_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  reject_reason text,
  cancelled_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  CONSTRAINT stock_room_requests_ref_key UNIQUE (clinic_id, ref_no),
  CONSTRAINT stock_room_requests_item_fkey
    FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id),
  CONSTRAINT stock_room_requests_location_fkey
    FOREIGN KEY (clinic_id, location_id) REFERENCES public.stock_locations (clinic_id, id),
  CONSTRAINT stock_room_requests_source_fkey
    FOREIGN KEY (clinic_id, source_location_id) REFERENCES public.stock_locations (clinic_id, id),
  CONSTRAINT rq_approved_shape CHECK (status NOT IN ('approved', 'delivered')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT rq_delivered_shape CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)
    AND (delivered_at IS NULL OR (delivered_by IS NOT NULL AND delivered_qty IS NOT NULL
                                  AND source_location_id IS NOT NULL AND delivery_operation_key IS NOT NULL))),
  CONSTRAINT rq_rejected_shape CHECK ((status = 'rejected') = (rejected_at IS NOT NULL)
    AND (rejected_at IS NULL OR (rejected_by IS NOT NULL AND char_length(btrim(reject_reason)) BETWEEN 3 AND 500))),
  CONSTRAINT rq_cancelled_shape CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (cancelled_at IS NULL OR cancelled_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS stock_room_requests_status ON public.stock_room_requests (clinic_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_room_requests_requester
  ON public.stock_room_requests (clinic_id, requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_room_requests_open_item ON public.stock_room_requests (stock_item_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS stock_room_requests_open_location ON public.stock_room_requests (location_id)
  WHERE status IN ('pending', 'approved');
CREATE UNIQUE INDEX IF NOT EXISTS stock_room_requests_legacy_key ON public.stock_room_requests (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- 2.7 Ledger hooks on stock_movements: added in section 12a (busy 0024 tables last, short lock window).

-- Named constraints of the new tables must exist (a table left by an earlier, different run would lack them).
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(e.tbl || '.' || e.con, ', ')
    INTO v_missing
  FROM (VALUES
    ('stock_settings', 'stock_settings_category_fkey'),
    ('purchase_orders', 'purchase_orders_supplier_fkey'), ('purchase_orders', 'purchase_orders_fin_entry_fkey'),
    ('purchase_orders', 'po_approved_shape'), ('purchase_orders', 'po_ordered_shape'),
    ('purchase_orders', 'po_received_shape'), ('purchase_orders', 'po_cancel_shape'),
    ('purchase_orders', 'po_close_shape'), ('purchase_orders', 'po_payable_shape'),
    ('purchase_order_items', 'po_items_item_key'), ('purchase_order_items', 'po_items_line_key'),
    ('purchase_order_items', 'po_items_received_le'), ('purchase_order_items', 'purchase_order_items_order_fkey'),
    ('purchase_order_items', 'purchase_order_items_item_fkey'),
    ('purchase_order_item_costs', 'purchase_order_item_costs_item_fkey'),
    ('stock_room_requests', 'stock_room_requests_item_fkey'), ('stock_room_requests', 'stock_room_requests_location_fkey'),
    ('stock_room_requests', 'stock_room_requests_source_fkey'), ('stock_room_requests', 'rq_approved_shape'),
    ('stock_room_requests', 'rq_delivered_shape'), ('stock_room_requests', 'rq_rejected_shape'),
    ('stock_room_requests', 'rq_cancelled_shape'), ('stock_room_requests', 'stock_room_requests_ref_key')
  ) AS e(tbl, con)
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = format('public.%I', e.tbl)::regclass AND c.conname = e.con);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Satın alma tablolarında beklenen kısıtlar yok (önceki farklı bir çalıştırma?): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Replaced 0024 objects.
-- 3.1 stock__raise: every 0024 branch verbatim, Phase 8 keys appended before ELSE (same signature, same rules).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock__raise(p_key text, p_arg text DEFAULT NULL, p_detail text DEFAULT NULL)
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
    WHEN 'E_OPERATE' THEN v_msg := 'Bu hesap stok kaydı oluşturamaz.'; v_code := '42501';
    WHEN 'E_MANAGE' THEN v_msg := 'Bu işlem için stok yönetim yetkisi gerekir.'; v_code := '42501';
    WHEN 'E_RETURN_ROLE' THEN v_msg := 'Kullanım iadesini stok sorumlusu veya klinik sahibi kaydedebilir.'; v_code := '42501';
    WHEN 'E_COST_FORBIDDEN' THEN v_msg := 'Maliyet girmek için stok maliyet yetkisi gerekir.'; v_code := '42501';
    WHEN 'E_COST_READ' THEN v_msg := 'Maliyet bilgilerini görme yetkiniz yok.'; v_code := '42501';
    WHEN 'E_FINANCE_LINK' THEN v_msg := 'Tedarikçiyi finans kaydına bağlamak için finans yetkisi gerekir.'; v_code := '42501';
    WHEN 'E_OP_KEY' THEN v_msg := 'Bu işlem anahtarı başka bir kayıt için kullanılmış.'; v_code := 'PT409';
    WHEN 'E_OP_KEY_FORMAT' THEN v_msg := 'İşlem anahtarı geçersiz.';
    WHEN 'E_VERSION' THEN v_msg := 'Kayıt başka bir ekranda değişti. Listeyi yenileyip tekrar açın.'; v_code := 'PT409';
    WHEN 'E_ITEM_VERSION' THEN v_msg := 'Kart başka bir işlemle değişti. Listeyi yenileyip yeniden açın.'; v_code := 'PT409';
    WHEN 'E_ID_TAKEN' THEN v_msg := 'Kayıt kaydedilemedi.'; v_code := 'PT409';
    WHEN 'E_FILTER' THEN v_msg := 'Filtre değerleri geçersiz.';
    WHEN 'E_ITEM_NOT_FOUND' THEN v_msg := 'Ürün bulunamadı veya kart bilgileri henüz tamamlanmadı.'; v_code := 'PT404';
    WHEN 'E_ITEM_INACTIVE' THEN v_msg := 'Bu ürün kartı pasif. Önce kartı yeniden etkinleştirin.';
    WHEN 'E_TYPE' THEN v_msg := 'Geçersiz işlem türü.';
    WHEN 'E_QTY' THEN v_msg := 'Miktar sıfırdan büyük olmalıdır.';
    WHEN 'E_QTY_SCALE' THEN v_msg := 'Miktar en fazla 4 ondalık basamak ve 1.000.000 değerini aşmayacak şekilde girilmelidir.';
    WHEN 'E_QTY_UNIT' THEN v_msg := 'Miktarı ve kutu / adet seçimini kontrol edin.';
    WHEN 'E_QTY_INTEGER' THEN v_msg := 'Bu üründe tam adet girin.';
    WHEN 'E_UNIT_CHANGED' THEN v_msg := 'Kartın kutu / adet dönüşümü değişmiş. Formu yenileyip miktarı tekrar girin.'; v_code := 'PT409';
    WHEN 'E_LOCATION' THEN v_msg := 'Seçilen konum bulunamadı.'; v_code := 'PT404';
    WHEN 'E_SAME_LOCATION' THEN v_msg := 'Malzemenin bulunduğu yer ile götürüleceği yer farklı olmalıdır.';
    WHEN 'E_BATCH_ON_RECEIVE' THEN v_msg := 'Yeni girişte lot ve tarih alanlarını kullanın.';
    WHEN 'E_LOT_REQUIRED' THEN v_msg := 'Bu üründe ambalajdaki lot / parti numarasını girin.';
    WHEN 'E_LOT_FORMAT' THEN v_msg := 'Lot / parti numarası en fazla 40 karakter olabilir.';
    WHEN 'E_SERIAL_FORMAT' THEN v_msg := 'Seri numarası en fazla 40 karakter olabilir.';
    WHEN 'E_EXPIRY_REQUIRED' THEN v_msg := 'Bu üründe son kullanma tarihini girin.';
    WHEN 'E_EXPIRY_INVALID' THEN v_msg := 'Geçerli bir son kullanma tarihi girin.';
    WHEN 'E_EXPIRED_RECEIVE' THEN v_msg := 'Süresi geçmiş ürün yeni stok olarak kabul edilemez.';
    WHEN 'E_SERIAL_QTY' THEN v_msg := 'Seri numaralı ürünleri tek tek, 1 adet olarak girin.';
    WHEN 'E_SERIAL_TAKEN' THEN v_msg := 'Bu seri numarası zaten kayıtlı. Yeni giriş yapmayın; ilgili kaydı kontrol edin.'; v_code := 'PT409';
    WHEN 'E_COST' THEN v_msg := 'Geçerli bir birim maliyet girin.';
    WHEN 'E_SUPPLIER' THEN v_msg := 'Tedarikçi bulunamadı.';
    WHEN 'E_DOCUMENT_NO' THEN v_msg := 'Belge numarası en fazla 60 karakter olabilir.';
    WHEN 'E_BATCH_REQUIRED' THEN v_msg := 'Bu üründe elinizdeki ambalajın lot / seri kaydını seçin.';
    WHEN 'E_BATCH' THEN v_msg := 'Bu ürüne ait lot / seri kaydını seçin.'; v_code := 'PT404';
    WHEN 'E_INSUFFICIENT' THEN v_msg := 'Seçilen yerde bu işlem için kullanılabilir miktar: %s. Lotu, konumu ve son kullanma tarihini kontrol edin.'; v_code := 'PT409';
    WHEN 'E_SERIAL_MOVE' THEN v_msg := 'Seri numaralı ürünler tek adet işlenir.';
    WHEN 'E_PATIENT_DOCTOR' THEN v_msg := 'Bu ürünün kullanımında hasta ve uygulayan hekim zorunlu.';
    WHEN 'E_PATIENT' THEN v_msg := 'Hasta bulunamadı.'; v_code := 'PT404';
    WHEN 'E_DOCTOR' THEN v_msg := 'Hekim bulunamadı.';
    WHEN 'E_APPOINTMENT' THEN v_msg := 'Randevu bulunamadı veya seçilen hastaya ait değil.';
    WHEN 'E_REASON_REQUIRED' THEN v_msg := 'Bu işlem için kısa bir açıklama yazın.';
    WHEN 'E_REASON_LENGTH' THEN v_msg := 'Açıklama en fazla 500 karakter olabilir.';
    WHEN 'E_RETURN_SOURCE' THEN v_msg := 'Bu ürüne ait kullanım kaydını seçin.';
    WHEN 'E_RETURN_CORRECTED' THEN v_msg := 'Bu kayıt düzeltildi. Güncel kullanım kaydını seçin.'; v_code := 'PT409';
    WHEN 'E_RETURN_UNUSED' THEN v_msg := 'Yalnızca kullanılmamış ve kliniğin tekrar stoğa kabul ettiği malzeme iade edilebilir.';
    WHEN 'E_RETURN_QTY' THEN v_msg := 'İade miktarı, bu kullanım kaydından iade edilebilecek miktarı aşıyor.'; v_code := 'PT409';
    WHEN 'E_BULK_SIZE' THEN v_msg := 'Bir listede 1–20 satır kaydedin.';
    WHEN 'E_COUNT_FIELDS' THEN v_msg := 'Saydığınız miktarı ve kısa bir açıklama girin.';
    WHEN 'E_COUNT_SIZE' THEN v_msg := 'Bir sayımda 1–500 satır kaydedin.';
    WHEN 'E_COUNT_STALE' THEN v_msg := 'Stok siz sayarken değişmiş. Yenileyip miktarı tekrar kontrol edin.'; v_code := 'PT409';
    WHEN 'E_COUNT_A_INTEGER' THEN v_msg := 'A grubu ürünlerde tam adet girin.';
    WHEN 'E_COUNT_SERIAL' THEN v_msg := 'Tek seri numarası için en fazla 1 adet bulunabilir.';
    WHEN 'E_COUNT_A_SURPLUS' THEN v_msg := 'A grubu fazla ürün sayımla eklenemez. Stok sorumlusu lot / seri bilgisiyle mal kabul veya kullanım iadesi yapmalıdır.'; v_code := 'PT409';
    WHEN 'E_COUNT_DUPLICATE' THEN v_msg := 'Aynı lot ve konum iki kez sayılamaz.';
    WHEN 'E_CORR_REASON' THEN v_msg := 'Hatayı kısaca açıklayın (3–1000 karakter).';
    WHEN 'E_CORR_OWN' THEN v_msg := 'Yalnız kendi stok işleminiz için talep bırakabilirsiniz.'; v_code := '42501';
    WHEN 'E_CORR_TYPE' THEN v_msg := 'Bu hareket türü için düzeltme talebi bırakılamaz.';
    WHEN 'E_CORR_EXISTS' THEN v_msg := 'Bu hareket için açık veya onaylanmış bir düzeltme talebi var.'; v_code := 'PT409';
    WHEN 'E_CORR_NOT_FOUND' THEN v_msg := 'Düzeltme talebi bulunamadı.'; v_code := 'PT404';
    WHEN 'E_CORR_DONE' THEN v_msg := 'Talep daha önce işlenmiş.'; v_code := 'PT409';
    WHEN 'E_CORR_ACTION' THEN v_msg := 'Karar seçin.';
    WHEN 'E_CORR_RESOLUTION' THEN v_msg := 'Karar açıklamasını yazın (3–1000 karakter).';
    WHEN 'E_CORR_QTY' THEN v_msg := 'Doğru miktarı girin; iptal için 0 yazın.';
    WHEN 'E_CORR_INTEGER' THEN v_msg := 'Tam adet girin.';
    WHEN 'E_CORR_SERIAL' THEN v_msg := 'Seri numaralı ürün en fazla 1 adettir.';
    WHEN 'E_CORR_ORDER' THEN v_msg := 'Siparişe bağlı mal kabul için önce siparişi ve fiziksel teslimatı stok sorumlusuyla kontrol edin; bu ekrandan miktar değiştirilemez.'; v_code := 'PT409';
    WHEN 'E_CORR_RETURNED' THEN v_msg := 'Bu kullanımın iadesi kayıtlı; düzeltme yapılamaz. Önce iade kaydını kontrol edin.'; v_code := 'PT409';
    WHEN 'E_CORR_NEGATIVE' THEN v_msg := 'Düzeltme stoğu eksiye düşürür. Sonraki hareketleri kontrol edin.'; v_code := 'PT409';
    WHEN 'E_ITEM_FIELDS' THEN v_msg := 'Ürün adı, kategori ve takip kuralını tamamlayın.';
    WHEN 'E_ITEM_UNITS' THEN v_msg := 'Alış ve tüketim birimini tamamlayın.';
    WHEN 'E_ITEM_NUMBERS' THEN v_msg := 'Miktar, dönüşüm ve maliyet alanlarını kontrol edin.';
    WHEN 'E_ITEM_MINMAX' THEN v_msg := 'Hedef stok, kritik stoktan küçük olamaz.';
    WHEN 'E_ITEM_LOCKED' THEN v_msg := 'İşlem görmüş kartın takip kuralı ve birimleri değiştirilemez. Farklı birim için yeni kart açın.'; v_code := 'PT409';
    WHEN 'E_ITEM_DRAFT_LOCKED' THEN v_msg := 'İşlem görmüş kart taslağa çevrilemez.'; v_code := 'PT409';
    WHEN 'E_ITEM_HAS_STOCK' THEN v_msg := 'Stoku olan kart pasif yapılamaz. Önce stoğu fire, kullanım veya sayımla sıfırlayın.'; v_code := 'PT409';
    WHEN 'E_ITEM_DELETE' THEN v_msg := 'Stok geçmişi olan kart silinemez; kartı pasif yapın.'; v_code := 'PT409';
    WHEN 'E_ITEM_CODE' THEN v_msg := 'Stok kodu en fazla 40 karakter olabilir.';
    WHEN 'E_ITEM_CODE_TAKEN' THEN v_msg := 'Bu stok kodu başka bir kartta kayıtlı.'; v_code := 'PT409';
    WHEN 'E_GTIN' THEN v_msg := 'Barkod 8, 12, 13 veya 14 rakam olmalıdır.';
    WHEN 'E_GTIN_TAKEN' THEN v_msg := 'Bu barkod başka bir kartta kayıtlı.'; v_code := 'PT409';
    WHEN 'E_LINK_GTIN' THEN v_msg := 'Bu kartın başka bir barkodu var. Barkodsuz bir kart seçin veya yeni kart tanımlayın.'; v_code := 'PT409';
    WHEN 'E_NOTES' THEN v_msg := 'Kart notu en fazla 2000 karakter olabilir.';
    WHEN 'E_ABC_POLICY' THEN v_msg := 'Sipariş sınıfını ve modelini kontrol edin.';
    WHEN 'E_PREQ_NAME' THEN v_msg := 'Ambalajdaki ürün adını yazın (en fazla 160 karakter).';
    WHEN 'E_PREQ_NOTE' THEN v_msg := 'Not en fazla 500 karakter olabilir.';
    WHEN 'E_GTIN_KNOWN' THEN v_msg := 'Bu ürün tanımlanmış. Listeyi yenileyip barkodu tekrar okutun.'; v_code := 'PT409';
    WHEN 'E_PREQ_NOT_FOUND' THEN v_msg := 'Tanımlama talebi bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PREQ_DONE' THEN v_msg := 'Bu tanımlama talebi daha önce sonuçlandırılmış.'; v_code := 'PT409';
    WHEN 'E_LOCATION_NAME' THEN v_msg := 'Konum adı 1–80 karakter olmalı.';
    WHEN 'E_LOCATION_TAKEN' THEN v_msg := 'Bu adla bir konum zaten var.'; v_code := 'PT409';
    WHEN 'E_LOCATION_KIND' THEN v_msg := 'Konum türünü seçin.';
    WHEN 'E_LOCATION_HAS_STOCK' THEN v_msg := 'Stoku olan konum pasif yapılamaz. Önce malzemeyi başka konuma taşıyın.'; v_code := 'PT409';
    WHEN 'E_LOCATION_DEFAULT' THEN v_msg := 'Ana depo olarak işaretli konum pasif yapılamaz veya depo dışı türe çevrilemez. Önce başka bir depoyu ana depo yapın.'; v_code := 'PT409';
    WHEN 'E_CHAIR' THEN v_msg := 'Koltuk bulunamadı veya pasif.';
    WHEN 'E_SUPPLIER_NAME' THEN v_msg := 'Tedarikçi adı 1–200 karakter olmalı.';
    WHEN 'E_SUPPLIER_TAKEN' THEN v_msg := 'Bu adla bir tedarikçi zaten var.'; v_code := 'PT409';
    WHEN 'E_SUPPLIER_FIELDS' THEN v_msg := 'Telefon, e-posta, vergi no ve not alanlarını kontrol edin.';
    WHEN 'E_FIN_COUNTERPARTY' THEN v_msg := 'Finans kaydı bulunamadı veya tedarikçi türünde değil.';
    WHEN 'E_FAVORITES_LIMIT' THEN v_msg := 'En fazla 100 favori ürün seçebilirsiniz.';
    WHEN 'E_DATE_RANGE' THEN v_msg := 'Geçerli tarih aralığı seçin.';
    WHEN 'E_LEGACY_COLUMNS' THEN v_msg := 'Eski stok alanları (miktar, minimum, fiyat, SKT, tedarikçi) artık yalnızca stok hareketleriyle değişir.';
    WHEN 'E_HISTORY' THEN v_msg := 'Stok geçmişi kayıtları değiştirilemez veya silinemez.';
    -- Phase 8 (0025_stock_purchasing.sql)
    WHEN 'E_PO_READ' THEN v_msg := 'Satın alma kayıtlarını görme yetkiniz yok.'; v_code := '42501';
    WHEN 'E_PO_NOT_FOUND' THEN v_msg := 'Sipariş bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PO_ACTION' THEN v_msg := 'Geçersiz sipariş işlemi.';
    WHEN 'E_PO_STATE' THEN v_msg := 'Sipariş bu aşamadan ilerletilemez. Listeyi yenileyin.'; v_code := 'PT409';
    WHEN 'E_PO_LINES' THEN v_msg := 'Siparişe 1–20 ürün ekleyin.';
    WHEN 'E_PO_DUP_ITEM' THEN v_msg := 'Aynı ürün siparişte iki kez yer alamaz; miktarı tek satırda toplayın.';
    WHEN 'E_PO_DATE' THEN v_msg := 'Teslim tarihini kontrol edin.';
    WHEN 'E_PO_NOTE' THEN v_msg := 'Sipariş notu en fazla 1000 karakter, satır notu en fazla 200 karakter olabilir.';
    WHEN 'E_PO_EDIT_STATE' THEN v_msg := 'Yalnızca onay bekleyen sipariş değiştirilebilir. Gerekirse siparişi iptal edip yenisini oluşturun.'; v_code := 'PT409';
    WHEN 'E_PO_SELF_APPROVE' THEN v_msg := 'Bu klinikte siparişi hazırlayan veya içeriğini değiştiren kişi onaylayamaz. Başka bir stok yetkilisi onaylamalı.'; v_code := '42501';
    WHEN 'E_PO_REASON' THEN v_msg := 'İptal veya kapatma nedenini yazın (3–500 karakter).';
    WHEN 'E_PO_RECEIVE_STATE' THEN v_msg := 'Bu sipariş satırı mal kabul için uygun değil. Sipariş "Sipariş verildi" aşamasında olmalı.'; v_code := 'PT409';
    WHEN 'E_PO_LINE' THEN v_msg := 'Sipariş satırı bulunamadı.'; v_code := 'PT404';
    WHEN 'E_PO_OVER' THEN v_msg := 'Giriş miktarı siparişin kalan miktarından fazla. Kalan: %s.'; v_code := 'PT409';
    WHEN 'E_RQ_NOT_FOUND' THEN v_msg := 'Talep bulunamadı.'; v_code := 'PT404';
    WHEN 'E_RQ_ACTION' THEN v_msg := 'Geçersiz talep işlemi.';
    WHEN 'E_RQ_STATE' THEN v_msg := 'Talep daha önce işlenmiş. Listeyi yenileyin.'; v_code := 'PT409';
    WHEN 'E_RQ_MANAGE' THEN v_msg := 'Talebi yalnızca stok sorumlusu veya klinik sahibi işleyebilir.'; v_code := '42501';
    WHEN 'E_RQ_LOCATION' THEN v_msg := 'Talep için bir oda veya sterilizasyon alanı seçin.';
    WHEN 'E_RQ_NOTE' THEN v_msg := 'Not en fazla 500 karakter olabilir.';
    WHEN 'E_RQ_QTY' THEN v_msg := 'Teslim miktarı talep edilen miktarı aşamaz.';
    WHEN 'E_RQ_REASON' THEN v_msg := 'Ret nedenini yazın (3–500 karakter).';
    WHEN 'E_RQ_CANCEL_OWN' THEN v_msg := 'Talebi yalnızca oluşturan kişi geri çekebilir.'; v_code := '42501';
    WHEN 'E_ITEM_OPEN_ORDERS' THEN v_msg := 'Açık siparişte yer alan kart pasif yapılamaz veya taslağa çevrilemez. Önce siparişi tamamlayın veya iptal edin.'; v_code := 'PT409';
    WHEN 'E_ITEM_OPEN_REQUESTS' THEN v_msg := 'Bekleyen oda talebi olan kart pasif yapılamaz veya taslağa çevrilemez. Önce talepleri sonuçlandırın.'; v_code := 'PT409';
    WHEN 'E_SUPPLIER_OPEN_ORDERS' THEN v_msg := 'Açık siparişi olan tedarikçi pasif yapılamaz.'; v_code := 'PT409';
    WHEN 'E_LOCATION_OPEN_REQUESTS' THEN v_msg := 'Bu konuma bekleyen oda talepleri var. Önce talepleri sonuçlandırın.'; v_code := 'PT409';
    WHEN 'E_SETTINGS' THEN v_msg := 'Ayar değerlerini kontrol edin.';
    WHEN 'E_SETTING_OWNER' THEN v_msg := 'Bu ayarı yalnızca klinik sahibi değiştirebilir.'; v_code := '42501';
    WHEN 'E_FINANCE_SETTING' THEN v_msg := 'Finans bağlantısı ayarlarını yalnızca finans yetkisi olan kullanıcılar değiştirebilir.'; v_code := '42501';
    WHEN 'E_PAYABLE_CATEGORY' THEN v_msg := 'Gider kategorisi bulunamadı veya gider türünde değil.';
    WHEN 'E_REPORT_READ' THEN v_msg := 'Raporu görme yetkiniz yok.'; v_code := '42501';
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
-- 3.2 stock__ledger (same signature): the INSERT also fills po_item_id / request_id from p_extra.
-- ---------------------------------------------------------------------------
-- §4.0 One ledger row. p_line NULL -> next line number of the operation (the operation key is exclusive to one
-- transaction through stock_operations). p_extra keys: patient_id, appointment_id, doctor_id, supplier_id,
-- document_no, reason, source_movement_id, correction_request_id, count_id, effective_at, actor_user_id, and (Phase 8)
-- po_item_id / request_id. Same signature as 0024; callers that pass neither key leave both columns NULL.
CREATE OR REPLACE FUNCTION public.stock__ledger(p_clinic uuid, p_op uuid, p_line integer, p_item uuid, p_batch uuid,
                                                p_type text, p_qty numeric, p_from uuid, p_to uuid, p_extra jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_line integer := p_line;
  v_id uuid;
  v_extra jsonb := coalesce(p_extra, '{}'::jsonb);
BEGIN
  IF v_line IS NULL THEN
    SELECT coalesce(max(m.line_no), 0) + 1 INTO v_line FROM public.stock_movements m WHERE m.operation_key = p_op;
  END IF;

  INSERT INTO public.stock_movements (
    clinic_id, operation_key, line_no, stock_item_id, batch_id, movement_type, quantity, from_location_id,
    to_location_id, patient_id, appointment_id, doctor_id, supplier_id, document_no, reason, source_movement_id,
    correction_request_id, count_id, po_item_id, request_id, actor_user_id, effective_at)
  VALUES (
    p_clinic, p_op, v_line, p_item, p_batch, p_type, p_qty, p_from, p_to,
    nullif(v_extra ->> 'patient_id', '')::uuid,
    nullif(v_extra ->> 'appointment_id', '')::uuid,
    nullif(v_extra ->> 'doctor_id', '')::uuid,
    nullif(v_extra ->> 'supplier_id', '')::uuid,
    coalesce(v_extra ->> 'document_no', ''),
    coalesce(v_extra ->> 'reason', ''),
    nullif(v_extra ->> 'source_movement_id', '')::uuid,
    nullif(v_extra ->> 'correction_request_id', '')::uuid,
    nullif(v_extra ->> 'count_id', '')::uuid,
    nullif(v_extra ->> 'po_item_id', '')::uuid,
    nullif(v_extra ->> 'request_id', '')::uuid,
    nullif(v_extra ->> 'actor_user_id', '')::uuid,
    coalesce(nullif(v_extra ->> 'effective_at', '')::timestamptz, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3.3 stock__receive_line: one trailing parameter. A changed signature is DROP + CREATE in this transaction (no
--     overloads); CREATE OR REPLACE also covers a re-run, where the 19-argument version already exists. Body: 0024
--     verbatim except the ledger extra. stock__harden_privileges() at the end re-applies the never-granted rule.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stock__receive_line(uuid, uuid, uuid, date, boolean, uuid, uuid, numeric, text, numeric,
  text, text, text, bigint, text, uuid, text, text);
-- §4.1 One receipt (stock_receive and every line of stock_bulk_receive). The card must already be locked by the
-- caller when several cards are involved (bulk locks them all in id order first). Returns the movement id.
-- Phase 8: trailing p_po_item (the purchase order line a receipt belongs to; NULL for every 0024 caller, which keep
-- passing 18 positional arguments and reach this function through the default).
CREATE OR REPLACE FUNCTION public.stock__receive_line(
  p_clinic uuid, p_actor uuid, p_op uuid, p_today date, p_can_cost boolean,
  p_item_id uuid, p_to uuid, p_quantity numeric, p_quantity_unit text, p_units_per_purchase numeric,
  p_lot text, p_serial text, p_expiry text, p_cost bigint, p_cost_unit text,
  p_supplier uuid, p_document_no text, p_reason text, p_po_item uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item public.stock_items%ROWTYPE;
  v_qty numeric;
  v_lot text;
  v_serial text;
  v_exp date;
  v_cost bigint;
  v_doc text;
  v_reason text;
  v_batch uuid;
  v_mid uuid;
BEGIN
  v_item := public.stock__item_for_move(p_clinic, p_item_id);
  PERFORM public.stock__location_active(p_clinic, p_to);

  -- Quantity and unit (MP:21-23, SW:1-5; stale factor D4). The factor the client saw is checked whenever it was used,
  -- for the quantity or for a cost entered per purchase unit (the batch cost and the lot merge depend on it).
  IF (coalesce(p_quantity_unit, 'usage') = 'purchase'
      OR (p_cost IS NOT NULL AND coalesce(p_cost_unit, 'usage') = 'purchase'))
     AND p_units_per_purchase IS NOT NULL
     AND p_units_per_purchase <> v_item.units_per_purchase THEN
    PERFORM public.stock__raise('E_UNIT_CHANGED');
  END IF;
  v_qty := public.stock__to_usage(public.stock__qty(p_quantity, false), p_quantity_unit, v_item.units_per_purchase);
  IF v_item.tracking_level = 'A' AND v_qty <> trunc(v_qty) THEN
    PERFORM public.stock__raise('E_QTY_INTEGER');
  END IF;

  -- Lot / serial / expiry (MP:53-60, C23).
  v_lot := public.stock__lot(p_lot, v_item.tracking_level);
  v_serial := public.stock__serial(p_serial);
  IF v_serial IS NOT NULL AND v_qty <> 1 THEN
    PERFORM public.stock__raise('E_SERIAL_QTY');
  END IF;
  v_exp := public.stock__expiry(p_expiry);
  IF v_item.tracking_level = 'B' AND v_exp IS NULL THEN
    PERFORM public.stock__raise('E_EXPIRY_REQUIRED');
  END IF;
  IF v_exp < p_today THEN
    PERFORM public.stock__raise('E_EXPIRED_RECEIVE');
  END IF;

  -- Cost (MP:61-63; a non-viewer who sends a cost is refused, §0.3-4).
  IF p_cost IS NOT NULL THEN
    IF NOT coalesce(p_can_cost, false) THEN
      PERFORM public.stock__raise('E_COST_FORBIDDEN');
    END IF;
    IF p_cost < 0 OR p_cost > 100000000000 OR coalesce(p_cost_unit, 'usage') NOT IN ('usage', 'purchase') THEN
      PERFORM public.stock__raise('E_COST');
    END IF;
    IF coalesce(p_cost_unit, 'usage') = 'purchase' THEN
      v_cost := round(p_cost / v_item.units_per_purchase)::bigint;
    ELSE
      v_cost := p_cost;
    END IF;
  ELSE
    SELECT c.last_unit_cost_cents INTO v_cost FROM public.stock_item_costs c WHERE c.stock_item_id = v_item.id;
  END IF;

  IF p_supplier IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers s WHERE s.id = p_supplier AND s.clinic_id = p_clinic AND s.is_active
  ) THEN
    PERFORM public.stock__raise('E_SUPPLIER');
  END IF;
  v_doc := btrim(coalesce(p_document_no, ''));
  IF char_length(v_doc) > 60 THEN
    PERFORM public.stock__raise('E_DOCUMENT_NO');
  END IF;
  v_reason := public.stock__reason(p_reason, false);
  IF v_reason = '' THEN
    v_reason := 'Mal kabul';
  END IF;

  -- A serial exists once per card (MV:23-24, BU:19). The card lock serialises receipts of the same card.
  IF v_serial IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.stock_batches b
    WHERE b.clinic_id = p_clinic AND b.stock_item_id = v_item.id AND b.serial_number = v_serial
  ) THEN
    PERFORM public.stock__raise('E_SERIAL_TAKEN');
  END IF;

  -- Batch merge (C23, MP:64-70): same lot, no serial, same expiry and same cost -> the oldest such batch.
  IF v_serial IS NULL THEN
    SELECT b.id INTO v_batch
    FROM public.stock_batches b
    LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = b.id
    WHERE b.clinic_id = p_clinic
      AND b.stock_item_id = v_item.id
      AND b.lot_number = v_lot
      AND b.serial_number IS NULL
      AND b.expiry_date IS NOT DISTINCT FROM v_exp
      AND bc.unit_cost_cents IS NOT DISTINCT FROM v_cost
    ORDER BY b.received_at, b.id
    LIMIT 1;
  END IF;
  IF v_batch IS NULL THEN
    INSERT INTO public.stock_batches (clinic_id, stock_item_id, lot_number, serial_number, expiry_date, received_at, created_by)
    VALUES (p_clinic, v_item.id, v_lot, v_serial, v_exp, now(), p_actor)
    RETURNING id INTO v_batch;
    IF v_cost IS NOT NULL THEN
      INSERT INTO public.stock_batch_costs (batch_id, clinic_id, unit_cost_cents) VALUES (v_batch, p_clinic, v_cost);
    END IF;
  END IF;

  PERFORM public.stock__apply(p_clinic, v_item.id, v_batch, p_to, v_qty);
  v_mid := public.stock__ledger(p_clinic, p_op, NULL, v_item.id, v_batch, 'receive', v_qty, NULL, p_to,
    jsonb_build_object('supplier_id', p_supplier, 'document_no', v_doc, 'reason', v_reason, 'actor_user_id', p_actor,
                       'po_item_id', p_po_item));

  -- An explicit cost becomes the card's last cost (MP:76). The card's supplier is not changed.
  IF p_cost IS NOT NULL THEN
    INSERT INTO public.stock_item_costs (stock_item_id, clinic_id, last_unit_cost_cents, updated_by, updated_at)
    VALUES (v_item.id, p_clinic, v_cost, p_actor, now())
    ON CONFLICT (stock_item_id) DO UPDATE
      SET last_unit_cost_cents = EXCLUDED.last_unit_cost_cents, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  RETURN v_mid;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Guard triggers (defence in depth; SECURITY DEFINER SET search_path = public, never granted). The RPCs enforce
--    every rule first; these refuse anything else that reaches the tables.
-- ---------------------------------------------------------------------------

-- purchase_orders BEFORE UPDATE OR DELETE (§2.8, §8.1).
CREATE OR REPLACE FUNCTION public.stock__trg_po_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL <> 'ROW' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.stock__is_editor() THEN
      RETURN OLD;
    END IF;
    PERFORM public.stock__raise('E_HISTORY');
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.order_year IS DISTINCT FROM OLD.order_year OR NEW.order_seq IS DISTINCT FROM OLD.order_seq
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('pending', 'approved'), ('pending', 'cancelled'), ('approved', 'ordered'), ('approved', 'cancelled'),
       ('ordered', 'partially_received'), ('ordered', 'received'), ('ordered', 'cancelled'),
       ('partially_received', 'received')) THEN
    PERFORM public.stock__raise('E_PO_STATE');
  END IF;

  -- Content (supplier, date, note) changes only while pending.
  IF OLD.status <> 'pending' AND (NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
                                  OR NEW.expected_date IS DISTINCT FROM OLD.expected_date
                                  OR NEW.note IS DISTINCT FROM OLD.note
                                  OR NEW.content_edited_by IS DISTINCT FROM OLD.content_edited_by
                                  OR NEW.content_editors IS DISTINCT FROM OLD.content_editors) THEN
    PERFORM public.stock__raise('E_PO_EDIT_STATE');
  END IF;

  -- Terminal rows: only the payable hook columns and the bookkeeping columns move (the hook runs after 'received').
  IF OLD.status IN ('received', 'cancelled')
     AND (to_jsonb(NEW) - ARRAY['order_number', 'payable_state', 'fin_entry_id', 'version', 'updated_by', 'updated_at'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['order_number', 'payable_state', 'fin_entry_id', 'version', 'updated_by', 'updated_at']) THEN
    PERFORM public.stock__raise('E_PO_STATE');
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- purchase_order_items BEFORE UPDATE OR DELETE (§2.8).
CREATE OR REPLACE FUNCTION public.stock__trg_po_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_LEVEL <> 'ROW' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF TG_OP = 'DELETE' AND public.stock__is_editor() THEN
    RETURN OLD;
  END IF;

  SELECT o.status INTO v_status FROM public.purchase_orders o WHERE o.id = OLD.order_id;

  IF TG_OP = 'DELETE' THEN
    IF v_status = 'pending' AND OLD.qty_received = 0 THEN
      RETURN OLD;
    END IF;
    PERFORM public.stock__raise('E_HISTORY');
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF v_status IS DISTINCT FROM 'pending'
     AND (NEW.qty_ordered IS DISTINCT FROM OLD.qty_ordered
          OR NEW.units_per_purchase IS DISTINCT FROM OLD.units_per_purchase
          OR NEW.line_no IS DISTINCT FROM OLD.line_no
          OR NEW.note IS DISTINCT FROM OLD.note) THEN
    PERFORM public.stock__raise('E_PO_EDIT_STATE');
  END IF;
  IF NEW.qty_received < OLD.qty_received THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF NEW.qty_received > OLD.qty_received AND v_status NOT IN ('ordered', 'partially_received') THEN
    PERFORM public.stock__raise('E_PO_RECEIVE_STATE');
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- stock_room_requests BEFORE UPDATE OR DELETE (§2.8, §8.2).
CREATE OR REPLACE FUNCTION public.stock__trg_rq_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL <> 'ROW' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.stock__is_editor() THEN
      RETURN OLD;
    END IF;
    PERFORM public.stock__raise('E_HISTORY');
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.ref_no IS DISTINCT FROM OLD.ref_no
     OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.note IS DISTINCT FROM OLD.note THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF OLD.status IN ('delivered', 'rejected', 'cancelled') THEN
    PERFORM public.stock__raise('E_RQ_STATE');
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('pending', 'approved'), ('pending', 'delivered'), ('pending', 'rejected'), ('pending', 'cancelled'),
       ('approved', 'delivered'), ('approved', 'rejected'), ('approved', 'cancelled')) THEN
    PERFORM public.stock__raise('E_RQ_STATE');
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 4.1 Open references (spec §3.6; P7R §3.5 / PD:71-75 hook). The SQL editor / service role passes. The errors reach the
--     existing save RPCs (stock_save_item / stock_save_supplier / stock_save_location) unchanged.
CREATE OR REPLACE FUNCTION public.stock__trg_item_open_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.stock__is_editor() THEN
    RETURN NEW;
  END IF;
  IF (OLD.is_active AND NOT NEW.is_active) OR (NOT OLD.needs_review AND NEW.needs_review) THEN
    IF EXISTS (
      SELECT 1 FROM public.purchase_order_items li
      JOIN public.purchase_orders o ON o.id = li.order_id
      WHERE li.stock_item_id = NEW.id AND li.clinic_id = NEW.clinic_id
        AND o.status IN ('pending', 'approved', 'ordered', 'partially_received')
    ) THEN
      PERFORM public.stock__raise('E_ITEM_OPEN_ORDERS');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.stock_room_requests r
      WHERE r.stock_item_id = NEW.id AND r.clinic_id = NEW.clinic_id AND r.status IN ('pending', 'approved')
    ) THEN
      PERFORM public.stock__raise('E_ITEM_OPEN_REQUESTS');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__trg_supplier_open_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.stock__is_editor() THEN
    RETURN NEW;
  END IF;
  IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
    SELECT 1 FROM public.purchase_orders o
    WHERE o.supplier_id = NEW.id AND o.clinic_id = NEW.clinic_id
      AND o.status IN ('pending', 'approved', 'ordered', 'partially_received')
  ) THEN
    PERFORM public.stock__raise('E_SUPPLIER_OPEN_ORDERS');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__trg_location_open_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.stock__is_editor() THEN
    RETURN NEW;
  END IF;
  IF ((OLD.is_active AND NOT NEW.is_active) OR (OLD.kind <> 'warehouse' AND NEW.kind = 'warehouse'))
     AND EXISTS (
       SELECT 1 FROM public.stock_room_requests r
       WHERE r.location_id = NEW.id AND r.clinic_id = NEW.clinic_id AND r.status IN ('pending', 'approved')
     ) THEN
    PERFORM public.stock__raise('E_LOCATION_OPEN_REQUESTS');
  END IF;
  RETURN NEW;
END;
$$;

-- stock_correction_requests BEFORE INSERT: a PO receipt can never be corrected (0024 stock__resolve_core raises
-- E_CORR_ORDER at approval), so the request itself is refused instead of waiting for a manager who can only reject
-- it. The SQL editor / service role passes (the self-check inserts one to prove the approval refusal).
CREATE OR REPLACE FUNCTION public.stock__trg_corr_po_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.stock__is_editor() AND EXISTS (
    SELECT 1 FROM public.stock_movements m
    WHERE m.id = NEW.movement_id AND m.clinic_id = NEW.clinic_id AND m.po_item_id IS NOT NULL
  ) THEN
    PERFORM public.stock__raise('E_CORR_ORDER');
  END IF;
  RETURN NEW;
END;
$$;

-- 0024 §5.4 history rows, same signature, body verbatim except one edit: can_request_correction is false for a PO
-- receipt (po_item_id set), so the movement / quick-sheet screens no longer offer a request that cannot succeed.
CREATE OR REPLACE FUNCTION public.stock__history_rows(p_clinic uuid, p_actor uuid, p_can_manage boolean,
                                                      p_can_operate boolean)
RETURNS TABLE (id uuid, j jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT m.id,
         pg_catalog.jsonb_build_object(
           'id', m.id, 'ref_no', m.ref_no, 'movement_type', m.movement_type, 'operation_key', m.operation_key,
           'created_at', m.created_at, 'effective_at', m.effective_at,
           'stock_item_id', m.stock_item_id, 'item_name', i.item_name, 'usage_unit', i.usage_unit,
           'tracking_level', i.tracking_level, 'quantity', public.stock__q(m.quantity),
           'batch_id', m.batch_id, 'lot_number', b.lot_number, 'serial_number', b.serial_number,
           'expiry_date', b.expiry_date,
           'from_location_id', m.from_location_id, 'from_location_name', lf.name,
           'to_location_id', m.to_location_id, 'to_location_name', lt.name)
         || pg_catalog.jsonb_build_object(
           'patient_id', m.patient_id, 'patient_name', p.full_name, 'appointment_id', m.appointment_id,
           'doctor_id', m.doctor_id, 'doctor_name', du.full_name, 'supplier_id', m.supplier_id,
           'supplier_name', s.name, 'document_no', m.document_no, 'reason', m.reason,
           'actor_user_id', m.actor_user_id, 'actor_name', au.full_name,
           'source_movement_id', m.source_movement_id, 'source_ref_no', sm.ref_no,
           'correction_request_id', m.correction_request_id)
         || pg_catalog.jsonb_build_object(
           'correction_status', cs.status,
           'corrected', cs.approved,
           'is_reentry', (m.correction_request_id IS NOT NULL AND m.movement_type <> 'correction_reversal'),
           'can_request_correction',
             (p_can_operate AND m.movement_type IN ('opening', 'receive', 'issue', 'transfer', 'waste')
              AND NOT cs.is_open AND (coalesce(m.actor_user_id = p_actor, false) OR p_can_manage)
              AND m.po_item_id IS NULL),
           'can_return', (p_can_manage AND m.movement_type = 'issue' AND NOT cs.approved AND rt.remaining > 0),
           'returnable_qty', CASE WHEN p_can_manage AND m.movement_type = 'issue' AND NOT cs.approved
                                  THEN public.stock__q(greatest(rt.remaining, 0))
                                  ELSE pg_catalog.to_jsonb(0) END)
  FROM public.stock_movements m
  JOIN public.stock_items i ON i.id = m.stock_item_id
  JOIN public.stock_batches b ON b.id = m.batch_id
  LEFT JOIN public.stock_locations lf ON lf.id = m.from_location_id
  LEFT JOIN public.stock_locations lt ON lt.id = m.to_location_id
  LEFT JOIN public.patients p ON p.id = m.patient_id
  LEFT JOIN public.doctors d ON d.id = m.doctor_id
  LEFT JOIN public.users du ON du.id = d.user_id
  LEFT JOIN public.suppliers s ON s.id = m.supplier_id
  LEFT JOIN public.users au ON au.id = m.actor_user_id
  LEFT JOIN public.stock_movements sm ON sm.id = m.source_movement_id
  CROSS JOIN LATERAL (
    SELECT coalesce(bool_or(cr.status = 'approved'), false) AS approved,
           coalesce(bool_or(cr.status IN ('pending', 'approved')), false) AS is_open,
           CASE WHEN bool_or(cr.status = 'approved') THEN 'approved'
                WHEN bool_or(cr.status = 'pending') THEN 'pending'
                WHEN bool_or(cr.status = 'rejected') THEN 'rejected' END AS status
    FROM public.stock_correction_requests cr
    WHERE cr.movement_id = m.id
  ) cs
  CROSS JOIN LATERAL (
    SELECT m.quantity - coalesce(sum(r.quantity), 0) AS remaining
    FROM public.stock_movements r
    WHERE r.source_movement_id = m.id AND r.movement_type = 'return'
  ) rt
  WHERE m.clinic_id = p_clinic
$$;

-- Wiring (idempotent).
DROP TRIGGER IF EXISTS stock_po_guard ON public.purchase_orders;
CREATE TRIGGER stock_po_guard
  BEFORE UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_po_guard();

DROP TRIGGER IF EXISTS stock_po_item_guard ON public.purchase_order_items;
CREATE TRIGGER stock_po_item_guard
  BEFORE UPDATE OR DELETE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_po_item_guard();

DROP TRIGGER IF EXISTS stock_rq_guard ON public.stock_room_requests;
CREATE TRIGGER stock_rq_guard
  BEFORE UPDATE OR DELETE ON public.stock_room_requests
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_rq_guard();

-- The open-reference triggers on stock_items / suppliers / stock_locations are wired in section 12a.

-- TRUNCATE skips row triggers and foreign-key checks: refused for everyone (0024 pattern).
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['purchase_orders', 'purchase_order_items', 'purchase_order_item_costs',
                             'stock_room_requests', 'stock_po_counters', 'stock_settings']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stock_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER stock_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.stock__trg_movements_immutable()', v_t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Row level security and table privileges (§11.1). Exactly one SELECT policy per client-readable table, helpers
--    wrapped as (SELECT ...); no INSERT / UPDATE / DELETE policy or privilege anywhere.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v record;
  q record;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('stock_settings', 'stock_settings_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('purchase_orders', 'purchase_orders_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND ((SELECT public.stock_can_manage()) OR (SELECT public.stock_can_view_costs()))'),
      ('purchase_order_items', 'purchase_order_items_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND ((SELECT public.stock_can_manage()) OR (SELECT public.stock_can_view_costs()))'),
      ('purchase_order_item_costs', 'purchase_order_item_costs_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.stock_can_view_costs())'),
      ('stock_room_requests', 'stock_room_requests_select', 'clinic_id = (SELECT public.current_clinic_id())')
    ) AS t(tbl, pol, expr)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v.tbl);
    FOR q IN SELECT p.policyname FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v.tbl LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', q.policyname, v.tbl);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', v.pol, v.tbl, v.expr);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v.tbl);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v.tbl);
  END LOOP;
END $$;

-- stock_po_counters: RLS on, no policy, no privileges (only the SECURITY DEFINER functions touch it).
ALTER TABLE public.stock_po_counters ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE
  q record;
BEGIN
  FOR q IN SELECT p.policyname FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'stock_po_counters' LOOP
    EXECUTE format('DROP POLICY %I ON public.stock_po_counters', q.policyname);
  END LOOP;
END $$;
REVOKE ALL ON public.stock_po_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5.1 Audit (spec §3.7): audit_row_change() (0019) on the new client-readable tables; stock_po_counters is not audited. The
--     RESTRICTIVE cost gate on audit_logs now also hides purchase_order_item_costs rows from non cost viewers.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['stock_settings', 'purchase_orders', 'purchase_order_items', 'purchase_order_item_costs',
                             'stock_room_requests']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()', v_t);
  END LOOP;
END $$;

-- The audit_logs cost guard is replaced in section 12a (ACCESS EXCLUSIVE on audit_logs only for the last seconds).

-- ---------------------------------------------------------------------------
-- 6. Internals (§4). Never granted; SECURITY INVOKER (fail closed); called only from the SECURITY DEFINER RPCs below
--    and from this migration's self-check, so every query filters by p_clinic. Time-dependent ones take p_today.
-- ---------------------------------------------------------------------------

-- 6.1 Settings row of a clinic, or the defaults (version 0) when the clinic never saved one.
CREATE OR REPLACE FUNCTION public.stock__settings(p_clinic uuid)
RETURNS public.stock_settings
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v public.stock_settings%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.stock_settings s WHERE s.clinic_id = p_clinic;
  IF NOT FOUND THEN
    v.clinic_id := p_clinic;
    v.id := p_clinic;
    v.po_creator_cannot_approve := false;
    v.po_payable_enabled := false;
    v.po_payable_due_days := 30;
    v.po_payable_category_id := NULL;
    v.version := 0;
    v.updated_by := NULL;
    v.updated_at := NULL;
  END IF;
  RETURN v;
END;
$$;

-- Next order number of a clinic and year. The counter row lock serialises concurrent creates; a rolled-back create
-- rolls the counter back, so committed numbers have no gaps. Self-healing: never below the highest existing
-- order_seq of that clinic and year (an import through legacy_id or a manual insert cannot block creates).
CREATE OR REPLACE FUNCTION public.stock__po_next_number(p_clinic uuid, p_year smallint)
RETURNS integer
LANGUAGE sql
AS $$
  INSERT INTO public.stock_po_counters AS c (clinic_id, order_year, last_no)
  VALUES (p_clinic, p_year, (SELECT coalesce(max(o.order_seq), 0) + 1 FROM public.purchase_orders o
                             WHERE o.clinic_id = p_clinic AND o.order_year = p_year))
  ON CONFLICT (clinic_id, order_year) DO UPDATE SET last_no = greatest(c.last_no, EXCLUDED.last_no - 1) + 1
  RETURNING c.last_no
$$;

-- Open order quantity per card (D:154): ordered - received over orders that are still open. A cancelled or received
-- (also short-closed) order counts 0.
CREATE OR REPLACE FUNCTION public.stock__po_open_qty(p_clinic uuid)
RETURNS TABLE (stock_item_id uuid, open_qty numeric, open_orders integer)
LANGUAGE sql
STABLE
AS $$
  SELECT li.stock_item_id,
         sum(li.qty_ordered - li.qty_received)::numeric,
         (count(DISTINCT li.order_id))::integer
  FROM public.purchase_order_items li
  JOIN public.purchase_orders o ON o.id = li.order_id
  WHERE li.clinic_id = p_clinic AND o.clinic_id = p_clinic
    AND o.status IN ('pending', 'approved', 'ordered', 'partially_received')
  GROUP BY li.stock_item_id
$$;

CREATE OR REPLACE FUNCTION public.stock__po_lock(p_clinic uuid, p_order uuid)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v public.purchase_orders%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.purchase_orders o
  WHERE o.id = p_order AND o.clinic_id = p_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_PO_NOT_FOUND');
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__rq_lock(p_clinic uuid, p_request uuid)
RETURNS public.stock_room_requests
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v public.stock_room_requests%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.stock_room_requests r
  WHERE r.id = p_request AND r.clinic_id = p_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_RQ_NOT_FOUND');
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__po_reason(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
BEGIN
  IF char_length(v) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.stock__raise('E_PO_REASON');
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__rq_reason(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
BEGIN
  IF char_length(v) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.stock__raise('E_RQ_REASON');
  END IF;
  RETURN v;
END;
$$;

-- Expected delivery day: blank -> NULL; otherwise the stock__day rules with E_PO_DATE; also E_PO_DATE before p_min
-- (NULL p_min = no lower bound; the save core applies "not in the past" itself).
CREATE OR REPLACE FUNCTION public.stock__po_day(p text, p_min date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
  d date;
BEGIN
  IF v = '' THEN
    RETURN NULL;
  END IF;
  IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    PERFORM public.stock__raise('E_PO_DATE');
  END IF;
  BEGIN
    d := to_date(v, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.stock__raise('E_PO_DATE');
  END;
  IF to_char(d, 'YYYY-MM-DD') <> v OR d < DATE '2000-01-01' OR d > DATE '2200-12-31' THEN
    PERFORM public.stock__raise('E_PO_DATE');
  END IF;
  IF p_min IS NOT NULL AND d < p_min THEN
    PERFORM public.stock__raise('E_PO_DATE');
  END IF;
  RETURN d;
END;
$$;

-- 6.2 The "creator cannot approve" predicate (§4.3, §8.1): with the rule ON the approver must differ from the creator
-- and from everyone who changed the supplier or the lines (purchase_orders.content_editors), so nobody approves
-- content they wrote, even after someone else touched the order last. One predicate for list, detail and approve.
DROP FUNCTION IF EXISTS public.stock__po_self_blocked(boolean, uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.stock__po_self_blocked(p_rule boolean, p_actor uuid, p_created_by uuid,
                                                         p_editors uuid[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_rule, false)
     AND coalesce(p_actor = p_created_by OR p_actor = ANY (coalesce(p_editors, '{}'::uuid[])), false)
$$;

-- Per-row action flags (§4.3), computed in SQL so the UI never re-derives the rules.
CREATE OR REPLACE FUNCTION public.stock__po_actions(p_status text, p_manage boolean, p_self_blocked boolean)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'can_edit', coalesce(p_manage, false) AND p_status = 'pending',
    'can_approve', coalesce(p_manage, false) AND p_status = 'pending' AND NOT coalesce(p_self_blocked, false),
    'approve_blocked', CASE WHEN coalesce(p_manage, false) AND p_status = 'pending' AND coalesce(p_self_blocked, false)
                            THEN 'self' END,
    'can_mark_ordered', coalesce(p_manage, false) AND p_status = 'approved',
    'can_cancel', coalesce(p_manage, false) AND p_status IN ('pending', 'approved', 'ordered'),
    'can_close', coalesce(p_manage, false) AND p_status = 'partially_received',
    'can_receive', coalesce(p_manage, false) AND p_status IN ('ordered', 'partially_received'))
$$;

-- Remaining quantity of a line: ordered - received while the order is open, else 0 (never stored).
CREATE OR REPLACE FUNCTION public.stock__po_remaining(p_status text, p_ordered numeric, p_received numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_status IN ('pending', 'approved', 'ordered', 'partially_received')
              THEN greatest(p_ordered - p_received, 0) ELSE 0 END
$$;

-- "9 kutu" when the quantity is a whole number of purchase packs and the factor is not 1, else "905 adet"
-- (decimal comma, trailing zeros trimmed). Used in the list summary.
CREATE OR REPLACE FUNCTION public.stock__po_qty_label(p_qty numeric, p_factor numeric, p_usage_unit text,
                                                      p_purchase_unit text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_factor > 0 AND p_factor <> 1 AND p_qty % p_factor = 0
              THEN replace(pg_catalog.trim_scale(p_qty / p_factor)::text, '.', ',') || ' ' || p_purchase_unit
              ELSE replace(pg_catalog.trim_scale(p_qty)::text, '.', ',') || ' ' || p_usage_unit END
$$;

-- 6.3 Cost-free write result of every PO write (stored for replays, so never a cost key).
CREATE OR REPLACE FUNCTION public.stock__po_write_json(p_clinic uuid, p_order uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', o.id, 'order_number', o.order_number, 'status', o.status, 'version', o.version,
           'payable_state', o.payable_state,
           'lines', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'id', li.id, 'line_no', li.line_no, 'stock_item_id', li.stock_item_id,
                      'qty_ordered', public.stock__q(li.qty_ordered), 'qty_received', public.stock__q(li.qty_received),
                      'qty_remaining', public.stock__q(public.stock__po_remaining(o.status, li.qty_ordered,
                                                                                  li.qty_received)))
                      ORDER BY li.line_no, li.id)
             FROM public.purchase_order_items li
             WHERE li.order_id = o.id AND li.clinic_id = p_clinic), '[]'::jsonb))
  FROM public.purchase_orders o
  WHERE o.id = p_order AND o.clinic_id = p_clinic
$$;

-- 6.4 List row (§6.1). Cost keys total_cents / unpriced_lines only when p_can_cost (absent otherwise, never 0); the
-- cost table is not even joined for non viewers.
CREATE OR REPLACE FUNCTION public.stock__po_row_json(p_clinic uuid, p_order uuid, p_actor uuid, p_can_cost boolean,
                                                     p_can_manage boolean, p_today date, p_rule boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', o.id, 'order_number', o.order_number, 'status', o.status, 'version', o.version,
           'supplier_id', o.supplier_id, 'supplier_name', s.name, 'expected_date', o.expected_date,
           'overdue', coalesce(o.expected_date < p_today, false)
                      AND o.status IN ('approved', 'ordered', 'partially_received'),
           'created_at', o.created_at, 'created_by', o.created_by, 'created_by_name', cu.full_name,
           'approved_by_name', au.full_name, 'approved_at', o.approved_at, 'ordered_at', o.ordered_at,
           'received_at', o.received_at, 'closed_short', o.closed_short, 'cancelled_at', o.cancelled_at)
         || pg_catalog.jsonb_build_object(
           'line_count', ls.line_count, 'lines_complete', ls.lines_complete,
           'summary', coalesce(sm.summary, '')
                      || CASE WHEN ls.line_count > 3 THEN ' • +' || (ls.line_count - 3)::text ELSE '' END,
           'payable_state', o.payable_state,
           'actions', public.stock__po_actions(o.status, p_can_manage,
                        public.stock__po_self_blocked(p_rule, p_actor, o.created_by, o.content_editors)))
         || CASE WHEN p_can_cost
                 THEN pg_catalog.jsonb_build_object('total_cents', ls.total_cents, 'unpriced_lines', ls.unpriced)
                 ELSE '{}'::jsonb END
  FROM public.purchase_orders o
  JOIN public.suppliers s ON s.id = o.supplier_id
  LEFT JOIN public.users cu ON cu.id = o.created_by
  LEFT JOIN public.users au ON au.id = o.approved_by
  CROSS JOIN LATERAL (
    SELECT (count(*))::integer AS line_count,
           (count(*) FILTER (WHERE li.qty_received >= li.qty_ordered))::integer AS lines_complete,
           (coalesce(sum(round(li.qty_ordered * c.unit_price_cents)) FILTER (WHERE c.po_item_id IS NOT NULL), 0))::bigint
             AS total_cents,
           (count(*) FILTER (WHERE c.po_item_id IS NULL))::integer AS unpriced
    FROM public.purchase_order_items li
    LEFT JOIN public.purchase_order_item_costs c ON c.po_item_id = li.id AND p_can_cost
    WHERE li.order_id = o.id AND li.clinic_id = p_clinic
  ) ls
  CROSS JOIN LATERAL (
    SELECT string_agg(x.lbl, ' • ' ORDER BY x.line_no) AS summary
    FROM (
      SELECT li.line_no,
             i.item_name || ' × ' || public.stock__po_qty_label(li.qty_ordered, li.units_per_purchase, i.usage_unit,
                                                                 i.purchase_unit) AS lbl
      FROM public.purchase_order_items li
      JOIN public.stock_items i ON i.id = li.stock_item_id
      WHERE li.order_id = o.id AND li.clinic_id = p_clinic
      ORDER BY li.line_no, li.id
      LIMIT 3
    ) x
  ) sm
  WHERE o.id = p_order AND o.clinic_id = p_clinic
$$;

-- 6.5 Detail object (§6.2): {order, settings, today}. Cost keys only when p_can_cost; fin_entry_id only for
-- 'finance' / 'finance_readonly' holders. received_value_cents = round(sum(receipt qty x batch cost)), NULL when a
-- receipt batch has no cost.
CREATE OR REPLACE FUNCTION public.stock__po_json(p_clinic uuid, p_order uuid, p_actor uuid, p_can_cost boolean,
                                                 p_can_manage boolean, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_s public.stock_settings%ROWTYPE := public.stock__settings(p_clinic);
  v_fin boolean := public.has_permission('finance') OR public.has_permission('finance_readonly');
  v_o public.purchase_orders%ROWTYPE;
  v_lines jsonb;
  v_total bigint;
  v_unpriced integer;
  v_received bigint;
  v_uncosted boolean;
  v_order jsonb;
BEGIN
  SELECT * INTO v_o FROM public.purchase_orders o WHERE o.id = p_order AND o.clinic_id = p_clinic;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.line_no, x.id), '[]'::jsonb)
    INTO v_lines
  FROM (
    SELECT li.line_no, li.id,
           jsonb_build_object(
             'id', li.id, 'line_no', li.line_no, 'stock_item_id', li.stock_item_id, 'item_code', i.item_code,
             'item_name', i.item_name, 'brand', i.brand, 'tracking_level', i.tracking_level,
             'usage_unit', i.usage_unit, 'purchase_unit', i.purchase_unit,
             'units_per_purchase', public.stock__q(li.units_per_purchase),
             'card_units_per_purchase', public.stock__q(i.units_per_purchase),
             'card_ready', (i.is_active AND NOT i.needs_review),
             'preferred_location_id', i.preferred_location_id,
             'qty_ordered', public.stock__q(li.qty_ordered), 'qty_received', public.stock__q(li.qty_received),
             'qty_remaining', public.stock__q(public.stock__po_remaining(v_o.status, li.qty_ordered, li.qty_received)),
             'note', li.note, 'receipts', rc.receipts)
           || CASE WHEN p_can_cost THEN jsonb_build_object(
                'unit_price_cents', c.unit_price_cents,
                'line_total_cents', CASE WHEN c.po_item_id IS NOT NULL
                                         THEN round(li.qty_ordered * c.unit_price_cents)::bigint END,
                'received_value_cents', rc.value_cents)
              ELSE '{}'::jsonb END AS j
    FROM public.purchase_order_items li
    JOIN public.stock_items i ON i.id = li.stock_item_id
    LEFT JOIN public.purchase_order_item_costs c ON c.po_item_id = li.id AND p_can_cost
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(
               jsonb_build_object(
                 'movement_id', m.id, 'ref_no', m.ref_no, 'operation_key', m.operation_key,
                 'quantity', public.stock__q(m.quantity), 'batch_id', m.batch_id, 'lot_number', b.lot_number,
                 'serial_number', b.serial_number, 'expiry_date', b.expiry_date,
                 'to_location_id', m.to_location_id, 'to_location_name', l.name,
                 'effective_at', m.effective_at, 'created_at', m.created_at, 'actor_name', u.full_name,
                 'document_no', m.document_no)
               || CASE WHEN p_can_cost THEN jsonb_build_object('unit_cost_cents', bc.unit_cost_cents)
                       ELSE '{}'::jsonb END
               ORDER BY m.ref_no), '[]'::jsonb) AS receipts,
             CASE WHEN bool_or(bc.batch_id IS NULL) THEN NULL
                  ELSE (coalesce(round(sum(m.quantity * bc.unit_cost_cents)), 0))::bigint END AS value_cents
      FROM public.stock_movements m
      JOIN public.stock_batches b ON b.id = m.batch_id
      LEFT JOIN public.stock_locations l ON l.id = m.to_location_id
      LEFT JOIN public.users u ON u.id = m.actor_user_id
      LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id AND p_can_cost
      WHERE m.po_item_id = li.id AND m.clinic_id = p_clinic AND m.movement_type = 'receive'
    ) rc
    WHERE li.order_id = v_o.id AND li.clinic_id = p_clinic
  ) x;

  v_order := jsonb_build_object(
      'id', v_o.id, 'order_number', v_o.order_number, 'status', v_o.status, 'version', v_o.version,
      'supplier_id', v_o.supplier_id,
      'supplier', (SELECT jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'email', s.email,
                                             'is_active', s.is_active)
                   FROM public.suppliers s WHERE s.id = v_o.supplier_id),
      'expected_date', v_o.expected_date,
      'overdue', coalesce(v_o.expected_date < p_today, false)
                 AND v_o.status IN ('approved', 'ordered', 'partially_received'),
      'note', v_o.note, 'created_at', v_o.created_at, 'created_by', v_o.created_by,
      'created_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_o.created_by),
      'content_edited_by', v_o.content_edited_by,
      'content_edited_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_o.content_edited_by),
      'approved_at', v_o.approved_at,
      'approved_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_o.approved_by),
      'ordered_at', v_o.ordered_at,
      'ordered_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_o.ordered_by))
    || jsonb_build_object(
      'received_at', v_o.received_at, 'closed_short', v_o.closed_short, 'close_reason', v_o.close_reason,
      'closed_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_o.closed_by),
      'cancelled_at', v_o.cancelled_at, 'cancel_reason', v_o.cancel_reason,
      'cancelled_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_o.cancelled_by),
      'payable_state', v_o.payable_state, 'updated_at', v_o.updated_at,
      'actions', public.stock__po_actions(v_o.status, p_can_manage,
                   public.stock__po_self_blocked(v_s.po_creator_cannot_approve, p_actor, v_o.created_by,
                                                 v_o.content_editors)),
      'line_count', jsonb_array_length(v_lines),
      'lines', v_lines);

  IF p_can_cost THEN
    SELECT (coalesce(sum(round(li.qty_ordered * c.unit_price_cents)) FILTER (WHERE c.po_item_id IS NOT NULL), 0))::bigint,
           (count(*) FILTER (WHERE c.po_item_id IS NULL))::integer
      INTO v_total, v_unpriced
    FROM public.purchase_order_items li
    LEFT JOIN public.purchase_order_item_costs c ON c.po_item_id = li.id
    WHERE li.order_id = v_o.id AND li.clinic_id = p_clinic;

    SELECT coalesce(bool_or(bc.batch_id IS NULL), false), (round(coalesce(sum(m.quantity * bc.unit_cost_cents), 0)))::bigint
      INTO v_uncosted, v_received
    FROM public.stock_movements m
    JOIN public.purchase_order_items li ON li.id = m.po_item_id
    LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id
    WHERE li.order_id = v_o.id AND m.clinic_id = p_clinic AND m.movement_type = 'receive';

    v_order := v_order || jsonb_build_object(
      'total_cents', v_total, 'unpriced_lines', v_unpriced,
      'received_value_cents', CASE WHEN v_uncosted THEN NULL ELSE v_received END);
  END IF;
  IF v_fin THEN
    v_order := v_order || jsonb_build_object('fin_entry_id', v_o.fin_entry_id);
  END IF;

  RETURN jsonb_build_object(
    'order', v_order,
    'settings', jsonb_build_object('po_creator_cannot_approve', v_s.po_creator_cannot_approve,
                                   'po_payable_enabled', v_s.po_payable_enabled),
    'today', p_today);
END;
$$;

-- 6.6 Room request object (§6.4). warehouse_usable_qty (usable = unexpired quantity in the current default warehouse)
-- only for managers; actions follow §5.5 (cancel only for the requester).
CREATE OR REPLACE FUNCTION public.stock__rq_json(p_clinic uuid, p_request uuid, p_actor uuid, p_can_manage boolean,
                                                 p_can_operate boolean, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', r.id, 'ref_no', r.ref_no, 'status', r.status, 'version', r.version,
           'stock_item_id', r.stock_item_id, 'item_code', i.item_code, 'item_name', i.item_name,
           'tracking_level', i.tracking_level, 'usage_unit', i.usage_unit, 'purchase_unit', i.purchase_unit,
           'units_per_purchase', public.stock__q(i.units_per_purchase),
           'quantity', public.stock__q(r.quantity), 'delivered_qty', public.stock__q(r.delivered_qty),
           'location_id', r.location_id, 'location_name', l.name, 'location_kind', l.kind, 'note', r.note,
           'requested_by', r.requested_by, 'requested_by_name', ru.full_name, 'created_at', r.created_at,
           'approved_by_name', au.full_name, 'approved_at', r.approved_at)
         || pg_catalog.jsonb_build_object(
           'delivered_by_name', du.full_name, 'delivered_at', r.delivered_at,
           'source_location_id', r.source_location_id, 'source_location_name', sl.name,
           'delivery_operation_key', r.delivery_operation_key,
           'rejected_by_name', ju.full_name, 'rejected_at', r.rejected_at, 'reject_reason', r.reject_reason,
           'cancelled_at', r.cancelled_at, 'cancelled_by_name', cu.full_name, 'updated_at', r.updated_at,
           'open_duplicates', (SELECT count(*) FROM public.stock_room_requests d
                               WHERE d.clinic_id = p_clinic AND d.stock_item_id = r.stock_item_id
                                 AND d.location_id = r.location_id AND d.id <> r.id
                                 AND d.status IN ('pending', 'approved')),
           'actions', pg_catalog.jsonb_build_object(
             'can_approve', coalesce(p_can_manage, false) AND r.status = 'pending',
             'can_reject', coalesce(p_can_manage, false) AND r.status IN ('pending', 'approved'),
             'can_deliver', coalesce(p_can_manage, false) AND r.status IN ('pending', 'approved'),
             'can_cancel', coalesce(r.requested_by = p_actor, false) AND r.status IN ('pending', 'approved')))
         || CASE WHEN coalesce(p_can_manage, false) THEN pg_catalog.jsonb_build_object(
              'warehouse_usable_qty', public.stock__q(coalesce((
                SELECT sum(sb.quantity)
                FROM public.stock_balances sb
                JOIN public.stock_batches b ON b.id = sb.batch_id
                JOIN public.stock_locations wl ON wl.id = sb.location_id AND wl.is_default_warehouse
                WHERE sb.clinic_id = p_clinic AND sb.stock_item_id = r.stock_item_id AND sb.quantity > 0
                  AND (b.expiry_date IS NULL OR b.expiry_date >= p_today)), 0)))
              ELSE '{}'::jsonb END
  FROM public.stock_room_requests r
  JOIN public.stock_items i ON i.id = r.stock_item_id
  JOIN public.stock_locations l ON l.id = r.location_id
  LEFT JOIN public.stock_locations sl ON sl.id = r.source_location_id
  LEFT JOIN public.users ru ON ru.id = r.requested_by
  LEFT JOIN public.users au ON au.id = r.approved_by
  LEFT JOIN public.users du ON du.id = r.delivered_by
  LEFT JOIN public.users ju ON ju.id = r.rejected_by
  LEFT JOIN public.users cu ON cu.id = r.cancelled_by
  WHERE r.id = p_request AND r.clinic_id = p_clinic
$$;

-- 6.7 Settings object (§6.6, without the flags). The payable category (id / name) only for 'finance' /
-- 'finance_readonly' holders: the stored one, else the clinic's active system 'supplies' category.
CREATE OR REPLACE FUNCTION public.stock__settings_json(p_clinic uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v public.stock_settings%ROWTYPE := public.stock__settings(p_clinic);
  v_fin boolean := public.has_permission('finance');
  v_fin_read boolean := public.has_permission('finance') OR public.has_permission('finance_readonly');
  v_cat_id uuid;
  v_cat_name text;
  v_out jsonb;
BEGIN
  v_out := jsonb_build_object(
    'po_creator_cannot_approve', v.po_creator_cannot_approve,
    'po_payable_enabled', v.po_payable_enabled,
    'po_payable_due_days', v.po_payable_due_days,
    'version', v.version,
    'updated_at', v.updated_at,
    'can_edit_approval_rule', coalesce(public.current_app_role()::text = 'owner', false),
    'can_edit_payable', v_fin);
  IF v_fin_read THEN
    IF v.po_payable_category_id IS NOT NULL THEN
      SELECT c.id, c.name INTO v_cat_id, v_cat_name
      FROM public.fin_categories c WHERE c.clinic_id = p_clinic AND c.id = v.po_payable_category_id;
    ELSE
      SELECT c.id, c.name INTO v_cat_id, v_cat_name
      FROM public.fin_categories c
      WHERE c.clinic_id = p_clinic AND c.is_system AND c.report_bucket = 'supplies' AND c.is_active
      ORDER BY c.id
      LIMIT 1;
    END IF;
    v_out := v_out || jsonb_build_object('po_payable_category_id', v_cat_id, 'po_payable_category_name', v_cat_name,
                                         'po_payable_category_is_default', v.po_payable_category_id IS NULL);
  END IF;
  RETURN v_out;
END;
$$;

-- 6.8 Finance payable hook (§9; owner decision: OFF). Runs once, under the order lock, right after the order became
-- 'received' (last receipt or close). Never raises: anything unexpected becomes 'skipped_error' with a WARNING, so a
-- receipt is never blocked by finance configuration. Writes payable_state and fin_entry_id in one UPDATE (shape
-- check) and returns the state. A planned obligation only: no fin_payments row is ever written.
CREATE OR REPLACE FUNCTION public.stock__po_payable(p_clinic uuid, p_order uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_s public.stock_settings%ROWTYPE := public.stock__settings(p_clinic);
  v_o public.purchase_orders%ROWTYPE;
  v_state text;
  v_entry uuid;
  v_cat uuid;
  v_amount numeric;
  v_uncosted boolean;
  v_cp uuid;
  v_cp_text text;
  v_lines integer;
  v_key text;
  v_sqlstate text;
  v_msg text;
BEGIN
  SELECT * INTO v_o FROM public.purchase_orders o WHERE o.id = p_order AND o.clinic_id = p_clinic;
  IF NOT FOUND OR v_o.status <> 'received' THEN
    RETURN NULL;
  END IF;

  IF NOT coalesce(v_s.po_payable_enabled, false) THEN
    v_state := 'disabled';
  ELSE
    BEGIN
      IF v_s.po_payable_category_id IS NOT NULL THEN
        SELECT c.id INTO v_cat FROM public.fin_categories c
        WHERE c.clinic_id = p_clinic AND c.id = v_s.po_payable_category_id AND c.is_active
          AND c.direction = 'out' AND c.profit_class = 'expense';
      END IF;
      IF v_cat IS NULL THEN
        SELECT c.id INTO v_cat FROM public.fin_categories c
        WHERE c.clinic_id = p_clinic AND c.is_system AND c.report_bucket = 'supplies' AND c.is_active
        ORDER BY c.id
        LIMIT 1;
      END IF;

      IF v_cat IS NULL THEN
        v_state := 'skipped_no_category';
      ELSE
        SELECT coalesce(bool_or(bc.batch_id IS NULL), false), sum(m.quantity * bc.unit_cost_cents)
          INTO v_uncosted, v_amount
        FROM public.stock_movements m
        JOIN public.purchase_order_items li ON li.id = m.po_item_id
        LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id
        WHERE li.order_id = p_order AND li.clinic_id = p_clinic AND m.clinic_id = p_clinic
          AND m.movement_type = 'receive';

        IF v_uncosted THEN
          v_state := 'skipped_unpriced';
        ELSIF round(coalesce(v_amount, 0)) <= 0 THEN
          v_state := 'skipped_zero';
        ELSE
          SELECT f.id INTO v_cp
          FROM public.suppliers s
          JOIN public.fin_counterparties f ON f.id = s.fin_counterparty_id AND f.clinic_id = p_clinic AND f.is_active
          WHERE s.id = v_o.supplier_id AND s.clinic_id = p_clinic;
          IF v_cp IS NULL THEN
            SELECT left(s.name, 200) INTO v_cp_text FROM public.suppliers s WHERE s.id = v_o.supplier_id;
          END IF;
          SELECT count(*) INTO v_lines FROM public.purchase_order_items li WHERE li.order_id = p_order;
          v_key := 'stock-po:' || p_order::text;

          INSERT INTO public.fin_entries (id, clinic_id, category_id, counterparty_id, counterparty_text, description,
                                          due_date, amount_cents, currency, source_key, created_by, updated_by)
          VALUES (md5('stock-po-payable:' || p_order::text)::uuid, p_clinic, v_cat, v_cp, v_cp_text,
                  'Stok siparişi ' || v_o.order_number || ' (' || v_lines::text || ' kalem)',
                  public.clinic_today() + v_s.po_payable_due_days, round(v_amount)::bigint, 'TRY', v_key,
                  p_actor, p_actor)
          ON CONFLICT (clinic_id, source_key) WHERE source_key IS NOT NULL DO NOTHING;

          SELECT e.id INTO v_entry FROM public.fin_entries e WHERE e.clinic_id = p_clinic AND e.source_key = v_key;
          v_state := CASE WHEN v_entry IS NULL THEN 'skipped_error' ELSE 'created' END;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RAISE WARNING 'Sipariş % için finans borç kaydı oluşturulamadı (%): %', v_o.order_number, v_sqlstate, v_msg;
      v_state := 'skipped_error';
      v_entry := NULL;
    END;
  END IF;

  UPDATE public.purchase_orders
  SET payable_state = v_state, fin_entry_id = CASE WHEN v_state = 'created' THEN v_entry END
  WHERE id = p_order AND clinic_id = p_clinic;
  RETURN v_state;
END;
$$;

-- 6.9 Reorder suggestion rows (§7) of every eligible card with a positive need, both scopes; the RPC filters by
-- scope and appends cost keys for cost viewers. last_unit_cost_cents is an internal column only.
--   usable = stock__levels usable_qty (all locations, unexpired); open = stock__po_open_qty;
--   need_raw = MAX - usable - open; packs = ceil(need_raw / factor); need = packs x factor (A: rounded up to whole).
CREATE OR REPLACE FUNCTION public.stock__reorder_rows(p_clinic uuid, p_today date)
RETURNS TABLE (stock_item_id uuid, item_name text, category text, tracking_level text, supplier_id uuid,
               supplier_name text, search text, critical boolean, state text, need_qty numeric,
               last_unit_cost_cents bigint, j jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT x.id, x.item_name, x.category, x.tracking_level, x.supplier_id, s.name,
         public.stock__tr_lower(concat_ws(' ', x.item_name, x.brand, x.model, x.category, x.sku, x.item_code, x.gtin)),
         x.critical,
         CASE WHEN x.usable_qty = 0 THEN 'out' WHEN x.critical THEN 'critical' ELSE 'below_max' END,
         n.need, c.last_unit_cost_cents,
         pg_catalog.jsonb_build_object(
           'stock_item_id', x.id, 'item_code', x.item_code, 'item_name', x.item_name, 'brand', x.brand,
           'category', x.category, 'tracking_level', x.tracking_level, 'usage_unit', x.usage_unit,
           'purchase_unit', x.purchase_unit, 'units_per_purchase', public.stock__q(x.units_per_purchase),
           'usable_qty', public.stock__q(x.usable_qty), 'min_qty', public.stock__q(x.min_qty),
           'max_qty', public.stock__q(x.max_qty), 'open_po_qty', public.stock__q(x.open_qty),
           'open_po_count', x.open_orders, 'need_qty', public.stock__q(n.need), 'need_packs', public.stock__q(p.packs),
           'state', CASE WHEN x.usable_qty = 0 THEN 'out' WHEN x.critical THEN 'critical' ELSE 'below_max' END,
           'supplier_id', x.supplier_id, 'supplier_name', s.name, 'supplier_active', s.is_active)
  FROM (
    SELECT i.id, i.item_code, i.item_name, i.brand, i.model, i.category, i.sku, i.gtin, i.tracking_level,
           i.usage_unit, i.purchase_unit, i.units_per_purchase, i.min_qty, i.max_qty, i.supplier_id,
           l.usable_qty, coalesce(op.open_qty, 0) AS open_qty, coalesce(op.open_orders, 0) AS open_orders,
           (l.usable_qty <= i.min_qty) AS critical,
           (i.max_qty - l.usable_qty - coalesce(op.open_qty, 0)) AS need_raw
    FROM public.stock_items i
    JOIN public.stock__levels(p_clinic, p_today) l ON l.stock_item_id = i.id
    LEFT JOIN public.stock__po_open_qty(p_clinic) op ON op.stock_item_id = i.id
    WHERE i.clinic_id = p_clinic AND i.is_active AND NOT i.needs_review AND i.max_qty > 0
  ) x
  CROSS JOIN LATERAL (
    SELECT CASE WHEN x.need_raw > 0 THEN ceil(x.need_raw / x.units_per_purchase) ELSE 0 END AS packs
  ) p
  CROSS JOIN LATERAL (
    SELECT CASE WHEN x.tracking_level = 'A' THEN ceil(p.packs * x.units_per_purchase)
                ELSE round(p.packs * x.units_per_purchase, 4) END AS need
  ) n
  LEFT JOIN public.suppliers s ON s.id = x.supplier_id
  LEFT JOIN public.stock_item_costs c ON c.stock_item_id = x.id
  WHERE n.need > 0
$$;

-- ---------------------------------------------------------------------------
-- 7. Write cores (internal). The RPCs are gate -> stock__op_begin -> core -> stock__op_finish; the rolled-back
--    self-check runs the same cores. Lock order (§1.3, extends 0024): PO header / room request / settings row ->
--    the PO's lines (by id) -> cards (by id) -> locations (FOR SHARE, by id) -> balance rows (FEFO order); the PO
--    number counter only in PO create, before any card lock.
-- ---------------------------------------------------------------------------

-- 7.1 PO create (p_version NULL) / edit of a pending order (§5.1). Returns stock__po_write_json.
CREATE OR REPLACE FUNCTION public.stock__po_save_core(p_clinic uuid, p_actor uuid, p_order_id uuid, p_version integer,
                                                      p_order jsonb, p_can_cost boolean, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_create boolean := p_version IS NULL;
  v_old public.purchase_orders%ROWTYPE;
  v_has_supplier boolean;
  v_has_lines boolean;
  v_supplier uuid;
  v_date date;
  v_note text;
  v_lines jsonb;
  v_line jsonb;
  v_n integer;
  v_ids uuid[];
  v_item_id uuid;
  v_item public.stock_items%ROWTYPE;
  v_qty numeric;
  v_unit text;
  v_upp numeric;
  v_price bigint;
  v_price_unit text;
  v_line_note text;
  v_items uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_upps numeric[] := '{}';
  v_has_price boolean[] := '{}';
  v_prices bigint[] := '{}';
  v_notes text[] := '{}';
  v_year smallint;
  v_seq integer;
  v_line_id uuid;
  v_state text;
  v_msg text;
  v_hint text;
  v_constraint text;
  i integer;
BEGIN
  IF p_order_id IS NULL OR p_order IS NULL
     OR NOT public.stock__keys_ok(p_order, ARRAY['supplier_id', 'expected_date', 'note', 'lines']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_has_supplier := p_order ? 'supplier_id';
  v_has_lines := p_order ? 'lines';

  -- 1. Create: a fresh id. Edit: the locked pending order at the version the client saw.
  IF v_create THEN
    IF EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = p_order_id) THEN
      PERFORM public.stock__raise('E_ID_TAKEN');
    END IF;
  ELSE
    v_old := public.stock__po_lock(p_clinic, p_order_id);
    IF v_old.status <> 'pending' THEN
      PERFORM public.stock__raise('E_PO_EDIT_STATE');
    END IF;
    IF v_old.version IS DISTINCT FROM p_version THEN
      PERFORM public.stock__raise('E_VERSION');
    END IF;
  END IF;

  -- 2. Supplier (O:35): an active supplier of the clinic, locked FOR SHARE against a concurrent deactivation.
  IF v_create OR v_has_supplier THEN
    v_supplier := public.stock__j_uuid(p_order, 'supplier_id', 'E_SUPPLIER');
    IF v_supplier IS NULL THEN
      PERFORM public.stock__raise('E_SUPPLIER');
    END IF;
    PERFORM 1 FROM public.suppliers s WHERE s.id = v_supplier AND s.clinic_id = p_clinic AND s.is_active FOR SHARE;
    IF NOT FOUND THEN
      PERFORM public.stock__raise('E_SUPPLIER');
    END IF;
  ELSE
    v_supplier := v_old.supplier_id;
  END IF;

  -- Expected date: '' / null clears; a new date must not be in the past (an unchanged stored date may stay).
  IF p_order ? 'expected_date' THEN
    v_date := public.stock__po_day(public.stock__j_text(p_order, 'expected_date', 'E_PO_DATE'), NULL);
    IF v_date < p_today AND (v_create OR v_date IS DISTINCT FROM v_old.expected_date) THEN
      PERFORM public.stock__raise('E_PO_DATE');
    END IF;
  ELSIF NOT v_create THEN
    v_date := v_old.expected_date;
  END IF;

  IF p_order ? 'note' THEN
    v_note := btrim(coalesce(public.stock__j_text(p_order, 'note', 'E_PO_NOTE'), ''));
    IF char_length(v_note) > 1000 THEN
      PERFORM public.stock__raise('E_PO_NOTE');
    END IF;
  ELSE
    v_note := CASE WHEN v_create THEN '' ELSE v_old.note END;
  END IF;

  -- Lines: 1..20 checked before any row (O:30); a price key from a non viewer refuses the whole call.
  IF v_create AND NOT v_has_lines THEN
    PERFORM public.stock__raise('E_PO_LINES');
  END IF;
  IF v_has_lines THEN
    v_lines := p_order -> 'lines';
    IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
      PERFORM public.stock__raise('E_PO_LINES');
    END IF;
    IF jsonb_array_length(v_lines) NOT BETWEEN 1 AND 20 THEN
      PERFORM public.stock__raise('E_PO_LINES');
    END IF;
    IF NOT coalesce(p_can_cost, false) AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_lines) AS e(v)
      WHERE jsonb_typeof(e.v) = 'object' AND e.v ? 'unit_price_cents'
    ) THEN
      PERFORM public.stock__raise('E_COST_FORBIDDEN');
    END IF;
  END IF;

  -- 3. Create only: the number (counter row lock) before any card lock.
  IF v_create THEN
    v_year := extract(year FROM p_today)::smallint;
    v_seq := public.stock__po_next_number(p_clinic, v_year);
  END IF;

  IF v_has_lines THEN
    -- Locks: the order's existing lines by id, then every (well-formed) card id FOR SHARE in id order, so a
    -- concurrent deactivation / draft switch waits and the open-reference trigger sees this order.
    IF NOT v_create THEN
      PERFORM 1 FROM public.purchase_order_items li WHERE li.order_id = p_order_id ORDER BY li.id FOR UPDATE;
    END IF;
    SELECT array_agg(DISTINCT btrim(e.v ->> 'stock_item_id')::uuid)
      INTO v_ids
    FROM jsonb_array_elements(v_lines) AS e(v)
    WHERE jsonb_typeof(e.v) = 'object'
      AND jsonb_typeof(e.v -> 'stock_item_id') = 'string'
      AND btrim(e.v ->> 'stock_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    PERFORM 1 FROM public.stock_items t
    WHERE t.clinic_id = p_clinic AND t.id = ANY (coalesce(v_ids, '{}'::uuid[]))
    ORDER BY t.id
    FOR SHARE;

    -- Rows in order (first failing row wins; '<n>. satır: ', DETAIL = n).
    FOR v_line, v_n IN SELECT e.v, e.n::integer FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(v, n) LOOP
      BEGIN
        IF NOT public.stock__keys_ok(v_line, ARRAY['stock_item_id', 'quantity', 'quantity_unit', 'units_per_purchase',
                                                   'unit_price_cents', 'price_unit', 'note']) THEN
          PERFORM public.stock__raise('E_FILTER');
        END IF;
        v_item_id := public.stock__j_uuid(v_line, 'stock_item_id', 'E_ITEM_NOT_FOUND');
        SELECT * INTO v_item FROM public.stock_items t WHERE t.id = v_item_id AND t.clinic_id = p_clinic;
        IF NOT FOUND OR NOT v_item.is_active OR v_item.needs_review THEN
          PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
        END IF;

        v_unit := coalesce(public.stock__j_text(v_line, 'quantity_unit', 'E_QTY_UNIT'), 'usage');
        v_upp := public.stock__j_num(v_line, 'units_per_purchase', 'E_QTY_UNIT');
        v_price_unit := coalesce(public.stock__j_text(v_line, 'price_unit', 'E_COST'), 'usage');
        IF v_price_unit NOT IN ('usage', 'purchase') THEN
          PERFORM public.stock__raise('E_COST');
        END IF;
        v_price := public.stock__j_bigint(v_line, 'unit_price_cents', 'E_COST');
        IF (v_unit = 'purchase' OR (v_price IS NOT NULL AND v_price_unit = 'purchase'))
           AND v_upp IS NOT NULL AND v_upp <> v_item.units_per_purchase THEN
          PERFORM public.stock__raise('E_UNIT_CHANGED');
        END IF;
        v_qty := public.stock__to_usage(public.stock__qty(public.stock__j_num(v_line, 'quantity', 'E_QTY'), false),
                                        v_unit, v_item.units_per_purchase);
        IF v_item.tracking_level = 'A' AND v_qty <> trunc(v_qty) THEN
          PERFORM public.stock__raise('E_QTY_INTEGER');
        END IF;
        IF v_price IS NOT NULL THEN
          IF v_price < 0 OR v_price > 100000000000 THEN
            PERFORM public.stock__raise('E_COST');
          END IF;
          IF v_price_unit = 'purchase' THEN
            v_price := round(v_price / v_item.units_per_purchase)::bigint;
          END IF;
          IF v_price > 100000000000 THEN
            PERFORM public.stock__raise('E_COST');
          END IF;
        END IF;
        v_line_note := btrim(coalesce(public.stock__j_text(v_line, 'note', 'E_PO_NOTE'), ''));
        IF char_length(v_line_note) > 200 THEN
          PERFORM public.stock__raise('E_PO_NOTE');
        END IF;

        v_items := v_items || v_item.id;
        v_qtys := v_qtys || v_qty;
        v_upps := v_upps || v_item.units_per_purchase;
        v_has_price := v_has_price || (v_line ? 'unit_price_cents');
        v_prices := v_prices || v_price;
        v_notes := v_notes || v_line_note;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
        PERFORM public.stock__row_raise(v_n, v_state, v_msg, v_hint);
      END;
    END LOOP;

    -- One line per card (UP:46), reported on the second occurrence's row.
    FOR i IN 2 .. coalesce(array_length(v_items, 1), 0) LOOP
      IF v_items[i] = ANY (v_items[1:i - 1]) THEN
        BEGIN
          PERFORM public.stock__raise('E_PO_DUP_ITEM');
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
          PERFORM public.stock__row_raise(i, v_state, v_msg, v_hint);
        END;
      END IF;
    END LOOP;
  END IF;

  -- 4. Header.
  IF v_create THEN
    BEGIN
      INSERT INTO public.purchase_orders (id, clinic_id, order_year, order_seq, supplier_id, status, expected_date, note,
                                          created_by, updated_by)
      VALUES (p_order_id, p_clinic, v_year, v_seq, v_supplier, 'pending', v_date, v_note, p_actor, p_actor);
    EXCEPTION WHEN unique_violation THEN
      -- Only a taken order id is E_ID_TAKEN (the client then makes a new id); a number collision is a real error
      -- (stock__po_next_number heals the counter, so it should never happen) and is re-raised unchanged.
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IN ('purchase_orders_pkey', 'purchase_orders_clinic_id_id_key') THEN
        PERFORM public.stock__raise('E_ID_TAKEN');
      END IF;
      RAISE;
    END;
  ELSE
    UPDATE public.purchase_orders
    SET supplier_id = v_supplier, expected_date = v_date, note = v_note,
        content_edited_by = CASE WHEN v_has_supplier OR v_has_lines THEN p_actor ELSE content_edited_by END,
        content_editors = CASE WHEN (v_has_supplier OR v_has_lines) AND NOT (p_actor = ANY (content_editors))
                               THEN content_editors || p_actor ELSE content_editors END,
        version = version + 1, updated_by = p_actor
    WHERE id = p_order_id AND clinic_id = p_clinic;
  END IF;

  -- 5. Lines: a present list replaces the line set (matched by card); positions renumber (deferred unique).
  IF v_has_lines THEN
    DELETE FROM public.purchase_order_items li
    WHERE li.order_id = p_order_id AND li.clinic_id = p_clinic AND NOT (li.stock_item_id = ANY (v_items));

    FOR i IN 1 .. array_length(v_items, 1) LOOP
      v_line_id := NULL;
      UPDATE public.purchase_order_items
      SET qty_ordered = v_qtys[i], units_per_purchase = v_upps[i], note = v_notes[i], line_no = i
      WHERE order_id = p_order_id AND clinic_id = p_clinic AND stock_item_id = v_items[i]
      RETURNING id INTO v_line_id;
      IF v_line_id IS NULL THEN
        INSERT INTO public.purchase_order_items (id, clinic_id, order_id, line_no, stock_item_id, qty_ordered,
                                                 units_per_purchase, note)
        VALUES (gen_random_uuid(), p_clinic, p_order_id, i, v_items[i], v_qtys[i], v_upps[i], v_notes[i])
        RETURNING id INTO v_line_id;
      END IF;
      -- Price key present: a value upserts, null clears; absent: a matched line keeps its price.
      IF v_has_price[i] THEN
        IF v_prices[i] IS NULL THEN
          DELETE FROM public.purchase_order_item_costs c WHERE c.po_item_id = v_line_id;
        ELSE
          INSERT INTO public.purchase_order_item_costs (po_item_id, clinic_id, unit_price_cents, updated_by, updated_at)
          VALUES (v_line_id, p_clinic, v_prices[i], p_actor, now())
          ON CONFLICT (po_item_id) DO UPDATE
            SET unit_price_cents = EXCLUDED.unit_price_cents, updated_by = EXCLUDED.updated_by, updated_at = now()
            WHERE purchase_order_item_costs.unit_price_cents IS DISTINCT FROM EXCLUDED.unit_price_cents;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN public.stock__po_write_json(p_clinic, p_order_id);
END;
$$;

-- 7.2 Transitions (§5.2): approve, mark_ordered, cancel, close. Returns stock__po_write_json.
CREATE OR REPLACE FUNCTION public.stock__po_transition_core(p_clinic uuid, p_actor uuid, p_order uuid,
                                                            p_version integer, p_action text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_o public.purchase_orders%ROWTYPE;
  v_s public.stock_settings%ROWTYPE;
  v_reason text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('approve', 'mark_ordered', 'cancel', 'close') THEN
    PERFORM public.stock__raise('E_PO_ACTION');
  END IF;
  v_o := public.stock__po_lock(p_clinic, p_order);
  IF (p_action = 'approve' AND v_o.status <> 'pending')
     OR (p_action = 'mark_ordered' AND v_o.status <> 'approved')
     OR (p_action = 'cancel' AND v_o.status NOT IN ('pending', 'approved', 'ordered'))
     OR (p_action = 'close' AND v_o.status <> 'partially_received') THEN
    PERFORM public.stock__raise('E_PO_STATE');
  END IF;
  IF v_o.version IS DISTINCT FROM p_version THEN
    PERFORM public.stock__raise('E_VERSION');
  END IF;

  IF p_action = 'approve' THEN
    v_s := public.stock__settings(p_clinic);
    IF public.stock__po_self_blocked(v_s.po_creator_cannot_approve, p_actor, v_o.created_by, v_o.content_editors) THEN
      PERFORM public.stock__raise('E_PO_SELF_APPROVE');
    END IF;
    UPDATE public.purchase_orders
    SET status = 'approved', approved_by = p_actor, approved_at = now(), version = version + 1, updated_by = p_actor
    WHERE id = v_o.id;
  ELSIF p_action = 'mark_ordered' THEN
    UPDATE public.purchase_orders
    SET status = 'ordered', ordered_by = p_actor, ordered_at = now(), version = version + 1, updated_by = p_actor
    WHERE id = v_o.id;
  ELSIF p_action = 'cancel' THEN
    v_reason := public.stock__po_reason(p_reason);
    UPDATE public.purchase_orders
    SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(), cancel_reason = v_reason,
        version = version + 1, updated_by = p_actor
    WHERE id = v_o.id;
  ELSE
    v_reason := public.stock__po_reason(p_reason);
    UPDATE public.purchase_orders
    SET status = 'received', closed_short = true, closed_by = p_actor, close_reason = v_reason, received_at = now(),
        version = version + 1, updated_by = p_actor
    WHERE id = v_o.id;
    PERFORM public.stock__po_payable(p_clinic, v_o.id, p_actor);
  END IF;

  RETURN public.stock__po_write_json(p_clinic, v_o.id);
END;
$$;

-- 7.3 Receipt of 1..20 rows of one order (§5.3), all or nothing, through stock__receive_line (every 0024 receipt
-- rule applies). Cost: an explicit unit_cost_cents (cost viewers only), else the order price (taken on the server,
-- so a manager without cost view receives at the order price without seeing it), else the card's last cost.
-- Returns {"movement_ids": [...]}; the order status / payable are updated here.
DROP FUNCTION IF EXISTS public.stock__po_receive_core(uuid, uuid, uuid, date, boolean, uuid, jsonb, text, text);
CREATE OR REPLACE FUNCTION public.stock__po_receive_core(p_clinic uuid, p_actor uuid, p_op uuid, p_today date,
                                                         p_can_cost boolean, p_order uuid, p_lines jsonb,
                                                         p_document_no text, p_reason text, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_o public.purchase_orders%ROWTYPE;
  v_li public.purchase_order_items%ROWTYPE;
  v_item public.stock_items%ROWTYPE;
  v_doc text;
  v_reason text;
  v_row jsonb;
  v_n integer;
  v_line_id uuid;
  v_unit text;
  v_upp numeric;
  v_qty numeric;
  v_remaining numeric;
  v_cost bigint;
  v_cost_unit text;
  v_use_price boolean;
  v_pass_cost boolean;
  v_mid uuid;
  v_ids jsonb := '[]'::jsonb;
  v_state text;
  v_msg text;
  v_hint text;
  r record;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    PERFORM public.stock__raise('E_BULK_SIZE');
  END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 20 THEN
    PERFORM public.stock__raise('E_BULK_SIZE');
  END IF;
  v_doc := btrim(coalesce(p_document_no, ''));
  IF char_length(v_doc) > 60 THEN
    PERFORM public.stock__raise('E_DOCUMENT_NO');
  END IF;
  v_reason := public.stock__reason(p_reason, false);

  v_o := public.stock__po_lock(p_clinic, p_order);
  IF v_o.status NOT IN ('ordered', 'partially_received') THEN
    PERFORM public.stock__raise('E_PO_RECEIVE_STATE');
  END IF;
  -- Every receipt bumps the version: a client that sends the version it saw can never record the same delivery
  -- twice (for example after a lost response and an edited retry under a new key). NULL = no check (contract §5.3).
  IF p_version IS NOT NULL AND v_o.version IS DISTINCT FROM p_version THEN
    PERFORM public.stock__raise('E_VERSION');
  END IF;
  IF v_reason = '' THEN
    v_reason := 'Sipariş ' || v_o.order_number || ' mal kabul';
  END IF;

  -- Locks: the order's lines by id, then their cards by id.
  PERFORM 1 FROM public.purchase_order_items li WHERE li.order_id = v_o.id ORDER BY li.id FOR UPDATE;
  PERFORM 1 FROM public.stock_items t
  WHERE t.clinic_id = p_clinic
    AND t.id IN (SELECT li.stock_item_id FROM public.purchase_order_items li WHERE li.order_id = v_o.id)
  ORDER BY t.id
  FOR NO KEY UPDATE;

  FOR v_row, v_n IN SELECT e.v, e.n::integer FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(v, n) LOOP
    BEGIN
      IF NOT public.stock__keys_ok(v_row, ARRAY['po_item_id', 'to_location_id', 'quantity', 'quantity_unit',
           'units_per_purchase', 'lot_number', 'serial_number', 'expiry_date', 'unit_cost_cents', 'cost_unit',
           'use_order_price']) THEN
        PERFORM public.stock__raise('E_FILTER');
      END IF;
      v_line_id := public.stock__j_uuid(v_row, 'po_item_id', 'E_PO_LINE');
      SELECT * INTO v_li FROM public.purchase_order_items li
      WHERE li.id = v_line_id AND li.order_id = v_o.id AND li.clinic_id = p_clinic;
      IF NOT FOUND THEN
        PERFORM public.stock__raise('E_PO_LINE');
      END IF;
      SELECT * INTO v_item FROM public.stock_items t WHERE t.id = v_li.stock_item_id AND t.clinic_id = p_clinic;

      v_unit := coalesce(public.stock__j_text(v_row, 'quantity_unit', 'E_QTY_UNIT'), 'usage');
      v_upp := public.stock__j_num(v_row, 'units_per_purchase', 'E_QTY_UNIT');
      v_cost := public.stock__j_bigint(v_row, 'unit_cost_cents', 'E_COST');
      v_cost_unit := coalesce(public.stock__j_text(v_row, 'cost_unit', 'E_COST'), 'usage');
      v_use_price := coalesce(public.stock__j_bool(v_row, 'use_order_price', 'E_FILTER'), true);
      IF (v_unit = 'purchase' OR (v_cost IS NOT NULL AND v_cost_unit = 'purchase'))
         AND v_upp IS NOT NULL AND v_upp <> v_item.units_per_purchase THEN
        PERFORM public.stock__raise('E_UNIT_CHANGED');
      END IF;
      v_qty := public.stock__to_usage(public.stock__qty(public.stock__j_num(v_row, 'quantity', 'E_QTY'), false),
                                      v_unit, v_item.units_per_purchase);

      -- Running remaining of the line (earlier rows of this call are already added to qty_received) (MP:84).
      v_remaining := v_li.qty_ordered - v_li.qty_received;
      IF v_qty > v_remaining THEN
        PERFORM public.stock__raise('E_PO_OVER', trim_scale(greatest(v_remaining, 0))::text,
                                    trim_scale(greatest(v_remaining, 0))::text);
      END IF;

      IF v_cost IS NOT NULL THEN
        IF NOT coalesce(p_can_cost, false) THEN
          PERFORM public.stock__raise('E_COST_FORBIDDEN');
        END IF;
        v_pass_cost := true;
      ELSIF v_use_price THEN
        SELECT c.unit_price_cents INTO v_cost FROM public.purchase_order_item_costs c WHERE c.po_item_id = v_li.id;
        v_cost_unit := 'usage';
        v_pass_cost := true;
      ELSE
        v_pass_cost := coalesce(p_can_cost, false);
      END IF;

      v_mid := public.stock__receive_line(p_clinic, p_actor, p_op, p_today, v_pass_cost, v_item.id,
        public.stock__j_uuid(v_row, 'to_location_id', 'E_LOCATION'), v_qty, 'usage', NULL,
        public.stock__j_text(v_row, 'lot_number', 'E_LOT_FORMAT'),
        public.stock__j_text(v_row, 'serial_number', 'E_SERIAL_FORMAT'),
        public.stock__j_text(v_row, 'expiry_date', 'E_EXPIRY_INVALID'),
        v_cost, v_cost_unit, v_o.supplier_id, v_doc, v_reason, v_li.id);

      UPDATE public.purchase_order_items SET qty_received = qty_received + v_qty WHERE id = v_li.id;
      v_ids := v_ids || to_jsonb(v_mid);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
      PERFORM public.stock__row_raise(v_n, v_state, v_msg, v_hint);
    END;
  END LOOP;

  FOR r IN
    SELECT DISTINCT m.stock_item_id FROM public.stock_movements m
    WHERE m.id IN (SELECT (x.v)::uuid FROM jsonb_array_elements_text(v_ids) AS x(v))
  LOOP
    PERFORM public.stock__sync_item(p_clinic, r.stock_item_id);
  END LOOP;

  -- Status (MP:88-90): every line complete -> received (+ payable hook), else partially received.
  IF NOT EXISTS (SELECT 1 FROM public.purchase_order_items li
                 WHERE li.order_id = v_o.id AND li.qty_received < li.qty_ordered) THEN
    UPDATE public.purchase_orders
    SET status = 'received', received_at = now(), version = version + 1, updated_by = p_actor
    WHERE id = v_o.id;
    PERFORM public.stock__po_payable(p_clinic, v_o.id, p_actor);
  ELSE
    UPDATE public.purchase_orders
    SET status = 'partially_received', version = version + 1, updated_by = p_actor
    WHERE id = v_o.id;
  END IF;

  RETURN jsonb_build_object('movement_ids', v_ids);
END;
$$;

-- 7.4 Room request create (§5.4). The card and the target are read FOR SHARE (no stock change; the locks only keep a
-- concurrent deactivation from slipping past the open-reference triggers).
CREATE OR REPLACE FUNCTION public.stock__rq_create_core(p_clinic uuid, p_actor uuid, p_request uuid, p_item uuid,
                                                        p_location uuid, p_quantity numeric, p_quantity_unit text,
                                                        p_units_per_purchase numeric, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item public.stock_items%ROWTYPE;
  v_loc public.stock_locations%ROWTYPE;
  v_qty numeric;
  v_note text := btrim(coalesce(p_note, ''));
  v_ref bigint;
  v_constraint text;
BEGIN
  IF p_request IS NULL THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_room_requests r WHERE r.id = p_request) THEN
    PERFORM public.stock__raise('E_ID_TAKEN');
  END IF;
  -- Per-clinic "Talep #n": one create per clinic at a time (taken before any row lock), gapless because a
  -- rolled-back create frees its number.
  PERFORM pg_advisory_xact_lock(hashtextextended('stock.rq_ref:' || p_clinic::text, 0));

  SELECT * INTO v_item FROM public.stock_items i WHERE i.id = p_item AND i.clinic_id = p_clinic FOR SHARE;
  IF NOT FOUND OR NOT v_item.is_active OR v_item.needs_review THEN
    PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
  END IF;
  SELECT * INTO v_loc FROM public.stock_locations l WHERE l.id = p_location AND l.clinic_id = p_clinic FOR SHARE;
  IF NOT FOUND OR NOT v_loc.is_active THEN
    PERFORM public.stock__raise('E_LOCATION');
  END IF;
  IF v_loc.kind NOT IN ('room', 'sterilization') OR v_loc.is_default_warehouse THEN
    PERFORM public.stock__raise('E_RQ_LOCATION');
  END IF;

  IF coalesce(p_quantity_unit, 'usage') = 'purchase' AND p_units_per_purchase IS NOT NULL
     AND p_units_per_purchase <> v_item.units_per_purchase THEN
    PERFORM public.stock__raise('E_UNIT_CHANGED');
  END IF;
  v_qty := public.stock__to_usage(public.stock__qty(p_quantity, false), p_quantity_unit, v_item.units_per_purchase);
  IF v_item.tracking_level = 'A' AND v_qty <> trunc(v_qty) THEN
    PERFORM public.stock__raise('E_QTY_INTEGER');
  END IF;
  IF char_length(v_note) > 500 THEN
    PERFORM public.stock__raise('E_RQ_NOTE');
  END IF;

  SELECT coalesce(max(r.ref_no), 0) + 1 INTO v_ref FROM public.stock_room_requests r WHERE r.clinic_id = p_clinic;
  BEGIN
    INSERT INTO public.stock_room_requests (id, ref_no, clinic_id, stock_item_id, location_id, quantity, status, note,
                                            requested_by)
    VALUES (p_request, v_ref, p_clinic, v_item.id, v_loc.id, v_qty, 'pending', v_note, p_actor);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IN ('stock_room_requests_pkey', 'stock_room_requests_clinic_id_id_key') THEN
      PERFORM public.stock__raise('E_ID_TAKEN');
    END IF;
    RAISE;
  END;
  RETURN p_request;
END;
$$;

-- 7.5 Room request actions (§5.5): approve / reject / deliver (managers), cancel (the requester). Delivery is a FEFO
-- transfer from the current default warehouse (§5.5.1); A-level needs chosen lots. Returns
-- {"movement_ids": [...], "stock_item_id": uuid}.
CREATE OR REPLACE FUNCTION public.stock__rq_action_core(p_clinic uuid, p_actor uuid, p_op uuid, p_today date,
                                                        p_can_manage boolean, p_request uuid, p_version integer,
                                                        p_action text, p_reason text, p_quantity numeric,
                                                        p_quantity_unit text, p_units_per_purchase numeric,
                                                        p_batch_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_r public.stock_room_requests%ROWTYPE;
  v_item public.stock_items%ROWTYPE;
  v_tgt public.stock_locations%ROWTYPE;
  v_src uuid;
  v_qty numeric;
  v_reason text;
  v_batches uuid[];
  v_bq uuid[] := '{}';
  v_qq numeric[] := '{}';
  v_total numeric := 0;
  v_remaining numeric;
  v_take numeric;
  v_extra jsonb;
  v_ids jsonb := '[]'::jsonb;
  r record;
  i integer;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('approve', 'reject', 'deliver', 'cancel') THEN
    PERFORM public.stock__raise('E_RQ_ACTION');
  END IF;
  IF p_action IN ('approve', 'reject', 'deliver') AND NOT coalesce(p_can_manage, false) THEN
    PERFORM public.stock__raise('E_RQ_MANAGE');
  END IF;

  v_r := public.stock__rq_lock(p_clinic, p_request);
  IF (p_action = 'approve' AND v_r.status <> 'pending')
     OR (p_action IN ('reject', 'deliver', 'cancel') AND v_r.status NOT IN ('pending', 'approved')) THEN
    PERFORM public.stock__raise('E_RQ_STATE');
  END IF;
  IF p_action = 'cancel' AND v_r.requested_by IS DISTINCT FROM p_actor THEN
    PERFORM public.stock__raise('E_RQ_CANCEL_OWN');
  END IF;
  IF v_r.version IS DISTINCT FROM p_version THEN
    PERFORM public.stock__raise('E_VERSION');
  END IF;

  IF p_action = 'approve' THEN
    UPDATE public.stock_room_requests
    SET status = 'approved', approved_by = p_actor, approved_at = now(), version = version + 1
    WHERE id = v_r.id;
    RETURN jsonb_build_object('movement_ids', '[]'::jsonb, 'stock_item_id', v_r.stock_item_id);
  ELSIF p_action = 'reject' THEN
    v_reason := public.stock__rq_reason(p_reason);
    UPDATE public.stock_room_requests
    SET status = 'rejected', rejected_by = p_actor, rejected_at = now(), reject_reason = v_reason,
        version = version + 1
    WHERE id = v_r.id;
    RETURN jsonb_build_object('movement_ids', '[]'::jsonb, 'stock_item_id', v_r.stock_item_id);
  ELSIF p_action = 'cancel' THEN
    UPDATE public.stock_room_requests
    SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(), version = version + 1
    WHERE id = v_r.id;
    RETURN jsonb_build_object('movement_ids', '[]'::jsonb, 'stock_item_id', v_r.stock_item_id);
  END IF;

  -- Delivery. Locks: the card, then source and target locations in id order (FOR SHARE).
  v_item := public.stock__item_for_move(p_clinic, v_r.stock_item_id);
  v_src := public.stock__default_location(p_clinic);
  PERFORM public.stock__location_active(p_clinic, l.id)
  FROM (SELECT DISTINCT x.id FROM unnest(ARRAY[v_src, v_r.location_id]) AS x(id) ORDER BY x.id) l;
  SELECT * INTO v_tgt FROM public.stock_locations l WHERE l.id = v_r.location_id AND l.clinic_id = p_clinic;
  IF v_tgt.kind NOT IN ('room', 'sterilization') OR v_tgt.is_default_warehouse THEN
    PERFORM public.stock__raise('E_RQ_LOCATION');
  END IF;
  IF v_tgt.id = v_src THEN
    PERFORM public.stock__raise('E_SAME_LOCATION');
  END IF;

  -- Quantity: the requested one, or a smaller delivered quantity.
  IF p_quantity IS NULL THEN
    v_qty := v_r.quantity;
  ELSE
    IF coalesce(p_quantity_unit, 'usage') = 'purchase' AND p_units_per_purchase IS NOT NULL
       AND p_units_per_purchase <> v_item.units_per_purchase THEN
      PERFORM public.stock__raise('E_UNIT_CHANGED');
    END IF;
    v_qty := public.stock__to_usage(public.stock__qty(p_quantity, false), p_quantity_unit, v_item.units_per_purchase);
    IF v_qty > v_r.quantity THEN
      PERFORM public.stock__raise('E_RQ_QTY');
    END IF;
  END IF;
  IF v_item.tracking_level = 'A' AND v_qty <> trunc(v_qty) THEN
    PERFORM public.stock__raise('E_QTY_INTEGER');
  END IF;

  -- Lots (RQ:54): A-level must name them; every id must be a batch of this card.
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[]) INTO v_batches
  FROM unnest(coalesce(p_batch_ids, '{}'::uuid[])) AS x(id)
  WHERE x.id IS NOT NULL;
  IF v_item.tracking_level = 'A' AND cardinality(v_batches) = 0 THEN
    PERFORM public.stock__raise('E_BATCH_REQUIRED');
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_batches) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM public.stock_batches b
                               WHERE b.id = x.id AND b.clinic_id = p_clinic AND b.stock_item_id = v_item.id)) THEN
    PERFORM public.stock__raise('E_BATCH');
  END IF;

  v_extra := jsonb_build_object('actor_user_id', p_actor, 'reason', 'Oda talebi #' || v_r.ref_no::text,
                                'request_id', v_r.id);
  IF cardinality(v_batches) = 0 THEN
    -- Plain FEFO over the source (unexpired lots only, expiry ascending, no expiry last, oldest receipt).
    v_ids := public.stock__allocate_out(p_clinic, p_op, v_item, 'transfer', v_qty, v_src, v_r.location_id, NULL,
                                        v_extra, p_today);
  ELSE
    -- The chosen lots, in FEFO order, their usable balance rows at the source locked FOR UPDATE.
    FOR r IN
      SELECT sb.batch_id, sb.quantity
      FROM public.stock_balances sb
      JOIN public.stock_batches b ON b.id = sb.batch_id
      WHERE sb.clinic_id = p_clinic AND sb.stock_item_id = v_item.id AND sb.location_id = v_src
        AND sb.batch_id = ANY (v_batches) AND sb.quantity > 0
        AND (b.expiry_date IS NULL OR b.expiry_date >= p_today)
      ORDER BY b.expiry_date ASC NULLS LAST, b.received_at, b.id
      FOR UPDATE OF sb
    LOOP
      v_bq := v_bq || r.batch_id;
      v_qq := v_qq || r.quantity::numeric;
      v_total := v_total + r.quantity;
    END LOOP;
    IF v_total < v_qty THEN
      PERFORM public.stock__raise('E_INSUFFICIENT', trim_scale(v_total)::text, trim_scale(v_total)::text);
    END IF;
    v_remaining := v_qty;
    FOR i IN 1 .. coalesce(array_length(v_bq, 1), 0) LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := least(v_remaining, v_qq[i]);
      v_ids := v_ids || public.stock__allocate_out(p_clinic, p_op, v_item, 'transfer', v_take, v_src, v_r.location_id,
                                                   v_bq[i], v_extra, p_today);
      v_remaining := round(v_remaining - v_take, 4);
    END LOOP;
  END IF;

  UPDATE public.stock_room_requests
  SET status = 'delivered', delivered_qty = v_qty, delivered_by = p_actor, delivered_at = now(),
      source_location_id = v_src, delivery_operation_key = p_op,
      approved_by = coalesce(approved_by, p_actor), approved_at = coalesce(approved_at, now()),
      version = version + 1
  WHERE id = v_r.id;

  PERFORM public.stock__sync_item(p_clinic, v_item.id);
  RETURN jsonb_build_object('movement_ids', v_ids, 'stock_item_id', v_item.id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Write RPCs (§5). SECURITY DEFINER, SET search_path = public, granted to authenticated by
--    stock__harden_privileges(). Skeleton: gate -> stock__op_begin (a replay returns the stored result) -> core ->
--    stock__op_finish. Stored results never contain cost keys; the UI re-reads the detail after a save.
-- ---------------------------------------------------------------------------

-- 8.1 Create (p_version NULL) or edit a pending order. Managers (O:23-25).
CREATE OR REPLACE FUNCTION public.stock_po_save(
  p_operation_key uuid,
  p_order_id uuid,
  p_version integer,
  p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
  v_order jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_po_save', jsonb_build_object(
    'order_id', p_order_id, 'version', p_version, 'order', p_order));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  v_order := public.stock__po_save_core(v_clinic, v_actor, p_order_id, p_version, p_order,
                                        public.stock_can_view_costs(), public.clinic_today());

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object('ok', true, 'order', v_order));
END;
$$;

-- 8.2 approve / mark_ordered / cancel / close (O:12-17, O:76-83).
CREATE OR REPLACE FUNCTION public.stock_po_transition(
  p_operation_key uuid,
  p_order_id uuid,
  p_version integer,
  p_action text,
  p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
  v_order jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_po_transition', jsonb_build_object(
    'order_id', p_order_id, 'version', p_version, 'action', p_action, 'reason', p_reason));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  v_order := public.stock__po_transition_core(v_clinic, v_actor, p_order_id, p_version, p_action, p_reason);

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object('ok', true, 'order', v_order));
END;
$$;

-- 8.3 Receive 1..20 rows of one order (one lot / serial of one line per row), all or nothing (MP:78-91).
--     p_version (optional, trailing): the order version the client saw; a newer one -> E_VERSION.
DROP FUNCTION IF EXISTS public.stock_po_receive(uuid, uuid, jsonb, text, text);
CREATE OR REPLACE FUNCTION public.stock_po_receive(
  p_operation_key uuid,
  p_order_id uuid,
  p_lines jsonb,
  p_document_no text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_version integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
  v_core jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_po_receive', jsonb_build_object(
    'order_id', p_order_id, 'lines', p_lines, 'document_no', p_document_no, 'reason', p_reason,
    'version', p_version));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  v_core := public.stock__po_receive_core(v_clinic, v_actor, p_operation_key, v_today, public.stock_can_view_costs(),
                                          p_order_id, p_lines, p_document_no, p_reason, p_version);

  RETURN public.stock__op_finish(v_clinic, p_operation_key,
    public.stock__move_result(v_clinic, p_operation_key, v_core -> 'movement_ids', v_today)
    || jsonb_build_object('order', public.stock__po_write_json(v_clinic, p_order_id)));
END;
$$;

-- 8.4 Room request (any operating role, RQ:5-27). Never changes stock.
CREATE OR REPLACE FUNCTION public.stock_room_request_create(
  p_operation_key uuid,
  p_request_id uuid,
  p_stock_item_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_quantity_unit text DEFAULT 'usage',
  p_units_per_purchase numeric DEFAULT NULL,
  p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_room_request_create', jsonb_build_object(
    'request_id', p_request_id, 'stock_item_id', p_stock_item_id, 'location_id', p_location_id,
    'quantity', p_quantity, 'quantity_unit', p_quantity_unit, 'units_per_purchase', p_units_per_purchase,
    'note', p_note));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  PERFORM public.stock__rq_create_core(v_clinic, v_actor, p_request_id, p_stock_item_id, p_location_id, p_quantity,
                                       p_quantity_unit, p_units_per_purchase, p_note);

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true,
    'request', public.stock__rq_json(v_clinic, p_request_id, v_actor, public.stock_can_manage(), true,
                                     public.clinic_today())));
END;
$$;

-- 8.5 approve / reject / deliver (managers) and cancel (the requester) (RQ:29-83).
CREATE OR REPLACE FUNCTION public.stock_room_request_action(
  p_operation_key uuid,
  p_request_id uuid,
  p_version integer,
  p_action text,
  p_reason text DEFAULT NULL,
  p_quantity numeric DEFAULT NULL,
  p_quantity_unit text DEFAULT 'usage',
  p_units_per_purchase numeric DEFAULT NULL,
  p_batch_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_manage boolean := public.stock_can_manage();
  v_operate boolean := public.stock_can_operate();
  v_prev jsonb;
  v_core jsonb;
  v_request jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_room_request_action', jsonb_build_object(
    'request_id', p_request_id, 'version', p_version, 'action', p_action, 'reason', p_reason,
    'quantity', p_quantity, 'quantity_unit', p_quantity_unit, 'units_per_purchase', p_units_per_purchase,
    'batch_ids', to_jsonb(p_batch_ids)));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  v_core := public.stock__rq_action_core(v_clinic, v_actor, p_operation_key, v_today, v_manage, p_request_id,
                                         p_version, p_action, p_reason, p_quantity, p_quantity_unit,
                                         p_units_per_purchase, p_batch_ids);
  v_request := public.stock__rq_json(v_clinic, p_request_id, v_actor, v_manage, v_operate, v_today);

  IF p_action = 'deliver' THEN
    RETURN public.stock__op_finish(v_clinic, p_operation_key,
      public.stock__move_result(v_clinic, p_operation_key, v_core -> 'movement_ids', v_today)
      || jsonb_build_object('request', v_request));
  END IF;
  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object('ok', true, 'request', v_request));
END;
$$;

-- 8.6 Settings (§5.6). A key is checked only when its value differs from the stored one, so a form that resends
-- unchanged values works for every role. Approval rule: owner role only. Payable keys: 'finance' holders only
-- (owner decision: an owner without the finance grant cannot turn the payable on).
CREATE OR REPLACE FUNCTION public.stock__save_settings_core(p_clinic uuid, p_actor uuid, p_owner boolean,
                                                            p_finance boolean, p_version integer, p_settings jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_actor uuid := p_actor;
  v_row public.stock_settings%ROWTYPE;
  v_rule boolean;
  v_enabled boolean;
  v_days integer;
  v_cat uuid;
  v_b boolean;
  v_num numeric;
  v_u uuid;
  v_owner boolean := coalesce(p_owner, false);
  v_fin boolean := coalesce(p_finance, false);
BEGIN
  IF p_settings IS NULL OR NOT public.stock__keys_ok(p_settings, ARRAY['po_creator_cannot_approve',
       'po_payable_enabled', 'po_payable_due_days', 'po_payable_category_id']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;

  -- The settings row (first save inserts it under a per-clinic advisory lock).
  PERFORM pg_advisory_xact_lock(hashtextextended('stock.settings:' || v_clinic::text, 0));
  SELECT * INTO v_row FROM public.stock_settings s WHERE s.clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    v_row := public.stock__settings(v_clinic);
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.stock__raise('E_VERSION');
  END IF;
  v_rule := v_row.po_creator_cannot_approve;
  v_enabled := v_row.po_payable_enabled;
  v_days := v_row.po_payable_due_days;
  v_cat := v_row.po_payable_category_id;

  IF p_settings ? 'po_creator_cannot_approve' THEN
    v_b := public.stock__j_bool(p_settings, 'po_creator_cannot_approve', 'E_SETTINGS');
    IF v_b IS NULL THEN
      PERFORM public.stock__raise('E_SETTINGS');
    END IF;
    IF v_b IS DISTINCT FROM v_rule THEN
      IF NOT v_owner THEN
        PERFORM public.stock__raise('E_SETTING_OWNER');
      END IF;
      v_rule := v_b;
    END IF;
  END IF;

  IF p_settings ? 'po_payable_enabled' THEN
    v_b := public.stock__j_bool(p_settings, 'po_payable_enabled', 'E_SETTINGS');
    IF v_b IS NULL THEN
      PERFORM public.stock__raise('E_SETTINGS');
    END IF;
    IF v_b IS DISTINCT FROM v_enabled THEN
      IF NOT v_fin THEN
        PERFORM public.stock__raise('E_FINANCE_SETTING');
      END IF;
      v_enabled := v_b;
    END IF;
  END IF;

  IF p_settings ? 'po_payable_due_days' THEN
    v_num := public.stock__j_num(p_settings, 'po_payable_due_days', 'E_SETTINGS');
    IF v_num IS NULL OR v_num <> trunc(v_num) OR v_num < 0 OR v_num > 365 THEN
      PERFORM public.stock__raise('E_SETTINGS');
    END IF;
    IF v_num::integer IS DISTINCT FROM v_days THEN
      IF NOT v_fin THEN
        PERFORM public.stock__raise('E_FINANCE_SETTING');
      END IF;
      v_days := v_num::integer;
    END IF;
  END IF;

  IF p_settings ? 'po_payable_category_id' THEN
    v_u := public.stock__j_uuid(p_settings, 'po_payable_category_id', 'E_PAYABLE_CATEGORY');
    IF v_u IS DISTINCT FROM v_cat THEN
      IF NOT v_fin THEN
        PERFORM public.stock__raise('E_FINANCE_SETTING');
      END IF;
      IF v_u IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.fin_categories c
        WHERE c.id = v_u AND c.clinic_id = v_clinic AND c.is_active AND c.direction = 'out'
          AND c.profit_class = 'expense'
      ) THEN
        PERFORM public.stock__raise('E_PAYABLE_CATEGORY');
      END IF;
      v_cat := v_u;
    END IF;
  END IF;

  -- Nothing changed (any staff member may resend the stored values): no write, no version bump, no audit row.
  IF (v_rule, v_enabled, v_days, v_cat) IS NOT DISTINCT FROM
     (v_row.po_creator_cannot_approve, v_row.po_payable_enabled, v_row.po_payable_due_days, v_row.po_payable_category_id)
  THEN
    RETURN;
  END IF;

  INSERT INTO public.stock_settings AS t (clinic_id, po_creator_cannot_approve, po_payable_enabled, po_payable_due_days,
                                         po_payable_category_id, version, updated_by, updated_at)
  VALUES (v_clinic, v_rule, v_enabled, v_days, v_cat, 1, v_actor, now())
  ON CONFLICT (clinic_id) DO UPDATE
    SET po_creator_cannot_approve = EXCLUDED.po_creator_cannot_approve,
        po_payable_enabled = EXCLUDED.po_payable_enabled,
        po_payable_due_days = EXCLUDED.po_payable_due_days,
        po_payable_category_id = EXCLUDED.po_payable_category_id,
        version = t.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_save_settings(
  p_operation_key uuid,
  p_version integer,
  p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_save_settings', jsonb_build_object(
    'version', p_version, 'settings', p_settings));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  PERFORM public.stock__save_settings_core(v_clinic, v_actor,
                                           coalesce(public.current_app_role()::text = 'owner', false),
                                           public.has_permission('finance'), p_version, p_settings);

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true, 'settings', public.stock__settings_json(v_clinic)));
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Read RPCs (§6). SECURITY DEFINER, STABLE, one jsonb value each, || stock__flags(). Filters are JSON objects;
--    unknown keys or wrong types -> E_FILTER; paging {offset, limit <= 200}.
-- ---------------------------------------------------------------------------

-- 9.1 Purchase order list (managers and cost viewers). Core (internal) + RPC.
CREATE OR REPLACE FUNCTION public.stock__po_list_core(p_clinic uuid, p_actor uuid, p_today date, p_cost boolean,
                                                      p_manage boolean, p_filters jsonb, p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_actor uuid := p_actor;
  v_today date := p_today;
  v_cost boolean := coalesce(p_cost, false);
  v_manage boolean := coalesce(p_manage, false);
  v_rule boolean;
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_supplier uuid;
  v_item uuid;
  v_q text;
  v_overdue boolean;
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
  v_counts jsonb;
BEGIN
  IF NOT public.stock__keys_ok(v_f, ARRAY['status', 'supplier_id', 'stock_item_id', 'q', 'overdue']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_status := coalesce(nullif(btrim(coalesce(public.stock__j_text(v_f, 'status', 'E_FILTER'), '')), ''), 'open');
  IF v_status NOT IN ('open', 'all', 'pending', 'approved', 'ordered', 'partially_received', 'received', 'cancelled') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_supplier := public.stock__j_uuid(v_f, 'supplier_id', 'E_FILTER');
  v_item := public.stock__j_uuid(v_f, 'stock_item_id', 'E_FILTER');
  v_q := nullif(public.stock__tr_lower(btrim(coalesce(public.stock__j_text(v_f, 'q', 'E_FILTER'), ''))), '');
  v_overdue := coalesce(public.stock__j_bool(v_f, 'overdue', 'E_FILTER'), false);
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;
  v_rule := (public.stock__settings(v_clinic)).po_creator_cannot_approve;

  WITH f AS (
    SELECT o.id, o.created_at, o.order_number
    FROM public.purchase_orders o
    JOIN public.suppliers s ON s.id = o.supplier_id
    WHERE o.clinic_id = v_clinic
      AND (CASE v_status
             WHEN 'open' THEN o.status IN ('pending', 'approved', 'ordered', 'partially_received')
             WHEN 'all' THEN true
             ELSE o.status = v_status END)
      AND (v_supplier IS NULL OR o.supplier_id = v_supplier)
      AND (v_item IS NULL OR EXISTS (SELECT 1 FROM public.purchase_order_items li
                                     WHERE li.order_id = o.id AND li.stock_item_id = v_item))
      AND (NOT v_overdue OR (o.expected_date < v_today AND o.status IN ('approved', 'ordered', 'partially_received')))
      AND (v_q IS NULL
           OR strpos(public.stock__tr_lower(o.order_number || ' ' || s.name), v_q) > 0
           OR EXISTS (SELECT 1 FROM public.purchase_order_items li
                      JOIN public.stock_items i ON i.id = li.stock_item_id
                      WHERE li.order_id = o.id
                        AND strpos(public.stock__tr_lower(concat_ws(' ', i.item_name, i.item_code)), v_q) > 0))
  ), p AS (
    SELECT f.id, row_number() OVER (ORDER BY f.created_at DESC, f.order_number DESC, f.id) AS rn FROM f
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(public.stock__po_row_json(v_clinic, p.id, v_actor, v_cost, v_manage, v_today, v_rule)
                                    ORDER BY p.rn)
                   FROM p WHERE p.rn > v_off AND p.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  SELECT jsonb_build_object(
           'pending', count(*) FILTER (WHERE o.status = 'pending'),
           'approved', count(*) FILTER (WHERE o.status = 'approved'),
           'ordered', count(*) FILTER (WHERE o.status = 'ordered'),
           'partially_received', count(*) FILTER (WHERE o.status = 'partially_received'),
           'received', count(*) FILTER (WHERE o.status = 'received'),
           'cancelled', count(*) FILTER (WHERE o.status = 'cancelled'),
           'overdue', count(*) FILTER (WHERE o.expected_date < v_today
                                         AND o.status IN ('approved', 'ordered', 'partially_received')))
    INTO v_counts
  FROM public.purchase_orders o
  WHERE o.clinic_id = v_clinic;

  RETURN jsonb_build_object('today', v_today, 'total', v_total, 'counts', v_counts, 'rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_po_list(p_filters jsonb DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_cost boolean := public.stock_can_view_costs();
  v_manage boolean := public.stock_can_manage();
BEGIN
  IF NOT (v_manage OR v_cost) THEN
    PERFORM public.stock__raise('E_PO_READ');
  END IF;
  RETURN public.stock__po_list_core(v_clinic, public.current_app_user_id(), public.clinic_today(), v_cost, v_manage,
                                    p_filters, p_page)
         || public.stock__flags();
END;
$$;

-- 9.2 Purchase order detail (managers and cost viewers).
CREATE OR REPLACE FUNCTION public.stock_po_detail(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_cost boolean := public.stock_can_view_costs();
  v_manage boolean := public.stock_can_manage();
BEGIN
  IF NOT (v_manage OR v_cost) THEN
    PERFORM public.stock__raise('E_PO_READ');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = p_order_id AND o.clinic_id = v_clinic) THEN
    PERFORM public.stock__raise('E_PO_NOT_FOUND');
  END IF;
  RETURN public.stock__po_json(v_clinic, p_order_id, v_actor, v_cost, v_manage, public.clinic_today())
         || public.stock__flags();
END;
$$;

-- 9.3 Reorder suggestions (§7; managers, SA:1470 / UP:43). Default scope 'critical' = legacy UP:45.
CREATE OR REPLACE FUNCTION public.stock__reorder_core(p_clinic uuid, p_today date, p_cost boolean, p_filters jsonb,
                                                      p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_today date := p_today;
  v_cost boolean := coalesce(p_cost, false);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_scope text;
  v_sup_text text;
  v_supplier uuid;
  v_none boolean := false;
  v_category text;
  v_level text;
  v_q text;
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
  v_groups jsonb;
BEGIN
  IF NOT public.stock__keys_ok(v_f, ARRAY['scope', 'supplier_id', 'category', 'tracking_level', 'q']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_scope := coalesce(nullif(btrim(coalesce(public.stock__j_text(v_f, 'scope', 'E_FILTER'), '')), ''), 'critical');
  IF v_scope NOT IN ('critical', 'below_max') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_sup_text := nullif(btrim(coalesce(public.stock__j_text(v_f, 'supplier_id', 'E_FILTER'), '')), '');
  IF v_sup_text = 'none' THEN
    v_none := true;
  ELSIF v_sup_text IS NOT NULL THEN
    v_supplier := public.stock__j_uuid(v_f, 'supplier_id', 'E_FILTER');
  END IF;
  v_category := nullif(btrim(coalesce(public.stock__j_text(v_f, 'category', 'E_FILTER'), '')), '');
  v_level := nullif(btrim(coalesce(public.stock__j_text(v_f, 'tracking_level', 'E_FILTER'), '')), '');
  IF v_level IS NOT NULL AND v_level NOT IN ('A', 'B', 'C') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_q := nullif(public.stock__tr_lower(btrim(coalesce(public.stock__j_text(v_f, 'q', 'E_FILTER'), ''))), '');
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH f AS (
    SELECT r.*,
           row_number() OVER (ORDER BY r.supplier_name COLLATE "tr-x-icu" ASC NULLS LAST, r.supplier_id,
                                       (r.state = 'out') DESC, r.item_name COLLATE "tr-x-icu", r.stock_item_id) AS rn,
           CASE WHEN r.last_unit_cost_cents IS NOT NULL
                THEN round(r.need_qty * r.last_unit_cost_cents)::bigint END AS est
    FROM public.stock__reorder_rows(v_clinic, v_today) r
    WHERE (v_scope = 'below_max' OR r.critical)
      AND (NOT v_none OR r.supplier_id IS NULL)
      AND (v_supplier IS NULL OR r.supplier_id = v_supplier)
      AND (v_category IS NULL OR r.category = v_category)
      AND (v_level IS NULL OR r.tracking_level = v_level)
      AND (v_q IS NULL OR strpos(r.search, v_q) > 0)
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(f.j || CASE WHEN v_cost THEN jsonb_build_object(
                                              'last_unit_cost_cents', f.last_unit_cost_cents, 'est_cost_cents', f.est)
                                            ELSE '{}'::jsonb END
                                    ORDER BY f.rn)
                   FROM f WHERE f.rn > v_off AND f.rn <= v_off + v_lim), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(g.j ORDER BY g.supplier_name COLLATE "tr-x-icu" ASC NULLS LAST, g.supplier_id)
                   FROM (
                     SELECT f.supplier_id, f.supplier_name,
                            jsonb_build_object('supplier_id', f.supplier_id, 'supplier_name', f.supplier_name,
                                               'items', count(*))
                            || CASE WHEN v_cost THEN jsonb_build_object(
                                 'est_cost_cents', coalesce(sum(f.est), 0),
                                 'uncosted_items', count(*) FILTER (WHERE f.est IS NULL))
                               ELSE '{}'::jsonb END AS j
                     FROM f
                     GROUP BY f.supplier_id, f.supplier_name
                   ) g), '[]'::jsonb)
    INTO v_total, v_rows, v_groups;

  RETURN jsonb_build_object('today', v_today, 'scope', v_scope, 'total', v_total, 'rows', v_rows,
                            'by_supplier', v_groups);
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_reorder_suggestions(p_filters jsonb DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
BEGIN
  RETURN public.stock__reorder_core(v_clinic, public.clinic_today(), public.stock_can_view_costs(), p_filters, p_page)
         || public.stock__flags();
END;
$$;

-- 9.4 Room requests (every staff member reads, D:79-94). Pending, approved, then the rest; newest first.
CREATE OR REPLACE FUNCTION public.stock__rq_list_core(p_clinic uuid, p_actor uuid, p_today date, p_manage boolean,
                                                      p_operate boolean, p_filters jsonb, p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_actor uuid := p_actor;
  v_today date := p_today;
  v_manage boolean := coalesce(p_manage, false);
  v_operate boolean := coalesce(p_operate, false);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_loc uuid;
  v_item uuid;
  v_mine boolean;
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
  v_counts jsonb;
BEGIN
  IF NOT public.stock__keys_ok(v_f, ARRAY['status', 'location_id', 'stock_item_id', 'mine']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_status := coalesce(nullif(btrim(coalesce(public.stock__j_text(v_f, 'status', 'E_FILTER'), '')), ''), 'open');
  IF v_status NOT IN ('open', 'all', 'pending', 'approved', 'delivered', 'rejected', 'cancelled') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_loc := public.stock__j_uuid(v_f, 'location_id', 'E_FILTER');
  v_item := public.stock__j_uuid(v_f, 'stock_item_id', 'E_FILTER');
  v_mine := coalesce(public.stock__j_bool(v_f, 'mine', 'E_FILTER'), false);
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH f AS (
    SELECT r.id, r.status, r.created_at
    FROM public.stock_room_requests r
    WHERE r.clinic_id = v_clinic
      AND (CASE v_status
             WHEN 'open' THEN r.status IN ('pending', 'approved')
             WHEN 'all' THEN true
             ELSE r.status = v_status END)
      AND (v_loc IS NULL OR r.location_id = v_loc)
      AND (v_item IS NULL OR r.stock_item_id = v_item)
      AND (NOT v_mine OR r.requested_by = v_actor)
  ), p AS (
    SELECT f.id,
           row_number() OVER (ORDER BY CASE f.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                                       f.created_at DESC, f.id) AS rn
    FROM f
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(public.stock__rq_json(v_clinic, p.id, v_actor, v_manage, v_operate, v_today)
                                    ORDER BY p.rn)
                   FROM p WHERE p.rn > v_off AND p.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  SELECT jsonb_build_object(
           'pending', count(*) FILTER (WHERE r.status = 'pending'),
           'approved', count(*) FILTER (WHERE r.status = 'approved'),
           'delivered', count(*) FILTER (WHERE r.status = 'delivered'),
           'rejected', count(*) FILTER (WHERE r.status = 'rejected'),
           'cancelled', count(*) FILTER (WHERE r.status = 'cancelled'))
    INTO v_counts
  FROM public.stock_room_requests r
  WHERE r.clinic_id = v_clinic
    AND (v_loc IS NULL OR r.location_id = v_loc)
    AND (v_item IS NULL OR r.stock_item_id = v_item)
    AND (NOT v_mine OR r.requested_by = v_actor);

  RETURN jsonb_build_object('today', v_today, 'total', v_total, 'counts', v_counts, 'rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_room_request_list(p_filters jsonb DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
BEGIN
  RETURN public.stock__rq_list_core(v_clinic, public.current_app_user_id(), public.clinic_today(),
                                    public.stock_can_manage(), public.stock_can_operate(), p_filters, p_page)
         || public.stock__flags();
END;
$$;

-- 9.5 Badge counts for the tab bar. purchase_orders only for PO readers.
CREATE OR REPLACE FUNCTION public.stock__work_counts_core(p_clinic uuid, p_today date, p_po_read boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_today date := p_today;
  v_out jsonb;
BEGIN
  SELECT jsonb_build_object('room_requests', jsonb_build_object(
           'pending', count(*) FILTER (WHERE r.status = 'pending'),
           'approved', count(*) FILTER (WHERE r.status = 'approved')))
    INTO v_out
  FROM public.stock_room_requests r
  WHERE r.clinic_id = v_clinic AND r.status IN ('pending', 'approved');

  IF coalesce(p_po_read, false) THEN
    v_out := v_out || (
      SELECT jsonb_build_object('purchase_orders', jsonb_build_object(
               'pending', count(*) FILTER (WHERE o.status = 'pending'),
               'approved', count(*) FILTER (WHERE o.status = 'approved'),
               'ordered', count(*) FILTER (WHERE o.status = 'ordered'),
               'partially_received', count(*) FILTER (WHERE o.status = 'partially_received'),
               'overdue', count(*) FILTER (WHERE o.expected_date < v_today
                                             AND o.status IN ('approved', 'ordered', 'partially_received'))))
      FROM public.purchase_orders o
      WHERE o.clinic_id = v_clinic AND o.status IN ('pending', 'approved', 'ordered', 'partially_received'));
  END IF;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_work_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
BEGIN
  RETURN public.stock__work_counts_core(v_clinic, public.clinic_today(),
                                        public.stock_can_manage() OR public.stock_can_view_costs())
         || public.stock__flags();
END;
$$;

-- 9.6 Settings (every staff member reads; the payable category only for finance readers).
CREATE OR REPLACE FUNCTION public.stock_settings_get()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
BEGIN
  RETURN public.stock__settings_json(v_clinic) || public.stock__flags();
END;
$$;

-- 9.7 Period consumption report (§10; managers and cost viewers, RP:4-15). Effective movements: clinic-local
-- effective_at day range, correction reversals and corrected originals excluded, re-entries counted on the original
-- business time. Count differences in their own columns; room deliveries informational (transfers are not
-- consumption). Cost keys only for cost viewers (batch cost of each movement; NULL cost adds nothing and is counted
-- in uncosted_rows); rounded once per card, totals = sum of the card values.
CREATE OR REPLACE FUNCTION public.stock__consumption_core(p_clinic uuid, p_cost boolean, p_from text, p_to text,
                                                          p_filters jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := p_clinic;
  v_cost boolean := coalesce(p_cost, false);
  v_from date;
  v_to date;
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_category text;
  v_level text;
  v_loc uuid;
  v_item uuid;
  v_rows jsonb;
  v_groups jsonb;
  v_totals jsonb;
BEGIN
  v_from := public.stock__day(p_from);
  v_to := public.stock__day(p_to);
  IF v_from > v_to OR v_to - v_from > 366 THEN
    PERFORM public.stock__raise('E_DATE_RANGE');
  END IF;
  IF NOT public.stock__keys_ok(v_f, ARRAY['category', 'tracking_level', 'location_id', 'stock_item_id']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_category := nullif(btrim(coalesce(public.stock__j_text(v_f, 'category', 'E_FILTER'), '')), '');
  v_level := nullif(btrim(coalesce(public.stock__j_text(v_f, 'tracking_level', 'E_FILTER'), '')), '');
  IF v_level IS NOT NULL AND v_level NOT IN ('A', 'B', 'C') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_loc := public.stock__j_uuid(v_f, 'location_id', 'E_FILTER');
  v_item := public.stock__j_uuid(v_f, 'stock_item_id', 'E_FILTER');

  WITH mv AS (
    SELECT m.stock_item_id, m.movement_type, m.quantity, m.po_item_id, m.from_location_id, m.to_location_id,
           (m.movement_type = 'transfer' AND coalesce(m.request_id, src.request_id) IS NOT NULL) AS is_delivery,
           bc.unit_cost_cents AS cost
    FROM public.stock_movements m
    JOIN public.stock_items i ON i.id = m.stock_item_id
    LEFT JOIN public.stock_movements src
      ON src.id = m.source_movement_id AND m.correction_request_id IS NOT NULL AND m.movement_type = 'transfer'
    LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id AND v_cost
    WHERE m.clinic_id = v_clinic
      AND m.effective_at >= (v_from::timestamp AT TIME ZONE 'Europe/Istanbul')
      AND m.effective_at < ((v_to + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')
      AND m.movement_type <> 'correction_reversal'
      AND NOT EXISTS (SELECT 1 FROM public.stock_correction_requests cr
                      WHERE cr.movement_id = m.id AND cr.status = 'approved')
      AND (v_item IS NULL OR m.stock_item_id = v_item)
      AND (v_category IS NULL OR i.category = v_category)
      AND (v_level IS NULL OR i.tracking_level = v_level)
  ), e AS (
    SELECT mv.*
    FROM mv
    WHERE (mv.movement_type IN ('opening', 'receive', 'issue', 'return', 'waste', 'adjust_in', 'adjust_out')
           OR mv.is_delivery)
      AND (v_loc IS NULL
           OR CASE WHEN mv.movement_type IN ('opening', 'receive', 'return', 'adjust_in', 'transfer')
                   THEN mv.to_location_id = v_loc
                   ELSE mv.from_location_id = v_loc END)
  ), a AS (
    SELECT e.stock_item_id,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'opening'), 0) AS opening,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'receive'), 0) AS received,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'receive' AND e.po_item_id IS NOT NULL), 0) AS received_po,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'issue'), 0) AS used,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'return'), 0) AS returned,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'waste'), 0) AS waste,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'adjust_in'), 0) AS adj_in,
           coalesce(sum(e.quantity) FILTER (WHERE e.movement_type = 'adjust_out'), 0) AS adj_out,
           coalesce(sum(e.quantity) FILTER (WHERE e.is_delivery), 0) AS room,
           (round(coalesce(sum(e.quantity * e.cost) FILTER (WHERE e.movement_type = 'receive'), 0)))::bigint
             AS received_cost,
           (round(coalesce(sum(e.quantity * e.cost) FILTER (WHERE e.movement_type = 'issue'), 0)
                  - coalesce(sum(e.quantity * e.cost) FILTER (WHERE e.movement_type = 'return'), 0)))::bigint
             AS net_used_cost,
           (round(coalesce(sum(e.quantity * e.cost) FILTER (WHERE e.movement_type = 'waste'), 0)))::bigint AS waste_cost,
           (round(coalesce(sum(e.quantity * e.cost) FILTER (WHERE e.movement_type = 'adjust_in'), 0)
                  - coalesce(sum(e.quantity * e.cost) FILTER (WHERE e.movement_type = 'adjust_out'), 0)))::bigint
             AS adjust_cost,
           (count(*) FILTER (WHERE e.cost IS NULL AND e.movement_type IN ('receive', 'issue', 'return', 'waste',
                                                                           'adjust_in', 'adjust_out')))::bigint
             AS uncosted
    FROM e
    GROUP BY e.stock_item_id
  ), j AS (
    SELECT a.*, i.item_code, i.item_name, i.category, i.tracking_level, i.usage_unit, i.purchase_unit,
           i.units_per_purchase
    FROM a
    JOIN public.stock_items i ON i.id = a.stock_item_id
  )
  SELECT
    coalesce((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'stock_item_id', j.stock_item_id, 'item_code', j.item_code, 'item_name', j.item_name,
                 'category', j.category, 'tracking_level', j.tracking_level, 'usage_unit', j.usage_unit,
                 'purchase_unit', j.purchase_unit, 'units_per_purchase', public.stock__q(j.units_per_purchase),
                 'opening_qty', public.stock__q(j.opening), 'received_qty', public.stock__q(j.received),
                 'received_po_qty', public.stock__q(j.received_po), 'used_qty', public.stock__q(j.used),
                 'returned_qty', public.stock__q(j.returned), 'net_used_qty', public.stock__q(j.used - j.returned),
                 'waste_qty', public.stock__q(j.waste), 'adjust_in_qty', public.stock__q(j.adj_in),
                 'adjust_out_qty', public.stock__q(j.adj_out), 'adjust_net_qty', public.stock__q(j.adj_in - j.adj_out),
                 'room_delivery_qty', public.stock__q(j.room))
               || CASE WHEN v_cost THEN jsonb_build_object(
                    'received_cost_cents', j.received_cost, 'net_used_cost_cents', j.net_used_cost,
                    'waste_cost_cents', j.waste_cost, 'adjust_net_cost_cents', j.adjust_cost,
                    'uncosted_rows', j.uncosted)
                  ELSE '{}'::jsonb END
               ORDER BY j.item_name COLLATE "tr-x-icu", j.stock_item_id)
      FROM j), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(g.v ORDER BY g.category COLLATE "tr-x-icu")
      FROM (
        SELECT coalesce(j.category, '') AS category,
               jsonb_build_object('category', coalesce(j.category, ''), 'items', count(*))
               || CASE WHEN v_cost THEN jsonb_build_object(
                    'received_cost_cents', sum(j.received_cost), 'net_used_cost_cents', sum(j.net_used_cost),
                    'waste_cost_cents', sum(j.waste_cost), 'adjust_net_cost_cents', sum(j.adjust_cost),
                    'uncosted_rows', sum(j.uncosted))
                  ELSE '{}'::jsonb END AS v
        FROM j
        GROUP BY coalesce(j.category, '')
      ) g), '[]'::jsonb),
    (SELECT jsonb_build_object('items', count(*))
            || CASE WHEN v_cost THEN jsonb_build_object(
                 'received_cost_cents', coalesce(sum(j.received_cost), 0),
                 'net_used_cost_cents', coalesce(sum(j.net_used_cost), 0),
                 'waste_cost_cents', coalesce(sum(j.waste_cost), 0),
                 'adjust_net_cost_cents', coalesce(sum(j.adjust_cost), 0),
                 'uncosted_rows', coalesce(sum(j.uncosted), 0))
               ELSE '{}'::jsonb END
     FROM j)
    INTO v_rows, v_groups, v_totals;

  RETURN jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows, 'by_category', v_groups, 'totals', v_totals);
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_consumption_report(p_from text, p_to text, p_filters jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_cost boolean := public.stock_can_view_costs();
BEGIN
  IF NOT (public.stock_can_manage() OR v_cost) THEN
    PERFORM public.stock__raise('E_REPORT_READ');
  END IF;
  RETURN public.stock__consumption_core(v_clinic, v_cost, p_from, p_to, p_filters) || public.stock__flags();
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. stock__purge_test_clinic (same signature and rules: editor only, slugs 'p<n>-test-...'): the new tables in
--     foreign-key order (constraints deferred as before). purchase_orders.fin_entry_id points INTO finance, so
--     deleting orders first never blocks; the acceptance clean-up removes the clinic's fin_* rows afterwards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock__purge_test_clinic(p_clinic uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_slug text;
  v_t text;
  v_n bigint;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.stock__is_editor() THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  SELECT c.slug INTO v_slug FROM public.clinics c WHERE c.id = p_clinic;
  IF v_slug IS NULL THEN
    RETURN jsonb_build_object('clinic_id', p_clinic, 'found', false);
  END IF;
  IF v_slug !~ '^p[0-9]+-test-' THEN
    RAISE EXCEPTION 'stock__purge_test_clinic yalnızca test klinikleri için çalışır (slug p<n>-test-...): %', v_slug;
  END IF;

  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  FOREACH v_t IN ARRAY ARRAY['user_favorite_items', 'stock_counts', 'stock_correction_requests', 'stock_movements',
                             'purchase_order_item_costs', 'purchase_order_items', 'purchase_orders',
                             'stock_room_requests', 'stock_po_counters', 'stock_settings',
                             'stock_balances', 'stock_batch_costs', 'stock_batches', 'stock_item_costs',
                             'stock_product_requests', 'stock_operations', 'stock_items', 'suppliers',
                             'stock_locations']
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE clinic_id = $1', v_t) USING p_clinic;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_out := v_out || jsonb_build_object(v_t, v_n);
  END LOOP;
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  RETURN jsonb_build_object('clinic_id', p_clinic, 'found', true, 'deleted', v_out);
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. stock__harden_privileges (same body as 0024 plus the Phase 8 tables): revokes EXECUTE on every stock_*
--     function from PUBLIC / anon / authenticated, grants the single-underscore RPCs to authenticated, never the
--     internals, keeps stock__purge_test_clinic for service_role, refuses overloads, non-definer RPCs and definer
--     internals (only trigger functions may be definer), and checks the table privileges.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock__harden_privileges()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_f record;
  v_bad text;
BEGIN
  FOR v_f IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'stock\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_f.sig);
    IF v_f.proname NOT LIKE 'stock\_\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_f.sig);
    END IF;
  END LOOP;
  -- The test clean-up runs through the API with the service role key (never anon / authenticated).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.stock__purge_test_clinic(uuid) TO service_role;
  END IF;

  -- No overloads (contract §1.3).
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'stock\_%'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stock_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- Every public RPC is SECURITY DEFINER with search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'stock\_%' AND p.proname NOT LIKE 'stock\_\_%'
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  -- Internals fail closed: only trigger functions may be SECURITY DEFINER.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'stock\_\_%'
    AND p.prosecdef AND p.prorettype <> 'trigger'::regtype;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç fonksiyonlar SECURITY DEFINER olmamalı: %', v_bad;
  END IF;

  -- No internal is callable from the API, and anon can call nothing.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'stock\_%'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR (p.proname LIKE 'stock\_\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç stok fonksiyonları API''ye açık: %', v_bad;
  END IF;

  -- Tables: SELECT only for authenticated, nothing for anon (no column privileges either); stock_operations and
  -- (Phase 8) stock_po_counters none.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['stock_locations', 'suppliers', 'stock_items', 'stock_item_costs', 'stock_batches',
                    'stock_batch_costs', 'stock_balances', 'stock_movements', 'stock_counts',
                    'stock_correction_requests', 'stock_product_requests', 'user_favorite_items',
                    'stock_transactions', 'stock_settings', 'purchase_orders', 'purchase_order_items',
                    'purchase_order_item_costs', 'stock_room_requests']) AS t(tbl)
  WHERE has_table_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_any_column_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE')
     OR has_table_privilege('anon', format('public.%I', t.tbl), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', t.tbl), 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Stok tablo yetkileri beklenen gibi değil: %', v_bad;
  END IF;
  IF has_table_privilege('authenticated', 'public.stock_operations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.stock_operations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'stock_operations istemcilere açık.';
  END IF;
  IF has_table_privilege('authenticated', 'public.stock_po_counters', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.stock_po_counters', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_any_column_privilege('authenticated', 'public.stock_po_counters', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION 'stock_po_counters istemcilere açık.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 12a. DDL on busy 0024 tables, last (short lock window; lock_timeout above). Until COMMIT these hold strong locks on
--      stock_movements, stock_items, suppliers, stock_locations, stock_correction_requests and audit_logs.
-- ---------------------------------------------------------------------------

-- Ledger hooks (0024 columns stock_movements.po_item_id / request_id). Every existing row has NULL in both (the
--     preflight checked it), so the constraints are added valid. A correction re-entry never carries these columns:
--     PO receipts cannot be corrected (E_CORR_ORDER) and stock__resolve_core writes re-entries without request_id.
SELECT public.stock__add_constraint('stock_movements', 'stock_movements_po_item_fkey',
  'FOREIGN KEY (clinic_id, po_item_id) REFERENCES public.purchase_order_items (clinic_id, id)', false);
SELECT public.stock__add_constraint('stock_movements', 'stock_movements_request_fkey',
  'FOREIGN KEY (clinic_id, request_id) REFERENCES public.stock_room_requests (clinic_id, id)', false);
SELECT public.stock__add_constraint('stock_movements', 'stock_movements_po_receive_only',
  'CHECK (po_item_id IS NULL OR movement_type = ''receive'')', false);
SELECT public.stock__add_constraint('stock_movements', 'stock_movements_request_transfer_only',
  'CHECK (request_id IS NULL OR movement_type = ''transfer'')', false);
CREATE INDEX IF NOT EXISTS stock_movements_po_item ON public.stock_movements (po_item_id) WHERE po_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_request ON public.stock_movements (request_id) WHERE request_id IS NOT NULL;

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(e.con, ', ')
    INTO v_missing
  FROM unnest(ARRAY['stock_movements_po_item_fkey', 'stock_movements_request_fkey', 'stock_movements_po_receive_only',
                    'stock_movements_request_transfer_only']) AS e(con)
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.stock_movements'::regclass AND c.conname = e.con);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stock_movements üzerinde beklenen kısıtlar yok: %', v_missing;
  END IF;
END $$;

-- Open-reference triggers (§3.6) on the 0024 tables.
DROP TRIGGER IF EXISTS stock_items_open_refs ON public.stock_items;
CREATE TRIGGER stock_items_open_refs
  BEFORE UPDATE OF is_active, needs_review ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_item_open_refs();

DROP TRIGGER IF EXISTS stock_supplier_open_refs ON public.suppliers;
CREATE TRIGGER stock_supplier_open_refs
  BEFORE UPDATE OF is_active ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_supplier_open_refs();

DROP TRIGGER IF EXISTS stock_location_open_refs ON public.stock_locations;
CREATE TRIGGER stock_location_open_refs
  BEFORE UPDATE OF is_active, kind ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_location_open_refs();

-- A PO receipt can never be corrected (E_CORR_ORDER): refuse the request itself instead of leaving a dead-end
-- request that a manager can only reject. The SQL editor / service role passes (self-check below).
DROP TRIGGER IF EXISTS stock_corr_po_link ON public.stock_correction_requests;
CREATE TRIGGER stock_corr_po_link
  BEFORE INSERT ON public.stock_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_corr_po_link();

-- Audit cost gate (spec §3.7): also hides purchase_order_item_costs rows from non cost viewers.
DROP POLICY IF EXISTS "audit_logs_stock_cost_guard" ON public.audit_logs;
CREATE POLICY "audit_logs_stock_cost_guard" ON public.audit_logs
  AS RESTRICTIVE
  FOR SELECT
  USING (
    entity_type NOT IN ('stock_item_costs', 'stock_batch_costs', 'purchase_order_item_costs')
    OR (SELECT public.stock_can_view_costs())
  );

SELECT public.stock__harden_privileges();

-- ---------------------------------------------------------------------------
-- 12. Self-checks (§11.3). Any failure RAISEs and rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_n bigint;
  v_last_name text;
  v_last_type text;
BEGIN
  -- 1. RLS on, exactly one permissive SELECT policy for authenticated and no write policy on the five client-readable
  --    tables; stock_po_counters RLS on without any policy; the audit cost gate RESTRICTIVE and naming
  --    purchase_order_item_costs.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['stock_settings', 'purchase_orders', 'purchase_order_items', 'purchase_order_item_costs',
                    'stock_room_requests']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd = 'SELECT'
                      AND p.permissive = 'PERMISSIVE' AND p.roles = ARRAY['authenticated']::name[]
                      AND p.qual ILIKE '%current_clinic_id%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: RLS / politika yapısı beklenen gibi değil: %', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'purchase_order_item_costs'
                   AND p.qual ILIKE '%stock_can_view_costs%')
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'purchase_order_item_costs'
                  AND p.qual ILIKE '%stock_can_manage%')
     OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'purchase_orders'
                      AND p.qual ILIKE '%stock_can_manage%' AND p.qual ILIKE '%stock_can_view_costs%') THEN
    RAISE EXCEPTION 'Öz denetim: sipariş tablolarının maliyet / yönetim kapısı beklenen gibi değil.';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.stock_po_counters'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'stock_po_counters') THEN
    RAISE EXCEPTION 'Öz denetim: stock_po_counters RLS açık ve politikasız olmalı.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs'
                   AND p.policyname = 'audit_logs_stock_cost_guard' AND p.permissive = 'RESTRICTIVE'
                   AND p.cmd = 'SELECT' AND p.qual ILIKE '%purchase_order_item_costs%'
                   AND p.qual ILIKE '%stock_batch_costs%' AND p.qual ILIKE '%stock_item_costs%') THEN
    RAISE EXCEPTION 'Öz denetim: audit_logs_stock_cost_guard purchase_order_item_costs satırlarını gizlemiyor.';
  END IF;

  -- 2. stock__receive_line: one version, 19 arguments, the last one p_po_item uuid with a default.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'stock__receive_line';
  SELECT p.proargnames[array_upper(p.proargnames, 1)], format_type(p.proargtypes[p.pronargs - 1], NULL)
    INTO v_last_name, v_last_type
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'stock__receive_line';
  IF v_n <> 1 OR v_last_name IS DISTINCT FROM 'p_po_item' OR v_last_type IS DISTINCT FROM 'uuid'
     OR (SELECT p.pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'stock__receive_line') <> 19 THEN
    RAISE EXCEPTION 'Öz denetim: stock__receive_line imzası beklenen gibi değil (% sürüm, son parametre % %).',
      v_n, v_last_name, v_last_type;
  END IF;

  -- 3. Every Phase 8 RPC exists (and the harden function already checked definer / grants / no overloads).
  SELECT string_agg(f.fn, ', ') INTO v_bad
  FROM unnest(ARRAY['stock_po_save', 'stock_po_transition', 'stock_po_receive', 'stock_po_list', 'stock_po_detail',
                    'stock_reorder_suggestions', 'stock_room_request_create', 'stock_room_request_action',
                    'stock_room_request_list', 'stock_work_counts', 'stock_settings_get', 'stock_save_settings',
                    'stock_consumption_report']) AS f(fn)
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = f.fn AND p.prosecdef
                      AND has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: Faz 8 RPC''leri eksik veya yetkisiz: %', v_bad;
  END IF;

  -- 4. Guard / open-reference / audit / TRUNCATE triggers are wired.
  SELECT string_agg(e.tbl || '.' || e.tg, ', ') INTO v_bad
  FROM (VALUES
    ('purchase_orders', 'stock_po_guard'), ('purchase_order_items', 'stock_po_item_guard'),
    ('stock_correction_requests', 'stock_corr_po_link'),
    ('stock_room_requests', 'stock_rq_guard'), ('stock_items', 'stock_items_open_refs'),
    ('suppliers', 'stock_supplier_open_refs'), ('stock_locations', 'stock_location_open_refs'),
    ('stock_settings', 'audit_row_change'), ('purchase_orders', 'audit_row_change'),
    ('purchase_order_items', 'audit_row_change'), ('purchase_order_item_costs', 'audit_row_change'),
    ('stock_room_requests', 'audit_row_change'),
    ('purchase_orders', 'stock_no_truncate'), ('purchase_order_items', 'stock_no_truncate'),
    ('purchase_order_item_costs', 'stock_no_truncate'), ('stock_room_requests', 'stock_no_truncate'),
    ('stock_po_counters', 'stock_no_truncate'), ('stock_settings', 'stock_no_truncate')
  ) AS e(tbl, tg)
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = format('public.%I', e.tbl)::regclass AND t.tgname = e.tg AND NOT t.tgisinternal);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: tetikleyiciler eksik: %', v_bad;
  END IF;

  -- 5. Ledger invariant (0024 §8.3-2): every balance equals sum(in) - sum(out) of its movements.
  SELECT count(*) INTO v_n
  FROM public.stock_balances b
  FULL JOIN (
    SELECT y.batch_id, y.loc, sum(y.q) AS q
    FROM (
      SELECT m.batch_id, m.to_location_id AS loc, m.quantity AS q
      FROM public.stock_movements m WHERE m.to_location_id IS NOT NULL
      UNION ALL
      SELECT m.batch_id, m.from_location_id, -m.quantity
      FROM public.stock_movements m WHERE m.from_location_id IS NOT NULL
    ) y
    GROUP BY y.batch_id, y.loc
  ) x ON x.batch_id = b.batch_id AND x.loc = b.location_id
  WHERE coalesce(b.quantity, 0) <> coalesce(x.q, 0);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Öz denetim: % bakiye satırı hareket defteriyle uyuşmuyor.', v_n;
  END IF;

  -- 6. Pure helpers.
  IF public.stock__po_qty_label(900, 100, 'adet', 'kutu') <> '9 kutu'
     OR public.stock__po_qty_label(905, 100, 'adet', 'kutu') <> '905 adet'
     OR public.stock__po_qty_label(17, 1, 'adet', 'adet') <> '17 adet'
     OR public.stock__po_qty_label(2.5, 1, 'adet', 'adet') <> '2,5 adet'
     OR public.stock__po_remaining('ordered', 900, 400) <> 500
     OR public.stock__po_remaining('received', 900, 400) <> 0
     OR NOT public.stock__po_self_blocked(true, 'a0000000-0000-0000-0000-000000000001'::uuid,
                                          'a0000000-0000-0000-0000-000000000001'::uuid, '{}'::uuid[])
     OR NOT public.stock__po_self_blocked(true, 'a0000000-0000-0000-0000-000000000002'::uuid,
                                          'a0000000-0000-0000-0000-000000000001'::uuid,
                                          ARRAY['a0000000-0000-0000-0000-000000000002'::uuid,
                                                'a0000000-0000-0000-0000-000000000004'::uuid])
     OR public.stock__po_self_blocked(true, 'a0000000-0000-0000-0000-000000000003'::uuid,
                                      'a0000000-0000-0000-0000-000000000001'::uuid,
                                      ARRAY['a0000000-0000-0000-0000-000000000002'::uuid])
     OR public.stock__po_self_blocked(true, 'a0000000-0000-0000-0000-000000000003'::uuid,
                                      'a0000000-0000-0000-0000-000000000001'::uuid, NULL)
     OR public.stock__po_self_blocked(false, 'a0000000-0000-0000-0000-000000000001'::uuid,
                                      'a0000000-0000-0000-0000-000000000001'::uuid, NULL)
     OR public.stock__po_day('', NULL) IS NOT NULL
     OR public.stock__po_day('2026-10-20', DATE '2026-10-15') <> DATE '2026-10-20'
     OR (public.stock__po_actions('pending', true, true) ->> 'approve_blocked') IS DISTINCT FROM 'self'
     OR (public.stock__po_actions('pending', true, true) ->> 'can_approve')::boolean
     OR NOT (public.stock__po_actions('partially_received', true, false) ->> 'can_close')::boolean
     OR (public.stock__po_actions('ordered', false, false) ->> 'can_receive')::boolean THEN
    RAISE EXCEPTION 'Öz denetim: sipariş yardımcıları beklenen değerleri vermiyor.';
  END IF;

  -- 7. The Phase 8 error keys are present in stock__raise (a later re-run of 0024 would silently drop them).
  BEGIN
    PERFORM public.stock__raise('E_PO_READ');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_last_name = PG_EXCEPTION_HINT, v_last_type = MESSAGE_TEXT;
  END;
  IF v_last_name IS DISTINCT FROM 'E_PO_READ' OR v_last_type IS DISTINCT FROM 'Satın alma kayıtlarını görme yetkiniz yok.' THEN
    RAISE EXCEPTION 'Öz denetim: stock__raise Faz 8 anahtarlarını tanımıyor (%: %).', v_last_name, v_last_type;
  END IF;
END $$;

-- 13. Replay through the internal cores with a fixed day, inside a block that is always rolled back (0024 §7 / 8
--     pattern). Uses the first clinic and its first user; skipped when there is none. Covers: suggestion (factor 10,
--     MIN 20, MAX 100, usable 15 -> 9 packs = 90), gapless numbers, the approval rule, the open quantity, a receipt
--     at the order price by a non cost viewer, E_PO_OVER, short close + payable state, a room request delivered by
--     FEFO transfer, the refused correction of a PO receipt, the guard trigger, and every read core once.
DO $$
DECLARE
  v_today date := DATE '2026-10-15';
  v_clinic uuid;
  v_user uuid;
  v_loc uuid;
  v_sup uuid := gen_random_uuid();
  v_room uuid := gen_random_uuid();
  v_card uuid := gen_random_uuid();
  v_po_a uuid := gen_random_uuid();
  v_po_b uuid := gen_random_uuid();
  v_po_c uuid := gen_random_uuid();
  v_rq uuid := gen_random_uuid();
  v_rq2 uuid := gen_random_uuid();
  v_rq3 uuid := gen_random_uuid();
  v_req uuid := gen_random_uuid();
  v_tag text;
  v_payable_on boolean;
  v_res jsonb;
  v_line uuid;
  v_seq_a integer;
  v_seq_b integer;
  v_num text;
  v_ver integer;
  v_op uuid;
  v_mid uuid;
  v_txt text;
  v_hint text;
  v_msg text;
  v_detail text;
  v_q numeric;
  v_n bigint;
  v_state text;
  v_ref bigint;
  v_fail text[] := '{}'::text[];
BEGIN
  SELECT c.id INTO v_clinic FROM public.clinics c ORDER BY c.created_at, c.id LIMIT 1;
  IF v_clinic IS NULL THEN
    RETURN;
  END IF;
  SELECT u.id INTO v_user FROM public.users u WHERE u.clinic_id = v_clinic ORDER BY u.created_at, u.id LIMIT 1;
  IF v_user IS NULL THEN
    RETURN;
  END IF;
  v_tag := upper(left(replace(v_card::text, '-', ''), 12));

  BEGIN
    v_payable_on := (public.stock__settings(v_clinic)).po_payable_enabled;
    v_loc := public.stock__default_location(v_clinic);
    INSERT INTO public.suppliers (id, clinic_id, name, name_key)
    VALUES (v_sup, v_clinic, 'ZZ Öz denetim tedarikçi ' || v_tag,
            public.stock__tr_lower('ZZ Öz denetim tedarikçi ' || v_tag));
    INSERT INTO public.stock_locations (id, clinic_id, name, name_key, kind)
    VALUES (v_room, v_clinic, 'ZZ Öz denetim oda ' || v_tag, public.stock__tr_lower('ZZ Öz denetim oda ' || v_tag), 'room');
    INSERT INTO public.stock_items (id, clinic_id, item_code, item_name, category, unit_price, quantity_minimum,
                                    tracking_level, purchase_unit, usage_unit, units_per_purchase, min_qty, max_qty,
                                    supplier_id)
    VALUES (v_card, v_clinic, 'ZZ-OZD-P8-' || v_tag, 'Öz denetim P8', 'materials', 0, 0, 'C', 'kutu', 'adet', 10, 20,
            100, v_sup);

    -- Receipt of 15 without an order (18 positional arguments -> the p_po_item default).
    PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_card, v_loc, 15, 'usage',
      NULL, NULL, NULL, NULL, NULL, 'usage', NULL, NULL, NULL);

    -- Suggestion: 100 - 15 - 0 = 85 -> 9 packs -> 90, critical (15 <= 20).
    SELECT r.need_qty, r.state, r.j ->> 'need_packs' INTO v_q, v_state, v_txt
    FROM public.stock__reorder_rows(v_clinic, v_today) r WHERE r.stock_item_id = v_card;
    IF v_q IS DISTINCT FROM 90 OR v_state IS DISTINCT FROM 'critical' OR v_txt IS DISTINCT FROM '9' THEN
      v_fail := array_append(v_fail, format('Öneri: %s / %s / %s', v_q, v_state, v_txt));
    END IF;
    v_res := public.stock__reorder_core(v_clinic, v_today, true, jsonb_build_object('supplier_id', v_sup), NULL);
    IF (v_res ->> 'total')::integer <> 1 OR (v_res -> 'rows' -> 0 ->> 'need_qty') IS DISTINCT FROM '90'
       OR (v_res -> 'by_supplier' -> 0 ->> 'uncosted_items') IS DISTINCT FROM '1' THEN
      v_fail := array_append(v_fail, 'Öneri RPC çekirdeği: ' || coalesce(v_res::text, '-'));
    END IF;

    -- Order A (9 kutu = 90 at 500 per adet) and order B: consecutive numbers.
    v_res := public.stock__po_save_core(v_clinic, v_user, v_po_a, NULL, jsonb_build_object(
      'supplier_id', v_sup, 'note', 'Öz denetim',
      'lines', jsonb_build_array(jsonb_build_object('stock_item_id', v_card, 'quantity', 9, 'quantity_unit', 'purchase',
                                                    'units_per_purchase', 10, 'unit_price_cents', 500))), true, v_today);
    v_line := (v_res -> 'lines' -> 0 ->> 'id')::uuid;
    IF (v_res -> 'lines' -> 0 ->> 'qty_ordered') IS DISTINCT FROM '90' OR v_res ->> 'status' <> 'pending'
       OR (v_res ->> 'version')::integer <> 1 OR v_res::text LIKE '%cents%' THEN
      v_fail := array_append(v_fail, 'Sipariş A: ' || v_res::text);
    END IF;
    PERFORM public.stock__po_save_core(v_clinic, v_user, v_po_b, NULL, jsonb_build_object(
      'supplier_id', v_sup,
      'lines', jsonb_build_array(jsonb_build_object('stock_item_id', v_card, 'quantity', 1))), false, v_today);
    SELECT o.order_seq, o.order_number INTO v_seq_a, v_num FROM public.purchase_orders o WHERE o.id = v_po_a;
    SELECT o.order_seq INTO v_seq_b FROM public.purchase_orders o WHERE o.id = v_po_b;
    IF v_seq_b IS DISTINCT FROM v_seq_a + 1 OR v_num !~ '^SP-[0-9]{4}-[0-9]{4,}$' OR v_num NOT LIKE 'SP-2026-%' THEN
      v_fail := array_append(v_fail, format('Sipariş numarası: %s / %s / %s', v_seq_a, v_seq_b, v_num));
    END IF;

    -- Edit of the pending order B (cost viewer): lines replaced, price stored, content editor set, version + 1;
    -- a stale version is refused; a note-only edit keeps the price and the content editor.
    v_res := public.stock__po_save_core(v_clinic, v_user, v_po_b, 1, jsonb_build_object(
      'expected_date', to_char(v_today + 5, 'YYYY-MM-DD'),
      'lines', jsonb_build_array(jsonb_build_object('stock_item_id', v_card, 'quantity', 3, 'unit_price_cents', 100,
                                                    'note', 'Öz denetim satırı'))), true, v_today);
    IF (v_res ->> 'version')::integer <> 2 OR (v_res -> 'lines' -> 0 ->> 'qty_ordered') IS DISTINCT FROM '3'
       OR NOT EXISTS (SELECT 1 FROM public.purchase_orders o
                      WHERE o.id = v_po_b AND o.content_edited_by = v_user AND o.content_editors = ARRAY[v_user]
                        AND o.expected_date = v_today + 5)
       OR (SELECT c.unit_price_cents FROM public.purchase_order_item_costs c
           JOIN public.purchase_order_items li ON li.id = c.po_item_id WHERE li.order_id = v_po_b) IS DISTINCT FROM 100 THEN
      v_fail := array_append(v_fail, 'Sipariş düzenleme: ' || coalesce(v_res::text, '-'));
    END IF;
    BEGIN
      PERFORM public.stock__po_save_core(v_clinic, v_user, v_po_b, 1, jsonb_build_object('note', 'x'), true, v_today);
      v_fail := array_append(v_fail, 'Sürüm hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_VERSION' THEN
        v_fail := array_append(v_fail, 'Sürüm: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;
    v_res := public.stock__po_save_core(v_clinic, v_user, v_po_b, 2, jsonb_build_object('note', 'Öz denetim notu'),
                                        false, v_today);
    IF (v_res ->> 'version')::integer <> 3
       OR (SELECT c.unit_price_cents FROM public.purchase_order_item_costs c
           JOIN public.purchase_order_items li ON li.id = c.po_item_id WHERE li.order_id = v_po_b) IS DISTINCT FROM 100 THEN
      v_fail := array_append(v_fail, 'Not düzenleme: ' || coalesce(v_res::text, '-'));
    END IF;

    -- Price key from a non cost viewer refuses the whole call.
    BEGIN
      PERFORM public.stock__po_save_core(v_clinic, v_user, gen_random_uuid(), NULL, jsonb_build_object(
        'supplier_id', v_sup,
        'lines', jsonb_build_array(jsonb_build_object('stock_item_id', v_card, 'quantity', 1, 'unit_price_cents', 1))),
        false, v_today);
      v_fail := array_append(v_fail, 'Maliyet yetkisi hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_COST_FORBIDDEN' THEN
        v_fail := array_append(v_fail, 'Maliyet yetkisi: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;
    -- Duplicate card -> row 2.
    BEGIN
      PERFORM public.stock__po_save_core(v_clinic, v_user, gen_random_uuid(), NULL, jsonb_build_object(
        'supplier_id', v_sup,
        'lines', jsonb_build_array(jsonb_build_object('stock_item_id', v_card, 'quantity', 1),
                                   jsonb_build_object('stock_item_id', v_card, 'quantity', 2))), true, v_today);
      v_fail := array_append(v_fail, 'Tekrarlanan ürün hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'E_PO_DUP_ITEM' OR v_detail IS DISTINCT FROM '2' THEN
        v_fail := array_append(v_fail, 'Tekrarlanan ürün: ' || coalesce(v_hint, '') || ' / ' || coalesce(v_detail, ''));
      END IF;
    END;

    -- Approval rule ON (owner role): the creator cannot approve.
    PERFORM public.stock__save_settings_core(v_clinic, v_user, true, false,
      (public.stock__settings(v_clinic)).version, jsonb_build_object('po_creator_cannot_approve', true));
    BEGIN
      PERFORM public.stock__save_settings_core(v_clinic, v_user, false, false,
        (public.stock__settings(v_clinic)).version, jsonb_build_object('po_creator_cannot_approve', false));
      v_fail := array_append(v_fail, 'Ayar sahibi hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_SETTING_OWNER' THEN
        v_fail := array_append(v_fail, 'Ayar sahibi: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;
    IF NOT v_payable_on THEN
      BEGIN
        PERFORM public.stock__save_settings_core(v_clinic, v_user, true, false,
          (public.stock__settings(v_clinic)).version, jsonb_build_object('po_payable_enabled', true));
        v_fail := array_append(v_fail, 'Finans ayarı hatası bekleniyordu');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'E_FINANCE_SETTING' THEN
          v_fail := array_append(v_fail, 'Finans ayarı: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
        END IF;
      END;
    END IF;
    BEGIN
      PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_b, 3, 'approve', NULL);
      v_fail := array_append(v_fail, 'Kendi siparişini onaylama hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_PO_SELF_APPROVE' THEN
        v_fail := array_append(v_fail, 'Kendi siparişi: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;
    v_res := public.stock__po_list_core(v_clinic, v_user, v_today, true, true,
                                        jsonb_build_object('supplier_id', v_sup, 'status', 'all'), NULL);
    IF (v_res ->> 'total')::integer <> 2
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res -> 'rows') AS e(v)
                      WHERE e.v ->> 'id' = v_po_a::text AND e.v -> 'actions' ->> 'approve_blocked' = 'self'
                        AND e.v ->> 'summary' = 'Öz denetim P8 × 9 kutu' AND (e.v ->> 'total_cents')::bigint = 45000) THEN
      v_fail := array_append(v_fail, 'Sipariş listesi: ' || coalesce(v_res::text, '-'));
    END IF;
    PERFORM public.stock__save_settings_core(v_clinic, v_user, true, false,
      (public.stock__settings(v_clinic)).version, jsonb_build_object('po_creator_cannot_approve', false));

    -- Cancel B; A's open 90 removes the suggestion (100 - 15 - 90 < 0).
    PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_b, 3, 'cancel', 'Öz denetim iptali');
    IF EXISTS (SELECT 1 FROM public.stock__reorder_rows(v_clinic, v_today) r WHERE r.stock_item_id = v_card) THEN
      v_fail := array_append(v_fail, 'Açık sipariş öneriden düşülmedi');
    END IF;

    -- Approve, mark ordered; receive 40 at the order price as a manager WITHOUT cost view.
    PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_a, 1, 'approve', NULL);
    PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_a, 2, 'mark_ordered', NULL);
    v_op := gen_random_uuid();
    v_res := public.stock__po_receive_core(v_clinic, v_user, v_op, v_today, false, v_po_a,
      jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'to_location_id', v_loc, 'quantity', 40)),
      'OZD-1', NULL, 3);
    v_mid := (v_res -> 'movement_ids' ->> 0)::uuid;
    SELECT count(*) INTO v_n FROM public.stock_movements m
    JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id
    WHERE m.id = v_mid AND m.po_item_id = v_line AND m.movement_type = 'receive' AND m.quantity = 40
      AND m.supplier_id = v_sup AND m.document_no = 'OZD-1' AND m.reason = 'Sipariş ' || v_num || ' mal kabul'
      AND bc.unit_cost_cents = 500;
    IF v_n <> 1 THEN
      v_fail := array_append(v_fail, 'Siparişli mal kabul hareketi / parti maliyeti beklenen gibi değil');
    END IF;
    IF (SELECT li.qty_received FROM public.purchase_order_items li WHERE li.id = v_line) IS DISTINCT FROM 40
       OR (SELECT o.status FROM public.purchase_orders o WHERE o.id = v_po_a) IS DISTINCT FROM 'partially_received' THEN
      v_fail := array_append(v_fail, 'Kısmi teslim durumu beklenen gibi değil');
    END IF;
    v_txt := (public.stock__move_result(v_clinic, v_op, v_res -> 'movement_ids', v_today)
              || jsonb_build_object('order', public.stock__po_write_json(v_clinic, v_po_a)))::text;
    IF v_txt LIKE '%cents%' THEN
      v_fail := array_append(v_fail, 'Mal kabul sonucu maliyet anahtarı içeriyor');
    END IF;

    -- Over-receipt: 51 > remaining 50 -> row 1 E_PO_OVER, the remaining in the text.
    BEGIN
      PERFORM public.stock__po_receive_core(v_clinic, v_user, gen_random_uuid(), v_today, false, v_po_a,
        jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'to_location_id', v_loc, 'quantity', 51)), NULL, NULL,
        NULL);
      v_fail := array_append(v_fail, 'Fazla mal kabul hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'E_PO_OVER' OR v_detail IS DISTINCT FROM '1' OR v_msg NOT LIKE '1. satır: %Kalan: 50.%' THEN
        v_fail := array_append(v_fail, 'Fazla mal kabul: ' || coalesce(v_hint, '') || ' / ' || coalesce(v_msg, ''));
      END IF;
    END;

    -- A receipt sent with the version seen before the first receipt (3; now 4) -> E_VERSION, nothing written.
    BEGIN
      PERFORM public.stock__po_receive_core(v_clinic, v_user, gen_random_uuid(), v_today, false, v_po_a,
        jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'to_location_id', v_loc, 'quantity', 1)), NULL, NULL,
        3);
      v_fail := array_append(v_fail, 'Eski sürümle mal kabul hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_VERSION' THEN
        v_fail := array_append(v_fail, 'Eski sürümle mal kabul: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;

    -- Detail (cost viewer): line total 45000, received value 20000.
    v_res := public.stock__po_json(v_clinic, v_po_a, v_user, true, true, v_today);
    IF (v_res -> 'order' ->> 'total_cents')::bigint IS DISTINCT FROM 45000
       OR (v_res -> 'order' -> 'lines' -> 0 ->> 'received_value_cents')::bigint IS DISTINCT FROM 20000
       OR (v_res -> 'order' -> 'lines' -> 0 ->> 'qty_remaining') IS DISTINCT FROM '50'
       OR jsonb_array_length(v_res -> 'order' -> 'lines' -> 0 -> 'receipts') <> 1 THEN
      v_fail := array_append(v_fail, 'Sipariş detayı: ' || coalesce(v_res::text, '-'));
    END IF;
    v_res := public.stock__po_json(v_clinic, v_po_a, v_user, false, true, v_today);
    IF v_res::text LIKE '%cents%' THEN
      v_fail := array_append(v_fail, 'Sipariş detayı maliyet yetkisi olmayana maliyet gösteriyor');
    END IF;

    -- A PO receipt can never be corrected (E_CORR_ORDER, 0024 stock__resolve_core); the history no longer offers it.
    IF (SELECT (h.j ->> 'can_request_correction')::boolean
        FROM public.stock__history_rows(v_clinic, v_user, true, true) h WHERE h.id = v_mid) IS DISTINCT FROM false THEN
      v_fail := array_append(v_fail, 'Siparişli mal kabul için düzeltme talebi düğmesi açık');
    END IF;
    INSERT INTO public.stock_correction_requests (id, clinic_id, movement_id, reason, requested_by)
    VALUES (v_req, v_clinic, v_mid, 'Öz denetim düzeltmesi', v_user);
    BEGIN
      PERFORM public.stock__resolve_core(v_clinic, v_user, gen_random_uuid(), v_req, 'approve', 30, 'Öz denetim');
      v_fail := array_append(v_fail, 'Siparişli mal kabul düzeltme hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_CORR_ORDER' THEN
        v_fail := array_append(v_fail, 'Siparişli düzeltme: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;

    -- Short close -> received; the payable stays 'disabled' while the setting is OFF (owner decision).
    SELECT o.version INTO v_ver FROM public.purchase_orders o WHERE o.id = v_po_a;
    PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_a, v_ver, 'close', 'Öz denetim kapatma');
    SELECT o.status, o.payable_state INTO v_state, v_txt FROM public.purchase_orders o WHERE o.id = v_po_a;
    IF v_state IS DISTINCT FROM 'received' OR v_txt = 'none'
       OR (NOT v_payable_on AND (v_txt IS DISTINCT FROM 'disabled'
                                 OR EXISTS (SELECT 1 FROM public.fin_entries e
                                            WHERE e.clinic_id = v_clinic AND e.source_key = 'stock-po:' || v_po_a::text)))
       OR NOT (SELECT o.closed_short FROM public.purchase_orders o WHERE o.id = v_po_a) THEN
      v_fail := array_append(v_fail, format('Eksik kapatma: %s / %s', v_state, v_txt));
    END IF;
    -- The guard trigger refuses reopening a terminal order.
    BEGIN
      UPDATE public.purchase_orders SET status = 'ordered' WHERE id = v_po_a;
      v_fail := array_append(v_fail, 'Kapanmış sipariş yeniden açıldı');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_PO_STATE' THEN
        v_fail := array_append(v_fail, 'Sipariş koruması: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;

    -- Room request for 5 into the room, delivered straight from pending by FEFO transfer from the default warehouse.
    PERFORM public.stock__rq_create_core(v_clinic, v_user, v_rq, v_card, v_room, 5, 'usage', NULL, 'Öz denetim');
    v_res := public.stock__rq_list_core(v_clinic, v_user, v_today, true, true,
                                        jsonb_build_object('stock_item_id', v_card), NULL);
    IF (v_res ->> 'total')::integer <> 1 OR (v_res -> 'rows' -> 0 -> 'actions' ->> 'can_deliver')::boolean IS NOT TRUE
       OR (v_res -> 'rows' -> 0 ->> 'warehouse_usable_qty') IS DISTINCT FROM '55' THEN
      v_fail := array_append(v_fail, 'Oda talebi listesi: ' || coalesce(v_res::text, '-'));
    END IF;
    v_op := gen_random_uuid();
    v_res := public.stock__rq_action_core(v_clinic, v_user, v_op, v_today, true, v_rq, 1, 'deliver', NULL, NULL,
                                          'usage', NULL, NULL);
    SELECT r.ref_no INTO v_ref FROM public.stock_room_requests r WHERE r.id = v_rq;
    SELECT count(*), sum(m.quantity) INTO v_n, v_q FROM public.stock_movements m
    WHERE m.operation_key = v_op AND m.movement_type = 'transfer' AND m.request_id = v_rq
      AND m.from_location_id = v_loc AND m.to_location_id = v_room AND m.reason = 'Oda talebi #' || v_ref::text;
    IF v_n < 1 OR v_q IS DISTINCT FROM 5
       OR (SELECT count(*) FROM public.stock_movements m WHERE m.operation_key = v_op) <> v_n
       OR (SELECT sum(sb.quantity) FROM public.stock_balances sb
           WHERE sb.stock_item_id = v_card AND sb.location_id = v_room) IS DISTINCT FROM 5
       OR (SELECT sum(sb.quantity) FROM public.stock_balances sb
           WHERE sb.stock_item_id = v_card AND sb.location_id = v_loc) IS DISTINCT FROM 50
       OR NOT EXISTS (SELECT 1 FROM public.stock_room_requests r
                      WHERE r.id = v_rq AND r.status = 'delivered' AND r.delivered_qty = 5 AND r.approved_by = v_user
                        AND r.delivered_by = v_user AND r.source_location_id = v_loc
                        AND r.delivery_operation_key = v_op) THEN
      v_fail := array_append(v_fail, format('Oda teslimi: %s satır, %s adet', v_n, v_q));
    END IF;
    BEGIN
      PERFORM public.stock__rq_action_core(v_clinic, v_user, gen_random_uuid(), v_today, true, v_rq, 2, 'cancel',
                                           NULL, NULL, 'usage', NULL, NULL);
      v_fail := array_append(v_fail, 'Teslim edilmiş talep geri çekildi');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_RQ_STATE' THEN
        v_fail := array_append(v_fail, 'Talep durumu: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;

    -- Approve then cancel by the requester; reject with a reason.
    PERFORM public.stock__rq_create_core(v_clinic, v_user, v_rq2, v_card, v_room, 1, 'usage', NULL, NULL);
    PERFORM public.stock__rq_action_core(v_clinic, v_user, gen_random_uuid(), v_today, true, v_rq2, 1, 'approve',
                                         NULL, NULL, 'usage', NULL, NULL);
    PERFORM public.stock__rq_action_core(v_clinic, v_user, gen_random_uuid(), v_today, false, v_rq2, 2, 'cancel',
                                         NULL, NULL, 'usage', NULL, NULL);
    PERFORM public.stock__rq_create_core(v_clinic, v_user, v_rq3, v_card, v_room, 1, 'usage', NULL, NULL);
    PERFORM public.stock__rq_action_core(v_clinic, v_user, gen_random_uuid(), v_today, true, v_rq3, 1, 'reject',
                                         'Öz denetim ret', NULL, 'usage', NULL, NULL);
    IF (SELECT r.ref_no FROM public.stock_room_requests r WHERE r.id = v_rq2) IS DISTINCT FROM v_ref + 1
       OR (SELECT r.ref_no FROM public.stock_room_requests r WHERE r.id = v_rq3) IS DISTINCT FROM v_ref + 2
       OR (SELECT r.status FROM public.stock_room_requests r WHERE r.id = v_rq2) IS DISTINCT FROM 'cancelled'
       OR (SELECT r.status FROM public.stock_room_requests r WHERE r.id = v_rq3) IS DISTINCT FROM 'rejected' THEN
      v_fail := array_append(v_fail, 'Oda talebi onay / geri çekme / ret beklenen gibi değil');
    END IF;

    -- Payable ON (rolled back): order C (2 at 300) fully received -> one planned fin_entries row of 600, no payment.
    INSERT INTO public.stock_settings (clinic_id, po_payable_enabled) VALUES (v_clinic, true)
    ON CONFLICT (clinic_id) DO UPDATE SET po_payable_enabled = true;
    PERFORM public.stock__po_save_core(v_clinic, v_user, v_po_c, NULL, jsonb_build_object(
      'supplier_id', v_sup,
      'lines', jsonb_build_array(jsonb_build_object('stock_item_id', v_card, 'quantity', 2, 'unit_price_cents', 300))),
      true, v_today);
    PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_c, 1, 'approve', NULL);
    PERFORM public.stock__po_transition_core(v_clinic, v_user, v_po_c, 2, 'mark_ordered', NULL);
    PERFORM public.stock__po_receive_core(v_clinic, v_user, gen_random_uuid(), v_today, false, v_po_c,
      jsonb_build_array(jsonb_build_object('po_item_id',
        (SELECT li.id FROM public.purchase_order_items li WHERE li.order_id = v_po_c), 'to_location_id', v_loc,
        'quantity', 2, 'lot_number', 'OZD-C')), NULL, NULL, 3);
    SELECT o.payable_state INTO v_txt FROM public.purchase_orders o WHERE o.id = v_po_c;
    IF v_txt = 'created' THEN
      IF NOT EXISTS (SELECT 1 FROM public.fin_entries e
                     JOIN public.purchase_orders o ON o.fin_entry_id = e.id
                     WHERE o.id = v_po_c AND e.id = md5('stock-po-payable:' || v_po_c::text)::uuid
                       AND e.clinic_id = v_clinic AND e.amount_cents = 600 AND e.currency = 'TRY'
                       AND e.source_key = 'stock-po:' || v_po_c::text AND e.counterparty_id IS NULL
                       AND e.counterparty_text = 'ZZ Öz denetim tedarikçi ' || v_tag
                       AND e.due_date = public.clinic_today() + (public.stock__settings(v_clinic)).po_payable_due_days
                       AND e.description LIKE 'Stok siparişi SP-2026-% (1 kalem)')
         OR EXISTS (SELECT 1 FROM public.fin_payments fp
                    WHERE fp.entry_id = md5('stock-po-payable:' || v_po_c::text)::uuid) THEN
        v_fail := array_append(v_fail, 'Finans borç kaydı beklenen gibi değil');
      END IF;
    ELSE
      -- The feature ships OFF (owner decision); a finance set-up that refuses the entry must not block the deploy.
      -- Acceptance FP-4 / FP-5 prove the 'created' path in test clinics.
      RAISE WARNING 'Öz denetim: finans borç kaydı denemesi % ile sonuçlandı (ayar kapalı kaldığı sürece etkisi yok).',
        coalesce(v_txt, '-');
    END IF;

    -- Report and counts run (today: receipts 15 + 40 + 2, of which 42 from orders; room deliveries 5).
    v_res := public.stock__consumption_core(v_clinic, true, '2000-01-01', '2000-01-02', NULL);
    v_res := public.stock__consumption_core(v_clinic, true, to_char(public.clinic_today(), 'YYYY-MM-DD'),
                                            to_char(public.clinic_today(), 'YYYY-MM-DD'),
                                            jsonb_build_object('stock_item_id', v_card));
    IF jsonb_array_length(v_res -> 'rows') <> 1
       OR (v_res -> 'rows' -> 0 ->> 'received_qty') IS DISTINCT FROM '57'
       OR (v_res -> 'rows' -> 0 ->> 'received_po_qty') IS DISTINCT FROM '42'
       OR (v_res -> 'rows' -> 0 ->> 'room_delivery_qty') IS DISTINCT FROM '5'
       OR (v_res -> 'rows' -> 0 ->> 'received_cost_cents') IS DISTINCT FROM '20600'
       OR (v_res -> 'rows' -> 0 ->> 'uncosted_rows') IS DISTINCT FROM '1'
       OR (v_res -> 'totals' ->> 'items') IS DISTINCT FROM '1' THEN
      v_fail := array_append(v_fail, 'Tüketim raporu: ' || coalesce(v_res::text, '-'));
    END IF;
    v_res := public.stock__consumption_core(v_clinic, false, to_char(public.clinic_today(), 'YYYY-MM-DD'),
                                            to_char(public.clinic_today(), 'YYYY-MM-DD'),
                                            jsonb_build_object('stock_item_id', v_card, 'location_id', v_room));
    IF v_res::text LIKE '%cents%' OR (v_res -> 'rows' -> 0 ->> 'room_delivery_qty') IS DISTINCT FROM '5'
       OR (v_res -> 'rows' -> 0 ->> 'received_qty') IS DISTINCT FROM '0' THEN
      v_fail := array_append(v_fail, 'Tüketim raporu (konum, maliyetsiz): ' || coalesce(v_res::text, '-'));
    END IF;
    v_res := public.stock__work_counts_core(v_clinic, v_today, true);
    IF NOT (v_res ? 'room_requests') OR NOT (v_res ? 'purchase_orders')
       OR public.stock__work_counts_core(v_clinic, v_today, false) ? 'purchase_orders' THEN
      v_fail := array_append(v_fail, 'İş sayıları: ' || coalesce(v_res::text, '-'));
    END IF;
    v_res := public.stock__settings_json(v_clinic);
    IF NOT (v_res ? 'po_payable_enabled') OR v_res ? 'po_payable_category_id' THEN
      v_fail := array_append(v_fail, 'Ayarlar: ' || coalesce(v_res::text, '-'));
    END IF;

    -- The replay keeps the ledger invariant for the test card.
    IF EXISTS (
      SELECT 1
      FROM public.stock_balances b
      FULL JOIN (
        SELECT y.batch_id, y.loc, sum(y.q) AS q
        FROM (
          SELECT m.batch_id, m.to_location_id AS loc, m.quantity AS q
          FROM public.stock_movements m WHERE m.stock_item_id = v_card AND m.to_location_id IS NOT NULL
          UNION ALL
          SELECT m.batch_id, m.from_location_id, -m.quantity
          FROM public.stock_movements m WHERE m.stock_item_id = v_card AND m.from_location_id IS NOT NULL
        ) y
        GROUP BY y.batch_id, y.loc
      ) x ON x.batch_id = b.batch_id AND x.loc = b.location_id
      WHERE (b.stock_item_id = v_card OR b.id IS NULL) AND coalesce(b.quantity, 0) <> coalesce(x.q, 0)
    ) THEN
      v_fail := array_append(v_fail, 'Öz denetim kartında defter ve bakiye uyuşmuyor');
    END IF;

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (satın alma / oda talebi): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'stock_p8_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;
END $$;

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
