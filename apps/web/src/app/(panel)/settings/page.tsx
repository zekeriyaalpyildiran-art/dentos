"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Clinic {
  name: string;
  phone: string | null;
  address: string | null;
  plan: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Sahip",
  admin: "Yönetici",
  doctor: "Hekim",
  assistant: "Asistan",
  reception: "Resepsiyon",
};

const PLAN_LABELS: Record<string, string> = {
  trial: "Deneme",
  starter: "Başlangıç",
  pro: "Pro",
};

function labelOf(map: Record<string, string>, key?: string | null) {
  return key ? map[key] ?? key : "-";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-3 border-b last:border-b-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 text-right">{value}</dd>
    </div>
  );
}

// Read-only: clinics has no UPDATE policy, so edits would be blocked by RLS.
export default function Page() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!user?.clinic_id) {
      setLoading(false);
      return;
    }

    const fetchClinic = async () => {
      setLoading(true);
      setFailed(false);
      try {
        const { data, error } = await supabase
          .from("clinics")
          .select("name, phone, address, plan")
          .eq("id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        setClinic(data);
      } catch (err) {
        console.error("Error fetching clinic:", err);
        setFailed(true);
      } finally {
        setLoading(false);
      }
    };

    fetchClinic();
  }, [user?.clinic_id]);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Ayarlar</h1>

      <div className="grid gap-6 md:grid-cols-2 items-start">
        <div>
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Klinik Bilgileri</h2>
            {loading ? (
              <p className="text-gray-500">Yükleniyor...</p>
            ) : failed ? (
              <p className="text-red-600">
                Klinik bilgileri yüklenemedi. Lütfen sayfayı yenileyin.
              </p>
            ) : (
              <dl>
                <Row label="Klinik Adı" value={clinic?.name || "-"} />
                <Row label="Telefon" value={clinic?.phone || "-"} />
                <Row label="Adres" value={clinic?.address || "-"} />
                <Row label="Plan" value={labelOf(PLAN_LABELS, clinic?.plan)} />
              </dl>
            )}
          </div>
          <p className="mt-3 text-sm text-gray-600">
            Klinik bilgilerinde değişiklik yapmak için bir yöneticiyle iletişime geçin.
          </p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Hesabım</h2>
          <dl>
            <Row label="E-posta" value={user?.email || "-"} />
            <Row label="Rol" value={labelOf(ROLE_LABELS, user?.role)} />
          </dl>
        </div>
      </div>
    </div>
  );
}
