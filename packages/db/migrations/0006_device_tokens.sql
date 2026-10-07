-- S3.1 Device tokens for push notifications

-- Device tokens table (store Expo push tokens)
CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token text NOT NULL,
  device_type text NOT NULL, -- 'ios', 'android', 'web'
  device_name text,
  is_active boolean DEFAULT true,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(patient_id, token)
);

-- Indexes
CREATE INDEX idx_device_tokens_clinic_id ON device_tokens(clinic_id);
CREATE INDEX idx_device_tokens_patient_id ON device_tokens(patient_id);
CREATE INDEX idx_device_tokens_is_active ON device_tokens(is_active);

-- Enable RLS
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "device_tokens_clinic_isolation" ON device_tokens FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "device_tokens_insert_own_clinic" ON device_tokens FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "device_tokens_delete_own" ON device_tokens FOR DELETE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "device_tokens_update_own" ON device_tokens FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
