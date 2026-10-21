"use client";

import { memo, useEffect, useState } from "react";
import {
  centsToInput,
  entitlementMonthLabel,
  formatDay,
  formatMonth,
  formatTL,
  parseTL,
  sortByOrder,
  type DebtSuggestionRowJson,
  type ImportCheckRowJson,
  type ImportWarningCode,
  type OpenDebtJson,
  type ReferenceData,
  type Subcategory,
} from "@/lib/finance";
import { takesEntitlementMonth } from "@/lib/finance-import/keys";
import { amountPatch, isMatchEligible } from "@/lib/finance-import/matching";
import { keyDay, type Blocker } from "@/lib/finance-import/review";
import { DebtMatchSelect, OpenDebtNotice } from "./DebtMatchSelect";
import { WARNING_LABEL, rowCategory, rowDirection, type WizardRow } from "./review";

export type RowPatch = Partial<
  Pick<
    WizardRow,
    | "selected"
    | "date"
    | "description"
    | "amount"
    | "categoryId"
    | "bucket"
    | "subcategory"
    | "entitlementMonth"
    | "counterpartyId"
    | "match"
    | "matchChosen"
    | "closeRemainder"
    | "ackOpenDebt"
  >
>;

export interface ReviewItem {
  row: WizardRow;
  blockers: Blocker[];
  warnings: ImportWarningCode[];
  check: ImportCheckRowJson | undefined;
  /** fin_debt_candidates_batch answer of an eligible row (0037) */
  suggestion: DebtSuggestionRowJson | undefined;
  /** open debts a new entry of this row would count twice (matching.ts rowOpenDebts); empty when matched */
  openDebts: OpenDebtJson[];
}

/** The review list (IP:65): editable date / description / amount / category, warnings and debt matching. */
export function ReviewTable({
  items,
  refData,
  disabled,
  highlightKey,
  onChange,
}: {
  items: ReviewItem[];
  refData: ReferenceData;
  disabled: boolean;
  highlightKey: string | null;
  onChange: (key: string, patch: RowPatch) => void;
}) {
  return (
    <div className="overflow-x-auto max-h-[70vh] overflow-y-auto border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b sticky top-0 z-10">
          <tr className="text-left text-gray-800">
            <th className="px-2 py-2 font-semibold">Seç</th>
            <th className="px-2 py-2 font-semibold">Tarih / kaynak</th>
            <th className="px-2 py-2 font-semibold min-w-[18rem]">İşlem / kontrol</th>
            <th className="px-2 py-2 font-semibold">Tutar (TL)</th>
            <th className="px-2 py-2 font-semibold min-w-[12rem]">Kategori / hakediş ayı</th>
            <th className="px-2 py-2 font-semibold min-w-[14rem]">Mevcut borca eşleştir</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <ReviewLine
              key={item.row.key}
              item={item}
              refData={refData}
              disabled={disabled}
              highlight={highlightKey === item.row.key}
              onChange={onChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ReviewLine = memo(function ReviewLine({
  item,
  refData,
  disabled,
  highlight,
  onChange,
}: {
  item: ReviewItem;
  refData: ReferenceData;
  disabled: boolean;
  highlight: boolean;
  onChange: (key: string, patch: RowPatch) => void;
}) {
  const { row, blockers, warnings, check, suggestion, openDebts } = item;
  const saved = row.flags.saved;
  const locked = disabled || saved;
  // A row with any blocker cannot be ticked (§11.1); its selection comes back once the problem is fixed.
  const blocked = blockers.length > 0;
  const dir = rowDirection(row);
  const category = rowCategory(refData, row);
  const categories = sortByOrder(refData.categories.filter((c) => c.direction === dir && (c.is_active || c.id === category?.id)));
  // A configured counterparty is used only on entitlement rows (lib usesCounterparty); others show the narration.
  // 0038: Personel rows carry the salary month and the rule's counterparty too.
  const monthBucket = takesEntitlementMonth(category?.report_bucket);
  const cpName =
    row.counterpartyId && row.requiresEntitlementMonth && monthBucket
      ? refData.counterparties.find((c) => c.id === row.counterpartyId)?.name
      : null;
  // Workbook and known-bank keys embed the day (fin_import_rows refuses a different date).
  const dateFixed = keyDay(row.key) !== null;
  const eligible = isMatchEligible(row, category?.direction ?? null, saved);
  const set = (patch: RowPatch) => onChange(row.key, patch);

  return (
    <tr
      id={`import-row-${row.seq}`}
      className={`border-b align-top ${highlight ? "bg-red-50" : saved ? "bg-gray-50 text-gray-500" : ""}`}
    >
      <td className="px-2 py-2">
        <input
          type="checkbox"
          aria-label={`${row.date} ${row.description} seç`}
          disabled={disabled || blocked}
          checked={row.selected && !blocked}
          onChange={(e) => set({ selected: e.target.checked })}
        />
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <input
          type="date"
          aria-label="İşlem tarihi"
          className="px-1 py-0.5 border rounded text-xs"
          disabled={locked || dateFixed}
          title={dateFixed ? "Bu satırın tarihi dosyadan gelir ve kaynak anahtarının parçasıdır; değiştirilemez." : undefined}
          value={row.date}
          onChange={(e) => e.target.value && set({ date: e.target.value, ackOpenDebt: false })}
        />
        <div className="text-xs text-gray-500 max-w-[10rem] truncate" title={row.file}>
          {row.file}
        </div>
        <div className="text-xs text-gray-500">{row.signedCents > 0 ? "Giriş" : "Çıkış"}</div>
      </td>
      <td className="px-2 py-2">
        <textarea
          aria-label="İşlem açıklaması"
          className="w-full px-1 py-0.5 border rounded text-xs"
          rows={2}
          maxLength={900}
          disabled={locked}
          value={row.description}
          onChange={(e) => set({ description: e.target.value })}
        />
        {blockers.map((b) => (
          <div key={b.code} className={`text-xs ${b.code === "saved" && !b.text.startsWith("TUTAR") ? "text-gray-600" : "text-red-700 font-medium"}`}>
            {b.text}
          </div>
        ))}
        {!saved &&
          row.warnings.map((w, i) => (
            <div key={i} className="text-xs text-gray-600">
              {w.text}
            </div>
          ))}
        {!saved &&
          warnings.map((w) => (
            <div key={w} className="text-xs font-semibold text-amber-700">
              {WARNING_LABEL[w]}
              {w === "possible_duplicate" && check?.warnings.find((x) => x.code === w)?.examples?.length ? (
                <ul className="font-normal list-disc pl-4">
                  {check.warnings
                    .find((x) => x.code === w)!
                    .examples!.map((ex) => (
                      <li key={ex.entry_id}>
                        {ex.counterparty_name} · {formatDay(ex.paid_on)} · {formatTL(ex.amount_cents)} · {ex.account_name}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ))}
        {row.meta.formulaCellEmpty && <div className="text-xs text-amber-700">Toplam hücresi boş; tutar ödeme sütunlarından okundu.</div>}
      </td>
      <td className="px-2 py-2">
        <AmountInput cents={row.amount} disabled={locked} onCommit={(amount) => set(amountPatch(row, amount))} />
      </td>
      <td className="px-2 py-2 space-y-1">
        {row.match ? (
          <div className="text-xs text-gray-600">Mevcut borcun kategorisi korunur.</div>
        ) : (
          <>
            <select
              aria-label="Kategori"
              className="w-full px-1 py-0.5 border rounded text-xs bg-white"
              disabled={locked}
              value={category?.id ?? ""}
              onChange={(e) => {
                const c = refData.categories.find((x) => x.id === e.target.value);
                if (!c) return set({ categoryId: null, bucket: null });
                set({
                  categoryId: c.id,
                  bucket: c.report_bucket,
                  subcategory: c.report_bucket === "other_expense" && row.subcategory === "official_fee" ? "official_fee" : null,
                  entitlementMonth: takesEntitlementMonth(c.report_bucket) ? row.entitlementMonth : null,
                  counterpartyId: takesEntitlementMonth(c.report_bucket) ? row.counterpartyId : null,
                });
              }}
            >
              <option value="">Kategori seçin</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {category?.report_bucket === "other_expense" && (
              <select
                aria-label="Alt tür"
                className="w-full px-1 py-0.5 border rounded text-xs bg-white"
                disabled={locked}
                value={row.subcategory === "official_fee" ? "official_fee" : ""}
                onChange={(e) => set({ subcategory: (e.target.value || null) as Subcategory | null })}
              >
                <option value="">Genel gider</option>
                <option value="official_fee">Resmi harç</option>
              </select>
            )}
            {monthBucket && (
              <label className="block text-xs">
                {entitlementMonthLabel(category?.report_bucket)}
                {row.requiresEntitlementMonth ? " (gerekli)" : ""}
                <input
                  type="month"
                  className="w-full px-1 py-0.5 border rounded text-xs"
                  disabled={locked}
                  value={row.entitlementMonth ?? ""}
                  onChange={(e) => set({ entitlementMonth: e.target.value || null })}
                />
              </label>
            )}
            {monthBucket && row.ruleEntitlementMonth && row.entitlementMonth === row.ruleEntitlementMonth && (
              <div className="text-xs text-gray-600">
                {entitlementMonthLabel(category?.report_bucket)}: {formatMonth(row.entitlementMonth)} (kuraldan)
              </div>
            )}
            {cpName && (
              <div className="text-xs text-gray-600">
                Kişi / kurum: {cpName}{" "}
                {!locked && (
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => set({ counterpartyId: null })}>
                    kaldır
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </td>
      <td className="px-2 py-2 space-y-1">
        {eligible ? (
          <DebtMatchSelect
            amount={row.amount}
            date={row.date}
            description={row.description}
            suggestion={suggestion}
            value={row.match}
            closeRemainder={row.closeRemainder}
            disabled={disabled}
            onChange={set}
          />
        ) : saved ? (
          <span className="text-xs text-gray-500">Kaydedilmiş satır</span>
        ) : (
          <span className="text-xs text-gray-500">Banka ve klinik Excel gider satırlarında kullanılabilir.</span>
        )}
        {!saved && !row.match && (
          <OpenDebtNotice
            debts={openDebts}
            higher={eligible ? (suggestion?.higher ?? null) : null}
            ack={row.ackOpenDebt}
            disabled={disabled}
            onAck={(ackOpenDebt) => set(ackOpenDebt ? { ackOpenDebt, matchChosen: true } : { ackOpenDebt })}
          />
        )}
      </td>
    </tr>
  );
});

function AmountInput({ cents, disabled, onCommit }: { cents: number; disabled: boolean; onCommit: (cents: number) => void }) {
  const [text, setText] = useState(centsToInput(cents));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(centsToInput(cents));
  }, [cents]);
  return (
    <div>
      <input
        aria-label="Tutar"
        className="w-28 px-1 py-0.5 border rounded text-xs text-right tabular-nums"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const p = parseTL(text);
          if (!p.ok) return setError(p.error);
          setError(null);
          if (p.cents !== cents) onCommit(p.cents);
        }}
      />
      <div className="text-xs text-gray-500 tabular-nums">{formatTL(cents)}</div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
