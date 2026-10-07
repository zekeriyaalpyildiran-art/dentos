"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { signOut } from "@/lib/auth";

const MENU_ITEMS = [
  { name: "📅 Ajanda", href: "/panel/schedule" },
  { name: "👥 Hastalar", href: "/panel/patients" },
  { name: "💬 Mesajlar", href: "/panel/messages" },
  { name: "📊 CRM", href: "/panel/crm" },
  { name: "🧪 Lab", href: "/panel/lab" },
  { name: "📦 Stok", href: "/panel/stock" },
  { name: "👔 Ekip", href: "/panel/team" },
  { name: "📈 Raporlar", href: "/panel/reports" },
  { name: "⚙️ Ayarlar", href: "/panel/settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);

  const handleLogout = async () => {
    try {
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
            <p className="text-foreground/60 capitalize">{user.role}</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-6">
        <ul className="space-y-2 px-4">
          {MENU_ITEMS.map((item) => {
            const isActive = pathname === item.href;
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
