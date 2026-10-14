"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = [
  { value: "materials", label: "Materyaller" },
  { value: "instruments", label: "Aletler" },
  { value: "disposables", label: "Tek Kullanımlı" },
  { value: "supplies", label: "Sarf Malzeme" },
];

const emptyForm = {
  item_code: "",
  item_name: "",
  category: "",
  quantity_on_hand: "",
  quantity_minimum: "",
  unit_price: "",
  supplier: "",
  expiry_date: "",
};

type FormKey = keyof typeof emptyForm;

export default function EditInventoryItemPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [form, setForm] = useState(emptyForm);
  const [savedQuantity, setSavedQuantity] = useState(0);
  const [lastRestockedAt, setLastRestockedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!user?.clinic_id) return;

    const fetchItem = async () => {
      try {
        // A non-uuid id such as "new" would make Postgres reject the query.
        if (!UUID_RE.test(params.id)) {
          setStatus("missing");
          return;
        }

        const { data, error } = await supabase
          .from("stock_items")
          .select("*")
          .eq("id", params.id)
          .eq("clinic_id", user.clinic_id)
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          setStatus("missing");
          return;
        }

        setForm({
          item_code: data.item_code,
          item_name: data.item_name,
          category: data.category ?? "",
          quantity_on_hand: String(data.quantity_on_hand),
          quantity_minimum: String(data.quantity_minimum),
          unit_price: String(data.unit_price),
          supplier: data.supplier ?? "",
          expiry_date: data.expiry_date ?? "",
        });
        setSavedQuantity(data.quantity_on_hand);
        setLastRestockedAt(data.last_restocked_at);
        setStatus("ready");
      } catch (error) {
        console.error("Error fetching inventory item:", error);
        setStatus("error");
      }
    };

    fetchItem();
  }, [user?.clinic_id, params.id]);

  const setField = (key: FormKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;

    const code = form.item_code.trim();
    const name = form.item_name.trim();
    const onHand = parseInt(form.quantity_on_hand, 10);
    const minimum = parseInt(form.quantity_minimum, 10);
    const price = parseFloat(form.unit_price);
    if (!code || !name) {
      setSaveError("Malzeme kodu ve adı zorunludur.");
      return;
    }
    if (![onHand, minimum, price].every((n) => Number.isFinite(n) && n >= 0)) {
      setSaveError("Stok ve fiyat alanlarına geçerli bir sayı girin.");
      return;
    }

    setSubmitting(true);
    setSaveError("");
    try {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from("stock_items")
        .update({
          item_code: code,
          item_name: name,
          category: form.category || null,
          quantity_on_hand: onHand,
          quantity_minimum: minimum,
          unit_price: price,
          supplier: form.supplier.trim() || null,
          expiry_date: form.expiry_date || null,
          // A stock increase is treated as a restock.
          ...(onHand > savedQuantity ? { last_restocked_at: now } : {}),
          updated_at: now,
        })
        .eq("id", params.id)
        .eq("clinic_id", user.clinic_id)
        .select("id");

      if (error) {
        console.error("Error updating inventory item:", error);
        setSaveError(
          error.code === "23505"
            ? "Bu malzeme kodu zaten kayıtlı."
            : "Malzeme güncellenirken hata oluştu"
        );
        return;
      }
      if (!data || data.length === 0) {
        setSaveError("Malzeme güncellenemedi.");
        return;
      }
      router.push("/inventory");
    } catch (error) {
      console.error("Error updating inventory item:", error);
      setSaveError("Bağlantı hatası oluştu, tekrar deneyin.");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") return <div className="p-8">Yükleniyor...</div>;
  if (status === "missing") return <div className="p-8">Malzeme bulunamadı</div>;
  if (status === "error") return <div className="p-8">Malzeme yüklenemedi</div>;

  return (
    <div className="p-8">
      <button
        onClick={() => router.push("/inventory")}
        className="mb-6 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      >
        ← Geri Dön
      </button>

      <h1 className="text-3xl font-bold mb-2">Malzeme Düzenle</h1>
      <p className="text-sm text-gray-600 mb-8">
        Son stok girişi:{" "}
        {lastRestockedAt ? new Date(lastRestockedAt).toLocaleString("tr-TR") : "-"}
      </p>

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-lg shadow p-6 max-w-3xl text-gray-900"
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-semibold mb-2">Malzeme Kodu</label>
            <input
              type="text"
              value={form.item_code}
              onChange={setField("item_code")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Malzeme Adı</label>
            <input
              type="text"
              value={form.item_name}
              onChange={setField("item_name")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Kategori</label>
            <select
              value={form.category}
              onChange={setField("category")}
              className="w-full px-4 py-2 border rounded"
            >
              <option value="">Seçiniz</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Tedarikçi</label>
            <input
              type="text"
              value={form.supplier}
              onChange={setField("supplier")}
              className="w-full px-4 py-2 border rounded"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Stok Miktarı</label>
            <input
              type="number"
              min="0"
              step="1"
              value={form.quantity_on_hand}
              onChange={setField("quantity_on_hand")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Minimum Stok</label>
            <input
              type="number"
              min="0"
              step="1"
              value={form.quantity_minimum}
              onChange={setField("quantity_minimum")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Birim Fiyat (₺)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.unit_price}
              onChange={setField("unit_price")}
              className="w-full px-4 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2">Son Kullanma Tarihi</label>
            <input
              type="date"
              value={form.expiry_date}
              onChange={setField("expiry_date")}
              className="w-full px-4 py-2 border rounded"
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {submitting ? "Kaydediliyor..." : "Kaydet"}
          </button>
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
        </div>
      </form>
    </div>
  );
}
