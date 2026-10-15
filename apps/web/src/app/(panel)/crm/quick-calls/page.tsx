"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { CallResultForm } from "@/components/crm/CallResultForm";
import {
  CrmErrorBox,
  CrmShell,
  Loading,
  Notice,
  StageBadge,
  buttonPrimary,
  buttonSecondary,
} from "@/components/crm/ui";
import {
  crmLeadDetail,
  crmWorkList,
  dayTimeLabel,
  formatDateTime,
  telHref,
  toCrmError,
  UUID_RE,
  type CrmError,
  type LeadDetailJson,
} from "@/lib/crm";
import { WORK_FILTERS, isWorkFilter, sourceLabel, type WorkFilter } from "@/lib/crm/codes";

export default function QuickCallsPage() {
  return (
    <CrmShell title="Hızlı arama" subtitle="Aramaları sırayla tamamla: son not, sonuç ve sonraki adım aynı ekranda.">
      <Suspense fallback={<Loading />}>
        <QuickCalls />
      </Suspense>
    </CrmShell>
  );
}

function QuickCalls() {
  const router = useRouter();
  const params = useSearchParams();
  const rawFilter = params.get("filter");
  const filter: WorkFilter = isWorkFilter(rawFilter) && rawFilter !== "future" ? rawFilter : "all";
  const rawUser = params.get("user");
  const userId = rawUser && UUID_RE.test(rawUser) ? rawUser : null;

  // The queue is frozen at start (D-AF): calls created during the session are not added.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [queueError, setQueueError] = useState<CrmError | null>(null);
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    let cancelled = false;
    crmWorkList({ p_filter: filter, p_user_id: userId, p_page: { offset: 0, limit: 1 } })
      .then((r) => {
        if (!cancelled) setQueue(r.quick_call_lead_ids);
      })
      .catch((err) => {
        if (!cancelled) setQueueError(toCrmError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filter, userId]);

  if (queueError) return <CrmErrorBox error={queueError} />;
  if (!queue) return <Loading />;

  const filterLabel = WORK_FILTERS.find((f) => f.value === filter)?.label ?? "";
  const leadId = queue[index];

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-gray-600">
        Liste: {filterLabel} · {Math.min(index + 1, queue.length)} / {queue.length} hasta · {saved} sonuç kaydedildi
      </p>
      {leadId ? (
        <QuickCall
          key={leadId}
          leadId={leadId}
          onSaved={() => {
            setSaved((n) => n + 1);
            setIndex((n) => n + 1);
          }}
          onSkip={() => setIndex((n) => n + 1)}
          onClose={() => router.push("/crm/today")}
        />
      ) : (
        <div className="bg-white rounded-lg shadow p-6 space-y-3">
          <h2 className="text-lg font-semibold">
            {queue.length ? "Bu arama listesini tamamladın." : "Bu listede hızlı aranacak hasta yok."}
          </h2>
          <p className="text-sm text-gray-700">
            {saved} hastanın arama sonucu kaydedildi. Atladığın hastalar iş listesinde kalır.
          </p>
          <Link href="/crm/today" className={buttonPrimary}>
            İş listesine dön
          </Link>
        </div>
      )}
    </div>
  );
}

function QuickCall({
  leadId,
  onSaved,
  onSkip,
  onClose,
}: {
  leadId: string;
  onSaved: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
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
    window.scrollTo({ top: 0 });
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // QC: leaving with a typed note asks first; nothing is saved without the button.
  const leave = (action: () => void) => {
    if (dirty && !confirm("Kaydedilmemiş görüşme notu var. Devam edersen bu formdaki not kaydedilmeyecek.")) return;
    action();
  };

  if (!detail) {
    return (
      <div className="bg-white rounded-lg shadow p-6 space-y-3">
        {error ? <CrmErrorBox error={error} onReload={load} /> : <Loading />}
        {error && (
          <button type="button" className={buttonSecondary} onClick={onSkip}>
            Şimdilik atla
          </button>
        )}
      </div>
    );
  }

  const lead = detail.lead;
  const call = detail.due_call;
  const hasScheduledVisit = detail.appointments.some((a) => a.status === "scheduled");
  // QC:25: no save when the follow-up is closed, the patient refuses calls, or a clinic visit is planned.
  const blocked = !!lead.deleted_at || !lead.is_open || lead.do_not_contact || hasScheduledVisit;

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="text-xs uppercase text-gray-500">
            {lead.treatment_interest || sourceLabel(lead.source)}
          </span>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            {lead.full_name} <StageBadge stage={lead.stage} />
          </h2>
          <a href={telHref(lead.phone)} className="text-lg text-blue-700 underline">
            {lead.phone}
          </a>
        </div>
        <button
          type="button"
          className="text-sm text-blue-700 underline"
          onClick={() => leave(() => router.push(`/crm/leads/${lead.id}`))}
        >
          Hasta kartını aç
        </button>
      </div>

      <div className="p-3 rounded bg-gray-50 space-y-2 text-sm">
        <b>{lead.next_action || "Hastayla görüş ve sonucunu kaydet"}</b>
        <p>
          {call
            ? `Planlanan arama: ${dayTimeLabel(call.date, call.time)}`
            : "Bu görüşme yeni bir arama sonucu olarak kaydedilecek."}
        </p>
        {detail.last_notes.length ? (
          detail.last_notes.map((n, i) => (
            <article key={i} className="border-t pt-2">
              <p className="whitespace-pre-line">{n.text}</p>
              <small className="text-gray-500">
                {n.actor_name ?? "Kullanıcı bilinmiyor"} · {formatDateTime(n.at)}
              </small>
            </article>
          ))
        ) : (
          <p className="text-gray-600">{lead.notes_legacy || "Önceki görüşme notu yok."}</p>
        )}
      </div>

      {blocked ? (
        <>
          <Notice tone="warn">
            Hastanın takibi kapanmış veya klinik randevusu var. Güncel durumu hasta kartından kontrol et.
          </Notice>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonSecondary} onClick={onClose}>
              Kapat
            </button>
            <button type="button" className={buttonSecondary} onClick={onSkip}>
              Şimdilik atla
            </button>
          </div>
        </>
      ) : (
        <CallResultForm
          lead={lead}
          call={call}
          rules={detail.rules}
          onDirtyChange={setDirty}
          onReload={load}
          onSaved={onSaved}
          submitLabel="Kaydet ve sıradaki hasta"
          extraButtons={
            <>
              <button type="button" className={buttonSecondary} onClick={() => leave(onClose)}>
                Kapat
              </button>
              <button type="button" className={buttonSecondary} onClick={() => leave(onSkip)}>
                Şimdilik atla
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
