"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Patient {
  id: string;
  full_name: string;
}

interface Doctor {
  id: string;
  user_id: string;
  specialty?: string;
}

interface Chair {
  id: string;
  name: string;
}

export default function Page() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [chairs, setChairs] = useState<Chair[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    patient_id: "",
    doctor_id: "",
    chair_id: "",
    start_time: "",
    end_time: "",
    notes: "",
  });

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchData = async () => {
      try {
        const [ptsRes, docsRes, chrsRes] = await Promise.all([
          supabase.from("patients").select("id,full_name").eq("clinic_id", user.clinic_id).eq("is_active", true),
          supabase.from("doctors").select("id,user_id,specialty").eq("clinic_id", user.clinic_id),
          supabase.from("chairs").select("id,name").eq("clinic_id", user.clinic_id).eq("is_active", true),
        ]);

        setPatients(ptsRes.data || []);
        setDoctors(docsRes.data || []);
        setChairs(chrsRes.data || []);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user?.clinic_id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;

    setSubmitting(true);
    try {
      const { error } = await supabase.from("appointments").insert([
        {
          clinic_id: user.clinic_id,
          patient_id: formData.patient_id,
          doctor_id: formData.doctor_id,
          chair_id: formData.chair_id,
          start_time: formData.start_time,
          end_time: formData.end_time,
          notes: formData.notes || null,
          status: "scheduled",
        },
      ]);

      if (error) throw error;

      // Create reminder 24h before appointment
      const appointmentDate = new Date(formData.start_time);
      const reminderDate = new Date(appointmentDate.getTime() - 24 * 60 * 60 * 1000);

      const patient = patients.find((p) => p.id === formData.patient_id);
      if (patient) {
        await supabase.from("reminders").insert([
          {
            clinic_id: user.clinic_id,
            appointment_id: null, // Will be set after appointment created
            reminder_type: "sms",
            scheduled_at: reminderDate.toISOString(),
            status: "pending",
          },
        ]);
      }

      router.push("/appointments");
    } catch (error) {
      console.error("Error creating appointment:", error);
      alert("Randevu oluşturulurken hata oluştu");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Yeni Randevu</h1>

      <form onSubmit={handleSubmit} className="max-w-2xl bg-white p-6 rounded-lg shadow">
        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">Hasta</label>
          <select
            value={formData.patient_id}
            onChange={(e) => setFormData({ ...formData, patient_id: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            required
          >
            <option value="">Seç...</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">Hekim</label>
          <select
            value={formData.doctor_id}
            onChange={(e) => setFormData({ ...formData, doctor_id: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            required
          >
            <option value="">Seç...</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.specialty || "Doctor"}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">Koltuk</label>
          <select
            value={formData.chair_id}
            onChange={(e) => setFormData({ ...formData, chair_id: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            required
          >
            <option value="">Seç...</option>
            {chairs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-semibold mb-2">Başlangıç</label>
            <input
              type="datetime-local"
              value={formData.start_time}
              onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Bitiş</label>
            <input
              type="datetime-local"
              value={formData.end_time}
              onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">Notlar</label>
          <textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            rows={3}
            placeholder="İşlem notları..."
          />
        </div>

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            {submitting ? "Kaydediliyor..." : "Randevu Oluştur"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="px-6 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
          >
            İptal
          </button>
        </div>
      </form>
    </div>
  );
}
