"use client";

// Ay özeti of the Hakediş pages (finance and prep modes, HakedisParts): per payee the month's figures (with the bank /
// cash split of 0032 when a payee has a bank part; v1.4: the lab costs taken off the ciro in the Lab column and the
// minimum top-up; 0033: the 'Ödenmemiş' column and the procedure piece fees), the warnings, the close / reopen of the
// month (finance mode only) and the lines and pieces per doctor (by procedure group). 0034: the informational
// UNMARKED_AS_CHILD warning (a doctor's unmarked patients counted as children) with a link to the marks.

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import {
  ComponentBreakdown,
  HK_BASE,
  HakedisTabs,
  MonthPicker,
  MonthStatusBadge,
  useHkMonth,
  useHkMonthData,
  useHkReference,
  type HkMode,
} from "./HakedisParts";
import { Card, ErrorBox, Loading, Modal, SuccessBox, buttonDanger, buttonPrimary, buttonSecondary } from "./ui";
import { formatDay, formatMonth, formatTL, formatTimestamp, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  HK_LINE_METHODS,
  HK_METHODS,
  KIND_LABELS,
  LAB_LABELS,
  METHOD_LABELS,
  MINIMUM_TOPUP_COMPONENT_LABEL,
  SEGMENT_LABELS,
  SPLIT_LABELS,
  bankSplitOf,
  bankSplitText,
  componentKey,
  finHkCloseMonth,
  finHkReopenMonth,
  formatBp,
  hkCanPrepare,
  hkLedgerVisible,
  isLabWarning,
  monthKey,
  sumPayeeSummaries,
  summarizePayee,
  warningText,
  type HkComponentJson,
  type HkLineJson,
  type HkLineMethod,
  type HkMonthPayload,
  type HkStatementJson,
} from "@/lib/hakedis";
import { formatMoney } from "@/lib/payments";

type Dialog = "close" | "reopen" | null;

/** Shown in prep mode instead of the close / reopen buttons. */
export const HK_PREP_CLOSE_TEXT = "Ayı klinik sahibi Finans → Hakediş'ten kapatır.";

/**
 * Hakediş month (spec §2, v1.2): per payee ciro by payment method, implant part, lab, deductions, matrah, rate, share,
 * implants, management share, fixed salary, bonus / other and total, the bank / cash split (v1.3), the minimum top-up
 * and the lab costs taken off the ciro (v1.4; per doctor and lab in Lab özeti), the warnings, the
 * close / reopen of the month (finance mode) and the lines per doctor. Figures come from fin_hk_month (fin__hk_compute in the database); nothing is
 * recomputed here. Ledger figures (paid / remaining, finance entry links) only when the server sends them.
 */
export function HakedisMonthView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [month, setMonth] = useHkMonth(ref.data);
  const { data: current, error, loading, reload, setData } = useHkMonthData(month);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const base = HK_BASE[mode];

  const reloadAll = async () => {
    await Promise.all([ref.reload(), reload()]);
  };

  if (!ref.data || !month) {
    return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  }

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HakedisTabs mode={mode} month={month} />
        <MonthPicker
          month={month}
          max={ref.data.current_month}
          onChange={(m) => {
            setMessage(null);
            setOpen(new Set());
            setMonth(m);
          }}
        />
      </div>

      <SuccessBox text={message} />
      <ErrorBox error={error} onReload={reloadAll} />

      {ref.data.rules.length === 0 &&
        (mode === "finance" ? (
          <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
            Henüz hakediş kuralı yok. Oranları ve maaşları{" "}
            <Link href={`${base}/rules`} className="underline">
              Kurallar
            </Link>{" "}
            sayfasından girin; tahsilat satırlarını{" "}
            <Link href={`${base}/lines?month=${month}`} className="underline">
              Satırlar ve hastalar
            </Link>{" "}
            sayfasından ekleyin.
          </div>
        ) : (
          <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
            Henüz hakediş kuralı yok. Oranları ve maaş tutarlarını klinik sahibi Finans → Hakediş → Kurallar
            sayfasından girer.
          </div>
        ))}

      {!current ? (
        loading ? <Loading /> : null
      ) : (
        <>
          <StatusCard
            data={current}
            mode={mode}
            labHref={`${base}/lab?month=${month}`}
            busy={loading}
            onClose={() => setDialog("close")}
            onReopen={() => setDialog("reopen")}
          />
          {current.warnings.length > 0 && (
            <div className="p-4 rounded bg-amber-50 text-amber-900 text-sm space-y-1">
              <div className="font-semibold">Uyarılar</div>
              <ul className="list-disc pl-5 space-y-1">
                {current.warnings.map((w, i) => (
                  <li key={`${w.code}:${i}`}>{warningText(w)}</li>
                ))}
              </ul>
              {current.warnings.some((w) => w.code === "UNRULED_LINES" || w.code === "UNRULED_PIECES") &&
                (mode === "finance" ? (
                  <p className="pt-1">
                    <Link href={`${base}/rules`} className="underline">
                      Kurallar sayfasında
                    </Link>{" "}
                    eksik kuralı ekleyin ya da satırın hekimini düzeltin.
                  </p>
                ) : (
                  <p className="pt-1">Satırın hekimini kontrol edin; kural eksikse klinik sahibine bildirin.</p>
                ))}
              {current.warnings.some((w) => w.code === "BANK_OVER_TOTAL") && (
                <p className="pt-1">
                  {current.status === "open" ? "Tutarlar değişmez ve ay kapatılabilir; " : "Tutarlar değişmez; "}
                  bankadan ödenen sabit tutar{" "}
                  {mode === "finance" ? (
                    <>
                      <Link href={`${base}/rules`} className="underline">
                        Kurallar
                      </Link>{" "}
                      sayfasından kontrol edilebilir.
                      {current.status === "closed" &&
                        " Kapalı ayda düzeltme için ay yeniden açılıp tekrar kapatılmalıdır."}
                    </>
                  ) : (
                    "yanlışsa klinik sahibine bildirin."
                  )}
                </p>
              )}
              {current.warnings.some((w) => w.code === "UNASSIGNED_PIECES") && (
                <p className="pt-1">
                  Atanmamış işlemler ayın kapatılmasını engellemez. İşlemi yapan hekimi{" "}
                  <Link href={`${base}/lines?month=${month}&tab=pieces`} className="underline">
                    Satırlar ve hastalar → İmplant ve işlemler
                  </Link>{" "}
                  sekmesinden seçin.
                </p>
              )}
              {current.warnings.some((w) => w.code === "UNMARKED_AS_CHILD") && (
                <p className="pt-1">
                  Bilgi amaçlıdır, ayın kapatılmasını engellemez. Hekimin çocuk kuralı işaretsiz hastaları çocuk sayar;
                  yetişkin hastayı{" "}
                  <Link href={`${base}/lines?month=${month}`} className="underline">
                    Satırlar ve hastalar
                  </Link>{" "}
                  sayfasında satırdaki “İşaretle” ile “Yetişkin” olarak işaretleyin (hasta grubu notu “işaretsiz — hekimin
                  varsayılanı” olan satırlar).
                </p>
              )}
              {current.warnings.some(isLabWarning) && (
                <p className="pt-1">
                  Lab uyarıları ayın kapatılmasını engellemez. Hekim ve laboratuvar ayrıntısı{" "}
                  <Link href={`${base}/lab?month=${month}`} className="underline">
                    {LAB_LABELS.tab}
                  </Link>{" "}
                  sayfasındadır
                  {current.warnings.some((w) => w.code === "UNRULED_LAB")
                    ? mode === "finance"
                      ? "; lab gideri düşülmeyen hekim için ciro payı kuralını Kurallar sayfasından ekleyin ya da lab giderinin hekimini düzeltin."
                      : "; lab giderinin hekimini kontrol edin, kural eksikse klinik sahibine bildirin."
                    : "."}
                </p>
              )}
            </div>
          )}
          {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}
          <PayeeTable data={current} open={open} onToggle={toggle} />
          {current.status === "closed" && <StatementsCard data={current} />}
          <LinesByDoctor data={current} month={month} base={base} />
        </>
      )}

      {mode === "finance" && dialog === "close" && current && (
        <CloseDialog
          data={current}
          onClose={() => setDialog(null)}
          onReload={async () => {
            setDialog(null);
            await reloadAll();
          }}
          onDone={async (next) => {
            setDialog(null);
            setData(next);
            setMessage(
              next.already_saved
                ? "Bu ay zaten kapatılmıştı."
                : "Ay kapatıldı. Hakediş ve maaş kayıtları Finans → Ödeme ve tahsilatlar listesinde oluşturuldu / güncellendi."
            );
            await ref.reload();
          }}
        />
      )}
      {mode === "finance" && dialog === "reopen" && current && (
        <ReopenDialog
          data={current}
          onClose={() => setDialog(null)}
          onReload={async () => {
            setDialog(null);
            await reloadAll();
          }}
          onDone={async (next) => {
            setDialog(null);
            setData(next);
            setMessage(
              next.already_saved
                ? "Bu ay zaten açıktı."
                : "Ay yeniden açıldı. Finans kayıtları olduğu gibi kaldı; ay tekrar kapatılınca tutarları güncellenir."
            );
            await ref.reload();
          }}
        />
      )}
    </div>
  );
}

function StatusCard({
  data,
  mode,
  labHref,
  busy,
  onClose,
  onReopen,
}: {
  data: HkMonthPayload;
  mode: HkMode;
  /** the month's Lab özeti page */
  labHref: string;
  busy: boolean;
  onClose: () => void;
  onReopen: () => void;
}) {
  const closed = data.status === "closed";
  const grand = data.payees.reduce((sum, p) => sum + p.total_cents, 0);
  const finance = mode === "finance";
  // 0032: the month's lab costs of every doctor and what the hakediş took off (lab_totals; absent before 0032).
  const labCost = data.lab_totals?.reduce((sum, t) => sum + t.cost_cents, 0) ?? 0;
  const labDeducted = data.lab_totals?.reduce((sum, t) => sum + t.deducted_cents, 0) ?? 0;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold capitalize">{formatMonth(monthKey(data.month))}</span>
            <MonthStatusBadge status={data.status} />
            {!closed && (
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">
                Tahmini — ay kapanınca kesinleşir
              </span>
            )}
          </div>
          {closed ? (
            <p className="text-sm text-gray-600">
              Kapatan: {data.closed_by_name ?? "—"} · {formatTimestamp(data.closed_at)}
            </p>
          ) : data.is_closable ? (
            <p className="text-sm text-gray-600">
              Ay bitti; satırlar tamamsa ay kapatılabilir.{finance ? "" : ` ${HK_PREP_CLOSE_TEXT}`}
            </p>
          ) : (
            <p className="text-sm text-gray-600">
              Ay henüz bitmedi; ay bittikten sonra kapatılabilir.{finance ? "" : ` ${HK_PREP_CLOSE_TEXT}`}
            </p>
          )}
          {data.reopened_at && (
            <p className="text-xs text-gray-500">
              Son yeniden açma: {data.reopened_by_name ?? "—"} · {formatTimestamp(data.reopened_at)}
            </p>
          )}
        </div>
        {finance && (
          <div className="flex flex-wrap gap-2">
            {data.can_write && !closed && data.is_closable && (
              <button type="button" className={buttonPrimary} onClick={onClose} disabled={busy}>
                Ayı kapat
              </button>
            )}
            {data.can_write && closed && data.is_owner && (
              <button type="button" className={buttonDanger} onClick={onReopen} disabled={busy}>
                Ayı yeniden aç
              </button>
            )}
          </div>
        )}
      </div>
      <div className="grid gap-x-8 gap-y-1 mt-4 sm:grid-cols-2 text-sm">
        <div className="flex justify-between gap-4 py-1 border-b">
          <span className="text-gray-700">Klinik cirosu (brüt, tüm satırlar)</span>
          <span className="tabular-nums">{formatTL(data.clinic_total_cents)}</span>
        </div>
        <div className="flex justify-between gap-4 py-1 border-b">
          <span className="font-semibold">Toplam hakediş ve maaş</span>
          <span className="tabular-nums font-semibold">{formatTL(grand)}</span>
        </div>
        {data.lab_totals && data.lab_totals.length > 0 && (
          <div className="flex justify-between gap-4 py-1 border-b sm:col-span-2">
            <span className="text-gray-700">
              Ayın lab giderleri ·{" "}
              <Link href={labHref} className="text-blue-600 hover:underline">
                {LAB_LABELS.tab}
              </Link>
            </span>
            <span className="tabular-nums text-right">
              {formatTL(labCost)}
              <span className="block text-xs text-gray-500">
                {LAB_LABELS.deducted.toLocaleLowerCase("tr")} {formatTL(labDeducted)}
              </span>
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

const NUM = "px-3 py-2 text-right tabular-nums whitespace-nowrap";

const dash = (cents: number) => (cents ? formatTL(cents) : "—");

/** "3 × ₺2.000,00" with one implant rule; "3 adet" when the payee has several (other doctors' implants). */
function implantText(components: HkComponentJson[], qty: number): string {
  const rates = components.filter((c) => c.kind === "implant_piece");
  return rates.length === 1 ? `${qty} × ${formatTL(rates[0].piece_cents)}` : `${qty} adet`;
}

/**
 * One row per payee; 'Ayrıntı' opens the component breakdown under the row. The salary, bonus and bank / cash columns
 * appear only in months that have them, so a month of hakediş alone looks as before.
 */
function PayeeTable({ data, open, onToggle }: { data: HkMonthPayload; open: Set<string>; onToggle: (id: string) => void }) {
  const rows = useMemo(() => data.payees.map((p) => ({ payee: p, s: summarizePayee(p) })), [data.payees]);
  const totals = useMemo(() => sumPayeeSummaries(rows.map((r) => r.s)), [rows]);
  const statements = new Map(data.statements.map((st) => [st.payee_user_id, st]));
  const ledger = hkLedgerVisible(data);
  const showSalary = data.payees.some((p) => p.components.some((c) => c.kind === "fixed_monthly"));
  const showAdjustments = data.payees.some((p) => p.components.some((c) => c.kind === "adjustments"));
  // 0032 (v1.4): the minimum top-up column when a payee's floor applies this month.
  const showTopup = rows.some((r) => r.s.minimum_topup_cents !== 0);
  // 0032: Bankadan / Elden when a payee has a bank part this month (part of the total, never on top of it).
  const showBank = rows.some((r) => r.s.bank_cents !== null);
  // 0033: the 'Ödenmemiş' column when a payee has unpaid (Macro) ciro, the procedure fee column with procedure_piece.
  const methods: readonly HkLineMethod[] = rows.some((r) => r.s.gross_by_method.unpaid !== 0) ? HK_LINE_METHODS : HK_METHODS;
  const showProcedure = data.payees.some((p) => p.components.some((c) => c.kind === "procedure_piece"));
  const colCount =
    12 +
    methods.length +
    (showProcedure ? 1 : 0) +
    (showSalary ? 1 : 0) +
    (showAdjustments ? 1 : 0) +
    (showTopup ? 1 : 0) +
    (showBank ? 2 : 0);

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto text-gray-900">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr className="text-left text-gray-800">
            <th className="px-3 py-3 font-semibold">Kişi</th>
            {methods.map((m) => (
              <th key={m} className="px-3 py-3 font-semibold text-right whitespace-nowrap">
                {METHOD_LABELS[m]}
              </th>
            ))}
            <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">İmplant payı</th>
            <th className="px-3 py-3 font-semibold text-right">{LAB_LABELS.column}</th>
            <th className="px-3 py-3 font-semibold text-right">Kesintiler</th>
            <th className="px-3 py-3 font-semibold text-right">Matrah</th>
            <th className="px-3 py-3 font-semibold text-right">Oran</th>
            <th className="px-3 py-3 font-semibold text-right">Pay</th>
            <th className="px-3 py-3 font-semibold text-right">İmplant</th>
            {showProcedure && <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">İşlem ücreti</th>}
            <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Yönetim payı</th>
            {showSalary && <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Sabit maaş</th>}
            {showAdjustments && <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Prim ve diğer</th>}
            {showTopup && (
              <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">{MINIMUM_TOPUP_COMPONENT_LABEL}</th>
            )}
            <th className="px-3 py-3 font-semibold text-right">Toplam</th>
            {showBank && (
              <>
                <th className="px-3 py-3 font-semibold text-right">{SPLIT_LABELS.bank}</th>
                <th className="px-3 py-3 font-semibold text-right">{SPLIT_LABELS.cash}</th>
              </>
            )}
            <th className="px-3 py-3 font-semibold">Kayıt</th>
            <th className="px-3 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="px-4 py-8 text-center text-gray-500">
                Bu ay için geçerli kural ya da prim kaydı yok.
              </td>
            </tr>
          ) : (
            rows.map(({ payee, s }) => {
              const st = statements.get(payee.payee_user_id);
              const expanded = open.has(payee.payee_user_id);
              return (
                <Fragment key={payee.payee_user_id}>
                  <tr className="border-b align-top">
                    <td className="px-3 py-2 font-medium">{payee.payee_name}</td>
                    {methods.map((m) => (
                      <td key={m} className={NUM}>
                        {dash(s.gross_by_method[m])}
                      </td>
                    ))}
                    <td className={NUM}>{s.implant_cents ? formatTL(-s.implant_cents) : "—"}</td>
                    <td className={NUM}>
                      {s.lab_cents ? formatTL(-s.lab_cents) : "—"}
                      {s.lab_excess_cents > 0 && (
                        <div className="text-xs text-amber-700">klinikte kalan {formatTL(s.lab_excess_cents)}</div>
                      )}
                    </td>
                    <td className={NUM}>{s.deduction_cents ? formatTL(-s.deduction_cents) : "—"}</td>
                    <td className={NUM}>{dash(s.base_cents)}</td>
                    <td className={NUM}>{s.share_bps.length ? s.share_bps.map((bp) => formatBp(bp)).join(" / ") : "—"}</td>
                    <td className={NUM}>{dash(s.share_cents)}</td>
                    <td className={NUM}>
                      {s.implant_qty || s.implant_amount_cents ? (
                        <>
                          <div>{formatTL(s.implant_amount_cents)}</div>
                          <div className="text-xs text-gray-500">{implantText(payee.components, s.implant_qty)}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    {showProcedure && (
                      <td className={NUM}>
                        {s.procedure_qty || s.procedure_amount_cents ? (
                          <>
                            <div>{formatTL(s.procedure_amount_cents)}</div>
                            <div className="text-xs text-gray-500">{s.procedure_qty} işlem</div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                    <td className={NUM}>{dash(s.management_cents)}</td>
                    {showSalary && <td className={NUM}>{dash(s.salary_cents)}</td>}
                    {showAdjustments && (
                      <td className={`${NUM} ${s.adjustments_cents < 0 ? "text-red-600" : ""}`}>{dash(s.adjustments_cents)}</td>
                    )}
                    {showTopup && <td className={NUM}>{dash(s.minimum_topup_cents)}</td>}
                    <td className={`${NUM} font-semibold ${payee.total_cents < 0 ? "text-red-600" : ""}`}>{formatTL(payee.total_cents)}</td>
                    {showBank && <SplitCells bank={s.bank_cents} cash={s.cash_cents} />}
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      <StatementCell
                        statement={st}
                        liveTotal={payee.total_cents}
                        closed={data.status === "closed"}
                        ledger={ledger}
                      />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        className="text-blue-600 hover:underline"
                        aria-expanded={expanded}
                        onClick={() => onToggle(payee.payee_user_id)}
                      >
                        {expanded ? "Gizle" : "Ayrıntı"}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-b bg-white">
                      <td colSpan={colCount} className="px-3 py-3">
                        {payee.components.length === 0 && (
                          <p className="text-sm text-gray-600 mb-2">
                            Bu ay hakediş ya da maaş çıkmadı; yalnızca bankadan ödenen sabit tutar kuralı var.
                          </p>
                        )}
                        {s.bank_cents !== null && (
                          <p className="text-sm text-gray-700 mb-2 tabular-nums">Ödeme: {bankSplitText(payee)}</p>
                        )}
                        <div className="grid gap-3 lg:grid-cols-2">
                          {payee.components.map((c) => (
                            <ComponentBreakdown key={componentKey(c)} c={c} />
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}
        </tbody>
        {rows.length > 1 && (
          <tfoot className="bg-gray-50 border-t font-semibold">
            <tr>
              <td className="px-3 py-2">Toplam</td>
              {methods.map((m) => (
                <td key={m} className={NUM}>
                  {dash(totals.gross_by_method[m])}
                </td>
              ))}
              <td className={NUM}>{totals.implant_cents ? formatTL(-totals.implant_cents) : "—"}</td>
              <td className={NUM}>{totals.lab_cents ? formatTL(-totals.lab_cents) : "—"}</td>
              <td className={NUM}>{totals.deduction_cents ? formatTL(-totals.deduction_cents) : "—"}</td>
              <td className={NUM}>{dash(totals.base_cents)}</td>
              <td className={NUM} />
              <td className={NUM}>{dash(totals.share_cents)}</td>
              <td className={NUM}>
                {totals.implant_qty || totals.implant_amount_cents ? (
                  <>
                    <div>{formatTL(totals.implant_amount_cents)}</div>
                    <div className="text-xs text-gray-500 font-normal">{totals.implant_qty} adet</div>
                  </>
                ) : (
                  "—"
                )}
              </td>
              {showProcedure && (
                <td className={NUM}>
                  {totals.procedure_qty || totals.procedure_amount_cents ? (
                    <>
                      <div>{formatTL(totals.procedure_amount_cents)}</div>
                      <div className="text-xs text-gray-500 font-normal">{totals.procedure_qty} işlem</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              )}
              <td className={NUM}>{dash(totals.management_cents)}</td>
              {showSalary && <td className={NUM}>{dash(totals.salary_cents)}</td>}
              {showAdjustments && <td className={NUM}>{dash(totals.adjustments_cents)}</td>}
              {showTopup && <td className={NUM}>{dash(totals.minimum_topup_cents)}</td>}
              <td className={NUM}>{formatTL(totals.total_cents)}</td>
              {showBank && <SplitCells bank={totals.bank_cents} cash={totals.cash_cents} />}
              <td colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
      <p className="px-4 py-3 text-xs text-gray-500 border-t">
        Ödeme şekli sütunları hekimin brüt tahsilatıdır (Macro&apos;dan gelen hekimlerde ay içinde yaptığı işlemler;
        “Ödenmemiş” işlemin ay sonuna kadar ödenmemiş kısmıdır). İmplant payı ciroya girmez; kesintiler ödeme şekline
        göre kalan tutardan düşülür. Lab: ortodontide hastanın ödemelerinden önce karşılanan lab gideri, ciro payında ayın
        lab gideri (kesintilerden sonra düşülür; ciroyu aşan kısım klinikte kalır). Oran matraha uygulanır. Yönetim
        payı kliniğin brüt cirosundan hesaplanır. Sabit maaş net tutardır; prim ve diğer satırları o ayın elle girilen tutarlarıdır (eksi
        tutar kesintidir). Ay kapatılınca hekimin bütün tutarları tek hakediş kaydına, personelin maaşı ve primi
        personel gideri olarak Finans&apos;a yazılır.
        {showProcedure && " İşlem ücreti: hekimin “İşlem başı ücret” kurallarındaki gruplarda yaptığı işlemler × tutar."}
        {showTopup &&
          ` ${MINIMUM_TOPUP_COMPONENT_LABEL}: kişinin bu ayki toplamı taban maaşının altında kaldığı için eklenen fark.`}
        {showBank &&
          " Bankadan: kişinin bu ay bankadan (resmi maaş olarak) ödenen sabit tutarı; Elden: toplamdan kalan kısım. Bu bölünme toplamı değiştirmez; ay kapatılınca Finans kaydının açıklamasına yazılır."}
      </p>
    </div>
  );
}

/** Bankadan / Elden cells of a payee (or totals) row; "—" without a bank part, a negative cash part in red. */
function SplitCells({ bank, cash }: { bank: number | null; cash: number | null }) {
  return (
    <>
      <td className={NUM}>{bank === null ? "—" : formatTL(bank)}</td>
      <td className={`${NUM} ${cash !== null && cash < 0 ? "text-red-600" : ""}`}>{cash === null ? "—" : formatTL(cash)}</td>
    </>
  );
}

function StatementCell({
  statement,
  liveTotal,
  closed,
  ledger,
}: {
  statement: HkStatementJson | undefined;
  liveTotal: number;
  closed: boolean;
  /** finance entry link and paid / remaining (finance readers only) */
  ledger: boolean;
}) {
  if (!closed) return <span className="text-gray-500">Ay kapanınca</span>;
  if (!statement) return <span className="text-amber-700">Döküm yok</span>;
  return (
    <div className="space-y-0.5">
      {!statement.fin_entry_id ? (
        <span className="text-gray-500">Kayıt yok (0)</span>
      ) : ledger ? (
        <Link href={`/finance/entries/${statement.fin_entry_id}`} className="text-blue-600 hover:underline">
          Finans kaydı
        </Link>
      ) : (
        <span className="text-gray-700">Finans&apos;a yazıldı</span>
      )}
      {ledger && statement.entry && (
        <div className="text-gray-600">
          {statement.entry.is_cancelled
            ? "İptal edilmiş"
            : `Ödenen ${formatTL(statement.entry.paid_cents)} · kalan ${formatTL(statement.entry.outstanding_cents)}`}
        </div>
      )}
      {statement.total_cents !== liveTotal && (
        <div className="text-amber-700">Kapanışta {formatTL(statement.total_cents)}</div>
      )}
    </div>
  );
}

/** Closed month: what was frozen at close, and whether the live figure has moved since (marks / rules changed). */
function StatementsCard({ data }: { data: HkMonthPayload }) {
  const live = new Map(data.payees.map((p) => [p.payee_user_id, p.total_cents]));
  const moved = data.statements.some((st) => (live.get(st.payee_user_id) ?? 0) !== st.total_cents);
  const ledger = hkLedgerVisible(data);
  // 0032: the bank / cash split frozen in the statement (statements of closes before 0032 have none).
  const splits = new Map(data.statements.map((st) => [st.id, st.breakdown ? bankSplitOf(st.breakdown) : null]));
  const showBank = Array.from(splits.values()).some((x) => x !== null);
  return (
    <Card title="Kapanış dökümleri">
      {data.statements.length === 0 ? (
        <p className="text-sm text-gray-500">Döküm yok.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-700 border-b">
                <th className="py-2 pr-3 font-semibold">Kişi</th>
                <th className="py-2 pr-3 font-semibold text-right">Kapanıştaki toplam</th>
                {showBank && (
                  <>
                    <th className="py-2 pr-3 font-semibold text-right">{SPLIT_LABELS.bank}</th>
                    <th className="py-2 pr-3 font-semibold text-right">{SPLIT_LABELS.cash}</th>
                  </>
                )}
                <th className="py-2 pr-3 font-semibold text-right">Güncel hesap</th>
                {ledger && (
                  <>
                    <th className="py-2 pr-3 font-semibold text-right">Ödenen</th>
                    <th className="py-2 pr-3 font-semibold text-right">Kalan</th>
                    <th className="py-2 font-semibold">Finans kaydı</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.statements.map((st) => {
                const now = live.get(st.payee_user_id) ?? 0;
                const split = splits.get(st.id) ?? null;
                return (
                  <tr key={st.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3">{st.payee_name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">{formatTL(st.total_cents)}</td>
                    {showBank && (
                      <>
                        <td className="py-2 pr-3 text-right tabular-nums">{split ? formatTL(split.bank_cents) : "—"}</td>
                        <td className={`py-2 pr-3 text-right tabular-nums ${split && split.cash_cents < 0 ? "text-red-600" : ""}`}>
                          {split ? formatTL(split.cash_cents) : "—"}
                        </td>
                      </>
                    )}
                    <td className={`py-2 pr-3 text-right tabular-nums ${now !== st.total_cents ? "text-amber-700" : "text-gray-600"}`}>
                      {formatTL(now)}
                    </td>
                    {ledger && (
                      <>
                        <td className="py-2 pr-3 text-right tabular-nums">{st.entry ? formatTL(st.entry.paid_cents) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {st.entry ? (st.entry.is_cancelled ? "İptal" : formatTL(st.entry.outstanding_cents)) : "—"}
                        </td>
                        <td className="py-2">
                          {st.fin_entry_id ? (
                            <Link href={`/finance/entries/${st.fin_entry_id}`} className="text-blue-600 hover:underline">
                              Aç
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-500 mt-3">
        {moved
          ? "Kapanıştan sonra hasta işaretleri ya da kurallar değiştiği için güncel hesap farklı. Kapanış dökümü ve finans kaydı değişmez; düzeltmek için ayı yeniden açıp tekrar kapatın (yalnızca klinik sahibi)."
          : ledger
            ? "Kapanış dökümü ve finans kaydı ay kapatıldığı andaki hesaptır. Ödemeleri finans kaydına ekleyin."
            : "Kapanış dökümü ay kapatıldığı andaki hesaptır; ödemeleri Finans yetkilisi kaydeder."}
      </p>
    </Card>
  );
}

/** Group key of rows without a doctor (0033: Macro lines of the clinic / an outside doctor, unassigned pieces). */
const NO_DOCTOR = "";

/**
 * Drill-down: the month's live lines grouped by doctor, with the engine's segment, rule and lab part, and the doctor's
 * pieces per procedure group (0033). Lines and pieces without a doctor are listed last.
 */
function LinesByDoctor({ data, month, base }: { data: HkMonthPayload; month: string; base: string }) {
  const groups = useMemo(() => {
    type Group = { name: string; lines: HkLineJson[]; gross: number; pieces: Map<string, number> };
    const map = new Map<string, Group>();
    const groupOf = (id: string | null, name: string | null) => {
      const key = id ?? NO_DOCTOR;
      let g = map.get(key);
      if (!g) {
        g = { name: id ? name ?? "" : "Hekimsiz (klinik / dışarıdan hekim)", lines: [], gross: 0, pieces: new Map() };
        map.set(key, g);
      }
      return g;
    };
    for (const l of data.lines) {
      if (l.voided_at) continue;
      const g = groupOf(l.doctor_id, l.doctor_name);
      g.lines.push(l);
      g.gross += l.try_cents;
    }
    for (const p of data.pieces) {
      if (p.voided_at) continue;
      const g = groupOf(p.doctor_id, p.doctor_name);
      const label = p.doctor_id || !p.assigned_none ? p.proc_group_name ?? "implant" : `${p.proc_group_name ?? "işlem"} (hakediş yok)`;
      g.pieces.set(label, (g.pieces.get(label) ?? 0) + p.qty);
    }
    return Array.from(map.entries()).sort(
      (a, b) => Number(a[0] === NO_DOCTOR) - Number(b[0] === NO_DOCTOR) || a[1].name.localeCompare(b[1].name, "tr")
    );
  }, [data.lines, data.pieces]);
  const payeeOfRule = new Map<string, string>();
  for (const p of data.payees) for (const c of p.components) if (c.rule_id) payeeOfRule.set(c.rule_id, p.payee_name);

  return (
    <Card
      title="Hekime göre satırlar"
      actions={
        <Link href={`${base}/lines?month=${month}`} className={buttonSecondary}>
          {data.status === "open" && hkCanPrepare(data) ? "Satırları düzenle" : "Satırları aç"}
        </Link>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">Bu ay için tahsilat satırı ya da implant / işlem kaydı yok.</p>
      ) : (
        <div className="space-y-2">
          {groups.map(([doctorId, g]) => {
            const pieceText = Array.from(g.pieces, ([label, qty]) => `${qty} ${label}`).join(", ");
            return (
              <details key={doctorId || "none"} className="rounded border">
                <summary className="cursor-pointer px-3 py-2 flex flex-wrap justify-between gap-2 text-sm">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-gray-600 tabular-nums">
                    {g.lines.length} satır · brüt {formatTL(g.gross)}
                    {pieceText ? ` · ${doctorId === NO_DOCTOR ? "atanmamış / hakedişsiz: " : ""}${pieceText}` : ""}
                  </span>
                </summary>
                {g.lines.length > 0 && (
                  <div className="overflow-x-auto border-t">
                    <table className="w-full text-xs md:text-sm">
                      <thead className="bg-gray-50">
                        <tr className="text-left text-gray-700">
                          <th className="px-3 py-2 font-medium">Tarih</th>
                          <th className="px-3 py-2 font-medium">Hasta</th>
                          <th className="px-3 py-2 font-medium">Ödeme</th>
                          <th className="px-3 py-2 font-medium text-right">Tutar</th>
                          <th className="px-3 py-2 font-medium text-right">İmplant payı</th>
                          <th className="px-3 py-2 font-medium text-right">Lab payı</th>
                          <th className="px-3 py-2 font-medium">Hasta grubu</th>
                          <th className="px-3 py-2 font-medium">Kural</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.id} className="border-t">
                            <td className="px-3 py-1.5 whitespace-nowrap">{formatDay(l.day)}</td>
                            <td className="px-3 py-1.5">
                              {l.patient_name}
                              {(l.procedure || l.ext_doctor) && (
                                <div className="text-xs text-gray-500">
                                  {[l.procedure, l.tooth ? `diş ${l.tooth}` : null, !l.doctor_id ? l.ext_doctor : null]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-1.5 whitespace-nowrap">{METHOD_LABELS[l.method] ?? l.method}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                              {formatTL(l.try_cents)}
                              {l.currency !== "TRY" && (
                                <div className="text-xs text-gray-500">{formatMoney(l.amount_cents, l.currency)}</div>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{dash(l.implant_cents)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{dash(l.lab_part ?? 0)}</td>
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              {!l.doctor_id ? "—" : l.resolved_segment ? SEGMENT_LABELS[l.resolved_segment] : "—"}
                              {l.segment ? <span className="text-xs text-gray-500"> (elle)</span> : null}
                            </td>
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              {!l.doctor_id ? (
                                <span className="text-gray-600">Yalnız klinik cirosu</span>
                              ) : l.rule_kind && l.rule_id ? (
                                <>
                                  {KIND_LABELS[l.rule_kind]}
                                  {payeeOfRule.get(l.rule_id) && (
                                    <span className="text-xs text-gray-500"> · {payeeOfRule.get(l.rule_id)}</span>
                                  )}
                                </>
                              ) : (
                                <span className="text-amber-700">Kural yok</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </details>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CloseDialog({
  data,
  onClose,
  onReload,
  onDone,
}: {
  data: HkMonthPayload;
  onClose: () => void;
  onReload: () => void;
  onDone: (next: HkMonthPayload) => void | Promise<void>;
}) {
  const unruled = data.warnings.filter((w) => w.code === "UNRULED_LINES" || w.code === "UNRULED_PIECES");
  const negative = data.payees.filter((p) => p.total_cents < 0);
  const bankOver = data.warnings.filter((w) => w.code === "BANK_OVER_TOTAL");
  const labWarnings = data.warnings.filter(isLabWarning);
  const unassigned = data.warnings.filter((w) => w.code === "UNASSIGNED_PIECES");
  const unmarked = data.warnings.filter((w) => w.code === "UNMARKED_AS_CHILD");
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);
  const label = formatMonth(monthKey(data.month));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const next = await finHkCloseMonth({ p_month: data.month, p_version: data.version, p_accept_unruled: accept });
      await onDone(next);
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Ayı kapat: ${label}`} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700">
          Kapatınca her kişi için bu ayın dökümü saklanır. Hekimin bu ayki hakediş kaydı (maaşı ve primi varsa dahil)
          ve personelin bu ayki maaş kaydı (personel gideri) Finans → Ödeme ve tahsilatlar listesinde oluşturulur ya da
          tutarı güncellenir. Kapalı ayın ve ondan önceki ayların satırları, implant, lab ve prim kayıtları
          değiştirilemez; düzeltmeler son kapatılan aydan sonraki bir aya düzeltme satırı olarak girilir.
          {data.payees.some((p) => bankSplitOf(p)) &&
            " Bankadan ödenen sabit tutarı olan kişinin kaydının açıklamasına bankadan ve elden ödenecek kısımlar yazılır; kayıt tutarı yine toplamdır."}
          {data.payees.some((p) => p.components.some((c) => c.kind === "minimum_topup")) &&
            " Taban maaşı tamamlanan kişinin kaydının açıklamasına taban maaş tamamlaması ayrıca yazılır."}
        </p>
        <div className="rounded border">
          {data.payees.length === 0 ? (
            <p className="p-3 text-sm text-gray-500">Bu ay için hakediş ya da maaş çıkmadı.</p>
          ) : (
            data.payees.map((p) => {
              const split = bankSplitText(p);
              return (
                <div key={p.payee_user_id} className="flex justify-between gap-4 px-3 py-2 border-b last:border-b-0 text-sm">
                  <span>{p.payee_name}</span>
                  <span className="text-right">
                    <span className={`tabular-nums font-medium ${p.total_cents < 0 ? "text-red-600" : ""}`}>{formatTL(p.total_cents)}</span>
                    {split && <span className="block text-xs text-gray-600 tabular-nums">{split}</span>}
                  </span>
                </div>
              );
            })
          )}
        </div>
        {negative.length > 0 && (
          <div className="p-3 rounded bg-red-50 text-red-700 text-sm">
            Toplamı eksi çıkan kişi var ({negative.map((p) => p.payee_name).join(", ")}). Ay kapatılamaz; düzeltme
            satırlarını ve kesintileri kontrol edin.
          </div>
        )}
        {bankOver.length > 0 && (
          <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-1">
            <ul className="list-disc pl-5 space-y-1">
              {bankOver.map((w, i) => (
                <li key={i}>{warningText(w)}</li>
              ))}
            </ul>
            <p>Tutarlar değişmez; ay yine de kapatılabilir.</p>
          </div>
        )}
        {labWarnings.length > 0 && (
          <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-1">
            <ul className="list-disc pl-5 space-y-1">
              {labWarnings.map((w, i) => (
                <li key={i}>{warningText(w)}</li>
              ))}
            </ul>
            <p>Tutarlar bu şekilde yazılır; ay yine de kapatılabilir.</p>
          </div>
        )}
        {unassigned.length > 0 && (
          <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-1">
            <ul className="list-disc pl-5 space-y-1">
              {unassigned.map((w, i) => (
                <li key={i}>{warningText(w)}</li>
              ))}
            </ul>
            <p>Bu işlemler kimsenin hakedişine girmeden ay kapatılabilir; kapandıktan sonra atanamaz.</p>
          </div>
        )}
        {unmarked.length > 0 && (
          <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-1">
            <ul className="list-disc pl-5 space-y-1">
              {unmarked.map((w, i) => (
                <li key={i}>{warningText(w)}</li>
              ))}
            </ul>
            <p>Bu hastalar çocuk sayılarak kapatılır; kapandıktan sonra işaret o ayın dökümünü değiştirmez.</p>
          </div>
        )}
        {unruled.length > 0 && (
          <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm space-y-2">
            <ul className="list-disc pl-5 space-y-1">
              {unruled.map((w, i) => (
                <li key={i}>{warningText(w)}</li>
              ))}
            </ul>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
              <span>Kuralı olmayan satırlar bu ay kimsenin hakedişine girmeden kapat.</span>
            </label>
          </div>
        )}
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button
            type="submit"
            className={buttonPrimary}
            disabled={busy || negative.length > 0 || (unruled.length > 0 && !accept)}
          >
            {busy ? "Kapatılıyor..." : "Ayı kapat"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReopenDialog({
  data,
  onClose,
  onReload,
  onDone,
}: {
  data: HkMonthPayload;
  onClose: () => void;
  onReload: () => void;
  onDone: (next: HkMonthPayload) => void | Promise<void>;
}) {
  const [error, setError] = useState<FinanceError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onDone(await finHkReopenMonth({ p_month: data.month, p_version: data.version }));
    } catch (err) {
      setError(toFinanceError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Ayı yeniden aç: ${formatMonth(monthKey(data.month))}`} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700">
          Ay yeniden açılınca kapanış dökümleri geçersiz sayılır (silinmez) ve bu ayın satırları yeniden
          değiştirilebilir. Finans kayıtları ve yapılmış ödemeler olduğu gibi kalır; ay tekrar kapatılınca hakediş ve
          maaş tutarları güncellenir.
        </p>
        <ErrorBox error={error} onReload={onReload} />
        <div className="flex gap-2">
          <button type="submit" className={buttonDanger} disabled={busy}>
            {busy ? "Kaydediliyor..." : "Ayı yeniden aç"}
          </button>
          <button type="button" className={buttonSecondary} onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
        </div>
      </form>
    </Modal>
  );
}
