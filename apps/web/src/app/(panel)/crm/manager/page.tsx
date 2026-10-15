"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TaskDialog } from "@/components/crm/TaskDialog";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  Card,
  CrmErrorBox,
  CrmModal,
  CrmShell,
  EmptyState,
  Loading,
  Notice,
  Pager,
  StageBadge,
  SuccessBox,
  useCanManageCrm,
} from "@/components/crm/ui";
import {
  changeLabel,
  crmFollowupInsights,
  crmManagerSummary,
  crmSummaryLeads,
  dayTimeLabel,
  durationLabel,
  rate,
  toCrmError,
  type CrmError,
  type InsightsJson,
  type ManagerSummaryJson,
  type SummaryLeadRow,
  type SummaryList,
} from "@/lib/crm";
import { sourceLabel } from "@/lib/crm/codes";

const LIST_TITLES: Record<SummaryList, string> = {
  cohort_total: "Yeni başvurular",
  cohort_booked: "Randevulu hastalar",
  cohort_won: "Tedavisi başlayanlar",
  previous_cohort_total: "Önceki dönem başvuruları",
  previous_cohort_booked: "Önceki dönem randevulu hastalar",
  previous_cohort_won: "Önceki dönem tedavisi başlayanlar",
  today_calls: "Bugün aranacak hastalar",
  missing_plan: "Takip planı eksik hastalar",
  reminders: "Randevu hatırlatması bekleyenler",
  waiting: "İlk arama bekleyenler",
  late_first: "İlk araması geciken",
  stalled: "Aynı aşamada bekleyenler",
  offers: "Teklif yanıtı bekleyenler",
  review: "Takip kararı bekleyenler",
  unknown_stage: "Aşama başlangıcı bilinmeyenler",
};

interface Drill {
  list: SummaryList;
  days?: number;
  source?: string | null;
  label?: string;
}

/** Owner overview (MS, MSU, FI): workload, cohort conversion and follow-up speed. CRM managers only. */
export default function CrmManagerPage() {
  const canManage = useCanManageCrm();
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [summary, setSummary] = useState<ManagerSummaryJson | null>(null);
  const [insights, setInsights] = useState<InsightsJson | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      const [s, i] = await Promise.all([crmManagerSummary({ p_days: days }), crmFollowupInsights()]);
      setSummary(s);
      setInsights(i);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, [days, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canManage) {
    return (
      <CrmShell title="Yönetici özeti">
        <Notice tone="info">Bu bölüm CRM yöneticilerine açıktır.</Notice>
      </CrmShell>
    );
  }

  const Num = ({ value, d }: { value: number; d: Drill }) => (
    <button type="button" className="text-2xl font-bold text-blue-700 hover:underline" onClick={() => setDrill(d)}>
      {value}
    </button>
  );

  return (
    <CrmShell title="Yönetici özeti" subtitle="Bugünkü iş yükü, dönem dönüşümleri ve takip hızı.">
      <div className="space-y-4">
        <CrmErrorBox error={error} />
        {!summary || !insights ? (
          !error && <Loading />
        ) : (
          <>
            <Card title="Bugünkü takip">
              <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
                <div>
                  <div className="text-sm text-gray-600">Geciken iş</div>
                  <Link href="/crm/today" className="text-2xl font-bold text-blue-700 hover:underline">
                    {summary.workload.overdue_items}
                  </Link>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Bugün aranacak hasta</div>
                  <Num value={summary.workload.today_call_patients} d={{ list: "today_calls" }} />
                </div>
                <div>
                  <div className="text-sm text-gray-600">Takip planı eksik</div>
                  <Num value={summary.workload.missing_plan_patients} d={{ list: "missing_plan" }} />
                </div>
                <div>
                  <div className="text-sm text-gray-600">Randevu hatırlatması (hasta adayı)</div>
                  <Num value={summary.workload.reminder_patients} d={{ list: "reminders" }} />
                  {summary.workload.reminder_items > summary.workload.reminder_patients && (
                    <div className="text-xs text-gray-500">
                      Toplam {summary.workload.reminder_items} randevu hatırlatması
                    </div>
                  )}
                </div>
              </div>
            </Card>

            <Card
              title="Dönem dönüşümü"
              actions={
                <div className="flex gap-1" role="group" aria-label="Dönem">
                  {([1, 7, 30] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={days === d}
                      onClick={() => setDays(d)}
                      className={`px-3 py-1 rounded text-sm ${days === d ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                    >
                      {d === 1 ? "Bugün" : `Son ${d} gün`}
                    </button>
                  ))}
                </div>
              }
            >
              <p className="text-sm text-gray-600 mb-3">
                {dayTimeLabel(summary.cohort.start)} – {dayTimeLabel(summary.cohort.end)} (önceki dönem:{" "}
                {dayTimeLabel(summary.cohort.previous_start)} – {dayTimeLabel(summary.cohort.previous_end)}). Arşivlenen
                adaylar dahil; aramalar randevu sayılmaz.
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                {(
                  [
                    { key: "total", label: "Başvuru", list: "cohort_total", prevList: "previous_cohort_total" },
                    { key: "booked", label: "Randevulu", list: "cohort_booked", prevList: "previous_cohort_booked" },
                    { key: "won", label: "Tedavi başladı", list: "cohort_won", prevList: "previous_cohort_won" },
                  ] as const
                ).map((m) => (
                  <div key={m.key} className="p-3 rounded border">
                    <div className="text-sm text-gray-600">{m.label}</div>
                    <Num value={summary.cohort.current[m.key]} d={{ list: m.list, days }} />
                    {m.key !== "total" && (
                      <span className="ml-2 text-sm text-gray-600">
                        {rate(summary.cohort.current[m.key], summary.cohort.current.total)}
                      </span>
                    )}
                    <div className="text-xs text-gray-500 mt-1">
                      Önceki:{" "}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => setDrill({ list: m.prevList, days })}
                      >
                        {summary.cohort.previous[m.key]}
                      </button>{" "}
                      · {changeLabel(summary.cohort.current[m.key], summary.cohort.previous[m.key])}
                    </div>
                  </div>
                ))}
              </div>
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="text-left border-b text-gray-600">
                    <th className="py-2">Kaynak</th>
                    <th className="py-2 text-right">Başvuru</th>
                    <th className="py-2 text-right">Randevulu</th>
                    <th className="py-2 text-right">Tedavi başladı</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.cohort.by_source.map((s) => (
                    <tr key={s.source ?? "none"} className="border-b last:border-b-0">
                      <td className="py-2">{sourceLabel(s.source)}</td>
                      {(["total", "booked", "won"] as const).map((k) => (
                        <td key={k} className="py-2 text-right tabular-nums">
                          <button
                            type="button"
                            className="text-blue-700 hover:underline disabled:text-gray-400 disabled:no-underline"
                            disabled={s[k] === 0}
                            onClick={() =>
                              setDrill({
                                list: k === "total" ? "cohort_total" : k === "booked" ? "cohort_booked" : "cohort_won",
                                days,
                                source: s.source,
                                label: sourceLabel(s.source),
                              })
                            }
                          >
                            {s[k]}
                          </button>
                          {k !== "total" && <span className="text-xs text-gray-500"> {rate(s[k], s.total)}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card title="Takip hızı ve bekleyen kararlar">
              <p className="text-sm text-gray-600 mb-3">
                Süreler takip kurallarındaki çalışma günleri ve arama saatlerine göre hesaplanır. Son 30 gün:{" "}
                {dayTimeLabel(insights.window_start)} – {dayTimeLabel(insights.today)}.
              </p>
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
                {(
                  [
                    { key: "waiting", label: "İlk arama bekleyen" },
                    { key: "late_first", label: "İlk araması geciken" },
                    { key: "stalled", label: "Aynı aşamada bekleyen" },
                    { key: "offers", label: "Teklif yanıtı bekleyen" },
                    { key: "review", label: "Takip kararı bekleyen" },
                    { key: "unknown_stage", label: "Aşama başlangıcı bilinmiyor" },
                  ] as const
                ).map((m) => (
                  <div key={m.key} className="p-3 rounded border">
                    <div className="text-sm text-gray-600">{m.label}</div>
                    <Num value={insights.counts[m.key]} d={{ list: m.key }} />
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2 text-sm">
                <div className="p-3 rounded bg-gray-50">
                  <div className="text-gray-600">İlk arama denemesine kadar (medyan)</div>
                  <div className="text-xl font-semibold">{durationLabel(insights.first_attempt.median_minutes)}</div>
                  <div className="text-xs text-gray-500">
                    {insights.first_attempt.sample} hasta
                    {insights.first_attempt.excluded_legacy > 0
                      ? ` · ${insights.first_attempt.excluded_legacy} eski kayıt sonuç zamanı olmadığı için hariç`
                      : ""}
                  </div>
                </div>
                <div className="p-3 rounded bg-gray-50">
                  <div className="text-gray-600">İlk görüşmeye kadar (medyan)</div>
                  <div className="text-xl font-semibold">{durationLabel(insights.first_reached.median_minutes)}</div>
                  <div className="text-xs text-gray-500">{insights.first_reached.sample} hasta</div>
                </div>
              </div>
            </Card>
          </>
        )}
      </div>

      {drill && <DrillDialog drill={drill} onClose={() => setDrill(null)} />}
    </CrmShell>
  );
}

const PAGE = 50;

/** Drill-down list (PL): the leads behind a number; "Görev yaz" per row (PL:10-11, generalised). */
function DrillDialog({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const staff = useStaff();
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<SummaryLeadRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<CrmError | null>(null);
  const [taskFor, setTaskFor] = useState<SummaryLeadRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const title = LIST_TITLES[drill.list] + (drill.label ? ` · ${drill.label}` : "");

  const load = useCallback(async () => {
    try {
      const r = await crmSummaryLeads({
        p_list: drill.list,
        p_days: drill.days ?? null,
        p_source: drill.source ?? null,
        p_page: { offset, limit: PAGE },
      });
      setRows(r.rows);
      setTotal(r.total_count);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
      setRows([]);
    }
  }, [drill, offset]);

  useEffect(() => {
    load();
  }, [load]);

  if (taskFor) {
    return (
      <TaskDialog
        staff={staff}
        defaults={{ title: `${LIST_TITLES[drill.list]}: ${taskFor.full_name}`, lead_id: taskFor.id, lead_name: taskFor.full_name }}
        onClose={() => setTaskFor(null)}
        onSaved={() => {
          setTaskFor(null);
          setMessage("Görev oluşturuldu.");
          load();
        }}
      />
    );
  }

  return (
    <CrmModal title={title} description={`${total} hasta`} onClose={onClose} wide>
      <div className="space-y-3">
        <SuccessBox text={message} />
        <CrmErrorBox error={error} />
        {!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState>Listede hasta yok.</EmptyState>
        ) : (
          <ul className="divide-y border rounded text-sm">
            {rows.map((r) => (
              <li key={r.id} className="px-3 py-2 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link href={`/crm/leads/${r.id}`} className="font-medium text-blue-700 hover:underline">
                    {r.full_name}
                  </Link>{" "}
                  <StageBadge stage={r.stage} />
                  <p className="text-xs text-gray-600">
                    {r.phone} · {sourceLabel(r.source)} · {r.assigned_name ?? "Sorumlu yok"}
                  </p>
                  <p className="text-xs text-gray-600">
                    {r.next_action || "Sonraki adım yok"} · {dayTimeLabel(r.followup_date)}
                    {r.open_task_count > 0 ? ` · ${r.open_task_count} açık görev` : ""}
                  </p>
                </div>
                <button type="button" className="text-xs text-blue-700 underline" onClick={() => setTaskFor(r)}>
                  Görev yaz
                </button>
              </li>
            ))}
          </ul>
        )}
        <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />
      </div>
    </CrmModal>
  );
}
