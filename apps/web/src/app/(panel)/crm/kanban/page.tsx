"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CrmErrorBox,
  CrmModal,
  CrmShell,
  Field,
  InterestBadge,
  Loading,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import {
  crmLeadList,
  crmSaveLead,
  leadToInput,
  toCrmError,
  type CrmError,
  type LeadJson,
} from "@/lib/crm";
import { LOSS_REASONS, STAGES, sourceLabel, stageLabel, type LossReason, type Stage } from "@/lib/crm/codes";

const COLUMN_LIMIT = 50;

const COLUMN_COLORS: Record<Stage, string> = {
  new: "bg-gray-100",
  in_contact: "bg-blue-50",
  appointment_booked: "bg-indigo-50",
  appointment_attended: "bg-violet-50",
  offer_given: "bg-amber-50",
  treatment_started: "bg-emerald-50",
  treatment_completed: "bg-green-50",
  lost: "bg-red-50",
  archived: "bg-gray-200",
};

interface Column {
  stage: Stage;
  rows: LeadJson[];
  total: number;
}

/** A stage change that needs more input: a loss reason (RR:70) or a note (RR:53, RR:59, RR:61). */
interface PendingMove {
  lead: LeadJson;
  to: Stage;
}

/** Stage board. A drag saves the whole card through crm_save_lead (stage history and status are server-side). */
export default function CRMKanbanPage() {
  const router = useRouter();
  const [showArchive, setShowArchive] = useState(false);
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragged, setDragged] = useState<LeadJson | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);

  const stages = STAGES.filter((s) => showArchive || s.value !== "archived").map((s) => s.value);

  const load = useCallback(async () => {
    try {
      const visible = STAGES.filter((s) => showArchive || s.value !== "archived").map((s) => s.value);
      const result = await Promise.all(
        visible.map((stage) =>
          crmLeadList({
            p_filters: { stage, include_closed: true, sort: "created_desc" },
            p_page: { limit: COLUMN_LIMIT },
          }).then((r) => ({ stage, rows: r.rows, total: r.total_count }))
        )
      );
      setColumns(result);
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, [showArchive]);

  useEffect(() => {
    load();
  }, [load]);

  const needsInput = (lead: LeadJson, to: Stage) =>
    to === "lost" || to === "treatment_completed" || lead.stage === "treatment_completed";

  const save = async (lead: LeadJson, to: Stage, lossReason: LossReason | null, note: string | null) => {
    const input = { ...leadToInput(lead), stage: to, loss_reason: to === "lost" ? lossReason : null };
    await crmSaveLead({
      p_id: lead.id,
      p_version: lead.version,
      p_lead: input,
      p_note: note,
      p_schedule_reason: null,
      p_initial_call: null,
    });
    setMessage(`${lead.full_name}: ${stageLabel(lead.stage)} → ${stageLabel(to)}`);
    await load();
  };

  const drop = async (to: Stage) => {
    const lead = dragged;
    setDragged(null);
    if (!lead || lead.stage === to) return;
    if (needsInput(lead, to)) {
      setPending({ lead, to });
      return;
    }
    try {
      setError(null);
      await save(lead, to, null, null);
    } catch (err) {
      setError(toCrmError(err));
    }
  };

  return (
    <CrmShell
      title="Kanban"
      subtitle="Kartı sürükleyerek aşamayı değiştir. Her sütun en yeni 50 adayı gösterir."
      actions={
        <>
          <label className="flex items-center gap-2 text-sm px-2">
            <input type="checkbox" checked={showArchive} onChange={(e) => setShowArchive(e.target.checked)} />
            Arşivi göster
          </label>
          <Link href="/crm/new-lead" className={buttonPrimary}>
            Yeni aday
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <SuccessBox text={message} />
        <CrmErrorBox error={error} onReload={load} />
        {!columns ? (
          <Loading />
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {stages.map((stage) => {
              const col = columns.find((c) => c.stage === stage);
              return (
                <div
                  key={stage}
                  className={`${COLUMN_COLORS[stage]} rounded-lg p-3 w-72 shrink-0 min-h-96`}
                  onDragOver={(e) => {
                    if (dragged) e.preventDefault();
                  }}
                  onDrop={() => drop(stage)}
                >
                  <div className="mb-3">
                    <h2 className="font-bold text-gray-800">{stageLabel(stage)}</h2>
                    <div className="text-sm text-gray-600">{col?.total ?? 0} aday</div>
                  </div>
                  <div className="space-y-2">
                    {col?.rows.map((lead) => (
                      <div
                        key={lead.id}
                        draggable
                        onDragStart={() => setDragged(lead)}
                        onDragEnd={() => setDragged(null)}
                        onClick={() => router.push(`/crm/leads/${lead.id}`)}
                        className="bg-white rounded-lg p-3 shadow cursor-move hover:shadow-md transition-shadow"
                      >
                        <h3 className="font-semibold text-gray-800 text-sm">{lead.full_name}</h3>
                        <p className="text-xs text-gray-500">{lead.phone}</p>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-1">
                          <InterestBadge interest={lead.interest} />
                          <span className="text-xs text-gray-500">{sourceLabel(lead.source)}</span>
                        </div>
                        {lead.next_action && lead.followup_state === "open" && (
                          <p className="mt-1 text-xs text-gray-700 line-clamp-2">{lead.next_action}</p>
                        )}
                      </div>
                    ))}
                    {col && col.total > col.rows.length && (
                      <Link
                        href="/crm/leads"
                        className="block text-center text-xs text-blue-700 underline"
                      >
                        +{col.total - col.rows.length} aday daha (listede filtrele)
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pending && (
        <MoveDialog
          move={pending}
          onClose={() => setPending(null)}
          onConfirm={async (lossReason, note) => {
            await save(pending.lead, pending.to, lossReason, note);
            setPending(null);
          }}
        />
      )}
    </CrmShell>
  );
}

function MoveDialog({
  move,
  onClose,
  onConfirm,
}: {
  move: PendingMove;
  onClose: () => void;
  onConfirm: (lossReason: LossReason | null, note: string | null) => Promise<void>;
}) {
  const [lossReason, setLossReason] = useState<LossReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const { lead, to } = move;
  const noteRequired = to === "treatment_completed" || lead.stage === "treatment_completed";
  const noteHint =
    to === "treatment_completed"
      ? "Tedaviyi kapatmak için yeni görüşme notuna tamamlanma açıklamasını yazın."
      : lead.stage === "treatment_completed"
        ? "Hastayı yeniden açma nedenini yeni görüşme notuna yazın."
        : "Not isteğe bağlıdır.";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(to === "lost" ? (lossReason || null) : null, note.trim() || null);
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal
      title="Aşamayı değiştir"
      description={`${lead.full_name}: ${stageLabel(lead.stage)} → ${stageLabel(to)}`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        {to === "lost" && (
          <Field label="Olumsuz sonuç nedeni *">
            <select
              required
              value={lossReason}
              onChange={(e) => setLossReason(e.target.value as LossReason | "")}
              className={inputClass}
            >
              <option value="">Neden seç</option>
              {LOSS_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={noteRequired ? "Yeni görüşme notu *" : "Yeni görüşme notu"} hint={noteHint}>
          <textarea
            rows={3}
            maxLength={10000}
            required={noteRequired}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={inputClass}
          />
        </Field>
        {to === "treatment_completed" && (
          <p className="text-xs text-gray-600">
            Tedavi tamamlandığında takip kapanır, bekleyen tüm aramalar ve açık aktarımlar iptal edilir.
          </p>
        )}
        <CrmErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button
            type="submit"
            className={buttonPrimary}
            disabled={busy || (to === "lost" && !lossReason) || (noteRequired && !note.trim())}
          >
            {busy ? "Kaydediliyor…" : "Kaydet"}
          </button>
        </div>
      </form>
    </CrmModal>
  );
}
