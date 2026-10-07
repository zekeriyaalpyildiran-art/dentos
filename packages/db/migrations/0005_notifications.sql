-- S1.5 Notifications + SMS gateway

-- Notification type enum
CREATE TYPE notification_type AS ENUM ('sms', 'email', 'in_app');

-- Notifications table (SMS/Email queue for reminders)
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  notification_type notification_type NOT NULL,
  recipient text NOT NULL,
  scheduled_at timestamp with time zone NOT NULL,
  sent_at timestamp with time zone,
  status text DEFAULT 'pending',
  message text,
  error_message text,
  retry_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX idx_notifications_clinic_id ON notifications(clinic_id);
CREATE INDEX idx_notifications_appointment_id ON notifications(appointment_id);
CREATE INDEX idx_notifications_patient_id ON notifications(patient_id);
CREATE INDEX idx_notifications_scheduled_at ON notifications(scheduled_at);
CREATE INDEX idx_notifications_status ON notifications(status);

-- Enable RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "notifications_clinic_isolation" ON notifications FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "notifications_insert_own_clinic" ON notifications FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "notifications_update_own_clinic" ON notifications FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
