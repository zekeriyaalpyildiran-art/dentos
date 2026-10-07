"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Appointment {
  id: string;
  patient_id: string;
  doctor_id: string;
  chair_id: string;
  start_time: string;
  end_time: string;
  status: string;
  notes?: string;
}

interface PatientInfo {
  id: string;
  full_name: string;
  phone: string;
}

interface DoctorInfo {
  id: string;
  user_id: string;
  specialty?: string;
}

interface ChairInfo {
  id: string;
  name: string;
}

export default function Page() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<PatientInfo[]>([]);
  const [doctors, setDoctors] = useState<DoctorInfo[]>([]);
  const [chairs, setChairs] = useState<ChairInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split("T")[0]);

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchData = async () => {
      try {
        const [aptsRes, ptsRes, docsRes, chrsRes] = await Promise.all([
          supabase.from("appointments").select("*").eq("clinic_id", user.clinic_id),
          supabase.from("patients").select("id,full_name,phone").eq("clinic_id", user.clinic_id).eq("is_active", true),
          supabase.from("doctors").select("id,user_id,specialty").eq("clinic_id", user.clinic_id),
          supabase.from("chairs").select("id,name").eq("clinic_id", user.clinic_id).eq("is_active", true),
        ]);

        setAppointments(aptsRes.data || []);
        setPatients(ptsRes.data || []);
        setDoctors(docsRes.data || []);
        setChairs(chrsRes.data || []);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user?.clinic_id]);

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  const dayAppointments = appointments.filter((apt) => apt.start_time.startsWith(selectedDate));

  const getPatientName = (id: string) => patients.find((p) => p.id === id)?.full_name || "Unknown";
  const getDoctorSpecialty = (id: string) => doctors.find((d) => d.id === id)?.specialty || "Doctor";
  const getChairName = (id: string) => chairs.find((c) => c.id === id)?.name || "Chair";

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Randevular</h1>
        <button className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">+ Yeni Randevu</button>
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
                <th className="px-4 py-2 text-left">Tarih/Saat</th>
                <th className="px-4 py-2 text-left">Durum</th>
                <th className="px-4 py-2 text-left">İşlemler</th>
              </tr>
            </thead>
            <tbody>
              {appointments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    Randevu bulunamadı
                  </td>
                </tr>
              ) : (
                appointments.map((apt) => (
                  <tr key={apt.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2">{getPatientName(apt.patient_id)}</td>
                    <td className="px-4 py-2">{getDoctorSpecialty(apt.doctor_id)}</td>
                    <td className="px-4 py-2">{getChairName(apt.chair_id)}</td>
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
                        {apt.status === "scheduled" ? "Planlı" : apt.status === "completed" ? "Tamamlandı" : "İptal"}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <button className="text-blue-600 hover:underline mr-2">Düzenle</button>
                      <button className="text-red-600 hover:underline">İptal</button>
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
                    {getDoctorSpecialty(apt.doctor_id)} / {getChairName(apt.chair_id)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
