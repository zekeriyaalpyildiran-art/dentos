-- S1.1 Patients schema + KVKK audit trail
-- Note: patient_gender enum already exists from S0.2 (0001_init.sql)

-- Create patients table
CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  auth_user_id uuid UNIQUE,
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  gender patient_gender,
  birth_date text,
  address text,
  tc_hash text,
  kvkk_consent boolean DEFAULT false,
  consent_date timestamp with time zone,
  notes text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(clinic_id, phone)
);

-- Create patient access log (KVKK audit trail)
CREATE TABLE patient_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  accessed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  changes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Create indexes
CREATE INDEX idx_patients_clinic_id ON patients(clinic_id);
CREATE INDEX idx_patients_phone ON patients(phone);
CREATE INDEX idx_patients_auth_user_id ON patients(auth_user_id);
CREATE INDEX idx_access_logs_clinic_id ON patient_access_logs(clinic_id);
CREATE INDEX idx_access_logs_patient_id ON patient_access_logs(patient_id);
CREATE INDEX idx_access_logs_user_id ON patient_access_logs(accessed_by_user_id);

-- Enable RLS
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_access_logs ENABLE ROW LEVEL SECURITY;

-- RLS policies: patients table
CREATE POLICY "patients_clinic_isolation" ON patients
  FOR SELECT
  USING (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "patients_insert_own_clinic" ON patients
  FOR INSERT
  WITH CHECK (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "patients_update_own_clinic" ON patients
  FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS policies: patient access logs (audit trail read-only for clinic staff)
CREATE POLICY "access_logs_clinic_isolation" ON patient_access_logs
  FOR SELECT
  USING (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "access_logs_insert_own_clinic" ON patient_access_logs
  FOR INSERT
  WITH CHECK (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
    AND accessed_by_user_id = (auth.uid())
  );
