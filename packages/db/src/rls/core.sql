-- Enable RLS on core tables
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE chairs ENABLE ROW LEVEL SECURITY;

-- Clinics: Owner/Admin can see all, others see only their clinic
CREATE POLICY "clinics_owner_admin_see_all" ON clinics
  FOR SELECT
  USING (
    auth.jwt() ->> 'role' IN ('owner', 'admin')
  );

CREATE POLICY "clinics_users_see_own" ON clinics
  FOR SELECT
  USING (
    id = (auth.jwt() ->> 'clinic_id')::uuid
  );

-- Users: Within clinic_id
CREATE POLICY "users_clinic_isolation" ON users
  FOR SELECT
  USING (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "users_insert_own_clinic" ON users
  FOR INSERT
  WITH CHECK (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
    AND auth.jwt() ->> 'role' IN ('owner', 'admin')
  );

CREATE POLICY "users_update_own_clinic" ON users
  FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- Doctors: Within clinic_id
CREATE POLICY "doctors_clinic_isolation" ON doctors
  FOR SELECT
  USING (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "doctors_insert_own_clinic" ON doctors
  FOR INSERT
  WITH CHECK (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

-- Chairs: Within clinic_id
CREATE POLICY "chairs_clinic_isolation" ON chairs
  FOR SELECT
  USING (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "chairs_insert_own_clinic" ON chairs
  FOR INSERT
  WITH CHECK (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );
