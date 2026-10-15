"use client";

// Add / edit a staff member (spec p10_platform §5.2). Writes only through plt_staff_save; the flags of the list item
// (can_change_role_active, login.status) decide which fields are editable. The server is authoritative.

import { useMemo, useRef, useState } from "react";
import { ROLE_LABELS } from "@/lib/auth";
import {
  STAFF_ROLES,
  newStaffId,
  saveStaff,
  toStaffError,
  validateStaffForm,
  type Db,
  type StaffError,
  type StaffItem,
  type StaffSaveResult,
} from "@/lib/staff";
import { InlineMessage, Modal, pltInput, pltPrimary, pltSecondary } from "./Modal";

const SELF_TITLE = "Kendi rolünüzü veya durumunuzu değiştiremezsiniz.";

export function StaffDialog({
  db,
  item,
  canAssignOwner,
  onClose,
  onSaved,
  onReload,
}: {
  db: Db;
  /** null → create. */
  item: StaffItem | null;
  canAssignOwner: boolean;
  onClose: () => void;
  onSaved: (result: StaffSaveResult, created: boolean) => void;
  onReload: () => void;
}) {
  const isEdit = !!item;
  // Generated once per dialog and reused for every retry, so a retried create is idempotent.
  const [createId] = useState(() => newStaffId());
  const [form, setForm] = useState({
    full_name: item?.full_name ?? "",
    email: item?.email ?? "",
    phone: item?.phone ?? "",
    role: item?.role ?? "",
    specialty: item?.doctor?.specialty ?? "",
    is_active: item ? item.is_active : true,
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<{ text: string; err: StaffError | null } | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const roleLocked = isEdit && !item.can_change_role_active;
  const linkedEmail = isEdit && item.login.status !== "none";
  const financeEmail = isEdit && !linkedEmail && !!item.finance_locked;
  const emailLocked = linkedEmail || financeEmail;
  const showSpecialty = form.role === "doctor" || !!item?.doctor;

  const roleOptions = useMemo(
    () => STAFF_ROLES.filter((r) => r !== "owner" || canAssignOwner || item?.role === "owner"),
    [canAssignOwner, item?.role]
  );

  const set =
    (key: "full_name" | "email" | "phone" | "role" | "specialty") =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value;
      setForm((prev) => ({ ...prev, [key]: value }));
    };

  const submit = async (confirmed: boolean) => {
    if (busyRef.current) return;
    setError(null);
    const invalid = validateStaffForm(form, item ? { email: item.email, phone: item.phone } : undefined);
    if (invalid) {
      setError({ text: invalid, err: null });
      return;
    }
    if (isEdit && item.is_active && !form.is_active && !confirmed) {
      setConfirmDeactivate(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await saveStaff(db, {
        id: item?.id ?? createId,
        expectedUpdatedAt: item?.updated_at ?? null,
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        role: form.role,
        is_active: form.is_active,
        specialty: form.specialty.trim(),
      });
      onSaved(r, !isEdit);
    } catch (err) {
      const e = toStaffError(err);
      setError({ text: e.message, err: e });
      setConfirmDeactivate(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const showReload = error?.err?.key === "PLT_VERSION";

  return (
    <Modal
      title={isEdit ? "Personeli düzenle" : "Personel ekle"}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          {error && (
            <InlineMessage tone="error">
              <span>{error.text}</span>
              {showReload && (
                <button type="button" className="ml-3 underline font-medium" onClick={onReload}>
                  Listeyi yenile
                </button>
              )}
            </InlineMessage>
          )}
          {confirmDeactivate ? (
            <div className="space-y-2">
              <InlineMessage tone="warn">
                Pasif personel giriş yapamaz ve listelerde görünmez. Kayıtları ve geçmişi korunur. Devam edilsin mi?
              </InlineMessage>
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  type="button"
                  className={pltSecondary}
                  onClick={() => setConfirmDeactivate(false)}
                  disabled={busy}
                >
                  Vazgeç
                </button>
                <button type="button" className={pltPrimary} onClick={() => void submit(true)} disabled={busy}>
                  {busy ? "Kaydediliyor..." : "Evet, pasif yap ve kaydet"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button type="button" className={pltSecondary} onClick={onClose} disabled={busy}>
                Vazgeç
              </button>
              <button type="button" className={pltPrimary} onClick={() => void submit(false)} disabled={busy}>
                {busy ? "Kaydediliyor..." : "Kaydet"}
              </button>
            </div>
          )}
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800">
            Ad soyad<span className="text-red-600"> *</span>
          </span>
          <input
            className={pltInput}
            value={form.full_name}
            onChange={set("full_name")}
            maxLength={120}
            autoComplete="off"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800">
            E-posta<span className="text-red-600"> *</span>
          </span>
          <input
            type="email"
            className={pltInput}
            value={form.email}
            onChange={set("email")}
            disabled={emailLocked}
            maxLength={254}
            autoComplete="off"
          />
          <span className="block text-xs text-gray-500 mt-1">
            {linkedEmail
              ? "Giriş hesabı olan personelin e-postası değiştirilemez."
              : financeEmail
                ? "Finans yetkisi olan personelin e-postasını yalnızca klinik sahibi veya finans yetkilisi değiştirebilir."
                : isEdit
                ? "Davet bu adrese gönderilir."
                : "Personelin gerçek e-posta adresini girin; davet bu adrese gider. Adres yoksa geçici olarak ad.soyad@dentos.local yazabilirsiniz, davetten önce düzeltmeniz gerekir."}
          </span>
        </label>

        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800">Telefon</span>
          <input
            type="tel"
            className={pltInput}
            value={form.phone}
            onChange={set("phone")}
            maxLength={30}
            autoComplete="off"
          />
        </label>

        <label className="block" title={roleLocked ? SELF_TITLE : undefined}>
          <span className="block text-sm font-semibold mb-1 text-gray-800">
            Rol<span className="text-red-600"> *</span>
          </span>
          <select className={pltInput} value={form.role} onChange={set("role")} disabled={roleLocked}>
            {!form.role && <option value="">Seçin</option>}
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>
          {roleLocked && <span className="block text-xs text-gray-500 mt-1">{SELF_TITLE}</span>}
        </label>

        {showSpecialty && (
          <label className="block">
            <span className="block text-sm font-semibold mb-1 text-gray-800">Uzmanlık</span>
            <input
              className={pltInput}
              value={form.specialty}
              onChange={set("specialty")}
              maxLength={120}
              placeholder="Örn. Ortodonti"
            />
            {form.role !== "doctor" && item?.doctor && (
              <span className="block text-xs text-gray-500 mt-1">
                Hekim kaydı geçmiş için korunur; rol değişse de silinmez.
              </span>
            )}
          </label>
        )}

        {isEdit && (
          <div role="group" title={roleLocked ? SELF_TITLE : undefined}>
            <span className="block text-sm font-semibold mb-1 text-gray-800">Durum</span>
            <div className="flex gap-6">
              {[
                { v: true, label: "Aktif" },
                { v: false, label: "Pasif" },
              ].map((o) => (
                <label key={o.label} className="inline-flex items-center gap-2 min-h-[44px]">
                  <input
                    type="radio"
                    name="staff-active"
                    checked={form.is_active === o.v}
                    onChange={() => setForm((prev) => ({ ...prev, is_active: o.v }))}
                    disabled={roleLocked}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </div>
        )}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
