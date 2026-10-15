"use client";

// Finans ayarları > Döviz kurları (spec p5 §6.6): latest reference rate per currency, manual entry for the owner and
// 'finance' holders (pp_fx_save_rates, source 'manual') and the rate history (fin_fx_history, 20 per page).
// These rates are only suggestions for payment / quote forms; a payment keeps the rate it was recorded with.

import { useCallback, useEffect, useState } from "react";
import { formatDay, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  FOREIGN_CURRENCIES,
  finFxHistory,
  formatRate,
  fxSourceLabel,
  parseRate,
  ppFxRates,
  ppFxSaveRates,
  type ForeignCurrency,
  type FxHistoryJson,
  type FxRatesJson,
} from "@/lib/payments";
import { Card, ErrorBox, Field, Loading, Pager, SuccessBox, buttonPrimary, inputClass } from "./ui";

const PAGE_SIZE = 20;

export function FxRatesSettingsCard({ canWrite }: { canWrite: boolean }) {
  const [latest, setLatest] = useState<FxRatesJson | null>(null);
  const [history, setHistory] = useState<FxHistoryJson | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const [currency, setCurrency] = useState<ForeignCurrency>("EUR");
  const [day, setDay] = useState("");
  const [rateText, setRateText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<FinanceError | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (pageOffset: number) => {
    setLoading(true);
    try {
      const [rates, hist] = await Promise.all([
        ppFxRates(null),
        finFxHistory(null, { offset: pageOffset, limit: PAGE_SIZE }),
      ]);
      setLatest(rates);
      setHistory(hist);
      setLoadError(null);
    } catch (err) {
      setLoadError(toFinanceError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  const today = latest?.today ?? "";
  const rateDay = day || today;
  const parsed = rateText.trim() === "" ? null : parseRate(rateText);
  const noteTooLong = note.trim().length > 500;
  const canSave = !busy && !!today && !!parsed?.ok && !!rateDay && rateDay <= today && !noteTooLong;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave || !parsed?.ok) return;
    setBusy(true);
    setSaveError(null);
    setMessage(null);
    try {
      const res = await ppFxSaveRates(
        [{ currency, rate: parsed.text, rate_on: rateDay, ...(note.trim() ? { note: note.trim() } : {}) }],
        "manual",
        null
      );
      const action = res.saved[0]?.action;
      setMessage(
        action === "unchanged"
          ? "Bu kur zaten kayıtlıydı."
          : action === "updated"
            ? "Kur güncellendi."
            : "Kur kaydedildi."
      );
      setRateText("");
      setNote("");
      if (offset === 0) await load(0);
      else setOffset(0);
    } catch (err) {
      setSaveError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Döviz kurları">
      <p className="text-sm text-gray-600 mb-4">
        Hasta ödemelerinde bu kurlar önerilir; kullanıcı ödeme sırasında değiştirebilir. Ödemeye yazılan kur sonradan
        değişmez. Klinik sahibi ve finans yetkilisi dışındaki kullanıcılar dövizli ödemede kayıtlı kurdan en fazla %10
        farklı kur girebilir.
      </p>

      <ErrorBox error={loadError} />

      {loading && !latest ? (
        <Loading />
      ) : (
        latest && (
          <div className="grid gap-3 sm:grid-cols-3 mb-6">
            {FOREIGN_CURRENCIES.map((c) => {
              const r = latest.rates.find((x) => x.currency === c);
              return (
                <div key={c} className="border rounded p-3">
                  <div className="text-sm text-gray-500">1 {c}</div>
                  {r ? (
                    <>
                      <div className="text-xl font-semibold tabular-nums">{formatRate(r.rate)} ₺</div>
                      <div className="text-xs text-gray-500">
                        {formatDay(r.rate_on)} · {fxSourceLabel(r.source)}
                        {r.age_days > 0 ? ` · ${r.age_days} gün önce` : ""}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-amber-700">Kayıtlı kur yok</div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {canWrite && (
        <form onSubmit={save} className="border-t pt-4 mb-6 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Para birimi">
              <select
                className={inputClass}
                value={currency}
                disabled={busy}
                onChange={(e) => setCurrency(e.target.value as ForeignCurrency)}
              >
                {FOREIGN_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tarih">
              <input
                type="date"
                className={inputClass}
                value={rateDay}
                max={today || undefined}
                disabled={busy || !today}
                onChange={(e) => setDay(e.target.value)}
              />
            </Field>
            <Field label={`Kur (1 ${currency} = ? ₺)`} hint={parsed && !parsed.ok ? parsed.error : undefined}>
              <input
                type="text"
                inputMode="decimal"
                className={inputClass}
                value={rateText}
                placeholder="0,0000"
                autoComplete="off"
                disabled={busy}
                onChange={(e) => setRateText(e.target.value)}
              />
            </Field>
            <Field label="Not" hint={noteTooLong ? "Not en fazla 500 karakter olabilir." : undefined}>
              <input
                type="text"
                className={inputClass}
                value={note}
                maxLength={500}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
          <ErrorBox error={saveError} />
          <SuccessBox text={message} />
          <button type="submit" className={buttonPrimary} disabled={!canSave}>
            {busy ? "Kaydediliyor..." : "Kuru kaydet"}
          </button>
        </form>
      )}

      <h3 className="font-semibold mb-2">Kur geçmişi</h3>
      {history && history.rows.length === 0 ? (
        <p className="text-sm text-gray-500">Kayıtlı kur yok.</p>
      ) : (
        history && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b text-left">
                <tr>
                  <th className="px-3 py-2">Tarih</th>
                  <th className="px-3 py-2">Para birimi</th>
                  <th className="px-3 py-2 text-right">Kur</th>
                  <th className="px-3 py-2">Kaynak</th>
                  <th className="px-3 py-2">Not / dosya</th>
                  <th className="px-3 py-2">Kaydeden</th>
                </tr>
              </thead>
              <tbody>
                {history.rows.map((r) => (
                  <tr key={r.id} className="border-b">
                    <td className="px-3 py-2 whitespace-nowrap">{formatDay(r.rate_on)}</td>
                    <td className="px-3 py-2">{r.currency}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatRate(r.rate)} ₺</td>
                    <td className="px-3 py-2">{fxSourceLabel(r.source)}</td>
                    <td className="px-3 py-2 text-gray-600">{[r.note, r.source_file].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-3 py-2 text-gray-600">{r.updated_by_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {history && (
        <Pager offset={offset} limit={PAGE_SIZE} total={history.total} onChange={setOffset} disabled={loading} />
      )}
    </Card>
  );
}
