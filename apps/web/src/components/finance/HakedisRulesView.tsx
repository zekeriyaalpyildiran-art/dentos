"use client";

// Kurallar of the Hakediş pages (finance and prep modes, HakedisParts): the rules grouped by payee and the child age
// limit. Only finance mode offers the editors, and only to 'finance' holders (fin_hk_save_rule / fin_hk_save_settings
// stay finance-only in 0031); the prep section shows the same list read-only. v1.3 (0032): kind bank_portion, the fixed
// monthly part of a payee's total paid by bank (any active user, like the fixed monthly salary). v1.4 (0032): kind
// minimum_monthly, the monthly floor of a payee's total (any active user), and how lab costs reach the hakediş. v2
// (0033): the 'Ödenmemiş (ay sonu)' deduction of ciro_share rules (the part of a Macro treatment unpaid at the end of
// its month) and kind procedure_piece, a doctor's fixed amount per piece of one procedure group (İşlem grupları). v2.2
// (0034): "İşaretsiz hastalar bu gruba girer" on a child ciro_share rule (unmarked patients of the doctor count as
// children; only adults are then marked). v2.3 (0035): the financing deduction applies after the Burgan bank's fee
// share (ciro_share; none under ortho_lab_first). 0038 (owner decision 2026-10-21): a bank_portion rule's amount and
// note are finance data; a caller without 'finance' / 'finance_readonly' (the preparer) gets the rule, its payee and
// months without them (piece_cents null, note ''): the amount shows as "—" (ruleAmountHidden).

import Link from "next/link";
import { useState } from "react";
import { HK_BASE, HakedisTabs, useHkReference, type HkMode } from "./HakedisParts";
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
  formatMonth,
  formatTL,
  isMonth,
  newId,
  parseTL,
  toFinanceError,
  type FinanceError,
} from "@/lib/finance";
import {
  BANK_PORTION_HINT,
  DEDUCT_LABELS,
  FINANCING_DEDUCT_HINT,
  HK_CHILD_AGE_LIMIT_MAX,
  HK_CHILD_AGE_LIMIT_MIN,
  HK_KINDS,
  HK_METHODS,
  HK_SEGMENTS,
  KIND_LABELS,
  LAB_DEDUCTION_TEXT,
  METHOD_LABELS,
  MINIMUM_MONTHLY_HINT,
  MINIMUM_TOPUP_COMPONENT_LABEL,
  PROCEDURE_PIECE_HINT,
  RULE_FIELDS,
  SEGMENT_LABELS,
  UNMARKED_DEFAULT_HINT,
  UNMARKED_DEFAULT_LABEL,
  UNPAID_DEDUCT_HINT,
  bpToInput,
  childAgeLimitOf,
  finHkSaveRule,
  finHkSaveSettings,
  formatBp,
  hkSplitVisible,
  kindAllowsAnyUser,
  monthKey,
  parsePercent,
  pieceFieldLabel,
  ruleActiveIn,
  ruleAllowsUnmarkedDefault,
  ruleAmountHidden,
  ruleDeductBp,
  validateChildAgeLimit,
  validateRule,
  type HkKind,
  type HkLineMethod,
  type HkPayeeRefJson,
  type HkReferenceJson,
  type HkRuleJson,
  type HkSegment,
} from "@/lib/hakedis";

type DialogState = { record: HkRuleJson | null; payeeUserId?: string };

/**
 * Hakediş rules need a doctors row or the owner role (fin_hk_save_rule); a fixed monthly salary, a bank amount and a
 * floor (kindAllowsAnyUser) any user.
 */
function canHaveHakedisRules(p: Pick<HkPayeeRefJson, "doctor_id" | "role">): boolean {
  return !!p.doctor_id || p.role === "owner";
}

/**
 * Rules grouped by payee (fin_hk_reference().rules), with the create / edit dialog for 'finance' holders in finance
 * mode. In prep mode everything is read-only.
 */
export function HakedisRulesView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!ref.data) return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  const data = ref.data;
  const canWrite = mode === "finance" && data.can_write;
  // 0038: bank amounts and the bank / cash split only for finance readers (the server sends no amount otherwise).
  const split = hkSplitVisible(data);

  const groups = new Map<string, { name: string; active: boolean; rules: HkRuleJson[] }>();
  for (const r of data.rules) {
    const g = groups.get(r.payee_user_id) ?? { name: r.payee_name, active: r.payee_is_active, rules: [] };
    g.rules.push(r);
    groups.set(r.payee_user_id, g);
  }
  const withoutRules = data.payees.filter((p) => p.is_active && canHaveHakedisRules(p) && !groups.has(p.user_id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HakedisTabs mode={mode} />
        {canWrite && (
          <button type="button" className={buttonPrimary} onClick={() => setDialog({ record: null })}>
            Yeni kural
          </button>
        )}
      </div>

      <SuccessBox text={message} />
      <ErrorBox error={ref.error} onReload={ref.reload} />

      <div className="p-4 rounded bg-blue-50 text-blue-900 text-sm space-y-1">
        {mode === "prep" && (
          <p className="font-medium">
            Kuralları ve maaş tutarlarını klinik sahibi Finans → Hakediş → Kurallar sayfasından girer; burada yalnızca
            görüntülenir.
          </p>
        )}
        <p>
          Oranlar ve tutarlar {mode === "prep" ? "Kurallar sayfasında" : "burada"} girilir; hesap her ay bu kurallardan
          yapılır. Oran ya da maaş değişince eski kuralın bitiş ayı girilir ve yeni ayla başlayan yeni bir kural
          eklenir; böylece geçmiş aylar eski tutarla kalır.
        </p>
        <p>
          Aynı tür, hekim ve hasta grubu için ayları çakışan iki kural olamaz. Bir tahsilat satırı önce hekimin
          ortodonti kuralına, yoksa hastanın grubuna uyan ciro payı kuralına, o da yoksa standart ciro payı kuralına
          girer.
        </p>
        <p>
          Sabit aylık maaş, kişinin her ay alacağı net tutardır (SGK ve vergi muhasebede takip edilir); aynı kişi için
          ayları çakışan iki maaş kuralı olamaz. Primler her ay Maaş ve prim sayfasından elle girilir.
        </p>
        <p>
          Bankadan ödenen sabit tutar, kişinin o ayki hakedişinin ya da maaşının bankadan (resmi maaş olarak) ödenen
          kısmıdır.{" "}
          {split
            ? "Toplamı değiştirmez; ay özetinde ödeme “Bankadan” ve “Elden” (toplamdan kalan) diye bölünür."
            : "Toplamı değiştirmez; tutarı ve ödemenin bankadan / elden bölünmesi yalnızca Finans yetkililerine gösterilir."}{" "}
          Aynı kişi için ayları çakışan iki bankadan ödenen tutar kuralı olamaz.
        </p>
        <p>
          Taban maaş (hangisi yüksekse): kişinin o ayki toplamı (hakediş, maaş, prim ve diğer dahil) bu tutarın altında
          kalırsa aradaki fark “{MINIMUM_TOPUP_COMPONENT_LABEL}” olarak eklenir ve taban tutar ödenir; toplam yüksekse
          bir şey eklenmez. Aynı kişi için ayları çakışan iki taban maaş kuralı olamaz.
        </p>
        <p>Lab giderleri: {LAB_DEDUCTION_TEXT}</p>
        <p>
          Macro&apos;dan yüklenen hekimlerde ciro, ay içinde yapılan işlemlerdir: işlemin ay sonuna kadar ödenen kısmı ödeme
          şeklinin kesintisiyle, ödenmeyen kısmı ciro payı kuralının “{DEDUCT_LABELS.unpaid}” kesintisiyle cirosuna
          girer. Ortodonti kuralı olan hekimin satırları ödeme gününe göredir.
        </p>
        <p>
          İşlem başı ücret: hekimin seçilen işlem grubunda (ör. çekim, kist) yaptığı her işlem için sabit tutar; işlemin
          fiyatı dikkate alınmaz. Gruplar ve Macro işlem adları{" "}
          <Link href={`${HK_BASE[mode]}/groups`} className="underline">
            İşlem grupları
          </Link>{" "}
          sayfasındadır. Bir hekime aynı aylarda hem implant (adet başı) kuralı hem de implant grubu için işlem başı ücret
          tanımlanamaz.
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
            <RuleTable
              rules={g.rules}
              groups={data.proc_groups ?? []}
              currentMonth={data.current_month}
              split={split}
              canWrite={canWrite}
              onEdit={(r) => setDialog({ record: r })}
            />
          </Card>
        ))
      )}

      {withoutRules.length > 0 && (
        <p className="text-sm text-gray-600">
          Hakediş kuralı olmayan hekimler / klinik sahibi: {withoutRules.map((p) => p.name).join(", ")}
        </p>
      )}

      <ChildAgeLimitCard
        key={`${data.settings?.version ?? 0}:${childAgeLimitOf(data.settings)}`}
        refData={data}
        canWrite={canWrite}
        onReload={ref.reload}
        onSaved={async (alreadySaved) => {
          setMessage(alreadySaved ? "Değişiklik yok; yaş sınırı aynı kaldı." : "Çocuk hasta yaş sınırı kaydedildi.");
          await ref.reload();
        }}
      />

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

/**
 * fin_settings.hk_child_age_limit (fin_hk_save_settings): a marked patient with a birth date is in the child group
 * while younger than this on the payment day. Finance writers change it; read-only holders see it.
 */
function ChildAgeLimitCard({
  refData,
  canWrite,
  onSaved,
  onReload,
}: {
  refData: HkReferenceJson;
  canWrite: boolean;
  onSaved: (alreadySaved: boolean) => void | Promise<void>;
  onReload: () => void;
}) {
  const limit = childAgeLimitOf(refData.settings);
  const [value, setValue] = useState(String(limit));
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const n = /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    const invalid = validateChildAgeLimit(n);
    if (invalid) return setFormError(invalid);
    setBusy(true);
    try {
      const res = await finHkSaveSettings({ p_version: refData.settings?.version ?? 0, p_child_age_limit: n });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Çocuk hasta yaş sınırı">
      <p className="text-sm text-gray-700">
        Doğum tarihi girilmiş hasta, ödeme gününde <strong>{limit} yaşından küçükse</strong> “Çocuk hasta” grubuna girer
        (doğum tarihi yoksa hasta işaretindeki “Çocuk hasta” seçimine bakılır). Değişiklik açık ayların hesabına hemen
        yansır; kapatılmış ayların dökümleri değişmez.
      </p>
      {canWrite && (
        <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Yaş sınırı" hint={`${HK_CHILD_AGE_LIMIT_MIN} ile ${HK_CHILD_AGE_LIMIT_MAX} arasında, tam yıl.`}>
            <input
              className={`${inputClass} w-28`}
              type="number"
              inputMode="numeric"
              min={HK_CHILD_AGE_LIMIT_MIN}
              max={HK_CHILD_AGE_LIMIT_MAX}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </Field>
          <button type="submit" className={`${buttonPrimary} mb-5`} disabled={busy || value.trim() === String(limit)}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </form>
      )}
      {formError && <div className="mt-3 p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
      {error && (
        <div className="mt-3">
          <ErrorBox error={error} onReload={onReload} />
        </div>
      )}
    </Card>
  );
}

function rateText(r: HkRuleJson): string {
  if (r.kind === "implant_piece") return `${formatTL(r.piece_cents)} / implant`;
  if (r.kind === "procedure_piece") return `${formatTL(r.piece_cents)} / işlem`;
  if (r.kind === "fixed_monthly" || r.kind === "bank_portion") return `${formatTL(r.piece_cents)} / ay`;
  if (r.kind === "minimum_monthly") return `en az ${formatTL(r.piece_cents)} / ay`;
  return formatBp(r.share_bp);
}

/** The method deductions of a rule; the unpaid one (0033) on ciro_share rules once it is set. */
function deductionsText(r: HkRuleJson): string {
  const f = RULE_FIELDS[r.kind];
  if (!f.deductions) return "—";
  const methods: HkLineMethod[] = [...HK_METHODS];
  if (f.unpaid && r.deduct_unpaid_bp !== undefined) methods.push("unpaid");
  return methods.map((m) => `${DEDUCT_LABELS[m]} ${formatBp(ruleDeductBp(r, m))}`).join(" · ");
}

/** The group of a procedure_piece rule (the rule's own name, else the reference list's). */
function groupName(r: HkRuleJson, groups: HkReferenceJson["proc_groups"]): string | null {
  if (r.kind !== "procedure_piece") return null;
  return r.proc_group_name ?? groups?.find((g) => g.id === r.proc_group_id)?.name ?? null;
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
  groups,
  currentMonth,
  split,
  canWrite,
  onEdit,
}: {
  rules: HkRuleJson[];
  groups: HkReferenceJson["proc_groups"];
  currentMonth: string;
  /** 0038: bank amounts are shown (hkSplitVisible) */
  split: boolean;
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
            <th className="py-2 pr-3 font-semibold whitespace-nowrap">Hasta / işlem grubu</th>
            <th className="py-2 pr-3 font-semibold text-right">Oran / tutar</th>
            <th className="py-2 pr-3 font-semibold">Ödeme şekline göre kesinti</th>
            <th className="py-2 pr-3 font-semibold">Geçerli aylar</th>
            <th className="py-2 pr-3 font-semibold">Durum</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => {
            // 0038: a bank amount (and its note) for finance readers only.
            const hidden = ruleAmountHidden(r, split);
            return (
              <tr key={r.id} className="border-b last:border-b-0 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium whitespace-nowrap">{KIND_LABELS[r.kind]}</div>
                  {r.note && !hidden && <div className="text-xs text-gray-500 max-w-xs">{r.note}</div>}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">{r.doctor_name ?? (r.kind === "clinic_ciro_share" ? "Tüm klinik" : "—")}</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {r.segment ? SEGMENT_LABELS[r.segment] : groupName(r, groups) ?? "—"}
                  {r.unmarked_default && <div className="text-xs text-gray-500">işaretsiz hastalar dahil</div>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap font-medium">
                  {hidden ? "—" : rateText(r)}
                  {hidden && <div className="text-xs text-gray-500 font-normal">Finans yetkilisi görür</div>}
                </td>
                <td className="py-2 pr-3 text-xs text-gray-700">{deductionsText(r)}</td>
                <td className="py-2 pr-3 whitespace-nowrap capitalize">
                  {formatMonth(monthKey(r.from_month))} – {r.to_month ? formatMonth(monthKey(r.to_month)) : "süresiz"}
                </td>
                <td className="py-2 pr-3">
                  <RuleStatus rule={r} currentMonth={currentMonth} />
                </td>
                <td className="py-2 text-right">
                  {canWrite && !hidden && (
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => onEdit(r)}>
                      Düzenle
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
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
  /** the four payment methods, and (0033, ciro_share) 'unpaid' */
  deduct: Record<HkLineMethod, string>;
  /** 0033: procedure_piece only */
  proc_group_id: string;
  /** 0034: ciro_share of the child segment only */
  unmarked_default: boolean;
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
        unpaid: bpToInput(record.deduct_unpaid_bp ?? 0),
      },
      proc_group_id: record.proc_group_id ?? "",
      unmarked_default: !!record.unmarked_default,
      from_month: monthKey(record.from_month),
      to_month: record.to_month ? monthKey(record.to_month) : "",
      note: record.note ?? "",
    };
  }
  const payee = payeeUserId ? ref.payees.find((p) => p.user_id === payeeUserId) : undefined;
  return {
    payee_user_id: payee?.user_id ?? "",
    // Staff can only have a salary.
    kind: payee && !canHaveHakedisRules(payee) ? "fixed_monthly" : "ciro_share",
    doctor_id: payee?.doctor_id ?? "",
    segment: "standard",
    share: "",
    piece: "",
    deduct: { cash: "0", card: "0", transfer: "0", financing: "0", unpaid: "0" },
    proc_group_id: "",
    unmarked_default: false,
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
  const procedure = form.kind === "procedure_piece";
  const unmarkedAllowed = ruleAllowsUnmarkedDefault({ kind: form.kind, segment: f.segment ? form.segment : null });
  const salary = form.kind === "fixed_monthly";
  const bank = form.kind === "bank_portion";
  const minimum = form.kind === "minimum_monthly";
  const anyUser = kindAllowsAnyUser(form.kind);
  const current = record ? refData.rules.find((r) => r.id === record.id) ?? record : null;
  // A salary, a bank amount or a floor may go to any active user; hakediş rules to doctors and the owner (the server
  // checks the same).
  const payees = refData.payees.filter(
    (p) => (p.is_active && (anyUser || canHaveHakedisRules(p))) || p.user_id === form.payee_user_id
  );
  const payee = refData.payees.find((p) => p.user_id === form.payee_user_id);
  const doctors = refData.doctors.filter((d) => d.is_active || d.id === form.doctor_id);
  // 0033: active procedure groups (the rule's own stays listed even if deactivated since).
  const groups = (refData.proc_groups ?? []).filter((g) => g.is_active || g.id === record?.proc_group_id);
  const overlapping =
    error?.isConflict && error.details && UUID_RE.test(error.details)
      ? refData.rules.find((r) => r.id === error.details && r.id !== id)
      : undefined;

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  // 0033: a procedure_piece rule pays the doctor who performs the pieces (payee = the doctor's own user).
  const setDoctor = (doctorId: string) =>
    setForm((prev) => {
      if (prev.kind !== "procedure_piece") return { ...prev, doctor_id: doctorId };
      const user = refData.doctors.find((d) => d.id === doctorId)?.user_id;
      return { ...prev, doctor_id: doctorId, payee_user_id: user ?? prev.payee_user_id };
    });
  const setPayee = (userId: string) =>
    setForm((prev) => {
      const payee = refData.payees.find((p) => p.user_id === userId);
      // A doctor's own rules are the usual case: pick the payee's doctors row while no doctor is chosen yet (always
      // for procedure_piece, whose payee is the performing doctor, 0033).
      const doctorId =
        prev.kind === "procedure_piece" ? payee?.doctor_id ?? prev.doctor_id : prev.doctor_id || payee?.doctor_id || "";
      return { ...prev, payee_user_id: userId, doctor_id: doctorId };
    });
  const setKind = (kind: HkKind) =>
    setForm((prev) => {
      if (kind !== "procedure_piece" || !prev.doctor_id) return { ...prev, kind };
      const user = refData.doctors.find((d) => d.id === prev.doctor_id)?.user_id;
      return { ...prev, kind, payee_user_id: user ?? prev.payee_user_id };
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
      if (!p.ok) {
        const label = salary
          ? "Aylık net maaş"
          : bank
            ? "Aylık bankadan ödenen tutar"
            : minimum
              ? "Aylık taban tutar"
              : procedure
                ? "İşlem başı tutar"
                : "Adet başı tutar";
        return setFormError(`${label}: ${p.error}`);
      }
      pieceCents = p.cents;
    }
    const deduct: Record<HkLineMethod, number> = { cash: 0, card: 0, transfer: 0, financing: 0, unpaid: 0 };
    const methods: HkLineMethod[] = [...(f.deductions ? HK_METHODS : []), ...(f.unpaid ? (["unpaid"] as const) : [])];
    for (const m of methods) {
      const p = parsePercent(form.deduct[m].trim() === "" ? "0" : form.deduct[m], { allowZero: true });
      if (!p.ok) return setFormError(`${DEDUCT_LABELS[m]} kesintisi: ${p.error}`);
      deduct[m] = p.bp;
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
      deduct_unpaid_bp: deduct.unpaid,
      proc_group_id: f.group ? form.proc_group_id || null : null,
      // 0034: only a child ciro_share rule keeps the flag (a changed kind / segment clears it).
      unmarked_default: unmarkedAllowed && form.unmarked_default,
      from_month: form.from_month,
      to_month: form.to_month || null,
    };
    const invalid = validateRule(input);
    if (invalid) return setFormError(invalid);
    if (procedure && refData.doctors.find((d) => d.id === input.doctor_id)?.user_id !== input.payee_user_id) {
      return setFormError("İşlem başı ücret kuralında hakediş sahibi işlemi yapan hekimin kendisi olmalı.");
    }
    if (!anyUser && payee && !canHaveHakedisRules(payee)) {
      return setFormError(
        "Hakediş yalnızca hekimlere ve klinik sahibine tanımlanabilir. Personel için “Sabit aylık maaş”, “Bankadan ödenen sabit tutar” ya da “Taban maaş” seçin."
      );
    }

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
        p_deduct_unpaid_bp: input.deduct_unpaid_bp,
        p_proc_group_id: input.proc_group_id,
        p_unmarked_default: input.unmarked_default,
      });
      await onSaved(res.already_saved);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Kuralı düzenle" : "Yeni kural"} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label={
              salary
                ? "Maaş alacak kişi"
                : bank
                  ? "Bankadan ödeme alacak kişi"
                  : minimum
                    ? "Taban maaş alacak kişi"
                    : "Hakediş sahibi"
            }
            hint={
              anyUser
                ? "Klinikteki herhangi bir aktif kullanıcı (personel ya da hekim)."
                : procedure
                  ? "İşlemi yapan hekimin kendisi (hekim seçilince kendiliğinden gelir)."
                  : "Hekimler ve klinik sahibi."
            }
          >
            <select className={inputClass} value={form.payee_user_id} onChange={(e) => setPayee(e.target.value)} required>
              <option value="">Seçin</option>
              {payees.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                  {p.role === "owner" ? " (klinik sahibi)" : ""}
                  {anyUser && !p.doctor_id && p.role !== "owner" ? " (personel)" : ""}
                  {p.is_active ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Kural türü">
            <select className={inputClass} value={form.kind} onChange={(e) => setKind(e.target.value as HkKind)}>
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
                  : procedure
                    ? "Bu hekimin seçilen gruptaki işlemleri sayılır; hakediş sahibi hekimin kendisidir."
                    : "Bu hekimin tahsilat satırları bu kurala girer."
              }
            >
              <select className={inputClass} value={form.doctor_id} onChange={(e) => setDoctor(e.target.value)} required>
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
          {f.group && (
            <Field
              label="İşlem grubu"
              hint={
                groups.length === 0 ? (
                  <>
                    Henüz işlem grubu yok;{" "}
                    <Link href={`${HK_BASE.finance}/groups`} className="underline">
                      İşlem grupları
                    </Link>{" "}
                    sayfasından ekleyin.
                  </>
                ) : (
                  PROCEDURE_PIECE_HINT
                )
              }
            >
              <select className={inputClass} value={form.proc_group_id} onChange={(e) => set("proc_group_id", e.target.value)} required>
                <option value="">Seçin</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                    {g.is_implant ? " (implant grubu)" : ""}
                    {g.is_active ? "" : " (pasif)"}
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
          {unmarkedAllowed && (
            <div className="md:col-span-2">
              <label className="flex items-start gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.unmarked_default}
                  onChange={(e) => set("unmarked_default", e.target.checked)}
                />
                <span>
                  <span className="font-semibold">{UNMARKED_DEFAULT_LABEL}</span>
                  <span className="block text-xs text-gray-500">
                    {UNMARKED_DEFAULT_HINT} Doğum tarihi girilen hasta yaşına göre sayılır; işaretsiz sayılan hastalar ay
                    ekranında uyarı olarak listelenir.
                  </span>
                </span>
              </label>
            </div>
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
            <Field
              label={pieceFieldLabel(form.kind)}
              hint={
                salary
                  ? "Her ay ödenecek net tutar. SGK ve vergi muhasebede takip edilir; prim her ay ayrıca girilir."
                  : bank
                    ? BANK_PORTION_HINT
                    : minimum
                      ? MINIMUM_MONTHLY_HINT
                      : undefined
              }
            >
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
              {f.unpaid && (
                <Field label={DEDUCT_LABELS.unpaid} className="col-span-2 md:col-span-1">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={form.deduct.unpaid}
                    onChange={(e) => set("deduct", { ...form.deduct, unpaid: e.target.value })}
                  />
                </Field>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Hekimin payı hesaplanmadan önce o ödeme şeklindeki tutardan düşülür (ör. kart komisyonu). Kesinti yoksa 0.
              {` ${FINANCING_DEDUCT_HINT}`}
              {f.unpaid && ` ${DEDUCT_LABELS.unpaid}: ${UNPAID_DEDUCT_HINT}`}
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
