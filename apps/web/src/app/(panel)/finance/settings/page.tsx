"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { CounterpartyDialog } from "@/components/finance/CounterpartyDialog";
import { FxRatesSettingsCard } from "@/components/finance/FxRatesSettingsCard";
import { AccountDialog, CategoryDialog, ReportGroupDialog } from "@/components/finance/MasterDialogs";
import { useReferenceData } from "@/components/finance/useReferenceData";
import {
  Card,
  ErrorBox,
  Field,
  Loading,
  MoneyRow,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
import { useAuthStore } from "@/lib/store";
import {
  ACCOUNT_KIND_LABELS,
  BUCKET_LABELS,
  COUNTERPARTY_KIND_LABELS,
  DIRECTION_LABELS,
  PROFIT_CLASS_LABELS,
  centsToInput,
  finSaveSettings,
  parseTL,
  pickable,
  searchKey,
  sortByOrder,
  toFinanceError,
  type AccountJson,
  type CategoryJson,
  type CounterpartyJson,
  type FinanceError,
  type ReferenceData,
  type ReportGroupJson,
} from "@/lib/finance";

export default function FinanceSettingsPage() {
  return (
    <FinanceShell title="Finans ayarları">
      <Settings />
    </FinanceShell>
  );
}

type Dialog =
  | { kind: "account"; record: AccountJson | null }
  | { kind: "group"; record: ReportGroupJson | null }
  | { kind: "category"; record: CategoryJson | null }
  | { kind: "counterparty"; record: CounterpartyJson | null };

function Settings() {
  const canWrite = useCanWriteFinance();
  const isOwner = useAuthStore((state) => state.user?.role === "owner");
  const ref = useReferenceData();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cpQuery, setCpQuery] = useState("");

  if (!ref.data) return ref.loading ? <Loading /> : <ErrorBox error={ref.error} />;
  const data = ref.data;

  const saved = async (text: string) => {
    setDialog(null);
    setMessage(text);
    await ref.reload();
  };
  const reloadAndClose = () => {
    setDialog(null);
    ref.reload();
  };

  const groupName = (id: string | null) => (id ? data.report_groups.find((g) => g.id === id)?.name ?? "—" : "—");
  const counterparties = data.counterparties.filter((c) => !cpQuery || searchKey(c.name).includes(searchKey(cpQuery)));

  const editButton = (onClick: () => void) =>
    canWrite ? (
      <button type="button" className="text-blue-600 hover:underline" onClick={onClick}>
        Düzenle
      </button>
    ) : null;

  return (
    <div className="space-y-6">
      <SuccessBox text={message} />
      <ErrorBox error={ref.error} />

      <GeneralSettings refData={data} canWrite={canWrite} onSaved={saved} onReload={() => ref.reload()} />

      <Card
        title="Hesaplar"
        actions={canWrite ? <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "account", record: null })}>Yeni hesap</button> : undefined}
      >
        <Table
          head={["Ad", "Tür", "Banka", "Durum", ""]}
          rows={sortByOrder(data.accounts).map((a) => [
            a.name,
            ACCOUNT_KIND_LABELS[a.kind],
            a.bank_name ?? "—",
            a.is_active ? "Aktif" : "Pasif",
            editButton(() => setDialog({ kind: "account", record: a })),
          ])}
          keys={sortByOrder(data.accounts).map((a) => a.id)}
        />
      </Card>

      <Card
        title="Açık borç rapor grupları"
        actions={canWrite ? <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "group", record: null })}>Yeni grup</button> : undefined}
      >
        <p className="text-sm text-gray-600 mb-3">
          Özet ekranındaki “Alacaklar / borçlar” kartı açık borçları bu gruplarla gösterir. Bir kayıt önce kişi / kurumun
          grubuna, yoksa kategorinin grubuna, o da yoksa “Diğer borçlar”a düşer.
        </p>
        <Table
          head={["Ad", "Sıra", "Durum", ""]}
          rows={sortByOrder(data.report_groups).map((g) => [
            g.name,
            String(g.sort_order),
            g.is_active ? "Aktif" : "Pasif",
            editButton(() => setDialog({ kind: "group", record: g })),
          ])}
          keys={sortByOrder(data.report_groups).map((g) => g.id)}
        />
      </Card>

      <Card
        title="Kategoriler"
        actions={canWrite ? <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "category", record: null })}>Yeni kategori</button> : undefined}
      >
        <Table
          head={["Ad", "Rapor türü", "Yön", "Sınıf", "Rapor grubu", "Durum", ""]}
          rows={sortByOrder(data.categories).map((c) => [
            <span key="n">
              {c.name}
              {c.is_system && <span className="text-xs text-gray-500"> · sistem</span>}
            </span>,
            BUCKET_LABELS[c.report_bucket],
            DIRECTION_LABELS[c.direction],
            PROFIT_CLASS_LABELS[c.profit_class],
            c.direction === "out" ? groupName(c.report_group_id) : "—",
            c.is_active ? "Aktif" : "Pasif",
            editButton(() => setDialog({ kind: "category", record: c })),
          ])}
          keys={sortByOrder(data.categories).map((c) => c.id)}
        />
      </Card>

      <Card
        title="Kişi / kurumlar"
        actions={canWrite ? <button type="button" className={buttonSecondary} onClick={() => setDialog({ kind: "counterparty", record: null })}>Yeni kişi / kurum</button> : undefined}
      >
        <input
          className={`${inputClass} mb-3`}
          placeholder="Ara"
          value={cpQuery}
          onChange={(e) => setCpQuery(e.target.value)}
        />
        <Table
          head={["Ad", "Tür", "Bağlı hekim", "Rapor grubu", "Durum", ""]}
          rows={counterparties.map((c) => [
            <span key="n">
              {c.name}
              {c.note && <div className="text-xs text-gray-500">{c.note}</div>}
            </span>,
            COUNTERPARTY_KIND_LABELS[c.kind],
            c.doctor_name ?? "—",
            groupName(c.report_group_id),
            c.is_active ? "Aktif" : "Pasif",
            editButton(() => setDialog({ kind: "counterparty", record: c })),
          ])}
          keys={counterparties.map((c) => c.id)}
          empty="Kayıtlı kişi / kurum yok."
        />
      </Card>

      {/* pp_fx_save_rates: owner or 'finance' (pp_can_void); the server enforces it as well. */}
      <FxRatesSettingsCard canWrite={canWrite || isOwner} />

      {isOwner && (
        <Card title="Veri yedeği">
          <p className="text-sm text-gray-600 mb-3">
            Klinik verilerinin tamamını (finans dahil, yetkiniz varsa) tek bir JSON dosyası olarak indirin.
          </p>
          <Link href="/settings/export" className={buttonSecondary}>
            Yedek sayfasını aç
          </Link>
        </Card>
      )}

      {dialog?.kind === "account" && (
        <AccountDialog record={dialog.record} onClose={() => setDialog(null)} onReload={reloadAndClose} onSaved={saved} />
      )}
      {dialog?.kind === "group" && (
        <ReportGroupDialog record={dialog.record} onClose={() => setDialog(null)} onReload={reloadAndClose} onSaved={saved} />
      )}
      {dialog?.kind === "category" && (
        <CategoryDialog refData={data} record={dialog.record} onClose={() => setDialog(null)} onReload={reloadAndClose} onSaved={saved} />
      )}
      {dialog?.kind === "counterparty" && (
        <CounterpartyDialog
          key={dialog.record?.id ?? "new"}
          refData={data}
          record={dialog.record}
          onClose={() => setDialog(null)}
          onReload={reloadAndClose}
          onOpenExisting={(existing) => setDialog({ kind: "counterparty", record: existing })}
          onSaved={(rec, already) => saved(already ? `${rec.name} zaten kayıtlıydı.` : `${rec.name} kaydedildi.`)}
        />
      )}
    </div>
  );
}

function Table({
  head,
  rows,
  keys,
  empty = "Kayıt yok.",
}: {
  head: string[];
  rows: React.ReactNode[][];
  keys: string[];
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr className="text-left text-gray-800">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="px-3 py-6 text-center text-gray-500">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((cells, r) => (
              <tr key={keys[r]} className="border-b text-gray-900 align-top">
                {cells.map((cell, i) => (
                  <td key={i} className={`px-3 py-2 ${i === cells.length - 1 ? "text-right" : ""}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** fin_save_settings: buffer target, plan length, physician fee note, report brand, entitlement account. */
function GeneralSettings({
  refData,
  canWrite,
  onSaved,
  onReload,
}: {
  refData: ReferenceData;
  canWrite: boolean;
  onSaved: (text: string) => Promise<void>;
  onReload: () => void;
}) {
  const s = refData.settings;
  const [buffer, setBuffer] = useState(centsToInput(s.buffer_target_cents));
  const [days, setDays] = useState(String(s.forecast_days));
  const [note, setNote] = useState(s.physician_fee_note ?? "");
  const [brand, setBrand] = useState(s.report_brand_name ?? "");
  const [accountId, setAccountId] = useState(s.entitlement_account_id ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-sync the form when fresh settings arrive (after a save or a "Yenile").
  useEffect(() => {
    setBuffer(centsToInput(s.buffer_target_cents));
    setDays(String(s.forecast_days));
    setNote(s.physician_fee_note ?? "");
    setBrand(s.report_brand_name ?? "");
    setAccountId(s.entitlement_account_id ?? "");
  }, [s]);

  const accounts = sortByOrder(pickable(refData.accounts, s.entitlement_account_id));
  const entitlementAccount = refData.accounts.find((a) => a.id === s.entitlement_account_id);

  if (!canWrite) {
    return (
      <Card title="Genel ayarlar">
        <MoneyRow label="Tampon hedefi" cents={s.buffer_target_cents} />
        <div className="flex justify-between py-2 border-b text-sm">
          <span className="text-gray-700">Plan süresi</span>
          <span>{s.forecast_days} gün</span>
        </div>
        <div className="flex justify-between py-2 border-b text-sm">
          <span className="text-gray-700">Hakediş ödemesi varsayılan hesabı</span>
          <span>{entitlementAccount?.name ?? "—"}</span>
        </div>
        <div className="py-2 border-b text-sm">
          <div className="text-gray-700">Hekim hakedişi notu</div>
          <div>{s.physician_fee_note ?? "—"}</div>
        </div>
        <div className="py-2 text-sm">
          <div className="text-gray-700">Rapor marka adı</div>
          <div>{s.report_brand_name ?? "—"}</div>
        </div>
      </Card>
    );
  }

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const b = parseTL(buffer, { allowZero: true });
    if (!b.ok) return setFormError(`Tampon hedefi: ${b.error}`);
    const d = /^\d{1,2}$/.test(days.trim()) ? Number(days.trim()) : NaN;
    if (!(d >= 1 && d <= 90)) return setFormError("Plan süresi 1 ile 90 gün arasında olmalı.");
    if (note.trim().length > 500) return setFormError("Not en fazla 500 karakter olabilir.");
    if (brand.trim().length > 120) return setFormError("Rapor marka adı en fazla 120 karakter olabilir.");
    setBusy(true);
    try {
      const res = await finSaveSettings({
        p_version: s.version,
        p_buffer_target_cents: b.cents,
        p_forecast_days: d,
        p_physician_fee_note: note.trim() || null,
        p_report_brand_name: brand.trim() || null,
        p_entitlement_account_id: accountId || null,
      });
      await onSaved(res.already_saved ? "Ayarlarda değişiklik yok." : "Finans ayarları kaydedildi.");
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Genel ayarlar">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <Field label="Tampon hedefi (TL)" hint="Özet ekranındaki “Tampon” kartı gerçek likiti bu hedefle karşılaştırır.">
          <input className={inputClass} inputMode="decimal" value={buffer} onChange={(e) => setBuffer(e.target.value)} required />
        </Field>
        <Field label="Plan süresi (gün)" hint="“Yaklaşan plan” bugünden itibaren bu kadar günü ve vadesi geçenleri kapsar.">
          <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} required />
        </Field>
        <Field label="Hakediş ödemesi varsayılan hesabı">
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Seçilmedi</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.is_active}>
                {a.name} ({ACCOUNT_KIND_LABELS[a.kind]}){a.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rapor marka adı (isteğe bağlı)">
          <input className={inputClass} value={brand} maxLength={120} onChange={(e) => setBrand(e.target.value)} />
        </Field>
        <Field
          label="Hekim hakedişi notu (isteğe bağlı)"
          hint="Hakediş formunda açıklamaya önerilir ve aylık sonuç kartında gösterilir. Örnek: kesintilerin hakedişe dahil olup olmadığı."
          className="md:col-span-2"
        >
          <textarea className={inputClass} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="md:col-span-2 space-y-3">
          {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
          <ErrorBox error={error} onReload={onReload} />
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Kaydediliyor..." : "Ayarları kaydet"}
          </button>
        </div>
      </form>
    </Card>
  );
}
