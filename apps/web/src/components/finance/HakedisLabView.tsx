"use client";

// Lab özeti of the Hakediş pages (finance and prep modes, HakedisParts; owner decisions 2026-10-18, 0032 v1.4): the
// month's lab costs per doctor and lab (fin_hk_month lab_summary) with what the month's hakediş took off, and the month
// totals per lab (lab_totals) to compare with each lab's single monthly statement. The clinic's own account with each
// lab (invoices, payments) stays in Finans → Cariler; nothing here writes to the ledger. Read-only in both modes; lab
// costs are entered in Satırlar ve hastalar → Lab giderleri.

import Link from "next/link";
import { useMemo } from "react";
import {
  HK_BASE,
  HakedisTabs,
  MonthPicker,
  MonthStatusBadge,
  useHkMonth,
  useHkMonthData,
  useHkReference,
  type HkMode,
} from "./HakedisParts";
import { Card, ErrorBox, Loading, buttonSecondary } from "./ui";
import { formatTL } from "@/lib/finance";
import {
  LAB_DEDUCTION_TEXT,
  LAB_LABELS,
  LAB_SUMMARY_HINT,
  hkCanPrepare,
  hkLedgerVisible,
  isLabWarning,
  labSummaryByDoctor,
  warningText,
  type HkLabSummaryRowJson,
  type HkLabTotalJson,
  type HkMonthPayload,
} from "@/lib/hakedis";

const NUM = "px-3 py-2 text-right tabular-nums whitespace-nowrap";

/** Doctor × lab table and the per-lab totals of the chosen month. */
export function HakedisLabView({ mode }: { mode: HkMode }) {
  const ref = useHkReference();
  const [month, setMonth] = useHkMonth(ref.data);
  const { data: current, error, loading, reload } = useHkMonthData(month);
  const base = HK_BASE[mode];

  if (!ref.data || !month) {
    return ref.loading ? <Loading /> : <ErrorBox error={ref.error} onReload={ref.reload} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HakedisTabs mode={mode} month={month} />
        <MonthPicker month={month} max={ref.data.current_month} onChange={setMonth} />
      </div>

      <ErrorBox
        error={error}
        onReload={async () => {
          await Promise.all([ref.reload(), reload()]);
        }}
      />

      {!current ? (
        loading ? <Loading /> : null
      ) : (
        <LabMonth data={current} mode={mode} base={base} month={month} loading={loading} />
      )}
    </div>
  );
}

function LabMonth({
  data,
  mode,
  base,
  month,
  loading,
}: {
  data: HkMonthPayload;
  mode: HkMode;
  base: string;
  month: string;
  loading: boolean;
}) {
  const warnings = data.warnings.filter(isLabWarning);
  const summary = data.lab_summary;
  const totals = data.lab_totals;
  const groups = useMemo(() => labSummaryByDoctor(summary ?? []), [summary]);
  const editable = data.status === "open" && hkCanPrepare(data);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
        <MonthStatusBadge status={data.status} />
        {data.status === "open" ? (
          <span>Tahmini — ay kapanınca kesinleşir.</span>
        ) : (
          <span>Kapalı ay. Bu tablo güncel hesaptandır; kapanış dökümleri Ay özeti&apos;ndedir.</span>
        )}
        {loading && <span className="text-gray-500">Güncelleniyor...</span>}
      </div>

      {warnings.length > 0 && (
        <div className="p-4 rounded bg-amber-50 text-amber-900 text-sm space-y-1">
          <div className="font-semibold">Uyarılar</div>
          <ul className="list-disc pl-5 space-y-1">
            {warnings.map((w, i) => (
              <li key={`${w.code}:${i}`}>{warningText(w)}</li>
            ))}
          </ul>
          <p className="pt-1">Tutarlar bu şekilde hesaplandı; bu uyarılar ayın kapatılmasını engellemez.</p>
        </div>
      )}

      {!summary || !totals ? (
        <Card>
          <p className="text-sm text-gray-700">
            Lab özeti, veritabanı güncellemesi (0032) uygulandıktan sonra görünür. Ayın lab giderleri şimdilik Satırlar
            ve hastalar → Lab giderleri sekmesinde listelenir.
          </p>
        </Card>
      ) : (
        <>
          <Card
            title="Hekim ve laboratuvar"
            actions={
              <Link href={`${base}/lines?month=${month}&tab=lab`} className={buttonSecondary}>
                {editable ? "Lab giderlerini düzenle" : "Lab giderlerini aç"}
              </Link>
            }
          >
            {groups.length === 0 ? (
              <p className="text-sm text-gray-500">Bu ay için lab gideri yok.</p>
            ) : (
              <DoctorLabTable groups={groups} />
            )}
          </Card>

          <Card title={LAB_LABELS.total}>
            {totals.length === 0 ? (
              <p className="text-sm text-gray-500">Bu ay için lab gideri yok.</p>
            ) : (
              <LabTotalsTable rows={totals} />
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-gray-700">
              <p className="flex-1 min-w-[16rem]">{LAB_SUMMARY_HINT}</p>
              {mode === "finance" && hkLedgerVisible(data) && (
                <Link href="/finance/counterparties" className={buttonSecondary}>
                  Cariler&apos;i aç
                </Link>
              )}
            </div>
          </Card>
        </>
      )}

      <p className="text-xs text-gray-500">
        {LAB_LABELS.cost}: bu ay tarihli, iptal edilmemiş lab giderleri (eksi tutar düzeltmedir). {LAB_LABELS.deducted}:
        bu ayın hakediş hesabında hekimin cirosundan düşülen kısım; ortodontide hastanın bu ayki ödemelerinden karşılanan
        lab gideridir (önceki ayların giderleri de olabilir, bu yüzden bu ay gideri olmayan bir satır görünebilir).{" "}
        {LAB_DEDUCTION_TEXT}
      </p>
    </>
  );
}

function DoctorLabTable({ groups }: { groups: ReturnType<typeof labSummaryByDoctor> }) {
  const grand = groups.reduce(
    (sum, g) => ({
      cost: sum.cost + g.cost_cents,
      deducted: sum.deducted + g.deducted_cents,
      count: sum.count + g.count,
    }),
    { cost: 0, deducted: 0, count: 0 }
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr className="text-left text-gray-800">
            <th className="px-3 py-2 font-semibold">Hekim</th>
            <th className="px-3 py-2 font-semibold">{LAB_LABELS.lab}</th>
            <th className="px-3 py-2 font-semibold text-right">{LAB_LABELS.count}</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{LAB_LABELS.cost}</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{LAB_LABELS.deducted}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <DoctorRows key={g.doctor_id} group={g} />
          ))}
        </tbody>
        {groups.length > 1 && (
          <tfoot className="bg-gray-50 border-t font-semibold">
            <tr>
              <td className="px-3 py-2" colSpan={2}>
                Toplam
              </td>
              <td className={NUM}>{grand.count}</td>
              <td className={NUM}>{formatTL(grand.cost)}</td>
              <td className={NUM}>{formatTL(grand.deducted)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function DoctorRows({ group }: { group: ReturnType<typeof labSummaryByDoctor>[number] }) {
  return (
    <>
      {group.rows.map((r: HkLabSummaryRowJson, i) => (
        <tr key={`${r.doctor_id}|${r.lab_name}`} className="border-b align-top">
          <td className="px-3 py-2 font-medium">{i === 0 ? group.doctor_name : ""}</td>
          <td className="px-3 py-2">{r.lab_name}</td>
          <td className={NUM}>{r.count}</td>
          <td className={`${NUM} ${r.cost_cents < 0 ? "text-red-600" : ""}`}>{formatTL(r.cost_cents)}</td>
          <td className={NUM}>{formatTL(r.deducted_cents)}</td>
        </tr>
      ))}
      {group.rows.length > 1 && (
        <tr className="border-b bg-gray-50 text-gray-700">
          <td className="px-3 py-1.5" />
          <td className="px-3 py-1.5 italic">{group.doctor_name} toplamı</td>
          <td className={NUM}>{group.count}</td>
          <td className={NUM}>{formatTL(group.cost_cents)}</td>
          <td className={NUM}>{formatTL(group.deducted_cents)}</td>
        </tr>
      )}
    </>
  );
}

function LabTotalsTable({ rows }: { rows: HkLabTotalJson[] }) {
  const grand = rows.reduce(
    (sum, r) => ({ cost: sum.cost + r.cost_cents, deducted: sum.deducted + r.deducted_cents, count: sum.count + r.count }),
    { cost: 0, deducted: 0, count: 0 }
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr className="text-left text-gray-800">
            <th className="px-3 py-2 font-semibold">{LAB_LABELS.lab}</th>
            <th className="px-3 py-2 font-semibold text-right">{LAB_LABELS.count}</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{LAB_LABELS.cost}</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{LAB_LABELS.deducted}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.lab_name} className="border-b last:border-b-0">
              <td className="px-3 py-2 font-medium">{r.lab_name}</td>
              <td className={NUM}>{r.count}</td>
              <td className={`${NUM} ${r.cost_cents < 0 ? "text-red-600" : ""}`}>{formatTL(r.cost_cents)}</td>
              <td className={NUM}>{formatTL(r.deducted_cents)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 1 && (
          <tfoot className="bg-gray-50 border-t font-semibold">
            <tr>
              <td className="px-3 py-2">Toplam</td>
              <td className={NUM}>{grand.count}</td>
              <td className={NUM}>{formatTL(grand.cost)}</td>
              <td className={NUM}>{formatTL(grand.deducted)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
