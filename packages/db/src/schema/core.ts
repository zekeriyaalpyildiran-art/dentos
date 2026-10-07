import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enum types
const clinicPlanEnum = pgEnum("clinic_plan", ["trial", "starter", "pro"]);
const userRoleEnum = pgEnum("user_role", [
  "owner",
  "admin",
  "doctor",
  "assistant",
  "reception",
]);

// Clinics table
export const clinics = pgTable("clinics", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  phone: text("phone"),
  address: text("address"),
  settings: jsonb("settings"), // çalışma saatleri, slot durations, etc.
  plan: clinicPlanEnum("plan").default("trial"),
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// Users table (personel)
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clinic_id: uuid("clinic_id")
    .notNull()
    .references(() => clinics.id),
  auth_user_id: uuid("auth_user_id").unique(), // Supabase auth.users.id
  role: userRoleEnum("role").notNull(),
  full_name: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  is_active: boolean("is_active").default(true),
  color: text("color"), // agenda'da renk
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// Doctors table
export const doctors = pgTable("doctors", {
  id: uuid("id").primaryKey().defaultRandom(),
  clinic_id: uuid("clinic_id")
    .notNull()
    .references(() => clinics.id),
  user_id: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  specialty: text("specialty"), // Periodontist, Protez, vb.
  default_chair_id: uuid("default_chair_id"), // Varsayılan koltuk (referans ileride)
  slot_minutes: integer("slot_minutes").default(30), // Randevu slot uzunluğu
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// Chairs (treatment units)
export const chairs = pgTable("chairs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clinic_id: uuid("clinic_id")
    .notNull()
    .references(() => clinics.id),
  name: text("name").notNull(), // "Koltuk 1", "OP2", vb.
  is_active: boolean("is_active").default(true),
  sort_order: integer("sort_order").default(0),
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// Procedure catalog (treatment types)
const procedureCategoryEnum = pgEnum("procedure_category", [
  "examination",
  "filling",
  "root_canal",
  "extraction",
  "implant",
  "crown",
  "whitening",
  "orthodontics",
  "cleaning",
  "other",
]);

export const proceduresCatalog = pgTable("procedures_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  clinic_id: uuid("clinic_id")
    .notNull()
    .references(() => clinics.id),
  name: text("name").notNull(), // "Dolgu", "Kanal Tedavisi", vb.
  category: procedureCategoryEnum("category").notNull(),
  description: text("description"),
  is_active: boolean("is_active").default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// Patients table
const patientGenderEnum = pgEnum("patient_gender", [
  "male",
  "female",
  "other",
]);

export const patients = pgTable("patients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clinic_id: uuid("clinic_id")
    .notNull()
    .references(() => clinics.id),
  auth_user_id: uuid("auth_user_id"), // Supabase auth.users.id (patient login, optional)
  full_name: text("full_name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  gender: patientGenderEnum("gender"),
  birth_date: text("birth_date"), // ISO date
  address: text("address"),
  tc_hash: text("tc_hash"), // Turkish ID hash (privacy: never store full TC number)
  kvkk_consent: boolean("kvkk_consent").default(false), // GDPR-equivalent consent
  consent_date: timestamp("consent_date", { withTimezone: true }),
  notes: text("notes"),
  is_active: boolean("is_active").default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// Patient access log (KVKK audit trail)
export const patientAccessLogs = pgTable("patient_access_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clinic_id: uuid("clinic_id")
    .notNull()
    .references(() => clinics.id),
  patient_id: uuid("patient_id")
    .notNull()
    .references(() => patients.id),
  accessed_by_user_id: uuid("accessed_by_user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(), // "view", "edit", "delete", etc.
  changes: text("changes"), // JSON delta for audit
  created_at: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});
