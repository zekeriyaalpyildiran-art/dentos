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

const roundMoney = (value: number) => Math.round(value * 100) / 100;

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
  // Sum of the plan's items, or null when it has none and the total is entered by hand.
  const [itemsTotal, setItemsTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<TreatmentStatus>("draft");
  const [completedAt, setCompletedAt] = useState<string | null>(null);
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
          .select(
            "title, description, total_cost, status, completed_at, patients(full_name), doctors(users(full_name)), treatment_items(total_price)"
          )
          .eq("id", id)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (!data) return;
        const embeds = data as unknown as {
          patients: { full_name: string } | null;
          doctors: { users: { full_name: string } | null } | null;
          treatment_items: { total_price: number }[] | null;
        };
        const items = embeds.treatment_items || [];

        setFound(true);
        setPatientName(embeds.patients?.full_name || "-");
        setDoctorName(embeds.doctors?.users?.full_name || "-");
        setTitle(data.title);
        setTotalCost(String(data.total_cost));
        setItemsTotal(
          items.length > 0
            ? roundMoney(items.reduce((sum, item) => sum + Number(item.total_price), 0))
            : null
        );
        setStatus(data.status);
        setCompletedAt(data.completed_at);
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
    if (!user?.clinic_id) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setSaveError("Plan başlığı boş olamaz.");
      return;
    }

    const values: Record<string, unknown> = {
      title: trimmedTitle,
      description: notes.trim() || null,
      status,
      completed_at: status === "completed" ? completedAt ?? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    // With items, total_cost follows their sum (as the detail page keeps it), so only a plan without items takes a typed total.
    if (itemsTotal === null) {
      const cost = Number(totalCost);
      if (totalCost.trim() === "" || !Number.isFinite(cost) || cost < 0) {
        setSaveError("Geçerli bir tutar girin");
        return;
      }
      values.total_cost = roundMoney(cost);
    }

    setSaving(true);
    try {
      if (itemsTotal !== null) {
        // Save the current item sum shown above, which also repairs a total left stale by a failed recalculation.
        const { data: rows, error: itemsError } = await supabase
          .from("treatment_items")
          .select("total_price")
          .eq("treatment_plan_id", id)
          .eq("clinic_id", user.clinic_id);

        if (itemsError) throw itemsError;
        values.total_cost = roundMoney(
          (rows || []).reduce((sum, row) => sum + Number(row.total_price), 0)
        );
      }

      const { data, error } = await supabase
        .from("treatment_plans")
        .update(values)
        .eq("id", id)
        .eq("clinic_id", user.clinic_id)
        .select("id");

      if (error) throw error;
      // RLS silently skips rows the user may not update.
      if (!data || data.length === 0) {
        setSaveError("Plan güncellenemedi. Bu planı değiştirme yetkiniz olmayabilir.");
        return;
      }

      router.replace(`/treatment-plans/${id}`);
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
            {itemsTotal === null ? (
              <input
                type="number"
                min="0"
                step="0.01"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                className="w-full px-4 py-2 border rounded"
                required
              />
            ) : (
              <>
                <div className="text-lg font-semibold">₺{itemsTotal.toLocaleString("tr-TR")}</div>
                <p className="mt-1 text-xs text-gray-500">
                  Toplam tutar plandaki işlemlerden hesaplanır. Değiştirmek için plan detayından işlem ekleyin veya kaldırın.
                </p>
              </>
            )}
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
