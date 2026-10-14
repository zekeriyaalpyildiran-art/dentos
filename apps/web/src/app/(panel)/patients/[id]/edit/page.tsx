"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GENDERS = [
  { value: "male", label: "Erkek" },
  { value: "female", label: "Kadın" },
  { value: "other", label: "Diğer" },
];

const emptyForm = {
  full_name: "",
  phone: "",
  email: "",
  gender: "",
  birth_date: "",
  address: "",
  notes: "",
};

type FormKey = keyof typeof emptyForm;

export default function EditPatientPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [form, setForm] = useState(emptyForm);
  const [kvkkConsent, setKvkkConsent] = useState(false);
  const [initialKvkkConsent, setInitialKvkkConsent] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchPatient = async () => {
      try {
        if (!UUID_RE.test(params.id)) {
          setStatus("missing");
          return;
        }

        const { data, error } = await supabase
          .from("patients")
          .select("*")
          .eq("id", params.id)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          setStatus("missing");
          return;
        }

        setForm({
          full_name: data.full_name ?? "",
          phone: data.phone ?? "",
          email: data.email ?? "",
          gender: data.gender ?? "",
          birth_date: data.birth_date ?? "",
          address: data.address ?? "",
          notes: data.notes ?? "",
        });
        setKvkkConsent(!!data.kvkk_consent);
        setInitialKvkkConsent(!!data.kvkk_consent);
        setStatus("ready");
      } catch (error) {
        console.error("Error fetching patient:", error);
        setStatus("error");
      }
    };

    fetchPatient();
  }, [user?.clinic_id, params.id]);

  const setField =
    (key: FormKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;
    if (!form.full_name.trim() || !form.phone.trim()) {
      setSaveError("Ad soyad ve telefon zorunludur.");
      return;
    }

    setSubmitting(true);
    setSaveError("");
    try {
      const updates: Record<string, unknown> = {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        gender: form.gender || null,
        birth_date: form.birth_date || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null,
        kvkk_consent: kvkkConsent,
        updated_at: new Date().toISOString(),
      };
      if (kvkkConsent !== initialKvkkConsent) {
        updates.consent_date = kvkkConsent ? new Date().toISOString() : null;
      }

      const { data, error } = await supabase
        .from("patients")
        .update(updates)
        .eq("id", params.id)
        .eq("clinic_id", user.clinic_id)
        .select("id");

      if (error) {
        setSaveError(
          error.code === "23505"
            ? "Bu telefon numarasıyla kayıtlı bir hasta zaten var."
            : `Kaydedilemedi: ${error.message}`
        );
        return;
      }
      if (!data || data.length === 0) {
        setSaveError("Hasta güncellenemedi.");
        return;
      }
      router.push(`/patients/${params.id}`);
    } catch (error) {
      console.error("Error updating patient:", error);
      setSaveError("Bağlantı hatası oluştu, tekrar deneyin.");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") return <div className="p-8">Yükleniyor...</div>;
  if (status === "missing")
    return (
      <div className="p-8">
        <p className="mb-4">Hasta bulunamadı</p>
        <Link href="/patients" className="text-blue-600 hover:underline">
          ← Hastalara Dön
        </Link>
      </div>
    );
  if (status === "error") return <div className="p-8">Hasta yüklenemedi</div>;

  return (
    <div className="p-8">
      <Link
        href={`/patients/${params.id}`}
        className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </Link>

      <h1 className="text-3xl font-bold mb-8">Hasta Düzenle</h1>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 max-w-3xl text-gray-900">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-semibold mb-2">Ad Soyad *</label>
            <input
              type="text"
              value={form.full_name}
              onChange={setField("full_name")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Telefon *</label>
            <input
              type="tel"
              value={form.phone}
              onChange={setField("phone")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">E-posta</label>
            <input
              type="email"
              value={form.email}
              onChange={setField("email")}
              className="w-full px-4 py-2 border rounded"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Cinsiyet</label>
            <select
              value={form.gender}
              onChange={setField("gender")}
              className="w-full px-4 py-2 border rounded bg-white"
            >
              <option value="">Seçiniz</option>
              {GENDERS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Doğum Tarihi</label>
            <input
              type="date"
              value={form.birth_date}
              onChange={setField("birth_date")}
              className="w-full px-4 py-2 border rounded"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold mb-2">Adres</label>
            <input
              type="text"
              value={form.address}
              onChange={setField("address")}
              className="w-full px-4 py-2 border rounded"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold mb-2">Notlar</label>
            <textarea
              value={form.notes}
              onChange={setField("notes")}
              rows={3}
              className="w-full px-4 py-2 border rounded"
            />
          </div>
          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={kvkkConsent}
                onChange={(e) => setKvkkConsent(e.target.checked)}
              />
              KVKK aydınlatma metni onaylandı
            </label>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {submitting ? "Kaydediliyor..." : "Kaydet"}
          </button>
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
        </div>
      </form>
    </div>
  );
}
