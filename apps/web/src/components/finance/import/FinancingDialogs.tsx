"use client";

import { useEffect, useMemo, useState } from "react";
import { ErrorBox, Field, Modal, MoneyRow, buttonDanger, buttonPrimary, buttonSecondary, inputClass } from "@/components/finance/ui";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import {
  centsToInput,
  finFinancingCorrect,
  finFinancingLinkPatient,
  finFinancingRelease,
  finFinancingVoid,
  formatDay,
  formatTL,
  isDay,
  parseTL,
  searchKey,
  toFinanceError,
  type FinanceError,
  type FinancingJson,
} from "@/lib/finance";

type Done = (text: string) => Promise<void> | void;

function FormError({ text }: { text: string | null }) {
  return text ? <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{text}</div> : null;
}

function Buttons({ busy, label, onClose, danger }: { busy: boolean; label: string; onClose: () => void; danger?: boolean }) {
  return (
    <div className="flex gap-2">
      <button type="submit" className={danger ? buttonDanger : buttonPrimary} disabled={busy}>
        {busy ? "Kaydediliyor..." : label}
      </button>
      <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
        Vazgeç
      </button>
    </div>
  );
}

/** Legacy burganRelease (RT:122-124, BG:20): marks the block as released; writes no income and no expense. */
export function ReleaseDialog({
  row,
  today,
  onClose,
  onDone,
  onReload,
}: {
  row: FinancingJson;
  today: string;
  onClose: () => void;
  onDone: Done;
  onReload: () => void;
}) {
  const [date, setDate] = useState(today);
  const [confirmed, setConfirmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    if (!isDay(date) || date < row.txn_date || date > today) {
      return setFormError("Çözülme tarihi işlem tarihi ile bugün arasında olmalı.");
    }
    if (!confirmed) return setFormError("Onay kutusunu işaretleyin.");
    setBusy(true);
    try {
      const res = await finFinancingRelease({ p_id: row.id, p_version: row.version, p_date: date });
      await onDone(
        res.already_saved
          ? "Bloke çözülmesi zaten bu tarihle kayıtlı."
          : "Bloke çözüldü olarak işaretlendi. Brüt tahsilat ve gider tekrar yazılmadı. Bakiyeler bölümünde güncel kullanılabilir banka bakiyesini doğrulayın."
      );
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`${row.patient_name_raw} · bloke doğrulaması`} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <MoneyRow label="Blokedeki net" cents={row.net_cents} hint={`Tahmini çözülme: ${formatDay(row.expected_release)}`} />
        <Field label="Bankada çözülme tarihi">
          <input type="date" className={inputClass} min={row.txn_date} max={today} value={date} onChange={(e) => { setDate(e.target.value); setConfirmed(false); }} />
        </Field>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Net tutarın bankada kullanılabilir hale geldiğini doğruladım. Banka bakiyesini ayrıca güncelleyeceğim.
        </label>
        <FormError text={formError} />
        <ErrorBox error={error} onReload={onReload} />
        <Buttons busy={busy} label="Çözülmeyi kaydet" onClose={onClose} />
      </form>
    </Modal>
  );
}

export interface CorrectionPreset {
  gross_cents: number;
  commission_cents: number;
  kkdf_cents: number;
  bsmv_cents: number;
  blocked?: boolean;
  expected_release?: string | null;
}

/** fin_financing_correct (C7): the only way to change a locked financing fee entry. */
export function CorrectDialog({
  row,
  today,
  preset,
  onClose,
  onDone,
  onReload,
}: {
  row: FinancingJson;
  today: string;
  /** amounts read from a newer statement (E_FIN_CHANGED path) */
  preset?: CorrectionPreset;
  onClose: () => void;
  onDone: Done;
  onReload: () => void;
}) {
  const src = preset ?? row;
  const [gross, setGross] = useState(centsToInput(src.gross_cents));
  const [commission, setCommission] = useState(centsToInput(src.commission_cents));
  const [kkdf, setKkdf] = useState(centsToInput(src.kkdf_cents));
  const [bsmv, setBsmv] = useState(centsToInput(src.bsmv_cents));
  const [blocked, setBlocked] = useState(preset?.blocked ?? row.blocked);
  const [expected, setExpected] = useState((preset?.expected_release ?? row.expected_release) || "");
  const [released, setReleased] = useState(row.released_on ?? "");
  const [reason, setReason] = useState(preset ? "Banka dökümündeki güncel tutarlar." : "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    const g = parseTL(gross);
    const c = parseTL(commission, { allowZero: true });
    const k = parseTL(kkdf, { allowZero: true });
    const b = parseTL(bsmv, { allowZero: true });
    return { g, c, k, b };
  }, [gross, commission, kkdf, bsmv]);
  const fee =
    parsed.c.ok && parsed.k.ok && parsed.b.ok ? parsed.c.cents + parsed.k.cents + parsed.b.cents : null;
  const net = parsed.g.ok && fee !== null ? parsed.g.cents - fee : null;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const { g, c, k, b } = parsed;
    if (!g.ok) return setFormError(`Brüt: ${g.error}`);
    if (!c.ok) return setFormError(`Komisyon: ${c.error}`);
    if (!k.ok) return setFormError(`KKDF: ${k.error}`);
    if (!b.ok) return setFormError(`BSMV: ${b.error}`);
    const f = c.cents + k.cents + b.cents;
    if (f <= 0 || f >= g.cents) return setFormError("Kesintileri kontrol edin.");
    if (blocked && !isDay(expected)) return setFormError("Bloke için tahmini çözülme tarihi gerekli.");
    if (blocked && expected < row.txn_date) return setFormError("Bloke tarihi işlemden önce olamaz.");
    if (released && (!blocked || !isDay(released) || released < row.txn_date || released > today)) {
      return setFormError("Bloke kaydını ve çözülme tarihini kontrol edin.");
    }
    const r = reason.trim();
    if (r.length < 3 || r.length > 500) return setFormError("Gerekçe 3-500 karakter olmalı.");
    setBusy(true);
    try {
      const res = await finFinancingCorrect({
        p_id: row.id,
        p_version: row.version,
        p_gross_cents: g.cents,
        p_commission_cents: c.cents,
        p_kkdf_cents: k.cents,
        p_bsmv_cents: b.cents,
        p_blocked: blocked,
        p_expected_release: blocked ? expected : null,
        p_released_on: blocked && released ? released : null,
        p_reason: r,
      });
      await onDone(res.already_saved ? "Finansman zaten bu değerlerle kayıtlı." : "Finansman düzeltildi; kesinti kaydı güncellendi.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Finansmanı düzelt · ${row.patient_name_raw}`} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-gray-600">
          {formatDay(row.txn_date)} · {row.reference}. Kesinti kaydı yalnızca buradan değiştirilebilir; brüt tutar klinik
          Excel’indeki tahsilatın içindedir ve yeniden yazılmaz.
        </p>
        {preset && (
          <p className="text-amber-700">
            Dosyadaki tutarlar kayıtlı finansmandan farklı. Kayıtlı: brüt {formatTL(row.gross_cents)}, kesinti{" "}
            {formatTL(row.fee_cents)}.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Brüt (TL)"><input className={inputClass} inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} /></Field>
          <Field label="Komisyon (TL)"><input className={inputClass} inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} /></Field>
          <Field label="KKDF (TL)"><input className={inputClass} inputMode="decimal" value={kkdf} onChange={(e) => setKkdf(e.target.value)} /></Field>
          <Field label="BSMV (TL)"><input className={inputClass} inputMode="decimal" value={bsmv} onChange={(e) => setBsmv(e.target.value)} /></Field>
        </div>
        <p className="text-gray-700">
          Toplam kesinti: {formatTL(fee)} · Net: {formatTL(net)}
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} />
          Blokeli
        </label>
        {blocked && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Tahmini çözülme tarihi">
              <input type="date" className={inputClass} min={row.txn_date} value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
            <Field label="Çözülme tarihi (çözüldüyse)">
              <input type="date" className={inputClass} min={row.txn_date} max={today} value={released} onChange={(e) => setReleased(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Gerekçe">
          <textarea className={inputClass} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <FormError text={formError} />
        <ErrorBox error={error} onReload={onReload} />
        <Buttons busy={busy} label="Düzeltmeyi kaydet" onClose={onClose} />
      </form>
    </Modal>
  );
}

/** fin_financing_void: the fee leaves every total; the key stays so the line can never be imported again. */
export function VoidDialog({ row, onClose, onDone, onReload }: { row: FinancingJson; onClose: () => void; onDone: Done; onReload: () => void }) {
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const r = reason.trim();
    if (r.length < 3 || r.length > 500) return setFormError("Gerekçe 3-500 karakter olmalı.");
    setBusy(true);
    try {
      const res = await finFinancingVoid({ p_id: row.id, p_version: row.version, p_reason: r });
      await onDone(res.already_saved ? "Finansman zaten iptal edilmiş." : "Finansman iptal edildi; kesinti kaydı toplamlardan çıktı.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Finansmanı iptal et · ${row.patient_name_raw}`} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-gray-700">
          Yanlış dosya veya yanlış gün için kullanın. Kesinti ödemesi iptal edilir ve kayıt kapatılır; brüt tahsilat klinik
          Excel kaydında kalır. İptal edilen finansman satırı yeniden aktarılamaz.
        </p>
        <Field label="Gerekçe">
          <textarea className={inputClass} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <FormError text={formError} />
        <ErrorBox error={error} onReload={onReload} />
        <Buttons busy={busy} label="İptal et" onClose={onClose} danger />
      </form>
    </Modal>
  );
}

/** fin_financing_link_patient: informational link to a patient card (or unlink). */
export function LinkPatientDialog({ row, onClose, onDone, onReload }: { row: FinancingJson; onClose: () => void; onDone: Done; onReload: () => void }) {
  const clinicId = useAuthStore((s) => s.user?.clinic_id ?? null);
  const [patients, setPatients] = useState<{ id: string; full_name: string }[] | null>(null);
  const [query, setQuery] = useState(row.patient_name_raw);
  const [selected, setSelected] = useState(row.patient_id ?? "");
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clinicId) return;
    let alive = true;
    // The clinic's active patients, filtered in the browser so no name travels in a URL. Keyset pages by id until an
    // empty page: PostgREST's max_rows (1000 on hosted projects) would otherwise cut the list silently.
    (async () => {
      const client = createClient();
      const out: { id: string; full_name: string }[] = [];
      let last: string | null = null;
      for (;;) {
        let q = client.from("patients").select("id,full_name").eq("clinic_id", clinicId).eq("is_active", true).order("id", { ascending: true }).limit(1000);
        if (last) q = q.gt("id", last);
        const { data, error: err } = await q;
        if (!alive) return;
        if (err) return setError(toFinanceError(err));
        const page = (data ?? []) as { id: string; full_name: string }[];
        if (page.length === 0) break;
        out.push(...page);
        last = page[page.length - 1].id;
      }
      setPatients(out);
    })();
    return () => {
      alive = false;
    };
  }, [clinicId]);

  const matches = useMemo(() => {
    const q = searchKey(query);
    const list = patients ?? [];
    return (q ? list.filter((p) => searchKey(p.full_name).includes(q)) : list).slice(0, 50);
  }, [patients, query]);

  const save = async (patientId: string | null) => {
    setError(null);
    setBusy(true);
    try {
      const res = await finFinancingLinkPatient({ p_id: row.id, p_version: row.version, p_patient_id: patientId });
      await onDone(res.already_saved ? "Bağlantı değişmedi." : patientId ? "Hasta kartı bağlandı." : "Hasta bağlantısı kaldırıldı.");
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Hasta kartına bağla" onClose={onClose} busy={busy}>
      <div className="space-y-4 text-sm">
        <p className="text-gray-600">Dökümdeki ad: {row.patient_name_raw}</p>
        <Field label="Hasta ara">
          <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        {!patients && !error && <p className="text-gray-500">Hastalar yükleniyor...</p>}
        {patients && (
          <div className="max-h-64 overflow-y-auto border rounded divide-y">
            {matches.length === 0 && <p className="p-2 text-gray-500">Eşleşen hasta yok.</p>}
            {matches.map((p) => (
              <label key={p.id} className="flex items-center gap-2 p-2 cursor-pointer hover:bg-gray-50">
                <input type="radio" name="patient" checked={selected === p.id} onChange={() => setSelected(p.id)} />
                {p.full_name}
              </label>
            ))}
          </div>
        )}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonPrimary} disabled={busy || !selected} onClick={() => save(selected)}>
            Bağla
          </button>
          {row.patient_id && (
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => save(null)}>
              Bağlantıyı kaldır
            </button>
          )}
          <button type="button" className={buttonSecondary} disabled={busy} onClick={onClose}>
            Vazgeç
          </button>
        </div>
      </div>
    </Modal>
  );
}
