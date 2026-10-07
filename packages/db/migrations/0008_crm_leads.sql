-- S6.1 CRM - Lead management

-- Lead status enum
CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'interested', 'qualified', 'converted', 'lost');

-- Leads table (prospects/customers)
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  address text,
  source text, -- 'direct', 'referral', 'online', 'social_media', 'other'
  status lead_status DEFAULT 'new',
  assigned_to uuid REFERENCES users(id),
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  converted_at timestamp with time zone
);

-- Lead activities (interactions log)
CREATE TABLE lead_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_type text NOT NULL, -- 'call', 'sms', 'email', 'visit', 'note'
  description text,
  created_by uuid REFERENCES users(id),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX idx_leads_clinic_id ON leads(clinic_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_phone ON leads(phone);

CREATE INDEX idx_lead_activities_clinic_id ON lead_activities(clinic_id);
CREATE INDEX idx_lead_activities_lead_id ON lead_activities(lead_id);
CREATE INDEX idx_lead_activities_created_by ON lead_activities(created_by);

-- Enable RLS
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;

-- RLS Policies for leads
CREATE POLICY "leads_clinic_isolation" ON leads FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "leads_insert_own_clinic" ON leads FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "leads_update_own_clinic" ON leads FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for lead_activities
CREATE POLICY "lead_activities_clinic_isolation" ON lead_activities FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "lead_activities_insert_own_clinic" ON lead_activities FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "lead_activities_update_own_clinic" ON lead_activities FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
