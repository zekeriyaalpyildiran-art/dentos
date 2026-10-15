"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  crmConvertToPatient,
  crmPhoneMatches,
  newId,
  toCrmError,
  type ConvertResult,
  type CrmError,
  type LeadJson,
  type PhoneMatchesJson,
} from "@/lib/crm";
import { PhoneMatchesList } from "./PhoneMatches";
import { CrmErrorBox, CrmModal, Field, Notice, buttonPrimary, buttonSecondary, inputClass } from "./ui";

const GENDERS = [
  { value: "male", label: "Erkek" },
  { value: "female", label: "Kadın" },
  { value: "other", label: "Diğer" },
];

/**
 * "Hastaya dönüştür" (crm_convert_to_patient): link an existing patient (for example one sharing the number) or
 * create a new patient from the lead. Stage and follow-up do not change; a duplicate phone is only a warning.
 */
export function ConvertDialog({
  lead,
  onClose,
  onSaved,
}: {
  lead: LeadJson;
  onClose: () => void;
  onSaved: (result: ConvertResult) => void;
}) {
  const [newPatientId] = useState(newId);
  const [matches, setMatches] = useState<PhoneMatchesJson | null>(null);
  const [choice, setChoice] = useState<string>("new");
  const [form, setForm] = useState({
    full_name: lead.full_name,
    phone: lead.phone,
    email: lead.email ?? "",
    gender: "",
    birth_date: "",
    address: lead.address ?? "",
    kvkk_consent: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    crmPhoneMatches({ p_phone: lead.phone, p_exclude_lead_id: lead.id })
      .then((m) => {
        if (!cancelled) setMatches(m);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lead.id, lead.phone]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await crmConvertToPatient({
        p_lead_id: lead.id,
        p_version: lead.version,
        p_patient_id: choice === "new" ? null : choice,
        p_new_patient_id: choice === "new" ? newPatientId : null,
        p_patient:
          choice === "new"
            ? {
                full_name: form.full_name.trim(),
                phone: form.phone.trim(),
                email: form.email.trim() || null,
                gender: form.gender || null,
                birth_date: form.birth_date || null,
                address: form.address.trim() || null,
                kvkk_consent: form.kvkk_consent,
              }
            : null,
      });
      setResult(r);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <CrmModal title="Hastaya dönüştür" onClose={() => onSaved(result)}>
        <div className="space-y-4">
          <Notice tone="success">
            {result.created ? "Hasta kaydı oluşturuldu" : "Mevcut hasta kaydına bağlandı"}: <b>{result.patient.full_name}</b>
          </Notice>
          <PhoneMatchesList matches={result.phone_matches} />
          <div className="flex flex-wrap justify-end gap-2">
            <Link href={`/patients/${result.patient.id}`} className={buttonSecondary}>
              Hasta kaydını aç
            </Link>
            <Link href={`/appointments/new?patient=${result.patient.id}`} className={buttonSecondary}>
              Randevu oluştur
            </Link>
            <button type="button" className={buttonPrimary} onClick={() => onSaved(result)}>
              Tamam
            </button>
          </div>
        </div>
      </CrmModal>
    );
  }

  const patients = matches?.patients ?? [];

  return (
    <CrmModal title="Hastaya dönüştür" description={lead.full_name} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-600">
          Hasta kaydı oluşturulur veya mevcut bir hastaya bağlanır. Aşama ve takip değişmez; randevu oluşturulduğunda
          aday otomatik olarak “Randevu alındı” aşamasına geçer.
        </p>
        {patients.length > 0 && (
          <Field label="Kayıt">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} className={inputClass}>
              <option value="new">Yeni hasta kaydı oluştur</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  Mevcut hastaya bağla: {p.full_name}
                  {p.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
        )}
        {choice === "new" && (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Ad soyad *">
              <input
                required
                maxLength={200}
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Telefon *">
              <input
                required
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="E-posta">
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Cinsiyet">
              <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className={inputClass}>
                <option value="">Seçiniz</option>
                {GENDERS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Doğum tarihi">
              <input
                type="date"
                value={form.birth_date}
                onChange={(e) => setForm({ ...form, birth_date: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Adres">
              <input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className={inputClass}
              />
            </Field>
            <label className="md:col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.kvkk_consent}
                onChange={(e) => setForm({ ...form, kvkk_consent: e.target.checked })}
              />
              KVKK aydınlatma metni onaylandı
            </label>
          </div>
        )}
        <PhoneMatchesList matches={matches} title="Aynı numarayla kayıtlı başka kayıtlar var:" />
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor…" : choice === "new" ? "Hasta kaydı oluştur" : "Hastaya bağla"}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}
