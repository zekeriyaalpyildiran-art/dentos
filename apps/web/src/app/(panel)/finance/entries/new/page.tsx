"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { EntryFields, buildEntryInput, type EntryFormState } from "@/components/finance/EntryFields";
import { useReferenceData } from "@/components/finance/useReferenceData";
import { Card, ErrorBox, Loading, buttonPrimary, buttonSecondary } from "@/components/finance/ui";
import {
  finCreateEntry,
  newId,
  sortByOrder,
  toFinanceError,
  type FinanceError,
  type ReferenceData,
} from "@/lib/finance";

export default function NewFinanceEntryPage() {
  return (
    <FinanceShell title="Ödeme / tahsilat ekle" requireWrite>
      <NewEntry />
    </FinanceShell>
  );
}

function initialState(ref: ReferenceData): EntryFormState {
  const categories = sortByOrder(ref.categories.filter((c) => c.is_active));
  const receipts = categories.find((c) => c.report_bucket === "patient_receipts" && c.is_system);
  const account = sortByOrder(ref.accounts.filter((a) => a.is_active))[0];
  return {
    category_id: receipts?.id ?? categories[0]?.id ?? "",
    subcategory: "",
    counterparty: "",
    description: "",
    due_date: ref.today,
    amount: "",
    entitlement_month: "",
    realized: true,
    account_id: account?.id ?? "",
  };
}

function NewEntry() {
  const router = useRouter();
  const ref = useReferenceData();
  // The id is fixed while the form is open, so a retry after a lost response is idempotent (p1 hard rule).
  const [entryId] = useState(() => newId());
  const [state, setState] = useState<EntryFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (ref.data && !state) setState(initialState(ref.data));
  }, [ref.data, state]);

  if (!ref.data || !state) {
    return ref.loading ? <Loading /> : <ErrorBox error={ref.error} />;
  }
  const refData = ref.data;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setError(null);
    const built = buildEntryInput(refData, state);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    if (state.realized) {
      if (!state.account_id) {
        setFormError("Hesap seçin.");
        return;
      }
      if (state.due_date > refData.today) {
        setFormError("Gerçekleşmiş işlem için gelecek tarih seçilemez.");
        return;
      }
    }
    setSaving(true);
    try {
      await finCreateEntry({
        p_id: entryId,
        ...built.input,
        p_realized: state.realized,
        p_account_id: state.realized ? state.account_id : null,
      });
      router.push(`/finance/entries/${entryId}?saved=1`);
    } catch (err) {
      setError(toFinanceError(err));
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <EntryFields
          refData={refData}
          state={state}
          onChange={setState}
          today={refData.today}
          showRealized
          disabled={saving}
        />
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} />
        <p className="text-xs text-gray-500">
          Gerçekleşen işlemler banka ve kasa bakiyelerini değiştirmez; kaydettikten sonra bakiyeleri ayrıca
          güncelleyin.
        </p>
        <div className="flex gap-2">
          <button type="submit" className={buttonPrimary} disabled={saving}>
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </button>
          <Link href="/finance/entries" className={buttonSecondary}>
            Vazgeç
          </Link>
        </div>
      </form>
    </Card>
  );
}
