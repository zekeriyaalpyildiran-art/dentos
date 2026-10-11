"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface StaffMember {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean | null;
}

interface Doctor {
  id: string;
  specialty: string | null;
  users: { full_name: string } | null;
}

const roleLabels: Record<string, string> = {
  owner: "Sahip",
  admin: "Yönetici",
  doctor: "Hekim",
  assistant: "Asistan",
  reception: "Resepsiyon",
};

const thClass = "px-6 py-4 text-left text-sm font-semibold text-gray-800";

export default function Page() {
  const { user } = useAuthStore();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!user?.clinic_id) {
      setLoading(false);
      return;
    }

    const clinicId = user.clinic_id;
    const supabase = createClient();

    const fetchTeam = async () => {
      try {
        const [staffRes, doctorRes] = await Promise.all([
          supabase
            .from("users")
            .select("id, full_name, email, role, is_active")
            .eq("clinic_id", clinicId)
            .order("full_name", { ascending: true }),
          supabase
            .from("doctors")
            .select("id, specialty, users(full_name)")
            .eq("clinic_id", clinicId),
        ]);

        if (staffRes.error || doctorRes.error) {
          throw new Error("Ekip verisi alınamadı");
        }

        setStaff(staffRes.data || []);
        setDoctors((doctorRes.data || []) as unknown as Doctor[]);
      } catch (err) {
        console.error("Error fetching team:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchTeam();
  }, [user?.clinic_id]);

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Ekip</h1>

      {error ? (
        <div className="bg-white rounded-lg shadow p-6 text-red-600">
          Ekip bilgileri yüklenemedi. Lütfen sayfayı yenileyin.
        </div>
      ) : (
        <>
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-gray-800 mb-4">Personel</h2>
            <div className="bg-white rounded-lg shadow overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className={thClass}>Ad Soyad</th>
                    <th className={thClass}>E-posta</th>
                    <th className={thClass}>Rol</th>
                    <th className={thClass}>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                        Personel bulunamadı
                      </td>
                    </tr>
                  ) : (
                    staff.map((member) => (
                      <tr key={member.id} className="border-b hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                          {member.full_name}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{member.email}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {roleLabels[member.role] || member.role}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <span
                            className={`px-3 py-1 rounded font-semibold ${
                              member.is_active
                                ? "bg-green-100 text-green-800"
                                : "bg-gray-100 text-gray-800"
                            }`}
                          >
                            {member.is_active ? "Aktif" : "Pasif"}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-800 mb-4">Hekimler</h2>
            <div className="bg-white rounded-lg shadow overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className={thClass}>Ad Soyad</th>
                    <th className={thClass}>Uzmanlık</th>
                  </tr>
                </thead>
                <tbody>
                  {doctors.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-6 py-8 text-center text-gray-500">
                        Hekim bulunamadı
                      </td>
                    </tr>
                  ) : (
                    doctors.map((doctor) => (
                      <tr key={doctor.id} className="border-b hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                          {doctor.users?.full_name || "-"}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {doctor.specialty || "-"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
