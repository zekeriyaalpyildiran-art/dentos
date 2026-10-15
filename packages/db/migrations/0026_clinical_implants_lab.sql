-- Phase 9: Clinical (implants with automatic A-level stock-out, consumption per patient, lab enhancements).
-- Safe to re-run.
--
-- Contract: spec_parts/p9_clinical.md (schema, RPCs, JSON shapes, error keys, acceptance). Requires 0019
-- (permissions incl. 'clinical'), 0020 (finance ledger) and 0024 (stock core). Migration 0025 belongs to another
-- workflow and is independent of this file.
--
--  1. lab_order_status gets two values: 'try_in' (Provada) and 'revision' (Revizyonda), see "Enum values" below.
--  2. New tables: implant_brands, labs (directories, deactivated never deleted), patient_implants (FK to the
--     patient, never a free-text name; FDI permanent teeth; stock or external source; soft delete; version),
--     lab_order_events (status history), lab_order_costs (cost-gated), clinical_settings (lab cost payable switch,
--     OFF by default).
--  3. lab_orders: lab_id (mirrored into lab_name), sent_on / received_on / last_try_in_on, revision_count, cancel
--     fields, version, legacy_id; order numbers from lab_order_number_seq; patient / doctor FKs become NO ACTION.
--     Direct client writes on lab_orders / lab_order_items are revoked: the lab pages use the clin_* RPCs.
--  4. Stock links (0024 tables, no 0024 function is replaced): deferred FK stock_movements.implant_record_id ->
--     patient_implants; trigger clin_movement_link fills it for the one issue written by clin_implant_record and
--     refuses a usage return of an active implant's movement; trigger clin_correction_link refuses a stock
--     correction request on it (void the implant first).
--  5. Writes only through SECURITY DEFINER clin_* RPCs. clin_implant_record writes the implant AND its A-level
--     stock issue (1 usage unit, patient + doctor + optional appointment) in one transaction through 0024's
--     stock__outbound, idempotent on the stock operation key (owner decision D1).
--  6. Lab cost (D2 / D3): visible only to owner / finance / finance_readonly / stock_cost_view; it creates a
--     finance payable only when a 'finance' holder has switched clinical_settings.lab_cost_payable_enabled on, and
--     only a 'finance' holder posts it. The finance entry description never contains a patient name.
--  7. Reads: implant list (with "kontrol tarihi gelen"), implant detail, stock picker options, patient materials
--     (Sarf), appointment materials, lab order list (late filter) / detail, settings.
--  8. Audit (0019 audit_row_change) on every clinical table; cost audit rows hidden by a RESTRICTIVE policy.
--  9. clin__harden_privileges(): EXECUTE revoked from PUBLIC / anon / authenticated on every clin_* function,
--     public RPCs granted to authenticated, internals (clin__*) never. Every later migration that touches clin_*
--     functions must end with SELECT public.clin__harden_privileges();
-- 10. clin__purge_test_clinic(uuid) (editor / service role only, slugs 'p<n>-test-...') removes a test clinic's
--     clinical rows and then calls stock__purge_test_clinic.
-- 11. Self-checks (RAISE rolls everything back), including a rolled-back replay in a temporary clinic.
--
-- Enum values (deliberate deviation from the spec's two-file split, see p9_clinical.md §2):
--   ALTER TYPE ... ADD VALUE runs inside this transaction (PostgreSQL >= 12). A new value cannot be USED in the
--   transaction that adds it (SQLSTATE 55P04), so nothing executed by this file uses 'try_in' / 'revision' as an
--   enum value: every comparison with them is written on status::text, SQL-language functions never contain them
--   as enum literals (their bodies are analysed at CREATE time), the "late" partial index is written with the old
--   values only (status NOT IN ('draft', 'ready', 'delivered', 'cancelled')), and the self-check reads pg_enum
--   labels as text. PL/pgSQL bodies that assign the new values are only parsed at CREATE time and run after COMMIT.
--   Result: ONE paste, ONE run, atomic (a failure anywhere also rolls back the two enum values). If the run fails
--   with 55P04 anyway, nothing was applied: report it, do not split the file by hand.
--
-- Error contract (as 0020 / 0021 / 0024): RAISE USING MESSAGE = <Turkish text>, ERRCODE = 42501 (403), PT404 (404),
-- PT409 (409) or P0001 (400), HINT = key (CL_*), DETAIL = machine value where noted. Errors raised by the 0024
-- internals that clin_implant_record calls (E_INSUFFICIENT, E_BATCH, E_PATIENT, E_DOCTOR, E_APPOINTMENT, E_OPERATE,
-- E_OP_KEY, E_ITEM_NOT_FOUND, E_LOCATION, ...) pass through with their stock keys and texts.
--
-- Deliberate additions to the contract (all backwards compatible):
--   * clin__tr_lower (name keys, search) also folds dotless 'ı' into 'i', so 'Kurgu Implant' and 'KURGU İMPLANT'
--     share one key (acceptance B-2 expects the conflict; a plain stock__tr_lower copy keys them apart).
--   * clin_save_lab lets a 'finance' holder without the clinical write right change the finance link of an existing
--     lab and nothing else (matrix §1.2 "link a lab to finance", acceptance B-7).
--   * The lab whose name changes re-mirrors its name into lab_orders.lab_name (trigger clin_lab_rename), so the
--     mirror self-check also holds on a later re-run.
--   * clin_lab_order_save / clin_save_lab accept an unchanged inactive lab / brand on edit (same rule as brands).
--   * A posted lab cost whose finance entry was cancelled in the finance screen counts as not posted again (the
--     dead link is cleared), so it can be re-posted with a new source key.
--   * Old 'ready' orders: the old arrival date moves to received_on and delivery_date is cleared (it now means
--     "Hastaya teslim"); only delivered orders carry delivery_date, and status changes keep it that way.
--   * Lab order JSON also carries status_label and lab_phone.
--   * Read RPC flags carry one extra key, can_view_material_costs (= 0024 stock_can_view_costs()).
--   * The appointment JSON of clin_appointment_materials also carries chair / procedure names and notes.
--   * Review fixes: a stock implant's brand must equal the active directory brand named by the issued card's brand
--     text (CL_BRAND_STOCK_MISMATCH, record and update); lab order edits compare unchanged items without validation
--     (clin__lab_items_norm) so old orders stay editable; a create retry with other values raises
--     CL_ALREADY_SAVED_CHANGED (DETAIL = order id) instead of a false "already saved"; a draft cost is never posted
--     (CL_LAB_COST_DRAFT) and set_cost auto-posts only sent, non-cancelled jobs when the finance 'lab' category
--     exists (else the cost is kept 'awaiting_finance'); the lab_orders patient / doctor FKs are found by column.
--
-- RUNBOOK (production is the only database):
--   0. Before applying: 0019, 0020 and 0024 are live. No production deploy that contains the Phase 9 web files may go
--      live before step 1 (every new screen calls clin_* RPCs and shows "Klinik modülü güncelleniyor" otherwise).
--      Apply outside clinic hours (or when nobody is entering payments, stock or appointments): until COMMIT the
--      run holds strong locks on lab_orders, stock_movements, stock_correction_requests and (for the last seconds)
--      audit_logs, so every audited write in the clinic waits.
--   1. Apply this file ALONE in the SQL editor ("New query", paste, Run). One transaction; any self-check failure
--      rolls everything back, including the enum values. Expected: success plus NOTICEs. There is no pre-step and
--      no second file (no 0026a / 0027): the enum values are added inside this transaction.
--      Verify in a new query: SELECT unnest(enum_range(NULL::public.lab_order_status)); -> 8 rows in this order:
--      draft, submitted, in_progress, try_in, revision, ready, delivered, cancelled.
--   2. Immediately deploy the Phase 9 web build. Between 1 and 2 the old /lab, /lab/new and /lab/[id] pages can read
--      but fail on save (direct writes on lab_orders / lab_order_items are revoked); nothing else changes.
--   3. Ask everyone to reload open tabs.
--   4. Smoke test as the owner (reads only, spec §10.1).
--   5. Read the NOTICEs of step 1: labs created from old lab_name texts (fix typos / duplicates in Laboratuvarlar),
--      lab orders whose sent_on / received_on were back-filled (approximations), orders without a lab, and existing
--      non-owner 'clinical' grants. Settings > export (Phase 9 web build) includes the six new tables.
--   Re-running this file is safe (idempotent DDL; data steps only touch rows that are still empty).

BEGIN;

-- ---------------------------------------------------------------------------
-- 3.0 Preflight: Phase 0 / finance / stock must be live with the functions and columns used here, PostgreSQL must
--     allow ADD VALUE in a transaction block, the Turkish ICU collation must exist, and anything left by an earlier
--     run must already have the shape created below.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  IF current_setting('server_version_num')::integer < 120000 THEN
    RAISE EXCEPTION 'PostgreSQL 12 veya üstü gerekli (ALTER TYPE ... ADD VALUE işlem içinde).';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.staff_permissions'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%''clinical''%'
  ) THEN
    RAISE EXCEPTION 'staff_permissions ''clinical'' yetkisini kabul etmiyor; önce 0019 uygulanmalı.';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() / auth.jwt() bulunamadı (Supabase auth şeması gerekli).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'tr-x-icu') THEN
    RAISE EXCEPTION 'tr-x-icu harmanlaması bulunamadı.';
  END IF;

  IF to_regtype('public.lab_order_status') IS NULL THEN
    RAISE EXCEPTION 'lab_order_status türü bulunamadı (0009).';
  END IF;

  -- 0024 / 0020 internals used here (exact signatures).
  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY[
    'public.stock_can_operate()',
    'public.stock_can_manage()',
    'public.stock_can_view_costs()',
    'public.stock__raise(text,text,text)',
    'public.stock__is_editor()',
    'public.stock__op_begin(uuid,uuid,uuid,text,jsonb)',
    'public.stock__op_finish(uuid,uuid,jsonb)',
    'public.stock__outbound(uuid,uuid,uuid,date,text,uuid,uuid,uuid,numeric,text,numeric,uuid,uuid,uuid,uuid,text)',
    'public.stock__check_patient_refs(uuid,uuid,uuid,uuid)',
    'public.stock__history_rows(uuid,uuid,boolean,boolean)',
    'public.stock__corr_json(uuid,uuid,uuid,boolean,boolean)',
    'public.stock__purge_test_clinic(uuid)',
    'public.stock__default_location(uuid)',
    'public.stock__q(numeric)'
  ]) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Stok çekirdeği eksik veya imzası farklı, önce 0024 uygulanmalı: %', v_missing;
  END IF;
  -- Used only by the rolled-back self-check, with its 18 leading arguments (0025 adds a trailing DEFAULT argument,
  -- so the name is checked, not the exact signature).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'stock__receive_line' AND p.pronargs >= 18) THEN
    RAISE EXCEPTION 'stock__receive_line bulunamadı; önce 0024 uygulanmalı.';
  END IF;

  -- Existing columns used here, with their live types (udt_name).
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('lab_orders', 'id', 'uuid'), ('lab_orders', 'clinic_id', 'uuid'), ('lab_orders', 'patient_id', 'uuid'),
    ('lab_orders', 'doctor_id', 'uuid'), ('lab_orders', 'treatment_plan_id', 'uuid'),
    ('lab_orders', 'order_number', 'text'), ('lab_orders', 'status', 'lab_order_status'),
    ('lab_orders', 'due_date', 'date'), ('lab_orders', 'delivery_date', 'date'), ('lab_orders', 'notes', 'text'),
    ('lab_orders', 'lab_name', 'text'), ('lab_orders', 'created_at', 'timestamptz'),
    ('lab_orders', 'updated_at', 'timestamptz'),
    ('lab_order_items', 'id', 'uuid'), ('lab_order_items', 'clinic_id', 'uuid'),
    ('lab_order_items', 'lab_order_id', 'uuid'), ('lab_order_items', 'item_type', 'text'),
    ('lab_order_items', 'description', 'text'), ('lab_order_items', 'tooth_number', 'text'),
    ('lab_order_items', 'material', 'text'), ('lab_order_items', 'color_code', 'text'),
    ('lab_order_items', 'quantity', 'int4'), ('lab_order_items', 'notes', 'text'),
    ('lab_order_items', 'created_at', 'timestamptz'),
    ('patients', 'id', 'uuid'), ('patients', 'clinic_id', 'uuid'), ('patients', 'full_name', 'text'),
    ('patients', 'phone', 'text'), ('patients', 'is_active', 'bool'),
    ('appointments', 'id', 'uuid'), ('appointments', 'clinic_id', 'uuid'), ('appointments', 'patient_id', 'uuid'),
    ('appointments', 'doctor_id', 'uuid'), ('appointments', 'chair_id', 'uuid'),
    ('appointments', 'procedure_id', 'uuid'), ('appointments', 'start_time', 'timestamptz'),
    ('appointments', 'end_time', 'timestamptz'), ('appointments', 'status', 'appointment_status'),
    ('appointments', 'notes', 'text'),
    ('chairs', 'id', 'uuid'), ('chairs', 'name', 'text'),
    ('procedures_catalog', 'id', 'uuid'), ('procedures_catalog', 'name', 'text'),
    ('doctors', 'id', 'uuid'), ('doctors', 'clinic_id', 'uuid'), ('doctors', 'user_id', 'uuid'),
    ('users', 'id', 'uuid'), ('users', 'clinic_id', 'uuid'), ('users', 'full_name', 'text'),
    ('users', 'email', 'text'), ('users', 'role', 'user_role'), ('users', 'is_active', 'bool'),
    ('treatment_plans', 'id', 'uuid'), ('treatment_plans', 'clinic_id', 'uuid'),
    ('treatment_plans', 'patient_id', 'uuid'),
    ('clinics', 'id', 'uuid'), ('clinics', 'name', 'text'), ('clinics', 'slug', 'text'),
    ('audit_logs', 'clinic_id', 'uuid'), ('audit_logs', 'entity_type', 'text'), ('audit_logs', 'entity_id', 'uuid'),
    ('stock_items', 'id', 'uuid'), ('stock_items', 'clinic_id', 'uuid'), ('stock_items', 'item_name', 'text'),
    ('stock_items', 'item_code', 'text'), ('stock_items', 'category', 'text'),
    ('stock_items', 'tracking_level', 'text'), ('stock_items', 'brand', 'text'), ('stock_items', 'model', 'text'),
    ('stock_items', 'gtin', 'text'), ('stock_items', 'usage_unit', 'text'), ('stock_items', 'is_active', 'bool'),
    ('stock_items', 'needs_review', 'bool'),
    ('stock_batches', 'id', 'uuid'), ('stock_batches', 'clinic_id', 'uuid'),
    ('stock_batches', 'stock_item_id', 'uuid'), ('stock_batches', 'lot_number', 'text'),
    ('stock_batches', 'serial_number', 'text'), ('stock_batches', 'expiry_date', 'date'),
    ('stock_batches', 'received_at', 'timestamptz'),
    ('stock_batch_costs', 'batch_id', 'uuid'), ('stock_batch_costs', 'unit_cost_cents', 'int8'),
    ('stock_balances', 'clinic_id', 'uuid'), ('stock_balances', 'stock_item_id', 'uuid'),
    ('stock_balances', 'batch_id', 'uuid'), ('stock_balances', 'location_id', 'uuid'),
    ('stock_balances', 'quantity', 'numeric'),
    ('stock_locations', 'id', 'uuid'), ('stock_locations', 'name', 'text'), ('stock_locations', 'is_active', 'bool'),
    ('stock_movements', 'id', 'uuid'), ('stock_movements', 'clinic_id', 'uuid'), ('stock_movements', 'ref_no', 'int8'),
    ('stock_movements', 'operation_key', 'uuid'), ('stock_movements', 'stock_item_id', 'uuid'),
    ('stock_movements', 'batch_id', 'uuid'), ('stock_movements', 'movement_type', 'text'),
    ('stock_movements', 'quantity', 'numeric'), ('stock_movements', 'from_location_id', 'uuid'),
    ('stock_movements', 'patient_id', 'uuid'), ('stock_movements', 'appointment_id', 'uuid'),
    ('stock_movements', 'doctor_id', 'uuid'), ('stock_movements', 'source_movement_id', 'uuid'),
    ('stock_movements', 'correction_request_id', 'uuid'), ('stock_movements', 'implant_record_id', 'uuid'),
    ('stock_movements', 'actor_user_id', 'uuid'), ('stock_movements', 'effective_at', 'timestamptz'),
    ('stock_correction_requests', 'id', 'uuid'), ('stock_correction_requests', 'ref_no', 'int8'),
    ('stock_correction_requests', 'clinic_id', 'uuid'), ('stock_correction_requests', 'movement_id', 'uuid'),
    ('stock_correction_requests', 'reason', 'text'), ('stock_correction_requests', 'requested_by', 'uuid'),
    ('stock_correction_requests', 'status', 'text'), ('stock_correction_requests', 'created_at', 'timestamptz'),
    ('stock_operations', 'operation_key', 'uuid'), ('stock_operations', 'result', 'jsonb'),
    ('fin_entries', 'id', 'uuid'), ('fin_entries', 'clinic_id', 'uuid'), ('fin_entries', 'category_id', 'uuid'),
    ('fin_entries', 'counterparty_id', 'uuid'), ('fin_entries', 'counterparty_text', 'text'),
    ('fin_entries', 'description', 'text'), ('fin_entries', 'due_date', 'date'),
    ('fin_entries', 'amount_cents', 'int8'), ('fin_entries', 'cancelled_at', 'timestamptz'),
    ('fin_entries', 'cancelled_by', 'uuid'), ('fin_entries', 'cancel_reason', 'text'),
    ('fin_entries', 'source_key', 'text'), ('fin_entries', 'version', 'int4'),
    ('fin_entries', 'created_by', 'uuid'), ('fin_entries', 'updated_by', 'uuid'),
    ('fin_categories', 'id', 'uuid'), ('fin_categories', 'clinic_id', 'uuid'),
    ('fin_categories', 'report_bucket', 'text'), ('fin_categories', 'is_system', 'bool'),
    ('fin_categories', 'is_active', 'bool'),
    ('fin_counterparties', 'id', 'uuid'), ('fin_counterparties', 'clinic_id', 'uuid'),
    ('fin_counterparties', 'name', 'text'), ('fin_counterparties', 'kind', 'text'),
    ('fin_counterparties', 'is_active', 'bool'),
    ('fin_payments', 'id', 'uuid'), ('fin_payments', 'clinic_id', 'uuid'), ('fin_payments', 'entry_id', 'uuid'),
    ('fin_payments', 'amount_cents', 'int8'), ('fin_payments', 'voided_at', 'timestamptz')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Beklenen sütunlar bulunamadı veya türü farklı: %', v_missing;
  END IF;

  -- Columns this migration adds to lab_orders: if one is already there (earlier run or drift), it must have the
  -- type created below.
  SELECT string_agg(format('lab_orders.%s (%s beklenirken %s)', e.col, e.udt, c.udt_name), ', ')
    INTO v_missing
  FROM (VALUES
    ('lab_id', 'uuid'), ('sent_on', 'date'), ('received_on', 'date'), ('last_try_in_on', 'date'),
    ('revision_count', 'int2'), ('cancelled_at', 'timestamptz'), ('cancel_reason', 'text'), ('version', 'int4'),
    ('created_by', 'uuid'), ('updated_by', 'uuid'), ('legacy_id', 'text')
  ) AS e(col, udt)
  JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'lab_orders' AND c.column_name = e.col
  WHERE c.udt_name::text <> e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'lab_orders üzerinde önceden kalan sütunlar beklenen yapıda değil: %', v_missing;
  END IF;

  -- New tables left by an earlier run must have every column created below, with the same type.
  SELECT string_agg(format('%s.%s (%s beklenirken %s)', e.tbl, e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
    INTO v_missing
  FROM (VALUES
    ('implant_brands', 'id', 'uuid'), ('implant_brands', 'clinic_id', 'uuid'), ('implant_brands', 'name', 'text'),
    ('implant_brands', 'name_key', 'text'), ('implant_brands', 'is_active', 'bool'),
    ('implant_brands', 'version', 'int4'), ('implant_brands', 'legacy_id', 'text'),
    ('implant_brands', 'created_by', 'uuid'), ('implant_brands', 'updated_by', 'uuid'),
    ('implant_brands', 'created_at', 'timestamptz'), ('implant_brands', 'updated_at', 'timestamptz'),
    ('labs', 'id', 'uuid'), ('labs', 'clinic_id', 'uuid'), ('labs', 'name', 'text'), ('labs', 'name_key', 'text'),
    ('labs', 'phone', 'text'), ('labs', 'email', 'text'), ('labs', 'note', 'text'),
    ('labs', 'fin_counterparty_id', 'uuid'), ('labs', 'is_active', 'bool'), ('labs', 'version', 'int4'),
    ('labs', 'legacy_id', 'text'), ('labs', 'created_by', 'uuid'), ('labs', 'updated_by', 'uuid'),
    ('labs', 'created_at', 'timestamptz'), ('labs', 'updated_at', 'timestamptz'),
    ('patient_implants', 'id', 'uuid'), ('patient_implants', 'clinic_id', 'uuid'),
    ('patient_implants', 'patient_id', 'uuid'), ('patient_implants', 'tooth_fdi', 'int2'),
    ('patient_implants', 'brand_id', 'uuid'), ('patient_implants', 'model', 'text'),
    ('patient_implants', 'diameter_mm', 'numeric'), ('patient_implants', 'length_mm', 'numeric'),
    ('patient_implants', 'placed_on', 'date'), ('patient_implants', 'doctor_id', 'uuid'),
    ('patient_implants', 'appointment_id', 'uuid'), ('patient_implants', 'stock_source', 'text'),
    ('patient_implants', 'source_note', 'text'), ('patient_implants', 'stock_item_id', 'uuid'),
    ('patient_implants', 'batch_id', 'uuid'), ('patient_implants', 'stock_movement_id', 'uuid'),
    ('patient_implants', 'lot_text', 'text'), ('patient_implants', 'serial_text', 'text'),
    ('patient_implants', 'torque_ncm', 'numeric'), ('patient_implants', 'next_control_on', 'date'),
    ('patient_implants', 'status', 'text'), ('patient_implants', 'notes', 'text'),
    ('patient_implants', 'version', 'int4'), ('patient_implants', 'legacy_id', 'text'),
    ('patient_implants', 'created_by', 'uuid'), ('patient_implants', 'updated_by', 'uuid'),
    ('patient_implants', 'created_at', 'timestamptz'), ('patient_implants', 'updated_at', 'timestamptz'),
    ('patient_implants', 'deleted_at', 'timestamptz'), ('patient_implants', 'deleted_by', 'uuid'),
    ('patient_implants', 'delete_reason', 'text'),
    ('lab_order_events', 'id', 'uuid'), ('lab_order_events', 'clinic_id', 'uuid'),
    ('lab_order_events', 'lab_order_id', 'uuid'), ('lab_order_events', 'from_status', 'lab_order_status'),
    ('lab_order_events', 'to_status', 'lab_order_status'), ('lab_order_events', 'on_date', 'date'),
    ('lab_order_events', 'note', 'text'), ('lab_order_events', 'actor_user_id', 'uuid'),
    ('lab_order_events', 'created_at', 'timestamptz'),
    ('lab_order_costs', 'lab_order_id', 'uuid'), ('lab_order_costs', 'id', 'uuid'),
    ('lab_order_costs', 'clinic_id', 'uuid'), ('lab_order_costs', 'amount_cents', 'int8'),
    ('lab_order_costs', 'currency', 'bpchar'), ('lab_order_costs', 'note', 'text'),
    ('lab_order_costs', 'fin_entry_id', 'uuid'), ('lab_order_costs', 'posted_at', 'timestamptz'),
    ('lab_order_costs', 'posted_by', 'uuid'), ('lab_order_costs', 'version', 'int4'),
    ('lab_order_costs', 'updated_by', 'uuid'), ('lab_order_costs', 'updated_at', 'timestamptz'),
    ('clinical_settings', 'clinic_id', 'uuid'), ('clinical_settings', 'id', 'uuid'),
    ('clinical_settings', 'lab_cost_payable_enabled', 'bool'), ('clinical_settings', 'version', 'int4'),
    ('clinical_settings', 'updated_by', 'uuid'), ('clinical_settings', 'updated_at', 'timestamptz')
  ) AS e(tbl, col, udt)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  WHERE to_regclass(format('public.%I', e.tbl)) IS NOT NULL
    AND c.udt_name::text IS DISTINCT FROM e.udt;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Önceki çalıştırmadan kalan klinik tabloları beklenen yapıda değil: %', v_missing;
  END IF;

  -- The finance 'Laboratuvar' system category is needed only when a cost is posted; reported, not required.
  SELECT string_agg(c.slug, ', ' ORDER BY c.slug)
    INTO v_missing
  FROM public.clinics c
  WHERE NOT EXISTS (SELECT 1 FROM public.fin_categories k
                    WHERE k.clinic_id = c.id AND k.report_bucket = 'lab' AND k.is_system AND k.is_active);
  IF v_missing IS NOT NULL THEN
    RAISE NOTICE 'Etkin "Laboratuvar" sistem kategorisi olmayan klinikler (lab maliyeti finansa işlenemez): %',
      left(v_missing, 2000);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. lab_order_status: 'try_in' (Provada) and 'revision' (Revizyonda). Never used as an enum value in this
--    transaction (see the header). 'revision' is placed BEFORE 'ready' so it only references a committed label.
-- ---------------------------------------------------------------------------
ALTER TYPE public.lab_order_status ADD VALUE IF NOT EXISTS 'try_in' AFTER 'in_progress';
ALTER TYPE public.lab_order_status ADD VALUE IF NOT EXISTS 'revision' BEFORE 'ready';

-- ---------------------------------------------------------------------------
-- 1.1 Pure helpers (no table access). Internal: never granted (clin__harden_privileges).
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

-- Turkish lower case for name keys and search (stock__tr_lower body, so no 0024 internal is needed), then dotted
-- and dotless i folded together: brand / lab names are often foreign and typed with either 'I' or 'İ', so
-- 'Kurgu Implant' and 'KURGU İMPLANT' share one key (acceptance B-2) and a search for 'implant' finds both.
CREATE OR REPLACE FUNCTION public.clin__tr_lower(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.translate(pg_catalog.lower(pg_catalog.translate(p, 'İIÇĞÖŞÜÂÎÛ', 'iıçğöşüâîû')), 'ı', 'i')
$$;

-- Numbers as JSON numbers with trailing zeros trimmed (numeric(4,2) 4.00 -> 4).
CREATE OR REPLACE FUNCTION public.clin__q(p numeric)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.to_jsonb(pg_catalog.trim_scale(p))
$$;

-- §1.5 FDI permanent tooth (CR:25): 11-18, 21-28, 31-38, 41-48. Primary teeth are refused (legacy has no rule).
CREATE OR REPLACE FUNCTION public.clin__fdi_ok(p integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(p BETWEEN 11 AND 48 AND p / 10 BETWEEN 1 AND 4 AND p % 10 BETWEEN 1 AND 8, false)
$$;

-- §1.5 Lab transition matrix on TEXT labels (never enum literals, see the header). 21 allowed pairs; x -> x never.
CREATE OR REPLACE FUNCTION public.clin__lab_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce((p_from || '>' || p_to) = ANY (ARRAY[
    'draft>submitted', 'draft>cancelled',
    'submitted>in_progress', 'submitted>try_in', 'submitted>ready', 'submitted>cancelled',
    'in_progress>try_in', 'in_progress>ready', 'in_progress>cancelled',
    'try_in>revision', 'try_in>ready', 'try_in>delivered', 'try_in>cancelled',
    'revision>in_progress', 'revision>try_in', 'revision>ready', 'revision>cancelled',
    'ready>revision', 'ready>delivered', 'ready>cancelled',
    'delivered>ready']), false)
$$;

-- §1.4 Turkish labels of the lab statuses (text in, text out).
CREATE OR REPLACE FUNCTION public.clin__lab_status_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p
           WHEN 'draft' THEN 'Taslak'
           WHEN 'submitted' THEN 'Gönderildi'
           WHEN 'in_progress' THEN 'Laboratuvarda'
           WHEN 'try_in' THEN 'Provada'
           WHEN 'revision' THEN 'Revizyonda'
           WHEN 'ready' THEN 'Kliniğe geldi'
           WHEN 'delivered' THEN 'Hastaya teslim'
           WHEN 'cancelled' THEN 'İptal'
           ELSE coalesce(p, '')
         END
$$;

-- §1.5 Statuses that count as "at the lab" for the late filter (CW:32 mapped). Text only.
CREATE OR REPLACE FUNCTION public.clin__lab_is_out(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(p IN ('submitted', 'in_progress', 'try_in', 'revision'), false)
$$;

-- Lab item type labels (lab/[id]/page.tsx:45-58) for summaries and search.
CREATE OR REPLACE FUNCTION public.clin__lab_item_label(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p
           WHEN 'crown' THEN 'Kron'
           WHEN 'bridge' THEN 'Köprü'
           WHEN 'denture' THEN 'Protez'
           WHEN 'implant_crown' THEN 'İmplant kronu'
           WHEN 'other' THEN 'Diğer'
           ELSE coalesce(p, '')
         END
$$;

-- §1.6 Day 'YYYY-MM-DD': blank -> NULL; a real day (2026-02-30 refused), years 2000..2200; else p_err.
CREATE OR REPLACE FUNCTION public.clin__day(p text, p_err text)
RETURNS date
LANGUAGE plpgsql
STABLE
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
    PERFORM public.clin__raise(p_err);
  END IF;
  BEGIN
    d := to_date(v, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.clin__raise(p_err);
  END;
  IF to_char(d, 'YYYY-MM-DD') <> v OR d < DATE '2000-01-01' OR d > DATE '2200-12-31' THEN
    PERFORM public.clin__raise(p_err);
  END IF;
  RETURN d;
END;
$$;

-- §1.6 Paging {offset >= 0 (default 0), limit 1..p_max (default 50)}; anything else -> CL_FILTER.
CREATE OR REPLACE FUNCTION public.clin__page(p_page jsonb, p_max integer, OUT o_offset integer, OUT o_limit integer)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_page jsonb := coalesce(p_page, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_page) <> 'object' THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_page) AS k(k_name) WHERE k.k_name NOT IN ('offset', 'limit')) THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  IF (v_page ? 'offset' AND jsonb_typeof(v_page -> 'offset') NOT IN ('number', 'null'))
     OR (v_page ? 'limit' AND jsonb_typeof(v_page -> 'limit') NOT IN ('number', 'null')) THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  BEGIN
    o_offset := coalesce((v_page ->> 'offset')::integer, 0);
    o_limit := coalesce((v_page ->> 'limit')::integer, 50);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.clin__raise('CL_FILTER');
  END;
  IF o_offset < 0 OR o_limit < 1 OR o_limit > p_max THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
END;
$$;

-- Filter readers: a wrong JSON type or an unparsable value -> CL_FILTER; JSON null and an absent key read as NULL.
CREATE OR REPLACE FUNCTION public.clin__j_text(p jsonb, p_key text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('string', 'null') THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  RETURN nullif(btrim(p ->> p_key), '');
END;
$$;

CREATE OR REPLACE FUNCTION public.clin__j_uuid(p jsonb, p_key text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text := public.clin__j_text(p, p_key);
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  RETURN v::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.clin__j_bool(p jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p ? p_key AND jsonb_typeof(p -> p_key) NOT IN ('boolean', 'null') THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  RETURN (p ->> p_key)::boolean;
END;
$$;

-- Array of strings, each in p_allowed; NULL / absent -> NULL; [] -> NULL (no filter).
CREATE OR REPLACE FUNCTION public.clin__j_codes(p jsonb, p_key text, p_allowed text[])
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text[];
BEGIN
  IF NOT (p ? p_key) OR jsonb_typeof(p -> p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p -> p_key) <> 'array'
     OR jsonb_array_length(p -> p_key) > 20
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p -> p_key) AS e(v)
                WHERE jsonb_typeof(e.v) <> 'string' OR NOT ((e.v #>> '{}') = ANY (p_allowed))) THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  SELECT array_agg(DISTINCT e.v) INTO v FROM jsonb_array_elements_text(p -> p_key) AS e(v);
  RETURN v;
END;
$$;

-- Adds a named constraint if it is missing. p_not_valid: added NOT VALID, validated only when every existing row
-- passes; otherwise a NOTICE and the rule applies to new and changed rows only (0024 stock__add_constraint copy).
CREATE OR REPLACE FUNCTION public.clin__add_constraint(p_table text, p_name text, p_def text, p_not_valid boolean)
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
-- 1.2 Permission helpers. clin_can_* answer only for the caller and are granted (RLS and the UI use them); the
--     clin__require_* gates are internal and are the first statement of every RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clin_can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_user_id() IS NOT NULL AND public.current_clinic_id() IS NOT NULL, false)
$$;

CREATE OR REPLACE FUNCTION public.clin_can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() IN ('owner', 'admin', 'doctor', 'assistant'), false)
      OR coalesce(public.has_permission('clinical'), false)
$$;

CREATE OR REPLACE FUNCTION public.clin_can_view_lab_costs()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false)
      OR coalesce(public.has_permission('finance'), false)
      OR coalesce(public.has_permission('finance_readonly'), false)
      OR coalesce(public.has_permission('stock_cost_view'), false)
$$;

CREATE OR REPLACE FUNCTION public.clin_can_edit_lab_costs()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_app_role() = 'owner', false)
      OR coalesce(public.has_permission('finance'), false)
      OR coalesce(public.has_permission('stock_cost_view'), false)
$$;

CREATE OR REPLACE FUNCTION public.clin__require_read()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.current_clinic_id();
BEGIN
  IF v_clinic IS NULL OR public.current_app_user_id() IS NULL THEN
    PERFORM public.clin__raise('CL_SESSION');
  END IF;
  RETURN v_clinic;
END;
$$;

CREATE OR REPLACE FUNCTION public.clin__require_write()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
BEGIN
  IF NOT public.clin_can_write() THEN
    PERFORM public.clin__raise('CL_WRITE');
  END IF;
  RETURN v_clinic;
END;
$$;

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
    'can_view_material_costs', coalesce(public.stock_can_view_costs(), false))
$$;

-- ---------------------------------------------------------------------------
-- 3.1 implant_brands (directory; deactivated, never deleted; no seed, §0.1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.implant_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  legacy_id text CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
  created_by uuid REFERENCES public.users(id),
  updated_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id)
);
-- Unique among inactive rows too (CR:43 directory_key).
CREATE UNIQUE INDEX IF NOT EXISTS implant_brands_name_key ON public.implant_brands (clinic_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS implant_brands_legacy_key ON public.implant_brands (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3.2 labs (directory). fin_counterparty_id is only a pointer, set / changed only by a 'finance' holder (RPC).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.labs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  name_key text NOT NULL,
  phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 30 AND phone ~ '^[0-9 +()-]*$'),
  email text NOT NULL DEFAULT '' CHECK (char_length(email) <= 120
                                        AND (email = '' OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  fin_counterparty_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  legacy_id text CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
  created_by uuid REFERENCES public.users(id),
  updated_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, fin_counterparty_id) REFERENCES public.fin_counterparties (clinic_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS labs_name_key ON public.labs (clinic_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS labs_legacy_key ON public.labs (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3.3 patient_implants. Patient by FK only (KVKK). clinic_id RESTRICT: clinical history protects the clinic row
--     (only the editor-only clin__purge_test_clinic removes a test clinic's rows). patient / doctor / appointment
--     of the same clinic are checked by the RPCs and by trigger clin_implant_refs (no composite FK on tables
--     another workflow owns, 0024:2097 choice). appointment RESTRICT (analysis_critique.md:155): the app cancels
--     appointments, it never deletes them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.patient_implants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  tooth_fdi smallint NOT NULL CHECK (tooth_fdi / 10 BETWEEN 1 AND 4 AND tooth_fdi % 10 BETWEEN 1 AND 8),
  brand_id uuid NOT NULL,
  model text NOT NULL DEFAULT '' CHECK (char_length(model) <= 150),
  diameter_mm numeric(4,2) NOT NULL CHECK (diameter_mm > 0 AND diameter_mm <= 10),
  length_mm numeric(4,2) NOT NULL CHECK (length_mm > 0 AND length_mm <= 30),
  placed_on date NOT NULL CHECK (placed_on BETWEEN DATE '2000-01-01' AND DATE '2200-12-31'),
  doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE RESTRICT,
  stock_source text NOT NULL CHECK (stock_source IN ('stock', 'external')),
  source_note text NOT NULL DEFAULT '' CHECK (char_length(source_note) <= 200),
  stock_item_id uuid,
  batch_id uuid,
  stock_movement_id uuid,
  lot_text text NOT NULL DEFAULT '' CHECK (char_length(lot_text) <= 60),
  serial_text text NOT NULL DEFAULT '' CHECK (char_length(serial_text) <= 60),
  torque_ncm numeric(5,1) CHECK (torque_ncm IS NULL OR torque_ncm BETWEEN 0 AND 200),
  next_control_on date CHECK (next_control_on IS NULL OR next_control_on <= DATE '2200-12-31'),
  status text NOT NULL DEFAULT 'healing' CHECK (status IN ('healing', 'prosthetic', 'completed', 'follow_up', 'failed')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  legacy_id text CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
  created_by uuid REFERENCES public.users(id),
  updated_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.users(id),
  delete_reason text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, brand_id) REFERENCES public.implant_brands (clinic_id, id),
  FOREIGN KEY (clinic_id, stock_item_id) REFERENCES public.stock_items (clinic_id, id),
  FOREIGN KEY (clinic_id, batch_id) REFERENCES public.stock_batches (clinic_id, id),
  -- Deferrable: the purge removes both sides in one transaction.
  CONSTRAINT patient_implants_movement_fkey FOREIGN KEY (clinic_id, stock_movement_id)
    REFERENCES public.stock_movements (clinic_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT patient_implants_stock_shape CHECK (
    (stock_source = 'stock' AND stock_item_id IS NOT NULL AND batch_id IS NOT NULL
       AND stock_movement_id IS NOT NULL AND doctor_id IS NOT NULL)
    OR (stock_source = 'external' AND stock_item_id IS NULL AND batch_id IS NULL
       AND stock_movement_id IS NULL AND char_length(btrim(source_note)) BETWEEN 3 AND 200)
  ),
  CONSTRAINT patient_implants_delete_shape CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL)
    OR (deleted_at IS NOT NULL AND char_length(btrim(delete_reason)) BETWEEN 3 AND 500)
  ),
  CONSTRAINT patient_implants_control CHECK (next_control_on IS NULL OR next_control_on >= placed_on)
);
-- One live implant per tooth; also stops double submits that slip past idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS patient_implants_tooth_active
  ON public.patient_implants (clinic_id, patient_id, tooth_fdi) WHERE deleted_at IS NULL AND status <> 'failed';
-- One implant per issue movement, kept after void.
CREATE UNIQUE INDEX IF NOT EXISTS patient_implants_movement
  ON public.patient_implants (stock_movement_id) WHERE stock_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS patient_implants_patient ON public.patient_implants (clinic_id, patient_id, placed_on DESC);
CREATE INDEX IF NOT EXISTS patient_implants_control_due ON public.patient_implants (clinic_id, next_control_on)
  WHERE deleted_at IS NULL AND status IN ('healing', 'prosthetic', 'follow_up');
CREATE INDEX IF NOT EXISTS patient_implants_placed ON public.patient_implants (clinic_id, placed_on DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS patient_implants_appointment ON public.patient_implants (appointment_id)
  WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS patient_implants_brand ON public.patient_implants (clinic_id, brand_id);
CREATE INDEX IF NOT EXISTS patient_implants_doctor ON public.patient_implants (doctor_id) WHERE doctor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS patient_implants_batch ON public.patient_implants (batch_id) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS patient_implants_legacy ON public.patient_implants (clinic_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3.4 lab_orders (0009 + 0012): additions. Foreign keys and checks are added by name (idempotent), not inline,
--     because ADD COLUMN IF NOT EXISTS ... REFERENCES may still add a constraint on a re-run.
-- ---------------------------------------------------------------------------
ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS lab_id uuid,
  ADD COLUMN IF NOT EXISTS sent_on date,
  ADD COLUMN IF NOT EXISTS received_on date,
  ADD COLUMN IF NOT EXISTS last_try_in_on date,
  ADD COLUMN IF NOT EXISTS revision_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS legacy_id text;

-- Composite foreign keys need UNIQUE (clinic_id, id).
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_clinic_id_id_key', 'UNIQUE (clinic_id, id)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_lab_fkey',
  'FOREIGN KEY (clinic_id, lab_id) REFERENCES public.labs (clinic_id, id)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_created_by_fkey',
  'FOREIGN KEY (created_by) REFERENCES public.users (id)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_updated_by_fkey',
  'FOREIGN KEY (updated_by) REFERENCES public.users (id)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_revision_count',
  'CHECK (revision_count BETWEEN 0 AND 999)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_version', 'CHECK (version >= 1)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_cancel_reason_len',
  'CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500)', false);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_legacy_len',
  'CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100)', false);

CREATE INDEX IF NOT EXISTS lab_orders_lab ON public.lab_orders (clinic_id, lab_id);
CREATE INDEX IF NOT EXISTS lab_orders_patient_created ON public.lab_orders (clinic_id, patient_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_legacy ON public.lab_orders (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;
-- Late candidates (§1.5): submitted / in_progress / try_in / revision, written with the OLD labels only (the new
-- ones cannot be used in this transaction); equivalent while the enum has its 8 values.
CREATE INDEX IF NOT EXISTS lab_orders_late ON public.lab_orders (clinic_id, due_date)
  WHERE status NOT IN ('draft', 'ready', 'delivered', 'cancelled');

-- New order numbers: 'LAB-' || YYMM || '-' || 5+ digits (old 'LAB-<base36>' numbers stay). Only the definer RPC
-- calls nextval.
CREATE SEQUENCE IF NOT EXISTS public.lab_order_number_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- ---------------------------------------------------------------------------
-- 3.5 lab_order_items (0009): composite clinic FK and quantity range; writes only through clin_lab_order_save.
-- ---------------------------------------------------------------------------
SELECT public.clin__add_constraint('lab_order_items', 'lab_order_items_order_clinic_fkey',
  'FOREIGN KEY (clinic_id, lab_order_id) REFERENCES public.lab_orders (clinic_id, id) ON DELETE CASCADE', true);
SELECT public.clin__add_constraint('lab_order_items', 'lab_order_items_quantity_range',
  'CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 99)', true);
CREATE INDEX IF NOT EXISTS lab_order_items_order ON public.lab_order_items (clinic_id, lab_order_id);

-- ---------------------------------------------------------------------------
-- 3.6 lab_order_events: status history; SELECT only for clients, written only by the lab RPCs; not audited.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lab_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  lab_order_id uuid NOT NULL,
  from_status public.lab_order_status,
  to_status public.lab_order_status NOT NULL,
  on_date date NOT NULL CHECK (on_date BETWEEN DATE '2000-01-01' AND DATE '2200-12-31'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  actor_user_id uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CONSTRAINT lab_order_events_order_fkey FOREIGN KEY (clinic_id, lab_order_id)
    REFERENCES public.lab_orders (clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS lab_order_events_order ON public.lab_order_events (clinic_id, lab_order_id, created_at);

-- ---------------------------------------------------------------------------
-- 3.7 lab_order_costs (cost-gated). id mirrors lab_order_id because audit_logs.entity_id is NOT NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lab_order_costs (
  lab_order_id uuid PRIMARY KEY,
  id uuid GENERATED ALWAYS AS (lab_order_id) STORED,
  clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000),
  currency char(3) NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  fin_entry_id uuid,
  posted_at timestamptz,
  posted_by uuid REFERENCES public.users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_order_costs_order_fkey FOREIGN KEY (clinic_id, lab_order_id)
    REFERENCES public.lab_orders (clinic_id, id) ON DELETE CASCADE,
  CONSTRAINT lab_order_costs_entry_fkey FOREIGN KEY (clinic_id, fin_entry_id)
    REFERENCES public.fin_entries (clinic_id, id),
  CONSTRAINT lab_order_costs_posted_shape CHECK ((fin_entry_id IS NULL) = (posted_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS lab_order_costs_entry ON public.lab_order_costs (fin_entry_id)
  WHERE fin_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lab_order_costs_clinic ON public.lab_order_costs (clinic_id);

-- ---------------------------------------------------------------------------
-- 3.8 clinical_settings: one row per clinic, created lazily; a missing row reads as payable OFF, version 0 (D2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clinical_settings (
  clinic_id uuid PRIMARY KEY REFERENCES public.clinics(id) ON DELETE CASCADE,
  id uuid GENERATED ALWAYS AS (clinic_id) STORED,
  lab_cost_payable_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3.9-1 Link into the stock ledger: stock_movements.implant_record_id (0024 hook, NULL so far) -> patient_implants.
--       Deferred: clin_implant_record writes the issue before the implant row.
-- ---------------------------------------------------------------------------
SELECT public.clin__add_constraint('stock_movements', 'stock_movements_implant_fkey',
  'FOREIGN KEY (clinic_id, implant_record_id) REFERENCES public.patient_implants (clinic_id, id)
   DEFERRABLE INITIALLY DEFERRED', false);
CREATE INDEX IF NOT EXISTS stock_movements_implant ON public.stock_movements (implant_record_id)
  WHERE implant_record_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3.11 Trigger functions. SECURITY DEFINER SET search_path = public (the only definer internals), never granted.
-- ---------------------------------------------------------------------------

-- implant_brands / labs: trimmed name and its Turkish-folded key; identity is immutable.
CREATE OR REPLACE FUNCTION public.clin__trg_name_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id)
     AND NOT public.stock__is_editor() THEN
    PERFORM public.clin__raise('CL_HISTORY');
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.name_key := public.clin__tr_lower(NEW.name);
  RETURN NEW;
END;
$$;

-- labs AFTER UPDATE OF name: keep the lab_orders.lab_name mirror in step.
CREATE OR REPLACE FUNCTION public.clin__trg_lab_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE public.lab_orders o
    SET lab_name = NEW.name
    WHERE o.clinic_id = NEW.clinic_id AND o.lab_id = NEW.id AND o.lab_name IS DISTINCT FROM NEW.name;
  END IF;
  RETURN NULL;
END;
$$;

-- patient_implants BEFORE INSERT OR UPDATE: patient / doctor / appointment of the row's clinic (defence for service
-- role imports and RPC bugs; the RPCs check first with the specific texts). Activity is not required here, so an
-- old implant stays editable after its doctor left.
CREATE OR REPLACE FUNCTION public.clin__trg_implant_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
    IF NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = NEW.patient_id AND p.clinic_id = NEW.clinic_id) THEN
      PERFORM public.stock__raise('E_PATIENT');
    END IF;
  END IF;
  IF NEW.doctor_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id)
     AND NOT EXISTS (SELECT 1 FROM public.doctors d WHERE d.id = NEW.doctor_id AND d.clinic_id = NEW.clinic_id) THEN
    PERFORM public.stock__raise('E_DOCTOR');
  END IF;
  IF NEW.appointment_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
          OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id)
     AND NOT EXISTS (SELECT 1 FROM public.appointments a
                     WHERE a.id = NEW.appointment_id AND a.clinic_id = NEW.clinic_id AND a.patient_id = NEW.patient_id) THEN
    PERFORM public.stock__raise('E_APPOINTMENT');
  END IF;
  RETURN NEW;
END;
$$;

-- patient_implants BEFORE UPDATE OR DELETE: identity, patient and stock link are immutable and rows are never
-- deleted (void = soft delete). The SQL editor / service role passes (data repair, test purge).
CREATE OR REPLACE FUNCTION public.clin__trg_implant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.stock__is_editor() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.clin__raise('CL_HISTORY');
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.stock_source IS DISTINCT FROM OLD.stock_source
     OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.stock_movement_id IS DISTINCT FROM OLD.stock_movement_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    PERFORM public.clin__raise('CL_HISTORY');
  END IF;
  RETURN NEW;
END;
$$;

-- lab_orders BEFORE INSERT OR UPDATE OF lab_id: lab_name mirrors labs.name (old readers keep working).
CREATE OR REPLACE FUNCTION public.clin__trg_lab_order_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  IF NEW.lab_id IS NOT NULL THEN
    SELECT l.name INTO v_name FROM public.labs l WHERE l.id = NEW.lab_id AND l.clinic_id = NEW.clinic_id;
    IF v_name IS NOT NULL THEN
      NEW.lab_name := v_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- stock_movements BEFORE INSERT (§3.9-2).
--   issue without implant_record_id: take the transaction-local 'clin.implant_record_id', set and cleared only by
--   clin_implant_record around its single stock__outbound call (0024's stock__ledger knows nothing about implants).
--   A value set by a later stock__ledger is never overwritten.
--   return of an ACTIVE implant's issue: refused (void the implant first, which opens a correction request).
-- The SQL editor / service role passes the return guard (data repair, purge).
CREATE OR REPLACE FUNCTION public.clin__trg_movement_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF NEW.movement_type = 'issue' AND NEW.implant_record_id IS NULL THEN
    v := nullif(current_setting('clin.implant_record_id', true), '');
    IF v IS NOT NULL THEN
      NEW.implant_record_id := v::uuid;
    END IF;
  ELSIF NEW.movement_type = 'return' AND NEW.source_movement_id IS NOT NULL AND NOT public.stock__is_editor() THEN
    IF EXISTS (SELECT 1 FROM public.patient_implants pi
               WHERE pi.stock_movement_id = NEW.source_movement_id AND pi.deleted_at IS NULL) THEN
      PERFORM public.clin__raise('CL_IMPLANT_LINKED');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- stock_correction_requests BEFORE INSERT (§3.9-3): no correction on an active implant's issue. clin_implant_void
-- sets deleted_at before it inserts its own request, so that insert passes.
CREATE OR REPLACE FUNCTION public.clin__trg_correction_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.stock__is_editor() AND EXISTS (
    SELECT 1 FROM public.patient_implants pi
    WHERE pi.stock_movement_id = NEW.movement_id AND pi.deleted_at IS NULL
  ) THEN
    PERFORM public.clin__raise('CL_IMPLANT_LINKED');
  END IF;
  RETURN NEW;
END;
$$;

-- TRUNCATE skips row triggers and foreign-key checks: refused on the history-like clinical tables, for everyone.
CREATE OR REPLACE FUNCTION public.clin__trg_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.clin__raise('CL_HISTORY');
  RETURN NULL;
END;
$$;

-- Trigger wiring (idempotent). audit_row_change is attached after the data steps (§4.3).
DROP TRIGGER IF EXISTS clin_name_key ON public.implant_brands;
CREATE TRIGGER clin_name_key
  BEFORE INSERT OR UPDATE ON public.implant_brands
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_name_key();

DROP TRIGGER IF EXISTS clin_name_key ON public.labs;
CREATE TRIGGER clin_name_key
  BEFORE INSERT OR UPDATE ON public.labs
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_name_key();

DROP TRIGGER IF EXISTS clin_lab_rename ON public.labs;
CREATE TRIGGER clin_lab_rename
  AFTER UPDATE OF name ON public.labs
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_lab_rename();

DROP TRIGGER IF EXISTS clin_implant_refs ON public.patient_implants;
CREATE TRIGGER clin_implant_refs
  BEFORE INSERT OR UPDATE ON public.patient_implants
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_implant_refs();

DROP TRIGGER IF EXISTS clin_implant_guard ON public.patient_implants;
CREATE TRIGGER clin_implant_guard
  BEFORE UPDATE OR DELETE ON public.patient_implants
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_implant_guard();

DROP TRIGGER IF EXISTS clin_lab_order_mirror ON public.lab_orders;
CREATE TRIGGER clin_lab_order_mirror
  BEFORE INSERT OR UPDATE OF lab_id ON public.lab_orders
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_lab_order_mirror();

DROP TRIGGER IF EXISTS clin_movement_link ON public.stock_movements;
CREATE TRIGGER clin_movement_link
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_movement_link();

DROP TRIGGER IF EXISTS clin_correction_link ON public.stock_correction_requests;
CREATE TRIGGER clin_correction_link
  BEFORE INSERT ON public.stock_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.clin__trg_correction_link();

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['lab_order_events', 'lab_order_costs', 'clinical_settings', 'patient_implants']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS clin_no_truncate ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER clin_no_truncate BEFORE TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.clin__trg_no_truncate()', v_t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3.10 Data steps (idempotent: only rows that are still empty are touched; NOTICE counts). Runs before the
--      lab_orders audit trigger is attached, so the back-fill does not flood audit_logs. Only OLD enum labels are
--      used here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_n bigint;
  v_list text;
BEGIN
  -- 1. status NOT NULL (0009 left it nullable with default 'draft').
  UPDATE public.lab_orders SET status = 'draft' WHERE status IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % siparişin boş durumu "Taslak" yapıldı.', v_n;
  END IF;

  -- 2. Labs from the old free-text lab_name, per clinic, grouped by the Turkish-folded key. The most frequent
  --    spelling wins (ties: alphabetical in tr-x-icu). Names are cut to 120 characters.
  WITH src AS (
    SELECT o.clinic_id,
           btrim(left(btrim(o.lab_name), 120)) AS nm
    FROM public.lab_orders o
    WHERE o.lab_id IS NULL AND o.lab_name IS NOT NULL AND btrim(o.lab_name) <> ''
  ), grp AS (
    SELECT s.clinic_id, public.clin__tr_lower(s.nm) AS k, s.nm, count(*) AS n
    FROM src s
    GROUP BY s.clinic_id, public.clin__tr_lower(s.nm), s.nm
  ), pick AS (
    SELECT DISTINCT ON (g.clinic_id, g.k) g.clinic_id, g.k, g.nm
    FROM grp g
    ORDER BY g.clinic_id, g.k, g.n DESC, g.nm COLLATE "tr-x-icu", g.nm
  ), ins AS (
    INSERT INTO public.labs (id, clinic_id, name, name_key)
    SELECT gen_random_uuid(), p.clinic_id, p.nm, p.k FROM pick p
    ON CONFLICT (clinic_id, name_key) DO NOTHING
    RETURNING clinic_id, name
  )
  SELECT string_agg(format('%s: %s', c.slug, x.names), '; ' ORDER BY c.slug)
    INTO v_list
  FROM (SELECT i.clinic_id, string_agg(i.name, ', ' ORDER BY i.name COLLATE "tr-x-icu") AS names
        FROM ins i GROUP BY i.clinic_id) x
  JOIN public.clinics c ON c.id = x.clinic_id;
  IF v_list IS NOT NULL THEN
    RAISE NOTICE 'Eski lab adlarından oluşturulan laboratuvarlar (yazım hatalarını / tekrarları Laboratuvarlar ekranından düzeltin): %',
      left(v_list, 3000);
  END IF;

  -- The mirror trigger sets lab_name := labs.name on these rows.
  UPDATE public.lab_orders o
  SET lab_id = l.id
  FROM public.labs l
  WHERE o.lab_id IS NULL
    AND o.lab_name IS NOT NULL AND btrim(o.lab_name) <> ''
    AND l.clinic_id = o.clinic_id
    AND l.name_key = public.clin__tr_lower(btrim(left(btrim(o.lab_name), 120)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % siparişe laboratuvar bağlandı.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.lab_orders o WHERE o.lab_id IS NULL;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % siparişin laboratuvarı yok (eski kayıt; düzenlenirken laboratuvar seçilmeli).', v_n;
  END IF;

  -- 3. Dates (approximations). sent_on: the creation day, or the old arrival day when that is earlier, so that
  --    received_on >= sent_on always holds. received_on: the old delivery_date (it meant "came back from the lab",
  --    lab/page.tsx:101) for ready / delivered orders. delivery_date keeps its value and means "Hastaya teslim"
  --    from now on.
  UPDATE public.lab_orders o
  SET sent_on = CASE
                  WHEN o.status IN ('ready', 'delivered') AND o.delivery_date IS NOT NULL
                    THEN least((o.created_at AT TIME ZONE 'Europe/Istanbul')::date, o.delivery_date)
                  ELSE (o.created_at AT TIME ZONE 'Europe/Istanbul')::date
                END
  WHERE o.sent_on IS NULL AND o.status NOT IN ('draft', 'cancelled');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % siparişin gönderim tarihi oluşturulma gününden yaklaşık olarak dolduruldu.', v_n;
  END IF;

  UPDATE public.lab_orders o
  SET received_on = o.delivery_date
  WHERE o.received_on IS NULL AND o.delivery_date IS NOT NULL AND o.status IN ('ready', 'delivered');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % siparişin kliniğe geliş tarihi eski teslim tarihinden yaklaşık olarak dolduruldu.', v_n;
  END IF;

  -- A 'ready' order has not reached the patient: its old arrival date now lives in received_on, and delivery_date
  -- ("Hastaya teslim") is cleared. Delivered orders keep it as the approximate delivery day.
  UPDATE public.lab_orders o
  SET delivery_date = NULL
  WHERE o.status = 'ready' AND o.delivery_date IS NOT NULL AND o.received_on IS NOT NULL
    AND o.received_on = o.delivery_date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % "Kliniğe geldi" siparişinin eski tarihi kliniğe geliş tarihine taşındı (hastaya teslim boş).', v_n;
  END IF;

  UPDATE public.lab_orders o
  SET cancelled_at = o.updated_at
  WHERE o.status = 'cancelled' AND o.cancelled_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'lab_orders: % iptal edilmiş siparişin iptal zamanı son güncelleme zamanından dolduruldu.', v_n;
  END IF;
END $$;

ALTER TABLE public.lab_orders ALTER COLUMN status SET NOT NULL;

-- Rules that the back-filled rows must meet (NOT VALID, validated when every row passes; CR:21-22).
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_dates_order',
  'CHECK ((received_on IS NULL OR sent_on IS NULL OR received_on >= sent_on)
          AND (delivery_date IS NULL OR received_on IS NULL OR delivery_date >= received_on)
          AND (last_try_in_on IS NULL OR sent_on IS NULL OR last_try_in_on >= sent_on))', true);
SELECT public.clin__add_constraint('lab_orders', 'lab_orders_cancel_shape',
  'CHECK ((status = ''cancelled'') = (cancelled_at IS NOT NULL))', true);

-- FK rules (0019 §9 rationale): deleting a patient or doctor must not wipe lab orders. NO ACTION is checked at the
-- end of the statement, so a clinic delete (clinic -> patients CASCADE and clinic -> lab_orders CASCADE in the
-- same statement) still works; a direct patient / doctor delete that would orphan lab orders fails.
-- The FKs are found by column, not by name: any FK on lab_orders.patient_id / doctor_id that is not NO ACTION
-- (whatever its name, e.g. after a manual repair) is dropped, then the NO ACTION FK is ensured under the default name.
DO $$
DECLARE
  fk record;
  c record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('lab_orders_patient_id_fkey', 'patient_id', 'patients'),
      ('lab_orders_doctor_id_fkey', 'doctor_id', 'doctors')
    ) AS t(conname, col, ref)
  LOOP
    FOR c IN
      SELECT k.conname
      FROM pg_constraint k
      WHERE k.conrelid = 'public.lab_orders'::regclass AND k.contype = 'f'
        AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                              WHERE a.attrelid = 'public.lab_orders'::regclass AND a.attname = fk.col)]::smallint[]
        AND (k.confdeltype <> 'a' OR k.confrelid <> format('public.%I', fk.ref)::regclass)
    LOOP
      EXECUTE format('ALTER TABLE public.lab_orders DROP CONSTRAINT %I', c.conname);
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint k
      WHERE k.conrelid = 'public.lab_orders'::regclass AND k.contype = 'f'
        AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                              WHERE a.attrelid = 'public.lab_orders'::regclass AND a.attname = fk.col)]::smallint[]
        AND k.confrelid = format('public.%I', fk.ref)::regclass AND k.confdeltype = 'a'
    ) THEN
      EXECUTE format('ALTER TABLE public.lab_orders DROP CONSTRAINT IF EXISTS %I', fk.conname);
      EXECUTE format('ALTER TABLE public.lab_orders ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id)
                      ON DELETE NO ACTION NOT VALID', fk.conname, fk.col, fk.ref);
      EXECUTE format('ALTER TABLE public.lab_orders VALIDATE CONSTRAINT %I', fk.conname);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4.1 / 4.2 Row level security and table privileges. Supabase grants ALL on public tables to anon / authenticated
--     by default, so every table gets an explicit revoke and SELECT for authenticated only. Every existing policy
--     goes (including the 0009 / 0017 lab write policies); exactly one SELECT policy each remains.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v record;
  q record;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('implant_brands', 'implant_brands_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('labs', 'labs_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('patient_implants', 'patient_implants_select',
       'clinic_id = (SELECT public.current_clinic_id())
        AND (deleted_at IS NULL OR (SELECT public.current_app_role()) IN (''owner'', ''admin''))'),
      ('lab_order_events', 'lab_order_events_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('lab_order_costs', 'lab_order_costs_select',
       'clinic_id = (SELECT public.current_clinic_id()) AND (SELECT public.clin_can_view_lab_costs())'),
      ('clinical_settings', 'clinical_settings_select', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('lab_orders', 'lab_orders_clinic_isolation', 'clinic_id = (SELECT public.current_clinic_id())'),
      ('lab_order_items', 'lab_order_items_clinic_isolation', 'clinic_id = (SELECT public.current_clinic_id())')
    ) AS t(tbl, pol, expr)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v.tbl);
    FOR q IN SELECT p.policyname FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v.tbl LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', q.policyname, v.tbl);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', v.pol, v.tbl, v.expr);
    -- Revoking the table privilege also revokes every column privilege.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v.tbl);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v.tbl);
  END LOOP;
END $$;

REVOKE ALL ON SEQUENCE public.lab_order_number_seq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4.3 Audit: audit_row_change() (0019) on every clinical table (lab_order_events is itself history). Attached only
--     now, after the back-fill. Cost audit rows only for lab cost viewers: a RESTRICTIVE gate ANDed with the
--     existing audit_logs policies, which are not recreated here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['implant_brands', 'labs', 'patient_implants', 'lab_orders', 'lab_order_items',
                             'lab_order_costs', 'clinical_settings']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', v_t);
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()', v_t);
  END LOOP;
END $$;

-- The audit_logs RESTRICTIVE gate itself is created near the end of this file (just before the self-checks):
-- DROP / CREATE POLICY takes an ACCESS EXCLUSIVE lock on audit_logs until COMMIT, and every audited write of the
-- clinic (payments, finance, stock, users) waits on it, so the lock window is kept as short as possible.

-- ---------------------------------------------------------------------------
-- 6.0 Read internals. Plain LANGUAGE sql STABLE without SECURITY DEFINER / SET clause, every name schema-qualified,
--     so the planner can inline them (0024 §5.0 pattern). Only ever called from SECURITY DEFINER functions. Patient
--     names come from patients.full_name by join, for display only; they are never copied into a row. Lab statuses
--     are compared as text (see the header).
-- ---------------------------------------------------------------------------

-- Allowed next lab statuses for one status (§1.5), in display order.
CREATE OR REPLACE FUNCTION public.clin__lab_allowed_next(p text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(pg_catalog.jsonb_agg(u.t ORDER BY u.o), '[]'::jsonb)
  FROM pg_catalog.unnest(ARRAY['submitted', 'in_progress', 'try_in', 'revision', 'ready', 'delivered', 'cancelled'])
         WITH ORDINALITY AS u(t, o)
  WHERE public.clin__lab_transition_ok(p, u.t)
$$;

-- D2 switch; a missing row reads as OFF.
CREATE OR REPLACE FUNCTION public.clin__payable_enabled(p_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((SELECT s.lab_cost_payable_enabled FROM public.clinical_settings s WHERE s.clinic_id = p_clinic), false)
$$;

-- §6.9 settings JSON; a missing row reads as {false, version 0}.
CREATE OR REPLACE FUNCTION public.clin__settings_json(p_clinic uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'lab_cost_payable_enabled', coalesce(s.lab_cost_payable_enabled, false),
           'version', coalesce(s.version, 0),
           'updated_at', s.updated_at,
           'updated_by_name', u.full_name)
  FROM (SELECT p_clinic AS cid) k
  LEFT JOIN public.clinical_settings s ON s.clinic_id = k.cid
  LEFT JOIN public.users u ON u.id = s.updated_by
$$;

-- §6.1 implant row of every implant of the clinic, plus the columns the read RPCs filter and sort on.
-- stock_state: null (external) | issued | correction_pending | corrected | returned.
CREATE OR REPLACE FUNCTION public.clin__implant_rows(p_clinic uuid, p_today date)
RETURNS TABLE (id uuid, patient_id uuid, doctor_id uuid, brand_id uuid, appointment_id uuid, tooth_fdi integer,
               status text, stock_source text, placed_on date, next_control_on date, created_at timestamptz,
               deleted_at timestamptz, control_due boolean, search text, j jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT pi.id, pi.patient_id, pi.doctor_id, pi.brand_id, pi.appointment_id, pi.tooth_fdi::integer, pi.status,
         pi.stock_source, pi.placed_on, pi.next_control_on, pi.created_at, pi.deleted_at, x.control_due,
         public.clin__tr_lower(concat_ws(' ', p.full_name, b.name, pi.model, pi.lot_text, pi.serial_text,
                                         pi.tooth_fdi::text)),
         pg_catalog.jsonb_build_object(
           'id', pi.id, 'patient_id', pi.patient_id, 'patient_name', p.full_name,
           'tooth_fdi', pi.tooth_fdi,
           'brand_id', pi.brand_id, 'brand_name', b.name, 'brand_active', b.is_active,
           'model', pi.model, 'diameter_mm', public.clin__q(pi.diameter_mm),
           'length_mm', public.clin__q(pi.length_mm),
           'placed_on', pi.placed_on,
           'doctor_id', pi.doctor_id, 'doctor_name', du.full_name,
           'appointment_id', pi.appointment_id, 'appointment_start', a.start_time,
           'stock_source', pi.stock_source, 'source_note', pi.source_note)
         || pg_catalog.jsonb_build_object(
           'stock_item_id', pi.stock_item_id, 'item_name', si.item_name,
           'batch_id', pi.batch_id, 'expiry_date', bt.expiry_date,
           'stock_movement_id', pi.stock_movement_id, 'movement_ref_no', m.ref_no,
           'stock_state', CASE WHEN pi.stock_source <> 'stock' THEN NULL
                               WHEN coalesce(cs.approved, false) THEN 'corrected'
                               WHEN rt.returned THEN 'returned'
                               WHEN coalesce(cs.pending, false) THEN 'correction_pending'
                               ELSE 'issued' END,
           'stock_correction', CASE WHEN cr.id IS NULL THEN NULL
                                    ELSE pg_catalog.jsonb_build_object('id', cr.id, 'ref_no', cr.ref_no,
                                                                       'status', cr.status) END,
           'lot_text', pi.lot_text, 'serial_text', pi.serial_text,
           'torque_ncm', public.clin__q(pi.torque_ncm),
           'next_control_on', pi.next_control_on, 'control_due', x.control_due,
           'status', pi.status, 'notes', pi.notes, 'version', pi.version)
         || pg_catalog.jsonb_build_object(
           'created_at', pi.created_at, 'created_by_name', cu.full_name,
           'updated_at', pi.updated_at, 'updated_by_name', uu.full_name,
           'deleted_at', pi.deleted_at, 'deleted_by_name', xu.full_name, 'delete_reason', pi.delete_reason)
  FROM public.patient_implants pi
  JOIN public.patients p ON p.id = pi.patient_id
  JOIN public.implant_brands b ON b.id = pi.brand_id
  LEFT JOIN public.doctors d ON d.id = pi.doctor_id
  LEFT JOIN public.users du ON du.id = d.user_id
  LEFT JOIN public.appointments a ON a.id = pi.appointment_id
  LEFT JOIN public.stock_items si ON si.id = pi.stock_item_id
  LEFT JOIN public.stock_batches bt ON bt.id = pi.batch_id
  LEFT JOIN public.stock_movements m ON m.id = pi.stock_movement_id
  LEFT JOIN public.users cu ON cu.id = pi.created_by
  LEFT JOIN public.users uu ON uu.id = pi.updated_by
  LEFT JOIN public.users xu ON xu.id = pi.deleted_by
  CROSS JOIN LATERAL (
    SELECT (pi.deleted_at IS NULL AND pi.next_control_on IS NOT NULL AND pi.next_control_on <= p_today
            AND pi.status IN ('healing', 'prosthetic', 'follow_up')) AS control_due
  ) x
  LEFT JOIN LATERAL (
    SELECT bool_or(r.status = 'approved') AS approved, bool_or(r.status = 'pending') AS pending
    FROM public.stock_correction_requests r
    WHERE pi.stock_movement_id IS NOT NULL AND r.movement_id = pi.stock_movement_id
  ) cs ON true
  LEFT JOIN LATERAL (
    SELECT r.id, r.ref_no, r.status
    FROM public.stock_correction_requests r
    WHERE pi.stock_movement_id IS NOT NULL AND r.movement_id = pi.stock_movement_id
    ORDER BY (r.status IN ('pending', 'approved')) DESC, r.created_at DESC, r.id
    LIMIT 1
  ) cr ON true
  CROSS JOIN LATERAL (
    SELECT EXISTS (SELECT 1 FROM public.stock_movements r
                   WHERE pi.stock_movement_id IS NOT NULL AND r.source_movement_id = pi.stock_movement_id
                     AND r.movement_type = 'return') AS returned
  ) rt
  WHERE pi.clinic_id = p_clinic
$$;

-- §6.1 one implant (any state); NULL when it is not in the clinic.
CREATE OR REPLACE FUNCTION public.clin__implant_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT r.j FROM public.clin__implant_rows(p_clinic, public.clinic_today()) r WHERE r.id = p_id
$$;

-- §6.6 lab order row of every order of the clinic. cost key only when p_can_cost (null when no cost row, absent
-- otherwise); fin_entry_id only when p_can_fin_read. A posted cost whose finance entry was cancelled counts as not
-- posted (payable_state from the live entry).
CREATE OR REPLACE FUNCTION public.clin__lab_order_rows(p_clinic uuid, p_today date, p_can_cost boolean,
                                                       p_can_fin_read boolean, p_payable_enabled boolean)
RETURNS TABLE (id uuid, status text, patient_id uuid, doctor_id uuid, lab_id uuid, due_date date, sent_on date,
               delivery_date date, created_at timestamptz, is_late boolean, payable_state text, search text, j jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT o.id, o.status::text, o.patient_id, o.doctor_id, o.lab_id, o.due_date, o.sent_on, o.delivery_date,
         o.created_at, x.is_late, x.payable_state,
         public.clin__tr_lower(concat_ws(' ', o.order_number, p.full_name, coalesce(l.name, o.lab_name), it.labels)),
         pg_catalog.jsonb_build_object(
           'id', o.id, 'order_number', o.order_number, 'status', o.status::text,
           'status_label', public.clin__lab_status_label(o.status::text),
           'patient_id', o.patient_id, 'patient_name', p.full_name,
           'doctor_id', o.doctor_id, 'doctor_name', du.full_name,
           'lab_id', o.lab_id, 'lab_name', coalesce(l.name, nullif(btrim(o.lab_name), '')),
           'lab_active', l.is_active, 'lab_phone', l.phone,
           'treatment_plan_id', o.treatment_plan_id,
           'due_date', o.due_date, 'sent_on', o.sent_on, 'received_on', o.received_on,
           'delivery_date', o.delivery_date)
         || pg_catalog.jsonb_build_object(
           'last_try_in_on', o.last_try_in_on, 'revision_count', o.revision_count,
           'is_late', x.is_late, 'days_late', CASE WHEN x.is_late THEN (p_today - o.due_date) ELSE 0 END,
           'notes', coalesce(o.notes, ''), 'cancel_reason', o.cancel_reason,
           'item_count', coalesce(it.n, 0), 'items_summary', coalesce(it.summary, ''),
           'allowed_next', public.clin__lab_allowed_next(o.status::text),
           'version', o.version, 'created_at', o.created_at, 'updated_at', o.updated_at)
         || CASE WHEN p_can_cost THEN
              pg_catalog.jsonb_build_object('cost',
                CASE WHEN c.lab_order_id IS NULL THEN NULL
                     ELSE pg_catalog.jsonb_build_object(
                            'amount_cents', c.amount_cents, 'note', c.note, 'version', c.version,
                            'payable_state', x.payable_state,
                            'posted_at', CASE WHEN x.payable_state = 'posted' THEN c.posted_at END)
                          || CASE WHEN p_can_fin_read
                                  THEN pg_catalog.jsonb_build_object(
                                         'fin_entry_id', CASE WHEN x.payable_state = 'posted' THEN c.fin_entry_id END)
                                  ELSE '{}'::jsonb END
                END)
            ELSE '{}'::jsonb END
  FROM public.lab_orders o
  JOIN public.patients p ON p.id = o.patient_id
  LEFT JOIN public.doctors d ON d.id = o.doctor_id
  LEFT JOIN public.users du ON du.id = d.user_id
  LEFT JOIN public.labs l ON l.id = o.lab_id
  LEFT JOIN public.lab_order_costs c ON c.lab_order_id = o.id
  LEFT JOIN public.fin_entries fe ON fe.id = c.fin_entry_id
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS n,
           string_agg(public.clin__lab_item_label(i.item_type)
                      || CASE WHEN coalesce(i.quantity, 1) > 1 THEN ' ×' || i.quantity::text ELSE '' END
                      || CASE WHEN coalesce(btrim(i.tooth_number), '') <> '' THEN ' (' || btrim(i.tooth_number) || ')'
                              ELSE '' END,
                      ' · ' ORDER BY i.created_at, i.id) AS summary,
           string_agg(public.clin__lab_item_label(i.item_type), ' ') AS labels
    FROM public.lab_order_items i
    WHERE i.lab_order_id = o.id
  ) it ON true
  CROSS JOIN LATERAL (
    SELECT (public.clin__lab_is_out(o.status::text) AND o.due_date < p_today) AS is_late,
           CASE WHEN c.lab_order_id IS NULL THEN NULL
                WHEN c.fin_entry_id IS NOT NULL AND fe.cancelled_at IS NULL THEN 'posted'
                WHEN p_payable_enabled THEN 'awaiting_finance'
                ELSE 'off' END AS payable_state
  ) x
  WHERE o.clinic_id = p_clinic
$$;

CREATE OR REPLACE FUNCTION public.clin__lab_order_json(p_clinic uuid, p_id uuid, p_can_cost boolean,
                                                       p_can_fin_read boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT r.j
  FROM public.clin__lab_order_rows(p_clinic, public.clinic_today(), p_can_cost, p_can_fin_read,
                                   public.clin__payable_enabled(p_clinic)) r
  WHERE r.id = p_id
$$;

-- §6.5 consumption rows (Sarf): issues with a patient and no approved correction (a corrected original is replaced
-- by its re-entry, which is an issue of the same patient); returns reduce the net quantity. Cost keys only when
-- p_can_cost (0024 stock_can_view_costs) and the batch has a cost.
CREATE OR REPLACE FUNCTION public.clin__material_rows(p_clinic uuid, p_can_cost boolean)
RETURNS TABLE (movement_id uuid, patient_id uuid, appointment_id uuid, stock_item_id uuid, item_name text,
               usage_unit text, effective_at timestamptz, ref_no bigint, net_qty numeric, cost_cents bigint, j jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT m.id, m.patient_id, m.appointment_id, m.stock_item_id, i.item_name, i.usage_unit, m.effective_at, m.ref_no,
         x.net_qty, x.cost_cents,
         pg_catalog.jsonb_build_object(
           'movement_id', m.id, 'ref_no', m.ref_no, 'effective_at', m.effective_at,
           'stock_item_id', m.stock_item_id, 'item_name', i.item_name, 'usage_unit', i.usage_unit,
           'tracking_level', i.tracking_level,
           'lot_number', b.lot_number, 'serial_number', b.serial_number, 'expiry_date', b.expiry_date,
           'quantity', public.clin__q(m.quantity), 'returned_qty', public.clin__q(rt.q),
           'net_qty', public.clin__q(x.net_qty), 'patient_id', m.patient_id)
         || pg_catalog.jsonb_build_object(
           'doctor_id', m.doctor_id, 'doctor_name', du.full_name,
           'appointment_id', m.appointment_id, 'appointment_start', a.start_time,
           'from_location_name', lf.name, 'actor_name', au.full_name,
           'implant_id', pi.id, 'implant_tooth', pi.tooth_fdi,
           'is_reentry', (m.correction_request_id IS NOT NULL), 'correction_status', cs.status)
         || CASE WHEN p_can_cost AND bc.unit_cost_cents IS NOT NULL
                 THEN pg_catalog.jsonb_build_object('unit_cost_cents', bc.unit_cost_cents, 'cost_cents', x.cost_cents)
                 ELSE '{}'::jsonb END
  FROM public.stock_movements m
  JOIN public.stock_items i ON i.id = m.stock_item_id
  JOIN public.stock_batches b ON b.id = m.batch_id
  LEFT JOIN public.stock_batch_costs bc ON bc.batch_id = m.batch_id AND p_can_cost
  LEFT JOIN public.doctors d ON d.id = m.doctor_id
  LEFT JOIN public.users du ON du.id = d.user_id
  LEFT JOIN public.appointments a ON a.id = m.appointment_id
  LEFT JOIN public.stock_locations lf ON lf.id = m.from_location_id
  LEFT JOIN public.users au ON au.id = m.actor_user_id
  LEFT JOIN public.patient_implants pi ON pi.stock_movement_id = m.id AND pi.deleted_at IS NULL
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(r.quantity), 0)::numeric AS q
    FROM public.stock_movements r
    WHERE r.source_movement_id = m.id AND r.movement_type = 'return'
  ) rt
  CROSS JOIN LATERAL (
    SELECT CASE WHEN bool_or(cr.status = 'pending') THEN 'pending'
                WHEN bool_or(cr.status = 'rejected') THEN 'rejected' END AS status
    FROM public.stock_correction_requests cr
    WHERE cr.movement_id = m.id
  ) cs
  CROSS JOIN LATERAL (
    SELECT greatest(m.quantity - rt.q, 0)::numeric AS net_qty,
           CASE WHEN bc.unit_cost_cents IS NOT NULL
                THEN round(greatest(m.quantity - rt.q, 0) * bc.unit_cost_cents)::bigint END AS cost_cents
  ) x
  WHERE m.clinic_id = p_clinic
    AND m.movement_type = 'issue'
    AND m.patient_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.stock_correction_requests ap
                    WHERE ap.movement_id = m.id AND ap.status = 'approved')
$$;

-- Normalised lab items (§5.7): JSON array of 1..30 objects with only the six known keys; returns the array with
-- every key present ('' for blank texts, quantity 1 when absent). Anything else -> CL_LAB_ITEMS.
CREATE OR REPLACE FUNCTION public.clin__lab_items(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  e jsonb;
  v_out jsonb := '[]'::jsonb;
  v_type text;
  v_tooth text;
  v_mat text;
  v_color text;
  v_desc text;
  v_qty_txt text;
  v_qty integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 30 THEN
    PERFORM public.clin__raise('CL_LAB_ITEMS');
  END IF;
  FOR e IN SELECT x.v FROM jsonb_array_elements(p) WITH ORDINALITY AS x(v, o) ORDER BY x.o LOOP
    IF jsonb_typeof(e) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) AS k(k_name)
                  WHERE k.k_name NOT IN ('item_type', 'tooth_number', 'material', 'color_code', 'quantity', 'description'))
       OR EXISTS (SELECT 1 FROM jsonb_each(e) AS f(k, v)
                  WHERE f.k <> 'quantity' AND jsonb_typeof(f.v) NOT IN ('string', 'null'))
       OR (e ? 'quantity' AND jsonb_typeof(e -> 'quantity') NOT IN ('number', 'null')) THEN
      PERFORM public.clin__raise('CL_LAB_ITEMS');
    END IF;
    v_type := btrim(coalesce(e ->> 'item_type', ''));
    v_tooth := btrim(coalesce(e ->> 'tooth_number', ''));
    v_mat := btrim(coalesce(e ->> 'material', ''));
    v_color := btrim(coalesce(e ->> 'color_code', ''));
    v_desc := btrim(coalesce(e ->> 'description', ''));
    v_qty_txt := e ->> 'quantity';
    IF v_qty_txt IS NULL THEN
      v_qty := 1;
    ELSIF v_qty_txt ~ '^[0-9]{1,2}$' THEN
      v_qty := v_qty_txt::integer;
    ELSE
      v_qty := 0;
    END IF;
    IF v_type NOT IN ('crown', 'bridge', 'denture', 'implant_crown', 'other')
       OR char_length(v_tooth) > 60 OR v_tooth !~ '^[0-9 ,/-]*$'
       OR v_mat NOT IN ('', 'zirconium', 'ceramic', 'composite', 'metal')
       OR char_length(v_color) > 20
       OR char_length(v_desc) > 500
       OR v_qty NOT BETWEEN 1 AND 99 THEN
      PERFORM public.clin__raise('CL_LAB_ITEMS');
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'item_type', v_type, 'tooth_number', v_tooth, 'material', v_mat, 'color_code', v_color,
      'quantity', v_qty, 'description', v_desc));
  END LOOP;
  RETURN v_out;
END;
$$;

-- The same normalised shape WITHOUT validation (never raises): used on edit to detect "items unchanged" before the
-- strict rules run, so an old order whose items predate them (free-text tooth such as '16 ve 17', long colour code,
-- unknown type) can still get a notes-only edit. NULL when p is not an array. A non-integer quantity yields NULL
-- (never equal to a stored row), so changed or malformed input always reaches clin__lab_items.
CREATE OR REPLACE FUNCTION public.clin__lab_items_norm(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p IS NULL OR pg_catalog.jsonb_typeof(p) <> 'array' THEN NULL
              WHEN EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p) AS y(w)
                           WHERE pg_catalog.jsonb_typeof(y.w) <> 'object') THEN NULL
         ELSE coalesce((
           SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'item_type', btrim(coalesce(x.v ->> 'item_type', '')),
                    'tooth_number', btrim(coalesce(x.v ->> 'tooth_number', '')),
                    'material', btrim(coalesce(x.v ->> 'material', '')),
                    'color_code', btrim(coalesce(x.v ->> 'color_code', '')),
                    'quantity', CASE WHEN NOT (x.v ? 'quantity') OR pg_catalog.jsonb_typeof(x.v -> 'quantity') = 'null' THEN 1
                                     WHEN pg_catalog.jsonb_typeof(x.v -> 'quantity') = 'number'
                                          AND (x.v ->> 'quantity') ~ '^-?[0-9]{1,9}$'
                                     THEN (x.v ->> 'quantity')::integer
                                END,
                    'description', btrim(coalesce(x.v ->> 'description', '')))
                  ORDER BY x.o)
           FROM pg_catalog.jsonb_array_elements(p) WITH ORDINALITY AS x(v, o)
         ), '[]'::jsonb) END
$$;

-- The stored items of an order in the same normalised shape (creation order), for "items unchanged" checks.
CREATE OR REPLACE FUNCTION public.clin__lab_items_stored(p_order uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'item_type', coalesce(btrim(i.item_type), ''), 'tooth_number', coalesce(btrim(i.tooth_number), ''),
           'material', coalesce(btrim(i.material), ''), 'color_code', coalesce(btrim(i.color_code), ''),
           'quantity', coalesce(i.quantity, 1), 'description', coalesce(btrim(i.description), ''))
           ORDER BY i.created_at, i.id), '[]'::jsonb)
  FROM public.lab_order_items i
  WHERE i.lab_order_id = p_order
$$;

-- Replace-all of an order's items (only called when the normalised array differs). created_at is spread by the
-- array position so the stored order is the order the user entered.
CREATE OR REPLACE FUNCTION public.clin__lab_items_replace(p_clinic uuid, p_order uuid, p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.lab_order_items i WHERE i.lab_order_id = p_order AND i.clinic_id = p_clinic;
  INSERT INTO public.lab_order_items (id, clinic_id, lab_order_id, item_type, description, tooth_number, material,
                                      color_code, quantity, created_at)
  SELECT gen_random_uuid(), p_clinic, p_order, x.v ->> 'item_type', nullif(x.v ->> 'description', ''),
         nullif(x.v ->> 'tooth_number', ''), nullif(x.v ->> 'material', ''), nullif(x.v ->> 'color_code', ''),
         (x.v ->> 'quantity')::integer, now() + (x.o::double precision * interval '1 microsecond')
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(v, o);
END;
$$;

-- A cost row's finance link is live only while its entry is not cancelled. A dead link (entry cancelled in the
-- finance screen) is cleared, so the cost counts as not posted again. Returns the live entry id or NULL.
CREATE OR REPLACE FUNCTION public.clin__cost_live_entry(p_clinic uuid, p_order uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry uuid;
  v_cancelled timestamptz;
BEGIN
  SELECT c.fin_entry_id INTO v_entry
  FROM public.lab_order_costs c WHERE c.lab_order_id = p_order AND c.clinic_id = p_clinic;
  IF v_entry IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT e.cancelled_at INTO v_cancelled FROM public.fin_entries e WHERE e.id = v_entry AND e.clinic_id = p_clinic;
  IF v_cancelled IS NULL THEN
    RETURN v_entry;
  END IF;
  -- The version is not bumped: the client's cost version stays valid (the JSON already showed it as not posted).
  UPDATE public.lab_order_costs
  SET fin_entry_id = NULL, posted_at = NULL, posted_by = NULL, updated_at = now()
  WHERE lab_order_id = p_order AND clinic_id = p_clinic;
  RETURN NULL;
END;
$$;

-- §5.14 Payable posting core. Preconditions are checked by the callers ('finance', setting on, cost not posted, order
-- and cost locked). KVKK: the description never contains the patient name.
CREATE OR REPLACE FUNCTION public.clin__post_lab_cost(p_clinic uuid, p_order uuid, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cat uuid;
  v_o public.lab_orders%ROWTYPE;
  v_amount bigint;
  v_lab_name text;
  v_cp uuid;
  v_cp_text text;
  v_n integer;
  v_id uuid := gen_random_uuid();
BEGIN
  SELECT k.id INTO v_cat
  FROM public.fin_categories k
  WHERE k.clinic_id = p_clinic AND k.report_bucket = 'lab' AND k.is_system AND k.is_active
  ORDER BY k.id
  LIMIT 1;
  IF v_cat IS NULL THEN
    PERFORM public.clin__raise('CL_FIN_CATEGORY');
  END IF;

  SELECT * INTO v_o FROM public.lab_orders o WHERE o.id = p_order AND o.clinic_id = p_clinic;
  SELECT c.amount_cents INTO v_amount FROM public.lab_order_costs c WHERE c.lab_order_id = p_order AND c.clinic_id = p_clinic;
  IF v_o.id IS NULL OR v_amount IS NULL THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  -- A draft never went to the lab, so nothing is owed yet. A cancelled job may still be billed by the lab, so an
  -- explicit post stays possible (clin_lab_order_set_cost never auto-posts it).
  IF v_o.status::text = 'draft' THEN
    PERFORM public.clin__raise('CL_LAB_COST_DRAFT');
  END IF;

  SELECT l.name, fc.id INTO v_lab_name, v_cp
  FROM public.labs l
  LEFT JOIN public.fin_counterparties fc
    ON fc.id = l.fin_counterparty_id AND fc.clinic_id = p_clinic AND fc.is_active
  WHERE l.id = v_o.lab_id AND l.clinic_id = p_clinic;
  IF v_cp IS NULL THEN
    v_cp_text := coalesce(nullif(btrim(left(btrim(coalesce(v_lab_name, v_o.lab_name, '')), 200)), ''), 'Laboratuvar');
  END IF;

  -- A re-post after a removal (whose entry was cancelled, never deleted) gets the next key; the key is unique per
  -- clinic (0020 fin_entries_source_key), so a double post fails loudly.
  SELECT count(*) INTO v_n
  FROM public.fin_entries e
  WHERE e.clinic_id = p_clinic
    AND left(e.source_key, char_length('clin_lab_order:' || p_order::text || ':'))
        = 'clin_lab_order:' || p_order::text || ':';

  INSERT INTO public.fin_entries (id, clinic_id, category_id, counterparty_id, counterparty_text, description,
                                  due_date, amount_cents, source_key, created_by, updated_by)
  VALUES (v_id, p_clinic, v_cat, v_cp, v_cp_text, 'Laboratuvar işi ' || v_o.order_number,
          least(coalesce(v_o.received_on, public.clinic_today()), DATE '2100-12-31'), v_amount,
          'clin_lab_order:' || p_order::text || ':' || (v_n + 1)::text, p_actor, p_actor);

  UPDATE public.lab_order_costs
  SET fin_entry_id = v_id, posted_at = now(), posted_by = p_actor, version = version + 1, updated_by = p_actor,
      updated_at = now()
  WHERE lab_order_id = p_order AND clinic_id = p_clinic;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.13 Test clean-up (editor only). Removes every clinical row of one acceptance-harness clinic (slug
--      'p<n>-test-...'), including the finance entries posted from its lab costs, then the stock rows through
--      stock__purge_test_clinic (which ends with SET CONSTRAINTS ALL IMMEDIATE, so the deferred implant / movement
--      links are checked with both sides gone). Granted to service_role only; real clinics are refused by slug.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clin__purge_test_clinic(p_clinic uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_slug text;
  v_n bigint;
  v_out jsonb := '{}'::jsonb;
  v_stock jsonb;
BEGIN
  IF NOT public.stock__is_editor() THEN
    PERFORM public.clin__raise('CL_HISTORY');
  END IF;
  SELECT c.slug INTO v_slug FROM public.clinics c WHERE c.id = p_clinic;
  IF v_slug IS NULL THEN
    RETURN jsonb_build_object('clinic_id', p_clinic, 'found', false);
  END IF;
  IF v_slug !~ '^p[0-9]+-test-' THEN
    RAISE EXCEPTION 'clin__purge_test_clinic yalnızca test klinikleri için çalışır (slug p<n>-test-...): %', v_slug;
  END IF;

  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';

  DELETE FROM public.fin_payments fp
  WHERE fp.clinic_id = p_clinic
    AND fp.entry_id IN (SELECT e.id FROM public.fin_entries e
                        WHERE e.clinic_id = p_clinic AND e.source_key LIKE 'clin\_lab\_order:%');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('fin_payments', v_n);

  DELETE FROM public.lab_order_costs WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('lab_order_costs', v_n);

  DELETE FROM public.fin_entries e WHERE e.clinic_id = p_clinic AND e.source_key LIKE 'clin\_lab\_order:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('fin_entries', v_n);

  DELETE FROM public.lab_order_events WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('lab_order_events', v_n);

  DELETE FROM public.lab_order_items WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('lab_order_items', v_n);

  DELETE FROM public.lab_orders WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('lab_orders', v_n);

  DELETE FROM public.patient_implants WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('patient_implants', v_n);

  DELETE FROM public.implant_brands WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('implant_brands', v_n);

  DELETE FROM public.labs WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('labs', v_n);

  DELETE FROM public.clinical_settings WHERE clinic_id = p_clinic;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('clinical_settings', v_n);

  v_stock := public.stock__purge_test_clinic(p_clinic);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  RETURN jsonb_build_object('clinic_id', p_clinic, 'found', true, 'deleted', v_out, 'stock', v_stock);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Write RPCs. SECURITY DEFINER, SET search_path = public, granted to authenticated only (clin__harden_privileges).
--    Skeleton: gate; idempotency (operation key or client id) and replay; scalar validation; locks; re-validation
--    against locked rows; writes; result JSON with ok = true (creates also return already_saved).
-- ---------------------------------------------------------------------------

-- Directory JSON helpers (internal).
-- The active directory brand named by a stock card's free-text brand (same match as clin_implant_stock_options'
-- brand_id), or NULL when the card has no brand or no active directory brand has that name.
CREATE OR REPLACE FUNCTION public.clin__stock_item_brand(p_clinic uuid, p_item uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT ib.id
  FROM public.stock_items i
  JOIN public.implant_brands ib
    ON ib.clinic_id = p_clinic AND ib.is_active AND ib.name_key = public.clin__tr_lower(btrim(i.brand))
  WHERE i.id = p_item AND i.clinic_id = p_clinic AND nullif(btrim(i.brand), '') IS NOT NULL
  ORDER BY ib.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.clin__brand_json(p_clinic uuid, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'id', b.id, 'name', b.name, 'is_active', b.is_active, 'version', b.version,
           'implant_count', (SELECT count(*) FROM public.patient_implants pi
                             WHERE pi.brand_id = b.id AND pi.clinic_id = b.clinic_id AND pi.deleted_at IS NULL))
  FROM public.implant_brands b
  WHERE b.id = p_id AND b.clinic_id = p_clinic
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
                                  AND o.status::text NOT IN ('delivered', 'cancelled')))
         || CASE WHEN p_fin_read THEN pg_catalog.jsonb_build_object('fin_counterparty_name', fc.name)
                 ELSE '{}'::jsonb END
  FROM public.labs l
  LEFT JOIN public.fin_counterparties fc ON fc.id = l.fin_counterparty_id
  WHERE l.id = p_id AND l.clinic_id = p_clinic
$$;

-- 5.1 Implant brand: create (p_version NULL, client id, idempotent) or edit (optimistic version).
CREATE OR REPLACE FUNCTION public.clin_save_implant_brand(p_id uuid, p_version integer, p_name text,
                                                          p_is_active boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_actor uuid := public.current_app_user_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_row public.implant_brands%ROWTYPE;
  v_constraint text;
  v_already boolean := false;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    PERFORM public.clin__raise('CL_BRAND_NAME');
  END IF;

  IF p_version IS NULL THEN
    IF p_id IS NULL THEN
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END IF;
    SELECT * INTO v_row FROM public.implant_brands b WHERE b.id = p_id;
    IF FOUND THEN
      IF v_row.clinic_id = v_clinic AND v_row.name_key = public.clin__tr_lower(v_name)
         AND v_row.created_by IS NOT DISTINCT FROM v_actor THEN
        v_already := true;
      ELSE
        PERFORM public.clin__raise('CL_ID_TAKEN');
      END IF;
    ELSE
      BEGIN
        INSERT INTO public.implant_brands (id, clinic_id, name, name_key, is_active, created_by, updated_by)
        VALUES (p_id, v_clinic, v_name, public.clin__tr_lower(v_name), coalesce(p_is_active, true), v_actor, v_actor);
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'implant_brands_name_key' THEN
          PERFORM public.clin__raise('CL_BRAND_TAKEN');
        END IF;
        PERFORM public.clin__raise('CL_ID_TAKEN');
      END;
    END IF;
  ELSE
    SELECT * INTO v_row FROM public.implant_brands b WHERE b.id = p_id AND b.clinic_id = v_clinic FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.clin__raise('CL_NOT_FOUND');
    END IF;
    IF v_row.version <> p_version THEN
      PERFORM public.clin__raise('CL_VERSION');
    END IF;
    IF v_row.name IS DISTINCT FROM v_name OR v_row.is_active IS DISTINCT FROM coalesce(p_is_active, v_row.is_active) THEN
      BEGIN
        UPDATE public.implant_brands
        SET name = v_name, is_active = coalesce(p_is_active, is_active), version = version + 1,
            updated_by = v_actor, updated_at = now()
        WHERE id = p_id;
      EXCEPTION WHEN unique_violation THEN
        PERFORM public.clin__raise('CL_BRAND_TAKEN');
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'brand', public.clin__brand_json(v_clinic, p_id), 'already_saved', v_already);
END;
$$;

-- 5.2 Laboratory: as 5.1, plus contact fields and the finance link (finance holders only; a non-finance edit that
-- sends the stored link unchanged passes). A 'finance' holder without the clinical write right may change the
-- finance link of an existing lab and nothing else (§1.2 matrix, acceptance B-7).
CREATE OR REPLACE FUNCTION public.clin_save_lab(p_id uuid, p_version integer, p_name text, p_phone text DEFAULT '',
                                                p_email text DEFAULT '', p_note text DEFAULT '',
                                                p_fin_counterparty_id uuid DEFAULT NULL, p_is_active boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_can_write boolean := public.clin_can_write();
  v_actor uuid := public.current_app_user_id();
  v_fin boolean := coalesce(public.has_permission('finance'), false);
  v_fin_read boolean := coalesce(public.has_permission('finance'), false)
                        OR coalesce(public.has_permission('finance_readonly'), false);
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := btrim(coalesce(p_email, ''));
  v_note text := btrim(coalesce(p_note, ''));
  v_row public.labs%ROWTYPE;
  v_constraint text;
  v_already boolean := false;
  v_link_changed boolean;
BEGIN
  IF NOT v_can_write AND (NOT v_fin OR p_version IS NULL) THEN
    PERFORM public.clin__raise('CL_WRITE');
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    PERFORM public.clin__raise('CL_LAB_NAME');
  END IF;
  IF char_length(v_phone) > 30 OR v_phone !~ '^[0-9 +()-]*$'
     OR char_length(v_email) > 120
     OR (v_email <> '' AND v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     OR char_length(v_note) > 500 THEN
    PERFORM public.clin__raise('CL_LAB_FIELDS');
  END IF;

  IF p_version IS NULL THEN
    IF p_id IS NULL THEN
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END IF;
    SELECT * INTO v_row FROM public.labs l WHERE l.id = p_id;
    IF FOUND THEN
      IF v_row.clinic_id = v_clinic AND v_row.name_key = public.clin__tr_lower(v_name)
         AND v_row.created_by IS NOT DISTINCT FROM v_actor THEN
        RETURN jsonb_build_object('ok', true, 'lab', public.clin__lab_json(v_clinic, p_id, v_fin_read),
                                  'already_saved', true);
      END IF;
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END IF;
    v_link_changed := p_fin_counterparty_id IS NOT NULL;
  ELSE
    SELECT * INTO v_row FROM public.labs l WHERE l.id = p_id AND l.clinic_id = v_clinic FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.clin__raise('CL_NOT_FOUND');
    END IF;
    IF v_row.version <> p_version THEN
      PERFORM public.clin__raise('CL_VERSION');
    END IF;
    IF NOT v_can_write
       AND (v_row.name, v_row.phone, v_row.email, v_row.note, v_row.is_active)
           IS DISTINCT FROM (v_name, v_phone, v_email, v_note, coalesce(p_is_active, v_row.is_active)) THEN
      PERFORM public.clin__raise('CL_WRITE');
    END IF;
    v_link_changed := p_fin_counterparty_id IS DISTINCT FROM v_row.fin_counterparty_id;
  END IF;

  IF v_link_changed THEN
    IF NOT v_fin THEN
      PERFORM public.clin__raise('CL_FINANCE_LINK');
    END IF;
    IF p_fin_counterparty_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.fin_counterparties fc
      WHERE fc.id = p_fin_counterparty_id AND fc.clinic_id = v_clinic AND fc.is_active AND fc.kind = 'lab'
    ) THEN
      PERFORM public.clin__raise('CL_FIN_COUNTERPARTY');
    END IF;
  END IF;

  IF p_version IS NULL THEN
    BEGIN
      INSERT INTO public.labs (id, clinic_id, name, name_key, phone, email, note, fin_counterparty_id, is_active,
                               created_by, updated_by)
      VALUES (p_id, v_clinic, v_name, public.clin__tr_lower(v_name), v_phone, v_email, v_note, p_fin_counterparty_id,
              coalesce(p_is_active, true), v_actor, v_actor);
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'labs_name_key' THEN
        PERFORM public.clin__raise('CL_LAB_TAKEN');
      END IF;
      PERFORM public.clin__raise('CL_ID_TAKEN');
    END;
  ELSIF (v_row.name, v_row.phone, v_row.email, v_row.note, v_row.fin_counterparty_id, v_row.is_active)
        IS DISTINCT FROM (v_name, v_phone, v_email, v_note, p_fin_counterparty_id, coalesce(p_is_active, v_row.is_active)) THEN
    BEGIN
      UPDATE public.labs
      SET name = v_name, phone = v_phone, email = v_email, note = v_note, fin_counterparty_id = p_fin_counterparty_id,
          is_active = coalesce(p_is_active, is_active), version = version + 1, updated_by = v_actor, updated_at = now()
      WHERE id = p_id;
    EXCEPTION WHEN unique_violation THEN
      PERFORM public.clin__raise('CL_LAB_TAKEN');
    END;
  END IF;

  RETURN jsonb_build_object('ok', true, 'lab', public.clin__lab_json(v_clinic, p_id, v_fin_read),
                            'already_saved', v_already);
END;
$$;

-- 5.3 The plan's implant_record (owner decision D1): the implant AND its A-level stock issue in one transaction.
--     Idempotent through the stock ledger's operation key (also the issue movement's key). Any failure after the
--     issue (tooth conflict, constraint, FK) rolls the movement and the balance back with the implant; any stock
--     error leaves no implant row. 'external' records an implant that did not come from clinic stock.
CREATE OR REPLACE FUNCTION public.clin_implant_record(
  p_operation_key uuid,
  p_implant_id uuid,
  p_patient_id uuid,
  p_tooth_fdi integer,
  p_brand_id uuid,
  p_model text,
  p_diameter_mm numeric,
  p_length_mm numeric,
  p_placed_on text,
  p_doctor_id uuid,
  p_appointment_id uuid DEFAULT NULL,
  p_stock_source text DEFAULT 'stock',
  p_batch_id uuid DEFAULT NULL,
  p_from_location_id uuid DEFAULT NULL,
  p_lot_text text DEFAULT NULL,
  p_serial_text text DEFAULT NULL,
  p_source_note text DEFAULT NULL,
  p_torque_ncm numeric DEFAULT NULL,
  p_next_control_on text DEFAULT NULL,
  p_status text DEFAULT 'healing',
  p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_prev jsonb;
  v_source text := btrim(coalesce(p_stock_source, 'stock'));
  v_status text := btrim(coalesce(p_status, 'healing'));
  v_model text := btrim(coalesce(p_model, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_lot text := btrim(coalesce(p_lot_text, ''));
  v_serial text := btrim(coalesce(p_serial_text, ''));
  v_note text := btrim(coalesce(p_source_note, ''));
  v_placed date;
  v_control date;
  v_item uuid;
  v_level text;
  v_b_lot text;
  v_b_serial text;
  v_stock jsonb;
  v_mid uuid;
  v_existing uuid;
  v_constraint text;
  v_card_brand uuid;
BEGIN
  -- Idempotency: same key + same arguments -> the stored result (already_saved); same key + other arguments ->
  -- 0024 E_OP_KEY; NULL key -> E_OP_KEY_FORMAT. The stored result carries ids, lots and quantities only.
  v_prev := public.stock__op_begin(v_clinic, v_actor, p_operation_key, 'clin_implant_record', jsonb_build_object(
    'implant_id', p_implant_id, 'patient_id', p_patient_id, 'tooth_fdi', p_tooth_fdi, 'brand_id', p_brand_id,
    'model', p_model, 'diameter_mm', p_diameter_mm, 'length_mm', p_length_mm, 'placed_on', p_placed_on,
    'doctor_id', p_doctor_id, 'appointment_id', p_appointment_id, 'stock_source', p_stock_source,
    'batch_id', p_batch_id, 'from_location_id', p_from_location_id, 'lot_text', p_lot_text,
    'serial_text', p_serial_text, 'source_note', p_source_note, 'torque_ncm', p_torque_ncm,
    'next_control_on', p_next_control_on, 'status', p_status, 'notes', p_notes));
  IF v_prev IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true,
                              'implant', public.clin__implant_json(v_clinic, (v_prev ->> 'implant_id')::uuid),
                              'stock', v_prev -> 'stock',
                              'already_saved', true);
  END IF;

  -- Scalar validation.
  IF p_implant_id IS NULL OR EXISTS (SELECT 1 FROM public.patient_implants pi WHERE pi.id = p_implant_id) THEN
    PERFORM public.clin__raise('CL_ID_TAKEN');
  END IF;
  IF NOT public.clin__fdi_ok(p_tooth_fdi) THEN
    PERFORM public.clin__raise('CL_TOOTH');
  END IF;
  IF p_diameter_mm IS NULL OR p_diameter_mm <= 0 OR p_diameter_mm > 10 OR p_diameter_mm <> round(p_diameter_mm, 2)
     OR p_length_mm IS NULL OR p_length_mm <= 0 OR p_length_mm > 30 OR p_length_mm <> round(p_length_mm, 2) THEN
    PERFORM public.clin__raise('CL_IMPLANT_SIZE');
  END IF;
  IF p_torque_ncm IS NOT NULL
     AND (p_torque_ncm < 0 OR p_torque_ncm > 200 OR p_torque_ncm <> round(p_torque_ncm, 1)) THEN
    PERFORM public.clin__raise('CL_TORQUE');
  END IF;
  v_placed := public.clin__day(p_placed_on, 'CL_PLACED_ON');
  IF v_placed IS NULL OR v_placed > v_today THEN
    PERFORM public.clin__raise('CL_PLACED_ON');
  END IF;
  v_control := public.clin__day(p_next_control_on, 'CL_CONTROL_DATE');
  IF v_control IS NOT NULL AND v_control < v_placed THEN
    PERFORM public.clin__raise('CL_CONTROL_DATE');
  END IF;
  IF v_status NOT IN ('healing', 'prosthetic', 'completed', 'follow_up', 'failed') THEN
    PERFORM public.clin__raise('CL_STATUS');
  END IF;
  IF char_length(v_model) > 150 THEN
    PERFORM public.clin__raise('CL_MODEL');
  END IF;
  IF char_length(v_notes) > 4000 THEN
    PERFORM public.clin__raise('CL_NOTES');
  END IF;
  IF v_source NOT IN ('stock', 'external') THEN
    PERFORM public.clin__raise('CL_SOURCE');
  END IF;

  -- References.
  IF p_brand_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.implant_brands b WHERE b.id = p_brand_id AND b.clinic_id = v_clinic AND b.is_active
  ) THEN
    PERFORM public.clin__raise('CL_BRAND');
  END IF;
  IF p_patient_id IS NULL THEN
    PERFORM public.stock__raise('E_PATIENT');
  END IF;
  PERFORM public.stock__check_patient_refs(v_clinic, p_patient_id, p_appointment_id, p_doctor_id);

  -- Tooth pre-check: fast fail before any stock lock (the unique index is the backstop).
  IF v_status <> 'failed' THEN
    SELECT pi.id INTO v_existing
    FROM public.patient_implants pi
    WHERE pi.clinic_id = v_clinic AND pi.patient_id = p_patient_id AND pi.tooth_fdi = p_tooth_fdi
      AND pi.deleted_at IS NULL AND pi.status <> 'failed'
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      PERFORM public.clin__raise('CL_TOOTH_TAKEN', NULL, v_existing::text);
    END IF;
  END IF;

  IF v_source = 'stock' THEN
    IF NOT coalesce(public.stock_can_operate(), false) THEN
      PERFORM public.stock__raise('E_OPERATE');
    END IF;
    IF p_doctor_id IS NULL THEN
      PERFORM public.clin__raise('CL_DOCTOR_REQUIRED');
    END IF;
    IF p_batch_id IS NULL OR p_from_location_id IS NULL THEN
      PERFORM public.clin__raise('CL_STOCK_ARGS');
    END IF;
    IF v_lot <> '' OR v_serial <> '' OR v_note <> '' THEN
      PERFORM public.clin__raise('CL_EXTERNAL_ARGS');
    END IF;
    -- The movement's effective_at is the server time of this call; an old placement would distort stock reports.
    IF v_placed < v_today - 30 THEN
      PERFORM public.clin__raise('CL_PLACED_ON_STOCK');
    END IF;

    -- Batches are immutable after insert (0024 stock_immutable); the level of a card with batches is locked
    -- (E_ITEM_LOCKED), so reading it before stock__outbound takes the card lock is safe.
    SELECT b.stock_item_id, b.lot_number, b.serial_number INTO v_item, v_b_lot, v_b_serial
    FROM public.stock_batches b
    WHERE b.id = p_batch_id AND b.clinic_id = v_clinic;
    IF v_item IS NULL THEN
      PERFORM public.stock__raise('E_BATCH');
    END IF;
    SELECT i.tracking_level INTO v_level FROM public.stock_items i WHERE i.id = v_item AND i.clinic_id = v_clinic;
    IF v_level IS DISTINCT FROM 'A' THEN
      PERFORM public.clin__raise('CL_ITEM_LEVEL');
    END IF;
    -- Recall traceability: when the card's brand text names an active directory brand (the picker's brand_id),
    -- the implant must carry that brand, so patient_implants.brand_id never contradicts the issued batch.
    v_card_brand := public.clin__stock_item_brand(v_clinic, v_item);
    IF v_card_brand IS NOT NULL AND v_card_brand IS DISTINCT FROM p_brand_id THEN
      PERFORM public.clin__raise('CL_BRAND_STOCK_MISMATCH',
        (SELECT b.name FROM public.implant_brands b WHERE b.id = v_card_brand));
    END IF;

    -- One issue of 1 usage unit from the chosen batch with patient, doctor and appointment. 0024 locks the card,
    -- the location and the balance, re-checks the A-level rules and the patient references, and writes exactly one
    -- ledger row with operation_key = p_operation_key; trigger clin_movement_link fills implant_record_id from
    -- the transaction-local setting. The reason never contains the patient name (KVKK).
    PERFORM set_config('clin.implant_record_id', p_implant_id::text, true);
    v_stock := public.stock__outbound(v_clinic, v_actor, p_operation_key, v_today, 'issue', v_item, p_from_location_id,
                                      NULL, 1, 'usage', NULL, p_batch_id, p_patient_id, p_appointment_id, p_doctor_id,
                                      'İmplant kaydı · diş ' || p_tooth_fdi::text);
    PERFORM set_config('clin.implant_record_id', '', true);

    IF jsonb_array_length(coalesce(v_stock -> 'movements', '[]'::jsonb)) <> 1 THEN
      RAISE EXCEPTION 'clin_implant_record: beklenmeyen stok hareketi sayısı (%).',
        jsonb_array_length(coalesce(v_stock -> 'movements', '[]'::jsonb));
    END IF;
    v_mid := (v_stock -> 'movements' -> 0 ->> 'id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.stock_movements m
                   WHERE m.id = v_mid AND m.clinic_id = v_clinic AND m.implant_record_id = p_implant_id
                     AND m.batch_id = p_batch_id AND m.movement_type = 'issue') THEN
      RAISE EXCEPTION 'clin_implant_record: stok hareketi implant kaydına bağlanamadı.';
    END IF;

    v_lot := CASE WHEN v_b_lot = 'GENEL' THEN '' ELSE coalesce(v_b_lot, '') END;
    v_serial := coalesce(v_b_serial, '');
    v_note := '';
  ELSE
    IF p_batch_id IS NOT NULL OR p_from_location_id IS NOT NULL THEN
      PERFORM public.clin__raise('CL_EXTERNAL_ARGS');
    END IF;
    IF char_length(v_note) NOT BETWEEN 3 AND 200 THEN
      PERFORM public.clin__raise('CL_SOURCE_NOTE');
    END IF;
    IF char_length(v_lot) > 60 OR char_length(v_serial) > 60 THEN
      PERFORM public.clin__raise('CL_LOT_TEXT');
    END IF;
    v_item := NULL;
    v_mid := NULL;
  END IF;

  -- A unique violation re-raised here aborts the whole call, so the stock issue above is rolled back with it.
  BEGIN
    INSERT INTO public.patient_implants (
      id, clinic_id, patient_id, tooth_fdi, brand_id, model, diameter_mm, length_mm, placed_on, doctor_id,
      appointment_id, stock_source, source_note, stock_item_id, batch_id, stock_movement_id, lot_text, serial_text,
      torque_ncm, next_control_on, status, notes, version, created_by, updated_by)
    VALUES (
      p_implant_id, v_clinic, p_patient_id, p_tooth_fdi, p_brand_id, v_model, p_diameter_mm, p_length_mm, v_placed,
      p_doctor_id, p_appointment_id, v_source, v_note, v_item,
      CASE WHEN v_source = 'stock' THEN p_batch_id END, v_mid, v_lot, v_serial,
      p_torque_ncm, v_control, v_status, v_notes, 1, v_actor, v_actor);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'patient_implants_tooth_active' THEN
      PERFORM public.clin__raise('CL_TOOTH_TAKEN');
    END IF;
    PERFORM public.clin__raise('CL_ID_TAKEN');
  END;

  PERFORM public.stock__op_finish(v_clinic, p_operation_key,
    jsonb_build_object('ok', true, 'implant_id', p_implant_id, 'stock', v_stock));

  RETURN jsonb_build_object('ok', true,
                            'implant', public.clin__implant_json(v_clinic, p_implant_id),
                            'stock', v_stock,
                            'already_saved', false);
END;
$$;

-- 5.4 Full-replace edit. Patient and source never change (void + re-record). A stock implant keeps doctor,
--     appointment and lot / serial (the ledger row is append-only and keeps them); placed_on stays within 30 days
--     before the movement day. A no-op returns the row without bumping the version.
CREATE OR REPLACE FUNCTION public.clin_implant_update(
  p_implant_id uuid,
  p_version integer,
  p_tooth_fdi integer,
  p_brand_id uuid,
  p_model text,
  p_diameter_mm numeric,
  p_length_mm numeric,
  p_placed_on text,
  p_doctor_id uuid,
  p_appointment_id uuid,
  p_lot_text text,
  p_serial_text text,
  p_source_note text,
  p_torque_ncm numeric,
  p_next_control_on text,
  p_status text,
  p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_actor uuid := public.current_app_user_id();
  v_today date := public.clinic_today();
  v_row public.patient_implants%ROWTYPE;
  v_status text := btrim(coalesce(p_status, ''));
  v_model text := btrim(coalesce(p_model, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_lot text;
  v_serial text;
  v_note text := btrim(coalesce(p_source_note, ''));
  v_placed date;
  v_control date;
  v_mday date;
  v_existing uuid;
  v_constraint text;
  v_card_brand uuid;
BEGIN
  SELECT * INTO v_row FROM public.patient_implants pi
  WHERE pi.id = p_implant_id AND pi.clinic_id = v_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    PERFORM public.clin__raise('CL_IMPLANT_DELETED');
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;

  -- Absent lot / serial texts keep the stored values (the form shows them read-only for stock implants).
  v_lot := btrim(coalesce(p_lot_text, v_row.lot_text));
  v_serial := btrim(coalesce(p_serial_text, v_row.serial_text));

  IF NOT public.clin__fdi_ok(p_tooth_fdi) THEN
    PERFORM public.clin__raise('CL_TOOTH');
  END IF;
  IF p_diameter_mm IS NULL OR p_diameter_mm <= 0 OR p_diameter_mm > 10 OR p_diameter_mm <> round(p_diameter_mm, 2)
     OR p_length_mm IS NULL OR p_length_mm <= 0 OR p_length_mm > 30 OR p_length_mm <> round(p_length_mm, 2) THEN
    PERFORM public.clin__raise('CL_IMPLANT_SIZE');
  END IF;
  IF p_torque_ncm IS NOT NULL
     AND (p_torque_ncm < 0 OR p_torque_ncm > 200 OR p_torque_ncm <> round(p_torque_ncm, 1)) THEN
    PERFORM public.clin__raise('CL_TORQUE');
  END IF;
  v_placed := public.clin__day(p_placed_on, 'CL_PLACED_ON');
  IF v_placed IS NULL OR v_placed > v_today THEN
    PERFORM public.clin__raise('CL_PLACED_ON');
  END IF;
  v_control := public.clin__day(p_next_control_on, 'CL_CONTROL_DATE');
  IF v_control IS NOT NULL AND v_control < v_placed THEN
    PERFORM public.clin__raise('CL_CONTROL_DATE');
  END IF;
  IF v_status NOT IN ('healing', 'prosthetic', 'completed', 'follow_up', 'failed') THEN
    PERFORM public.clin__raise('CL_STATUS');
  END IF;
  IF char_length(v_model) > 150 THEN
    PERFORM public.clin__raise('CL_MODEL');
  END IF;
  IF char_length(v_notes) > 4000 THEN
    PERFORM public.clin__raise('CL_NOTES');
  END IF;

  -- Brand: must be active unless unchanged.
  IF p_brand_id IS NULL OR (p_brand_id IS DISTINCT FROM v_row.brand_id AND NOT EXISTS (
    SELECT 1 FROM public.implant_brands b WHERE b.id = p_brand_id AND b.clinic_id = v_clinic AND b.is_active
  )) THEN
    PERFORM public.clin__raise('CL_BRAND');
  END IF;

  IF v_row.stock_source = 'stock' THEN
    IF p_doctor_id IS DISTINCT FROM v_row.doctor_id OR p_appointment_id IS DISTINCT FROM v_row.appointment_id
       OR v_lot IS DISTINCT FROM v_row.lot_text OR v_serial IS DISTINCT FROM v_row.serial_text OR v_note <> '' THEN
      PERFORM public.clin__raise('CL_IMPLANT_STOCK_FIELDS');
    END IF;
    -- A brand change must still match the issued card's directory brand (see clin_implant_record).
    IF p_brand_id IS DISTINCT FROM v_row.brand_id THEN
      v_card_brand := public.clin__stock_item_brand(v_clinic, v_row.stock_item_id);
      IF v_card_brand IS NOT NULL AND v_card_brand IS DISTINCT FROM p_brand_id THEN
        PERFORM public.clin__raise('CL_BRAND_STOCK_MISMATCH',
          (SELECT b.name FROM public.implant_brands b WHERE b.id = v_card_brand));
      END IF;
    END IF;
    SELECT (m.effective_at AT TIME ZONE 'Europe/Istanbul')::date INTO v_mday
    FROM public.stock_movements m WHERE m.id = v_row.stock_movement_id;
    IF v_mday IS NOT NULL AND v_placed < v_mday - 30 THEN
      PERFORM public.clin__raise('CL_PLACED_ON_STOCK');
    END IF;
    v_note := v_row.source_note;
  ELSE
    IF char_length(v_note) NOT BETWEEN 3 AND 200 THEN
      PERFORM public.clin__raise('CL_SOURCE_NOTE');
    END IF;
    IF char_length(v_lot) > 60 OR char_length(v_serial) > 60 THEN
      PERFORM public.clin__raise('CL_LOT_TEXT');
    END IF;
    IF p_doctor_id IS NOT NULL AND p_doctor_id IS DISTINCT FROM v_row.doctor_id THEN
      PERFORM public.stock__check_patient_refs(v_clinic, NULL, NULL, p_doctor_id);
    END IF;
    IF p_appointment_id IS NOT NULL AND p_appointment_id IS DISTINCT FROM v_row.appointment_id THEN
      PERFORM public.stock__check_patient_refs(v_clinic, v_row.patient_id, p_appointment_id, NULL);
    END IF;
  END IF;

  -- No-op: nothing changed -> the row as it is.
  IF (p_tooth_fdi, p_brand_id, v_model, p_diameter_mm, p_length_mm, v_placed, p_doctor_id, p_appointment_id, v_lot,
      v_serial, v_note, p_torque_ncm, v_control, v_status, v_notes)
     IS NOT DISTINCT FROM
     (v_row.tooth_fdi::integer, v_row.brand_id, v_row.model, v_row.diameter_mm, v_row.length_mm, v_row.placed_on,
      v_row.doctor_id, v_row.appointment_id, v_row.lot_text, v_row.serial_text, v_row.source_note, v_row.torque_ncm,
      v_row.next_control_on, v_row.status, v_row.notes) THEN
    RETURN jsonb_build_object('ok', true, 'implant', public.clin__implant_json(v_clinic, p_implant_id));
  END IF;

  -- Tooth uniqueness when the tooth changes or the implant leaves 'failed'.
  IF v_status <> 'failed' AND (p_tooth_fdi <> v_row.tooth_fdi OR v_row.status = 'failed') THEN
    SELECT pi.id INTO v_existing
    FROM public.patient_implants pi
    WHERE pi.clinic_id = v_clinic AND pi.patient_id = v_row.patient_id AND pi.tooth_fdi = p_tooth_fdi
      AND pi.deleted_at IS NULL AND pi.status <> 'failed' AND pi.id <> v_row.id
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      PERFORM public.clin__raise('CL_TOOTH_TAKEN', NULL, v_existing::text);
    END IF;
  END IF;

  BEGIN
    UPDATE public.patient_implants
    SET tooth_fdi = p_tooth_fdi, brand_id = p_brand_id, model = v_model, diameter_mm = p_diameter_mm,
        length_mm = p_length_mm, placed_on = v_placed, doctor_id = p_doctor_id, appointment_id = p_appointment_id,
        lot_text = v_lot, serial_text = v_serial, source_note = v_note, torque_ncm = p_torque_ncm,
        next_control_on = v_control, status = v_status, notes = v_notes, version = version + 1,
        updated_by = v_actor, updated_at = now()
    WHERE id = v_row.id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'patient_implants_tooth_active' THEN
      PERFORM public.clin__raise('CL_TOOTH_TAKEN');
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('ok', true, 'implant', public.clin__implant_json(v_clinic, p_implant_id));
END;
$$;

-- 5.5 Void ("İptal et", soft delete). A stock implant opens a correction request for the stock manager (approve
--     with 0 when the implant was not used; reject when it was consumed), unless the movement already has an open
--     or approved request or a return.
CREATE OR REPLACE FUNCTION public.clin_implant_void(p_implant_id uuid, p_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_write();
  v_actor uuid := public.current_app_user_id();
  v_row public.patient_implants%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_req uuid;
  v_constraint text;
  v_corr jsonb;
BEGIN
  SELECT * INTO v_row FROM public.patient_implants pi
  WHERE pi.id = p_implant_id AND pi.clinic_id = v_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    PERFORM public.clin__raise('CL_IMPLANT_DELETED');
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  IF char_length(v_reason) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.clin__raise('CL_REASON');
  END IF;

  -- deleted_at first: the correction guard (clin_correction_link) then lets the request below through.
  UPDATE public.patient_implants
  SET deleted_at = now(), deleted_by = v_actor, delete_reason = v_reason, version = version + 1,
      updated_by = v_actor, updated_at = now()
  WHERE id = v_row.id;

  IF v_row.stock_source = 'stock' AND v_row.stock_movement_id IS NOT NULL THEN
    SELECT r.id INTO v_req
    FROM public.stock_correction_requests r
    WHERE r.movement_id = v_row.stock_movement_id AND r.status IN ('pending', 'approved')
    ORDER BY r.created_at DESC
    LIMIT 1;
    IF v_req IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.stock_movements r
      WHERE r.source_movement_id = v_row.stock_movement_id AND r.movement_type = 'return'
    ) THEN
      v_req := gen_random_uuid();
      BEGIN
        INSERT INTO public.stock_correction_requests (id, clinic_id, movement_id, reason, requested_by)
        VALUES (v_req, v_clinic, v_row.stock_movement_id, left('İmplant kaydı iptal edildi: ' || v_reason, 1000), v_actor);
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'stock_corr_open_key' THEN
          RAISE;
        END IF;
        -- A concurrent request was opened first: report that one.
        SELECT r.id INTO v_req
        FROM public.stock_correction_requests r
        WHERE r.movement_id = v_row.stock_movement_id AND r.status IN ('pending', 'approved')
        LIMIT 1;
      END;
    END IF;
  END IF;

  IF v_req IS NOT NULL THEN
    SELECT jsonb_build_object('id', r.id, 'ref_no', r.ref_no, 'status', r.status) INTO v_corr
    FROM public.stock_correction_requests r WHERE r.id = v_req;
  END IF;

  RETURN jsonb_build_object('ok', true, 'implant', public.clin__implant_json(v_clinic, p_implant_id),
                            'stock_correction', v_corr);
END;
$$;

-- 5.6 Restore (owner only, CR:10). A stock implant can be restored only while its issue stands (no pending or
--     approved correction, no return).
CREATE OR REPLACE FUNCTION public.clin_implant_restore(p_implant_id uuid, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_actor uuid := public.current_app_user_id();
  v_row public.patient_implants%ROWTYPE;
  v_existing uuid;
  v_constraint text;
BEGIN
  IF coalesce(public.current_app_role(), '') <> 'owner' THEN
    PERFORM public.clin__raise('CL_RESTORE_OWNER');
  END IF;
  SELECT * INTO v_row FROM public.patient_implants pi
  WHERE pi.id = p_implant_id AND pi.clinic_id = v_clinic
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  IF p_version IS DISTINCT FROM v_row.version THEN
    PERFORM public.clin__raise('CL_VERSION');
  END IF;
  IF v_row.deleted_at IS NULL THEN
    PERFORM public.clin__raise('CL_IMPLANT_ACTIVE');
  END IF;

  IF v_row.stock_source = 'stock' AND v_row.stock_movement_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.stock_correction_requests r
               WHERE r.movement_id = v_row.stock_movement_id AND r.status = 'pending') THEN
      PERFORM public.clin__raise('CL_IMPLANT_RESTORE_PENDING');
    END IF;
    IF EXISTS (SELECT 1 FROM public.stock_correction_requests r
               WHERE r.movement_id = v_row.stock_movement_id AND r.status = 'approved')
       OR EXISTS (SELECT 1 FROM public.stock_movements r
                  WHERE r.source_movement_id = v_row.stock_movement_id AND r.movement_type = 'return') THEN
      PERFORM public.clin__raise('CL_IMPLANT_RESTORE_STOCK');
    END IF;
  END IF;

  IF v_row.status <> 'failed' THEN
    SELECT pi.id INTO v_existing
    FROM public.patient_implants pi
    WHERE pi.clinic_id = v_clinic AND pi.patient_id = v_row.patient_id AND pi.tooth_fdi = v_row.tooth_fdi
      AND pi.deleted_at IS NULL AND pi.status <> 'failed' AND pi.id <> v_row.id
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      PERFORM public.clin__raise('CL_TOOTH_TAKEN', NULL, v_existing::text);
    END IF;
  END IF;

  BEGIN
    UPDATE public.patient_implants
    SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, version = version + 1,
        updated_by = v_actor, updated_at = now()
    WHERE id = v_row.id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'patient_implants_tooth_active' THEN
      PERFORM public.clin__raise('CL_TOOTH_TAKEN');
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('ok', true, 'implant', public.clin__implant_json(v_clinic, p_implant_id));
END;
$$;

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

  -- Edit.
  SELECT * INTO v_row FROM public.lab_orders o WHERE o.id = p_id AND o.clinic_id = v_clinic FOR UPDATE;
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
  SELECT * INTO v_row FROM public.lab_orders o WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic FOR UPDATE;
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
  SELECT * INTO v_row FROM public.lab_orders o WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic FOR UPDATE;
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
  SELECT * INTO v_order FROM public.lab_orders o WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic FOR UPDATE;
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
  SELECT * INTO v_order FROM public.lab_orders o WHERE o.id = p_lab_order_id AND o.clinic_id = v_clinic FOR UPDATE;
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

-- 5.12 Payable switch (D2: only a 'finance' holder; the owner role alone is not enough). Switching on does not post
--      existing costs; switching off leaves posted entries untouched.
CREATE OR REPLACE FUNCTION public.clin_save_settings(p_version integer, p_lab_cost_payable_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_actor uuid := public.current_app_user_id();
  v_row public.clinical_settings%ROWTYPE;
  v_n integer;
BEGIN
  IF NOT coalesce(public.has_permission('finance'), false) THEN
    PERFORM public.clin__raise('CL_FINANCE');
  END IF;
  IF p_lab_cost_payable_enabled IS NULL THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;

  SELECT * INTO v_row FROM public.clinical_settings s WHERE s.clinic_id = v_clinic FOR UPDATE;
  IF NOT FOUND THEN
    IF p_version IS DISTINCT FROM 0 THEN
      PERFORM public.clin__raise('CL_VERSION');
    END IF;
    INSERT INTO public.clinical_settings (clinic_id, lab_cost_payable_enabled, version, updated_by)
    VALUES (v_clinic, p_lab_cost_payable_enabled, 1, v_actor)
    ON CONFLICT (clinic_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      PERFORM public.clin__raise('CL_VERSION');
    END IF;
  ELSE
    IF p_version IS DISTINCT FROM v_row.version THEN
      PERFORM public.clin__raise('CL_VERSION');
    END IF;
    IF v_row.lab_cost_payable_enabled IS DISTINCT FROM p_lab_cost_payable_enabled THEN
      UPDATE public.clinical_settings
      SET lab_cost_payable_enabled = p_lab_cost_payable_enabled, version = version + 1, updated_by = v_actor,
          updated_at = now()
      WHERE clinic_id = v_clinic;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'settings', public.clin__settings_json(v_clinic));
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Read RPCs. SECURITY DEFINER, STABLE, clinic from the session, one jsonb each (every aggregate computed in SQL,
--    so PostgREST's 1000-row cap never truncates). Every response carries flags and today.
-- ---------------------------------------------------------------------------

-- 6.2 Implant list with the "kontrol tarihi gelen" filter; counts cover the clinic's live implants (tiles, CW:37).
CREATE OR REPLACE FUNCTION public.clin_implant_list(p_filters jsonb DEFAULT '{}'::jsonb, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_today date := public.clinic_today();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_q_tooth integer;
  v_patient uuid;
  v_doctor uuid;
  v_brand uuid;
  v_status text[];
  v_control boolean;
  v_source text;
  v_deleted text;
  v_from date;
  v_to date;
  v_offset integer;
  v_limit integer;
  v_rows jsonb;
  v_total bigint;
  v_counts jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_f) AS k(k_name)
    WHERE k.k_name NOT IN ('q', 'patient_id', 'doctor_id', 'brand_id', 'status', 'control_due', 'stock_source',
                           'deleted', 'placed_from', 'placed_to')
  ) THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  v_q := public.clin__j_text(v_f, 'q');
  IF char_length(v_q) > 100 THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  v_patient := public.clin__j_uuid(v_f, 'patient_id');
  v_doctor := public.clin__j_uuid(v_f, 'doctor_id');
  v_brand := public.clin__j_uuid(v_f, 'brand_id');
  v_status := public.clin__j_codes(v_f, 'status', ARRAY['healing', 'prosthetic', 'completed', 'follow_up', 'failed']);
  v_control := coalesce(public.clin__j_bool(v_f, 'control_due'), false);
  v_source := public.clin__j_text(v_f, 'stock_source');
  IF v_source IS NOT NULL AND v_source NOT IN ('stock', 'external') THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  v_deleted := coalesce(public.clin__j_text(v_f, 'deleted'), 'active');
  IF v_deleted NOT IN ('active', 'deleted', 'all') THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  IF v_deleted <> 'active' AND NOT coalesce(public.current_app_role() IN ('owner', 'admin'), false) THEN
    PERFORM public.clin__raise('CL_DELETED_VIEW');
  END IF;
  v_from := public.clin__day(public.clin__j_text(v_f, 'placed_from'), 'CL_FILTER');
  v_to := public.clin__day(public.clin__j_text(v_f, 'placed_to'), 'CL_FILTER');
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.clin__page(p_page, 200) pg;
  v_q := public.clin__tr_lower(v_q);
  IF v_q ~ '^[0-9]{2}$' THEN
    v_q_tooth := v_q::integer;
  END IF;

  WITH f AS (
    SELECT r.*,
           row_number() OVER (
             ORDER BY CASE WHEN v_control THEN r.next_control_on END ASC NULLS LAST,
                      CASE WHEN v_control THEN r.placed_on END ASC,
                      CASE WHEN NOT v_control THEN r.placed_on END DESC,
                      CASE WHEN NOT v_control THEN r.created_at END DESC,
                      r.id) AS rn
    FROM public.clin__implant_rows(v_clinic, v_today) r
    WHERE (v_deleted = 'all'
           OR (v_deleted = 'active' AND r.deleted_at IS NULL)
           OR (v_deleted = 'deleted' AND r.deleted_at IS NOT NULL))
      AND (v_q IS NULL OR strpos(r.search, v_q) > 0 OR r.tooth_fdi = v_q_tooth)
      AND (v_patient IS NULL OR r.patient_id = v_patient)
      AND (v_doctor IS NULL OR r.doctor_id = v_doctor)
      AND (v_brand IS NULL OR r.brand_id = v_brand)
      AND (v_status IS NULL OR r.status = ANY (v_status))
      AND (NOT v_control OR r.control_due)
      AND (v_source IS NULL OR r.stock_source = v_source)
      AND (v_from IS NULL OR r.placed_on >= v_from)
      AND (v_to IS NULL OR r.placed_on <= v_to)
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(f.j ORDER BY f.rn) FROM f WHERE f.rn > v_offset AND f.rn <= v_offset + v_limit),
                  '[]'::jsonb)
    INTO v_total, v_rows;

  SELECT jsonb_build_object(
           'control_due', count(*) FILTER (WHERE pi.next_control_on IS NOT NULL AND pi.next_control_on <= v_today
                                           AND pi.status IN ('healing', 'prosthetic', 'follow_up')),
           'healing', count(*) FILTER (WHERE pi.status = 'healing'),
           'prosthetic', count(*) FILTER (WHERE pi.status = 'prosthetic'),
           'completed', count(*) FILTER (WHERE pi.status = 'completed'),
           'follow_up', count(*) FILTER (WHERE pi.status = 'follow_up'),
           'failed', count(*) FILTER (WHERE pi.status = 'failed'),
           'placed_this_month', count(*) FILTER (WHERE pi.placed_on >= date_trunc('month', v_today)::date),
           'external', count(*) FILTER (WHERE pi.stock_source = 'external'))
    INTO v_counts
  FROM public.patient_implants pi
  WHERE pi.clinic_id = v_clinic AND pi.deleted_at IS NULL;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'counts', v_counts, 'today', v_today,
                            'flags', public.clin__flags());
END;
$$;

-- 6.3 One implant with its issue movement (0024 history row), the correction request and the patient's other live
--     implants. Deleted implants only for owner / admin.
CREATE OR REPLACE FUNCTION public.clin_implant_detail(p_implant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_actor uuid := public.current_app_user_id();
  v_manage boolean := coalesce(public.stock_can_manage(), false);
  v_operate boolean := coalesce(public.stock_can_operate(), false);
  v_row public.patient_implants%ROWTYPE;
  v_movement jsonb;
  v_req uuid;
  v_corr jsonb;
  v_others jsonb;
BEGIN
  SELECT * INTO v_row FROM public.patient_implants pi WHERE pi.id = p_implant_id AND pi.clinic_id = v_clinic;
  IF NOT FOUND OR (v_row.deleted_at IS NOT NULL
                   AND NOT coalesce(public.current_app_role() IN ('owner', 'admin'), false)) THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;

  IF v_row.stock_movement_id IS NOT NULL THEN
    SELECT h.j INTO v_movement
    FROM public.stock__history_rows(v_clinic, v_actor, v_manage, v_operate) h
    WHERE h.id = v_row.stock_movement_id;
    SELECT r.id INTO v_req
    FROM public.stock_correction_requests r
    WHERE r.movement_id = v_row.stock_movement_id
    ORDER BY (r.status IN ('pending', 'approved')) DESC, r.created_at DESC, r.id
    LIMIT 1;
    IF v_req IS NOT NULL THEN
      v_corr := public.stock__corr_json(v_clinic, v_req, v_actor, v_manage, v_operate);
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', pi.id, 'tooth_fdi', pi.tooth_fdi, 'brand_name', b.name,
                                               'status', pi.status) ORDER BY pi.tooth_fdi, pi.placed_on), '[]'::jsonb)
    INTO v_others
  FROM public.patient_implants pi
  JOIN public.implant_brands b ON b.id = pi.brand_id
  WHERE pi.clinic_id = v_clinic AND pi.patient_id = v_row.patient_id AND pi.deleted_at IS NULL AND pi.id <> v_row.id;

  RETURN jsonb_build_object('implant', public.clin__implant_json(v_clinic, v_row.id), 'movement', v_movement,
                            'correction', v_corr, 'other_implants', v_others, 'today', public.clinic_today(),
                            'flags', public.clin__flags());
END;
$$;

-- 6.4 Stock picker of the implant form: ready A-level cards with usable balances (quantity > 0, not expired, active
--     location), FEFO-ordered batches. Caps: 100 cards, 500 balance rows (truncated = true). No cost keys.
CREATE OR REPLACE FUNCTION public.clin_implant_stock_options(p_q text DEFAULT NULL, p_location_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_today date := public.clinic_today();
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_items jsonb;
  v_trunc boolean;
BEGIN
  IF char_length(v_q) > 100 THEN
    PERFORM public.clin__raise('CL_FILTER');
  END IF;
  v_q := public.clin__tr_lower(v_q);

  WITH b AS (
    SELECT i.id AS item_id, i.item_name, i.brand, i.model, sb.batch_id, bt.lot_number, bt.serial_number,
           bt.expiry_date, bt.received_at, sb.location_id, l.name AS location_name, sb.quantity
    FROM public.stock_balances sb
    JOIN public.stock_items i ON i.id = sb.stock_item_id
    JOIN public.stock_batches bt ON bt.id = sb.batch_id
    JOIN public.stock_locations l ON l.id = sb.location_id
    WHERE sb.clinic_id = v_clinic
      AND sb.quantity > 0
      AND i.tracking_level = 'A' AND i.is_active AND NOT i.needs_review
      AND l.is_active
      AND (bt.expiry_date IS NULL OR bt.expiry_date >= v_today)
      AND (p_location_id IS NULL OR sb.location_id = p_location_id)
      AND (v_q IS NULL OR strpos(public.clin__tr_lower(concat_ws(' ', i.item_name, i.brand, i.model, bt.lot_number,
                                                                 bt.serial_number, i.gtin)), v_q) > 0)
  ), it AS (
    SELECT x.item_id, x.item_name, x.brand, x.model,
           row_number() OVER (ORDER BY x.item_name COLLATE "tr-x-icu", x.item_id) AS rn
    FROM (SELECT DISTINCT b.item_id, b.item_name, b.brand, b.model FROM b) x
  ), br AS (
    SELECT b.*,
           row_number() OVER (ORDER BY it.rn, b.expiry_date ASC NULLS LAST, b.received_at, b.batch_id,
                                       b.location_name COLLATE "tr-x-icu", b.location_id) AS brn
    FROM b JOIN it ON it.item_id = b.item_id
    WHERE it.rn <= 100
  )
  SELECT coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'stock_item_id', it.item_id, 'item_name', it.item_name, 'brand', it.brand, 'model', it.model,
                    'brand_id', (SELECT ib.id FROM public.implant_brands ib
                                 WHERE ib.clinic_id = v_clinic AND ib.is_active
                                   AND ib.name_key = public.clin__tr_lower(btrim(it.brand))
                                 LIMIT 1),
                    'batches', (SELECT jsonb_agg(jsonb_build_object(
                                         'batch_id', br.batch_id, 'lot_number', br.lot_number,
                                         'serial_number', br.serial_number, 'expiry_date', br.expiry_date,
                                         'location_id', br.location_id, 'location_name', br.location_name,
                                         'quantity', public.clin__q(br.quantity)) ORDER BY br.brn)
                                FROM br WHERE br.item_id = it.item_id AND br.brn <= 500))
                  ORDER BY it.rn)
           FROM it
           WHERE it.rn <= 100 AND EXISTS (SELECT 1 FROM br WHERE br.item_id = it.item_id AND br.brn <= 500)),
         '[]'::jsonb),
         (SELECT count(*) FROM it) > 100 OR (SELECT count(*) FROM br) > 500
    INTO v_items, v_trunc;

  RETURN jsonb_build_object('items', v_items, 'truncated', v_trunc, 'today', v_today, 'flags', public.clin__flags());
END;
$$;

-- 6.5 Patient materials (Sarf): newest first; totals per item over the whole patient.
CREATE OR REPLACE FUNCTION public.clin_patient_materials(p_patient_id uuid, p_page jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_can_cost boolean := coalesce(public.stock_can_view_costs(), false);
  v_offset integer;
  v_limit integer;
  v_rows jsonb;
  v_total bigint;
  v_totals jsonb;
BEGIN
  IF p_patient_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.patients p WHERE p.id = p_patient_id AND p.clinic_id = v_clinic
  ) THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;
  SELECT pg.o_offset, pg.o_limit INTO v_offset, v_limit FROM public.clin__page(p_page, 200) pg;

  WITH r AS (
    SELECT m.*, row_number() OVER (ORDER BY m.effective_at DESC, m.ref_no DESC) AS rn
    FROM public.clin__material_rows(v_clinic, v_can_cost) m
    WHERE m.patient_id = p_patient_id
  )
  SELECT (SELECT count(*) FROM r),
         coalesce((SELECT jsonb_agg(r.j ORDER BY r.rn) FROM r WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit),
                  '[]'::jsonb),
         coalesce((
           SELECT jsonb_agg(t.j ORDER BY t.item_name COLLATE "tr-x-icu", t.stock_item_id)
           FROM (
             SELECT r.stock_item_id, r.item_name,
                    jsonb_build_object('stock_item_id', r.stock_item_id, 'item_name', r.item_name,
                                       'usage_unit', r.usage_unit, 'net_qty', public.clin__q(sum(r.net_qty)))
                    || CASE WHEN v_can_cost AND count(r.cost_cents) > 0
                            THEN jsonb_build_object('cost_cents', sum(r.cost_cents)::bigint)
                            ELSE '{}'::jsonb END AS j
             FROM r
             GROUP BY r.stock_item_id, r.item_name, r.usage_unit
           ) t), '[]'::jsonb)
    INTO v_total, v_rows, v_totals;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'totals', v_totals, 'today', public.clinic_today(),
                            'flags', public.clin__flags());
END;
$$;

-- 6.5 Appointment materials ("Kullanılan malzeme") and the live implants placed in that appointment.
CREATE OR REPLACE FUNCTION public.clin_appointment_materials(p_appointment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
  v_today date := public.clinic_today();
  v_can_cost boolean := coalesce(public.stock_can_view_costs(), false);
  v_appt jsonb;
  v_materials jsonb;
  v_implants jsonb;
BEGIN
  SELECT jsonb_build_object(
           'id', a.id, 'start_time', a.start_time, 'end_time', a.end_time, 'status', a.status::text,
           'patient_id', a.patient_id, 'patient_name', p.full_name,
           'doctor_id', a.doctor_id, 'doctor_name', du.full_name,
           'chair_id', a.chair_id, 'chair_name', ch.name,
           'procedure_id', a.procedure_id, 'procedure_name', pc.name,
           'notes', a.notes)
    INTO v_appt
  FROM public.appointments a
  JOIN public.patients p ON p.id = a.patient_id
  LEFT JOIN public.doctors d ON d.id = a.doctor_id
  LEFT JOIN public.users du ON du.id = d.user_id
  LEFT JOIN public.chairs ch ON ch.id = a.chair_id
  LEFT JOIN public.procedures_catalog pc ON pc.id = a.procedure_id
  WHERE a.id = p_appointment_id AND a.clinic_id = v_clinic;
  IF v_appt IS NULL THEN
    PERFORM public.clin__raise('CL_NOT_FOUND');
  END IF;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.effective_at DESC, x.ref_no DESC), '[]'::jsonb)
    INTO v_materials
  FROM (
    SELECT m.j, m.effective_at, m.ref_no
    FROM public.clin__material_rows(v_clinic, v_can_cost) m
    WHERE m.appointment_id = p_appointment_id
    ORDER BY m.effective_at DESC, m.ref_no DESC
    LIMIT 200
  ) x;

  SELECT coalesce(jsonb_agg(r.j ORDER BY r.tooth_fdi, r.created_at), '[]'::jsonb)
    INTO v_implants
  FROM public.clin__implant_rows(v_clinic, v_today) r
  WHERE r.appointment_id = p_appointment_id AND r.deleted_at IS NULL;

  RETURN jsonb_build_object('appointment', v_appt, 'materials', v_materials, 'implants', v_implants,
                            'today', v_today, 'flags', public.clin__flags());
END;
$$;

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

-- 6.9 Settings (every staff member; the switch itself is not sensitive).
CREATE OR REPLACE FUNCTION public.clin_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.clin__require_read();
BEGIN
  RETURN jsonb_build_object('settings', public.clin__settings_json(v_clinic), 'today', public.clinic_today(),
                            'flags', public.clin__flags());
END;
$$;

-- ---------------------------------------------------------------------------
-- 4.4 Function privileges and self-checks (0024 stock__harden_privileges pattern). PostgreSQL grants EXECUTE to
--     PUBLIC on every new function (and Supabase's default privileges add anon and authenticated); CREATE OR REPLACE
--     keeps the ACL, a new overload or DROP + CREATE does not. Every clin_* / clin__* function loses EXECUTE from
--     PUBLIC, anon and authenticated; public RPCs (single underscore) are then granted to authenticated; internals
--     never are. Runs as the migration owner; never granted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clin__harden_privileges()
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
    WHERE n.nspname = 'public' AND p.proname LIKE 'clin\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_f.sig);
    IF v_f.proname NOT LIKE 'clin\_\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_f.sig);
    END IF;
  END LOOP;
  -- The test clean-up runs through the API with the service role key (never anon / authenticated).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.clin__purge_test_clinic(uuid) TO service_role;
  END IF;

  -- No overloads (§1.3).
  SELECT string_agg(x.proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'clin\_%'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'clin_* fonksiyonlarının birden fazla sürümü var: %', v_bad;
  END IF;

  -- Every public RPC is SECURITY DEFINER with search_path = public.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'clin\_%' AND p.proname NOT LIKE 'clin\_\_%'
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER / search_path eksik: %', v_bad;
  END IF;

  -- Internals fail closed: only trigger functions may be SECURITY DEFINER.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'clin\_\_%'
    AND p.prosecdef AND p.prorettype <> 'trigger'::regtype;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç klinik fonksiyonları SECURITY DEFINER olmamalı: %', v_bad;
  END IF;

  -- No internal is callable from the API, and anon can call nothing.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'clin\_%'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR (p.proname LIKE 'clin\_\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'İç klinik fonksiyonları API''ye açık: %', v_bad;
  END IF;

  -- Tables: SELECT only for authenticated, nothing for anon (no column privileges either).
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['implant_brands', 'labs', 'patient_implants', 'lab_order_events', 'lab_order_costs',
                    'clinical_settings', 'lab_orders', 'lab_order_items']) AS t(tbl)
  WHERE has_table_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_any_column_privilege('authenticated', format('public.%I', t.tbl), 'INSERT, UPDATE')
     OR has_table_privilege('anon', format('public.%I', t.tbl), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', t.tbl), 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Klinik tablo yetkileri beklenen gibi değil: %', v_bad;
  END IF;
  IF has_sequence_privilege('authenticated', 'public.lab_order_number_seq', 'USAGE, SELECT, UPDATE')
     OR has_sequence_privilege('anon', 'public.lab_order_number_seq', 'USAGE, SELECT, UPDATE') THEN
    RAISE EXCEPTION 'lab_order_number_seq istemcilere açık.';
  END IF;
END;
$$;

SELECT public.clin__harden_privileges();

-- Grants made before Phase 9 are kept but listed, so the owner can review them (runbook step 5).
DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.staff_permissions sp
  JOIN public.users u ON u.id = sp.user_id
  WHERE sp.permission = 'clinical' AND sp.revoked_at IS NULL AND u.role <> 'owner';
  IF v_n > 0 THEN
    RAISE NOTICE 'Sahip dışı etkin "clinical" yetkisi: % kişi (bu kişiler klinik kayıt yazabilir; kontrol edin).', v_n;
  END IF;
END $$;

-- 4.3b Cost audit rows only for lab cost viewers (see 4.3; placed here to shorten the audit_logs lock window).
DROP POLICY IF EXISTS "audit_logs_lab_cost_gate" ON public.audit_logs;
CREATE POLICY "audit_logs_lab_cost_gate" ON public.audit_logs
  AS RESTRICTIVE
  FOR SELECT
  USING (
    entity_type <> 'lab_order_costs'
    OR (SELECT public.clin_can_view_lab_costs())
  );

-- ---------------------------------------------------------------------------
-- 4.5 Migration self-checks. Any failure RAISEs and rolls the whole migration back (enum values included).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_n bigint;
BEGIN
  -- 1. RLS on, exactly one SELECT policy and no write policy; the audit cost gate is RESTRICTIVE.
  SELECT string_agg(t.tbl, ', ') INTO v_bad
  FROM unnest(ARRAY['implant_brands', 'labs', 'patient_implants', 'lab_order_events', 'lab_order_costs',
                    'clinical_settings', 'lab_orders', 'lab_order_items']) AS t(tbl)
  WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', t.tbl)::regclass)
     OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) <> 1
     OR EXISTS (SELECT 1 FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = t.tbl
                  AND (p.cmd <> 'SELECT' OR p.permissive <> 'PERMISSIVE'
                       OR p.roles <> ARRAY['authenticated']::name[] OR p.qual NOT ILIKE '%current_clinic_id%'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: RLS / politika yapısı beklenen gibi değil: %', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs'
                   AND p.policyname = 'audit_logs_lab_cost_gate' AND p.permissive = 'RESTRICTIVE'
                   AND p.cmd = 'SELECT') THEN
    RAISE EXCEPTION 'Öz denetim: audit_logs_lab_cost_gate yok veya kısıtlayıcı değil.';
  END IF;

  -- 2. Enum: 8 labels in the documented order (read from the catalog as text; never cast here).
  SELECT string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder) INTO v_bad
  FROM pg_enum e WHERE e.enumtypid = 'public.lab_order_status'::regtype;
  IF v_bad IS DISTINCT FROM 'draft,submitted,in_progress,try_in,revision,ready,delivered,cancelled' THEN
    RAISE EXCEPTION 'Öz denetim: lab_order_status değerleri beklenen sırada değil: %', v_bad;
  END IF;

  -- 3. Stock links: deferred FK and both guard triggers, enabled.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conrelid = 'public.stock_movements'::regclass AND c.conname = 'stock_movements_implant_fkey'
                   AND c.contype = 'f' AND c.condeferrable AND c.condeferred) THEN
    RAISE EXCEPTION 'Öz denetim: stock_movements_implant_fkey yok veya ertelenebilir değil.';
  END IF;
  SELECT string_agg(x.t, ', ') INTO v_bad
  FROM (VALUES ('stock_movements', 'clin_movement_link'), ('stock_correction_requests', 'clin_correction_link'),
               ('patient_implants', 'clin_implant_guard'), ('patient_implants', 'clin_implant_refs'),
               ('lab_orders', 'clin_lab_order_mirror'), ('labs', 'clin_lab_rename')) AS x(tbl, t)
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg
                    WHERE tg.tgrelid = format('public.%I', x.tbl)::regclass AND tg.tgname = x.t
                      AND tg.tgenabled <> 'D');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: tetikleyici eksik veya kapalı: %', v_bad;
  END IF;

  -- 4. Lab mirror: every order with a non-blank lab_name has a lab, and lab_name = labs.name.
  SELECT count(*) INTO v_n
  FROM public.lab_orders o
  LEFT JOIN public.labs l ON l.id = o.lab_id
  WHERE o.lab_name IS NOT NULL AND btrim(o.lab_name) <> ''
    AND (o.lab_id IS NULL OR l.id IS NULL OR o.lab_name IS DISTINCT FROM l.name);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Öz denetim: % lab siparişinde laboratuvar bağlantısı / ad yansıması hatalı.', v_n;
  END IF;

  -- 5. lab_orders.status NOT NULL.
  IF NOT (SELECT a.attnotnull FROM pg_attribute a
          WHERE a.attrelid = 'public.lab_orders'::regclass AND a.attname = 'status') THEN
    RAISE EXCEPTION 'Öz denetim: lab_orders.status NOT NULL değil.';
  END IF;

  -- 5b. Patient / doctor FKs of lab_orders: exactly one each, NO ACTION (a patient delete never wipes lab orders).
  SELECT string_agg(x.col, ', ') INTO v_bad
  FROM unnest(ARRAY['patient_id', 'doctor_id']) AS x(col)
  WHERE (SELECT count(*) FILTER (WHERE k.confdeltype <> 'a') = 0 AND count(*) = 1
         FROM pg_constraint k
         WHERE k.conrelid = 'public.lab_orders'::regclass AND k.contype = 'f'
           AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                 WHERE a.attrelid = 'public.lab_orders'::regclass AND a.attname = x.col)]::smallint[])
        IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: lab_orders yabancı anahtarları NO ACTION değil veya birden fazla: %', v_bad;
  END IF;

  -- 6. Transition matrix: 64 pairs against the §1.5 table (21 allowed; same vectors as the vitest file).
  SELECT string_agg(f.s || '>' || t.s, ', ') INTO v_bad
  FROM unnest(ARRAY['draft', 'submitted', 'in_progress', 'try_in', 'revision', 'ready', 'delivered', 'cancelled']) AS f(s)
  CROSS JOIN unnest(ARRAY['draft', 'submitted', 'in_progress', 'try_in', 'revision', 'ready', 'delivered', 'cancelled']) AS t(s)
  WHERE public.clin__lab_transition_ok(f.s, t.s) IS DISTINCT FROM ((f.s || '>' || t.s) IN (
    'draft>submitted', 'draft>cancelled',
    'submitted>in_progress', 'submitted>try_in', 'submitted>ready', 'submitted>cancelled',
    'in_progress>try_in', 'in_progress>ready', 'in_progress>cancelled',
    'try_in>revision', 'try_in>ready', 'try_in>delivered', 'try_in>cancelled',
    'revision>in_progress', 'revision>try_in', 'revision>ready', 'revision>cancelled',
    'ready>revision', 'ready>delivered', 'ready>cancelled',
    'delivered>ready'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: lab durum geçiş tablosu hatalı: %', v_bad;
  END IF;
  SELECT count(*) INTO v_n
  FROM unnest(ARRAY['draft', 'submitted', 'in_progress', 'try_in', 'revision', 'ready', 'delivered', 'cancelled']) AS f(s)
  CROSS JOIN unnest(ARRAY['draft', 'submitted', 'in_progress', 'try_in', 'revision', 'ready', 'delivered', 'cancelled']) AS t(s)
  WHERE public.clin__lab_transition_ok(f.s, t.s);
  IF v_n <> 21 THEN
    RAISE EXCEPTION 'Öz denetim: izinli lab durum geçişi sayısı 21 değil: %', v_n;
  END IF;
  IF public.clin__lab_allowed_next('try_in') IS DISTINCT FROM '["revision", "ready", "delivered", "cancelled"]'::jsonb
     OR public.clin__lab_allowed_next('cancelled') IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'Öz denetim: allowed_next beklenen değerleri vermiyor.';
  END IF;

  -- 7. FDI predicate: the 32 permanent teeth pass, everything else fails (primary teeth included).
  SELECT count(*) INTO v_n
  FROM generate_series(-20, 120) AS g(t)
  WHERE public.clin__fdi_ok(g.t) IS DISTINCT FROM (g.t / 10 BETWEEN 1 AND 4 AND g.t % 10 BETWEEN 1 AND 8 AND g.t > 0);
  IF v_n > 0 OR (SELECT count(*) FROM generate_series(0, 99) AS g(t) WHERE public.clin__fdi_ok(g.t)) <> 32
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[10, 19, 20, 29, 30, 39, 40, 49, 51, 55, 85, 0, 99]) AS x(t)
                WHERE public.clin__fdi_ok(x.t))
     OR public.clin__fdi_ok(NULL) THEN
    RAISE EXCEPTION 'Öz denetim: FDI diş numarası kuralı hatalı.';
  END IF;

  -- Pure validators.
  IF public.clin__day(' 2026-02-28 ', 'CL_FILTER') <> DATE '2026-02-28' OR public.clin__day('', 'CL_FILTER') IS NOT NULL
     OR public.clin__tr_lower('İMPLANT Işık') <> 'implant işik'
     OR public.clin__tr_lower('Kurgu Implant RUN') <> public.clin__tr_lower('KURGU İMPLANT run')
     OR public.clin__lab_items('[{"item_type": "crown", "tooth_number": "36, 37", "quantity": 2}]'::jsonb)
        <> '[{"item_type": "crown", "tooth_number": "36, 37", "material": "", "color_code": "", "quantity": 2,
              "description": ""}]'::jsonb
     OR public.clin__lab_items_norm('[{"item_type": " veneer ", "tooth_number": "16 ve 17", "quantity": 150}]'::jsonb)
        IS DISTINCT FROM '[{"item_type": "veneer", "tooth_number": "16 ve 17", "material": "", "color_code": "",
                            "quantity": 150, "description": ""}]'::jsonb
     OR public.clin__lab_items_norm('[{"item_type": "crown", "quantity": 1.5}]'::jsonb) -> 0 -> 'quantity'
        IS DISTINCT FROM 'null'::jsonb
     OR public.clin__lab_items_norm('[1]'::jsonb) IS NOT NULL
     OR public.clin__lab_items_norm('[]'::jsonb) IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'Öz denetim: klinik doğrulayıcıları beklenen değerleri vermiyor.';
  END IF;

  -- Rules that could not be validated on old rows (reported only).
  SELECT string_agg(c.conname, ', ') INTO v_bad
  FROM pg_constraint c
  WHERE c.conrelid IN ('public.lab_orders'::regclass, 'public.lab_order_items'::regclass) AND NOT c.convalidated;
  IF v_bad IS NOT NULL THEN
    RAISE NOTICE 'Eski satırlarda doğrulanamayan kurallar (yeni ve değişen satırlara uygulanıyor): %', v_bad;
  END IF;
END $$;

-- 8. Replay inside a block that is always rolled back: a temporary clinic 'p9-test-selfcheck-<random>' with a
--    synthetic patient, doctor, brand, lab, A-level card and serial batch. Checks the tooth unique index, the
--    'failed' release, the stock shape rule, the issue -> implant link (trigger + one movement), the implant and
--    material JSON, the lab mirror / JSON, and the test purge. Nothing survives the block.
DO $$
DECLARE
  v_today date := public.clinic_today();
  v_clinic uuid := gen_random_uuid();
  v_slug text := 'p9-test-selfcheck-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_patient uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_doctor uuid := gen_random_uuid();
  v_brand uuid := gen_random_uuid();
  v_lab uuid := gen_random_uuid();
  v_order uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_i1 uuid := gen_random_uuid();
  v_i2 uuid := gen_random_uuid();
  v_i3 uuid := gen_random_uuid();
  v_imp uuid := gen_random_uuid();
  v_op uuid := gen_random_uuid();
  v_loc uuid;
  v_recv uuid;
  v_batch uuid;
  v_stock jsonb;
  v_mid uuid;
  v_j jsonb;
  v_constraint text;
  v_n bigint;
  v_fail text[] := '{}'::text[];
BEGIN
  BEGIN
    INSERT INTO public.clinics (id, name, slug) VALUES (v_clinic, 'Öz denetim P9', v_slug);
    INSERT INTO public.patients (id, clinic_id, full_name, phone)
    VALUES (v_patient, v_clinic, 'Öz denetim hasta', '5000000099');
    INSERT INTO public.users (id, clinic_id, role, full_name, email, is_active)
    VALUES (v_user, v_clinic, 'doctor', 'Öz denetim hekim', 'p9-selfcheck-' || left(v_slug, 40) || '@example.invalid', true);
    INSERT INTO public.doctors (id, clinic_id, user_id) VALUES (v_doctor, v_clinic, v_user);
    INSERT INTO public.implant_brands (id, clinic_id, name, name_key)
    VALUES (v_brand, v_clinic, '  Öz Denetim Marka  ', 'x');
    IF (SELECT b.name || '|' || b.name_key FROM public.implant_brands b WHERE b.id = v_brand)
       IS DISTINCT FROM 'Öz Denetim Marka|öz denetim marka' THEN
      v_fail := array_append(v_fail, 'marka adı / anahtarı');
    END IF;

    -- Tooth unique index: a second live implant on the same tooth is refused; a 'failed' one frees the tooth.
    INSERT INTO public.patient_implants (id, clinic_id, patient_id, tooth_fdi, brand_id, diameter_mm, length_mm,
                                         placed_on, stock_source, source_note)
    VALUES (v_i1, v_clinic, v_patient, 36, v_brand, 4, 10, v_today, 'external', 'Öz denetim');
    BEGIN
      INSERT INTO public.patient_implants (id, clinic_id, patient_id, tooth_fdi, brand_id, diameter_mm, length_mm,
                                           placed_on, stock_source, source_note)
      VALUES (v_i2, v_clinic, v_patient, 36, v_brand, 4, 10, v_today, 'external', 'Öz denetim');
      v_fail := array_append(v_fail, 'aynı dişe ikinci etkin implant kabul edildi');
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'patient_implants_tooth_active' THEN
        v_fail := array_append(v_fail, 'diş tekilliği: ' || coalesce(v_constraint, '-'));
      END IF;
    END;
    UPDATE public.patient_implants SET status = 'failed' WHERE id = v_i1;
    INSERT INTO public.patient_implants (id, clinic_id, patient_id, tooth_fdi, brand_id, diameter_mm, length_mm,
                                         placed_on, stock_source, source_note)
    VALUES (v_i2, v_clinic, v_patient, 36, v_brand, 4, 10, v_today, 'external', 'Öz denetim');

    -- Stock shape: 'external' without a note is refused.
    BEGIN
      INSERT INTO public.patient_implants (id, clinic_id, patient_id, tooth_fdi, brand_id, diameter_mm, length_mm,
                                           placed_on, stock_source, source_note)
      VALUES (v_i3, v_clinic, v_patient, 37, v_brand, 4, 10, v_today, 'external', '');
      v_fail := array_append(v_fail, 'notsuz stok dışı implant kabul edildi');
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'patient_implants_stock_shape' THEN
        v_fail := array_append(v_fail, 'stok şekli: ' || coalesce(v_constraint, '-'));
      END IF;
    END;

    -- Issue -> implant link: one A-level issue of 1 written through stock__outbound with the setting; the trigger
    -- fills implant_record_id; the implant row then points at the movement (the 5.3 sequence without a session).
    INSERT INTO public.stock_items (id, clinic_id, item_code, item_name, category, unit_price, quantity_minimum,
                                    tracking_level, brand, model)
    VALUES (v_item, v_clinic, 'ZZ-P9-' || left(replace(v_item::text, '-', ''), 12), 'Öz denetim implant', 'materials',
            0, 0, 'A', 'Öz Denetim Marka', 'GM');
    -- The card's brand text 'Öz Denetim Marka' names the directory brand (implant brand must match the card).
    IF public.clin__stock_item_brand(v_clinic, v_item) IS DISTINCT FROM v_brand THEN
      v_fail := array_append(v_fail, 'stok kartı markası dizindeki markayla eşleşmedi');
    END IF;
    v_loc := public.stock__default_location(v_clinic);
    v_recv := public.stock__receive_line(v_clinic, v_user, gen_random_uuid(), v_today, true, v_item, v_loc, 1, 'usage',
                                         NULL, 'L1', 'S1', '2099-12-31', 50000, 'usage', NULL, NULL, NULL);
    SELECT m.batch_id INTO v_batch FROM public.stock_movements m WHERE m.id = v_recv;

    PERFORM set_config('clin.implant_record_id', v_imp::text, true);
    v_stock := public.stock__outbound(v_clinic, v_user, v_op, v_today, 'issue', v_item, v_loc, NULL, 1, 'usage', NULL,
                                      v_batch, v_patient, NULL, v_doctor, 'İmplant kaydı · diş 46');
    PERFORM set_config('clin.implant_record_id', '', true);
    IF jsonb_array_length(coalesce(v_stock -> 'movements', '[]'::jsonb)) <> 1 THEN
      v_fail := array_append(v_fail, 'implant çıkışı tek hareket değil');
    END IF;
    v_mid := (v_stock -> 'movements' -> 0 ->> 'id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.id = v_mid AND m.implant_record_id = v_imp
                     AND m.patient_id = v_patient AND m.doctor_id = v_doctor AND m.quantity = 1) THEN
      v_fail := array_append(v_fail, 'stok hareketi implant kaydına bağlanmadı');
    END IF;
    -- The setting is cleared: a later issue in the same transaction gets no link.
    IF nullif(current_setting('clin.implant_record_id', true), '') IS NOT NULL THEN
      v_fail := array_append(v_fail, 'clin.implant_record_id temizlenmedi');
    END IF;

    INSERT INTO public.patient_implants (id, clinic_id, patient_id, tooth_fdi, brand_id, model, diameter_mm, length_mm,
                                         placed_on, doctor_id, stock_source, stock_item_id, batch_id, stock_movement_id,
                                         lot_text, serial_text, status)
    VALUES (v_imp, v_clinic, v_patient, 46, v_brand, 'GM', 4.1, 11.5, v_today, v_doctor, 'stock', v_item, v_batch, v_mid,
            'L1', 'S1', 'healing');

    v_j := public.clin__implant_json(v_clinic, v_imp);
    IF v_j IS NULL OR v_j ->> 'stock_state' IS DISTINCT FROM 'issued' OR (v_j ->> 'tooth_fdi')::integer <> 46
       OR v_j -> 'diameter_mm' IS DISTINCT FROM '4.1'::jsonb OR v_j ->> 'serial_text' IS DISTINCT FROM 'S1'
       OR (v_j ->> 'control_due')::boolean THEN
      v_fail := array_append(v_fail, 'implant JSON: ' || coalesce(left(v_j::text, 300), '-'));
    END IF;

    SELECT count(*) INTO v_n
    FROM public.clin__material_rows(v_clinic, true) m
    WHERE m.patient_id = v_patient AND m.movement_id = v_mid AND m.net_qty = 1 AND m.cost_cents = 50000
      AND (m.j ->> 'implant_id')::uuid = v_imp;
    IF v_n <> 1 THEN
      v_fail := array_append(v_fail, 'Sarf satırı implant çıkışını göstermiyor');
    END IF;
    SELECT count(*) INTO v_n
    FROM public.clin__material_rows(v_clinic, false) m
    WHERE m.movement_id = v_mid AND (m.j ? 'cost_cents' OR m.j ? 'unit_cost_cents');
    IF v_n <> 0 THEN
      v_fail := array_append(v_fail, 'Sarf satırında yetkisiz maliyet anahtarı');
    END IF;

    -- Lab: mirror trigger and order JSON (draft; allowed_next; cost key absent / present by flag).
    INSERT INTO public.labs (id, clinic_id, name, name_key) VALUES (v_lab, v_clinic, 'Öz denetim lab', 'x');
    INSERT INTO public.lab_orders (id, clinic_id, patient_id, doctor_id, order_number, due_date, lab_id, lab_name)
    VALUES (v_order, v_clinic, v_patient, v_doctor, 'LAB-P9-' || left(replace(v_order::text, '-', ''), 12),
            v_today + 7, v_lab, 'yanlış');
    INSERT INTO public.lab_order_items (clinic_id, lab_order_id, item_type, tooth_number, quantity)
    VALUES (v_clinic, v_order, 'crown', '36', 2);
    IF (SELECT o.lab_name FROM public.lab_orders o WHERE o.id = v_order) IS DISTINCT FROM 'Öz denetim lab' THEN
      v_fail := array_append(v_fail, 'lab adı yansıması');
    END IF;
    UPDATE public.labs SET name = 'Öz denetim lab 2' WHERE id = v_lab;
    IF (SELECT o.lab_name FROM public.lab_orders o WHERE o.id = v_order) IS DISTINCT FROM 'Öz denetim lab 2' THEN
      v_fail := array_append(v_fail, 'lab yeniden adlandırma yansıması');
    END IF;
    v_j := public.clin__lab_order_json(v_clinic, v_order, false, false);
    IF v_j IS NULL OR v_j ->> 'status' IS DISTINCT FROM 'draft'
       OR v_j -> 'allowed_next' IS DISTINCT FROM '["submitted", "cancelled"]'::jsonb
       OR v_j ->> 'items_summary' IS DISTINCT FROM 'Kron ×2 (36)'
       OR (v_j ->> 'is_late')::boolean OR v_j ? 'cost' THEN
      v_fail := array_append(v_fail, 'lab JSON: ' || coalesce(left(v_j::text, 300), '-'));
    END IF;
    v_j := public.clin__lab_order_json(v_clinic, v_order, true, false);
    IF NOT (v_j ? 'cost') OR v_j -> 'cost' <> 'null'::jsonb THEN
      v_fail := array_append(v_fail, 'lab JSON maliyet anahtarı');
    END IF;

    -- Test purge: every clinical and stock row of the temporary clinic goes; deferred links check clean.
    v_j := public.clin__purge_test_clinic(v_clinic);
    IF NOT coalesce((v_j ->> 'found')::boolean, false)
       OR EXISTS (SELECT 1 FROM public.patient_implants WHERE clinic_id = v_clinic)
       OR EXISTS (SELECT 1 FROM public.lab_orders WHERE clinic_id = v_clinic)
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE clinic_id = v_clinic)
       OR EXISTS (SELECT 1 FROM public.implant_brands WHERE clinic_id = v_clinic) THEN
      v_fail := array_append(v_fail, 'test temizliği: ' || coalesce(left(v_j::text, 300), '-'));
    END IF;

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (implant / stok / lab): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'clin_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;
END $$;

-- Make the API see the new tables and functions now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;
