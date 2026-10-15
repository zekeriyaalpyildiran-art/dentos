"use client";

import {
  addDays,
  centsToInput,
  contactSuggestion,
  normalizePhone,
  parseTL,
  type LeadInput,
  type LeadJson,
} from "@/lib/crm";
import {
  CLOSED_STAGES,
  CONTACT_RESULTS,
  CURRENCIES,
  CURRENCY_LABELS,
  INTERESTS,
  INTEREST_LABELS,
  LOSS_REASONS,
  SOURCES,
  STAGES,
  sourceLabel,
  type ContactResult,
  type Currency,
  type FollowupState,
  type Interest,
  type LossReason,
  type Stage,
} from "@/lib/crm/codes";
import type { StaffOption } from "./useCrmRefs";
import { Field, Notice, buttonSecondary, inputClass } from "./ui";

export interface LeadFormState {
  full_name: string;
  phone: string;
  email: string;
  address: string;
  source: string;
  referrer: string;
  campaign: string;
  treatment_interest: string;
  assigned_to: string;
  stage: Stage;
  interest: Interest;
  contact_result: ContactResult;
  loss_reason: LossReason | "";
  followup_date: string;
  followup_state: FollowupState;
  next_action: string;
  do_not_contact: boolean;
  quote_amount: string;
  quote_currency: Currency;
}

export function emptyLeadForm(assignee: string): LeadFormState {
  return {
    full_name: "",
    phone: "",
    email: "",
    address: "",
    source: "",
    referrer: "",
    campaign: "",
    treatment_interest: "",
    assigned_to: assignee,
    stage: "new",
    interest: "unknown",
    contact_result: "unspecified",
    loss_reason: "",
    followup_date: "",
    followup_state: "open",
    next_action: "",
    do_not_contact: false,
    quote_amount: "",
    quote_currency: "TRY",
  };
}

export function leadToForm(lead: LeadJson): LeadFormState {
  return {
    full_name: lead.full_name,
    phone: lead.phone,
    email: lead.email ?? "",
    address: lead.address ?? "",
    source: lead.source ?? "",
    referrer: lead.referrer ?? "",
    campaign: lead.campaign ?? "",
    treatment_interest: lead.treatment_interest ?? "",
    assigned_to: lead.assigned_to ?? "",
    stage: lead.stage,
    interest: lead.interest,
    contact_result: lead.contact_result,
    loss_reason: lead.loss_reason ?? "",
    followup_date: lead.followup_date ?? "",
    followup_state: lead.followup_state,
    next_action: lead.next_action ?? "",
    do_not_contact: lead.do_not_contact,
    quote_amount: centsToInput(lead.quote_amount_cents),
    quote_currency: lead.quote_currency ?? "TRY",
  };
}

/** Form → p_lead. Client checks only what the server would refuse with a field error. */
export function formToInput(f: LeadFormState): { ok: true; input: LeadInput } | { ok: false; error: string } {
  const name = f.full_name.trim();
  if (name.length < 2 || name.length > 200) return { ok: false, error: "Ad soyad en az 2, en fazla 200 karakter olmalı." };
  if (normalizePhone(f.phone).length < 7) return { ok: false, error: "Geçerli bir telefon numarası girin." };
  if (f.stage === "lost" && !f.loss_reason) return { ok: false, error: "Olumsuz sonuç nedenini seçin." };
  let quote: number | null = null;
  if (f.quote_amount.trim()) {
    const parsed = parseTL(f.quote_amount, { allowZero: true });
    if (!parsed.ok) return { ok: false, error: `Verilen teklif: ${parsed.error}` };
    quote = parsed.cents;
  }
  return {
    ok: true,
    input: {
      full_name: name,
      phone: f.phone.trim(),
      email: f.email.trim() || null,
      address: f.address.trim() || null,
      source: f.source || null,
      referrer: f.referrer.trim(),
      campaign: f.campaign.trim(),
      treatment_interest: f.treatment_interest.trim(),
      assigned_to: f.assigned_to || null,
      stage: f.stage,
      interest: f.interest,
      contact_result: f.contact_result,
      loss_reason: f.stage === "lost" && f.loss_reason ? f.loss_reason : null,
      followup_date: f.followup_date || null,
      followup_state: f.followup_state,
      next_action: f.next_action.trim(),
      do_not_contact: f.do_not_contact,
      quote_amount_cents: quote,
      quote_currency: f.quote_currency,
    },
  };
}

/**
 * The editable lead card fields (contract §4.1). The stored source stays selectable when it is a deprecated
 * code or old free text, so saving never drops it.
 */
export function LeadFields({
  value,
  onChange,
  staff,
  today,
  originalSource,
  originalAssignee,
  disabled,
}: {
  value: LeadFormState;
  onChange: (patch: Partial<LeadFormState>) => void;
  staff: StaffOption[];
  today: string;
  originalSource?: string | null;
  originalAssignee?: { id: string; name: string | null } | null;
  disabled?: boolean;
}) {
  const set =
    <K extends keyof LeadFormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange({ [key]: e.target.value } as Partial<LeadFormState>);

  const suggestion = contactSuggestion(value.contact_result, value.interest);
  const keepSource =
    originalSource && !SOURCES.some((s) => s.value === originalSource) ? originalSource : null;
  const closedByStage = CLOSED_STAGES.includes(value.stage);
  const missingPlan =
    !value.do_not_contact &&
    value.followup_state === "open" &&
    !closedByStage &&
    (!value.followup_date || !value.next_action.trim());

  const applySuggestion = () => {
    if (!suggestion) return;
    onChange({
      followup_state: "open",
      interest: suggestion.interest,
      next_action: suggestion.nextAction,
      followup_date: value.followup_date || (suggestion.days === null ? "" : addDays(today, suggestion.days)),
    });
  };

  const quick = (days: number) =>
    onChange({
      followup_date: addDays(today, days),
      followup_state: "open",
      next_action: value.next_action.trim() ? value.next_action : "Hastayı ara",
    });

  return (
    <fieldset disabled={disabled} className="space-y-6">
      <div>
        <h3 className="font-semibold mb-3">İletişim ve kaynak</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Ad soyad *">
            <input required maxLength={200} value={value.full_name} onChange={set("full_name")} className={inputClass} />
          </Field>
          <Field label="Telefon *">
            <input required type="tel" maxLength={200} value={value.phone} onChange={set("phone")} className={inputClass} />
          </Field>
          <Field label="E-posta">
            <input type="email" maxLength={200} value={value.email} onChange={set("email")} className={inputClass} />
          </Field>
          <Field label="Başvuru kaynağı">
            <select value={value.source} onChange={set("source")} className={inputClass}>
              <option value="">Bilinmiyor</option>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
              {/* Deprecated codes and old free text are kept only when already stored (contract §1.4). */}
              {keepSource && <option value={keepSource}>{sourceLabel(keepSource)}</option>}
            </select>
          </Field>
          <Field label="Referans olan kişi">
            <input maxLength={200} value={value.referrer} onChange={set("referrer")} className={inputClass} />
          </Field>
          <Field label="Kampanya">
            <input maxLength={200} value={value.campaign} onChange={set("campaign")} className={inputClass} />
          </Field>
          <Field label="İlgilendiği tedavi">
            <input
              maxLength={200}
              value={value.treatment_interest}
              onChange={set("treatment_interest")}
              className={inputClass}
            />
          </Field>
          <Field label="Sorumlu">
            <select value={value.assigned_to} onChange={set("assigned_to")} className={inputClass}>
              <option value="">Atanmamış</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
              {originalAssignee && !staff.some((s) => s.id === originalAssignee.id) && (
                <option value={originalAssignee.id}>{originalAssignee.name ?? "Atanmış kullanıcı"}</option>
              )}
            </select>
          </Field>
          <Field label="Adres" className="md:col-span-2">
            <textarea rows={2} maxLength={500} value={value.address} onChange={set("address")} className={inputClass} />
          </Field>
        </div>
      </div>

      <div>
        <h3 className="font-semibold mb-3">Aşama ve takip</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Aşama">
            <select value={value.stage} onChange={set("stage")} className={inputClass}>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          {value.stage === "lost" ? (
            <Field label="Olumsuz sonuç nedeni *">
              <select value={value.loss_reason} onChange={set("loss_reason")} className={inputClass}>
                <option value="">Neden seç</option>
                {LOSS_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div />
          )}
          <Field label="İlgi durumu">
            <select value={value.interest} onChange={set("interest")} className={inputClass}>
              {INTERESTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Görüşme sonucu">
            <select value={value.contact_result} onChange={set("contact_result")} className={inputClass}>
              {CONTACT_RESULTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          {suggestion && (
            <div className="md:col-span-2 p-3 rounded border bg-blue-50 text-sm text-blue-900 flex flex-wrap items-center justify-between gap-3">
              <div>
                <b>Programın önerisi:</b> İlgi {INTEREST_LABELS[suggestion.interest]} ·{" "}
                {suggestion.days === null ? "tarih hastaya göre" : `${suggestion.days} gün sonra`} ·{" "}
                {suggestion.nextAction}
              </div>
              <button type="button" className={buttonSecondary} onClick={applySuggestion}>
                Öneriyi uygula
              </button>
            </div>
          )}
          <Field label="Takip tarihi">
            <input
              type="date"
              value={value.followup_date}
              onChange={(e) =>
                // Legacy contact-fields: picking a date also reopens the follow-up.
                onChange(
                  e.target.value
                    ? { followup_date: e.target.value, followup_state: "open" }
                    : { followup_date: "" }
                )
              }
              className={inputClass}
            />
            <span className="mt-2 flex flex-wrap gap-2">
              {[
                { d: 1, l: "Yarın ara" },
                { d: 3, l: "3 gün sonra" },
                { d: 7, l: "1 hafta sonra" },
              ].map((q) => (
                <button
                  key={q.d}
                  type="button"
                  onClick={() => quick(q.d)}
                  className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
                >
                  {q.l}
                </button>
              ))}
              {value.followup_date && (
                <button
                  type="button"
                  onClick={() => onChange({ followup_date: "" })}
                  className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
                >
                  Tarihi kaldır
                </button>
              )}
            </span>
          </Field>
          <Field label="Takip durumu">
            <select value={value.followup_state} onChange={set("followup_state")} className={inputClass}>
              <option value="open">Takip açık</option>
              <option value="done">Takip tamamlandı</option>
            </select>
          </Field>
          <Field label="Sonraki adım" className="md:col-span-2">
            <input
              maxLength={200}
              value={value.next_action}
              onChange={set("next_action")}
              className={inputClass}
              placeholder="Ör. teklif kararını sor"
            />
          </Field>
          <Field label="Verilen teklif">
            <div className="flex gap-2">
              <input
                inputMode="decimal"
                value={value.quote_amount}
                onChange={set("quote_amount")}
                className={inputClass}
                placeholder="Ör. 25.000"
              />
              <select value={value.quote_currency} onChange={set("quote_currency")} className={`${inputClass} w-28`}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm md:mt-7">
            <input
              type="checkbox"
              checked={value.do_not_contact}
              onChange={(e) => onChange({ do_not_contact: e.target.checked })}
            />
            Hasta telefonla aranmak istemiyor
          </label>
        </div>
        <div className="mt-3 space-y-2">
          {value.do_not_contact && (
            <Notice tone="danger">
              Kaydedildiğinde takip kapanır ve bekleyen tüm arama planları iptal edilir. Yeni görüşme notuna nedeni
              yazın.
            </Notice>
          )}
          {missingPlan && (
            <Notice tone="warn">Takip planı eksik: sonraki adımı ve tarihi birlikte belirleyin.</Notice>
          )}
        </div>
      </div>
    </fieldset>
  );
}
