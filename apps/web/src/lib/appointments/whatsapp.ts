// Free appointment reminder through WhatsApp: the user's own WhatsApp opens with a ready message (wa.me link); the
// program sends nothing itself. The message carries no price and no treatment detail (KVKK: a phone screen may be seen
// by others). Pure helpers without a Supabase import, so they are unit-tested.

import { formatDay, istanbulDayOf } from "../clinical/dates";
import { formatClock, weekdayName } from "./agenda";

export interface ClinicContact {
  name: string | null;
  phone: string | null;
  address: string | null;
}

/**
 * Phone number for a wa.me link (digits only, with country code), or null when it is not usable.
 *  - Turkish national forms are completed to 90XXXXXXXXXX: "0532 123 45 67", "532 123 45 67", "+90 532 ...",
 *    "0090 532 ...". Only mobile numbers (905XXXXXXXXX) are usable; landlines have no WhatsApp in practice.
 *  - Other numbers are used only with an explicit international prefix ("+44 ...", "0044 ...") or when they cannot
 *    be Turkish national numbers (11-15 digits, no leading 0); 8-15 digits as in E.164.
 */
export function whatsappPhone(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const explicitInternational = /^(\+|00)/.test(text);
  let digits = text.replace(/\D/g, "");
  if (explicitInternational && digits.startsWith("00")) digits = digits.slice(2);

  if (!explicitInternational) {
    if (digits.length === 11 && digits.startsWith("0")) digits = "90" + digits.slice(1);
    else if (digits.length === 10) digits = "90" + digits;
  }

  if (digits.startsWith("90")) return /^905\d{9}$/.test(digits) ? digits : null;
  if (digits.startsWith("0")) return null;
  if (!explicitInternational && digits.length < 11) return null;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** First given name, capitalised the Turkish way when it was typed all upper or all lower case ("AYŞE" → "Ayşe"). */
export function firstName(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  const upper = first.toLocaleUpperCase("tr-TR");
  const lower = first.toLocaleLowerCase("tr-TR");
  if (first !== upper && first !== lower) return first;
  return lower.charAt(0).toLocaleUpperCase("tr-TR") + lower.slice(1);
}

function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s*[\r\n]+\s*/g, ", ").replace(/\s+/g, " ").trim();
}

/**
 * Reminder text: greeting with the first name, clinic, date with weekday, time, doctor, clinic address and phone.
 * Lines without a value are left out. Times are Istanbul wall clock.
 */
export function buildReminderMessage(input: {
  patientName: string | null | undefined;
  startTime: string;
  doctorName?: string | null;
  clinic?: ClinicContact | null;
}): string {
  const name = firstName(input.patientName);
  const day = istanbulDayOf(input.startTime);
  const clinicName = oneLine(input.clinic?.name);
  const doctor = oneLine(input.doctorName);
  const address = oneLine(input.clinic?.address);
  const phone = oneLine(input.clinic?.phone);

  const lines = [
    name ? `Merhaba ${name},` : "Merhaba,",
    clinicName ? `${clinicName} olarak randevunuzu hatırlatmak isteriz.` : "Randevunuzu hatırlatmak isteriz.",
    "",
    day ? `Tarih: ${formatDay(day)} ${weekdayName(day)}` : null,
    `Saat: ${formatClock(input.startTime)}`,
    doctor ? `Hekim: ${doctor}` : null,
    address ? `Adres: ${address}` : null,
    phone ? `Telefon: ${phone}` : null,
    "",
    "Randevunuza gelemeyecekseniz lütfen bize önceden haber verin. Sağlıklı günler dileriz.",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** https://wa.me/<number>?text=<message> */
export function whatsappUrl(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}
