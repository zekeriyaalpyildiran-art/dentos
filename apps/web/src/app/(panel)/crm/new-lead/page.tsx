"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

const SOURCES = [
  { value: "direct", label: "Doğrudan" },
  { value: "referral", label: "Referans" },
  { value: "online", label: "Online" },
  { value: "social_media", label: "Sosyal Medya" },
  { value: "other", label: "Diğer" },
];

const STATUSES = [
  { value: "new", label: "Yeni" },
  { value: "contacted", label: "İletişime Geçildi" },
  { value: "interested", label: "İlgilendiği" },
  { value: "qualified", label: "Nitelikli" },
  { value: "converted", label: "Müşteri" },
  { value: "lost", label: "Kaybedildi" },
];

export default function NewLeadPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    full_name: "",
    phone: "",
    source: "",
    status: "new",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const fullName = formData.full_name.trim();
    const phone = formData.phone.trim();

    if (!user?.clinic_id) {
      setFormError("Oturum bilgisi bulunamadı. Lütfen tekrar giriş yapın.");
      return;
    }
    if (!fullName || !phone) {
      setFormError("Ad soyad ve telefon zorunludur.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const { error } = await supabase.from("leads").insert([
        {
          clinic_id: user.clinic_id,
          full_name: fullName,
          phone,
          source: formData.source || null,
          status: formData.status,
        },
      ]);

      if (error) throw error;

      router.push("/crm/leads");
    } catch (error) {
      console.error("Error creating lead:", error);
      setFormError("Lead kaydedilemedi. Lütfen tekrar deneyin.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-8">
      <Link
        href="/crm/leads"
        className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Lead Listesine Dön
      </Link>

      <h1 className="text-3xl font-bold mb-8">Yeni Lead</h1>

      <form
        onSubmit={handleSubmit}
        className="max-w-2xl bg-white p-6 rounded-lg shadow text-gray-900"
      >
        {formError && <p className="mb-6 text-red-600">{formError}</p>}

        <div className="mb-6">
          <label htmlFor="full_name" className="block text-sm font-semibold mb-2">
            Ad Soyad
          </label>
          <input
            id="full_name"
            type="text"
            value={formData.full_name}
            onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            required
          />
        </div>

        <div className="mb-6">
          <label htmlFor="phone" className="block text-sm font-semibold mb-2">
            Telefon
          </label>
          <input
            id="phone"
            type="tel"
            value={formData.phone}
            onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
            className="w-full px-4 py-2 border rounded"
            required
          />
        </div>

        <div className="mb-6">
          <label htmlFor="source" className="block text-sm font-semibold mb-2">
            Kaynak
          </label>
          <select
            id="source"
            value={formData.source}
            onChange={(e) => setFormData({ ...formData, source: e.target.value })}
            className="w-full px-4 py-2 border rounded"
          >
            <option value="">Seç...</option>
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-6">
          <label htmlFor="status" className="block text-sm font-semibold mb-2">
            Durum
          </label>
          <select
            id="status"
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="w-full px-4 py-2 border rounded"
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
        >
          {submitting ? "Kaydediliyor..." : "Lead Oluştur"}
        </button>
      </form>
    </div>
  );
}
