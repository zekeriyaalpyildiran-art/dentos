-- Supabase Custom JWT Hook
-- Add clinic_id and role to JWT token

-- Create function to add clinic_id to JWT
CREATE OR REPLACE FUNCTION auth.get_clinic_id(user_id uuid)
RETURNS uuid AS $$
  SELECT clinic_id FROM users WHERE auth_user_id = user_id LIMIT 1;
$$ LANGUAGE SQL STABLE;

-- PostgreSQL policy that uses it
-- This gets attached to Supabase's JWT hook in Settings → Auth → Providers

-- The hook should be set up in Supabase Dashboard:
-- 1. Go to Authentication → Providers → Supabase
-- 2. Set "JWT Secret" if needed
-- 3. Create a custom SQL hook that adds clinic_id:

/*
In Supabase Dashboard JWT Hook (SQL):
SELECT
  auth.uid() as sub,
  (SELECT clinic_id FROM public.users WHERE auth_user_id = auth.uid()) as clinic_id,
  (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) as role,
  auth.email() as email,
  now() as iat,
  now() + interval '1 hour' as exp
*/

-- Alternatively, set via Supabase CLI:
-- supabase secrets set JWT_SECRET="your-super-secret-key"

-- Then add this SQL to a Postgres function:
CREATE OR REPLACE FUNCTION get_custom_claims(user_id uuid)
RETURNS jsonb AS $$
BEGIN
  RETURN jsonb_build_object(
    'clinic_id', (SELECT clinic_id FROM users WHERE auth_user_id = user_id),
    'role', (SELECT role FROM users WHERE auth_user_id = user_id)
  );
END;
$$ LANGUAGE plpgsql STABLE;
