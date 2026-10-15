"use client";

// "Satın alma ve finans bağlantısı" settings (spec p8_purchasing §12.8, RPC §5.6, §6.6).
// The approval rule is owner-only; the payable link only for 'finance' holders (owner decision: default OFF).
// Only changed keys are sent, so a role that may change one setting never trips the check of another.

import { useCallback, useEffect, useRef, useState } from "react";
import { finReferenceData, type CategoryJson } from "@/lib/finance";
import {
  newKey,
  stockSaveSettings,
  stockSettingsGet,
  toStockError,
  type StockError,
  type StockSettingsInput,
  type StockSettingsJson,
} from "@/lib/stock/rpc";
import { Card, Field, Loading, Notice, buttonPrimary, stockInput } from "../ui";
import { PurchasingErrorBox } from "./common";

export function PurchasingSettings() {
  const [settings, setSettings] = useState<StockSettingsJson | null>(null);
  const [error, setError] = useState<StockError | null>(null);
  const [approvalRule, setApprovalRule] = useState(false);
  const [payableEnabled, setPayableEnabled] = useState(false);
  const [dueDays, setDueDays] = useState("30");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<CategoryJson[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<StockError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const opKey = useRef(newKey());

  const apply = (s: StockSettingsJson) => {
    setSettings(s);
    setApprovalRule(!!s.po_creator_cannot_approve);
    setPayableEnabled(!!s.po_payable_enabled);
    setDueDays(String(s.po_payable_due_days ?? 30));
    setCategoryId(s.po_payable_category_id ?? "");
  };

  const load = useCallback(async () => {
    try {
      apply(await stockSettingsGet());
      setError(null);
      setSaveError(null);
    } catch (e) {
      setError(toStockError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Expense categories for the payable (finance holders only; fin_reference_data needs finance read).
  useEffect(() => {
    if (!settings?.can_edit_payable || categories) return;
    finReferenceData()
      .then((ref) =>
        setCategories(
          (ref.categories || []).filter((c) => c.is_active && c.direction === "out" && c.profit_class === "expense")
        )
      )
      .catch(() => setCategories([]));
  }, [settings?.can_edit_payable, categories]);

  if (error && !settings) return <PurchasingErrorBox error={error} onReload={() => void load()} />;
  if (!settings) return <Loading />;

  const canRule = settings.can_edit_approval_rule;
  const canPayable = settings.can_edit_payable;

  function changes(): StockSettingsInput | string {
    const s = settings!;
    const out: StockSettingsInput = {};
    if (canRule && approvalRule !== s.po_creator_cannot_approve) out.po_creator_cannot_approve = approvalRule;
    if (canPayable) {
      if (payableEnabled !== s.po_payable_enabled) out.po_payable_enabled = payableEnabled;
      const days = Number(dueDays.trim());
      if (!/^\d+$/.test(dueDays.trim()) || days > 365) return "Vade 0–365 gün arasında bir tam sayı olmalı.";
      if (days !== s.po_payable_due_days) out.po_payable_due_days = days;
      const stored = s.po_payable_category_id ?? "";
      // The read returns the effective category (stored or the system 'supplies' one); only an explicit change is sent.
      if (categoryId !== stored) out.po_payable_category_id = categoryId || null;
    }
    return out;
  }

  async function save() {
    setMessage(null);
    setSaveError(null);
    const c = changes();
    if (typeof c === "string") {
      setLocalError(c);
      return;
    }
    setLocalError(null);
    if (Object.keys(c).length === 0) {
      setLocalError("Kaydedilecek bir değişiklik yok.");
      return;
    }
    setBusy(true);
    try {
      const res = await stockSaveSettings({ p_operation_key: opKey.current, p_version: settings!.version, p_settings: c });
      opKey.current = newKey();
      // The write result may omit finance-only keys; re-read for the full picture.
      if (res?.settings) apply({ ...settings!, ...res.settings });
      await load();
      setMessage("Ayarlar kaydedildi.");
    } catch (e) {
      const err = toStockError(e);
      if (err.key === "E_OP_KEY") opKey.current = newKey();
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Satın alma ve finans bağlantısı">
      <div className="space-y-5">
        <div>
          <label className="flex items-start gap-3 min-h-[44px]">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5"
              checked={approvalRule}
              disabled={!canRule}
              onChange={(e) => setApprovalRule(e.target.checked)}
            />
            <span>
              <span className="font-semibold block">Siparişi hazırlayan kişi onaylayamasın</span>
              <span className="text-sm text-gray-600 block">
                Açıkken siparişi hazırlayan veya ürünlerini / tedarikçisini değiştiren kişi onaylayamaz; başka bir stok yetkilisi onaylar.
              </span>
              {!canRule && (
                <span className="text-xs text-gray-500 block mt-1">
                  {settings.po_creator_cannot_approve ? "Açık" : "Kapalı"} · Bu ayarı klinik sahibi değiştirir.
                </span>
              )}
            </span>
          </label>
        </div>

        <div className="border-t pt-4 space-y-3">
          <label className="flex items-start gap-3 min-h-[44px]">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5"
              checked={payableEnabled}
              disabled={!canPayable}
              onChange={(e) => setPayableEnabled(e.target.checked)}
            />
            <span>
              <span className="font-semibold block">Teslim alınan siparişler finansa borç olarak yazılsın</span>
              <span className="text-sm text-gray-600 block">
                Açıldığında yalnızca sonradan tamamlanan siparişler için planlanmış bir borç kaydı oluşur; ödeme kaydı
                oluşmaz. Önerilen: Kapalı.
              </span>
              {!canPayable && (
                <span className="text-xs text-gray-500 block mt-1">
                  {settings.po_payable_enabled ? "Açık" : "Kapalı"} · Bu ayarı finans yetkilisi değiştirir.
                </span>
              )}
            </span>
          </label>
          {canPayable && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Vade (gün)">
                <input
                  className={stockInput}
                  inputMode="numeric"
                  value={dueDays}
                  onChange={(e) => setDueDays(e.target.value)}
                />
              </Field>
              <Field label="Gider kategorisi">
                <select className={stockInput} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">Sistem kategorisi (Sarf / tedarikçi)</option>
                  {settings.po_payable_category_id &&
                    !(categories || []).some((c) => c.id === settings.po_payable_category_id) && (
                      <option value={settings.po_payable_category_id}>
                        {settings.po_payable_category_name ?? "Seçili kategori"}
                      </option>
                    )}
                  {(categories || []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {!canPayable && settings.po_payable_category_name && (
            <p className="text-xs text-gray-600">Gider kategorisi: {settings.po_payable_category_name}</p>
          )}
        </div>

        {(canRule || canPayable) && (
          <div className="space-y-3">
            {localError && <Notice tone="warn">{localError}</Notice>}
            <PurchasingErrorBox error={saveError} onReload={() => void load()} />
            {message && <Notice tone="success">{message}</Notice>}
            <button type="button" className={`${buttonPrimary} min-h-[44px]`} disabled={busy} onClick={() => void save()}>
              {busy ? "Kaydediliyor..." : "Kaydet"}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
