"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { istanbulToday } from "@/lib/clinical/dates";
import { UUID_RE, formatDay, newId, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  HK_MARKS_LIST_LIMIT,
  HK_MIN_BIRTH_DATE,
  MARK_GROUP_LABELS,
  ageOn,
  hkMarksAccess,
  hkMarksList,
  hkSaveMark,
  markGroupOf,
  normalizePatientRef,
  validateBirthDate,
  type HkMarkDoctorJson,
  type HkMarkRowJson,
  type HkMarksAccessJson,
} from "@/lib/hakedis";

/**
 * Hasta işaretleri (hakediş v1.1): the reception marks a patient as a doctor's own-portfolio patient and enters the
 * birth date (the child patient group follows the age on each payment day). hk_marks_access / hk_marks_list /
 * hk_save_mark need no finance permission and carry patient names, doctor names and birth dates only, never an amount.
 * The child / adult mark (0034: "Grup", shown read-only) and the note stay with the finance Hakediş pages; an adult
 * birth date entered here still makes the patient an adult. Reception, admins and the owner (layout.tsx).
 */
export default function HastaIsaretleriPage() {
  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900 max-w-5xl">
      <h1 className="text-2xl md:text-3xl font-bold">Hasta işaretleri</h1>
      <MarksDesk />
    </div>
  );
}

type DialogState = { record: HkMarkRowJson | null; name?: string };

/** The patient key is the normalized name unless a patient no was entered (then it is shown as "Hasta no"). */
function patientNo(m: Pick<HkMarkRowJson, "patient_ref" | "patient_name">): string {
  return m.patient_ref === normalizePatientRef(m.patient_name) ? "" : m.patient_ref;
}

/**
 * "Grup" column (0034): with a birth date the group follows the age on each payment day; else the finance child /
 * adult mark; "—" = not stated (the doctor's default applies).
 */
function groupText(m: Pick<HkMarkRowJson, "birth_date" | "is_child" | "is_adult">): string {
  if (m.birth_date) return "Yaşa göre";
  const group = markGroupOf(m);
  return group ? MARK_GROUP_LABELS[group] : "—";
}

function ageText(birth: string | null, today: string): string {
  const age = birth ? ageOn(birth, today) : null;
  return age === null ? "—" : String(Math.max(age, 0));
}

function MarksDesk() {
  const [today] = useState(() => istanbulToday());
  const [access, setAccess] = useState<HkMarksAccessJson | null>(null);
  const [accessError, setAccessError] = useState<FinanceError | null>(null);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HkMarkRowJson[] | null>(null);
  const [listError, setListError] = useState<FinanceError | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const seq = useRef(0);

  const loadAccess = useCallback(async () => {
    try {
      setAccess(await hkMarksAccess());
      setAccessError(null);
    } catch (err) {
      setAccessError(toFinanceError(err));
    }
  }, []);

  const loadList = useCallback(async (q: string) => {
    const mine = ++seq.current;
    setListLoading(true);
    try {
      const next = await hkMarksList(q);
      if (mine !== seq.current) return;
      setRows(next);
      setListError(null);
    } catch (err) {
      if (mine === seq.current) setListError(toFinanceError(err));
    } finally {
      if (mine === seq.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

  const canMark = access?.can_mark ?? false;
  useEffect(() => {
    if (!canMark) return;
    // The search runs on the server (at most HK_MARKS_LIST_LIMIT rows); typing waits a moment before asking.
    const timer = setTimeout(() => loadList(query), query.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [canMark, query, loadList]);

  if (!access) return accessError ? <AccessError error={accessError} onRetry={loadAccess} /> : <Loading />;

  if (!access.can_mark) {
    return (
      <Card>
        <p className="text-gray-700">Hasta işaretlerini görme yetkiniz yok.</p>
      </Card>
    );
  }

  const reload = async () => {
    setDialog(null);
    await Promise.all([loadAccess(), loadList(query)]);
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded bg-blue-50 text-blue-900 text-sm space-y-1">
        <p>
          <strong>Hekimin kendi hastası:</strong> hasta, seçilen hekimin kendi hastasıdır; o hekimin bu hastadan aldığı
          ödemeler hakedişte “Hekimin kendi hastası” grubunda sayılır. Listede yalnız bu ay için böyle bir hakediş
          kuralı olan hekimler çıkar.
        </p>
        <p>
          <strong>Doğum tarihi:</strong> çocuk hasta grubu, hastanın her ödeme günündeki yaşına göre belirlenir.
          Doğum tarihi yoksa finansın “Grup” seçimi (Çocuk / Yetişkin) kullanılır; o da yoksa hekimin ayarına göre
          sayılır (çocuk hastası çok olan hekimde işaretsiz hasta çocuk sayılabilir). Yetişkin bir hastanın doğum
          tarihini girmek yeterlidir.
        </p>
        <p>
          Hasta adını tahsilat kayıtlarındaki gibi yazın (büyük / küçük harf ve boşluk fark etmez). Kapanmış bir ayda
          ödemesi olan hastanın hekim ve doğum tarihi değişikliğini klinik sahibi yapar.
        </p>
      </div>

      <SuccessBox text={message} />

      <div className="bg-white p-4 rounded-lg shadow flex flex-wrap items-end gap-3">
        <Field label="Ara" className="flex-1 min-w-[12rem]">
          <input
            className={`${inputClass} min-h-[44px]`}
            type="search"
            placeholder="Hasta adı veya hasta no"
            maxLength={100}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <button
          type="button"
          className={`${buttonPrimary} min-h-[44px]`}
          onClick={() => {
            setMessage(null);
            setDialog({ record: null });
          }}
        >
          Yeni işaret
        </button>
        {listLoading && <span className="text-sm text-gray-500 pb-3">Yükleniyor...</span>}
      </div>

      {listError && (
        <div className="p-4 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3">
          <span className="flex-1 min-w-[12rem]">{listError.message}</span>
          <button
            type="button"
            onClick={() => loadList(query)}
            disabled={listLoading}
            className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100"
          >
            Tekrar dene
          </button>
        </div>
      )}

      {rows === null ? (
        listError ? null : <Loading />
      ) : (
        <MarksList
          rows={rows}
          today={today}
          query={query}
          onEdit={(m) => {
            setMessage(null);
            setDialog({ record: m });
          }}
          onAdd={(name) => {
            setMessage(null);
            setDialog({ record: null, name });
          }}
        />
      )}

      {dialog && (
        <MarkDialog
          key={dialog.record?.id ?? `new:${dialog.name ?? ""}`}
          record={dialog.record}
          initialName={dialog.name}
          doctors={access.doctors}
          today={today}
          onClose={() => setDialog(null)}
          onReload={reload}
          onOpenExisting={(m) => setDialog({ record: m })}
          onSaved={async (alreadySaved) => {
            setDialog(null);
            setMessage(alreadySaved ? "Değişiklik yok; işaret aynı kaldı." : "Hasta işareti kaydedildi.");
            await loadList(query);
          }}
        />
      )}
    </div>
  );
}

function AccessError({ error, onRetry }: { error: FinanceError; onRetry: () => void }) {
  return (
    <div className="p-4 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3">
      <span className="flex-1 min-w-[12rem]">{error.message}</span>
      {!error.isForbidden && (
        <button type="button" onClick={onRetry} className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100">
          Tekrar dene
        </button>
      )}
    </div>
  );
}

function MarksList({
  rows,
  today,
  query,
  onEdit,
  onAdd,
}: {
  rows: HkMarkRowJson[];
  today: string;
  query: string;
  onEdit: (m: HkMarkRowJson) => void;
  onAdd: (name: string) => void;
}) {
  const q = query.trim();
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-gray-700">{q ? "Aramaya uyan işaretli hasta yok." : "Henüz işaretli hasta yok."}</p>
        {q && (
          <button type="button" className={`${buttonSecondary} mt-3 min-h-[44px]`} onClick={() => onAdd(q)}>
            “{q}” için işaret ekle
          </button>
        )}
      </Card>
    );
  }

  const lockedNote = (m: HkMarkRowJson) =>
    m.locked ? <div className="text-xs text-amber-700">Kapanmış ayda ödemesi var</div> : null;
  const noNote = (m: HkMarkRowJson) => {
    const no = patientNo(m);
    return no ? <div className="text-xs text-gray-500">Hasta no: {no}</div> : null;
  };

  return (
    <Card>
      {/* Phones: one card per patient. */}
      <ul className="md:hidden divide-y -my-2">
        {rows.map((m) => (
          <li key={m.id} className="py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium break-words">{m.patient_name}</div>
              {noNote(m)}
              <div className="text-sm text-gray-700 mt-1">
                Hekimin kendi hastası: {m.own_doctor_name ?? "Yok"}
              </div>
              <div className="text-sm text-gray-700">
                Doğum tarihi: {formatDay(m.birth_date)}
                {m.birth_date ? ` · ${ageText(m.birth_date, today)} yaş` : ""}
              </div>
              <div className="text-sm text-gray-700">Grup: {groupText(m)}</div>
              {lockedNote(m)}
            </div>
            <button type="button" className="text-blue-600 hover:underline min-h-[44px] shrink-0" onClick={() => onEdit(m)}>
              Düzenle
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-700 border-b">
              <th className="py-2 pr-3 font-semibold">Hasta</th>
              <th className="py-2 pr-3 font-semibold">Hekimin kendi hastası</th>
              <th className="py-2 pr-3 font-semibold">Doğum tarihi</th>
              <th className="py-2 pr-3 font-semibold text-right">Yaş</th>
              <th className="py-2 pr-3 font-semibold">Grup</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-b last:border-b-0 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{m.patient_name}</div>
                  {noNote(m)}
                  {lockedNote(m)}
                </td>
                <td className="py-2 pr-3">{m.own_doctor_name ?? "—"}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{formatDay(m.birth_date)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{ageText(m.birth_date, today)}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{groupText(m)}</td>
                <td className="py-2 text-right">
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(m)}>
                    Düzenle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length >= HK_MARKS_LIST_LIMIT && (
        <p className="text-xs text-gray-500 mt-3">
          İlk {HK_MARKS_LIST_LIMIT} hasta gösteriliyor; aradığınız hasta yoksa aramayı daraltın.
        </p>
      )}
    </Card>
  );
}

/**
 * Add / edit a mark (hk_save_mark): patient name, patient no (optional; empty = the name is the key, as in manually
 * entered payments; 0033: for a patient already imported from Macro, an empty no or the Macro file number puts the mark
 * on the key of the patient's Macro rows), own-portfolio doctor and birth date. A conflict on the patient offers the
 * existing mark.
 */
function MarkDialog({
  record,
  initialName,
  doctors,
  today,
  onClose,
  onSaved,
  onReload,
  onOpenExisting,
}: {
  record: HkMarkRowJson | null;
  initialName?: string;
  doctors: HkMarkDoctorJson[];
  today: string;
  onClose: () => void;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
  onOpenExisting: (m: HkMarkRowJson) => void;
}) {
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.patient_name ?? initialName ?? "");
  const [no, setNo] = useState(record ? patientNo(record) : "");
  const [ownDoctorId, setOwnDoctorId] = useState(record?.own_doctor_id ?? "");
  const [birth, setBirth] = useState(record?.birth_date ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [existing, setExisting] = useState<HkMarkRowJson | null>(null);
  const [busy, setBusy] = useState(false);

  const locked = !!record?.locked;
  // The current own doctor stays selectable even when the doctor's 'own' rule has ended, but only while the mark stays
  // on the same patient key (the server keeps it as is there); for another patient it is a new choice and needs the
  // rule. Once the key changes the option is shown only while still selected, and cannot be chosen again.
  const ruleless =
    record?.own_doctor_id && !doctors.some((d) => d.id === record.own_doctor_id) ? record.own_doctor_id : null;
  const sameKey = !!record && (no.trim() || normalizePatientRef(name)) === record.patient_ref;
  const rulelessChosen = !!ruleless && ownDoctorId === ruleless;
  const options: (HkMarkDoctorJson & { disabled?: boolean })[] =
    ruleless && (sameKey || rulelessChosen)
      ? [...doctors, { id: ruleless, name: `${record?.own_doctor_name ?? "Hekim"} (bu ay kuralı yok)`, disabled: !sameKey }]
      : doctors;
  const rulelessError =
    rulelessChosen && !sameKey
      ? "Bu hekim için bu ay “Hekimin kendi hastası” kuralı yok; hasta değişince seçilemez. Başka bir hekim veya “Yok” seçin."
      : null;
  const birthError = birth ? validateBirthDate(birth, today) : null;
  const age = birth && !birthError ? ageOn(birth, today) : null;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    setExisting(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) return setFormError("Hasta adı boş olamaz ve en fazla 200 karakter olabilir.");
    if (no.trim().length > 200) return setFormError("Hasta no en fazla 200 karakter olabilir.");
    if (rulelessError) return setFormError(rulelessError);
    const bError = validateBirthDate(birth, today);
    if (bError) return setFormError(bError);
    setBusy(true);
    try {
      const res = await hkSaveMark({
        p_id: id,
        p_version: record?.version ?? 0,
        p_patient_ref: no.trim() || null,
        p_patient_name: trimmed,
        p_own_doctor_id: ownDoctorId || null,
        p_birth_date: birth || null,
      });
      await onSaved(res.already_saved);
    } catch (err) {
      const fe = toFinanceError(err);
      setError(fe);
      setBusy(false);
      // One mark per patient: find the other one (DETAIL is its id) so it can be opened instead.
      if (fe.isConflict && fe.details && UUID_RE.test(fe.details)) {
        try {
          const found = (await hkMarksList(no.trim() || trimmed)).find((m) => m.id === fe.details);
          if (found) setExisting(found);
        } catch {
          // The message above already explains the conflict.
        }
      }
    }
  };

  return (
    <Modal title={record ? "Hasta işaretini düzenle" : "Hasta işareti ekle"} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Hasta adı" hint="Tahsilat kayıtlarındaki adla aynı yazılmalı (büyük / küçük harf ve boşluk fark etmez).">
          <input className={inputClass} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!record} />
        </Field>
        <Field
          label="Hasta no (isteğe bağlı)"
          hint="Boş bırakılırsa hasta adı kullanılır; Macro'dan gelen hasta adıyla ya da Macro dosya numarasıyla (D. NO) bulunur ve işaret Macro satırlarına da uygulanır. Tahsilat kayıtları hasta numarasıyla geliyorsa o numarayı girin."
        >
          <input className={inputClass} maxLength={200} value={no} onChange={(e) => setNo(e.target.value)} />
        </Field>
        <Field
          label="Hekimin kendi hastası"
          hint={
            rulelessError ??
            (doctors.length === 0
              ? "Bu ay “Hekimin kendi hastası” kuralı olan hekim yok."
              : "Seçilen hekimin bu hastadan aldığı ödemeler “Hekimin kendi hastası” grubunda sayılır.")
          }
        >
          <select className={inputClass} value={ownDoctorId} onChange={(e) => setOwnDoctorId(e.target.value)}>
            <option value="">Yok</option>
            {options.map((d) => (
              <option key={d.id} value={d.id} disabled={d.disabled}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Doğum tarihi"
          hint={
            locked
              ? "Bu hastanın kapanmış ayda ödemesi var; doğum tarihini klinik sahibi değiştirebilir."
              : birthError ?? (age !== null ? `Bugün ${Math.max(age, 0)} yaşında.` : "Bilinmiyorsa boş bırakın.")
          }
        >
          <input
            className={inputClass}
            type="date"
            min={HK_MIN_BIRTH_DATE}
            max={today}
            value={birth}
            onChange={(e) => setBirth(e.target.value)}
            disabled={locked}
          />
        </Field>
        {locked && (
          <p className="p-3 rounded bg-amber-50 text-amber-800 text-sm">
            Bu hastanın kapanmış ayda ödemesi var. Hekim değişikliği kapanmış ayın hesabını etkiliyorsa kaydedilmez;
            değişikliği klinik sahibi yapabilir.
          </p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={existing ? undefined : onReload} />
        {existing && (
          <button type="button" className={buttonSecondary} onClick={() => onOpenExisting(existing)}>
            Mevcut işareti aç
          </button>
        )}
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
