-- 0041_po_owner_approval.sql — purchase orders above a limit are approved by the clinic owner only.
--
-- Owner 2026-11-06 ("10.000 TL üstü"): the administrative manager (role admin, stock_manage + stock_cost_view) runs
-- purchasing; an order whose total is above 10.000 TL needs the owner's approval. Below the limit the manager (any
-- stock manager) approves as before.
--
--   stock_settings.po_owner_approval_cents  the limit in kuruş (NULL = rule off). Set to 1.000.000 (10.000 TL) for
--                                           every clinic here; no screen edits it.
--   stock__po_needs_owner(clinic, order)    a PENDING order needs the owner when the limit is set and
--                                           the priced total is above it, or a line has no price (the total cannot
--                                           be checked), or it has no line.
--   stock_po_transition                     'approve' by anyone but the owner on such an order → E_PO_OWNER_APPROVAL
--                                           (42501). Checked under the order's row lock, after the replay check.
--   stock_po_list / stock_po_detail         every order carries owner_approval (bool) and, when it is true,
--                                           owner_approval_limit_cents; for a non-owner its actions say
--                                           can_approve = false, approve_blocked = 'owner'.
--   mgmt_owner_approval_count()             pending orders waiting for the owner (Yönetim tile, owner's menu badge).
--
-- The 0025 cores are untouched; only the three public wrappers are replaced (same signatures, 0025 bodies plus the
-- rule). Purchases outside purchase orders (a direct stock receipt, a Finans expense) are not covered.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.stock_settings
  ADD COLUMN IF NOT EXISTS po_owner_approval_cents bigint
    CHECK (po_owner_approval_cents IS NULL OR po_owner_approval_cents BETWEEN 1 AND 100000000000);

CREATE OR REPLACE FUNCTION public.stock__po_needs_owner(p_clinic uuid, p_order uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT s.po_owner_approval_cents IS NOT NULL
           AND o.status = 'pending'
           AND (t.lines = 0 OR t.unpriced > 0 OR t.total_cents > s.po_owner_approval_cents)
    FROM public.purchase_orders o
    JOIN public.stock_settings s ON s.clinic_id = o.clinic_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS lines,
             count(*) FILTER (WHERE c.po_item_id IS NULL) AS unpriced,
             coalesce(sum(round(li.qty_ordered * c.unit_price_cents)) FILTER (WHERE c.po_item_id IS NOT NULL), 0)
               AS total_cents
      FROM public.purchase_order_items li
      LEFT JOIN public.purchase_order_item_costs c ON c.po_item_id = li.id
      WHERE li.order_id = o.id AND li.clinic_id = p_clinic
    ) t
    WHERE o.id = p_order AND o.clinic_id = p_clinic), false)
$$;

-- An order object of stock_po_list / stock_po_detail with the owner rule applied for the caller.
CREATE OR REPLACE FUNCTION public.stock__po_owner_mark(p_order jsonb, p_clinic uuid, p_is_owner boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_need boolean;
  v_out jsonb;
BEGIN
  IF p_order IS NULL OR jsonb_typeof(p_order) <> 'object' OR NOT (p_order ? 'id') THEN
    RETURN p_order;
  END IF;
  v_need := public.stock__po_needs_owner(p_clinic, (p_order ->> 'id')::uuid);
  v_out := p_order || jsonb_build_object('owner_approval', v_need);
  IF v_need THEN
    v_out := v_out || jsonb_build_object('owner_approval_limit_cents',
                                         (SELECT s.po_owner_approval_cents FROM public.stock_settings s
                                          WHERE s.clinic_id = p_clinic));
    IF NOT p_is_owner AND jsonb_typeof(v_out -> 'actions') = 'object' THEN
      v_out := jsonb_set(v_out, '{actions}',
                         (v_out -> 'actions') || jsonb_build_object('can_approve', false, 'approve_blocked', 'owner'));
    END IF;
  END IF;
  RETURN v_out;
END;
$$;

-- 0025 8.2 body plus the owner rule for 'approve'.
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

  IF p_action = 'approve' THEN
    -- Same row lock the core takes (pending edits lock the order too), so the lines cannot change under the check.
    PERFORM public.stock__po_lock(v_clinic, p_order_id);
    IF public.stock__po_needs_owner(v_clinic, p_order_id)
       AND coalesce(public.current_app_role(), '') <> 'owner' THEN
      RAISE EXCEPTION USING
        MESSAGE = 'Bu sipariş onay sınırının üzerinde (veya fiyatsız satırı var); yalnızca klinik sahibi onaylayabilir.',
        ERRCODE = '42501', HINT = 'E_PO_OWNER_APPROVAL';
    END IF;
  END IF;

  v_order := public.stock__po_transition_core(v_clinic, v_actor, p_order_id, p_version, p_action, p_reason);

  RETURN public.stock__op_finish(v_clinic, p_operation_key, jsonb_build_object('ok', true, 'order', v_order));
END;
$$;

-- 0025 9.1 body; every row gets the owner rule.
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
  v_owner boolean := coalesce(public.current_app_role() = 'owner', false);
  v_res jsonb;
BEGIN
  IF NOT (v_manage OR v_cost) THEN
    PERFORM public.stock__raise('E_PO_READ');
  END IF;
  v_res := public.stock__po_list_core(v_clinic, public.current_app_user_id(), public.clinic_today(), v_cost, v_manage,
                                      p_filters, p_page)
           || public.stock__flags();
  IF jsonb_typeof(v_res -> 'rows') = 'array' THEN
    v_res := jsonb_set(v_res, '{rows}', coalesce((
      SELECT jsonb_agg(public.stock__po_owner_mark(e.r, v_clinic, v_owner) ORDER BY e.ord)
      FROM jsonb_array_elements(v_res -> 'rows') WITH ORDINALITY e(r, ord)), '[]'::jsonb));
  END IF;
  RETURN v_res;
END;
$$;

-- 0025 9.2 body; the order gets the owner rule.
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
  v_owner boolean := coalesce(public.current_app_role() = 'owner', false);
  v_res jsonb;
BEGIN
  IF NOT (v_manage OR v_cost) THEN
    PERFORM public.stock__raise('E_PO_READ');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = p_order_id AND o.clinic_id = v_clinic) THEN
    PERFORM public.stock__raise('E_PO_NOT_FOUND');
  END IF;
  v_res := public.stock__po_json(v_clinic, p_order_id, v_actor, v_cost, v_manage, public.clinic_today())
           || public.stock__flags();
  IF jsonb_typeof(v_res -> 'order') = 'object' THEN
    v_res := jsonb_set(v_res, '{order}', public.stock__po_owner_mark(v_res -> 'order', v_clinic, v_owner));
  END IF;
  RETURN v_res;
END;
$$;

-- Pending orders waiting for the owner's approval (owner and admins: Yönetim, the owner's menu badge).
CREATE OR REPLACE FUNCTION public.mgmt_owner_approval_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic uuid := public.mgmt__require();
BEGIN
  RETURN (SELECT count(*)::integer FROM public.purchase_orders o
          WHERE o.clinic_id = v_clinic AND o.status = 'pending' AND public.stock__po_needs_owner(v_clinic, o.id));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.stock__po_needs_owner(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stock__po_owner_mark(jsonb, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mgmt_owner_approval_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mgmt_owner_approval_count() TO authenticated;
-- The replaced wrappers keep their 0025 grants (CREATE OR REPLACE keeps privileges); restated for clarity.
REVOKE EXECUTE ON FUNCTION public.stock_po_transition(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.stock_po_list(jsonb, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.stock_po_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_po_transition(uuid, uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_po_list(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_po_detail(uuid) TO authenticated;

-- The owner's limit: 10.000 TL for every clinic (a clinic without a settings row gets one with the defaults).
INSERT INTO public.stock_settings (clinic_id, po_owner_approval_cents)
SELECT c.id, 1000000 FROM public.clinics c
ON CONFLICT (clinic_id) DO UPDATE
  SET po_owner_approval_cents = EXCLUDED.po_owner_approval_cents,
      version = public.stock_settings.version + 1,
      updated_at = now()
  WHERE public.stock_settings.po_owner_approval_cents IS DISTINCT FROM EXCLUDED.po_owner_approval_cents;

-- Self-check (rolls the migration back on failure).
DO $chk$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.clinics c
  LEFT JOIN public.stock_settings s ON s.clinic_id = c.id
  WHERE s.po_owner_approval_cents IS DISTINCT FROM 1000000;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '0041 self-check: % clinic(s) without the 10.000 TL limit', v_bad;
  END IF;
  IF public.stock__po_needs_owner((SELECT id FROM public.clinics LIMIT 1), gen_random_uuid()) THEN
    RAISE EXCEPTION '0041 self-check: unknown order needs the owner';
  END IF;
  IF has_function_privilege('authenticated', 'public.stock__po_needs_owner(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.stock_po_transition(uuid, uuid, integer, text, text)',
                                   'EXECUTE') THEN
    RAISE EXCEPTION '0041 self-check: function privileges';
  END IF;
END
$chk$;

COMMIT;
