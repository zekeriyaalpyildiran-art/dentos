BEGIN;

DROP POLICY IF EXISTS "procedures_update_owner_admin" ON public.procedures_catalog;
CREATE POLICY "procedures_update_owner_admin" ON public.procedures_catalog
  FOR UPDATE
  USING (clinic_id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'))
  WITH CHECK (clinic_id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'));

COMMIT;
