"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuthStore } from "@/lib/store";
import {
  crmLeadDetail,
  crmLeadList,
  crmPlanCall,
  crmRescheduleCall,
  dayTimeLabel,
  hhmm,
  istanbulToday,
  newId,
  toCrmError,
  type CallJson,
  type CrmError,
  type LeadDetailJson,
  type LeadJson,
  type ResolveCallResult,
} from "@/lib/crm";
import { CLOSED_STAGES, CALL_DECISION_LABELS } from "@/lib/crm/codes";
import { CallResultForm } from "./CallResultForm";
import type { StaffOption } from "./useCrmRefs";
import {
  CrmErrorBox,
  CrmModal,
  Field,
  Loading,
  Notice,
  StageBadge,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "./ui";

/** One-line Turkish summary of a call resolution for the page message. */
export function resolveMessage(r: ResolveCallResult): string {
  const parts = [r.already_saved ? "Bu sonuç daha önce kaydedilmişti." : "Arama sonucu kaydedildi."];
  if (r.call.decision) parts.push(`Karar: ${CALL_DECISION_LABELS[r.call.decision]}.`);
  if (r.plan?.reason) parts.push(r.plan.reason);
  if (r.next_call) parts.push(`Sonraki arama: ${dayTimeLabel(r.next_call.date, r.next_call.time)}.`);
  if (r.appointment) parts.push("Klinik randevusu ajandaya eklendi.");
  if (r.patient_created) parts.push("Hasta kaydı oluşturuldu.");
  if (r.cancelled_call_ids?.length) parts.push(`${r.cancelled_call_ids.length} bekleyen arama iptal edildi.`);
  return parts.join(" ");
}

/**
 * Loads the lead card and opens the call result form for a planned call (callId), the earliest due call
 * (useDueCall, as the quick-call queue does) or an ad-hoc call (neither).
 */
export function CallResultDialog({
  leadId,
  callId,
  useDueCall,
  onClose,
  onSaved,
}: {
  leadId: string;
  callId?: string | null;
  useDueCall?: boolean;
  onClose: () => void;
  onSaved: (result: ResolveCallResult) => void;
}) {
  const [detail, setDetail] = useState<LeadDetailJson | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await crmLeadDetail({ p_lead_id: leadId }));
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  let call: CallJson | null = null;
  if (detail) {
    if (callId) call = detail.calls.find((c) => c.id === callId) ?? null;
    else if (useDueCall) call = detail.due_call;
  }
  const missingCall = !!detail && !!callId && !call;
  const concluded = !!call && call.status !== "planned";

  const close = () => {
    if (dirty && !confirm("Kaydedilmemiş görüşme notu var. Kaydetmeden kapatılsın mı?")) return;
    onClose();
  };

  return (
    <CrmModal
      title="Arama sonucu ve sonraki adım"
      description={detail ? `${detail.lead.full_name} · ${detail.lead.phone}` : undefined}
      onClose={close}
      wide
    >
      {!detail && !error && <Loading />}
      {!detail && <CrmErrorBox error={error} />}
      {detail && detail.lead.deleted_at && <Notice tone="warn">Hasta çöp kutusunda. Önce geri getirin.</Notice>}
      {detail && !detail.lead.deleted_at && missingCall && <Notice tone="warn">Arama kaydı bulunamadı.</Notice>}
      {detail && !detail.lead.deleted_at && concluded && (
        <Notice tone="info">Bu arama zaten sonuçlandırıldı. Yeni bir arama planlayın.</Notice>
      )}
      {detail && !detail.lead.deleted_at && !missingCall && !concluded && (
        <>
          {detail.last_notes.length > 0 && (
            <div className="mb-4 space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase">Son notlar</p>
              {detail.last_notes.map((n, i) => (
                <div key={i} className="p-2 rounded bg-gray-50 text-sm">
                  <p className="whitespace-pre-line">{n.text}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {n.actor_name ?? "Kullanıcı bilinmiyor"} · {new Date(n.at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}
                  </p>
                </div>
              ))}
            </div>
          )}
          <CallResultForm
            key={detail.lead.id + (call?.id ?? "")}
            lead={detail.lead}
            call={call}
            rules={detail.rules}
            onDirtyChange={setDirty}
            onReload={load}
            onCancel={close}
            onSaved={onSaved}
          />
        </>
      )}
    </CrmModal>
  );
}

type PlanLead = Pick<LeadJson, "id" | "full_name" | "stage" | "do_not_contact" | "followup_state" | "assigned_to">;

/** "Arama planla" (crm_plan_call, RR:121-129). Without a lead, a search box picks one. */
export function PlanCallDialog({
  lead: initialLead,
  staff,
  defaultDate,
  defaultTime,
  defaultCaller,
  onClose,
  onSaved,
}: {
  lead?: PlanLead | null;
  staff: StaffOption[];
  defaultDate?: string;
  defaultTime?: string;
  defaultCaller?: string | null;
  onClose: () => void;
  onSaved: (call: CallJson) => void;
}) {
  const me = useAuthStore((s) => s.user?.user_id ?? null);
  const today = istanbulToday();
  const [id] = useState(newId);
  const [lead, setLead] = useState<PlanLead | null>(initialLead ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeadJson[]>([]);
  const [form, setForm] = useState({
    date: defaultDate && defaultDate >= today ? defaultDate : today,
    time: hhmm(defaultTime) || "10:00",
    caller: defaultCaller ?? initialLead?.assigned_to ?? me ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);

  useEffect(() => {
    if (lead || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      crmLeadList({ p_filters: { q: query.trim(), include_closed: true }, p_page: { limit: 10 } })
        .then((r) => {
          if (!cancelled) setResults(r.rows);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, lead]);

  const pick = (l: LeadJson) => {
    setLead(l);
    setForm((f) => ({ ...f, caller: defaultCaller ?? l.assigned_to ?? f.caller }));
  };

  const hardBlock = lead
    ? lead.stage === "treatment_completed"
      ? "Tedavi tamamlanmış. Arama planlamak için önce hasta kartındaki aşamayı değiştirip yeniden açın."
      : lead.do_not_contact
        ? "Bu hasta telefonla aranmak istemiyor. Hasta kartındaki iletişim tercihini kontrol edin."
        : null
    : null;
  const softWarn =
    lead && !hardBlock && (CLOSED_STAGES.includes(lead.stage) || lead.followup_state === "done")
      ? "Hastanın takibi kapalı. Elle arama yine de planlanabilir; otomatik takip başlamaz."
      : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await crmPlanCall({
        p_id: id,
        p_lead_id: lead.id,
        p_caller_user_id: form.caller || null,
        p_date: form.date,
        p_time: form.time,
      });
      onSaved(r.call);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal title="Yeni arama planla" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {lead ? (
          <div className="flex items-center justify-between gap-2 p-2 rounded bg-gray-50">
            <span className="font-medium">
              {lead.full_name} <StageBadge stage={lead.stage} />
            </span>
            {!initialLead && (
              <button type="button" className="text-sm text-blue-700 underline" onClick={() => setLead(null)}>
                Değiştir
              </button>
            )}
          </div>
        ) : (
          <Field label="Hasta adayı">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ad, telefon veya kampanya ile ara"
              className={inputClass}
            />
            {results.length > 0 && (
              <ul className="mt-1 border rounded divide-y max-h-60 overflow-y-auto">
                {results.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => pick(l)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm"
                    >
                      <b>{l.full_name}</b> · {l.phone} <StageBadge stage={l.stage} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        {hardBlock && <Notice tone="danger">{hardBlock}</Notice>}
        {softWarn && <Notice tone="warn">{softWarn}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tarih">
            <input
              type="date"
              required
              min={today}
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Saat">
            <input
              type="time"
              required
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Arayacak kişi" className="col-span-2">
            <select
              required
              value={form.caller}
              onChange={(e) => setForm({ ...form, caller: e.target.value })}
              className={inputClass}
            >
              <option value="">Seç...</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" className={buttonPrimary} disabled={busy || !lead || !!hardBlock}>
            {busy ? "Kaydediliyor…" : "Aramayı planla"}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}

export interface ReschedulableCall {
  id: string;
  version: number;
  lead_name: string | null;
  date: string;
  time: string;
  caller_user_id: string | null;
  caller_name: string | null;
}

/** Move a planned call or change its caller (crm_reschedule_call). A date/time change needs a reason (RR:134). */
export function RescheduleCallDialog({
  call,
  staff,
  initial,
  onClose,
  onSaved,
}: {
  call: ReschedulableCall;
  staff: StaffOption[];
  /** Prefill from a drag on the agenda. */
  initial?: { date?: string; time?: string; caller_user_id?: string | null };
  onClose: () => void;
  onSaved: (call: CallJson) => void;
}) {
  const today = istanbulToday();
  const [form, setForm] = useState({
    date: initial?.date ?? call.date,
    time: hhmm(initial?.time ?? call.time),
    caller: initial?.caller_user_id ?? call.caller_user_id ?? "",
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const moved = form.date !== call.date || form.time !== hhmm(call.time);
  const callerKnown = !call.caller_user_id || staff.some((s) => s.id === call.caller_user_id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (moved && !form.reason.trim()) {
      setLocalError("Arama planını değiştirme nedenini yazın.");
      return;
    }
    if (moved && form.date < today) {
      setLocalError("Arama tarihi bugünden önce olamaz.");
      return;
    }
    setLocalError(null);
    setBusy(true);
    setError(null);
    try {
      const r = await crmRescheduleCall({
        p_call_id: call.id,
        p_version: call.version,
        p_date: form.date,
        p_time: form.time,
        p_caller_user_id: form.caller || null,
        p_reason: moved ? form.reason.trim() : null,
      });
      onSaved(r.call);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal
      title="Arama planını değiştir"
      description={`${call.lead_name ?? "Hasta"} · şu an ${dayTimeLabel(call.date, call.time)}`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tarih">
            <input
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Saat">
            <input
              type="time"
              required
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Arayacak kişi" className="col-span-2">
            <select
              value={form.caller}
              onChange={(e) => setForm({ ...form, caller: e.target.value })}
              className={inputClass}
            >
              {!callerKnown && call.caller_user_id && (
                <option value={call.caller_user_id}>{call.caller_name ?? "Mevcut arayan"}</option>
              )}
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={moved ? "Değişiklik nedeni *" : "Değişiklik nedeni"}
            className="col-span-2"
            hint="Tarih veya saat değişirse neden zorunludur. Yalnızca arayan kişi değişiyorsa gerekmez."
          >
            <textarea
              rows={2}
              maxLength={500}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className={inputClass}
            />
          </Field>
        </div>
        {localError && (
          <div className="p-3 rounded bg-red-50 text-red-700 text-sm" role="alert">
            {localError}
          </div>
        )}
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor…" : "Planı kaydet"}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}
