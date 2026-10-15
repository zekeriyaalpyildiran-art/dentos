"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { LeadFields, emptyLeadForm, formToInput, type LeadFormState } from "@/components/crm/LeadFields";
import { PhoneMatchWarning } from "@/components/crm/PhoneMatches";
import { useStaff } from "@/components/crm/useCrmRefs";
import {
  Card,
  CrmErrorBox,
  CrmShell,
  Field,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/crm/ui";
import { useAuthStore } from "@/lib/store";
import { crmSaveLead, istanbulToday, newId, toCrmError, type CrmError } from "@/lib/crm";

/**
 * New lead card (crm_save_lead create). The id is created when the form opens and reused for retries, so a
 * double click or a retry after a network error cannot create a second lead. A duplicate phone only warns.
 */
export default function NewLeadPage() {
  const router = useRouter();
  const me = useAuthStore((s) => s.user?.user_id ?? "");
  const staff = useStaff();
  const today = istanbulToday();
  const [ids] = useState(() => ({ lead: newId(), call: newId() }));
  const [form, setForm] = useState<LeadFormState>(() => emptyLeadForm(me));
  const [note, setNote] = useState("");
  const [planCall, setPlanCall] = useState(true);
  const [call, setCall] = useState({ date: today, time: "10:00", caller: me });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // The signed-in user arrives after the first render: default the assignee and caller to them (never a fixed name).
  useEffect(() => {
    if (!me) return;
    setForm((f) => (f.assigned_to ? f : { ...f, assigned_to: me }));
    setCall((c) => (c.caller ? c : { ...c, caller: me }));
  }, [me]);

  const closed = form.do_not_contact || form.stage === "treatment_completed";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const parsed = formToInput(form);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    if ((form.followup_state === "done" || closed) && !note.trim()) {
      setLocalError("Takibi tamamlamak için yeni görüşme notuna kapanış nedenini yazın.");
      return;
    }
    if (form.stage === "treatment_completed" && !note.trim()) {
      setLocalError("Tedaviyi kapatmak için yeni görüşme notuna tamamlanma açıklamasını yazın.");
      return;
    }
    const withCall = planCall && !closed;
    setLocalError(null);
    setError(null);
    setSubmitting(true);
    try {
      await crmSaveLead({
        p_id: ids.lead,
        p_version: null,
        p_lead: parsed.input,
        p_note: note.trim() || null,
        p_schedule_reason: null,
        p_initial_call: withCall
          ? { id: ids.call, date: call.date, time: call.time, caller_user_id: call.caller || null }
          : null,
      });
      // Without a first call, open the call agenda with the plan form for this lead (rules §3).
      router.push(withCall ? `/crm/leads/${ids.lead}` : `/crm/calls?plan=${ids.lead}`);
    } catch (err) {
      setError(toCrmError(err));
      setSubmitting(false);
    }
  };

  return (
    <CrmShell
      title="Yeni hasta adayı"
      actions={
        <Link href="/crm/leads" className={buttonSecondary}>
          ← Listeye dön
        </Link>
      }
    >
      <form onSubmit={submit} className="max-w-4xl space-y-4">
        <Card>
          <LeadFields
            value={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            staff={staff}
            today={today}
            disabled={submitting}
          />
          <div className="mt-4">
            <PhoneMatchWarning phone={form.phone} />
          </div>
        </Card>

        <Card title="İlk arama">
          {closed ? (
            <p className="text-sm text-gray-600">Takibi kapalı veya aranmak istemeyen adaya arama planlanamaz.</p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm mb-3">
                <input type="checkbox" checked={planCall} onChange={(e) => setPlanCall(e.target.checked)} />
                İlk aramayı şimdi planla
              </label>
              {planCall && (
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Tarih">
                    <input
                      type="date"
                      required
                      min={today}
                      value={call.date}
                      onChange={(e) => setCall({ ...call, date: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Saat">
                    <input
                      type="time"
                      required
                      value={call.time}
                      onChange={(e) => setCall({ ...call, time: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Arayacak kişi">
                    <select
                      value={call.caller}
                      onChange={(e) => setCall({ ...call, caller: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">Sorumlu kişi</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.full_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
            </>
          )}
        </Card>

        <Card>
          <Field label="Yeni görüşme notu" hint="Kaydettiğinde geçmişe not olarak eklenir.">
            <textarea
              rows={3}
              maxLength={10000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={inputClass}
            />
          </Field>
          {localError && (
            <div className="mt-3 p-3 rounded bg-red-50 text-red-700 text-sm" role="alert">
              {localError}
            </div>
          )}
          <div className="mt-3">
            <CrmErrorBox error={error} />
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={submitting} className={buttonPrimary}>
              {submitting ? "Kaydediliyor…" : "Hasta adayını kaydet"}
            </button>
          </div>
        </Card>
      </form>
    </CrmShell>
  );
}
