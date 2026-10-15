"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { hasPermission } from "@/lib/permissions";
import {
  centsToInput,
  crmSaveAdSpend,
  formatMonth,
  formatTL,
  newId,
  parseTL,
  toCrmError,
  type AdSpendRow,
  type CrmError,
} from "@/lib/crm";
import { CURRENCIES, CURRENCY_LABELS, SOURCES, sourceLabel, type Currency } from "@/lib/crm/codes";
import { Card, CrmErrorBox, EmptyState, Field, buttonPrimary, buttonSecondary, inputClass } from "./ui";

export function formatMoney(cents: number, currency: Currency | string): string {
  if (currency === "TRY") return formatTL(cents);
  return `${formatTL(cents).replace("₺", "")} ${currency}`;
}

interface EditState {
  id: string;
  version: number | null;
  source: string;
  month: string;
  amount: string;
  currency: Currency;
  note: string;
}

const blank = (): EditState => ({
  id: newId(),
  version: null,
  source: "instagram_meta",
  month: new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Istanbul" }).format(new Date()).slice(0, 7),
  amount: "",
  currency: "TRY",
  note: "",
});

/**
 * Monthly ad spend per source (owner decision 4): visible to finance / finance_readonly holders (RLS), editable
 * only with 'finance'. There are no deletes; an amount of 0 removes the spend from the report.
 */
export function AdSpendSection({ onChanged }: { onChanged: () => void }) {
  const user = useAuthStore((s) => s.user);
  const clinicId = user?.clinic_id;
  const canWrite = hasPermission(user, "finance");
  const [rows, setRows] = useState<AdSpendRow[] | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrmError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clinicId) return;
    const { data, error: err } = await createClient()
      .from("crm_ad_spend")
      .select("id,version,source,month,amount_cents,currency,note,updated_at")
      .eq("clinic_id", clinicId)
      .order("month", { ascending: false })
      .order("source")
      .limit(200);
    if (err) {
      console.error("Error fetching ad spend:", err);
      setRows([]);
      return;
    }
    setRows((data || []) as AdSpendRow[]);
  }, [clinicId]);

  useEffect(() => {
    load();
  }, [load]);

  const openRow = (r: AdSpendRow) =>
    setEdit({
      id: r.id,
      version: r.version,
      source: r.source,
      month: r.month.slice(0, 7),
      amount: centsToInput(r.amount_cents),
      currency: r.currency,
      note: r.note ?? "",
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit || busy) return;
    const parsed = parseTL(edit.amount, { allowZero: true });
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    setLocalError(null);
    setError(null);
    setBusy(true);
    try {
      await crmSaveAdSpend({
        p_id: edit.id,
        p_version: edit.version,
        p_source: edit.source,
        p_month: edit.month,
        p_amount_cents: parsed.cents,
        p_currency: edit.currency,
        p_note: edit.note.trim(),
      });
      setEdit(null);
      await load();
      onChanged();
    } catch (err) {
      const ce = toCrmError(err);
      // E_AD_DUPLICATE: DETAIL carries the existing row's id; open it for editing instead.
      const existing = ce.isConflict && ce.details ? rows?.find((r) => r.id === ce.details) : undefined;
      if (existing) {
        openRow(existing);
        setLocalError("Bu kaynak, ay ve para birimi için kayıt zaten var; mevcut kayıt düzenlemeye açıldı.");
      } else {
        setError(ce);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Reklam harcamaları"
      actions={
        canWrite && !edit ? (
          <button type="button" className={buttonSecondary} onClick={() => setEdit(blank())}>
            + Harcama ekle
          </button>
        ) : undefined
      }
    >
      {edit && (
        <form onSubmit={submit} className="mb-4 p-3 rounded border bg-gray-50 space-y-3">
          <div className="grid gap-3 md:grid-cols-5">
            <Field label="Kaynak">
              <select value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} className={inputClass}>
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ay">
              <input
                type="month"
                required
                value={edit.month}
                onChange={(e) => setEdit({ ...edit, month: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Tutar">
              <input
                required
                inputMode="decimal"
                value={edit.amount}
                onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                className={inputClass}
                placeholder="Ör. 12.500"
              />
            </Field>
            <Field label="Para birimi">
              <select
                value={edit.currency}
                onChange={(e) => setEdit({ ...edit, currency: e.target.value as Currency })}
                className={inputClass}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Not">
              <input
                maxLength={500}
                value={edit.note}
                onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>
          {localError && <p className="text-sm text-red-600">{localError}</p>}
          <CrmErrorBox error={error} onReload={load} />
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonSecondary} onClick={() => setEdit(null)} disabled={busy}>
              Vazgeç
            </button>
            <button type="submit" className={buttonPrimary} disabled={busy}>
              {busy ? "Kaydediliyor…" : "Kaydet"}
            </button>
          </div>
        </form>
      )}
      {!rows ? null : rows.length === 0 ? (
        <EmptyState>Kayıtlı reklam harcaması yok.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b text-gray-600">
              <th className="py-2">Ay</th>
              <th className="py-2">Kaynak</th>
              <th className="py-2 text-right">Tutar</th>
              <th className="py-2">Not</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-b-0">
                <td className="py-2">{formatMonth(r.month.slice(0, 7))}</td>
                <td className="py-2">{sourceLabel(r.source)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(r.amount_cents, r.currency)}</td>
                <td className="py-2 text-gray-600">{r.note}</td>
                {canWrite && (
                  <td className="py-2 text-right">
                    <button type="button" className="text-blue-700 underline text-xs" onClick={() => openRow(r)}>
                      Düzenle
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
