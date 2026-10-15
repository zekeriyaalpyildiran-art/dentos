"use client";

// Confirmation before an invitation e-mail is sent (spec p10_platform §4.1). Sending happens in the Edge Function.

import { useRef, useState } from "react";
import { inviteStaff, type Db, type InviteAction, type StaffItem } from "@/lib/staff";
import { InlineMessage, Modal, pltPrimary, pltSecondary } from "./Modal";

export function InviteDialog({
  db,
  item,
  action,
  onClose,
  onDone,
}: {
  db: Db;
  item: StaffItem;
  action: InviteAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await inviteStaff(db, item.id, action);
      if (r.ok) {
        onDone(action === "invite" ? "Davet e-postası gönderildi." : "Şifre belirleme bağlantısı yeniden gönderildi.");
      } else {
        setError(r.message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title={action === "invite" ? "Davet gönder" : "Daveti yeniden gönder"}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={pltSecondary} onClick={onClose} disabled={busy}>
              Vazgeç
            </button>
            <button type="button" className={pltPrimary} onClick={() => void send()} disabled={busy}>
              {busy ? "Gönderiliyor..." : "Gönder"}
            </button>
          </div>
        </div>
      }
    >
      {action === "invite" ? (
        <p className="text-gray-800">
          <strong>{item.full_name}</strong> adlı personele <strong>{item.email}</strong> adresine davet e-postası
          gönderilecek. Personel e-postadaki bağlantıyla şifresini belirleyip giriş yapabilir. Gönderilsin mi?
        </p>
      ) : (
        <p className="text-gray-800">
          <strong>{item.full_name}</strong> adlı personele <strong>{item.email}</strong> adresine yeni bir şifre
          belirleme bağlantısı gönderilsin mi?
        </p>
      )}
      <p className="text-sm text-gray-500">
        Bağlantı tek kullanımlıktır. E-posta gelmezse gereksiz (spam) klasörünü kontrol etmesini isteyin.
      </p>
    </Modal>
  );
}
