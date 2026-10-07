-- S1.2 Appointments + Reminders + Waitlist schema
-- Conflict detection: business logic validation required (DB constraint deferred to app layer)

-- Appointment status enum
CREATE TYPE appointment_status AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');

-- Reminder status enum
CREATE TYPE reminder_status AS ENUM ('pending', 'sent', 'failed');

-- Waitlist status enum
CREATE TYPE waitlist_status AS ENUM ('waiting', 'assigned', 'cancelled');

-- Appointments table (clinic-isolated, conflict detection via app)
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  chair_id uuid NOT NULL REFERENCES chairs(id) ON DELETE CASCADE,
  procedure_id uuid REFERENCES procedures_catalog(id) ON DELETE SET NULL,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone NOT NULL,
  status appointment_status DEFAULT 'scheduled',
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Reminders table (SMS/Email notifications)
CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  reminder_type text NOT NULL,
  scheduled_at timestamp with time zone NOT NULL,
  sent_at timestamp with time zone,
  status reminder_status DEFAULT 'pending',
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Waitlist table (queue for cancelled slots)
CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES doctors(id) ON DELETE SET NULL,
  procedure_id uuid REFERENCES procedures_catalog(id) ON DELETE SET NULL,
  preferred_date_start timestamp with time zone,
  preferred_date_end timestamp with time zone,
  status waitlist_status DEFAULT 'waiting',
  position integer,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Create indexes for performance
CREATE INDEX idx_appointments_clinic_id ON appointments(clinic_id);
CREATE INDEX idx_appointments_patient_id ON appointments(patient_id);
CREATE INDEX idx_appointments_doctor_id ON appointments(doctor_id);
CREATE INDEX idx_appointments_chair_id ON appointments(chair_id);
CREATE INDEX idx_appointments_start_time ON appointments(start_time);
CREATE INDEX idx_appointments_status ON appointments(status);

CREATE INDEX idx_reminders_clinic_id ON reminders(clinic_id);
CREATE INDEX idx_reminders_appointment_id ON reminders(appointment_id);
CREATE INDEX idx_reminders_scheduled_at ON reminders(scheduled_at);
CREATE INDEX idx_reminders_status ON reminders(status);

CREATE INDEX idx_waitlist_clinic_id ON waitlist(clinic_id);
CREATE INDEX idx_waitlist_patient_id ON waitlist(patient_id);
CREATE INDEX idx_waitlist_status ON waitlist(status);

-- Enable RLS
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Appointments (clinic isolation)
CREATE POLICY "appointments_clinic_isolation" ON appointments FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "appointments_insert_own_clinic" ON appointments FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "appointments_update_own_clinic" ON appointments FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "appointments_delete_own_clinic" ON appointments FOR DELETE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies: Reminders (clinic isolation)
CREATE POLICY "reminders_clinic_isolation" ON reminders FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "reminders_insert_own_clinic" ON reminders FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "reminders_update_own_clinic" ON reminders FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies: Waitlist (clinic isolation)
CREATE POLICY "waitlist_clinic_isolation" ON waitlist FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "waitlist_insert_own_clinic" ON waitlist FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "waitlist_update_own_clinic" ON waitlist FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "waitlist_delete_own_clinic" ON waitlist FOR DELETE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
