"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, ErrorBox, MoneyRow, SuccessBox, buttonPrimary, buttonSecondary } from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  finBalanceHistory,
  finImportBalances,
  finSetAccountImportKey,
  formatDay,
  formatTL,
  sortByOrder,
  toFinanceError,
  type FinanceError,
  type ImportSetupJson,
  type ReferenceData,
  type SnapshotJson,
} from "@/lib/finance";
import { toBalancePayload } from "@/lib/finance-import/balances";
import type { BalanceSource } from "@/lib/finance-import/types";

/**
 * Balances read from the files (legacy BP, merge rules C17). Preview = fin_import_balances with p_dry_run;
 * the save repeats the same call for real. Importing movements never changes balances, and saving balances never
 * creates movements.
 */
export function BalancePreviewCard({
  candidates,
  setup,
  refData,
  today,
  disabled,
  onSetupChanged,
}: {
  candidates: BalanceSource[];
  setup: ImportSetupJson;
  refData: ReferenceData;
  today: string;
  disabled: boolean;
  onSetupChanged: () => Promise<unknown>;
}) {
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const [initialize, setInitialize] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [current, setCurrent] = useState<SnapshotJson | null | undefined>(undefined);
  const [preview, setPreview] = useState<{ key: string; snapshot: SnapshotJson } | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCurrent = useCallback(async () => {
    try {
      const page = await finBalanceHistory(0, 1);
      setCurrent(page.rows.find((r) => r.id === page.current_snapshot_id) ?? null);
    } catch (err) {
      setError(toFinanceError(err));
    }
  }, []);

  useEffect(() => {
    loadCurrent();
  }, [loadCurrent]);

  if (!candidates.length) return null;

  const mappedAccount = (s: BalanceSource) =>
    s.kind === "cash"
      ? null
      : setup.accounts.find((a) => a.import_key === s.importKey && a.is_active && (a.kind === "bank" || a.kind === "pos"));
  const selected = candidates.filter((c) => !unchecked.includes(c.importKey));
  const unmapped = selected.filter((s) => s.kind === "bank" && !mappedAccount(s));
  const needsInit = current !== undefined && (!current || current.bank_mode === "manual");
  const key = JSON.stringify([selected, initialize && needsInit, current?.id ?? null, current?.updated_at ?? null]);
  const previewValid = preview !== null && preview.key === key;

  const run = async (dryRun: boolean) => {
    setError(null);
    setMessage(null);
    if (!selected.length) return;
    setBusy(true);
    try {
      const res = await finImportBalances({
        p_sources: selected.map(toBalancePayload),
        p_base_updated_at: current?.updated_at ?? null,
        p_initialize_banks: initialize && needsInit,
        p_dry_run: dryRun,
      });
      if (dryRun) setPreview({ key, snapshot: res.snapshot });
      else {
        setMessage(
          res.already_saved
            ? "Bakiyeler zaten bu değerlerle kayıtlı."
            : "Banka / kasa bakiyesi güncellendi. Tahsilat veya gider kaydı eklenmedi."
        );
        setPreview(null);
        setConfirmed(false);
        await loadCurrent();
      }
    } catch (err) {
      setError(toFinanceError(err));
      if (toFinanceError(err).isConflict) await loadCurrent();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Dosyalardan okunan bakiyeler">
      <p className="text-sm text-gray-600 mb-3">
        Bunlar hesap ve kasa bakiyeleridir; işlem toplamları üzerlerine eklenmez. Hareket aktarımından ayrı kaydedilir.
        Excel kasa hücreleri dosyada son kaydedilmiş değerlerdir; yüklemeden önce Excel’i hesaplatıp kaydedin.
      </p>
      <div className="space-y-2">
        {candidates.map((c) => {
          const acc = mappedAccount(c);
          return (
            <div key={c.importKey} className="flex flex-wrap items-start gap-3 text-sm border-b pb-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={!unchecked.includes(c.importKey)}
                disabled={disabled || busy}
                onChange={(e) => {
                  setConfirmed(false);
                  setUnchecked((old) => (e.target.checked ? old.filter((k) => k !== c.importKey) : [...old, c.importKey]));
                }}
              />
              <div className="flex-1 min-w-[14rem]">
                <div className="font-medium">
                  {c.label} · {formatTL(c.amountCents)}
                </div>
                <div className="text-xs text-gray-500">
                  {formatDay(c.day)} · {c.file}
                  {c.day < today && " · Bugünden eski bakiye"}
                </div>
                <div className="text-xs text-gray-500">{c.note}</div>
                {c.kind === "bank" &&
                  (acc ? (
                    <div className="text-xs text-gray-700">Finans hesabı: {acc.name}</div>
                  ) : (
                    <LinkAccount source={c} refData={refData} disabled={disabled || busy} onLinked={onSetupChanged} />
                  ))}
              </div>
            </div>
          );
        })}
      </div>
      {needsInit && (
        <label className="flex items-start gap-2 text-sm mt-3">
          <input type="checkbox" className="mt-1" checked={initialize} disabled={disabled || busy} onChange={(e) => { setInitialize(e.target.checked); setConfirmed(false); }} />
          İlk aktarım: tüm banka hesaplarımı seçtim (banka aktarıyorsam). Seçili dosya bakiyelerinin, gösterilen tarihleriyle
          elle girilmiş tutarların yerine geçmesini onaylıyorum.
        </label>
      )}
      {unmapped.length > 0 && (
        <p className="text-sm text-amber-700 mt-2">Eşleşmemiş hesapların seçimini kaldırın veya hesabı bağlayın.</p>
      )}
      <ErrorBox error={error} onReload={loadCurrent} />
      <SuccessBox text={message} />
      {previewValid && preview && (
        <div className="rounded border border-blue-200 bg-blue-50 p-3 mt-3 space-y-1 text-sm">
          <p className="font-semibold">Önizleme · henüz kaydedilmedi</p>
          <MoneyRow label={`Banka: mevcut ${formatTL(current?.bank_cents ?? null)} → yeni`} cents={preview.snapshot.bank_cents} />
          <MoneyRow label={`Kasa: mevcut ${formatTL(current?.cash_cents ?? null)} → yeni`} cents={preview.snapshot.cash_cents} />
          <MoneyRow label="Yeni toplam likit" cents={preview.snapshot.liquid_cents} strong />
          {preview.snapshot.sources
            .filter((s) => s.kind === "bank" && !selected.some((c) => c.kind === "bank" && mappedAccount(c)?.id === s.account_id))
            .map((s) => (
              <p key={s.id} className="text-xs text-gray-600">
                Korunan hesap: {s.label} · {formatDay(s.as_of)} · {formatTL(s.amount_cents)}
              </p>
            ))}
          <p className="text-xs text-gray-600">
            Banka bilgisi en eski {formatDay(preview.snapshot.bank_as_of)}, kasa bilgisi {formatDay(preview.snapshot.cash_as_of)} tarihli.
            Dosyalar aynı güne ait olmayabilir.
          </p>
          <label className="flex items-start gap-2 pt-2">
            <input type="checkbox" className="mt-1" checked={confirmed} disabled={disabled || busy} onChange={(e) => setConfirmed(e.target.checked)} />
            Seçili hesapları, tarihleri ve yeni toplamları kontrol ettim.
          </label>
        </div>
      )}
      {preview && !previewValid && <p className="text-xs text-amber-700 mt-2">Seçim önizlemeden sonra değişti; yeniden önizleyin.</p>}
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className={buttonSecondary} disabled={disabled || busy || !selected.length || unmapped.length > 0 || current === undefined} onClick={() => run(true)}>
          {busy && !previewValid ? "Hesaplanıyor..." : "Önizle"}
        </button>
        <button type="button" className={buttonPrimary} disabled={disabled || busy || !previewValid || !confirmed} onClick={() => run(false)}>
          {busy && previewValid ? "Bakiyeler kaydediliyor..." : "Önizlemedeki bakiyeleri güncelle"}
        </button>
      </div>
    </Card>
  );
}

function LinkAccount({
  source,
  refData,
  disabled,
  onLinked,
}: {
  source: BalanceSource;
  refData: ReferenceData;
  disabled: boolean;
  onLinked: () => Promise<unknown>;
}) {
  const free = sortByOrder(refData.accounts.filter((a) => a.is_active && (a.kind === "bank" || a.kind === "pos") && !a.import_key));
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FinanceError | null>(null);
  const link = async () => {
    const acc = free.find((a) => a.id === pick);
    if (!acc) return;
    setBusy(true);
    setError(null);
    try {
      await finSetAccountImportKey({ p_id: acc.id, p_version: acc.version, p_import_key: source.importKey });
      await onLinked();
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 space-y-1">
      <div className="text-xs text-amber-700">Bu hesap bir finans hesabıyla eşleşmemiş.</div>
      <div className="flex flex-wrap gap-2">
        <select className="px-2 py-1 border rounded text-sm" value={pick} onChange={(e) => setPick(e.target.value)} disabled={disabled || busy}>
          <option value="">Banka / POS hesabı seçin</option>
          {free.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({ACCOUNT_KIND_LABELS[a.kind]})
            </option>
          ))}
        </select>
        <button type="button" className="px-3 py-1 border rounded text-sm hover:bg-gray-50 disabled:opacity-40" disabled={disabled || busy || !pick} onClick={link}>
          Hesabı bağla
        </button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
