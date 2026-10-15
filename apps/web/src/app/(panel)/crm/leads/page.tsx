"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  CrmErrorBox,
  CrmShell,
  EmptyState,
  InterestBadge,
  Loading,
  Pager,
  StageBadge,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import {
  crmLeadList,
  dayTimeLabel,
  toCrmError,
  type CrmError,
  type LeadJson,
  type LeadListFilters,
} from "@/lib/crm";
import { INTERESTS, SOURCES, STAGES, sourceLabel, type Interest, type Stage } from "@/lib/crm/codes";

const PAGE = 50;

/** 'Hasta adayları' (CRM:93): server-side search, filters and paging (crm_lead_list). */
export default function LeadsListPage() {
  const staff = useStaff();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<Stage | "">("");
  const [source, setSource] = useState("");
  const [interest, setInterest] = useState<Interest | "">("");
  const [assignee, setAssignee] = useState("");
  const [missingPlan, setMissingPlan] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(true);
  const [sort, setSort] = useState<NonNullable<LeadListFilters["sort"]>>("created_desc");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<LeadJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<CrmError | null>(null);

  // Debounced free-text search.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const r = await crmLeadList({
        p_filters: {
          q: query || undefined,
          stage: stage || undefined,
          source: source || undefined,
          interest: interest || undefined,
          assigned_to: assignee || undefined,
          missing_plan: missingPlan || undefined,
          include_closed: includeClosed,
          sort,
        },
        p_page: { offset, limit: PAGE },
      });
      setRows(r.rows);
      setTotal(r.total_count);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
      setRows([]);
    }
  }, [query, stage, source, interest, assignee, missingPlan, includeClosed, sort, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setOffset(0);
  };

  return (
    <CrmShell
      title="Hasta adayları"
      subtitle={`${total} kayıt`}
      actions={
        <>
          <Link href="/crm/new-lead" className={buttonPrimary}>
            Yeni aday
          </Link>
          <Link href="/crm/kanban" className={buttonSecondary}>
            Kanban
          </Link>
        </>
      }
    >
      <div className="bg-white rounded-lg shadow p-4 mb-4 grid gap-3 md:grid-cols-4">
        <input
          type="search"
          placeholder="Ad, telefon veya kampanya ile ara..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${inputClass} md:col-span-2`}
          aria-label="Ara"
        />
        <select
          aria-label="Aşama"
          value={stage}
          onChange={(e) => resetPage(setStage)(e.target.value as Stage | "")}
          className={inputClass}
        >
          <option value="">Tüm aşamalar (arşiv hariç)</option>
          {STAGES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sıralama"
          value={sort}
          onChange={(e) => resetPage(setSort)(e.target.value as NonNullable<LeadListFilters["sort"]>)}
          className={inputClass}
        >
          <option value="created_desc">En yeni başvuru</option>
          <option value="followup_asc">Takip tarihine göre</option>
          <option value="name_asc">Ada göre</option>
        </select>
        <select aria-label="Kaynak" value={source} onChange={(e) => resetPage(setSource)(e.target.value)} className={inputClass}>
          <option value="">Tüm kaynaklar</option>
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          aria-label="İlgi"
          value={interest}
          onChange={(e) => resetPage(setInterest)(e.target.value as Interest | "")}
          className={inputClass}
        >
          <option value="">Tüm ilgi durumları</option>
          {INTERESTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sorumlu"
          value={assignee}
          onChange={(e) => resetPage(setAssignee)(e.target.value)}
          className={inputClass}
        >
          <option value="">Tüm sorumlular</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </select>
        <div className="flex flex-col justify-center gap-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={missingPlan} onChange={(e) => resetPage(setMissingPlan)(e.target.checked)} />
            Yalnızca takip planı eksik
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => resetPage(setIncludeClosed)(e.target.checked)}
            />
            Olumsuz ve tamamlananları göster
          </label>
        </div>
      </div>

      <CrmErrorBox error={error} />
      {!rows ? (
        <Loading />
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr className="text-left text-gray-800">
                <th className="px-4 py-3 font-semibold">Ad soyad</th>
                <th className="px-4 py-3 font-semibold">Telefon</th>
                <th className="px-4 py-3 font-semibold">Aşama</th>
                <th className="px-4 py-3 font-semibold">Sonraki adım</th>
                <th className="px-4 py-3 font-semibold">Sıradaki arama</th>
                <th className="px-4 py-3 font-semibold">Sorumlu</th>
                <th className="px-4 py-3 font-semibold">Kaynak</th>
                <th className="px-4 py-3 font-semibold">Başvuru</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState>Aday bulunamadı</EmptyState>
                  </td>
                </tr>
              ) : (
                rows.map((lead) => (
                  <tr key={lead.id} className="border-b hover:bg-gray-50 align-top">
                    <td className="px-4 py-3">
                      <Link href={`/crm/leads/${lead.id}`} className="font-semibold text-blue-700 hover:underline">
                        {lead.full_name}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <InterestBadge interest={lead.interest} />
                        {lead.do_not_contact && (
                          <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-700">Aranmak istemiyor</span>
                        )}
                        {lead.automation_review && (
                          <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800">Karar gerekiyor</span>
                        )}
                        {lead.patient_id && (
                          <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800">Hasta</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{lead.phone}</td>
                    <td className="px-4 py-3">
                      <StageBadge stage={lead.stage} />
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {lead.followup_state === "done" ? (
                        <span className="text-gray-500">Takip tamamlandı</span>
                      ) : (
                        <>
                          <div>{lead.next_action || <span className="text-amber-700">Sonraki adım yok</span>}</div>
                          <div className="text-xs text-gray-500">{dayTimeLabel(lead.followup_date)}</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      {lead.next_call ? dayTimeLabel(lead.next_call.date, lead.next_call.time) : "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{lead.assigned_name ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-700">{sourceLabel(lead.source)}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      {new Date(lead.created_at).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="px-4 pb-4">
            <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />
          </div>
        </div>
      )}
    </CrmShell>
  );
}
