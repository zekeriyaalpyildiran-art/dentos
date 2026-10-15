"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  crmPhoneMatches,
  crmResolveCall,
  dayTimeLabel,
  hhmm,
  istanbulIso,
  istanbulNowTime,
  istanbulToday,
  newId,
  toCrmError,
  type AppointmentInput,
  type CallJson,
  type CrmError,
  type LeadJson,
  type PhoneMatchesJson,
  type ResolveCallResult,
  type RulesJson,
} from "@/lib/crm";
import {
  CALL_DECISIONS,
  CONTACT_RESULTS,
  LOSS_REASONS,
  type CallDecision,
  type CallResultStatus,
  type ContactResult,
  type LossReason,
} from "@/lib/crm/codes";
import { useClinicResources } from "./useCrmRefs";
import { CrmErrorBox, Field, Notice, buttonPrimary, buttonSecondary, inputClass } from "./ui";

const RESULT_OPTIONS: { value: CallResultStatus; label: string }[] = [
  { value: "reached", label: "Görüşüldü" },
  { value: "unreachable", label: "Ulaşılamadı" },
  { value: "cancelled", label: "İptal" },
];

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** True for the decisions offered with this status (CRF:12). */
function decisionAllowed(
  decision: CallDecision,
  status: CallResultStatus,
  rules: RulesJson,
  doNotContact: boolean
): boolean {
  // RR:129: a do-not-contact lead only accepts the "stop" decision.
  if (doNotContact) return decision === "stop";
  if (decision === "auto") return rules.enabled && status !== "cancelled";
  if (decision === "clinic") return status === "reached";
  return true;
}

function defaultDecision(status: CallResultStatus, rules: RulesJson, doNotContact: boolean): CallDecision | "" {
  if (doNotContact) return "stop";
  if (status !== "cancelled" && rules.enabled) return "auto";
  return status === "cancelled" ? "" : "followup";
}

/**
 * "Arama sonucu ve sonraki adım" (CRF, QC). One crm_resolve_call saves the call outcome, the lead state, the next
 * call, the clinic appointment and the cancellations atomically. The note and the decision are mandatory.
 * The ids (request, next call, appointment, new patient, ad-hoc call) are created once per form, so a retry
 * after a network error cannot create a second row.
 */
export function CallResultForm({
  lead,
  call,
  rules,
  onSaved,
  onCancel,
  onReload,
  onDirtyChange,
  submitLabel,
  extraButtons,
}: {
  lead: LeadJson;
  /** The planned call being resolved; null logs an ad-hoc call at "now" (QC:22-23). */
  call: CallJson | null;
  rules: RulesJson;
  onSaved: (result: ResolveCallResult) => void;
  onCancel?: () => void;
  onReload?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  submitLabel?: string;
  extraButtons?: ReactNode;
}) {
  const [ids] = useState(() => ({
    request: newId(),
    nextCall: newId(),
    appointment: newId(),
    newPatient: newId(),
    adHocCall: newId(),
  }));
  const today = istanbulToday();
  const [status, setStatus] = useState<CallResultStatus>("reached");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<CallDecision | "">(() =>
    defaultDecision("reached", rules, lead.do_not_contact)
  );
  const [contactResult, setContactResult] = useState<ContactResult>("unspecified");
  const [followup, setFollowup] = useState({ date: "", time: hhmm(rules.call_time) || "10:00", action: "" });
  const [lossReason, setLossReason] = useState<LossReason | "">("");
  const [appt, setAppt] = useState({
    doctor_id: "",
    chair_id: "",
    procedure_id: "",
    date: "",
    start: "",
    end: "",
    notes: "",
    patientChoice: "new" as string, // "new" or an existing patient id
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [matches, setMatches] = useState<PhoneMatchesJson | null>(null);

  const resources = useClinicResources(decision === "clinic");
  const blocked = lead.stage === "treatment_completed";

  useEffect(() => {
    onDirtyChange?.(note.trim().length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  // Patients sharing the lead's number, so the clinic decision can link an existing patient instead of creating one.
  useEffect(() => {
    if (decision !== "clinic" || lead.patient_id || matches) return;
    let cancelled = false;
    crmPhoneMatches({ p_phone: lead.phone, p_exclude_lead_id: lead.id })
      .then((m) => {
        if (!cancelled) setMatches(m);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [decision, lead.patient_id, lead.phone, lead.id, matches]);

  const decisions = useMemo(
    () => CALL_DECISIONS.filter((d) => decisionAllowed(d.value, status, rules, lead.do_not_contact)),
    [status, rules, lead.do_not_contact]
  );

  const changeStatus = (next: CallResultStatus) => {
    setStatus(next);
    setContactResult("unspecified");
    setDecision((d) =>
      d && decisionAllowed(d, next, rules, lead.do_not_contact) ? d : defaultDecision(next, rules, lead.do_not_contact)
    );
  };

  const changeContactResult = (value: ContactResult) => {
    setContactResult(value);
    // CRF:14: a requested date is never guessed; switch to "Yeni arama planla".
    if (value === "call_on_date" && decision === "auto") {
      setDecision("followup");
      setFollowup((f) => ({ ...f, action: f.action || "Hastanın istediği tarihte ara" }));
    }
  };

  const validate = (): string | null => {
    if (!note.trim()) return "Görüşme notunu yazın.";
    if (!decision) return "Görüşme sonrası kararı seçin.";
    // 'auto' with no usable result is decided by the server (E_AUTO_RESULT): legacy automaticPlan (FU:33-40) first
    // stops, keeps an existing planned call or keeps a future follow-up date, and only then needs a result.
    if (decision === "followup") {
      if (!followup.date) return "Geçerli takip tarihi seçin.";
      if (!followup.time) return "Takip saatini seçin.";
      if (!followup.action.trim()) return "Sonraki adımı yazın.";
      if (`${followup.date} ${followup.time}` <= `${today} ${istanbulNowTime()}`) {
        return "Sonraki arama için gelecekte bir tarih ve saat seçin.";
      }
    }
    if (decision === "clinic") {
      if (!appt.doctor_id || !appt.chair_id || !appt.date || !appt.start || !appt.end) {
        return "Klinik randevusu için tarih, saat, hekim ve koltuk girin.";
      }
      if (appt.end <= appt.start) return "Bitiş saati başlangıç saatinden sonra olmalı.";
      if (`${appt.date} ${appt.start}` <= `${today} ${istanbulNowTime()}`) {
        return "Klinik randevusu için Görüşüldü sonucunu ve gelecekte bir tarih/saat seçin.";
      }
    }
    if (decision === "lost" && !lossReason) return "Olumsuz sonuç nedenini seçin.";
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !decision) {
      if (!decision) setLocalError("Görüşme sonrası kararı seçin.");
      return;
    }
    const problem = validate();
    setLocalError(problem);
    setError(null);
    if (problem) return;

    let appointment: AppointmentInput | null = null;
    if (decision === "clinic") {
      appointment = {
        id: ids.appointment,
        doctor_id: appt.doctor_id,
        chair_id: appt.chair_id,
        procedure_id: appt.procedure_id || null,
        start_time: istanbulIso(appt.date, appt.start),
        end_time: istanbulIso(appt.date, appt.end),
        notes: appt.notes.trim() || null,
      };
      if (!lead.patient_id) {
        if (appt.patientChoice !== "new") {
          appointment.patient_id = appt.patientChoice;
        } else {
          appointment.new_patient_id = ids.newPatient;
          appointment.patient = { full_name: lead.full_name, phone: lead.phone, email: lead.email };
        }
      }
    }

    setBusy(true);
    try {
      const result = await crmResolveCall({
        p_call_id: call?.id ?? ids.adHocCall,
        p_call_version: call ? call.version : null,
        p_lead_id: lead.id,
        p_lead_version: lead.version,
        p_request_id: ids.request,
        p_status: status,
        p_note: note.trim(),
        p_decision: decision,
        // NULL keeps the lead's stored result (the server forces 'unreachable' itself). An unchosen result is sent
        // only for 'auto', whose plan must use exactly what was recorded for this call (legacy FU:42-51).
        p_contact_result:
          status === "reached" && (contactResult !== "unspecified" || decision === "auto") ? contactResult : null,
        p_next_call_id: decision === "auto" || decision === "followup" ? ids.nextCall : null,
        p_followup:
          decision === "followup"
            ? { date: followup.date, time: followup.time, action: followup.action.trim() }
            : null,
        p_loss_reason: decision === "lost" && lossReason ? lossReason : null,
        p_appointment: appointment,
      });
      onDirtyChange?.(false);
      onSaved(result);
    } catch (err) {
      // The typed note stays in the form (legacy QC: "notun bu ekranda korunuyor").
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  if (blocked) {
    return (
      <Notice tone="warn">
        Tedavi tamamlanmış. Arama planlamak için önce hasta kartındaki aşamayı değiştirip yeniden açın.
      </Notice>
    );
  }

  const patientMatches = matches?.patients ?? [];

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        <p className="text-sm text-gray-600">
          {call
            ? `Planlanan arama: ${dayTimeLabel(call.date, call.time)}${call.caller_name ? ` · ${call.caller_name}` : ""}`
            : "Bu görüşme yeni bir arama sonucu olarak kaydedilecek."}
        </p>
        {lead.do_not_contact && (
          <Notice tone="danger">
            Bu hasta telefonla aranmak istemiyor. Yalnızca “Telefonla aranmak istemiyor” kararı kaydedilebilir.
          </Notice>
        )}

        <Field label="Arama sonucu">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Arama sonucu">
            {RESULT_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={status === o.value}
                onClick={() => changeStatus(o.value)}
                className={`px-3 py-1.5 rounded border text-sm ${
                  status === o.value ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 hover:bg-gray-50"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Görüşme notu / açıklama *">
          <textarea
            required
            rows={4}
            maxLength={10000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={inputClass}
            placeholder="Ne konuşuldu? Ulaşılamadıysa arama denemesini kısaca belirt."
          />
        </Field>

        {status === "reached" && (
          <Field label="Hasta ne söyledi?">
            <select
              value={contactResult}
              onChange={(e) => changeContactResult(e.target.value as ContactResult)}
              className={inputClass}
            >
              {CONTACT_RESULTS.filter((r) => r.value !== "unreachable").map((r) => (
                <option key={r.value} value={r.value}>
                  {r.value === "unspecified" ? "Görüşme sonucunu seç" : r.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Görüşme sonrası karar *">
          <select
            required
            value={decision}
            onChange={(e) => setDecision(e.target.value as CallDecision | "")}
            className={inputClass}
          >
            <option value="">Sonraki adımı seç</option>
            {decisions.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>

        {decision === "auto" && (
          <div className="p-3 rounded bg-gray-50 border text-sm">
            <b>Sonraki aramayı program planlayacak</b>
            <p className="mt-1">
              {status === "unreachable"
                ? `${rules.retry_days} gün sonra, çalışma gününde saat ${hhmm(rules.call_time)}. Art arda ${rules.max_unreachable} başarısız aramada yeni plan yerine karar uyarısı oluşur.`
                : "Sonuç için yöneticinin belirlediği süre ve çalışma günleri uygulanır."}
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Mevcut arama veya hasta kartındaki ileri takip tarihi korunur. Hastanın özel tarih isteği varsa “Yeni
              arama planla”yı seç.
            </p>
          </div>
        )}

        {decision === "followup" && (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Sonraki arama tarihi *">
              <input
                type="date"
                min={today}
                value={followup.date}
                onChange={(e) => setFollowup({ ...followup, date: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Arama saati *">
              <input
                type="time"
                value={followup.time}
                onChange={(e) => setFollowup({ ...followup, time: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Sonraki adım *" className="md:col-span-2">
              <input
                maxLength={200}
                value={followup.action}
                onChange={(e) => setFollowup({ ...followup, action: e.target.value })}
                className={inputClass}
                placeholder="Ör. teklif kararını sor"
              />
            </Field>
            <p className="md:col-span-2 text-xs text-gray-600">
              Kaydettiğinde yeni arama aynı arayan kişi için takvime eklenir.
            </p>
          </div>
        )}

        {decision === "clinic" && (
          <div className="grid gap-3 md:grid-cols-2 p-3 rounded border bg-gray-50">
            <div className="md:col-span-2 text-sm">
              {lead.patient_id ? (
                <span>
                  Randevu hasta kaydına eklenecek: <b>{lead.patient_name ?? lead.full_name}</b>
                </span>
              ) : (
                <Field label="Hasta kaydı">
                  <select
                    value={appt.patientChoice}
                    onChange={(e) => setAppt({ ...appt, patientChoice: e.target.value })}
                    className={inputClass}
                  >
                    <option value="new">
                      Yeni hasta kaydı oluştur ({lead.full_name} · {lead.phone})
                    </option>
                    {patientMatches.map((p) => (
                      <option key={p.id} value={p.id}>
                        Mevcut hastaya bağla: {p.full_name}
                        {p.is_active ? "" : " (pasif)"}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <Field label="Hekim *">
              <select
                value={appt.doctor_id}
                onChange={(e) => setAppt({ ...appt, doctor_id: e.target.value })}
                className={inputClass}
              >
                <option value="">Seç...</option>
                {resources.doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Koltuk *">
              <select
                value={appt.chair_id}
                onChange={(e) => setAppt({ ...appt, chair_id: e.target.value })}
                className={inputClass}
              >
                <option value="">Seç...</option>
                {resources.chairs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tarih *">
              <input
                type="date"
                min={today}
                value={appt.date}
                onChange={(e) => setAppt({ ...appt, date: e.target.value })}
                className={inputClass}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Başlangıç *">
                <input
                  type="time"
                  value={appt.start}
                  onChange={(e) =>
                    setAppt({ ...appt, start: e.target.value, end: appt.end || addMinutes(e.target.value, 30) })
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Bitiş *">
                <input
                  type="time"
                  value={appt.end}
                  onChange={(e) => setAppt({ ...appt, end: e.target.value })}
                  className={inputClass}
                />
              </Field>
            </div>
            <Field label="İşlem (isteğe bağlı)">
              <select
                value={appt.procedure_id}
                onChange={(e) => setAppt({ ...appt, procedure_id: e.target.value })}
                className={inputClass}
              >
                <option value="">Seçilmedi</option>
                {resources.procedures.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Randevu notu">
              <input
                maxLength={1000}
                value={appt.notes}
                onChange={(e) => setAppt({ ...appt, notes: e.target.value })}
                className={inputClass}
              />
            </Field>
            <p className="md:col-span-2 text-xs text-gray-600">
              Saatler İstanbul saatidir. Randevu ajandaya eklenir; hasta adayı “Randevu alındı” aşamasına geçer ve
              otomatik aramalar iptal edilir. Elle planlanan aramalar korunur.
            </p>
          </div>
        )}

        {decision === "lost" && (
          <Field label="Olumsuz sonuç nedeni *">
            <select
              value={lossReason}
              onChange={(e) => setLossReason(e.target.value as LossReason | "")}
              className={inputClass}
            >
              <option value="">Neden seç</option>
              {LOSS_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {decision === "stop" && (
          <p className="text-sm text-gray-700">
            Hastanın aranmama tercihi kaydedilir ve bekleyen tüm arama planları iptal edilir.
          </p>
        )}
        {decision === "completed" && (
          <p className="text-sm text-gray-700">
            Bu hasta için arama takibi tamamlanır; klinik aşaması değişmez. Diğer otomatik aramalar durdurulur; elle
            oluşturulmuş planlar korunur.
          </p>
        )}

        <p className="text-xs text-gray-600">
          Not ve takip kararı zorunlu. Kaydettiğinde arama sonucu, hasta notu ve varsa yeni arama birlikte kaydedilir.
        </p>
      </fieldset>

      {localError && (
        <div className="p-3 rounded bg-red-50 text-red-700 text-sm" role="alert">
          {localError}
        </div>
      )}
      <CrmErrorBox error={error} onReload={onReload} />

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <button type="button" className={buttonSecondary} onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
        )}
        {extraButtons}
        <button type="submit" className={buttonPrimary} disabled={busy}>
          {busy ? "Kaydediliyor…" : (submitLabel ?? "Sonucu kaydet")}
        </button>
      </div>
    </form>
  );
}
