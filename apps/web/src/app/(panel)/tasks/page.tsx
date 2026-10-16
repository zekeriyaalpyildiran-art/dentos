"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TaskDialog, TaskResultDialog, useCanAssignTasks } from "@/components/crm/TaskDialog";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  Badge,
  CrmErrorBox,
  EmptyState,
  Loading,
  Pager,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  useCanManageCrm,
} from "@/components/crm/ui";
import { useAuthStore } from "@/lib/store";
import { useCanOpenPath } from "@/components/useCanOpenPath";
import {
  dayTimeLabel,
  formatDateTime,
  staffTaskAction,
  staffTaskList,
  toCrmError,
  type CrmError,
  type TaskJson,
  type TaskScope,
} from "@/lib/crm";
import { TASK_DISPLAY_LABELS, TASK_DISPLAY_STYLES } from "@/lib/crm/codes";

const PAGE = 50;

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; task: TaskJson }
  | { kind: "complete"; task: TaskJson }
  | { kind: "cancel"; task: TaskJson };

/**
 * Staff tasks (generalised legacy task messages, TMU). The assignee reads and completes; the creator or a CRM
 * manager edits and cancels. Tasks are not work-list items; "Bugün" shows a banner instead.
 */
export default function TasksPage() {
  const me = useAuthStore((s) => s.user?.user_id ?? "");
  const canManage = useCanManageCrm();
  const canSeeAll = useCanAssignTasks();
  const staff = useStaff();
  // CRM is closed to some roles (assistants, lib/nav.ts): no CRM button, and a task's lead is shown as plain text.
  const canOpenCrmToday = useCanOpenPath("/crm/today");
  const canOpenLeads = useCanOpenPath("/crm/leads");
  const [scope, setScope] = useState<TaskScope>("mine");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<TaskJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<{ open: number; unread: number; overdue: number } | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await staffTaskList({ p_scope: scope, p_page: { offset, limit: PAGE } });
      setRows(r.rows);
      setTotal(r.total_count);
      setCounts(r.counts);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
      setRows([]);
    }
  }, [scope, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = async (task: TaskJson) => {
    try {
      await staffTaskAction({
        p_action: "read",
        p_id: task.id,
        p_version: task.version,
        p_title: null,
        p_detail: null,
        p_due_date: null,
        p_assignee_user_id: null,
        p_lead_id: null,
        p_patient_id: null,
        p_result: null,
      });
      load();
    } catch (err) {
      setError(toCrmError(err));
    }
  };

  const finish = (text: string) => {
    setDialog(null);
    setMessage(text);
    load();
  };

  const scopes: { value: TaskScope; label: string }[] = [
    { value: "mine", label: "Bana atananlar" },
    { value: "created", label: "Yazdıklarım" },
    ...(canSeeAll ? [{ value: "all" as TaskScope, label: "Tüm görevler" }] : []),
  ];

  return (
    <div className="p-8 text-gray-900 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Görevler</h1>
          <p className="text-sm text-gray-600 mt-1">
            Ekip içi görevler. Göreve atanan kişi okur ve sonucu yazarak tamamlar.
          </p>
        </div>
        <div className="flex gap-2">
          {canOpenCrmToday && (
            <Link href="/crm/today" className={buttonSecondary}>
              CRM · Bugün
            </Link>
          )}
          <button type="button" className={buttonPrimary} onClick={() => setDialog({ kind: "create" })}>
            + Yeni görev
          </button>
        </div>
      </div>

      <SuccessBox text={message} />
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Görev listesi">
        {scopes.map((s) => (
          <button
            key={s.value}
            role="tab"
            aria-selected={scope === s.value}
            onClick={() => {
              setScope(s.value);
              setOffset(0);
            }}
            className={`px-3 py-1.5 rounded text-sm ${
              scope === s.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"
            }`}
          >
            {s.label}
          </button>
        ))}
        {counts && (
          <span className="text-sm text-gray-600 ml-2">
            {counts.open} açık · {counts.unread} yeni · {counts.overdue} geciken
          </span>
        )}
      </div>

      <CrmErrorBox error={error} onReload={load} />
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-lg shadow">
          <EmptyState>Bu listede görev yok.</EmptyState>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((t) => {
            const isAssignee = t.assignee_user_id === me;
            const canEdit = t.status === "open" && (t.created_by === me || canManage);
            return (
              <li key={t.id} className="bg-white rounded-lg shadow p-4 text-sm space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-base">{t.title}</span>
                  <Badge className={TASK_DISPLAY_STYLES[t.display_status]}>{TASK_DISPLAY_LABELS[t.display_status]}</Badge>
                  <span className="text-xs text-gray-600">Tarih: {dayTimeLabel(t.due_date)}</span>
                </div>
                {t.detail && <p className="whitespace-pre-line text-gray-800">{t.detail}</p>}
                <p className="text-xs text-gray-600">
                  Görevli: {t.assignee_name ?? "—"} · Yazan: {t.created_by_name ?? "—"}
                  {t.lead_id &&
                    (t.lead_visible ? (
                      <>
                        {" "}
                        · Hasta:{" "}
                        {canOpenLeads ? (
                          <Link href={`/crm/leads/${t.lead_id}`} className="text-blue-700 underline">
                            {t.lead_name ?? "Hasta kartı"}
                          </Link>
                        ) : (
                          <span className="font-medium text-gray-800">{t.lead_name ?? "Hasta adayı"}</span>
                        )}
                      </>
                    ) : (
                      " · İlgili hasta kaydı artık görünmüyor."
                    ))}
                  {t.patient_id && (
                    <>
                      {" "}
                      ·{" "}
                      <Link href={`/patients/${t.patient_id}`} className="text-blue-700 underline">
                        {t.patient_name ?? "Hasta kaydı"}
                      </Link>
                    </>
                  )}
                </p>
                {t.status === "done" && (
                  <p className="p-2 rounded bg-green-50">
                    <b>Sonuç:</b> {t.result} · {t.completed_by_name ?? ""} · {formatDateTime(t.completed_at)}
                  </p>
                )}
                {t.status === "cancelled" && (
                  <p className="p-2 rounded bg-gray-50 text-gray-700">
                    İptal edildi · {formatDateTime(t.cancelled_at)}
                    {t.result ? ` · ${t.result}` : ""}
                  </p>
                )}
                {t.status === "open" && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {isAssignee && !t.read_at && (
                      <button type="button" className={buttonSecondary} onClick={() => markRead(t)}>
                        Okundu
                      </button>
                    )}
                    {isAssignee && (
                      <button type="button" className={buttonPrimary} onClick={() => setDialog({ kind: "complete", task: t })}>
                        Tamamla
                      </button>
                    )}
                    {canEdit && (
                      <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "edit", task: t })}>
                        Düzenle
                      </button>
                    )}
                    {canEdit && (
                      <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "cancel", task: t })}>
                        İptal et
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <TaskDialog
          task={dialog.kind === "edit" ? dialog.task : null}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={() => finish(dialog.kind === "edit" ? "Görev güncellendi." : "Görev oluşturuldu.")}
        />
      )}
      {(dialog?.kind === "complete" || dialog?.kind === "cancel") && (
        <TaskResultDialog
          task={dialog.task}
          mode={dialog.kind}
          onClose={() => setDialog(null)}
          onSaved={() => finish(dialog.kind === "complete" ? "Görev tamamlandı." : "Görev iptal edildi.")}
        />
      )}
    </div>
  );
}
