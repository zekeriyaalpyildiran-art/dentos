"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  crmHandoffAction,
  crmLeadDetail,
  dayTimeLabel,
  formatDateTime,
  istanbulToday,
  newId,
  toCrmError,
  type CrmError,
  type HandoffJson,
} from "@/lib/crm";
import { HANDOFF_STATUS_LABELS, HANDOFF_TOPICS, HANDOFF_TOPIC_LABELS, type HandoffTopic } from "@/lib/crm/codes";
import type { StaffOption } from "./useCrmRefs";
import {
  CrmErrorBox,
  CrmModal,
  Field,
  Loading,
  Notice,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  useCanManageCrm,
} from "./ui";

export type HandoffMode = "request" | "answer" | "complete" | "cancel";

const TITLES: Record<HandoffMode, string> = {
  request: "Yöneticiye aktar",
  answer: "Yönetici kararı",
  complete: "Aktarımı tamamla",
  cancel: "Aktarımı geri çek",
};

/** Read-only summary of a handoff (question, answer, private note for managers). */
export function HandoffSummary({ handoff }: { handoff: HandoffJson }) {
  return (
    <div className="p-3 rounded bg-gray-50 text-sm space-y-1">
      <p>
        <b>{HANDOFF_TOPIC_LABELS[handoff.topic] ?? handoff.topic}</b> · {HANDOFF_STATUS_LABELS[handoff.status]}
      </p>
      <p className="whitespace-pre-line">{handoff.question}</p>
      <p className="text-xs text-gray-500">
        {handoff.requested_by_name ?? "Kullanıcı bilinmiyor"} · {formatDateTime(handoff.requested_at)}
      </p>
      {handoff.answer_text && (
        <div className="mt-2 pt-2 border-t">
          <p>
            <b>Yapılacak iş</b> ({dayTimeLabel(handoff.answer_due_date)}
            {handoff.answer_assignee_name ? `, ${handoff.answer_assignee_name}` : ""}):
          </p>
          <p className="whitespace-pre-line">{handoff.answer_text}</p>
          <p className="text-xs text-gray-500">
            {handoff.answered_by_name ?? "Yönetici"} · {formatDateTime(handoff.answered_at)}
          </p>
        </div>
      )}
      {handoff.private_note !== undefined && handoff.private_note && (
        <div className="mt-2 p-2 rounded bg-purple-50 text-purple-900">
          <b>Özel yönetici notu:</b> {handoff.private_note}
        </div>
      )}
      {handoff.completion_text && (
        <p className="mt-2 pt-2 border-t">
          <b>{handoff.status === "completed" ? "Sonuç" : "Geri çekme nedeni"}:</b> {handoff.completion_text}
          {handoff.system_closed ? " (sistem)" : ""}
        </p>
      )}
    </div>
  );
}

/**
 * Handoff actions (crm_handoff_action, HO:28-52): request (staff), answer / re-answer (crm_manage or owner),
 * complete an answered one, cancel a waiting one.
 */
export function HandoffDialog({
  mode,
  leadId,
  leadName,
  handoff,
  staff,
  onClose,
  onSaved,
}: {
  mode: HandoffMode;
  /** request only */
  leadId?: string;
  leadName?: string;
  handoff?: HandoffJson | null;
  staff: StaffOption[];
  onClose: () => void;
  onSaved: (handoff: HandoffJson) => void;
}) {
  const canManage = useCanManageCrm();
  const today = istanbulToday();
  const [requestId] = useState(newId);
  const [topic, setTopic] = useState<HandoffTopic>("price_payment");
  const [text, setText] = useState(mode === "answer" ? (handoff?.answer_text ?? "") : "");
  const [dueDate, setDueDate] = useState(handoff?.answer_due_date && handoff.answer_due_date >= today ? handoff.answer_due_date : today);
  const [assignee, setAssignee] = useState(handoff?.answer_assignee_user_id ?? "");
  const [privateNote, setPrivateNote] = useState<string>(handoff?.private_note ?? "");
  const [privateTouched, setPrivateTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await crmHandoffAction({
        p_action: mode,
        p_handoff_id: mode === "request" ? requestId : handoff!.id,
        p_version: mode === "request" ? null : handoff!.version,
        p_lead_id: mode === "request" ? (leadId ?? null) : null,
        p_topic: mode === "request" ? topic : null,
        p_text: text.trim(),
        p_due_date: mode === "answer" ? dueDate : null,
        p_private_note: mode === "answer" && privateTouched ? privateNote.trim() : null,
        p_assignee_user_id: mode === "answer" ? assignee || null : null,
      });
      onSaved(r.handoff);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  const textLabel =
    mode === "request"
      ? "Yöneticiye soru / talep *"
      : mode === "answer"
        ? "Yapılacak iş *"
        : mode === "complete"
          ? "Sonuç *"
          : "Geri çekme nedeni *";

  return (
    <CrmModal
      title={TITLES[mode]}
      description={leadName ?? handoff?.lead_name ?? undefined}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        {handoff && <HandoffSummary handoff={handoff} />}
        {mode === "answer" && !canManage && (
          <Notice tone="warn">Bu kararı yalnızca CRM yöneticisi kaydedebilir.</Notice>
        )}
        {mode === "request" && (
          <Field label="Konu">
            <select value={topic} onChange={(e) => setTopic(e.target.value as HandoffTopic)} className={inputClass}>
              {HANDOFF_TOPICS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={textLabel}>
          <textarea
            required
            rows={4}
            maxLength={3000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
          />
        </Field>
        {mode === "answer" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Görev tarihi *">
                <input
                  type="date"
                  required
                  min={today}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Sorumlu" hint="Boş bırakılırsa aktaran kişi">
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={inputClass}>
                  <option value="">Aktaran kişi</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label="Özel yönetici notu"
              hint="Yalnızca CRM yöneticileri görür. Silmek için alanı boşaltın."
            >
              <textarea
                rows={2}
                maxLength={3000}
                value={privateNote}
                onChange={(e) => {
                  setPrivateNote(e.target.value);
                  setPrivateTouched(true);
                }}
                className={inputClass}
              />
            </Field>
          </>
        )}
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button
            type="submit"
            className={buttonPrimary}
            disabled={busy || !text.trim() || (mode === "answer" && !canManage)}
          >
            {busy ? "Kaydediliyor…" : TITLES[mode]}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}

/** Work-list rows carry only the handoff id: load the lead card and open the matching action. */
export function HandoffByIdDialog({
  leadId,
  handoffId,
  staff,
  onClose,
  onSaved,
}: {
  leadId: string;
  handoffId: string;
  staff: StaffOption[];
  onClose: () => void;
  onSaved: (handoff: HandoffJson) => void;
}) {
  const canManage = useCanManageCrm();
  const [handoff, setHandoff] = useState<HandoffJson | null>(null);
  const [error, setError] = useState<CrmError | null>(null);

  useEffect(() => {
    let cancelled = false;
    crmLeadDetail({ p_lead_id: leadId })
      .then((d) => {
        if (cancelled) return;
        const h = d.handoffs.find((x) => x.id === handoffId) ?? null;
        if (!h) setError(toCrmError({ message: "Aktarım bulunamadı. Hasta kartını yenileyin.", code: "PT404" }));
        setHandoff(h);
      })
      .catch((err) => {
        if (!cancelled) setError(toCrmError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, handoffId]);

  if (!handoff) {
    return (
      <CrmModal title="Aktarım" onClose={onClose}>
        {error ? <CrmErrorBox error={error} /> : <Loading />}
      </CrmModal>
    );
  }
  const mode: HandoffMode | null =
    handoff.status === "answered"
      ? "complete"
      : handoff.status === "waiting"
        ? canManage
          ? "answer"
          : "cancel"
        : null;
  if (!mode) {
    return (
      <CrmModal title="Aktarım" onClose={onClose}>
        <HandoffSummary handoff={handoff} />
      </CrmModal>
    );
  }
  return <HandoffDialog mode={mode} handoff={handoff} staff={staff} onClose={onClose} onSaved={onSaved} />;
}
