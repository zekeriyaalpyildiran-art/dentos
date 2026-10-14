"use client";

import { useState } from "react";
import {
  COUNTERPARTY_KIND_LABELS,
  UUID_RE,
  finSaveCounterparty,
  newId,
  pickable,
  sortByOrder,
  toFinanceError,
  type CounterpartyJson,
  type CounterpartyKind,
  type FinanceError,
  type ReferenceData,
} from "@/lib/finance";
import { ErrorBox, Field, Modal, buttonPrimary, buttonSecondary, inputClass } from "./ui";

/**
 * Create or edit a master counterparty (fin_save_counterparty). `initialName` pre-fills a new record,
 * e.g. when a free-text Cariler row is turned into a master record.
 */
export function CounterpartyDialog({
  refData,
  record,
  initialName,
  onClose,
  onSaved,
  onReload,
  onOpenExisting,
}: {
  refData: ReferenceData;
  record: CounterpartyJson | null;
  initialName?: string;
  onClose: () => void;
  onSaved: (saved: CounterpartyJson, alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
  /** E_NAME_TAKEN carries the existing id in DETAIL; offer to edit that record instead. */
  onOpenExisting?: (existing: CounterpartyJson) => void;
}) {
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.name ?? initialName ?? "");
  const [kind, setKind] = useState<CounterpartyKind>(record?.kind ?? "other");
  const [doctorId, setDoctorId] = useState(record?.doctor_id ?? "");
  const [groupId, setGroupId] = useState(record?.report_group_id ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [active, setActive] = useState(record?.is_active ?? true);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  // The latest version from reference data, so a "Yenile" after a conflict picks up the fresh value.
  const current = record ? refData.counterparties.find((c) => c.id === record.id) ?? record : null;
  const doctors = refData.doctors.filter(
    (d) => d.doctor_id === doctorId || (d.is_active && (!d.counterparty_id || d.counterparty_id === record?.id))
  );
  const groups = sortByOrder(pickable(refData.report_groups, groupId));
  const existing =
    error?.isConflict && error.details && UUID_RE.test(error.details)
      ? refData.counterparties.find((c) => c.id === error.details)
      : undefined;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) return setFormError("Ad boş olamaz ve en fazla 200 karakter olabilir.");
    if (note.length > 500) return setFormError("Not en fazla 500 karakter olabilir.");
    setBusy(true);
    try {
      const res = await finSaveCounterparty({
        p_id: id,
        p_version: current?.version ?? 0,
        p_name: trimmed,
        p_kind: kind,
        p_doctor_id: kind === "physician" && doctorId ? doctorId : null,
        p_report_group_id: groupId || null,
        p_note: note.trim(),
        p_is_active: active,
      });
      await onSaved(res.record, res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Kişi / kurumu düzenle" : "Yeni kişi / kurum"} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ad">
          <input className={inputClass} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Tür">
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as CounterpartyKind)}>
            {(Object.keys(COUNTERPARTY_KIND_LABELS) as CounterpartyKind[]).map((k) => (
              <option key={k} value={k}>
                {COUNTERPARTY_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        {kind === "physician" && (
          <Field label="Bağlı hekim (isteğe bağlı)" hint="Klinikteki hekim kaydıyla eşleştirir.">
            <select className={inputClass} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">Bağlı değil</option>
              {doctors.map((d) => (
                <option key={d.doctor_id} value={d.doctor_id}>
                  {d.full_name}
                  {d.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label="Açık borç rapor grubu"
          hint="Bu kişi / kurumun açık borçları özet ekranında bu grupta toplanır. Boşsa kategorinin grubu kullanılır."
        >
          <select className={inputClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Kategoriye göre</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Not">
          <textarea className={inputClass} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktif (pasif kayıtlar yeni işlemlerde seçilemez; eski kayıtlar etkilenmez)
        </label>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        {existing && onOpenExisting && (
          <button type="button" className={buttonSecondary} onClick={() => onOpenExisting(existing)}>
            Mevcut kaydı düzenle: {existing.name}
          </button>
        )}
        <div className="flex gap-2">
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}
