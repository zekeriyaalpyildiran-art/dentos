"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

const GENDERS = [
  { value: "male", label: "Erkek" },
  { value: "female", label: "Kadın" },
  { value: "other", label: "Diğer" },
];

export default function NewPatientPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [gender, setGender] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [kvkkConsent, setKvkkConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) {
      setError("Oturum bilgisi bulunamadı.");
      return;
    }
    if (!fullName.trim() || !phone.trim()) {
      setError("Ad soyad ve telefon zorunludur.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const { data, error: insertError } = await supabase
        .from("patients")
        .insert({
          clinic_id: user.clinic_id,
          full_name: fullName.trim(),
          phone: phone.trim(),
          email: email.trim() || null,
          gender: gender || null,
          birth_date: birthDate || null,
          address: address.trim() || null,
          notes: notes.trim() || null,
          kvkk_consent: kvkkConsent,
          consent_date: kvkkConsent ? new Date().toISOString() : null,
          is_active: true,
        })
        .select("id")
        .single();

      if (insertError || !data) {
        setError(
          insertError?.code === "23505"
            ? "Bu telefon numarasıyla kayıtlı bir hasta zaten var."
            : `Kaydedilemedi: ${insertError?.message ?? "Bilinmeyen hata"}`
        );
        return;
      }
      router.push(`/patients/${data.id}`);
    } catch {
      setError("Bağlantı hatası oluştu, tekrar deneyin.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8">
      <Link
        href="/patients"
        className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </Link>

      <h1 className="text-3xl font-bold mb-8">Yeni Hasta</h1>

      <div className="bg-white rounded-lg shadow p-6 max-w-2xl">
        {error && <div className="mb-4 p-3 bg-red-50 text-red-700 rounded">{error}</div>}

        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Ad Soyad *</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Telefon *</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">E-posta</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Cinsiyet</label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full px-4 py-2 border rounded bg-white text-gray-900"
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
            <label className="block text-sm font-semibold mb-2 text-gray-900">Doğum Tarihi</label>
            <input
              type="date"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-semibold mb-2 text-gray-900">Adres</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-semibold mb-2 text-gray-900">Notlar</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm text-gray-900">
              <input
                type="checkbox"
                checked={kvkkConsent}
                onChange={(e) => setKvkkConsent(e.target.checked)}
              />
              KVKK aydınlatma metni onaylandı
            </label>
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
            >
              {saving ? "Kaydediliyor..." : "Kaydet"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
