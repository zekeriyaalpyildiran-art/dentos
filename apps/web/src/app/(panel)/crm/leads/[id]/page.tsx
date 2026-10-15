"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CallResultDialog,
  PlanCallDialog,
  RescheduleCallDialog,
  resolveMessage,
  type ReschedulableCall,
} from "@/components/crm/CallDialogs";
import { ConvertDialog } from "@/components/crm/ConvertDialog";
import { HandoffDialog, HandoffSummary, type HandoffMode } from "@/components/crm/HandoffDialog";
import { LeadFields, formToInput, leadToForm, type LeadFormState } from "@/components/crm/LeadFields";
import { LeadHistory } from "@/components/crm/LeadHistory";
import { PhoneMatchWarning, PhoneMatchesList } from "@/components/crm/PhoneMatches";
import { ReminderDialog } from "@/components/crm/ReminderDialog";
import { TaskDialog } from "@/components/crm/TaskDialog";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  Badge,
  Card,
  CrmErrorBox,
  CrmShell,
  Field,
  InterestBadge,
  Loading,
  Notice,
  StageBadge,
  SuccessBox,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import {
  crmLeadDetail,
  crmRestoreLead,
  crmSaveLead,
  crmTrashLead,
  dayTimeLabel,
  formatDateTime,
  istanbulToday,
  splitIstanbul,
  telHref,
  toCrmError,
  UUID_RE,
  type CallJson,
  type CrmError,
  type HandoffJson,
  type LeadDetailJson,
  type PhoneMatchesJson,
} from "@/lib/crm";
import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_STATUS_STYLES,
  CALL_DECISION_LABELS,
  CALL_ORIGIN_LABELS,
  CALL_STATUS_LABELS,
  CALL_STATUS_STYLES,
  REMINDER_OUTCOME_LABELS,
  TASK_DISPLAY_LABELS,
  TASK_DISPLAY_STYLES,
  sourceLabel,
} from "@/lib/crm/codes";

type Dialog =
  | { kind: "result"; callId: string | null; useDue: boolean }
  | { kind: "plan" }
  | { kind: "reschedule"; call: ReschedulableCall }
  | { kind: "reminder"; appointmentId: string }
  | { kind: "handoff"; mode: HandoffMode; handoff: HandoffJson | null }
  | { kind: "task" }
  | { kind: "convert" };

export default function LeadCardPage() {
  const params = useParams<{ id: string }>();
  const leadId = params.id;
  const router = useRouter();
  const staff = useStaff();

  const [detail, setDetail] = useState<LeadDetailJson | null>(null);
  const [loadError, setLoadError] = useState<CrmError | null>(null);
  const [form, setForm] = useState<LeadFormState | null>(null);
  const [note, setNote] = useState("");
  const [scheduleReason, setScheduleReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<CrmError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savedMatches, setSavedMatches] = useState<PhoneMatchesJson | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(
    async (resetForm: boolean) => {
      if (!UUID_RE.test(leadId)) {
        setLoadError(toCrmError({ message: "Hasta kaydı bulunamadı.", code: "PT404" }));
        return;
      }
      try {
        const d = await crmLeadDetail({ p_lead_id: leadId });
        setDetail(d);
        setLoadError(null);
        if (resetForm) {
          setForm(leadToForm(d.lead));
          setNote("");
          setScheduleReason("");
        }
      } catch (err) {
        setLoadError(toCrmError(err));
      }
    },
    [leadId]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  const lead = detail?.lead ?? null;
  const original = useMemo(() => (lead ? leadToForm(lead) : null), [lead]);
  const dirty = !!form && !!original && (JSON.stringify(form) !== JSON.stringify(original) || note.trim() !== "");

  const reloadAll = () => load(true);
  const reloadKeepForm = () => load(false);

  const done = (text: string, keepForm = false) => {
    setDialog(null);
    setMessage(text);
    if (keepForm && dirty) reloadKeepForm();
    else reloadAll();
  };

  if (!detail || !lead || !form || !original) {
    return (
      <CrmShell title="Hasta kartı">
        {loadError ? (
          <div className="space-y-3">
            <CrmErrorBox error={loadError} />
            <Link href="/crm/leads" className={buttonSecondary}>
              Listeye dön
            </Link>
          </div>
        ) : (
          <Loading />
        )}
      </CrmShell>
    );
  }

  const trashed = !!lead.deleted_at;
  const canManage = detail.can_manage;
  const today = istanbulToday();
  const moved =
    !!original.followup_date &&
    !!form.followup_date &&
    original.followup_date !== form.followup_date &&
    form.followup_state === "open";

  // Client-side hints for the server's mandatory-note rules (RR:53, RR:59, RR:61); the server decides.
  const closesFollowup =
    original.followup_state === "open" &&
    (form.followup_state === "done" || form.do_not_contact || form.stage === "treatment_completed");
  const noteRule =
    form.stage === "treatment_completed" && original.stage !== "treatment_completed"
      ? "Tedaviyi kapatmak için yeni görüşme notuna tamamlanma açıklamasını yazın."
      : original.stage === "treatment_completed" && form.stage !== "treatment_completed"
        ? "Hastayı yeniden açma nedenini yeni görüşme notuna yazın."
        : closesFollowup
          ? "Takibi tamamlamak için yeni görüşme notuna kapanış nedenini yazın."
          : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || trashed) return;
    const parsed = formToInput(form);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    if (noteRule && !note.trim()) {
      setLocalError(noteRule);
      return;
    }
    if (moved && !scheduleReason.trim()) {
      setLocalError("Takip tarihini değiştirme nedenini yazın.");
      return;
    }
    setLocalError(null);
    setSaveError(null);
    setSaving(true);
    try {
      const r = await crmSaveLead({
        p_id: lead.id,
        p_version: lead.version,
        p_lead: parsed.input,
        p_note: note.trim() || null,
        p_schedule_reason: moved ? scheduleReason.trim() : null,
        p_initial_call: null,
      });
      setSavedMatches(r.phone_matches);
      const cancelled = r.cancelled_call_ids?.length ?? 0;
      setMessage(
        `Hasta kartı kaydedildi.${cancelled ? ` ${cancelled} bekleyen arama iptal edildi.` : ""}`
      );
      await load(true);
    } catch (err) {
      setSaveError(toCrmError(err));
    } finally {
      setSaving(false);
    }
  };

  const trash = async () => {
    if (!confirm("Hasta çöp kutusuna taşınsın mı? Aramaları ve geçmişi korunur; listelerde görünmez.")) return;
    try {
      await crmTrashLead({ p_lead_id: lead.id, p_version: lead.version });
      router.push("/crm/leads");
    } catch (err) {
      setSaveError(toCrmError(err));
    }
  };

  const restore = async () => {
    try {
      const r = await crmRestoreLead({ p_lead_id: lead.id, p_version: lead.version });
      setSavedMatches(r.phone_matches);
      setMessage("Hasta çöp kutusundan geri getirildi.");
      await load(true);
    } catch (err) {
      setSaveError(toCrmError(err));
    }
  };

  const openHandoff = detail.handoffs.find((h) => h.status === "waiting" || h.status === "answered") ?? null;
  const canRequestHandoff =
    !trashed && !openHandoff && lead.stage !== "archived" && lead.stage !== "treatment_completed";
  const toReschedulable = (c: CallJson): ReschedulableCall => ({
    id: c.id,
    version: c.version,
    lead_name: lead.full_name,
    date: c.date,
    time: c.time,
    caller_user_id: c.caller_user_id,
    caller_name: c.caller_name ?? c.caller_name_legacy ?? null,
  });

  return (
    <CrmShell
      title={
        <span className="flex flex-wrap items-center gap-3">
          {lead.full_name} <StageBadge stage={lead.stage} /> <InterestBadge interest={lead.interest} />
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <a href={telHref(lead.phone)} className="text-blue-700 underline">
            {lead.phone}
          </a>
          <span>· {sourceLabel(lead.source)}</span>
          <span>· Sorumlu: {lead.assigned_name ?? "Atanmamış"}</span>
          <span>· Kayıt: {formatDateTime(lead.created_at)}</span>
        </span>
      }
      actions={
        <>
          <Link href="/crm/leads" className={buttonSecondary}>
            ← Liste
          </Link>
          {!trashed &&
            (lead.patient_id ? (
              <Link href={`/patients/${lead.patient_id}`} className={buttonSecondary}>
                Hasta kaydı: {lead.patient_name ?? "aç"}
              </Link>
            ) : (
              <button type="button" className={buttonPrimary} onClick={() => setDialog({ kind: "convert" })}>
                Hastaya dönüştür
              </button>
            ))}
          {trashed ? (
            <button type="button" className={buttonPrimary} onClick={restore}>
              Çöp kutusundan geri getir
            </button>
          ) : (
            <button type="button" className={buttonDanger} onClick={trash}>
              Çöp kutusuna taşı
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {trashed && (
          <Notice tone="danger">
            Bu hasta çöp kutusunda ({formatDateTime(lead.deleted_at)}
            {lead.deleted_by_name ? ` · ${lead.deleted_by_name}` : ""}). Kart salt okunurdur.
          </Notice>
        )}
        {lead.automation_review && (
          <Notice tone="warn">
            <b>Takip kararı gerekiyor:</b> {lead.automation_review}
          </Notice>
        )}
        {lead.do_not_contact && <Notice tone="danger">Hasta telefonla aranmak istemiyor.</Notice>}
        {lead.missing_plan && !lead.automation_review && (
          <Notice tone="warn">Takip planı eksik: sonraki adımı ve tarihi birlikte belirleyin veya bir arama planlayın.</Notice>
        )}
        {lead.treatment_closed_at && lead.stage === "treatment_completed" && (
          <Notice tone="success">
            Tedavi tamamlandı · {formatDateTime(lead.treatment_closed_at)}
            {lead.treatment_closed_by_name ? ` · ${lead.treatment_closed_by_name}` : ""}
          </Notice>
        )}
        <SuccessBox text={message} />
        <PhoneMatchesList matches={savedMatches} />

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Card title="Hasta kartı">
              <form onSubmit={save} className="space-y-6">
                <LeadFields
                  value={form}
                  onChange={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
                  staff={staff}
                  today={today}
                  originalSource={lead.source}
                  originalAssignee={lead.assigned_to ? { id: lead.assigned_to, name: lead.assigned_name } : null}
                  disabled={trashed || saving}
                />
                {!trashed && form.phone !== original.phone && (
                  <PhoneMatchWarning phone={form.phone} excludeLeadId={lead.id} excludePatientId={lead.patient_id} />
                )}
                {!trashed && (
                  <div className="space-y-3">
                    {moved && (
                      <Field label="Takip tarihini değiştirme nedeni *">
                        <input
                          maxLength={500}
                          value={scheduleReason}
                          onChange={(e) => setScheduleReason(e.target.value)}
                          className={inputClass}
                          placeholder={`${dayTimeLabel(original.followup_date)} → ${dayTimeLabel(form.followup_date)}`}
                        />
                      </Field>
                    )}
                    <Field
                      label={noteRule ? "Yeni görüşme notu *" : "Yeni görüşme notu"}
                      hint={noteRule ?? "Kaydettiğinde geçmişe not olarak eklenir."}
                    >
                      <textarea
                        rows={3}
                        maxLength={10000}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                    {localError && (
                      <div className="p-3 rounded bg-red-50 text-red-700 text-sm" role="alert">
                        {localError}
                      </div>
                    )}
                    <CrmErrorBox error={saveError} onReload={reloadAll} />
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className={buttonSecondary}
                        disabled={!dirty || saving}
                        onClick={() => {
                          setForm(original);
                          setNote("");
                          setScheduleReason("");
                          setLocalError(null);
                        }}
                      >
                        Değişiklikleri geri al
                      </button>
                      <button type="submit" className={buttonPrimary} disabled={!dirty || saving}>
                        {saving ? "Kaydediliyor…" : "Kaydet"}
                      </button>
                    </div>
                  </div>
                )}
              </form>
              {/* The migration copies leads.notes into one 'legacy' history row; show the box only without it. */}
              {lead.notes_legacy && !detail.activities.some((a) => a.type === "legacy") && (
                <div className="mt-4 p-3 rounded bg-gray-50 text-sm">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Eski not</p>
                  <p className="whitespace-pre-line">{lead.notes_legacy}</p>
                </div>
              )}
            </Card>

            <Card title="Geçmiş">
              <LeadHistory
                leadId={lead.id}
                activities={detail.activities}
                total={detail.activities_total}
                canManage={canManage}
                readOnly={trashed}
                onChanged={reloadKeepForm}
              />
            </Card>
          </div>

          <div className="space-y-4">
            <Card
              title="Aramalar"
              actions={
                !trashed && (
                  <>
                    <button
                      type="button"
                      className={buttonPrimary}
                      onClick={() =>
                        setDialog({ kind: "result", callId: detail.due_call?.id ?? null, useDue: !!detail.due_call })
                      }
                    >
                      Görüşme sonucu
                    </button>
                    <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "plan" })}>
                      Arama planla
                    </button>
                  </>
                )
              }
            >
              <div className="space-y-2 text-sm">
                <p>
                  <b>Sıradaki arama:</b>{" "}
                  {lead.next_call
                    ? `${dayTimeLabel(lead.next_call.date, lead.next_call.time)} · ${lead.next_call.caller_name ?? "Arayan"} · ${CALL_ORIGIN_LABELS[lead.next_call.origin]}`
                    : "Yok"}
                </p>
                <p>
                  <b>Takip:</b> {lead.followup_state === "done" ? "Tamamlandı" : dayTimeLabel(lead.followup_date)}
                  {lead.next_action ? ` · ${lead.next_action}` : ""}
                </p>
              </div>
              {detail.calls.length > 0 && (
                <ul className="mt-3 divide-y border rounded text-sm">
                  {detail.calls.map((c) => (
                    <li key={c.id} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium tabular-nums">{dayTimeLabel(c.date, c.time)}</span>
                        <Badge className={CALL_STATUS_STYLES[c.status]}>{CALL_STATUS_LABELS[c.status]}</Badge>
                        {c.origin === "automatic" && (
                          <Badge className="bg-purple-100 text-purple-800">{CALL_ORIGIN_LABELS.automatic}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-gray-600">
                        {c.caller_name ?? c.caller_name_legacy ?? "Arayan bilinmiyor"}
                        {c.decision ? ` · ${CALL_DECISION_LABELS[c.decision]}` : ""}
                        {c.auto_cancelled && c.cancel_reason ? ` · Sistem iptali: ${c.cancel_reason}` : ""}
                      </p>
                      {c.note && (
                        <p className="text-xs text-gray-800 mt-1 line-clamp-3 whitespace-pre-line">
                          {c.note}
                          {c.note_edited && <span className="text-gray-500"> (düzeltildi)</span>}
                        </p>
                      )}
                      {c.status === "planned" && !trashed && (
                        <div className="mt-1 flex gap-3 text-xs">
                          <button
                            type="button"
                            className="text-blue-700 underline"
                            onClick={() => setDialog({ kind: "result", callId: c.id, useDue: false })}
                          >
                            Sonucu kaydet
                          </button>
                          <button
                            type="button"
                            className="text-blue-700 underline"
                            onClick={() => setDialog({ kind: "reschedule", call: toReschedulable(c) })}
                          >
                            Planı değiştir
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Klinik randevuları"
              actions={
                lead.patient_id && !trashed ? (
                  <Link href={`/appointments/new?patient=${lead.patient_id}`} className={buttonSecondary}>
                    Randevu oluştur
                  </Link>
                ) : undefined
              }
            >
              {!lead.patient_id ? (
                <p className="text-sm text-gray-600">
                  Hasta kaydı yok. Randevu için “Hastaya dönüştür” veya görüşme sonucunda “Klinik randevusu kesinleşti”
                  kararını kullanın.
                </p>
              ) : detail.appointments.length === 0 ? (
                <p className="text-sm text-gray-600">Randevu yok.</p>
              ) : (
                <ul className="divide-y border rounded text-sm">
                  {detail.appointments.map((a) => {
                    const local = splitIstanbul(a.start_time);
                    const remindable = a.status === "scheduled" && local.date >= today;
                    return (
                      <li key={a.id} className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{formatDateTime(a.start_time)}</span>
                          <Badge className={APPOINTMENT_STATUS_STYLES[a.status] ?? "bg-gray-100 text-gray-700"}>
                            {APPOINTMENT_STATUS_LABELS[a.status] ?? a.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-600">
                          {a.doctor_name ?? "Hekim"} · {a.chair_name ?? "Koltuk"}
                        </p>
                        {a.reminder_current && a.reminder_outcome && (
                          <p className="text-xs text-teal-700">
                            Hatırlatma: {REMINDER_OUTCOME_LABELS[a.reminder_outcome]}
                          </p>
                        )}
                        {remindable && !trashed && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-blue-700 underline"
                            onClick={() => setDialog({ kind: "reminder", appointmentId: a.id })}
                          >
                            Hatırlatma sonucu kaydet
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card
              title="Yöneticiye aktarım"
              actions={
                canRequestHandoff ? (
                  <button
                    type="button"
                    className={buttonSecondary}
                    onClick={() => setDialog({ kind: "handoff", mode: "request", handoff: null })}
                  >
                    Yöneticiye aktar
                  </button>
                ) : undefined
              }
            >
              {detail.handoffs.length === 0 ? (
                <p className="text-sm text-gray-600">Aktarım yok.</p>
              ) : (
                <div className="space-y-3">
                  {detail.handoffs.map((h) => (
                    <div key={h.id} className="space-y-2">
                      <HandoffSummary handoff={h} />
                      {!trashed && (
                        <div className="flex flex-wrap gap-3 text-xs">
                          {canManage && (h.status === "waiting" || h.status === "answered") && (
                            <button
                              type="button"
                              className="text-blue-700 underline"
                              onClick={() => setDialog({ kind: "handoff", mode: "answer", handoff: h })}
                            >
                              {h.status === "answered" ? "Yanıtı düzenle" : "Yanıtla"}
                            </button>
                          )}
                          {h.status === "answered" && (
                            <button
                              type="button"
                              className="text-blue-700 underline"
                              onClick={() => setDialog({ kind: "handoff", mode: "complete", handoff: h })}
                            >
                              Tamamla
                            </button>
                          )}
                          {h.status === "waiting" && (
                            <button
                              type="button"
                              className="text-blue-700 underline"
                              onClick={() => setDialog({ kind: "handoff", mode: "cancel", handoff: h })}
                            >
                              Geri çek
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Görevler"
              actions={
                !trashed ? (
                  <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "task" })}>
                    Görev yaz
                  </button>
                ) : undefined
              }
            >
              {detail.tasks.length === 0 ? (
                <p className="text-sm text-gray-600">Açık görev yok.</p>
              ) : (
                <ul className="divide-y border rounded text-sm">
                  {detail.tasks.map((t) => (
                    <li key={t.id} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{t.title}</span>
                        <Badge className={TASK_DISPLAY_STYLES[t.display_status]}>
                          {TASK_DISPLAY_LABELS[t.display_status]}
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-600">
                        {dayTimeLabel(t.due_date)} · {t.assignee_name ?? "Görevli"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/tasks" className="mt-2 inline-block text-xs text-blue-700 underline">
                Tüm görevler
              </Link>
            </Card>
          </div>
        </div>
      </div>

      {dialog?.kind === "result" && (
        <CallResultDialog
          leadId={lead.id}
          callId={dialog.callId}
          useDueCall={dialog.useDue}
          onClose={() => setDialog(null)}
          onSaved={(r) => done(resolveMessage(r))}
        />
      )}
      {dialog?.kind === "plan" && (
        <PlanCallDialog
          lead={lead}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={(c) => done(`Arama planlandı: ${dayTimeLabel(c.date, c.time)}.`)}
        />
      )}
      {dialog?.kind === "reschedule" && (
        <RescheduleCallDialog
          call={dialog.call}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={(c) => done(`Arama planı güncellendi: ${dayTimeLabel(c.date, c.time)}.`)}
        />
      )}
      {dialog?.kind === "reminder" && (
        <ReminderDialog
          appointmentId={dialog.appointmentId}
          onClose={() => setDialog(null)}
          onSaved={() => done("Hatırlatma sonucu kaydedildi.", true)}
        />
      )}
      {dialog?.kind === "handoff" && (
        <HandoffDialog
          mode={dialog.mode}
          leadId={lead.id}
          leadName={lead.full_name}
          handoff={dialog.handoff}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={() => done("Aktarım kaydedildi.", true)}
        />
      )}
      {dialog?.kind === "task" && (
        <TaskDialog
          staff={staff}
          defaults={{ title: `Hasta adayı: ${lead.full_name}`, lead_id: lead.id, lead_name: lead.full_name }}
          onClose={() => setDialog(null)}
          onSaved={() => done("Görev oluşturuldu.", true)}
        />
      )}
      {dialog?.kind === "convert" && (
        <ConvertDialog
          lead={lead}
          onClose={() => setDialog(null)}
          onSaved={(r) => {
            setSavedMatches(r.phone_matches);
            done(r.created ? "Hasta kaydı oluşturuldu." : "Hasta kaydına bağlandı.");
          }}
        />
      )}
    </CrmShell>
  );
}
