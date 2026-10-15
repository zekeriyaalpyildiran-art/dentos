"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { stockDb } from "@/lib/stock/rpc";
import { stockInput } from "./ui";

export interface PatientRef {
  id: string;
  full_name: string;
}

/** PostgREST `or` filter values must not carry its syntax characters. */
function safeTerm(q: string): string {
  return q.replace(/[,()*%\\:."']/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Patient search by name or phone (≥ 2 characters, 10 results). Only the patient id is stored on the movement; no
 * name or national ID is typed into a stock field.
 */
export function PatientPicker({
  value,
  onChange,
  disabled,
}: {
  value: PatientRef | null;
  onChange: (p: PatientRef | null) => void;
  disabled?: boolean;
}) {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<{ id: string; full_name: string; phone: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = safeTerm(search);
    if (!clinicId || value || term.length < 2) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setBusy(true);
      stockDb()
        .from("patients")
        .select("id,full_name,phone,is_active")
        .eq("clinic_id", clinicId)
        .eq("is_active", true)
        .or(`full_name.ilike.*${term}*,phone.ilike.*${term}*`)
        .order("full_name")
        .limit(10)
        .then(({ data }) => {
          if (cancelled) return;
          setBusy(false);
          setRows((data || []) as { id: string; full_name: string; phone: string | null }[]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, clinicId, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 p-2 border rounded bg-gray-50">
        <span className="font-medium">{value.full_name}</span>
        {!disabled && (
          <button
            type="button"
            className="text-sm text-blue-700 hover:underline min-h-[44px] px-2"
            onClick={() => {
              onChange(null);
              setSearch("");
            }}
          >
            Değiştir
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <input
        className={stockInput}
        placeholder="Hasta adı veya telefon (en az 2 harf)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled}
        aria-label="Hasta ara"
      />
      {busy && <p className="text-xs text-gray-500">Aranıyor...</p>}
      {rows.length > 0 && (
        <ul className="border rounded divide-y max-h-56 overflow-y-auto">
          {rows.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 min-h-11 hover:bg-blue-50"
                onClick={() => onChange({ id: p.id, full_name: p.full_name })}
              >
                {p.full_name}
                {p.phone && <span className="text-xs text-gray-500 ml-2">{p.phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
