"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface StockItem {
  id: string;
  item_code: string;
  item_name: string;
  category: string | null;
  quantity_on_hand: number;
  quantity_minimum: number;
  unit_price: number;
  supplier: string | null;
  expiry_date: string | null;
}

type Filter = "all" | "low_stock" | "expiring" | "expired";
type ExpiryState = "expired" | "expiring";

const FILTER_LABELS: Record<Filter, string> = {
  all: "Tümü",
  low_stock: "Düşük Stok",
  expiring: "Süresi Yaklaşıyor",
  expired: "Süresi Doldu",
};

const EXPIRY_STYLES: Record<ExpiryState, { label: string; badge: string; text: string }> = {
  expired: { label: "Süresi Doldu", badge: "bg-red-100 text-red-800", text: "text-red-700" },
  expiring: { label: "Süresi Yaklaşıyor", badge: "bg-amber-100 text-amber-800", text: "text-amber-700" },
};

const EXPIRY_WARNING_DAYS = 30;

// expiry_date is a plain date, so it is compared as a local YYYY-MM-DD key to avoid UTC shifts.
const toDateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const formatDate = (value: string) =>
  new Date(value.slice(0, 10) + "T00:00:00").toLocaleDateString("tr-TR");

const isLowStock = (item: StockItem) => item.quantity_on_hand <= item.quantity_minimum;

export default function InventoryPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
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

  const today = new Date();
  const todayKey = toDateKey(today);
  const warningLimit = new Date(today);
  warningLimit.setDate(warningLimit.getDate() + EXPIRY_WARNING_DAYS);
  const warningKey = toDateKey(warningLimit);

  // An item is usable through its expiry date, so it only counts as expired from the next day.
  const getExpiryState = (expiryDate: string | null): ExpiryState | null => {
    if (!expiryDate) return null;
    const key = expiryDate.slice(0, 10);
    if (key < todayKey) return "expired";
    if (key <= warningKey) return "expiring";
    return null;
  };

  const filtered = items.filter((item) => {
    let match = true;

    if (filter === "low_stock") {
      match = isLowStock(item);
    } else if (filter === "expiring" || filter === "expired") {
      match = getExpiryState(item.expiry_date) === filter;
    }

    if (search) {
      const q = search.toLocaleLowerCase("tr-TR");
      match =
        match &&
        (item.item_name.toLocaleLowerCase("tr-TR").includes(q) ||
          item.item_code.toLocaleLowerCase("tr-TR").includes(q));
    }

    return match;
  });

  const getStockStatus = (quantity: number, minimum: number) => {
    if (quantity <= minimum) {
      return { color: "text-red-700", label: "Düşük Stok", bgColor: "bg-red-50" };
    } else if (quantity <= minimum * 1.5) {
      return { color: "text-yellow-800", label: "Uyarı", bgColor: "bg-yellow-50" };
    }
    return { color: "text-green-700", label: "Uygun", bgColor: "bg-green-50" };
  };

  const getCategoryLabel = (category: string | null) => {
    const labels: Record<string, string> = {
      materials: "Materyaller",
      instruments: "Aletler",
      disposables: "Tek Kullanımlı",
      supplies: "Sarf Malzeme",
    };
    if (!category) return "-";
    return labels[category] || category;
  };

  const stats = {
    total: items.length,
    lowStock: items.filter(isLowStock).length,
    expired: items.filter((i) => getExpiryState(i.expiry_date) === "expired").length,
    expiring: items.filter((i) => getExpiryState(i.expiry_date) === "expiring").length,
    totalValue: items.reduce((sum, i) => sum + i.quantity_on_hand * Number(i.unit_price), 0),
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-500 text-sm mb-2">Toplam Malzeme</div>
          <div className="text-3xl font-bold text-gray-800">{stats.total}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-red-700 text-sm mb-2">Düşük Stok</div>
          <div className="text-3xl font-bold text-red-600">{stats.lowStock}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-amber-700 text-sm mb-2">Son Kullanma Uyarısı</div>
          <div className="text-3xl font-bold">
            <span className="text-red-600">{stats.expired}</span>
            <span className="text-gray-400 mx-2">/</span>
            <span className="text-amber-600">{stats.expiring}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Süresi dolan / {EXPIRY_WARNING_DAYS} gün içinde dolacak
          </div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-green-700 text-sm mb-2">Toplam Değer</div>
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

      <div className="mb-6 flex flex-wrap gap-2">
        {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded font-semibold ${
              filter === f
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-800 hover:bg-gray-300"
            }`}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Inventory Table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
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
                Son Kullanma
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
                <td colSpan={9} className="px-6 py-8 text-center text-gray-500">
                  Malzeme bulunamadı
                </td>
              </tr>
            ) : (
              filtered.map((item) => {
                const status = getStockStatus(item.quantity_on_hand, item.quantity_minimum);
                const expiry = getExpiryState(item.expiry_date);
                const rowBg =
                  expiry === "expired" || isLowStock(item)
                    ? "bg-red-50"
                    : expiry === "expiring"
                      ? "bg-amber-50"
                      : status.bgColor;
                return (
                  <tr key={item.id} className={`border-b hover:bg-gray-50 ${rowBg}`}>
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
                      {Number(item.unit_price).toLocaleString("tr-TR")}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {item.supplier || "-"}
                    </td>
                    <td
                      className={`px-6 py-4 text-sm ${
                        expiry ? `font-semibold ${EXPIRY_STYLES[expiry].text}` : "text-gray-600"
                      }`}
                    >
                      {item.expiry_date ? formatDate(item.expiry_date) : "-"}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <div className={`font-semibold ${status.color}`}>{status.label}</div>
                      {expiry && (
                        <span
                          className={`inline-block mt-1 px-2 py-1 rounded text-xs font-semibold ${EXPIRY_STYLES[expiry].badge}`}
                        >
                          {EXPIRY_STYLES[expiry].label}
                        </span>
                      )}
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
