"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";

interface Chair {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number | null;
}

const inputClass =
  "px-3 py-2 border border-gray-300 rounded text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500";

interface Props {
  clinicId: string;
  canEdit: boolean;
}

export function ChairManager({ clinicId, canEdit }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [chairs, setChairs] = useState<Chair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("chairs")
      .select("id, name, is_active, sort_order")
      .eq("clinic_id", clinicId)
      .order("sort_order")
      .order("name");

    if (loadError) {
      console.error("Error loading chairs:", loadError);
      setError("Koltuklar yüklenemedi. Lütfen sayfayı yenileyin.");
    } else {
      setChairs((data ?? []) as Chair[]);
    }
    setLoading(false);
  }, [supabase, clinicId]);

  useEffect(() => {
    load();
  }, [load]);

  const describeError = (code?: string) =>
    code === "23505" ? "Bu isimde bir koltuk zaten var." : "Koltuk kaydedilemedi. Lütfen tekrar deneyin.";

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;

    setAdding(true);
    setError(null);
    const nextOrder = chairs.reduce((max, c) => Math.max(max, c.sort_order ?? 0), 0) + 1;
    const { error: insertError } = await supabase
      .from("chairs")
      .insert({ clinic_id: clinicId, name, sort_order: nextOrder, is_active: true });

    if (insertError) {
      setError(describeError(insertError.code));
    } else {
      setNewName("");
      await load();
    }
    setAdding(false);
  };

  // RLS silently skips rows the user may not update, so an empty result means the change was refused.
  const update = async (id: string, values: Partial<Chair>) => {
    setBusyId(id);
    setError(null);
    const { data, error: updateError } = await supabase
      .from("chairs")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .select("id");

    let ok = false;
    if (updateError) {
      setError(describeError(updateError.code));
    } else if (!data || data.length === 0) {
      setError("Bu koltuğu değiştirme yetkiniz yok.");
    } else {
      ok = true;
      await load();
    }
    setBusyId(null);
    return ok;
  };

  const saveEdit = async (id: string) => {
    const name = editName.trim();
    if (!name) return;
    if (await update(id, { name })) setEditingId(null);
  };

  const activeCount = chairs.filter((c) => c.is_active).length;

  return (
    <div className="bg-white p-6 rounded-lg shadow text-gray-900">
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Koltuklar</h2>
        <p className="text-sm text-gray-500">
          {activeCount} aktif koltuk
          {chairs.length > activeCount && `, ${chairs.length - activeCount} pasif`}
        </p>
      </div>

      {canEdit && (
        <form onSubmit={handleAdd} className="flex flex-wrap gap-2 mb-6">
          <input
            type="text"
            placeholder="Yeni koltuk adı"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={`${inputClass} flex-1 min-w-[10rem]`}
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
      ) : chairs.length === 0 ? (
        <p className="text-gray-500">Koltuk bulunamadı.</p>
      ) : (
        <ul className="divide-y border rounded">
          {chairs.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
              {editingId === c.id ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className={`${inputClass} flex-1 min-w-[10rem]`}
                  />
                  <button
                    type="button"
                    onClick={() => saveEdit(c.id)}
                    disabled={busyId === c.id || !editName.trim()}
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
                  <span className={`flex-1 ${c.is_active ? "" : "text-gray-400 line-through"}`}>{c.name}</span>
                  {!c.is_active && (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">Pasif</span>
                  )}
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(c.id);
                          setEditName(c.name);
                        }}
                        className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                      >
                        Düzenle
                      </button>
                      <button
                        type="button"
                        onClick={() => update(c.id, { is_active: !c.is_active })}
                        disabled={busyId === c.id}
                        className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                      >
                        {c.is_active ? "Pasif Yap" : "Aktif Yap"}
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
