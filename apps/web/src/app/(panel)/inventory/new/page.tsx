"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

const CATEGORIES = [
  { value: "materials", label: "Materyaller" },
  { value: "instruments", label: "Aletler" },
  { value: "disposables", label: "Tek Kullanımlı" },
  { value: "supplies", label: "Sarf Malzeme" },
];

export default function NewInventoryItemPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [itemCode, setItemCode] = useState("");
  const [itemName, setItemName] = useState("");
  const [category, setCategory] = useState("materials");
  const [quantityOnHand, setQuantityOnHand] = useState("0");
  const [quantityMinimum, setQuantityMinimum] = useState("5");
  const [unitPrice, setUnitPrice] = useState("");
  const [supplier, setSupplier] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) {
      setError("Oturum bilgisi bulunamadı.");
      return;
    }

    const code = itemCode.trim();
    const name = itemName.trim();
    const onHand = parseInt(quantityOnHand, 10);
    const minimum = parseInt(quantityMinimum, 10);
    const price = parseFloat(unitPrice);
    if (!code || !name) {
      setError("Malzeme kodu ve adı zorunludur.");
      return;
    }
    if (![onHand, minimum, price].every((n) => Number.isFinite(n) && n >= 0)) {
      setError("Stok ve fiyat alanlarına geçerli bir sayı girin.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const { error: insertError } = await supabase.from("stock_items").insert({
        clinic_id: user.clinic_id,
        item_code: code,
        item_name: name,
        category,
        quantity_on_hand: onHand,
        quantity_minimum: minimum,
        unit_price: price,
        supplier: supplier.trim() || null,
        // Opening stock counts as the first restock.
        last_restocked_at: onHand > 0 ? new Date().toISOString() : null,
        expiry_date: expiryDate || null,
      });

      if (insertError) {
        setError(
          insertError.code === "23505"
            ? "Bu malzeme kodu zaten kayıtlı."
            : `Kaydedilemedi: ${insertError.message}`
        );
        setSaving(false);
        return;
      }
      // The button stays disabled until navigation so a second click cannot resubmit.
      router.push("/inventory");
    } catch {
      setError("Bağlantı hatası oluştu, tekrar deneyin.");
      setSaving(false);
    }
  };

  return (
    <div className="p-8">
      <button
        onClick={() => router.push("/inventory")}
        className="mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </button>

      <h1 className="text-3xl font-bold mb-8">Yeni Malzeme</h1>

      <div className="bg-white rounded-lg shadow p-6 max-w-2xl">
        {error && <div className="mb-4 p-3 bg-red-50 text-red-700 rounded">{error}</div>}

        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Malzeme Kodu</label>
            <input
              type="text"
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Malzeme Adı</label>
            <input
              type="text"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Kategori</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-4 py-2 border rounded bg-white text-gray-900"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Tedarikçi</label>
            <input
              type="text"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Mevcut Stok</label>
            <input
              type="number"
              min="0"
              step="1"
              value={quantityOnHand}
              onChange={(e) => setQuantityOnHand(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Minimum Stok</label>
            <input
              type="number"
              min="0"
              step="1"
              value={quantityMinimum}
              onChange={(e) => setQuantityMinimum(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Birim Fiyat (₺)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-gray-900">Son Kullanma Tarihi</label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full px-4 py-2 border rounded text-gray-900"
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
            >
              {saving ? "Kaydediliyor..." : "Kaydet"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
