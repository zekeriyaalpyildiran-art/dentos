BEGIN;

-- Only draft orders can be deleted; their lab_order_items go with them via ON DELETE CASCADE.
DROP POLICY IF EXISTS "lab_orders_delete_own_clinic_draft" ON public.lab_orders;
CREATE POLICY "lab_orders_delete_own_clinic_draft" ON public.lab_orders
  FOR DELETE USING (clinic_id = public.current_clinic_id() AND status = 'draft');

COMMIT;
