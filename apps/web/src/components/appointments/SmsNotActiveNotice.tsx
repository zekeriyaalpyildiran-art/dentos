"use client";

import Link from "next/link";
import { useCanOpenPath } from "@/components/useCanOpenPath";

/**
 * Honest notice for the Hatırlatmalar / Mesajlar screens: the clinic has no SMS sending, so nothing listed there was
 * or will be sent automatically. Reminders are done by phone from CRM "Bugün" or with the agenda's WhatsApp link.
 */
export function SmsNotActiveNotice({ className = "" }: { className?: string }) {
  // CRM is closed to some roles (assistants, lib/nav.ts); they are pointed at the agenda's WhatsApp link only.
  const canOpenCrmToday = useCanOpenPath("/crm/today");
  return (
    <div
      role="note"
      className={`rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${className}`}
    >
      <p className="font-semibold">Otomatik SMS gönderimi etkin değil.</p>
      <p className="mt-1">
        Program hastalara kendiliğinden SMS veya mesaj göndermez; bu listedeki kayıtlar yalnızca geçmiş bilgisidir.
        Randevu hatırlatmasını{" "}
        {canOpenCrmToday && (
          <>
            <Link href="/crm/today" className="font-medium text-blue-700 underline">
              CRM &gt; Bugün
            </Link>{" "}
            listesinden hastayı arayarak ya da{" "}
          </>
        )}
        <Link href="/appointments" className="font-medium text-blue-700 underline">
          Randevular
        </Link>{" "}
        sayfasındaki {"“WhatsApp'tan hatırlat”"} bağlantısıyla yapın ve sonucu kaydedin.
      </p>
    </div>
  );
}
