"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useStock } from "./StockContext";

interface Tab {
  href: string;
  label: string;
  short?: string;
  gate?: "mgr" | "cost";
  badge?: "critical" | "requests" | "corrections";
}

const TABS: Tab[] = [
  { href: "/inventory", label: "Ana ekran" },
  { href: "/inventory/items", label: "Stok kartları", badge: "critical" },
  { href: "/inventory/movements", label: "Hareketler" },
  { href: "/inventory/receipt", label: "Toplu mal kabul" },
  { href: "/inventory/counts", label: "Sayım", gate: "mgr" },
  { href: "/inventory/corrections", label: "Düzeltmeler", badge: "corrections" },
  { href: "/inventory/requests", label: "Tanımlama talepleri", badge: "requests" },
  { href: "/inventory/report", label: "Rapor", gate: "cost" },
  { href: "/inventory/settings", label: "Ayarlar", gate: "mgr" },
];

/** Tab bar and page header of the stock area (same idiom as CrmShell). */
export function StockShell({
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
  const { gates, dashboard, openSheet, notifyChanged, moduleMissing } = useStock();
  const isActive = (href: string) =>
    href === "/inventory" ? pathname === href : pathname === href || !!pathname?.startsWith(href + "/");

  const badgeValue = (b: Tab["badge"]): number => {
    if (!dashboard || !b) return 0;
    if (b === "critical") return dashboard.critical?.count ?? 0;
    if (b === "requests") return dashboard.pending?.product_requests ?? 0;
    return dashboard.pending?.corrections ?? 0;
  };

  if (moduleMissing) {
    return (
      <div className="p-4 sm:p-8 text-gray-900 max-w-full">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-4">Stok</h1>
        <div role="alert" className="p-4 rounded border border-amber-200 bg-amber-50 text-amber-900 text-sm">
          Stok modülü güncelleniyor; lütfen daha sonra tekrar deneyin. Sorun sürerse klinik sahibine bildirin.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 pb-24 sm:pb-8 text-gray-900 max-w-full">
      <nav className="mb-6 flex gap-2 border-b pb-3 overflow-x-auto" aria-label="Stok bölümleri">
        {TABS.filter((t) => (t.gate === "mgr" ? gates.mgr : t.gate === "cost" ? gates.cost : true))
          .filter((t) => t.href !== "/inventory/receipt" || gates.op)
          .map((tab) => {
            const n = badgeValue(tab.badge);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`px-3 py-1.5 rounded text-sm whitespace-nowrap ${
                  isActive(tab.href) ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                {tab.label}
                {n > 0 && (
                  <span
                    className={`ml-1.5 inline-block min-w-[1.25rem] px-1 rounded-full text-xs text-center ${
                      isActive(tab.href) ? "bg-white text-blue-700" : tab.badge === "critical" ? "bg-red-600 text-white" : "bg-amber-500 text-white"
                    }`}
                  >
                    {n}
                  </span>
                )}
              </Link>
            );
          })}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-600 mt-1">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {actions}
          {gates.op && (
            <button
              type="button"
              onClick={() => openSheet()}
              className="px-4 py-2 min-h-[44px] bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              <span className="hidden sm:inline">Hızlı hareket</span>
              <span className="sm:hidden">İşlem</span>
            </button>
          )}
          <button
            type="button"
            onClick={notifyChanged}
            className="px-4 py-2 min-h-[44px] border border-gray-300 text-gray-800 rounded hover:bg-gray-50"
          >
            Yenile
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
