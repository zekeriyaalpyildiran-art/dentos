"use client";

// Macro import (0033) pieces shared by the "Macro yükleme" and "İşlem grupları" pages of the Hakediş section (finance
// and prep modes, HakedisParts): the procedure groups (fin_hk_proc_groups: Macro operation names counted as pieces of
// a group; implant groups keep the amount out of the doctor's ciro) and the Macro doctor mapping (fin_hk_ext_doctors:
// DentOS doctor / clinic / outside doctor / ignore). Both are written by 'finance' or 'hakedis_prepare' holders
// (fin_hk_save_proc_group, fin_hk_save_ext_doctor); a change affects later imports only.

import { useState } from "react";
import { DialogButtons, HakedisTabs, useHkReference, type HkMode } from "./HakedisParts";
import { Card, ErrorBox, Field, Loading, Modal, SuccessBox, buttonPrimary, buttonSecondary, inputClass } from "./ui";
import { UUID_RE, formatTimestamp, newId, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  EXT_DOCTOR_MODE_HINTS,
  EXT_DOCTOR_MODE_LABELS,
  HK_EXT_DOCTOR_MODES,
  HK_EXT_NAME_MAX,
  HK_OP_NAME_MAX,
  HK_PROC_GROUP_NAME_MAX,
  finHkSaveExtDoctor,
  finHkSaveProcGroup,
  hkCanPrepare,
  normalizeOpNames,
  opNameMoves,
  validateExtDoctor,
  validateProcGroup,
  type HkExtDoctorJson,
  type HkExtDoctorMode,
  type HkProcGroupJson,
  type HkReferenceJson,
} from "@/lib/hakedis";

/** How the procedure groups are used, for the groups page and the import page. */
export const PROC_GROUPS_TEXT =
  "Macro işlem raporundaki her satır, işlem adı bir gruba bağlıysa o grubun bir işlemi (adedi) sayılır; fiyatı 0 TL " +
  "olsa da. Hekimin “İşlem başı ücret” kuralı grubun her işlemi için sabit tutar öder. “İmplant grubu” işaretli " +
  "gruplarda satırın tutarı hekimin cirosuna girmez (implant payı) ve “İmplant (adet başı)” kuralı bu işlemleri sayar. " +
  "Gruba bağlı olmayan işlem adları normal tedavidir. Grup değişikliği yüklenmiş satırları değiştirmez; aralığı yeniden " +
  "yükleyin.";

/** How the Macro doctor names are mapped. */
export const EXT_DOCTORS_TEXT =
  "Macro raporlarındaki her hekim adı bir kez eşleştirilir. Eşleştirme sonraki yüklemelerde kullanılır; değişiklik " +
  "yüklenmiş satırları değiştirmez, aralığı yeniden yükleyin.";

/** Mode of a Macro doctor mapping in a table cell: "Klinik", "DentOS hekimi · Hekim A". */
export function extDoctorModeText(m: Pick<HkExtDoctorJson, "mode" | "doctor_name">): string {
  return m.mode === "doctor" ? m.doctor_name || EXT_DOCTOR_MODE_LABELS.doctor : EXT_DOCTOR_MODE_LABELS[m.mode];
}

/**
 * Puts a Macro operation name into the group `targetId` (null = into no group): out of the group that holds it, then
 * into the target (two saves at most, opNameMoves). Throws the first failure as a FinanceError.
 */
export async function moveOperation(groups: readonly HkProcGroupJson[], operation: string, targetId: string | null) {
  for (const move of opNameMoves(groups, operation, targetId)) {
    const g = move.group;
    await finHkSaveProcGroup({
      p_id: g.id,
      p_version: g.version,
      p_name: g.name,
      p_is_implant: g.is_implant,
      p_op_names: move.op_names,
      p_is_active: g.is_active,
      p_note: g.note ?? "",
    });
  }
}

/**
 * Create / edit a procedure group: name, implant flag, the Macro operation names (one per line; stored normalized),
 * active flag and note. `prefillOps` adds operation names to a new group (from the import page's operation table).
 */
export function ProcGroupDialog({
  refData,
  record,
  prefillOps,
  onClose,
  onSaved,
  onReload,
}: {
  refData: HkReferenceJson;
  record: HkProcGroupJson | null;
  prefillOps?: string[];
  onClose: () => void;
  onSaved: (record: HkProcGroupJson, alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
}) {
  const groups = refData.proc_groups ?? [];
  const current = record ? groups.find((g) => g.id === record.id) ?? record : null;
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.name ?? "");
  const [isImplant, setIsImplant] = useState(record?.is_implant ?? false);
  const [ops, setOps] = useState(() => [...(record?.op_names ?? []), ...(prefillOps ?? [])].join("\n"));
  const [isActive, setIsActive] = useState(record?.is_active ?? true);
  const [note, setNote] = useState(record?.note ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const opList = ops
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const normalized = normalizeOpNames(opList);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const invalid = validateProcGroup({ id, name, op_names: opList }, groups);
    if (invalid) return setFormError(invalid);
    if (note.trim().length > 500) return setFormError("Not en fazla 500 karakter olabilir.");
    setBusy(true);
    try {
      const res = await finHkSaveProcGroup({
        p_id: id,
        p_version: current?.version ?? 0,
        p_name: name.trim().replace(/\s+/g, " "),
        p_is_implant: isImplant,
        p_op_names: normalized,
        p_is_active: isActive,
        p_note: note.trim(),
      });
      await onSaved(res.record, res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "İşlem grubunu düzenle" : "Yeni işlem grubu"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Grup adı" hint="Ör. Çekim, Gömülü diş çekimi, Sinüs + greft.">
          <input
            className={inputClass}
            maxLength={HK_PROC_GROUP_NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <label className="flex items-start gap-2 text-sm text-gray-800">
          <input type="checkbox" className="mt-1" checked={isImplant} onChange={(e) => setIsImplant(e.target.checked)} />
          <span>
            İmplant grubu
            <span className="block text-xs text-gray-500">
              Satırların tutarı hekimin cirosuna girmez (implant payı); “İmplant (adet başı)” kuralı bu gruptaki işlemleri
              sayar.
            </span>
          </span>
        </label>
        <Field
          label="Macro işlem adları"
          hint={`Her satıra bir işlem adı, Macro raporundaki gibi (büyük / küçük harf ve boşluk fark etmez; en fazla ${HK_OP_NAME_MAX} karakter). Bir işlem adı yalnız bir grupta olabilir.`}
        >
          <textarea className={`${inputClass} font-mono text-sm`} rows={6} value={ops} onChange={(e) => setOps(e.target.value)} />
        </Field>
        {normalized.length > 0 && (
          <p className="text-xs text-gray-600">
            {normalized.length} işlem adı şöyle kaydedilir: {normalized.join(" · ")}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Aktif (pasif grubun işlem adları yeni yüklemelerde gruba bağlanmaz)
        </label>
        <Field label="Not">
          <textarea className={inputClass} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

/**
 * Create / edit the mapping of a Macro doctor name: a DentOS doctor, the clinic, an outside doctor without hakediş or
 * ignore. `extName` fills the name of a new mapping (from the import page).
 */
export function ExtDoctorDialog({
  refData,
  record,
  extName,
  onClose,
  onSaved,
  onReload,
  onOpenExisting,
}: {
  refData: HkReferenceJson;
  record: HkExtDoctorJson | null;
  extName?: string;
  onClose: () => void;
  onSaved: (record: HkExtDoctorJson, alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
  onOpenExisting?: (m: HkExtDoctorJson) => void;
}) {
  const mapping = refData.ext_doctors ?? [];
  const current = record ? mapping.find((m) => m.id === record.id) ?? record : null;
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.display_name ?? extName ?? "");
  const [mode, setMode] = useState<HkExtDoctorMode | null>(record?.mode ?? null);
  const [doctorId, setDoctorId] = useState(record?.doctor_id ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const doctors = refData.doctors.filter((d) => d.is_active || d.id === doctorId);
  const existing =
    error?.isConflict && error.details && UUID_RE.test(error.details)
      ? mapping.find((m) => m.id === error.details && m.id !== id)
      : undefined;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const doctor = mode === "doctor" ? doctorId || null : null;
    const invalid = validateExtDoctor({ ext_name: name, mode, doctor_id: doctor });
    if (invalid) return setFormError(invalid);
    setBusy(true);
    try {
      const res = await finHkSaveExtDoctor({
        p_id: id,
        p_version: current?.version ?? 0,
        p_ext_name: name.trim().replace(/\s+/g, " "),
        p_mode: mode!,
        p_doctor_id: doctor,
      });
      await onSaved(res.record, res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Macro hekim eşleştirmesini düzenle" : "Macro hekimini eşleştir"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Macro'daki hekim adı" hint="Rapordaki DOKTOR sütunundaki ad (büyük / küçük harf ve boşluk fark etmez).">
          <input
            className={inputClass}
            maxLength={HK_EXT_NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={!record && !!extName}
            required
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-gray-800 mb-1">Bu hekimin satırları</legend>
          {HK_EXT_DOCTOR_MODES.map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm text-gray-800">
              <input type="radio" name="ext-mode" className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                <span className="font-medium">{EXT_DOCTOR_MODE_LABELS[m]}</span>
                <span className="block text-xs text-gray-500">{EXT_DOCTOR_MODE_HINTS[m]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "doctor" && (
          <Field label="DentOS hekimi">
            <select className={inputClass} value={doctorId} onChange={(e) => setDoctorId(e.target.value)} required>
              <option value="">Seçin</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.specialty ? ` · ${d.specialty}` : ""}
                  {d.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
        )}
        {record && (
          <p className="text-xs text-gray-500">Değişiklik yüklenmiş satırları değiştirmez; aralığı yeniden yükleyin.</p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={existing ? undefined : onReload} />
        {existing && onOpenExisting && (
          <button type="button" className={buttonSecondary} onClick={() => onOpenExisting(existing)}>
            Mevcut eşleştirmeyi aç
          </button>
        )}
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

/** The procedure groups with their Macro operation names. */
export function ProcGroupsCard({
  groups,
  canWrite,
  onAdd,
  onEdit,
}: {
  groups: readonly HkProcGroupJson[];
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (g: HkProcGroupJson) => void;
}) {
  return (
    <Card
      title="İşlem grupları"
      actions={
        canWrite ? (
          <button type="button" className={buttonPrimary} onClick={onAdd}>
            Yeni grup
          </button>
        ) : undefined
      }
    >
      <p className="text-sm text-gray-600 mb-3">{PROC_GROUPS_TEXT}</p>
      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">Henüz işlem grubu yok.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-700 border-b">
                <th className="py-2 pr-3 font-semibold">Grup</th>
                <th className="py-2 pr-3 font-semibold">Tür</th>
                <th className="py-2 pr-3 font-semibold">Macro işlem adları</th>
                <th className="py-2 pr-3 font-semibold">Durum</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className={`border-b last:border-b-0 align-top ${g.is_active ? "" : "text-gray-400"}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{g.name}</div>
                    {g.note && <div className="text-xs text-gray-500 max-w-xs">{g.note}</div>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{g.is_implant ? "İmplant grubu" : "İşlem grubu"}</td>
                  <td className="py-2 pr-3">
                    {g.op_names.length === 0 ? (
                      <span className="text-xs text-amber-700">İşlem adı yok</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {g.op_names.map((op) => (
                          <span key={op} className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-800 text-xs">
                            {op}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{g.is_active ? "Aktif" : "Pasif"}</td>
                  <td className="py-2 text-right">
                    {canWrite && (
                      <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(g)}>
                        Düzenle
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The Macro doctor mapping. */
export function ExtDoctorsCard({
  mapping,
  canWrite,
  onAdd,
  onEdit,
}: {
  mapping: readonly HkExtDoctorJson[];
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (m: HkExtDoctorJson) => void;
}) {
  return (
    <Card
      title="Macro hekim eşleştirme"
      actions={
        canWrite ? (
          <button type="button" className={buttonSecondary} onClick={onAdd}>
            Yeni eşleştirme
          </button>
        ) : undefined
      }
    >
      <p className="text-sm text-gray-600 mb-3">{EXT_DOCTORS_TEXT}</p>
      {mapping.length === 0 ? (
        <p className="text-sm text-gray-500">Henüz eşleştirme yok. Macro yükleme sayfası raporlardaki hekimleri sorar.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-700 border-b">
                <th className="py-2 pr-3 font-semibold">Macro&apos;daki ad</th>
                <th className="py-2 pr-3 font-semibold">Eşleştirme</th>
                <th className="py-2 pr-3 font-semibold">Son değişiklik</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {mapping.map((m) => (
                <tr key={m.id} className="border-b last:border-b-0 align-top">
                  <td className="py-2 pr-3 font-medium">{m.display_name || m.ext_name}</td>
                  <td className="py-2 pr-3">
                    <div>{extDoctorModeText(m)}</div>
                    <div className="text-xs text-gray-500">{m.mode === "doctor" ? EXT_DOCTOR_MODE_LABELS.doctor : EXT_DOCTOR_MODE_HINTS[m.mode]}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-600 whitespace-nowrap">
                    {m.updated_by_name ?? "—"} · {formatTimestamp(m.updated_at)}
                  </td>
                  <td className="py-2 text-right">
                    {canWrite && (
                      <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(m)}>
                        Düzenle
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type GroupsDialog =
  | { kind: "group"; record: HkProcGroupJson | null }
  | { kind: "ext"; record: HkExtDoctorJson | null };

/**
 * İşlem grupları page: the procedure groups and the Macro doctor mapping, editable by 'finance' or
 * 'hakedis_prepare' holders (read-only for 'finance_readonly').
 */
export function HakedisGroupsView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [dialog, setDialog] = useState<GroupsDialog | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!ref.data) return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  const data = ref.data;
  const canWrite = hkCanPrepare(data);
  const groups = data.proc_groups ?? [];
  const mapping = data.ext_doctors ?? [];

  const close = () => setDialog(null);
  const reload = async () => {
    setDialog(null);
    await ref.reload();
  };

  return (
    <div className="space-y-4">
      <HakedisTabs mode={mode} />
      <SuccessBox text={message} />
      <ErrorBox error={ref.error} onReload={ref.reload} />
      {data.proc_groups === undefined && (
        <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
          İşlem grupları ve Macro yükleme veritabanında henüz etkin değil (0033 uygulanmalı).
        </div>
      )}
      {!canWrite && <p className="text-sm text-gray-600">Salt okunur.</p>}

      <ProcGroupsCard
        groups={groups}
        canWrite={canWrite}
        onAdd={() => setDialog({ kind: "group", record: null })}
        onEdit={(g) => setDialog({ kind: "group", record: g })}
      />
      <ExtDoctorsCard
        mapping={mapping}
        canWrite={canWrite}
        onAdd={() => setDialog({ kind: "ext", record: null })}
        onEdit={(m) => setDialog({ kind: "ext", record: m })}
      />

      {dialog?.kind === "group" && (
        <ProcGroupDialog
          key={dialog.record?.id ?? "new"}
          refData={data}
          record={dialog.record}
          onClose={close}
          onReload={reload}
          onSaved={async (_record, already) => {
            setDialog(null);
            setMessage(already ? "Değişiklik yok; grup aynı kaldı." : "İşlem grubu kaydedildi.");
            await ref.reload();
          }}
        />
      )}
      {dialog?.kind === "ext" && (
        <ExtDoctorDialog
          key={dialog.record?.id ?? "new"}
          refData={data}
          record={dialog.record}
          onClose={close}
          onReload={reload}
          onOpenExisting={(m) => setDialog({ kind: "ext", record: m })}
          onSaved={async (_record, already) => {
            setDialog(null);
            setMessage(already ? "Değişiklik yok; eşleştirme aynı kaldı." : "Macro hekim eşleştirmesi kaydedildi.");
            await ref.reload();
          }}
        />
      )}
    </div>
  );
}

