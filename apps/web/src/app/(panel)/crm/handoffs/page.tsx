"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { HandoffDialog, type HandoffMode } from "@/components/crm/HandoffDialog";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  Badge,
  CrmErrorBox,
  CrmShell,
  EmptyState,
  Loading,
  Pager,
  SuccessBox,
  buttonSecondary,
  useCanManageCrm,
} from "@/components/crm/ui";
import {
  crmHandoffList,
  dayTimeLabel,
  formatDateTime,
  toCrmError,
  type CrmError,
  type HandoffJson,
} from "@/lib/crm";
import {
  HANDOFF_STATUS_LABELS,
  HANDOFF_STATUS_STYLES,
  HANDOFF_STATUS_TABS,
  HANDOFF_TOPIC_LABELS,
  type HandoffStatus,
} from "@/lib/crm/codes";

const PAGE = 50;

/** Handoff inbox (HI): managers start on "Karar bekleyen", everyone else on "Yapılacak işler". */
export default function HandoffsPage() {
  const canManage = useCanManageCrm();
  const staff = useStaff();
  const [status, setStatus] = useState<HandoffStatus>(canManage ? "waiting" : "answered");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<HandoffJson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<HandoffStatus, number> | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [dialog, setDialog] = useState<{ mode: HandoffMode; handoff: HandoffJson } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await crmHandoffList({ p_status: status, p_page: { offset, limit: PAGE } });
      setRows(r.rows);
      setTotal(r.total_count);
      setCounts(r.counts);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
      setRows([]);
    }
  }, [status, offset]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <CrmShell
      title="Aktarımlar"
      subtitle="Yöneticiye aktarılan sorular ve yöneticinin verdiği görevler. Aktarımlar arama, aşama veya takibi değiştirmez."
    >
      <div className="space-y-4">
        <SuccessBox text={message} />
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Aktarım durumu">
          {HANDOFF_STATUS_TABS.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={status === t.value}
              onClick={() => {
                setStatus(t.value);
                setOffset(0);
              }}
              className={`px-3 py-1.5 rounded text-sm flex items-center gap-2 ${
                status === t.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"
              }`}
            >
              {t.label}
              <span className={`px-1.5 rounded text-xs ${status === t.value ? "bg-white/20" : "bg-white"}`}>
                {counts ? counts[t.value] : "–"}
              </span>
            </button>
          ))}
        </div>
        <CrmErrorBox error={error} onReload={load} />
        {!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-lg shadow">
            <EmptyState>Bu durumda aktarım yok.</EmptyState>
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((h) => (
              <li key={h.id} className="bg-white rounded-lg shadow p-4 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/crm/leads/${h.lead_id}`} className="font-semibold text-blue-700 hover:underline">
                    {h.lead_name ?? "Hasta"}
                  </Link>
                  <Badge className="bg-gray-100 text-gray-800">{HANDOFF_TOPIC_LABELS[h.topic] ?? h.topic}</Badge>
                  <Badge className={HANDOFF_STATUS_STYLES[h.status]}>{HANDOFF_STATUS_LABELS[h.status]}</Badge>
                  {h.answer_due_date && (
                    <span className="text-xs text-gray-600">Görev tarihi: {dayTimeLabel(h.answer_due_date)}</span>
                  )}
                </div>
                <p className="whitespace-pre-line">{h.question}</p>
                <p className="text-xs text-gray-500">
                  {h.requested_by_name ?? "Kullanıcı bilinmiyor"} · {formatDateTime(h.requested_at)}
                </p>
                {h.answer_text && (
                  <div className="p-2 rounded bg-blue-50">
                    <b>Yapılacak iş{h.answer_assignee_name ? ` (${h.answer_assignee_name})` : ""}:</b>{" "}
                    <span className="whitespace-pre-line">{h.answer_text}</span>
                    <p className="text-xs text-gray-500">
                      {h.answered_by_name ?? "Yönetici"} · {formatDateTime(h.answered_at)}
                    </p>
                  </div>
                )}
                {h.private_note !== undefined && h.private_note && (
                  <div className="p-2 rounded bg-purple-50 text-purple-900">
                    <b>Özel yönetici notu:</b> {h.private_note}
                  </div>
                )}
                {h.completion_text && (
                  <p>
                    <b>{h.status === "completed" ? "Sonuç" : "Geri çekme nedeni"}:</b> {h.completion_text}
                    <span className="text-xs text-gray-500">
                      {" "}
                      · {h.system_closed ? "Sistem" : (h.completed_by_name ?? "")} · {formatDateTime(h.completed_at)}
                    </span>
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {canManage && (h.status === "waiting" || h.status === "answered") && (
                    <button type="button" className={buttonSecondary} onClick={() => setDialog({ mode: "answer", handoff: h })}>
                      {h.status === "answered" ? "Yanıtı düzenle" : "Yanıtla"}
                    </button>
                  )}
                  {h.status === "answered" && (
                    <button type="button" className={buttonSecondary} onClick={() => setDialog({ mode: "complete", handoff: h })}>
                      Tamamla
                    </button>
                  )}
                  {h.status === "waiting" && (
                    <button type="button" className={buttonSecondary} onClick={() => setDialog({ mode: "cancel", handoff: h })}>
                      Geri çek
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />
      </div>

      {dialog && (
        <HandoffDialog
          mode={dialog.mode}
          handoff={dialog.handoff}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setMessage("Aktarım güncellendi.");
            load();
          }}
        />
      )}
    </CrmShell>
  );
}
