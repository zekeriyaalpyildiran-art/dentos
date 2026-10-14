BEGIN;

ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS lab_name text;

DROP POLICY IF EXISTS "clinics_owner_admin_update" ON public.clinics;
CREATE POLICY "clinics_owner_admin_update" ON public.clinics
  FOR UPDATE
  USING (id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'))
  WITH CHECK (id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'));

COMMIT;
