"use client";

import { useState, type FormEvent } from "react";
import {
  crmAddNote,
  crmCorrectNote,
  formatDateTime,
  newId,
  toCrmError,
  type ActivityJson,
  type CrmError,
} from "@/lib/crm";
import { ACTIVITY_TYPE_LABELS } from "@/lib/crm/codes";
import { Badge, CrmErrorBox, EmptyState, buttonPrimary, buttonSecondary, inputClass } from "./ui";

const TYPE_STYLES: Record<string, string> = {
  note: "bg-blue-100 text-blue-800",
  legacy: "bg-gray-100 text-gray-700",
  update: "bg-gray-100 text-gray-700",
  stage: "bg-indigo-100 text-indigo-800",
  call: "bg-green-100 text-green-800",
  schedule: "bg-amber-100 text-amber-800",
  reminder: "bg-teal-100 text-teal-800",
  handoff: "bg-purple-100 text-purple-800",
};

/**
 * Lead history (legacy history[], MO:16): notes, generated updates, stage changes, calls, plan changes,
 * reminders and handoffs. Private rows reach only CRM managers (RLS); corrections keep the old text as a row.
 */
export function LeadHistory({
  leadId,
  activities,
  total,
  canManage,
  readOnly,
  onChanged,
}: {
  leadId: string;
  activities: ActivityJson[];
  total: number;
  canManage: boolean;
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [noteId, setNoteId] = useState(newId);
  const [text, setText] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [edit, setEdit] = useState<{ activity: ActivityJson; text: string; correctionId: string } | null>(null);
  const [editError, setEditError] = useState<CrmError | null>(null);

  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await crmAddNote({ p_lead_id: leadId, p_activity_id: noteId, p_text: text.trim(), p_private: isPrivate && canManage });
      setText("");
      setIsPrivate(false);
      setNoteId(newId());
      onChanged();
    } catch (err) {
      setError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  const saveCorrection = async () => {
    if (!edit || busy) return;
    setBusy(true);
    setEditError(null);
    try {
      await crmCorrectNote({
        p_activity_id: edit.activity.id,
        p_version: edit.activity.version,
        p_text: edit.text.trim(),
        p_correction_id: edit.correctionId,
      });
      setEdit(null);
      onChanged();
    } catch (err) {
      setEditError(toCrmError(err));
    } finally {
      setBusy(false);
    }
  };

  // Newest first on screen; the server orders by created_at, seq.
  const rows = [...activities].reverse();

  return (
    <div className="space-y-4">
      {!readOnly && (
        <form onSubmit={addNote} className="space-y-2">
          <textarea
            rows={3}
            maxLength={10000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
            placeholder="Görüşme dışı bir not ekle"
            aria-label="Yeni not"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canManage ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                Özel not (yalnızca CRM yöneticileri görür)
              </label>
            ) : (
              <span />
            )}
            <button type="submit" className={buttonPrimary} disabled={busy || !text.trim()}>
              Not ekle
            </button>
          </div>
          <CrmErrorBox error={error} />
        </form>
      )}

      {rows.length === 0 ? (
        <EmptyState>Henüz geçmiş kaydı yok.</EmptyState>
      ) : (
        <ol className="space-y-2">
          {rows.map((a) => (
            <li
              key={a.id}
              className={`p-3 rounded border text-sm ${a.is_private ? "border-purple-200 bg-purple-50" : "bg-white"}`}
            >
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <Badge className={TYPE_STYLES[a.type] ?? "bg-gray-100 text-gray-700"}>
                  {ACTIVITY_TYPE_LABELS[a.type] ?? a.type}
                </Badge>
                {a.is_private && <Badge className="bg-purple-200 text-purple-900">Özel</Badge>}
                <span className="text-xs text-gray-500">
                  {formatDateTime(a.created_at)} · {a.actor_name ?? "Kullanıcı bilinmiyor"}
                </span>
                {!readOnly && a.editable && edit?.activity.id !== a.id && (
                  <button
                    type="button"
                    className="ml-auto text-xs text-blue-700 underline"
                    onClick={() => {
                      setEditError(null);
                      setEdit({ activity: a, text: a.text, correctionId: newId() });
                    }}
                  >
                    Düzelt
                  </button>
                )}
              </div>
              {edit?.activity.id === a.id ? (
                <div className="space-y-2">
                  <textarea
                    rows={3}
                    maxLength={10000}
                    value={edit.text}
                    onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                    className={inputClass}
                  />
                  <p className="text-xs text-gray-600">
                    Eski metin geçmişte “Not düzeltildi” kaydı olarak korunur.
                  </p>
                  <CrmErrorBox error={editError} onReload={onChanged} />
                  <div className="flex justify-end gap-2">
                    <button type="button" className={buttonSecondary} onClick={() => setEdit(null)} disabled={busy}>
                      Vazgeç
                    </button>
                    <button
                      type="button"
                      className={buttonPrimary}
                      onClick={saveCorrection}
                      disabled={busy || !edit.text.trim()}
                    >
                      Düzeltmeyi kaydet
                    </button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-line text-gray-900">{a.text}</p>
              )}
              {a.edited_at && (
                <p className="text-xs text-gray-500 mt-1">
                  Düzeltildi · {formatDateTime(a.edited_at)}
                  {a.edited_by_name ? ` · ${a.edited_by_name}` : ""}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {total > activities.length && (
        <p className="text-xs text-gray-500">
          Son {activities.length} kayıt gösteriliyor (toplam {total}).
        </p>
      )}
    </div>
  );
}
