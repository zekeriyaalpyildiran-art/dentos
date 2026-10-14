"use client";

import { formatTL } from "@/lib/finance";

/** Column labels for finance audit rows (p2 §2.5: changes holds the moved columns with their new values). */
const FIELD_LABELS: Record<string, string> = {
  name: "Ad",
  kind: "Tür",
  bank_name: "Banka adı",
  is_active: "Aktif",
  sort_order: "Sıra",
  report_bucket: "Rapor türü",
  report_group_id: "Rapor grubu",
  doctor_id: "Hekim",
  note: "Not",
  category_id: "Kategori",
  subcategory: "Alt tür",
  counterparty_id: "Kişi / kurum",
  counterparty_text: "Kişi / kurum (metin)",
  description: "Açıklama",
  due_date: "Vade / tarih",
  amount_cents: "Tutar",
  entitlement_month: "Hakediş ayı",
  cancelled_at: "İptal zamanı",
  cancel_reason: "İptal gerekçesi",
  excluded_from_totals: "Toplam dışı",
  exclusion_reason: "Toplam dışı gerekçesi",
  paid_on: "Ödeme tarihi",
  account_id: "Hesap",
  voided_at: "Ödeme iptal zamanı",
  void_reason: "Ödeme iptal gerekçesi",
  buffer_target_cents: "Tampon hedefi",
  forecast_days: "Plan süresi (gün)",
  physician_fee_note: "Hekim hakedişi notu",
  report_brand_name: "Rapor marka adı",
  entitlement_account_id: "Hakediş hesabı",
  bank_cents: "Banka",
  cash_cents: "Nakit",
  bank_as_of: "Banka tarihi",
  cash_as_of: "Nakit tarihi",
  day: "Gün",
  label: "Etiket",
  as_of: "Tarih",
  replaced_at: "Değiştirilme zamanı",
};

/** Bookkeeping columns that move on every write; they add noise to the history. */
const HIDDEN = new Set(["version", "updated_at", "updated_by", "updated_by_name", "created_at", "created_by", "clinic_id", "id"]);

function show(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Evet" : "Hayır";
  if (typeof value === "number" && key.endsWith("_cents")) return formatTL(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function AuditChanges({
  action,
  changes,
  before,
  after,
}: {
  action: string;
  changes: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  if (action === "create") {
    const row = after ?? {};
    const keys = Object.keys(row).filter((k) => !HIDDEN.has(k) && row[k] !== null && row[k] !== "" && FIELD_LABELS[k]);
    if (keys.length === 0) return null;
    return (
      <ul className="text-xs text-gray-600 space-y-0.5">
        {keys.map((k) => (
          <li key={k}>
            {FIELD_LABELS[k]}: {show(k, row[k])}
          </li>
        ))}
      </ul>
    );
  }

  const keys = Object.keys(changes ?? {}).filter((k) => !HIDDEN.has(k));
  if (keys.length === 0) return null;
  return (
    <ul className="text-xs text-gray-600 space-y-0.5">
      {keys.map((k) => (
        <li key={k}>
          {FIELD_LABELS[k] ?? k}: {show(k, before?.[k])} → {show(k, (changes ?? {})[k])}
        </li>
      ))}
    </ul>
  );
}
