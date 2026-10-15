"use client";

// One audit_logs row of /settings/audit with its expandable before/after table (spec p10_platform §5.4).

import { useState } from "react";
import Link from "next/link";
import {
  ACTION_TONES,
  actionLabel,
  auditDiff,
  auditSummary,
  entityHref,
  entityLabel,
  formatAuditValue,
  hasFieldLabel,
  shortId,
  type AuditNameContext,
  type AuditRow,
} from "@/lib/audit";
import { formatIstanbulDateTime } from "@/lib/staff";

function DiffValue({ k, value, ctx }: { k: string; value: unknown; ctx: AuditNameContext }) {
  const [full, setFull] = useState(false);
  const short = formatAuditValue(k, value, ctx, false);
  const long = formatAuditValue(k, value, ctx, true);
  return (
    <span className="whitespace-pre-wrap break-words">
      {full ? long : short}
      {short !== long && (
        <button type="button" className="ml-2 text-xs text-blue-700 hover:underline" onClick={() => setFull(!full)}>
          {full ? "Kısalt" : "Tamamını göster"}
        </button>
      )}
    </span>
  );
}

export function AuditRowView({
  row,
  ctx,
  actorName,
  recordLabel,
}: {
  row: AuditRow;
  ctx: AuditNameContext;
  actorName: string;
  recordLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const href = entityHref(row.entity_type, row.entity_id);
  const rowCtx: AuditNameContext = { ...ctx, entityType: row.entity_type };
  const lines = open ? auditDiff(row) : [];

  return (
    <>
      <tr className={`border-b hover:bg-gray-50 ${open ? "bg-gray-50" : ""}`}>
        <td className="px-3 py-2 text-sm text-gray-700 whitespace-nowrap">{formatIstanbulDateTime(row.created_at)}</td>
        <td className="px-3 py-2 text-sm text-gray-800">{actorName}</td>
        <td className="px-3 py-2 text-sm text-gray-700">{entityLabel(row.entity_type)}</td>
        <td className="px-3 py-2 text-sm">
          {href ? (
            <Link href={href} className="text-blue-700 hover:underline">
              {recordLabel}
            </Link>
          ) : (
            <span className="text-gray-800">{recordLabel}</span>
          )}
        </td>
        <td className="px-3 py-2 text-sm">
          <span
            className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${
              ACTION_TONES[row.action] ?? "bg-gray-100 text-gray-800"
            }`}
          >
            {actionLabel(row.action)}
          </span>
        </td>
        <td className="px-3 py-2 text-sm text-gray-600">{auditSummary(row)}</td>
        <td className="px-3 py-2 text-sm text-right">
          <button
            type="button"
            className="text-blue-700 hover:underline whitespace-nowrap min-h-[32px]"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            {open ? "Gizle" : "Ayrıntı"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-gray-50">
          <td colSpan={7} className="px-3 pb-4">
            {lines.length === 0 ? (
              <p className="text-sm text-gray-500 py-2">Bu kayıtta gösterilecek alan yok.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full bg-white border rounded text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-gray-800 w-1/4">Alan</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-800">Önce</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-800">Sonra</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.key} className="border-t align-top">
                        <td className="px-3 py-2 text-gray-700">
                          {hasFieldLabel(row.entity_type, l.key) ? (
                            l.label
                          ) : (
                            <span className="font-mono text-xs">{l.key}</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-gray-800 ${l.changed ? "bg-yellow-50" : ""}`}>
                          <DiffValue k={l.key} value={l.before} ctx={rowCtx} />
                        </td>
                        <td className={`px-3 py-2 text-gray-800 ${l.changed ? "bg-yellow-50" : ""}`}>
                          <DiffValue k={l.key} value={l.after} ctx={rowCtx} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-gray-500 mt-2">Kayıt no: {shortId(row.entity_id)}</p>
          </td>
        </tr>
      )}
    </>
  );
}
