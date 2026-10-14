"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuthStore } from "@/lib/store";
import { hasPermission, type Permission } from "@/lib/permissions";

/** Read pages: 'finance' or 'finance_readonly'. Write-only pages pass requireWrite. */
const READ_PERMISSIONS: readonly Permission[] = ["finance", "finance_readonly"];

const TABS: { href: string; label: string; writeOnly?: boolean }[] = [
  { href: "/finance", label: "Özet" },
  { href: "/finance/entries", label: "Ödeme ve tahsilatlar" },
  { href: "/finance/plan", label: "Yaklaşan plan" },
  { href: "/finance/counterparties", label: "Cariler" },
  { href: "/finance/balances", label: "Bakiyeler" },
  { href: "/finance/reports", label: "Raporlar" },
  { href: "/finance/entitlement", label: "Hekim hakedişi", writeOnly: true },
  { href: "/finance/audit", label: "Finans geçmişi" },
  { href: "/finance/settings", label: "Finans ayarları" },
];

/** True when the signed-in user may use write controls (has 'finance'). */
export function useCanWriteFinance(): boolean {
  const user = useAuthStore((state) => state.user);
  return hasPermission(user, "finance");
}

export function FinanceShell({
  title,
  actions,
  children,
  requireWrite,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  requireWrite?: boolean;
}) {
  return (
    <ProtectedRoute requiredPermission={requireWrite ? "finance" : READ_PERMISSIONS}>
      <FinanceFrame title={title} actions={actions}>
        {children}
      </FinanceFrame>
    </ProtectedRoute>
  );
}

function FinanceFrame({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const canWrite = useCanWriteFinance();

  const isActive = (href: string) =>
    href === "/finance" ? pathname === href : pathname === href || !!pathname?.startsWith(href + "/");

  return (
    <div className="p-8">
      <nav className="mb-6 flex flex-wrap gap-2 border-b pb-3">
        {TABS.filter((t) => canWrite || !t.writeOnly).map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-1.5 rounded text-sm ${
              isActive(tab.href)
                ? "bg-blue-600 text-white"
                : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
          {!canWrite && (
            <span className="px-2 py-0.5 rounded bg-gray-200 text-gray-700 text-xs font-medium">
              Salt okunur
            </span>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
