-- Create enums
CREATE TYPE clinic_plan AS ENUM ('trial', 'starter', 'pro');
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'doctor', 'assistant', 'reception');
CREATE TYPE patient_gender AS ENUM ('male', 'female', 'other');

-- Create clinics table
CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  phone text,
  address text,
  settings jsonb,
  plan clinic_plan DEFAULT 'trial',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Create users table
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  auth_user_id uuid UNIQUE,
  role user_role NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  is_active boolean DEFAULT true,
  color text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(clinic_id, email)
);

-- Create doctors table
CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  specialty text,
  default_chair_id uuid,
  slot_minutes integer DEFAULT 30,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Create chairs table
CREATE TABLE chairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(clinic_id, name)
);

-- Create indexes
CREATE INDEX idx_users_clinic_id ON users(clinic_id);
CREATE INDEX idx_users_auth_user_id ON users(auth_user_id);
CREATE INDEX idx_doctors_clinic_id ON doctors(clinic_id);
CREATE INDEX idx_doctors_user_id ON doctors(user_id);
CREATE INDEX idx_chairs_clinic_id ON chairs(clinic_id);
