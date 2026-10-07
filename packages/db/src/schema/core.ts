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
