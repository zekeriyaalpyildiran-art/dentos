"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { amountToCents, asCurrency, formatMoney, type Currency } from "@/lib/payments";

const PAGE_SIZE = 50;

interface TreatmentPlan {
  id: string;
  patient_name: string;
  doctor_name: string;
  title: string;
  total_cost: number;
  currency: Currency;
  status: "draft" | "proposed" | "approved" | "in_progress" | "completed" | "cancelled";
  created_at: string;
}

export default function TreatmentPlansPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [plans, setPlans] = useState<TreatmentPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<"all" | TreatmentPlan["status"]>("all");
  const requestId = useRef(0);

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchPlans(0);
  }, [user?.clinic_id, filter]);

  const fetchPlans = async (from: number) => {
    const reqId = ++requestId.current;
    if (from === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      let query = supabase
        .from("treatment_plans")
        .select(
          `
          id,
          title,
          total_cost,
          currency,
          status,
          created_at,
          patients(full_name),
          doctors(users(full_name))
        `
        )
        .eq("clinic_id", user?.clinic_id);
      if (filter !== "all") query = query.eq("status", filter);

      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      // A newer request (filter change or another page) supersedes this one.
      if (reqId !== requestId.current) return;
      if (error) throw error;

      const mapped = (data || []).map((p: any) => ({
        id: p.id,
        patient_name: p.patients?.full_name || "-",
        doctor_name: p.doctors?.users?.full_name || "-",
        title: p.title,
        total_cost: Number(p.total_cost),
        currency: asCurrency(p.currency),
        status: p.status,
        created_at: p.created_at,
      }));

      setPlans((prev) => {
        if (from === 0) return mapped;
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...mapped.filter((p) => !seen.has(p.id))];
      });
      setHasMore(mapped.length === PAGE_SIZE);
    } catch (error) {
      console.error("Error fetching treatment plans:", error);
      if (from === 0) {
        setPlans([]);
        setHasMore(false);
      }
    } finally {
      if (reqId === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-gray-800",
      proposed: "bg-blue-100 text-blue-800",
      approved: "bg-green-100 text-green-800",
      in_progress: "bg-yellow-100 text-yellow-800",
      completed: "bg-green-100 text-green-800",
      cancelled: "bg-red-100 text-red-800",
    };
    return colors[status] || colors.draft;
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: "Taslak",
      proposed: "Önerilen",
      approved: "Onaylı",
      in_progress: "Devam Ediyor",
      completed: "Tamamlandı",
      cancelled: "İptal",
    };
    return labels[status] || status;
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Tedavi Planları</h1>
        <button
          onClick={() => router.push("/treatment-plans/new")}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Yeni Plan
        </button>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap gap-2">
        {(["all", "draft", "proposed", "approved", "in_progress", "completed", "cancelled"] as const).map((f) => (
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
        ))}
      </div>

      {/* Plans Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Hasta
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Hekim
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Plan
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Tutar
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Durum
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                İşlemler
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  Yükleniyor...
                </td>
              </tr>
            ) : plans.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  Plan bulunamadı
                </td>
              </tr>
            ) : (
              plans.map((plan) => (
                <tr key={plan.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                    {plan.patient_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {plan.doctor_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {plan.title}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-800 font-semibold">
                    {formatMoney(amountToCents(plan.total_cost), plan.currency)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className={`px-3 py-1 rounded text-sm font-semibold ${getStatusColor(plan.status)}`}>
                      {getStatusLabel(plan.status)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <button
                      onClick={() => router.push(`/treatment-plans/${plan.id}`)}
                      className="text-blue-600 hover:underline mr-4"
                    >
                      Detay
                    </button>
                    <button
                      onClick={() => router.push(`/treatment-plans/${plan.id}/edit`)}
                      className="text-gray-600 hover:underline"
                    >
                      Düzenle
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && !loading && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={() => fetchPlans(plans.length)}
            disabled={loadingMore}
            className="px-4 py-2 rounded font-semibold bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50"
          >
            {loadingMore ? "Yükleniyor..." : "Daha fazla yükle"}
          </button>
        </div>
      )}
    </div>
  );
}
