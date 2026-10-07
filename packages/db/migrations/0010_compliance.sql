-- S8.1 Turkish compliance (e-Arşiv, e-Nabız, audit logs)

-- Audit log table (KVKK compliance)
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type text NOT NULL, -- 'patient', 'appointment', 'treatment', 'payment', etc.
  entity_id uuid NOT NULL,
  action text NOT NULL, -- 'create', 'read', 'update', 'delete'
  changes jsonb, -- Previous and new values for updates
  ip_address text,
  user_agent text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- e-Arşiv (e-Invoice) records
CREATE TABLE einvoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  invoice_number text NOT NULL UNIQUE,
  treatment_plan_id uuid REFERENCES treatment_plans(id) ON DELETE SET NULL,
  total_amount numeric NOT NULL,
  tax_amount numeric NOT NULL,
  status text DEFAULT 'pending', -- 'pending', 'sent', 'approved', 'cancelled'
  einvoice_uuid text, -- UUID from e-Arşiv service
  sent_at timestamp with time zone,
  approved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- e-Nabız integration logs (patient medical history to Turkish healthcare system)
CREATE TABLE enabiz_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  patient_tc_no text, -- Turkish ID encrypted
  record_type text NOT NULL, -- 'appointment', 'treatment', 'prescription'
  record_data jsonb NOT NULL,
  status text DEFAULT 'pending', -- 'pending', 'sent', 'confirmed', 'failed'
  error_message text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- GDPR/KVKK consent records
CREATE TABLE consent_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consent_type text NOT NULL, -- 'kvkk', 'marketing', 'sms', 'email'
  given boolean NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  valid_until timestamp with time zone
);

-- Regulatory compliance checklist
CREATE TABLE compliance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  check_type text NOT NULL, -- 'patient_records', 'invoice_integrity', 'appointment_logs'
  status text DEFAULT 'pending', -- 'pending', 'passed', 'failed', 'review_needed'
  checked_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX idx_audit_logs_clinic_id ON audit_logs(clinic_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE INDEX idx_einvoices_clinic_id ON einvoices(clinic_id);
CREATE INDEX idx_einvoices_patient_id ON einvoices(patient_id);
CREATE INDEX idx_einvoices_status ON einvoices(status);

CREATE INDEX idx_enabiz_logs_clinic_id ON enabiz_logs(clinic_id);
CREATE INDEX idx_enabiz_logs_patient_id ON enabiz_logs(patient_id);
CREATE INDEX idx_enabiz_logs_status ON enabiz_logs(status);

CREATE INDEX idx_consent_logs_clinic_id ON consent_logs(clinic_id);
CREATE INDEX idx_consent_logs_patient_id ON consent_logs(patient_id);

CREATE INDEX idx_compliance_checks_clinic_id ON compliance_checks(clinic_id);
CREATE INDEX idx_compliance_checks_status ON compliance_checks(status);

-- Enable RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE enabiz_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_checks ENABLE ROW LEVEL SECURITY;

-- RLS Policies for audit_logs
CREATE POLICY "audit_logs_clinic_isolation" ON audit_logs FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "audit_logs_insert_own_clinic" ON audit_logs FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for einvoices
CREATE POLICY "einvoices_clinic_isolation" ON einvoices FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "einvoices_insert_own_clinic" ON einvoices FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "einvoices_update_own_clinic" ON einvoices FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for enabiz_logs
CREATE POLICY "enabiz_logs_clinic_isolation" ON enabiz_logs FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "enabiz_logs_insert_own_clinic" ON enabiz_logs FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for consent_logs
CREATE POLICY "consent_logs_clinic_isolation" ON consent_logs FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "consent_logs_insert_own_clinic" ON consent_logs FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for compliance_checks
CREATE POLICY "compliance_checks_clinic_isolation" ON compliance_checks FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "compliance_checks_insert_own_clinic" ON compliance_checks FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "compliance_checks_update_own_clinic" ON compliance_checks FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
