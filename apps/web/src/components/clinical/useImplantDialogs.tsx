"use client";

// Shared implant actions for the implant list, the patient tab and the appointment page (spec p9_clinical §7.1-7.2):
// create / row "+" / edit through ImplantForm, "İptal et" through ImplantVoidDialog, owner "Geri al".

import { useCallback, useState } from "react";
import type { PatientRef } from "@/components/stock/PatientPicker";
import {
  clinImplantRestore,
  toClinicalError,
  type ClinicalError,
  type ClinicalFlags,
  type ImplantJson,
} from "@/lib/clinical/rpc";
import { sameImplantPatientForm, type ImplantFormValues } from "@/lib/clinical/implant-entry";
import { ImplantForm, type FixedAppointment } from "./ImplantForm";
import { ImplantVoidDialog, voidResultMessage } from "./ImplantVoidDialog";
import type { ImplantRowActions } from "./ImplantTable";
import { Toast } from "./ui";

export interface ImplantFormOpen {
  implant?: ImplantJson | null;
  initial?: Partial<ImplantFormValues>;
  fixedPatient?: PatientRef | null;
  fixedAppointment?: FixedAppointment | null;
}

/** Row "+" (CW:35): same patient; shared details of that implant; placed today, healing, no control date. */
export function sameFromRow(r: ImplantJson, today: string): Partial<ImplantFormValues> {
  return sameImplantPatientForm(
    {
      patientId: r.patient_id,
      doctorId: r.doctor_id ?? "",
      brandId: r.brand_active ? r.brand_id : "",
      model: r.model,
      appointmentId: r.placed_on === today ? r.appointment_id ?? "" : "",
      stockSource: r.stock_source,
      sourceNote: r.stock_source === "external" ? r.source_note : "",
    },
    today
  );
}

export function useImplantDialogs({
  flags,
  today,
  onChanged,
}: {
  flags: ClinicalFlags;
  today: string;
  /** Called after every successful write so the caller reloads its list. */
  onChanged: () => void;
}) {
  const [form, setForm] = useState<ImplantFormOpen | null>(null);
  const [formSeq, setFormSeq] = useState(0);
  const [voiding, setVoiding] = useState<ImplantJson | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<ClinicalError | null>(null);

  const open = useCallback((opts: ImplantFormOpen) => {
    setError(null);
    setFormSeq((n) => n + 1);
    setForm(opts);
  }, []);

  const restore = useCallback(
    async (r: ImplantJson) => {
      setBusyId(r.id);
      setError(null);
      try {
        await clinImplantRestore(r.id, r.version);
        setToast("İmplant kaydı geri alındı.");
        onChanged();
      } catch (err) {
        setError(toClinicalError(err));
      } finally {
        setBusyId(null);
      }
    },
    [onChanged]
  );

  const actions: ImplantRowActions = {
    onAddSame: (r) =>
      open({ initial: sameFromRow(r, today), fixedPatient: { id: r.patient_id, full_name: r.patient_name } }),
    onEdit: (r) => open({ implant: r }),
    onVoid: (r) => {
      setError(null);
      setVoiding(r);
    },
    onRestore: (r) => void restore(r),
    busyId,
  };

  const element = (
    <>
      {form && (
        <ImplantForm
          key={formSeq}
          implant={form.implant}
          initial={form.initial}
          fixedPatient={form.fixedPatient}
          fixedAppointment={form.fixedAppointment}
          flags={flags}
          today={today}
          onClose={() => setForm(null)}
          onSaved={(_implant, more) => {
            onChanged();
            if (!more) {
              setForm(null);
              setToast(form.implant ? "İmplant kaydı güncellendi." : "İmplant kaydedildi.");
            }
          }}
        />
      )}
      {voiding && (
        <ImplantVoidDialog
          implant={voiding}
          onClose={() => setVoiding(null)}
          onDone={(r) => {
            setVoiding(null);
            setToast(voidResultMessage(r));
            onChanged();
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </>
  );

  return { actions, open, element, error };
}
