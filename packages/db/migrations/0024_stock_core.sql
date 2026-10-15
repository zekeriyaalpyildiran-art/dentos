-- Phase 7: Stock core (stok çekirdeği). Safe to re-run.
--
-- Contract: spec_parts p7_db_contract.md (schema, RPCs, JSON shapes, error keys; wins on names and conflicts) and
-- p7_rules_ui.md (legacy behaviour, edge cases, acceptance). Requires 0019_phase0_security.sql. Number 0023 belongs
-- to another workflow and is never reused here.
--
--  1. Helpers: stock__raise (Turkish error texts keyed E_*, key in HINT), input validators (quantity, unit,
--     GTIN, lot, serial, expiry, reason, paging), stock_can_operate / stock_can_manage / stock_can_view_costs
--     (granted; answer only for the caller) and the internal stock__require_* gates.
--  2. New tables: stock_locations (one 'Ana Depo' default warehouse per clinic, editable), suppliers,
--     stock_item_costs / stock_batch_costs (cost-gated), stock_batches (lot / serial / expiry), stock_balances
--     (numeric(14,4), never negative), stock_movements (append-only ledger with Phase 8/9 hook columns),
--     stock_counts, stock_correction_requests, stock_product_requests, stock_operations (idempotency ledger, no
--     client access), user_favorite_items.
--  3. stock_items: extended card (brand/model, tracking A/B/C, GTIN, units + factor, MIN/MAX, ABC class, order
--     policy, draft flag, supplier, preferred location, version). The old integer columns quantity_on_hand,
--     quantity_minimum, supplier, expiry_date and last_restocked_at stay readable as mirrors of the new data;
--     unit_price is always 0 (the price moves to stock_item_costs). Direct client writes are revoked.
--  4. Writes only through SECURITY DEFINER RPCs (stock_receive, stock_issue, stock_transfer, stock_waste,
--     stock_return, stock_bulk_receive, stock_count, stock_request_correction, stock_resolve_correction,
--     stock_request_product, stock_define_item, stock_save_item, stock_save_location, stock_save_supplier,
--     stock_set_favorite): FEFO allocation, row locks in a fixed order (items by id, then locations, then balance
--     rows in FEFO order), client operation keys for idempotency.
--  5. Reads: stock_dashboard, stock_item_levels, stock_expiry_watch, stock_movement_history, stock_item_detail,
--     stock_location_snapshot, stock_scan_lookup, stock_correction_list, stock_product_request_list,
--     stock_return_candidates, stock_count_history, stock_period_report. Every aggregate is computed in SQL and
--     returned as one jsonb value (PostgREST's 1000-row cap never truncates). Cost keys are present only for cost
--     viewers (absent, never 0).
--  6. Migration of existing stock_items: every card becomes tracking level C with units 'adet'; MIN = MAX = the
--     old minimum; quantity_on_hand becomes one 'opening' movement into 'Ana Depo' (lot 'GENEL') with a fixed
--     operation key; old supplier texts become suppliers rows; unit_price moves to stock_item_costs (exact old
--     value kept) and is then zeroed. Audit triggers are attached only after the zeroing.
--  7. Audit: audit_row_change() (0019) on stock_items (catalog columns only), stock_locations, suppliers,
--     stock_item_costs, stock_correction_requests, stock_product_requests; cost audit rows hidden from non-viewers
--     by a RESTRICTIVE policy.
--  8. stock__harden_privileges(): EXECUTE revoked from PUBLIC / anon / authenticated on every stock_* function,
--     public RPCs granted to authenticated, internals (stock__*) never; plus self-checks. Every later migration
--     that touches stock_* functions must end with SELECT public.stock__harden_privileges();
--  9. Self-checks (RAISE rolls everything back): RLS / policies, ledger = balances, one default warehouse per
--     clinic, opening totals, preserved prices, mirrors, FEFO and correction replays inside a rolled-back block.
--
-- Error contract (as 0020 / 0021): RAISE '<Turkish text>' USING ERRCODE = 42501 (403), PT404 (404), PT409 (409) or
-- the default P0001 (400). The UI shows error.message verbatim; HINT carries the key (E_*), DETAIL a machine value
-- where noted. Bulk / count row errors are prefixed '<n>. satır: ' with DETAIL = n; the inner code and key are kept.
--
-- Deliberate additions to the contract (all backwards compatible):
--   * stock_receive / stock_issue / stock_transfer / stock_waste take an optional trailing p_units_per_purchase
--     (bulk lines: key units_per_purchase). When the purchase unit is used and it differs from the card's factor
--     under lock, the call is refused with E_UNIT_CHANGED (rules R2.1 / D4).
--   * stock_item_costs carries id = stock_item_id (generated column) because audit_logs.entity_id is NOT NULL.
--   * Extra error keys: E_UNIT_CHANGED, E_HISTORY (append-only tables), E_LINK_GTIN (link to a card that already
--     has another barcode).
--   * The stock_items audit trigger fires only for catalog columns, so the mirror refresh after every movement does
--     not flood audit_logs.
--   * last_restocked_at mirror keeps the legacy restock date for migrated openings (batch received_at).
--   * grant_staff_permission / revoke_staff_permission (0019) are replaced with the same signatures: 'stock_manage'
--     only by the owner, 'stock_cost_view' only by the owner or a 'finance' holder (§8.0).
--   * Editor / service-role row deletes pass the append-only guards (fin / crm pattern; TRUNCATE always refused),
--     the correction <-> movement links are DEFERRABLE, and stock__purge_test_clinic(uuid) (editor only, slugs
--     'p<n>-test-...' only) removes a test clinic's stock rows. stock_locations / suppliers cascade with the clinic.
--   * The opening movement keeps the card's old expiry even when it is already past (a migration, not a receipt);
--     those cards are listed by NOTICE. Cards whose old minimum was 0 keep MIN = MAX = 0 and raise no critical
--     alert until a MIN / MAX is entered (legacy rule "critical only when MAX > 0"); the old reports page still
--     compares the mirrors (0 <= 0) until it is switched to stock_item_levels.
--
-- RUNBOOK (apply and deploy together; production is the only database):
--   0. Before applying: no production deploy from a working tree that contains the Phase 7 web files may go live
--      until step 1 is done (every /inventory page calls stock_* RPCs; the UI shows "Stok modülü güncelleniyor"
--      when they are missing). Acceptance clean-up scripts of other phases keep working: the seeded 'Ana Depo'
--      cascades with its clinic; a test clinic WITH stock rows needs stock__purge_test_clinic first.
--   1. Apply this file in the SQL editor (one transaction; any self-check failure rolls everything back).
--   2. Immediately deploy the Phase 7 web build (new /inventory pages, quick movement sheet, scanner). Between 1 and
--      2 the old /inventory/new and /inventory/[id]/edit pages fail on save (direct writes are revoked) and the old
--      list shows price 0; reads keep working. The new build must not go live before step 1 (it calls stock_* RPCs).
--   3. Ask everyone to reload open tabs.
--   4. Smoke test as the owner: dashboard loads with value; quick receive of a B item with lot + expiry; issue with
--      a FEFO split; transfer; waste of an expired lot; a reception user sees lists but no actions and no cost
--      keys; an assistant receives without a cost field; a count with a difference writes an adjust row; a
--      correction request + approval; unknown GTIN -> request -> define -> receive.
--   5. Read the NOTICEs of step 1: cards whose opening batch is already expired (waste them, or correct the opening
--      to 0 and receive real lots), cards whose old minimum was 0 (enter MIN / MAX to get critical alerts), cards
--      without a category, and existing non-owner stock_manage / stock_cost_view grants (revoke any you did not
--      intend). Settings > export does not include the new stock tables yet (follow-up in the export page).

BEGIN;

-- ---------------------------------------------------------------------------
-- 2.0 Preflight: Phase 0 must be live, the existing tables must have the columns and types used here, the Turkish
--     ICU collation must exist, anything left by an earlier run must already have the shape created below, and no
--     existing stock card may hold a negative quantity (it could not become an opening movement).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_n bigint;
BEGIN
  SELECT string_agg(f.fn, ', ')
    INTO v_missing
  FROM unnest(ARRAY['current_clinic_id', 'current_app_role', 'current_app_user_id', 'clinic_today',
                    'has_permission', 'audit_row_change']) AS f(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f.fn
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 0 eksik, önce 0019 uygulanmalı: %', v_missing;
  END IF;

  IF to_regclass('public.staff_permissions') IS NULL THEN
    RAISE EXCEPTION 'staff_permissions tablosu yok; önce 0019 uygulanmalı.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.staff_permissions'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%stock_manage%'
      AND pg_get_constraintdef(c.oid) ILIKE '%stock_cost_view%'
  ) THEN
    RAISE EXCEPTION 'staff_permissions ''stock_manage'' / ''stock_cost_view'' yetkilerini kabul etmiyor; önce 0019 uygulanmalı.';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() / auth.jwt() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  IF to_regclass('public.fin_counterparties') IS NULL THEN
    RAISE EXCEPTION 'fin_counterparties tablosu yok; önce 0020 uygulanmalı.';
  END IF;

  -- Existing columns used here, with their live types (udt_name).
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('stock_items', 'id', 'uuid'), ('stock_items', 'clinic_id', 'uuid'), ('stock_items', 'item_code', 'text'),
    ('stock_items', 'item_name', 'text'), ('stock_items', 'category', 'text'),
    ('stock_items', 'quantity_on_hand', 'int4'), ('stock_items', 'quantity_minimum', 'int4'),
    ('stock_items', 'unit_price', 'numeric'), ('stock_items', 'supplier', 'text'),
    ('stock_items', 'last_restocked_at', 'timestamptz'), ('stock_items', 'expiry_date', 'date'),
    ('stock_items', 'created_at', 'timestamptz'), ('stock_items', 'updated_at', 'timestamptz'),
    ('stock_transactions', 'id', 'uuid'), ('stock_transactions', 'clinic_id', 'uuid'),
    ('stock_transactions', 'stock_item_id', 'uuid'),
    ('patients', 'id', 'uuid'), ('patients', 'clinic_id', 'uuid'), ('patients', 'full_name', 'text'),
    ('patients', 'is_active', 'bool'),
    ('doctors', 'id', 'uuid'), ('doctors', 'clinic_id', 'uuid'), ('doctors', 'user_id', 'uuid'),
    ('users', 'id', 'uuid'), ('users', 'clinic_id', 'uuid'), ('users', 'full_name', 'text'),
    ('users', 'is_active', 'bool'), ('users', 'role', 'user_role'), ('users', 'auth_user_id', 'uuid'),
    ('appointments', 'id', 'uuid'), ('appointments', 'clinic_id', 'uuid'), ('appointments', 'patient_id', 'uuid'),
    ('appointments', 'doctor_id', 'uuid'), ('appointments', 'start_time', 'timestamptz'),
    ('chairs', 'id', 'uuid'), ('chairs', 'clinic_id', 'uuid'), ('chairs', 'name', 'text'), ('chairs', 'is_active', 'bool'),
    ('fin_counterparties', 'id', 'uuid'), ('fin_counterparties', 'clinic_id', 'uuid'),
    ('fin_counterparties', 'name', 'text'), ('fin_counterparties', 'kind', 'text'),
    ('fin_counterparties', 'is_active', 'bool'),
    ('clinics', 'id', 'uuid'), ('clinics', 'created_at', 'timestamptz'), ('clinics', 'slug', 'text'),
    ('audit_logs', 'clinic_id', 'uuid'), ('audit_logs', 'entity_type', 'text'), ('audit_logs', 'entity_id', 'uuid'),
    ('audit_logs', 'before_data', 'jsonb'), ('audit_logs', 'after_data', 'jsonb')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı veya türü farklı: %', v_missing;
  END IF;

  -- Columns this migration adds to stock_items: if one is already there (earlier run or drift), it must have the
  -- type created below, and the NOT NULL ones must already be NOT NULL.
  SELECT string_agg(format('stock_items.%s (%s%s beklenirken %s%s)', e.col, e.udt,
                           CASE WHEN e.nn THEN ' NOT NULL' ELSE '' END, c.udt_name,
                           CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END), ', ')
    INTO v_missing
  FROM (VALUES
    ('brand', 'text', true), ('model', 'text', true), ('tracking_level', 'text', true), ('gtin', 'text', false),
    ('sku', 'text', true), ('purchase_unit', 'text', true), ('usage_unit', 'text', true),
    ('units_per_purchase', 'numeric', true), ('min_qty', 'numeric', true), ('max_qty', 'numeric', true),
    ('abc_class', 'text', true), ('order_policy', 'text', true), ('needs_review', 'bool', true),
    ('supplier_id', 'uuid', false), ('preferred_location_id', 'uuid', false), ('is_active', 'bool', true),
    ('notes', 'text', true), ('version', 'int4', true), ('legacy_id', 'text', false),
    ('opening_movement_id', 'uuid', false), ('created_by', 'uuid', false), ('updated_by', 'uuid', false)
  ) AS e(col, udt, nn)
  JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'stock_items' AND c.column_name = e.col
  WHERE c.udt_name::text <> e.udt OR (e.nn AND c.is_nullable <> 'NO');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stock_items üzerinde önceden kalan sütunlar beklenen yapıda değil: %', v_missing;
  END IF;

  -- New tables left by an earlier run must have every column created below, with the same type.
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('stock_locations', 'id', 'uuid'), ('stock_locations', 'clinic_id', 'uuid'), ('stock_locations', 'name', 'text'),
    ('stock_locations', 'name_key', 'text'), ('stock_locations', 'kind', 'text'),
    ('stock_locations', 'is_default_warehouse', 'bool'), ('stock_locations', 'chair_id', 'uuid'),
    ('stock_locations', 'sort_order', 'int4'), ('stock_locations', 'is_active', 'bool'),
    ('stock_locations', 'legacy_id', 'text'), ('stock_locations', 'version', 'int4'),
    ('stock_locations', 'created_by', 'uuid'), ('stock_locations', 'created_at', 'timestamptz'),
    ('stock_locations', 'updated_by', 'uuid'), ('stock_locations', 'updated_at', 'timestamptz'),
    ('suppliers', 'id', 'uuid'), ('suppliers', 'clinic_id', 'uuid'), ('suppliers', 'name', 'text'),
    ('suppliers', 'name_key', 'text'), ('suppliers', 'phone', 'text'), ('suppliers', 'email', 'text'),
    ('suppliers', 'tax_no', 'text'), ('suppliers', 'note', 'text'), ('suppliers', 'fin_counterparty_id', 'uuid'),
    ('suppliers', 'is_active', 'bool'), ('suppliers', 'legacy_id', 'text'), ('suppliers', 'version', 'int4'),
    ('suppliers', 'created_by', 'uuid'), ('suppliers', 'created_at', 'timestamptz'),
    ('suppliers', 'updated_by', 'uuid'), ('suppliers', 'updated_at', 'timestamptz'),
    ('stock_item_costs', 'stock_item_id', 'uuid'), ('stock_item_costs', 'id', 'uuid'),
    ('stock_item_costs', 'clinic_id', 'uuid'), ('stock_item_costs', 'last_unit_cost_cents', 'int8'),
    ('stock_item_costs', 'legacy_unit_price', 'numeric'), ('stock_item_costs', 'updated_by', 'uuid'),
    ('stock_item_costs', 'updated_at', 'timestamptz'),
    ('stock_batches', 'id', 'uuid'), ('stock_batches', 'clinic_id', 'uuid'), ('stock_batches', 'stock_item_id', 'uuid'),
    ('stock_batches', 'lot_number', 'text'), ('stock_batches', 'serial_number', 'text'),
    ('stock_batches', 'expiry_date', 'date'), ('stock_batches', 'received_at', 'timestamptz'),
    ('stock_batches', 'legacy_id', 'text'), ('stock_batches', 'created_by', 'uuid'),
    ('stock_batch_costs', 'batch_id', 'uuid'), ('stock_batch_costs', 'clinic_id', 'uuid'),
    ('stock_batch_costs', 'unit_cost_cents', 'int8'),
    ('stock_balances', 'id', 'uuid'), ('stock_balances', 'clinic_id', 'uuid'), ('stock_balances', 'stock_item_id', 'uuid'),
    ('stock_balances', 'batch_id', 'uuid'), ('stock_balances', 'location_id', 'uuid'),
    ('stock_balances', 'quantity', 'numeric'), ('stock_balances', 'updated_at', 'timestamptz'),
    ('stock_movements', 'id', 'uuid'), ('stock_movements', 'ref_no', 'int8'), ('stock_movements', 'clinic_id', 'uuid'),
    ('stock_movements', 'operation_key', 'uuid'), ('stock_movements', 'line_no', 'int2'),
    ('stock_movements', 'stock_item_id', 'uuid'), ('stock_movements', 'batch_id', 'uuid'),
    ('stock_movements', 'movement_type', 'text'), ('stock_movements', 'quantity', 'numeric'),
    ('stock_movements', 'from_location_id', 'uuid'), ('stock_movements', 'to_location_id', 'uuid'),
    ('stock_movements', 'patient_id', 'uuid'), ('stock_movements', 'appointment_id', 'uuid'),
    ('stock_movements', 'doctor_id', 'uuid'), ('stock_movements', 'supplier_id', 'uuid'),
    ('stock_movements', 'document_no', 'text'), ('stock_movements', 'reason', 'text'),
    ('stock_movements', 'source_movement_id', 'uuid'), ('stock_movements', 'correction_request_id', 'uuid'),
    ('stock_movements', 'count_id', 'uuid'), ('stock_movements', 'po_item_id', 'uuid'),
    ('stock_movements', 'request_id', 'uuid'), ('stock_movements', 'implant_record_id', 'uuid'),
    ('stock_movements', 'actor_user_id', 'uuid'), ('stock_movements', 'effective_at', 'timestamptz'),
    ('stock_movements', 'created_at', 'timestamptz'), ('stock_movements', 'legacy_id', 'text'),
    ('stock_counts', 'id', 'uuid'), ('stock_counts', 'clinic_id', 'uuid'), ('stock_counts', 'operation_key', 'uuid'),
    ('stock_counts', 'line_no', 'int2'), ('stock_counts', 'location_id', 'uuid'),
    ('stock_counts', 'stock_item_id', 'uuid'), ('stock_counts', 'batch_id', 'uuid'),
    ('stock_counts', 'expected_qty', 'numeric'), ('stock_counts', 'actual_qty', 'numeric'),
    ('stock_counts', 'delta', 'numeric'), ('stock_counts', 'movement_id', 'uuid'), ('stock_counts', 'reason', 'text'),
    ('stock_counts', 'actor_user_id', 'uuid'), ('stock_counts', 'created_at', 'timestamptz'),
    ('stock_correction_requests', 'id', 'uuid'), ('stock_correction_requests', 'ref_no', 'int8'),
    ('stock_correction_requests', 'clinic_id', 'uuid'), ('stock_correction_requests', 'movement_id', 'uuid'),
    ('stock_correction_requests', 'reason', 'text'), ('stock_correction_requests', 'requested_by', 'uuid'),
    ('stock_correction_requests', 'status', 'text'), ('stock_correction_requests', 'corrected_qty', 'numeric'),
    ('stock_correction_requests', 'resolution', 'text'), ('stock_correction_requests', 'resolved_by', 'uuid'),
    ('stock_correction_requests', 'resolved_at', 'timestamptz'),
    ('stock_correction_requests', 'reversal_movement_id', 'uuid'),
    ('stock_correction_requests', 'reentry_movement_id', 'uuid'),
    ('stock_correction_requests', 'created_at', 'timestamptz'),
    ('stock_product_requests', 'id', 'uuid'), ('stock_product_requests', 'clinic_id', 'uuid'),
    ('stock_product_requests', 'gtin', 'text'), ('stock_product_requests', 'name', 'text'),
    ('stock_product_requests', 'note', 'text'), ('stock_product_requests', 'lot_number', 'text'),
    ('stock_product_requests', 'serial_number', 'text'), ('stock_product_requests', 'expiry_date', 'date'),
    ('stock_product_requests', 'status', 'text'), ('stock_product_requests', 'stock_item_id', 'uuid'),
    ('stock_product_requests', 'resolution_note', 'text'), ('stock_product_requests', 'requested_by', 'uuid'),
    ('stock_product_requests', 'resolved_by', 'uuid'), ('stock_product_requests', 'created_at', 'timestamptz'),
    ('stock_product_requests', 'updated_at', 'timestamptz'), ('stock_product_requests', 'resolved_at', 'timestamptz'),
    ('stock_operations', 'operation_key', 'uuid'), ('stock_operations', 'clinic_id', 'uuid'),
    ('stock_operations', 'actor_user_id', 'uuid'), ('stock_operations', 'kind', 'text'),
    ('stock_operations', 'fingerprint', 'text'), ('stock_operations', 'result', 'jsonb'),
    ('stock_operations', 'created_at', 'timestamptz'),
    ('user_favorite_items', 'clinic_id', 'uuid'), ('user_favorite_items', 'user_id', 'uuid'),
    ('user_favorite_items', 'stock_item_id', 'uuid'), ('user_favorite_items', 'created_at', 'timestamptz')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önceki çalıştırmadan kalan stok tabloları beklenen yapıda değil: %', v_missing;
  END IF;

  -- The ledger is not touched; it is expected to be empty (reported only).
  SELECT count(*) INTO v_n FROM public.stock_transactions;
  RAISE NOTICE 'stock_transactions: % satır (beklenen 0; tabloya dokunulmuyor).', v_n;

  -- A negative quantity cannot become an opening movement; the owner fixes such cards in the old screen first.
  -- Only cards that would be migrated in this run are checked (a re-run sees mirrors, which are never negative).
  SELECT string_agg(i.item_code, ', ' ORDER BY i.item_code)
    INTO v_missing
  FROM public.stock_items i
  WHERE i.quantity_on_hand < 0;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Eksi stok miktarı olan kartlar var; önce eski ekrandan düzeltin: %', v_missing;
  END IF;

  -- The migration updates every card (mirrors, MIN / MAX, price zeroing) and the guard trims code and name. Postgres
  -- enforces even NOT VALID checks on UPDATE, so a code / name outside the new limits, or two codes that differ only
  -- by surrounding spaces, would abort the run with a raw error; they are named here instead.
  SELECT string_agg(format('%s (%s)', i.item_code, i.id), ', ' ORDER BY i.item_code)
    INTO v_missing
  FROM public.stock_items i
  WHERE char_length(btrim(coalesce(i.item_code, ''))) NOT BETWEEN 1 AND 40
     OR char_length(btrim(coalesce(i.item_name, ''))) NOT BETWEEN 1 AND 200;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Stok kodu 1–40 veya ürün adı 1–200 karakter dışında olan kartlar var; önce eski ekrandan kısaltın: %',
      v_missing;
  END IF;

  SELECT string_agg(format('%s: %s', x.clinic_id, x.codes), '; ')
    INTO v_missing
  FROM (
    SELECT i.clinic_id, string_agg(quote_literal(i.item_code), ', ' ORDER BY i.item_code) AS codes
    FROM public.stock_items i
    GROUP BY i.clinic_id, btrim(i.item_code)
    HAVING count(*) > 1
  ) x;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Yalnızca baş / son boşlukla ayrışan aynı stok kodları var; önce birini yeniden adlandırın: %', v_missing;
  END IF;

  -- A card without a category migrates as it is; partial saves (activate / deactivate) keep working and the card
  -- form asks for a category on the next full edit. Reported only.
  SELECT count(*) INTO v_n FROM public.stock_items i WHERE btrim(coalesce(i.category, '')) = '';
  IF v_n > 0 THEN
    RAISE NOTICE 'stock_items: % kartın kategorisi boş; kart formu ilk tam düzenlemede kategori isteyecek.', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1.1 Pure helpers (no table access). Internal: never granted (stock__harden_privileges).
-- ---------------------------------------------------------------------------

-- Error contract §1.1. One place for every Turkish text; the key travels in HINT so the UI can branch on it.
-- '%s' in a text is replaced by p_arg; p_detail is a machine value (DETAIL).
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

-- Bulk / count rows (contract E_ROW): '<n>. satır: ' + inner text; the inner code and key are kept, DETAIL = n.
-- Called from an exception handler with the values read by GET STACKED DIAGNOSTICS.
CREATE OR REPLACE FUNCTION public.stock__row_raise(p_row integer, p_state text, p_msg text, p_hint text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = p_row::text || '. satır: ' || coalesce(p_msg, ''),
    ERRCODE = coalesce(nullif(p_state, ''), 'P0001'),
    HINT = coalesce(p_hint, ''),
    DETAIL = p_row::text;
END;
$$;

-- Turkish lower case for search and uniqueness keys (same body as crm__tr_lower / fin__tr_lower; own copy).
CREATE OR REPLACE FUNCTION public.stock__tr_lower(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.lower(pg_catalog.translate(p, 'İIÇĞÖŞÜÂÎÛ', 'iıçğöşüâîû'))
$$;

-- Quantity as a JSON number with trailing zeros trimmed (numeric(14,4) -> 2.5, 40).
CREATE OR REPLACE FUNCTION public.stock__q(p numeric)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.to_jsonb(pg_catalog.trim_scale(p))
$$;

-- §1.5 quantity: not null; > 0 (or >= 0 when allowed); at most 4 decimals; <= 1 000 000.
CREATE OR REPLACE FUNCTION public.stock__qty(p numeric, p_allow_zero boolean DEFAULT false)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR (p_allow_zero AND p < 0) OR (NOT p_allow_zero AND p <= 0) THEN
    PERFORM public.stock__raise('E_QTY');
  END IF;
  IF p <> round(p, 4) OR p > 1000000 THEN
    PERFORM public.stock__raise('E_QTY_SCALE');
  END IF;
  RETURN round(p, 4);
END;
$$;

-- §1.5 unit conversion (SW:1-5): 'usage' keeps the quantity, 'purchase' multiplies by the card factor and rounds to
-- 4 decimals; the result must stay > 0 and within the quantity limit.
CREATE OR REPLACE FUNCTION public.stock__to_usage(p_qty numeric, p_unit text, p_factor numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v numeric;
BEGIN
  IF coalesce(p_unit, 'usage') NOT IN ('usage', 'purchase') THEN
    PERFORM public.stock__raise('E_QTY_UNIT');
  END IF;
  IF coalesce(p_unit, 'usage') = 'purchase' THEN
    v := round(p_qty * p_factor, 4);
  ELSE
    v := round(p_qty, 4);
  END IF;
  IF v IS NULL OR v <= 0 THEN
    PERFORM public.stock__raise('E_QTY_UNIT');
  END IF;
  IF v > 1000000 THEN
    PERFORM public.stock__raise('E_QTY_SCALE');
  END IF;
  RETURN v;
END;
$$;

-- §1.5 GTIN: blank -> NULL; digits only, 8 / 12 / 13 / 14 long, stored left-padded to 14 (PD:38, SR:33).
CREATE OR REPLACE FUNCTION public.stock__gtin(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
BEGIN
  IF v = '' THEN
    RETURN NULL;
  END IF;
  IF v !~ '^[0-9]+$' OR char_length(v) NOT IN (8, 12, 13, 14) THEN
    PERFORM public.stock__raise('E_GTIN');
  END IF;
  RETURN lpad(v, 14, '0');
END;
$$;

-- §1.5 lot: trimmed; blank or any case of 'GENEL' -> 'GENEL'; <= 40; A / B need a real lot (MP:53-56, C23).
CREATE OR REPLACE FUNCTION public.stock__lot(p text, p_level text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
BEGIN
  IF v = '' OR upper(v) = 'GENEL' THEN
    v := 'GENEL';
  END IF;
  IF char_length(v) > 40 THEN
    PERFORM public.stock__raise('E_LOT_FORMAT');
  END IF;
  IF p_level IN ('A', 'B') AND v = 'GENEL' THEN
    PERFORM public.stock__raise('E_LOT_REQUIRED');
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__serial(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := nullif(btrim(coalesce(p, '')), '');
BEGIN
  IF char_length(v) > 40 THEN
    PERFORM public.stock__raise('E_SERIAL_FORMAT');
  END IF;
  RETURN v;
END;
$$;

-- §1.5 expiry: blank -> NULL; a real 'YYYY-MM-DD' day (2099-02-30 is refused, SR:5-9), years 2000..2200.
CREATE OR REPLACE FUNCTION public.stock__expiry(p text)
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
    PERFORM public.stock__raise('E_EXPIRY_INVALID');
  END IF;
  BEGIN
    d := to_date(v, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.stock__raise('E_EXPIRY_INVALID');
  END;
  IF to_char(d, 'YYYY-MM-DD') <> v OR d < DATE '2000-01-01' OR d > DATE '2200-12-31' THEN
    PERFORM public.stock__raise('E_EXPIRY_INVALID');
  END IF;
  RETURN d;
END;
$$;

-- Report / filter day: same rules, error E_DATE_RANGE.
CREATE OR REPLACE FUNCTION public.stock__day(p text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
  d date;
BEGIN
  IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    PERFORM public.stock__raise('E_DATE_RANGE');
  END IF;
  BEGIN
    d := to_date(v, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.stock__raise('E_DATE_RANGE');
  END;
  IF to_char(d, 'YYYY-MM-DD') <> v OR d < DATE '2000-01-01' OR d > DATE '2200-12-31' THEN
    PERFORM public.stock__raise('E_DATE_RANGE');
  END IF;
  RETURN d;
END;
$$;

-- §1.5 reason: trimmed; required and blank -> E_REASON_REQUIRED; > 500 -> E_REASON_LENGTH.
CREATE OR REPLACE FUNCTION public.stock__reason(p text, p_required boolean)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(coalesce(p, ''));
BEGIN
  IF p_required AND v = '' THEN
    PERFORM public.stock__raise('E_REASON_REQUIRED');
  END IF;
  IF char_length(v) > 500 THEN
    PERFORM public.stock__raise('E_REASON_LENGTH');
  END IF;
  RETURN v;
END;
$$;

-- Paging object {offset >= 0 (default 0), limit 1..p_max (default 50)}; anything else -> E_FILTER (P6 crm__page).
CREATE OR REPLACE FUNCTION public.stock__page(p_page jsonb, p_max integer, OUT o_offset integer, OUT o_limit integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_page jsonb := coalesce(p_page, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_page) <> 'object' THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_page) AS k(k_name) WHERE k.k_name NOT IN ('offset', 'limit')) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF (v_page ? 'offset' AND jsonb_typeof(v_page -> 'offset') NOT IN ('number', 'null'))
     OR (v_page ? 'limit' AND jsonb_typeof(v_page -> 'limit') NOT IN ('number', 'null')) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  BEGIN
    o_offset := coalesce((v_page ->> 'offset')::integer, 0);
    o_limit := coalesce((v_page ->> 'limit')::integer, 50);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.stock__raise('E_FILTER');
  END;
  IF o_offset < 0 OR o_limit < 1 OR o_limit > p_max THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
END;
$$;

-- JSON field readers. A wrong JSON type or an unparsable value -> p_err. JSON null and an absent key read as NULL.
CREATE OR REPLACE FUNCTION public.stock__j_text(p jsonb, p_key text, p_err text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('string', 'null') THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  RETURN p ->> p_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__j_uuid(p jsonb, p_key text, p_err text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := public.stock__j_text(p, p_key, p_err);
BEGIN
  IF v IS NULL OR btrim(v) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(v) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  RETURN btrim(v)::uuid;
END;
$$;

-- Numbers: a JSON number, or a string holding a plain decimal ('2.5').
CREATE OR REPLACE FUNCTION public.stock__j_num(p jsonb, p_key text, p_err text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('number', 'string', 'null') THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  v := btrim(p ->> p_key);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  IF v !~ '^-?[0-9]{1,12}(\.[0-9]+)?$' THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  RETURN v::numeric;
END;
$$;

-- Whole numbers only (no fraction), at most 15 digits.
CREATE OR REPLACE FUNCTION public.stock__j_bigint(p jsonb, p_key text, p_err text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('number', 'null') THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  v := p ->> p_key;
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  IF v !~ '^-?[0-9]{1,15}$' THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  RETURN v::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__j_bool(p jsonb, p_key text, p_err text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('boolean', 'null') THEN
    PERFORM public.stock__raise(p_err);
  END IF;
  RETURN (p ->> p_key)::boolean;
END;
$$;

-- True when every key of the object p is listed in p_allowed.
CREATE OR REPLACE FUNCTION public.stock__keys_ok(p jsonb, p_allowed text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT pg_catalog.jsonb_typeof(p) = 'object'
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p) AS k(k_name) WHERE k.k_name <> ALL (p_allowed))
$$;

-- Requests from the SQL editor / service role (no JWT user, not an API role). Same test as crm__is_editor.
CREATE OR REPLACE FUNCTION public.stock__is_editor()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid() IS NULL
     AND coalesce(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated')
     AND coalesce(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
$$;

-- Adds a named constraint if it is missing. p_not_valid: added NOT VALID, validated only when every existing row
-- passes; otherwise a NOTICE and the rule applies to new and changed rows only (0019 §7 / 0021 pattern).
CREATE OR REPLACE FUNCTION public.stock__add_constraint(p_table text, p_name text, p_def text, p_not_valid boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = format('public.%I', p_table)::regclass AND conname = p_name
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s%s', p_table, p_name, p_def,
                   CASE WHEN p_not_valid THEN ' NOT VALID' ELSE '' END);
  END IF;

  IF p_not_valid AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = format('public.%I', p_table)::regclass AND conname = p_name AND NOT convalidated
  ) THEN
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', p_table, p_name);
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE NOTICE '%: % mevcut satırlarda sağlanmıyor; kural şimdilik yalnızca yeni ve değişen satırlara uygulanıyor.',
        p_table, p_name;
    END;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1.2 Permission helpers. The three stock_can_* answer only for the caller and are granted (RLS and the UI use
--     them); the stock__require_* gates are internal and are the first statement of every RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_can_operate()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() IN ('owner', 'admin', 'doctor', 'assistant'), false)
      OR public.has_permission('stock_manage')
$$;

CREATE OR REPLACE FUNCTION public.stock_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false)
      OR public.has_permission('stock_manage')
$$;

CREATE OR REPLACE FUNCTION public.stock_can_view_costs()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false)
      OR public.has_permission('stock_cost_view')
      OR public.has_permission('finance')
$$;

CREATE OR REPLACE FUNCTION public.stock__require_staff()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL OR public.current_app_user_id() IS NULL THEN
    PERFORM public.stock__raise('E_SESSION');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__require_operate()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
BEGIN
  IF NOT public.stock_can_operate() THEN
    PERFORM public.stock__raise('E_OPERATE');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__require_manage()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
BEGIN
  IF NOT public.stock_can_manage() THEN
    PERFORM public.stock__raise('E_MANAGE');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock__require_costs()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
BEGIN
  IF NOT public.stock_can_view_costs() THEN
    PERFORM public.stock__raise('E_COST_READ');
  END IF;
  RETURN v_clinic;
END;
$$;

-- Permission flags carried by every read response, so the UI never re-derives roles.
CREATE OR REPLACE FUNCTION public.stock__flags()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'can_view_costs', public.stock_can_view_costs(),
    'can_operate', public.stock_can_operate(),
    'can_manage', public.stock_can_manage())
$$;

-- ---------------------------------------------------------------------------
-- 2.1 stock_locations (SCH:60-66). Seeded with one 'Ana Depo' default warehouse per clinic (§7.2); rooms are not
--     seeded (the UI offers "Koltuklardan oda oluştur"). kind 'room' and is_default_warehouse are Phase 8 hooks.
--     clinic_id cascades (here and on suppliers, as stock_items does since 0009), so deleting a clinic that never
--     used stock still works with the seeded 'Ana Depo'; a clinic with stock history stays protected because
--     batches, balances and movements keep RESTRICT (only the editor-only stock__purge_test_clinic removes them).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_key text NOT NULL,
  kind text NOT NULL DEFAULT 'room' CHECK (kind IN ('warehouse', 'room', 'sterilization')),
  is_default_warehouse boolean NOT NULL DEFAULT false,
  chair_id uuid REFERENCES public.chairs(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999),
  is_active boolean NOT NULL DEFAULT true,
  legacy_id text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT stock_locations_default_kind CHECK (NOT is_default_warehouse OR (kind = 'warehouse' AND is_active))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_name_key ON public.stock_locations (clinic_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_default_key ON public.stock_locations (clinic_id) WHERE is_default_warehouse;
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_legacy_key ON public.stock_locations (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.2 suppliers (SCH:68-75). fin_counterparty_id is only a pointer (finance-gated on write).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  name_key text NOT NULL,
  phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
  email text NOT NULL DEFAULT '' CHECK (char_length(email) <= 200),
  tax_no text NOT NULL DEFAULT '' CHECK (tax_no ~ '^[0-9]{0,11}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  fin_counterparty_id uuid REFERENCES public.fin_counterparties(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  legacy_id text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_key ON public.suppliers (clinic_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_legacy_key ON public.suppliers (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.3 stock_items (M9:38-53): extended card. Old integer / text columns stay readable as mirrors (§2.3 table).
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS brand text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tracking_level text NOT NULL DEFAULT 'C',
  ADD COLUMN IF NOT EXISTS gtin text,
  ADD COLUMN IF NOT EXISTS sku text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS purchase_unit text NOT NULL DEFAULT 'adet',
  ADD COLUMN IF NOT EXISTS usage_unit text NOT NULL DEFAULT 'adet',
  ADD COLUMN IF NOT EXISTS units_per_purchase numeric(14,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS min_qty numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_qty numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abc_class text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_policy text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS preferred_location_id uuid,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS legacy_id text,
  ADD COLUMN IF NOT EXISTS opening_movement_id uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.users(id);

-- Composite foreign keys need UNIQUE (clinic_id, id).
SELECT public.stock__add_constraint('stock_items', 'stock_items_clinic_id_id_key', 'UNIQUE (clinic_id, id)', false);

SELECT public.stock__add_constraint('stock_items', 'stock_items_brand_len', 'CHECK (char_length(brand) <= 120)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_model_len', 'CHECK (char_length(model) <= 120)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_tracking_level',
  'CHECK (tracking_level IN (''A'', ''B'', ''C''))', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_gtin_format', 'CHECK (gtin ~ ''^[0-9]{14}$'')', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_sku_len', 'CHECK (char_length(sku) <= 60)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_purchase_unit',
  'CHECK (char_length(btrim(purchase_unit)) BETWEEN 1 AND 30)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_usage_unit',
  'CHECK (char_length(btrim(usage_unit)) BETWEEN 1 AND 30)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_units_per_purchase',
  'CHECK (units_per_purchase > 0 AND units_per_purchase <= 100000)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_min_qty', 'CHECK (min_qty >= 0)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_max_qty', 'CHECK (max_qty >= min_qty)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_abc_class',
  'CHECK (abc_class IN ('''', ''A'', ''B'', ''C''))', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_order_policy',
  'CHECK (order_policy IN ('''', ''auto_minmax'', ''weekly'', ''case''))', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_notes_len', 'CHECK (char_length(notes) <= 2000)', false);
-- Existing rows may break these two (M9 had no limits): NOT VALID, validated only when every row passes. Postgres
-- still enforces a NOT VALID check on every UPDATE, and this migration updates every card, so the 2.0 preflight
-- refuses to start while any card breaks them (in practice both are validated here).
SELECT public.stock__add_constraint('stock_items', 'stock_items_item_name_len',
  'CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 200)', true);
SELECT public.stock__add_constraint('stock_items', 'stock_items_item_code_len',
  'CHECK (char_length(btrim(item_code)) BETWEEN 1 AND 40)', true);

-- GTIN unique among ACTIVE cards only (fixes "GTIN uniqueness includes soft-deleted cards", PD:105).
CREATE UNIQUE INDEX IF NOT EXISTS stock_items_gtin_active_key ON public.stock_items (clinic_id, gtin)
  WHERE gtin IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS stock_items_legacy_key ON public.stock_items (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_items_active_review ON public.stock_items (clinic_id, is_active, needs_review);
CREATE INDEX IF NOT EXISTS stock_items_tracking ON public.stock_items (clinic_id, tracking_level);

-- Composite references into the clinic's own suppliers / locations (P1 pattern).
SELECT public.stock__add_constraint('stock_items', 'stock_items_supplier_fkey',
  'FOREIGN KEY (clinic_id, supplier_id) REFERENCES public.suppliers (clinic_id, id)', false);
SELECT public.stock__add_constraint('stock_items', 'stock_items_preferred_location_fkey',
  'FOREIGN KEY (clinic_id, preferred_location_id) REFERENCES public.stock_locations (clinic_id, id)', false);

-- ---------------------------------------------------------------------------
-- 2.4 stock_item_costs (cost-gated). One row per card with a known cost; cents per USAGE unit.
--     id mirrors stock_item_id so audit_row_change() can fill audit_logs.entity_id (NOT NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_item_costs (
  stock_item_id uuid PRIMARY KEY,
  id uuid GENERATED ALWAYS AS (stock_item_id) STORED,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  last_unit_cost_cents bigint CHECK (last_unit_cost_cents IS NULL OR last_unit_cost_cents BETWEEN 0 AND 100000000000),
  legacy_unit_price numeric,
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id)
);

-- ---------------------------------------------------------------------------
-- 2.5 stock_batches (SCH:118-136). Immutable after insert. Serial unique per clinic and ITEM.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  stock_item_id uuid NOT NULL,
  lot_number text NOT NULL DEFAULT 'GENEL' CHECK (char_length(lot_number) BETWEEN 1 AND 40),
  serial_number text CHECK (serial_number IS NULL OR char_length(serial_number) BETWEEN 1 AND 40),
  expiry_date date,
  received_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  created_by uuid REFERENCES public.users(id),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_serial_key ON public.stock_batches (clinic_id, stock_item_id, serial_number)
  WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_batches_item_expiry ON public.stock_batches (clinic_id, stock_item_id, expiry_date);
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_legacy_key ON public.stock_batches (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.6 stock_batch_costs (cost-gated, immutable). No row = cost unknown ("Fiyat girilmemiş").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_batch_costs (
  batch_id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents BETWEEN 0 AND 100000000000),
  FOREIGN KEY (clinic_id, batch_id) REFERENCES public.stock_batches (clinic_id, id)
);

-- ---------------------------------------------------------------------------
-- 2.7 stock_balances (SCH:138-164). Written only by stock__apply; zero rows are kept (count snapshot, CP:15-19).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  stock_item_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity numeric(14,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, location_id),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id),
  FOREIGN KEY (clinic_id, batch_id) REFERENCES public.stock_batches (clinic_id, id),
  FOREIGN KEY (clinic_id, location_id) REFERENCES public.stock_locations (clinic_id, id)
);
CREATE INDEX IF NOT EXISTS stock_balances_item_location ON public.stock_balances (clinic_id, stock_item_id, location_id);
CREATE INDEX IF NOT EXISTS stock_balances_location ON public.stock_balances (clinic_id, location_id) WHERE quantity > 0;

-- ---------------------------------------------------------------------------
-- 2.8 stock_movements: append-only ledger (SCH:166-191). Hook columns po_item_id / request_id (Phase 8) and
--     implant_record_id (Phase 9) stay NULL in Phase 7.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  operation_key uuid NOT NULL,
  line_no smallint NOT NULL,
  stock_item_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN
    ('opening', 'receive', 'issue', 'transfer', 'waste', 'return', 'adjust_in', 'adjust_out', 'correction_reversal')),
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  from_location_id uuid,
  to_location_id uuid,
  patient_id uuid REFERENCES public.patients(id) ON DELETE RESTRICT,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE RESTRICT,
  doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,
  supplier_id uuid,
  document_no text NOT NULL DEFAULT '' CHECK (char_length(document_no) <= 60),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 1100),
  source_movement_id uuid,
  correction_request_id uuid,
  count_id uuid,
  po_item_id uuid,
  request_id uuid,
  implant_record_id uuid,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  legacy_id text,
  UNIQUE (clinic_id, id),
  UNIQUE (operation_key, line_no),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id),
  FOREIGN KEY (clinic_id, batch_id) REFERENCES public.stock_batches (clinic_id, id),
  FOREIGN KEY (clinic_id, from_location_id) REFERENCES public.stock_locations (clinic_id, id),
  FOREIGN KEY (clinic_id, to_location_id) REFERENCES public.stock_locations (clinic_id, id),
  FOREIGN KEY (clinic_id, supplier_id) REFERENCES public.suppliers (clinic_id, id),
  FOREIGN KEY (clinic_id, source_movement_id) REFERENCES public.stock_movements (clinic_id, id),
  CONSTRAINT stock_movements_locations CHECK (CASE movement_type
    WHEN 'opening' THEN from_location_id IS NULL AND to_location_id IS NOT NULL
    WHEN 'receive' THEN from_location_id IS NULL AND to_location_id IS NOT NULL
    WHEN 'return' THEN from_location_id IS NULL AND to_location_id IS NOT NULL
    WHEN 'adjust_in' THEN from_location_id IS NULL AND to_location_id IS NOT NULL
    WHEN 'issue' THEN from_location_id IS NOT NULL AND to_location_id IS NULL
    WHEN 'waste' THEN from_location_id IS NOT NULL AND to_location_id IS NULL
    WHEN 'adjust_out' THEN from_location_id IS NOT NULL AND to_location_id IS NULL
    WHEN 'transfer' THEN from_location_id IS NOT NULL AND to_location_id IS NOT NULL AND from_location_id <> to_location_id
    ELSE (from_location_id IS NOT NULL OR to_location_id IS NOT NULL) END),
  CONSTRAINT stock_movements_receive_only CHECK (movement_type = 'receive' OR (supplier_id IS NULL AND document_no = '')),
  CONSTRAINT stock_movements_return_source CHECK (movement_type <> 'return' OR source_movement_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS stock_movements_item_time ON public.stock_movements (clinic_id, stock_item_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_time ON public.stock_movements (clinic_id, created_at DESC, ref_no DESC);
CREATE INDEX IF NOT EXISTS stock_movements_source ON public.stock_movements (source_movement_id) WHERE source_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_actor ON public.stock_movements (clinic_id, actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_patient ON public.stock_movements (clinic_id, patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_batch ON public.stock_movements (batch_id);
CREATE INDEX IF NOT EXISTS stock_movements_effective ON public.stock_movements (clinic_id, effective_at);
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_legacy_key ON public.stock_movements (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.9 stock_counts (SCH:285-295): one row per counted batch x location, written even without a difference.
--     The count / adjust movement pair is circular; both foreign keys are checked at COMMIT.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  operation_key uuid NOT NULL,
  line_no smallint NOT NULL,
  location_id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  expected_qty numeric(14,4) NOT NULL CHECK (expected_qty >= 0),
  actual_qty numeric(14,4) NOT NULL CHECK (actual_qty >= 0),
  delta numeric(14,4) GENERATED ALWAYS AS (actual_qty - expected_qty) STORED,
  movement_id uuid,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (operation_key, line_no),
  UNIQUE (operation_key, batch_id, location_id),
  FOREIGN KEY (clinic_id, location_id) REFERENCES public.stock_locations (clinic_id, id),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id),
  FOREIGN KEY (clinic_id, batch_id) REFERENCES public.stock_batches (clinic_id, id),
  FOREIGN KEY (clinic_id, movement_id) REFERENCES public.stock_movements (clinic_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS stock_counts_location_time ON public.stock_counts (clinic_id, location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_counts_operation ON public.stock_counts (clinic_id, operation_key);

-- ---------------------------------------------------------------------------
-- 2.10 stock_correction_requests (SCH:307-317). One pending or approved request per movement (unique index).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  movement_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  requested_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  corrected_qty numeric(14,4) CHECK (corrected_qty IS NULL OR corrected_qty >= 0),
  resolution text NOT NULL DEFAULT '' CHECK (char_length(resolution) <= 1000),
  resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  reversal_movement_id uuid,
  reentry_movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  -- Circular with stock_movements.correction_request_id: deferrable, so the editor-only purge can remove both sides.
  FOREIGN KEY (clinic_id, movement_id) REFERENCES public.stock_movements (clinic_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (clinic_id, reversal_movement_id) REFERENCES public.stock_movements (clinic_id, id)
    DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (clinic_id, reentry_movement_id) REFERENCES public.stock_movements (clinic_id, id)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT stock_corr_resolved CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CONSTRAINT stock_corr_approved CHECK (status <> 'approved' OR (corrected_qty IS NOT NULL AND reversal_movement_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_corr_open_key ON public.stock_correction_requests (movement_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS stock_corr_status ON public.stock_correction_requests (clinic_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_corr_requester ON public.stock_correction_requests (clinic_id, requested_by, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2.11 stock_product_requests (SCH:269-283): unknown GTIN -> definition request; unique among PENDING only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_product_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  gtin text NOT NULL CHECK (gtin ~ '^[0-9]{14}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  lot_number text NOT NULL DEFAULT '' CHECK (char_length(lot_number) <= 40),
  serial_number text NOT NULL DEFAULT '' CHECK (char_length(serial_number) <= 40),
  expiry_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
  stock_item_id uuid,
  resolution_note text NOT NULL DEFAULT '' CHECK (char_length(resolution_note) <= 500),
  requested_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id),
  CONSTRAINT stock_preq_resolved CHECK ((status = 'resolved') = (stock_item_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_preq_pending_gtin ON public.stock_product_requests (clinic_id, gtin)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS stock_preq_status ON public.stock_product_requests (clinic_id, status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 2.12 stock_operations: idempotency ledger (SO:26-35). RLS on, no policy, no client privileges.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_operations (
  operation_key uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2.13 user_favorite_items (legacy preferences JSON, PF:3) -> rows; at most 100 per user (stock_set_favorite).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_favorite_items (
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  stock_item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stock_item_id),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id)
);

-- Ledger links that need the later tables (§2.8). count_id is deferred (circular with stock_counts.movement_id).
SELECT public.stock__add_constraint('stock_movements', 'stock_movements_count_fkey',
  'FOREIGN KEY (clinic_id, count_id) REFERENCES public.stock_counts (clinic_id, id) DEFERRABLE INITIALLY DEFERRED', false);
SELECT public.stock__add_constraint('stock_movements', 'stock_movements_correction_fkey',
  'FOREIGN KEY (clinic_id, correction_request_id) REFERENCES public.stock_correction_requests (clinic_id, id)
   DEFERRABLE INITIALLY IMMEDIATE', false);

-- ---------------------------------------------------------------------------
-- 2.15 Trigger functions. SECURITY DEFINER SET search_path = public (the only definer internals), never granted.
--      The custom setting 'stock.internal' = 'on' (transaction-local, set and restored by stock__sync_item, the
--      RPC cores and the data migration) lets the mirrors of the deprecated stock_items columns be written.
-- ---------------------------------------------------------------------------

-- stock_locations / suppliers: trimmed name and its Turkish-folded key (uniqueness, search).
CREATE OR REPLACE FUNCTION public.stock__trg_name_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.name_key := public.stock__tr_lower(NEW.name);
  RETURN NEW;
END;
$$;

-- stock_items BEFORE INSERT OR UPDATE (§2.3).
--   INSERT (service role / SQL editor only; authenticated has no INSERT): a non-zero unit_price and a positive
--   quantity_on_hand are stashed in transaction-local settings and zeroed, so no audit row or later read sees the
--   price in stock_items; the AFTER INSERT trigger moves them into stock_item_costs and an opening movement.
--   An old-style insert that only sets quantity_minimum gets MIN = MAX = that minimum (as the migration does).
--   UPDATE: the six deprecated columns change only through the stock functions ('stock.internal' = 'on').
CREATE OR REPLACE FUNCTION public.stock__trg_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_internal boolean := coalesce(current_setting('stock.internal', true), '') = 'on';
  v_tag text;
BEGIN
  NEW.item_name := btrim(NEW.item_name);
  NEW.item_code := btrim(NEW.item_code);

  IF TG_OP = 'INSERT' THEN
    v_tag := replace(NEW.id::text, '-', '');
    IF coalesce(NEW.unit_price, 0) <> 0 THEN
      PERFORM set_config('stock.pp_' || v_tag, NEW.unit_price::text, true);
    END IF;
    NEW.unit_price := 0;
    IF coalesce(NEW.quantity_on_hand, 0) > 0 THEN
      PERFORM set_config('stock.pq_' || v_tag, NEW.quantity_on_hand::text, true);
    ELSIF coalesce(NEW.quantity_on_hand, 0) < 0 THEN
      RAISE NOTICE 'stock_items %: eksi miktar (%) açılış hareketine aktarılmadı.', NEW.item_code, NEW.quantity_on_hand;
    END IF;
    NEW.quantity_on_hand := 0;
    IF NEW.min_qty = 0 AND NEW.max_qty = 0 AND coalesce(NEW.quantity_minimum, 0) > 0 THEN
      NEW.min_qty := NEW.quantity_minimum;
      NEW.max_qty := NEW.quantity_minimum;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_internal AND (
       NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       OR NEW.quantity_minimum IS DISTINCT FROM OLD.quantity_minimum
       OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
       OR NEW.supplier IS DISTINCT FROM OLD.supplier
       OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date
       OR NEW.last_restocked_at IS DISTINCT FROM OLD.last_restocked_at) THEN
    PERFORM public.stock__raise('E_LEGACY_COLUMNS');
  END IF;

  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;

  -- updated_at moves only when a catalog column changed (not for mirror refreshes).
  IF NOT v_internal
     AND (to_jsonb(NEW) - ARRAY['quantity_on_hand', 'quantity_minimum', 'unit_price', 'supplier', 'expiry_date',
                                'last_restocked_at', 'updated_at', 'opening_movement_id'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['quantity_on_hand', 'quantity_minimum', 'unit_price', 'supplier', 'expiry_date',
                                'last_restocked_at', 'updated_at', 'opening_movement_id']) THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- stock_items AFTER INSERT: stashed price -> stock_item_costs; supplier text -> suppliers row; stashed quantity ->
-- opening movement into the default warehouse (lot 'GENEL'); then the mirrors (keeps app/api/seed consistent).
CREATE OR REPLACE FUNCTION public.stock__trg_items_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tag text := replace(NEW.id::text, '-', '');
  v_price numeric := nullif(coalesce(current_setting('stock.pp_' || v_tag, true), ''), '')::numeric;
  v_qty numeric := nullif(coalesce(current_setting('stock.pq_' || v_tag, true), ''), '')::numeric;
  v_cost bigint;
  v_prev text := coalesce(current_setting('stock.internal', true), '');
  v_name text;
  v_supplier uuid;
BEGIN
  IF v_price IS NOT NULL THEN
    PERFORM set_config('stock.pp_' || v_tag, '', true);
    v_cost := CASE WHEN v_price > 0 AND round(v_price * 100) <= 100000000000 THEN round(v_price * 100)::bigint END;
    INSERT INTO public.stock_item_costs (stock_item_id, clinic_id, last_unit_cost_cents, legacy_unit_price, updated_at)
    VALUES (NEW.id, NEW.clinic_id, v_cost, v_price, now())
    ON CONFLICT (stock_item_id) DO NOTHING;
  END IF;

  v_name := left(btrim(coalesce(NEW.supplier, '')), 200);
  IF NEW.supplier_id IS NULL AND v_name <> '' THEN
    SELECT s.id INTO v_supplier
    FROM public.suppliers s
    WHERE s.clinic_id = NEW.clinic_id AND s.name_key = public.stock__tr_lower(v_name);
    IF v_supplier IS NULL THEN
      INSERT INTO public.suppliers (id, clinic_id, name, name_key)
      VALUES (gen_random_uuid(), NEW.clinic_id, v_name, public.stock__tr_lower(v_name))
      ON CONFLICT (clinic_id, name_key) DO NOTHING
      RETURNING id INTO v_supplier;
      IF v_supplier IS NULL THEN
        SELECT s.id INTO v_supplier
        FROM public.suppliers s
        WHERE s.clinic_id = NEW.clinic_id AND s.name_key = public.stock__tr_lower(v_name);
      END IF;
    END IF;
    PERFORM set_config('stock.internal', 'on', true);
    UPDATE public.stock_items SET supplier_id = v_supplier WHERE id = NEW.id;
    PERFORM set_config('stock.internal', v_prev, true);
  END IF;

  IF v_qty IS NOT NULL THEN
    PERFORM set_config('stock.pq_' || v_tag, '', true);
    IF v_qty > 0 THEN
      PERFORM public.stock__open_legacy_item(NEW.clinic_id, NEW.id, v_qty, NEW.expiry_date, v_cost);
    END IF;
  END IF;

  PERFORM public.stock__sync_item(NEW.clinic_id, NEW.id);
  RETURN NULL;
END;
$$;

-- stock_items BEFORE DELETE: a card with history is deactivated, never deleted (PD:60-82). The SQL editor / service
-- role may delete (test clean-up, 0020 fin__trg_no_delete pattern); the RESTRICT foreign keys still apply.
CREATE OR REPLACE FUNCTION public.stock__trg_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.stock__is_editor() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.stock_item_id = OLD.id) THEN
    PERFORM public.stock__raise('E_ITEM_DELETE');
  END IF;
  RETURN OLD;
END;
$$;

-- stock_batches, stock_batch_costs, stock_counts: immutable after insert for app users. Row changes from the SQL
-- editor / service role pass (test clean-up and the acceptance back-dating step); TRUNCATE is always refused.
CREATE OR REPLACE FUNCTION public.stock__trg_batches_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND public.stock__is_editor() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  PERFORM public.stock__raise('E_HISTORY');
  RETURN NULL;
END;
$$;

-- stock_movements: append-only for app users (SU "Records are never deleted"); the SQL editor / service role may
-- delete rows (test clean-up, fin / crm pattern); TRUNCATE is always refused.
CREATE OR REPLACE FUNCTION public.stock__trg_movements_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND public.stock__is_editor() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  PERFORM public.stock__raise('E_HISTORY');
  RETURN NULL;
END;
$$;

-- stock_balances: the row's item must be its batch's item; updated_at is the server clock.
CREATE OR REPLACE FUNCTION public.stock__trg_balance_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stock_batches b
    WHERE b.id = NEW.batch_id AND b.stock_item_id = NEW.stock_item_id AND b.clinic_id = NEW.clinic_id
  ) THEN
    PERFORM public.stock__raise('E_BATCH');
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
                           OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id) THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- stock_correction_requests: only pending -> approved / rejected, once, and only the decision columns; no DELETE.
-- The SQL editor / service role may delete (test clean-up).
CREATE OR REPLACE FUNCTION public.stock__trg_corr_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL <> 'ROW' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF TG_OP = 'DELETE' AND public.stock__is_editor() THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM public.stock__raise('E_CORR_DONE');
  END IF;
  RETURN NEW;
END;
$$;

-- stock_product_requests: only pending -> resolved / rejected; no DELETE (the SQL editor / service role may delete).
CREATE OR REPLACE FUNCTION public.stock__trg_preq_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL <> 'ROW' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF TG_OP = 'DELETE' AND public.stock__is_editor() THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.stock__raise('E_HISTORY');
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('resolved', 'rejected')
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.gtin IS DISTINCT FROM OLD.gtin OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM public.stock__raise('E_PREQ_DONE');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- clinics AFTER INSERT: every new clinic starts with its 'Ana Depo'.
CREATE OR REPLACE FUNCTION public.stock__trg_clinic_seed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.stock__default_location(NEW.id);
  RETURN NULL;
END;
$$;

-- Trigger wiring (idempotent). audit_row_change is attached later (§7.4 step 3), after the price zeroing.
DROP TRIGGER IF EXISTS stock_name_key ON public.stock_locations;
CREATE TRIGGER stock_name_key
  BEFORE INSERT OR UPDATE ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_name_key();

DROP TRIGGER IF EXISTS stock_name_key ON public.suppliers;
CREATE TRIGGER stock_name_key
  BEFORE INSERT OR UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_name_key();

DROP TRIGGER IF EXISTS stock_items_guard ON public.stock_items;
CREATE TRIGGER stock_items_guard
  BEFORE INSERT OR UPDATE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_items_guard();

DROP TRIGGER IF EXISTS stock_items_after_insert ON public.stock_items;
CREATE TRIGGER stock_items_after_insert
  AFTER INSERT ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_items_after_insert();

DROP TRIGGER IF EXISTS stock_items_no_delete ON public.stock_items;
CREATE TRIGGER stock_items_no_delete
  BEFORE DELETE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_no_delete();

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['stock_batches', 'stock_batch_costs', 'stock_counts']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stock_immutable ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER stock_immutable BEFORE UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.stock__trg_batches_immutable()', v_t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS stock_immutable ON public.stock_movements;
CREATE TRIGGER stock_immutable
  BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_movements_immutable();

DROP TRIGGER IF EXISTS stock_balance_item ON public.stock_balances;
CREATE TRIGGER stock_balance_item
  BEFORE INSERT OR UPDATE ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_balance_item();

DROP TRIGGER IF EXISTS stock_corr_guard ON public.stock_correction_requests;
CREATE TRIGGER stock_corr_guard
  BEFORE UPDATE OR DELETE ON public.stock_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_corr_guard();

DROP TRIGGER IF EXISTS stock_preq_guard ON public.stock_product_requests;
CREATE TRIGGER stock_preq_guard
  BEFORE UPDATE OR DELETE ON public.stock_product_requests
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_preq_guard();

-- TRUNCATE skips row triggers and foreign-key checks: refused on every ledger-like table, for everyone.
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['stock_batches', 'stock_batch_costs', 'stock_balances', 'stock_movements', 'stock_counts',
                             'stock_correction_requests', 'stock_product_requests', 'stock_operations']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stock_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER stock_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.stock__trg_movements_immutable()', v_t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS stock_clinic_seed ON public.clinics;
CREATE TRIGGER stock_clinic_seed
  AFTER INSERT ON public.clinics
  FOR EACH ROW EXECUTE FUNCTION public.stock__trg_clinic_seed();

-- ---------------------------------------------------------------------------
-- 3. Row level security and table privileges. Supabase grants ALL on public tables to anon / authenticated by
--    default, so every stock table gets an explicit revoke and an explicit authenticated grant set. Helpers are
--    wrapped as (SELECT ...) so they are evaluated once per statement. No write policy anywhere.
-- ---------------------------------------------------------------------------

-- stock_items / stock_transactions: every existing policy goes (the M9 insert / update policies and anything added
-- by hand, e.g. a permissive "enable read access" SELECT policy, which would be OR-ed with the clinic filter);
-- exactly one clinic-scoped SELECT policy each is recreated.
ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT p.tablename, p.policyname FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename IN ('stock_items', 'stock_transactions')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', v.policyname, v.tablename);
  END LOOP;
END $$;

CREATE POLICY "stock_items_clinic_isolation" ON public.stock_items
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT public.current_clinic_id()));
-- Revoking the table privilege also revokes every column privilege.
REVOKE ALL ON public.stock_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_items TO authenticated;

-- stock_transactions (M9): left in place and unused; SELECT only.
ALTER TABLE public.stock_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_transactions_clinic_isolation" ON public.stock_transactions
  FOR SELECT TO authenticated
  USING (clinic_id = (SELECT public.current_clinic_id()));
REVOKE ALL ON public.stock_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_transactions TO authenticated;

-- New tables: one SELECT policy each.
DO $$
DECLARE
  v record;
  q record;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('stock_locations', 'stock_locations_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('suppliers', 'suppliers_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_batches', 'stock_batches_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_balances', 'stock_balances_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_movements', 'stock_movements_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_counts', 'stock_counts_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_correction_requests', 'stock_correction_requests_select',
       'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_product_requests', 'stock_product_requests_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('stock_item_costs', 'stock_item_costs_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.stock_can_view_costs())'),
      ('stock_batch_costs', 'stock_batch_costs_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.stock_can_view_costs())'),
      ('user_favorite_items', 'user_favorite_items_select',
       'user_id = (SELECT public.current_app_user_id()) AND clinic_id = (SELECT public.current_clinic_id())')
    ) AS t(tbl, pol, expr)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v.tbl);
    -- Anything left by hand or an earlier shape goes; exactly one SELECT policy remains.
    FOR q IN SELECT p.policyname FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v.tbl LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', q.policyname, v.tbl);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', v.pol, v.tbl, v.expr);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v.tbl);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v.tbl);
  END LOOP;
END $$;

-- stock_operations: RLS on, no policy, no privileges (only the SECURITY DEFINER functions touch it).
ALTER TABLE public.stock_operations ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE
  q record;
BEGIN
  FOR q IN SELECT p.policyname FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'stock_operations' LOOP
    EXECUTE format('DROP POLICY %I ON public.stock_operations', q.policyname);
  END LOOP;
END $$;
REVOKE ALL ON public.stock_operations FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1.4 / 4.0 Core internals. Never granted; SECURITY INVOKER (fail closed, 0020 / 0021 pattern); called only from
--     SECURITY DEFINER RPCs, triggers and this migration, so every query filters by p_clinic. Time-dependent ones
--     take p_today so the self-checks can replay a fixed day.
-- ---------------------------------------------------------------------------

-- Idempotency (§1.4, SO:26-35). Inserted -> NULL (the caller proceeds). A concurrent call with the same key waits
-- on the primary key until the first transaction ends: after a rollback it inserts and proceeds, after a commit it
-- reads the stored result. Same clinic, actor, RPC and arguments -> the stored result with already_saved = true;
-- anything else -> E_OP_KEY.
CREATE OR REPLACE FUNCTION public.stock__op_begin(p_clinic uuid, p_actor uuid, p_key uuid, p_kind text, p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fp text;
  v_inserted uuid;
  v_row public.stock_operations%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN
    PERFORM public.stock__raise('E_OP_KEY_FORMAT');
  END IF;
  v_fp := md5(p_kind || ':' || coalesce(p_args, 'null'::jsonb)::text);

  INSERT INTO public.stock_operations (operation_key, clinic_id, actor_user_id, kind, fingerprint)
  VALUES (p_key, p_clinic, p_actor, p_kind, v_fp)
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING operation_key INTO v_inserted;
  IF v_inserted IS NOT NULL THEN
    -- A key already used by the ledger outside this table (a migrated opening's deterministic key, or rows written
    -- by the SQL editor) is never accepted for a new operation; its rows must not be mixed with the client's.
    IF EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.operation_key = p_key)
       OR EXISTS (SELECT 1 FROM public.stock_counts c WHERE c.operation_key = p_key) THEN
      PERFORM public.stock__raise('E_OP_KEY');
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO v_row FROM public.stock_operations WHERE operation_key = p_key;
  IF v_row.clinic_id IS DISTINCT FROM p_clinic
     OR v_row.actor_user_id IS DISTINCT FROM p_actor
     OR v_row.kind IS DISTINCT FROM p_kind
     OR v_row.fingerprint IS DISTINCT FROM v_fp
     OR v_row.result IS NULL THEN
    PERFORM public.stock__raise('E_OP_KEY');
  END IF;
  RETURN v_row.result || jsonb_build_object('already_saved', true);
END;
$$;

-- Stores the result (never containing cost keys) and returns it with already_saved = false.
CREATE OR REPLACE FUNCTION public.stock__op_finish(p_clinic uuid, p_key uuid, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result jsonb := coalesce(p_result, '{}'::jsonb) - 'already_saved';
BEGIN
  UPDATE public.stock_operations SET result = v_result
  WHERE operation_key = p_key AND clinic_id = p_clinic;
  RETURN v_result || jsonb_build_object('already_saved', false);
END;
$$;

-- The clinic's default warehouse; created (or an existing 'Ana Depo' flagged) when missing (§2.1, §7.2-1).
CREATE OR REPLACE FUNCTION public.stock__default_location(p_clinic uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT l.id INTO v_id FROM public.stock_locations l
  WHERE l.clinic_id = p_clinic AND l.is_default_warehouse;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT l.id INTO v_id FROM public.stock_locations l
  WHERE l.clinic_id = p_clinic AND l.name_key = public.stock__tr_lower('Ana Depo')
  FOR UPDATE;
  IF v_id IS NOT NULL THEN
    UPDATE public.stock_locations
    SET kind = 'warehouse', is_active = true, is_default_warehouse = true, version = version + 1, updated_at = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.stock_locations (id, clinic_id, name, name_key, kind, is_default_warehouse, sort_order)
  VALUES (gen_random_uuid(), p_clinic, 'Ana Depo', public.stock__tr_lower('Ana Depo'), 'warehouse', true, 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- §4.0 Upsert / decrement one balance row; never negative; a serial batch holds 0..1 in total (CO:15).
-- p_delta < 0 locks the row; a missing row or a shortfall raises p_err_key (E_INSUFFICIENT: the available quantity
-- in the text and DETAIL; E_CORR_NEGATIVE: DETAIL = location id).
CREATE OR REPLACE FUNCTION public.stock__apply(p_clinic uuid, p_item uuid, p_batch uuid, p_location uuid,
                                               p_delta numeric, p_err_key text DEFAULT 'E_INSUFFICIENT')
RETURNS numeric
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_qty numeric;
  v_total numeric;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    SELECT sb.quantity INTO v_qty FROM public.stock_balances sb
    WHERE sb.batch_id = p_batch AND sb.location_id = p_location AND sb.clinic_id = p_clinic;
    RETURN coalesce(v_qty, 0);
  END IF;

  IF p_delta < 0 THEN
    SELECT sb.quantity INTO v_qty FROM public.stock_balances sb
    WHERE sb.batch_id = p_batch AND sb.location_id = p_location AND sb.clinic_id = p_clinic
    FOR UPDATE;
    IF v_qty IS NULL OR v_qty + p_delta < 0 THEN
      IF p_err_key = 'E_CORR_NEGATIVE' THEN
        PERFORM public.stock__raise('E_CORR_NEGATIVE', NULL, p_location::text);
      ELSE
        PERFORM public.stock__raise(p_err_key, trim_scale(coalesce(v_qty, 0))::text,
                                    trim_scale(coalesce(v_qty, 0))::text);
      END IF;
    END IF;
    UPDATE public.stock_balances SET quantity = quantity + p_delta
    WHERE batch_id = p_batch AND location_id = p_location
    RETURNING quantity INTO v_qty;
  ELSE
    INSERT INTO public.stock_balances AS t (clinic_id, stock_item_id, batch_id, location_id, quantity)
    VALUES (p_clinic, p_item, p_batch, p_location, p_delta)
    ON CONFLICT (batch_id, location_id) DO UPDATE SET quantity = t.quantity + EXCLUDED.quantity
    RETURNING t.quantity INTO v_qty;
  END IF;

  IF EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.id = p_batch AND b.serial_number IS NOT NULL) THEN
    SELECT coalesce(sum(sb.quantity), 0) INTO v_total FROM public.stock_balances sb WHERE sb.batch_id = p_batch;
    IF v_total > 1 THEN
      PERFORM public.stock__raise('E_SERIAL_MOVE');
    END IF;
  END IF;
  RETURN v_qty;
END;
$$;

-- §4.0 One ledger row. p_line NULL -> next line number of the operation (the operation key is exclusive to one
-- transaction through stock_operations). p_extra keys: patient_id, appointment_id, doctor_id, supplier_id,
-- document_no, reason, source_movement_id, correction_request_id, count_id, effective_at, actor_user_id.
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
    correction_request_id, count_id, actor_user_id, effective_at)
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
    nullif(v_extra ->> 'actor_user_id', '')::uuid,
    coalesce(nullif(v_extra ->> 'effective_at', '')::timestamptz, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- §4.0 FEFO candidates for an outbound move, locked FOR UPDATE in allocation order (MP:99-102):
-- expiry ascending, no expiry last, then oldest receipt. Expired lots only when p_allow_expired (waste, MP:101).
CREATE OR REPLACE FUNCTION public.stock__fefo(p_clinic uuid, p_item uuid, p_location uuid, p_batch uuid,
                                              p_allow_expired boolean, p_today date)
RETURNS TABLE (batch_id uuid, quantity numeric, serial_number text, expiry_date date, lot_number text)
LANGUAGE plpgsql
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT sb.batch_id, sb.quantity::numeric, b.serial_number, b.expiry_date, b.lot_number
  FROM public.stock_balances sb
  JOIN public.stock_batches b ON b.id = sb.batch_id
  WHERE sb.clinic_id = p_clinic
    AND sb.stock_item_id = p_item
    AND sb.location_id = p_location
    AND sb.quantity > 0
    AND (p_batch IS NULL OR sb.batch_id = p_batch)
    AND (p_allow_expired OR b.expiry_date IS NULL OR b.expiry_date >= p_today)
  ORDER BY b.expiry_date ASC NULLS LAST, b.received_at, b.id
  FOR UPDATE OF sb;
END;
$$;

-- §4.0 Shared outbound allocator (issue / transfer / waste). One ledger row per consumed lot (MP:111-118).
-- Returns the movement ids as a JSON array.
CREATE OR REPLACE FUNCTION public.stock__allocate_out(p_clinic uuid, p_op uuid, p_item public.stock_items,
                                                      p_type text, p_qty numeric, p_from uuid, p_to uuid,
                                                      p_batch uuid, p_extra jsonb, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r record;
  v_batches uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_serials text[] := '{}';
  v_avail numeric := 0;
  v_remaining numeric := p_qty;
  v_used numeric;
  v_ids jsonb := '[]'::jsonb;
  v_mid uuid;
  i integer;
BEGIN
  FOR r IN
    SELECT f.batch_id, f.quantity, f.serial_number
    FROM public.stock__fefo(p_clinic, p_item.id, p_from, p_batch, p_type = 'waste', p_today) f
  LOOP
    v_batches := v_batches || r.batch_id;
    v_qtys := v_qtys || r.quantity;
    v_serials := v_serials || r.serial_number;
    v_avail := v_avail + r.quantity;
  END LOOP;

  IF v_avail < p_qty THEN
    PERFORM public.stock__raise('E_INSUFFICIENT', trim_scale(v_avail)::text, trim_scale(v_avail)::text);
  END IF;

  FOR i IN 1 .. coalesce(array_length(v_batches, 1), 0) LOOP
    EXIT WHEN v_remaining <= 0;
    v_used := least(v_remaining, v_qtys[i]);
    IF v_serials[i] IS NOT NULL AND v_used <> 1 THEN
      PERFORM public.stock__raise('E_SERIAL_MOVE');
    END IF;
    PERFORM public.stock__apply(p_clinic, p_item.id, v_batches[i], p_from, -v_used);
    IF p_to IS NOT NULL THEN
      PERFORM public.stock__apply(p_clinic, p_item.id, v_batches[i], p_to, v_used);
    END IF;
    v_mid := public.stock__ledger(p_clinic, p_op, NULL, p_item.id, v_batches[i], p_type, v_used, p_from, p_to, p_extra);
    v_ids := v_ids || to_jsonb(v_mid);
    v_remaining := round(v_remaining - v_used, 4);
  END LOOP;
  RETURN v_ids;
END;
$$;

-- §4.0 The card for a movement, locked FOR NO KEY UPDATE (the per-item mutex). Missing, inactive or draft ->
-- E_ITEM_NOT_FOUND (MP:18-20).
CREATE OR REPLACE FUNCTION public.stock__item_for_move(p_clinic uuid, p_item uuid)
RETURNS public.stock_items
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v public.stock_items%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.stock_items i
  WHERE i.id = p_item AND i.clinic_id = p_clinic
  FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT v.is_active OR v.needs_review THEN
    PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
  END IF;
  RETURN v;
END;
$$;

-- §4.0 An active location of the clinic, locked FOR SHARE (blocks a concurrent deactivation, SO:20-24).
CREATE OR REPLACE FUNCTION public.stock__location_active(p_clinic uuid, p_location uuid)
RETURNS public.stock_locations
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v public.stock_locations%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.stock_locations l
  WHERE l.id = p_location AND l.clinic_id = p_clinic
  FOR SHARE;
  IF NOT FOUND OR NOT v.is_active THEN
    PERFORM public.stock__raise('E_LOCATION');
  END IF;
  RETURN v;
END;
$$;

-- §4.0 Clinic consistency of the patient / appointment / doctor given on an issue (checked here, not by new
-- constraints on tables another workflow owns).
CREATE OR REPLACE FUNCTION public.stock__check_patient_refs(p_clinic uuid, p_patient uuid, p_appointment uuid, p_doctor uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_patient IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = p_patient AND p.clinic_id = p_clinic AND coalesce(p.is_active, true)
  ) THEN
    PERFORM public.stock__raise('E_PATIENT');
  END IF;
  IF p_doctor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.doctors d JOIN public.users u ON u.id = d.user_id
    WHERE d.id = p_doctor AND d.clinic_id = p_clinic AND u.clinic_id = p_clinic AND coalesce(u.is_active, false)
  ) THEN
    PERFORM public.stock__raise('E_DOCTOR');
  END IF;
  IF p_appointment IS NOT NULL AND (p_patient IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.id = p_appointment AND a.clinic_id = p_clinic AND a.patient_id = p_patient
  )) THEN
    PERFORM public.stock__raise('E_APPOINTMENT');
  END IF;
END;
$$;

-- §2.3 Mirrors of the deprecated stock_items columns, recomputed in one UPDATE at the end of every RPC for every
-- touched card: quantity_on_hand = floor(usable stock) capped to int4, quantity_minimum = ceil(MIN),
-- supplier = supplier name, expiry_date = earliest expiry among balances > 0, last_restocked_at = latest receipt
-- (a migrated opening counts with its batch receipt time, which keeps the legacy restock date).
CREATE OR REPLACE FUNCTION public.stock__sync_item(p_clinic uuid, p_item uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_today date := public.clinic_today();
  v_prev text := coalesce(current_setting('stock.internal', true), '');
BEGIN
  PERFORM set_config('stock.internal', 'on', true);
  UPDATE public.stock_items i
  SET quantity_on_hand = least(floor(coalesce((
        SELECT sum(sb.quantity)
        FROM public.stock_balances sb
        JOIN public.stock_batches b ON b.id = sb.batch_id
        WHERE sb.stock_item_id = i.id AND (b.expiry_date IS NULL OR b.expiry_date >= v_today)), 0)), 2147483647)::integer,
      quantity_minimum = least(ceil(i.min_qty), 2147483647)::integer,
      supplier = (SELECT s.name FROM public.suppliers s WHERE s.id = i.supplier_id),
      expiry_date = (
        SELECT min(b.expiry_date)
        FROM public.stock_balances sb
        JOIN public.stock_batches b ON b.id = sb.batch_id
        WHERE sb.stock_item_id = i.id AND sb.quantity > 0),
      last_restocked_at = coalesce((
        SELECT max(CASE WHEN m.movement_type = 'opening' THEN b.received_at ELSE m.effective_at END)
        FROM public.stock_movements m
        JOIN public.stock_batches b ON b.id = m.batch_id
        WHERE m.stock_item_id = i.id AND m.movement_type IN ('receive', 'opening')), i.last_restocked_at)
  WHERE i.id = p_item AND i.clinic_id = p_clinic;
  PERFORM set_config('stock.internal', v_prev, true);
END;
$$;

-- §7.3 Opening movement of a migrated (or service-role inserted) card: batch 'GENEL' with the old expiry, optional
-- batch cost, balance in the default warehouse, ledger row 'opening' with the deterministic operation key
-- md5('stock-opening:' || item id), so a re-run can never duplicate it. Skipped when the card already has a batch.
CREATE OR REPLACE FUNCTION public.stock__open_legacy_item(p_clinic uuid, p_item uuid, p_qty numeric, p_expiry date,
                                                          p_cost_cents bigint)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_loc uuid;
  v_batch uuid;
  v_received timestamptz;
  v_mid uuid;
  v_prev text := coalesce(current_setting('stock.internal', true), '');
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.stock_item_id = p_item) THEN
    RETURN NULL;
  END IF;

  -- The deterministic key is reserved in the idempotency ledger (no actor, no result), so a client that sends it
  -- gets E_OP_KEY instead of appending to the opening (§1.4).
  INSERT INTO public.stock_operations (operation_key, clinic_id, actor_user_id, kind, fingerprint, result)
  VALUES (md5('stock-opening:' || p_item::text)::uuid, p_clinic, NULL, 'opening', 'opening', NULL)
  ON CONFLICT (operation_key) DO NOTHING;

  v_loc := public.stock__default_location(p_clinic);
  SELECT coalesce(i.last_restocked_at, i.created_at) INTO v_received
  FROM public.stock_items i WHERE i.id = p_item AND i.clinic_id = p_clinic;

  INSERT INTO public.stock_batches (clinic_id, stock_item_id, lot_number, serial_number, expiry_date, received_at)
  VALUES (p_clinic, p_item, 'GENEL', NULL, p_expiry, coalesce(v_received, now()))
  RETURNING id INTO v_batch;
  IF p_cost_cents IS NOT NULL THEN
    INSERT INTO public.stock_batch_costs (batch_id, clinic_id, unit_cost_cents) VALUES (v_batch, p_clinic, p_cost_cents);
  END IF;

  PERFORM public.stock__apply(p_clinic, p_item, v_batch, v_loc, round(p_qty, 4));
  v_mid := public.stock__ledger(p_clinic, md5('stock-opening:' || p_item::text)::uuid, 1, p_item, v_batch, 'opening',
                                round(p_qty, 4), NULL, v_loc,
                                jsonb_build_object('reason', 'Açılış bakiyesi (eski stok kaydından aktarıldı)'));

  PERFORM set_config('stock.internal', 'on', true);
  UPDATE public.stock_items SET opening_movement_id = v_mid WHERE id = p_item;
  PERFORM set_config('stock.internal', v_prev, true);
  RETURN v_mid;
END;
$$;

-- §4.1 One receipt (stock_receive and every line of stock_bulk_receive). The card must already be locked by the
-- caller when several cards are involved (bulk locks them all in id order first). Returns the movement id.
CREATE OR REPLACE FUNCTION public.stock__receive_line(
  p_clinic uuid, p_actor uuid, p_op uuid, p_today date, p_can_cost boolean,
  p_item_id uuid, p_to uuid, p_quantity numeric, p_quantity_unit text, p_units_per_purchase numeric,
  p_lot text, p_serial text, p_expiry text, p_cost bigint, p_cost_unit text,
  p_supplier uuid, p_document_no text, p_reason text)
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
    jsonb_build_object('supplier_id', p_supplier, 'document_no', v_doc, 'reason', v_reason, 'actor_user_id', p_actor));

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

-- §4.9 Correction decision core (used by stock_resolve_correction and the self-check replay). The request is
-- locked first, then its card. Approval writes a full reversal plus a re-entry that keeps the original
-- effective_at; balances change only by the net difference (negative side first, E_CORR_NEGATIVE).
-- Returns {"movement_ids": [...], "stock_item_id": uuid | null}.
CREATE OR REPLACE FUNCTION public.stock__resolve_core(p_clinic uuid, p_actor uuid, p_op uuid, p_request uuid,
                                                      p_action text, p_qty numeric, p_resolution text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_req public.stock_correction_requests%ROWTYPE;
  m public.stock_movements%ROWTYPE;
  v_item public.stock_items%ROWTYPE;
  v_res text := btrim(coalesce(p_resolution, ''));
  v_serial boolean;
  v_delta numeric;
  v_net numeric;
  v_total numeric;
  v_rev uuid;
  v_re uuid;
  v_ids jsonb := '[]'::jsonb;
  v_lr record;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('approve', 'reject') THEN
    PERFORM public.stock__raise('E_CORR_ACTION');
  END IF;
  IF char_length(v_res) NOT BETWEEN 3 AND 1000 THEN
    PERFORM public.stock__raise('E_CORR_RESOLUTION');
  END IF;

  SELECT * INTO v_req FROM public.stock_correction_requests r
  WHERE r.id = p_request AND r.clinic_id = p_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_CORR_NOT_FOUND');
  END IF;
  IF v_req.status <> 'pending' THEN
    PERFORM public.stock__raise('E_CORR_DONE');
  END IF;

  IF p_action = 'reject' THEN
    UPDATE public.stock_correction_requests
    SET status = 'rejected', resolution = v_res, resolved_by = p_actor, resolved_at = now()
    WHERE id = v_req.id;
    RETURN jsonb_build_object('movement_ids', '[]'::jsonb, 'stock_item_id', NULL);
  END IF;

  SELECT * INTO m FROM public.stock_movements mv WHERE mv.id = v_req.movement_id AND mv.clinic_id = p_clinic;
  SELECT * INTO v_item FROM public.stock_items i
  WHERE i.id = m.stock_item_id AND i.clinic_id = p_clinic
  FOR NO KEY UPDATE;
  IF NOT v_item.is_active THEN
    PERFORM public.stock__raise('E_ITEM_INACTIVE');
  END IF;

  v_serial := EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.id = m.batch_id AND b.serial_number IS NOT NULL);
  IF p_qty IS NULL OR p_qty < 0 OR p_qty <> round(p_qty, 4) OR p_qty > 1000000 OR p_qty = m.quantity THEN
    PERFORM public.stock__raise('E_CORR_QTY');
  END IF;
  IF v_item.tracking_level = 'A' AND p_qty <> trunc(p_qty) THEN
    PERFORM public.stock__raise('E_CORR_INTEGER');
  END IF;
  IF v_serial AND p_qty > 1 THEN
    PERFORM public.stock__raise('E_CORR_SERIAL');
  END IF;
  IF m.po_item_id IS NOT NULL THEN
    PERFORM public.stock__raise('E_CORR_ORDER');
  END IF;
  IF m.movement_type = 'issue' AND EXISTS (
    SELECT 1 FROM public.stock_movements r
    WHERE r.source_movement_id = m.id AND r.movement_type = 'return'
  ) THEN
    PERFORM public.stock__raise('E_CORR_RETURNED');
  END IF;

  v_delta := round(p_qty - m.quantity, 4);
  -- Serial batch: the batch total after the net change must stay within 0..1 (CO:15).
  IF v_serial THEN
    v_net := (CASE WHEN m.to_location_id IS NOT NULL THEN v_delta ELSE 0 END)
           - (CASE WHEN m.from_location_id IS NOT NULL THEN v_delta ELSE 0 END);
    SELECT coalesce(sum(sb.quantity), 0) INTO v_total FROM public.stock_balances sb WHERE sb.batch_id = m.batch_id;
    IF v_total + v_net < 0 OR v_total + v_net > 1 THEN
      PERFORM public.stock__raise('E_CORR_SERIAL');
    END IF;
  END IF;

  -- Locations in id order, FOR SHARE (blocks a concurrent stock_save_location deactivation, as every other write
  -- path does); a location that would gain stock must be active (E_LOCATION, "inactive locations hold no stock").
  FOR v_lr IN
    SELECT l.id, l.is_active FROM public.stock_locations l
    WHERE l.clinic_id = p_clinic AND l.id IN (m.from_location_id, m.to_location_id)
    ORDER BY l.id
    FOR SHARE
  LOOP
    IF NOT v_lr.is_active AND ((v_lr.id = m.to_location_id AND v_delta > 0)
                               OR (v_lr.id = m.from_location_id AND v_delta < 0)) THEN
      PERFORM public.stock__raise('E_LOCATION');
    END IF;
  END LOOP;

  -- Net balance change (CO:16-19): from gets -delta, to gets +delta; the negative side first.
  IF v_delta < 0 THEN
    IF m.to_location_id IS NOT NULL THEN
      PERFORM public.stock__apply(p_clinic, m.stock_item_id, m.batch_id, m.to_location_id, v_delta, 'E_CORR_NEGATIVE');
    END IF;
    IF m.from_location_id IS NOT NULL THEN
      PERFORM public.stock__apply(p_clinic, m.stock_item_id, m.batch_id, m.from_location_id, -v_delta, 'E_CORR_NEGATIVE');
    END IF;
  ELSE
    IF m.from_location_id IS NOT NULL THEN
      PERFORM public.stock__apply(p_clinic, m.stock_item_id, m.batch_id, m.from_location_id, -v_delta, 'E_CORR_NEGATIVE');
    END IF;
    IF m.to_location_id IS NOT NULL THEN
      PERFORM public.stock__apply(p_clinic, m.stock_item_id, m.batch_id, m.to_location_id, v_delta, 'E_CORR_NEGATIVE');
    END IF;
  END IF;

  -- Ledger: full reversal now (CO:21), re-entry on the original business time (CO:22).
  v_rev := public.stock__ledger(p_clinic, p_op, NULL, m.stock_item_id, m.batch_id, 'correction_reversal', m.quantity,
    m.to_location_id, m.from_location_id,
    jsonb_build_object('source_movement_id', m.id, 'correction_request_id', v_req.id, 'actor_user_id', p_actor,
                       'reason', 'Düzeltme #' || v_req.ref_no::text || ': ' || v_res));
  v_ids := v_ids || to_jsonb(v_rev);
  IF p_qty > 0 THEN
    v_re := public.stock__ledger(p_clinic, p_op, NULL, m.stock_item_id, m.batch_id, m.movement_type, p_qty,
      m.from_location_id, m.to_location_id,
      jsonb_build_object('source_movement_id', m.id, 'correction_request_id', v_req.id, 'actor_user_id', p_actor,
                         'patient_id', m.patient_id, 'appointment_id', m.appointment_id, 'doctor_id', m.doctor_id,
                         'supplier_id', m.supplier_id, 'document_no', m.document_no,
                         'effective_at', m.effective_at,
                         'reason', 'Düzeltilen kayıt #' || m.ref_no::text || ': ' || v_res));
    v_ids := v_ids || to_jsonb(v_re);
  END IF;

  UPDATE public.stock_correction_requests
  SET status = 'approved', corrected_qty = p_qty, resolution = v_res, resolved_by = p_actor, resolved_at = now(),
      reversal_movement_id = v_rev, reentry_movement_id = v_re
  WHERE id = v_req.id;

  RETURN jsonb_build_object('movement_ids', v_ids, 'stock_item_id', m.stock_item_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.0 Read internals. Plain LANGUAGE sql STABLE without SECURITY DEFINER / SET clause, every name schema-qualified,
--     so the planner inlines them and pushes filters down (P1 §3.4 pattern). Only ever called from SECURITY DEFINER
--     functions. Levels / expiry are served through these and the read RPCs, never through views (a view would run
--     with its owner's rights and bypass the cost gate).
-- ---------------------------------------------------------------------------

-- Per card (active or not): total, usable (no expiry or expiry >= today), expired, next expiry over balances > 0.
CREATE OR REPLACE FUNCTION public.stock__levels(p_clinic uuid, p_today date)
RETURNS TABLE (stock_item_id uuid, total_qty numeric, usable_qty numeric, expired_qty numeric, next_expiry date,
               location_count integer, batch_count integer)
LANGUAGE sql
STABLE
AS $$
  SELECT i.id,
         coalesce(sum(sb.quantity), 0)::numeric,
         coalesce(sum(sb.quantity) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= p_today), 0)::numeric,
         coalesce(sum(sb.quantity) FILTER (WHERE b.expiry_date < p_today), 0)::numeric,
         min(b.expiry_date) FILTER (WHERE sb.quantity > 0),
         (count(DISTINCT sb.location_id) FILTER (WHERE sb.quantity > 0))::integer,
         (count(DISTINCT sb.batch_id) FILTER (WHERE sb.quantity > 0))::integer
  FROM public.stock_items i
  LEFT JOIN public.stock_balances sb ON sb.stock_item_id = i.id AND sb.clinic_id = i.clinic_id
  LEFT JOIN public.stock_batches b ON b.id = sb.batch_id
  WHERE i.clinic_id = p_clinic
  GROUP BY i.id
$$;

-- Balances > 0 with their batch cost (NULL = uncosted). Expired stock included (SM dashboard value).
CREATE OR REPLACE FUNCTION public.stock__value_rows(p_clinic uuid)
RETURNS TABLE (stock_item_id uuid, batch_id uuid, location_id uuid, quantity numeric, unit_cost_cents bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT sb.stock_item_id, sb.batch_id, sb.location_id, sb.quantity::numeric, bc.unit_cost_cents
  FROM public.stock_balances sb
  LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = sb.batch_id
  WHERE sb.clinic_id = p_clinic AND sb.quantity > 0
$$;

-- §1.7 expiry watch: balances > 0 expiring within p_days (expired included); expired < today, critical <= 30 days.
CREATE OR REPLACE FUNCTION public.stock__expiry_rows(p_clinic uuid, p_today date, p_days integer)
RETURNS TABLE (stock_item_id uuid, batch_id uuid, location_id uuid, quantity numeric, lot_number text,
               serial_number text, expiry_date date, days_left integer, state text)
LANGUAGE sql
STABLE
AS $$
  SELECT sb.stock_item_id, sb.batch_id, sb.location_id, sb.quantity::numeric, b.lot_number, b.serial_number,
         b.expiry_date, (b.expiry_date - p_today)::integer,
         CASE WHEN b.expiry_date < p_today THEN 'expired'
              WHEN b.expiry_date <= p_today + 30 THEN 'critical'
              ELSE 'warning' END
  FROM public.stock_balances sb
  JOIN public.stock_batches b ON b.id = sb.batch_id
  WHERE sb.clinic_id = p_clinic
    AND sb.quantity > 0
    AND b.expiry_date IS NOT NULL
    AND b.expiry_date <= p_today + p_days
$$;

-- §5.2 level row of every card of the clinic, plus the columns the read RPCs filter and sort on.
-- Cost key last_unit_cost_cents only when p_can_cost (absent otherwise, never 0).
CREATE OR REPLACE FUNCTION public.stock__item_rows(p_clinic uuid, p_today date, p_actor uuid, p_can_cost boolean)
RETURNS TABLE (id uuid, item_name text, category text, tracking_level text, is_active boolean, needs_review boolean,
               search text, gtin text, critical boolean, usable_qty numeric, min_qty numeric, max_qty numeric,
               units_per_purchase numeric, usage_unit text, is_favorite boolean, has_history boolean,
               next_expiry date, j jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT x.id, x.item_name, x.category, x.tracking_level, x.is_active, x.needs_review, x.search, x.gtin, x.critical,
         x.usable_qty, x.min_qty, x.max_qty, x.units_per_purchase, x.usage_unit, x.is_favorite, x.has_history,
         x.next_expiry,
         pg_catalog.jsonb_build_object(
           'id', x.id, 'item_code', x.item_code, 'item_name', x.item_name, 'brand', x.brand, 'model', x.model,
           'category', x.category, 'tracking_level', x.tracking_level, 'gtin', x.gtin, 'sku', x.sku,
           'purchase_unit', x.purchase_unit, 'usage_unit', x.usage_unit,
           'units_per_purchase', public.stock__q(x.units_per_purchase),
           'min_qty', public.stock__q(x.min_qty), 'max_qty', public.stock__q(x.max_qty),
           'abc_class', x.abc_class, 'order_policy', x.order_policy, 'needs_review', x.needs_review,
           'is_active', x.is_active, 'version', x.version)
         || pg_catalog.jsonb_build_object(
           'supplier_id', x.supplier_id, 'supplier_name', x.supplier_name,
           'preferred_location_id', x.preferred_location_id, 'preferred_location_name', x.preferred_location_name,
           'total_qty', public.stock__q(x.total_qty), 'usable_qty', public.stock__q(x.usable_qty),
           'expired_qty', public.stock__q(x.expired_qty), 'next_expiry', x.next_expiry,
           'days_to_expiry', (x.next_expiry - p_today),
           'state', CASE WHEN x.critical AND x.usable_qty = 0 THEN 'out' WHEN x.critical THEN 'critical' ELSE 'ok' END,
           'fill_pct', CASE WHEN x.max_qty > 0 THEN round(least(100, x.usable_qty / x.max_qty * 100)) END,
           'is_favorite', x.is_favorite, 'has_history', x.has_history)
         || CASE WHEN p_can_cost THEN pg_catalog.jsonb_build_object('last_unit_cost_cents', x.last_unit_cost_cents)
                 ELSE '{}'::jsonb END
  FROM (
    SELECT i.id, i.item_code, i.item_name, i.brand, i.model, i.category, i.tracking_level, i.gtin, i.sku,
           i.purchase_unit, i.usage_unit, i.units_per_purchase, i.min_qty, i.max_qty, i.abc_class, i.order_policy,
           i.needs_review, i.is_active, i.version, i.supplier_id, s.name AS supplier_name, i.preferred_location_id,
           pl.name AS preferred_location_name, l.total_qty, l.usable_qty, l.expired_qty, l.next_expiry,
           public.stock__tr_lower(concat_ws(' ', i.item_name, i.brand, i.model, i.category, i.sku, i.item_code,
                                            i.gtin)) AS search,
           (i.is_active AND NOT i.needs_review AND i.max_qty > 0 AND l.usable_qty <= i.min_qty) AS critical,
           (f.user_id IS NOT NULL) AS is_favorite,
           EXISTS (SELECT 1 FROM public.stock_batches hb WHERE hb.stock_item_id = i.id) AS has_history,
           c.last_unit_cost_cents
    FROM public.stock_items i
    JOIN public.stock__levels(p_clinic, p_today) l ON l.stock_item_id = i.id
    LEFT JOIN public.suppliers s ON s.id = i.supplier_id
    LEFT JOIN public.stock_locations pl ON pl.id = i.preferred_location_id
    LEFT JOIN public.user_favorite_items f ON f.user_id = p_actor AND f.stock_item_id = i.id
    LEFT JOIN public.stock_item_costs c ON c.stock_item_id = i.id AND p_can_cost
    WHERE i.clinic_id = p_clinic
  ) x
$$;

-- §5.4 history row of every movement of the clinic (patient / doctor / actor names, correction state, return and
-- correction permissions of the caller).
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
              AND NOT cs.is_open AND (coalesce(m.actor_user_id = p_actor, false) OR p_can_manage)),
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

-- §4.0 result of every movement RPC: the written rows and the new levels of the touched cards. No cost keys.
CREATE OR REPLACE FUNCTION public.stock__move_result(p_clinic uuid, p_op uuid, p_ids jsonb, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH ids AS (
    SELECT (x.v)::uuid AS id FROM pg_catalog.jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) AS x(v)
  ), mv AS (
    SELECT m.* FROM public.stock_movements m WHERE m.clinic_id = p_clinic AND m.id IN (SELECT ids.id FROM ids)
  )
  SELECT pg_catalog.jsonb_build_object(
    'ok', true,
    'operation_key', p_op,
    'movements', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', mv.id, 'ref_no', mv.ref_no, 'movement_type', mv.movement_type,
               'stock_item_id', mv.stock_item_id, 'batch_id', mv.batch_id, 'lot_number', b.lot_number,
               'serial_number', b.serial_number, 'expiry_date', b.expiry_date,
               'quantity', public.stock__q(mv.quantity), 'from_location_id', mv.from_location_id,
               'to_location_id', mv.to_location_id, 'effective_at', mv.effective_at) ORDER BY mv.ref_no)
      FROM mv JOIN public.stock_batches b ON b.id = mv.batch_id), '[]'::jsonb),
    'items', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', l.stock_item_id, 'usable_qty', public.stock__q(l.usable_qty),
               'total_qty', public.stock__q(l.total_qty), 'expired_qty', public.stock__q(l.expired_qty),
               'next_expiry', l.next_expiry) ORDER BY l.stock_item_id)
      FROM public.stock__levels(p_clinic, p_today) l
      WHERE l.stock_item_id IN (SELECT DISTINCT mv.stock_item_id FROM mv)), '[]'::jsonb))
$$;

-- Card JSON for write results and the detail page: the level row (no cost) plus notes, timestamps, locked fields
-- (PD:34-36) and the legacy mirrors.
CREATE OR REPLACE FUNCTION public.stock__item_json(p_clinic uuid, p_item uuid, p_actor uuid, p_can_cost boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT r.j || pg_catalog.jsonb_build_object(
           'notes', i.notes, 'created_at', i.created_at, 'updated_at', i.updated_at,
           'locked_fields', CASE WHEN r.has_history
                                 THEN '["tracking_level","purchase_unit","usage_unit","units_per_purchase"]'::jsonb
                                 ELSE '[]'::jsonb END,
           'legacy', pg_catalog.jsonb_build_object('quantity_on_hand', i.quantity_on_hand,
                                                   'quantity_minimum', i.quantity_minimum,
                                                   'opening_movement_id', i.opening_movement_id))
  FROM public.stock__item_rows(p_clinic, public.clinic_today(), p_actor, p_can_cost) r
  JOIN public.stock_items i ON i.id = r.id
  WHERE r.id = p_item
$$;

-- §5.8 correction request JSON with its movement (history row shape).
CREATE OR REPLACE FUNCTION public.stock__corr_json(p_clinic uuid, p_request uuid, p_actor uuid, p_can_manage boolean,
                                                   p_can_operate boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', r.id, 'ref_no', r.ref_no, 'status', r.status, 'reason', r.reason, 'resolution', r.resolution,
           'corrected_qty', public.stock__q(r.corrected_qty), 'requested_by', r.requested_by,
           'requested_by_name', ru.full_name, 'resolved_by', r.resolved_by, 'resolved_by_name', vu.full_name,
           'created_at', r.created_at, 'resolved_at', r.resolved_at,
           'reversal_movement_id', r.reversal_movement_id, 'reentry_movement_id', r.reentry_movement_id,
           'movement_id', r.movement_id, 'movement', h.j)
  FROM public.stock_correction_requests r
  LEFT JOIN public.users ru ON ru.id = r.requested_by
  LEFT JOIN public.users vu ON vu.id = r.resolved_by
  LEFT JOIN public.stock__history_rows(p_clinic, p_actor, p_can_manage, p_can_operate) h ON h.id = r.movement_id
  WHERE r.id = p_request AND r.clinic_id = p_clinic
$$;

-- §5.9 product definition request JSON (carries lot / serial / expiry so the UI can resume the receipt).
CREATE OR REPLACE FUNCTION public.stock__preq_json(p_clinic uuid, p_request uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', r.id, 'gtin', r.gtin, 'name', r.name, 'note', r.note, 'lot_number', r.lot_number,
           'serial_number', r.serial_number, 'expiry_date', r.expiry_date, 'status', r.status,
           'stock_item_id', r.stock_item_id, 'item_name', i.item_name, 'resolution_note', r.resolution_note,
           'requested_by', r.requested_by, 'requested_by_name', ru.full_name,
           'resolved_by_name', vu.full_name, 'created_at', r.created_at, 'updated_at', r.updated_at,
           'resolved_at', r.resolved_at)
  FROM public.stock_product_requests r
  LEFT JOIN public.stock_items i ON i.id = r.stock_item_id
  LEFT JOIN public.users ru ON ru.id = r.requested_by
  LEFT JOIN public.users vu ON vu.id = r.resolved_by
  WHERE r.id = p_request AND r.clinic_id = p_clinic
$$;

-- ---------------------------------------------------------------------------
-- 7. Migration of existing data. Idempotent: a card that already has a batch or an opening movement is never
--    migrated again; costs are copied once (ON CONFLICT DO NOTHING); suppliers are matched by folded name.
-- ---------------------------------------------------------------------------

-- 7.1 Snapshot for the self-checks (§8.3). to_migrate marks the cards this run turns into opening movements.
DROP TABLE IF EXISTS pg_temp.stock__m24_snapshot;
CREATE TEMP TABLE stock__m24_snapshot ON COMMIT DROP AS
SELECT i.id, i.clinic_id, i.item_code, i.quantity_on_hand, i.quantity_minimum, i.unit_price, i.supplier,
       i.expiry_date, i.last_restocked_at,
       (i.opening_movement_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.stock_item_id = i.id)) AS to_migrate
FROM public.stock_items i;

DO $$
DECLARE
  r record;
  v_n bigint;
  v_codes text;
BEGIN
  PERFORM set_config('stock.internal', 'on', true);

  -- 7.2-1 'Ana Depo' per clinic (an unflagged 'Ana Depo' is flagged instead).
  PERFORM public.stock__default_location(c.id) FROM public.clinics c;

  -- 7.2-2 Suppliers from the old free-text column: one row per folded name and clinic, named with the most
  -- frequent original spelling (ties: alphabetical).
  INSERT INTO public.suppliers (id, clinic_id, name, name_key)
  SELECT gen_random_uuid(), x.clinic_id, x.name, x.key
  FROM (
    SELECT DISTINCT ON (s.clinic_id, s.key) s.clinic_id, s.key, s.name
    FROM (
      SELECT i.clinic_id,
             public.stock__tr_lower(left(btrim(i.supplier), 200)) AS key,
             left(btrim(i.supplier), 200) AS name,
             count(*) AS n
      FROM public.stock_items i
      WHERE btrim(coalesce(i.supplier, '')) <> ''
      GROUP BY 1, 2, 3
    ) s
    ORDER BY s.clinic_id, s.key, s.n DESC, s.name
  ) x
  ON CONFLICT (clinic_id, name_key) DO NOTHING;

  UPDATE public.stock_items i
  SET supplier_id = s.id
  FROM public.suppliers s
  WHERE i.supplier_id IS NULL
    AND btrim(coalesce(i.supplier, '')) <> ''
    AND s.clinic_id = i.clinic_id
    AND s.name_key = public.stock__tr_lower(left(btrim(i.supplier), 200));

  -- 7.2-3 Catalog defaults: tracking level C, units 'adet' x 1 (column defaults), MIN = MAX = the old minimum.
  SELECT count(*) INTO v_n
  FROM stock__m24_snapshot s
  WHERE s.to_migrate AND s.quantity_minimum < 0;
  IF v_n > 0 THEN
    RAISE NOTICE 'stock_items: % kartta eksi minimum vardı; MIN / MAX 0 olarak aktarıldı.', v_n;
  END IF;

  UPDATE public.stock_items i
  SET min_qty = greatest(s.quantity_minimum, 0),
      max_qty = greatest(s.quantity_minimum, 0)
  FROM stock__m24_snapshot s
  WHERE s.id = i.id AND s.to_migrate AND i.min_qty = 0 AND i.max_qty = 0
    AND greatest(s.quantity_minimum, 0) > 0;

  -- 7.4-1 Costs out of stock_items (exact old value kept in legacy_unit_price; cents per usage unit).
  INSERT INTO public.stock_item_costs (stock_item_id, clinic_id, last_unit_cost_cents, legacy_unit_price, updated_at)
  SELECT i.id, i.clinic_id,
         CASE WHEN i.unit_price > 0 AND round(i.unit_price * 100) <= 100000000000
              THEN round(i.unit_price * 100)::bigint END,
         i.unit_price, now()
  FROM public.stock_items i
  WHERE i.unit_price <> 0
  ON CONFLICT (stock_item_id) DO NOTHING;

  -- 7.3 Opening movements (quantity_on_hand > 0, no batch yet) into the default warehouse, lot 'GENEL'.
  --     The old single expiry_date is kept on the opening batch even when it is already past (deliberate: the
  --     opening is a migration of what the old screen said, not a new receipt, so the "refuse expired on receive"
  --     rule does not apply). Such stock is unusable (FEFO skips it, the quantity_on_hand mirror shows 0) until the
  --     owner wastes it or corrects the opening and receives real lots; the cards are named here (runbook step 5).
  SELECT count(*), string_agg(s.item_code, ', ' ORDER BY s.item_code)
    INTO v_n, v_codes
  FROM stock__m24_snapshot s
  WHERE s.to_migrate AND s.quantity_on_hand > 0 AND s.expiry_date < public.clinic_today();
  IF v_n > 0 THEN
    RAISE NOTICE 'stock_items: % kartın açılış bakiyesi SKT''si geçmiş partiye aktarılıyor (kullanılabilir 0); fire veya açılış düzeltmesi gerekir: %',
      v_n, left(v_codes, 2000);
  END IF;
  SELECT count(*) INTO v_n
  FROM stock__m24_snapshot s
  WHERE s.to_migrate AND s.quantity_on_hand <= 0 AND s.expiry_date IS NOT NULL;
  IF v_n > 0 THEN
    RAISE NOTICE 'stock_items: % kart stoksuz olduğu için eski SKT bilgisi parti oluşmadan boşaltılıyor (expiry_date NULL).', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM stock__m24_snapshot s
  WHERE s.to_migrate AND s.quantity_on_hand > 0 AND s.last_restocked_at IS NULL;
  IF v_n > 0 THEN
    RAISE NOTICE 'stock_items: % kartın son giriş tarihi boştu; açılış partisi kart oluşturma tarihini alıyor.', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM stock__m24_snapshot s
  WHERE s.to_migrate AND s.quantity_minimum <= 0;
  IF v_n > 0 THEN
    RAISE NOTICE 'stock_items: % kartın eski minimumu 0; MIN = MAX = 0 kalır ve bu kartlar MIN / MAX girilene kadar kritik stok uyarısı vermez.', v_n;
  END IF;

  FOR r IN
    SELECT s.id, s.clinic_id, s.quantity_on_hand, s.expiry_date, c.last_unit_cost_cents
    FROM stock__m24_snapshot s
    LEFT JOIN public.stock_item_costs c ON c.stock_item_id = s.id
    WHERE s.to_migrate AND s.quantity_on_hand > 0
    ORDER BY s.clinic_id, s.id
  LOOP
    PERFORM public.stock__open_legacy_item(r.clinic_id, r.id, r.quantity_on_hand::numeric, r.expiry_date,
                                           r.last_unit_cost_cents);
  END LOOP;

  -- 7.4-2 The price leaves stock_items (every staff member could read it there).
  UPDATE public.stock_items SET unit_price = 0 WHERE unit_price <> 0;

  -- 7.5 Mirrors for every card.
  FOR r IN SELECT i.clinic_id, i.id FROM public.stock_items i ORDER BY i.clinic_id, i.id LOOP
    PERFORM public.stock__sync_item(r.clinic_id, r.id);
  END LOOP;

  PERFORM set_config('stock.internal', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- 7.4-3 / 2.15 Audit: audit_row_change() (0019), attached only now so no old price reaches audit_logs.
--   stock_items: catalog columns only (the mirror refresh after every movement is not history).
--   Ledger-like tables (batches, balances, movements, counts) are their own history and are not audited.
--   Cost audit rows only for cost viewers: a RESTRICTIVE gate, ANDed with the 0019 / 0020 / 0021 policies, which
--   are not recreated here.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_row_change ON public.stock_items;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR DELETE OR UPDATE OF item_code, item_name, category, brand, model, tracking_level, gtin, sku,
    purchase_unit, usage_unit, units_per_purchase, min_qty, max_qty, abc_class, order_policy, needs_review,
    supplier_id, preferred_location_id, is_active, notes, version
  ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['stock_locations', 'suppliers', 'stock_item_costs', 'stock_correction_requests',
                             'stock_product_requests']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()', v_t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "audit_logs_stock_cost_guard" ON public.audit_logs;
CREATE POLICY "audit_logs_stock_cost_guard" ON public.audit_logs
  AS RESTRICTIVE
  FOR SELECT
  USING (
    entity_type NOT IN ('stock_item_costs', 'stock_batch_costs')
    OR (SELECT public.stock_can_view_costs())
  );

-- ---------------------------------------------------------------------------
-- 4.12 Card save core (stock_save_item and stock_define_item 'create'). Create when p_version IS NULL, else edit
--      with optimistic concurrency. On edit an absent key keeps the current value. p_skip_request: a product
--      request the caller resolves itself (excluded from the automatic GTIN resolution). Returns the card id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock__item_save(p_clinic uuid, p_actor uuid, p_id uuid, p_version integer,
                                                   p_item jsonb, p_can_cost boolean, p_skip_request uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_create boolean := p_version IS NULL;
  v_old public.stock_items%ROWTYPE;
  v_hist boolean := false;
  v_name text;
  v_code text;
  v_code_given boolean := false;
  v_category text;
  v_brand text := '';
  v_model text := '';
  v_level text;
  v_sku text := '';
  v_gtin text;
  v_pu text := 'adet';
  v_uu text := 'adet';
  v_upp numeric := 1;
  v_min numeric := 0;
  v_max numeric := 0;
  v_abc text := '';
  v_policy text := '';
  v_review boolean := false;
  v_supplier uuid;
  v_pref uuid;
  v_notes text := '';
  v_active boolean := true;
  v_cost bigint;
  v_has_cost boolean := p_item ? 'last_unit_cost_cents';
  v_taken uuid;
  v_hex text;
  v_len integer;
  v_constraint text;
BEGIN
  IF p_item IS NULL OR NOT public.stock__keys_ok(p_item, ARRAY[
       'item_name', 'item_code', 'category', 'brand', 'model', 'tracking_level', 'sku', 'gtin', 'purchase_unit',
       'usage_unit', 'units_per_purchase', 'min_qty', 'max_qty', 'abc_class', 'order_policy', 'needs_review',
       'supplier_id', 'preferred_location_id', 'notes', 'is_active', 'last_unit_cost_cents']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF p_id IS NULL THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF v_has_cost AND NOT coalesce(p_can_cost, false) THEN
    PERFORM public.stock__raise('E_COST_FORBIDDEN');
  END IF;

  IF v_create THEN
    IF EXISTS (SELECT 1 FROM public.stock_items i WHERE i.id = p_id) THEN
      PERFORM public.stock__raise('E_ID_TAKEN');
    END IF;
  ELSE
    SELECT * INTO v_old FROM public.stock_items i
    WHERE i.id = p_id AND i.clinic_id = p_clinic
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
    END IF;
    IF v_old.version <> p_version THEN
      PERFORM public.stock__raise('E_ITEM_VERSION');
    END IF;
    v_hist := EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.stock_item_id = p_id);
    v_name := v_old.item_name; v_code := v_old.item_code; v_category := v_old.category; v_brand := v_old.brand;
    v_model := v_old.model; v_level := v_old.tracking_level; v_sku := v_old.sku; v_gtin := v_old.gtin;
    v_pu := v_old.purchase_unit; v_uu := v_old.usage_unit; v_upp := v_old.units_per_purchase;
    v_min := v_old.min_qty; v_max := v_old.max_qty; v_abc := v_old.abc_class; v_policy := v_old.order_policy;
    v_review := v_old.needs_review; v_supplier := v_old.supplier_id; v_pref := v_old.preferred_location_id;
    v_notes := v_old.notes; v_active := v_old.is_active;
  END IF;

  -- Present keys override (PD:27-44, PD:93-112).
  IF p_item ? 'item_name' THEN v_name := btrim(coalesce(public.stock__j_text(p_item, 'item_name', 'E_ITEM_FIELDS'), '')); END IF;
  IF p_item ? 'item_code' THEN
    v_code := btrim(coalesce(public.stock__j_text(p_item, 'item_code', 'E_ITEM_CODE'), ''));
    v_code_given := v_code <> '';
  END IF;
  IF p_item ? 'category' THEN v_category := btrim(coalesce(public.stock__j_text(p_item, 'category', 'E_ITEM_FIELDS'), '')); END IF;
  IF p_item ? 'brand' THEN v_brand := btrim(coalesce(public.stock__j_text(p_item, 'brand', 'E_ITEM_FIELDS'), '')); END IF;
  IF p_item ? 'model' THEN v_model := btrim(coalesce(public.stock__j_text(p_item, 'model', 'E_ITEM_FIELDS'), '')); END IF;
  IF p_item ? 'tracking_level' THEN v_level := upper(btrim(coalesce(public.stock__j_text(p_item, 'tracking_level', 'E_ITEM_FIELDS'), ''))); END IF;
  IF p_item ? 'sku' THEN v_sku := btrim(coalesce(public.stock__j_text(p_item, 'sku', 'E_ITEM_FIELDS'), '')); END IF;
  IF p_item ? 'gtin' THEN v_gtin := public.stock__gtin(public.stock__j_text(p_item, 'gtin', 'E_GTIN')); END IF;
  IF p_item ? 'purchase_unit' THEN v_pu := btrim(coalesce(public.stock__j_text(p_item, 'purchase_unit', 'E_ITEM_UNITS'), '')); END IF;
  IF p_item ? 'usage_unit' THEN v_uu := btrim(coalesce(public.stock__j_text(p_item, 'usage_unit', 'E_ITEM_UNITS'), '')); END IF;
  IF p_item ? 'units_per_purchase' THEN v_upp := public.stock__j_num(p_item, 'units_per_purchase', 'E_ITEM_NUMBERS'); END IF;
  IF p_item ? 'min_qty' THEN v_min := public.stock__j_num(p_item, 'min_qty', 'E_ITEM_NUMBERS'); END IF;
  IF p_item ? 'max_qty' THEN v_max := public.stock__j_num(p_item, 'max_qty', 'E_ITEM_NUMBERS'); END IF;
  IF p_item ? 'abc_class' THEN v_abc := upper(btrim(coalesce(public.stock__j_text(p_item, 'abc_class', 'E_ABC_POLICY'), ''))); END IF;
  IF p_item ? 'order_policy' THEN v_policy := btrim(coalesce(public.stock__j_text(p_item, 'order_policy', 'E_ABC_POLICY'), '')); END IF;
  IF p_item ? 'needs_review' THEN v_review := public.stock__j_bool(p_item, 'needs_review', 'E_ITEM_FIELDS'); END IF;
  IF p_item ? 'supplier_id' THEN v_supplier := public.stock__j_uuid(p_item, 'supplier_id', 'E_SUPPLIER'); END IF;
  IF p_item ? 'preferred_location_id' THEN v_pref := public.stock__j_uuid(p_item, 'preferred_location_id', 'E_LOCATION'); END IF;
  IF p_item ? 'notes' THEN v_notes := btrim(coalesce(public.stock__j_text(p_item, 'notes', 'E_NOTES'), '')); END IF;
  IF p_item ? 'is_active' THEN v_active := public.stock__j_bool(p_item, 'is_active', 'E_ITEM_FIELDS'); END IF;
  IF v_has_cost THEN
    v_cost := public.stock__j_bigint(p_item, 'last_unit_cost_cents', 'E_ITEM_NUMBERS');
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost > 100000000000) THEN
      PERFORM public.stock__raise('E_ITEM_NUMBERS');
    END IF;
  END IF;

  -- Validation.
  -- A legacy card may carry a NULL category; it stays NULL until a save names one (partial saves keep working).
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 200
     OR (v_category IS NULL AND (v_create OR p_item ? 'category'))
     OR (v_category IS NOT NULL AND char_length(v_category) NOT BETWEEN 1 AND 80)
     OR v_level IS NULL OR v_level NOT IN ('A', 'B', 'C')
     OR v_review IS NULL OR v_active IS NULL
     OR char_length(v_brand) > 120 OR char_length(v_model) > 120 OR char_length(v_sku) > 60 THEN
    PERFORM public.stock__raise('E_ITEM_FIELDS');
  END IF;
  IF (NOT v_create OR v_code_given) AND (v_code IS NULL OR char_length(v_code) NOT BETWEEN 1 AND 40) THEN
    PERFORM public.stock__raise('E_ITEM_CODE');
  END IF;
  IF v_review THEN
    IF coalesce(v_pu, '') = '' THEN v_pu := 'belirlenecek'; END IF;
    IF coalesce(v_uu, '') = '' THEN v_uu := 'belirlenecek'; END IF;
  ELSIF coalesce(v_pu, '') = '' OR coalesce(v_uu, '') = ''
        OR lower(v_pu) = 'belirlenecek' OR lower(v_uu) = 'belirlenecek' THEN
    PERFORM public.stock__raise('E_ITEM_UNITS');
  END IF;
  IF char_length(v_pu) > 30 OR char_length(v_uu) > 30 THEN
    PERFORM public.stock__raise('E_ITEM_UNITS');
  END IF;
  IF v_upp IS NULL OR v_upp <= 0 OR v_upp > 100000 OR v_upp <> round(v_upp, 4)
     OR v_min IS NULL OR v_min < 0 OR v_min > 1000000000 OR v_min <> round(v_min, 4)
     OR v_max IS NULL OR v_max < 0 OR v_max > 1000000000 OR v_max <> round(v_max, 4) THEN
    PERFORM public.stock__raise('E_ITEM_NUMBERS');
  END IF;
  IF v_max < v_min THEN
    PERFORM public.stock__raise('E_ITEM_MINMAX');
  END IF;
  IF v_abc NOT IN ('', 'A', 'B', 'C') OR v_policy NOT IN ('', 'auto_minmax', 'weekly', 'case') THEN
    PERFORM public.stock__raise('E_ABC_POLICY');
  END IF;
  IF char_length(v_notes) > 2000 THEN
    PERFORM public.stock__raise('E_NOTES');
  END IF;
  -- A supplier / location must be active when chosen anew (an inactive one already on the card may stay).
  IF v_supplier IS NOT NULL AND (v_create OR v_supplier IS DISTINCT FROM v_old.supplier_id) AND NOT EXISTS (
    SELECT 1 FROM public.suppliers s WHERE s.id = v_supplier AND s.clinic_id = p_clinic AND s.is_active
  ) THEN
    PERFORM public.stock__raise('E_SUPPLIER');
  END IF;
  IF v_pref IS NOT NULL AND (v_create OR v_pref IS DISTINCT FROM v_old.preferred_location_id) AND NOT EXISTS (
    SELECT 1 FROM public.stock_locations l WHERE l.id = v_pref AND l.clinic_id = p_clinic AND l.is_active
  ) THEN
    PERFORM public.stock__raise('E_LOCATION');
  END IF;

  IF NOT v_create THEN
    -- History lock (PD:34-36).
    IF v_hist AND (v_level IS DISTINCT FROM v_old.tracking_level OR v_pu IS DISTINCT FROM v_old.purchase_unit
                   OR v_uu IS DISTINCT FROM v_old.usage_unit OR v_upp IS DISTINCT FROM v_old.units_per_purchase) THEN
      PERFORM public.stock__raise('E_ITEM_LOCKED');
    END IF;
    IF v_hist AND v_review AND NOT v_old.needs_review THEN
      PERFORM public.stock__raise('E_ITEM_DRAFT_LOCKED');
    END IF;
    -- Deactivation needs zero stock everywhere (PD:71-75).
    IF v_old.is_active AND NOT v_active AND EXISTS (
      SELECT 1 FROM public.stock_balances sb WHERE sb.stock_item_id = p_id AND sb.quantity > 0
    ) THEN
      PERFORM public.stock__raise('E_ITEM_HAS_STOCK');
    END IF;
  END IF;

  -- GTIN unique among active cards (serialised with stock_request_product by the same advisory key).
  IF v_gtin IS NOT NULL AND v_active THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('stock.gtin:' || p_clinic::text || ':' || v_gtin, 0));
    SELECT i.id INTO v_taken FROM public.stock_items i
    WHERE i.clinic_id = p_clinic AND i.gtin = v_gtin AND i.is_active AND i.id <> p_id
    LIMIT 1;
    IF v_taken IS NOT NULL THEN
      PERFORM public.stock__raise('E_GTIN_TAKEN', NULL, v_taken::text);
    END IF;
  END IF;

  -- Card code: given -> unique per clinic; missing on create -> 'STK-' + the first hex digits of the id.
  IF v_create AND NOT v_code_given THEN
    v_hex := upper(replace(p_id::text, '-', ''));
    FOREACH v_len IN ARRAY ARRAY[8, 12, 16, 32] LOOP
      v_code := 'STK-' || substr(v_hex, 1, v_len);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.stock_items i WHERE i.clinic_id = p_clinic AND i.item_code = v_code);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_items i WHERE i.clinic_id = p_clinic AND i.item_code = v_code AND i.id <> p_id) THEN
    PERFORM public.stock__raise('E_ITEM_CODE_TAKEN');
  END IF;

  BEGIN
    IF v_create THEN
      INSERT INTO public.stock_items (
        id, clinic_id, item_code, item_name, category, quantity_on_hand, quantity_minimum, unit_price,
        brand, model, tracking_level, gtin, sku, purchase_unit, usage_unit, units_per_purchase, min_qty, max_qty,
        abc_class, order_policy, needs_review, supplier_id, preferred_location_id, is_active, notes, version,
        created_by, updated_by)
      VALUES (
        p_id, p_clinic, v_code, v_name, v_category, 0, least(ceil(v_min), 2147483647)::integer, 0,
        v_brand, v_model, v_level, v_gtin, v_sku, v_pu, v_uu, v_upp, v_min, v_max,
        v_abc, v_policy, v_review, v_supplier, v_pref, v_active, v_notes, 1,
        p_actor, p_actor);
    ELSE
      UPDATE public.stock_items
      SET item_code = v_code, item_name = v_name, category = v_category, brand = v_brand, model = v_model,
          tracking_level = v_level, gtin = v_gtin, sku = v_sku, purchase_unit = v_pu, usage_unit = v_uu,
          units_per_purchase = v_upp, min_qty = v_min, max_qty = v_max, abc_class = v_abc, order_policy = v_policy,
          needs_review = v_review, supplier_id = v_supplier, preferred_location_id = v_pref, is_active = v_active,
          notes = v_notes, version = version + 1, updated_by = p_actor, updated_at = now()
      WHERE id = p_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'stock_items_gtin_active_key' THEN
      PERFORM public.stock__raise('E_GTIN_TAKEN');
    ELSIF v_constraint IN ('stock_items_pkey') THEN
      PERFORM public.stock__raise('E_ID_TAKEN');
    ELSE
      PERFORM public.stock__raise('E_ITEM_CODE_TAKEN');
    END IF;
  END;

  -- Cost (cost viewers only, checked above).
  IF v_has_cost THEN
    IF v_cost IS NULL THEN
      UPDATE public.stock_item_costs
      SET last_unit_cost_cents = NULL, updated_by = p_actor, updated_at = now()
      WHERE stock_item_id = p_id AND last_unit_cost_cents IS NOT NULL;
    ELSE
      INSERT INTO public.stock_item_costs (stock_item_id, clinic_id, last_unit_cost_cents, updated_by, updated_at)
      VALUES (p_id, p_clinic, v_cost, p_actor, now())
      ON CONFLICT (stock_item_id) DO UPDATE
        SET last_unit_cost_cents = EXCLUDED.last_unit_cost_cents, updated_by = EXCLUDED.updated_by, updated_at = now();
    END IF;
  END IF;

  -- A card that (newly) carries a GTIN resolves the pending definition requests for it (PD:139-141).
  IF v_gtin IS NOT NULL AND v_active
     AND (v_create OR v_gtin IS DISTINCT FROM v_old.gtin OR NOT v_old.is_active) THEN
    UPDATE public.stock_product_requests
    SET status = 'resolved', stock_item_id = p_id, resolved_by = p_actor, resolved_at = now()
    WHERE clinic_id = p_clinic AND gtin = v_gtin AND status = 'pending'
      AND id IS DISTINCT FROM p_skip_request;
  END IF;

  PERFORM public.stock__sync_item(p_clinic, p_id);
  RETURN p_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Write RPCs. Skeleton (in this order): gate -> stock__op_begin (replay returns the stored result) -> scalar
--    validation -> locks (cards by id, locations FOR SHARE, balance rows FOR UPDATE in FEFO order) -> re-validation
--    against the locked rows -> writes through stock__apply / stock__ledger -> stock__sync_item -> stock__op_finish.
-- ---------------------------------------------------------------------------

-- 4.1 Receive (MP:50-76). Cost only from cost viewers (E_COST_FORBIDDEN).
CREATE OR REPLACE FUNCTION public.stock_receive(
  p_operation_key uuid,
  p_stock_item_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_quantity_unit text DEFAULT 'usage',
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_expiry_date text DEFAULT NULL,
  p_unit_cost_cents bigint DEFAULT NULL,
  p_cost_unit text DEFAULT 'usage',
  p_supplier_id uuid DEFAULT NULL,
  p_document_no text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_units_per_purchase numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
  v_mid uuid;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_receive', jsonb_build_object(
    'stock_item_id', p_stock_item_id, 'to_location_id', p_to_location_id, 'quantity', p_quantity,
    'quantity_unit', p_quantity_unit, 'lot_number', p_lot_number, 'serial_number', p_serial_number,
    'expiry_date', p_expiry_date, 'unit_cost_cents', p_unit_cost_cents, 'cost_unit', p_cost_unit,
    'supplier_id', p_supplier_id, 'document_no', p_document_no, 'reason', p_reason,
    'units_per_purchase', p_units_per_purchase));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  v_mid := public.stock__receive_line(v_clinic, v_actor, p_operation_key, v_today, public.stock_can_view_costs(),
    p_stock_item_id, p_to_location_id, p_quantity, p_quantity_unit, p_units_per_purchase, p_lot_number,
    p_serial_number, p_expiry_date, p_unit_cost_cents, p_cost_unit, p_supplier_id, p_document_no, p_reason);

  PERFORM public.stock__sync_item(v_clinic, p_stock_item_id);
  RETURN public.stock__op_finish(v_clinic, p_operation_key,
    public.stock__move_result(v_clinic, p_operation_key, jsonb_build_array(v_mid), v_today));
END;
$$;

-- Shared outbound path of issue / transfer / waste (§4.2-4.4). Internal.
CREATE OR REPLACE FUNCTION public.stock__outbound(
  p_clinic uuid, p_actor uuid, p_op uuid, p_today date, p_type text,
  p_item_id uuid, p_from uuid, p_to uuid, p_quantity numeric, p_quantity_unit text, p_units_per_purchase numeric,
  p_batch uuid, p_patient uuid, p_appointment uuid, p_doctor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item public.stock_items%ROWTYPE;
  v_qty numeric;
  v_reason text;
  v_ids jsonb;
BEGIN
  IF p_type NOT IN ('issue', 'transfer', 'waste') THEN
    PERFORM public.stock__raise('E_TYPE');
  END IF;
  IF p_type = 'transfer' AND p_from IS NOT DISTINCT FROM p_to THEN
    PERFORM public.stock__raise('E_SAME_LOCATION');
  END IF;
  v_reason := public.stock__reason(p_reason, p_type = 'waste');

  -- Locks: the card, then the location(s) in id order.
  v_item := public.stock__item_for_move(p_clinic, p_item_id);
  IF p_type = 'transfer' THEN
    PERFORM public.stock__location_active(p_clinic, l.id)
    FROM (SELECT x.id FROM unnest(ARRAY[p_from, p_to]) AS x(id) ORDER BY x.id) l;
    -- unnest of a NULL id still has to fail as an unknown location
    IF p_from IS NULL OR p_to IS NULL THEN
      PERFORM public.stock__raise('E_LOCATION');
    END IF;
  ELSE
    PERFORM public.stock__location_active(p_clinic, p_from);
  END IF;

  IF coalesce(p_quantity_unit, 'usage') = 'purchase' AND p_units_per_purchase IS NOT NULL
     AND p_units_per_purchase <> v_item.units_per_purchase THEN
    PERFORM public.stock__raise('E_UNIT_CHANGED');
  END IF;
  v_qty := public.stock__to_usage(public.stock__qty(p_quantity, false), p_quantity_unit, v_item.units_per_purchase);
  IF v_item.tracking_level = 'A' AND v_qty <> trunc(v_qty) THEN
    PERFORM public.stock__raise('E_QTY_INTEGER');
  END IF;

  IF v_item.tracking_level = 'A' AND p_batch IS NULL THEN
    PERFORM public.stock__raise('E_BATCH_REQUIRED');
  END IF;
  IF p_type = 'issue' THEN
    IF v_item.tracking_level = 'A' AND (p_patient IS NULL OR p_doctor IS NULL) THEN
      PERFORM public.stock__raise('E_PATIENT_DOCTOR');
    END IF;
    PERFORM public.stock__check_patient_refs(p_clinic, p_patient, p_appointment, p_doctor);
  END IF;
  IF p_batch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.stock_batches b
    WHERE b.id = p_batch AND b.clinic_id = p_clinic AND b.stock_item_id = v_item.id
  ) THEN
    PERFORM public.stock__raise('E_BATCH');
  END IF;

  v_ids := public.stock__allocate_out(p_clinic, p_op, v_item, p_type, v_qty, p_from,
    CASE WHEN p_type = 'transfer' THEN p_to END, p_batch,
    jsonb_build_object('actor_user_id', p_actor, 'reason', v_reason,
                       'patient_id', CASE WHEN p_type = 'issue' THEN p_patient END,
                       'appointment_id', CASE WHEN p_type = 'issue' THEN p_appointment END,
                       'doctor_id', CASE WHEN p_type = 'issue' THEN p_doctor END),
    p_today);

  PERFORM public.stock__sync_item(p_clinic, v_item.id);
  RETURN public.stock__move_result(p_clinic, p_op, v_ids, p_today);
END;
$$;

-- 4.2 Issue (usage). Level A: batch, patient and doctor required (MP:24, MP:98). FEFO may split across lots.
CREATE OR REPLACE FUNCTION public.stock_issue(
  p_operation_key uuid,
  p_stock_item_id uuid,
  p_from_location_id uuid,
  p_quantity numeric,
  p_quantity_unit text DEFAULT 'usage',
  p_batch_id uuid DEFAULT NULL,
  p_patient_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_doctor_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_units_per_purchase numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_issue', jsonb_build_object(
    'stock_item_id', p_stock_item_id, 'from_location_id', p_from_location_id, 'quantity', p_quantity,
    'quantity_unit', p_quantity_unit, 'batch_id', p_batch_id, 'patient_id', p_patient_id,
    'appointment_id', p_appointment_id, 'doctor_id', p_doctor_id, 'reason', p_reason,
    'units_per_purchase', p_units_per_purchase));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;
  RETURN public.stock__op_finish(v_clinic, p_operation_key, public.stock__outbound(
    v_clinic, v_actor, p_operation_key, v_today, 'issue', p_stock_item_id, p_from_location_id, NULL, p_quantity,
    p_quantity_unit, p_units_per_purchase, p_batch_id, p_patient_id, p_appointment_id, p_doctor_id, p_reason));
END;
$$;

-- 4.3 Transfer. Expired lots are not transferred (they are wasted where they are, MP:101).
CREATE OR REPLACE FUNCTION public.stock_transfer(
  p_operation_key uuid,
  p_stock_item_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_quantity_unit text DEFAULT 'usage',
  p_batch_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_units_per_purchase numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_transfer', jsonb_build_object(
    'stock_item_id', p_stock_item_id, 'from_location_id', p_from_location_id, 'to_location_id', p_to_location_id,
    'quantity', p_quantity, 'quantity_unit', p_quantity_unit, 'batch_id', p_batch_id, 'reason', p_reason,
    'units_per_purchase', p_units_per_purchase));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;
  RETURN public.stock__op_finish(v_clinic, p_operation_key, public.stock__outbound(
    v_clinic, v_actor, p_operation_key, v_today, 'transfer', p_stock_item_id, p_from_location_id, p_to_location_id,
    p_quantity, p_quantity_unit, p_units_per_purchase, p_batch_id, NULL, NULL, NULL, p_reason));
END;
$$;

-- 4.4 Waste (fire / SKT). Reason required; expired lots allowed and consumed first.
CREATE OR REPLACE FUNCTION public.stock_waste(
  p_operation_key uuid,
  p_stock_item_id uuid,
  p_from_location_id uuid,
  p_quantity numeric,
  p_quantity_unit text DEFAULT 'usage',
  p_batch_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_units_per_purchase numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_waste', jsonb_build_object(
    'stock_item_id', p_stock_item_id, 'from_location_id', p_from_location_id, 'quantity', p_quantity,
    'quantity_unit', p_quantity_unit, 'batch_id', p_batch_id, 'reason', p_reason,
    'units_per_purchase', p_units_per_purchase));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;
  RETURN public.stock__op_finish(v_clinic, p_operation_key, public.stock__outbound(
    v_clinic, v_actor, p_operation_key, v_today, 'waste', p_stock_item_id, p_from_location_id, NULL, p_quantity,
    p_quantity_unit, p_units_per_purchase, p_batch_id, NULL, NULL, NULL, p_reason));
END;
$$;

-- 4.5 Usage return (MP:28-48). Managers only (E_RETURN_ROLE). The card lock serialises returns of one issue.
CREATE OR REPLACE FUNCTION public.stock_return(
  p_operation_key uuid,
  p_source_movement_id uuid,
  p_quantity numeric,
  p_unused_confirmed boolean,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
  s public.stock_movements%ROWTYPE;
  v_item public.stock_items%ROWTYPE;
  v_qty numeric;
  v_reason text;
  v_remaining numeric;
  v_mid uuid;
BEGIN
  IF NOT public.stock_can_manage() THEN
    PERFORM public.stock__raise('E_RETURN_ROLE');
  END IF;
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_return', jsonb_build_object(
    'source_movement_id', p_source_movement_id, 'quantity', p_quantity, 'unused_confirmed', p_unused_confirmed,
    'reason', p_reason));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  SELECT * INTO s FROM public.stock_movements m
  WHERE m.id = p_source_movement_id AND m.clinic_id = v_clinic AND m.movement_type = 'issue';
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_RETURN_SOURCE');
  END IF;
  SELECT * INTO v_item FROM public.stock_items i
  WHERE i.id = s.stock_item_id AND i.clinic_id = v_clinic
  FOR NO KEY UPDATE;

  IF EXISTS (SELECT 1 FROM public.stock_correction_requests r WHERE r.movement_id = s.id AND r.status = 'approved') THEN
    PERFORM public.stock__raise('E_RETURN_CORRECTED');
  END IF;
  IF p_unused_confirmed IS NOT TRUE THEN
    PERFORM public.stock__raise('E_RETURN_UNUSED');
  END IF;
  v_reason := public.stock__reason(p_reason, true);
  v_qty := public.stock__qty(p_quantity, false);
  IF v_item.tracking_level = 'A' AND v_qty <> trunc(v_qty) THEN
    PERFORM public.stock__raise('E_QTY_INTEGER');
  END IF;

  SELECT s.quantity - coalesce(sum(r.quantity), 0) INTO v_remaining
  FROM public.stock_movements r
  WHERE r.source_movement_id = s.id AND r.movement_type = 'return';
  IF v_qty > v_remaining THEN
    PERFORM public.stock__raise('E_RETURN_QTY', NULL, trim_scale(greatest(v_remaining, 0))::text);
  END IF;

  PERFORM public.stock__location_active(v_clinic, s.from_location_id);
  IF NOT v_item.is_active THEN
    PERFORM public.stock__raise('E_ITEM_INACTIVE');
  END IF;

  PERFORM public.stock__apply(v_clinic, s.stock_item_id, s.batch_id, s.from_location_id, v_qty);
  v_mid := public.stock__ledger(v_clinic, p_operation_key, NULL, s.stock_item_id, s.batch_id, 'return', v_qty,
    NULL, s.from_location_id,
    jsonb_build_object('actor_user_id', v_actor, 'reason', v_reason, 'source_movement_id', s.id,
                       'patient_id', s.patient_id, 'appointment_id', s.appointment_id, 'doctor_id', s.doctor_id));

  PERFORM public.stock__sync_item(v_clinic, s.stock_item_id);
  RETURN public.stock__op_finish(v_clinic, p_operation_key,
    public.stock__move_result(v_clinic, p_operation_key, jsonb_build_array(v_mid), v_today));
END;
$$;

-- 4.6 Bulk receive: 1..20 lines, all-or-nothing (BU:9-19). Every card is locked first in id order; a failing line
-- is re-raised as '<n>. satır: ...'. Lines of the same list may merge into a batch created by an earlier line.
CREATE OR REPLACE FUNCTION public.stock_bulk_receive(
  p_operation_key uuid,
  p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_can_cost boolean := public.stock_can_view_costs();
  v_prev jsonb;
  v_line jsonb;
  v_n integer;
  v_ids jsonb := '[]'::jsonb;
  v_items uuid[];
  v_mid uuid;
  v_state text;
  v_msg text;
  v_hint text;
  i uuid;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 20 THEN
    PERFORM public.stock__raise('E_BULK_SIZE');
  END IF;
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_bulk_receive',
                                   jsonb_build_object('lines', p_lines));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  -- Lock every (well-formed) card id first, in id order.
  SELECT array_agg(DISTINCT btrim(e.v ->> 'stock_item_id')::uuid)
    INTO v_items
  FROM jsonb_array_elements(p_lines) AS e(v)
  WHERE jsonb_typeof(e.v) = 'object'
    AND jsonb_typeof(e.v -> 'stock_item_id') = 'string'
    AND btrim(e.v ->> 'stock_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  FOR i IN
    SELECT t.id FROM public.stock_items t
    WHERE t.clinic_id = v_clinic AND t.id = ANY (coalesce(v_items, '{}'::uuid[]))
    ORDER BY t.id
    FOR NO KEY UPDATE
  LOOP
    NULL;
  END LOOP;

  FOR v_line, v_n IN SELECT e.v, e.n::integer FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(v, n) LOOP
    BEGIN
      IF NOT public.stock__keys_ok(v_line, ARRAY['stock_item_id', 'to_location_id', 'quantity', 'quantity_unit',
           'units_per_purchase', 'lot_number', 'serial_number', 'expiry_date', 'unit_cost_cents', 'cost_unit',
           'supplier_id', 'document_no', 'reason']) THEN
        PERFORM public.stock__raise('E_FILTER');
      END IF;
      v_mid := public.stock__receive_line(v_clinic, v_actor, p_operation_key, v_today, v_can_cost,
        public.stock__j_uuid(v_line, 'stock_item_id', 'E_ITEM_NOT_FOUND'),
        public.stock__j_uuid(v_line, 'to_location_id', 'E_LOCATION'),
        public.stock__j_num(v_line, 'quantity', 'E_QTY'),
        coalesce(public.stock__j_text(v_line, 'quantity_unit', 'E_QTY_UNIT'), 'usage'),
        public.stock__j_num(v_line, 'units_per_purchase', 'E_QTY_UNIT'),
        public.stock__j_text(v_line, 'lot_number', 'E_LOT_FORMAT'),
        public.stock__j_text(v_line, 'serial_number', 'E_SERIAL_FORMAT'),
        public.stock__j_text(v_line, 'expiry_date', 'E_EXPIRY_INVALID'),
        public.stock__j_bigint(v_line, 'unit_cost_cents', 'E_COST'),
        coalesce(public.stock__j_text(v_line, 'cost_unit', 'E_COST'), 'usage'),
        public.stock__j_uuid(v_line, 'supplier_id', 'E_SUPPLIER'),
        public.stock__j_text(v_line, 'document_no', 'E_DOCUMENT_NO'),
        public.stock__j_text(v_line, 'reason', 'E_REASON_LENGTH'));
      v_ids := v_ids || to_jsonb(v_mid);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
      PERFORM public.stock__row_raise(v_n, v_state, v_msg, v_hint);
    END;
  END LOOP;

  FOR i IN
    SELECT DISTINCT m.stock_item_id FROM public.stock_movements m
    WHERE m.id IN (SELECT (x.v)::uuid FROM jsonb_array_elements_text(v_ids) AS x(v))
  LOOP
    PERFORM public.stock__sync_item(v_clinic, i);
  END LOOP;

  RETURN public.stock__op_finish(v_clinic, p_operation_key,
    public.stock__move_result(v_clinic, p_operation_key, v_ids, v_today));
END;
$$;

-- 4.7 Count per location (CP:5-40). Managers only. Every line writes a stock_counts row (also without a
-- difference); a difference writes adjust_in / adjust_out. expected_qty must equal the locked balance exactly.
CREATE OR REPLACE FUNCTION public.stock_count(
  p_operation_key uuid,
  p_location_id uuid,
  p_lines jsonb,
  p_reason text)
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
  v_reason text := btrim(coalesce(p_reason, ''));
  v_line jsonb;
  v_n integer;
  v_batch uuid;
  v_expected numeric;
  v_actual numeric;
  v_current numeric;
  v_delta numeric;
  v_level text;
  v_item uuid;
  v_active boolean;
  v_review boolean;
  v_serial text;
  v_count uuid;
  v_mid uuid;
  v_ids jsonb := '[]'::jsonb;
  v_seen uuid[] := '{}';
  v_batches uuid[];
  v_lines integer := 0;
  v_diff integer := 0;
  v_in numeric := 0;
  v_out numeric := 0;
  v_state text;
  v_msg text;
  v_hint text;
  r record;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_count', jsonb_build_object(
    'location_id', p_location_id, 'lines', p_lines, 'reason', p_reason));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  PERFORM public.stock__location_active(v_clinic, p_location_id);
  IF char_length(v_reason) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.stock__raise('E_COUNT_FIELDS');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 500 THEN
    PERFORM public.stock__raise('E_COUNT_SIZE');
  END IF;

  -- Lock the cards of every known batch in id order, then their balance rows at this location. Ids are normalised
  -- exactly as the line parser (stock__j_uuid) does, so no accepted line escapes the up-front locks.
  SELECT array_agg(DISTINCT btrim(e.v ->> 'batch_id')::uuid)
    INTO v_batches
  FROM jsonb_array_elements(p_lines) AS e(v)
  WHERE jsonb_typeof(e.v) = 'object'
    AND jsonb_typeof(e.v -> 'batch_id') = 'string'
    AND btrim(e.v ->> 'batch_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  FOR r IN
    SELECT t.id FROM public.stock_items t
    WHERE t.clinic_id = v_clinic
      AND t.id IN (SELECT b.stock_item_id FROM public.stock_batches b
                   WHERE b.clinic_id = v_clinic AND b.id = ANY (coalesce(v_batches, '{}'::uuid[])))
    ORDER BY t.id
    FOR NO KEY UPDATE
  LOOP
    NULL;
  END LOOP;
  FOR r IN
    SELECT sb.id FROM public.stock_balances sb
    WHERE sb.clinic_id = v_clinic AND sb.location_id = p_location_id
      AND sb.batch_id = ANY (coalesce(v_batches, '{}'::uuid[]))
    ORDER BY sb.batch_id
    FOR UPDATE
  LOOP
    NULL;
  END LOOP;

  FOR v_line, v_n IN SELECT e.v, e.n::integer FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(v, n) LOOP
    BEGIN
      IF NOT public.stock__keys_ok(v_line, ARRAY['batch_id', 'expected_qty', 'actual_qty']) THEN
        PERFORM public.stock__raise('E_FILTER');
      END IF;
      v_batch := public.stock__j_uuid(v_line, 'batch_id', 'E_BATCH');
      v_expected := public.stock__j_num(v_line, 'expected_qty', 'E_COUNT_STALE');
      v_actual := public.stock__j_num(v_line, 'actual_qty', 'E_COUNT_FIELDS');
      IF v_batch IS NULL THEN
        PERFORM public.stock__raise('E_BATCH');
      END IF;
      IF v_actual IS NULL OR v_actual < 0 OR v_actual <> round(v_actual, 4) OR v_actual > 1000000 THEN
        PERFORM public.stock__raise('E_COUNT_FIELDS');
      END IF;
      IF v_batch = ANY (v_seen) THEN
        PERFORM public.stock__raise('E_COUNT_DUPLICATE');
      END IF;
      v_seen := v_seen || v_batch;

      SELECT b.stock_item_id, b.serial_number, i.tracking_level, i.is_active, i.needs_review
        INTO v_item, v_serial, v_level, v_active, v_review
      FROM public.stock_batches b
      JOIN public.stock_items i ON i.id = b.stock_item_id
      WHERE b.id = v_batch AND b.clinic_id = v_clinic;
      IF NOT FOUND THEN
        PERFORM public.stock__raise('E_BATCH');
      END IF;
      IF NOT v_active OR v_review THEN
        PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
      END IF;

      -- Each line holds its own locks too (already held after the up-front pass; never skipped): the card, then the
      -- balance row, so the stale check compares against a balance no concurrent movement can change.
      PERFORM 1 FROM public.stock_items t WHERE t.id = v_item AND t.clinic_id = v_clinic FOR NO KEY UPDATE;
      v_current := NULL;
      SELECT sb.quantity INTO v_current FROM public.stock_balances sb
      WHERE sb.batch_id = v_batch AND sb.location_id = p_location_id AND sb.clinic_id = v_clinic
      FOR UPDATE;
      v_current := coalesce(v_current, 0);
      IF v_expected IS NULL OR v_expected <> v_current THEN
        PERFORM public.stock__raise('E_COUNT_STALE', NULL, trim_scale(v_current)::text);
      END IF;
      IF v_level = 'A' AND v_actual <> trunc(v_actual) THEN
        PERFORM public.stock__raise('E_COUNT_A_INTEGER');
      END IF;
      IF v_serial IS NOT NULL AND v_actual > 1 THEN
        PERFORM public.stock__raise('E_COUNT_SERIAL');
      END IF;
      v_delta := round(v_actual - v_current, 4);
      IF v_level = 'A' AND v_delta > 0 THEN
        PERFORM public.stock__raise('E_COUNT_A_SURPLUS');
      END IF;
      -- A serial lot holds at most 1 across all locations: a count surplus here while it sits elsewhere is a count
      -- error (E_COUNT_SERIAL), not the movement message stock__apply would give.
      IF v_serial IS NOT NULL AND v_delta > 0 AND (
        SELECT coalesce(sum(sb.quantity), 0) FROM public.stock_balances sb
        WHERE sb.batch_id = v_batch AND sb.location_id <> p_location_id) + v_actual > 1 THEN
        PERFORM public.stock__raise('E_COUNT_SERIAL');
      END IF;

      v_count := gen_random_uuid();
      v_mid := NULL;
      IF v_delta <> 0 THEN
        PERFORM public.stock__apply(v_clinic, v_item, v_batch, p_location_id, v_delta);
        v_mid := public.stock__ledger(v_clinic, p_operation_key, NULL, v_item, v_batch,
          CASE WHEN v_delta > 0 THEN 'adjust_in' ELSE 'adjust_out' END, abs(v_delta),
          CASE WHEN v_delta < 0 THEN p_location_id END, CASE WHEN v_delta > 0 THEN p_location_id END,
          jsonb_build_object('actor_user_id', v_actor, 'reason', v_reason, 'count_id', v_count));
        v_ids := v_ids || to_jsonb(v_mid);
        v_diff := v_diff + 1;
        IF v_delta > 0 THEN v_in := v_in + v_delta; ELSE v_out := v_out - v_delta; END IF;
      END IF;
      INSERT INTO public.stock_counts (id, clinic_id, operation_key, line_no, location_id, stock_item_id, batch_id,
                                       expected_qty, actual_qty, movement_id, reason, actor_user_id)
      VALUES (v_count, v_clinic, p_operation_key, v_n, p_location_id, v_item, v_batch, v_current, v_actual, v_mid,
              v_reason, v_actor);
      v_lines := v_lines + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
      PERFORM public.stock__row_raise(v_n, v_state, v_msg, v_hint);
    END;
  END LOOP;

  FOR r IN
    SELECT DISTINCT c.stock_item_id FROM public.stock_counts c
    WHERE c.operation_key = p_operation_key AND c.clinic_id = v_clinic
  LOOP
    PERFORM public.stock__sync_item(v_clinic, r.stock_item_id);
  END LOOP;

  RETURN public.stock__op_finish(v_clinic, p_operation_key,
    public.stock__move_result(v_clinic, p_operation_key, v_ids, v_today)
    || jsonb_build_object('location_id', p_location_id, 'lines', v_lines, 'differences', v_diff,
                          'adjust_in_qty', public.stock__q(v_in), 'adjust_out_qty', public.stock__q(v_out)));
END;
$$;

-- 4.8 Correction request (CO:5). Own movement, or any for a manager; one pending / approved request per movement.
CREATE OR REPLACE FUNCTION public.stock_request_correction(
  p_operation_key uuid,
  p_request_id uuid,
  p_movement_id uuid,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_manage boolean := public.stock_can_manage();
  v_prev jsonb;
  v_reason text := btrim(coalesce(p_reason, ''));
  m public.stock_movements%ROWTYPE;
  v_constraint text;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_request_correction', jsonb_build_object(
    'request_id', p_request_id, 'movement_id', p_movement_id, 'reason', p_reason));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  IF char_length(v_reason) NOT BETWEEN 3 AND 1000 THEN
    PERFORM public.stock__raise('E_CORR_REASON');
  END IF;
  IF p_request_id IS NULL THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  SELECT * INTO m FROM public.stock_movements mv
  WHERE mv.id = p_movement_id AND mv.clinic_id = v_clinic
    AND mv.movement_type IN ('opening', 'receive', 'issue', 'transfer', 'waste');
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_CORR_TYPE');
  END IF;
  IF NOT v_manage AND m.actor_user_id IS DISTINCT FROM v_actor THEN
    PERFORM public.stock__raise('E_CORR_OWN');
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_correction_requests r
             WHERE r.movement_id = m.id AND r.status IN ('pending', 'approved')) THEN
    PERFORM public.stock__raise('E_CORR_EXISTS');
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_correction_requests r WHERE r.id = p_request_id) THEN
    PERFORM public.stock__raise('E_ID_TAKEN');
  END IF;

  BEGIN
    INSERT INTO public.stock_correction_requests (id, clinic_id, movement_id, reason, requested_by)
    VALUES (p_request_id, v_clinic, m.id, v_reason, v_actor);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'stock_corr_open_key' THEN
      PERFORM public.stock__raise('E_CORR_EXISTS');
    END IF;
    PERFORM public.stock__raise('E_ID_TAKEN');
  END;

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true,
    'request', public.stock__corr_json(v_clinic, p_request_id, v_actor, v_manage, true)));
END;
$$;

-- 4.9 Correction decision (CO:6-24). Managers only.
CREATE OR REPLACE FUNCTION public.stock_resolve_correction(
  p_operation_key uuid,
  p_request_id uuid,
  p_action text,
  p_corrected_qty numeric DEFAULT NULL,
  p_resolution text DEFAULT NULL)
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
  v_item uuid;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_resolve_correction', jsonb_build_object(
    'request_id', p_request_id, 'action', p_action, 'corrected_qty', p_corrected_qty, 'resolution', p_resolution));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  v_core := public.stock__resolve_core(v_clinic, v_actor, p_operation_key, p_request_id, p_action, p_corrected_qty,
                                       p_resolution);
  v_item := nullif(v_core ->> 'stock_item_id', '')::uuid;
  IF v_item IS NOT NULL THEN
    PERFORM public.stock__sync_item(v_clinic, v_item);
  END IF;

  RETURN public.stock__op_finish(v_clinic, p_operation_key,
    public.stock__move_result(v_clinic, p_operation_key, v_core -> 'movement_ids', v_today)
    || jsonb_build_object('request', public.stock__corr_json(v_clinic, p_request_id, v_actor, true, true)));
END;
$$;

-- 4.10 Unknown barcode -> definition request (PR:9-29). Never changes stock. One pending request per GTIN.
CREATE OR REPLACE FUNCTION public.stock_request_product(
  p_operation_key uuid,
  p_request_id uuid,
  p_gtin text,
  p_name text,
  p_note text DEFAULT NULL,
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_expiry_date text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_operate();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
  v_name text := btrim(coalesce(p_name, ''));
  v_note text := btrim(coalesce(p_note, ''));
  v_lot text := btrim(coalesce(p_lot_number, ''));
  v_serial text := btrim(coalesce(p_serial_number, ''));
  v_gtin text;
  v_exp date;
  v_item uuid;
  v_pending uuid;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_request_product', jsonb_build_object(
    'request_id', p_request_id, 'gtin', p_gtin, 'name', p_name, 'note', p_note, 'lot_number', p_lot_number,
    'serial_number', p_serial_number, 'expiry_date', p_expiry_date));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  IF p_request_id IS NULL THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 160 THEN
    PERFORM public.stock__raise('E_PREQ_NAME');
  END IF;
  IF char_length(v_note) > 500 THEN
    PERFORM public.stock__raise('E_PREQ_NOTE');
  END IF;
  v_gtin := public.stock__gtin(p_gtin);
  IF v_gtin IS NULL THEN
    PERFORM public.stock__raise('E_GTIN');
  END IF;
  IF char_length(v_lot) > 40 THEN
    PERFORM public.stock__raise('E_LOT_FORMAT');
  END IF;
  IF char_length(v_serial) > 40 THEN
    PERFORM public.stock__raise('E_SERIAL_FORMAT');
  END IF;
  v_exp := public.stock__expiry(p_expiry_date);

  -- Same advisory key as the card save, so a request and a definition of one GTIN never cross.
  PERFORM pg_advisory_xact_lock(hashtextextended('stock.gtin:' || v_clinic::text || ':' || v_gtin, 0));
  SELECT i.id INTO v_item FROM public.stock_items i
  WHERE i.clinic_id = v_clinic AND i.gtin = v_gtin AND i.is_active
  LIMIT 1;
  IF v_item IS NOT NULL THEN
    PERFORM public.stock__raise('E_GTIN_KNOWN', NULL, v_item::text);
  END IF;

  SELECT r.id INTO v_pending FROM public.stock_product_requests r
  WHERE r.clinic_id = v_clinic AND r.gtin = v_gtin AND r.status = 'pending';
  IF v_pending IS NOT NULL THEN
    RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
      'ok', true, 'already_pending', true, 'request', public.stock__preq_json(v_clinic, v_pending)));
  END IF;

  IF EXISTS (SELECT 1 FROM public.stock_product_requests r WHERE r.id = p_request_id) THEN
    PERFORM public.stock__raise('E_ID_TAKEN');
  END IF;
  INSERT INTO public.stock_product_requests (id, clinic_id, gtin, name, note, lot_number, serial_number, expiry_date,
                                             requested_by)
  VALUES (p_request_id, v_clinic, v_gtin, v_name, v_note, v_lot, v_serial, v_exp, v_actor);

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true, 'already_pending', false, 'request', public.stock__preq_json(v_clinic, p_request_id)));
END;
$$;

-- 4.11 A manager answers a definition request: create a ready card with the GTIN, link an existing card without a
-- barcode, or reject with a note.
CREATE OR REPLACE FUNCTION public.stock_define_item(
  p_operation_key uuid,
  p_request_id uuid,
  p_action text,
  p_item_id uuid DEFAULT NULL,
  p_item jsonb DEFAULT NULL,
  p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
  v_req public.stock_product_requests%ROWTYPE;
  v_item public.stock_items%ROWTYPE;
  v_note text := btrim(coalesce(p_note, ''));
  v_taken uuid;
  v_item_id uuid;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_define_item', jsonb_build_object(
    'request_id', p_request_id, 'action', p_action, 'item_id', p_item_id, 'item', p_item, 'note', p_note));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  SELECT * INTO v_req FROM public.stock_product_requests r
  WHERE r.id = p_request_id AND r.clinic_id = v_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_PREQ_NOT_FOUND');
  END IF;
  IF v_req.status <> 'pending' THEN
    PERFORM public.stock__raise('E_PREQ_DONE');
  END IF;
  IF char_length(v_note) > 500 THEN
    PERFORM public.stock__raise('E_PREQ_NOTE');
  END IF;

  IF p_action = 'create' THEN
    IF p_item IS NOT NULL AND jsonb_typeof(p_item) <> 'object' THEN
      PERFORM public.stock__raise('E_FILTER');
    END IF;
    v_item_id := public.stock__item_save(v_clinic, v_actor, p_item_id, NULL,
      coalesce(p_item, '{}'::jsonb) || jsonb_build_object('gtin', v_req.gtin, 'needs_review', false),
      public.stock_can_view_costs(), v_req.id);
  ELSIF p_action = 'link' THEN
    SELECT * INTO v_item FROM public.stock_items i
    WHERE i.id = p_item_id AND i.clinic_id = v_clinic
    FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT v_item.is_active THEN
      PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
    END IF;
    IF v_item.gtin IS NOT NULL AND v_item.gtin <> v_req.gtin THEN
      PERFORM public.stock__raise('E_LINK_GTIN');
    END IF;
    IF v_item.gtin IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('stock.gtin:' || v_clinic::text || ':' || v_req.gtin, 0));
      SELECT i.id INTO v_taken FROM public.stock_items i
      WHERE i.clinic_id = v_clinic AND i.gtin = v_req.gtin AND i.is_active AND i.id <> v_item.id
      LIMIT 1;
      IF v_taken IS NOT NULL THEN
        PERFORM public.stock__raise('E_GTIN_TAKEN', NULL, v_taken::text);
      END IF;
      UPDATE public.stock_items
      SET gtin = v_req.gtin, version = version + 1, updated_by = v_actor, updated_at = now()
      WHERE id = v_item.id;
    END IF;
    v_item_id := v_item.id;
  ELSIF p_action = 'reject' THEN
    IF v_note = '' THEN
      PERFORM public.stock__raise('E_PREQ_NOTE');
    END IF;
    UPDATE public.stock_product_requests
    SET status = 'rejected', resolution_note = v_note, resolved_by = v_actor, resolved_at = now()
    WHERE id = v_req.id;
  ELSE
    PERFORM public.stock__raise('E_CORR_ACTION');
  END IF;

  IF v_item_id IS NOT NULL THEN
    UPDATE public.stock_product_requests
    SET status = 'resolved', stock_item_id = v_item_id, resolution_note = v_note, resolved_by = v_actor,
        resolved_at = now()
    WHERE id = v_req.id;
  END IF;

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true,
    'request', public.stock__preq_json(v_clinic, v_req.id),
    'item', CASE WHEN v_item_id IS NOT NULL THEN public.stock__item_json(v_clinic, v_item_id, v_actor, false) END));
END;
$$;

-- 4.12 Card create / edit / deactivate (PD:19-141). Managers only; the cost key only for cost viewers.
CREATE OR REPLACE FUNCTION public.stock_save_item(
  p_operation_key uuid,
  p_id uuid,
  p_version integer,
  p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_save_item', jsonb_build_object(
    'id', p_id, 'version', p_version, 'item', p_item));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  PERFORM public.stock__item_save(v_clinic, v_actor, p_id, p_version, p_item, public.stock_can_view_costs(), NULL);

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true, 'item', public.stock__item_json(v_clinic, p_id, v_actor, false)));
END;
$$;

-- 4.13 Locations (managers). Exactly one active default warehouse per clinic at all times.
CREATE OR REPLACE FUNCTION public.stock_save_location(
  p_operation_key uuid,
  p_id uuid,
  p_version integer,
  p_location jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
  v_create boolean := p_version IS NULL;
  v_old public.stock_locations%ROWTYPE;
  v_name text;
  v_kind text := 'room';
  v_chair uuid;
  v_sort integer := 0;
  v_sort_n numeric;
  v_active boolean := true;
  v_default boolean := false;
  v_old_default uuid;
  v_constraint text;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_save_location', jsonb_build_object(
    'id', p_id, 'version', p_version, 'location', p_location));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  IF p_id IS NULL OR p_location IS NULL OR NOT public.stock__keys_ok(p_location,
       ARRAY['name', 'kind', 'chair_id', 'sort_order', 'is_active', 'is_default_warehouse']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;

  IF v_create THEN
    IF EXISTS (SELECT 1 FROM public.stock_locations l WHERE l.id = p_id) THEN
      PERFORM public.stock__raise('E_ID_TAKEN');
    END IF;
  ELSE
    SELECT * INTO v_old FROM public.stock_locations l
    WHERE l.id = p_id AND l.clinic_id = v_clinic
    FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.stock__raise('E_LOCATION');
    END IF;
    IF v_old.version <> p_version THEN
      PERFORM public.stock__raise('E_VERSION');
    END IF;
    v_name := v_old.name; v_kind := v_old.kind; v_chair := v_old.chair_id; v_sort := v_old.sort_order;
    v_active := v_old.is_active; v_default := v_old.is_default_warehouse;
  END IF;

  IF p_location ? 'name' THEN v_name := btrim(coalesce(public.stock__j_text(p_location, 'name', 'E_LOCATION_NAME'), '')); END IF;
  IF p_location ? 'kind' THEN v_kind := public.stock__j_text(p_location, 'kind', 'E_LOCATION_KIND'); END IF;
  IF p_location ? 'chair_id' THEN v_chair := public.stock__j_uuid(p_location, 'chair_id', 'E_CHAIR'); END IF;
  IF p_location ? 'sort_order' THEN
    v_sort_n := public.stock__j_num(p_location, 'sort_order', 'E_FILTER');
    IF v_sort_n IS NULL OR v_sort_n <> trunc(v_sort_n) OR v_sort_n < 0 OR v_sort_n > 9999 THEN
      PERFORM public.stock__raise('E_FILTER');
    END IF;
    v_sort := v_sort_n::integer;
  END IF;
  IF p_location ? 'is_active' THEN v_active := public.stock__j_bool(p_location, 'is_active', 'E_FILTER'); END IF;
  IF p_location ? 'is_default_warehouse' THEN
    v_default := public.stock__j_bool(p_location, 'is_default_warehouse', 'E_FILTER');
  END IF;
  IF v_active IS NULL OR v_default IS NULL THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;

  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    PERFORM public.stock__raise('E_LOCATION_NAME');
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('warehouse', 'room', 'sterilization') THEN
    PERFORM public.stock__raise('E_LOCATION_KIND');
  END IF;
  IF v_chair IS NOT NULL AND (v_create OR v_chair IS DISTINCT FROM v_old.chair_id) AND NOT EXISTS (
    SELECT 1 FROM public.chairs c WHERE c.id = v_chair AND c.clinic_id = v_clinic AND coalesce(c.is_active, true)
  ) THEN
    PERFORM public.stock__raise('E_CHAIR');
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_locations l
             WHERE l.clinic_id = v_clinic AND l.name_key = public.stock__tr_lower(v_name) AND l.id <> p_id) THEN
    PERFORM public.stock__raise('E_LOCATION_TAKEN');
  END IF;

  -- The current default stays an active warehouse and keeps its flag until another one takes it.
  IF NOT v_create AND v_old.is_default_warehouse AND (NOT v_default OR NOT v_active OR v_kind <> 'warehouse') THEN
    PERFORM public.stock__raise('E_LOCATION_DEFAULT');
  END IF;
  IF v_default AND (v_kind <> 'warehouse' OR NOT v_active) THEN
    PERFORM public.stock__raise('E_LOCATION_DEFAULT');
  END IF;
  IF NOT v_create AND v_old.is_active AND NOT v_active AND EXISTS (
    SELECT 1 FROM public.stock_balances sb WHERE sb.location_id = p_id AND sb.quantity > 0
  ) THEN
    PERFORM public.stock__raise('E_LOCATION_HAS_STOCK');
  END IF;

  -- A new default: the old one is un-flagged first (both rows locked).
  IF v_default AND (v_create OR NOT v_old.is_default_warehouse) THEN
    SELECT l.id INTO v_old_default FROM public.stock_locations l
    WHERE l.clinic_id = v_clinic AND l.is_default_warehouse AND l.id <> p_id
    FOR UPDATE;
    IF v_old_default IS NOT NULL THEN
      UPDATE public.stock_locations
      SET is_default_warehouse = false, version = version + 1, updated_by = v_actor, updated_at = now()
      WHERE id = v_old_default;
    END IF;
  END IF;

  BEGIN
    IF v_create THEN
      INSERT INTO public.stock_locations (id, clinic_id, name, name_key, kind, is_default_warehouse, chair_id,
                                          sort_order, is_active, created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, public.stock__tr_lower(v_name), v_kind, v_default, v_chair, v_sort, v_active,
              v_actor, v_actor);
    ELSE
      UPDATE public.stock_locations
      SET name = v_name, kind = v_kind, is_default_warehouse = v_default, chair_id = v_chair, sort_order = v_sort,
          is_active = v_active, version = version + 1, updated_by = v_actor, updated_at = now()
      WHERE id = p_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'stock_locations_name_key' THEN
      PERFORM public.stock__raise('E_LOCATION_TAKEN');
    ELSIF v_constraint = 'stock_locations_default_key' THEN
      PERFORM public.stock__raise('E_VERSION');
    END IF;
    PERFORM public.stock__raise('E_ID_TAKEN');
  END;

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true,
    'location', (
      SELECT jsonb_build_object(
        'id', l.id, 'name', l.name, 'kind', l.kind, 'is_default_warehouse', l.is_default_warehouse,
        'chair_id', l.chair_id, 'chair_name', c.name, 'sort_order', l.sort_order, 'is_active', l.is_active,
        'version', l.version,
        'stock_lines', (SELECT count(*) FROM public.stock_balances sb WHERE sb.location_id = l.id AND sb.quantity > 0))
      FROM public.stock_locations l
      LEFT JOIN public.chairs c ON c.id = l.chair_id
      WHERE l.id = p_id)));
END;
$$;

-- 4.14 Suppliers (managers). Linking to a finance counterparty needs 'finance'.
CREATE OR REPLACE FUNCTION public.stock_save_supplier(
  p_operation_key uuid,
  p_id uuid,
  p_version integer,
  p_supplier jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_actor uuid := public.current_app_user_id();
  v_prev jsonb;
  v_create boolean := p_version IS NULL;
  v_old public.suppliers%ROWTYPE;
  v_name text;
  v_phone text := '';
  v_email text := '';
  v_tax text := '';
  v_note text := '';
  v_active boolean := true;
  v_fin uuid;
  v_constraint text;
BEGIN
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'stock_save_supplier', jsonb_build_object(
    'id', p_id, 'version', p_version, 'supplier', p_supplier));
  IF v_prev IS NOT NULL THEN
    RETURN v_prev;
  END IF;

  IF p_id IS NULL OR p_supplier IS NULL OR NOT public.stock__keys_ok(p_supplier,
       ARRAY['name', 'phone', 'email', 'tax_no', 'note', 'is_active', 'fin_counterparty_id']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;

  IF v_create THEN
    IF EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = p_id) THEN
      PERFORM public.stock__raise('E_ID_TAKEN');
    END IF;
  ELSE
    SELECT * INTO v_old FROM public.suppliers s
    WHERE s.id = p_id AND s.clinic_id = v_clinic
    FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.stock__raise('E_SUPPLIER');
    END IF;
    IF v_old.version <> p_version THEN
      PERFORM public.stock__raise('E_VERSION');
    END IF;
    v_name := v_old.name; v_phone := v_old.phone; v_email := v_old.email; v_tax := v_old.tax_no;
    v_note := v_old.note; v_active := v_old.is_active; v_fin := v_old.fin_counterparty_id;
  END IF;

  IF p_supplier ? 'name' THEN v_name := btrim(coalesce(public.stock__j_text(p_supplier, 'name', 'E_SUPPLIER_NAME'), '')); END IF;
  IF p_supplier ? 'phone' THEN v_phone := btrim(coalesce(public.stock__j_text(p_supplier, 'phone', 'E_SUPPLIER_FIELDS'), '')); END IF;
  IF p_supplier ? 'email' THEN v_email := btrim(coalesce(public.stock__j_text(p_supplier, 'email', 'E_SUPPLIER_FIELDS'), '')); END IF;
  IF p_supplier ? 'tax_no' THEN v_tax := btrim(coalesce(public.stock__j_text(p_supplier, 'tax_no', 'E_SUPPLIER_FIELDS'), '')); END IF;
  IF p_supplier ? 'note' THEN v_note := btrim(coalesce(public.stock__j_text(p_supplier, 'note', 'E_SUPPLIER_FIELDS'), '')); END IF;
  IF p_supplier ? 'is_active' THEN v_active := public.stock__j_bool(p_supplier, 'is_active', 'E_SUPPLIER_FIELDS'); END IF;

  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    PERFORM public.stock__raise('E_SUPPLIER_NAME');
  END IF;
  IF v_active IS NULL OR char_length(v_phone) > 40 OR char_length(v_email) > 200
     OR (v_email <> '' AND v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     OR v_tax !~ '^[0-9]{0,11}$' OR char_length(v_note) > 500 THEN
    PERFORM public.stock__raise('E_SUPPLIER_FIELDS');
  END IF;

  -- Finance link: changing it (also unlinking) needs 'finance'; the counterparty must be an active supplier.
  IF p_supplier ? 'fin_counterparty_id' THEN
    IF public.stock__j_uuid(p_supplier, 'fin_counterparty_id', 'E_FIN_COUNTERPARTY') IS DISTINCT FROM v_fin THEN
      IF NOT public.has_permission('finance') THEN
        PERFORM public.stock__raise('E_FINANCE_LINK');
      END IF;
      v_fin := public.stock__j_uuid(p_supplier, 'fin_counterparty_id', 'E_FIN_COUNTERPARTY');
      IF v_fin IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.fin_counterparties f
        WHERE f.id = v_fin AND f.clinic_id = v_clinic AND f.is_active AND f.kind = 'supplier'
      ) THEN
        PERFORM public.stock__raise('E_FIN_COUNTERPARTY');
      END IF;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.suppliers s
             WHERE s.clinic_id = v_clinic AND s.name_key = public.stock__tr_lower(v_name) AND s.id <> p_id) THEN
    PERFORM public.stock__raise('E_SUPPLIER_TAKEN');
  END IF;

  BEGIN
    IF v_create THEN
      INSERT INTO public.suppliers (id, clinic_id, name, name_key, phone, email, tax_no, note, fin_counterparty_id,
                                    is_active, created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, public.stock__tr_lower(v_name), v_phone, v_email, v_tax, v_note, v_fin,
              v_active, v_actor, v_actor);
    ELSE
      UPDATE public.suppliers
      SET name = v_name, phone = v_phone, email = v_email, tax_no = v_tax, note = v_note, fin_counterparty_id = v_fin,
          is_active = v_active, version = version + 1, updated_by = v_actor, updated_at = now()
      WHERE id = p_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'suppliers_name_key' THEN
      PERFORM public.stock__raise('E_SUPPLIER_TAKEN');
    END IF;
    PERFORM public.stock__raise('E_ID_TAKEN');
  END;

  -- Card mirrors carry the supplier name.
  IF NOT v_create AND v_name IS DISTINCT FROM v_old.name THEN
    PERFORM public.stock__sync_item(v_clinic, i.id) FROM public.stock_items i
    WHERE i.clinic_id = v_clinic AND i.supplier_id = p_id;
  END IF;

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object(
    'ok', true,
    'supplier', (
      SELECT jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'email', s.email, 'tax_no', s.tax_no,
                                'note', s.note, 'is_active', s.is_active, 'version', s.version,
                                'linked_to_finance', s.fin_counterparty_id IS NOT NULL)
      FROM public.suppliers s WHERE s.id = p_id)));
END;
$$;

-- 4.15 Favourites (any active staff; at most 100 per user, PF:3). Naturally idempotent.
CREATE OR REPLACE FUNCTION public.stock_set_favorite(p_stock_item_id uuid, p_favorite boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_n integer;
BEGIN
  IF p_favorite IS NULL THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.stock_items i
    WHERE i.id = p_stock_item_id AND i.clinic_id = v_clinic AND (i.is_active OR NOT p_favorite)
  ) THEN
    PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock.favorites:' || v_actor::text, 0));
  IF p_favorite THEN
    IF NOT EXISTS (SELECT 1 FROM public.user_favorite_items f WHERE f.user_id = v_actor AND f.stock_item_id = p_stock_item_id) THEN
      SELECT count(*) INTO v_n FROM public.user_favorite_items f WHERE f.user_id = v_actor;
      IF v_n >= 100 THEN
        PERFORM public.stock__raise('E_FAVORITES_LIMIT');
      END IF;
      INSERT INTO public.user_favorite_items (clinic_id, user_id, stock_item_id)
      VALUES (v_clinic, v_actor, p_stock_item_id)
      ON CONFLICT (user_id, stock_item_id) DO NOTHING;
    END IF;
  ELSE
    DELETE FROM public.user_favorite_items f WHERE f.user_id = v_actor AND f.stock_item_id = p_stock_item_id;
  END IF;

  SELECT count(*) INTO v_n FROM public.user_favorite_items f WHERE f.user_id = v_actor;
  RETURN jsonb_build_object('ok', true, 'stock_item_id', p_stock_item_id, 'favorite', p_favorite, 'count', v_n);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Read RPCs. SECURITY DEFINER, clinic from the session, one jsonb value each. Cost keys only for cost viewers
--    (absent otherwise). Every response carries can_view_costs / can_operate / can_manage.
-- ---------------------------------------------------------------------------

-- 5.1 Dashboard: counts, critical list, expiry list, attention list, pending work, recent movements, value.
CREATE OR REPLACE FUNCTION public.stock_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_cost boolean := public.stock_can_view_costs();
  v_manage boolean := public.stock_can_manage();
  v_operate boolean := public.stock_can_operate();
  v_items jsonb;
  v_health jsonb;
  v_crit_count bigint;
  v_crit_out bigint;
  v_crit_rows jsonb;
  v_exp_count bigint;
  v_exp_expired bigint;
  v_exp_critical bigint;
  v_exp_rows jsonb;
  v_att jsonb;
  v_pending jsonb;
  v_recent jsonb;
  v_recent_items jsonb;
  v_favorites jsonb;
  v_value jsonb;
  v_result jsonb;
BEGIN
  -- Cards and A/B/C health (same critical predicate everywhere, §1.7).
  SELECT jsonb_build_object(
           'active', count(*) FILTER (WHERE r.is_active AND NOT r.needs_review),
           'draft', count(*) FILTER (WHERE r.is_active AND r.needs_review),
           'by_level', jsonb_build_object(
             'A', count(*) FILTER (WHERE r.is_active AND NOT r.needs_review AND r.tracking_level = 'A'),
             'B', count(*) FILTER (WHERE r.is_active AND NOT r.needs_review AND r.tracking_level = 'B'),
             'C', count(*) FILTER (WHERE r.is_active AND NOT r.needs_review AND r.tracking_level = 'C'))),
         count(*) FILTER (WHERE r.critical),
         count(*) FILTER (WHERE r.critical AND r.usable_qty = 0)
    INTO v_items, v_crit_count, v_crit_out
  FROM public.stock__item_rows(v_clinic, v_today, v_actor, false) r;

  SELECT jsonb_object_agg(g.l, jsonb_build_object(
           'items', g.items, 'eligible', g.eligible, 'ok', g.ok,
           'pct', CASE WHEN g.eligible > 0 THEN round(100.0 * g.ok / g.eligible) END))
    INTO v_health
  FROM (
    SELECT lv.l,
           count(r.id) FILTER (WHERE r.is_active AND NOT r.needs_review) AS items,
           count(r.id) FILTER (WHERE r.is_active AND NOT r.needs_review AND r.max_qty > 0) AS eligible,
           count(r.id) FILTER (WHERE r.is_active AND NOT r.needs_review AND r.max_qty > 0 AND NOT r.critical) AS ok
    FROM (VALUES ('A'), ('B'), ('C')) AS lv(l)
    LEFT JOIN public.stock__item_rows(v_clinic, v_today, v_actor, false) r ON r.tracking_level = lv.l
    GROUP BY lv.l
  ) g;

  -- Critical cards: red (usable 0) first, then usable / MIN ascending, then Turkish name; top 20.
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.rn), '[]'::jsonb)
    INTO v_crit_rows
  FROM (
    SELECT jsonb_build_object(
             'stock_item_id', r.id, 'item_name', r.item_name, 'usage_unit', r.usage_unit,
             'tracking_level', r.tracking_level, 'usable_qty', public.stock__q(r.usable_qty),
             'min_qty', public.stock__q(r.min_qty), 'max_qty', public.stock__q(r.max_qty),
             'suggested_qty', public.stock__q(CASE WHEN r.max_qty > r.usable_qty
                                                   THEN ceil((r.max_qty - r.usable_qty) / r.units_per_purchase)
                                                        * r.units_per_purchase
                                                   ELSE 0 END),
             'state', CASE WHEN r.usable_qty = 0 THEN 'out' ELSE 'critical' END) AS j,
           row_number() OVER (ORDER BY (r.usable_qty = 0) DESC, r.usable_qty / nullif(r.min_qty, 0) ASC NULLS FIRST,
                                       r.item_name COLLATE "tr-x-icu", r.id) AS rn
    FROM public.stock__item_rows(v_clinic, v_today, v_actor, false) r
    WHERE r.critical
  ) x
  WHERE x.rn <= 20;

  -- Expiry watch (90 days, expired included): counts and top 20 by date.
  SELECT count(*), count(*) FILTER (WHERE e.state = 'expired'), count(*) FILTER (WHERE e.state = 'critical')
    INTO v_exp_count, v_exp_expired, v_exp_critical
  FROM public.stock__expiry_rows(v_clinic, v_today, 90) e;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.rn), '[]'::jsonb)
    INTO v_exp_rows
  FROM (
    SELECT jsonb_build_object(
             'stock_item_id', e.stock_item_id, 'item_name', i.item_name, 'usage_unit', i.usage_unit,
             'tracking_level', i.tracking_level, 'batch_id', e.batch_id, 'lot_number', e.lot_number,
             'serial_number', e.serial_number, 'expiry_date', e.expiry_date, 'days_left', e.days_left,
             'state', e.state, 'location_id', e.location_id, 'location_name', l.name,
             'quantity', public.stock__q(e.quantity)) AS j,
           row_number() OVER (ORDER BY e.expiry_date, i.item_name COLLATE "tr-x-icu", e.batch_id, e.location_id) AS rn
    FROM public.stock__expiry_rows(v_clinic, v_today, 90) e
    JOIN public.stock_items i ON i.id = e.stock_item_id
    JOIN public.stock_locations l ON l.id = e.location_id
  ) x
  WHERE x.rn <= 20;

  -- "Bugün dikkat isteyenler": critical cards, then the first 4 expiry rows; red first; at most 7.
  SELECT coalesce(jsonb_agg(a.j ORDER BY a.sev, a.k, a.ord), '[]'::jsonb)
    INTO v_att
  FROM (
    SELECT b.j, b.sev, b.k, b.ord
    FROM (
      SELECT jsonb_build_object('kind', 'critical') || c.v
               || jsonb_build_object('severity', CASE WHEN c.v ->> 'state' = 'out' THEN 'red' ELSE 'amber' END) AS j,
             CASE WHEN c.v ->> 'state' = 'out' THEN 0 ELSE 1 END AS sev, 0 AS k, c.ord
      FROM jsonb_array_elements(v_crit_rows) WITH ORDINALITY AS c(v, ord)
      UNION ALL
      SELECT jsonb_build_object('kind', 'expiry') || c.v
               || jsonb_build_object('severity', CASE WHEN (c.v ->> 'days_left')::integer <= 30 THEN 'red' ELSE 'amber' END),
             CASE WHEN (c.v ->> 'days_left')::integer <= 30 THEN 0 ELSE 1 END, 1, c.ord
      FROM jsonb_array_elements(v_exp_rows) WITH ORDINALITY AS c(v, ord)
      WHERE c.ord <= 4
    ) b
    ORDER BY b.sev, b.k, b.ord
    LIMIT 7
  ) a;

  SELECT jsonb_build_object(
           'corrections', (SELECT count(*) FROM public.stock_correction_requests r
                           WHERE r.clinic_id = v_clinic AND r.status = 'pending'
                             AND (v_manage OR r.requested_by = v_actor)),
           'product_requests', (SELECT count(*) FROM public.stock_product_requests r
                                WHERE r.clinic_id = v_clinic AND r.status = 'pending'))
    INTO v_pending;

  SELECT coalesce(jsonb_agg(h.j ORDER BY p.created_at DESC, p.ref_no DESC), '[]'::jsonb)
    INTO v_recent
  FROM (
    SELECT m.id, m.created_at, m.ref_no FROM public.stock_movements m
    WHERE m.clinic_id = v_clinic
    ORDER BY m.created_at DESC, m.ref_no DESC
    LIMIT 8
  ) p
  JOIN public.stock__history_rows(v_clinic, v_actor, v_manage, v_operate) h ON h.id = p.id;

  SELECT coalesce(jsonb_agg(to_jsonb(x.stock_item_id) ORDER BY x.last_at DESC), '[]'::jsonb)
    INTO v_recent_items
  FROM (
    SELECT m.stock_item_id, max(m.created_at) AS last_at
    FROM public.stock_movements m
    JOIN public.stock_items i ON i.id = m.stock_item_id AND i.is_active
    WHERE m.clinic_id = v_clinic AND m.actor_user_id = v_actor
    GROUP BY m.stock_item_id
    ORDER BY max(m.created_at) DESC
    LIMIT 8
  ) x;

  SELECT coalesce(jsonb_agg(to_jsonb(f.stock_item_id) ORDER BY f.created_at), '[]'::jsonb)
    INTO v_favorites
  FROM public.user_favorite_items f
  JOIN public.stock_items i ON i.id = f.stock_item_id AND i.is_active
  WHERE f.user_id = v_actor AND f.clinic_id = v_clinic;

  v_result := jsonb_build_object(
    'today', v_today,
    'items', v_items,
    'health_by_level', coalesce(v_health, '{}'::jsonb),
    'critical', jsonb_build_object('count', v_crit_count, 'out_of_stock', v_crit_out, 'rows', v_crit_rows),
    'expiry', jsonb_build_object('count', v_exp_count, 'expired', v_exp_expired, 'critical', v_exp_critical,
                                 'rows', v_exp_rows),
    'attention', v_att,
    'pending', v_pending,
    'recent_movements', v_recent,
    'recent_items', v_recent_items,
    'favorites', v_favorites) || public.stock__flags();

  IF v_cost THEN
    SELECT jsonb_build_object(
             'value_cents', coalesce((SELECT round(sum(v.quantity * v.unit_cost_cents))::bigint
                                      FROM public.stock__value_rows(v_clinic) v
                                      WHERE v.unit_cost_cents IS NOT NULL), 0),
             'expiry_risk_value_cents', coalesce((SELECT round(sum(e.quantity * bc.unit_cost_cents))::bigint
                                                  FROM public.stock__expiry_rows(v_clinic, v_today, 90) e
                                                  JOIN public.stock_batch_costs bc ON bc.batch_id = e.batch_id), 0),
             'uncosted_batches', (SELECT count(DISTINCT v.batch_id) FROM public.stock__value_rows(v_clinic) v
                                  WHERE v.unit_cost_cents IS NULL),
             'by_category', coalesce((
               SELECT jsonb_agg(jsonb_build_object('category', g.category, 'value_cents', g.value_cents)
                                ORDER BY g.value_cents DESC, g.category)
               FROM (
                 SELECT coalesce(i.category, '') AS category,
                        round(sum(v.quantity * v.unit_cost_cents))::bigint AS value_cents
                 FROM public.stock__value_rows(v_clinic) v
                 JOIN public.stock_items i ON i.id = v.stock_item_id
                 WHERE v.unit_cost_cents IS NOT NULL
                 GROUP BY coalesce(i.category, '')
               ) g), '[]'::jsonb),
             'by_location', coalesce((
               SELECT jsonb_agg(jsonb_build_object('location_id', g.location_id, 'location_name', g.name,
                                                   'value_cents', g.value_cents)
                                ORDER BY g.value_cents DESC, g.name)
               FROM (
                 SELECT v.location_id, l.name, round(sum(v.quantity * v.unit_cost_cents))::bigint AS value_cents
                 FROM public.stock__value_rows(v_clinic) v
                 JOIN public.stock_locations l ON l.id = v.location_id
                 WHERE v.unit_cost_cents IS NOT NULL
                 GROUP BY v.location_id, l.name
               ) g), '[]'::jsonb))
      INTO v_value;
    v_result := v_result || jsonb_build_object('value', v_value);
  END IF;

  RETURN v_result;
END;
$$;

-- 5.2 Card list with levels (paged, max 200).
CREATE OR REPLACE FUNCTION public.stock_item_levels(p_filters jsonb DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_cost boolean := public.stock_can_view_costs();
  v_manage boolean := public.stock_can_manage();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_gtin_q text;
  v_level text;
  v_status text;
  v_category text;
  v_loc uuid;
  v_fav boolean;
  v_recent boolean;
  v_operable boolean;
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF NOT public.stock__keys_ok(v_f, ARRAY['q', 'tracking_level', 'status', 'category', 'location_id', 'favorites',
                                          'recent', 'operable']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_q := nullif(public.stock__tr_lower(btrim(coalesce(public.stock__j_text(v_f, 'q', 'E_FILTER'), ''))), '');
  IF v_q ~ '^[0-9]{8,14}$' THEN
    v_gtin_q := lpad(v_q, 14, '0');
  END IF;
  v_level := public.stock__j_text(v_f, 'tracking_level', 'E_FILTER');
  v_status := coalesce(public.stock__j_text(v_f, 'status', 'E_FILTER'), 'all');
  v_category := public.stock__j_text(v_f, 'category', 'E_FILTER');
  v_loc := public.stock__j_uuid(v_f, 'location_id', 'E_FILTER');
  v_fav := coalesce(public.stock__j_bool(v_f, 'favorites', 'E_FILTER'), false);
  v_recent := coalesce(public.stock__j_bool(v_f, 'recent', 'E_FILTER'), false);
  v_operable := coalesce(public.stock__j_bool(v_f, 'operable', 'E_FILTER'), false);
  IF (v_level IS NOT NULL AND v_level NOT IN ('A', 'B', 'C'))
     OR v_status NOT IN ('all', 'ready', 'draft', 'critical', 'expiring', 'out', 'inactive') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH rec AS (
    SELECT m.stock_item_id, max(m.created_at) AS last_at
    FROM public.stock_movements m
    WHERE m.clinic_id = v_clinic AND m.actor_user_id = v_actor
    GROUP BY m.stock_item_id
    ORDER BY max(m.created_at) DESC
    LIMIT 8
  ), atloc AS (
    SELECT sb.stock_item_id, sum(sb.quantity) AS q
    FROM public.stock_balances sb
    WHERE sb.clinic_id = v_clinic AND sb.location_id = v_loc AND sb.quantity > 0
    GROUP BY sb.stock_item_id
  ), expiring AS (
    SELECT DISTINCT e.stock_item_id FROM public.stock__expiry_rows(v_clinic, v_today, 90) e
  ), f AS (
    SELECT r.id, r.item_name, r.tracking_level, rec.last_at,
           r.j || CASE WHEN v_loc IS NOT NULL THEN jsonb_build_object('at_location_qty', public.stock__q(coalesce(atloc.q, 0)))
                       ELSE '{}'::jsonb END AS j
    FROM public.stock__item_rows(v_clinic, v_today, v_actor, v_cost) r
    LEFT JOIN rec ON rec.stock_item_id = r.id
    LEFT JOIN atloc ON atloc.stock_item_id = r.id
    WHERE (CASE v_status
             WHEN 'all' THEN r.is_active AND (NOT r.needs_review OR v_manage)
             WHEN 'ready' THEN r.is_active AND NOT r.needs_review
             WHEN 'draft' THEN v_manage AND r.is_active AND r.needs_review
             WHEN 'critical' THEN r.critical
             WHEN 'expiring' THEN r.is_active AND r.id IN (SELECT expiring.stock_item_id FROM expiring)
             WHEN 'out' THEN r.is_active AND NOT r.needs_review AND r.usable_qty = 0
             WHEN 'inactive' THEN v_manage AND NOT r.is_active
           END)
      AND (NOT v_operable OR (r.is_active AND NOT r.needs_review))
      AND (v_level IS NULL OR r.tracking_level = v_level)
      AND (v_category IS NULL OR r.category = v_category)
      AND (v_loc IS NULL OR atloc.q IS NOT NULL)
      AND (NOT v_fav OR r.is_favorite)
      AND (NOT v_recent OR rec.last_at IS NOT NULL)
      AND (v_q IS NULL OR strpos(r.search, v_q) > 0 OR r.gtin = v_gtin_q)
  ), p AS (
    SELECT f.j,
           row_number() OVER (ORDER BY CASE WHEN v_recent THEN f.last_at END DESC NULLS LAST, f.tracking_level,
                                       f.item_name COLLATE "tr-x-icu", f.id) AS rn
    FROM f
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(p.j ORDER BY p.rn) FROM p WHERE p.rn > v_off AND p.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.3 Expiry watch (per batch x location), paged; the action pre-selects waste for expired rows.
CREATE OR REPLACE FUNCTION public.stock_expiry_watch(p_days integer DEFAULT 90, p_location_id uuid DEFAULT NULL,
                                                     p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_today date := public.clinic_today();
  v_cost boolean := public.stock_can_view_costs();
  v_days integer := coalesce(p_days, 90);
  v_off integer;
  v_lim integer;
  v_totals jsonb;
  v_rows jsonb;
BEGIN
  IF v_days NOT BETWEEN 0 AND 365 THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH e AS (
    SELECT x.*, i.item_name, i.usage_unit, i.tracking_level, l.name AS location_name, bc.unit_cost_cents,
           row_number() OVER (ORDER BY x.expiry_date, i.item_name COLLATE "tr-x-icu", x.batch_id, x.location_id) AS rn
    FROM public.stock__expiry_rows(v_clinic, v_today, v_days) x
    JOIN public.stock_items i ON i.id = x.stock_item_id
    JOIN public.stock_locations l ON l.id = x.location_id
    LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = x.batch_id
    WHERE p_location_id IS NULL OR x.location_id = p_location_id
  )
  SELECT jsonb_build_object('count', count(*), 'expired', count(*) FILTER (WHERE e.state = 'expired'),
                            'critical', count(*) FILTER (WHERE e.state = 'critical'))
         || CASE WHEN v_cost THEN jsonb_build_object('value_cents',
                   coalesce(round(sum(e.quantity * e.unit_cost_cents))::bigint, 0)) ELSE '{}'::jsonb END,
         coalesce(jsonb_agg(
           jsonb_build_object(
             'stock_item_id', e.stock_item_id, 'item_name', e.item_name, 'usage_unit', e.usage_unit,
             'tracking_level', e.tracking_level, 'batch_id', e.batch_id, 'lot_number', e.lot_number,
             'serial_number', e.serial_number, 'expiry_date', e.expiry_date, 'days_left', e.days_left,
             'state', e.state, 'location_id', e.location_id, 'location_name', e.location_name,
             'quantity', public.stock__q(e.quantity),
             'action', CASE WHEN e.state = 'expired' THEN 'waste' ELSE 'issue' END)
           || CASE WHEN v_cost THEN jsonb_build_object('value_cents',
                     CASE WHEN e.unit_cost_cents IS NOT NULL THEN round(e.quantity * e.unit_cost_cents)::bigint END)
                   ELSE '{}'::jsonb END
           ORDER BY e.rn) FILTER (WHERE e.rn > v_off AND e.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_totals, v_rows
  FROM e;

  RETURN jsonb_build_object('today', v_today, 'days', v_days, 'totals', v_totals, 'total', v_totals -> 'count',
                            'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.4 Movement history, paged (default 50, max 200), newest first.
CREATE OR REPLACE FUNCTION public.stock_movement_history(p_filters jsonb DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_manage boolean := public.stock_can_manage();
  v_operate boolean := public.stock_can_operate();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_item uuid;
  v_loc uuid;
  v_types text[];
  v_from date;
  v_to date;
  v_by uuid;
  v_mine boolean;
  v_patient uuid;
  v_corrected text;
  v_op uuid;
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF NOT public.stock__keys_ok(v_f, ARRAY['stock_item_id', 'location_id', 'types', 'from', 'to', 'actor_user_id',
                                          'mine', 'patient_id', 'corrected', 'operation_key']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_item := public.stock__j_uuid(v_f, 'stock_item_id', 'E_FILTER');
  v_loc := public.stock__j_uuid(v_f, 'location_id', 'E_FILTER');
  v_by := public.stock__j_uuid(v_f, 'actor_user_id', 'E_FILTER');
  v_patient := public.stock__j_uuid(v_f, 'patient_id', 'E_FILTER');
  v_op := public.stock__j_uuid(v_f, 'operation_key', 'E_FILTER');
  v_mine := coalesce(public.stock__j_bool(v_f, 'mine', 'E_FILTER'), false);
  v_corrected := public.stock__j_text(v_f, 'corrected', 'E_FILTER');
  IF v_corrected IS NOT NULL AND v_corrected NOT IN ('only', 'exclude') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  IF v_f ? 'types' AND jsonb_typeof(v_f -> 'types') <> 'null' THEN
    IF jsonb_typeof(v_f -> 'types') <> 'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_f -> 'types') AS t(v)
      WHERE jsonb_typeof(t.v) <> 'string'
         OR (t.v #>> '{}') NOT IN ('opening', 'receive', 'issue', 'transfer', 'waste', 'return', 'adjust_in',
                                   'adjust_out', 'correction_reversal')
    ) THEN
      PERFORM public.stock__raise('E_FILTER');
    END IF;
    SELECT array_agg(t.v) INTO v_types FROM jsonb_array_elements_text(v_f -> 'types') AS t(v);
  END IF;
  IF nullif(btrim(coalesce(public.stock__j_text(v_f, 'from', 'E_DATE_RANGE'), '')), '') IS NOT NULL THEN
    v_from := public.stock__day(v_f ->> 'from');
  END IF;
  IF nullif(btrim(coalesce(public.stock__j_text(v_f, 'to', 'E_DATE_RANGE'), '')), '') IS NOT NULL THEN
    v_to := public.stock__day(v_f ->> 'to');
  END IF;
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND (v_from > v_to OR v_to - v_from > 366) THEN
    PERFORM public.stock__raise('E_DATE_RANGE');
  END IF;
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH f AS (
    SELECT m.id, m.created_at, m.ref_no
    FROM public.stock_movements m
    WHERE m.clinic_id = v_clinic
      AND (v_item IS NULL OR m.stock_item_id = v_item)
      AND (v_loc IS NULL OR m.from_location_id = v_loc OR m.to_location_id = v_loc)
      AND (v_types IS NULL OR m.movement_type = ANY (v_types))
      AND (v_from IS NULL OR m.effective_at >= (v_from::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AND (v_to IS NULL OR m.effective_at < ((v_to + 1)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AND (v_by IS NULL OR m.actor_user_id = v_by)
      AND (NOT v_mine OR m.actor_user_id = v_actor)
      AND (v_patient IS NULL OR m.patient_id = v_patient)
      AND (v_op IS NULL OR m.operation_key = v_op)
      AND (v_corrected IS NULL
           OR (v_corrected = 'only') = EXISTS (SELECT 1 FROM public.stock_correction_requests cr
                                                WHERE cr.movement_id = m.id AND cr.status = 'approved'))
  ), p AS (
    SELECT f.id, f.created_at, f.ref_no FROM f
    ORDER BY f.created_at DESC, f.ref_no DESC
    OFFSET v_off LIMIT v_lim
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(h.j ORDER BY p.created_at DESC, p.ref_no DESC)
                   FROM p JOIN public.stock__history_rows(v_clinic, v_actor, v_manage, v_operate) h ON h.id = p.id),
                  '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.5 Card detail. Draft and inactive cards only for managers.
CREATE OR REPLACE FUNCTION public.stock_item_detail(p_stock_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_cost boolean := public.stock_can_view_costs();
  v_manage boolean := public.stock_can_manage();
  v_operate boolean := public.stock_can_operate();
  v_item public.stock_items%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_item FROM public.stock_items i WHERE i.id = p_stock_item_id AND i.clinic_id = v_clinic;
  IF NOT FOUND OR ((NOT v_item.is_active OR v_item.needs_review) AND NOT v_manage) THEN
    PERFORM public.stock__raise('E_ITEM_NOT_FOUND');
  END IF;

  v_result := jsonb_build_object(
    'item', public.stock__item_json(v_clinic, v_item.id, v_actor, v_cost),
    'balances', coalesce((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'location_id', sb.location_id, 'location_name', l.name, 'batch_id', sb.batch_id,
                 'lot_number', b.lot_number, 'serial_number', b.serial_number, 'expiry_date', b.expiry_date,
                 'received_at', b.received_at, 'quantity', public.stock__q(sb.quantity),
                 'usable', (b.expiry_date IS NULL OR b.expiry_date >= v_today))
               || CASE WHEN v_cost THEN jsonb_build_object('unit_cost_cents', bc.unit_cost_cents) ELSE '{}'::jsonb END
               ORDER BY b.expiry_date ASC NULLS LAST, b.received_at, b.id, l.sort_order, l.name)
      FROM public.stock_balances sb
      JOIN public.stock_batches b ON b.id = sb.batch_id
      JOIN public.stock_locations l ON l.id = sb.location_id
      LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = sb.batch_id
      WHERE sb.stock_item_id = v_item.id AND sb.clinic_id = v_clinic AND sb.quantity > 0), '[]'::jsonb),
    'by_location', coalesce((
      SELECT jsonb_agg(jsonb_build_object('location_id', g.location_id, 'location_name', g.name,
                                          'usable_qty', public.stock__q(g.usable), 'total_qty', public.stock__q(g.total))
                       ORDER BY g.sort_order, g.name)
      FROM (
        SELECT sb.location_id, l.name, l.sort_order, sum(sb.quantity) AS total,
               coalesce(sum(sb.quantity) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= v_today), 0) AS usable
        FROM public.stock_balances sb
        JOIN public.stock_batches b ON b.id = sb.batch_id
        JOIN public.stock_locations l ON l.id = sb.location_id
        WHERE sb.stock_item_id = v_item.id AND sb.clinic_id = v_clinic AND sb.quantity > 0
        GROUP BY sb.location_id, l.name, l.sort_order
      ) g), '[]'::jsonb),
    'recent_movements', coalesce((
      SELECT jsonb_agg(h.j ORDER BY p.created_at DESC, p.ref_no DESC)
      FROM (
        SELECT m.id, m.created_at, m.ref_no FROM public.stock_movements m
        WHERE m.clinic_id = v_clinic AND m.stock_item_id = v_item.id
        ORDER BY m.created_at DESC, m.ref_no DESC
        LIMIT 20
      ) p
      JOIN public.stock__history_rows(v_clinic, v_actor, v_manage, v_operate) h ON h.id = p.id), '[]'::jsonb),
    'pending_corrections', coalesce((
      SELECT jsonb_agg(public.stock__corr_json(v_clinic, r.id, v_actor, v_manage, v_operate) ORDER BY r.created_at DESC)
      FROM public.stock_correction_requests r
      JOIN public.stock_movements m ON m.id = r.movement_id
      WHERE r.clinic_id = v_clinic AND r.status = 'pending' AND m.stock_item_id = v_item.id
        AND (v_manage OR r.requested_by = v_actor)), '[]'::jsonb),
    'product_requests', coalesce((
      SELECT jsonb_agg(public.stock__preq_json(v_clinic, r.id) ORDER BY r.updated_at DESC)
      FROM public.stock_product_requests r
      WHERE r.clinic_id = v_clinic
        AND (r.stock_item_id = v_item.id OR (v_item.gtin IS NOT NULL AND r.gtin = v_item.gtin))), '[]'::jsonb)
  ) || public.stock__flags();

  IF v_cost THEN
    v_result := v_result || jsonb_build_object('cost', jsonb_build_object(
      'last_unit_cost_cents', (SELECT c.last_unit_cost_cents FROM public.stock_item_costs c WHERE c.stock_item_id = v_item.id),
      'value_cents', coalesce((SELECT round(sum(v.quantity * v.unit_cost_cents))::bigint
                               FROM public.stock__value_rows(v_clinic) v
                               WHERE v.stock_item_id = v_item.id AND v.unit_cost_cents IS NOT NULL), 0),
      'uncosted_qty', public.stock__q(coalesce((SELECT sum(v.quantity) FROM public.stock__value_rows(v_clinic) v
                                                WHERE v.stock_item_id = v_item.id AND v.unit_cost_cents IS NULL), 0))));
  END IF;
  RETURN v_result;
END;
$$;

-- 5.6 Count snapshot of one location (managers): every balance row there, zero rows included; expected_qty is the
-- value the count must send back.
CREATE OR REPLACE FUNCTION public.stock_location_snapshot(p_location_id uuid, p_filters jsonb DEFAULT NULL,
                                                          p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_today date := public.clinic_today();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_loc public.stock_locations%ROWTYPE;
  v_q text;
  v_item uuid;
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  SELECT * INTO v_loc FROM public.stock_locations l WHERE l.id = p_location_id AND l.clinic_id = v_clinic;
  IF NOT FOUND THEN
    PERFORM public.stock__raise('E_LOCATION');
  END IF;
  IF NOT public.stock__keys_ok(v_f, ARRAY['q', 'stock_item_id']) THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  v_q := nullif(public.stock__tr_lower(btrim(coalesce(public.stock__j_text(v_f, 'q', 'E_FILTER'), ''))), '');
  v_item := public.stock__j_uuid(v_f, 'stock_item_id', 'E_FILTER');
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 500) o;

  WITH s AS (
    SELECT jsonb_build_object(
             'batch_id', sb.batch_id, 'stock_item_id', sb.stock_item_id, 'item_name', i.item_name,
             'usage_unit', i.usage_unit, 'tracking_level', i.tracking_level, 'lot_number', b.lot_number,
             'serial_number', b.serial_number, 'expiry_date', b.expiry_date,
             'expired', coalesce(b.expiry_date < v_today, false),
             'expected_qty', public.stock__q(sb.quantity)) AS j,
           row_number() OVER (ORDER BY i.item_name COLLATE "tr-x-icu", b.expiry_date ASC NULLS LAST, b.lot_number,
                                       b.serial_number, sb.batch_id) AS rn
    FROM public.stock_balances sb
    JOIN public.stock_batches b ON b.id = sb.batch_id
    JOIN public.stock_items i ON i.id = sb.stock_item_id
    WHERE sb.clinic_id = v_clinic AND sb.location_id = v_loc.id
      AND i.is_active AND NOT i.needs_review
      AND (v_item IS NULL OR sb.stock_item_id = v_item)
      AND (v_q IS NULL OR strpos(public.stock__tr_lower(concat_ws(' ', i.item_name, i.brand, i.model, i.item_code,
                                                                  i.gtin, b.lot_number, b.serial_number)), v_q) > 0)
  )
  SELECT count(*), coalesce(jsonb_agg(s.j ORDER BY s.rn) FILTER (WHERE s.rn > v_off AND s.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows
  FROM s;

  RETURN jsonb_build_object(
    'location', jsonb_build_object('id', v_loc.id, 'name', v_loc.name, 'kind', v_loc.kind, 'is_active', v_loc.is_active),
    'snapshot_at', now(), 'total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.7 Scan lookup by the parsed GTIN (lot / serial / expiry optional, from the same scan).
CREATE OR REPLACE FUNCTION public.stock_scan_lookup(p_gtin text, p_lot_number text DEFAULT NULL,
                                                    p_serial_number text DEFAULT NULL, p_expiry_date text DEFAULT NULL,
                                                    p_location_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_cost boolean := public.stock_can_view_costs();
  v_gtin text := public.stock__gtin(p_gtin);
  v_lot text := nullif(btrim(coalesce(p_lot_number, '')), '');
  v_serial text := nullif(btrim(coalesce(p_serial_number, '')), '');
  v_exp date := public.stock__expiry(p_expiry_date);
  v_item public.stock_items%ROWTYPE;
  v_match text;
  v_batches jsonb := '[]'::jsonb;
  v_pending uuid;
BEGIN
  IF v_gtin IS NULL THEN
    PERFORM public.stock__raise('E_GTIN');
  END IF;

  SELECT * INTO v_item FROM public.stock_items i
  WHERE i.clinic_id = v_clinic AND i.gtin = v_gtin
  ORDER BY i.is_active DESC, i.updated_at DESC, i.id
  LIMIT 1;
  IF NOT FOUND THEN
    v_match := 'unknown';
  ELSIF NOT v_item.is_active THEN
    v_match := 'inactive';
  ELSIF v_item.needs_review THEN
    v_match := 'draft';
  ELSE
    v_match := 'known';
  END IF;

  IF v_match = 'known' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'batch_id', sb.batch_id, 'lot_number', b.lot_number, 'serial_number', b.serial_number,
             'expiry_date', b.expiry_date, 'location_id', sb.location_id, 'location_name', l.name,
             'quantity', public.stock__q(sb.quantity),
             'usable', (b.expiry_date IS NULL OR b.expiry_date >= v_today),
             'matches_scan', ((v_lot IS NULL OR b.lot_number = v_lot)
                              AND (v_serial IS NULL OR b.serial_number = v_serial)
                              AND (v_exp IS NULL OR b.expiry_date = v_exp)))
             ORDER BY b.expiry_date ASC NULLS LAST, b.received_at, b.id, l.sort_order, l.name), '[]'::jsonb)
      INTO v_batches
    FROM public.stock_balances sb
    JOIN public.stock_batches b ON b.id = sb.batch_id
    JOIN public.stock_locations l ON l.id = sb.location_id
    WHERE sb.clinic_id = v_clinic AND sb.stock_item_id = v_item.id AND sb.quantity > 0
      AND (p_location_id IS NULL OR sb.location_id = p_location_id);
  END IF;

  SELECT r.id INTO v_pending FROM public.stock_product_requests r
  WHERE r.clinic_id = v_clinic AND r.gtin = v_gtin AND r.status = 'pending';

  RETURN jsonb_build_object(
    'gtin', v_gtin,
    'match', v_match,
    'item', CASE WHEN v_match <> 'unknown'
                 THEN (SELECT r.j FROM public.stock__item_rows(v_clinic, v_today, v_actor, v_cost) r WHERE r.id = v_item.id)
            END,
    'batches', v_batches,
    'pending_request', CASE WHEN v_pending IS NOT NULL THEN public.stock__preq_json(v_clinic, v_pending) END
  ) || public.stock__flags();
END;
$$;

-- 5.8 Correction requests: managers see all, others their own. Pending first, then newest.
CREATE OR REPLACE FUNCTION public.stock_correction_list(p_status text DEFAULT 'pending', p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_actor uuid := public.current_app_user_id();
  v_manage boolean := public.stock_can_manage();
  v_operate boolean := public.stock_can_operate();
  v_status text := coalesce(p_status, 'pending');
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_status NOT IN ('pending', 'approved', 'rejected', 'all') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH f AS (
    SELECT r.id, r.status, r.created_at
    FROM public.stock_correction_requests r
    WHERE r.clinic_id = v_clinic
      AND (v_status = 'all' OR r.status = v_status)
      AND (v_manage OR r.requested_by = v_actor)
  ), p AS (
    SELECT f.id, row_number() OVER (ORDER BY (f.status = 'pending') DESC, f.created_at DESC, f.id) AS rn FROM f
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(public.stock__corr_json(v_clinic, p.id, v_actor, v_manage, v_operate) ORDER BY p.rn)
                   FROM p WHERE p.rn > v_off AND p.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.9 Product definition requests of the clinic (every staff member sees them). Pending first, then newest change.
CREATE OR REPLACE FUNCTION public.stock_product_request_list(p_status text DEFAULT 'pending', p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_status text := coalesce(p_status, 'pending');
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_status NOT IN ('pending', 'resolved', 'rejected', 'all') THEN
    PERFORM public.stock__raise('E_FILTER');
  END IF;
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH f AS (
    SELECT r.id, r.status, r.updated_at
    FROM public.stock_product_requests r
    WHERE r.clinic_id = v_clinic AND (v_status = 'all' OR r.status = v_status)
  ), p AS (
    SELECT f.id, row_number() OVER (ORDER BY (f.status = 'pending') DESC, f.updated_at DESC, f.id) AS rn FROM f
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(public.stock__preq_json(v_clinic, p.id) ORDER BY p.rn)
                   FROM p WHERE p.rn > v_off AND p.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.10 Return candidates (managers): issues with something left to return and no approved correction.
CREATE OR REPLACE FUNCTION public.stock_return_candidates(p_stock_item_id uuid DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_manage();
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH f AS (
    SELECT m.id, m.ref_no, m.stock_item_id, m.batch_id, m.from_location_id, m.patient_id, m.doctor_id, m.quantity,
           m.effective_at, m.created_at,
           coalesce((SELECT sum(r.quantity) FROM public.stock_movements r
                     WHERE r.source_movement_id = m.id AND r.movement_type = 'return'), 0) AS returned
    FROM public.stock_movements m
    WHERE m.clinic_id = v_clinic
      AND m.movement_type = 'issue'
      AND (p_stock_item_id IS NULL OR m.stock_item_id = p_stock_item_id)
      AND NOT EXISTS (SELECT 1 FROM public.stock_correction_requests cr
                      WHERE cr.movement_id = m.id AND cr.status = 'approved')
  ), g AS (
    SELECT f.*, row_number() OVER (ORDER BY f.created_at DESC, f.ref_no DESC) AS rn
    FROM f WHERE f.quantity - f.returned > 0
  )
  SELECT (SELECT count(*) FROM g),
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'movement_id', g.id, 'ref_no', g.ref_no, 'stock_item_id', g.stock_item_id,
                    'item_name', i.item_name, 'usage_unit', i.usage_unit, 'tracking_level', i.tracking_level,
                    'batch_id', g.batch_id, 'lot_number', b.lot_number, 'serial_number', b.serial_number,
                    'location_id', g.from_location_id, 'location_name', l.name, 'patient_id', g.patient_id,
                    'patient_name', pt.full_name, 'doctor_id', g.doctor_id, 'doctor_name', du.full_name,
                    'quantity', public.stock__q(g.quantity), 'returned_qty', public.stock__q(g.returned),
                    'remaining', public.stock__q(g.quantity - g.returned), 'effective_at', g.effective_at)
                    ORDER BY g.rn)
           FROM g
           JOIN public.stock_items i ON i.id = g.stock_item_id
           JOIN public.stock_batches b ON b.id = g.batch_id
           JOIN public.stock_locations l ON l.id = g.from_location_id
           LEFT JOIN public.patients pt ON pt.id = g.patient_id
           LEFT JOIN public.doctors d ON d.id = g.doctor_id
           LEFT JOIN public.users du ON du.id = d.user_id
           WHERE g.rn > v_off AND g.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.11 Count sessions (one row per operation key), newest first.
CREATE OR REPLACE FUNCTION public.stock_count_history(p_location_id uuid DEFAULT NULL, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_staff();
  v_off integer;
  v_lim integer;
  v_total bigint;
  v_rows jsonb;
BEGIN
  SELECT o.o_offset, o.o_limit INTO v_off, v_lim FROM public.stock__page(p_page, 200) o;

  WITH g AS (
    SELECT c.operation_key, min(c.location_id::text)::uuid AS location_id, min(c.created_at) AS created_at,
           min(c.actor_user_id::text)::uuid AS actor_user_id, min(c.reason) AS reason, count(*) AS lines,
           count(*) FILTER (WHERE c.delta <> 0) AS differences,
           coalesce(sum(c.delta) FILTER (WHERE c.delta > 0), 0) AS adjust_in,
           coalesce(-sum(c.delta) FILTER (WHERE c.delta < 0), 0) AS adjust_out
    FROM public.stock_counts c
    WHERE c.clinic_id = v_clinic AND (p_location_id IS NULL OR c.location_id = p_location_id)
    GROUP BY c.operation_key
  ), p AS (
    SELECT g.*, row_number() OVER (ORDER BY g.created_at DESC, g.operation_key) AS rn FROM g
  )
  SELECT (SELECT count(*) FROM g),
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'operation_key', p.operation_key, 'location_id', p.location_id, 'location_name', l.name,
                    'created_at', p.created_at, 'actor_user_id', p.actor_user_id, 'actor_name', u.full_name,
                    'reason', p.reason, 'lines', p.lines, 'differences', p.differences,
                    'adjust_in_qty', public.stock__q(p.adjust_in), 'adjust_out_qty', public.stock__q(p.adjust_out))
                    ORDER BY p.rn)
           FROM p
           LEFT JOIN public.stock_locations l ON l.id = p.location_id
           LEFT JOIN public.users u ON u.id = p.actor_user_id
           WHERE p.rn > v_off AND p.rn <= v_off + v_lim), '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows) || public.stock__flags();
END;
$$;

-- 5.12 Period report (cost viewers, RP:4-15) by clinic-local effective day. Corrected originals and reversal rows
-- are excluded, re-entries count on the original day; transfers are excluded (no value change).
CREATE OR REPLACE FUNCTION public.stock_period_report(p_from text, p_to text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.stock__require_costs();
  v_from date := public.stock__day(p_from);
  v_to date := public.stock__day(p_to);
  v_rows jsonb;
  v_totals jsonb;
BEGIN
  IF v_from > v_to OR v_to - v_from > 366 THEN
    PERFORM public.stock__raise('E_DATE_RANGE');
  END IF;

  WITH mv AS (
    SELECT m.stock_item_id, m.movement_type, m.quantity, bc.unit_cost_cents
    FROM public.stock_movements m
    LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id
    WHERE m.clinic_id = v_clinic
      AND m.effective_at >= (v_from::timestamp AT TIME ZONE 'Europe/Istanbul')
      AND m.effective_at < ((v_to + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')
      AND m.movement_type NOT IN ('transfer', 'correction_reversal')
      AND NOT EXISTS (SELECT 1 FROM public.stock_correction_requests cr
                      WHERE cr.movement_id = m.id AND cr.status = 'approved')
  ), a AS (
    SELECT mv.stock_item_id,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'receive'), 0) AS received,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'opening'), 0) AS opening,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'issue'), 0) AS used,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'return'), 0) AS returned,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'waste'), 0) AS waste,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'adjust_in'), 0) AS adj_in,
           coalesce(sum(mv.quantity) FILTER (WHERE mv.movement_type = 'adjust_out'), 0) AS adj_out,
           round(coalesce(sum(mv.quantity * mv.unit_cost_cents) FILTER (WHERE mv.movement_type = 'issue'), 0)
                 - coalesce(sum(mv.quantity * mv.unit_cost_cents) FILTER (WHERE mv.movement_type = 'return'), 0))::bigint
             AS net_used_cost,
           round(coalesce(sum(mv.quantity * mv.unit_cost_cents) FILTER (WHERE mv.movement_type = 'waste'), 0))::bigint
             AS waste_cost,
           round(coalesce(sum(mv.quantity * mv.unit_cost_cents) FILTER (WHERE mv.movement_type = 'adjust_in'), 0)
                 - coalesce(sum(mv.quantity * mv.unit_cost_cents) FILTER (WHERE mv.movement_type = 'adjust_out'), 0))::bigint
             AS adjust_cost,
           count(*) FILTER (WHERE mv.unit_cost_cents IS NULL
                              AND mv.movement_type IN ('issue', 'return', 'waste', 'adjust_in', 'adjust_out')) AS uncosted
    FROM mv
    GROUP BY mv.stock_item_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'stock_item_id', a.stock_item_id, 'item_code', i.item_code, 'item_name', i.item_name,
           'category', i.category, 'usage_unit', i.usage_unit, 'tracking_level', i.tracking_level,
           'received_qty', public.stock__q(a.received), 'opening_qty', public.stock__q(a.opening),
           'used_qty', public.stock__q(a.used), 'returned_qty', public.stock__q(a.returned),
           'waste_qty', public.stock__q(a.waste), 'adjust_in_qty', public.stock__q(a.adj_in),
           'adjust_out_qty', public.stock__q(a.adj_out), 'net_used_cost_cents', a.net_used_cost,
           'waste_cost_cents', a.waste_cost, 'adjust_net_cost_cents', a.adjust_cost, 'uncosted_rows', a.uncosted)
           ORDER BY i.item_name COLLATE "tr-x-icu", i.id), '[]'::jsonb),
         jsonb_build_object(
           'net_used_cost_cents', coalesce(sum(a.net_used_cost), 0),
           'waste_cost_cents', coalesce(sum(a.waste_cost), 0),
           'adjust_net_cost_cents', coalesce(sum(a.adjust_cost), 0),
           'uncosted_rows', coalesce(sum(a.uncosted), 0),
           'items', count(*))
    INTO v_rows, v_totals
  FROM a
  JOIN public.stock_items i ON i.id = a.stock_item_id;

  RETURN jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows, 'totals', v_totals) || public.stock__flags();
END;
$$;

-- ---------------------------------------------------------------------------
-- 8.0 Stock grants stay with the owner (§0.3). 0019's grant / revoke let an owner OR admin hand out any permission
--     except the finance ones, so an admin could give themselves 'stock_cost_view' (every cost, the dashboard value,
--     the period report, cost audit rows) or 'stock_manage' (catalog, counts, corrections, returns). Same signatures
--     and bodies as 0019 (CREATE OR REPLACE keeps the 0019 ACL) plus two rules:
--       'stock_manage'    -> granted / revoked by the owner only;
--       'stock_cost_view' -> by the owner or a 'finance' holder (who already sees every cost).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_staff_permission(p_user_id uuid, p_permission text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_caller FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF v_caller.id IS NULL OR v_caller.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Yetki vermek için klinik sahibi veya yönetici olmanız gerekir.';
  END IF;

  IF p_permission IS NULL OR p_permission NOT IN (
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical'
  ) THEN
    RAISE EXCEPTION 'Geçersiz yetki türü: %', coalesce(p_permission, '(boş)');
  END IF;

  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF v_target.id IS NULL OR v_target.clinic_id <> v_caller.clinic_id THEN
    RAISE EXCEPTION 'Personel bulunamadı.';
  END IF;
  IF v_target.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pasif personelin yetkileri değiştirilemez.';
  END IF;

  IF p_permission IN ('finance', 'finance_readonly') AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Finans yetkilerini yalnızca finans yetkisi olan kullanıcılar verebilir.';
  END IF;
  IF p_permission = 'stock_manage' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Stok yönetim yetkisini yalnızca klinik sahibi verebilir.' USING ERRCODE = '42501';
  END IF;
  IF p_permission = 'stock_cost_view' AND v_caller.role <> 'owner' AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Stok maliyet yetkisini yalnızca klinik sahibi veya finans yetkisi olan kullanıcılar verebilir.'
      USING ERRCODE = '42501';
  END IF;

  -- Already granted is not an error.
  INSERT INTO public.staff_permissions (clinic_id, user_id, permission, granted_by)
  VALUES (v_target.clinic_id, v_target.id, p_permission, v_caller.id)
  ON CONFLICT (user_id, permission) WHERE revoked_at IS NULL DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_staff_permission(p_user_id uuid, p_permission text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_caller FROM public.users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF v_caller.id IS NULL OR v_caller.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Yetki kaldırmak için klinik sahibi veya yönetici olmanız gerekir.';
  END IF;

  IF p_permission IS NULL OR p_permission NOT IN (
    'finance', 'finance_readonly', 'stock_manage', 'stock_cost_view', 'crm_manage', 'clinical'
  ) THEN
    RAISE EXCEPTION 'Geçersiz yetki türü: %', coalesce(p_permission, '(boş)');
  END IF;

  -- Inactive targets are allowed here (unlike grant) so a departed person's grants can still be cleaned up.
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF v_target.id IS NULL OR v_target.clinic_id <> v_caller.clinic_id THEN
    RAISE EXCEPTION 'Personel bulunamadı.';
  END IF;

  IF p_permission IN ('finance', 'finance_readonly') AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Finans yetkilerini yalnızca finans yetkisi olan kullanıcılar kaldırabilir.';
  END IF;
  IF p_permission = 'stock_manage' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Stok yönetim yetkisini yalnızca klinik sahibi kaldırabilir.' USING ERRCODE = '42501';
  END IF;
  IF p_permission = 'stock_cost_view' AND v_caller.role <> 'owner' AND NOT public.has_permission('finance') THEN
    RAISE EXCEPTION 'Stok maliyet yetkisini yalnızca klinik sahibi veya finans yetkisi olan kullanıcılar kaldırabilir.'
      USING ERRCODE = '42501';
  END IF;

  -- An admin must not be able to strip the owner, who could then not win finance back.
  IF v_target.role = 'owner' AND v_caller.role <> 'owner' THEN
    RAISE EXCEPTION 'Klinik sahibinin yetkilerini yalnızca klinik sahibi kaldırabilir.';
  END IF;

  IF p_permission = 'finance' THEN
    -- Serialise finance revokes and finance-holder deactivations (users_guard) per clinic, so two concurrent
    -- changes cannot both pass the last-holder check.
    PERFORM pg_advisory_xact_lock(hashtextextended('staff_permissions.finance:' || v_target.clinic_id::text, 0));

    -- Only an active holder counts; revoking an inactive one's leftover grant never lowers the active count.
    IF v_target.is_active = true AND EXISTS (
      SELECT 1 FROM public.staff_permissions
      WHERE user_id = v_target.id AND permission = 'finance' AND revoked_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.staff_permissions sp
      JOIN public.users u ON u.id = sp.user_id
      WHERE sp.clinic_id = v_target.clinic_id
        AND sp.permission = 'finance'
        AND sp.revoked_at IS NULL
        AND sp.user_id <> v_target.id
        AND u.is_active = true
    ) THEN
      RAISE EXCEPTION 'Klinikteki son finans yetkilisinin finans yetkisi kaldırılamaz.';
    END IF;
  END IF;

  -- Nothing active to revoke is not an error.
  UPDATE public.staff_permissions
  SET revoked_at = now(), revoked_by = v_caller.id
  WHERE user_id = v_target.id
    AND permission = p_permission
    AND revoked_at IS NULL;
END;
$$;

-- Same ACL as 0019 (idempotent; CREATE OR REPLACE already kept it).
REVOKE EXECUTE ON FUNCTION public.grant_staff_permission(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_staff_permission(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_staff_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_permission(uuid, text) TO authenticated;

-- Grants made before this rule existed are kept but listed, so the owner can review them (runbook step 5).
DO $$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(format('%s: %s (%s)', sp.permission, u.full_name, u.role), ', ' ORDER BY sp.permission, u.full_name)
    INTO v_list
  FROM public.staff_permissions sp
  JOIN public.users u ON u.id = sp.user_id
  WHERE sp.permission IN ('stock_manage', 'stock_cost_view') AND sp.revoked_at IS NULL AND u.role <> 'owner';
  IF v_list IS NOT NULL THEN
    RAISE NOTICE 'Mevcut stok yetkileri (sahip dışı; kontrol edin): %', left(v_list, 2000);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8.1 Test clean-up (editor only). Removes every stock row of one acceptance-harness clinic (slug 'p<n>-test-...')
--     in foreign-key order, with the circular count / correction links deferred, so the clinic itself can then be
--     deleted. Never granted to API roles; the service role (acceptance clean-up scripts) and the SQL editor only.
--     Real clinics are refused by slug, so a production clinic's history can never be purged through it.
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
-- 8.2 Function privileges and self-checks (0020 / 0021 pattern). PostgreSQL grants EXECUTE to PUBLIC on every new
--     function (and Supabase's default privileges add anon and authenticated); CREATE OR REPLACE keeps the ACL, a
--     new overload or DROP + CREATE does not. Every stock_* / stock__* function loses EXECUTE from PUBLIC, anon and
--     authenticated; public RPCs (single underscore) are then granted to authenticated; internals never are.
--     Runs as the migration owner; never granted.
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

  -- Tables: SELECT only for authenticated, nothing for anon (no column privileges either); stock_operations none.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['stock_locations', 'suppliers', 'stock_items', 'stock_item_costs', 'stock_batches',
                    'stock_batch_costs', 'stock_balances', 'stock_movements', 'stock_counts',
                    'stock_correction_requests', 'stock_product_requests', 'user_favorite_items',
                    'stock_transactions']) AS t(tbl)
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
END;
$$;

SELECT public.stock__harden_privileges();

-- ---------------------------------------------------------------------------
-- 8.3 Migration-specific self-checks. Any failure RAISEs and rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_n bigint;
BEGIN
  -- 1. RLS on, exactly one SELECT policy and no write policy on every client-readable stock table; none on
  --    stock_operations; stock_items / stock_transactions keep no write policy; the audit cost gate is RESTRICTIVE.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['stock_locations', 'suppliers', 'stock_item_costs', 'stock_batches', 'stock_batch_costs',
                    'stock_balances', 'stock_movements', 'stock_counts', 'stock_correction_requests',
                    'stock_product_requests', 'user_favorite_items']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd <> 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: RLS / politika yapısı beklenen gibi değil: %', v_bad;
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.stock_operations'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'stock_operations') THEN
    RAISE EXCEPTION 'Öz denetim: stock_operations RLS açık ve politikasız olmalı.';
  END IF;
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['stock_items', 'stock_transactions']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd = 'SELECT'
                      AND p.permissive = 'PERMISSIVE' AND p.roles = ARRAY['authenticated']::name[]
                      AND p.qual ILIKE '%current_clinic_id%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: stock_items / stock_transactions tek bir klinik SELECT politikasına sahip olmalı: %', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs'
                   AND p.policyname = 'audit_logs_stock_cost_guard' AND p.permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'Öz denetim: audit_logs_stock_cost_guard yok veya kısıtlayıcı değil.';
  END IF;

  -- 2. Ledger invariant: every balance equals sum(in) - sum(out) of its movements, and no movement sum lacks a row.
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

  -- 3. Exactly one active default warehouse per clinic.
  SELECT string_agg(c.id::text, ', ') INTO v_bad
  FROM public.clinics c
  WHERE (SELECT count(*) FROM public.stock_locations l
         WHERE l.clinic_id = c.id AND l.is_default_warehouse AND l.is_active AND l.kind = 'warehouse') <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: ana deposu olmayan veya birden fazla olan klinikler: %', v_bad;
  END IF;

  -- 4. Opening totals: every card migrated in this run has exactly one opening of its old quantity in the default
  --    warehouse, and the clinic sums match.
  SELECT string_agg(s.item_code, ', ') INTO v_bad
  FROM stock__m24_snapshot s
  WHERE s.to_migrate AND s.quantity_on_hand > 0
    AND (SELECT count(*) FROM public.stock_movements m
         JOIN public.stock_locations l ON l.id = m.to_location_id AND l.is_default_warehouse
         WHERE m.stock_item_id = s.id AND m.movement_type = 'opening' AND m.quantity = s.quantity_on_hand
           AND m.operation_key = md5('stock-opening:' || s.id::text)::uuid) <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: açılış hareketi eksik veya hatalı kartlar: %', v_bad;
  END IF;
  SELECT string_agg(x.clinic_id::text, ', ') INTO v_bad
  FROM (
    SELECT s.clinic_id, sum(s.quantity_on_hand) AS q
    FROM stock__m24_snapshot s WHERE s.to_migrate AND s.quantity_on_hand > 0
    GROUP BY s.clinic_id
  ) x
  WHERE x.q IS DISTINCT FROM (
    SELECT sum(m.quantity) FROM public.stock_movements m
    JOIN stock__m24_snapshot s2 ON s2.id = m.stock_item_id AND s2.to_migrate
    WHERE m.clinic_id = x.clinic_id AND m.movement_type = 'opening');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: açılış toplamları eski miktarlarla uyuşmuyor: %', v_bad;
  END IF;

  -- 5. Prices preserved exactly in stock_item_costs and gone from stock_items.
  SELECT string_agg(s.item_code, ', ') INTO v_bad
  FROM stock__m24_snapshot s
  LEFT JOIN public.stock_item_costs c ON c.stock_item_id = s.id
  WHERE s.unit_price <> 0 AND c.legacy_unit_price IS DISTINCT FROM s.unit_price;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: eski fiyatı aktarılmamış kartlar: %', v_bad;
  END IF;
  SELECT count(*) INTO v_n FROM public.stock_items WHERE unit_price <> 0;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Öz denetim: % kartta unit_price hâlâ sıfır değil.', v_n;
  END IF;

  -- 6. Mirrors.
  SELECT string_agg(i.item_code, ', ') INTO v_bad
  FROM public.clinics c
  CROSS JOIN LATERAL public.stock__levels(c.id, public.clinic_today()) l
  JOIN public.stock_items i ON i.id = l.stock_item_id
  WHERE i.quantity_on_hand IS DISTINCT FROM least(floor(l.usable_qty), 2147483647)::integer
     OR i.quantity_minimum IS DISTINCT FROM least(ceil(i.min_qty), 2147483647)::integer;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: eski alan yansımaları hatalı: %', v_bad;
  END IF;

  -- Pure validators (§1.5).
  IF public.stock__gtin('8806383546393') <> '08806383546393' OR public.stock__gtin(' ') IS NOT NULL
     OR public.stock__lot(' genel ', 'C') <> 'GENEL' OR public.stock__expiry('2026-02-28') <> DATE '2026-02-28'
     OR public.stock__to_usage(2, 'purchase', 50) <> 100 THEN
    RAISE EXCEPTION 'Öz denetim: stok doğrulayıcıları beklenen değerleri vermiyor.';
  END IF;
END $$;

-- 7 / 8. FEFO and correction replay through the internal cores with a fixed day, inside a block that is always
--        rolled back. Uses the first clinic; skipped when there is none (the correction part also needs a user).
DO $$
DECLARE
  v_today date := DATE '2026-10-15';
  v_clinic uuid;
  v_user uuid;
  v_loc uuid;
  v_c uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_item public.stock_items%ROWTYPE;
  v_op uuid;
  v_l1 uuid;
  v_batch uuid;
  v_k1 uuid;
  v_recv uuid;
  v_req uuid;
  v_eff timestamptz;
  v_mid uuid;
  v_txt text;
  v_hint text;
  v_detail text;
  v_q numeric;
  v_fail text[] := '{}'::text[];
BEGIN
  SELECT c.id INTO v_clinic FROM public.clinics c ORDER BY c.created_at, c.id LIMIT 1;
  IF v_clinic IS NULL THEN
    RETURN;
  END IF;
  SELECT u.id INTO v_user FROM public.users u WHERE u.clinic_id = v_clinic ORDER BY u.created_at, u.id LIMIT 1;

  BEGIN
    v_loc := public.stock__default_location(v_clinic);
    INSERT INTO public.stock_items (id, clinic_id, item_code, item_name, category, unit_price, quantity_minimum,
                                    tracking_level)
    VALUES (v_c, v_clinic, 'ZZ-OZD-C-' || left(replace(v_c::text, '-', ''), 12), 'Öz denetim C', 'materials', 0, 0, 'C'),
           (v_b, v_clinic, 'ZZ-OZD-B-' || left(replace(v_b::text, '-', ''), 12), 'Öz denetim B', 'materials', 0, 0, 'B'),
           (v_a, v_clinic, 'ZZ-OZD-A-' || left(replace(v_a::text, '-', ''), 12), 'Öz denetim A', 'materials', 0, 0, 'A');

    -- Receipts: L1 5 (2026-12-31, cost 100), L2 5 (2026-11-30), L3 5 (no expiry), L0 2 already expired (direct).
    PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_c, v_loc, 5, 'usage',
      NULL, 'L1', NULL, '2026-12-31', 100, 'usage', NULL, NULL, NULL);
    PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_c, v_loc, 5, 'usage',
      NULL, 'L2', NULL, '2026-11-30', 100, 'usage', NULL, NULL, NULL);
    PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_c, v_loc, 5, 'usage',
      NULL, 'L3', NULL, NULL, 100, 'usage', NULL, NULL, NULL);
    INSERT INTO public.stock_batches (clinic_id, stock_item_id, lot_number, expiry_date)
    VALUES (v_clinic, v_c, 'L0', DATE '2026-10-01') RETURNING id INTO v_batch;
    PERFORM public.stock__apply(v_clinic, v_c, v_batch, v_loc, 2);
    PERFORM public.stock__ledger(v_clinic, gen_random_uuid(), NULL, v_c, v_batch, 'receive', 2, NULL, v_loc, '{}'::jsonb);
    SELECT b.id INTO v_l1 FROM public.stock_batches b WHERE b.stock_item_id = v_c AND b.lot_number = 'L1';

    -- Issue 7 -> L2 x 5 then L1 x 2 (FEFO; expired L0 skipped).
    SELECT * INTO v_item FROM public.stock_items WHERE id = v_c;
    v_op := gen_random_uuid();
    PERFORM public.stock__allocate_out(v_clinic, v_op, v_item, 'issue', 7, v_loc, NULL, NULL, '{}'::jsonb, v_today);
    SELECT string_agg(b.lot_number || ':' || trim_scale(m.quantity)::text, ',' ORDER BY m.line_no) INTO v_txt
    FROM public.stock_movements m JOIN public.stock_batches b ON b.id = m.batch_id WHERE m.operation_key = v_op;
    IF v_txt IS DISTINCT FROM 'L2:5,L1:2' THEN
      v_fail := array_append(v_fail, 'FEFO çıkış: ' || coalesce(v_txt, '-'));
    END IF;

    -- Issue 9 -> E_INSUFFICIENT with 8 available (L1 3 + L3 5).
    BEGIN
      PERFORM public.stock__allocate_out(v_clinic, gen_random_uuid(), v_item, 'issue', 9, v_loc, NULL, NULL,
                                         '{}'::jsonb, v_today);
      v_fail := array_append(v_fail, 'Yetersiz stok hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'E_INSUFFICIENT' OR v_detail IS DISTINCT FROM '8' THEN
        v_fail := array_append(v_fail, 'Yetersiz stok: ' || coalesce(v_hint, '') || ' / ' || coalesce(v_detail, ''));
      END IF;
    END;

    -- Waste 2 -> the expired L0 first.
    v_op := gen_random_uuid();
    PERFORM public.stock__allocate_out(v_clinic, v_op, v_item, 'waste', 2, v_loc, NULL, NULL, '{}'::jsonb, v_today);
    SELECT string_agg(b.lot_number || ':' || trim_scale(m.quantity)::text, ',' ORDER BY m.line_no) INTO v_txt
    FROM public.stock_movements m JOIN public.stock_batches b ON b.id = m.batch_id WHERE m.operation_key = v_op;
    IF v_txt IS DISTINCT FROM 'L0:2' THEN
      v_fail := array_append(v_fail, 'Fire: ' || coalesce(v_txt, '-'));
    END IF;

    -- Merge rule (C23): same lot + expiry + cost -> same batch; another cost -> a new batch.
    v_mid := public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_c, v_loc, 5, 'usage',
      NULL, 'L1', NULL, '2026-12-31', 100, 'usage', NULL, NULL, NULL);
    IF (SELECT m.batch_id FROM public.stock_movements m WHERE m.id = v_mid) IS DISTINCT FROM v_l1 THEN
      v_fail := array_append(v_fail, 'Lot birleştirme: aynı maliyet yeni partiye gitti');
    END IF;
    v_mid := public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_c, v_loc, 5, 'usage',
      NULL, 'L1', NULL, '2026-12-31', 200, 'usage', NULL, NULL, NULL);
    IF (SELECT m.batch_id FROM public.stock_movements m WHERE m.id = v_mid) IS NOT DISTINCT FROM v_l1 THEN
      v_fail := array_append(v_fail, 'Lot birleştirme: farklı maliyet aynı partiye girdi');
    END IF;

    -- Tracking rules: B without expiry, A with 'genel', serial with quantity 2.
    BEGIN
      PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_b, v_loc, 1, 'usage',
        NULL, 'X1', NULL, NULL, NULL, 'usage', NULL, NULL, NULL);
      v_fail := array_append(v_fail, 'B SKT hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_EXPIRY_REQUIRED' THEN
        v_fail := array_append(v_fail, 'B SKT: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;
    BEGIN
      PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_a, v_loc, 1, 'usage',
        NULL, 'genel', NULL, NULL, NULL, 'usage', NULL, NULL, NULL);
      v_fail := array_append(v_fail, 'A lot hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_LOT_REQUIRED' THEN
        v_fail := array_append(v_fail, 'A lot: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;
    BEGIN
      PERFORM public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_a, v_loc, 2, 'usage',
        NULL, 'X1', 'S1', NULL, NULL, 'usage', NULL, NULL, NULL);
      v_fail := array_append(v_fail, 'Seri adet hatası bekleniyordu');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'E_SERIAL_QTY' THEN
        v_fail := array_append(v_fail, 'Seri adet: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
      END IF;
    END;

    -- Correction replay: receive 10 (K1), issue 4; correcting the receipt to 3 would go negative; to 6 -> balance 2,
    -- reversal 10 + re-entry 6 on the original effective_at.
    IF v_user IS NOT NULL THEN
      v_recv := public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_c, v_loc, 10, 'usage',
        NULL, 'K1', NULL, NULL, NULL, 'usage', NULL, NULL, NULL);
      SELECT m.batch_id, m.effective_at INTO v_k1, v_eff FROM public.stock_movements m WHERE m.id = v_recv;
      PERFORM public.stock__allocate_out(v_clinic, gen_random_uuid(), v_item, 'issue', 4, v_loc, NULL, v_k1,
                                         '{}'::jsonb, v_today);
      v_req := gen_random_uuid();
      INSERT INTO public.stock_correction_requests (id, clinic_id, movement_id, reason, requested_by)
      VALUES (v_req, v_clinic, v_recv, 'Öz denetim düzeltmesi', v_user);

      BEGIN
        PERFORM public.stock__resolve_core(v_clinic, v_user, gen_random_uuid(), v_req, 'approve', 3, 'Öz denetim');
        v_fail := array_append(v_fail, 'Eksi düzeltme hatası bekleniyordu');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'E_CORR_NEGATIVE' THEN
          v_fail := array_append(v_fail, 'Eksi düzeltme: ' || coalesce(v_hint, '') || ' ' || SQLERRM);
        END IF;
      END;

      v_op := gen_random_uuid();
      PERFORM public.stock__resolve_core(v_clinic, v_user, v_op, v_req, 'approve', 6, 'Öz denetim');
      SELECT sb.quantity INTO v_q FROM public.stock_balances sb WHERE sb.batch_id = v_k1 AND sb.location_id = v_loc;
      IF v_q IS DISTINCT FROM 2 THEN
        v_fail := array_append(v_fail, 'Düzeltme bakiyesi: ' || coalesce(v_q::text, '-'));
      END IF;
      SELECT string_agg(m.movement_type || ':' || trim_scale(m.quantity)::text
                        || CASE WHEN m.movement_type <> 'correction_reversal' AND m.effective_at = v_eff
                                THEN ':orijinal' ELSE '' END, ',' ORDER BY m.line_no)
        INTO v_txt
      FROM public.stock_movements m WHERE m.operation_key = v_op;
      IF v_txt IS DISTINCT FROM 'correction_reversal:10,receive:6:orijinal' THEN
        v_fail := array_append(v_fail, 'Düzeltme defteri: ' || coalesce(v_txt, '-'));
      END IF;
      IF (SELECT r.status FROM public.stock_correction_requests r WHERE r.id = v_req) <> 'approved' THEN
        v_fail := array_append(v_fail, 'Düzeltme talebi onaylanmadı');
      END IF;
    END IF;

    -- The replay keeps the ledger invariant for the test card.
    IF EXISTS (
      SELECT 1
      FROM public.stock_balances b
      FULL JOIN (
        SELECT y.batch_id, y.loc, sum(y.q) AS q
        FROM (
          SELECT m.batch_id, m.to_location_id AS loc, m.quantity AS q
          FROM public.stock_movements m WHERE m.stock_item_id = v_c AND m.to_location_id IS NOT NULL
          UNION ALL
          SELECT m.batch_id, m.from_location_id, -m.quantity
          FROM public.stock_movements m WHERE m.stock_item_id = v_c AND m.from_location_id IS NOT NULL
        ) y
        GROUP BY y.batch_id, y.loc
      ) x ON x.batch_id = b.batch_id AND x.loc = b.location_id
      WHERE (b.stock_item_id = v_c OR b.id IS NULL) AND coalesce(b.quantity, 0) <> coalesce(x.q, 0)
    ) THEN
      v_fail := array_append(v_fail, 'Öz denetim kartında defter ve bakiye uyuşmuyor');
    END IF;

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (FEFO / düzeltme): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'stock_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;
END $$;

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
