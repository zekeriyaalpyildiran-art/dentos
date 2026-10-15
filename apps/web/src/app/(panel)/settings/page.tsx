"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { ProcedureCatalog } from "@/components/ProcedureCatalog";
import { ChairManager } from "@/components/ChairManager";
import { PermissionManager } from "@/components/PermissionManager";
import { ROLE_LABELS } from "@/lib/auth";
import { PERMISSION_LABELS, hasPermission, isPermission } from "@/lib/permissions";

interface Clinic {
  name: string;
  phone: string | null;
  address: string | null;
  plan: string | null;
}

interface Message {
  type: "success" | "error";
  text: string;
}

const PLAN_LABELS: Record<string, string> = {
  trial: "Deneme",
  starter: "Başlangıç",
  pro: "Pro",
};

function labelOf(map: Record<string, string>, key?: string | null) {
  return key ? map[key] ?? key : "-";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-3 border-b last:border-b-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 text-right">{value}</dd>
    </div>
  );
}

export default function Page() {
  const { user } = useAuthStore();
  const supabase = useMemo(() => createClient(), []);
  const canEdit = user?.role === "owner" || user?.role === "admin";
  const myPermissionLabels = (user?.permissions ?? [])
    .map((p) => (isPermission(p) ? PERMISSION_LABELS[p] : p))
    .join(", ");

  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", address: "" });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const fetchClinic = useCallback(async () => {
    if (!user?.clinic_id) {
      setLoading(false);
      return;
    }

    setFailed(false);
    try {
      const { data, error } = await supabase
        .from("clinics")
        .select("name, phone, address, plan")
        .eq("id", user.clinic_id)
        .maybeSingle();

      if (error) throw error;
      setClinic(data);
      setForm({
        name: data?.name ?? "",
        phone: data?.phone ?? "",
        address: data?.address ?? "",
      });
    } catch (err) {
      console.error("Error fetching clinic:", err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [supabase, user?.clinic_id]);

  useEffect(() => {
    fetchClinic();
  }, [fetchClinic]);

  const setField = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.clinic_id) return;

    setSaving(true);
    setMessage(null);
    try {
      const { data, error } = await supabase
        .from("clinics")
        .update({
          name: form.name,
          phone: form.phone || null,
          address: form.address || null,
        })
        .eq("id", user.clinic_id)
        .select("id");

      if (error) throw error;
      // RLS skips rows the user may not update, so an empty result means the change was refused.
      if (!data || data.length === 0) {
        setMessage({ type: "error", text: "Klinik bilgilerini değiştirme yetkiniz yok." });
        return;
      }
      setMessage({ type: "success", text: "Klinik bilgileri güncellendi." });
      await fetchClinic();
    } catch (err) {
      console.error("Error updating clinic:", err);
      setMessage({ type: "error", text: "Klinik bilgileri güncellenirken hata oluştu." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Ayarlar</h1>

      <div className="grid gap-6 md:grid-cols-2 items-start">
        <div>
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Klinik Bilgileri</h2>
            {loading ? (
              <p className="text-gray-500">Yükleniyor...</p>
            ) : failed ? (
              <p className="text-red-600">
                Klinik bilgileri yüklenemedi. Lütfen sayfayı yenileyin.
              </p>
            ) : canEdit ? (
              <form onSubmit={handleSave} className="text-gray-900">
                <div className="mb-4">
                  <label className="block text-sm font-semibold mb-2">Klinik Adı</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={setField("name")}
                    className="w-full px-4 py-2 border rounded"
                    required
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-sm font-semibold mb-2">Telefon</label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={setField("phone")}
                    className="w-full px-4 py-2 border rounded"
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-sm font-semibold mb-2">Adres</label>
                  <textarea
                    rows={3}
                    value={form.address}
                    onChange={setField("address")}
                    className="w-full px-4 py-2 border rounded"
                  />
                </div>
                <div className="mb-6">
                  <p className="text-sm font-semibold mb-2">Plan</p>
                  <p className="text-gray-600">{labelOf(PLAN_LABELS, clinic?.plan)}</p>
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
                >
                  {saving ? "Kaydediliyor..." : "Kaydet"}
                </button>
              </form>
            ) : (
              <dl>
                <Row label="Klinik Adı" value={clinic?.name || "-"} />
                <Row label="Telefon" value={clinic?.phone || "-"} />
                <Row label="Adres" value={clinic?.address || "-"} />
                <Row label="Plan" value={labelOf(PLAN_LABELS, clinic?.plan)} />
              </dl>
            )}
            {message && (
              <p
                className={`mt-4 text-sm ${
                  message.type === "success" ? "text-green-600" : "text-red-600"
                }`}
              >
                {message.text}
              </p>
            )}
          </div>
          {!canEdit && (
            <p className="mt-3 text-sm text-gray-600">
              Klinik bilgilerinde değişiklik yapmak için bir yöneticiyle iletişime geçin.
            </p>
          )}
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Hesabım</h2>
          <dl>
            <Row label="E-posta" value={user?.email || "-"} />
            <Row label="Rol" value={labelOf(ROLE_LABELS, user?.role)} />
            <Row label="Yetkiler" value={myPermissionLabels || "-"} />
          </dl>
        </div>
      </div>

      {user?.clinic_id && (
        <div className="mt-6 space-y-6">
          {canEdit && (
            <section id="yetkiler" className="scroll-mt-4">
              <PermissionManager
                clinicId={user.clinic_id}
                canManageFinance={hasPermission(user, "finance")}
              />
            </section>
          )}
          {canEdit && (
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold text-gray-900 mb-2">Değişiklik geçmişi</h2>
              <p className="text-gray-600 mb-4">
                Personel, yetki, ödeme, finans, stok, CRM ve klinik kayıtlarındaki değişiklikleri görüntüleyin.
              </p>
              <Link
                href="/settings/audit"
                className="inline-block px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Geçmişi aç
              </Link>
            </div>
          )}
          <ChairManager clinicId={user.clinic_id} canEdit={canEdit} />
          <ProcedureCatalog clinicId={user.clinic_id} canEdit={canEdit} />
          {user.role === "owner" && (
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold text-gray-900 mb-2">Veri yedeği</h2>
              <p className="text-gray-600 mb-4">
                Kliniğin tüm kayıtlarını tek bir JSON dosyası olarak indirin. Finans tabloları yalnızca finans
                yetkiniz varsa dahil edilir.
              </p>
              <Link
                href="/settings/export"
                className="inline-block px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Yedek sayfasını aç
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
