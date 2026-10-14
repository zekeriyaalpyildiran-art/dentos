"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Patient {
  id: string;
  full_name: string;
}

interface Doctor {
  id: string;
  users?: { full_name: string } | null;
}

interface ItemDraft {
  item_type: string;
  tooth_number: string;
  material: string;
  color_code: string;
  quantity: number;
  description: string;
}

const ITEM_TYPES = [
  { value: "crown", label: "Kron" },
  { value: "bridge", label: "Köprü" },
  { value: "denture", label: "Protez" },
  { value: "implant_crown", label: "İmplant Kronu" },
  { value: "other", label: "Diğer" },
];

const MATERIALS = [
  { value: "zirconium", label: "Zirkonyum" },
  { value: "ceramic", label: "Seramik" },
  { value: "composite", label: "Kompozit" },
  { value: "metal", label: "Metal" },
];

const emptyItem = (): ItemDraft => ({
  item_type: "crown",
  tooth_number: "",
  material: "zirconium",
  color_code: "",
  quantity: 1,
  description: "",
});

const inputClass =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500";
const labelClass = "block text-sm font-medium text-gray-700 mb-1";

export default function Page() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [patientId, setPatientId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchData = async () => {
      try {
        const [ptsRes, docsRes] = await Promise.all([
          supabase.from("patients").select("id,full_name").eq("clinic_id", user.clinic_id).eq("is_active", true),
          supabase.from("doctors").select("id,users(full_name)").eq("clinic_id", user.clinic_id),
        ]);

        setPatients(ptsRes.data || []);
        setDoctors((docsRes.data || []) as unknown as Doctor[]);
      } catch (err) {
        console.error("Error fetching lab order form data:", err);
        setError("Hasta ve hekim listesi yüklenemedi.");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user?.clinic_id]);

  const updateItem = (index: number, field: keyof ItemDraft, value: string | number) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const removeItem = (index: number) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;

    if (!patientId || !doctorId || !dueDate) {
      setError("Hasta, hekim ve teslim tarihi zorunludur.");
      return;
    }
    if (items.some((item) => !item.item_type || item.quantity < 1)) {
      setError("Her kalem için tür ve en az 1 adet girin.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const orderNumber = `LAB-${Date.now().toString(36).toUpperCase()}`;

      const { data: order, error: orderError } = await supabase
        .from("lab_orders")
        .insert({
          clinic_id: user.clinic_id,
          patient_id: patientId,
          doctor_id: doctorId,
          order_number: orderNumber,
          status: "draft",
          due_date: dueDate,
          notes: notes.trim() || null,
        })
        .select("id")
        .single();

      if (orderError || !order) throw orderError || new Error("Sipariş oluşturulamadı");

      const { error: itemsError } = await supabase.from("lab_order_items").insert(
        items.map((item) => ({
          clinic_id: user.clinic_id,
          lab_order_id: order.id,
          item_type: item.item_type,
          tooth_number: item.tooth_number.trim() || null,
          material: item.material || null,
          color_code: item.color_code.trim() || null,
          quantity: item.quantity,
          description: item.description.trim() || null,
        }))
      );

      if (itemsError) {
        setError("Sipariş oluşturuldu ancak kalemler kaydedilemedi. Lütfen sipariş listesini kontrol edin.");
        setSubmitting(false);
        return;
      }

      router.push("/lab");
    } catch (err) {
      console.error("Error creating lab order:", err);
      setError("Sipariş kaydedilemedi. Lütfen tekrar deneyin.");
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-gray-600">Yükleniyor...</div>;
  }

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/lab" className="text-blue-600 hover:underline text-sm">
        ← Lab Siparişlerine Dön
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-8">Yeni Lab Siparişi</h1>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Hasta</label>
            <select className={inputClass} value={patientId} onChange={(e) => setPatientId(e.target.value)}>
              <option value="">Seç...</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Hekim</label>
            <select className={inputClass} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">Seç...</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.users?.full_name || "İsimsiz hekim"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Teslim Tarihi</label>
            <input
              type="date"
              className={inputClass}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Notlar</label>
            <textarea
              className={inputClass}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Kalemler</h2>
            <button
              type="button"
              onClick={() => setItems((prev) => [...prev, emptyItem()])}
              className="px-3 py-1.5 text-sm border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50"
            >
              + Kalem Ekle
            </button>
          </div>

          {items.map((item, index) => (
            <div key={index} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end border-t pt-4">
              <div>
                <label className={labelClass}>Tür</label>
                <select
                  className={inputClass}
                  value={item.item_type}
                  onChange={(e) => updateItem(index, "item_type", e.target.value)}
                >
                  {ITEM_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Diş No</label>
                <input
                  className={inputClass}
                  value={item.tooth_number}
                  onChange={(e) => updateItem(index, "tooth_number", e.target.value)}
                  placeholder="16"
                />
              </div>
              <div>
                <label className={labelClass}>Malzeme</label>
                <select
                  className={inputClass}
                  value={item.material}
                  onChange={(e) => updateItem(index, "material", e.target.value)}
                >
                  {MATERIALS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Renk</label>
                <input
                  className={inputClass}
                  value={item.color_code}
                  onChange={(e) => updateItem(index, "color_code", e.target.value)}
                  placeholder="A2"
                />
              </div>
              <div>
                <label className={labelClass}>Adet</label>
                <input
                  type="number"
                  min={1}
                  className={inputClass}
                  value={item.quantity}
                  onChange={(e) => updateItem(index, "quantity", Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => removeItem(index)}
                  disabled={items.length === 1}
                  className="w-full px-3 py-2 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-40"
                >
                  Kaldır
                </button>
              </div>
              <div className="col-span-2 md:col-span-6">
                <label className={labelClass}>Açıklama</label>
                <input
                  className={inputClass}
                  value={item.description}
                  onChange={(e) => updateItem(index, "description", e.target.value)}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-500"
          >
            {submitting ? "Kaydediliyor..." : "Sipariş Oluştur"}
          </button>
          <Link href="/lab" className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            İptal
          </Link>
        </div>
      </form>
    </div>
  );
}
