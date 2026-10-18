"use client";

import Link from "next/link";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FinanceShell, useCanWriteFinance } from "@/components/finance/FinanceShell";
import {
  ComponentBreakdown,
  HakedisTabs,
  MonthPicker,
  MonthStatusBadge,
  useHkMonth,
  useHkReference,
} from "@/components/finance/HakedisParts";
import { Card, ErrorBox, Loading, Modal, SuccessBox, buttonDanger, buttonPrimary, buttonSecondary } from "@/components/finance/ui";
import { formatDay, formatMonth, formatTL, formatTimestamp, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  HK_METHODS,
  KIND_LABELS,
  METHOD_LABELS,
  SEGMENT_LABELS,
  finHkCloseMonth,
  finHkMonth,
  finHkReopenMonth,
  formatBp,
  monthKey,
  summarizePayee,
  warningText,
  type HkComponentJson,
  type HkLineJson,
  type HkMethod,
  type HkMonthPayload,
  type HkPayeeSummary,
  type HkStatementJson,
} from "@/lib/hakedis";
import { formatMoney } from "@/lib/payments";

export default function FinanceHakedisPage() {
  return (
    <FinanceShell title="Hakediş">
      <Suspense fallback={<Loading />}>
        <MonthSummary />
      </Suspense>
    </FinanceShell>
  );
}

type Dialog = "close" | "reopen" | null;

/**
 * Hakediş month (spec §2): per payee ciro by payment method, implant part, lab, deductions, matrah, rate, share,
 * implants, management share and total, the warnings, the close / reopen of the month and the lines per doctor.
 * Figures come from fin_hk_month (fin__hk_compute in the database); nothing is recomputed here.
 */
function MonthSummary() {
  const canWrite = useCanWriteFinance();
  const ref = useHkReference();
  const [month, setMonth] = useHkMonth(ref.data);
  const [data, setData] = useState<HkMonthPayload | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!month) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await finHkMonth(month);
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(toFinanceError(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    load();
  }, [load]);

  const reloadAll = async () => {
    await Promise.all([ref.reload(), load()]);
  };

  const current = data && month && monthKey(data.month) === month ? data : null;

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
        <HakedisTabs month={month} />
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

      {ref.data.rules.length === 0 && (
        <div className="p-4 rounded bg-amber-50 text-amber-800 text-sm">
          Henüz hakediş kuralı yok. Oranları{" "}
          <Link href="/finance/hakedis/rules" className="underline">
            Kurallar
          </Link>{" "}
          sayfasından girin; tahsilat satırlarını{" "}
          <Link href={`/finance/hakedis/lines?month=${month}`} className="underline">
            Satırlar ve hastalar
          </Link>{" "}
          sayfasından ekleyin.
        </div>
      )}

      {!current ? (
        loading ? <Loading /> : null
      ) : (
        <>
          <StatusCard
            data={current}
            canWrite={canWrite}
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
              {current.warnings.some((w) => w.code === "UNRULED_LINES" || w.code === "UNRULED_PIECES") && (
                <p className="pt-1">
                  <Link href="/finance/hakedis/rules" className="underline">
                    Kurallar sayfasında
                  </Link>{" "}
                  eksik kuralı ekleyin ya da satırın hekimini düzeltin.
                </p>
              )}
            </div>
          )}
          {loading && <p className="text-sm text-gray-500">Güncelleniyor...</p>}
          <PayeeTable data={current} open={open} onToggle={toggle} />
          {current.status === "closed" && <StatementsCard data={current} />}
          <LinesByDoctor data={current} month={month} />
        </>
      )}

      {dialog === "close" && current && (
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
                : "Ay kapatıldı. Hakediş kayıtları Finans → Ödeme ve tahsilatlar listesinde oluşturuldu / güncellendi."
            );
            await ref.reload();
          }}
        />
      )}
      {dialog === "reopen" && current && (
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
  canWrite,
  busy,
  onClose,
  onReopen,
}: {
  data: HkMonthPayload;
  canWrite: boolean;
  busy: boolean;
  onClose: () => void;
  onReopen: () => void;
}) {
  const closed = data.status === "closed";
  const grand = data.payees.reduce((sum, p) => sum + p.total_cents, 0);
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
            <p className="text-sm text-gray-600">Ay bitti; satırlar tamamsa ay kapatılabilir.</p>
          ) : (
            <p className="text-sm text-gray-600">Ay henüz bitmedi; ay bittikten sonra kapatılabilir.</p>
          )}
          {data.reopened_at && (
            <p className="text-xs text-gray-500">
              Son yeniden açma: {data.reopened_by_name ?? "—"} · {formatTimestamp(data.reopened_at)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && !closed && data.is_closable && (
            <button type="button" className={buttonPrimary} onClick={onClose} disabled={busy}>
              Ayı kapat
            </button>
          )}
          {canWrite && closed && data.is_owner && (
            <button type="button" className={buttonDanger} onClick={onReopen} disabled={busy}>
              Ayı yeniden aç
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-x-8 gap-y-1 mt-4 sm:grid-cols-2 text-sm">
        <div className="flex justify-between gap-4 py-1 border-b">
          <span className="text-gray-700">Klinik cirosu (brüt, tüm satırlar)</span>
          <span className="tabular-nums">{formatTL(data.clinic_total_cents)}</span>
        </div>
        <div className="flex justify-between gap-4 py-1 border-b">
          <span className="font-semibold">Toplam hakediş</span>
          <span className="tabular-nums font-semibold">{formatTL(grand)}</span>
        </div>
      </div>
    </Card>
  );
}

const NUM = "px-3 py-2 text-right tabular-nums whitespace-nowrap";

function sumSummaries(rows: HkPayeeSummary[]): HkPayeeSummary {
  const out: HkPayeeSummary = {
    gross_by_method: { cash: 0, card: 0, transfer: 0, financing: 0 },
    gross_cents: 0,
    implant_cents: 0,
    lab_cents: 0,
    deduction_cents: 0,
    base_cents: 0,
    share_cents: 0,
    share_bps: [],
    implant_qty: 0,
    implant_amount_cents: 0,
    management_base_cents: 0,
    management_cents: 0,
    total_cents: 0,
  };
  for (const s of rows) {
    for (const m of HK_METHODS) out.gross_by_method[m] += s.gross_by_method[m];
    out.gross_cents += s.gross_cents;
    out.implant_cents += s.implant_cents;
    out.lab_cents += s.lab_cents;
    out.deduction_cents += s.deduction_cents;
    out.base_cents += s.base_cents;
    out.share_cents += s.share_cents;
    out.implant_qty += s.implant_qty;
    out.implant_amount_cents += s.implant_amount_cents;
    out.management_cents += s.management_cents;
    out.total_cents += s.total_cents;
  }
  return out;
}

const dash = (cents: number) => (cents ? formatTL(cents) : "—");

/** "3 × ₺2.000,00" with one implant rule; "3 adet" when the payee has several (other doctors' implants). */
function implantText(components: HkComponentJson[], qty: number): string {
  const rates = components.filter((c) => c.kind === "implant_piece");
  return rates.length === 1 ? `${qty} × ${formatTL(rates[0].piece_cents)}` : `${qty} adet`;
}

/** One row per payee; 'Ayrıntı' opens the component breakdown under the row. */
function PayeeTable({ data, open, onToggle }: { data: HkMonthPayload; open: Set<string>; onToggle: (id: string) => void }) {
  const rows = useMemo(() => data.payees.map((p) => ({ payee: p, s: summarizePayee(p) })), [data.payees]);
  const totals = useMemo(() => sumSummaries(rows.map((r) => r.s)), [rows]);
  const statements = new Map(data.statements.map((st) => [st.payee_user_id, st]));
  const colCount = 16;

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto text-gray-900">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr className="text-left text-gray-800">
            <th className="px-3 py-3 font-semibold">Hakediş sahibi</th>
            {HK_METHODS.map((m: HkMethod) => (
              <th key={m} className="px-3 py-3 font-semibold text-right whitespace-nowrap">
                {METHOD_LABELS[m]}
              </th>
            ))}
            <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">İmplant payı</th>
            <th className="px-3 py-3 font-semibold text-right">Lab</th>
            <th className="px-3 py-3 font-semibold text-right">Kesintiler</th>
            <th className="px-3 py-3 font-semibold text-right">Matrah</th>
            <th className="px-3 py-3 font-semibold text-right">Oran</th>
            <th className="px-3 py-3 font-semibold text-right">Pay</th>
            <th className="px-3 py-3 font-semibold text-right">İmplant</th>
            <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Yönetim payı</th>
            <th className="px-3 py-3 font-semibold text-right">Toplam</th>
            <th className="px-3 py-3 font-semibold">Kayıt</th>
            <th className="px-3 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="px-4 py-8 text-center text-gray-500">
                Bu ay için geçerli kural yok.
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
                    {HK_METHODS.map((m) => (
                      <td key={m} className={NUM}>
                        {dash(s.gross_by_method[m])}
                      </td>
                    ))}
                    <td className={NUM}>{s.implant_cents ? formatTL(-s.implant_cents) : "—"}</td>
                    <td className={NUM}>{s.lab_cents ? formatTL(-s.lab_cents) : "—"}</td>
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
                    <td className={NUM}>{dash(s.management_cents)}</td>
                    <td className={`${NUM} font-semibold ${payee.total_cents < 0 ? "text-red-600" : ""}`}>{formatTL(payee.total_cents)}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      <StatementCell statement={st} liveTotal={payee.total_cents} closed={data.status === "closed"} />
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
                        <div className="grid gap-3 lg:grid-cols-2">
                          {payee.components.map((c) => (
                            <ComponentBreakdown key={c.rule_id} c={c} />
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
              {HK_METHODS.map((m) => (
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
              <td className={NUM}>{dash(totals.management_cents)}</td>
              <td className={NUM}>{formatTL(totals.total_cents)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
      <p className="px-4 py-3 text-xs text-gray-500 border-t">
        Ödeme şekli sütunları hekimin brüt tahsilatıdır. İmplant payı ve (ortodontide) lab gideri ciroya girmez;
        kesintiler ödeme şekline göre kalan tutardan düşülür, oran matraha uygulanır. Yönetim payı kliniğin brüt
        cirosundan hesaplanır.
      </p>
    </div>
  );
}

function StatementCell({
  statement,
  liveTotal,
  closed,
}: {
  statement: HkStatementJson | undefined;
  liveTotal: number;
  closed: boolean;
}) {
  if (!closed) return <span className="text-gray-500">Ay kapanınca</span>;
  if (!statement) return <span className="text-amber-700">Döküm yok</span>;
  return (
    <div className="space-y-0.5">
      {statement.fin_entry_id ? (
        <Link href={`/finance/entries/${statement.fin_entry_id}`} className="text-blue-600 hover:underline">
          Finans kaydı
        </Link>
      ) : (
        <span className="text-gray-500">Kayıt yok (0)</span>
      )}
      {statement.entry && (
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
  return (
    <Card title="Kapanış dökümleri">
      {data.statements.length === 0 ? (
        <p className="text-sm text-gray-500">Döküm yok.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-700 border-b">
                <th className="py-2 pr-3 font-semibold">Hakediş sahibi</th>
                <th className="py-2 pr-3 font-semibold text-right">Kapanıştaki toplam</th>
                <th className="py-2 pr-3 font-semibold text-right">Güncel hesap</th>
                <th className="py-2 pr-3 font-semibold text-right">Ödenen</th>
                <th className="py-2 pr-3 font-semibold text-right">Kalan</th>
                <th className="py-2 font-semibold">Finans kaydı</th>
              </tr>
            </thead>
            <tbody>
              {data.statements.map((st) => {
                const now = live.get(st.payee_user_id) ?? 0;
                return (
                  <tr key={st.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3">{st.payee_name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">{formatTL(st.total_cents)}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${now !== st.total_cents ? "text-amber-700" : "text-gray-600"}`}>
                      {formatTL(now)}
                    </td>
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
          : "Kapanış dökümü ve finans kaydı ay kapatıldığı andaki hesaptır. Hekime ödemeleri finans kaydına ekleyin."}
      </p>
    </Card>
  );
}

/** Drill-down: the month's live lines grouped by doctor, with the engine's segment, rule and lab part. */
function LinesByDoctor({ data, month }: { data: HkMonthPayload; month: string }) {
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; lines: HkLineJson[]; gross: number; pieces: number }>();
    for (const l of data.lines) {
      if (l.voided_at) continue;
      const g = map.get(l.doctor_id) ?? { name: l.doctor_name, lines: [], gross: 0, pieces: 0 };
      g.lines.push(l);
      g.gross += l.try_cents;
      map.set(l.doctor_id, g);
    }
    for (const p of data.pieces) {
      if (p.voided_at) continue;
      const g = map.get(p.doctor_id) ?? { name: p.doctor_name, lines: [], gross: 0, pieces: 0 };
      g.pieces += p.qty;
      map.set(p.doctor_id, g);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name, "tr"));
  }, [data.lines, data.pieces]);
  const payeeOfRule = new Map<string, string>();
  for (const p of data.payees) for (const c of p.components) payeeOfRule.set(c.rule_id, p.payee_name);

  return (
    <Card
      title="Hekime göre satırlar"
      actions={
        <Link href={`/finance/hakedis/lines?month=${month}`} className={buttonSecondary}>
          Satırları düzenle
        </Link>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">Bu ay için tahsilat satırı ya da implant kaydı yok.</p>
      ) : (
        <div className="space-y-2">
          {groups.map(([doctorId, g]) => (
            <details key={doctorId} className="rounded border">
              <summary className="cursor-pointer px-3 py-2 flex flex-wrap justify-between gap-2 text-sm">
                <span className="font-medium">{g.name}</span>
                <span className="text-gray-600 tabular-nums">
                  {g.lines.length} satır · brüt {formatTL(g.gross)}
                  {g.pieces ? ` · ${g.pieces} implant` : ""}
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
                          <td className="px-3 py-1.5">{l.patient_name}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{METHOD_LABELS[l.method]}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                            {formatTL(l.try_cents)}
                            {l.currency !== "TRY" && (
                              <div className="text-xs text-gray-500">{formatMoney(l.amount_cents, l.currency)}</div>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{dash(l.implant_cents)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{dash(l.lab_part ?? 0)}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {l.resolved_segment ? SEGMENT_LABELS[l.resolved_segment] : "—"}
                            {l.segment ? <span className="text-xs text-gray-500"> (elle)</span> : null}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {l.rule_kind && l.rule_id ? (
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
          ))}
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
          Kapatınca her hakediş sahibi için bu ayın dökümü saklanır ve hekimin bu ayki hakediş kaydı (Finans → Ödeme ve
          tahsilatlar) oluşturulur ya da tutarı güncellenir. Kapalı ayın ve ondan önceki ayların satırları, implant ve
          lab kayıtları değiştirilemez; düzeltmeler son kapatılan aydan sonraki bir aya düzeltme satırı olarak girilir.
        </p>
        <div className="rounded border">
          {data.payees.length === 0 ? (
            <p className="p-3 text-sm text-gray-500">Bu ay için hakediş çıkmadı.</p>
          ) : (
            data.payees.map((p) => (
              <div key={p.payee_user_id} className="flex justify-between gap-4 px-3 py-2 border-b last:border-b-0 text-sm">
                <span>{p.payee_name}</span>
                <span className={`tabular-nums font-medium ${p.total_cents < 0 ? "text-red-600" : ""}`}>{formatTL(p.total_cents)}</span>
              </div>
            ))
          )}
        </div>
        {negative.length > 0 && (
          <div className="p-3 rounded bg-red-50 text-red-700 text-sm">
            Toplamı eksi çıkan kişi var ({negative.map((p) => p.payee_name).join(", ")}). Ay kapatılamaz; düzeltme
            satırlarını kontrol edin.
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
          değiştirilebilir. Finans kayıtları ve yapılmış ödemeler olduğu gibi kalır; ay tekrar kapatılınca hakediş
          tutarları güncellenir.
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
