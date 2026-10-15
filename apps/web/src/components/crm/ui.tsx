"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "@/lib/store";
import { hasPermission } from "@/lib/permissions";
import type { CrmError } from "@/lib/crm";
import {
  INTEREST_LABELS,
  INTEREST_STYLES,
  STAGE_STYLES,
  stageLabel,
  type Interest,
  type Stage,
} from "@/lib/crm/codes";

export {
  Card,
  Field,
  Loading,
  Pager,
  SuccessBox,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/finance/ui";

/**
 * UI hint for manager-only controls: role owner or the 'crm_manage' grant (crm_can_manage()).
 * The database enforces the same rule; this only hides controls that would be refused.
 */
export function useCanManageCrm(): boolean {
  const user = useAuthStore((state) => state.user);
  return !!user && (user.role === "owner" || hasPermission(user, "crm_manage"));
}

const TABS: { href: string; label: string; managerOnly?: boolean }[] = [
  { href: "/crm/today", label: "Bugün" },
  { href: "/crm/calls", label: "Arama planı" },
  { href: "/crm/quick-calls", label: "Hızlı arama" },
  { href: "/crm/leads", label: "Hasta adayları" },
  { href: "/crm/kanban", label: "Kanban" },
  { href: "/crm/handoffs", label: "Aktarımlar" },
  { href: "/crm/reports", label: "Raporlar" },
  { href: "/crm/manager", label: "Yönetici özeti", managerOnly: true },
  { href: "/crm/settings/rules", label: "Takip kuralları" },
  { href: "/crm/trash", label: "Çöp kutusu" },
];

export function CrmShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const canManage = useCanManageCrm();
  const isActive = (href: string) => pathname === href || !!pathname?.startsWith(href + "/");

  return (
    <div className="p-8 text-gray-900">
      <nav className="mb-6 flex flex-wrap gap-2 border-b pb-3" aria-label="CRM bölümleri">
        {TABS.filter((t) => canManage || !t.managerOnly).map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-1.5 rounded text-sm ${
              isActive(tab.href) ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {tab.label}
          </Link>
        ))}
        <Link href="/tasks" className="px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100">
          Görevler
        </Link>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-600 mt-1">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function CrmErrorBox({ error, onReload }: { error: CrmError | null; onReload?: () => void }) {
  if (!error) return null;
  return (
    <div className="p-3 rounded bg-red-50 text-red-700 text-sm flex flex-wrap items-center gap-3" role="alert">
      <span className="flex-1 min-w-[12rem]">{error.message}</span>
      {error.isConflict && onReload && (
        <button
          type="button"
          onClick={onReload}
          className="px-3 py-1 rounded border border-red-300 bg-white hover:bg-red-100"
        >
          Yenile
        </button>
      )}
    </div>
  );
}

/**
 * Modal dialog. Escape and the backdrop close it unless `busy`, or unless `locked`
 * (quick calls: the queue cannot be left by accident, QC).
 */
export function CrmModal({
  title,
  description,
  children,
  onClose,
  busy,
  wide,
  locked,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  locked?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !locked) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, locked]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy && !locked) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`bg-white rounded-lg shadow-xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} mt-12 mb-12 text-gray-900`}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="text-sm text-gray-600 mt-0.5">{description}</p>}
          </div>
          {!locked && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-gray-500 hover:text-gray-800 disabled:opacity-40"
              aria-label="Kapat"
            >
              ✕
            </button>
          )}
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

export function StageBadge({ stage }: { stage: Stage | string }) {
  const cls = STAGE_STYLES[stage as Stage] ?? "bg-gray-100 text-gray-700";
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{stageLabel(stage)}</span>;
}

export function InterestBadge({ interest }: { interest: Interest | string | null | undefined }) {
  const key = (interest ?? "unknown") as Interest;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${INTEREST_STYLES[key] ?? INTEREST_STYLES.unknown}`}>
      {INTEREST_LABELS[key] ?? interest}
    </span>
  );
}

export function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${className}`}>{children}</span>;
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "danger" | "success";
  children: ReactNode;
}) {
  const cls =
    tone === "warn"
      ? "bg-amber-50 text-amber-900 border-amber-200"
      : tone === "danger"
        ? "bg-red-50 text-red-800 border-red-200"
        : tone === "success"
          ? "bg-green-50 text-green-800 border-green-200"
          : "bg-blue-50 text-blue-900 border-blue-200";
  return <div className={`p-3 rounded border text-sm ${cls}`}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-gray-500 text-sm">{children}</p>;
}
