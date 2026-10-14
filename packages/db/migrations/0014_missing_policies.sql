BEGIN;

-- 0004 defined these policies but they never reached the live database, leaving the tables unreadable.
DROP POLICY IF EXISTS "appointments_clinic_isolation" ON public.appointments;
CREATE POLICY "appointments_clinic_isolation" ON public.appointments
  FOR SELECT USING (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "appointments_insert_own_clinic" ON public.appointments;
CREATE POLICY "appointments_insert_own_clinic" ON public.appointments
  FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "appointments_update_own_clinic" ON public.appointments;
CREATE POLICY "appointments_update_own_clinic" ON public.appointments
  FOR UPDATE USING (clinic_id = public.current_clinic_id())
  WITH CHECK (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "appointments_delete_own_clinic" ON public.appointments;
CREATE POLICY "appointments_delete_own_clinic" ON public.appointments
  FOR DELETE USING (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "reminders_clinic_isolation" ON public.reminders;
CREATE POLICY "reminders_clinic_isolation" ON public.reminders
  FOR SELECT USING (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "reminders_insert_own_clinic" ON public.reminders;
CREATE POLICY "reminders_insert_own_clinic" ON public.reminders
  FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "reminders_update_own_clinic" ON public.reminders;
CREATE POLICY "reminders_update_own_clinic" ON public.reminders
  FOR UPDATE USING (clinic_id = public.current_clinic_id())
  WITH CHECK (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "waitlist_clinic_isolation" ON public.waitlist;
CREATE POLICY "waitlist_clinic_isolation" ON public.waitlist
  FOR SELECT USING (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "waitlist_insert_own_clinic" ON public.waitlist;
CREATE POLICY "waitlist_insert_own_clinic" ON public.waitlist
  FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "waitlist_update_own_clinic" ON public.waitlist;
CREATE POLICY "waitlist_update_own_clinic" ON public.waitlist
  FOR UPDATE USING (clinic_id = public.current_clinic_id())
  WITH CHECK (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "waitlist_delete_own_clinic" ON public.waitlist;
CREATE POLICY "waitlist_delete_own_clinic" ON public.waitlist
  FOR DELETE USING (clinic_id = public.current_clinic_id());

DROP POLICY IF EXISTS "chairs_update_owner_admin" ON public.chairs;
CREATE POLICY "chairs_update_owner_admin" ON public.chairs
  FOR UPDATE
  USING (clinic_id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'))
  WITH CHECK (clinic_id = public.current_clinic_id() AND public.current_app_role() IN ('owner', 'admin'));

COMMIT;
