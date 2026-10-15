"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  crmDaySummary,
  dayTimeLabel,
  formatClock,
  longDayLabel,
  toCrmError,
  type CrmError,
  type DaySummaryJson,
} from "@/lib/crm";
import { CALL_STATUS_LABELS, REMINDER_OUTCOME_LABELS, type CallResultStatus } from "@/lib/crm/codes";
import { CrmErrorBox, EmptyState, Loading, buttonSecondary, inputClass } from "./ui";

type Panel = "resolved" | "unreachable" | "pending" | "changes" | "reminders";

/** "Gün sonu özeti" (DW:26-38, TW:11-31): always the clinic's today; updates as results are saved. */
export function DaySummary({ onShowWorkList }: { onShowWorkList: () => void }) {
  const [data, setData] = useState<DaySummaryJson | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [panel, setPanel] = useState<Panel>("resolved");
  const [status, setStatus] = useState<CallResultStatus | "all">("all");

  const load = useCallback(async () => {
    try {
      setData(await crmDaySummary());
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return error ? <CrmErrorBox error={error} /> : <Loading />;

  const c = data.counts;
  const cards: { id: Panel; label: string; value: number; unit: string }[] = [
    { id: "resolved", label: "Sonucu kaydedilen", value: c.resolved, unit: "arama" },
    { id: "unreachable", label: "Ulaşılamayan", value: c.unreachable_patients, unit: "hasta" },
    { id: "pending", label: "Bekleyen", value: c.pending, unit: "iş" },
    { id: "changes", label: "Planı değiştirilen", value: c.changes, unit: "işlem" },
  ];
  const calls = data.resolved.filter((r) => status === "all" || r.status === status);

  return (
    <section className="bg-white rounded-lg shadow p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Gün sonu özeti</h2>
          <p className="text-sm text-gray-600">{longDayLabel(data.day)} · Gün içinde kaydettikçe güncellenir</p>
        </div>
        <button type="button" className={buttonSecondary} onClick={load}>
          Yenile
        </button>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4" role="group" aria-label="Günlük özet listeleri">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            aria-pressed={panel === card.id}
            onClick={() => (card.id === "pending" ? onShowWorkList() : setPanel(card.id))}
            className={`text-left p-4 rounded-lg border ${
              panel === card.id ? "border-blue-600 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
            }`}
          >
            <span className="block text-sm text-gray-600">{card.label}</span>
            <strong className="text-2xl">
              {card.value} <small className="text-sm font-normal text-gray-500">{card.unit}</small>
            </strong>
            <span className="block text-xs text-blue-700 mt-1">
              {card.id === "pending" ? "İş listesini aç" : "İsim listesini aç"}
            </span>
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-700">
        {c.reached} görüşüldü · {c.unreachable} aramada ulaşılamadı · {c.cancelled} iptal. Sonuçlar İstanbul saatine göre
        kaydedildikleri gün sayılır. Bekleyen işler şu anki durumu gösterir.
      </p>
      <button
        type="button"
        className="text-sm text-blue-700 underline"
        aria-pressed={panel === "reminders"}
        onClick={() => setPanel("reminders")}
      >
        Randevu hatırlatmaları: {c.reminders} kayıt
      </button>

      <div className="border-t pt-4" aria-live="polite">
        {panel === "resolved" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="font-semibold">Sonucu kaydedilen aramalar</h3>
              <select
                aria-label="Özette arama sonucu"
                value={status}
                onChange={(e) => setStatus(e.target.value as CallResultStatus | "all")}
                className={`${inputClass} w-48`}
              >
                <option value="all">Tüm sonuçlar</option>
                <option value="reached">Görüşüldü</option>
                <option value="unreachable">Ulaşılamadı</option>
                <option value="cancelled">İptal</option>
              </select>
            </div>
            {calls.length ? (
              <ul className="divide-y">
                {calls.map((r) => (
                  <li key={r.call_id} className="py-2 text-sm">
                    <Link href={`/crm/leads/${r.lead_id}`} className="font-medium text-blue-700 hover:underline">
                      {r.lead_name}
                    </Link>
                    <p>
                      {CALL_STATUS_LABELS[r.status]} · {formatClock(r.resolved_at)} ·{" "}
                      {r.resolved_by_name ?? "Kullanıcı bilinmiyor"}
                    </p>
                    <p className="text-xs text-gray-500">Planlanan: {dayTimeLabel(r.scheduled_date, r.scheduled_time)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>Bugün bu filtrede kaydedilmiş arama sonucu yok.</EmptyState>
            )}
          </>
        )}
        {panel === "unreachable" && (
          <>
            <h3 className="font-semibold mb-2">Ulaşılamayan hastalar</h3>
            {data.unreachable_patients.length ? (
              <ul className="divide-y">
                {data.unreachable_patients.map((p) => (
                  <li key={p.lead_id} className="py-2 text-sm">
                    <Link href={`/crm/leads/${p.lead_id}`} className="font-medium text-blue-700 hover:underline">
                      {p.full_name}
                    </Link>
                    <p>
                      {p.attempts} aramada ulaşılamadı · {p.phone}
                    </p>
                    <p className="text-xs text-gray-500">
                      Aynı hastanın sonraki görüşmeleri arama sonuçları listesinde görünür.
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>Bugün ulaşılamadı sonucu kaydedilen hasta yok.</EmptyState>
            )}
          </>
        )}
        {panel === "changes" && (
          <>
            <h3 className="font-semibold mb-2">Plan değişiklikleri</h3>
            {data.changes.length ? (
              <ul className="divide-y">
                {data.changes.map((ch) => (
                  <li key={ch.activity_id} className="py-2 text-sm">
                    <Link href={`/crm/leads/${ch.lead_id}`} className="font-medium text-blue-700 hover:underline">
                      {ch.lead_name}
                    </Link>
                    <p>
                      {ch.type === "call" ? "Arama" : "Hasta takibi"}: {dayTimeLabel(ch.from_date, ch.from_time)} →{" "}
                      {dayTimeLabel(ch.to_date, ch.to_time)}
                    </p>
                    <p>
                      <b>Neden:</b> {ch.reason}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatClock(ch.at)} · {ch.actor_name ?? "Kullanıcı bilinmiyor"}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>Bugün kayıtlı tarih değişikliği yok.</EmptyState>
            )}
          </>
        )}
        {panel === "reminders" && (
          <>
            <h3 className="font-semibold mb-2">Klinik randevusu hatırlatmaları</h3>
            {data.reminders.length ? (
              <ul className="divide-y">
                {data.reminders.map((r) => (
                  <li key={r.log_id} className="py-2 text-sm">
                    <Link href={`/patients/${r.patient_id}`} className="font-medium text-blue-700 hover:underline">
                      {r.patient_name}
                    </Link>
                    <p>
                      {REMINDER_OUTCOME_LABELS[r.outcome]} · {formatClock(r.at)} · {r.actor_name ?? "Kullanıcı bilinmiyor"}
                    </p>
                    <p className="text-xs text-gray-600">{r.note}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>Bugün kaydedilen randevu hatırlatması yok.</EmptyState>
            )}
          </>
        )}
      </div>

      <p className="text-xs text-gray-500">
        {c.legacy_undated > 0
          ? `${c.legacy_undated} eski aramada sonuç zamanı bulunmuyor; günlük sayılara dahil edilmez. `
          : ""}
        {c.auto_cancelled > 0
          ? `Sistemin otomatik iptal ettiği ${c.auto_cancelled} arama sonuç sayılarına dahil edilmez. `
          : ""}
        Hasta kartına yazılan serbest notlar arama sayılmaz. Çöp kutusundaki hastalar bu özete dahil değildir. Plan
        değişiklikleri ve randevu hatırlatmaları arama sayısına eklenmez; ayrı listelerde görünür.
        {data.truncated ? " Listeler en fazla 500 kayıt gösterir." : ""}
      </p>
    </section>
  );
}
