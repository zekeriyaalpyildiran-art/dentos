"use client";

// Satırlar ve hastalar of the Hakediş pages (finance and prep modes, HakedisParts): the month's revenue lines, implants
// and procedure pieces, lab costs (0032: with the rule and patient group each live cost resolves to) and the patient
// marks. Data entry needs can_prepare ('finance' or 'hakedis_prepare', 0031) and an open month; the server enforces
// the same. 0033: lines imported from Macro carry the Macro doctor, operation, tooth and file number, method
// 'Ödenmemiş', and no doctor for the clinic / an outside doctor (clinic ciro only); they are voided, never edited (the
// next import of their range replaces them). Imported pieces of the clinic get their performing doctor or "Hakediş
// yok" here (fin_hk_assign_piece). 0034 (v2.1): ANY imported piece can get another performing doctor, "Hakediş yok" or
// its Macro default back (kept across re-imports; only the piece fee moves, the revenue lines stay with the Macro
// doctor); outside doctors' pieces arrive as "Hakediş yok". (v2.2): lines and lab costs show where their patient group
// comes from (the doctor's unmarked default included) and the patient marks carry an explicit child / adult choice.
// ?tab=pieces | lab | marks opens that sub-tab (e.g. the Lab özeti's link to the lab costs); default: the lines.

import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  DialogButtons,
  HakedisTabs,
  HkVoidDialog,
  MonthPicker,
  MonthStatusBadge,
  hkMonthLock,
  useHkMarks,
  useHkMonth,
  useHkMonthData,
  useHkReference,
  type HkMode,
} from "./HakedisParts";
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
} from "./ui";
import {
  UUID_RE,
  centsToInput,
  formatDay,
  formatTL,
  isDay,
  newId,
  parseTL,
  searchKey,
  toFinanceError,
  type FinanceError,
} from "@/lib/finance";
import {
  EXT_DOCTOR_MODE_LABELS,
  HK_METHODS,
  HK_MIN_BIRTH_DATE,
  HK_SEGMENTS,
  IMPORTED_PIECE_VOID_TEXT,
  KIND_LABELS,
  LAB_DEDUCTION_TEXT,
  MARK_GROUP_HINT,
  MARK_GROUP_LABELS,
  MARK_GROUP_UNSET_LABEL,
  METHOD_LABELS,
  PIECE_OVERRIDE_HINT,
  SEGMENT_LABELS,
  SEGMENT_SOURCE_LABELS,
  SOURCE_LABELS,
  UNMARKED_DEFAULT_LABEL,
  ageOn,
  childAgeLimitOf,
  extDoctorOf,
  finHkAssignPiece,
  finHkSaveLabCost,
  finHkSaveLine,
  finHkSaveMark,
  finHkSavePiece,
  finHkVoidLabCost,
  finHkVoidLine,
  finHkVoidPiece,
  hkCanPrepare,
  markFor,
  markGroupOf,
  markGroupText,
  markIsChildOn,
  normalizePatientRef,
  pieceDefaultModeOf,
  pieceMacroText,
  piecePerformerText,
  pieceResetLabel,
  ruleActiveIn,
  segmentSourceOf,
  unmarkedDefaultDoctorIds,
  validateBirthDate,
  type HkCurrency,
  type HkLabCostJson,
  type HkLineJson,
  type HkMarkGroup,
  type HkMarkJson,
  type HkMethod,
  type HkMonthPayload,
  type HkPieceJson,
  type HkReferenceJson,
  type HkSegment,
  type HkSegmentSource,
} from "@/lib/hakedis";
import { CURRENCIES, CURRENCY_LABELS, formatMoney } from "@/lib/payments";

type Tab = "lines" | "pieces" | "lab" | "marks";

type Dialog =
  | { kind: "line"; record: HkLineJson | null }
  | { kind: "piece" }
  | { kind: "assign"; records: HkPieceJson[] }
  | { kind: "lab" }
  | { kind: "mark"; record: HkMarkJson | null; patient?: KnownPatient }
  | { kind: "void-line"; record: HkLineJson }
  | { kind: "void-piece"; record: HkPieceJson }
  | { kind: "void-lab"; record: HkLabCostJson };

interface KnownPatient {
  ref: string;
  name: string;
  /** the key comes from a mark only (no line, piece or lab cost of the month uses it) */
  fromMark?: boolean;
}

/**
 * Patients seen in the month's records and in the marks, by normalized name (the manual patient key). The month's
 * lines, pieces and lab costs come first and the marks last: a key that already holds payments, implant pieces or lab
 * costs wins over a key only a mark uses (a reception "Hasta no" must not split the patient's records over two keys).
 */
function knownPatients(data: HkMonthPayload | null, marks: HkMarkJson[] | null): Map<string, KnownPatient> {
  const map = new Map<string, KnownPatient>();
  const add = (ref: string, name: string, fromMark = false) => {
    const key = normalizePatientRef(name);
    if (key && !map.has(key)) map.set(key, fromMark ? { ref, name, fromMark } : { ref, name });
  };
  for (const l of data?.lines ?? []) add(l.patient_ref, l.patient_name);
  for (const p of data?.pieces ?? []) add(p.patient_ref, p.patient_name);
  for (const c of data?.lab_costs ?? []) add(c.patient_ref, c.patient_name);
  for (const m of marks ?? []) add(m.patient_ref, m.patient_name, true);
  return map;
}

/**
 * patient_ref for a save: the record's own key while the name is unchanged, else the key of a known patient with that
 * name, else null (the database uses the normalized name).
 */
function patientRefFor(
  name: string,
  known: Map<string, KnownPatient>,
  original?: { patient_name: string; patient_ref: string } | null
): string | null {
  const key = normalizePatientRef(name);
  if (original && normalizePatientRef(original.patient_name) === key) return original.patient_ref;
  return known.get(key)?.ref ?? null;
}

/** The patient no of a record whose key is not its normalized name (e.g. a "Hasta no" entered at the reception), else "". */
function customPatientNo(o: { patient_name: string; patient_ref: string } | null | undefined): string {
  return o && o.patient_ref !== normalizePatientRef(o.patient_name) ? o.patient_ref : "";
}

/**
 * Hint under a patient field when the record will be saved under a patient no rather than the name, so finance sees
 * the key (it decides which mark applies and which payments a lab cost is recovered from).
 */
function patientNoHint(ref: string | null, name: string, known: Map<string, KnownPatient>): string | null {
  const key = normalizePatientRef(name);
  if (!ref || ref === key) return null;
  const k = known.get(key);
  return `Hasta no: ${ref}${k?.fromMark && k.ref === ref ? " (hasta işaretinden)" : ""}`;
}

/** Several hints of one field, one per line. */
function hintLines(...items: (string | null | undefined)[]): ReactNode {
  const list = items.filter((t): t is string => !!t);
  return list.length === 0
    ? undefined
    : list.map((t) => (
        <span key={t} className="block">
          {t}
        </span>
      ));
}

/** Day range a new record of `month` may take: the month, never after today. */
function dayBounds(month: string, today: string): { min: string; max: string } {
  const [y, m] = month.split("-").map(Number);
  const last = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  return { min: `${month}-01`, max: last < today ? last : today };
}

function checkDay(day: string, bounds: { min: string; max: string }): string | null {
  if (!isDay(day)) return "Tarih seçin.";
  if (day < bounds.min || day > bounds.max) return "Tarih seçili ay içinde olmalı ve bugünden sonra olamaz.";
  return null;
}

function checkPatient(name: string): string | null {
  const t = name.trim();
  if (!t || t.length > 200) return "Hasta adı boş olamaz ve en fazla 200 karakter olabilir.";
  return null;
}

/**
 * The month's revenue lines (add / edit / void), implants placed (add / void), lab costs per lab invoice
 * (add / void) and the patient marks (own-portfolio doctor, birth date, child patient, note; add / edit, any month).
 * A closed month shows its records without write buttons; so does a caller without can_prepare (finance_readonly).
 */
export function HakedisLinesView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [month, setMonth] = useHkMonth(ref.data);
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get("tab");
    return t === "pieces" || t === "lab" || t === "marks" ? t : "lines";
  });
  const { data: current, error, loading, reload: loadMonth } = useHkMonthData(month);
  // Separate from the month's error: a successful month load must not hide a failed marks load.
  const { marks, error: marksError, reload: loadMarks } = useHkMarks();
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const known = useMemo(() => knownPatients(current, marks), [current, marks]);
  const marksByRef = useMemo(() => new Map((marks ?? []).map((m) => [m.patient_ref, m])), [marks]);

  if (!ref.data || !month) {
    return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  }
  const refData = ref.data;
  const canWrite = hkCanPrepare(refData);
  const bounds = dayBounds(month, refData.today);
  const lock = hkMonthLock(refData, current?.status, month);
  const editable = canWrite && current?.status === "open" && !lock && bounds.min <= bounds.max;

  const done = async (text: string, alsoMarks = false) => {
    setDialog(null);
    setMessage(text);
    await Promise.all([loadMonth(), alsoMarks ? loadMarks() : Promise.resolve()]);
  };
  const reloadAll = async () => {
    setDialog(null);
    await Promise.all([ref.reload(), loadMonth(), loadMarks()]);
  };

  const live = <T extends { voided_at: string | null }>(rows: T[]) => rows.filter((r) => !r.voided_at).length;
  const tabs: { key: Tab; label: string }[] = [
    { key: "lines", label: `Tahsilatlar${current ? ` (${live(current.lines)})` : ""}` },
    { key: "pieces", label: `İmplant ve işlemler${current ? ` (${live(current.pieces)})` : ""}` },
    { key: "lab", label: `Lab giderleri${current ? ` (${live(current.lab_costs)})` : ""}` },
    { key: "marks", label: `Hasta işaretleri${marks ? ` (${marks.length})` : ""}` },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HakedisTabs mode={mode} month={month} />
        <MonthPicker
          month={month}
          max={refData.current_month}
          onChange={(m) => {
            setMessage(null);
            setMonth(m);
          }}
        />
      </div>

      <div className="flex flex-wrap gap-2 border-b pb-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded text-sm ${tab === t.key ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <SuccessBox text={message} />
      <ErrorBox error={error} onReload={reloadAll} />

      {tab !== "marks" && current && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <MonthStatusBadge status={current.status} />
          {lock ? <span>{lock}</span> : !canWrite ? <span>Salt okunur.</span> : null}
        </div>
      )}

      {tab === "marks" ? (
        marks ? (
          <MarksTab
            marks={marks}
            today={refData.today}
            childAgeLimit={childAgeLimitOf(refData.settings)}
            canWrite={canWrite}
            onAdd={() => setDialog({ kind: "mark", record: null })}
            onEdit={(m) => setDialog({ kind: "mark", record: m })}
          />
        ) : marksError ? (
          <div className="space-y-2">
            <ErrorBox error={marksError} />
            <button type="button" className={buttonSecondary} onClick={loadMarks}>
              Tekrar dene
            </button>
          </div>
        ) : (
          <Loading />
        )
      ) : !current ? (
        loading ? <Loading /> : null
      ) : tab === "lines" ? (
        <LinesTab
          data={current}
          refData={refData}
          editable={editable}
          canMark={canWrite && marks !== null}
          marksByRef={marksByRef}
          onAdd={() => setDialog({ kind: "line", record: null })}
          onEdit={(l) => setDialog({ kind: "line", record: l })}
          onVoid={(l) => setDialog({ kind: "void-line", record: l })}
          onMark={(l) => {
            // 0033: a Macro line shows / edits the mark it resolves to (its own key, the bare file number or the
            // patient's name); only without one is a new mark keyed by the line's key.
            const existing = markFor(marksByRef, l);
            setDialog({ kind: "mark", record: existing ?? null, patient: { ref: l.patient_ref, name: l.patient_name } });
          }}
        />
      ) : tab === "pieces" ? (
        <PiecesTab
          data={current}
          month={month}
          refData={refData}
          editable={editable}
          onAdd={() => setDialog({ kind: "piece" })}
          onVoid={(p) => setDialog({ kind: "void-piece", record: p })}
          onAssign={(records) => setDialog({ kind: "assign", records })}
        />
      ) : (
        <LabTab
          data={current}
          month={month}
          refData={refData}
          editable={editable}
          onAdd={() => setDialog({ kind: "lab" })}
          onVoid={(c) => setDialog({ kind: "void-lab", record: c })}
        />
      )}

      <datalist id="hk-patients">
        {Array.from(known.entries()).map(([key, p]) => (
          <option key={key} value={p.name} />
        ))}
      </datalist>

      {dialog?.kind === "line" && (
        <LineDialog
          refData={refData}
          record={dialog.record}
          bounds={bounds}
          known={known}
          marksByRef={marksByRef}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
          onSaved={(already) => done(already ? "Değişiklik yok; satır aynı kaldı." : "Tahsilat satırı kaydedildi.")}
        />
      )}
      {dialog?.kind === "piece" && (
        <PieceDialog
          refData={refData}
          bounds={bounds}
          known={known}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
          onSaved={(already) => done(already ? "Kayıt zaten vardı." : "İmplant kaydı eklendi.")}
        />
      )}
      {dialog?.kind === "assign" && (
        <AssignPieceDialog
          refData={refData}
          records={dialog.records}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
          onDone={(text) => done(text)}
        />
      )}
      {dialog?.kind === "lab" && (
        <LabCostDialog
          refData={refData}
          month={month}
          bounds={bounds}
          known={known}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
          onSaved={(already) => done(already ? "Kayıt zaten vardı." : "Lab gideri eklendi.")}
        />
      )}
      {dialog?.kind === "mark" && (
        <MarkDialog
          key={dialog.record?.id ?? `new:${dialog.patient?.ref ?? ""}`}
          refData={refData}
          record={dialog.record}
          patient={dialog.patient}
          known={known}
          marks={marks ?? []}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
          onOpenExisting={(m) => setDialog({ kind: "mark", record: m })}
          onSaved={(already) => done(already ? "Değişiklik yok; işaret aynı kaldı." : "Hasta işareti kaydedildi.", true)}
        />
      )}
      {dialog?.kind === "void-line" && (
        <HkVoidDialog
          title="Tahsilat satırını iptal et"
          body={`${formatDay(dialog.record.day)} · ${dialog.record.patient_name} · ${formatTL(dialog.record.try_cents)}. Satır silinmez, iptal edilmiş olarak kalır ve hesaba girmez.${dialog.record.source === "import" ? " Aralık Macro'dan yeniden yüklenirse yeni satırlar yazılır." : ""}`}
          onVoid={(reason) => finHkVoidLine({ p_id: dialog.record.id, p_version: dialog.record.version, p_reason: reason })}
          onDone={(text) => done(text)}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
        />
      )}
      {dialog?.kind === "void-piece" && (
        <HkVoidDialog
          title={dialog.record.proc_group_id ? "İşlem kaydını iptal et" : "İmplant kaydını iptal et"}
          body={`${formatDay(dialog.record.day)} · ${dialog.record.patient_name} · ${dialog.record.proc_group_name ? `${dialog.record.proc_group_name} · ` : ""}${dialog.record.qty} adet. Kayıt silinmez, iptal edilmiş olarak kalır.`}
          extra={
            dialog.record.source === "import" ? (
              // 0034 (v2.1): a re-import brings a voided imported piece back; choosing the doctor is the lasting fix.
              <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-2">
                <p>{IMPORTED_PIECE_VOID_TEXT}</p>
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => setDialog({ kind: "assign", records: [dialog.record] })}
                >
                  Hekimi değiştir
                </button>
              </div>
            ) : undefined
          }
          onVoid={(reason) => finHkVoidPiece({ p_id: dialog.record.id, p_version: dialog.record.version, p_reason: reason })}
          onDone={(text) => done(text)}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
        />
      )}
      {dialog?.kind === "void-lab" && (
        <HkVoidDialog
          title="Lab giderini iptal et"
          body={`${formatDay(dialog.record.day)} · ${dialog.record.patient_name} · ${dialog.record.lab_name} · ${formatTL(dialog.record.amount_cents)}. Kayıt silinmez, iptal edilmiş olarak kalır.`}
          onVoid={(reason) => finHkVoidLabCost({ p_id: dialog.record.id, p_version: dialog.record.version, p_reason: reason })}
          onDone={(text) => done(text)}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
        />
      )}
    </div>
  );
}

function VoidedNote({ row }: { row: { voided_at: string | null; voided_by_name: string | null; void_reason: string | null } }) {
  if (!row.voided_at) return null;
  return (
    <div className="text-xs text-red-600">
      İptal edildi{row.voided_by_name ? ` (${row.voided_by_name})` : ""}: {row.void_reason}
    </div>
  );
}

/** Filter value of the lines without a doctor (0033: Macro doctors mapped to the clinic or an outside doctor). */
const NO_DOCTOR = "__none__";

/** "Klinik" / "Dışarıdan hekim (hakediş yok)" of a doctor-less imported row's Macro doctor, from the mapping. */
function extModeText(refData: HkReferenceJson, extDoctor: string | null | undefined): string {
  const m = extDoctor ? extDoctorOf(refData.ext_doctors ?? [], extDoctor) : undefined;
  return m ? EXT_DOCTOR_MODE_LABELS[m.mode] : "Hekimsiz";
}

/**
 * The note under a resolved patient group (0034 segment_source); before 0034 the given fallback. The doctor's unmarked
 * default is highlighted: an adult patient still needs an adult mark.
 */
function SegmentSourceNote({ source, fallback }: { source: HkSegmentSource | null | undefined; fallback?: string }) {
  const text = source ? SEGMENT_SOURCE_LABELS[source] : fallback ?? "";
  if (!text) return null;
  return <div className={`text-xs ${source === "unmarked_default" ? "text-amber-700" : "text-gray-500"}`}>{text}</div>;
}

/** The Macro details of an imported line / piece: operation, tooth, file number. */
function MacroDetails({
  row,
}: {
  row: { procedure?: string | null; tooth?: string | null; macro_patient_no?: string | null };
}) {
  const parts = [
    row.procedure || null,
    row.tooth ? `diş ${row.tooth}` : null,
    row.macro_patient_no ? `dosya no ${row.macro_patient_no}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className="text-xs text-gray-500">{parts.join(" · ")}</div>;
}

function LinesTab({
  data,
  refData,
  editable,
  canMark,
  marksByRef,
  onAdd,
  onEdit,
  onVoid,
  onMark,
}: {
  data: HkMonthPayload;
  refData: HkReferenceJson;
  editable: boolean;
  canMark: boolean;
  marksByRef: Map<string, HkMarkJson>;
  onAdd: () => void;
  onEdit: (l: HkLineJson) => void;
  onVoid: (l: HkLineJson) => void;
  onMark: (l: HkLineJson) => void;
}) {
  const [doctorId, setDoctorId] = useState("");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [showVoided, setShowVoided] = useState(false);
  const payeeOfRule = useMemo(() => new Map(refData.rules.map((r) => [r.id, r.payee_name])), [refData.rules]);
  const doctors = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of data.lines) {
      if (l.doctor_id) map.set(l.doctor_id, l.doctor_name ?? "");
      else map.set(NO_DOCTOR, "Hekimsiz (klinik / dışarıdan hekim)");
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], "tr"));
  }, [data.lines]);
  const hasImport = data.lines.some((l) => l.source === "import");

  const q = searchKey(query);
  const rows = data.lines.filter(
    (l) =>
      (showVoided || !l.voided_at) &&
      (!doctorId || (doctorId === NO_DOCTOR ? !l.doctor_id : l.doctor_id === doctorId)) &&
      (!source || (source === "import" ? l.source === "import" : l.source !== "import")) &&
      (!q ||
        searchKey(l.patient_name).includes(q) ||
        searchKey(l.description).includes(q) ||
        searchKey(l.procedure).includes(q) ||
        searchKey(l.ext_doctor).includes(q) ||
        searchKey(l.macro_patient_no).includes(q))
  );
  const liveRows = rows.filter((l) => !l.voided_at);
  const sum = (pick: (l: HkLineJson) => number) => liveRows.reduce((s, l) => s + pick(l), 0);
  // 0034: lines counted as a child's only through the doctor's unmarked default (adult patients need a mark).
  const unmarkedChild = data.lines.filter((l) => !l.voided_at && l.segment_source === "unmarked_default").length;

  return (
    <div className="space-y-3">
      <div className="bg-white p-4 rounded-lg shadow flex flex-wrap items-end gap-4 text-gray-900">
        <Field label="Hekim" className="min-w-[12rem]">
          <select className={inputClass} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="">Tümü</option>
            {doctors.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        {hasImport && (
          <Field label="Kaynak" className="min-w-[10rem]">
            <select className={inputClass} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Tümü</option>
              <option value="import">Macro&apos;dan</option>
              <option value="other">Elle / diğer</option>
            </select>
          </Field>
        )}
        <Field label="Ara" className="flex-1 min-w-[12rem]">
          <input
            className={inputClass}
            placeholder="Hasta, işlem, açıklama veya dosya no"
            maxLength={100}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-800 pb-2">
          <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
          İptal edilenleri göster
        </label>
        {editable && (
          <button type="button" className={buttonPrimary} onClick={onAdd}>
            Tahsilat satırı ekle
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto text-gray-900">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b">
            <tr className="text-left text-gray-800">
              <th className="px-3 py-3 font-semibold">Tarih</th>
              <th className="px-3 py-3 font-semibold">Hekim</th>
              <th className="px-3 py-3 font-semibold">Hasta</th>
              <th className="px-3 py-3 font-semibold">Ödeme</th>
              <th className="px-3 py-3 font-semibold text-right">Tutar (TL)</th>
              <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">İmplant payı</th>
              <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Lab payı</th>
              <th className="px-3 py-3 font-semibold whitespace-nowrap">Hasta grubu</th>
              <th className="px-3 py-3 font-semibold">Kural</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                  Bu ay için tahsilat satırı yok.
                </td>
              </tr>
            ) : (
              rows.map((l) => {
                const voided = !!l.voided_at;
                const imported = l.source === "import";
                const mark = markFor(marksByRef, l);
                return (
                  <tr key={l.id} className={`border-b align-top ${voided ? "text-gray-400" : ""}`}>
                    <td className={`px-3 py-2 whitespace-nowrap ${voided ? "line-through" : ""}`}>
                      {formatDay(l.day)}
                      {l.basis === "payment" && l.treatment_day && (
                        <div className="text-xs text-gray-500">işlem {formatDay(l.treatment_day)}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {l.doctor_id ? (
                        l.doctor_name
                      ) : (
                        <span className="text-gray-600">{extModeText(refData, l.ext_doctor)}</span>
                      )}
                      {l.ext_doctor && <div className="text-xs text-gray-500">Macro: {l.ext_doctor}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className={voided ? "line-through" : "font-medium"}>{l.patient_name}</div>
                      <MacroDetails row={l} />
                      {l.description && <div className="text-xs text-gray-500">{l.description}</div>}
                      {l.source !== "manual" && (
                        <div className="text-xs text-gray-500">
                          {SOURCE_LABELS[l.source] ?? l.source}
                          {l.basis === "payment" ? " · ödeme raporu" : l.basis === "production" ? " · işlem raporu" : ""}
                        </div>
                      )}
                      <VoidedNote row={l} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {METHOD_LABELS[l.method] ?? l.method}
                      {l.method === "unpaid" && <div className="text-xs text-gray-500">ay sonunda</div>}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${voided ? "line-through" : ""} ${l.try_cents < 0 ? "text-red-600" : ""}`}>
                      {formatTL(l.try_cents)}
                      {l.currency !== "TRY" && <div className="text-xs text-gray-500">{formatMoney(l.amount_cents, l.currency)}</div>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{l.implant_cents ? formatTL(l.implant_cents) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{l.lab_part ? formatTL(l.lab_part) : "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {voided || !l.doctor_id ? (
                        "—"
                      ) : (
                        <>
                          {l.resolved_segment ? SEGMENT_LABELS[l.resolved_segment] : "—"}
                          <SegmentSourceNote
                            source={l.segment_source}
                            fallback={l.segment ? "elle seçildi" : mark ? "hasta işaretinden" : ""}
                          />
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {voided ? (
                        "—"
                      ) : !l.doctor_id ? (
                        <span className="text-gray-600 whitespace-nowrap">Yalnız klinik cirosu</span>
                      ) : l.rule_kind && l.rule_id ? (
                        <>
                          <div className="whitespace-nowrap">{KIND_LABELS[l.rule_kind]}</div>
                          <div className="text-xs text-gray-500">{payeeOfRule.get(l.rule_id) ?? ""}</div>
                        </>
                      ) : (
                        <span className="text-amber-700 whitespace-nowrap">Kural yok</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap space-x-3">
                      {editable && !voided && (
                        <>
                          {!imported && (
                            <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(l)}>
                              Düzenle
                            </button>
                          )}
                          <button type="button" className="text-red-600 hover:underline" onClick={() => onVoid(l)}>
                            İptal et
                          </button>
                        </>
                      )}
                      {canMark && !voided && l.doctor_id && (
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => onMark(l)}>
                          {mark ? "İşareti düzenle" : "İşaretle"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {liveRows.length > 0 && (
            <tfoot className="bg-gray-50 border-t font-semibold">
              <tr>
                <td className="px-3 py-2" colSpan={4}>
                  {liveRows.length} satır
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(sum((l) => l.try_cents))}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(sum((l) => l.implant_cents))}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatTL(sum((l) => l.lab_part ?? 0))}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-xs text-gray-500">
        Tutar, tahsilatın TL karşılığıdır; eksi tutar düzeltme satırıdır. İmplant payı hekimin cirosuna girmez (implant
        adet başı ödenir). Hasta grubu, satırda elle seçilmediyse hasta işaretinden gelir.
        {unmarkedChild > 0 &&
          ` Çocuk kuralında “${UNMARKED_DEFAULT_LABEL}” seçili hekimin işaretsiz hastası çocuk sayılır (“${SEGMENT_SOURCE_LABELS.unmarked_default}”; bu ay ${unmarkedChild} satır); hasta yetişkinse “İşaretle” ile “${MARK_GROUP_LABELS.adult}” seçin.`}
        {hasImport &&
          ` Macro'dan aktarılan satırlar işlem gününe göredir (ortodontide ödeme gününe göre); “${METHOD_LABELS.unpaid}” işlemin ay sonuna kadar ödenmemiş kısmıdır. Bu satırlar düzenlenmez: yanlışsa Macro'da düzeltip aralığı yeniden yükleyin ya da satırı iptal edin. Hekimsiz satırlar (klinik / dışarıdan hekim) yalnız klinik cirosuna girer. Macro satırlarının hasta anahtarı dosya numarasıdır (macro:…); hastanın Macro'dan önce adla ya da dosya numarasıyla girilmiş işareti ve lab giderleri bu satırlara da uygulanır, yüklemeden sonra adla girilen işaret dosya numarasına kaydedilir.`}
      </p>
    </div>
  );
}

/** Rule hint of a live piece with a doctor: implant-type pieces need a rule; others are paid only with a fee rule. */
function pieceRuleHint(
  p: HkPieceJson,
  implantDoctors: Set<string | null>,
  procedureKeys: Set<string>
): { text: string; warn: boolean } | null {
  if (!p.doctor_id) return null;
  const implantType = !p.proc_group_id || p.proc_group_is_implant !== false;
  const byGroup = !!p.proc_group_id && procedureKeys.has(`${p.doctor_id}|${p.proc_group_id}`);
  if (implantType) {
    return implantDoctors.has(p.doctor_id) || byGroup ? null : { text: "İmplant kuralı yok", warn: true };
  }
  return byGroup ? null : { text: "İşlem başı ücret kuralı yok", warn: false };
}

function PiecesTab({
  data,
  month,
  refData,
  editable,
  onAdd,
  onVoid,
  onAssign,
}: {
  data: HkMonthPayload;
  month: string;
  refData: HkReferenceJson;
  editable: boolean;
  onAdd: () => void;
  onVoid: (p: HkPieceJson) => void;
  onAssign: (records: HkPieceJson[]) => void;
}) {
  const [showVoided, setShowVoided] = useState(false);
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [onlyAssigned, setOnlyAssigned] = useState(false);
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const unassignedOf = (p: HkPieceJson) => !p.voided_at && !p.doctor_id && !p.assigned_none;
  // 0034 (v2.1): every live imported piece gets its performing doctor here (fin_hk_assign_piece), whatever its Macro
  // doctor's mode; manual / clinical pieces are voided and entered again instead.
  const assignable = (p: HkPieceJson) => !p.voided_at && p.source === "import";
  const hasImport = data.pieces.some((p) => p.source === "import");
  const groupOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of data.pieces) map.set(p.proc_group_id ?? "", p.proc_group_name ?? "İmplant (elle girilen)");
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], "tr"));
  }, [data.pieces]);
  const rows = data.pieces.filter(
    (p) =>
      (showVoided || !p.voided_at) &&
      (!onlyUnassigned || unassignedOf(p)) &&
      (!onlyAssigned || (!p.voided_at && !!p.assigned)) &&
      (!group || (p.proc_group_id ?? "") === (group === NO_DOCTOR ? "" : group))
  );
  const activeRules = refData.rules.filter((r) => ruleActiveIn(r, month));
  const implantDoctors = new Set(activeRules.filter((r) => r.kind === "implant_piece").map((r) => r.doctor_id));
  const procedureKeys = new Set(
    activeRules.filter((r) => r.kind === "procedure_piece").map((r) => `${r.doctor_id}|${r.proc_group_id ?? ""}`)
  );
  const live = rows.filter((p) => !p.voided_at);
  const unassigned = data.pieces.filter(unassignedOf);
  const overridden = data.pieces.filter((p) => !p.voided_at && !!p.assigned).length;
  const byGroup = new Map<string, number>();
  for (const p of live) {
    const name = p.proc_group_name ?? "İmplant";
    byGroup.set(name, (byGroup.get(name) ?? 0) + p.qty);
  }
  const chosen = data.pieces.filter((p) => selected.has(p.id) && assignable(p));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectable = (p: HkPieceJson) => editable && assignable(p);

  return (
    <Card
      title="İmplant ve işlemler"
      actions={
        <>
          {editable && chosen.length > 0 && (
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                setSelected(new Set());
                onAssign(chosen);
              }}
            >
              Seçilenlere hekim ata ({chosen.length})
            </button>
          )}
          {editable && (
            <button type="button" className={buttonPrimary} onClick={onAdd}>
              İmplant ekle
            </button>
          )}
        </>
      }
    >
      {unassigned.length > 0 && (
        <div className="mb-3 p-3 rounded bg-amber-50 text-amber-900 text-sm flex flex-wrap items-center gap-3">
          <span className="flex-1 min-w-[12rem]">
            Klinik adına Macro&apos;dan gelen {unassigned.reduce((s, p) => s + p.qty, 0)} işlem için işlemi yapan hekim
            seçilmedi; seçilene kadar kimsenin hakedişine girmez.
          </span>
          {editable && (
            <button type="button" className={buttonSecondary} onClick={() => setOnlyUnassigned(true)}>
              Atanmamışları göster
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4 mb-3">
        {groupOptions.length > 1 && (
          <Field label="İşlem grubu" className="min-w-[12rem]">
            <select className={inputClass} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">Tümü</option>
              {groupOptions.map(([id, name]) => (
                <option key={id || NO_DOCTOR} value={id || NO_DOCTOR}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-800 pb-2">
          <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} />
          Yalnız hekimi seçilmemişler
        </label>
        {hasImport && (
          <label className="flex items-center gap-2 text-sm text-gray-800 pb-2">
            <input type="checkbox" checked={onlyAssigned} onChange={(e) => setOnlyAssigned(e.target.checked)} />
            Yalnız elle seçilenler{overridden > 0 ? ` (${overridden})` : ""}
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-800 pb-2">
          <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
          İptal edilenleri göster
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-700 border-b">
              {editable && (
                <th className="py-2 pr-2">
                  <input
                    type="checkbox"
                    aria-label="Görünen Macro işlemlerini seç"
                    checked={rows.some(selectable) && rows.filter(selectable).every((p) => selected.has(p.id))}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.filter(selectable).map((p) => p.id)) : new Set())
                    }
                  />
                </th>
              )}
              <th className="py-2 pr-3 font-semibold">Tarih</th>
              <th className="py-2 pr-3 font-semibold">Hekim</th>
              <th className="py-2 pr-3 font-semibold">Hasta</th>
              <th className="py-2 pr-3 font-semibold">İşlem</th>
              <th className="py-2 pr-3 font-semibold text-right">Adet</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={editable ? 7 : 6} className="py-6 text-center text-gray-500">
                  Bu ay için implant ya da işlem kaydı yok.
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const voided = !!p.voided_at;
                const hint = voided ? null : pieceRuleHint(p, implantDoctors, procedureKeys);
                const macro = pieceMacroText(p);
                return (
                  <tr key={p.id} className={`border-b last:border-b-0 align-top ${voided ? "text-gray-400" : ""}`}>
                    {editable && (
                      <td className="py-2 pr-2">
                        {selectable(p) && (
                          <input
                            type="checkbox"
                            aria-label={`${p.patient_name} seç`}
                            checked={selected.has(p.id)}
                            onChange={() => toggle(p.id)}
                          />
                        )}
                      </td>
                    )}
                    <td className={`py-2 pr-3 whitespace-nowrap ${voided ? "line-through" : ""}`}>{formatDay(p.day)}</td>
                    <td className="py-2 pr-3">
                      <div className="whitespace-nowrap">
                        {p.doctor_id ? (
                          p.doctor_name
                        ) : p.assigned_none ? (
                          <span className="text-gray-600">{piecePerformerText(p)}</span>
                        ) : (
                          <span className="text-amber-700 font-medium">Hekim seçilmedi</span>
                        )}
                        {p.assigned && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                            elle seçildi
                          </span>
                        )}
                      </div>
                      {macro && (
                        <div className="text-xs text-gray-500">
                          {p.assigned ? `Macro: ${macro} → işlemi yapan: ${piecePerformerText(p)}` : `Macro: ${macro}`}
                        </div>
                      )}
                      {hint && <div className={`text-xs ${hint.warn ? "text-amber-700" : "text-gray-500"}`}>{hint.text}</div>}
                    </td>
                    <td className="py-2 pr-3">
                      <div className={voided ? "line-through" : ""}>{p.patient_name}</div>
                      {p.macro_patient_no && <div className="text-xs text-gray-500">dosya no {p.macro_patient_no}</div>}
                      {p.description && <div className="text-xs text-gray-500">{p.description}</div>}
                      <VoidedNote row={p} />
                    </td>
                    <td className="py-2 pr-3">
                      <div>
                        {p.proc_group_name ?? "İmplant"}
                        {p.proc_group_is_implant ? <span className="text-xs text-gray-500"> (implant)</span> : null}
                      </div>
                      {(p.procedure || p.tooth) && (
                        <div className="text-xs text-gray-500">
                          {[p.procedure, p.tooth ? `diş ${p.tooth}` : null].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${p.qty < 0 ? "text-red-600" : ""} ${voided ? "line-through" : ""}`}>{p.qty}</td>
                    <td className="py-2 text-right whitespace-nowrap space-x-3">
                      {editable && assignable(p) && (
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => onAssign([p])}>
                          {unassignedOf(p) ? "Ata" : "Hekimi değiştir"}
                        </button>
                      )}
                      {editable && !voided && (
                        <button type="button" className="text-red-600 hover:underline" onClick={() => onVoid(p)}>
                          İptal et
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Bu ay: {byGroup.size === 0 ? "kayıt yok" : Array.from(byGroup, ([name, qty]) => `${name} ${qty}`).join(", ")}.
        İmplantların tutarı takan hekimin “İmplant (adet başı)” kuralından, gruplu işlemlerin tutarı hekimin “İşlem başı
        ücret” kuralından hesaplanır; eksi adet düzeltmedir.
        {hasImport &&
          ` ${PIECE_OVERRIDE_HINT} Klinik adına gelen işlemde işlemi yapan hekimi “Ata” ile seçin; hakediş verilmeyecekse “Hakediş yok” seçin. Dışarıdan hekimlerin işlemleri “Hakediş yok” olarak gelir; işlemi bir DentOS hekimi yaptıysa “Hekimi değiştir” ile seçin.`}
      </p>
    </Card>
  );
}

type AssignChoice = "doctor" | "none" | "default";

/** What the "back to the Macro default" choice does, per default (0034). */
const RESET_HINTS: Record<ReturnType<typeof pieceDefaultModeOf>, string> = {
  doctor: "Elle seçim kaldırılır; işlem Macro'daki hekimin hakedişine girer.",
  clinic: "Elle seçim kaldırılır; işlem hekim seçilene kadar kimsenin hakedişine girmez.",
  outside: "Elle seçim kaldırılır; dışarıdan hekimin işlemi kimsenin hakedişine girmez.",
  manual: "",
};

/**
 * The performing doctor of imported pieces (fin_hk_assign_piece, one call per piece; 0034: any imported piece): a
 * DentOS doctor, "Hakediş yok", or back to the piece's Macro default (the mapped doctor, unassigned, or "Hakediş yok"
 * for an outside doctor's piece). Pieces whose save fails are listed; the others are saved.
 */
function AssignPieceDialog({
  refData,
  records,
  onClose,
  onDone,
  onReload,
}: {
  refData: HkReferenceJson;
  records: HkPieceJson[];
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
  onReload: () => void;
}) {
  const first = records[0];
  const same = records.every((p) => p.doctor_id === first?.doctor_id && !!p.assigned_none === !!first?.assigned_none);
  const [choice, setChoice] = useState<AssignChoice>(() => (same && first?.assigned_none ? "none" : "doctor"));
  const [doctorId, setDoctorId] = useState(() => (same ? first?.doctor_id ?? "" : ""));
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // One label when every piece goes back to the same default, else a general one.
  const resetLabels = Array.from(new Set(records.map((p) => pieceResetLabel(p))));
  const resetLabel = resetLabels.length === 1 && resetLabels[0] ? resetLabels[0] : "Macro'daki varsayılana dön";
  const mixedDefaults = resetLabels.length > 1;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    if (choice === "doctor" && !doctorId) return setFormError("Hekimi seçin.");
    setBusy(true);
    setProgress(0);
    let saved = 0;
    const failed: string[] = [];
    let lastError: FinanceError | null = null;
    for (const p of records) {
      try {
        const res = await finHkAssignPiece({
          p_id: p.id,
          p_version: p.version,
          p_doctor_id: choice === "doctor" ? doctorId : null,
          p_none: choice === "none",
        });
        if (!res.already_saved) saved += 1;
      } catch (err) {
        lastError = toFinanceError(err);
        failed.push(`${formatDay(p.day)} ${p.patient_name}`);
      }
      setProgress((n) => n + 1);
    }
    if (failed.length > 0) {
      setError(lastError);
      setFormError(`${failed.length} işlem kaydedilemedi: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}`);
      setBusy(false);
      return;
    }
    await onDone(saved === 0 ? "Değişiklik yok." : `${saved} işlem kaydedildi.`);
  };

  return (
    <Modal title={records.length > 1 ? `${records.length} işleme hekim ata` : "İşlemi yapan hekim"} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {records.length === 1 && first && (
          <div className="text-sm text-gray-700 space-y-0.5">
            <p>
              {formatDay(first.day)} · {first.patient_name} · {first.proc_group_name ?? "İmplant"}
              {first.procedure ? ` (${first.procedure}${first.tooth ? `, diş ${first.tooth}` : ""})` : ""}
            </p>
            {pieceMacroText(first) && <p className="text-xs text-gray-500">Macro: {pieceMacroText(first)}</p>}
            <p className="text-xs text-gray-500">
              Şu an: {piecePerformerText(first)}
              {first.assigned ? " (elle seçildi)" : ""}
            </p>
          </div>
        )}
        <p className="text-xs text-gray-500">{PIECE_OVERRIDE_HINT}</p>
        <fieldset className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="radio" name="assign" className="mt-1" checked={choice === "doctor"} onChange={() => setChoice("doctor")} />
            <span>İşlemi yapan hekim</span>
          </label>
          {choice === "doctor" && (
            <div className="pl-6">
              <DoctorSelect refData={refData} value={doctorId} onChange={setDoctorId} />
            </div>
          )}
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="radio" name="assign" className="mt-1" checked={choice === "none"} onChange={() => setChoice("none")} />
            <span>
              Hakediş yok
              <span className="block text-xs text-gray-500">İşlem kimsenin hakedişine girmez; uyarı da verilmez.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="radio" name="assign" className="mt-1" checked={choice === "default"} onChange={() => setChoice("default")} />
            <span>
              {resetLabel}
              <span className="block text-xs text-gray-500">
                {mixedDefaults
                  ? "Her işlem kendi Macro hekimine döner: DentOS hekimi adına gelen o hekime, klinik adına gelen hekim seçilmemiş hâline, dışarıdan hekim adına gelen “Hakediş yok”a."
                  : RESET_HINTS[first ? pieceDefaultModeOf(first) : "manual"]}
              </span>
            </span>
          </label>
        </fieldset>
        {busy && records.length > 1 && (
          <p className="text-sm text-gray-500">
            {progress} / {records.length}
          </p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

function LabTab({
  data,
  month,
  refData,
  editable,
  onAdd,
  onVoid,
}: {
  data: HkMonthPayload;
  month: string;
  refData: HkReferenceJson;
  editable: boolean;
  onAdd: () => void;
  onVoid: (c: HkLabCostJson) => void;
}) {
  const [showVoided, setShowVoided] = useState(false);
  const rows = data.lab_costs.filter((c) => showVoided || !c.voided_at);
  const rulesById = useMemo(() => new Map(refData.rules.map((r) => [r.id, r])), [refData.rules]);
  // Before 0032 the rows carry no resolution: the doctor's ortho rule was the only one that used lab costs.
  const resolved = data.lab_summary !== undefined || data.lab_costs.some((c) => c.rule_id !== undefined);
  const ortho = new Set(
    refData.rules.filter((r) => r.kind === "ortho_lab_first" && ruleActiveIn(r, month)).map((r) => r.doctor_id)
  );
  const total = rows.filter((c) => !c.voided_at).reduce((s, c) => s + c.amount_cents, 0);

  return (
    <Card
      title="Lab giderleri"
      actions={
        <>
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
            İptal edilenleri göster
          </label>
          {editable && (
            <button type="button" className={buttonPrimary} onClick={onAdd}>
              Lab gideri ekle
            </button>
          )}
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-700 border-b">
              <th className="py-2 pr-3 font-semibold">Tarih</th>
              <th className="py-2 pr-3 font-semibold">Hekim</th>
              <th className="py-2 pr-3 font-semibold">Hasta</th>
              <th className="py-2 pr-3 font-semibold">Laboratuvar</th>
              <th className="py-2 pr-3 font-semibold text-right">Tutar</th>
              <th className="py-2 pr-3 font-semibold">Kural</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">
                  Bu ay için lab gideri yok.
                </td>
              </tr>
            ) : (
              rows.map((c) => {
                const voided = !!c.voided_at;
                return (
                  <tr key={c.id} className={`border-b last:border-b-0 align-top ${voided ? "text-gray-400" : ""}`}>
                    <td className={`py-2 pr-3 whitespace-nowrap ${voided ? "line-through" : ""}`}>{formatDay(c.day)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{c.doctor_name}</td>
                    <td className="py-2 pr-3">
                      <div className={voided ? "line-through" : ""}>{c.patient_name}</div>
                      {c.description && <div className="text-xs text-gray-500">{c.description}</div>}
                      <VoidedNote row={c} />
                    </td>
                    <td className="py-2 pr-3">{c.lab_name}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${c.amount_cents < 0 ? "text-red-600" : ""} ${voided ? "line-through" : ""}`}>
                      {formatTL(c.amount_cents)}
                    </td>
                    <td className="py-2 pr-3">
                      {voided ? (
                        "—"
                      ) : resolved ? (
                        <LabCostRule cost={c} rule={c.rule_id ? rulesById.get(c.rule_id) : undefined} />
                      ) : ortho.has(c.doctor_id) ? (
                        <div className="whitespace-nowrap">{KIND_LABELS.ortho_lab_first}</div>
                      ) : (
                        <span className="text-xs text-gray-500">Bilgi amaçlı</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {editable && !voided && (
                        <button type="button" className="text-red-600 hover:underline" onClick={() => onVoid(c)}>
                          İptal et
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Bu ay toplam {formatTL(total)}. Her laboratuvar faturası / ücreti hasta başına ayrı satır girilir. Kural
        sütunu giderin hangi kuralda düşüldüğünü gösterir. {LAB_DEDUCTION_TEXT} Ortodontide gider bu ay ve sonraki
        aylardaki ödemelerden karşılanır; geçmiş aylara geri dönmez.
      </p>
    </Card>
  );
}

/**
 * The rule a live lab cost resolves to (0032, fin__hk_eval_lab_costs): the kind, the patient group of a ciro_share rule
 * and the payee; "Kural yok" when no ortho / ciro_share rule takes it (UNRULED_LAB).
 */
function LabCostRule({ cost, rule }: { cost: HkLabCostJson; rule: HkReferenceJson["rules"][number] | undefined }) {
  if (!cost.rule_id) {
    return (
      <>
        <div className="text-amber-700 whitespace-nowrap">Kural yok</div>
        <div className="text-xs text-gray-500">Hakedişten düşülmez</div>
      </>
    );
  }
  const segment = rule?.kind === "ciro_share" ? rule.segment ?? cost.resolved_segment : null;
  return (
    <>
      <div className="whitespace-nowrap">
        {rule ? KIND_LABELS[rule.kind] : "Kural"}
        {segment ? ` · ${SEGMENT_LABELS[segment]}` : ""}
      </div>
      <div className="text-xs text-gray-500">
        {rule?.payee_name ?? ""}
        {cost.resolved_segment && segment && cost.resolved_segment !== segment
          ? ` (hasta grubu ${SEGMENT_LABELS[cost.resolved_segment].toLocaleLowerCase("tr")}, kuralı olmadığı için standart)`
          : ""}
      </div>
      {segment && <SegmentSourceNote source={cost.segment_source} />}
    </>
  );
}

function MarksTab({
  marks,
  today,
  childAgeLimit,
  canWrite,
  onAdd,
  onEdit,
}: {
  marks: HkMarkJson[];
  today: string;
  childAgeLimit: number;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (m: HkMarkJson) => void;
}) {
  const [query, setQuery] = useState("");
  const q = searchKey(query);
  const rows = marks.filter((m) => !q || searchKey(m.patient_name).includes(q) || searchKey(m.patient_ref).includes(q));
  return (
    <Card
      title="Hasta işaretleri"
      actions={
        canWrite ? (
          <button type="button" className={buttonPrimary} onClick={onAdd}>
            İşaret ekle
          </button>
        ) : undefined
      }
    >
      <div className="mb-3 max-w-sm">
        <input
          className={inputClass}
          placeholder="Hasta adı veya hasta no"
          aria-label="Hasta ara"
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-700 border-b">
              <th className="py-2 pr-3 font-semibold">Hasta</th>
              <th className="py-2 pr-3 font-semibold">Kendi hastası olduğu hekim</th>
              <th className="py-2 pr-3 font-semibold">Doğum tarihi</th>
              <th className="py-2 pr-3 font-semibold text-right">Yaş</th>
              <th className="py-2 pr-3 font-semibold">Grup</th>
              <th className="py-2 pr-3 font-semibold">Not</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">
                  İşaretli hasta yok.
                </td>
              </tr>
            ) : (
              rows.map((m) => {
                const age = m.birth_date ? ageOn(m.birth_date, today) : null;
                return (
                  <tr key={m.id} className="border-b last:border-b-0 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{m.patient_name}</div>
                      {customPatientNo(m) && <div className="text-xs text-gray-500">Hasta no: {m.patient_ref}</div>}
                      {m.updated_by_name && <div className="text-xs text-gray-500">Son değiştiren: {m.updated_by_name}</div>}
                    </td>
                    <td className="py-2 pr-3">{m.own_doctor_name ?? "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDay(m.birth_date)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{age === null ? "—" : Math.max(age, 0)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{markGroupText(m, today, childAgeLimit)}</td>
                    <td className="py-2 pr-3 text-xs text-gray-600">{m.note || "—"}</td>
                    <td className="py-2 text-right">
                      {canWrite && (
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(m)}>
                          Düzenle
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        İşaret, satırda hasta grubu elle seçilmediyse kullanılır: hasta o hekimin kendi hastasıysa “Hekimin kendi hastası”;
        değilse doğum tarihi varsa ödeme gününde {childAgeLimit} yaşından küçükse “Çocuk hasta”, değilse “Standart”;
        doğum tarihi yoksa “Grup” seçimi (“{MARK_GROUP_LABELS.child}” / “{MARK_GROUP_LABELS.adult}”). Grubu belirtilmemiş
        hasta, çocuk kuralında “{UNMARKED_DEFAULT_LABEL}” seçili hekimde “Çocuk hasta”, diğer hekimlerde “Standart”
        sayılır. Yaş bugüne göredir; hesapta her ödemenin günündeki yaş kullanılır.
        Doğum tarihi ve kendi hastası olduğu hekim resepsiyonda “Hasta işaretleri” sayfasından da girilebilir. Değişiklik
        açık ayların hesabına hemen yansır; kapatılmış ayların dökümleri değişmez.
      </p>
    </Card>
  );
}

function DoctorSelect({
  refData,
  value,
  onChange,
  preferred,
}: {
  refData: HkReferenceJson;
  value: string;
  onChange: (id: string) => void;
  /** listed first (e.g. doctors whose lab costs come off a rule this month: ortho_lab_first or ciro_share) */
  preferred?: Set<string | null>;
}) {
  const doctors = refData.doctors
    .filter((d) => d.is_active || d.id === value)
    .slice()
    .sort((a, b) => Number(!!preferred?.has(b.id)) - Number(!!preferred?.has(a.id)));
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Seçin</option>
      {doctors.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
          {d.is_active ? "" : " (pasif)"}
        </option>
      ))}
    </select>
  );
}

interface LineForm {
  day: string;
  doctor_id: string;
  patient_name: string;
  method: HkMethod;
  currency: HkCurrency;
  amount: string;
  try_value: string;
  implant: string;
  segment: HkSegment | "";
  description: string;
}

/** Add / edit a revenue line (fin_hk_save_line). TL by default; another currency needs the amount and its TL value. */
function LineDialog({
  refData,
  record,
  bounds,
  known,
  marksByRef,
  onClose,
  onSaved,
  onReload,
}: {
  refData: HkReferenceJson;
  record: HkLineJson | null;
  bounds: { min: string; max: string };
  known: Map<string, KnownPatient>;
  marksByRef: Map<string, HkMarkJson>;
  onClose: () => void;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
}) {
  const [id] = useState(() => record?.id ?? newId());
  const [form, setForm] = useState<LineForm>(() => ({
    day: record?.day ?? bounds.max,
    doctor_id: record?.doctor_id ?? "",
    patient_name: record?.patient_name ?? "",
    // Imported lines (the only ones with 'unpaid') are never edited here.
    method: record && record.method !== "unpaid" ? record.method : "cash",
    currency: record?.currency ?? "TRY",
    amount: centsToInput(record?.amount_cents),
    try_value: record && record.currency !== "TRY" ? centsToInput(record.try_cents) : "",
    implant: record?.implant_cents ? centsToInput(record.implant_cents) : "",
    segment: record?.segment ?? "",
    description: record?.description ?? "",
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof LineForm>(key: K, value: LineForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const foreign = form.currency !== "TRY";
  const patientRef = patientRefFor(form.patient_name, known, record);
  const patientKey = patientRef ?? normalizePatientRef(form.patient_name);
  const mark = marksByRef.get(patientKey);
  // A mark of the same name under another key (e.g. a reception "Hasta no") does not apply to this record.
  const otherMark = mark
    ? undefined
    : Array.from(marksByRef.values()).find((m) => normalizePatientRef(m.patient_name) === normalizePatientRef(form.patient_name));
  // With a birth date the child group follows the age on the line's day (fin_hk__compute), not the manual mark.
  const markAge = mark?.birth_date ? ageOn(mark.birth_date, form.day) : null;
  const markText = mark
    ? [
        mark.own_doctor_name ? `${mark.own_doctor_name} hekiminin kendi hastası` : null,
        markIsChildOn(mark, form.day, childAgeLimitOf(refData.settings)) ? "çocuk hasta" : null,
        // 0034: the adult mark counts only without a birth date.
        markAge === null && !mark.is_child && mark.is_adult ? "yetişkin" : null,
        markAge !== null ? `ödeme gününde ${Math.max(markAge, 0)} yaşında` : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  // 0034: no child / adult information and the doctor's child rule of the line's month counts unmarked patients as
  // children.
  const unmarkedDoctors = useMemo(
    () => unmarkedDefaultDoctorIds(refData.rules, form.day.slice(0, 7)),
    [refData.rules, form.day]
  );
  const unmarkedChild =
    !form.segment &&
    !!form.doctor_id &&
    segmentSourceOf({ segment: null, doctor_id: form.doctor_id, day: form.day }, mark, unmarkedDoctors.has(form.doctor_id)) ===
      "unmarked_default";

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const dayError = record ? (isDay(form.day) ? null : "Tarih seçin.") : checkDay(form.day, bounds);
    if (dayError) return setFormError(dayError);
    if (form.day > refData.today) return setFormError("Tarih bugünden sonra olamaz.");
    if (!form.doctor_id) return setFormError("Hekimi seçin.");
    const patientError = checkPatient(form.patient_name);
    if (patientError) return setFormError(patientError);
    const amount = parseTL(form.amount, { allowNegative: true });
    if (!amount.ok) return setFormError(`Tutar: ${amount.error}`);
    let tryCents = amount.cents;
    if (foreign) {
      const t = parseTL(form.try_value, { allowNegative: true });
      if (!t.ok) return setFormError(`TL karşılığı: ${t.error}`);
      if (t.cents > 0 !== amount.cents > 0) return setFormError("TL karşılığı tutarla aynı işaretli olmalı.");
      tryCents = t.cents;
    }
    let implantCents = 0;
    if (form.implant.trim()) {
      const i = parseTL(form.implant, { allowNegative: true, allowZero: true });
      if (!i.ok) return setFormError(`İmplant payı: ${i.error}`);
      implantCents = i.cents;
    }
    if (implantCents !== 0 && (implantCents > 0 !== tryCents > 0 || Math.abs(implantCents) > Math.abs(tryCents))) {
      return setFormError("İmplant payı TL tutarını aşamaz ve tutarla aynı işaretli olmalı.");
    }
    if (form.description.trim().length > 500) return setFormError("Açıklama en fazla 500 karakter olabilir.");

    setBusy(true);
    try {
      const res = await finHkSaveLine({
        p_id: id,
        p_version: record?.version ?? 0,
        p_day: form.day,
        p_doctor_id: form.doctor_id,
        p_patient_name: form.patient_name.trim(),
        p_patient_ref: patientRef,
        p_method: form.method,
        p_currency: form.currency,
        p_amount_cents: amount.cents,
        p_try_cents: tryCents,
        p_implant_cents: implantCents,
        p_segment: form.segment || null,
        p_description: form.description.trim(),
      });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Tahsilat satırını düzenle" : "Tahsilat satırı ekle"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Tarih">
            <input
              type="date"
              className={inputClass}
              value={form.day}
              min={record ? undefined : bounds.min}
              max={record ? refData.today : bounds.max}
              onChange={(e) => set("day", e.target.value)}
              required
            />
          </Field>
          <Field label="Hekim">
            <DoctorSelect refData={refData} value={form.doctor_id} onChange={(v) => set("doctor_id", v)} />
          </Field>
          <Field
            label="Hasta"
            className="md:col-span-2"
            hint={hintLines(
              patientNoHint(patientRef, form.patient_name, known),
              markText ? `Hasta işareti: ${markText}.` : null,
              unmarkedChild
                ? `Hastanın grubu belirtilmemiş; bu hekimin çocuk kuralında “${UNMARKED_DEFAULT_LABEL}” seçili olduğu için “Çocuk hasta” sayılır. Yetişkinse hasta işaretinden “${MARK_GROUP_LABELS.adult}” seçin.`
                : null,
              otherMark
                ? `Bu adla hasta no “${otherMark.patient_ref}” ile kayıtlı bir hasta işareti var; bu kayda uygulanmaz.`
                : null
            )}
          >
            <input
              className={inputClass}
              list="hk-patients"
              maxLength={200}
              value={form.patient_name}
              onChange={(e) => set("patient_name", e.target.value)}
              required
            />
          </Field>
          <Field label="Ödeme şekli">
            <select className={inputClass} value={form.method} onChange={(e) => set("method", e.target.value as HkMethod)}>
              {HK_METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Para birimi">
            <select className={inputClass} value={form.currency} onChange={(e) => set("currency", e.target.value as HkCurrency)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={foreign ? `Tutar (${form.currency})` : "Tutar (TL)"} hint="Düzeltme için eksi tutar girin (ör. -500).">
            <input className={inputClass} inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
          </Field>
          {foreign && (
            <Field label="TL karşılığı" hint="Hakediş TL karşılığı üzerinden hesaplanır.">
              <input className={inputClass} inputMode="decimal" value={form.try_value} onChange={(e) => set("try_value", e.target.value)} required />
            </Field>
          )}
          <Field label="İmplant payı (TL, isteğe bağlı)" hint="Tahsilatın implanta ait kısmı; hekimin cirosuna girmez.">
            <input className={inputClass} inputMode="decimal" value={form.implant} onChange={(e) => set("implant", e.target.value)} />
          </Field>
          <Field label="Hasta grubu">
            <select className={inputClass} value={form.segment} onChange={(e) => set("segment", e.target.value as HkSegment | "")}>
              <option value="">Hasta işaretine göre (otomatik)</option>
              {HK_SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {SEGMENT_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Açıklama" className="md:col-span-2">
            <textarea className={inputClass} rows={2} maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
        {record && record.day.slice(0, 7) !== form.day.slice(0, 7) && (
          <p className="text-xs text-amber-700">Tarih başka bir aya taşınıyor; satır o ayın hesabına girer.</p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

/** Implants placed (fin_hk_save_piece); a negative quantity corrects an earlier entry. */
function PieceDialog({
  refData,
  bounds,
  known,
  onClose,
  onSaved,
  onReload,
}: {
  refData: HkReferenceJson;
  bounds: { min: string; max: string };
  known: Map<string, KnownPatient>;
  onClose: () => void;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
}) {
  const [id] = useState(() => newId());
  const [day, setDay] = useState(bounds.max);
  const [doctorId, setDoctorId] = useState("");
  const [patient, setPatient] = useState("");
  const [qty, setQty] = useState("1");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  const patientRef = patientRefFor(patient, known);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const dayError = checkDay(day, bounds);
    if (dayError) return setFormError(dayError);
    if (!doctorId) return setFormError("Hekimi seçin.");
    const patientError = checkPatient(patient);
    if (patientError) return setFormError(patientError);
    const n = Number(qty.trim());
    if (!/^-?\d+$/.test(qty.trim()) || n === 0 || n < -1000 || n > 1000) {
      return setFormError("Adet 0 olamaz ve -1000 ile 1000 arasında tam sayı olmalı.");
    }
    if (description.trim().length > 500) return setFormError("Açıklama en fazla 500 karakter olabilir.");
    setBusy(true);
    try {
      const res = await finHkSavePiece({
        p_id: id,
        p_version: 0,
        p_day: day,
        p_doctor_id: doctorId,
        p_patient_name: patient.trim(),
        p_patient_ref: patientRef,
        p_qty: n,
        p_description: description.trim(),
      });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="İmplant ekle" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Tarih">
          <input type="date" className={inputClass} value={day} min={bounds.min} max={bounds.max} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <Field label="İmplantı takan hekim">
          <DoctorSelect refData={refData} value={doctorId} onChange={setDoctorId} />
        </Field>
        <Field label="Hasta" hint={patientNoHint(patientRef, patient, known)}>
          <input className={inputClass} list="hk-patients" maxLength={200} value={patient} onChange={(e) => setPatient(e.target.value)} required />
        </Field>
        <Field label="Adet" hint="Düzeltme için eksi adet girin (ör. -1).">
          <input className={inputClass} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} required />
        </Field>
        <Field label="Açıklama">
          <textarea className={inputClass} rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

/**
 * One lab invoice / charge for a patient (fin_hk_save_lab_cost). The lab name is picked from the names the clinic
 * already uses (labs directory, finance lab counterparties and lab-category entries, earlier lab costs) or typed.
 */
function LabCostDialog({
  refData,
  month,
  bounds,
  known,
  onClose,
  onSaved,
  onReload,
}: {
  refData: HkReferenceJson;
  month: string;
  bounds: { min: string; max: string };
  known: Map<string, KnownPatient>;
  onClose: () => void;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
}) {
  const ortho = useMemo(
    () => new Set(refData.rules.filter((r) => r.kind === "ortho_lab_first" && ruleActiveIn(r, month)).map((r) => r.doctor_id)),
    [refData.rules, month]
  );
  // 0032: a ciro_share doctor's lab costs come off the month's ciro.
  const ciro = useMemo(
    () => new Set(refData.rules.filter((r) => r.kind === "ciro_share" && ruleActiveIn(r, month)).map((r) => r.doctor_id)),
    [refData.rules, month]
  );
  const [id] = useState(() => newId());
  const [day, setDay] = useState(bounds.max);
  // Every doctor with a ciro_share or ortho rule this month has lab costs deducted (0032), so no doctor is pre-selected
  // (a cost booked to the wrong doctor would not come off the right ciro); those doctors are listed first.
  const deducting = useMemo(() => new Set([...Array.from(ortho), ...Array.from(ciro)]), [ortho, ciro]);
  const [doctorId, setDoctorId] = useState("");
  const [patient, setPatient] = useState("");
  const [labName, setLabName] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const labKeys = useMemo(() => new Set(refData.lab_names.map((n) => normalizePatientRef(n))), [refData.lab_names]);
  const patientRef = patientRefFor(patient, known);
  const labTyped = labName.trim();
  const newLab = labTyped !== "" && !labKeys.has(normalizePatientRef(labTyped));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const dayError = checkDay(day, bounds);
    if (dayError) return setFormError(dayError);
    if (!doctorId) return setFormError("Hekimi seçin.");
    const patientError = checkPatient(patient);
    if (patientError) return setFormError(patientError);
    if (!labTyped || labTyped.length > 120) return setFormError("Laboratuvar adı boş olamaz ve en fazla 120 karakter olabilir.");
    const a = parseTL(amount, { allowNegative: true });
    if (!a.ok) return setFormError(`Tutar: ${a.error}`);
    if (description.trim().length > 500) return setFormError("Açıklama en fazla 500 karakter olabilir.");
    setBusy(true);
    try {
      const res = await finHkSaveLabCost({
        p_id: id,
        p_version: 0,
        p_day: day,
        p_doctor_id: doctorId,
        p_patient_name: patient.trim(),
        p_patient_ref: patientRef,
        p_lab_name: labTyped,
        p_amount_cents: a.cents,
        p_description: description.trim(),
      });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Lab gideri ekle" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Tarih" hint="Fatura / ücret tarihi; gider bu tarihin ayında hesaba girer.">
          <input type="date" className={inputClass} value={day} min={bounds.min} max={bounds.max} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <Field
          label="Hekim"
          hint={
            !doctorId
              ? "Lab gideri, hekimin payı hesaplanmadan önce düşülür."
              : ortho.has(doctorId)
                ? "Ortodonti: lab gideri bu hastanın ödemelerinden önce karşılanır."
                : ciro.has(doctorId)
                  ? "Lab gideri bu ayın cirosundan, ödeme şekli kesintilerinden sonra düşülür."
                  : "Bu hekimin bu ay ciro payı ya da ortodonti kuralı yok; gider hakedişten düşülmez."
          }
        >
          <DoctorSelect refData={refData} value={doctorId} onChange={setDoctorId} preferred={deducting} />
        </Field>
        <Field label="Hasta" hint={patientNoHint(patientRef, patient, known)}>
          <input className={inputClass} list="hk-patients" maxLength={200} value={patient} onChange={(e) => setPatient(e.target.value)} required />
        </Field>
        <Field
          label="Laboratuvar"
          hint={
            newLab
              ? "Bu ad kayıtlı laboratuvarlar arasında yok; yazım doğruysa yeni ad olarak kaydedilir."
              : refData.lab_names.length > 0
                ? "Cariler ekranındaki laboratuvarlardan ya da daha önce kullanılan adlardan seçin veya yazın."
                : undefined
          }
        >
          <input
            className={inputClass}
            list="hk-lab-names"
            maxLength={120}
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
            required
          />
          <datalist id="hk-lab-names">
            {refData.lab_names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>
        {refData.lab_names.length > 0 && refData.lab_names.length <= 20 && (
          <div className="flex flex-wrap gap-2" aria-label="Kayıtlı laboratuvarlar">
            {refData.lab_names.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLabName(n)}
                aria-pressed={labTyped === n}
                className={`px-2 py-1 rounded border text-xs ${
                  labTyped === n ? "bg-blue-600 text-white border-blue-700" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <Field label="Tutar (TL)" hint="Düzeltme için eksi tutar girin.">
          <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Açıklama">
          <textarea className={inputClass} rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}

/** The child / adult choices of the mark dialog (0034): unset first. */
const MARK_GROUP_CHOICES: [HkMarkGroup | "", string][] = [
  ["", MARK_GROUP_UNSET_LABEL],
  ["child", MARK_GROUP_LABELS.child],
  ["adult", MARK_GROUP_LABELS.adult],
];

/**
 * Patient mark (fin_hk_save_mark): patient no, own-portfolio doctor, birth date and / or the child / adult choice (0034:
 * "Belirtilmedi" / "Çocuk" / "Yetişkin"; unmarked patients follow the line doctor's default), note; one per patient.
 * The birth date and the patient no are always sent, so an edit here keeps those entered at the reception (Hasta
 * işaretleri); both flags are always sent (never both true).
 */
function MarkDialog({
  refData,
  record,
  patient,
  known,
  marks,
  onClose,
  onSaved,
  onReload,
  onOpenExisting,
}: {
  refData: HkReferenceJson;
  record: HkMarkJson | null;
  patient?: KnownPatient;
  known: Map<string, KnownPatient>;
  marks: HkMarkJson[];
  onClose: () => void;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
  onOpenExisting: (m: HkMarkJson) => void;
}) {
  const original = record ?? (patient ? { patient_name: patient.name, patient_ref: patient.ref } : null);
  // A patient no (a key that is not the normalized name, e.g. entered at the reception) is shown and kept on a rename;
  // clearing it keys the mark by the name again, as on the reception page.
  const originalNo = customPatientNo(original);
  const [id] = useState(() => record?.id ?? newId());
  const [name, setName] = useState(record?.patient_name ?? patient?.name ?? "");
  const [no, setNo] = useState(originalNo);
  const [ownDoctorId, setOwnDoctorId] = useState(record?.own_doctor_id ?? "");
  const [birth, setBirth] = useState(record?.birth_date ?? "");
  const [group, setGroup] = useState<HkMarkGroup | "">(() => markGroupOf(record) ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const existing =
    error?.isConflict && error.details && UUID_RE.test(error.details) ? marks.find((m) => m.id === error.details) : undefined;
  const doctors = refData.doctors.filter((d) => d.is_active || d.id === ownDoctorId);
  const childAgeLimit = childAgeLimitOf(refData.settings);
  const birthError = birth ? validateBirthDate(birth, refData.today) : null;
  const age = birth && !birthError ? ageOn(birth, refData.today) : null;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const patientError = checkPatient(name);
    if (patientError) return setFormError(patientError);
    if (no.trim().length > 200) return setFormError("Hasta no en fazla 200 karakter olabilir.");
    const bError = validateBirthDate(birth, refData.today);
    if (bError) return setFormError(bError);
    if (note.trim().length > 500) return setFormError("Not en fazla 500 karakter olabilir.");
    setBusy(true);
    try {
      const res = await finHkSaveMark({
        p_id: id,
        p_version: record?.version ?? 0,
        p_patient_ref: no.trim() || (originalNo ? null : patientRefFor(name, known, original)),
        p_patient_name: name.trim(),
        p_own_doctor_id: ownDoctorId || null,
        p_is_child: group === "child",
        p_is_adult: group === "adult",
        p_note: note.trim(),
        p_birth_date: birth || null,
      });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Hasta işaretini düzenle" : "Hasta işareti ekle"} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Hasta" hint="Satırlardaki hasta adıyla aynı yazılmalı (büyük / küçük harf ve boşluk fark etmez).">
          <input className={inputClass} list="hk-patients" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field
          label="Hasta no (isteğe bağlı)"
          hint="Yalnız satırlar hasta numarasıyla kayıtlıysa girin; boş bırakılırsa hasta adı kullanılır. İşaret yalnız aynı hasta no / adla kayıtlı satırlara uygulanır."
        >
          <input className={inputClass} maxLength={200} value={no} onChange={(e) => setNo(e.target.value)} />
        </Field>
        <Field label="Kendi hastası olduğu hekim" hint="Bu hekimin satırlarında hasta “Hekimin kendi hastası” grubuna girer.">
          <select className={inputClass} value={ownDoctorId} onChange={(e) => setOwnDoctorId(e.target.value)}>
            <option value="">Yok</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Doğum tarihi"
          hint={
            birthError ??
            (age !== null
              ? `Bugün ${Math.max(age, 0)} yaşında. Ödeme gününde ${childAgeLimit} yaşından küçükse “Çocuk hasta” grubuna girer.`
              : "Bilinmiyorsa boş bırakın; o zaman aşağıdaki grup seçimine bakılır.")
          }
        >
          <input
            className={inputClass}
            type="date"
            min={HK_MIN_BIRTH_DATE}
            max={refData.today}
            value={birth}
            onChange={(e) => setBirth(e.target.value)}
          />
        </Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold text-gray-800 mb-1">Grup</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {MARK_GROUP_CHOICES.map(([value, label]) => (
              <label
                key={value || "unset"}
                className={`flex items-center gap-2 text-sm ${birth ? "text-gray-400" : "text-gray-800"}`}
              >
                <input
                  type="radio"
                  name="mark-group"
                  checked={group === value}
                  onChange={() => setGroup(value)}
                  disabled={!!birth}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {birth ? "Doğum tarihi varken grup yaşa göre belirlenir; bu seçim kullanılmaz." : MARK_GROUP_HINT}
          </p>
        </fieldset>
        <Field label="Not">
          <textarea className={inputClass} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={existing ? undefined : onReload} />
        {existing && (
          <button type="button" className={buttonSecondary} onClick={() => onOpenExisting(existing)}>
            Mevcut işareti aç
          </button>
        )}
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
