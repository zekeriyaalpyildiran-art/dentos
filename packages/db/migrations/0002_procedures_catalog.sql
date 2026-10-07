-- Create procedure category enum
CREATE TYPE procedure_category AS ENUM (
  'examination',
  'filling',
  'root_canal',
  'extraction',
  'implant',
  'crown',
  'whitening',
  'orthodontics',
  'cleaning',
  'other'
);

-- Create procedures catalog table
CREATE TABLE procedures_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  category procedure_category NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(clinic_id, name)
);

-- Create indexes
CREATE INDEX idx_procedures_clinic_id ON procedures_catalog(clinic_id);
CREATE INDEX idx_procedures_category ON procedures_catalog(category);

-- Enable RLS
ALTER TABLE procedures_catalog ENABLE ROW LEVEL SECURITY;

-- RLS policies for procedures_catalog
CREATE POLICY "procedures_clinic_isolation" ON procedures_catalog
  FOR SELECT
  USING (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );

CREATE POLICY "procedures_insert_own_clinic" ON procedures_catalog
  FOR INSERT
  WITH CHECK (
    clinic_id = (auth.jwt() ->> 'clinic_id')::uuid
  );
