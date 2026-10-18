"use client";

import { useState } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import { HakedisTabs, useHkReference } from "@/components/finance/HakedisParts";
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
  UUID_RE,
  centsToInput,
  formatMonth,
  formatTL,
  isMonth,
  newId,
  parseTL,
  toFinanceError,
  type FinanceError,
} from "@/lib/finance";
import {
  HK_KINDS,
  HK_METHODS,
  HK_SEGMENTS,
  KIND_LABELS,
  METHOD_LABELS,
  RULE_FIELDS,
  SEGMENT_LABELS,
  bpToInput,
  finHkSaveRule,
  formatBp,
  monthKey,
  parsePercent,
  ruleActiveIn,
  validateRule,
  type HkKind,
  type HkMethod,
  type HkReferenceJson,
  type HkRuleJson,
  type HkSegment,
} from "@/lib/hakedis";

export default function FinanceHakedisRulesPage() {
  return (
    <FinanceShell title="Hakediş kuralları">
      <RulesList />
    </FinanceShell>
  );
}

type DialogState = { record: HkRuleJson | null; payeeUserId?: string };

/** Rules grouped by payee (fin_hk_reference().rules), with the create / edit dialog for 'finance' holders. */
function RulesList() {
  const canWrite = useCanWriteFinance();
  const ref = useHkReference();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!ref.data) return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  const data = ref.data;

  const groups = new Map<string, { name: string; active: boolean; rules: HkRuleJson[] }>();
  for (const r of data.rules) {
    const g = groups.get(r.payee_user_id) ?? { name: r.payee_name, active: r.payee_is_active, rules: [] };
    g.rules.push(r);
    groups.set(r.payee_user_id, g);
  }
  const withoutRules = data.payees.filter((p) => p.is_active && !groups.has(p.user_id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HakedisTabs />
        {canWrite && (
          <button type="button" className={buttonPrimary} onClick={() => setDialog({ record: null })}>
            Yeni kural
          </button>
        )}
      </div>

      <SuccessBox text={message} />
      <ErrorBox error={ref.error} onReload={ref.reload} />

      <div className="p-4 rounded bg-blue-50 text-blue-900 text-sm space-y-1">
        <p>
          Oranlar ve tutarlar burada girilir; hesap her ay bu kurallardan yapılır. Oran değişince eski kuralın bitiş
          ayını girin ve yeni ayla başlayan yeni bir kural ekleyin; böylece geçmiş aylar eski oranla kalır.
        </p>
        <p>
          Aynı tür, hekim ve hasta grubu için ayları çakışan iki kural olamaz. Bir tahsilat satırı önce hekimin
          ortodonti kuralına, yoksa hastanın grubuna uyan ciro payı kuralına, o da yoksa standart ciro payı kuralına
          girer.
        </p>
      </div>

      {groups.size === 0 ? (
        <Card>
          <p className="text-sm text-gray-500">Henüz kural yok.</p>
        </Card>
      ) : (
        Array.from(groups.entries()).map(([payeeId, g]) => (
          <Card
            key={payeeId}
            title={
              <>
                {g.name}
                {!g.active && <span className="text-sm font-normal text-gray-500"> (pasif)</span>}
              </>
            }
            actions={
              canWrite && g.active ? (
                <button type="button" className={buttonSecondary} onClick={() => setDialog({ record: null, payeeUserId: payeeId })}>
                  Kural ekle
                </button>
              ) : undefined
            }
          >
            <RuleTable rules={g.rules} currentMonth={data.current_month} canWrite={canWrite} onEdit={(r) => setDialog({ record: r })} />
          </Card>
        ))
      )}

      {withoutRules.length > 0 && (
        <p className="text-sm text-gray-600">
          Kuralı olmayan hekimler / klinik sahibi: {withoutRules.map((p) => p.name).join(", ")}
        </p>
      )}

      {dialog && (
        <RuleDialog
          key={dialog.record?.id ?? `new:${dialog.payeeUserId ?? ""}`}
          refData={data}
          record={dialog.record}
          payeeUserId={dialog.payeeUserId}
          onClose={() => setDialog(null)}
          onReload={async () => {
            setDialog(null);
            await ref.reload();
          }}
          onOpenRule={(r) => setDialog({ record: r })}
          onSaved={async (alreadySaved) => {
            setDialog(null);
            setMessage(alreadySaved ? "Değişiklik yok; kural aynı kaldı." : "Kural kaydedildi.");
            await ref.reload();
          }}
        />
      )}
    </div>
  );
}

function rateText(r: HkRuleJson): string {
  if (r.kind === "implant_piece") return `${formatTL(r.piece_cents)} / implant`;
  return formatBp(r.share_bp);
}

function deductionsText(r: HkRuleJson): string {
  if (!RULE_FIELDS[r.kind].deductions) return "—";
  return HK_METHODS.map((m) => `${METHOD_LABELS[m]} ${formatBp(ruleDeduct(r, m))}`).join(" · ");
}

function ruleDeduct(r: Pick<HkRuleJson, "deduct_cash_bp" | "deduct_card_bp" | "deduct_transfer_bp" | "deduct_financing_bp">, m: HkMethod) {
  return m === "cash" ? r.deduct_cash_bp : m === "card" ? r.deduct_card_bp : m === "transfer" ? r.deduct_transfer_bp : r.deduct_financing_bp;
}

function RuleStatus({ rule, currentMonth }: { rule: HkRuleJson; currentMonth: string }) {
  const cur = monthKey(currentMonth);
  if (ruleActiveIn(rule, cur)) {
    return <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Bu ay geçerli</span>;
  }
  if (monthKey(rule.from_month) > cur) {
    return <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">Başlayacak</span>;
  }
  return <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">Bitti</span>;
}

function RuleTable({
  rules,
  currentMonth,
  canWrite,
  onEdit,
}: {
  rules: HkRuleJson[];
  currentMonth: string;
  canWrite: boolean;
  onEdit: (r: HkRuleJson) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-700 border-b">
            <th className="py-2 pr-3 font-semibold">Tür</th>
            <th className="py-2 pr-3 font-semibold">Hekim</th>
            <th className="py-2 pr-3 font-semibold">Hasta grubu</th>
            <th className="py-2 pr-3 font-semibold text-right">Oran / tutar</th>
            <th className="py-2 pr-3 font-semibold">Ödeme şekline göre kesinti</th>
            <th className="py-2 pr-3 font-semibold">Geçerli aylar</th>
            <th className="py-2 pr-3 font-semibold">Durum</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-b last:border-b-0 align-top">
              <td className="py-2 pr-3">
                <div className="font-medium whitespace-nowrap">{KIND_LABELS[r.kind]}</div>
                {r.note && <div className="text-xs text-gray-500 max-w-xs">{r.note}</div>}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">{r.doctor_name ?? (r.kind === "clinic_ciro_share" ? "Tüm klinik" : "—")}</td>
              <td className="py-2 pr-3 whitespace-nowrap">{r.segment ? SEGMENT_LABELS[r.segment] : "—"}</td>
              <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap font-medium">{rateText(r)}</td>
              <td className="py-2 pr-3 text-xs text-gray-700">{deductionsText(r)}</td>
              <td className="py-2 pr-3 whitespace-nowrap capitalize">
                {formatMonth(monthKey(r.from_month))} – {r.to_month ? formatMonth(monthKey(r.to_month)) : "süresiz"}
              </td>
              <td className="py-2 pr-3">
                <RuleStatus rule={r} currentMonth={currentMonth} />
              </td>
              <td className="py-2 text-right">
                {canWrite && (
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(r)}>
                    Düzenle
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RuleForm {
  payee_user_id: string;
  kind: HkKind;
  doctor_id: string;
  segment: HkSegment;
  share: string;
  piece: string;
  deduct: Record<HkMethod, string>;
  from_month: string;
  to_month: string;
  note: string;
}

function initialForm(ref: HkReferenceJson, record: HkRuleJson | null, payeeUserId?: string): RuleForm {
  if (record) {
    return {
      payee_user_id: record.payee_user_id,
      kind: record.kind,
      doctor_id: record.doctor_id ?? "",
      segment: record.segment ?? "standard",
      share: bpToInput(record.share_bp),
      piece: centsToInput(record.piece_cents),
      deduct: {
        cash: bpToInput(record.deduct_cash_bp),
        card: bpToInput(record.deduct_card_bp),
        transfer: bpToInput(record.deduct_transfer_bp),
        financing: bpToInput(record.deduct_financing_bp),
      },
      from_month: monthKey(record.from_month),
      to_month: record.to_month ? monthKey(record.to_month) : "",
      note: record.note ?? "",
    };
  }
  const payee = payeeUserId ? ref.payees.find((p) => p.user_id === payeeUserId) : undefined;
  return {
    payee_user_id: payee?.user_id ?? "",
    kind: "ciro_share",
    doctor_id: payee?.doctor_id ?? "",
    segment: "standard",
    share: "",
    piece: "",
    deduct: { cash: "0", card: "0", transfer: "0", financing: "0" },
    from_month: monthKey(ref.current_month),
    to_month: "",
    note: "",
  };
}

/** Create / edit one rule (fin_hk_save_rule). Fields follow the kind (RULE_FIELDS); the rest are sent as null / 0. */
function RuleDialog({
  refData,
  record,
  payeeUserId,
  onClose,
  onSaved,
  onReload,
  onOpenRule,
}: {
  refData: HkReferenceJson;
  record: HkRuleJson | null;
  payeeUserId?: string;
  onClose: () => void;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
  onOpenRule: (rule: HkRuleJson) => void;
}) {
  const [id] = useState(() => record?.id ?? newId());
  const [form, setForm] = useState<RuleForm>(() => initialForm(refData, record, payeeUserId));
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const f = RULE_FIELDS[form.kind];
  const current = record ? refData.rules.find((r) => r.id === record.id) ?? record : null;
  const payees = refData.payees.filter((p) => p.is_active || p.user_id === form.payee_user_id);
  const doctors = refData.doctors.filter((d) => d.is_active || d.id === form.doctor_id);
  const overlapping =
    error?.isConflict && error.details && UUID_RE.test(error.details)
      ? refData.rules.find((r) => r.id === error.details && r.id !== id)
      : undefined;

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const setPayee = (userId: string) =>
    setForm((prev) => {
      const payee = refData.payees.find((p) => p.user_id === userId);
      // A doctor's own rules are the usual case: pick the payee's doctors row while no doctor is chosen yet.
      return { ...prev, payee_user_id: userId, doctor_id: prev.doctor_id || payee?.doctor_id || "" };
    });

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);

    let shareBp: number | null = null;
    if (f.share) {
      const p = parsePercent(form.share);
      if (!p.ok) return setFormError(`Pay oranı: ${p.error}`);
      shareBp = p.bp;
    }
    let pieceCents: number | null = null;
    if (f.piece) {
      const p = parseTL(form.piece);
      if (!p.ok) return setFormError(`Adet başı tutar: ${p.error}`);
      pieceCents = p.cents;
    }
    const deduct: Record<HkMethod, number> = { cash: 0, card: 0, transfer: 0, financing: 0 };
    if (f.deductions) {
      for (const m of HK_METHODS) {
        const p = parsePercent(form.deduct[m].trim() === "" ? "0" : form.deduct[m], { allowZero: true });
        if (!p.ok) return setFormError(`${METHOD_LABELS[m]} kesintisi: ${p.error}`);
        deduct[m] = p.bp;
      }
    }
    if (!isMonth(form.from_month)) return setFormError("Başlangıç ayını seçin.");
    if (form.to_month && !isMonth(form.to_month)) return setFormError("Bitiş ayı geçersiz.");
    if (form.note.trim().length > 500) return setFormError("Not en fazla 500 karakter olabilir.");

    const input = {
      payee_user_id: form.payee_user_id || null,
      doctor_id: f.doctor ? form.doctor_id || null : null,
      kind: form.kind,
      segment: f.segment ? form.segment : null,
      share_bp: shareBp,
      piece_cents: pieceCents,
      deduct_cash_bp: deduct.cash,
      deduct_card_bp: deduct.card,
      deduct_transfer_bp: deduct.transfer,
      deduct_financing_bp: deduct.financing,
      from_month: form.from_month,
      to_month: form.to_month || null,
    };
    const invalid = validateRule(input);
    if (invalid) return setFormError(invalid);

    setBusy(true);
    try {
      const res = await finHkSaveRule({
        p_id: id,
        p_version: current?.version ?? 0,
        p_payee_user_id: input.payee_user_id!,
        p_doctor_id: input.doctor_id,
        p_kind: input.kind,
        p_segment: input.segment,
        p_share_bp: input.share_bp,
        p_piece_cents: input.piece_cents,
        p_deduct_cash_bp: input.deduct_cash_bp,
        p_deduct_card_bp: input.deduct_card_bp,
        p_deduct_transfer_bp: input.deduct_transfer_bp,
        p_deduct_financing_bp: input.deduct_financing_bp,
        p_from_month: input.from_month,
        p_to_month: input.to_month,
        p_note: form.note.trim(),
      });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Kuralı düzenle" : "Yeni hakediş kuralı"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Hakediş sahibi" hint="Hekimler ve klinik sahibi.">
            <select className={inputClass} value={form.payee_user_id} onChange={(e) => setPayee(e.target.value)} required>
              <option value="">Seçin</option>
              {payees.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                  {p.role === "owner" ? " (klinik sahibi)" : ""}
                  {p.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Kural türü">
            <select className={inputClass} value={form.kind} onChange={(e) => set("kind", e.target.value as HkKind)}>
              {HK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          {f.doctor && (
            <Field
              label="Hekim"
              hint={
                form.kind === "implant_piece"
                  ? "Bu hekimin taktığı implantlar sayılır."
                  : "Bu hekimin tahsilat satırları bu kurala girer."
              }
            >
              <select className={inputClass} value={form.doctor_id} onChange={(e) => set("doctor_id", e.target.value)} required>
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
          {f.segment && (
            <Field label="Hasta grubu" hint="Standart kural, grubuna ait kuralı olmayan hastalar için de geçerlidir.">
              <select className={inputClass} value={form.segment} onChange={(e) => set("segment", e.target.value as HkSegment)}>
                {HK_SEGMENTS.map((s) => (
                  <option key={s} value={s}>
                    {SEGMENT_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {f.share && (
            <Field
              label="Pay oranı (%)"
              hint={
                form.kind === "clinic_ciro_share"
                  ? "Kliniğin aylık brüt cirosu üzerinden (tüm hekimler, implant ve lab dahil, kesintisiz)."
                  : form.kind === "ortho_lab_first"
                    ? "Her ödemeden önce hastanın lab gideri karşılanır, kalan tutara uygulanır."
                    : "Kesintilerden sonra kalan matraha uygulanır. Örnek: 30 veya 12,5"
              }
            >
              <input className={inputClass} inputMode="decimal" value={form.share} onChange={(e) => set("share", e.target.value)} required />
            </Field>
          )}
          {f.piece && (
            <Field label="İmplant başı tutar (TL)">
              <input className={inputClass} inputMode="decimal" value={form.piece} onChange={(e) => set("piece", e.target.value)} required />
            </Field>
          )}
        </div>

        {f.deductions && (
          <fieldset className="rounded border p-3">
            <legend className="px-1 text-sm font-semibold text-gray-800">Ödeme şekline göre kesinti (%)</legend>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              {HK_METHODS.map((m) => (
                <Field key={m} label={METHOD_LABELS[m]}>
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={form.deduct[m]}
                    onChange={(e) => set("deduct", { ...form.deduct, [m]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Hekimin payı hesaplanmadan önce o ödeme şeklindeki tutardan düşülür (ör. kart komisyonu). Kesinti yoksa 0.
            </p>
          </fieldset>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Başlangıç ayı">
            <input type="month" className={inputClass} value={form.from_month} onChange={(e) => set("from_month", e.target.value)} required />
          </Field>
          <Field label="Bitiş ayı (dahil, isteğe bağlı)" hint="Boş = süresiz. Kural silinmez; bitiş ayı girilerek sonlandırılır.">
            <input
              type="month"
              className={inputClass}
              value={form.to_month}
              min={form.from_month || undefined}
              onChange={(e) => set("to_month", e.target.value)}
            />
          </Field>
          <Field label="Not" className="md:col-span-2">
            <textarea className={inputClass} rows={2} maxLength={500} value={form.note} onChange={(e) => set("note", e.target.value)} />
          </Field>
        </div>

        {record && (
          <p className="text-xs text-gray-500">
            Kapatılmış ayların dökümleri ve finans kayıtları değişmez; değişiklik açık aylarda hemen hesaba yansır.
          </p>
        )}
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={overlapping ? undefined : onReload} />
        {overlapping && (
          <button type="button" className={buttonSecondary} onClick={() => onOpenRule(overlapping)}>
            Çakışan kuralı aç ({overlapping.payee_name} · {KIND_LABELS[overlapping.kind]})
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
