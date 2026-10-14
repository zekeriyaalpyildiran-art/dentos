"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";

type Category =
  | "examination"
  | "cleaning"
  | "filling"
  | "root_canal"
  | "extraction"
  | "implant"
  | "crown"
  | "whitening"
  | "orthodontics"
  | "other";

interface Procedure {
  id: string;
  name: string;
  category: Category;
  is_active: boolean;
  default_price: number | null;
}

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "examination", label: "Muayene" },
  { value: "cleaning", label: "Temizlik / Koruyucu" },
  { value: "filling", label: "Dolgu" },
  { value: "root_canal", label: "Kanal" },
  { value: "extraction", label: "Çekim" },
  { value: "implant", label: "İmplant" },
  { value: "crown", label: "Kron / Estetik" },
  { value: "whitening", label: "Beyazlatma" },
  { value: "orthodontics", label: "Ortodonti" },
  { value: "other", label: "Diğer" },
];

const inputClass =
  "px-3 py-2 border border-gray-300 rounded text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500";

// Empty input means "no default price"; undefined signals an invalid value. The column is numeric(10,2).
const parsePrice = (value: string): number | null | undefined => {
  if (value.trim() === "") return null;
  const price = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(price) || price < 0 || price >= 100000000) return undefined;
  return price;
};

interface Props {
  clinicId: string;
  canEdit: boolean;
}

export function ProcedureCatalog({ clinicId, canEdit }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<Category>("examination");
  const [newPrice, setNewPrice] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState<Category>("examination");
  const [editPrice, setEditPrice] = useState("");
  // The edit row is not a form, so a value the number input cannot parse (e.g. "12,50") arrives as "" unvalidated.
  const editPriceRef = useRef<HTMLInputElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("procedures_catalog")
      .select("id, name, category, is_active, default_price")
      .eq("clinic_id", clinicId)
      .order("name");

    if (loadError) {
      console.error("Error loading procedures:", loadError);
      setError("İşlemler yüklenemedi. Lütfen sayfayı yenileyin.");
    } else {
      setItems((data ?? []) as Procedure[]);
    }
    setLoading(false);
  }, [supabase, clinicId]);

  useEffect(() => {
    load();
  }, [load]);

  const describeError = (code?: string) =>
    code === "23505" ? "Bu isimde bir işlem zaten var." : "İşlem kaydedilemedi. Lütfen tekrar deneyin.";

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const defaultPrice = parsePrice(newPrice);
    if (defaultPrice === undefined) {
      setError("Geçerli bir varsayılan ücret girin.");
      return;
    }

    setAdding(true);
    setError(null);
    const { error: insertError } = await supabase.from("procedures_catalog").insert({
      clinic_id: clinicId,
      name,
      category: newCategory,
      is_active: true,
      default_price: defaultPrice,
    });

    if (insertError) {
      setError(describeError(insertError.code));
    } else {
      setNewName("");
      setNewPrice("");
      await load();
    }
    setAdding(false);
  };

  // RLS silently skips rows the user may not update, so an empty result means the change was refused.
  const update = async (id: string, values: Partial<Procedure>) => {
    setBusyId(id);
    setError(null);
    const { data, error: updateError } = await supabase
      .from("procedures_catalog")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .select("id");

    let ok = false;
    if (updateError) {
      setError(describeError(updateError.code));
    } else if (!data || data.length === 0) {
      setError("Bu işlemi değiştirme yetkiniz yok.");
    } else {
      ok = true;
      await load();
    }
    setBusyId(null);
    return ok;
  };

  const startEdit = (p: Procedure) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditCategory(p.category);
    setEditPrice(p.default_price == null ? "" : String(p.default_price));
  };

  const saveEdit = async (id: string) => {
    const name = editName.trim();
    if (!name) return;
    const defaultPrice = editPriceRef.current?.validity.badInput ? undefined : parsePrice(editPrice);
    if (defaultPrice === undefined) {
      setError("Geçerli bir varsayılan ücret girin.");
      return;
    }
    if (await update(id, { name, category: editCategory, default_price: defaultPrice })) {
      setEditingId(null);
    }
  };

  const visible = items.filter((p) => showInactive || p.is_active);
  const activeCount = items.filter((p) => p.is_active).length;

  return (
    <div className="bg-white p-6 rounded-lg shadow text-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold">İşlem Kataloğu</h2>
          <p className="text-sm text-gray-500">
            {activeCount} aktif işlem
            {items.length > activeCount && `, ${items.length - activeCount} pasif`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Pasif işlemleri göster
        </label>
      </div>

      {canEdit && (
        <form onSubmit={handleAdd} className="flex flex-wrap gap-2 mb-6">
          <input
            type="text"
            placeholder="Yeni işlem adı"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={`${inputClass} flex-1 min-w-[12rem]`}
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as Category)}
            className={inputClass}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Varsayılan Ücret (₺)"
            aria-label="Varsayılan Ücret"
            title="Varsayılan Ücret (isteğe bağlı)"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            className={`${inputClass} w-48`}
          />
          <button
            type="submit"
            disabled={adding || !newName.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {adding ? "Ekleniyor..." : "Ekle"}
          </button>
        </form>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-gray-500">Yükleniyor...</p>
      ) : visible.length === 0 ? (
        <p className="text-gray-500">İşlem bulunamadı.</p>
      ) : (
        <div className="space-y-6">
          {CATEGORIES.map((cat) => {
            const rows = visible.filter((p) => p.category === cat.value);
            if (rows.length === 0) return null;
            return (
              <div key={cat.value}>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {cat.label}
                </h3>
                <ul className="divide-y border rounded">
                  {rows.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                      {editingId === p.id ? (
                        <>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className={`${inputClass} flex-1 min-w-[12rem]`}
                          />
                          <select
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value as Category)}
                            className={inputClass}
                          >
                            {CATEGORIES.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Varsayılan Ücret (₺)"
                            aria-label="Varsayılan Ücret"
                            title="Varsayılan Ücret (isteğe bağlı)"
                            ref={editPriceRef}
                            value={editPrice}
                            onChange={(e) => setEditPrice(e.target.value)}
                            className={`${inputClass} w-48`}
                          />
                          <button
                            type="button"
                            onClick={() => saveEdit(p.id)}
                            disabled={busyId === p.id || !editName.trim()}
                            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
                          >
                            Kaydet
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                          >
                            İptal
                          </button>
                        </>
                      ) : (
                        <>
                          <span className={`flex-1 ${p.is_active ? "" : "text-gray-400 line-through"}`}>
                            {p.name}
                          </span>
                          <span
                            className={`text-sm ${p.default_price == null ? "text-gray-400" : "text-gray-700"}`}
                            title="Varsayılan Ücret"
                          >
                            {p.default_price == null
                              ? "Ücret girilmedi"
                              : `₺${Number(p.default_price).toLocaleString("tr-TR")}`}
                          </span>
                          {!p.is_active && (
                            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">Pasif</span>
                          )}
                          {canEdit && (
                            <>
                              <button
                                type="button"
                                onClick={() => startEdit(p)}
                                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                              >
                                Düzenle
                              </button>
                              <button
                                type="button"
                                onClick={() => update(p.id, { is_active: !p.is_active })}
                                disabled={busyId === p.id}
                                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                              >
                                {p.is_active ? "Pasif Yap" : "Aktif Yap"}
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
