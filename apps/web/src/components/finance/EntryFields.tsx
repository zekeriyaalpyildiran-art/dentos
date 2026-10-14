"use client";

import {
  ACCOUNT_KIND_LABELS,
  matchCounterparty,
  parseTL,
  pickable,
  searchKey,
  sortByOrder,
  subcategoryOptions,
  isDay,
  isMonth,
  type ReferenceData,
  type Subcategory,
} from "@/lib/finance";
import { Field, inputClass } from "./ui";

export interface EntryFormState {
  category_id: string;
  subcategory: Subcategory | "";
  /** Typed counterparty name; snapped to a master row when it matches one. */
  counterparty: string;
  description: string;
  due_date: string;
  amount: string;
  entitlement_month: string;
  realized: boolean;
  account_id: string;
}

export interface EntryInput {
  p_category_id: string;
  p_subcategory: Subcategory | null;
  p_counterparty_id: string | null;
  p_counterparty_text: string | null;
  p_description: string;
  p_due_date: string;
  p_amount_cents: number;
  p_entitlement_month: string | null;
}

/** Client-side shape checks before the RPC; the server re-checks everything (p2 §3.2). */
export function buildEntryInput(
  ref: ReferenceData,
  s: EntryFormState,
  original?: { counterparty_id: string | null; counterparty_name: string }
): { ok: true; input: EntryInput } | { ok: false; error: string } {
  const category = ref.categories.find((c) => c.id === s.category_id);
  if (!category) return { ok: false, error: "Kategori seçin." };

  const name = s.counterparty.trim().replace(/\s+/g, " ");
  if (!name || name.length > 200) {
    return { ok: false, error: "Kişi / kurum seçin veya yazın (en fazla 200 karakter)." };
  }
  let counterpartyId: string | null = null;
  if (original?.counterparty_id && searchKey(name) === searchKey(original.counterparty_name)) {
    counterpartyId = original.counterparty_id; // unchanged (possibly inactive) master row is kept
  } else {
    counterpartyId = matchCounterparty(ref, name)?.id ?? null;
  }

  const amount = parseTL(s.amount);
  if (!amount.ok) return { ok: false, error: amount.error };
  if (!isDay(s.due_date)) return { ok: false, error: "Geçersiz tarih." };
  if (s.description.length > 1000) {
    return { ok: false, error: "Açıklama en fazla 1000 karakter olabilir." };
  }

  const bucket = category.report_bucket;
  let subcategory: Subcategory | null = s.subcategory || null;
  if (!subcategoryOptions(bucket).some((o) => o.value === (subcategory ?? ""))) subcategory = null;
  if (bucket === "doctor" && !subcategory) subcategory = "current_physician";

  let month: string | null = null;
  if (bucket === "doctor" && s.entitlement_month) {
    if (!isMonth(s.entitlement_month)) return { ok: false, error: "Geçersiz hakediş ayı." };
    month = s.entitlement_month;
  }

  return {
    ok: true,
    input: {
      p_category_id: category.id,
      p_subcategory: subcategory,
      p_counterparty_id: counterpartyId,
      p_counterparty_text: counterpartyId ? null : name,
      p_description: s.description.trim(),
      p_due_date: s.due_date,
      p_amount_cents: amount.cents,
      p_entitlement_month: month,
    },
  };
}

export function EntryFields({
  refData,
  state,
  onChange,
  today,
  showRealized,
  lockCategory,
  lockCounterparty,
  lockMonth,
  originalCategoryId,
  disabled,
}: {
  refData: ReferenceData;
  state: EntryFormState;
  onChange: (next: EntryFormState) => void;
  today: string;
  /** Create form only: 'Gerçekleşti' / 'Planlandı' and the account. */
  showRealized?: boolean;
  lockCategory?: boolean;
  lockCounterparty?: boolean;
  lockMonth?: boolean;
  originalCategoryId?: string;
  disabled?: boolean;
}) {
  const set = <K extends keyof EntryFormState>(key: K, value: EntryFormState[K]) =>
    onChange({ ...state, [key]: value });

  const categories = sortByOrder(pickable(refData.categories, originalCategoryId ?? state.category_id));
  const category = refData.categories.find((c) => c.id === state.category_id);
  const bucket = category?.report_bucket;
  const subOptions = subcategoryOptions(bucket);
  const accounts = sortByOrder(pickable(refData.accounts, state.account_id));
  const counterparties = refData.counterparties.filter((c) => c.is_active);
  const matched = matchCounterparty(refData, state.counterparty);

  const changeCategory = (id: string) => {
    const nextBucket = refData.categories.find((c) => c.id === id)?.report_bucket;
    const allowed = subcategoryOptions(nextBucket);
    onChange({
      ...state,
      category_id: id,
      subcategory: allowed.some((o) => o.value === state.subcategory)
        ? state.subcategory
        : nextBucket === "doctor"
          ? "current_physician"
          : "",
      // Hakediş ayı is only valid in the physician bucket (p1 §1.4).
      entitlement_month: nextBucket === "doctor" ? state.entitlement_month : "",
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Kategori">
        <select
          className={inputClass}
          value={state.category_id}
          onChange={(e) => changeCategory(e.target.value)}
          disabled={disabled || lockCategory}
          required
        >
          <option value="">Seçin</option>
          <optgroup label="Kliniğe giriş">
            {categories.filter((c) => c.direction === "in").map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </optgroup>
          <optgroup label="Klinikten çıkış">
            {categories.filter((c) => c.direction === "out").map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>

      <Field
        label="Kişi / kurum"
        hint={
          matched
            ? "Kayıtlı kişi / kurum ile eşleşti."
            : state.counterparty.trim()
              ? "Kayıtlı değil; serbest metin olarak saklanır. Cariler için aynı adı kullanın."
              : undefined
        }
      >
        <input
          className={inputClass}
          list="fin-counterparty-options"
          value={state.counterparty}
          onChange={(e) => set("counterparty", e.target.value)}
          maxLength={200}
          disabled={disabled || lockCounterparty}
          required
        />
        <datalist id="fin-counterparty-options">
          {counterparties.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      </Field>

      {subOptions.length > 0 && (
        <Field label={bucket === "doctor" ? "Hakediş alt türü" : "Gider alt türü"}>
          <select
            className={inputClass}
            value={state.subcategory}
            onChange={(e) => set("subcategory", e.target.value as Subcategory | "")}
            disabled={disabled}
          >
            {subOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      {bucket === "doctor" && (
        <Field
          label="Hakediş ayı (isteğe bağlı)"
          hint="Ödeme bu aydan sonraki bir ayda yapılırsa geçmiş dönem borç ödemesi sayılır."
        >
          <input
            type="month"
            className={inputClass}
            value={state.entitlement_month}
            onChange={(e) => set("entitlement_month", e.target.value)}
            disabled={disabled || lockMonth}
          />
        </Field>
      )}

      <Field label="Toplam tutar (TL)" hint="Örnek: 1.250,50">
        <input
          className={inputClass}
          inputMode="decimal"
          value={state.amount}
          onChange={(e) => set("amount", e.target.value)}
          disabled={disabled}
          required
        />
      </Field>

      {showRealized && (
        <Field label="Durum">
          <select
            className={inputClass}
            value={state.realized ? "realized" : "planned"}
            onChange={(e) => set("realized", e.target.value === "realized")}
            disabled={disabled}
          >
            <option value="realized">Gerçekleşti</option>
            <option value="planned">Planlandı</option>
          </select>
        </Field>
      )}

      <Field label={showRealized && state.realized ? "Gerçekleşme tarihi" : "Vade tarihi"}>
        <input
          type="date"
          className={inputClass}
          value={state.due_date}
          max={showRealized && state.realized ? today : undefined}
          onChange={(e) => set("due_date", e.target.value)}
          disabled={disabled}
          required
        />
      </Field>

      {showRealized && state.realized && (
        <Field label="Hesap">
          <select
            className={inputClass}
            value={state.account_id}
            onChange={(e) => set("account_id", e.target.value)}
            disabled={disabled}
            required
          >
            <option value="">Seçin</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.is_active}>
                {a.name} ({ACCOUNT_KIND_LABELS[a.kind]})
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Açıklama" className="md:col-span-2">
        <textarea
          className={inputClass}
          rows={3}
          maxLength={1000}
          value={state.description}
          onChange={(e) => set("description", e.target.value)}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}
