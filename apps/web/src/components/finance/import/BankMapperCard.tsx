"use client";

import { useEffect, useMemo, useState } from "react";
import { ErrorBox, Field, buttonPrimary, buttonSecondary, inputClass } from "@/components/finance/ui";
import {
  ACCOUNT_KIND_LABELS,
  finSaveImportLayout,
  finSetAccountImportKey,
  formatDay,
  formatTL,
  newId,
  sortByOrder,
  toFinanceError,
  type AccountJson,
  type FinanceError,
  type ImportLayoutJson,
  type ImportSetupJson,
  type ReferenceData,
} from "@/lib/finance";
import {
  headerSignature,
  parseBankTable,
  pasteTable,
  suggestMapping,
  type BankMapping,
  type BankTable,
  type BankTableResult,
  type MappingMode,
} from "@/lib/finance-import/bank-table";
import type { CompiledRules } from "@/lib/finance-import/classify";
import type { BankCard } from "@/lib/finance-import/detect";
import { bankText, normB } from "@/lib/finance-import/primitives";
import type { ParsedRow } from "@/lib/finance-import/types";
import { asBankTableConfig, type BankTableLayoutConfig } from "./layout-config";

export type CardState = BankCard & { id: string };

export interface AcceptedBankRows {
  rows: ParsedRow[];
  notes: string[];
  accountId: string;
  layoutId: string | null;
}

const MODE_LABELS: Record<MappingMode, string> = {
  signed: "Tek tutar: eksi çıkış / artı giriş",
  split: "Ayrı borç ve alacak sütunları",
  direction: "Tutar + giriş/çıkış sütunu",
  debit: "Tüm satırlar banka çıkışı",
  credit: "Tüm satırlar banka girişi",
};

const bankAccountsOf = (ref: ReferenceData): AccountJson[] =>
  sortByOrder(ref.accounts.filter((a) => a.is_active && (a.kind === "bank" || a.kind === "pos")));

/** Bank card (legacy BM): ready reading of a known format and the generic column mapper with saved layouts. */
export function BankMapperCard({
  card,
  setup,
  refData,
  rules,
  disabled,
  onAdd,
  onClose,
  onSetupChanged,
}: {
  card: CardState;
  setup: ImportSetupJson;
  refData: ReferenceData;
  rules: CompiledRules;
  disabled: boolean;
  onAdd: (accepted: AcceptedBankRows) => void;
  onClose: () => void;
  onSetupChanged: () => Promise<unknown>;
}) {
  const accounts = bankAccountsOf(refData);
  const knownAccount = card.accountImportKey
    ? setup.accounts.find((a) => a.import_key === card.accountImportKey && (a.kind === "bank" || a.kind === "pos"))
    : undefined;

  return (
    <section className="border rounded-lg p-4 bg-white space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">Banka dosyası: {card.file}</h3>
          <p className="text-xs text-gray-600">{card.notice}</p>
        </div>
        <button type="button" className={buttonSecondary} onClick={onClose} disabled={disabled}>
          Bu dosyayı kapat
        </button>
      </div>

      {!!card.knownRows?.length && (
        <KnownReading
          card={card}
          account={knownAccount}
          accounts={accounts}
          disabled={disabled}
          onLinked={onSetupChanged}
          onUse={(accountId) => {
            onAdd({ rows: card.knownRows ?? [], notes: card.knownNotes ?? [], accountId, layoutId: null });
            onClose();
          }}
        />
      )}

      <GenericMapper
        card={card}
        setup={setup}
        accounts={accounts}
        rules={rules}
        disabled={disabled}
        onAdd={onAdd}
        onSetupChanged={onSetupChanged}
        collapsed={!!card.knownRows?.length}
      />
    </section>
  );
}

function maskKey(key: string): string {
  const i = key.indexOf(":");
  if (i < 0) return key;
  const acct = key.slice(i + 1);
  return key.slice(0, i) + " · " + (acct.length > 4 ? "…" + acct.slice(-4) : acct);
}

function KnownReading({
  card,
  account,
  accounts,
  disabled,
  onLinked,
  onUse,
}: {
  card: CardState;
  account: { id: string; name: string } | undefined;
  accounts: AccountJson[];
  disabled: boolean;
  onLinked: () => Promise<unknown>;
  onUse: (accountId: string) => void;
}) {
  const key = card.accountImportKey ?? "";
  const free = accounts.filter((a) => !a.import_key);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FinanceError | null>(null);
  const rows = card.knownRows ?? [];
  const inflow = rows.filter((r) => r.signedCents > 0);
  const outflow = rows.filter((r) => r.signedCents < 0);

  const link = async () => {
    const acc = accounts.find((a) => a.id === pick);
    if (!acc) return;
    setBusy(true);
    setError(null);
    try {
      await finSetAccountImportKey({ p_id: acc.id, p_version: acc.version, p_import_key: key });
      await onLinked();
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-3 space-y-2 text-sm">
      <p>
        Bu dosya tanınan bir banka biçiminde ({maskKey(key)}): {rows.length} hareket okundu · {inflow.length} giriş{" "}
        {formatTL(inflow.reduce((n, r) => n + r.amount, 0))} · {outflow.length} çıkış{" "}
        {formatTL(outflow.reduce((n, r) => n + r.amount, 0))}.
        {card.knownIssues?.length ? ` ${card.knownIssues.length} satır okunamadı.` : ""}
      </p>
      {account ? (
        <>
          <p className="text-gray-700">Finans hesabı: {account.name}</p>
          <button type="button" className={buttonPrimary} disabled={disabled} onClick={() => onUse(account.id)}>
            Hazır okumayı kullan ({rows.length} kayıt)
          </button>
          <p className="text-xs text-gray-600">Farklı bir düzen için aşağıdaki sütun eşleştirmesini kullanın.</p>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-amber-800">
            Bu döküm henüz bir finans hesabına bağlı değil. Hesabı seçin; anahtar hesaba kaydedilir ve sonraki dökümler
            otomatik bağlanır.
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            <select className={`${inputClass} max-w-xs`} value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || disabled}>
              <option value="">Banka / POS hesabı seçin</option>
              {free.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({ACCOUNT_KIND_LABELS[a.kind]})
                </option>
              ))}
            </select>
            <button type="button" className={buttonSecondary} disabled={busy || disabled || !pick} onClick={link}>
              {busy ? "Kaydediliyor..." : "Hesabı bağla"}
            </button>
          </div>
          {free.length === 0 && (
            <p className="text-xs text-gray-600">
              Anahtarı boş aktif banka / POS hesabı yok. Finans ayarlarından hesap ekleyin veya Sütun eşleştirmeleri ve
              hesap anahtarları sayfasından mevcut anahtarı düzeltin.
            </p>
          )}
          <ErrorBox error={error} />
        </div>
      )}
    </div>
  );
}

type MapperState = { mapping: Omit<BankMapping, "account">; sheet: number; layoutId: string; accountId: string; label: string };

function GenericMapper({
  card,
  setup,
  accounts,
  rules,
  disabled,
  onAdd,
  onSetupChanged,
  collapsed,
}: {
  card: CardState;
  setup: ImportSetupJson;
  accounts: AccountJson[];
  rules: CompiledRules;
  disabled: boolean;
  onAdd: (accepted: AcceptedBankRows) => void;
  onSetupChanged: () => Promise<unknown>;
  collapsed: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [tables, setTables] = useState<BankTable[]>(card.tables);
  const layouts = setup.layouts.filter((l) => l.kind === "bank_table" && l.is_active);

  const initial = useMemo<MapperState>(() => {
    const t = card.tables[0]?.rows ?? [];
    const auto = suggestMapping(t);
    const offered = offerLayout(layouts, card.tables[0], auto.header);
    return fromLayoutOrSuggestion(offered, auto, 0, accounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [state, setState] = useState<MapperState>(initial);
  const [paste, setPaste] = useState("");
  const [tl, setTl] = useState(false);
  const [checked, setChecked] = useState(false);
  const [parsed, setParsed] = useState<BankTableResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<FinanceError | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [layoutName, setLayoutName] = useState("");
  const [busy, setBusy] = useState(false);

  const table = useMemo<BankTable>(() => tables[state.sheet] ?? { name: "Tablo", rows: [] }, [tables, state.sheet]);
  const width = Math.min(100, Math.max(0, ...table.rows.slice(0, 100).map((r) => r.length)));
  const layout = layouts.find((l) => l.id === state.layoutId) ?? null;
  const account = accounts.find((a) => a.id === state.accountId);
  const keyLabel = layout?.key_label ?? state.label;

  const mapping: BankMapping = useMemo(() => ({ ...state.mapping, account: keyLabel.trim() }), [state.mapping, keyLabel]);

  useEffect(() => {
    let alive = true;
    setParseError(null);
    parseBankTable(table, mapping, card.file, rules)
      .then((r) => alive && setParsed(r))
      .catch(() => alive && setParseError("Önizleme hazırlanamadı. Tekrar deneyin."));
    return () => {
      alive = false;
    };
  }, [table, mapping, card.file, rules]);

  const change = (patch: Partial<MapperState>) => {
    setState((s) => ({ ...s, ...patch }));
    setChecked(false);
    setSaveMsg(null);
  };
  const changeMapping = (patch: Partial<MapperState["mapping"]>) => change({ mapping: { ...state.mapping, ...patch } });

  const pickSheet = (i: number) => {
    const auto = suggestMapping(tables[i]?.rows ?? []);
    const offered = offerLayout(layouts, tables[i], auto.header);
    setState(fromLayoutOrSuggestion(offered, auto, i, accounts, state));
    setTl(false);
    setChecked(false);
  };

  const pickLayout = (id: string) => {
    const l = layouts.find((x) => x.id === id) ?? null;
    if (!l) return change({ layoutId: "" });
    const cfg = asBankTableConfig(l.config);
    if (!cfg) return change({ layoutId: l.id, accountId: l.account_id ?? state.accountId });
    const { header, date, description, amount, debit, credit, direction, balance, reference, currency, mode, format } = cfg.mapping;
    change({
      layoutId: l.id,
      accountId: l.account_id ?? state.accountId,
      mapping: { header, date, description, amount, debit, credit, direction, balance, reference, currency, mode, format },
    });
  };

  const pickAccount = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    change({ accountId: id, label: state.layoutId ? state.label : proposeLabel(a) });
  };

  const column = (key: keyof MapperState["mapping"], label: string) => (
    <Field label={label} key={key}>
      <select
        className={inputClass}
        value={String(state.mapping[key])}
        onChange={(e) => changeMapping({ [key]: Number(e.target.value) } as Partial<MapperState["mapping"]>)}
        disabled={disabled}
      >
        <option value="-1">Yok / seçin</option>
        {Array.from({ length: width }, (_, i) => (
          <option key={i} value={i}>
            {i + 1}. {bankText(table.rows[state.mapping.header]?.[i]).slice(0, 70) || "Başlıksız sütun"}
          </option>
        ))}
      </select>
    </Field>
  );

  const add = () => {
    if (!parsed || !account) return;
    onAdd({
      rows: parsed.rows,
      notes: [
        `${card.file} · ${table.name}: ${parsed.rows.length} satır eşleştirildi; ${parsed.issues.length} sorunlu satır ve ${parsed.ignored} başlık/işlem dışı satır aktarılmadı. Tüm banka satırları kontrol için seçimsiz eklendi.`,
      ],
      accountId: account.id,
      layoutId: layout?.id ?? null,
    });
    setChecked(false);
    setTl(false);
  };

  const saveLayout = async () => {
    if (!account) return;
    setBusy(true);
    setSaveError(null);
    setSaveMsg(null);
    const config: BankTableLayoutConfig = {
      version: 1,
      sheet_name: table.name.slice(0, 100),
      header_signature: headerSignature(table.rows[state.mapping.header] ?? []),
      mapping: { ...state.mapping },
    };
    try {
      const id = layout?.id ?? newId();
      const res = await finSaveImportLayout({
        p_id: id,
        p_version: layout?.version ?? 0,
        p_kind: "bank_table",
        p_name: (layout?.name ?? layoutName.trim()) || `${account.name} dökümü`,
        p_config: config as unknown as Record<string, unknown>,
        p_key_label: keyLabel.trim(),
        p_account_id: account.id,
        p_receipts_account_id: null,
        p_bank_paid_account_id: null,
        p_cash_paid_account_id: null,
        p_is_default: layout?.is_default ?? false,
        p_is_active: true,
      });
      await onSetupChanged();
      setState((s) => ({ ...s, layoutId: res.record.id }));
      setSaveMsg(res.already_saved ? "Eşleştirme zaten kayıtlı." : "Eşleştirme kaydedildi; bu bankanın sonraki dosyalarında otomatik önerilir.");
    } catch (err) {
      setSaveError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => setOpen(true)}>
        Sütunları elle eşleştir
      </button>
    );
  }

  const labelOk = keyLabel.trim().length >= 1 && keyLabel.trim().length <= 100;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-gray-700">
        Tarih ve tutar sütunlarını kontrol edin; sonra işlemleri kontrol listesine alın. Aynı dosyadaki her hesap için
        ilgili sayfayı ayrı eşleştirin.
      </p>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Sayfa">
          <select className={inputClass} value={state.sheet} onChange={(e) => pickSheet(Number(e.target.value))} disabled={disabled}>
            {tables.map((t, i) => (
              <option key={i} value={i}>
                {t.name} ({t.rows.length} satır)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kayıtlı eşleştirme">
          <select className={inputClass} value={state.layoutId} onChange={(e) => pickLayout(e.target.value)} disabled={disabled}>
            <option value="">Yeni eşleştirme</option>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Finans hesabı">
          <select className={inputClass} value={state.accountId} onChange={(e) => pickAccount(e.target.value)} disabled={disabled || !!layout}>
            <option value="">Banka / POS hesabı seçin</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({ACCOUNT_KIND_LABELS[a.kind]})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Banka + hesap etiketi" hint="Kaynak anahtarının parçası; aynı hesap için hep aynı kalmalı.">
          <input
            className={inputClass}
            value={keyLabel}
            maxLength={100}
            disabled={disabled || !!layout}
            onChange={(e) => change({ label: e.target.value })}
          />
        </Field>
        <Field label="Başlık satırı">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={Math.max(1, table.rows.length)}
            value={state.mapping.header + 1}
            disabled={disabled}
            onChange={(e) => {
              const header = Math.max(0, Number(e.target.value) - 1);
              const auto = suggestMapping([table.rows[header] ?? []]);
              const { account: _a, ...rest } = auto;
              void _a;
              change({ mapping: { ...rest, header } });
            }}
          />
        </Field>
        <Field label="Sayı biçimi">
          <select className={inputClass} value={state.mapping.format} onChange={(e) => changeMapping({ format: e.target.value as "tr" | "en" })} disabled={disabled}>
            <option value="tr">1.234,56 (Türkçe)</option>
            <option value="en">1,234.56 (İngilizce)</option>
          </select>
        </Field>
        <Field label="Tutar düzeni" className="md:col-span-2">
          <select className={inputClass} value={state.mapping.mode} onChange={(e) => changeMapping({ mode: e.target.value as MappingMode })} disabled={disabled}>
            {(Object.keys(MODE_LABELS) as MappingMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <details>
        <summary className="cursor-pointer text-gray-700">Dosyadaki ham tablo · ilk 30 satır</summary>
        <div className="overflow-x-auto max-h-80 mt-2 border rounded">
          <table className="text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-2 py-1">Satır</th>
                {Array.from({ length: width }, (_, i) => (
                  <th key={i} className="px-2 py-1">
                    Sütun {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 30).map((r, i) => (
                <tr key={i} className={i === state.mapping.header ? "bg-green-50" : ""}>
                  <td className="px-2 py-1 text-gray-500">{i + 1}</td>
                  {Array.from({ length: width }, (_, j) => (
                    <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[16rem] overflow-hidden text-ellipsis">
                      {bankText(r[j])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="grid gap-3 md:grid-cols-4">
        {column("date", "İşlem tarihi")}
        {column("description", "Açıklama")}
        {state.mapping.mode === "split" ? (
          <>
            {column("debit", "Borç / çıkış")}
            {column("credit", "Alacak / giriş")}
          </>
        ) : (
          column("amount", "İşlem tutarı (bakiye değil)")
        )}
        {state.mapping.mode === "direction" && column("direction", "Giriş / çıkış yönü")}
        {column("balance", "İşlem sonrası bakiye (isteğe bağlı)")}
        {column("reference", "İşlem referansı (isteğe bağlı)")}
        {column("currency", "Para birimi (varsa)")}
      </div>

      {parseError && <p className="text-red-600">{parseError}</p>}
      {parsed && (
        <>
          <p>
            <b>{parsed.rows.length} işlem okunabildi.</b> {parsed.issues.length} sorunlu satır aktarılmayacak. {parsed.ignored} başlık veya
            işlem dışı satır atlandı.
          </p>
          {parsed.issues.length > 0 && (
            <details open={parsed.rows.length === 0}>
              <summary className="cursor-pointer">Kontrol gereken satırlar</summary>
              <ul className="list-disc pl-5 text-xs text-gray-700">
                {parsed.issues.slice(0, 100).map((v, i) => (
                  <li key={i}>
                    {v.line ? `Satır ${v.line}: ` : ""}
                    {v.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {parsed.rows.length > 0 && (
            <div className="overflow-x-auto border rounded">
              <table className="w-full text-xs">
                <thead className="bg-gray-100">
                  <tr className="text-left">
                    <th className="px-2 py-1">Tarih</th>
                    <th className="px-2 py-1">Açıklama</th>
                    <th className="px-2 py-1 text-right">Tutar</th>
                    <th className="px-2 py-1">Yön</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 20).map((r) => (
                    <tr key={r.key} className="border-t">
                      <td className="px-2 py-1 whitespace-nowrap">{formatDay(r.date)}</td>
                      <td className="px-2 py-1">{r.description}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{formatTL(r.amount)}</td>
                      <td className="px-2 py-1">{r.signedCents < 0 ? "Çıkış" : "Giriş"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <details>
        <summary className="cursor-pointer text-gray-700">Tablo düzgün görünmüyorsa tablo yapıştır</summary>
        <p className="text-xs text-gray-600 my-2">
          Excel’den kopyalanmış tabloyu yapıştırabilirsiniz. Sütunlar sekmeyle ayrılmalı; ilk satır başlık olmalı.
        </p>
        <textarea className={inputClass} rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Tarih\tAçıklama\tBorç\tAlacak\n01.10.2026\tÖdeme\t1.000,00\t0,00"} />
        <button
          type="button"
          className={`${buttonSecondary} mt-2`}
          disabled={!paste.trim() || disabled}
          onClick={() => {
            const t = pasteTable(paste);
            setTables([t]);
            const auto = suggestMapping(t.rows);
            setState(fromLayoutOrSuggestion(null, auto, 0, accounts, state));
            setChecked(false);
          }}
        >
          Yapıştırılan tabloyu kullan
        </button>
      </details>

      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={tl} onChange={(e) => setTl(e.target.checked)} disabled={disabled} />
        Bu hesap ve seçtiğim tutarlar TL cinsinden.
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={disabled} />
        Tarihleri, giriş/çıkış yönünü ve atlanan satırları kontrol ettim.
      </label>
      {!account && <p className="text-amber-700">Satırların işleneceği banka / POS hesabını seçin.</p>}
      {account && !labelOk && <p className="text-amber-700">Banka + hesap etiketi 1-100 karakter olmalı.</p>}
      <div className="flex flex-wrap gap-2 items-end">
        <button
          type="button"
          className={buttonPrimary}
          disabled={disabled || !tl || !checked || !parsed?.rows.length || !account || !labelOk}
          onClick={add}
        >
          {parsed?.rows.length ?? 0} satırı kontrol listesine al
        </button>
        {!layout && (
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Eşleştirme adı"
            value={layoutName}
            maxLength={80}
            onChange={(e) => setLayoutName(e.target.value)}
            disabled={disabled}
          />
        )}
        <button type="button" className={buttonSecondary} disabled={disabled || busy || !account || !labelOk} onClick={saveLayout}>
          {busy ? "Kaydediliyor..." : layout ? "Eşleştirmeyi güncelle" : "Bu eşleştirmeyi kaydet"}
        </button>
      </div>
      {saveMsg && <p className="text-green-700">{saveMsg}</p>}
      <ErrorBox error={saveError} />
    </div>
  );
}

function proposeLabel(a: AccountJson | undefined): string {
  if (!a) return "";
  return (a.import_key ?? `${a.bank_name ?? ""} ${a.name}`).trim().slice(0, 100);
}

/** A saved layout whose header signature equals the table's header row (and sheet name, when set). */
function offerLayout(layouts: ImportLayoutJson[], table: BankTable | undefined, header: number): ImportLayoutJson | null {
  if (!table) return null;
  const sig = (table.rows[header] ?? []).map((c) => normB(c).trim()).filter(Boolean).slice(0, 40).map((c) => c.slice(0, 80)).join("\u0001");
  if (!sig) return null;
  const hits = layouts.filter((l) => {
    const cfg = asBankTableConfig(l.config);
    if (!cfg) return false;
    if (cfg.sheet_name && cfg.sheet_name !== table.name) return false;
    return cfg.header_signature.join("\u0001") === sig;
  });
  return hits.find((l) => l.is_default) ?? hits[0] ?? null;
}

function fromLayoutOrSuggestion(
  layout: ImportLayoutJson | null,
  auto: BankMapping,
  sheet: number,
  accounts: AccountJson[],
  prev?: MapperState
): MapperState {
  const cfg = layout ? asBankTableConfig(layout.config) : null;
  if (layout && cfg) {
    const { header, date, description, amount, debit, credit, direction, balance, reference, currency, mode, format } = cfg.mapping;
    return {
      sheet,
      layoutId: layout.id,
      accountId: layout.account_id ?? "",
      label: layout.key_label ?? "",
      mapping: { header, date, description, amount, debit, credit, direction, balance, reference, currency, mode, format },
    };
  }
  const { account: _a, ...mapping } = auto;
  void _a;
  const accountId = prev?.accountId ?? "";
  return {
    sheet,
    layoutId: "",
    accountId,
    label: prev?.label ?? proposeLabel(accounts.find((a) => a.id === accountId)),
    mapping,
  };
}
