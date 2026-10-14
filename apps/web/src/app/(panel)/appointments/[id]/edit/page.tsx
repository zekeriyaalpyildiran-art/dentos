"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { reschedulePendingReminders } from "../../reminder-utils";

// Postgres rejects non-uuid ids, so such routes are treated as not found.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Doctor {
  id: string;
  user_id: string;
  specialty?: string;
  users?: { full_name: string } | null;
}

interface Chair {
  id: string;
  name: string;
  is_active: boolean | null;
}

interface Procedure {
  id: string;
  name: string;
  is_active: boolean | null;
}

// datetime-local inputs hold local wall-clock time without an offset.
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const emptyForm = {
  doctor_id: "",
  chair_id: "",
  procedure_id: "",
  start_time: "",
  end_time: "",
  notes: "",
};

export default function EditAppointmentPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "closed" | "error">("loading");
  const [patientName, setPatientName] = useState("");
  const [originalStart, setOriginalStart] = useState("");
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [chairs, setChairs] = useState<Chair[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [formData, setFormData] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user?.clinic_id || !id) return;

    const fetchData = async () => {
      try {
        if (!UUID_RE.test(id)) {
          setStatus("missing");
          return;
        }

        // Inactive chairs and procedures are loaded too, so the appointment's current ones stay selectable.
        const [aptRes, docsRes, chrsRes, procRes] = await Promise.all([
          supabase
            .from("appointments")
            .select("doctor_id, chair_id, procedure_id, start_time, end_time, status, notes, patients(full_name)")
            .eq("id", id)
            .eq("clinic_id", user.clinic_id)
            .maybeSingle(),
          supabase.from("doctors").select("id,user_id,specialty,users(full_name)").eq("clinic_id", user.clinic_id),
          supabase.from("chairs").select("id,name,is_active").eq("clinic_id", user.clinic_id).order("sort_order"),
          supabase.from("procedures_catalog").select("id,name,is_active").eq("clinic_id", user.clinic_id).order("name"),
        ]);

        const loadError = aptRes.error || docsRes.error || chrsRes.error || procRes.error;
        if (loadError) throw loadError;

        const apt = aptRes.data;
        if (!apt) {
          setStatus("missing");
          return;
        }
        if (apt.status !== "scheduled") {
          setStatus("closed");
          return;
        }

        const embeds = apt as unknown as { patients: { full_name: string } | null };
        setPatientName(embeds.patients?.full_name || "-");
        setOriginalStart(apt.start_time);
        // users(full_name) is a single object at runtime (many-to-one), which supabase's inferred type does not reflect.
        setDoctors((docsRes.data || []) as unknown as Doctor[]);
        setChairs((chrsRes.data || []).filter((c) => c.is_active || c.id === apt.chair_id));
        setProcedures((procRes.data || []).filter((p) => p.is_active || p.id === apt.procedure_id));
        setFormData({
          doctor_id: apt.doctor_id,
          chair_id: apt.chair_id,
          procedure_id: apt.procedure_id ?? "",
          start_time: toLocalInput(apt.start_time),
          end_time: toLocalInput(apt.end_time),
          notes: apt.notes ?? "",
        });
        setStatus("ready");
      } catch (error) {
        console.error("Error fetching appointment:", error);
        setStatus("error");
      }
    };

    fetchData();
  }, [user?.clinic_id, id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;

    setSubmitting(true);
    try {
      // datetime-local values carry no UTC offset, so convert from local time before update.
      const startIso = new Date(formData.start_time).toISOString();
      const endIso = new Date(formData.end_time).toISOString();

      if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
        alert("Bitiş saati başlangıç saatinden sonra olmalı.");
        return;
      }

      const { data: overlaps, error: overlapError } = await supabase
        .from("appointments")
        .select("id, doctor_id, chair_id")
        .eq("clinic_id", user.clinic_id)
        .eq("status", "scheduled")
        .neq("id", id)
        .lt("start_time", endIso)
        .gt("end_time", startIso);

      if (overlapError) {
        console.error("Error checking appointment overlaps:", overlapError);
        alert("Randevu çakışması kontrol edilirken hata oluştu.");
        return;
      }

      if ((overlaps || []).some((a) => a.doctor_id === formData.doctor_id)) {
        alert("Seçilen hekimin bu saatte başka bir randevusu var.");
        return;
      }

      if ((overlaps || []).some((a) => a.chair_id === formData.chair_id)) {
        alert("Seçilen koltuk bu saatte dolu.");
        return;
      }

      // Only a still-scheduled appointment is updated, in case it was cancelled or closed meanwhile.
      const { data: updated, error } = await supabase
        .from("appointments")
        .update({
          doctor_id: formData.doctor_id,
          chair_id: formData.chair_id,
          procedure_id: formData.procedure_id || null,
          start_time: startIso,
          end_time: endIso,
          notes: formData.notes || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("clinic_id", user.clinic_id)
        .eq("status", "scheduled")
        .select("id");

      if (error) throw error;
      if (!updated || updated.length === 0) {
        alert("Randevu güncellenemedi. Randevu iptal edilmiş ya da kapatılmış olabilir.");
        return;
      }

      if (new Date(startIso).getTime() !== new Date(originalStart).getTime()) {
        // The appointment is already saved, so only warn that its reminders still point at the old time.
        const moved = await reschedulePendingReminders(supabase, user.clinic_id, id, startIso);
        if (!moved) alert("Randevu güncellendi ancak hatırlatmalar yeni saate taşınamadı.");
      }

      router.push("/appointments");
    } catch (error) {
      console.error("Error updating appointment:", error);
      alert("Randevu güncellenirken hata oluştu");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") return <div className="p-8">Yükleniyor...</div>;
  if (status === "missing" || status === "closed")
    return (
      <div className="p-8">
        <p className="mb-4">
          {status === "missing" ? "Randevu bulunamadı" : "Yalnızca planlı randevular düzenlenebilir."}
        </p>
        <Link href="/appointments" className="text-blue-600 hover:underline">
          ← Randevulara Dön
        </Link>
      </div>
    );
  if (status === "error") return <div className="p-8">Randevu yüklenemedi</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Randevu Düzenle</h1>

      <form onSubmit={handleSubmit} className="max-w-2xl bg-white p-6 rounded-lg shadow">
        <div className="mb-6">
          <div className="text-gray-500 text-sm">Hasta</div>
          <div className="text-lg font-semibold">{patientName}</div>
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
                {`${c.name}${c.is_active ? "" : " (pasif)"}`}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">İşlem (isteğe bağlı)</label>
          <select
            value={formData.procedure_id}
            onChange={(e) => setFormData({ ...formData, procedure_id: e.target.value })}
            className="w-full px-4 py-2 border rounded"
          >
            <option value="">Seçilmedi</option>
            {procedures.map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.name}${p.is_active ? "" : " (pasif)"}`}
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
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {submitting ? "Kaydediliyor..." : "Kaydet"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/appointments")}
            className="px-6 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
          >
            Vazgeç
          </button>
        </div>
      </form>
    </div>
  );
}
