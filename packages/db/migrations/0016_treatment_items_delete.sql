BEGIN;

DROP POLICY IF EXISTS "treatment_items_delete_own_clinic" ON public.treatment_items;
CREATE POLICY "treatment_items_delete_own_clinic" ON public.treatment_items
  FOR DELETE USING (clinic_id = public.current_clinic_id());

COMMIT;
