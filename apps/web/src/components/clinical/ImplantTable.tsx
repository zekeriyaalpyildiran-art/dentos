"use client";

// Implant list (spec p9_clinical §7.3 table; §7.5 patient tab without the patient column). Cards below 768 px.

import Link from "next/link";
import type { ReactNode } from "react";
import type { ClinicalFlags, ImplantJson } from "@/lib/clinical/rpc";
import { IMPLANT_STATUS_LABELS, IMPLANT_STATUS_STYLES } from "@/lib/clinical/codes";
import { formatDay, istanbulDayOf } from "@/lib/clinical/dates";
import { formatDecimalTr } from "@/lib/clinical/numbers";
import { lotSerialText } from "./ImplantStockPicker";
import { Badge } from "./ui";

export function StockBadge({ implant }: { implant: ImplantJson }) {
  if (implant.stock_source === "external") {
    return (
      <Badge className="bg-gray-100 text-gray-700" title={implant.source_note}>
        Stok dışı
      </Badge>
    );
  }
  switch (implant.stock_state) {
    case "correction_pending":
      return <Badge className="bg-amber-100 text-amber-800">Düzeltme bekliyor</Badge>;
    case "corrected":
      return <Badge className="bg-blue-100 text-blue-800">Stok düzeltildi</Badge>;
    case "returned":
      return <Badge className="bg-blue-100 text-blue-800">Stoğa iade</Badge>;
    default:
      return (
        <Badge className="bg-green-50 text-green-800">
          Stoktan düşüldü{implant.movement_ref_no ? ` #${implant.movement_ref_no}` : ""}
        </Badge>
      );
  }
}

export function ImplantStatusBadge({ implant }: { implant: ImplantJson }) {
  if (implant.deleted_at) return <Badge className="bg-red-100 text-red-800">İptal edildi</Badge>;
  return <Badge className={IMPLANT_STATUS_STYLES[implant.status]}>{IMPLANT_STATUS_LABELS[implant.status] ?? implant.status}</Badge>;
}

function sizeText(r: ImplantJson): string {
  return `Ø ${formatDecimalTr(r.diameter_mm)} × ${formatDecimalTr(r.length_mm)} mm`;
}

function ControlText({ r }: { r: ImplantJson }) {
  if (!r.next_control_on) return <span className="text-gray-500">Kontrol: —</span>;
  if (r.control_due && !r.deleted_at) {
    return (
      <span className="text-red-700 font-medium">
        Kontrol: {formatDay(r.next_control_on)} · Kontrol zamanı geldi
      </span>
    );
  }
  return <span className="text-gray-600">Kontrol: {formatDay(r.next_control_on)}</span>;
}

export interface ImplantRowActions {
  onAddSame?: (r: ImplantJson) => void;
  onEdit?: (r: ImplantJson) => void;
  onVoid?: (r: ImplantJson) => void;
  onRestore?: (r: ImplantJson) => void;
  busyId?: string | null;
}

function Actions({ r, flags, actions }: { r: ImplantJson; flags: ClinicalFlags; actions: ImplantRowActions }) {
  const btn = "px-3 min-h-[44px] rounded border text-sm bg-white hover:bg-gray-50 disabled:opacity-40";
  const items: ReactNode[] = [];
  if (r.deleted_at) {
    if (flags.can_restore && actions.onRestore) {
      items.push(
        <button key="restore" type="button" className={btn} disabled={actions.busyId === r.id} onClick={() => actions.onRestore?.(r)}>
          {actions.busyId === r.id ? "Kaydediliyor…" : "Geri al"}
        </button>
      );
    }
  } else if (flags.can_write) {
    if (actions.onAddSame) {
      items.push(
        <button
          key="add"
          type="button"
          className={btn}
          title="Aynı hastaya implant ekle"
          aria-label="Aynı hastaya implant ekle"
          onClick={() => actions.onAddSame?.(r)}
        >
          +
        </button>
      );
    }
    if (actions.onEdit) {
      items.push(
        <button key="edit" type="button" className={btn} onClick={() => actions.onEdit?.(r)}>
          Düzenle
        </button>
      );
    }
    if (actions.onVoid) {
      items.push(
        <button
          key="void"
          type="button"
          className={`${btn} text-red-600 border-red-200`}
          onClick={() => actions.onVoid?.(r)}
          title="İptal et"
        >
          🗑 İptal et
        </button>
      );
    }
  }
  if (items.length === 0) return null;
  return <div className="flex flex-wrap gap-2 justify-end">{items}</div>;
}

export function ImplantTable({
  rows,
  flags,
  showPatient = true,
  actions,
}: {
  rows: ImplantJson[];
  flags: ClinicalFlags;
  showPatient?: boolean;
  actions: ImplantRowActions;
}) {
  const doctorPart = (r: ImplantJson) => (r.doctor_name ? ` · Dr. ${r.doctor_name}` : "");
  return (
    <>
      <div className="hidden md:block bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b text-left text-gray-800">
            <tr>
              <th className="px-4 py-3 font-semibold">{showPatient ? "Hasta / diş" : "Diş"}</th>
              <th className="px-4 py-3 font-semibold">İmplant</th>
              <th className="px-4 py-3 font-semibold">Uygulama / kontrol</th>
              <th className="px-4 py-3 font-semibold">Durum</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b align-top ${r.deleted_at ? "bg-red-50/40" : ""}`}>
                <td className="px-4 py-3">
                  {showPatient ? (
                    <Link href={`/patients/${r.patient_id}?tab=implants`} className="font-semibold text-blue-700 hover:underline">
                      {r.patient_name}
                    </Link>
                  ) : (
                    <span className="font-semibold">Diş {r.tooth_fdi}</span>
                  )}
                  <div className="text-xs text-gray-600">
                    {showPatient ? `Diş ${r.tooth_fdi}` : ""}
                    {showPatient ? doctorPart(r) : r.doctor_name ? `Dr. ${r.doctor_name}` : ""}
                  </div>
                  {r.notes && <div className="text-xs text-gray-500 truncate max-w-[16rem]" title={r.notes}>{r.notes}</div>}
                  {r.deleted_at && (
                    <div className="text-xs text-red-700 mt-1">
                      İptal: {formatDay(istanbulDayOf(r.deleted_at))}
                      {r.deleted_by_name ? ` · ${r.deleted_by_name}` : ""}
                      {r.delete_reason ? ` · ${r.delete_reason}` : ""}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="font-semibold">
                    {r.brand_name}
                    {!r.brand_active && <span className="font-normal text-gray-500"> (pasif)</span>}
                  </div>
                  <div className="text-xs text-gray-600">{[r.model, sizeText(r)].filter(Boolean).join(" · ")}</div>
                  <div className="text-xs text-gray-600">{lotSerialText(r.lot_text, r.serial_text)}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="tabular-nums">{formatDay(r.placed_on)}</div>
                  <div className="text-xs">
                    <ControlText r={r} />
                  </div>
                </td>
                <td className="px-4 py-3 space-y-1">
                  <div>
                    <ImplantStatusBadge implant={r} />
                  </div>
                  <div>
                    <StockBadge implant={r} />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Actions r={r} flags={flags} actions={actions} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="md:hidden space-y-3">
        {rows.map((r) => (
          <li key={r.id} className={`bg-white rounded-lg shadow p-4 space-y-2 ${r.deleted_at ? "ring-1 ring-red-200" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {showPatient ? (
                  <Link href={`/patients/${r.patient_id}?tab=implants`} className="font-semibold text-blue-700 hover:underline">
                    {r.patient_name}
                  </Link>
                ) : null}
                <div className="text-sm text-gray-700">
                  Diş {r.tooth_fdi}
                  {doctorPart(r)}
                </div>
              </div>
              <ImplantStatusBadge implant={r} />
            </div>
            <div className="text-sm">
              <span className="font-semibold">{r.brand_name}</span>
              {!r.brand_active && <span className="text-gray-500"> (pasif)</span>}
              <div className="text-xs text-gray-600">{[r.model, sizeText(r)].filter(Boolean).join(" · ")}</div>
              <div className="text-xs text-gray-600">{lotSerialText(r.lot_text, r.serial_text)}</div>
            </div>
            <div className="text-xs">
              <div>Uygulama: {formatDay(r.placed_on)}</div>
              <ControlText r={r} />
            </div>
            <StockBadge implant={r} />
            {r.deleted_at && r.delete_reason && <div className="text-xs text-red-700">İptal nedeni: {r.delete_reason}</div>}
            <Actions r={r} flags={flags} actions={actions} />
          </li>
        ))}
      </ul>
    </>
  );
}
