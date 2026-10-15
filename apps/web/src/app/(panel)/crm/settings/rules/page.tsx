"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Card,
  CrmErrorBox,
  CrmShell,
  Field,
  Loading,
  Notice,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  useCanManageCrm,
} from "@/components/crm/ui";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import {
  DEFAULT_RULES,
  crmSaveFollowupRules,
  hhmm,
  toCrmError,
  type CrmError,
  type RulesJson,
  type RulesValues,
} from "@/lib/crm";
import { WEEKDAYS } from "@/lib/crm/codes";

type NumberKey =
  | "retry_days"
  | "interested_days"
  | "price_days"
  | "timing_days"
  | "later_days"
  | "max_unreachable"
  | "first_call_minutes"
  | "stale_days"
  | "offer_days";

/** FS:11 labels and the §2.6 ranges. */
const NUMBERS: { key: NumberKey; label: string; min: number; max: number }[] = [
  { key: "retry_days", label: "Ulaşılamadı · kaç gün sonra?", min: 1, max: 30 },
  { key: "interested_days", label: "Randevu / tedavi istiyor · gün", min: 1, max: 30 },
  { key: "price_days", label: "Fiyatı değerlendiriyor · gün", min: 1, max: 90 },
  { key: "timing_days", label: "Zamanlamayı değerlendiriyor · gün", min: 1, max: 90 },
  { key: "later_days", label: "Daha sonra düşünecek · gün", min: 1, max: 90 },
  { key: "max_unreachable", label: "Art arda ulaşılamayan arama sınırı", min: 1, max: 10 },
  { key: "first_call_minutes", label: "İlk arama hedefi · çalışma dakikası", min: 15, max: 1440 },
  { key: "stale_days", label: "Aynı aşamada bekleme · iş günü", min: 1, max: 90 },
  { key: "offer_days", label: "Teklif yanıtı bekleme · iş günü", min: 1, max: 90 },
];

const TIMES: { key: "start_time" | "end_time" | "call_time"; label: string }[] = [
  { key: "start_time", label: "Arama mesaisi başlangıcı" },
  { key: "end_time", label: "Arama mesaisi bitişi" },
  { key: "call_time", label: "Otomatik arama saati" },
];

interface Draft extends Omit<RulesValues, NumberKey> {
  numbers: Record<NumberKey, string>;
}

function toDraft(r: RulesJson): Draft {
  return {
    enabled: r.enabled,
    work_days: [...r.work_days],
    start_time: hhmm(r.start_time),
    end_time: hhmm(r.end_time),
    call_time: hhmm(r.call_time),
    numbers: Object.fromEntries(NUMBERS.map((n) => [n.key, String(r[n.key])])) as Record<NumberKey, string>,
  };
}

/** Rows from the table carry 'HH:MM:SS' times and no daily_minutes. */
function rowToRules(row: Record<string, unknown>): RulesJson {
  const start = hhmm(String(row.start_time ?? DEFAULT_RULES.start_time));
  const end = hhmm(String(row.end_time ?? DEFAULT_RULES.end_time));
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const rules = { ...DEFAULT_RULES } as RulesJson;
  for (const key of Object.keys(DEFAULT_RULES) as (keyof RulesJson)[]) {
    if (row[key] !== undefined && row[key] !== null) (rules as unknown as Record<string, unknown>)[key] = row[key];
  }
  rules.start_time = start;
  rules.end_time = end;
  rules.call_time = hhmm(String(row.call_time ?? DEFAULT_RULES.call_time));
  rules.work_days = Array.isArray(row.work_days) ? (row.work_days as number[]).map(Number) : DEFAULT_RULES.work_days;
  rules.daily_minutes = minutes(end) - minutes(start);
  return rules;
}

/**
 * Follow-up rules (FS, FRR). Every staff member sees them; only a CRM manager (crm_manage or owner) saves.
 * Changes apply to results saved afterwards; existing calls never move.
 */
export default function FollowupRulesPage() {
  const clinicId = useAuthStore((s) => s.user?.clinic_id);
  const canManage = useCanManageCrm();
  const [rules, setRules] = useState<RulesJson | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clinicId) return;
    const { data, error: err } = await createClient()
      .from("crm_followup_rules")
      .select("*")
      .eq("clinic_id", clinicId)
      .maybeSingle();
    if (err) {
      console.error("Error fetching follow-up rules:", err);
      setLoadError("Takip kuralları yüklenemedi.");
      return;
    }
    // No row yet: the legacy defaults with version 0 (FRR:15).
    const r = data ? rowToRules(data as Record<string, unknown>) : DEFAULT_RULES;
    setRules(r);
    setDraft(toDraft(r));
    setLoadError(null);
  }, [clinicId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!draft || !rules) {
    return (
      <CrmShell title="Takip kuralları">{loadError ? <Notice tone="danger">{loadError}</Notice> : <Loading />}</CrmShell>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const validate = (): { ok: true; values: RulesValues } | { ok: false; error: string } => {
    const days = [...new Set(draft.work_days)].sort((a, b) => a - b);
    if (days.length === 0) return { ok: false, error: "En az bir çalışma günü seçin." };
    if (!(draft.start_time < draft.end_time && draft.call_time >= draft.start_time && draft.call_time < draft.end_time)) {
      return { ok: false, error: "Arama saati çalışma başlangıcı ile bitişi arasında olmalı." };
    }
    const numbers = {} as Record<NumberKey, number>;
    for (const n of NUMBERS) {
      const v = Number(draft.numbers[n.key]);
      if (!Number.isInteger(v) || v < n.min || v > n.max) {
        return { ok: false, error: `${n.label} ${n.min}–${n.max} arasında olmalı.` };
      }
      numbers[n.key] = v;
    }
    return {
      ok: true,
      values: {
        enabled: draft.enabled,
        work_days: days,
        start_time: draft.start_time,
        end_time: draft.end_time,
        call_time: draft.call_time,
        ...numbers,
      },
    };
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !canManage) return;
    const v = validate();
    if (!v.ok) {
      setLocalError(v.error);
      return;
    }
    setLocalError(null);
    setError(null);
    setBusy(true);
    try {
      const r = await crmSaveFollowupRules({ p_version: rules.version, p_rules: v.values });
      setRules(r.rules);
      setDraft(toDraft(r.rules));
      setMessage("Takip kuralları kaydedildi. Değişiklikler bundan sonraki sonuç kayıtlarında uygulanır.");
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmShell
      title="Takip kuralları"
      subtitle="Görüşme sonuçlarından sonra oluşturulacak aramaları ve yönetici uyarılarını belirle."
    >
      <form onSubmit={save} className="max-w-3xl space-y-4">
        {!canManage && (
          <Notice tone="info">Takip kurallarını yalnızca CRM yöneticisi değiştirebilir. Kuralları görüntülüyorsunuz.</Notice>
        )}
        {rules.version === 0 && (
          <Notice tone="info">Bu klinik için henüz kural kaydedilmedi; varsayılan değerler kullanılıyor.</Notice>
        )}
        <SuccessBox text={message} />
        <Card>
          <fieldset disabled={!canManage || busy} className="space-y-5">
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Sonuca göre otomatik arama planla
            </label>
            <p className="text-sm text-gray-600">
              Değişiklikler sonraki sonuç kayıtlarında uygulanır. Mevcut aramaların tarihleri değişmez. Kapatmak yeni
              otomatik planları durdurur.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              {NUMBERS.map((n) => (
                <Field key={n.key} label={n.label} hint={`${n.min}–${n.max}`}>
                  <input
                    type="number"
                    required
                    min={n.min}
                    max={n.max}
                    value={draft.numbers[n.key]}
                    onChange={(e) => set({ numbers: { ...draft.numbers, [n.key]: e.target.value } })}
                    className={inputClass}
                  />
                </Field>
              ))}
            </div>
            <div>
              <span className="block text-sm font-semibold mb-1 text-gray-800">Arama günleri</span>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((day, i) => (
                  <label key={day} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.work_days.includes(i)}
                      onChange={(e) =>
                        set({
                          work_days: e.target.checked
                            ? [...draft.work_days.filter((d) => d !== i), i]
                            : draft.work_days.filter((d) => d !== i),
                        })
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {TIMES.map((t) => (
                <Field key={t.key} label={t.label}>
                  <input
                    type="time"
                    required
                    value={draft[t.key]}
                    onChange={(e) => set({ [t.key]: e.target.value } as Partial<Draft>)}
                    className={inputClass}
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-gray-600">
              Tüm saatler İstanbul saatidir. Takip süresi takvim günü olarak eklenir; kapalı güne denk gelirse ilk açık
              güne alınır. Hastanın istediği özel tarih ve mevcut arama planı önceliklidir. Arama sınırına gelince yeni
              plan yerine takip kararı uyarısı oluşur.
            </p>
          </fieldset>
        </Card>
        {localError && (
          <div className="p-3 rounded bg-red-50 text-red-700 text-sm" role="alert">
            {localError}
          </div>
        )}
        <CrmErrorBox error={error} onReload={load} />
        {canManage && (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={buttonSecondary}
              disabled={busy}
              onClick={() => {
                setDraft(toDraft(rules));
                setLocalError(null);
              }}
            >
              Vazgeç
            </button>
            <button type="submit" className={buttonPrimary} disabled={busy}>
              {busy ? "Kaydediliyor…" : "Kuralları kaydet"}
            </button>
          </div>
        )}
      </form>
    </CrmShell>
  );
}
