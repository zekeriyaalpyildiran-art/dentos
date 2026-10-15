"use client";

// Laboratuvarlar (spec p9_clinical §7.9): directory plus the "Lab maliyeti ve finans" setting. The payable switch
// is OFF by default and only a `finance` holder can change it (owner decision D2).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import {
  ClinicalError,
  NO_FLAGS,
  clinSaveLab,
  clinSaveSettings,
  clinSettings,
  countOpenOrdersByLab,
  listLabCounterparties,
  listLabs,
  newKey,
  toClinicalError,
  type ClinicalFlags,
  type ClinicalSettingsJson,
  type LabRow,
} from "@/lib/clinical/rpc";
import { LIMITS } from "@/lib/clinical/codes";
import { formatDateTime } from "@/lib/clinical/dates";
import {
  ClinicalNotice,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  NoPatientTextHint,
  SAVING_LABEL,
  Sheet,
  Toast,
  clinInput,
  clinPrimary,
  clinSecondary,
} from "@/components/clinical/ui";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function LabDialog({
  lab,
  flags,
  onClose,
  onSaved,
}: {
  lab: LabRow | null;
  flags: ClinicalFlags;
  onClose: () => void;
  onSaved: (lab: LabRow) => void;
}) {
  const [name, setName] = useState(lab?.name ?? "");
  const [phone, setPhone] = useState(lab?.phone ?? "");
  const [email, setEmail] = useState(lab?.email ?? "");
  const [note, setNote] = useState(lab?.note ?? "");
  const [active, setActive] = useState(lab?.is_active ?? true);
  const [counterpartyId, setCounterpartyId] = useState(lab?.fin_counterparty_id ?? "");
  const [counterparties, setCounterparties] = useState<{ id: string; name: string; is_active: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);
  const key = useRef(lab?.id ?? newKey());
  // A 'finance' holder without clinical write rights may change only the finance link of an existing lab
  // (clin_save_lab sends every other field back unchanged; the server refuses any other change with CL_WRITE).
  const linkOnly = !flags.can_write && flags.can_finance && !!lab;
  const fieldsDisabled = busy || linkOnly;

  useEffect(() => {
    if (!flags.can_finance) return;
    listLabCounterparties()
      .then(setCounterparties)
      .catch(() => setCounterparties([]));
  }, [flags.can_finance]);

  const submit = async () => {
    if (linkOnly && lab) {
      setBusy(true);
      setError(null);
      try {
        const r = await clinSaveLab({
          p_id: lab.id,
          p_version: lab.version,
          p_name: lab.name,
          p_phone: lab.phone,
          p_email: lab.email,
          p_note: lab.note,
          p_fin_counterparty_id: counterpartyId || null,
          p_is_active: lab.is_active,
        });
        onSaved(r.lab);
      } catch (err) {
        setError(toClinicalError(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    const n = name.trim();
    if (n.length < 1 || n.length > LIMITS.labName) {
      setError(new ClinicalError("Laboratuvar adı 1–120 karakter olmalı.", null, null, null));
      return;
    }
    const p = phone.trim();
    const e = email.trim();
    if (
      p.length > LIMITS.labPhone ||
      !/^[0-9 +()-]*$/.test(p) ||
      e.length > LIMITS.labEmail ||
      (e !== "" && !EMAIL_RE.test(e)) ||
      note.trim().length > LIMITS.labNote
    ) {
      setError(new ClinicalError("Telefon, e-posta ve not alanlarını kontrol edin.", null, null, null));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await clinSaveLab({
        p_id: key.current,
        p_version: lab ? lab.version : null,
        p_name: n,
        p_phone: p,
        p_email: e,
        p_note: note.trim(),
        // Non-finance editors send the stored link unchanged (§5.2).
        p_fin_counterparty_id: flags.can_finance ? counterpartyId || null : lab?.fin_counterparty_id ?? null,
        p_is_active: active,
      });
      onSaved(r.lab);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={lab ? "Laboratuvarı düzenle" : "Laboratuvar ekle"}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="space-y-2">
          <ErrorBox error={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={clinSecondary} onClick={onClose} disabled={busy}>
              Vazgeç
            </button>
            <button type="button" className={clinPrimary} onClick={() => void submit()} disabled={busy}>
              {busy ? SAVING_LABEL : "Kaydet"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {linkOnly && (
          <p className="text-sm text-gray-600">Finans yetkisiyle yalnızca finans kaydı bağlantısı değiştirilebilir.</p>
        )}
        <Field label="Laboratuvar adı" required>
          <input className={clinInput} value={name} maxLength={LIMITS.labName} disabled={fieldsDisabled} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Telefon">
            <input
              className={clinInput}
              inputMode="tel"
              value={phone}
              maxLength={LIMITS.labPhone}
              disabled={fieldsDisabled}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Field label="E-posta">
            <input
              className={clinInput}
              type="email"
              value={email}
              maxLength={LIMITS.labEmail}
              disabled={fieldsDisabled}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Not" hint={<NoPatientTextHint />}>
          <textarea className={clinInput} rows={2} value={note} maxLength={LIMITS.labNote} disabled={fieldsDisabled} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {flags.can_finance ? (
          <Field label="Finans kaydı" hint="Lab maliyeti finansa borç olarak işlenirken bu kişi / kurum kullanılır.">
            <select className={clinInput} value={counterpartyId} disabled={busy} onChange={(e) => setCounterpartyId(e.target.value)}>
              <option value="">Bağlantı yok</option>
              {counterpartyId && !counterparties.some((c) => c.id === counterpartyId) && (
                <option value={counterpartyId}>Seçili kayıt</option>
              )}
              {counterparties
                .filter((c) => c.is_active || c.id === counterpartyId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : (
          <p className="text-sm text-gray-600">Finans bağlantısı: {lab?.fin_counterparty_id ? "var" : "yok"}</p>
        )}
        <label className="inline-flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" className="h-5 w-5" checked={active} disabled={fieldsDisabled} onChange={(e) => setActive(e.target.checked)} />
          Etkin (yeni işlerde seçilebilir)
        </label>
      </div>
    </Sheet>
  );
}

function SettingsCard({
  settings,
  flags,
  onSaved,
}: {
  settings: ClinicalSettingsJson;
  flags: ClinicalFlags;
  onSaved: (s: ClinicalSettingsJson) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClinicalError | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await clinSaveSettings(settings.version, !settings.lab_cost_payable_enabled);
      onSaved(r.settings);
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-lg shadow p-4 md:p-6 space-y-3 text-gray-900">
      <h2 className="text-lg font-semibold">Lab maliyeti ve finans</h2>
      <label className="inline-flex items-center gap-3 min-h-[44px]">
        <input
          type="checkbox"
          role="switch"
          className="h-5 w-5"
          checked={settings.lab_cost_payable_enabled}
          disabled={!flags.can_finance || busy}
          onChange={() => void toggle()}
        />
        <span className="font-medium">Lab maliyetinden finans borcu oluştur</span>
        {busy && <span className="text-sm text-gray-500">{SAVING_LABEL}</span>}
      </label>
      {!flags.can_finance && <p className="text-sm text-gray-600">Bu ayarı finans yetkilisi değiştirir.</p>}
      <p className="text-sm text-gray-600">
        Kapalıyken lab maliyeti yalnızca bilgi olarak saklanır ve finans ekranına hiçbir kayıt düşmez. Açıldığında finans
        yetkilisi maliyeti girdiğinde (veya onayladığında) “Laboratuvar” kategorisinde borç kaydı oluşur. Hasta adı finans
        kaydına yazılmaz.
      </p>
      {settings.updated_at && settings.version > 0 && (
        <p className="text-xs text-gray-500">
          Son değişiklik: {formatDateTime(settings.updated_at)}
          {settings.updated_by_name ? ` · ${settings.updated_by_name}` : ""}
        </p>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

export default function LabsPage() {
  const user = useAuthStore((s) => s.user);
  const [labs, setLabs] = useState<LabRow[]>([]);
  const [openCounts, setOpenCounts] = useState<Map<string, number> | null>(null);
  const [flags, setFlags] = useState<ClinicalFlags>(NO_FLAGS);
  const [settings, setSettings] = useState<ClinicalSettingsJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClinicalError | null>(null);
  const [rowError, setRowError] = useState<ClinicalError | null>(null);
  const [editing, setEditing] = useState<LabRow | "new" | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, list] = await Promise.all([clinSettings(), listLabs()]);
      setFlags(s.flags ?? NO_FLAGS);
      setSettings(s.settings);
      setLabs(list);
      setError(null);
      countOpenOrdersByLab()
        .then(setOpenCounts)
        .catch(() => setOpenCounts(null));
    } catch (err) {
      setError(toClinicalError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.clinic_id) void load();
  }, [load, user?.clinic_id]);

  const toggle = async (lab: LabRow) => {
    setTogglingId(lab.id);
    setRowError(null);
    try {
      const r = await clinSaveLab({
        p_id: lab.id,
        p_version: lab.version,
        p_name: lab.name,
        p_phone: lab.phone,
        p_email: lab.email,
        p_note: lab.note,
        p_fin_counterparty_id: lab.fin_counterparty_id,
        p_is_active: !lab.is_active,
      });
      setLabs((prev) => prev.map((x) => (x.id === lab.id ? { ...x, ...r.lab } : x)));
    } catch (err) {
      setRowError(toClinicalError(err));
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900 max-w-5xl">
      <Link href="/lab" className="text-blue-700 hover:underline text-sm">
        ← Laboratuvar işleri
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold">Laboratuvarlar</h1>
        {flags.can_write && (
          <button type="button" className={clinPrimary} onClick={() => setEditing("new")}>
            Laboratuvar ekle
          </button>
        )}
      </div>

      <ClinicalNotice error={error} />
      <ErrorBox error={rowError} onReload={() => void load()} />

      {loading ? (
        <Loading />
      ) : (
        <>
          {labs.length === 0 && !error ? (
            <EmptyState title="Henüz laboratuvar tanımlı değil">
              {flags.can_write ? "“Laboratuvar ekle” ile ilk laboratuvarı tanımlayın." : null}
            </EmptyState>
          ) : (
            <ul className="bg-white rounded-lg shadow divide-y">
              {labs.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-[12rem]">
                    <div className={`font-semibold ${l.is_active ? "" : "text-gray-500"}`}>
                      {l.name}
                      {!l.is_active && <span className="font-normal"> (pasif)</span>}
                    </div>
                    <div className="text-xs text-gray-600 space-x-2">
                      {l.phone && (
                        <a href={`tel:${l.phone.replace(/[^0-9+]/g, "")}`} className="text-blue-700 hover:underline">
                          {l.phone}
                        </a>
                      )}
                      {l.email && <span>{l.email}</span>}
                      {openCounts && <span>{openCounts.get(l.id) ?? 0} açık iş</span>}
                    </div>
                  </div>
                  {flags.can_write ? (
                    <>
                      <label className="inline-flex items-center gap-2 min-h-[44px] text-sm">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={l.is_active}
                          disabled={togglingId === l.id}
                          onChange={() => void toggle(l)}
                        />
                        Etkin
                      </label>
                      <button type="button" className={clinSecondary} onClick={() => setEditing(l)}>
                        Düzenle
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-sm text-gray-600">{l.is_active ? "Etkin" : "Pasif"}</span>
                      {flags.can_finance && (
                        <button type="button" className={clinSecondary} onClick={() => setEditing(l)}>
                          Finans bağlantısı
                        </button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {settings && (flags.can_view_lab_costs || flags.can_finance) && (
            <SettingsCard
              settings={settings}
              flags={flags}
              onSaved={(s) => {
                setSettings(s);
                setToast(s.lab_cost_payable_enabled ? "Lab maliyetinden finans borcu oluşturma açıldı." : "Ayar kapatıldı.");
              }}
            />
          )}
        </>
      )}

      {editing && (
        <LabDialog
          lab={editing === "new" ? null : editing}
          flags={flags}
          onClose={() => setEditing(null)}
          onSaved={(lab) => {
            setEditing(null);
            setToast("Laboratuvar kaydedildi.");
            setLabs((prev) => [...prev.filter((x) => x.id !== lab.id), lab].sort((a, b) => a.name.localeCompare(b.name, "tr")));
          }}
        />
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
