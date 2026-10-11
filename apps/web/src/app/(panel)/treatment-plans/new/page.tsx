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
  specialty: string | null;
  users?: { full_name: string } | null;
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Taslak" },
  { value: "proposed", label: "Önerilen" },
  { value: "approved", label: "Onaylı" },
  { value: "in_progress", label: "Devam Ediyor" },
  { value: "completed", label: "Tamamlandı" },
  { value: "cancelled", label: "İptal" },
];

export default function NewTreatmentPlanPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    patient_id: "",
    doctor_id: "",
    title: "",
    total_cost: "",
    status: "draft",
    notes: "",
  });

  useEffect(() => {
    if (!user?.clinic_id) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        const [ptsRes, docsRes] = await Promise.all([
          supabase
            .from("patients")
            .select("id,full_name")
            .eq("clinic_id", user.clinic_id)
            .eq("is_active", true)
            .order("full_name"),
          supabase
            .from("doctors")
            .select("id,specialty,users(full_name)")
            .eq("clinic_id", user.clinic_id),
        ]);

        if (ptsRes.error) throw ptsRes.error;
        if (docsRes.error) throw docsRes.error;

        setPatients(ptsRes.data || []);
        // users(full_name) is a many-to-one join, so it arrives as one object that the inferred type does not reflect.
        setDoctors((docsRes.data || []) as unknown as Doctor[]);
      } catch (err) {
        console.error("Error loading treatment plan form data:", err);
        setErrorMessage("Hasta ve hekim listesi yüklenemedi.");
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
    setErrorMessage(null);
    try {
      const { error } = await supabase.from("treatment_plans").insert([
        {
          clinic_id: user.clinic_id,
          patient_id: formData.patient_id,
          doctor_id: formData.doctor_id,
          title: formData.title.trim(),
          total_cost: Number(formData.total_cost),
          status: formData.status,
          description: formData.notes.trim() || null,
        },
      ]);

      if (error) throw error;

      router.push("/treatment-plans");
    } catch (err) {
      console.error("Error creating treatment plan:", err);
      setErrorMessage("Tedavi planı kaydedilemedi. Lütfen tekrar deneyin.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <button
        onClick={() => router.push("/treatment-plans")}
        className="mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Tedavi Planlarına Dön
      </button>

      <h1 className="text-3xl font-bold mb-8">Yeni Tedavi Planı</h1>

      <form
        onSubmit={handleSubmit}
        className="max-w-2xl bg-white p-6 rounded-lg shadow text-gray-900"
      >
        {errorMessage && (
          <div className="mb-6 px-4 py-3 bg-red-50 text-red-700 rounded">{errorMessage}</div>
        )}

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
                {d.users?.full_name || d.specialty || "Hekim"}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">Plan Başlığı</label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            placeholder="Örn: Üst çene implant tedavisi"
            required
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-semibold mb-2">Toplam Tutar (₺)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={formData.total_cost}
              onChange={(e) => setFormData({ ...formData, total_cost: e.target.value })}
              className="w-full px-4 py-2 border rounded"
              placeholder="0.00"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Durum</label>
            <select
              value={formData.status}
              onChange={(e) => setFormData({ ...formData, status: e.target.value })}
              className="w-full px-4 py-2 border rounded"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">Notlar</label>
          <textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            rows={3}
            placeholder="Plan notları..."
          />
        </div>

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {submitting ? "Kaydediliyor..." : "Plan Oluştur"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/treatment-plans")}
            className="px-6 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
          >
            İptal
          </button>
        </div>
      </form>
    </div>
  );
}
