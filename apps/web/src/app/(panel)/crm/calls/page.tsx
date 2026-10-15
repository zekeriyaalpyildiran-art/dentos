"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CallResultDialog,
  PlanCallDialog,
  RescheduleCallDialog,
  resolveMessage,
  type ReschedulableCall,
} from "@/components/crm/CallDialogs";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  Badge,
  CrmShell,
  EmptyState,
  Loading,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import {
  addDays,
  crmLeadDetail,
  dayTimeLabel,
  hhmm,
  istanbulToday,
  longDayLabel,
  UUID_RE,
  type LeadJson,
} from "@/lib/crm";
import {
  CALL_ORIGIN_LABELS,
  CALL_STATUS_LABELS,
  CALL_STATUS_STYLES,
  type CallOrigin,
  type CallStatus,
  type Interest,
  type Stage,
} from "@/lib/crm/codes";

interface AgendaCall {
  id: string;
  version: number;
  lead_id: string;
  caller_user_id: string | null;
  caller_name_legacy: string | null;
  scheduled_date: string;
  scheduled_time: string;
  status: CallStatus;
  origin: CallOrigin;
  auto_cancelled: boolean;
  lead: { id: string; full_name: string; phone: string; interest: Interest; stage: Stage } | null;
  caller: { full_name: string | null } | null;
}

/** 09:00–23:30 in 30-minute slots (legacy agenda), plus any off-grid times present that day. */
const GRID: string[] = Array.from({ length: 30 }, (_, i) => {
  const minutes = 9 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

type Dialog =
  | { kind: "result"; leadId: string; callId: string }
  | { kind: "reschedule"; call: ReschedulableCall; initial?: { date?: string; time?: string; caller_user_id?: string | null } }
  | { kind: "plan"; lead: LeadJson | null; time?: string; caller?: string | null };

export default function CallsAgendaPage() {
  return (
    <CrmShell title="Arama planı" subtitle="Günlük arama ajandası; arayan kişiye göre sütunlar.">
      <Suspense fallback={<Loading />}>
        <Agenda />
      </Suspense>
    </CrmShell>
  );
}

function Agenda() {
  const router = useRouter();
  const params = useSearchParams();
  const clinicId = useAuthStore((s) => s.user?.clinic_id);
  const staff = useStaff();
  const [day, setDay] = useState(istanbulToday);
  const [callerFilter, setCallerFilter] = useState("");
  const [calls, setCalls] = useState<AgendaCall[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragged, setDragged] = useState<AgendaCall | null>(null);

  const load = useCallback(async () => {
    if (!clinicId) return;
    let q = createClient()
      .from("crm_calls")
      .select(
        "id,version,lead_id,caller_user_id,caller_name_legacy,scheduled_date,scheduled_time,status,origin,auto_cancelled,lead:leads(id,full_name,phone,interest,stage),caller:users!crm_calls_caller_user_id_fkey(full_name)"
      )
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", day)
      .order("scheduled_time");
    if (callerFilter) q = q.eq("caller_user_id", callerFilter);
    const { data, error } = await q;
    if (error) {
      console.error("Error fetching calls:", error);
      setLoadError("Arama planı yüklenemedi.");
      setCalls([]);
      return;
    }
    setLoadError(null);
    setCalls((data || []) as unknown as AgendaCall[]);
  }, [clinicId, day, callerFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // /crm/calls?plan=<lead id>: a new lead saved without a call lands here with the plan form open.
  const planParam = params.get("plan");
  const handledPlan = useRef<string | null>(null);
  useEffect(() => {
    if (!planParam || !UUID_RE.test(planParam) || handledPlan.current === planParam) return;
    handledPlan.current = planParam;
    crmLeadDetail({ p_lead_id: planParam })
      .then((d) => {
        if (!d.lead.deleted_at) setDialog({ kind: "plan", lead: d.lead });
      })
      .catch(() => undefined);
    router.replace("/crm/calls");
  }, [planParam, router]);

  const columns = useMemo(() => {
    const map = new Map<string, { key: string; callerId: string | null; name: string }>();
    if (callerFilter) {
      map.set(callerFilter, {
        key: callerFilter,
        callerId: callerFilter,
        name: staff.find((s) => s.id === callerFilter)?.full_name ?? "Arayan",
      });
    }
    for (const c of calls ?? []) {
      const key = c.caller_user_id ?? `legacy:${c.caller_name_legacy ?? ""}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          callerId: c.caller_user_id,
          name: c.caller?.full_name ?? c.caller_name_legacy ?? "Arayan bilinmiyor",
        });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }, [calls, callerFilter, staff]);

  const slots = useMemo(() => {
    const set = new Set(GRID);
    for (const c of calls ?? []) set.add(hhmm(c.scheduled_time));
    return [...set].sort();
  }, [calls]);

  const toReschedulable = (c: AgendaCall): ReschedulableCall => ({
    id: c.id,
    version: c.version,
    lead_name: c.lead?.full_name ?? null,
    date: c.scheduled_date,
    time: hhmm(c.scheduled_time),
    caller_user_id: c.caller_user_id,
    caller_name: c.caller?.full_name ?? c.caller_name_legacy,
  });

  const drop = (slot: string, callerId: string | null) => {
    const c = dragged;
    setDragged(null);
    if (!c || c.status !== "planned" || !callerId) return;
    if (slot === hhmm(c.scheduled_time) && callerId === c.caller_user_id) return;
    setDialog({ kind: "reschedule", call: toReschedulable(c), initial: { date: day, time: slot, caller_user_id: callerId } });
  };

  const done = (text: string) => {
    setDialog(null);
    setMessage(text);
    load();
  };

  const today = istanbulToday();
  const planned = (calls ?? []).filter((c) => c.status === "planned").length;

  return (
    <div className="space-y-4">
      <SuccessBox text={message} />
      <div className="flex flex-wrap items-end gap-3">
        <button type="button" className={buttonSecondary} onClick={() => setDay((d) => addDays(d, -1))}>
          ← Önceki gün
        </button>
        <input
          type="date"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className={`${inputClass} w-44`}
          aria-label="Gün"
        />
        <button type="button" className={buttonSecondary} onClick={() => setDay((d) => addDays(d, 1))}>
          Sonraki gün →
        </button>
        {day !== today && (
          <button type="button" className={buttonSecondary} onClick={() => setDay(today)}>
            Bugün
          </button>
        )}
        <select
          aria-label="Arayan kişi"
          value={callerFilter}
          onChange={(e) => setCallerFilter(e.target.value)}
          className={`${inputClass} w-52`}
        >
          <option value="">Tüm arayanlar</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`${buttonPrimary} ml-auto`}
          onClick={() => setDialog({ kind: "plan", lead: null, caller: callerFilter || null })}
        >
          + Yeni arama
        </button>
      </div>

      <p className="text-sm text-gray-600">
        {longDayLabel(day)} · {calls?.length ?? 0} arama · {planned} planlı. Planlı bir aramayı başka bir saate veya
        arayana sürükleyerek taşıyabilirsin; tarih veya saat değişirse neden sorulur.
      </p>
      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {!calls ? (
        <Loading />
      ) : columns.length === 0 ? (
        <div className="bg-white rounded-lg shadow">
          <EmptyState>Bu gün için arama planı yok.</EmptyState>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="w-16 px-2 py-2 text-left text-gray-600 font-medium border-b">Saat</th>
                {columns.map((col) => (
                  <th key={col.key} className="min-w-[14rem] px-2 py-2 text-left font-semibold border-b border-l">
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slots.map((slot) => (
                <tr key={slot} className="align-top">
                  <td className={`px-2 py-1 border-b text-gray-500 tabular-nums ${GRID.includes(slot) ? "" : "italic"}`}>
                    {slot}
                  </td>
                  {columns.map((col) => {
                    const here = (calls ?? []).filter(
                      (c) =>
                        hhmm(c.scheduled_time) === slot &&
                        (c.caller_user_id ?? `legacy:${c.caller_name_legacy ?? ""}`) === col.key
                    );
                    return (
                      <td
                        key={col.key}
                        className={`px-1 py-1 border-b border-l h-10 ${dragged && col.callerId ? "bg-blue-50/40" : ""}`}
                        onDragOver={(e) => {
                          if (dragged && col.callerId) e.preventDefault();
                        }}
                        onDrop={() => drop(slot, col.callerId)}
                      >
                        {here.map((c) => (
                          <CallCard
                            key={c.id}
                            call={c}
                            onDragStart={() => setDragged(c)}
                            onDragEnd={() => setDragged(null)}
                            onResult={() => setDialog({ kind: "result", leadId: c.lead_id, callId: c.id })}
                            onReschedule={() => setDialog({ kind: "reschedule", call: toReschedulable(c) })}
                          />
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === "result" && (
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
          initial={dialog.initial}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={(c) => done(`Arama planı güncellendi: ${dayTimeLabel(c.date, c.time)}.`)}
        />
      )}
      {dialog?.kind === "plan" && (
        <PlanCallDialog
          lead={dialog.lead}
          staff={staff}
          defaultDate={day}
          defaultCaller={dialog.caller}
          onClose={() => setDialog(null)}
          onSaved={(c) => {
            if (c.date !== day) setDay(c.date);
            done(`Arama planlandı: ${dayTimeLabel(c.date, c.time)}.`);
          }}
        />
      )}
    </div>
  );
}

function CallCard({
  call,
  onDragStart,
  onDragEnd,
  onResult,
  onReschedule,
}: {
  call: AgendaCall;
  onDragStart: () => void;
  onDragEnd: () => void;
  onResult: () => void;
  onReschedule: () => void;
}) {
  const planned = call.status === "planned";
  return (
    <div
      draggable={planned}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`mb-1 p-2 rounded border ${planned ? "bg-white cursor-move hover:shadow" : "bg-gray-50"}`}
    >
      <div className="flex items-center justify-between gap-2">
        {call.lead ? (
          <Link href={`/crm/leads/${call.lead.id}`} className="font-medium text-blue-700 hover:underline truncate">
            {call.lead.full_name}
          </Link>
        ) : (
          <span className="font-medium">Hasta</span>
        )}
        <span className="text-xs text-gray-500 tabular-nums">{hhmm(call.scheduled_time)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge className={CALL_STATUS_STYLES[call.status]}>{CALL_STATUS_LABELS[call.status]}</Badge>
        {call.origin === "automatic" && <Badge className="bg-purple-100 text-purple-800">{CALL_ORIGIN_LABELS.automatic}</Badge>}
        {call.auto_cancelled && <Badge className="bg-gray-100 text-gray-600">Sistem iptali</Badge>}
      </div>
      {call.lead?.phone && <p className="text-xs text-gray-600 mt-1">{call.lead.phone}</p>}
      {planned && (
        <div className="mt-1 flex gap-3 text-xs">
          <button type="button" className="text-blue-700 underline" onClick={onResult}>
            Sonuç
          </button>
          <button type="button" className="text-blue-700 underline" onClick={onReschedule}>
            Değiştir
          </button>
        </div>
      )}
    </div>
  );
}
