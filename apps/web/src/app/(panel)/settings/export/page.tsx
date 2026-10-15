"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { hasPermission } from "@/lib/permissions";
import { finExportManifest, toFinanceError, type ExportManifestJson } from "@/lib/finance";
import { crmExportCounts, crmExportTrashed, toCrmError, type CrmTrashedExportTable } from "@/lib/crm";

/**
 * Owner JSON export (owner decision 3: no paid Supabase backups). Reads every clinic table directly through
 * PostgREST, 1000 rows per request with keyset paging on id, so RLS decides what is included. fin_* tables are
 * read only when the owner also holds 'finance' (fin_export_manifest requires both).
 *
 * CRM (Phase 6): RLS hides trashed leads and their history, calls and handoffs from direct reads, so those rows
 * come from crm_export_trashed (owner only) and are merged into the same tables; crm_export_counts then proves
 * that every CRM table was read completely.
 */

const PAGE = 1000;

/** Clinic tables with a clinic_id column. device_tokens is left out on purpose: push tokens are credentials, not data. */
const CLINIC_TABLES = [
  "users",
  "staff_permissions",
  "doctors",
  "chairs",
  "procedures_catalog",
  "patients",
  "patient_access_logs",
  "appointments",
  "reminders",
  "waitlist",
  "notifications",
  "treatment_plans",
  "treatment_items",
  "payments",
  "fx_rates",
  "leads",
  "lead_activities",
  "crm_calls",
  "crm_handoffs",
  "staff_tasks",
  "crm_followup_rules",
  "appointment_reminder_logs",
  "lab_orders",
  "lab_order_items",
  "stock_items",
  "stock_transactions",
  "einvoices",
  "enabiz_logs",
  "consent_logs",
  "compliance_checks",
  "audit_logs",
] as const;

/** Tables keyed by something other than `id`: read with keyset paging on that column. */
const KEYED_TABLES: { table: string; key: string }[] = [{ table: "crm_handoff_private_notes", key: "handoff_id" }];

/** Rows hidden by RLS (trashed leads and what belongs to them), fetched through crm_export_trashed. */
const CRM_TRASHED_TABLES: CrmTrashedExportTable[] = ["leads", "lead_activities", "crm_calls", "crm_handoffs"];

/** Read only with 'finance' (crm_ad_spend amounts are finance data). */
const CRM_FINANCE_TABLES = ["crm_ad_spend"] as const;

const FINANCE_TABLES = [
  "fin_settings",
  "fin_accounts",
  "fin_report_groups",
  "fin_categories",
  "fin_counterparties",
  "fin_entries",
  "fin_payments",
  "fin_balance_snapshots",
  "fin_balance_sources",
] as const;

/** Finance tables to read: every table fin_export_manifest names (0022 adds the import and financing tables), in the
 *  manifest's order, with the Phase 1 list as the floor so an older manifest never drops a table. */
function financeTablesOf(manifest: ExportManifestJson): string[] {
  const names = manifest.tables.map((m) => m.name).filter((n) => n !== "audit_logs" && /^fin_[a-z0-9_]+$/.test(n));
  return Array.from(new Set<string>([...FINANCE_TABLES, ...names]));
}

/** A finance read is restarted when the row counts move during the export (a write happened meanwhile). */
const MAX_FINANCE_ATTEMPTS = 3;

type Row = Record<string, unknown>;

interface Progress {
  table: string;
  rows: number;
}

export default function ExportPage() {
  return (
    <ProtectedRoute allowedRoles={["owner"]}>
      <Exporter />
    </ProtectedRoute>
  );
}

function Exporter() {
  const user = useAuthStore((state) => state.user);
  const supabase = useMemo(() => createClient(), []);
  const includeFinance = hasPermission(user, "finance");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<string | null>(null);
  const cancelled = useRef(false);

  /** Reads one table completely with keyset paging (`key > last`), so the 1000-row cap never truncates it. */
  const readAll = async (table: string, scope: "clinic" | "self", key = "id"): Promise<Row[]> => {
    const rows: Row[] = [];
    let last: string | null = null;
    for (;;) {
      if (cancelled.current) throw new Error("İptal edildi.");
      let q = supabase.from(table).select("*").order(key, { ascending: true }).limit(PAGE);
      q = scope === "self" ? q.eq("id", user!.clinic_id) : q.eq("clinic_id", user!.clinic_id);
      if (last) q = q.gt(key, last);
      const { data, error: err } = await q;
      if (err) throw new Error(`${table}: ${err.message}`);
      const page = (data ?? []) as Row[];
      rows.push(...page);
      setProgress({ table, rows: rows.length });
      if (page.length < PAGE) break;
      last = String(page[page.length - 1][key]);
    }
    return rows;
  };

  /** Trashed rows of one CRM table (hidden from direct reads), keyset paged through crm_export_trashed. */
  const readTrashed = async (table: CrmTrashedExportTable): Promise<Row[]> => {
    const rows: Row[] = [];
    let after: string | null = null;
    for (;;) {
      if (cancelled.current) throw new Error("İptal edildi.");
      const r = await crmExportTrashed({ p_table: table, p_after: after, p_limit: PAGE });
      rows.push(...r.rows);
      setProgress({ table: `${table} (çöp kutusu)`, rows: rows.length });
      if (!r.next_after) break;
      after = r.next_after;
    }
    return rows;
  };

  const readFinance = async (): Promise<{
    manifest: ExportManifestJson;
    tables: Record<string, Row[]>;
    attempts: number;
    consistent: boolean;
  }> => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const manifest = await finExportManifest();
      const tables: Record<string, Row[]> = {};
      for (const t of financeTablesOf(manifest)) tables[t] = await readAll(t, "clinic");
      const after = await finExportManifest();
      const mismatch = after.tables.some((m) => {
        if (m.name === "audit_logs") return false; // compared below against the audit export
        const before = manifest.tables.find((x) => x.name === m.name)?.row_count;
        // A manifest table that was not read at all is a mismatch too (a new fin_* table can never be left out).
        return before !== m.row_count || !tables[m.name] || tables[m.name].length !== m.row_count;
      });
      if (!mismatch || attempt >= MAX_FINANCE_ATTEMPTS) {
        return { manifest: after, tables, attempts: attempt, consistent: !mismatch };
      }
    }
  };

  const run = async () => {
    if (!user?.clinic_id) return;
    cancelled.current = false;
    setRunning(true);
    setError(null);
    setWarnings([]);
    setCounts(null);
    setDoneAt(null);
    const warn: string[] = [];
    try {
      const startedAt = new Date().toISOString();
      const tables: Record<string, Row[]> = {};
      const tableErrors: Record<string, string> = {};

      tables.clinics = await readAll("clinics", "self");
      const clinicReads: { table: string; key: string }[] = [
        ...CLINIC_TABLES.map((table) => ({ table, key: "id" })),
        ...KEYED_TABLES,
        ...(includeFinance ? CRM_FINANCE_TABLES.map((table) => ({ table, key: "id" })) : []),
      ];
      for (const { table: t, key } of clinicReads) {
        try {
          tables[t] = await readAll(t, "clinic", key);
        } catch (err) {
          if (cancelled.current) throw err;
          tableErrors[t] = err instanceof Error ? err.message : String(err);
          warn.push(`${t} okunamadı: ${tableErrors[t]}`);
        }
      }

      // Trashed CRM rows (RLS hides them from the reads above), merged into the same tables.
      const trashedCounts: Record<string, number> = {};
      for (const t of CRM_TRASHED_TABLES) {
        if (tableErrors[t]) continue;
        try {
          const extra = await readTrashed(t);
          const seen = new Set((tables[t] ?? []).map((r) => String(r.id)));
          const fresh = extra.filter((r) => !seen.has(String(r.id)));
          tables[t] = [...(tables[t] ?? []), ...fresh];
          trashedCounts[t] = fresh.length;
        } catch (err) {
          if (cancelled.current) throw err;
          const message = toCrmError(err).message;
          tableErrors[`${t} (çöp kutusu)`] = message;
          warn.push(`${t} çöp kutusundaki kayıtlar okunamadı: ${message}`);
        }
      }

      // Completeness: every CRM table must hold exactly the server's row count (trashed rows included).
      let crmExpected: Record<string, number> | null = null;
      try {
        crmExpected = await crmExportCounts();
        for (const [name, expected] of Object.entries(crmExpected)) {
          if (name === "leads_trashed" || !tables[name]) continue;
          if (tables[name].length !== expected) {
            warn.push(
              `${name}: sunucuda ${expected} kayıt var, yedeğe ${tables[name].length} kayıt alındı. Kimse CRM kaydı girmezken tekrar deneyin.`
            );
          }
        }
      } catch (err) {
        if (cancelled.current) throw err;
        warn.push(`CRM kayıt sayıları doğrulanamadı: ${toCrmError(err).message}`);
      }

      let financeManifest: ExportManifestJson | null = null;
      if (includeFinance) {
        try {
          const fin = await readFinance();
          financeManifest = fin.manifest;
          Object.assign(tables, fin.tables);
          if (!fin.consistent) {
            warn.push(
              `Finans tabloları dışa aktarma sırasında değişti (${fin.attempts} deneme). Dosya yine de indirildi; kimse finans kaydı girmezken tekrar deneyin.`
            );
          }
          // audit_logs was read with the other clinic tables; its fin_* rows must match the manifest.
          const auditExpected = fin.manifest.tables.find((m) => m.name === "audit_logs")?.row_count;
          const auditFin = (tables.audit_logs ?? []).filter((r) => String(r.entity_type ?? "").startsWith("fin_")).length;
          if (auditExpected !== undefined && tables.audit_logs && auditExpected !== auditFin) {
            warn.push(`Finans denetim kayıtları sayısı farklı (beklenen ${auditExpected}, okunan ${auditFin}).`);
          }
        } catch (err) {
          if (cancelled.current) throw err;
          const fe = toFinanceError(err);
          tableErrors.finance = fe.message;
          warn.push(`Finans verileri okunamadı: ${fe.message}`);
        }
      }

      const perTable: Record<string, number> = {};
      for (const [name, rows] of Object.entries(tables)) perTable[name] = rows.length;

      const exportedAt = new Date().toISOString();
      const payload = {
        format: "dentos-export/1",
        exported_at: exportedAt,
        started_at: startedAt,
        clinic_id: user.clinic_id,
        exported_by_user_id: user.user_id,
        finance_included: includeFinance && !tableErrors.finance,
        finance_manifest: financeManifest,
        excluded_tables: { device_tokens: "Bildirim cihaz anahtarları yedeğe alınmaz." },
        errors: tableErrors,
        counts: perTable,
        crm_trashed_counts: trashedCounts,
        crm_expected_counts: crmExpected,
        tables,
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dentos-yedek-${exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      setCounts(perTable);
      setWarnings(warn);
      setDoneAt(exportedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dışa aktarma tamamlanamadı.");
      setWarnings(warn);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div className="p-8 space-y-6 text-gray-900">
      <Link href="/settings" className="inline-block px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300">
        ← Ayarlar
      </Link>
      <h1 className="text-3xl font-bold">Veri yedeği (JSON)</h1>

      <div className="bg-white p-6 rounded-lg shadow space-y-4">
        <p className="text-sm text-gray-700">
          Kliniğin tüm kayıtları tek bir JSON dosyası olarak bilgisayarınıza indirilir. Dosya hasta ve finans verisi
          içerir; güvenli bir yerde saklayın ve paylaşmayın. Geri yükleme bu ekrandan yapılmaz.
        </p>
        <p className="text-sm text-gray-700">
          {includeFinance
            ? "Finans tabloları ve finans geçmişi dahil edilecek."
            : "Finans yetkiniz olmadığı için finans tabloları dahil edilmeyecek."}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-500"
          >
            {running ? "Hazırlanıyor..." : "Yedeği indir"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => {
                cancelled.current = true;
              }}
              className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
            >
              Durdur
            </button>
          )}
        </div>
        {progress && (
          <p className="text-sm text-gray-600">
            {progress.table}: {progress.rows.toLocaleString("tr-TR")} satır okundu...
          </p>
        )}
        {error && <div className="p-4 rounded bg-red-50 text-red-700 text-sm">{error}</div>}
        {warnings.length > 0 && (
          <ul className="p-4 rounded bg-amber-50 text-amber-800 text-sm list-disc pl-8 space-y-1">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        {doneAt && (
          <div className="p-4 rounded bg-green-50 text-green-800 text-sm">
            Yedek indirildi ({new Date(doneAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}).
          </div>
        )}
      </div>

      {counts && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-lg font-semibold mb-3">Tablo başına satır sayısı</h2>
          <dl className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            {Object.entries(counts).map(([name, n]) => (
              <div key={name} className="flex justify-between py-1 border-b">
                <dt className="text-gray-600">{name}</dt>
                <dd className="tabular-nums">{n.toLocaleString("tr-TR")}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
