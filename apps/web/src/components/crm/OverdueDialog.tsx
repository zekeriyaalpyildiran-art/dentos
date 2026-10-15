"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { crmOverdueList, dayTimeLabel, toCrmError, type CrmError, type OverdueListJson } from "@/lib/crm";
import { CrmErrorBox, CrmModal, Loading, Pager, buttonPrimary } from "./ui";

const PAGE = 50;

/** "Geciken hasta listesi" (OD, TK:7-15): overdue items (priority ≤ 1) grouped by patient, plus the PDF call list. */
export function OverdueDialog({ onClose }: { onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<OverdueListJson | null>(null);
  const [error, setError] = useState<CrmError | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await crmOverdueList({ p_page: { offset, limit: PAGE } }));
      setError(null);
    } catch (err) {
      setError(toCrmError(err));
    }
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  const downloadPdf = async () => {
    if (!data) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const { createCallListPdf } = await import("@/lib/crm-pdf");
      const bytes = await createCallListPdf({
        clinicName: data.clinic_name,
        today: data.today,
        rows: data.export_rows,
      });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `Aranacaklar-${data.today}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "PDF oluşturulamadı.");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <CrmModal
      title="Geciken hasta listesi"
      description={data ? `${data.count} geciken iş · ${data.patient_count} hasta` : undefined}
      onClose={onClose}
      wide
    >
      {!data && !error && <Loading />}
      <CrmErrorBox error={error} />
      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-gray-600">
              Arama listesinde {data.export_rows.length} hasta var. Takibi kapalı, karar bekleyen veya klinik randevusu
              olan hastalar listeye alınmaz; not ve tutar yazdırılmaz.
            </p>
            <button type="button" className={buttonPrimary} onClick={downloadPdf} disabled={pdfBusy}>
              {pdfBusy ? "Hazırlanıyor…" : "Arama listesini indir (PDF)"}
            </button>
          </div>
          {pdfError && <p className="text-sm text-red-600">{pdfError}</p>}
          {data.patients.length === 0 ? (
            <p className="text-sm text-gray-500">Geciken iş yok.</p>
          ) : (
            <ul className="divide-y border rounded">
              {data.patients.map((g, i) => {
                const href = g.lead ? `/crm/leads/${g.lead.id}` : g.patient ? `/patients/${g.patient.id}` : null;
                const name = g.lead?.full_name ?? g.patient?.full_name ?? "Hasta";
                const phone = g.lead?.phone ?? g.patient?.phone ?? "";
                return (
                  <li key={(g.lead?.id ?? g.patient?.id ?? "") + i} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      {href ? (
                        <Link href={href} className="font-semibold text-blue-700 hover:underline">
                          {name}
                        </Link>
                      ) : (
                        <span className="font-semibold">{name}</span>
                      )}
                      <span className="text-sm text-gray-600">{phone}</span>
                      {g.lead?.assigned_name && <span className="text-xs text-gray-500">· {g.lead.assigned_name}</span>}
                    </div>
                    <ul className="mt-1 text-sm space-y-0.5">
                      {g.items.map((it) => (
                        <li key={it.key}>
                          <span className="text-red-700">{it.reason}</span> · {dayTimeLabel(it.due_date, it.due_time)} ·{" "}
                          <span className="text-gray-700">{it.action}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          <Pager offset={offset} limit={PAGE} total={data.patient_count} onChange={setOffset} />
        </div>
      )}
    </CrmModal>
  );
}
