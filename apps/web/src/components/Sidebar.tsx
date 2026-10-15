"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { signOut } from "@/lib/auth";
import { clearStockStorage } from "@/lib/stock/storage";
import { canSeeFinance } from "@/lib/permissions";

/** Shown only to finance / finance_readonly holders (owner decision 1: role alone gives nothing). */
const FINANCE_ITEM = { name: "💰 Finans", href: "/finance", match: "/finance" };

/** `match` marks the item active for every page under that prefix (CRM sub-pages, finance). */
const MENU_ITEMS: { name: string; href: string; match?: string; exclude?: string }[] = [
  { name: "📅 Ajanda", href: "/appointments" },
  { name: "👥 Hastalar", href: "/patients" },
  { name: "🦷 Tedavi Planları", href: "/treatment-plans" },
  { name: "🔔 Hatırlatmalar", href: "/reminders" },
  { name: "💬 Mesajlar", href: "/messages" },
  { name: "📞 CRM · Bugün", href: "/crm/today" },
  { name: "📊 CRM", href: "/crm/leads", match: "/crm", exclude: "/crm/today" },
  { name: "✅ Görevler", href: "/tasks" },
  { name: "🧪 Lab", href: "/lab" },
  { name: "📦 Stok", href: "/inventory", match: "/inventory" },
  { name: "👔 Ekip", href: "/team" },
  { name: "📈 Raporlar", href: "/reports" },
  { name: "⚙️ Ayarlar", href: "/settings" },
];

const ROLE_LABELS: Record<string, string> = {
  owner: "Sahip",
  admin: "Yönetici",
  doctor: "Hekim",
  assistant: "Asistan",
  reception: "Resepsiyon",
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);

  // 'Finans' goes right after 'Raporlar'.
  const items = canSeeFinance(user)
    ? MENU_ITEMS.flatMap((item) => (item.href === "/reports" ? [item, FINANCE_ITEM] : [item]))
    : MENU_ITEMS;

  const handleLogout = async () => {
    try {
      // Per-viewer stock drafts (bulk cart with costs, count drafts) never outlive the session on a shared PC.
      clearStockStorage();
      await signOut();
      router.push("/login");
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  return (
    <aside className="w-64 bg-background border-r border-border h-screen flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <h1 className="text-2xl font-bold">DentOS</h1>
        {user && (
          <div className="mt-4 text-sm">
            <p className="font-medium">{user.email}</p>
            <p className="text-foreground/60">{ROLE_LABELS[user.role] || user.role}</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-6">
        <ul className="space-y-2 px-4">
          {items.map((item) => {
            const prefix = "match" in item ? item.match : undefined;
            const exclude = "exclude" in item ? item.exclude : undefined;
            const isActive =
              pathname === item.href ||
              (!!prefix &&
                !!pathname?.startsWith(prefix + "/") &&
                !(exclude && (pathname === exclude || pathname.startsWith(exclude + "/"))));
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block px-4 py-2 rounded-lg transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground font-medium"
                      : "hover:bg-foreground/5"
                  }`}
                >
                  {item.name}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <button
          onClick={handleLogout}
          className="w-full px-4 py-2 text-sm border border-border rounded-lg hover:bg-foreground/5 transition-colors"
        >
          Çıkış Yap
        </button>
      </div>
    </aside>
  );
}
