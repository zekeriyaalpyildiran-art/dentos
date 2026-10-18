"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ComponentBreakdown, LabPatientsTable } from "@/components/finance/HakedisParts";
import { Card, ErrorBox, Loading } from "@/components/finance/ui";
import { formatDay, formatMonth, formatTL, formatTimestamp, toFinanceError, type FinanceError } from "@/lib/finance";
import {
  METHOD_LABELS,
  SEGMENT_LABELS,
  componentKey,
  formatBp,
  hkMyMonth,
  hkMyMonths,
  monthKey,
  pickDefaultMonth,
  summarizePayee,
  type HkLabPatientJson,
  type HkMyLineJson,
  type HkMyMonthData,
  type HkMyMonthJson,
  type HkMyMonthsJson,
} from "@/lib/hakedis";
import { formatMoney } from "@/lib/payments";

/**
 * Hakedişim: the signed-in doctor's (or the owner's) own hakediş, read-only. hk_my_months / hk_my_month return only
 * the caller's figures and lines; no finance permission is needed. Doctors and the owner only (layout.tsx).
 */
export default function HakedisimPage() {
  return (
    <div className="p-4 md:p-8 space-y-6 text-gray-900 max-w-6xl">
      <h1 className="text-2xl md:text-3xl font-bold">Hakedişim</h1>
      <MyHakedis />
    </div>
  );
}

function MyHakedis() {
  const [months, setMonths] = useState<HkMyMonthsJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [detail, setDetail] = useState<HkMyMonthJson | null>(null);
  const [detailError, setDetailError] = useState<FinanceError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const seq = useRef(0);

  const loadMonths = useCallback(async () => {
    try {
      const data = await hkMyMonths();
      setMonths(data);
      setError(null);
      const keys = data.months.map((m) => monthKey(m.month));
      // The previous month while it is still open (being completed), else the current one; newest when missing.
      const preferred = data.current_month ? pickDefaultMonth(data.current_month, data.months) : keys[0];
      setMonth((prev) => (prev && keys.includes(prev) ? prev : keys.includes(preferred) ? preferred : keys[0] ?? null));
    } catch (err) {
      setError(toFinanceError(err));
    }
  }, []);

  const loadDetail = useCallback(async () => {
    if (!month) return;
    const mine = ++seq.current;
    setDetailLoading(true);
    try {
      const next = await hkMyMonth(month);
      if (mine !== seq.current) return;
      setDetail(next);
      setDetailError(null);
    } catch (err) {
      if (mine === seq.current) setDetailError(toFinanceError(err));
    } finally {
      if (mine === seq.current) setDetailLoading(false);
    }
  }, [month]);

  useEffect(() => {
    loadMonths();
  }, [loadMonths]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  if (!months) return error ? <ErrorBox error={error} /> : <Loading />;

  if (!months.has_rules) {
    return (
      <Card>
        <p className="text-gray-700">Sizin için tanımlı hakediş kuralı yok.</p>
        <p className="text-sm text-gray-500 mt-1">Hakediş oranları klinik yönetimi tarafından tanımlanır.</p>
      </Card>
    );
  }

  if (months.months.length === 0) {
    // Rules exist but the earliest one starts after the current month (e.g. rules entered ahead of the start month).
    return (
      <Card>
        <p className="text-gray-700">Hakediş kuralınız henüz başlamadı.</p>
        <p className="text-sm text-gray-500 mt-1">Kuralınızın ilk ayı başladığında hakedişiniz burada görünür.</p>
      </Card>
    );
  }

  const current = detail && detail.has_rules && month && monthKey(detail.month) === month ? detail : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800">Ay</span>
          <select
            className="px-3 py-2 border rounded bg-white text-gray-900 min-h-[44px]"
            value={month ?? ""}
            onChange={(e) => setMonth(e.target.value)}
          >
            {months.months.map((m) => (
              <option key={m.month} value={monthKey(m.month)}>
                {formatMonth(monthKey(m.month))}
                {m.status === "closed" ? "" : " (tahmini)"}
              </option>
            ))}
          </select>
        </label>
        {detailLoading && <span className="text-sm text-gray-500 pb-2">Yükleniyor...</span>}
      </div>

      {/* ErrorBox offers a reload only on conflicts; a failed month load gets its own retry. */}
      {detailError && (
        <div className="p-4 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3">
          <span className="flex-1 min-w-[12rem]">{detailError.message}</span>
          <button
            type="button"
            onClick={loadDetail}
            disabled={detailLoading}
            className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100"
          >
            Tekrar dene
          </button>
        </div>
      )}

      {detail && !detail.has_rules ? (
        <Card>
          <p className="text-gray-700">Sizin için tanımlı hakediş kuralı yok.</p>
        </Card>
      ) : current ? (
        <MonthDetail data={current} />
      ) : detailLoading || detailError ? null : (
        <Loading />
      )}

      <Card title="Aylarım">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-700 border-b">
                <th className="py-2 pr-3 font-semibold">Ay</th>
                <th className="py-2 pr-3 font-semibold">Durum</th>
                <th className="py-2 pr-3 font-semibold text-right">Hakediş</th>
                <th className="py-2 pr-3 font-semibold text-right">Ödenen</th>
                <th className="py-2 font-semibold text-right">Kalan</th>
              </tr>
            </thead>
            <tbody>
              {months.months.map((m) => {
                const key = monthKey(m.month);
                const selected = key === month;
                return (
                  <tr key={m.month} className={`border-b last:border-b-0 ${selected ? "bg-blue-50" : ""}`}>
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        className={`capitalize text-left min-h-[32px] ${selected ? "font-semibold text-gray-900" : "text-blue-600 hover:underline"}`}
                        aria-current={selected ? "true" : undefined}
                        onClick={() => setMonth(key)}
                      >
                        {formatMonth(key)}
                      </button>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {m.status === "closed" ? (
                        <span className="text-green-700">Kesinleşti</span>
                      ) : (
                        <span className="text-amber-700">Tahmini</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{formatTL(m.total_cents)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{m.paid_cents ? formatTL(m.paid_cents) : "—"}</td>
                    <td className="py-2 text-right tabular-nums whitespace-nowrap">{m.remaining_cents === null ? "—" : formatTL(m.remaining_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  cents,
  caption,
  strong,
  tone,
}: {
  label: string;
  cents: number | null;
  caption?: string;
  strong?: boolean;
  tone?: "green" | "amber";
}) {
  const color = tone === "green" ? "text-green-700" : tone === "amber" ? "text-amber-700" : "text-gray-900";
  return (
    <div className={`bg-white p-4 rounded-lg shadow min-w-0 ${strong ? "ring-2 ring-blue-200" : ""}`}>
      <div className="text-gray-500 text-sm">{label}</div>
      <div className={`mt-1 tabular-nums break-words ${strong ? "text-2xl font-bold" : "text-xl font-semibold"} ${color}`}>
        {formatTL(cents)}
      </div>
      {caption && <div className="mt-1 text-xs text-gray-500">{caption}</div>}
    </div>
  );
}

function MonthDetail({ data }: { data: HkMyMonthData }) {
  const components = data.payees.flatMap((p) => p.components);
  const total = data.payees.reduce((sum, p) => sum + p.total_cents, 0);
  const s = summarizePayee({ total_cents: total, components });
  const hasShare = components.some((c) => c.kind === "ciro_share" || c.kind === "ortho_lab_first");
  const hasImplant = components.some((c) => c.kind === "implant_piece");
  const management = components.filter((c) => c.kind === "clinic_ciro_share");
  // 0031: a fixed monthly salary and the month's bonus / other rows are part of the same monthly entry.
  const hasSalary = components.some((c) => c.kind === "fixed_monthly");
  const hasAdjustments = components.some((c) => c.kind === "adjustments");
  const ortho = components.filter((c) => c.kind === "ortho_lab_first");
  const labPatients: HkLabPatientJson[] = ortho.flatMap((c) => c.lab_patients ?? []);
  const closed = data.status === "closed";
  const ent = data.entitlement;

  // The doctor's ciro: gross collections without the implant part and the ortho lab part, so Ciro − Kesintiler =
  // Matrah on the tiles below.
  const ciroCents = s.gross_cents - s.implant_cents - s.lab_cents;
  const ciroCaption =
    s.implant_cents || s.lab_cents
      ? [
          `Brüt ${formatTL(s.gross_cents)}`,
          s.implant_cents ? `implant payı ${formatTL(s.implant_cents)} hariç` : null,
          s.lab_cents ? `lab ${formatTL(s.lab_cents)} hariç` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold capitalize">{formatMonth(monthKey(data.month))}</h2>
        {data.is_estimate ? (
          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
            Tahmini — ay kapanınca kesinleşir
          </span>
        ) : (
          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
            Kesinleşti{data.statement?.closed_at ? ` · ${formatTimestamp(data.statement.closed_at)}` : ""}
          </span>
        )}
      </div>

      {components.length === 0 ? (
        <Card>
          <p className="text-gray-700">Bu ay için geçerli hakediş kuralınız yok.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {hasShare && (
            <>
              <SummaryTile label="Ciro" cents={ciroCents} caption={ciroCaption || undefined} />
              <SummaryTile label="Kesintiler" cents={s.deduction_cents ? -s.deduction_cents : 0} caption="Ödeme şekline göre" />
              <SummaryTile label="Matrah" cents={s.base_cents} />
              <SummaryTile
                label="Pay"
                cents={s.share_cents}
                caption={s.share_bps.length ? s.share_bps.map((bp) => formatBp(bp)).join(" / ") : undefined}
              />
            </>
          )}
          {hasImplant && <SummaryTile label="İmplant" cents={s.implant_amount_cents} caption={`${s.implant_qty} adet`} />}
          {management.length > 0 && (
            <SummaryTile
              label="Yönetim payı"
              cents={s.management_cents}
              caption={management
                .map((c) => `Klinik cirosu ${formatTL(c.base_cents ?? 0)} × ${formatBp(c.share_bp)}`)
                .join("; ")}
            />
          )}
          {hasSalary && <SummaryTile label="Sabit maaş" cents={s.salary_cents} caption="Net" />}
          {hasAdjustments && (
            <SummaryTile
              label="Prim ve diğer"
              cents={s.adjustments_cents}
              caption={[s.bonus_cents ? `Prim ${formatTL(s.bonus_cents)}` : null, s.other_cents ? `Diğer ${formatTL(s.other_cents)}` : null]
                .filter(Boolean)
                .join(" · ") || undefined}
            />
          )}
          <SummaryTile label={closed ? "Toplam hakediş" : "Toplam (tahmini)"} cents={total} strong />
          {ent && <SummaryTile label="Ödenen" cents={ent.paid_cents} tone="green" />}
          {closed &&
            (ent ? (
              <SummaryTile
                label="Kalan"
                cents={ent.remaining_cents}
                tone={ent.remaining_cents > 0 ? "amber" : undefined}
                caption={ent.is_cancelled ? "Hakediş kaydı iptal edilmiş" : undefined}
              />
            ) : (
              <SummaryTile label="Kalan" cents={total} caption="Ödeme kaydı henüz açılmadı" tone={total > 0 ? "amber" : undefined} />
            ))}
        </div>
      )}

      {data.is_estimate && components.length > 0 && (
        <p className="text-sm text-gray-600">
          Ay devam ederken yeni tahsilatlar ve düzeltmeler girildikçe rakamlar değişebilir. Ay kapatılınca tutar
          kesinleşir ve ödemeler bu tutara yapılır.
        </p>
      )}

      {components.length > 0 && (
        <details className="bg-white rounded-lg shadow">
          <summary className="cursor-pointer px-4 py-3 font-semibold">Hesap dökümü</summary>
          <div className="px-4 pb-4 grid gap-3 lg:grid-cols-2">
            {components.map((c) => (
              <ComponentBreakdown key={componentKey(c)} c={c} />
            ))}
          </div>
        </details>
      )}

      {(hasShare || data.lines.length > 0) && <LinesCard lines={data.lines} />}

      {hasImplant && (
        <Card title="İmplantlar">
          {data.pieces.length === 0 ? (
            <p className="text-sm text-gray-500">Bu ay implant kaydı yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-700 border-b">
                    <th className="py-2 pr-3 font-semibold">Tarih</th>
                    <th className="py-2 pr-3 font-semibold">Hasta</th>
                    <th className="py-2 font-semibold text-right">Adet</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pieces.map((p, i) => (
                    <tr key={p.id ?? i} className="border-b last:border-b-0">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDay(p.day)}</td>
                      <td className="py-2 pr-3">{p.patient_name}</td>
                      <td className={`py-2 text-right tabular-nums ${p.qty < 0 ? "text-red-600" : ""}`}>{p.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {ortho.length > 0 && (
        <>
          <Card title="Lab giderleri">
            {data.lab_costs.length === 0 ? (
              <p className="text-sm text-gray-500">Lab gideri yok.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-700 border-b">
                      <th className="py-2 pr-3 font-semibold">Tarih</th>
                      <th className="py-2 pr-3 font-semibold">Hasta</th>
                      <th className="py-2 pr-3 font-semibold">Lab</th>
                      <th className="py-2 font-semibold text-right">Tutar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lab_costs.map((c, i) => (
                      <tr key={c.id ?? i} className="border-b last:border-b-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDay(c.day)}</td>
                        <td className="py-2 pr-3">{c.patient_name}</td>
                        <td className="py-2 pr-3">{c.lab_name}</td>
                        <td className={`py-2 text-right tabular-nums whitespace-nowrap ${c.amount_cents < 0 ? "text-red-600" : ""}`}>
                          {formatTL(c.amount_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-gray-500 mt-3">
              Hastanın lab gideri önce o hastanın ödemelerinden karşılanır; payınız kalan tutar üzerinden hesaplanır.
            </p>
          </Card>
          <Card title="Hasta başına lab: toplam / karşılanan / kalan">
            {labPatients.length === 0 ? (
              <p className="text-sm text-gray-500">Karşılanmayı bekleyen lab gideri yok.</p>
            ) : (
              <LabPatientsTable rows={labPatients} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * The month's lines counted under the caller's own rules, plus the unruled lines of the caller's own doctors row (shown
 * as not counted). hk_my_month never returns a line counted under another payee's rule.
 */
function LinesCard({ lines }: { lines: HkMyLineJson[] }) {
  const amount = (l: HkMyLineJson) => (
    <>
      {formatTL(l.try_cents)}
      {l.currency !== "TRY" && <span className="block text-xs text-gray-500">{formatMoney(l.amount_cents, l.currency)}</span>}
    </>
  );
  return (
    <Card title="Tahsilatlar">
      {lines.length === 0 ? (
        <p className="text-sm text-gray-500">Bu ay tahsilat satırı yok.</p>
      ) : (
        <>
          {/* Phones: one card per line. */}
          <ul className="md:hidden divide-y">
            {lines.map((l, i) => (
              <li key={l.id ?? i} className={`py-3 ${l.counted ? "" : "opacity-60"}`}>
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{l.patient_name}</span>
                  <span className={`tabular-nums text-right ${l.try_cents < 0 ? "text-red-600" : ""}`}>{amount(l)}</span>
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  {formatDay(l.day)} · {METHOD_LABELS[l.method]} · {SEGMENT_LABELS[l.segment] ?? l.segment}
                </div>
                {(l.implant_cents !== 0 || l.lab_part !== 0) && (
                  <div className="text-xs text-gray-600">
                    {l.implant_cents !== 0 ? `İmplant payı ${formatTL(l.implant_cents)}` : ""}
                    {l.implant_cents !== 0 && l.lab_part !== 0 ? " · " : ""}
                    {l.lab_part !== 0 ? `Lab payı ${formatTL(l.lab_part)}` : ""}
                  </div>
                )}
                {!l.counted && <div className="text-xs text-gray-500">Hakedişinize dahil değil</div>}
              </li>
            ))}
          </ul>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-700 border-b">
                  <th className="py-2 pr-3 font-semibold">Tarih</th>
                  <th className="py-2 pr-3 font-semibold">Hasta</th>
                  <th className="py-2 pr-3 font-semibold">Ödeme şekli</th>
                  <th className="py-2 pr-3 font-semibold text-right">Tutar</th>
                  <th className="py-2 pr-3 font-semibold text-right">İmplant payı</th>
                  <th className="py-2 pr-3 font-semibold">Hasta grubu</th>
                  <th className="py-2 font-semibold text-right">Lab payı</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.id ?? i} className={`border-b last:border-b-0 align-top ${l.counted ? "" : "text-gray-400"}`}>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDay(l.day)}</td>
                    <td className="py-2 pr-3">
                      {l.patient_name}
                      {!l.counted && <span className="block text-xs">Hakedişinize dahil değil</span>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{METHOD_LABELS[l.method]}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${l.try_cents < 0 ? "text-red-600" : ""}`}>{amount(l)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{l.implant_cents ? formatTL(l.implant_cents) : "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{SEGMENT_LABELS[l.segment] ?? l.segment}</td>
                    <td className="py-2 text-right tabular-nums whitespace-nowrap">{l.lab_part ? formatTL(l.lab_part) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            Tutarlar TL karşılığıdır; eksi tutar düzeltmedir. İmplant payı cironuza girmez (implant adet başı ödenir).
          </p>
        </>
      )}
    </Card>
  );
}
