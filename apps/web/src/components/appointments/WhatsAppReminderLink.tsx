"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";
import {
  buildReminderMessage,
  whatsappPhone,
  whatsappUrl,
  type ClinicContact,
} from "@/lib/appointments/whatsapp";

/** Note prefilled in the reminder outcome dialog after the WhatsApp link was used. */
export const WHATSAPP_REMINDER_NOTE = "WhatsApp'tan hatırlatma mesajı gönderildi.";

/**
 * The signed-in clinic's name, phone and address for the reminder text. Load it once per page and pass it to every
 * link. undefined while loading, null when it could not be read (the text then simply leaves those lines out).
 */
export function useClinicContact(): ClinicContact | null | undefined {
  const clinicId = useAuthStore((s) => s.user?.clinic_id);
  const [contact, setContact] = useState<ClinicContact | null | undefined>(undefined);

  useEffect(() => {
    if (!clinicId) return;
    let cancelled = false;
    createClient()
      .from("clinics")
      .select("name,phone,address")
      .eq("id", clinicId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error("Error loading clinic contact:", error);
        setContact(data ? { name: data.name ?? null, phone: data.phone ?? null, address: data.address ?? null } : null);
      });
    return () => {
      cancelled = true;
    };
  }, [clinicId]);

  return contact;
}

/**
 * Free reminder: opens the user's own WhatsApp (wa.me, new tab) with a ready Turkish message to the patient. Nothing
 * is sent by the program. Renders nothing when the patient has no usable mobile number or the clinic is still loading.
 * onOpen lets the page ask for the reminder outcome (crm_set_reminder_outcome) right after.
 */
export function WhatsAppReminderLink({
  patientName,
  phone,
  startTime,
  doctorName,
  clinic,
  onOpen,
  className,
}: {
  patientName: string | null | undefined;
  phone: string | null | undefined;
  startTime: string;
  doctorName?: string | null;
  clinic: ClinicContact | null | undefined;
  onOpen?: () => void;
  className?: string;
}) {
  const number = whatsappPhone(phone);
  if (!number || clinic === undefined) return null;
  const href = whatsappUrl(number, buildReminderMessage({ patientName, startTime, doctorName, clinic }));
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => onOpen?.()}
      className={className ?? "text-green-700 hover:underline whitespace-nowrap"}
      title="WhatsApp'ta hazır hatırlatma mesajı açılır; gönderme düğmesine siz basarsınız."
    >
      {"WhatsApp'tan hatırlat"}
    </a>
  );
}
