"use client";

import { useState, type FormEvent } from "react";
import { useAuthStore } from "@/lib/store";
import {
  istanbulToday,
  newId,
  staffTaskAction,
  toCrmError,
  type CrmError,
  type TaskJson,
} from "@/lib/crm";
import type { StaffOption } from "./useCrmRefs";
import {
  CrmErrorBox,
  CrmModal,
  Field,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  useCanManageCrm,
} from "./ui";

/**
 * True when the user may assign tasks to someone else and see every task: a CRM manager (owner or 'crm_manage').
 * Role admin alone is not a manager (rules §1, §27); the owner grants 'crm_manage' when an admin needs it.
 */
export function useCanAssignTasks(): boolean {
  return useCanManageCrm();
}

/** Create or edit a staff task (staff_task_action 'create' / 'update'). */
export function TaskDialog({
  task,
  staff,
  defaults,
  onClose,
  onSaved,
}: {
  /** Edit when set. */
  task?: TaskJson | null;
  staff: StaffOption[];
  defaults?: { title?: string; lead_id?: string | null; lead_name?: string | null; patient_id?: string | null };
  onClose: () => void;
  onSaved: (task: TaskJson) => void;
}) {
  const me = useAuthStore((s) => s.user?.user_id ?? "");
  const canAssign = useCanAssignTasks();
  const today = istanbulToday();
  const [id] = useState(() => task?.id ?? newId());
  const [form, setForm] = useState({
    title: task?.title ?? defaults?.title ?? "",
    detail: task?.detail ?? "",
    due_date: task?.due_date ?? today,
    assignee: task?.assignee_user_id ?? me,
  });
  const leadId = task ? task.lead_id : (defaults?.lead_id ?? null);
  const leadName = task ? task.lead_name : (defaults?.lead_name ?? null);
  const patientId = task ? task.patient_id : (defaults?.patient_id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);

  const assignees = canAssign ? staff : staff.filter((s) => s.id === me);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await staffTaskAction({
        p_action: task ? "update" : "create",
        p_id: id,
        p_version: task ? task.version : null,
        p_title: form.title.trim(),
        p_detail: form.detail.trim(),
        p_due_date: form.due_date,
        p_assignee_user_id: form.assignee || me || null,
        p_lead_id: leadId,
        p_patient_id: patientId,
        p_result: null,
      });
      onSaved(r.task);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal title={task ? "Görevi düzenle" : "Yeni görev"} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {leadName && (
          <p className="text-sm text-gray-700">
            İlgili hasta: <b>{leadName}</b>
          </p>
        )}
        <Field label="Başlık *">
          <input
            required
            minLength={3}
            maxLength={160}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Açıklama">
          <textarea
            rows={3}
            maxLength={2000}
            value={form.detail}
            onChange={(e) => setForm({ ...form, detail: e.target.value })}
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tarih *">
            <input
              type="date"
              required
              min={today}
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Görevli *" hint={canAssign ? undefined : "Kendinize görev yazabilirsiniz."}>
            <select
              required
              value={form.assignee}
              onChange={(e) => setForm({ ...form, assignee: e.target.value })}
              className={inputClass}
            >
              {assignees.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                  {s.id === me ? " (ben)" : ""}
                </option>
              ))}
              {task && !assignees.some((s) => s.id === task.assignee_user_id) && (
                <option value={task.assignee_user_id}>{task.assignee_name ?? "Mevcut görevli"}</option>
              )}
            </select>
          </Field>
        </div>
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" className={buttonPrimary} disabled={busy || form.title.trim().length < 3}>
            {busy ? "Kaydediliyor…" : "Kaydet"}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}

/** Complete a task with its mandatory result (TM:25), or cancel it with an optional reason. */
export function TaskResultDialog({
  task,
  mode,
  onClose,
  onSaved,
}: {
  task: TaskJson;
  mode: "complete" | "cancel";
  onClose: () => void;
  onSaved: (task: TaskJson) => void;
}) {
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await staffTaskAction({
        p_action: mode,
        p_id: task.id,
        p_version: task.version,
        p_title: null,
        p_detail: null,
        p_due_date: null,
        p_assignee_user_id: null,
        p_lead_id: null,
        p_patient_id: null,
        p_result: result.trim() || null,
      });
      onSaved(r.task);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal
      title={mode === "complete" ? "Görevi tamamla" : "Görevi iptal et"}
      description={task.title}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={mode === "complete" ? "Sonuç *" : "İptal nedeni"}>
          <textarea
            rows={3}
            maxLength={2000}
            required={mode === "complete"}
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className={inputClass}
          />
        </Field>
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button
            type="submit"
            className={buttonPrimary}
            disabled={busy || (mode === "complete" && result.trim().length < 2)}
          >
            {busy ? "Kaydediliyor…" : mode === "complete" ? "Tamamla" : "İptal et"}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}
