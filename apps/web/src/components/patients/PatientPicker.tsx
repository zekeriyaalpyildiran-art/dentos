"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { patientSearchFilter } from "@/lib/patients/search";
import { UUID_RE } from "@/lib/clinical/rpc";

export interface PatientRef {
  id: string;
  full_name: string;
}

/** The clinic's active patient with this id (for ?patient= presets from other pages), or null. */
export async function fetchActivePatient(clinicId: string, id: string | null | undefined): Promise<PatientRef | null> {
  if (!id || !UUID_RE.test(id)) return null;
  const { data, error } = await createClient()
    .from("patients")
    .select("id,full_name")
    .eq("id", id)
    .eq("clinic_id", clinicId)
    .not("is_active", "is", false)
    .maybeSingle();
  if (error) console.error("Error loading patient:", error);
  return data ? { id: data.id, full_name: data.full_name } : null;
}

interface PatientRow {
  id: string;
  full_name: string;
  phone: string | null;
}

const DEFAULT_INPUT_CLASS =
  "w-full px-3 py-2 border rounded bg-white text-base text-gray-900 disabled:bg-gray-100 disabled:text-gray-500";

/**
 * Server-side patient search by name or phone (≥ 2 characters, 10 results, active patients; NULL is_active counts as
 * active, spec p10 §1.4). Nothing is loaded until the user types, so it works for any number of patients. Only the
 * picked patient's id and name leave the component.
 */
export function PatientPicker({
  value,
  onChange,
  disabled,
  inputClassName,
  inputId,
  placeholder,
}: {
  value: PatientRef | null;
  onChange: (p: PatientRef | null) => void;
  disabled?: boolean;
  inputClassName?: string;
  /** Id of the search box, for a visible <label htmlFor>; without it the box is named "Hasta ara". */
  inputId?: string;
  placeholder?: string;
}) {
  const clinicId = useAuthStore((state) => state.user?.clinic_id);
  const supabase = useMemo(() => createClient(), []);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  /** Arrow keys move between the search box and the results (up from the first result returns to the box). */
  const focusResult = (i: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons || buttons.length === 0) return;
    if (i < 0) {
      inputRef.current?.focus();
      return;
    }
    buttons[Math.min(i, buttons.length - 1)].focus();
  };

  useEffect(() => {
    const filter = patientSearchFilter(search, 2);
    if (!clinicId || value || !filter) {
      setRows([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setStatus("busy");
      supabase
        .from("patients")
        .select("id,full_name,phone")
        .eq("clinic_id", clinicId)
        .not("is_active", "is", false)
        .or(filter)
        .order("full_name")
        .limit(10)
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) {
            console.error("Error searching patients:", error);
            setRows([]);
            setStatus("error");
            return;
          }
          setRows((data || []) as PatientRow[]);
          setStatus("done");
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, clinicId, value, supabase]);

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
        ref={inputRef}
        id={inputId}
        className={inputClassName ?? DEFAULT_INPUT_CLASS}
        placeholder={placeholder ?? "Hasta adı veya telefon (en az 2 harf)"}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        // Enter in the search box must not submit the surrounding form without a patient.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
          if (e.key === "ArrowDown" && rows.length > 0) {
            e.preventDefault();
            focusResult(0);
          }
        }}
        disabled={disabled}
        autoComplete="off"
        aria-label={inputId ? undefined : "Hasta ara"}
      />
      <div aria-live="polite">
        {status === "busy" && <p className="text-xs text-gray-500">Aranıyor...</p>}
        {status === "error" && <p className="text-xs text-red-600">Hasta araması yapılamadı. Tekrar deneyin.</p>}
        {status === "done" && rows.length === 0 && (
          <p className="text-xs text-gray-500">Eşleşen hasta bulunamadı.</p>
        )}
        {status === "done" && rows.length > 0 && <p className="sr-only">{rows.length} hasta bulundu.</p>}
      </div>
      {rows.length > 0 && (
        <ul
          ref={listRef}
          className="border rounded divide-y max-h-56 overflow-y-auto bg-white"
          aria-label="Bulunan hastalar"
        >
          {rows.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 min-h-11 hover:bg-blue-50 focus:bg-blue-50"
                onClick={() => onChange({ id: p.id, full_name: p.full_name })}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    focusResult(e.key === "ArrowDown" ? i + 1 : i - 1);
                  }
                }}
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
