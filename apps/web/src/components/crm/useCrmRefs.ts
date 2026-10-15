"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";

export interface StaffOption {
  id: string;
  full_name: string;
}

/** Active users of the caller's clinic (callers, assignees). Names come from the database, never from code. */
export function useStaff(): StaffOption[] {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [staff, setStaff] = useState<StaffOption[]>([]);

  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    createClient()
      .from("users")
      .select("id, full_name, is_active")
      .eq("clinic_id", clinicId)
      .order("full_name", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Error fetching staff:", error);
          return;
        }
        setStaff(
          (data || [])
            .filter((u) => u.is_active === true)
            .map((u) => ({ id: u.id as string, full_name: (u.full_name as string) || "Adsız kullanıcı" }))
        );
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId]);

  return staff;
}

export interface ClinicResources {
  doctors: { id: string; name: string }[];
  chairs: { id: string; name: string }[];
  procedures: { id: string; name: string }[];
  loaded: boolean;
}

/** Doctors, active chairs and procedures for the "Klinik randevusu kesinleşti" decision. */
export function useClinicResources(enabled: boolean): ClinicResources {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [res, setRes] = useState<ClinicResources>({ doctors: [], chairs: [], procedures: [], loaded: false });

  useEffect(() => {
    if (!clinicId || !enabled || res.loaded) return;
    let cancelled = false;
    const supabase = createClient();
    Promise.all([
      supabase.from("doctors").select("id,specialty,users(full_name)").eq("clinic_id", clinicId),
      supabase.from("chairs").select("id,name").eq("clinic_id", clinicId).eq("is_active", true).order("sort_order"),
      supabase
        .from("procedures_catalog")
        .select("id,name")
        .eq("clinic_id", clinicId)
        .eq("is_active", true)
        .order("name"),
    ]).then(([docs, chairs, procs]) => {
      if (cancelled) return;
      // users(full_name) is a single object at runtime (many-to-one).
      const doctorRows = (docs.data || []) as unknown as {
        id: string;
        specialty?: string | null;
        users?: { full_name?: string | null } | null;
      }[];
      setRes({
        doctors: doctorRows.map((d) => ({ id: d.id, name: d.users?.full_name || d.specialty || "Hekim" })),
        chairs: (chairs.data || []).map((c) => ({ id: c.id as string, name: c.name as string })),
        procedures: (procs.data || []).map((p) => ({ id: p.id as string, name: p.name as string })),
        loaded: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [clinicId, enabled, res.loaded]);

  return res;
}
