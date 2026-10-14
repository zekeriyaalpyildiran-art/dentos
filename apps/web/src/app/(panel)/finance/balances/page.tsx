"use client";

import { useCallback, useEffect, useState } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { useReferenceData } from "@/components/finance/useReferenceData";
import {
  Card,
  ErrorBox,
  Field,
  Loading,
  Modal,
  MoneyRow,
  Pager,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  centsToInput,
  finBalanceHistory,
  finMergeBalanceSources,
  finSaveBalance,
  formatDay,
  formatTL,
  formatTimestamp,
  isDay,
  parseTL,
  sortByOrder,
  toFinanceError,
  type AccountJson,
  type BalanceAccountItem,
  type BalanceHistoryJson,
  type FinanceError,
  type MergeSourceItem,
  type ReferenceData,
  type SnapshotJson,
} from "@/lib/finance";

const PAGE_SIZE = 30;

export default function FinanceBalancesPage() {
  return (
    <FinanceShell title="Banka ve kasa bakiyeleri">
      <Balances />
    </FinanceShell>
  );
}

type DialogState = { kind: "declare"; snapshot: SnapshotJson | null } | { kind: "merge" };

/** Accounts that can carry a per-account bank balance (E_BALANCE_ACCOUNT: active bank or POS). */
function balanceAccounts(ref: ReferenceData): AccountJson[] {
  return sortByOrder(ref.accounts.filter((a) => a.is_active && (a.kind === "bank" || a.kind === "pos")));
}

function Balances() {
  const canWrite = useCanWriteFinance();
  const ref = useReferenceData();
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<BalanceHistoryJson | null>(null);
  const [current, setCurrent] = useState<SnapshotJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await finBalanceHistory(offset, PAGE_SIZE);
      setData(page);
      // The current snapshot (latest day <= today) is the merge base; fetch it when it is not on this page.
      let cur = page.rows.find((r) => r.id === page.current_snapshot_id) ?? null;
      if (!cur && page.current_snapshot_id) {
        const first = await finBalanceHistory(0, 1);
        cur = first.rows.find((r) => r.id === first.current_snapshot_id) ?? null;
      }
      setCurrent(cur);
      setError(null);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  const done = async (text: string) => {
    setDialog(null);
    setMessage(text);
    await load();
  };

  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onReload={load} />;

  const knownSnapshots = current ? [current, ...data.rows] : data.rows;

  return (
    <div className="space-y-6">
      <SuccessBox text={message} />
      <ErrorBox error={error ?? ref.error} onReload={load} />

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <Card
          title="Güncel bakiye"
          actions={
            canWrite && ref.data ? (
              <>
                <button
                  type="button"
                  className={buttonPrimary}
                  onClick={() =>
                    setDialog({ kind: "declare", snapshot: current && current.day === data.today ? current : null })
                  }
                >
                  Banka / kasa güncelle
                </button>
                <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "merge" })}>
                  Yalnızca seçili hesapları güncelle
                </button>
              </>
            ) : undefined
          }
        >
          {current ? (
            <>
              <MoneyRow label="Banka" cents={current.bank_cents} hint={`En eski banka tarihi: ${formatDay(current.bank_as_of)}`} />
              <MoneyRow label="Nakit kasa" cents={current.cash_cents} hint={`Tarih: ${formatDay(current.cash_as_of)}`} />
              <MoneyRow label="Toplam likit" cents={current.liquid_cents} strong />
              <p className="text-xs text-gray-500 mt-2">
                Bakiye günü {formatDay(current.day)} · {current.bank_mode === "manual" ? "Banka toplamı manuel" : "Hesap bazında"}
                {!current.is_today && " · Bakiye bugüne ait değil; tahminler eski bakiyeye dayanıyor."}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-600">Başlamak için gerçek banka ve kasa bakiyelerini gir.</p>
          )}
        </Card>

        {current && (
          <Card title="Bakiye kaynakları">
            <div className="divide-y">
              {current.sources.map((s) => (
                <div key={s.id} className="flex justify-between gap-4 py-2 text-sm">
                  <div>
                    <span className="font-medium">{s.label}</span>
                    <span className="text-gray-500">
                      {" "}
                      · {formatDay(s.as_of)}
                      {s.is_older_than_today && <span className="text-amber-700"> · Bugünden eski</span>}
                    </span>
                    {s.note && <div className="text-xs text-gray-500">{s.note}</div>}
                  </div>
                  <div className="tabular-nums whitespace-nowrap">{formatTL(s.amount_cents)}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Bakiyeler beyan edilir; ödeme / tahsilat hareketleri bu bakiyelere otomatik eklenmez.
            </p>
          </Card>
        )}
      </div>

      <Card title="Bakiye geçmişi">
        {loading && <p className="text-sm text-gray-500 mb-2">Güncelleniyor...</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr className="text-left text-gray-800">
                <th className="px-3 py-2 font-semibold">Tarih</th>
                <th className="px-3 py-2 font-semibold text-right">Banka</th>
                <th className="px-3 py-2 font-semibold text-right">Nakit</th>
                <th className="px-3 py-2 font-semibold text-right">Toplam</th>
                <th className="px-3 py-2 font-semibold">Banka girişi</th>
                <th className="px-3 py-2 font-semibold">Son değişiklik</th>
                {canWrite && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                    Henüz bakiye girilmedi.
                  </td>
                </tr>
              ) : (
                data.rows.map((s) => (
                  <tr key={s.id} className="border-b text-gray-900">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatDay(s.day)}
                      {s.id === data.current_snapshot_id && <span className="text-xs text-green-700"> · güncel</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTL(s.bank_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTL(s.cash_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{formatTL(s.liquid_cents)}</td>
                    <td className="px-3 py-2">{s.bank_mode === "manual" ? "Manuel toplam" : "Hesap bazında"}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {s.updated_by_name ?? "—"} · {formatTimestamp(s.updated_at)}
                      {s.note && <div>{s.note}</div>}
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="text-blue-600 hover:underline"
                          disabled={!ref.data}
                          onClick={() => setDialog({ kind: "declare", snapshot: s })}
                        >
                          Düzelt
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager offset={data.offset} limit={data.limit} total={data.total_count} onChange={setOffset} disabled={loading} />
      </Card>

      {dialog?.kind === "declare" && ref.data && (
        <DeclareDialog
          refData={ref.data}
          today={data.today}
          snapshot={dialog.snapshot}
          base={current}
          known={knownSnapshots}
          onClose={() => setDialog(null)}
          onReload={load}
          onDone={done}
        />
      )}
      {dialog?.kind === "merge" && ref.data && (
        <MergeDialog
          refData={ref.data}
          today={data.today}
          current={current}
          onClose={() => setDialog(null)}
          onReload={load}
          onDone={done}
        />
      )}
    </div>
  );
}

interface AccountLine {
  include: boolean;
  amount: string;
  as_of: string;
}

/**
 * 'Banka / kasa güncelle' and 'Düzelt' (fin_save_balance): the complete balance of one day.
 * A new declaration is always for today; an older day is corrected only through 'Düzelt' in the history, which
 * passes that day's snapshot (and so its version). In 'Hesap bazında' mode the list is the complete bank side of
 * the day, so a new declaration starts from the current snapshot's accounts (amount and date kept).
 */
function DeclareDialog({
  refData,
  today,
  snapshot,
  base,
  known,
  onClose,
  onReload,
  onDone,
}: {
  refData: ReferenceData;
  today: string;
  snapshot: SnapshotJson | null;
  base: SnapshotJson | null;
  known: SnapshotJson[];
  onClose: () => void;
  onReload: () => Promise<void>;
  onDone: (text: string) => Promise<void>;
}) {
  const accounts = balanceAccounts(refData);
  const day = snapshot?.day ?? today;
  // Prefill source for the per-account lines: the edited day, else the current snapshot (legacy BI:31 keeps the
  // accounts that are not re-entered; here they stay ticked with their last amount and date).
  const prefill = snapshot ?? base;
  const [mode, setMode] = useState<"manual" | "accounts">(prefill?.bank_mode ?? "manual");
  const [bankTotal, setBankTotal] = useState(snapshot && snapshot.bank_mode === "manual" ? centsToInput(snapshot.bank_cents) : "");
  const [lines, setLines] = useState<Record<string, AccountLine>>(() => {
    const out: Record<string, AccountLine> = {};
    for (const a of accounts) {
      const src = prefill?.sources.find((s) => s.kind === "bank" && s.account_id === a.id);
      out[a.id] = { include: !!src, amount: src ? centsToInput(src.amount_cents) : "", as_of: src?.as_of ?? "" };
    }
    return out;
  });
  const [cash, setCash] = useState(snapshot ? centsToInput(snapshot.cash_cents) : "");
  const [note, setNote] = useState(snapshot?.note ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  // p_version: the version of that day's snapshot as last read, 0 when the day has none (RT:26). 'Düzelt' passes
  // the row itself; a new declaration is for today, whose snapshot (if any) is the current one in `known`.
  const existing = snapshot ?? known.find((s) => s.day === day) ?? null;

  const setLine = (id: string, patch: Partial<AccountLine>) =>
    setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    if (!isDay(day) || day > today) return setFormError("Gerçek bakiye için gelecek tarih seçilemez.");

    let bankTotalCents: number | null = null;
    let bankAccounts: BalanceAccountItem[] | null = null;
    if (mode === "manual") {
      const p = parseTL(bankTotal, { allowNegative: true, allowZero: true });
      if (!p.ok) return setFormError(`Banka: ${p.error}`);
      bankTotalCents = p.cents;
    } else {
      bankAccounts = [];
      for (const a of accounts) {
        const line = lines[a.id];
        if (!line?.include) continue;
        const p = parseTL(line.amount, { allowNegative: true, allowZero: true });
        if (!p.ok) return setFormError(`${a.name}: ${p.error}`);
        if (line.as_of && (!isDay(line.as_of) || line.as_of > day)) {
          return setFormError(`${a.name}: hesap tarihi bakiye gününden sonra olamaz.`);
        }
        bankAccounts.push({ account_id: a.id, amount_cents: p.cents, as_of: line.as_of || null });
      }
      if (bankAccounts.length === 0) return setFormError("En az bir banka hesabı seçin.");
    }
    const c = parseTL(cash, { allowZero: true });
    if (!c.ok) return setFormError(`Nakit kasa: ${c.error}`);
    if (note.length > 1000) return setFormError("Not en fazla 1000 karakter olabilir.");

    setBusy(true);
    try {
      const res = await finSaveBalance({
        p_day: day,
        p_version: existing?.version ?? 0,
        p_bank_total_cents: bankTotalCents,
        p_bank_accounts: bankAccounts,
        p_cash_cents: c.cents,
        p_note: note.trim(),
      });
      await onDone(res.already_saved ? "Bakiye zaten bu değerlerle kayıtlı." : `${formatDay(day)} bakiyesi kaydedildi.`);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={snapshot ? `Bakiyeyi düzelt · ${formatDay(snapshot.day)}` : "Banka / kasa güncelle"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Bakiye tarihi"
          hint={
            existing
              ? "Bu günün kaydı güncellenecek."
              : "Bugün için yeni kayıt oluşturulacak. Geçmiş bir günü düzeltmek için bakiye geçmişindeki 'Düzelt' düğmesini kullan."
          }
        >
          <input type="date" className={inputClass} value={day} disabled required readOnly />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-gray-800 mb-1">Banka</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} />
            Toplam tutar
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={mode === "accounts"} onChange={() => setMode("accounts")} disabled={accounts.length === 0} />
            Hesap bazında
            {accounts.length === 0 && <span className="text-xs text-gray-500">(aktif banka / POS hesabı yok)</span>}
          </label>
        </fieldset>

        {mode === "manual" ? (
          <>
            <Field label="Kullanılabilir banka toplamı (blokeler hariç, TL)" hint="Negatif olabilir.">
              <input className={inputClass} inputMode="decimal" value={bankTotal} onChange={(e) => setBankTotal(e.target.value)} required />
            </Field>
            <p className="text-xs text-amber-700">
              Manuel toplam girersen hesap bazındaki dağılım sıfırlanır; sonraki banka girişinde tüm hesapları birlikte gir.
            </p>
          </>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <div key={a.id} className="grid grid-cols-12 gap-2 items-center">
                <label className="col-span-4 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={lines[a.id]?.include ?? false} onChange={(e) => setLine(a.id, { include: e.target.checked })} />
                  {a.name} <span className="text-xs text-gray-500">({ACCOUNT_KIND_LABELS[a.kind]})</span>
                </label>
                <input
                  className={`${inputClass} col-span-4`}
                  inputMode="decimal"
                  placeholder="Tutar (TL)"
                  value={lines[a.id]?.amount ?? ""}
                  onChange={(e) => setLine(a.id, { amount: e.target.value })}
                  disabled={!lines[a.id]?.include}
                />
                <input
                  type="date"
                  className={`${inputClass} col-span-4`}
                  title="Hesap tarihi (boşsa bakiye günü)"
                  value={lines[a.id]?.as_of ?? ""}
                  max={day}
                  onChange={(e) => setLine(a.id, { as_of: e.target.value })}
                  disabled={!lines[a.id]?.include}
                />
              </div>
            ))}
            <p className="text-xs text-gray-500">Hesap tarihi boş bırakılırsa bakiye günü kullanılır.</p>
            <p className="text-xs text-amber-700">
              İşaretlenmeyen hesaplar bu günün bakiyesinden çıkarılır. Yalnızca bazı hesapları güncellemek için
              &quot;Yalnızca seçili hesapları güncelle&quot; seçeneğini kullan.
            </p>
          </div>
        )}

        <Field label="Nakit kasa (TL)">
          <input className={inputClass} inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} required />
        </Field>
        <Field label="Not">
          <textarea className={inputClass} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 'Yalnızca seçili hesapları güncelle' (fin_merge_balance_sources): today's snapshot keeps the other accounts. */
function MergeDialog({
  refData,
  today,
  current,
  onClose,
  onReload,
  onDone,
}: {
  refData: ReferenceData;
  today: string;
  current: SnapshotJson | null;
  onClose: () => void;
  onReload: () => Promise<void>;
  onDone: (text: string) => Promise<void>;
}) {
  const accounts = balanceAccounts(refData);
  const [lines, setLines] = useState<Record<string, AccountLine>>(() =>
    Object.fromEntries(accounts.map((a) => [a.id, { include: false, amount: "", as_of: today }]))
  );
  const [cashLine, setCashLine] = useState<AccountLine>({ include: !current, amount: "", as_of: today });
  const [initialize, setInitialize] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const needsInit = !current || current.bank_mode === "manual";
  // Legacy shows the merged result before it is saved (BP:9-13): 'Önizle' runs the RPC with p_dry_run (nothing is
  // written), and 'Kaydet' is enabled only while the inputs and the base are exactly those of the preview.
  const [preview, setPreview] = useState<{ key: string; snapshot: SnapshotJson } | null>(null);

  const setLine = (id: string, patch: Partial<AccountLine>) =>
    setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const buildSources = (): { sources: MergeSourceItem[] } | { error: string } => {
    const sources: MergeSourceItem[] = [];
    for (const a of accounts) {
      const line = lines[a.id];
      if (!line?.include) continue;
      const p = parseTL(line.amount, { allowNegative: true, allowZero: true });
      if (!p.ok) return { error: `${a.name}: ${p.error}` };
      if (!isDay(line.as_of) || line.as_of > today) return { error: `${a.name}: Gelecek tarihli bakiye kaydedilemez.` };
      sources.push({ kind: "bank", account_id: a.id, amount_cents: p.cents, as_of: line.as_of, label: null, file_name: null, note: null });
    }
    if (cashLine.include) {
      const p = parseTL(cashLine.amount, { allowZero: true });
      if (!p.ok) return { error: `Nakit kasa: ${p.error}` };
      if (!isDay(cashLine.as_of) || cashLine.as_of > today) return { error: "Nakit kasa: Gelecek tarihli bakiye kaydedilemez." };
      sources.push({ kind: "cash", account_id: null, amount_cents: p.cents, as_of: cashLine.as_of, label: null, file_name: null, note: null });
    }
    if (sources.length === 0) return { error: "En az bir bakiye seçin." };
    return { sources };
  };

  const built = buildSources();
  const init = needsInit && initialize;
  const currentKey =
    "sources" in built ? JSON.stringify([built.sources, init, current?.id ?? null, current?.version ?? null]) : null;
  const previewValid = preview !== null && currentKey !== null && preview.key === currentKey;

  const run = async (dryRun: boolean) => {
    setFormError(null);
    setError(null);
    if ("error" in built) return setFormError(built.error);
    setBusy(true);
    try {
      const res = await finMergeBalanceSources({
        p_base_snapshot_id: current?.id ?? null,
        p_base_version: current?.version ?? null,
        p_sources: built.sources,
        p_initialize_banks: init,
        p_dry_run: dryRun,
      });
      if (dryRun) {
        setPreview({ key: currentKey ?? "", snapshot: res.snapshot });
        setBusy(false);
        return;
      }
      await onDone(res.already_saved ? "Bakiyeler zaten bu değerlerle kayıtlı." : "Bugünün bakiyesi güncellendi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    await run(!previewValid);
  };

  return (
    <Modal title="Yalnızca seçili hesapları güncelle" onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700">
          Seçtiğin hesaplar bugünün bakiyesine işlenir; seçmediğin hesaplar son okunan tutar ve tarihiyle korunur. Eksik
          banka dökümü o hesabı sıfırlamaz.
          {current && ` Temel bakiye: ${formatDay(current.day)} (${formatTL(current.liquid_cents)}).`}
        </p>
        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-4 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={lines[a.id]?.include ?? false} onChange={(e) => setLine(a.id, { include: e.target.checked })} />
                {a.name} <span className="text-xs text-gray-500">({ACCOUNT_KIND_LABELS[a.kind]})</span>
              </label>
              <input
                className={`${inputClass} col-span-4`}
                inputMode="decimal"
                placeholder="Tutar (TL)"
                value={lines[a.id]?.amount ?? ""}
                onChange={(e) => setLine(a.id, { amount: e.target.value })}
                disabled={!lines[a.id]?.include}
              />
              <input
                type="date"
                className={`${inputClass} col-span-4`}
                value={lines[a.id]?.as_of ?? today}
                max={today}
                onChange={(e) => setLine(a.id, { as_of: e.target.value })}
                disabled={!lines[a.id]?.include}
              />
            </div>
          ))}
          <div className="grid grid-cols-12 gap-2 items-center">
            <label className="col-span-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={cashLine.include} onChange={(e) => setCashLine({ ...cashLine, include: e.target.checked })} />
              Nakit kasa
            </label>
            <input
              className={`${inputClass} col-span-4`}
              inputMode="decimal"
              placeholder="Tutar (TL)"
              value={cashLine.amount}
              onChange={(e) => setCashLine({ ...cashLine, amount: e.target.value })}
              disabled={!cashLine.include}
            />
            <input
              type="date"
              className={`${inputClass} col-span-4`}
              value={cashLine.as_of}
              max={today}
              onChange={(e) => setCashLine({ ...cashLine, as_of: e.target.value })}
              disabled={!cashLine.include}
            />
          </div>
        </div>
        {needsInit && (
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="checkbox" className="mt-1" checked={initialize} onChange={(e) => setInitialize(e.target.checked)} />
            İlk hesap bazlı girişte tüm banka hesaplarını girdiğimi onaylıyorum. Eski toplamın hesap dağılımı bilinmiyor.
          </label>
        )}
        {previewValid && preview && <MergePreview snapshot={preview.snapshot} />}
        {preview && !previewValid && (
          <p className="text-xs text-amber-700">Girdiler önizlemeden sonra değişti; kaydetmeden önce yeniden önizle.</p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonSecondary} onClick={() => run(true)} disabled={busy}>
            {busy && !previewValid ? "Hesaplanıyor..." : "Önizle"}
          </button>
          <button type="submit" className={buttonPrimary} disabled={busy || !previewValid}>
            {busy && previewValid ? "Kaydediliyor..." : "Kaydet"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Result of a dry-run merge: today's balance as it will be saved, with every source and its date. */
function MergePreview({ snapshot }: { snapshot: SnapshotJson }) {
  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-3 space-y-2">
      <p className="text-sm font-semibold text-gray-900">Önizleme · henüz kaydedilmedi</p>
      <MoneyRow label="Banka" cents={snapshot.bank_cents} hint={`En eski banka tarihi: ${formatDay(snapshot.bank_as_of)}`} />
      <MoneyRow label="Nakit kasa" cents={snapshot.cash_cents} hint={`Tarih: ${formatDay(snapshot.cash_as_of)}`} />
      <MoneyRow label="Toplam likit" cents={snapshot.liquid_cents} strong />
      <div className="divide-y text-sm">
        {snapshot.sources.map((s) => (
          <div key={s.id} className="flex justify-between gap-4 py-1">
            <span>
              {s.label}
              <span className="text-gray-500">
                {" "}
                · {formatDay(s.as_of)}
                {s.is_older_than_today && <span className="text-amber-700"> · Bugünden eski</span>}
              </span>
            </span>
            <span className="tabular-nums whitespace-nowrap">{formatTL(s.amount_cents)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
