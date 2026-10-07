import { createClient } from "./supabase";

export type UserRole = "owner" | "admin" | "doctor" | "assistant" | "reception";

export interface AuthUser {
  id: string;
  email: string;
  clinic_id: string;
  role: UserRole;
}

export async function signIn(email: string, password: string) {
  const supabase = createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw error;

  return data.session;
}

export async function signUp(email: string, password: string) {
  const supabase = createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) throw error;

  return data.session;
}

export async function signOut() {
  const supabase = createClient();

  const { error } = await supabase.auth.signOut();

  if (error) throw error;
}

export async function getSession() {
  const supabase = createClient();

  const { data, error } = await supabase.auth.getSession();

  if (error) throw error;

  return data.session;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const supabase = createClient();

    const { data } = await supabase.auth.getUser();

    if (!data.user) return null;

    // Fetch user details from database (clinic_id, role)
    const { data: userRecord, error } = await supabase
      .from("users")
      .select("clinic_id, role")
      .eq("auth_user_id", data.user.id)
      .single();

    if (error || !userRecord) return null;

    return {
      id: data.user.id,
      email: data.user.email || "",
      clinic_id: userRecord.clinic_id,
      role: userRecord.role,
    };
  } catch {
    return null;
  }
}
