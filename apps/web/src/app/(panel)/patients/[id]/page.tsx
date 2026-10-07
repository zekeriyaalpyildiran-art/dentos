"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { useParams } from "next/navigation";

interface Patient {
  id: string;
  full_name: string;
  phone: string;
  email?: string;
  gender?: string;
  birth_date?: string;
  address?: string;
  kvkk_consent: boolean;
  notes?: string;
  created_at: string;
}

interface Appointment {
  id: string;
  start_time: string;
  end_time: string;
  status: string;
  notes?: string;
}

export default function Page() {
  const params = useParams();
  const patientId = params.id as string;
  const { user } = useAuthStore();
  const supabase = createClient();

  const [patient, setPatient] = useState<Patient | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "appointments" | "treatment-plan" | "documents" | "messages">("overview");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.clinic_id || !patientId) return;

    const fetchData = async () => {
      try {
        const [ptRes, aptRes] = await Promise.all([
          supabase.from("patients").select("*").eq("id", patientId).eq("clinic_id", user.clinic_id).single(),
          supabase.from("appointments").select("*").eq("patient_id", patientId).eq("clinic_id", user.clinic_id),
        ]);

        if (ptRes.data) setPatient(ptRes.data);
        setAppointments(aptRes.data || []);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user?.clinic_id, patientId]);

  if (loading) return <div className="p-8">Yükleniyor...</div>;
  if (!patient) return <div className="p-8">Hasta bulunamadı</div>;

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-bold">{patient.full_name}</h1>
          <p className="text-gray-600">{patient.phone}</p>
        </div>
        <button className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Düzenle</button>
      </div>

      {/* Patient Info Card */}
      <div className="grid grid-cols-2 gap-4 mb-8 bg-gray-50 p-4 rounded">
        <div>
          <div className="text-sm text-gray-600">E-posta</div>
          <div className="font-semibold">{patient.email || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Cinsiyet</div>
          <div className="font-semibold">{patient.gender || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">Doğum Tarihi</div>
          <div className="font-semibold">{patient.birth_date || "-"}</div>
        </div>
        <div>
          <div className="text-sm text-gray-600">KVKK Rızası</div>
          <div className={`font-semibold ${patient.kvkk_consent ? "text-green-600" : "text-red-600"}`}>
            {patient.kvkk_consent ? "✓ Var" : "✗ Yok"}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-sm text-gray-600">Adres</div>
          <div className="font-semibold">{patient.address || "-"}</div>
        </div>
        <div className="col-span-2">
          <div className="text-sm text-gray-600">Notlar</div>
          <div className="font-semibold">{patient.notes || "-"}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b mb-6">
        <div className="flex gap-4">
          {(["overview", "appointments", "treatment-plan", "documents", "messages"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 border-b-2 ${
                activeTab === tab ? "border-blue-600 text-blue-600 font-semibold" : "border-transparent text-gray-600"
              }`}
            >
              {tab === "overview"
                ? "Özet"
                : tab === "appointments"
                  ? "Randevular"
                  : tab === "treatment-plan"
                    ? "İşlem Planı"
                    : tab === "documents"
                      ? "Dokümanlar"
                      : "Mesajlar"}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Hızlı Özet</h2>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-50 p-4 rounded">
              <div className="text-sm text-gray-600">Toplam Randevu</div>
              <div className="text-2xl font-bold">{appointments.length}</div>
            </div>
            <div className="bg-green-50 p-4 rounded">
              <div className="text-sm text-gray-600">Tamamlanan</div>
              <div className="text-2xl font-bold">{appointments.filter((a) => a.status === "completed").length}</div>
            </div>
            <div className="bg-yellow-50 p-4 rounded">
              <div className="text-sm text-gray-600">Planlı</div>
              <div className="text-2xl font-bold">{appointments.filter((a) => a.status === "scheduled").length}</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "appointments" && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Randevu Geçmişi</h2>
          {appointments.length === 0 ? (
            <p className="text-gray-500">Randevu bulunamadı</p>
          ) : (
            <div className="space-y-3">
              {appointments.map((apt) => (
                <div key={apt.id} className="p-4 border rounded hover:bg-gray-50">
                  <div className="flex justify-between">
                    <div>
                      <div className="font-semibold">{new Date(apt.start_time).toLocaleString("tr-TR")}</div>
                      <div className="text-sm text-gray-600">{apt.notes}</div>
                    </div>
                    <span
                      className={`px-3 py-1 rounded text-sm ${
                        apt.status === "completed"
                          ? "bg-green-100 text-green-800"
                          : apt.status === "cancelled"
                            ? "bg-red-100 text-red-800"
                            : "bg-blue-100 text-blue-800"
                      }`}
                    >
                      {apt.status === "scheduled" ? "Planlı" : apt.status === "completed" ? "Tamamlandı" : "İptal"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {["treatment-plan", "documents", "messages"].includes(activeTab) && (
        <div className="text-center py-12 text-gray-500">
          <p>Bu sekme yakında aktif olacak</p>
        </div>
      )}
    </div>
  );
}
