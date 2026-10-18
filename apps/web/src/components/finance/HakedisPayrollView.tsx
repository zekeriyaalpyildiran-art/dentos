"use client";

// Maaş ve prim of the Hakediş pages (finance and prep modes, HakedisParts; owner decisions 2026-10-18, 0031): per month
// the people with a fixed monthly net salary (fin_hk_rules kind fixed_monthly, read-only here) and the month's bonus /
// other rows of any active user (fin_hk_adjustments: add / edit / void in open months by 'finance' or
// 'hakedis_prepare'). At month close a staff member's salary and rows become one personnel entry in Finans, a doctor's
// are added to the doctor's hakediş entry. A closed month shows the closing statements' amounts (what Finans got), and
// the live calculation only as a hint when a rule changed since. v1.3 (0032): the bank / cash split of each person's
// month (bank_portion rule, part of the total) and the BANK_OVER_TOTAL warnings of the listed people (in a closed
// month from the closing statements: a negative cash part).

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  DialogButtons,
  HK_BASE,
  HakedisTabs,
  HkVoidDialog,
  MonthPicker,
  MonthStatusBadge,
  hkMonthLock,
  useHkMonth,
  useHkMonthData,
  useHkReference,
  type HkMode,
} from "./HakedisParts";
import { Card, ErrorBox, Field, Loading, Modal, SuccessBox, buttonPrimary, inputClass } from "./ui";
import {
  centsToInput,
  formatMonth,
  formatTL,
  formatTimestamp,
  newId,
  parseTL,
  toFinanceError,
  type FinanceError,
} from "@/lib/finance";
import {
  ADJUSTMENT_KIND_LABELS,
  HK_ADJUSTMENT_DESCRIPTION_MAX,
  HK_ADJUSTMENT_KINDS,
  SPLIT_LABELS,
  bankOverText,
  bankSplitOf,
  finHkSaveAdjustment,
  finHkVoidAdjustment,
  hkCanPrepare,
  monthKey,
  ruleActiveIn,
  salaryRuleOf,
  summarizePayee,
  validateAdjustment,
  warningText,
  type HkAdjustmentJson,
  type HkAdjustmentKind,
  type HkComponentJson,
  type HkMonthPayload,
  type HkPayeeRefJson,
  type HkReferenceJson,
  type HkRuleJson,
} from "@/lib/hakedis";
import { ROLE_LABELS } from "@/lib/auth";

type Dialog =
  | { kind: "edit"; record: HkAdjustmentJson | null; payeeUserId?: string }
  | { kind: "void"; record: HkAdjustmentJson };

/** One person of the month: salary rule and / or live bonus / other rows. */
interface PersonRow {
  userId: string;
  name: string;
  /** users.role label, or "Hekim" for a doctors row */
  roleText: string;
  isDoctor: boolean;
  isActive: boolean;
  /** the salary rule active in the month now (its months; the amount of a closed month comes from the statement) */
  salaryRule: HkRuleJson | undefined;
  /** shown figures: the live calculation in an open month, the closing statement in a closed one */
  salaryCents: number;
  bonusCents: number;
  otherCents: number;
  /** the payee's whole month total (a doctor's hakediş included) */
  payeeTotal: number;
  /** the live calculation's salary + bonus + other (differs in a closed month when a rule changed after the close) */
  livePayroll: number;
  /** closed month without a closing statement for this person (nothing was written to Finans for them) */
  noStatement: boolean;
  /**
   * 0032: the part of payeeTotal paid by bank and the rest (cash); null without a bank part (and for statements of
   * closes before 0032)
   */
  bankCents: number | null;
  cashCents: number | null;
}

function hasPayrollComponent(components: readonly HkComponentJson[]): boolean {
  return components.some((c) => c.kind === "fixed_monthly" || c.kind === "adjustments");
}

function personRows(ref: HkReferenceJson, data: HkMonthPayload, month: string): PersonRow[] {
  const people = new Map<string, HkPayeeRefJson>(ref.payees.map((p) => [p.user_id, p]));
  const closed = data.status === "closed";
  const stmts = new Map(data.statements.map((st) => [st.payee_user_id, st]));
  const rows = new Map<string, PersonRow>();
  const rowOf = (userId: string, fallbackName: string): PersonRow => {
    let row = rows.get(userId);
    if (!row) {
      const p = people.get(userId);
      row = {
        userId,
        name: p?.name ?? fallbackName,
        roleText: p?.doctor_id ? "Hekim" : p ? ROLE_LABELS[p.role] ?? p.role : "",
        isDoctor: !!p?.doctor_id,
        isActive: p?.is_active ?? true,
        salaryRule: salaryRuleOf(ref.rules, userId, month),
        salaryCents: 0,
        bonusCents: 0,
        otherCents: 0,
        payeeTotal: 0,
        livePayroll: 0,
        noStatement: false,
        bankCents: null,
        cashCents: null,
      };
      rows.set(userId, row);
    }
    return row;
  };
  const isStaff = (userId: string) => !people.get(userId)?.doctor_id;
  // Everyone with a salary rule this month, even before the month's figures mention them; staff with a bank amount
  // (0032) too (a doctor's bank amount belongs to the hakediş, shown in Ay özeti).
  for (const r of ref.rules) {
    if (!ruleActiveIn(r, month)) continue;
    if (r.kind === "fixed_monthly" || (r.kind === "bank_portion" && isStaff(r.payee_user_id))) {
      rowOf(r.payee_user_id, r.payee_name);
    }
  }
  // Closed month: everyone whose closing statement had a salary or bonus / other rows (or a staff bank amount), even
  // if the rule was changed out of the month since.
  if (closed) {
    for (const st of data.statements) {
      if (
        hasPayrollComponent(st.breakdown.components) ||
        (isStaff(st.payee_user_id) && bankSplitOf(st.breakdown) !== null)
      ) {
        rowOf(st.payee_user_id, st.payee_name);
      }
    }
  }
  for (const p of data.payees) {
    if (!hasPayrollComponent(p.components) && !rows.has(p.payee_user_id)) continue;
    const s = summarizePayee(p);
    const row = rowOf(p.payee_user_id, p.payee_name);
    row.livePayroll = s.salary_cents + s.bonus_cents + s.other_cents;
    row.salaryCents = s.salary_cents;
    row.bonusCents = s.bonus_cents;
    row.otherCents = s.other_cents;
    row.payeeTotal = p.total_cents;
    row.bankCents = s.bank_cents;
    row.cashCents = s.cash_cents;
  }
  // Closed month: the amounts written to Finans at close (the statement), not today's calculation.
  if (closed) {
    for (const row of rows.values()) {
      const st = stmts.get(row.userId);
      if (!st) {
        row.noStatement = true;
        row.salaryCents = 0;
        row.bonusCents = 0;
        row.otherCents = 0;
        row.payeeTotal = 0;
        row.bankCents = null;
        row.cashCents = null;
        continue;
      }
      const s = summarizePayee(st.breakdown);
      row.salaryCents = s.salary_cents;
      row.bonusCents = s.bonus_cents;
      row.otherCents = s.other_cents;
      row.payeeTotal = st.total_cents;
      row.bankCents = s.bank_cents;
      row.cashCents = s.cash_cents;
    }
  }
  return Array.from(rows.values()).sort(
    (a, b) => Number(a.isDoctor) - Number(b.isDoctor) || a.name.localeCompare(b.name, "tr")
  );
}

/**
 * The month's salaries and bonus / other rows. Salaries are read-only here (Kurallar, 'finance' holders); the rows can
 * be added, corrected and voided while the month is open by 'finance' or 'hakedis_prepare' holders.
 */
export function HakedisPayrollView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [month, setMonth] = useHkMonth(ref.data);
  const { data: current, error, loading, reload } = useHkMonthData(month);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [showVoided, setShowVoided] = useState(false);

  const rows = useMemo(
    () => (ref.data && current && month ? personRows(ref.data, current, month) : []),
    [ref.data, current, month]
  );

  if (!ref.data || !month) {
    return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  }
  const refData = ref.data;
  const canPrepare = hkCanPrepare(refData);
  const lock = hkMonthLock(refData, current?.status, month);
  const editable = canPrepare && current?.status === "open" && !lock;
  const closed = current?.status === "closed";
  const base = HK_BASE[mode];

  const done = async (text: string) => {
    setDialog(null);
    setMessage(text);
    await reload();
  };
  const reloadAll = async () => {
    setDialog(null);
    await Promise.all([ref.reload(), reload()]);
  };

  // Active staff (no doctors row, not the owner) without a salary rule this month: a reminder, not an error.
  const salaried = new Set(rows.filter((r) => r.salaryRule || r.salaryCents).map((r) => r.userId));
  const withoutSalary = refData.payees.filter(
    (p) => p.is_active && !p.doctor_id && p.role !== "owner" && !salaried.has(p.user_id)
  );

  // 0032: Bankadan / Elden columns when a listed person has a bank part. Warnings follow the shown figures: the live
  // BANK_OVER_TOTAL of the listed people in an open month, the closing statements' negative cash part in a closed one.
  const showBank = rows.some((r) => r.bankCents !== null);
  const listed = new Set(rows.map((r) => r.userId));
  const bankWarnings: { key: string; text: string }[] = closed
    ? rows
        .filter((r) => !r.noStatement && r.cashCents !== null && r.cashCents < 0)
        .map((r) => ({ key: r.userId, text: `${r.name}: ${bankOverText(-(r.cashCents as number))}` }))
    : (current?.warnings ?? [])
        .filter((w) => w.code === "BANK_OVER_TOTAL" && listed.has(w.payee_user_id))
        .map((w, i) => ({ key: `${w.code}:${i}`, text: warningText(w) }));

  const adjustments = current?.adjustments ?? [];
  const visible = adjustments.filter((a) => showVoided || !a.voided_at);
  const liveTotal = adjustments.filter((a) => !a.voided_at).reduce((s, a) => s + a.amount_cents, 0);
  const voidedCount = adjustments.length - adjustments.filter((a) => !a.voided_at).length;

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

      <SuccessBox text={message} />
      <ErrorBox error={error} onReload={reloadAll} />

      {current && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <MonthStatusBadge status={current.status} />
          {lock ? <span>{lock}</span> : !canPrepare ? <span>Salt okunur.</span> : null}
        </div>
      )}

      {!current ? (
        loading ? <Loading /> : null
      ) : (
        <>
          <Card
            title={<span className="capitalize">Maaşlar · {formatMonth(month)}</span>}
            actions={
              editable ? (
                <button type="button" className={buttonPrimary} onClick={() => setDialog({ kind: "edit", record: null })}>
                  Prim / diğer ekle
                </button>
              ) : undefined
            }
          >
            {bankWarnings.length > 0 && (
              <div className="mb-3 p-3 rounded bg-amber-50 text-amber-900 text-sm">
                <ul className="list-disc pl-5 space-y-1">
                  {bankWarnings.map((w) => (
                    <li key={w.key}>{w.text}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-700 border-b">
                    <th className="py-2 pr-3 font-semibold">Kişi</th>
                    <th className="py-2 pr-3 font-semibold text-right whitespace-nowrap">Sabit maaş (net)</th>
                    <th className="py-2 pr-3 font-semibold text-right">Prim</th>
                    <th className="py-2 pr-3 font-semibold text-right">Diğer</th>
                    <th className="py-2 pr-3 font-semibold text-right whitespace-nowrap">Bu ay ödenecek</th>
                    {showBank && (
                      <>
                        <th className="py-2 pr-3 font-semibold text-right">{SPLIT_LABELS.bank}</th>
                        <th className="py-2 pr-3 font-semibold text-right">{SPLIT_LABELS.cash}</th>
                      </>
                    )}
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={showBank ? 8 : 6} className="py-6 text-center text-gray-500">
                        Bu ay için maaş kuralı ya da prim kaydı yok.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => {
                      const payroll = r.salaryCents + r.bonusCents + r.otherCents;
                      // Open month: the rule's amount until the calculation lists it; closed: the statement's.
                      const salary = closed ? r.salaryCents : r.salaryCents || (r.salaryRule?.piece_cents ?? 0);
                      return (
                        <tr key={r.userId} className="border-b last:border-b-0 align-top">
                          <td className="py-2 pr-3">
                            <div className="font-medium">
                              {r.name}
                              {r.isActive ? "" : <span className="text-gray-500 font-normal"> (pasif)</span>}
                            </div>
                            {r.roleText && <div className="text-xs text-gray-500">{r.roleText}</div>}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                            {r.noStatement ? (
                              "—"
                            ) : salary ? (
                              <>
                                <div>{formatTL(salary)}</div>
                                {r.salaryRule && (
                                  <div className="text-xs text-gray-500 capitalize">
                                    {formatMonth(monthKey(r.salaryRule.from_month))} –{" "}
                                    {r.salaryRule.to_month ? formatMonth(monthKey(r.salaryRule.to_month)) : "süresiz"}
                                  </div>
                                )}
                              </>
                            ) : r.isDoctor || closed ? (
                              "—"
                            ) : (
                              <span className="text-gray-500">Maaş kuralı yok</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                            {r.bonusCents ? formatTL(r.bonusCents) : "—"}
                          </td>
                          <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${r.otherCents < 0 ? "text-red-600" : ""}`}>
                            {r.otherCents ? formatTL(r.otherCents) : "—"}
                          </td>
                          <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap font-semibold ${payroll < 0 ? "text-red-600" : ""}`}>
                            {r.noStatement ? <span className="text-amber-700 font-normal">Döküm yok</span> : formatTL(payroll)}
                            {!r.noStatement && r.isDoctor && r.payeeTotal !== payroll && (
                              <div className="text-xs text-gray-500 font-normal">Hakedişle birlikte {formatTL(r.payeeTotal)}</div>
                            )}
                            {closed && (r.noStatement ? r.livePayroll !== 0 : r.livePayroll !== payroll) && (
                              <div className="text-xs text-amber-700 font-normal">Güncel hesap {formatTL(r.livePayroll)}</div>
                            )}
                          </td>
                          {showBank && (
                            <>
                              <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                                {r.bankCents === null ? "—" : formatTL(r.bankCents)}
                              </td>
                              <td
                                className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${
                                  r.cashCents !== null && r.cashCents < 0 ? "text-red-600" : ""
                                }`}
                              >
                                {r.cashCents === null ? "—" : formatTL(r.cashCents)}
                              </td>
                            </>
                          )}
                          <td className="py-2 text-right whitespace-nowrap">
                            {editable && r.isActive && (
                              <button
                                type="button"
                                className="text-blue-600 hover:underline"
                                onClick={() => setDialog({ kind: "edit", record: null, payeeUserId: r.userId })}
                              >
                                Prim / diğer ekle
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
            {closed && (
              <p className="text-sm text-gray-600 mt-3">
                Kapanmış ay: tutarlar kapanış dökümündendir; kural sonradan değiştiyse güncel hesap ayrıca gösterilir.
                Düzeltmek için ayı klinik sahibi yeniden açıp kapatır.
              </p>
            )}
            {withoutSalary.length > 0 && (
              <p className="text-sm text-gray-600 mt-3">
                Bu ay maaş kuralı olmayan personel: {withoutSalary.map((p) => p.name).join(", ")}.
              </p>
            )}
            <p className="text-xs text-gray-500 mt-3">
              Sabit maaş net tutardır; SGK ve vergi muhasebede takip edilir. Maaş tutarlarını klinik sahibi{" "}
              {mode === "finance" ? (
                <Link href={`${base}/rules`} className="underline">
                  Kurallar
                </Link>
              ) : (
                "Finans → Hakediş → Kurallar"
              )}{" "}
              sayfasından girer. Ay kapatılınca personelin maaşı ve primi Finans&apos;a personel gideri olarak, hekimin
              primi hakediş kaydıyla birlikte yazılır. Avans yoktur; kesinti için eksi tutarlı “Diğer” satırı girin.
              {showBank &&
                " Bankadan: kişinin bu ay bankadan ödenen sabit tutarı (Kurallar'daki “Bankadan ödenen sabit tutar”); Elden: bu ayın toplamından kalan kısım (hekimde hakediş dahil toplamdan). Toplamı değiştirmez; ay kapatılınca Finans kaydının açıklamasına yazılır."}
            </p>
          </Card>

          <Card
            title="Prim ve diğer kayıtları"
            actions={
              voidedCount > 0 ? (
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
                  İptal edilenleri göster ({voidedCount})
                </label>
              ) : undefined
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-700 border-b">
                    <th className="py-2 pr-3 font-semibold">Kişi</th>
                    <th className="py-2 pr-3 font-semibold">Tür</th>
                    <th className="py-2 pr-3 font-semibold">Açıklama</th>
                    <th className="py-2 pr-3 font-semibold text-right">Tutar</th>
                    <th className="py-2 pr-3 font-semibold">Giren</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-gray-500">
                        Bu ay için prim ya da diğer kaydı yok.
                      </td>
                    </tr>
                  ) : (
                    visible.map((a) => {
                      const voided = !!a.voided_at;
                      return (
                        <tr key={a.id} className={`border-b last:border-b-0 align-top ${voided ? "text-gray-400" : ""}`}>
                          <td className={`py-2 pr-3 ${voided ? "line-through" : "font-medium"}`}>{a.payee_name}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">{ADJUSTMENT_KIND_LABELS[a.kind] ?? a.kind}</td>
                          <td className="py-2 pr-3">
                            <div className={voided ? "line-through" : ""}>{a.description}</div>
                            {voided && (
                              <div className="text-xs text-red-600">
                                İptal edildi{a.voided_by_name ? ` (${a.voided_by_name})` : ""}: {a.void_reason}
                              </div>
                            )}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${voided ? "line-through" : ""} ${
                              a.amount_cents < 0 ? "text-red-600" : ""
                            }`}
                          >
                            {formatTL(a.amount_cents)}
                          </td>
                          <td className="py-2 pr-3 text-xs text-gray-600 whitespace-nowrap">
                            {a.created_by_name ?? "—"}
                            <div>{formatTimestamp(a.created_at)}</div>
                            {a.updated_by_name && a.updated_at !== a.created_at && !voided && (
                              <div>Düzelten: {a.updated_by_name}</div>
                            )}
                          </td>
                          <td className="py-2 text-right whitespace-nowrap space-x-3">
                            {editable && !voided && (
                              <>
                                <button
                                  type="button"
                                  className="text-blue-600 hover:underline"
                                  onClick={() => setDialog({ kind: "edit", record: a })}
                                >
                                  Düzenle
                                </button>
                                <button
                                  type="button"
                                  className="text-red-600 hover:underline"
                                  onClick={() => setDialog({ kind: "void", record: a })}
                                >
                                  İptal et
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
                {adjustments.some((a) => !a.voided_at) && (
                  <tfoot className="border-t font-semibold">
                    <tr>
                      <td className="py-2 pr-3" colSpan={3}>
                        Toplam
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${liveTotal < 0 ? "text-red-600" : ""}`}>
                        {formatTL(liveTotal)}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </Card>
        </>
      )}

      {dialog?.kind === "edit" && (
        <AdjustmentDialog
          key={dialog.record?.id ?? `new:${dialog.payeeUserId ?? ""}`}
          refData={refData}
          month={month}
          record={dialog.record}
          payeeUserId={dialog.payeeUserId}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
          onSaved={(already, edit) =>
            done(already ? (edit ? "Değişiklik yok; kayıt aynı kaldı." : "Kayıt zaten vardı.") : edit ? "Kayıt düzeltildi." : "Kayıt eklendi.")
          }
        />
      )}
      {dialog?.kind === "void" && (
        <HkVoidDialog
          title="Prim / diğer kaydını iptal et"
          body={`${dialog.record.payee_name} · ${ADJUSTMENT_KIND_LABELS[dialog.record.kind] ?? dialog.record.kind} · ${formatTL(dialog.record.amount_cents)}. Kayıt silinmez, iptal edilmiş olarak kalır ve hesaba girmez.`}
          onVoid={(reason) => finHkVoidAdjustment({ p_id: dialog.record.id, p_version: dialog.record.version, p_reason: reason })}
          onDone={(text) => done(text)}
          onClose={() => setDialog(null)}
          onReload={reloadAll}
        />
      )}
    </div>
  );
}

/** Add / correct one bonus or other row of the page's month (fin_hk_save_adjustment). */
function AdjustmentDialog({
  refData,
  month,
  record,
  payeeUserId,
  onClose,
  onSaved,
  onReload,
}: {
  refData: HkReferenceJson;
  month: string;
  record: HkAdjustmentJson | null;
  payeeUserId?: string;
  onClose: () => void;
  onSaved: (alreadySaved: boolean, edit: boolean) => void | Promise<void>;
  onReload: () => void;
}) {
  const [id] = useState(() => record?.id ?? newId());
  const [payee, setPayee] = useState(record?.payee_user_id ?? payeeUserId ?? "");
  const [kind, setKind] = useState<HkAdjustmentKind>(record?.kind ?? "bonus");
  const [amount, setAmount] = useState(centsToInput(record?.amount_cents));
  const [description, setDescription] = useState(record?.description ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  // Any active user of the clinic (an inactive one stays selectable on the row that already names them).
  const people = refData.payees.filter((p) => p.is_active || p.user_id === record?.payee_user_id);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    setError(null);
    const a = parseTL(amount, { allowNegative: true });
    if (!a.ok) return setFormError(`Tutar: ${a.error}`);
    const input = {
      month: record ? monthKey(record.month) : month,
      payee_user_id: payee || null,
      kind,
      amount_cents: a.cents,
      description,
    };
    const invalid = validateAdjustment(input);
    if (invalid) return setFormError(invalid);
    setBusy(true);
    try {
      const res = await finHkSaveAdjustment({
        p_id: id,
        p_version: record?.version ?? 0,
        p_month: input.month,
        p_payee_user_id: payee,
        p_kind: kind,
        p_amount_cents: a.cents,
        p_description: description.trim(),
      });
      await onSaved(res.already_saved, !!record);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? "Prim / diğer kaydını düzelt" : "Prim / diğer ekle"} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700 capitalize">{formatMonth(record ? monthKey(record.month) : month)}</p>
        <Field label="Kişi" hint="Personel ya da hekim; hekimin primi ay sonunda hakediş kaydına eklenir.">
          <select className={inputClass} value={payee} onChange={(e) => setPayee(e.target.value)} required>
            <option value="">Seçin</option>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.name}
                {p.doctor_id ? " (hekim)" : p.role === "owner" ? " (klinik sahibi)" : ""}
                {p.is_active ? "" : " (pasif)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tür">
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as HkAdjustmentKind)}>
            {HK_ADJUSTMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ADJUSTMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tutar (TL, net)" hint="Kesinti için eksi tutar girin (ör. -500).">
          <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Açıklama" hint={`En fazla ${HK_ADJUSTMENT_DESCRIPTION_MAX} karakter.`}>
          <textarea
            className={inputClass}
            rows={2}
            maxLength={HK_ADJUSTMENT_DESCRIPTION_MAX}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
        </Field>
        {formError && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{formError}</div>}
        <ErrorBox error={error} onReload={onReload} />
        <DialogButtons busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
