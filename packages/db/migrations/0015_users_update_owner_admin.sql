BEGIN;

-- current_app_role() reads users.role, so a clinic-wide update policy let any staff member promote themselves.
DROP POLICY IF EXISTS "users_update_own_clinic" ON public.users;
DROP POLICY IF EXISTS "users_update_owner_admin" ON public.users;
CREATE POLICY "users_update_owner_admin" ON public.users
  FOR UPDATE
  USING (clinic_id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'))
  WITH CHECK (clinic_id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'));

COMMIT;
