"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Lead {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  status: string;
  source: string;
  created_at: string;
}

export default function LeadsListPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "new" | "contacted" | "interested" | "qualified">(
    "all"
  );
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchLeads();
  }, [user?.clinic_id]);

  const fetchLeads = async () => {
    try {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("clinic_id", user?.clinic_id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setLeads(data || []);
    } catch (error) {
      console.error("Error fetching leads:", error);
    } finally {
      setLoading(false);
    }
  };

  const filtered = leads.filter((lead) => {
    let match = true;

    if (filter !== "all") {
      match = match && lead.status === filter;
    }

    if (search) {
      match =
        match &&
        (lead.full_name.toLowerCase().includes(search.toLowerCase()) ||
          lead.phone.includes(search));
    }

    return match;
  });

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      new: "bg-gray-100 text-gray-800",
      contacted: "bg-blue-100 text-blue-800",
      interested: "bg-yellow-100 text-yellow-800",
      qualified: "bg-green-100 text-green-800",
      converted: "bg-emerald-100 text-emerald-800",
      lost: "bg-red-100 text-red-800",
    };
    return colors[status] || colors.new;
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      new: "Yeni",
      contacted: "İletişime Geçildi",
      interested: "İlgilendiği",
      qualified: "Nitelikli",
      converted: "Müşteri",
      lost: "Kaybedildi",
    };
    return labels[status] || status;
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Leads</h1>
        <button
          onClick={() => router.push("/crm/new-lead")}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Yeni Lead
        </button>
      </div>

      {/* Search and Filters */}
      <div className="mb-6 flex gap-4">
        <input
          type="text"
          placeholder="Ad veya telefon ile ara..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-4 py-2 border rounded"
        />
      </div>

      <div className="mb-6 flex gap-2">
        {(["all", "new", "contacted", "interested", "qualified"] as const).map(
          (f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded font-semibold ${
                filter === f
                  ? "bg-blue-600 text-white"
                  : "bg-gray-200 text-gray-800 hover:bg-gray-300"
              }`}
            >
              {f === "all" ? "Tümü" : getStatusLabel(f)}
            </button>
          )
        )}
      </div>

      {/* Leads Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                İsim
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Telefon
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Email
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Durum
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Kaynak
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Tarih
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                İşlemler
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                  Lead bulunamadı
                </td>
              </tr>
            ) : (
              filtered.map((lead) => (
                <tr key={lead.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-semibold text-gray-800">
                    {lead.full_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {lead.phone}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {lead.email || "-"}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className={`px-3 py-1 rounded text-sm font-semibold ${getStatusColor(lead.status)}`}>
                      {getStatusLabel(lead.status)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {lead.source}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {new Date(lead.created_at).toLocaleDateString("tr-TR")}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <button
                      onClick={() => router.push(`/crm/leads/${lead.id}`)}
                      className="text-blue-600 hover:underline"
                    >
                      Detay
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
