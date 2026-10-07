-- S5.1 Treatment plans and payment processing

-- Treatment plan status enum
CREATE TYPE treatment_status AS ENUM ('draft', 'proposed', 'approved', 'in_progress', 'completed', 'cancelled');

-- Treatment plans table
CREATE TABLE treatment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  total_cost numeric NOT NULL,
  status treatment_status DEFAULT 'draft',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone
);

-- Treatment items (procedures in a plan)
CREATE TABLE treatment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  treatment_plan_id uuid NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  procedure_id uuid REFERENCES procedures_catalog(id),
  procedure_name text NOT NULL,
  quantity integer DEFAULT 1,
  unit_price numeric NOT NULL,
  total_price numeric NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Payment terms enum
CREATE TYPE payment_status AS ENUM ('pending', 'partial', 'paid', 'overdue', 'cancelled');

-- Payments table
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  treatment_plan_id uuid NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  status payment_status DEFAULT 'pending',
  payment_method text, -- 'cash', 'card', 'transfer', 'installment'
  transaction_id text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  paid_at timestamp with time zone,
  due_date date
);

-- Indexes
CREATE INDEX idx_treatment_plans_clinic_id ON treatment_plans(clinic_id);
CREATE INDEX idx_treatment_plans_patient_id ON treatment_plans(patient_id);
CREATE INDEX idx_treatment_plans_doctor_id ON treatment_plans(doctor_id);
CREATE INDEX idx_treatment_plans_status ON treatment_plans(status);

CREATE INDEX idx_treatment_items_clinic_id ON treatment_items(clinic_id);
CREATE INDEX idx_treatment_items_treatment_plan_id ON treatment_items(treatment_plan_id);

CREATE INDEX idx_payments_clinic_id ON payments(clinic_id);
CREATE INDEX idx_payments_treatment_plan_id ON payments(treatment_plan_id);
CREATE INDEX idx_payments_patient_id ON payments(patient_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_due_date ON payments(due_date);

-- Enable RLS
ALTER TABLE treatment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for treatment_plans
CREATE POLICY "treatment_plans_clinic_isolation" ON treatment_plans FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "treatment_plans_insert_own_clinic" ON treatment_plans FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "treatment_plans_update_own_clinic" ON treatment_plans FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for treatment_items
CREATE POLICY "treatment_items_clinic_isolation" ON treatment_items FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "treatment_items_insert_own_clinic" ON treatment_items FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "treatment_items_update_own_clinic" ON treatment_items FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for payments
CREATE POLICY "payments_clinic_isolation" ON payments FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "payments_insert_own_clinic" ON payments FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "payments_update_own_clinic" ON payments FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
