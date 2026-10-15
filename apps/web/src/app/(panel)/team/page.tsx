"use client";

// Ekip (spec p10_platform §5.1). Owner/admin manage staff through plt_staff_list / plt_staff_save and send
// invitations through the `invite-staff` Edge Function; everyone else sees the read-only staff list.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import { ROLE_LABELS } from "@/lib/auth";
import {
  isStaffModuleMissing,
  listStaff,
  loginStatusLabel,
  toStaffError,
  type InviteAction,
  type StaffError,
  type StaffItem,
  type StaffListResponse,
  type StaffSaveResult,
  type StatusTone,
} from "@/lib/staff";
import { StaffDialog } from "@/components/staff/StaffDialog";
import { InviteDialog } from "@/components/staff/InviteDialog";
import { InlineMessage } from "@/components/staff/Modal";

interface StaffMember {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean | null;
}

interface Message {
  type: "success" | "error";
  text: string;
}

const thClass = "px-4 py-3 text-left text-sm font-semibold text-gray-800 whitespace-nowrap";
const tdClass = "px-4 py-3 text-sm align-top";

const TONE_CLASS: Record<StatusTone, string> = {
  gray: "text-gray-600",
  amber: "text-amber-700",
  green: "text-green-700",
  red: "text-red-700",
};

function ActiveBadge({ active }: { active: boolean | null }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${
        active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"
      }`}
    >
      {active ? "Aktif" : "Pasif"}
    </span>
  );
}

function ReadOnlyTeam({ clinicId }: { clinicId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: err } = await supabase
          .from("users")
          .select("id, full_name, email, role, is_active")
          .eq("clinic_id", clinicId)
          .order("full_name", { ascending: true });
        if (err) throw err;
        if (!cancelled) setStaff(data || []);
      } catch (err) {
        console.error("Error fetching team:", err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, clinicId]);

  if (loading) return <p className="text-gray-500">Yükleniyor...</p>;
  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-red-600">
        Ekip bilgileri yüklenemedi. Lütfen sayfayı yenileyin.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-100 border-b">
          <tr>
            <th className={thClass}>Ad Soyad</th>
            <th className={thClass}>E-posta</th>
            <th className={thClass}>Rol</th>
            <th className={thClass}>Durum</th>
          </tr>
        </thead>
        <tbody>
          {staff.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                Personel bulunamadı
              </td>
            </tr>
          ) : (
            staff.map((m) => (
              <tr key={m.id} className="border-b hover:bg-gray-50">
                <td className={`${tdClass} text-gray-800 font-semibold`}>{m.full_name}</td>
                <td className={`${tdClass} text-gray-600`}>{m.email}</td>
                <td className={`${tdClass} text-gray-600`}>{ROLE_LABELS[m.role] || m.role}</td>
                <td className={tdClass}>
                  <ActiveBadge active={m.is_active} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function InviteButtons({
  item,
  onInvite,
}: {
  item: StaffItem;
  onInvite: (item: StaffItem, action: InviteAction) => void;
}) {
  if (item.is_me || !item.can_edit) return null;
  if (item.can_resend) {
    return (
      <button type="button" className="text-blue-700 hover:underline" onClick={() => onInvite(item, "resend")}>
        Daveti yeniden gönder
      </button>
    );
  }
  if (item.login.status !== "none") return null;
  const reason = item.can_invite
    ? undefined
    : item.email_placeholder
      ? "Önce gerçek e-posta adresini girin."
      : !item.is_active
        ? "Pasif personele davet gönderilemez. Önce personeli aktif yapın."
        : item.finance_locked
          ? "Finans yetkisi olan personele yalnızca klinik sahibi veya finans yetkilisi davet gönderebilir."
          : "Önce geçerli bir e-posta adresi girin.";
  return (
    <button
      type="button"
      className="text-blue-700 hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
      onClick={() => onInvite(item, "invite")}
      disabled={!item.can_invite}
      title={reason}
    >
      Davet gönder
    </button>
  );
}

function ManageTeam() {
  const db = useMemo(() => createClient(), []);
  const [data, setData] = useState<StaffListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<StaffError | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<{ item: StaffItem | null } | null>(null);
  const [inviting, setInviting] = useState<{ item: StaffItem; action: InviteAction } | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await listStaff(db);
      setData(r);
      setNow(new Date());
    } catch (err) {
      console.error("Error fetching staff:", err);
      setLoadError(toStaffError(err));
    } finally {
      setLoading(false);
    }
  }, [db]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = (r: StaffSaveResult, created: boolean) => {
    setEditing(null);
    setMessage({
      type: "success",
      text: created
        ? r.already_saved
          ? "Personel zaten kayıtlıydı."
          : "Personel eklendi. Giriş yapabilmesi için “Davet gönder” ile davet gönderin."
        : r.changed
          ? "Personel bilgileri güncellendi."
          : "Değişiklik yoktu.",
    });
    void load();
  };

  if (loading) return <p className="text-gray-500">Yükleniyor...</p>;

  if (loadError && !data) {
    if (isStaffModuleMissing(loadError)) {
      return (
        <div className="space-y-4">
          <InlineMessage tone="warn">{loadError.message}</InlineMessage>
          <ReadOnlyTeamFallback />
        </div>
      );
    }
    return (
      <div className="bg-white rounded-lg shadow p-6 text-red-600">
        {loadError.message || "Ekip bilgileri yüklenemedi. Lütfen sayfayı yenileyin."}
      </div>
    );
  }

  const staff = data?.staff ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="text-sm text-gray-600 max-w-3xl">
          Yeni personel önce burada eklenir; giriş yapabilmesi için “Davet gönder” ile e-posta daveti gönderin.
          Yetkiler rolden bağımsızdır:{" "}
          <Link href="/settings#yetkiler" className="text-blue-700 hover:underline">
            Ayarlar › Yetkiler
          </Link>
          .
        </p>
        <button
          type="button"
          className="px-4 py-2 min-h-[44px] bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={() => {
            setMessage(null);
            setEditing({ item: null });
          }}
        >
          + Personel ekle
        </button>
      </div>

      {message && (
        <InlineMessage tone={message.type} onClose={() => setMessage(null)}>
          {message.text}
        </InlineMessage>
      )}
      {loadError && <InlineMessage tone="error">{loadError.message}</InlineMessage>}

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className={thClass}>Ad Soyad</th>
              <th className={thClass}>E-posta</th>
              <th className={thClass}>Telefon</th>
              <th className={thClass}>Rol</th>
              <th className={thClass}>Durum</th>
              <th className={thClass}>Giriş hesabı</th>
              <th className={thClass}>İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  Personel bulunamadı
                </td>
              </tr>
            ) : (
              staff.map((s) => {
                const login = loginStatusLabel(s.login, now);
                return (
                  <tr key={s.id} className={`border-b hover:bg-gray-50 ${s.is_active ? "" : "text-gray-500"}`}>
                    <td className={`${tdClass} text-gray-800`}>
                      <span className="font-semibold">{s.full_name}</span>
                      {s.is_me && <span className="text-gray-500"> (siz)</span>}
                      {s.email_placeholder && (
                        <span
                          className="ml-2 px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700 whitespace-nowrap"
                          title="Davet göndermeden önce gerçek e-posta adresini girin."
                        >
                          Geçici e-posta
                        </span>
                      )}
                    </td>
                    <td className={`${tdClass} text-gray-600 break-all`}>{s.email}</td>
                    <td className={`${tdClass} text-gray-600 whitespace-nowrap`}>{s.phone || "—"}</td>
                    <td className={`${tdClass} text-gray-700`}>
                      {ROLE_LABELS[s.role] || s.role}
                      {s.role === "doctor" &&
                        (s.doctor ? (
                          s.doctor.specialty && (
                            <span className="block text-xs text-gray-500">{s.doctor.specialty}</span>
                          )
                        ) : (
                          <span className="block text-xs text-amber-700">
                            Hekim kaydı eksik — kaydedince oluşturulur
                          </span>
                        ))}
                    </td>
                    <td className={tdClass}>
                      <ActiveBadge active={s.is_active} />
                    </td>
                    <td
                      className={`${tdClass} ${TONE_CLASS[login.tone]}`}
                      title={
                        s.login.status === "active"
                          ? "Bağlantı açıldığında hesap aktif görünür. Şifresini belirlemediyse veya unuttuysa giriş sayfasındaki “Şifremi unuttum” bağlantısını kullanabilir."
                          : undefined
                      }
                    >
                      {login.text}
                      {login.hint && <span className="block text-xs text-amber-700">{login.hint}</span>}
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-col items-start gap-1">
                        {s.can_edit && (
                          <button
                            type="button"
                            className="text-blue-700 hover:underline"
                            onClick={() => {
                              setMessage(null);
                              setEditing({ item: s });
                            }}
                          >
                            Düzenle
                          </button>
                        )}
                        <InviteButtons
                          item={s}
                          onInvite={(item, action) => {
                            setMessage(null);
                            setInviting({ item, action });
                          }}
                        />
                        <Link
                          href={`/settings/audit?entity_type=users&entity_id=${s.id}`}
                          className="text-gray-600 hover:underline"
                        >
                          Geçmiş
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <StaffDialog
          db={db}
          item={editing.item}
          canAssignOwner={!!data?.can_assign_owner}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
          onReload={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {inviting && (
        <InviteDialog
          db={db}
          item={inviting.item}
          action={inviting.action}
          onClose={() => setInviting(null)}
          onDone={(text) => {
            setInviting(null);
            setMessage({ type: "success", text });
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Read-only list while migration 0027 is not applied yet. */
function ReadOnlyTeamFallback() {
  const clinicId = useAuthStore((s) => s.user?.clinic_id);
  return clinicId ? <ReadOnlyTeam clinicId={clinicId} /> : null;
}

export default function Page() {
  const { user } = useAuthStore();
  const canManage = user?.role === "owner" || user?.role === "admin";

  return (
    <div className="p-4 sm:p-8">
      <h1 className="text-3xl font-bold mb-6">Ekip</h1>
      {!user?.clinic_id ? (
        <p className="text-gray-500">Yükleniyor...</p>
      ) : canManage ? (
        <ManageTeam />
      ) : (
        <ReadOnlyTeam clinicId={user.clinic_id} />
      )}
    </div>
  );
}
