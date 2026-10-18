"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import { ROLE_LABELS, getMyPermissions } from "@/lib/auth";
import { useAuthStore } from "@/lib/store";
import {
  FINANCE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  isPermission,
  permissionGrantLock,
  type Permission,
} from "@/lib/permissions";

interface StaffRow {
  id: string;
  full_name: string;
  role: string;
}

interface Props {
  clinicId: string;
  /** The signed-in user holds 'finance'; only then are the finance toggles offered. */
  canManageFinance: boolean;
}

const keyOf = (userId: string, permission: Permission) => `${userId}:${permission}`;

export function PermissionManager({ clinicId, canManageFinance }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const currentUserId = useAuthStore((state) => state.user?.user_id);
  const myRole = useAuthStore((state) => state.user?.role);
  const setPermissions = useAuthStore((state) => state.setPermissions);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const columns = useMemo(
    () => PERMISSIONS.filter((p) => canManageFinance || !FINANCE_PERMISSIONS.includes(p)),
    [canManageFinance]
  );

  // Returns the active grants that were loaded, or null when loading failed.
  const load = useCallback(async (): Promise<Set<string> | null> => {
    const [staffRes, grantsRes] = await Promise.all([
      supabase
        .from("users")
        .select("id, full_name, role")
        .eq("clinic_id", clinicId)
        .eq("is_active", true)
        .order("full_name", { ascending: true }),
      supabase
        .from("staff_permissions")
        .select("user_id, permission")
        .eq("clinic_id", clinicId)
        .is("revoked_at", null),
    ]);

    if (staffRes.error || grantsRes.error) {
      console.error("Error loading permissions:", staffRes.error || grantsRes.error);
      setLoadFailed(true);
      setLoading(false);
      return null;
    }

    const next = new Set<string>();
    for (const row of grantsRes.data ?? []) {
      if (isPermission(row.permission)) next.add(keyOf(row.user_id, row.permission));
    }

    setStaff((staffRes.data ?? []) as StaffRow[]);
    setGranted(next);
    setLoadFailed(false);
    setLoading(false);
    return next;
  }, [supabase, clinicId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (member: StaffRow, permission: Permission) => {
    const key = keyOf(member.id, permission);
    const grant = !granted.has(key);

    setBusyKey(key);
    setError(null);

    const { error: rpcError } = await supabase.rpc(
      grant ? "grant_staff_permission" : "revoke_staff_permission",
      { p_user_id: member.id, p_permission: permission }
    );

    if (rpcError) {
      // The functions raise Turkish messages meant for the user.
      console.error("Error changing permission:", rpcError);
      setError(rpcError.message || "Yetki değiştirilemedi. Lütfen tekrar deneyin.");
    }

    const after = await load();
    if (!rpcError && after && after.has(key) !== grant) {
      setError("Yetki değişikliği kaydedilemedi. Lütfen tekrar deneyin.");
    }

    // Changing your own grants changes what the rest of the panel shows you.
    if (!rpcError && member.id === currentUserId) {
      setPermissions(await getMyPermissions());
    }

    setBusyKey(null);
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow text-gray-900">
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Yetkiler</h2>
        <p className="text-sm text-gray-600 mt-1">
          Yetkiler rolden bağımsızdır ve kişiye tek tek verilir. Finans yetkileri yalnızca Finans
          yetkisi olan biri tarafından verilebilir veya geri alınabilir; kliniğin son Finans
          yetkilisinin yetkisi geri alınamaz. Stok yönetim yetkisini yalnızca klinik sahibi, stok
          maliyet yetkisini klinik sahibi veya Finans yetkilisi verebilir.
        </p>
        <p className="text-sm text-gray-600 mt-2">
          Hakediş ve maaş hazırlama yetkisini yalnızca klinik sahibi verebilir veya kaldırabilir. Bu
          yetkiyle kişi “Hakediş ve maaş” bölümünde tahsilat satırlarını, implant ve lab kayıtlarını,
          hasta işaretlerini ve aylık primleri girer; herkesin aylık hesabını, maaşlarını ve kuralları
          görür. Kural ve maaş tutarlarını değiştiremez, ayı kapatamaz ve Finans&apos;ı (ödemeler,
          ödenen / kalan tutarlar) göremez.
        </p>
        <p className="text-sm text-gray-600 mt-2">
          Şu an Finans yetkisi raporlardaki tahsilat tutarını, ödeme kayıtlarını düzeltmeyi ve
          geçmiş tarihli ödeme girmeyi kapsar. Tedavi planlarındaki ve hasta kartındaki ödeme
          bilgileri ise tüm personele açıktır.
        </p>
        {!canManageFinance && (
          <p className="text-sm text-gray-500 mt-2">
            Finans yetkilerini yönetmek için Finans yetkiniz olmalıdır.
          </p>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-gray-500">Yükleniyor...</p>
      ) : loadFailed ? (
        <p className="text-red-600">Yetkiler yüklenemedi. Lütfen sayfayı yenileyin.</p>
      ) : staff.length === 0 ? (
        <p className="text-gray-500">Aktif personel bulunamadı.</p>
      ) : (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-gray-800">Personel</th>
                {columns.map((p) => (
                  <th
                    key={p}
                    className="px-3 py-3 text-center font-semibold text-gray-800 min-w-[6.5rem]"
                  >
                    {PERMISSION_LABELS[p]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => (
                <tr key={member.id} className="border-b last:border-b-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-gray-800">
                      {member.full_name}
                      {member.id === currentUserId && (
                        <span className="ml-2 text-xs font-normal text-gray-500">(siz)</span>
                      )}
                    </div>
                    <div className="text-gray-500">{ROLE_LABELS[member.role] || member.role}</div>
                  </td>
                  {columns.map((p) => {
                    const key = keyOf(member.id, p);
                    // The database lets only an owner take a permission away from an owner.
                    const ownerLocked =
                      member.role === "owner" && myRole !== "owner" && granted.has(key);
                    // Who may grant what (grant_staff_permission): stock_manage and hakedis_prepare only the
                    // owner (0024, 0031), stock_cost_view the owner or a finance holder, finance keys a finance
                    // holder (those columns are hidden otherwise).
                    const grantLock = permissionGrantLock(p, { role: myRole, holdsFinance: canManageFinance });
                    const locked = ownerLocked || !!grantLock;
                    return (
                      <td key={p} className="px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={granted.has(key)}
                          disabled={busyKey !== null || locked}
                          onChange={() => toggle(member, p)}
                          title={
                            ownerLocked
                              ? "Klinik sahibinin yetkilerini yalnızca klinik sahibi kaldırabilir."
                              : grantLock ?? undefined
                          }
                          aria-label={`${member.full_name}: ${PERMISSION_LABELS[p]}`}
                          className={`h-4 w-4 accent-blue-600 ${
                            locked ? "cursor-not-allowed" : "cursor-pointer disabled:cursor-wait"
                          }`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
