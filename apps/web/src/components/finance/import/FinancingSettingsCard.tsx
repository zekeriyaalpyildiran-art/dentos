"use client";

import { useState } from "react";
import { Card, ErrorBox, Field, SuccessBox, buttonPrimary, inputClass } from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  COUNTERPARTY_KIND_LABELS,
  finSaveImportSettings,
  pickable,
  sortByOrder,
  toFinanceError,
  type FinanceError,
  type ImportSetupJson,
  type ReferenceData,
} from "@/lib/finance";

/** fin_save_import_settings: the financing bank (counterparty), the fee account and the default block period. */
export function FinancingSettingsCard({
  setup,
  refData,
  canWrite,
  onSaved,
}: {
  setup: ImportSetupJson;
  refData: ReferenceData;
  canWrite: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const s = setup.settings;
  const [counterpartyId, setCounterpartyId] = useState(s.financing_counterparty_id ?? "");
  const [accountId, setAccountId] = useState(s.financing_account_id ?? "");
  const [days, setDays] = useState(String(s.default_block_days));
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const counterparties = pickable(refData.counterparties, s.financing_counterparty_id).sort(
    (a, b) => Number(b.kind === "bank") - Number(a.kind === "bank") || a.name.localeCompare(b.name, "tr-TR")
  );
  const accounts = pickable(
    sortByOrder(refData.accounts.filter((a) => a.kind === "bank" || a.kind === "pos")),
    s.financing_account_id
  );
  const cpName = refData.counterparties.find((c) => c.id === s.financing_counterparty_id)?.name;
  const accName = refData.accounts.find((a) => a.id === s.financing_account_id)?.name;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    setMessage(null);
    const d = Number(days);
    if (!Number.isInteger(d) || d < 0 || d > 365) return setFormError("Bloke süresi 0 ile 365 gün arasında olmalı.");
    setBusy(true);
    try {
      const res = await finSaveImportSettings({
        p_version: s.version,
        p_financing_receipts_source: "clinic_excel",
        p_default_block_days: d,
        p_financing_counterparty_id: counterpartyId || null,
        p_financing_account_id: accountId || null,
      });
      setMessage(res.already_saved ? "Ayarlar zaten bu değerlerle kayıtlı." : "Hasta finansmanı ayarları kaydedildi.");
      await onSaved();
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Hasta finansmanı ayarları">
      {!setup.financing_ready && (
        <p className="text-sm text-amber-700 mb-3">
          Finansman aktarmadan önce finansmanı sağlayan bankayı (kişi / kurum kaydı) ve kesintilerin ödendiği banka
          hesabını seçin. Banka kaydı yoksa Finans ayarları &gt; Kişi / kurumlar bölümünden “Banka / finans kurumu”
          türünde ekleyin.
        </p>
      )}
      {canWrite ? (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Finansman bankası (kişi / kurum)" hint="Kesinti kayıtları bu kişi / kurum altında toplanır.">
              <select className={inputClass} value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)}>
                <option value="">Seçin</option>
                {counterparties.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({COUNTERPARTY_KIND_LABELS[c.kind]}){c.is_active ? "" : " · pasif"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kesintilerin ödendiği hesap">
              <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Seçin</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({ACCOUNT_KIND_LABELS[a.kind]}){a.is_active ? "" : " · pasif"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Varsayılan bloke süresi (gün)" hint="Blokeli dökümlerde tahmini çözülme tarihi için.">
              <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-gray-500">
            Brüt tutarın kaynağı: klinik Excel günlük tahsilatı. DentOS tahsilat kaynağı, hasta tahsilatları modülüyle
            açılacak.
          </p>
          {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
          <ErrorBox error={error} />
          <SuccessBox text={message} />
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor..." : "Ayarları kaydet"}
          </button>
        </form>
      ) : (
        <div className="text-sm text-gray-700 space-y-1">
          <div>Finansman bankası: {cpName ?? "—"}</div>
          <div>Kesinti hesabı: {accName ?? "—"}</div>
          <div>Varsayılan bloke süresi: {s.default_block_days} gün</div>
        </div>
      )}
    </Card>
  );
}
