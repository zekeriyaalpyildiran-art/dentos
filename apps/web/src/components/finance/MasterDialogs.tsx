"use client";

import { useState } from "react";
import {
  ACCOUNT_KIND_LABELS,
  REPORT_BUCKETS,
  finSaveAccount,
  finSaveCategory,
  finSaveReportGroup,
  newId,
  pickable,
  sortByOrder,
  toFinanceError,
  type AccountJson,
  type AccountKind,
  type CategoryJson,
  type FinanceError,
  type ReferenceData,
  type ReportBucket,
  type ReportGroupJson,
} from "@/lib/finance";
import { ErrorBox, Field, Modal, buttonPrimary, buttonSecondary, inputClass } from "./ui";

interface Common {
  refData: ReferenceData;
  onClose: () => void;
  /** PT409: close and reload the reference data. */
  onReload: () => void;
  onSaved: (message: string) => void | Promise<void>;
}

function parseSort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 0 && n <= 10000 ? n : null;
}

function Buttons({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  return (
    <div className="flex gap-2">
      <button type="submit" className={buttonPrimary} disabled={busy}>
        {busy ? "Kaydediliyor..." : "Kaydet"}
      </button>
      <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
        Vazgeç
      </button>
    </div>
  );
}

function useSaveState() {
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  return { formError, setFormError, error, setError, busy, setBusy };
}

export function AccountDialog({
  record,
  onClose,
  onReload,
  onSaved,
}: Omit<Common, "refData"> & { record: AccountJson | null }) {
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.name ?? "");
  const [kind, setKind] = useState<AccountKind>(record?.kind ?? "bank");
  const [bankName, setBankName] = useState(record?.bank_name ?? "");
  const [active, setActive] = useState(record?.is_active ?? true);
  const [sort, setSort] = useState(String(record?.sort_order ?? 100));
  const s = useSaveState();
  const kindLocked = !!record?.is_used;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    s.setFormError(null);
    s.setError(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) return s.setFormError("Ad boş olamaz ve en fazla 80 karakter olabilir.");
    const sortOrder = parseSort(sort);
    if (sortOrder === null) return s.setFormError("Sıra 0 ile 10000 arasında bir tam sayı olmalı.");
    s.setBusy(true);
    try {
      const res = await finSaveAccount({
        p_id: id,
        p_version: record?.version ?? 0,
        p_name: trimmed,
        p_kind: kind,
        p_bank_name: bankName.trim() || null,
        p_is_active: active,
        p_sort_order: sortOrder,
      });
      await onSaved(res.already_saved ? "Değişiklik yok." : `${res.record.name} hesabı kaydedildi.`);
    } catch (err) {
      s.setError(toFinanceError(err));
      s.setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Hesabı düzenle" : "Yeni hesap"} onClose={onClose} busy={s.busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ad">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Tür" hint={kindLocked ? "Kullanılmış hesabın türü değiştirilemez." : undefined}>
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)} disabled={kindLocked}>
            {(Object.keys(ACCOUNT_KIND_LABELS) as AccountKind[]).map((k) => (
              <option key={k} value={k}>
                {ACCOUNT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Banka adı (isteğe bağlı)">
          <input className={inputClass} value={bankName} maxLength={80} onChange={(e) => setBankName(e.target.value)} />
        </Field>
        <Field label="Sıra">
          <input className={inputClass} inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktif (pasif hesap yeni ödemelerde seçilemez; eski ödemeler korunur)
        </label>
        {s.formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{s.formError}</div>}
        <ErrorBox error={s.error} onReload={onReload} />
        <Buttons busy={s.busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function ReportGroupDialog({
  record,
  onClose,
  onReload,
  onSaved,
}: Omit<Common, "refData"> & { record: ReportGroupJson | null }) {
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.name ?? "");
  const [active, setActive] = useState(record?.is_active ?? true);
  const [sort, setSort] = useState(String(record?.sort_order ?? 100));
  const s = useSaveState();

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    s.setFormError(null);
    s.setError(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) return s.setFormError("Ad boş olamaz ve en fazla 80 karakter olabilir.");
    const sortOrder = parseSort(sort);
    if (sortOrder === null) return s.setFormError("Sıra 0 ile 10000 arasında bir tam sayı olmalı.");
    s.setBusy(true);
    try {
      const res = await finSaveReportGroup({
        p_id: id,
        p_version: record?.version ?? 0,
        p_name: trimmed,
        p_is_active: active,
        p_sort_order: sortOrder,
      });
      await onSaved(res.already_saved ? "Değişiklik yok." : `${res.record.name} grubu kaydedildi.`);
    } catch (err) {
      s.setError(toFinanceError(err));
      s.setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Rapor grubunu düzenle" : "Yeni rapor grubu"} onClose={onClose} busy={s.busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ad" hint="Açık borçlar özet ekranında bu adla gruplanır.">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Sıra">
          <input className={inputClass} inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktif (pasif grup seçilemez; açık tutarı varsa özette görünmeye devam eder)
        </label>
        {s.formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{s.formError}</div>}
        <ErrorBox error={s.error} onReload={onReload} />
        <Buttons busy={s.busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function CategoryDialog({ refData, record, onClose, onReload, onSaved }: Common & { record: CategoryJson | null }) {
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.name ?? "");
  const [bucket, setBucket] = useState<ReportBucket | "">(record?.report_bucket ?? "");
  const [groupId, setGroupId] = useState(record?.report_group_id ?? "");
  const [active, setActive] = useState(record?.is_active ?? true);
  const [sort, setSort] = useState(String(record?.sort_order ?? 200));
  const s = useSaveState();

  const bucketInfo = REPORT_BUCKETS.find((b) => b.value === bucket);
  const groups = sortByOrder(pickable(refData.report_groups, groupId));
  const systemDoctor = !!record?.is_system && record.report_bucket === "doctor";

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    s.setFormError(null);
    s.setError(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) return s.setFormError("Ad boş olamaz ve en fazla 80 karakter olabilir.");
    if (!bucket) return s.setFormError("Rapor türü seçin.");
    const sortOrder = parseSort(sort);
    if (sortOrder === null) return s.setFormError("Sıra 0 ile 10000 arasında bir tam sayı olmalı.");
    s.setBusy(true);
    try {
      const res = await finSaveCategory({
        p_id: id,
        p_version: record?.version ?? 0,
        p_name: trimmed,
        p_report_bucket: bucket,
        p_report_group_id: bucketInfo?.direction === "out" && groupId ? groupId : null,
        p_is_active: active,
        p_sort_order: sortOrder,
      });
      await onSaved(res.already_saved ? "Değişiklik yok." : `${res.record.name} kategorisi kaydedildi.`);
    } catch (err) {
      s.setError(toFinanceError(err));
      s.setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Kategoriyi düzenle" : "Yeni kategori"} onClose={onClose} busy={s.busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ad">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field
          label="Rapor türü"
          hint={
            record
              ? "Rapor türü değiştirilemez. Gerekirse kategoriyi pasif yapıp yenisini ekleyin."
              : "Hesaplamalar kategori adını değil rapor türünü kullanır; yön ve faaliyet sınıfı buradan gelir."
          }
        >
          <select
            className={inputClass}
            value={bucket}
            onChange={(e) => setBucket(e.target.value as ReportBucket | "")}
            disabled={!!record}
            required
          >
            <option value="">Seçin</option>
            {REPORT_BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label} · {b.direction === "in" ? "giriş" : "çıkış"}
              </option>
            ))}
          </select>
        </Field>
        {bucketInfo?.direction === "out" && (
          <Field label="Açık borç rapor grubu" hint="Kişi / kurumun grubu yoksa bu kategorideki açık borçlar bu grupta toplanır.">
            <select className={inputClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Diğer borçlar</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Sıra">
          <input className={inputClass} inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={active} disabled={systemDoctor} onChange={(e) => setActive(e.target.checked)} />
          Aktif
          {systemDoctor && <span className="text-xs text-gray-500">(hekim hakedişi sistem kategorisi pasif yapılamaz)</span>}
        </label>
        {s.formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{s.formError}</div>}
        <ErrorBox error={s.error} onReload={onReload} />
        <Buttons busy={s.busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
