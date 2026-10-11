"use client";

import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Stats {
  activePatients: number;
  monthAppointments: number;
  monthRevenue: number;
  openPlans: number;
  lowStock: number;
}

const formatTRY = (value: number) =>
  `₺${value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatCard({
  label,
  value,
  valueClass = "text-gray-900",
}: {
  label: string;
  value: string | number;
  valueClass?: string;
}) {
  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="text-gray-500 text-sm mb-2">{label}</div>
      <div className={`text-3xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}

export default function Page() {
  const user = useAuthStore((state) => state.user);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const clinicId = user?.clinic_id;
    if (!clinicId) {
      setError(true);
      setLoading(false);
      return;
    }

    const load = async () => {
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        // Exclusive upper bound: the next month's start, so boundary rows are not counted twice.
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
        const supabase = createClient();

        const [patients, appointments, payments, plans, stock] = await Promise.all([
          supabase
            .from("patients")
            .select("id", { count: "exact", head: true })
            .eq("clinic_id", clinicId)
            .eq("is_active", true),
          supabase
            .from("appointments")
            .select("id", { count: "exact", head: true })
            .eq("clinic_id", clinicId)
            .gte("start_time", monthStart)
            .lt("start_time", monthEnd),
          supabase
            .from("payments")
            .select("amount")
            .eq("clinic_id", clinicId)
            .eq("status", "paid")
            .gte("paid_at", monthStart)
            .lt("paid_at", monthEnd),
          supabase
            .from("treatment_plans")
            .select("id", { count: "exact", head: true })
            .eq("clinic_id", clinicId)
            .not("status", "in", "(completed,cancelled)"),
          supabase
            .from("stock_items")
            .select("quantity_on_hand, quantity_minimum")
            .eq("clinic_id", clinicId),
        ]);

        if ([patients, appointments, payments, plans, stock].some((r) => r.error)) {
          setError(true);
          return;
        }

        setStats({
          activePatients: patients.count ?? 0,
          monthAppointments: appointments.count ?? 0,
          monthRevenue: (payments.data ?? []).reduce((sum, p) => sum + Number(p.amount), 0),
          openPlans: plans.count ?? 0,
          lowStock: (stock.data ?? []).filter(
            (s) => s.quantity_on_hand <= s.quantity_minimum
          ).length,
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [user?.clinic_id]);

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Raporlar</h1>

      {error || !stats ? (
        <div className="bg-white p-6 rounded-lg shadow text-red-600">
          Raporlar yüklenirken bir hata oluştu. Lütfen sayfayı yenileyin.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <StatCard label="Aktif Hasta" value={stats.activePatients} />
          <StatCard label="Bu Ay Randevu" value={stats.monthAppointments} />
          <StatCard
            label="Bu Ay Tahsilat"
            value={formatTRY(stats.monthRevenue)}
            valueClass="text-green-600"
          />
          <StatCard label="Açık Tedavi Planı" value={stats.openPlans} />
          <StatCard
            label="Düşük Stoklu Ürün"
            value={stats.lowStock}
            valueClass="text-red-600"
          />
        </div>
      )}
    </div>
  );
}
