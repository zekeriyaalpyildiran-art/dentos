import { createClient } from "./supabase";

export type UserRole = "owner" | "admin" | "doctor" | "assistant" | "reception";

export const ROLE_LABELS: Record<string, string> = {
  owner: "Sahip",
  admin: "Yönetici",
  doctor: "Hekim",
  assistant: "Asistan",
  reception: "Resepsiyon",
};

export interface AuthUser {
  /** auth.users id (auth.uid()). */
  id: string;
  /** public.users id; staff_permissions.user_id and other users FKs refer to it. */
  user_id: string;
  email: string;
  clinic_id: string;
  role: UserRole;
  /** Active staff_permissions of the caller, from my_permissions(). */
  permissions: string[];
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

    // Fetch user details from database (id, clinic_id, role, is_active)
    const { data: userRecord, error } = await supabase
      .from("users")
      .select("id, clinic_id, role, is_active")
      .eq("auth_user_id", data.user.id)
      .maybeSingle();

    // Same rule as the database helpers: only is_active = true counts, NULL is inactive.
    if (error || !userRecord || userRecord.is_active !== true) return null;

    return {
      id: data.user.id,
      user_id: userRecord.id,
      email: data.user.email || "",
      clinic_id: userRecord.clinic_id,
      role: userRecord.role,
      permissions: await getMyPermissions(),
    };
  } catch {
    return null;
  }
}

/**
 * The caller's active permissions. Fails closed: any error yields no permissions,
 * so finance figures stay hidden rather than shown by mistake.
 */
export async function getMyPermissions(): Promise<string[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("my_permissions");
    if (error || !Array.isArray(data)) return [];

    // A setof text function arrives as plain strings; tolerate { my_permissions: "..." } rows too.
    return (data as unknown[])
      .map((row) => {
        if (typeof row === "string") return row;
        if (row && typeof row === "object") {
          const value = Object.values(row as Record<string, unknown>)[0];
          return typeof value === "string" ? value : null;
        }
        return null;
      })
      .filter((p): p is string => !!p);
  } catch {
    return [];
  }
}
