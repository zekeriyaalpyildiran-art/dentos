"use client";

import { useState } from "react";
import { useCanWriteFinance } from "@/components/finance/FinanceShell";
import { useReferenceData } from "@/components/finance/useReferenceData";
import {
  Card,
  ErrorBox,
  Field,
  Loading,
  Modal,
  SuccessBox,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  finSaveImportLayout,
  finSetAccountImportKey,
  formatTimestamp,
  newId,
  pickable,
  sortByOrder,
  toFinanceError,
  type AccountJson,
  type FinanceError,
  type ImportLayoutJson,
  type ReferenceData,
} from "@/lib/finance";
import {
  asBankTableConfig,
  asWorkbookConfig,
  checkBankTableConfig,
  checkWorkbookConfig,
  colLetter,
  colIndex,
  colsToText,
  textToCols,
  workbookTemplate,
  type BankTableLayoutConfig,
  type BankTableMode,
  type WorkbookLayoutConfig,
} from "./layout-config";
import { useImportSetup } from "./useImportSetup";

type Dialog =
  | { kind: "workbook"; layout: ImportLayoutJson | null }
  | { kind: "bank_table"; layout: ImportLayoutJson }
  | { kind: "account_key"; account: AccountJson };

/** /finance/import/layouts: workbook layouts, saved bank column maps and account import keys. */
export function LayoutsEditor() {
  const canWrite = useCanWriteFinance();
  const setup = useImportSetup();
  const ref = useReferenceData();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!setup.data || !ref.data) {
    return setup.loading || ref.loading ? <Loading /> : <ErrorBox error={setup.error ?? ref.error} />;
  }
  const workbooks = setup.data.layouts.filter((l) => l.kind === "clinic_workbook");
  const tables = setup.data.layouts.filter((l) => l.kind === "bank_table");
  const bankAccounts = sortByOrder(ref.data.accounts.filter((a) => a.kind === "bank" || a.kind === "pos"));

  const saved = async (text: string) => {
    setDialog(null);
    setMessage(text);
    await Promise.all([setup.reload(), ref.reload()]);
  };
  const reload = () => {
    setup.reload();
    ref.reload();
  };

  return (
    <div className="space-y-6">
      <SuccessBox text={message} />
      <ErrorBox error={setup.error ?? ref.error} />

      <Card
        title="Klinik günlük Excel düzeni"
        actions={
          canWrite ? (
            <button type="button" className={buttonPrimary} onClick={() => setDialog({ kind: "workbook", layout: null })}>
              Yeni düzen
            </button>
          ) : undefined
        }
      >
        <p className="text-sm text-gray-600 mb-3">
          Klinik Excel’inin hangi sayfa ve sütunlarından tahsilat, gider ve kasa okunacağını belirler. Excel aktarımı
          yalnızca etkin ve varsayılan düzenle yapılır. Tahsilat hesabı aktif olmalıdır.
        </p>
        {workbooks.length === 0 ? (
          <p className="text-sm text-amber-700">Henüz düzen yok. Klinik Excel’i aktarmak için bir düzen oluşturun.</p>
        ) : (
          <LayoutTable
            layouts={workbooks}
            canWrite={canWrite}
            onEdit={(l) => setDialog({ kind: "workbook", layout: l })}
            accounts={(l) => `Tahsilat: ${l.receipts_account_name ?? "—"} · Banka gideri: ${l.bank_paid_account_name ?? "—"} · Nakit gideri: ${l.cash_paid_account_name ?? "—"}`}
          />
        )}
      </Card>

      <Card title="Banka tablosu eşleştirmeleri">
        <p className="text-sm text-gray-600 mb-3">
          Hazır okuyucusu olmayan banka dosyaları için kaydedilen sütun eşleştirmeleri. Yeni eşleştirme aktarım ekranında
          bir dosyanın sütunlarını eşleştirip “Bu eşleştirmeyi kaydet” ile oluşturulur. Banka + hesap etiketi kaynak
          anahtarlarının parçasıdır ve sonradan değiştirilemez.
        </p>
        {tables.length === 0 ? (
          <p className="text-sm text-gray-500">Kayıtlı eşleştirme yok.</p>
        ) : (
          <LayoutTable
            layouts={tables}
            canWrite={canWrite}
            onEdit={(l) => setDialog({ kind: "bank_table", layout: l })}
            accounts={(l) => `${l.key_label ?? ""} · Hesap: ${l.account_name ?? "—"}`}
          />
        )}
      </Card>

      <Card title="Banka hesabı içe aktarma anahtarları">
        <p className="text-sm text-gray-600 mb-3">
          Hazır okunan banka dökümleri (PDF ve tanınan Excel) hesabı “Banka:hesap numarası” anahtarıyla bulur. Anahtar
          ilk aktarımda dosyadan önerilir; eski sistemde kullanılan anahtarla birebir aynı olmalıdır. Anahtar
          değiştirilirse sonraki dökümler o hesaba bağlanmaz.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 border-b">
              <tr className="text-left text-gray-800">
                <th className="px-3 py-2 font-semibold">Hesap</th>
                <th className="px-3 py-2 font-semibold">Tür</th>
                <th className="px-3 py-2 font-semibold">İçe aktarma anahtarı</th>
                <th className="px-3 py-2 font-semibold">Durum</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {bankAccounts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                    Banka veya POS türünde hesap yok. Finans ayarlarından ekleyin.
                  </td>
                </tr>
              ) : (
                bankAccounts.map((a) => (
                  <tr key={a.id} className="border-b">
                    <td className="px-3 py-2">{a.name}{a.bank_name && <span className="text-gray-500"> · {a.bank_name}</span>}</td>
                    <td className="px-3 py-2">{ACCOUNT_KIND_LABELS[a.kind]}</td>
                    <td className="px-3 py-2">
                      {a.import_key ? <code className="text-xs bg-gray-100 px-1 rounded">{a.import_key}</code> : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2">{a.is_active ? "Aktif" : "Pasif"}</td>
                    <td className="px-3 py-2 text-right">
                      {canWrite && (
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setDialog({ kind: "account_key", account: a })}>
                          {a.import_key ? "Değiştir" : "Tanımla"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {dialog?.kind === "workbook" && (
        <WorkbookLayoutDialog refData={ref.data} layout={dialog.layout} onClose={() => setDialog(null)} onSaved={saved} onReload={reload} />
      )}
      {dialog?.kind === "bank_table" && (
        <BankTableLayoutDialog refData={ref.data} layout={dialog.layout} onClose={() => setDialog(null)} onSaved={saved} onReload={reload} />
      )}
      {dialog?.kind === "account_key" && (
        <AccountKeyDialog account={dialog.account} onClose={() => setDialog(null)} onSaved={saved} onReload={reload} />
      )}
    </div>
  );
}

function LayoutTable({
  layouts,
  canWrite,
  onEdit,
  accounts,
}: {
  layouts: ImportLayoutJson[];
  canWrite: boolean;
  onEdit: (l: ImportLayoutJson) => void;
  accounts: (l: ImportLayoutJson) => string;
}) {
  return (
    <div className="divide-y">
      {layouts.map((l) => (
        <div key={l.id} className={`flex flex-wrap justify-between gap-4 py-2 text-sm ${l.is_active ? "" : "text-gray-400"}`}>
          <div>
            <span className="font-medium">{l.name}</span>
            {l.is_default && <span className="ml-2 px-2 py-0.5 rounded bg-green-100 text-green-800 text-xs">varsayılan</span>}
            {!l.is_active && <span className="ml-2 text-xs">pasif</span>}
            <div className="text-xs text-gray-500">{accounts(l)}</div>
            <div className="text-xs text-gray-500">Son kullanım: {l.last_used_at ? formatTimestamp(l.last_used_at) : "—"}</div>
          </div>
          {canWrite && (
            <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(l)}>
              Düzenle
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function AccountSelect({
  label,
  accounts,
  value,
  onChange,
  hint,
}: {
  label: string;
  accounts: AccountJson[];
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Seçin</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({ACCOUNT_KIND_LABELS[a.kind]}){a.is_active ? "" : " · pasif"}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ColsField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ör. C, H, I" />
    </Field>
  );
}

function ColField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <input className={inputClass} value={value} maxLength={2} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

type WbForm = {
  required: string;
  dayPattern: string;
  fxSheet: string;
  fxCode: string;
  fxRate: string;
  firstRow: string;
  rRowNo: string;
  rName: string;
  rSkip: string;
  rTry: string;
  rEur: string;
  rUsd: string;
  rGbp: string;
  eDesc: string;
  eTotal: string;
  eSkip: string;
  eTry: string;
  eEur: string;
  eUsd: string;
  eGbp: string;
  eBank: string;
  cTry: string;
  cEur: string;
  cUsd: string;
  cGbp: string;
  tCounterparty: string;
  tDescription: string;
};

function toForm(c: WorkbookLayoutConfig): WbForm {
  return {
    required: c.required_sheets.join(", "),
    dayPattern: c.day_sheet_pattern,
    fxSheet: c.fx_sheet,
    fxCode: colLetter(c.fx_code_col),
    fxRate: colLetter(c.fx_rate_col),
    firstRow: String(c.first_row + 1),
    rRowNo: colLetter(c.receipt.row_no_col),
    rName: colLetter(c.receipt.name_col),
    rSkip: c.receipt.skip_name_pattern,
    rTry: colsToText(c.receipt.try_cols),
    rEur: colsToText(c.receipt.eur_cols),
    rUsd: colsToText(c.receipt.usd_cols),
    rGbp: colsToText(c.receipt.gbp_cols),
    eDesc: colLetter(c.expense.desc_col),
    eTotal: colLetter(c.expense.total_col),
    eSkip: c.expense.skip_desc_pattern,
    eTry: colsToText(c.expense.try_cols),
    eEur: colsToText(c.expense.eur_cols),
    eUsd: colsToText(c.expense.usd_cols),
    eGbp: colsToText(c.expense.gbp_cols),
    eBank: colsToText(c.expense.bank_cols),
    cTry: c.cash.TRY,
    cEur: c.cash.EUR ?? "",
    cUsd: c.cash.USD ?? "",
    cGbp: c.cash.GBP ?? "",
    tCounterparty: c.receipt_text.counterparty,
    tDescription: c.receipt_text.description,
  };
}

function fromForm(f: WbForm): { config: WorkbookLayoutConfig } | { error: string } {
  const col = (v: string, label: string): number | string => {
    const i = colIndex(v);
    return i === null ? `${label}: geçerli bir sütun harfi girin.` : i;
  };
  const cols = (v: string, label: string): number[] | string => {
    const c = textToCols(v);
    return c === null ? `${label}: sütun harflerini virgülle ayırın (en fazla 10).` : c;
  };
  const vals = {
    fxCode: col(f.fxCode, "Kur kodu sütunu"),
    fxRate: col(f.fxRate, "Kur sütunu"),
    rRowNo: col(f.rRowNo, "Sıra no sütunu"),
    rName: col(f.rName, "Hasta adı sütunu"),
    rTry: cols(f.rTry, "TL tahsilat sütunları"),
    rEur: cols(f.rEur, "EUR tahsilat sütunları"),
    rUsd: cols(f.rUsd, "USD tahsilat sütunları"),
    rGbp: cols(f.rGbp, "GBP tahsilat sütunları"),
    eDesc: col(f.eDesc, "Gider açıklaması sütunu"),
    eTotal: col(f.eTotal, "Gider toplam sütunu"),
    eTry: cols(f.eTry, "TL gider sütunları"),
    eEur: cols(f.eEur, "EUR gider sütunları"),
    eUsd: cols(f.eUsd, "USD gider sütunları"),
    eGbp: cols(f.eGbp, "GBP gider sütunları"),
    eBank: cols(f.eBank, "Bankadan ödenen gider sütunları"),
  };
  for (const v of Object.values(vals)) if (typeof v === "string") return { error: v };
  const firstRow = Number(f.firstRow);
  if (!Number.isInteger(firstRow) || firstRow < 1 || firstRow > 256) return { error: "İlk veri satırı 1-256 olmalı." };
  const n = (k: keyof typeof vals) => vals[k] as number;
  const a = (k: keyof typeof vals) => vals[k] as number[];
  const config: WorkbookLayoutConfig = {
    version: 1,
    required_sheets: f.required.split(",").map((s) => s.trim()).filter(Boolean),
    day_sheet_pattern: f.dayPattern.trim(),
    fx_sheet: f.fxSheet.trim(),
    fx_code_col: n("fxCode"),
    fx_rate_col: n("fxRate"),
    first_row: firstRow - 1,
    receipt: {
      row_no_col: n("rRowNo"),
      name_col: n("rName"),
      skip_name_pattern: f.rSkip.trim(),
      try_cols: a("rTry"),
      eur_cols: a("rEur"),
      usd_cols: a("rUsd"),
      gbp_cols: a("rGbp"),
    },
    expense: {
      desc_col: n("eDesc"),
      total_col: n("eTotal"),
      skip_desc_pattern: f.eSkip.trim(),
      try_cols: a("eTry"),
      eur_cols: a("eEur"),
      usd_cols: a("eUsd"),
      gbp_cols: a("eGbp"),
      bank_cols: a("eBank"),
    },
    // EUR / USD / GBP labels are optional (a blank label means the currency is not on the sheet).
    cash: {
      TRY: f.cTry.trim(),
      ...(f.cEur.trim() ? { EUR: f.cEur.trim() } : {}),
      ...(f.cUsd.trim() ? { USD: f.cUsd.trim() } : {}),
      ...(f.cGbp.trim() ? { GBP: f.cGbp.trim() } : {}),
    },
    receipt_text: { counterparty: f.tCounterparty.trim(), description: f.tDescription.trim() },
  };
  const bad = checkWorkbookConfig(config);
  if (bad) return { error: `Sütun eşleştirmesi geçersiz: ${bad}` };
  return { config };
}

function WorkbookLayoutDialog({
  refData,
  layout,
  onClose,
  onSaved,
  onReload,
}: {
  refData: ReferenceData;
  layout: ImportLayoutJson | null;
  onClose: () => void;
  onSaved: (text: string) => Promise<void>;
  onReload: () => void;
}) {
  const [id] = useState(() => layout?.id ?? newId());
  const existing = layout ? asWorkbookConfig(layout.config) : null;
  const [name, setName] = useState(layout?.name ?? "Klinik günlük Excel");
  const [form, setForm] = useState<WbForm>(() => toForm(existing ?? workbookTemplate()));
  const [receipts, setReceipts] = useState(layout?.receipts_account_id ?? "");
  const [bankPaid, setBankPaid] = useState(layout?.bank_paid_account_id ?? "");
  const [cashPaid, setCashPaid] = useState(layout?.cash_paid_account_id ?? "");
  const [isDefault, setIsDefault] = useState(layout?.is_default ?? true);
  const [active, setActive] = useState(layout?.is_active ?? true);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<WbForm>) => setForm((f) => ({ ...f, ...patch }));
  const accounts = sortByOrder(refData.accounts);
  const receiptsAccounts = pickable(accounts, layout?.receipts_account_id);
  const bankAccounts = pickable(accounts.filter((a) => a.kind === "bank" || a.kind === "pos" || a.kind === "mixed"), layout?.bank_paid_account_id);
  const cashAccounts = pickable(accounts.filter((a) => a.kind === "cash" || a.kind === "mixed"), layout?.cash_paid_account_id);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    if (!name.trim() || name.trim().length > 80) return setFormError("Ad 1-80 karakter olmalı.");
    if (!receipts || !bankPaid || !cashPaid) return setFormError("Tahsilat, banka ve nakit hesaplarını seçin.");
    const built = fromForm(form);
    if ("error" in built) return setFormError(built.error);
    setBusy(true);
    try {
      const res = await finSaveImportLayout({
        p_id: id,
        p_version: layout?.version ?? 0,
        p_kind: "clinic_workbook",
        p_name: name.trim(),
        p_config: built.config as unknown as Record<string, unknown>,
        p_key_label: null,
        p_account_id: null,
        p_receipts_account_id: receipts,
        p_bank_paid_account_id: bankPaid,
        p_cash_paid_account_id: cashPaid,
        p_is_default: isDefault,
        p_is_active: active,
      });
      await onSaved(res.already_saved ? "Düzen zaten bu değerlerle kayıtlı." : "Klinik Excel düzeni kaydedildi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={layout ? "Klinik Excel düzenini düzenle" : "Yeni klinik Excel düzeni"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <Field label="Ad">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <AccountSelect label="Günlük tahsilat hesabı" accounts={receiptsAccounts} value={receipts} onChange={setReceipts} hint="Aktif bir hesap seçin." />
          <AccountSelect label="Bankadan ödenen giderler" accounts={bankAccounts} value={bankPaid} onChange={setBankPaid} />
          <AccountSelect label="Diğer (nakit) giderler" accounts={cashAccounts} value={cashPaid} onChange={setCashPaid} />
        </div>
        {!layout && (
          <button type="button" className="text-blue-600 hover:underline text-xs" onClick={() => setForm(toForm(workbookTemplate()))}>
            Sütunları standart klinik Excel şablonuyla doldur
          </button>
        )}
        <fieldset className="border rounded p-3 space-y-3">
          <legend className="px-1 font-semibold">Sayfalar ve kur</legend>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Gerekli sayfalar" hint="Virgülle ayırın; dosya bu sayfaların hepsini içermeli.">
              <input className={inputClass} value={form.required} onChange={(e) => set({ required: e.target.value })} />
            </Field>
            <Field label="Gün sayfası adı (düzenli ifade)">
              <input className={inputClass} value={form.dayPattern} onChange={(e) => set({ dayPattern: e.target.value })} />
            </Field>
            <Field label="İlk veri satırı" hint="Gün sayfasında başlıktan sonraki ilk satır.">
              <input className={inputClass} inputMode="numeric" value={form.firstRow} onChange={(e) => set({ firstRow: e.target.value })} />
            </Field>
            <Field label="Kur sayfası">
              <input className={inputClass} value={form.fxSheet} onChange={(e) => set({ fxSheet: e.target.value })} />
            </Field>
            <ColField label="Kur kodu sütunu" value={form.fxCode} onChange={(v) => set({ fxCode: v })} />
            <ColField label="Kur değeri sütunu" value={form.fxRate} onChange={(v) => set({ fxRate: v })} />
          </div>
        </fieldset>
        <fieldset className="border rounded p-3 space-y-3">
          <legend className="px-1 font-semibold">Tahsilatlar</legend>
          <div className="grid gap-3 md:grid-cols-3">
            <ColField label="Sıra no sütunu" value={form.rRowNo} onChange={(v) => set({ rRowNo: v })} />
            <ColField label="Hasta adı sütunu" value={form.rName} onChange={(v) => set({ rName: v })} />
            <Field label="Atlanacak ad (düzenli ifade)">
              <input className={inputClass} value={form.rSkip} onChange={(e) => set({ rSkip: e.target.value })} />
            </Field>
            <ColsField label="TL sütunları" value={form.rTry} onChange={(v) => set({ rTry: v })} />
            <ColsField label="EUR sütunları" value={form.rEur} onChange={(v) => set({ rEur: v })} />
            <ColsField label="USD sütunları" value={form.rUsd} onChange={(v) => set({ rUsd: v })} />
            <ColsField label="GBP sütunları" value={form.rGbp} onChange={(v) => set({ rGbp: v })} />
            <Field label="Günlük toplam kişi / kurum metni" hint="Önceki aktarımların tanınması için değiştirmeyin.">
              <input className={inputClass} value={form.tCounterparty} onChange={(e) => set({ tCounterparty: e.target.value })} />
            </Field>
            <Field label="Günlük toplam açıklaması">
              <input className={inputClass} value={form.tDescription} onChange={(e) => set({ tDescription: e.target.value })} />
            </Field>
          </div>
        </fieldset>
        <fieldset className="border rounded p-3 space-y-3">
          <legend className="px-1 font-semibold">Giderler</legend>
          <div className="grid gap-3 md:grid-cols-3">
            <ColField label="Açıklama sütunu" value={form.eDesc} onChange={(v) => set({ eDesc: v })} />
            <ColField label="Toplam (formül) sütunu" value={form.eTotal} onChange={(v) => set({ eTotal: v })} />
            <Field label="Atlanacak açıklama (düzenli ifade)">
              <input className={inputClass} value={form.eSkip} onChange={(e) => set({ eSkip: e.target.value })} />
            </Field>
            <ColsField label="TL sütunları" value={form.eTry} onChange={(v) => set({ eTry: v })} />
            <ColsField label="EUR sütunları" value={form.eEur} onChange={(v) => set({ eEur: v })} />
            <ColsField label="USD sütunları" value={form.eUsd} onChange={(v) => set({ eUsd: v })} />
            <ColsField label="GBP sütunları" value={form.eGbp} onChange={(v) => set({ eGbp: v })} />
            <ColsField label="Bankadan ödenen sütunlar" value={form.eBank} onChange={(v) => set({ eBank: v })} hint="Bu sütunlarda tutar varsa gider banka hesabına işlenir." />
          </div>
        </fieldset>
        <fieldset className="border rounded p-3 space-y-3">
          <legend className="px-1 font-semibold">Kasa başlıkları (düzenli ifade)</legend>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="TL"><input className={inputClass} value={form.cTry} onChange={(e) => set({ cTry: e.target.value })} /></Field>
            <Field label="EUR"><input className={inputClass} value={form.cEur} onChange={(e) => set({ cEur: e.target.value })} /></Field>
            <Field label="USD"><input className={inputClass} value={form.cUsd} onChange={(e) => set({ cUsd: e.target.value })} /></Field>
            <Field label="GBP"><input className={inputClass} value={form.cGbp} onChange={(e) => set({ cGbp: e.target.value })} /></Field>
          </div>
        </fieldset>
        <p className="text-xs text-gray-500">
          Döviz bozdurma ve hekim hakediş satırları sınıflandırma kurallarıyla tanınır (kapsamı “Yalnızca klinik Excel”
          olan kurallar ve “hakediş ayı gerekli” işaretli hekim kuralları).
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Varsayılan düzen
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Etkin
        </label>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700">{formError}</div>}
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

const MODE_LABELS: Record<BankTableMode, string> = {
  signed: "Tek tutar: eksi çıkış / artı giriş",
  split: "Ayrı borç ve alacak sütunları",
  direction: "Tutar + giriş/çıkış sütunu",
  debit: "Tüm satırlar banka çıkışı",
  credit: "Tüm satırlar banka girişi",
};

const MAPPING_FIELDS: { key: keyof BankTableLayoutConfig["mapping"]; label: string }[] = [
  { key: "date", label: "İşlem tarihi" },
  { key: "description", label: "Açıklama" },
  { key: "amount", label: "Tutar" },
  { key: "debit", label: "Borç / çıkış" },
  { key: "credit", label: "Alacak / giriş" },
  { key: "direction", label: "Giriş / çıkış yönü" },
  { key: "balance", label: "Bakiye" },
  { key: "reference", label: "Referans" },
  { key: "currency", label: "Para birimi" },
];

function BankTableLayoutDialog({
  refData,
  layout,
  onClose,
  onSaved,
  onReload,
}: {
  refData: ReferenceData;
  layout: ImportLayoutJson;
  onClose: () => void;
  onSaved: (text: string) => Promise<void>;
  onReload: () => void;
}) {
  const initial = asBankTableConfig(layout.config);
  const [name, setName] = useState(layout.name);
  const [config, setConfig] = useState<BankTableLayoutConfig | null>(initial);
  const [accountId, setAccountId] = useState(layout.account_id ?? "");
  const [isDefault, setIsDefault] = useState(layout.is_default);
  const [active, setActive] = useState(layout.is_active);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = pickable(
    sortByOrder(refData.accounts.filter((a) => a.kind === "bank" || a.kind === "pos")),
    layout.account_id
  );

  const setMap = (patch: Partial<BankTableLayoutConfig["mapping"]>) =>
    setConfig((c) => (c ? { ...c, mapping: { ...c.mapping, ...patch } } : c));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    if (!config) return setFormError("Kayıtlı eşleştirme okunamadı.");
    const bad = checkBankTableConfig(config);
    if (bad) return setFormError(`Sütun eşleştirmesi geçersiz: ${bad}.`);
    if (!name.trim() || name.trim().length > 80) return setFormError("Ad 1-80 karakter olmalı.");
    if (!accountId) return setFormError("Banka dökümü için banka veya POS türünde aktif bir hesap seçin.");
    setBusy(true);
    try {
      const res = await finSaveImportLayout({
        p_id: layout.id,
        p_version: layout.version,
        p_kind: "bank_table",
        p_name: name.trim(),
        p_config: config as unknown as Record<string, unknown>,
        p_key_label: layout.key_label,
        p_account_id: accountId,
        p_receipts_account_id: null,
        p_bank_paid_account_id: null,
        p_cash_paid_account_id: null,
        p_is_default: isDefault,
        p_is_active: active,
      });
      await onSaved(res.already_saved ? "Eşleştirme zaten bu değerlerle kayıtlı." : "Eşleştirme kaydedildi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Banka tablosu eşleştirmesi" onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <Field label="Ad">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Banka + hesap etiketi" hint="Kaynak anahtarlarının parçası; değiştirilemez.">
          <input className={inputClass} value={layout.key_label ?? ""} disabled readOnly />
        </Field>
        <Field label="Finans hesabı">
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Seçin</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({ACCOUNT_KIND_LABELS[a.kind]}){a.is_active ? "" : " · pasif"}
              </option>
            ))}
          </select>
        </Field>
        {config ? (
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Başlık satırı">
              <input
                className={inputClass}
                inputMode="numeric"
                value={config.mapping.header + 1}
                onChange={(e) => setMap({ header: Math.max(0, Number(e.target.value || 1) - 1) })}
              />
            </Field>
            <Field label="Tutar düzeni">
              <select className={inputClass} value={config.mapping.mode} onChange={(e) => setMap({ mode: e.target.value as BankTableMode })}>
                {(Object.keys(MODE_LABELS) as BankTableMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sayı biçimi">
              <select className={inputClass} value={config.mapping.format} onChange={(e) => setMap({ format: e.target.value as "tr" | "en" })}>
                <option value="tr">1.234,56 (Türkçe)</option>
                <option value="en">1,234.56 (İngilizce)</option>
              </select>
            </Field>
            {MAPPING_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  className={inputClass}
                  maxLength={2}
                  value={config.mapping[f.key] === -1 ? "" : colLetter(config.mapping[f.key] as number)}
                  placeholder="yok"
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    const idx = v ? colIndex(v) : -1;
                    if (idx !== null) setMap({ [f.key]: idx } as Partial<BankTableLayoutConfig["mapping"]>);
                  }}
                />
              </Field>
            ))}
          </div>
        ) : (
          <p className="text-red-600">Kayıtlı eşleştirme biçimi okunamadı; yalnızca ad, hesap ve durum değiştirilebilir.</p>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Varsayılan eşleştirme
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Etkin
        </label>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button type="submit" className={buttonPrimary} disabled={busy || !config}>
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

/** fin_set_account_import_key. Exact '<Bank>:<account>' string, ≤ 200 characters; blank clears it. */
export function AccountKeyDialog({
  account,
  proposal,
  onClose,
  onSaved,
  onReload,
}: {
  account: AccountJson;
  proposal?: string;
  onClose: () => void;
  onSaved: (text: string) => Promise<void> | void;
  onReload: () => void;
}) {
  const [key, setKey] = useState(account.import_key ?? proposal ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const v = key.trim();
    if (v && (!/^[^:\s][^:]*:[^:]+$/.test(v) || v.length > 200)) {
      return setFormError('İçe aktarma anahtarı "Banka:hesap" biçiminde ve en fazla 200 karakter olmalı.');
    }
    setBusy(true);
    try {
      const res = await finSetAccountImportKey({ p_id: account.id, p_version: account.version, p_import_key: v || null });
      await onSaved(res.already_saved ? "Anahtar zaten kayıtlı." : `${account.name}: içe aktarma anahtarı kaydedildi.`);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`İçe aktarma anahtarı · ${account.name}`} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <Field label="Anahtar" hint="Ör. Banka:hesap numarası. Boş bırakılırsa anahtar kaldırılır.">
          <input className={inputClass} value={key} maxLength={200} onChange={(e) => setKey(e.target.value)} />
        </Field>
        {account.import_key && (
          <p className="text-amber-700 text-xs">
            Anahtarı değiştirirseniz bu hesabın eski anahtarlı dökümleri artık bu hesaba bağlanmaz.
          </p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700">{formError}</div>}
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
