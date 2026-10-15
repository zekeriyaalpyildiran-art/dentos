"use client";

// Import wizard: the clinic workbook's 'GÜNCEL DÖVİZ' rates (spec p5 §7). They are saved as clinic fx_rates
// (source 'workbook') together with the import, or alone with "Yalnızca kurları kaydet". Saving the rates never
// touches the ledger rows, and a failure here never undoes the import.

import { Card, buttonSecondary } from "@/components/finance/ui";
import { formatDay } from "@/lib/finance";
import type { FxCode } from "@/lib/finance-import/layout";
import type { WorkbookFxRates } from "@/lib/finance-import/workbook";
import { formatRate, ppFxSaveRates } from "@/lib/payments";

export type PendingFxRate = { currency: FxCode; rate: string; on: string; file: string };

/** Adds a file's rates, keeping per currency the one with the latest day (an equal day: the later file wins). */
export function mergeFxRates(old: PendingFxRate[], add: WorkbookFxRates): PendingFxRate[] {
  const by = new Map(old.map((r) => [r.currency, r]));
  for (const item of add.items) {
    const prev = by.get(item.currency);
    if (!prev || prev.on <= add.on) by.set(item.currency, { currency: item.currency, rate: item.rate, on: add.on, file: add.file });
  }
  const order: FxCode[] = ["EUR", "USD", "GBP"];
  return order.map((c) => by.get(c)).filter((r): r is PendingFxRate => !!r);
}

/** Saves the pending rates as 'workbook' fx_rates; returns a Turkish status line (never throws). */
export async function saveWorkbookFxRates(rates: PendingFxRate[]): Promise<{ ok: boolean; text: string }> {
  if (!rates.length) return { ok: true, text: "" };
  try {
    const files = Array.from(new Set(rates.map((r) => r.file))).join(", ").slice(0, 200) || null;
    const res = await ppFxSaveRates(
      rates.map((r) => ({ currency: r.currency, rate: r.rate, rate_on: r.on })),
      "workbook",
      files
    );
    const count = (a: string) => res.saved.filter((s) => s.action === a).length;
    const parts = [
      count("inserted") ? `${count("inserted")} eklendi` : "",
      count("updated") ? `${count("updated")} güncellendi` : "",
      count("unchanged") ? `${count("unchanged")} değişmedi` : "",
    ].filter(Boolean);
    return { ok: true, text: `Döviz kurları kaydedildi (${parts.join(", ") || "değişiklik yok"}).` };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "Bilinmeyen hata";
    return { ok: false, text: `Döviz kurları kaydedilemedi: ${message}` };
  }
}

export function FxRatesCard({
  rates,
  disabled,
  saving,
  status,
  onSaveOnly,
}: {
  rates: PendingFxRate[];
  disabled?: boolean;
  saving?: boolean;
  status: { ok: boolean; text: string } | null;
  onSaveOnly: () => void;
}) {
  if (!rates.length) return null;
  const days = Array.from(new Set(rates.map((r) => r.on)));
  return (
    <Card
      title="Dosyadaki döviz kurları"
      actions={
        <button type="button" className={buttonSecondary} disabled={disabled || saving} onClick={onSaveOnly}>
          {saving ? "Kaydediliyor…" : "Yalnızca kurları kaydet"}
        </button>
      }
    >
      <p className="text-sm text-gray-900">
        {rates.map((r) => `${r.currency} ${formatRate(r.rate)}`).join(" · ")}
        {" — "}
        {days.length === 1
          ? `${formatDay(days[0])} (dosya)`
          : rates.map((r) => `${r.currency}: ${formatDay(r.on)}`).join(", ") + " (dosya)"}
      </p>
      <p className="text-xs text-gray-600 mt-1">
        İçe aktarma kaydedilirken hasta ödemelerinde önerilecek kur olarak da kaydedilir. Ödemelere önceden yazılmış
        kurlar değişmez.
      </p>
      <p className="text-xs text-gray-600 mt-1">
        Kurlar ayın son işlem gününe yazılır. &apos;GÜNCEL DÖVİZ&apos; sayfası dosyanın son kaydedildiği günün kurunu
        tutar; geçmiş bir ayın dosyasında tarih ve kuru kontrol edin. Aynı gün için Finans ayarları &gt; Döviz
        kurları ekranında elle girilen kur önceliklidir.
      </p>
      {status?.text && (
        <p className={`text-sm mt-2 ${status.ok ? "text-green-700" : "text-red-700"}`}>{status.text}</p>
      )}
    </Card>
  );
}
