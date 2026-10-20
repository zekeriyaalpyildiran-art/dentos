"use client";

// Lab job form (spec p9_clinical §7.7): one atomic clin_lab_order_save call replaces the two inserts and the manual
// rollback of the old page. Edit of an arrived / delivered / cancelled job changes the notes only.
// A doctor (without finance access) opens and edits jobs only under their own doctor record (0036: the server refuses
// any other doctor with CL_LAB_OWN_DOCTOR), so for them the doctor is fixed text, not a choice.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PatientPicker, type PatientRef } from "@/components/stock/PatientPicker";
import { useAuthStore } from "@/lib/store";
import { LAB_NO_DOCTOR_TEXT, labOwnOnly, ownDoctor } from "@/lib/clinical/permissions";
import {
  ClinicalError,
  clinLabOrderSave,
  clinSaveLab,
  listDoctors,
  listLabs,
  listPatientPlans,
  newKey,
  toClinicalError,
  type ClinicalFlags,
  type DoctorRef,
  type LabItemInput,
  type LabOrderItemJson,
  type LabOrderJson,
  type LabRow,
  type TreatmentPlanRef,
} from "@/lib/clinical/rpc";
import { LAB_ITEM_TYPES, LAB_MATERIALS, LIMITS } from "@/lib/clinical/codes";
import { isDay } from "@/lib/clinical/dates";
import { ErrorBox, Field, NoPatientTextHint, SAVING_LABEL, clinInput, clinPrimary, clinSecondary } from "./ui";

interface ItemDraft {
  item_type: string;
  tooth_number: string;
  material: string;
  color_code: string;
  quantity: string;
  description: string;
}

const emptyItem = (): ItemDraft => ({
  item_type: "crown",
  tooth_number: "",
  material: "zirconium",
  color_code: "",
  quantity: "1",
  description: "",
});

function fromItem(i: LabOrderItemJson): ItemDraft {
  return {
    item_type: i.item_type,
    tooth_number: i.tooth_number ?? "",
    material: i.material ?? "",
    color_code: i.color_code ?? "",
    quantity: String(i.quantity ?? 1),
    description: i.description ?? "",
  };
}

const LOCKED_STATUSES = ["ready", "delivered", "cancelled"];

const TEXT = {
  fields: "Hasta, hekim, laboratuvar ve beklenen dönüş tarihi zorunludur.",
  items: "Her kalem için tür ve 1–99 adet girin (en fazla 30 kalem).",
  dates: "Dönüş, geliş veya teslim tarihi gönderimden önce olamaz.",
  future: "Gönderim, geliş ve teslim tarihleri bugünden sonra olamaz.",
  notes: "Not en fazla 4000 karakter olabilir.",
  labName: "Laboratuvar adı 1–120 karakter olmalı.",
  noDoctor: LAB_NO_DOCTOR_TEXT,
};

function toPayload(items: ItemDraft[]): LabItemInput[] {
  return items.map((i) => ({
    item_type: i.item_type,
    tooth_number: i.tooth_number.trim(),
    material: i.material,
    color_code: i.color_code.trim(),
    quantity: Number(i.quantity),
    description: i.description.trim(),
  }));
}

function itemProblem(items: ItemDraft[]): boolean {
  if (items.length < 1 || items.length > LIMITS.labItemsMax) return true;
  return items.some((i) => {
    const q = Number(i.quantity);
    return (
      !LAB_ITEM_TYPES.some((t) => t.value === i.item_type) ||
      !/^\d+$/.test(i.quantity.trim()) ||
      q < 1 ||
      q > 99 ||
      i.tooth_number.trim().length > LIMITS.labItemTooth ||
      !/^[0-9 ,/-]*$/.test(i.tooth_number.trim()) ||
      i.color_code.trim().length > LIMITS.labItemColor ||
      i.description.trim().length > LIMITS.labItemDescription
    );
  });
}

export function LabForm({
  order,
  items: initialItems,
  today,
  onSaved,
  cancelHref,
  flags,
}: {
  /** Edit mode when set. */
  order?: LabOrderJson | null;
  items?: LabOrderItemJson[];
  today: string;
  onSaved: (order: LabOrderJson) => void;
  cancelHref: string;
  /** The server's flags when the page has them (edit): lab_own_only wins over the role. */
  flags?: ClinicalFlags | null;
}) {
  const editing = !!order;
  const locked = !!order && LOCKED_STATUSES.includes(order.status);
  const patientLocked = !!order && order.status !== "draft";
  // An old locked order without a lab may get one (server CL_LAB_LOCKED allows it); every other field stays fixed.
  const labOpen = !locked || !order?.lab_id;

  const [patient, setPatient] = useState<PatientRef | null>(
    order ? { id: order.patient_id, full_name: order.patient_name } : null
  );
  const [doctorId, setDoctorId] = useState(order?.doctor_id ?? "");
  const [labId, setLabId] = useState(order?.lab_id ?? "");
  const [planId, setPlanId] = useState(order?.treatment_plan_id ?? "");
  const [dueDate, setDueDate] = useState(order?.due_date ?? "");
  const [sentOn, setSentOn] = useState(today);
  const [notes, setNotes] = useState(order?.notes ?? "");
  // A locked old order without items keeps none (adding one would be an item change, refused with CL_LAB_LOCKED).
  const [items, setItems] = useState<ItemDraft[]>(
    initialItems && initialItems.length > 0 ? initialItems.map(fromItem) : locked ? [] : [emptyItem()]
  );
  // Stored items as the form would send them unchanged: unchanged items skip the item rules (old orders may
  // predate them; the server compares them the same way with clin__lab_items_norm).
  const initialPayloadJson = useMemo(
    () => JSON.stringify(toPayload(initialItems && initialItems.length > 0 ? initialItems.map(fromItem) : [])),
    [initialItems]
  );

  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [doctorsLoaded, setDoctorsLoaded] = useState(false);
  const activeDoctors = useMemo(() => doctors.filter((d) => d.active), [doctors]);
  const user = useAuthStore((s) => s.user);
  const ownOnly = labOwnOnly(user, flags);
  const mine = useMemo(() => ownDoctor(doctors, user), [doctors, user]);
  const [labs, setLabs] = useState<LabRow[]>([]);
  const [plans, setPlans] = useState<TreatmentPlanRef[]>([]);
  const [refError, setRefError] = useState<ClinicalError | null>(null);

  const [saving, setSaving] = useState<"draft" | "submit" | null>(null);
  const savingRef = useRef(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const clientId = useRef(order?.id ?? newKey());

  const [newLabOpen, setNewLabOpen] = useState(false);
  const [newLabName, setNewLabName] = useState("");
  const [labSaving, setLabSaving] = useState(false);
  const labKey = useRef(newKey());

  useEffect(() => {
    let cancelled = false;
    Promise.all([listDoctors(), listLabs()])
      .then(([d, l]) => {
        if (cancelled) return;
        setDoctors(d);
        setDoctorsLoaded(true);
        setLabs(l);
      })
      .catch((err) => {
        if (!cancelled) setRefError(toClinicalError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A doctor's new job is always their own.
  useEffect(() => {
    if (ownOnly && !editing && mine && !doctorId) setDoctorId(mine.id);
  }, [ownOnly, editing, mine, doctorId]);
  const missingOwnDoctor = ownOnly && !editing && doctorsLoaded && !mine;

  const patientId = patient?.id ?? "";
  useEffect(() => {
    if (!patientId) {
      setPlans([]);
      return;
    }
    let cancelled = false;
    listPatientPlans(patientId)
      .then((p) => {
        if (!cancelled) setPlans(p);
      })
      .catch(() => {
        if (!cancelled) setPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const labOptions = useMemo(() => {
    const active = labs.filter((l) => l.is_active);
    if (order?.lab_id && !active.some((l) => l.id === order.lab_id)) {
      active.unshift({
        id: order.lab_id,
        name: `${order.lab_name ?? "Laboratuvar"} (pasif)`,
        phone: "",
        email: "",
        note: "",
        fin_counterparty_id: null,
        is_active: false,
        version: 0,
      });
    }
    return active;
  }, [labs, order]);

  const updateItem = (index: number, field: keyof ItemDraft, value: string) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)));

  const submit = async (mode: "draft" | "submit") => {
    if (savingRef.current) return;
    if (missingOwnDoctor) {
      setError(new ClinicalError(TEXT.noDoctor, null, null, null));
      return;
    }
    if (!patientId || !doctorId || !labId || !dueDate) {
      setError(new ClinicalError(TEXT.fields, null, null, null));
      return;
    }
    if (!isDay(dueDate)) {
      setError(new ClinicalError(TEXT.fields, null, null, null));
      return;
    }
    const payload = toPayload(items);
    const itemsUnchanged = editing && JSON.stringify(payload) === initialPayloadJson;
    if (!itemsUnchanged && itemProblem(items)) {
      setError(new ClinicalError(TEXT.items, null, null, null));
      return;
    }
    if (notes.length > LIMITS.notes) {
      setError(new ClinicalError(TEXT.notes, null, null, null));
      return;
    }
    if (!editing && mode === "submit") {
      if (!isDay(sentOn) || sentOn > today) {
        setError(new ClinicalError(TEXT.future, null, null, null));
        return;
      }
      if (sentOn > dueDate) {
        setError(new ClinicalError(TEXT.dates, null, null, null));
        return;
      }
    }
    // CR:21 on change only, as the server: a back-filled sent_on may be later than an old due date.
    if (editing && order && dueDate !== order.due_date && order.sent_on && dueDate < order.sent_on) {
      setError(new ClinicalError(TEXT.dates, null, null, null));
      return;
    }
    savingRef.current = true;
    setSaving(mode);
    setError(null);
    try {
      const r = await clinLabOrderSave({
        p_id: clientId.current,
        p_version: order ? order.version : null,
        p_patient_id: patientId,
        p_doctor_id: doctorId,
        p_lab_id: labId,
        p_due_date: dueDate,
        p_notes: notes.trim(),
        p_items: payload,
        p_treatment_plan_id: planId || null,
        p_submit: !editing && mode === "submit",
        p_sent_on: !editing && mode === "submit" ? sentOn : null,
      });
      onSaved(r.order);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  };

  const saveLab = async () => {
    const name = newLabName.trim();
    if (name.length < 1 || name.length > LIMITS.labName) {
      setError(new ClinicalError(TEXT.labName, null, null, null));
      return;
    }
    setLabSaving(true);
    setError(null);
    try {
      const r = await clinSaveLab({
        p_id: labKey.current,
        p_version: null,
        p_name: name,
        p_phone: "",
        p_email: "",
        p_note: "",
        p_fin_counterparty_id: null,
        p_is_active: true,
      });
      labKey.current = newKey();
      setLabs((prev) => [...prev.filter((l) => l.id !== r.lab.id), r.lab].sort((a, b) => a.name.localeCompare(b.name, "tr")));
      setLabId(r.lab.id);
      setNewLabName("");
      setNewLabOpen(false);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setLabSaving(false);
    }
  };

  const busy = !!saving || labSaving;
  const fieldsDisabled = busy || locked;

  return (
    <div className="space-y-6 text-gray-900">
      <ErrorBox error={refError} />
      {locked && (
        <p className="p-3 rounded border border-amber-200 bg-amber-50 text-amber-900 text-sm">
          Kliniğe gelmiş, teslim edilmiş veya iptal edilmiş işte yalnızca not değiştirilebilir.
        </p>
      )}

      <div className="bg-white rounded-lg shadow p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Hasta" required group>
          {patientLocked ? (
            <div className="p-2 min-h-[44px] border rounded bg-gray-50 font-medium flex items-center">{patient?.full_name}</div>
          ) : (
            <PatientPicker
              value={patient}
              onChange={(p) => {
                setPatient(p);
                setPlanId("");
              }}
              disabled={busy}
            />
          )}
        </Field>
        {ownOnly ? (
          <Field label="Hekim" required group>
            {missingOwnDoctor ? (
              <p className="p-2 min-h-[44px] rounded border border-amber-200 bg-amber-50 text-amber-900 text-sm">{TEXT.noDoctor}</p>
            ) : (
              <div className="p-2 min-h-[44px] border rounded bg-gray-50 font-medium flex items-center">
                {order?.doctor_name || mine?.name || "…"}
              </div>
            )}
          </Field>
        ) : (
          <Field label="Hekim" required>
            <select className={clinInput} value={doctorId} disabled={fieldsDisabled} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">Seçin</option>
              {doctorId && !activeDoctors.some((d) => d.id === doctorId) && (
                <option value={doctorId}>
                  {order?.doctor_name || doctors.find((d) => d.id === doctorId)?.name || "Seçili hekim"}
                  {doctors.some((d) => d.id === doctorId && !d.active) ? " (pasif)" : ""}
                </option>
              )}
              {activeDoctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Laboratuvar" required group>
          <select
            className={clinInput}
            aria-label="Laboratuvar"
            value={labId}
            disabled={busy || !labOpen}
            onChange={(e) => setLabId(e.target.value)}
          >
            <option value="">Seçin</option>
            {labOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {labOpen && !newLabOpen && (
            <button
              type="button"
              className="mt-1 text-sm text-blue-700 hover:underline min-h-[44px]"
              onClick={() => setNewLabOpen(true)}
              disabled={busy}
            >
              + Yeni laboratuvar
            </button>
          )}
          {newLabOpen && (
            <div className="mt-2 flex flex-wrap gap-2 items-end p-3 border rounded bg-gray-50">
              <input
                className={`${clinInput} flex-1 min-w-[10rem]`}
                aria-label="Yeni laboratuvar adı"
                placeholder="Laboratuvar adı"
                value={newLabName}
                maxLength={LIMITS.labName}
                disabled={labSaving}
                onChange={(e) => setNewLabName(e.target.value)}
              />
              <button type="button" className={clinPrimary} onClick={() => void saveLab()} disabled={labSaving}>
                {labSaving ? SAVING_LABEL : "Ekle"}
              </button>
              <button type="button" className={clinSecondary} onClick={() => setNewLabOpen(false)} disabled={labSaving}>
                Vazgeç
              </button>
            </div>
          )}
        </Field>
        <Field label="Tedavi planı">
          <select className={clinInput} value={planId} disabled={fieldsDisabled || !patientId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Seçilmedi</option>
            {planId && !plans.some((p) => p.id === planId) && <option value={planId}>Seçili plan</option>}
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Beklenen dönüş" required>
          <input type="date" className={clinInput} value={dueDate} disabled={fieldsDisabled} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        {!editing && (
          <Field label="Gönderim tarihi" hint="“Laboratuvara gönderildi” ile kaydederken kullanılır.">
            <input type="date" className={clinInput} value={sentOn} max={today} disabled={busy} onChange={(e) => setSentOn(e.target.value)} />
          </Field>
        )}
        <Field label="Notlar" hint={<NoPatientTextHint />} className="md:col-span-2">
          <textarea className={clinInput} rows={3} maxLength={LIMITS.notes} value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      <div className="bg-white rounded-lg shadow p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Kalemler</h2>
          {!locked && (
            <button
              type="button"
              onClick={() => setItems((prev) => (prev.length >= LIMITS.labItemsMax ? prev : [...prev, emptyItem()]))}
              disabled={busy || items.length >= LIMITS.labItemsMax}
              className={clinSecondary}
            >
              + Kalem ekle
            </button>
          )}
        </div>
        {items.map((item, index) => (
          <div key={index} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end border-t pt-4">
            <Field label="Tür">
              <select className={clinInput} value={item.item_type} disabled={fieldsDisabled} onChange={(e) => updateItem(index, "item_type", e.target.value)}>
                {LAB_ITEM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Diş No">
              <input
                className={clinInput}
                value={item.tooth_number}
                maxLength={LIMITS.labItemTooth}
                placeholder="16"
                disabled={fieldsDisabled}
                onChange={(e) => updateItem(index, "tooth_number", e.target.value)}
              />
            </Field>
            <Field label="Malzeme">
              <select className={clinInput} value={item.material} disabled={fieldsDisabled} onChange={(e) => updateItem(index, "material", e.target.value)}>
                <option value="">Seçilmedi</option>
                {LAB_MATERIALS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Renk">
              <input
                className={clinInput}
                value={item.color_code}
                maxLength={LIMITS.labItemColor}
                placeholder="A2"
                disabled={fieldsDisabled}
                onChange={(e) => updateItem(index, "color_code", e.target.value)}
              />
            </Field>
            <Field label="Adet">
              <input
                className={clinInput}
                inputMode="numeric"
                value={item.quantity}
                disabled={fieldsDisabled}
                onChange={(e) => updateItem(index, "quantity", e.target.value.replace(/\D/g, "").slice(0, 2))}
              />
            </Field>
            <div>
              {!locked && (
                <button
                  type="button"
                  onClick={() => setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}
                  disabled={busy || items.length === 1}
                  className="w-full px-3 min-h-[44px] text-sm border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-40"
                >
                  Kaldır
                </button>
              )}
            </div>
            <Field label="Açıklama" className="col-span-2 md:col-span-6">
              <input
                className={clinInput}
                value={item.description}
                maxLength={LIMITS.labItemDescription}
                disabled={fieldsDisabled}
                onChange={(e) => updateItem(index, "description", e.target.value)}
              />
            </Field>
          </div>
        ))}
      </div>

      <ErrorBox error={error} />
      {error?.key === "CL_ALREADY_SAVED_CHANGED" && (
        <p className="text-sm">
          <Link href={`/lab/${clientId.current}`} className="text-blue-700 hover:underline">
            Kaydedilen siparişi aç
          </Link>
        </p>
      )}
      <div className="flex flex-col-reverse sm:flex-row gap-3">
        <Link href={cancelHref} className={`${clinSecondary} inline-flex items-center justify-center`}>
          Vazgeç
        </Link>
        {editing ? (
          <button type="button" className={clinPrimary} onClick={() => void submit("draft")} disabled={busy}>
            {saving ? SAVING_LABEL : locked ? "Notu kaydet" : "Kaydet"}
          </button>
        ) : (
          <>
            <button type="button" className={clinSecondary} onClick={() => void submit("draft")} disabled={busy}>
              {saving === "draft" ? SAVING_LABEL : "Taslak kaydet"}
            </button>
            <button type="button" className={clinPrimary} onClick={() => void submit("submit")} disabled={busy}>
              {saving === "submit" ? SAVING_LABEL : "Kaydet ve laboratuvara gönderildi işaretle"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
