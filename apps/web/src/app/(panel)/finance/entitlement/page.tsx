"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { useReferenceData } from "@/components/finance/useReferenceData";
import { Card, ErrorBox, Field, Loading, buttonPrimary, buttonSecondary, inputClass } from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  UUID_RE,
  finAddEntitlement,
  formatMonth,
  isDay,
  isMonth,
  newId,
  parseTL,
  pickable,
  sortByOrder,
  toFinanceError,
  type FinanceError,
  type ReferenceData,
} from "@/lib/finance";

export default function FinanceEntitlementPage() {
  return (
    <FinanceShell title="Hekim hakedişi ekle" requireWrite>
      <EntitlementForm />
    </FinanceShell>
  );
}

interface FormState {
  counterparty_id: string;
  month: string;
  amount: string;
  paid: string;
  paid_on: string;
  account_id: string;
  description: string;
}

function initialState(ref: ReferenceData): FormState {
  const settingsAccount = ref.accounts.find((a) => a.id === ref.settings.entitlement_account_id && a.is_active);
  return {
    counterparty_id: "",
    month: ref.current_month,
    amount: "",
    paid: "",
    paid_on: ref.today,
    account_id: settingsAccount?.id ?? sortByOrder(ref.accounts.filter((a) => a.is_active))[0]?.id ?? "",
    description: ref.settings.physician_fee_note ?? "",
  };
}

/** 'Hekim hakedişi ekle' (fin_add_entitlement): one entitlement per physician per month, with an optional first payment. */
function EntitlementForm() {
  const router = useRouter();
  const ref = useReferenceData();
  const [entryId, setEntryId] = useState(() => newId());
  const [state, setState] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ref.data && !state) setState(initialState(ref.data));
  }, [ref.data, state]);

  if (!ref.data || !state) return ref.loading ? <Loading /> : <ErrorBox error={ref.error} />;
  const data = ref.data;

  const physicians = data.counterparties.filter((c) => c.is_active && c.kind === "physician");
  const accounts = sortByOrder(pickable(data.accounts, state.account_id));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setState({ ...state, [key]: value });
  const existingId = error?.isConflict && error.details && UUID_RE.test(error.details) ? error.details : null;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    if (!state.counterparty_id) return setFormError("Hekim seçin.");
    if (!isMonth(state.month)) return setFormError("Hakediş ayını seçin.");
    const amount = parseTL(state.amount);
    if (!amount.ok) return setFormError(`Toplam hakediş: ${amount.error}`);
    const paid = state.paid.trim() ? parseTL(state.paid, { allowZero: true }) : ({ ok: true, cents: 0 } as const);
    if (!paid.ok) return setFormError(`Ödenen tutar: ${paid.error}`);
    if (paid.cents > amount.cents) {
      return setFormError("Ödenen tutar hakediş tutarını aşamaz; ödeme tarihi bugünden sonra olamaz.");
    }
    if (paid.cents > 0) {
      if (!isDay(state.paid_on) || state.paid_on > data.today) {
        return setFormError("Ödenen tutar hakediş tutarını aşamaz; ödeme tarihi bugünden sonra olamaz.");
      }
      if (!state.account_id) return setFormError("Ödeme hesabını seçin.");
    }
    if (state.description.length > 1000) return setFormError("Açıklama en fazla 1000 karakter olabilir.");

    setBusy(true);
    try {
      await finAddEntitlement({
        p_id: entryId,
        p_counterparty_id: state.counterparty_id,
        p_month: state.month,
        p_amount_cents: amount.cents,
        p_paid_cents: paid.cents,
        p_paid_on: paid.cents > 0 ? state.paid_on : null,
        p_account_id: paid.cents > 0 ? state.account_id : null,
        p_description: state.description.trim(),
      });
      router.push(`/finance/entries/${entryId}?saved=1`);
    } catch (err) {
      const fe = toFinanceError(err);
      setError(fe);
      setBusy(false);
      // A different physician/month after E_ENTITLEMENT_EXISTS is a new request, so it gets a new id.
      if (fe.isConflict) setEntryId(newId());
    }
  };

  return (
    <div className="space-y-4">
      {physicians.length === 0 && (
        <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
          Hekim türünde aktif kişi / kurum yok.{" "}
          <Link href="/finance/settings" className="underline">
            Finans ayarlarından
          </Link>{" "}
          hekimi “Hekim” türünde ekleyin.
        </div>
      )}
      <Card>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <Field label="Hekim">
            <select className={inputClass} value={state.counterparty_id} onChange={(e) => set("counterparty_id", e.target.value)} required>
              <option value="">Seçin</option>
              {physicians.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Hakediş ayı" hint={isMonth(state.month) ? formatMonth(state.month) : undefined}>
            <input type="month" className={inputClass} value={state.month} onChange={(e) => set("month", e.target.value)} required />
          </Field>
          <Field label="Toplam hakediş (TL)">
            <input className={inputClass} inputMode="decimal" value={state.amount} onChange={(e) => set("amount", e.target.value)} required />
          </Field>
          <Field label="Şimdi ödenen tutar (TL, isteğe bağlı)" hint="Boş bırakılırsa hakediş açık borç olarak kaydedilir.">
            <input className={inputClass} inputMode="decimal" value={state.paid} onChange={(e) => set("paid", e.target.value)} />
          </Field>
          <Field label="Ödeme tarihi">
            <input
              type="date"
              className={inputClass}
              value={state.paid_on}
              max={data.today}
              onChange={(e) => set("paid_on", e.target.value)}
              disabled={!state.paid.trim()}
            />
          </Field>
          <Field label="Ödeme hesabı">
            <select
              className={inputClass}
              value={state.account_id}
              onChange={(e) => set("account_id", e.target.value)}
              disabled={!state.paid.trim()}
            >
              <option value="">Seçin</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.is_active}>
                  {a.name} ({ACCOUNT_KIND_LABELS[a.kind]})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Açıklama" className="md:col-span-2" hint="Varsayılan metin finans ayarlarındaki hekim hakedişi notundan gelir.">
            <textarea className={inputClass} rows={3} maxLength={1000} value={state.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div className="md:col-span-2 space-y-3">
            <p className="text-xs text-gray-500">
              Her hekim için ay başına tek hakediş kaydı açılır. Sonraki ödemeleri “Ödeme ve tahsilatlar” listesindeki bu
              kayda ekleyin. Hakediş ayından sonraki aylarda yapılan ödemeler geçmiş dönem borç ödemesi sayılır.
            </p>
            {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
            <ErrorBox error={error} />
            {existingId && (
              <Link href={`/finance/entries/${existingId}`} className={buttonSecondary}>
                Mevcut kaydı aç
              </Link>
            )}
            <div className="flex gap-2">
              <button type="submit" className={buttonPrimary} disabled={busy || physicians.length === 0}>
                {busy ? "Kaydediliyor..." : "Hakedişi kaydet"}
              </button>
              <Link href="/finance" className={buttonSecondary}>
                Vazgeç
              </Link>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
