BEGIN;

CREATE OR REPLACE FUNCTION public.current_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT clinic_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1
$$;

DO $$
DECLARE
  p record;
  q text;
  c text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') LIKE '%auth.jwt()%' OR coalesce(with_check, '') LIKE '%auth.jwt()%')
  LOOP
    q := replace(replace(coalesce(p.qual, ''),
      $a$auth.jwt() ->> 'clinic_id'::text$a$, 'public.current_clinic_id()'),
      $a$auth.jwt() ->> 'role'::text$a$, 'public.current_app_role()');
    c := replace(replace(coalesce(p.with_check, ''),
      $a$auth.jwt() ->> 'clinic_id'::text$a$, 'public.current_clinic_id()'),
      $a$auth.jwt() ->> 'role'::text$a$, 'public.current_app_role()');

    IF p.cmd = 'INSERT' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, c);
    ELSIF p.cmd IN ('SELECT', 'DELETE') THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename, q);
    ELSIF c = '' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename, q);
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, q, c);
    END IF;
  END LOOP;
END $$;

DROP POLICY IF EXISTS "users_read_own_profile" ON public.users;
CREATE POLICY "users_read_own_profile" ON public.users
  FOR SELECT
  USING (auth_user_id = auth.uid());

COMMIT;
