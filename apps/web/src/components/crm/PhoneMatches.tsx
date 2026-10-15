"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { crmPhoneMatches, normalizePhone, type PhoneMatchesJson } from "@/lib/crm";
import { stageLabel } from "@/lib/crm/codes";

/** True when the matches list anything. */
export function hasPhoneMatches(m: PhoneMatchesJson | null | undefined): m is PhoneMatchesJson {
  return !!m && ((m.leads?.length ?? 0) > 0 || (m.patients?.length ?? 0) > 0);
}

/**
 * Non-blocking duplicate warning (owner decision 1: shared numbers are allowed). Lists the other leads and
 * patients with the same normalized number and links to each with "Mevcut kaydı aç".
 */
export function PhoneMatchesList({ matches, title }: { matches: PhoneMatchesJson | null; title?: string }) {
  if (!hasPhoneMatches(matches)) return null;
  return (
    <div className="p-3 rounded border border-amber-200 bg-amber-50 text-amber-900 text-sm" role="status">
      <p className="font-medium">{title ?? "Bu numara başka bir kayıtta da kullanılıyor:"}</p>
      <ul className="mt-1 space-y-1">
        {matches.leads.map((l) => (
          <li key={"l" + l.id} className="flex flex-wrap items-center gap-2">
            <span>
              Hasta adayı: <b>{l.full_name}</b> · {stageLabel(l.stage)}
              {l.assigned_name ? ` · ${l.assigned_name}` : ""}
            </span>
            <Link href={`/crm/leads/${l.id}`} className="text-blue-700 underline">
              Mevcut kaydı aç
            </Link>
          </li>
        ))}
        {matches.patients.map((p) => (
          <li key={"p" + p.id} className="flex flex-wrap items-center gap-2">
            <span>
              Hasta: <b>{p.full_name}</b>
              {!p.is_active ? " (pasif)" : ""}
            </span>
            <Link href={`/patients/${p.id}`} className="text-blue-700 underline">
              Mevcut kaydı aç
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs">Ortak numara kullanılabilir; kayıt yine de kaydedilir.</p>
    </div>
  );
}

/**
 * Live warning while typing (CRM:53, CRM:108): calls crm_phone_matches once the number has ≥ 7 digits.
 * Errors are silent: the warning is advisory and must never block a save.
 */
export function PhoneMatchWarning({
  phone,
  excludeLeadId,
  excludePatientId,
  onMatches,
}: {
  phone: string;
  excludeLeadId?: string | null;
  excludePatientId?: string | null;
  onMatches?: (matches: PhoneMatchesJson | null) => void;
}) {
  const [matches, setMatches] = useState<PhoneMatchesJson | null>(null);
  const normalized = normalizePhone(phone);

  useEffect(() => {
    if (normalized.length < 7) {
      setMatches(null);
      onMatches?.(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      crmPhoneMatches({
        p_phone: phone,
        p_exclude_lead_id: excludeLeadId ?? null,
        p_exclude_patient_id: excludePatientId ?? null,
      })
        .then((m) => {
          if (cancelled) return;
          setMatches(m);
          onMatches?.(m);
        })
        .catch(() => {
          if (!cancelled) setMatches(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // onMatches is a notification callback; re-running on its identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalized, excludeLeadId, excludePatientId]);

  return <PhoneMatchesList matches={matches} />;
}
