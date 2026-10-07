"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface StockItem {
  id: string;
  item_code: string;
  item_name: string;
  category: string;
  quantity_on_hand: number;
  quantity_minimum: number;
  unit_price: number;
  supplier: string;
  expiry_date: string | null;
}

export default function InventoryPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "low_stock" | "expiring">("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchItems();
  }, [user?.clinic_id]);

  const fetchItems = async () => {
    try {
      const { data, error } = await supabase
        .from("stock_items")
        .select("*")
        .eq("clinic_id", user?.clinic_id)
        .order("item_name", { ascending: true });

      if (error) throw error;
      setItems(data || []);
    } catch (error) {
      console.error("Error fetching inventory:", error);
    } finally {
      setLoading(false);
    }
  };

  const filtered = items.filter((item) => {
    let match = true;

    if (filter === "low_stock") {
      match = match && item.quantity_on_hand <= item.quantity_minimum;
    } else if (filter === "expiring") {
      if (item.expiry_date) {
        const expiry = new Date(item.expiry_date);
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        match = match && expiry <= thirtyDaysFromNow && expiry >= new Date();
      } else {
        match = false;
      }
    }

    if (search) {
      match =
        match &&
        (item.item_name.toLowerCase().includes(search.toLowerCase()) ||
          item.item_code.includes(search));
    }

    return match;
  });

  const getStockStatus = (quantity: number, minimum: number) => {
    if (quantity <= minimum) {
      return { color: "text-red-600", label: "Düşük Stok", bgColor: "bg-red-50" };
    } else if (quantity <= minimum * 1.5) {
      return { color: "text-yellow-600", label: "Uyarı", bgColor: "bg-yellow-50" };
    }
    return { color: "text-green-600", label: "Uygun", bgColor: "bg-green-50" };
  };

  const getCategoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      materials: "Materyaller",
      instruments: "Aletler",
      disposables: "Tek Kullanımlı",
      supplies: "Sarf Malzeme",
    };
    return labels[category] || category;
  };

  const stats = {
    total: items.length,
    lowStock: items.filter((i) => i.quantity_on_hand <= i.quantity_minimum).length,
    totalValue: items.reduce((sum, i) => sum + i.quantity_on_hand * i.unit_price, 0),
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Envanter Yönetimi</h1>
        <button
          onClick={() => router.push("/inventory/new")}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Yeni Malzeme
        </button>
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-500 text-sm mb-2">Toplam Malzeme</div>
          <div className="text-3xl font-bold text-gray-800">{stats.total}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-red-500 text-sm mb-2">Düşük Stok</div>
          <div className="text-3xl font-bold text-red-600">{stats.lowStock}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-green-500 text-sm mb-2">Toplam Değer</div>
          <div className="text-3xl font-bold text-green-600">
            ₺{stats.totalValue.toLocaleString("tr-TR")}
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="mb-6 flex gap-4">
        <input
          type="text"
          placeholder="Malzeme adı veya kodla ara..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-4 py-2 border rounded"
        />
      </div>

      <div className="mb-6 flex gap-2">
        {(["all", "low_stock", "expiring"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded font-semibold ${
              filter === f
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-800 hover:bg-gray-300"
            }`}
          >
            {f === "all" ? "Tümü" : f === "low_stock" ? "Düşük Stok" : "Sona Erme Tarihi"}
          </button>
        ))}
      </div>

      {/* Inventory Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Kod
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Malzeme
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Kategori
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Stok
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Fiyat (₺)
              </th>
              <th className="px-6 py-4 text-left text-sm font-semibold text-gray-800">
                Tedarikçi
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
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-8 text-center text-gray-500">
                  Malzeme bulunamadı
                </td>
              </tr>
            ) : (
              filtered.map((item) => {
                const status = getStockStatus(item.quantity_on_hand, item.quantity_minimum);
                return (
                  <tr key={item.id} className={`border-b hover:bg-gray-50 ${status.bgColor}`}>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800">
                      {item.item_code}
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800">
                      {item.item_name}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {getCategoryLabel(item.category)}
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">
                      {item.quantity_on_hand} (Min: {item.quantity_minimum})
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {item.unit_price.toLocaleString("tr-TR")}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {item.supplier || "-"}
                    </td>
                    <td className={`px-6 py-4 text-sm font-semibold ${status.color}`}>
                      {status.label}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <button
                        onClick={() => router.push(`/inventory/${item.id}/edit`)}
                        className="text-blue-600 hover:underline"
                      >
                        Düzenle
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
