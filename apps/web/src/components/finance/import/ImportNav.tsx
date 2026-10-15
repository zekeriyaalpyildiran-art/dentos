"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCanWriteFinance } from "@/components/finance/FinanceShell";

const LINKS: { href: string; label: string; writeOnly?: boolean }[] = [
  { href: "/finance/import", label: "Aktarım", writeOnly: true },
  { href: "/finance/import/history", label: "Aktarım geçmişi" },
  { href: "/finance/import/rules", label: "Sınıflandırma kuralları" },
  { href: "/finance/import/layouts", label: "Sütun eşleştirmeleri ve hesap anahtarları" },
];

/** Second-level navigation of the 'Dosyadan aktar' section. */
export function ImportNav() {
  const pathname = usePathname();
  const canWrite = useCanWriteFinance();
  return (
    <nav className="flex flex-wrap gap-2 mb-6 text-sm">
      {LINKS.filter((l) => canWrite || !l.writeOnly).map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`px-3 py-1 rounded-full border ${
              active ? "bg-blue-50 border-blue-400 text-blue-800" : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
