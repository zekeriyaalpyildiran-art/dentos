"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { stockDb, type LocationJson, type SupplierJson } from "@/lib/stock/rpc";

/** Locations (direct RLS-filtered read; contract §9 allows it for pickers and settings). */
export function useStockLocations(reloadTick = 0) {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [locations, setLocations] = useState<LocationJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    stockDb()
      .from("stock_locations")
      .select("id,name,kind,is_default_warehouse,chair_id,sort_order,is_active,version")
      .eq("clinic_id", clinicId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) {
          setError("Konumlar yüklenemedi.");
          setLocations([]);
          return;
        }
        setError(null);
        setLocations((data || []) as LocationJson[]);
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId, reloadTick, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const active = useMemo(() => (locations || []).filter((l) => l.is_active), [locations]);
  const defaultWarehouse = useMemo(
    () => active.find((l) => l.is_default_warehouse) ?? active.find((l) => l.kind === "warehouse") ?? null,
    [active]
  );
  return { locations, active, defaultWarehouse, error, reload };
}

export function useStockSuppliers(reloadTick = 0) {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [suppliers, setSuppliers] = useState<SupplierJson[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    stockDb()
      .from("suppliers")
      .select("id,name,phone,email,tax_no,note,is_active,version,fin_counterparty_id")
      .eq("clinic_id", clinicId)
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        setSuppliers(error ? [] : ((data || []) as SupplierJson[]));
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId, reloadTick, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const active = useMemo(() => (suppliers || []).filter((s) => s.is_active), [suppliers]);
  return { suppliers, active, reload };
}

export interface DoctorOption {
  id: string;
  name: string;
  user_id: string | null;
}

/** Clinic doctors (names from users), for the "Uygulayan hekim" select. Loaded only when enabled. */
export function useStockDoctors(enabled: boolean) {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [doctors, setDoctors] = useState<DoctorOption[] | null>(null);

  useEffect(() => {
    if (!clinicId || !enabled || doctors) return;
    let cancelled = false;
    stockDb()
      .from("doctors")
      .select("id,user_id,specialty,users(full_name,is_active)")
      .eq("clinic_id", clinicId)
      .then(({ data }) => {
        if (cancelled) return;
        const rows = (data || []) as unknown as {
          id: string;
          user_id: string | null;
          specialty?: string | null;
          users?: { full_name?: string | null; is_active?: boolean | null } | null;
        }[];
        setDoctors(
          rows
            .filter((d) => d.users?.is_active !== false)
            .map((d) => ({ id: d.id, user_id: d.user_id, name: d.users?.full_name || d.specialty || "Hekim" }))
            .sort((a, b) => a.name.localeCompare(b.name, "tr"))
        );
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId, enabled, doctors]);

  return doctors;
}

export function useStockChairs(enabled: boolean) {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [chairs, setChairs] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    if (!clinicId || !enabled || chairs) return;
    let cancelled = false;
    stockDb()
      .from("chairs")
      .select("id,name,is_active,sort_order")
      .eq("clinic_id", clinicId)
      .eq("is_active", true)
      .order("sort_order")
      .then(({ data }) => {
        if (cancelled) return;
        setChairs((data || []).map((c) => ({ id: c.id as string, name: c.name as string })));
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId, enabled, chairs]);

  return chairs;
}
