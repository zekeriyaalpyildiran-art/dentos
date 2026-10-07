"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Patient {
  id: string;
  full_name: string;
  phone: string;
  email?: string;
  gender?: string;
  kvkk_consent: boolean;
  created_at: string;
}

export default function Page() {
  const { user } = useAuthStore();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchPatients = async () => {
      try {
        const { data } = await supabase
          .from("patients")
          .select("*")
          .eq("clinic_id", user.clinic_id)
          .eq("is_active", true)
          .order("created_at", { ascending: false });

        setPatients(data || []);
      } finally {
        setLoading(false);
      }
    };

    fetchPatients();
  }, [user?.clinic_id]);

  const filtered = patients.filter((p) =>
    p.full_name.toLowerCase().includes(search.toLowerCase()) ||
    p.phone.includes(search)
  );

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Hastalar</h1>
        <button className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          + Yeni Hasta
        </button>
      </div>

      <input
        placeholder="Ad, telefon ara..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-4 py-2 border rounded mb-6"
      />

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-100">
            <tr>
              <th className="px-4 py-2 text-left">Ad Soyad</th>
              <th className="px-4 py-2 text-left">Telefon</th>
              <th className="px-4 py-2 text-left">E-posta</th>
              <th className="px-4 py-2 text-left">KVKK</th>
              <th className="px-4 py-2 text-left">İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  Hasta bulunamadı
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <tr key={p.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2">{p.full_name}</td>
                  <td className="px-4 py-2">{p.phone}</td>
                  <td className="px-4 py-2">{p.email || "-"}</td>
                  <td className="px-4 py-2">
                    <span className={p.kvkk_consent ? "text-green-600" : "text-red-600"}>
                      {p.kvkk_consent ? "✓" : "✗"}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <button className="text-blue-600 hover:underline mr-2">Düzenle</button>
                    <button className="text-red-600 hover:underline">Sil</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-sm text-gray-600">
        Toplam: {filtered.length} hasta
      </div>
    </div>
  );
}
