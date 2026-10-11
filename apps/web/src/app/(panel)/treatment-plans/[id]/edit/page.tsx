"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

type TreatmentStatus = "draft" | "proposed" | "approved" | "in_progress" | "completed" | "cancelled";

const STATUS_OPTIONS: { value: TreatmentStatus; label: string }[] = [
  { value: "draft", label: "Taslak" },
  { value: "proposed", label: "Önerilen" },
  { value: "approved", label: "Onaylı" },
  { value: "in_progress", label: "Devam Ediyor" },
  { value: "completed", label: "Tamamlandı" },
  { value: "cancelled", label: "İptal" },
];

// Postgres rejects non-uuid ids, so such routes are treated as not found.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function EditTreatmentPlanPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [found, setFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [patientName, setPatientName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [title, setTitle] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [status, setStatus] = useState<TreatmentStatus>("draft");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!user?.clinic_id || !id) return;

    const fetchPlan = async () => {
      try {
        if (!UUID_RE.test(id)) return;

        const { data, error } = await supabase
          .from("treatment_plans")
          .select("title, description, total_cost, status, patients(full_name), doctors(users(full_name))")
          .eq("id", id)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (!data) return;
        const embeds = data as unknown as {
          patients: { full_name: string } | null;
          doctors: { users: { full_name: string } | null } | null;
        };

        setFound(true);
        setPatientName(embeds.patients?.full_name || "-");
        setDoctorName(embeds.doctors?.users?.full_name || "-");
        setTitle(data.title);
        setTotalCost(String(data.total_cost));
        setStatus(data.status);
        setNotes(data.description || "");
      } catch (err) {
        console.error("Error fetching plan:", err);
        setLoadError("Plan yüklenemedi, lütfen tekrar deneyin.");
      } finally {
        setLoading(false);
      }
    };

    fetchPlan();
  }, [user?.clinic_id, id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError("");

    const cost = parseFloat(totalCost);
    if (Number.isNaN(cost) || cost < 0) {
      setSaveError("Geçerli bir tutar girin");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from("treatment_plans")
        .update({
          title,
          description: notes || null,
          total_cost: cost,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("clinic_id", user?.clinic_id);

      if (error) throw error;

      router.push(`/treatment-plans/${id}`);
    } catch (err) {
      console.error("Error saving plan:", err);
      setSaveError("Plan kaydedilemedi, lütfen tekrar deneyin.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  if (!found) {
    return <div className="p-8">{loadError || "Plan bulunamadı"}</div>;
  }

  return (
    <div className="p-8">
      <button
        onClick={() => router.push(`/treatment-plans/${id}`)}
        className="mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </button>

      <h1 className="text-3xl font-bold mb-8">Tedavi Planını Düzenle</h1>

      <div className="max-w-2xl bg-white rounded-lg shadow p-6 text-gray-900">
        <form onSubmit={handleSave} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-gray-500 text-sm">Hasta</div>
              <div className="text-lg font-semibold">{patientName}</div>
            </div>
            <div>
              <div className="text-gray-500 text-sm">Hekim</div>
              <div className="text-lg font-semibold">{doctorName}</div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Plan Başlığı</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Toplam Tutar (₺)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={totalCost}
              onChange={(e) => setTotalCost(e.target.value)}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Durum</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TreatmentStatus)}
              className="w-full px-4 py-2 border rounded"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2">Notlar</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full px-4 py-2 border rounded"
            />
          </div>

          {saveError && <p className="text-red-600 text-sm">{saveError}</p>}

          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </form>
      </div>
    </div>
  );
}
