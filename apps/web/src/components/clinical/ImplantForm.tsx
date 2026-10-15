"use client";

// Implant form (spec p9_clinical §7.1): create through clin_implant_record (implant + A-level stock issue in one
// transaction, D1) or edit through clin_implant_update. "Kaydet ve aynı hastaya implant ekle" resets the form with
// nextImplantForm (§8.2), a new operation key and a new implant id.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PatientPicker, type PatientRef } from "@/components/stock/PatientPicker";
import {
  ClinicalError,
  clinImplantDetail,
  clinImplantList,
  clinImplantRecord,
  clinImplantUpdate,
  clinSaveImplantBrand,
  listBrands,
  listDoctors,
  listPatientAppointments,
  newKey,
  toClinicalError,
  type AppointmentRef,
  type BrandRow,
  type ClinicalFlags,
  type DoctorRef,
  type ImplantJson,
} from "@/lib/clinical/rpc";
import {
  IMPLANT_STATUSES,
  IMPLANT_STATUS_LABELS,
  LIMITS,
  isImplantStatus,
  type ImplantStatus,
} from "@/lib/clinical/codes";
import { parseFdi } from "@/lib/clinical/fdi";
import { parseDecimalTr, formatDecimalTr } from "@/lib/clinical/numbers";
import { addDays, addMonths, formatDateTime, isDay } from "@/lib/clinical/dates";
import { emptyImplantForm, nextImplantForm, type ImplantFormValues } from "@/lib/clinical/implant-entry";
import { ToothPicker, type OccupiedTooth } from "./ToothPicker";
import { ImplantStockPicker, lotSerialText, type StockChoice } from "./ImplantStockPicker";
import {
  ErrorBox,
  Field,
  NoPatientTextHint,
  SAVING_LABEL,
  Sheet,
  clinInput,
  clinPrimary,
  clinSecondary,
} from "./ui";

/** Client texts mirror the server keys (§1.1); the server stays the authority. */
const TEXT = {
  patient: "Hastayı seçin.",
  tooth: "Geçerli bir diş numarası girin (FDI 11–18, 21–28, 31–38, 41–48).",
  toothTaken:
    "Bu hastanın bu dişinde etkin bir implant kaydı var. Önceki implantı “Başarısız / çıkarıldı” olarak işaretleyin veya o kaydı düzeltin.",
  brand: "İmplant markası bulunamadı veya pasif. Tanımlardan etkin bir marka seçin.",
  brandStock: "Seçilen marka, stoktan düşülen kartın markası ile aynı olmalı.",
  alreadySaved: "Bu implant önceki denemede kaydedilmişti; kayıt listeye eklendi.",
  size: "İmplant çapını ve boyunu kontrol edin.",
  torque: "Tork 0–200 Ncm arasında olmalıdır.",
  placedOn: "Geçerli bir uygulama tarihi girin; bugünden sonra olamaz.",
  placedOnStock:
    "Stoktan düşülen implantın uygulama tarihi son 30 gün içinde olmalı. Daha eski kayıtlar için “Stok dışı” seçin.",
  control: "Kontrol tarihi uygulama tarihinden önce olamaz.",
  status: "İmplant durumunu seçin.",
  model: "Model en fazla 150 karakter olabilir.",
  notes: "Not en fazla 4000 karakter olabilir.",
  lot: "Lot / seri numarası en fazla 60 karakter olabilir.",
  sourceNote: "Stok dışı implant için kısa bir açıklama yazın (3–200 karakter).",
  stockArgs: "Stoktan düşülecek implantın lot / seri kaydını ve alındığı yeri seçin.",
  doctor: "Uygulayan hekimi seçin.",
  doctorInactive: "Seçili hekimin hesabı pasif; stoktan düşmek için etkin bir hekim seçin.",
  brandName: "Marka adı 1–80 karakter olmalı.",
};

const DIAMETER_CHIPS = ["3,5", "4", "4,5", "5"];
const LENGTH_CHIPS = ["8", "10", "11,5", "13"];

function clientError(message: string): ClinicalError {
  return new ClinicalError(message, null, null, null);
}

/** Istanbul is UTC+3 all year (no DST since 2016). */
function istanbulMidnightIso(day: string): string {
  return `${day}T00:00:00+03:00`;
}

export interface FixedAppointment {
  id: string;
  start_time: string;
  doctor_id: string | null;
}

export function ImplantForm({
  implant,
  initial,
  fixedPatient,
  fixedAppointment,
  flags,
  today,
  onClose,
  onSaved,
}: {
  /** Edit mode when set. */
  implant?: ImplantJson | null;
  /** Create mode: starting values (e.g. sameImplantPatientForm for the row "+" action). */
  initial?: Partial<ImplantFormValues>;
  /** Patient chip instead of the picker (patient tab, appointment page, row "+"). */
  fixedPatient?: PatientRef | null;
  /** Appointment page: appointment and doctor fixed too. */
  fixedAppointment?: FixedAppointment | null;
  flags: ClinicalFlags;
  today: string;
  onClose: () => void;
  /** `more` is true after "Kaydet ve aynı hastaya implant ekle" (the form stays open). */
  onSaved: (implant: ImplantJson, more: boolean) => void;
}) {
  const editing = !!implant;
  const canStock = flags.can_operate_stock;

  const [values, setValues] = useState<ImplantFormValues>(() => {
    if (implant) {
      return {
        patientId: implant.patient_id,
        placedOn: implant.placed_on,
        doctorId: implant.doctor_id ?? "",
        brandId: implant.brand_id,
        model: implant.model ?? "",
        nextControlOn: implant.next_control_on ?? "",
        status: implant.status,
        appointmentId: implant.appointment_id ?? "",
        stockSource: implant.stock_source,
        fromLocationId: "",
        sourceNote: implant.source_note ?? "",
        tooth: String(implant.tooth_fdi),
        diameter: formatDecimalTr(implant.diameter_mm),
        length: formatDecimalTr(implant.length_mm),
        torque: implant.torque_ncm === null || implant.torque_ncm === undefined ? "" : formatDecimalTr(implant.torque_ncm),
        batchId: implant.batch_id ?? "",
        stockItemId: implant.stock_item_id ?? "",
        lotText: implant.lot_text ?? "",
        serialText: implant.serial_text ?? "",
        notes: implant.notes ?? "",
      };
    }
    const base = emptyImplantForm(today, {
      patientId: fixedPatient?.id ?? "",
      appointmentId: fixedAppointment?.id ?? "",
      doctorId: fixedAppointment?.doctor_id ?? "",
    });
    const merged = { ...base, ...(initial ?? {}) };
    if (fixedPatient) merged.patientId = fixedPatient.id;
    if (fixedAppointment) {
      merged.appointmentId = fixedAppointment.id;
      merged.doctorId = fixedAppointment.doctor_id ?? merged.doctorId;
    }
    if (!canStock || !merged.stockSource) merged.stockSource = canStock ? "stock" : "external";
    if (!isImplantStatus(merged.status)) merged.status = "healing";
    return merged;
  });
  const set = <K extends keyof ImplantFormValues>(key: K, v: ImplantFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const [patient, setPatient] = useState<PatientRef | null>(
    fixedPatient ?? (implant ? { id: implant.patient_id, full_name: implant.patient_name } : null)
  );
  const [stockChoice, setStockChoice] = useState<StockChoice | null>(null);
  const opKey = useRef(newKey());
  const implantId = useRef(newKey());
  const savingRef = useRef(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [appointments, setAppointments] = useState<AppointmentRef[]>([]);
  const [occupied, setOccupied] = useState<OccupiedTooth[]>([]);
  const [refError, setRefError] = useState<ClinicalError | null>(null);

  const [newBrandOpen, setNewBrandOpen] = useState(false);
  const [newBrandName, setNewBrandName] = useState("");
  const [brandSaving, setBrandSaving] = useState(false);
  const brandKey = useRef(newKey());

  const isStock = values.stockSource === "stock";
  const stockLocked = editing && implant?.stock_source === "stock";

  useEffect(() => {
    let cancelled = false;
    Promise.all([listDoctors(), listBrands()])
      .then(([d, b]) => {
        if (cancelled) return;
        setDoctors(d);
        setBrands(b);
      })
      .catch((err) => {
        if (!cancelled) setRefError(toClinicalError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patientId = patient?.id ?? "";

  const loadOccupied = useCallback(async () => {
    if (!patientId) {
      setOccupied([]);
      return;
    }
    try {
      const r = await clinImplantList({ patient_id: patientId }, { offset: 0, limit: 200 });
      setOccupied(
        r.rows
          .filter((row) => row.status !== "failed" && row.id !== implant?.id)
          .map((row) => ({ tooth: row.tooth_fdi, status: row.status }))
      );
    } catch {
      // The server refuses an occupied tooth anyway (CL_TOOTH_TAKEN); the chart is only a hint.
      setOccupied([]);
    }
  }, [patientId, implant?.id]);

  useEffect(() => {
    void loadOccupied();
  }, [loadOccupied]);

  useEffect(() => {
    if (!patientId || fixedAppointment) {
      setAppointments([]);
      return;
    }
    let cancelled = false;
    listPatientAppointments(patientId, istanbulMidnightIso(addDays(today, -30)), istanbulMidnightIso(addDays(today, 1)))
      .then((rows) => {
        if (!cancelled) setAppointments(rows.filter((a) => a.status !== "cancelled"));
      })
      .catch(() => {
        if (!cancelled) setAppointments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, today, fixedAppointment]);

  // Inactive doctors are refused for stock issues (0024 E_DOCTOR); they stay visible only as the current value.
  const activeDoctors = useMemo(() => doctors.filter((d) => d.active), [doctors]);

  const doctorName = useCallback(
    (id: string | null | undefined) => (id ? doctors.find((d) => d.id === id)?.name ?? "Hekim" : ""),
    [doctors]
  );

  const appointmentOptions = useMemo(() => {
    const opts = appointments.map((a) => ({
      id: a.id,
      label: `${formatDateTime(a.start_time)}${a.doctor_id ? ` · ${doctorName(a.doctor_id)}` : ""}`,
      doctor_id: a.doctor_id,
    }));
    if (fixedAppointment && !opts.some((o) => o.id === fixedAppointment.id)) {
      opts.unshift({
        id: fixedAppointment.id,
        label: `${formatDateTime(fixedAppointment.start_time)}${fixedAppointment.doctor_id ? ` · ${doctorName(fixedAppointment.doctor_id)}` : ""}`,
        doctor_id: fixedAppointment.doctor_id,
      });
    }
    if (implant?.appointment_id && !opts.some((o) => o.id === implant.appointment_id)) {
      opts.unshift({
        id: implant.appointment_id,
        label: `${formatDateTime(implant.appointment_start)}${implant.doctor_name ? ` · ${implant.doctor_name}` : ""}`,
        doctor_id: implant.doctor_id,
      });
    }
    return opts;
  }, [appointments, fixedAppointment, implant, doctorName]);

  const brandOptions = useMemo(() => {
    const active = brands.filter((b) => b.is_active);
    if (implant && !active.some((b) => b.id === implant.brand_id)) {
      active.unshift({ id: implant.brand_id, name: `${implant.brand_name} (pasif)`, is_active: false, version: 0 });
    }
    return active;
  }, [brands, implant]);

  // Brand / model that the current stock choice filled in, so clearing or changing the choice can take them back
  // without discarding values the user typed for a card that names no directory brand.
  const stockDerived = useRef<{ brandId: string; model: string }>({ brandId: "", model: "" });

  const pickStock = (choice: StockChoice | null) => {
    setStockChoice(choice);
    setValues((prev) => {
      const derived = stockDerived.current;
      // Values that came from the previous choice go back to empty; user-typed values stay.
      const baseBrand = derived.brandId && prev.brandId === derived.brandId ? "" : prev.brandId;
      const baseModel = derived.model && prev.model === derived.model ? "" : prev.model;
      if (!choice) {
        stockDerived.current = { brandId: "", model: "" };
        return {
          ...prev,
          batchId: "",
          stockItemId: "",
          fromLocationId: "",
          lotText: "",
          serialText: "",
          brandId: baseBrand,
          model: baseModel,
        };
      }
      // The issued card wins: the implant record must name the brand / model of the batch that leaves stock
      // (recall traceability; the server refuses a different brand with CL_BRAND_STOCK_MISMATCH).
      const brandId = choice.item.brand_id || baseBrand;
      const model = choice.item.model?.trim() ? choice.item.model.trim() : baseModel;
      stockDerived.current = {
        brandId: choice.item.brand_id ? brandId : "",
        model: choice.item.model?.trim() ? model : "",
      };
      return {
        ...prev,
        batchId: choice.batch.batch_id,
        stockItemId: choice.item.stock_item_id,
        fromLocationId: choice.batch.location_id,
        lotText: choice.batch.lot_number === "GENEL" ? "" : choice.batch.lot_number,
        serialText: choice.batch.serial_number ?? "",
        brandId,
        model,
      };
    });
  };
  const brandFromStock = !editing && isStock && !!stockChoice?.item.brand_id;

  const validate = (): string | null => {
    if (!patientId) return TEXT.patient;
    if (!isDay(values.placedOn) || values.placedOn > today) return TEXT.placedOn;
    if (!editing && isStock && values.placedOn < addDays(today, -30)) return TEXT.placedOnStock;
    if (!editing && isStock) {
      if (!values.doctorId) return TEXT.doctor;
      if (doctors.some((d) => d.id === values.doctorId && !d.active)) return TEXT.doctorInactive;
      if (!stockChoice) return TEXT.stockArgs;
    }
    if (!isStock) {
      const note = values.sourceNote.trim();
      if (note.length < LIMITS.sourceNoteMin || note.length > LIMITS.sourceNoteMax) return TEXT.sourceNote;
      if (values.lotText.trim().length > LIMITS.lotText || values.serialText.trim().length > LIMITS.lotText) return TEXT.lot;
    }
    if (parseFdi(values.tooth) === null) return TEXT.tooth;
    if (occupied.some((o) => o.tooth === parseFdi(values.tooth)) && values.status !== "failed") return TEXT.toothTaken;
    if (!values.brandId) return TEXT.brand;
    if (brandFromStock && values.brandId !== stockChoice?.item.brand_id) return TEXT.brandStock;
    if (values.model.trim().length > LIMITS.model) return TEXT.model;
    const d = parseDecimalTr(values.diameter, 2);
    const l = parseDecimalTr(values.length, 2);
    if (d === null || l === null || d <= 0 || d > 10 || l <= 0 || l > 30) return TEXT.size;
    if (values.torque.trim() !== "") {
      const t = parseDecimalTr(values.torque, 1);
      if (t === null || t < 0 || t > 200) return TEXT.torque;
    }
    if (values.nextControlOn && (!isDay(values.nextControlOn) || values.nextControlOn < values.placedOn)) return TEXT.control;
    if (!isImplantStatus(values.status)) return TEXT.status;
    if (values.notes.length > LIMITS.notes) return TEXT.notes;
    return null;
  };

  /** After a create: rotate the keys (0024 contract), then either reset for the next implant or close. */
  const finishCreate = (saved: ImplantJson, more: boolean, note: string | null) => {
    opKey.current = newKey();
    implantId.current = newKey();
    if (more) {
      setOccupied((prev) =>
        saved.status === "failed" ? prev : [...prev, { tooth: saved.tooth_fdi, status: saved.status }]
      );
      setValues(nextImplantForm(values));
      setStockChoice(null);
      // Carried brand / model are now the user's values for the next implant.
      stockDerived.current = { brandId: "", model: "" };
      setInfo(note ?? "İmplant kaydedildi. Aynı hastanın sonraki implantını girin.");
      onSaved(saved, true);
    } else {
      onSaved(saved, false);
    }
  };

  /** The implant with this id if it was committed; "missing" when the server says it does not exist. */
  const findSavedImplant = async (id: string): Promise<ImplantJson | "missing" | "unknown"> => {
    try {
      const d = await clinImplantDetail(id);
      return d.implant ?? "missing";
    } catch (err) {
      const e = toClinicalError(err);
      return e.isNotFound ? "missing" : "unknown";
    }
  };

  const submit = async (more: boolean) => {
    if (savingRef.current) return;
    const problem = validate();
    if (problem) {
      setError(clientError(problem));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setInfo(null);
    const tooth = parseFdi(values.tooth) as number;
    const diameter = parseDecimalTr(values.diameter, 2) as number;
    const length = parseDecimalTr(values.length, 2) as number;
    const torque = values.torque.trim() === "" ? null : parseDecimalTr(values.torque, 1);
    try {
      if (implant) {
        const r = await clinImplantUpdate({
          p_implant_id: implant.id,
          p_version: implant.version,
          p_tooth_fdi: tooth,
          p_brand_id: values.brandId,
          p_model: values.model.trim(),
          p_diameter_mm: diameter,
          p_length_mm: length,
          p_placed_on: values.placedOn,
          p_doctor_id: values.doctorId || null,
          p_appointment_id: values.appointmentId || null,
          p_lot_text: stockLocked ? implant.lot_text : values.lotText.trim(),
          p_serial_text: stockLocked ? implant.serial_text : values.serialText.trim(),
          p_source_note: stockLocked ? "" : values.sourceNote.trim(),
          p_torque_ncm: torque,
          p_next_control_on: values.nextControlOn || null,
          p_status: values.status as ImplantStatus,
          p_notes: values.notes.trim(),
        });
        onSaved(r.implant, false);
        return;
      }
      const r = await clinImplantRecord({
        p_operation_key: opKey.current,
        p_implant_id: implantId.current,
        p_patient_id: patientId,
        p_tooth_fdi: tooth,
        p_brand_id: values.brandId,
        p_model: values.model.trim(),
        p_diameter_mm: diameter,
        p_length_mm: length,
        p_placed_on: values.placedOn,
        p_doctor_id: values.doctorId || null,
        p_appointment_id: values.appointmentId || null,
        p_stock_source: isStock ? "stock" : "external",
        p_batch_id: isStock ? stockChoice?.batch.batch_id ?? null : null,
        p_from_location_id: isStock ? stockChoice?.batch.location_id ?? null : null,
        p_lot_text: isStock ? null : values.lotText.trim(),
        p_serial_text: isStock ? null : values.serialText.trim(),
        p_source_note: isStock ? null : values.sourceNote.trim(),
        p_torque_ncm: torque,
        p_next_control_on: values.nextControlOn || null,
        p_status: values.status as ImplantStatus,
        p_notes: values.notes.trim() || null,
      });
      finishCreate(r.implant, more, r.already_saved ? TEXT.alreadySaved : null);
    } catch (err) {
      const e = toClinicalError(err);
      // A lost answer (network) or a retry with edited fields after one (E_OP_KEY: the key is bound to the first
      // arguments) may hide a committed save. If the implant id exists, it was saved with its stock issue: treat
      // it as saved instead of letting the user re-enter it (a second record and a second stock-out).
      if (!implant && (e.network || e.key === "E_OP_KEY" || e.key === "CL_ID_TAKEN")) {
        const saved = await findSavedImplant(implantId.current);
        if (saved !== "missing" && saved !== "unknown") {
          finishCreate(saved, more, TEXT.alreadySaved);
          return;
        }
        // The server answered and the implant definitely does not exist: the keys are stale, so the next press
        // starts a new operation (never after an unanswered lookup, which could still hide a committed save).
        if (saved === "missing" && (e.key === "E_OP_KEY" || e.key === "CL_ID_TAKEN")) {
          opKey.current = newKey();
          implantId.current = newKey();
        }
      }
      setError(e);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveBrand = async () => {
    const name = newBrandName.trim();
    if (name.length < 1 || name.length > LIMITS.brandName) {
      setError(clientError(TEXT.brandName));
      return;
    }
    setBrandSaving(true);
    setError(null);
    try {
      const r = await clinSaveImplantBrand({ p_id: brandKey.current, p_version: null, p_name: name, p_is_active: true });
      brandKey.current = newKey();
      setBrands((prev) => [...prev.filter((b) => b.id !== r.brand.id), r.brand].sort((a, b) => a.name.localeCompare(b.name, "tr")));
      set("brandId", r.brand.id);
      setNewBrandName("");
      setNewBrandOpen(false);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBrandSaving(false);
    }
  };

  const busy = saving || brandSaving;
  const minPlaced = !editing && isStock ? addDays(today, -30) : "2000-01-01";

  const footer = (
    <div className="space-y-2">
      <ErrorBox error={error} />
      {info && !error && <p className="text-sm text-green-800 bg-green-50 rounded p-2" role="status">{info}</p>}
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button type="button" className={clinSecondary} onClick={onClose} disabled={busy}>
          Vazgeç
        </button>
        {editing ? (
          <button type="button" className={clinPrimary} onClick={() => void submit(false)} disabled={busy}>
            {saving ? SAVING_LABEL : "Kaydet"}
          </button>
        ) : (
          <>
            <button type="button" className={clinSecondary} onClick={() => void submit(true)} disabled={busy}>
              {saving ? SAVING_LABEL : "Kaydet ve aynı hastaya implant ekle"}
            </button>
            <button type="button" className={clinPrimary} onClick={() => void submit(false)} disabled={busy}>
              {saving ? SAVING_LABEL : "Kaydet ve bitir"}
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <Sheet
      title={editing ? "İmplantı düzenle" : "İmplant ekle"}
      description="Yıldızlı alanlar zorunludur. Stoktan düşülen implant için lot / seri kaydını listeden seçin; kayıt kaydedildiğinde stoktan 1 adet düşülür."
      onClose={onClose}
      busy={busy}
      wide
      footer={footer}
    >
      <div className="space-y-4">
        <ErrorBox error={refError} />

        <Field label="Hasta" required group>
          {fixedPatient || editing ? (
            <div className="p-2 min-h-[44px] border rounded bg-gray-50 font-medium flex items-center">{patient?.full_name}</div>
          ) : (
            <PatientPicker
              value={patient}
              onChange={(p) => {
                setPatient(p);
                setValues((prev) => ({ ...prev, patientId: p?.id ?? "", appointmentId: "" }));
              }}
              disabled={busy}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Randevu"
            hint={stockLocked ? "Stoktan düşülmüş kayıtta bu alan değiştirilemez." : "Son 30 gün ve bugünün randevuları."}
          >
            <select
              className={clinInput}
              value={values.appointmentId}
              disabled={busy || !patientId || !!fixedAppointment || stockLocked}
              onChange={(e) => {
                const id = e.target.value;
                const opt = appointmentOptions.find((o) => o.id === id);
                setValues((prev) => ({
                  ...prev,
                  appointmentId: id,
                  doctorId: prev.doctorId || opt?.doctor_id || "",
                }));
              }}
            >
              <option value="">Randevu seçilmedi</option>
              {appointmentOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Uygulayan hekim" required={isStock}>
            <select
              className={clinInput}
              value={values.doctorId}
              disabled={busy || stockLocked}
              onChange={(e) => set("doctorId", e.target.value)}
            >
              <option value="">{isStock ? "Hekim seçin" : "Hekim yok (başka klinik)"}</option>
              {values.doctorId && !activeDoctors.some((d) => d.id === values.doctorId) && (
                <option value={values.doctorId}>
                  {implant?.doctor_name || doctors.find((d) => d.id === values.doctorId)?.name || "Seçili hekim"}
                  {doctors.some((d) => d.id === values.doctorId && !d.active) ? " (pasif)" : ""}
                </option>
              )}
              {activeDoctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Uygulama tarihi" required>
          <input
            type="date"
            className={`${clinInput} sm:max-w-[14rem]`}
            value={values.placedOn}
            min={minPlaced}
            max={today}
            disabled={busy}
            onChange={(e) => set("placedOn", e.target.value)}
          />
        </Field>

        <Field label="Stok kaynağı" required group>
          {editing ? (
            <div className="p-2 min-h-[44px] border rounded bg-gray-50 flex items-center">
              {implant?.stock_source === "stock" ? "Stoktan düşüldü" : `Stok dışı · ${implant?.source_note ?? ""}`}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Stok kaynağı">
                {canStock && (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isStock}
                    disabled={busy}
                    onClick={() => set("stockSource", "stock")}
                    className={`min-h-[44px] px-3 py-2 rounded border text-sm ${isStock ? "bg-blue-600 text-white border-blue-700" : "bg-white text-gray-800"}`}
                  >
                    Stoktan düş
                  </button>
                )}
                <button
                  type="button"
                  role="radio"
                  aria-checked={!isStock}
                  disabled={busy}
                  onClick={() => {
                    pickStock(null);
                    set("stockSource", "external");
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded border text-sm ${!isStock ? "bg-blue-600 text-white border-blue-700" : "bg-white text-gray-800"}`}
                >
                  Stok dışı (hasta getirdi / başka klinik / eski kayıt)
                </button>
              </div>
              {!canStock && <p className="text-xs text-gray-500">Stoktan düşmek için stok işlemi yetkisi gerekir.</p>}
            </div>
          )}
        </Field>

        {!editing && isStock && (
          <Field label="İmplant stoğu" required group>
            <ImplantStockPicker value={stockChoice} onChange={pickStock} disabled={busy} />
          </Field>
        )}

        {stockLocked && implant && (
          <div className="text-sm p-3 border rounded bg-gray-50 space-y-1">
            <div>
              <span className="text-gray-600">Stok kaydı: </span>
              {implant.item_name ?? "—"} · {lotSerialText(implant.lot_text, implant.serial_text)}
              {implant.movement_ref_no ? ` · #${implant.movement_ref_no}` : ""}
            </div>
            <p className="text-xs text-gray-600">
              Stoktan düşülmüş kayıtta bu alanlar değiştirilemez; yanlışsa kaydı iptal edip yeniden girin.
            </p>
          </div>
        )}

        {!isStock && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Açıklama" required hint={<NoPatientTextHint />} className="sm:col-span-2">
              <input
                className={clinInput}
                value={values.sourceNote}
                maxLength={LIMITS.sourceNoteMax}
                placeholder="Örn. Hasta kendi implantını getirdi"
                disabled={busy}
                onChange={(e) => set("sourceNote", e.target.value)}
              />
            </Field>
            <Field label="Lot numarası">
              <input
                className={clinInput}
                value={values.lotText}
                maxLength={LIMITS.lotText}
                disabled={busy}
                onChange={(e) => set("lotText", e.target.value)}
              />
            </Field>
            <Field label="Seri numarası">
              <input
                className={clinInput}
                value={values.serialText}
                maxLength={LIMITS.lotText}
                disabled={busy}
                onChange={(e) => set("serialText", e.target.value)}
              />
            </Field>
          </div>
        )}

        <Field label="Diş numarası (FDI)" required group>
          <ToothPicker value={values.tooth} onChange={(t) => set("tooth", t)} occupied={occupied} disabled={busy} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="İmplant markası"
            required
            group
            hint={brandFromStock ? "Marka, stoktan düşülen karttan alınır." : undefined}
          >
            <select
              className={clinInput}
              value={values.brandId}
              disabled={busy || brandFromStock}
              onChange={(e) => set("brandId", e.target.value)}
            >
              <option value="">Marka seçin</option>
              {brandOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {flags.can_write && !newBrandOpen && (
              <button
                type="button"
                className="mt-1 text-sm text-blue-700 hover:underline min-h-[44px]"
                onClick={() => setNewBrandOpen(true)}
                disabled={busy}
              >
                + Yeni marka
              </button>
            )}
          </Field>
          <Field label="Model / seri">
            <input
              className={clinInput}
              value={values.model}
              maxLength={LIMITS.model}
              disabled={busy}
              onChange={(e) => set("model", e.target.value)}
            />
          </Field>
        </div>

        {newBrandOpen && (
          <div className="flex flex-wrap gap-2 items-end p-3 border rounded bg-gray-50">
            <Field label="Yeni marka adı" className="flex-1 min-w-[12rem]">
              <input
                className={clinInput}
                value={newBrandName}
                maxLength={LIMITS.brandName}
                disabled={brandSaving}
                onChange={(e) => setNewBrandName(e.target.value)}
              />
            </Field>
            <button type="button" className={clinPrimary} onClick={() => void saveBrand()} disabled={brandSaving}>
              {brandSaving ? SAVING_LABEL : "Markayı ekle"}
            </button>
            <button type="button" className={clinSecondary} onClick={() => setNewBrandOpen(false)} disabled={brandSaving}>
              Vazgeç
            </button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Çap (mm)" required group>
            <input
              className={clinInput}
              inputMode="decimal"
              value={values.diameter}
              disabled={busy}
              placeholder="4,0"
              onChange={(e) => set("diameter", e.target.value)}
            />
            <div className="flex flex-wrap gap-1 mt-1">
              {DIAMETER_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={busy}
                  onClick={() => set("diameter", c)}
                  className="px-2 min-h-[36px] text-xs rounded border bg-white hover:bg-blue-50"
                >
                  Ø {c}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Boy (mm)" required group>
            <input
              className={clinInput}
              inputMode="decimal"
              value={values.length}
              disabled={busy}
              placeholder="10"
              onChange={(e) => set("length", e.target.value)}
            />
            <div className="flex flex-wrap gap-1 mt-1">
              {LENGTH_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={busy}
                  onClick={() => set("length", c)}
                  className="px-2 min-h-[36px] text-xs rounded border bg-white hover:bg-blue-50"
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Yerleştirme torku (Ncm)">
            <input
              className={clinInput}
              inputMode="decimal"
              value={values.torque}
              disabled={busy}
              placeholder="35"
              onChange={(e) => set("torque", e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sonraki kontrol tarihi" group>
            <input
              type="date"
              className={clinInput}
              value={values.nextControlOn}
              min={values.placedOn || undefined}
              disabled={busy}
              onChange={(e) => set("nextControlOn", e.target.value)}
            />
            <div className="flex flex-wrap gap-1 mt-1">
              {[
                { label: "+3 ay", months: 3 },
                { label: "+6 ay", months: 6 },
                { label: "+1 yıl", months: 12 },
              ].map((c) => (
                <button
                  key={c.label}
                  type="button"
                  disabled={busy || !isDay(values.placedOn)}
                  onClick={() => set("nextControlOn", addMonths(values.placedOn, c.months))}
                  className="px-2 min-h-[36px] text-xs rounded border bg-white hover:bg-blue-50"
                >
                  {c.label}
                </button>
              ))}
              {values.nextControlOn && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => set("nextControlOn", "")}
                  className="px-2 min-h-[36px] text-xs rounded border bg-white hover:bg-gray-50"
                >
                  Temizle
                </button>
              )}
            </div>
          </Field>
          <Field label="Durum" required>
            <select
              className={clinInput}
              value={values.status}
              disabled={busy}
              onChange={(e) => set("status", e.target.value)}
            >
              {IMPLANT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {IMPLANT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Takip / işlem notları" hint={<NoPatientTextHint />}>
          <textarea
            className={clinInput}
            rows={3}
            value={values.notes}
            maxLength={LIMITS.notes}
            disabled={busy}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}
