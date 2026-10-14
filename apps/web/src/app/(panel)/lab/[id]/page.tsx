"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

type LabOrderStatus = "draft" | "submitted" | "in_progress" | "ready" | "delivered" | "cancelled";

interface LabOrder {
  id: string;
  order_number: string;
  status: LabOrderStatus;
  patient_name: string;
  doctor_name: string;
  lab_name: string | null;
  due_date: string;
  delivery_date: string | null;
  notes: string | null;
  created_at: string;
}

interface LabOrderItem {
  id: string;
  item_type: string;
  tooth_number: string | null;
  material: string | null;
  color_code: string | null;
  quantity: number | null;
  description: string | null;
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

const ITEM_TYPE_LABELS: Record<string, string> = {
  crown: "Kron",
  bridge: "Köprü",
  denture: "Protez",
  implant_crown: "İmplant Kronu",
  other: "Diğer",
};

const MATERIAL_LABELS: Record<string, string> = {
  zirconium: "Zirkonyum",
  ceramic: "Seramik",
  composite: "Kompozit",
  metal: "Metal",
};

// Postgres rejects non-uuid ids, so such routes are treated as not found.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const formatDay = (value: string | null) =>
  value ? new Date(value + "T00:00:00").toLocaleDateString("tr-TR") : "-";

// Local calendar day as YYYY-MM-DD, so delivery_date matches the clinic's day rather than UTC.
const localDateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function LabOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [order, setOrder] = useState<LabOrder | null>(null);
  const [items, setItems] = useState<LabOrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!user?.clinic_id || !orderId) return;

    const fetchOrder = async () => {
      try {
        if (!UUID_RE.test(orderId)) return;

        const { data, error } = await supabase
          .from("lab_orders")
          .select(
            "id, order_number, status, lab_name, due_date, delivery_date, notes, created_at, patients(full_name), doctors(users(full_name))"
          )
          .eq("id", orderId)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (!data) return;

        const embeds = data as unknown as {
          patients: { full_name: string } | null;
          doctors: { users: { full_name: string } | null } | null;
        };

        setOrder({
          id: data.id,
          order_number: data.order_number,
          status: data.status ?? "draft",
          patient_name: embeds.patients?.full_name || "-",
          doctor_name: embeds.doctors?.users?.full_name || "-",
          lab_name: data.lab_name ?? null,
          due_date: data.due_date,
          delivery_date: data.delivery_date ?? null,
          notes: data.notes ?? null,
          created_at: data.created_at,
        });

        const { data: itemData, error: itemErr } = await supabase
          .from("lab_order_items")
          .select("id, item_type, tooth_number, material, color_code, quantity, description")
          .eq("lab_order_id", data.id)
          .eq("clinic_id", user.clinic_id)
          .order("created_at", { ascending: true });

        if (itemErr) {
          console.error("Error fetching lab order items:", itemErr);
          setItemsError("Sipariş kalemleri yüklenemedi. Lütfen sayfayı yenileyin.");
        } else {
          setItems((itemData as LabOrderItem[]) || []);
        }
      } catch (err) {
        console.error("Error fetching lab order:", err);
        setError("Lab siparişi yüklenemedi. Lütfen sayfayı yenileyin.");
      } finally {
        setLoading(false);
      }
    };

    fetchOrder();
  }, [user?.clinic_id, orderId]);

  const updateStatus = async (status: LabOrderStatus) => {
    if (!user?.clinic_id || !order || status === order.status) return;

    setUpdating(true);
    setActionError(null);

    // delivery_date records when the work came back from the lab; undoing delivery clears it.
    const patch: { status: LabOrderStatus; updated_at: string; delivery_date?: string | null } = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (status === "delivered") patch.delivery_date = localDateKey(new Date());
    else if (order.status === "delivered") patch.delivery_date = null;

    try {
      const { data, error } = await supabase
        .from("lab_orders")
        .update(patch)
        .eq("id", order.id)
        .eq("clinic_id", user.clinic_id)
        .select("id, status, delivery_date");

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("Lab order was not updated");
      }

      const row = data[0] as { status: LabOrderStatus | null; delivery_date: string | null };
      setOrder((prev) =>
        prev ? { ...prev, status: row.status ?? "draft", delivery_date: row.delivery_date ?? null } : prev
      );
    } catch (err) {
      console.error("Error updating lab order:", err);
      setActionError("Sipariş durumu güncellenemedi. Lütfen tekrar deneyin.");
    } finally {
      setUpdating(false);
    }
  };

  const deleteOrder = async () => {
    if (!user?.clinic_id || !order || order.status !== "draft") return;
    if (!confirm(`${order.order_number} numaralı taslak sipariş ve kalemleri silinsin mi? Bu işlem geri alınamaz.`)) {
      return;
    }

    setDeleting(true);
    setActionError(null);
    try {
      // Items go with the order via ON DELETE CASCADE; RLS only allows deleting drafts.
      const { data, error } = await supabase
        .from("lab_orders")
        .delete()
        .eq("id", order.id)
        .eq("clinic_id", user.clinic_id)
        .eq("status", "draft")
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("Lab order was not deleted");
      }
      router.push("/lab");
    } catch (err) {
      console.error("Error deleting lab order:", err);
      setActionError("Sipariş silinemedi. Yalnızca taslak siparişler silinebilir.");
      setDeleting(false);
    }
  };

  if (loading) return <div className="p-8">Yükleniyor...</div>;

  if (!order) {
    return (
      <div className="p-8">
        <Link
          href="/lab"
          className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
        >
          ← Geri Dön
        </Link>
        <p className="text-gray-600">{error ?? "Lab siparişi bulunamadı"}</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <Link
        href="/lab"
        className="inline-block mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </Link>

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Sipariş {order.order_number}</h1>
        {order.status === "draft" && (
          <button
            type="button"
            onClick={deleteOrder}
            disabled={deleting || updating}
            className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-40"
          >
            {deleting ? "Siliniyor..." : "Siparişi Sil"}
          </button>
        )}
      </div>

      {actionError && (
        <div className="mb-6 p-4 rounded bg-red-50 text-red-700">{actionError}</div>
      )}

      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-gray-600">Sipariş No</div>
            <div className="font-semibold text-gray-900">{order.order_number}</div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Durum</div>
            <select
              value={order.status}
              disabled={updating || deleting}
              onChange={(e) => updateStatus(e.target.value as LabOrderStatus)}
              className="mt-1 px-3 py-1 border rounded bg-white text-gray-900 font-semibold"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-sm text-gray-600">Hasta</div>
            <div className="font-semibold text-gray-900">{order.patient_name}</div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Hekim</div>
            <div className="font-semibold text-gray-900">{order.doctor_name}</div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Laboratuvar</div>
            <div className="font-semibold text-gray-900">{order.lab_name || "-"}</div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Sipariş Tarihi</div>
            <div className="font-semibold text-gray-900">
              {new Date(order.created_at).toLocaleDateString("tr-TR")}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Teslim Tarihi</div>
            <div className="font-semibold text-gray-900">{formatDay(order.due_date)}</div>
          </div>
          <div>
            <div className="text-sm text-gray-600">Teslim Alınma Tarihi</div>
            <div className="font-semibold text-gray-900">{formatDay(order.delivery_date)}</div>
          </div>
          <div className="col-span-2">
            <div className="text-sm text-gray-600">Notlar</div>
            <div className="text-gray-900 whitespace-pre-wrap">{order.notes || "-"}</div>
          </div>
        </div>
      </div>

      <h2 className="text-xl font-bold text-gray-900 mb-4">Sipariş Kalemleri</h2>

      {itemsError && (
        <div className="mb-6 p-4 rounded bg-red-50 text-red-700">{itemsError}</div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">Tür</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">Diş No</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">Malzeme</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">Renk</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">Adet</th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">Açıklama</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  Bu siparişte kalem yok
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {ITEM_TYPE_LABELS[item.item_type] ?? item.item_type}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">{item.tooth_number || "-"}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {item.material ? (MATERIAL_LABELS[item.material] ?? item.material) : "-"}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">{item.color_code || "-"}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">{item.quantity ?? 1}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">{item.description || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
