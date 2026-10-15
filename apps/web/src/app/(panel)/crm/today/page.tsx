"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CallResultDialog, RescheduleCallDialog, resolveMessage, type ReschedulableCall } from "@/components/crm/CallDialogs";
import { ClinicResultDialog } from "@/components/crm/ClinicResultDialog";
import { DaySummary } from "@/components/crm/DaySummary";
import { HandoffByIdDialog } from "@/components/crm/HandoffDialog";
import { OverdueDialog } from "@/components/crm/OverdueDialog";
import { ReminderDialog } from "@/components/crm/ReminderDialog";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  CrmErrorBox,
  CrmShell,
  EmptyState,
  InterestBadge,
  Loading,
  Pager,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import {
  crmWorkList,
  dayTimeLabel,
  longDayLabel,
  toCrmError,
  type CrmError,
  type WorkItemJson,
  type WorkListJson,
} from "@/lib/crm";
import { REMINDER_OUTCOME_LABELS, WORK_FILTERS, type WorkFilter } from "@/lib/crm/codes";

const PAGE = 50;

type Dialog =
  | { kind: "call"; leadId: string; callId: string }
  | { kind: "reschedule"; call: ReschedulableCall }
  | { kind: "reminder"; appointmentId: string }
  | { kind: "handoff"; leadId: string; handoffId: string }
  | { kind: "clinic"; appointmentId: string }
  | { kind: "overdue" };

const EXPLANATIONS: Record<WorkFilter, string> = {
  all: "Aramalar, hasta takipleri, klinik randevusu hatırlatmaları ve yönetici yanıtlarından gelen görevler. Aynı hastanın birden fazla işi olabilir.",
  overdue: "Geciken aramalar, geçmiş takip tarihleri, sonucu girilmemiş randevular ve karar bekleyen hastalar.",
  today: "Bugün aranacak hastalar, bugünkü takipler, yeni başvurular ve bugünkü randevular.",
  missing: "Her hasta bir kez gösterilir. Hasta kartında sonraki adımı ve tarihi belirle.",
  future: "Gelecek günlerin arama planları, hasta kartındaki takip tarihleri ve ileri tarihli görevler.",
};

export default function CrmTodayPage() {
  const staff = useStaff();
  const [tab, setTab] = useState<"work" | "summary">("work");
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [userId, setUserId] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<WorkListJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CrmError | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await crmWorkList({ p_filter: filter, p_user_id: userId || null, p_page: { offset, limit: PAGE } }));
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setLoading(false);
    }
  }, [filter, userId, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const done = (text: string) => {
    setDialog(null);
    setMessage(text);
    load();
  };

  const quickHref = `/crm/quick-calls?filter=${filter}${userId ? `&user=${userId}` : ""}`;
  const quickCount = data?.quick_call_lead_ids.length ?? 0;

  return (
    <CrmShell
      title="Bugün"
      subtitle={data ? longDayLabel(data.today) : undefined}
      actions={
        <>
          <Link href="/crm/new-lead" className={buttonPrimary}>
            + Yeni hasta adayı
          </Link>
          <Link href="/crm/calls" className={buttonSecondary}>
            Arama planı
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {data && data.my_tasks.open > 0 && (
          <div className="p-3 rounded border border-blue-200 bg-blue-50 text-blue-900 text-sm flex flex-wrap items-center justify-between gap-2">
            <span>
              <b>{data.my_tasks.open} görev mesajın var.</b>
              {data.my_tasks.unread > 0 ? ` ${data.my_tasks.unread} yeni.` : ""}
              {data.my_tasks.overdue > 0 ? ` ${data.my_tasks.overdue} gecikti.` : ""}
            </span>
            <Link href="/tasks" className="underline">
              Görevlerimi aç
            </Link>
          </div>
        )}
        <SuccessBox text={message} />

        <div className="flex gap-2 border-b" role="tablist" aria-label="Bugün görünümü">
          {(
            [
              { id: "work", label: "İş listesi" },
              { id: "summary", label: "Gün sonu özeti" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 -mb-px border-b-2 text-sm font-medium ${
                tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "summary" ? (
          <DaySummary onShowWorkList={() => setTab("work")} />
        ) : (
          <section className="bg-white rounded-lg shadow p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Bekleyen işler</h2>
                {data && (
                  <p className="text-sm text-gray-600">
                    {data.counts.all} iş · {data.counts.missing} hastanın takip planı eksik
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Sorumlu"
                  value={userId}
                  onChange={(e) => {
                    setUserId(e.target.value);
                    setOffset(0);
                  }}
                  className={`${inputClass} w-52`}
                >
                  <option value="">Tüm sorumlular</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
                <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "overdue" })}>
                  Geciken hasta listesi ({data?.counts.overdue ?? 0})
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2" role="group" aria-label="İş listesi filtresi">
              {WORK_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => {
                    setFilter(f.value);
                    setOffset(0);
                  }}
                  className={`px-3 py-1.5 rounded text-sm flex items-center gap-2 ${
                    filter === f.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"
                  }`}
                >
                  {f.label}
                  <span
                    className={`px-1.5 rounded text-xs ${filter === f.value ? "bg-white/20" : "bg-white text-gray-700"}`}
                  >
                    {data?.counts[f.value] ?? "–"}
                  </span>
                </button>
              ))}
            </div>

            {filter !== "future" && (
              <div className="p-3 rounded border bg-gray-50 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <b>Aramaları sırayla tamamla</b>
                  <span className="block text-gray-600">Son not, görüşme sonucu ve sonraki adım aynı ekranda.</span>
                </div>
                {quickCount > 0 ? (
                  <Link href={quickHref} className={buttonPrimary}>
                    Hızlı aramayı başlat ({quickCount})
                  </Link>
                ) : (
                  <button type="button" className={buttonPrimary} disabled>
                    Hızlı aramayı başlat (0)
                  </button>
                )}
              </div>
            )}
            <p className="text-sm text-gray-600">{EXPLANATIONS[filter]}</p>

            <CrmErrorBox error={error} onReload={load} />
            {loading && !data ? (
              <Loading />
            ) : data && data.rows.length === 0 ? (
              <EmptyState>
                {filter === "all"
                  ? "Bugün bekleyen iş yok. Gelecek planlarını İleri tarihli filtresinden görebilirsin."
                  : "Bu filtrede kayıt yok."}
              </EmptyState>
            ) : (
              <ol className="divide-y border rounded">
                {data?.rows.map((item, i) => (
                  <WorkRow key={item.key} index={offset + i + 1} item={item} onOpen={setDialog} />
                ))}
              </ol>
            )}
            {data && <Pager offset={offset} limit={PAGE} total={data.total_count} onChange={setOffset} />}
          </section>
        )}
      </div>

      {dialog?.kind === "overdue" && <OverdueDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "call" && (
        <CallResultDialog
          leadId={dialog.leadId}
          callId={dialog.callId}
          onClose={() => setDialog(null)}
          onSaved={(r) => done(resolveMessage(r))}
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
          onSaved={(r) =>
            done(`Hatırlatma sonucu kaydedildi: ${REMINDER_OUTCOME_LABELS[r.log.outcome] ?? r.log.outcome}.`)
          }
        />
      )}
      {dialog?.kind === "clinic" && (
        <ClinicResultDialog
          appointmentId={dialog.appointmentId}
          onClose={() => setDialog(null)}
          onSaved={(text) => done(text)}
        />
      )}
      {dialog?.kind === "handoff" && (
        <HandoffByIdDialog
          leadId={dialog.leadId}
          handoffId={dialog.handoffId}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={() => done("Aktarım güncellendi.")}
        />
      )}
    </CrmShell>
  );
}

function WorkRow({ index, item, onOpen }: { index: number; item: WorkItemJson; onOpen: (d: Dialog) => void }) {
  const name = item.lead?.full_name ?? item.patient?.full_name ?? "Hasta";
  const href = item.lead ? `/crm/leads/${item.lead.id}` : item.patient ? `/patients/${item.patient.id}` : null;
  const phone = item.lead?.phone ?? item.patient?.phone ?? "";
  const who =
    item.call?.caller_name ?? item.appointment?.doctor_name ?? item.lead?.assigned_name ?? "Sorumlu atanmadı";
  const isCall = item.type === "call_overdue" || item.type === "call_today" || item.type === "future_call";
  const isHandoff = item.type === "handoff" || item.type === "future_handoff";
  const isClinic = item.type === "clinic_result" || item.type === "clinic_today";

  let button: React.ReactNode = null;
  if (isCall && item.call && item.lead) {
    const call = item.call;
    const lead = item.lead;
    button = (
      <div className="flex flex-col gap-1 items-end">
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => onOpen({ kind: "call", leadId: lead.id, callId: call.id })}
        >
          Sonucu kaydet
        </button>
        <button
          type="button"
          className="text-xs text-blue-700 underline"
          onClick={() =>
            onOpen({
              kind: "reschedule",
              call: {
                id: call.id,
                version: call.version,
                lead_name: lead.full_name,
                date: item.due_date ?? "",
                time: item.due_time ?? "",
                caller_user_id: call.caller_user_id,
                caller_name: call.caller_name,
              },
            })
          }
        >
          Planı değiştir
        </button>
      </div>
    );
  } else if (item.type === "reminder" && item.appointment) {
    const appointmentId = item.appointment.id;
    button = (
      <button type="button" className={buttonSecondary} onClick={() => onOpen({ kind: "reminder", appointmentId })}>
        Hatırlatmayı kaydet
      </button>
    );
  } else if (isHandoff && item.handoff_id && item.lead) {
    const leadId = item.lead.id;
    const handoffId = item.handoff_id;
    button = (
      <button type="button" className={buttonSecondary} onClick={() => onOpen({ kind: "handoff", leadId, handoffId })}>
        Görevi aç
      </button>
    );
  } else if (isClinic && item.appointment) {
    const appointmentId = item.appointment.id;
    button = (
      <button type="button" className={buttonSecondary} onClick={() => onOpen({ kind: "clinic", appointmentId })}>
        Randevu sonucu
      </button>
    );
  } else if (href) {
    button = (
      <Link href={href} className={buttonSecondary}>
        Hasta kartını aç
      </Link>
    );
  }

  return (
    <li className="flex gap-3 px-3 py-3">
      <span className="w-6 text-right text-sm text-gray-400 tabular-nums">{index}</span>
      <div className="flex-1 min-w-0">
        <span className={`text-sm font-medium ${item.priority <= 1 ? "text-red-700" : "text-gray-600"}`}>
          {item.reason}
        </span>
        <h3 className="font-semibold flex flex-wrap items-center gap-2">
          {href ? (
            <Link href={href} className="text-blue-700 hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
          {item.lead && <InterestBadge interest={item.lead.interest} />}
          {item.type === "reminder" && item.appointment?.reminder_current && item.appointment.reminder_outcome && (
            <span className="text-xs text-amber-700">
              Son deneme: {REMINDER_OUTCOME_LABELS[item.appointment.reminder_outcome]}
            </span>
          )}
        </h3>
        <p className="text-sm text-gray-800 whitespace-pre-line">{item.action}</p>
        <p className="text-xs text-gray-500">
          {phone} · {who} · {dayTimeLabel(item.due_date, item.due_time)}
        </p>
      </div>
      <div className="shrink-0">{button}</div>
    </li>
  );
}
