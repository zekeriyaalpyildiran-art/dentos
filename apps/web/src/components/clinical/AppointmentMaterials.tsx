"use client";

// Appointment "Kullanılan malzeme" (spec p9_clinical §7.10): stock issues and implants linked to the appointment.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  NO_FLAGS,
  clinAppointmentMaterials,
  toClinicalError,
  type AppointmentMaterials as AppointmentMaterialsJson,
  type ClinicalError,
} from "@/lib/clinical/rpc";
import { istanbulToday } from "@/lib/clinical/dates";
import { ImplantTable } from "./ImplantTable";
import { MaterialTable } from "./MaterialTable";
import { useImplantDialogs } from "./useImplantDialogs";
import { ClinicalNotice, ErrorBox, Loading, clinPrimary, clinSecondary } from "./ui";

export function AppointmentMaterials({ appointmentId }: { appointmentId: string }) {
  const [data, setData] = useState<AppointmentMaterialsJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClinicalError | null>(null);
  const req = useRef(0);

  const load = useCallback(async () => {
    const r = ++req.current;
    setLoading(true);
    try {
      const res = await clinAppointmentMaterials(appointmentId);
      if (r !== req.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (r === req.current) setError(toClinicalError(err));
    } finally {
      if (r === req.current) setLoading(false);
    }
  }, [appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flags = data?.flags ?? NO_FLAGS;
  const today = data?.today ?? istanbulToday();
  const dialogs = useImplantDialogs({ flags, today, onChanged: () => void load() });

  const materials = data?.materials ?? [];
  const implants = data?.implants ?? [];

  return (
    <section className="space-y-4 text-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Kullanılan malzeme</h2>
        <div className="flex flex-wrap gap-2">
          {data && flags.can_write && (
            <button
              type="button"
              className={clinPrimary}
              onClick={() =>
                dialogs.open({
                  fixedPatient: { id: data.appointment.patient_id, full_name: data.appointment.patient_name },
                  fixedAppointment: {
                    id: data.appointment.id,
                    start_time: data.appointment.start_time,
                    doctor_id: data.appointment.doctor_id,
                  },
                })
              }
            >
              İmplant ekle
            </button>
          )}
          {data && flags.can_operate_stock && (
            <Link href="/inventory" className={`${clinSecondary} inline-flex items-center`}>
              Stokta kullanım kaydet
            </Link>
          )}
        </div>
      </div>

      <ClinicalNotice error={error} />
      <ErrorBox error={dialogs.error} />

      {loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          {implants.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-semibold">İmplantlar</h3>
              <ImplantTable rows={implants} flags={flags} showPatient={false} actions={dialogs.actions} />
            </div>
          )}
          {materials.length > 0 ? (
            <div className="space-y-2">
              <h3 className="font-semibold">Stoktan kullanılanlar</h3>
              <MaterialTable rows={materials} showAppointment={false} />
            </div>
          ) : (
            <p className="text-gray-600 py-4">Bu randevuda stoktan malzeme kullanımı kaydedilmemiş.</p>
          )}
        </>
      ) : null}
      {dialogs.element}
    </section>
  );
}
