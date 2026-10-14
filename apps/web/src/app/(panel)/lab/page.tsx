"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

type LabOrderStatus = "draft" | "submitted" | "in_progress" | "ready" | "delivered" | "cancelled";

interface LabOrder {
  id: string;
  order_number: string;
  status: LabOrderStatus;
  due_date: string;
  created_at: string;
  patient_name: string;
}

const STATUS_LABELS: Record<LabOrderStatus, string> = {
  draft: "Taslak",
  submitted: "Gönderildi",
  in_progress: "Hazırlanıyor",
  ready: "Hazır",
  delivered: "Teslim Edildi",
  cancelled: "İptal",
};

const STATUSES = Object.keys(STATUS_LABELS) as LabOrderStatus[];

export default function LabPage() {
  const { user } = useAuthStore();
  const supabase = createClient();

  const [orders, setOrders] = useState<LabOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<LabOrderStatus | "all">("all");

  useEffect(() => {
    fetchOrders();
  }, [user?.clinic_id]);

  const fetchOrders = async () => {
    if (!user?.clinic_id) {
      setErrorMessage("Klinik bilgisi bulunamadı.");
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("lab_orders")
        .select("id, order_number, status, due_date, created_at, patients(full_name)")
        .eq("clinic_id", user.clinic_id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      setOrders(
        (data || []).map((o: any) => ({
          id: o.id,
          order_number: o.order_number,
          status: o.status ?? "draft",
          due_date: o.due_date,
          created_at: o.created_at,
          patient_name: o.patients?.full_name || "-",
        }))
      );
      setErrorMessage("");
    } catch (err) {
      console.error("Error fetching lab orders:", err);
      setErrorMessage("Lab siparişleri yüklenemedi. Lütfen sayfayı yenileyin.");
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (id: string, status: LabOrderStatus) => {
    if (!user?.clinic_id) return;

    setUpdatingId(id);
    try {
      const { error } = await supabase
        .from("lab_orders")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("clinic_id", user.clinic_id);

      if (error) throw error;
      await fetchOrders();
    } catch (err) {
      console.error("Error updating lab order:", err);
      setErrorMessage("Sipariş durumu güncellenemedi. Lütfen tekrar deneyin.");
    } finally {
      setUpdatingId(null);
    }
  };

  const filtered = filter === "all" ? orders : orders.filter((o) => o.status === filter);

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Lab Siparişleri</h1>
        <Link
          href="/lab/new"
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          + Yeni Sipariş
        </Link>
      </div>

      {errorMessage && (
        <div className="mb-6 p-4 rounded bg-red-50 text-red-700">{errorMessage}</div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {(["all", ...STATUSES] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded font-semibold ${
              filter === f
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-800 hover:bg-gray-300"
            }`}
          >
            {f === "all" ? "Tümü" : STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Sipariş Tarihi
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Hasta
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Sipariş No
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Teslim Tarihi
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Durum
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                  Lab siparişi bulunamadı
                </td>
              </tr>
            ) : (
              filtered.map((order) => (
                <tr key={order.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {new Date(order.created_at).toLocaleDateString("tr-TR")}
                  </td>
                  <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                    {order.patient_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">{order.order_number}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {new Date(order.due_date + "T00:00:00").toLocaleDateString("tr-TR")}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <select
                      value={order.status}
                      disabled={updatingId === order.id}
                      onChange={(e) => updateStatus(order.id, e.target.value as LabOrderStatus)}
                      className="px-3 py-1 border rounded bg-white text-gray-900"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
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
