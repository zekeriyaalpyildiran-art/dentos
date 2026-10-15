"use client";

// Appointment detail (spec p9_clinical §7.10): summary plus "Kullanılan malzeme".

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { UUID_RE } from "@/lib/clinical/rpc";
import { formatDateTime } from "@/lib/clinical/dates";
import { AppointmentMaterials } from "@/components/clinical/AppointmentMaterials";

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Planlı",
  completed: "Tamamlandı",
  cancelled: "İptal",
  no_show: "Gelmedi",
};

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-yellow-100 text-yellow-800",
};

interface AppointmentRow {
  id: string;
  patient_id: string;
  start_time: string;
  end_time: string;
  status: string | null;
  notes: string | null;
  patients: { full_name: string } | null;
  doctors: { specialty: string | null; users: { full_name: string } | null } | null;
  chairs: { name: string } | null;
  procedures_catalog: { name: string } | null;
}

function timeOnly(ts: string): string {
  return formatDateTime(ts).slice(11);
}

export default function AppointmentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const user = useAuthStore((s) => s.user);
  const [apt, setApt] = useState<AppointmentRow | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    if (!user?.clinic_id || !id) return;
    if (!UUID_RE.test(id)) {
      setState("missing");
      return;
    }
    let cancelled = false;
    createClient()
      .from("appointments")
      .select(
        "id,patient_id,start_time,end_time,status,notes,patients(full_name),doctors(specialty,users(full_name)),chairs(name),procedures_catalog(name)"
      )
      .eq("id", id)
      .eq("clinic_id", user.clinic_id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Error loading appointment:", error);
          setState("error");
          return;
        }
        if (!data) {
          setState("missing");
          return;
        }
        // Many-to-one embeds arrive as single objects, which the inferred type does not reflect.
        setApt(data as unknown as AppointmentRow);
        setState("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [id, user?.clinic_id]);

  if (state === "loading") return <div className="p-8">Yükleniyor...</div>;
  if (state !== "ready" || !apt) {
    return (
      <div className="p-8">
        <p className={state === "error" ? "text-red-600" : "text-gray-700"}>
          {state === "error" ? "Randevu yüklenemedi. Lütfen sayfayı yenileyin." : "Randevu bulunamadı"}
        </p>
        <Link href="/appointments" className="inline-block mt-4 text-blue-600 hover:underline">
          ← Randevulara dön
        </Link>
      </div>
    );
  }

  const status = apt.status ?? "scheduled";
  const doctor = apt.doctors?.users?.full_name || apt.doctors?.specialty || "-";

  return (
    <div className="p-4 md:p-8 space-y-8 text-gray-900">
      <Link href="/appointments" className="text-blue-600 hover:underline text-sm">
        ← Randevular
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Randevu</h1>
          <p className="text-gray-600 mt-1">
            {formatDateTime(apt.start_time)} – {timeOnly(apt.end_time)}
          </p>
        </div>
        {status === "scheduled" && (
          <Link
            href={`/appointments/${apt.id}/edit`}
            className="px-4 py-2 min-h-[44px] inline-flex items-center bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Düzenle
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-white rounded-lg shadow p-4 md:p-6">
        <div>
          <div className="text-sm text-gray-600">Hasta</div>
          <Link href={`/patients/${apt.patient_id}`} className="font-semibold text-blue-700 hover:underline">
            {apt.patients?.full_name || "-"}
          </Link>
        </div>
        <div>
          <div className="text-sm text-gray-600">Durum</div>
          <span className={`inline-block px-2 py-1 rounded text-sm ${STATUS_STYLES[status] ?? STATUS_STYLES.scheduled}`}>
            {STATUS_LABELS[status] ?? status}
          </span>
        </div>
        <div>
          <div className="text-sm text-gray-600">Hekim</div>
          <div className="font-semibold">{doctor}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Koltuk</div>
          <div className="font-semibold">{apt.chairs?.name || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Tedavi</div>
          <div className="font-semibold">{apt.procedures_catalog?.name || "-"}</div>
        </div>
        <div className="sm:col-span-2">
          <div className="text-sm text-gray-600">Notlar</div>
          <div className="whitespace-pre-wrap">{apt.notes || "-"}</div>
        </div>
      </div>

      <AppointmentMaterials appointmentId={apt.id} />
    </div>
  );
}
