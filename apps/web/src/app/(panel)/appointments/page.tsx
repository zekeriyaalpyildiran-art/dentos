"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Appointment {
  id: string;
  patient_id: string;
  doctor_id: string;
  chair_id: string;
  procedure_id?: string | null;
  start_time: string;
  end_time: string;
  status: string;
  notes?: string;
}

interface ProcedureInfo {
  id: string;
  name: string;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Planlı",
  completed: "Tamamlandı",
  cancelled: "İptal",
  no_show: "Gelmedi",
};

interface PatientInfo {
  id: string;
  full_name: string;
  phone: string;
}

interface DoctorInfo {
  id: string;
  user_id: string;
  specialty?: string;
  users?: { full_name: string } | null;
}

interface ChairInfo {
  id: string;
  name: string;
}

// Local calendar day as YYYY-MM-DD, so bookings group by the clinic's day rather than UTC.
const localDateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function Page() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<PatientInfo[]>([]);
  const [doctors, setDoctors] = useState<DoctorInfo[]>([]);
  const [chairs, setChairs] = useState<ChairInfo[]>([]);
  const [procedures, setProcedures] = useState<ProcedureInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedDate, setSelectedDate] = useState(localDateKey(new Date()));

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchData = async () => {
      try {
        // Lookups include inactive chairs and procedures so older appointments still show their names.
        const [aptsRes, ptsRes, docsRes, chrsRes, procRes] = await Promise.all([
          supabase.from("appointments").select("*").eq("clinic_id", user.clinic_id).order("start_time"),
          supabase.from("patients").select("id,full_name,phone").eq("clinic_id", user.clinic_id),
          supabase.from("doctors").select("id,user_id,specialty,users(full_name)").eq("clinic_id", user.clinic_id),
          supabase.from("chairs").select("id,name").eq("clinic_id", user.clinic_id),
          supabase.from("procedures_catalog").select("id,name").eq("clinic_id", user.clinic_id),
        ]);

        setAppointments(aptsRes.data || []);
        setPatients(ptsRes.data || []);
        // users(full_name) is a single object at runtime (many-to-one), which supabase's inferred type does not reflect.
        setDoctors((docsRes.data || []) as any[]);
        setChairs(chrsRes.data || []);
        setProcedures(procRes.data || []);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user?.clinic_id]);

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  const dayAppointments = appointments.filter(
    (apt) => localDateKey(new Date(apt.start_time)) === selectedDate
  );

  const getPatientName = (id: string) => patients.find((p) => p.id === id)?.full_name || "-";
  const getDoctorName = (id: string) => {
    const doctor = doctors.find((d) => d.id === id);
    return doctor?.users?.full_name || doctor?.specialty || "-";
  };
  const getChairName = (id: string) => chairs.find((c) => c.id === id)?.name || "-";
  const getProcedureName = (id?: string | null) =>
    (id && procedures.find((p) => p.id === id)?.name) || "-";

  const cancelAppointment = async (id: string) => {
    if (!user?.clinic_id || !confirm("Bu randevuyu iptal etmek istiyor musunuz?")) return;

    setCancellingId(id);
    const { data, error } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("clinic_id", user.clinic_id)
      .select("id");

    if (error || !data || data.length === 0) {
      alert("Randevu iptal edilemedi.");
    } else {
      setAppointments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "cancelled" } : a)));
    }
    setCancellingId(null);
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Randevular</h1>
        <Link
          href="/appointments/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Yeni Randevu
        </Link>
      </div>

      <div className="flex gap-4 mb-8">
        <button
          onClick={() => setView("list")}
          className={`px-4 py-2 rounded ${view === "list" ? "bg-blue-600 text-white" : "bg-gray-200"}`}
        >
          Liste
        </button>
        <button
          onClick={() => setView("calendar")}
          className={`px-4 py-2 rounded ${view === "calendar" ? "bg-blue-600 text-white" : "bg-gray-200"}`}
        >
          Takvim
        </button>
      </div>

      {view === "list" && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-2 text-left">Hasta</th>
                <th className="px-4 py-2 text-left">Hekim</th>
                <th className="px-4 py-2 text-left">Koltuk</th>
                <th className="px-4 py-2 text-left">Tedavi</th>
                <th className="px-4 py-2 text-left">Tarih/Saat</th>
                <th className="px-4 py-2 text-left">Durum</th>
                <th className="px-4 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {appointments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    Randevu bulunamadı
                  </td>
                </tr>
              ) : (
                appointments.map((apt) => (
                  <tr key={apt.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2">{getPatientName(apt.patient_id)}</td>
                    <td className="px-4 py-2">{getDoctorName(apt.doctor_id)}</td>
                    <td className="px-4 py-2">{getChairName(apt.chair_id)}</td>
                    <td className="px-4 py-2">{getProcedureName(apt.procedure_id)}</td>
                    <td className="px-4 py-2">{new Date(apt.start_time).toLocaleString("tr-TR")}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`px-2 py-1 rounded text-sm ${
                          apt.status === "completed"
                            ? "bg-green-100 text-green-800"
                            : apt.status === "cancelled"
                              ? "bg-red-100 text-red-800"
                              : "bg-blue-100 text-blue-800"
                        }`}
                      >
                        {STATUS_LABELS[apt.status] ?? apt.status}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {apt.status === "scheduled" && (
                        <button
                          onClick={() => cancelAppointment(apt.id)}
                          disabled={cancellingId === apt.id}
                          className="text-red-600 hover:underline disabled:opacity-50"
                        >
                          İptal Et
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === "calendar" && (
        <div>
          <div className="mb-4">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-4 py-2 border rounded"
            />
          </div>
          <div className="grid grid-cols-1 gap-4">
            {dayAppointments.length === 0 ? (
              <p className="text-gray-500">{selectedDate} tarihinde randevu yok</p>
            ) : (
              dayAppointments.map((apt) => (
                <div key={apt.id} className="p-4 border rounded bg-blue-50">
                  <div className="font-semibold">{getPatientName(apt.patient_id)}</div>
                  <div className="text-sm text-gray-600">
                    {new Date(apt.start_time).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })} -{" "}
                    {new Date(apt.end_time).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className="text-sm text-gray-600">
                    {getDoctorName(apt.doctor_id)} / {getChairName(apt.chair_id)}
                  </div>
                  {apt.procedure_id && (
                    <div className="text-sm text-gray-600">{getProcedureName(apt.procedure_id)}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
