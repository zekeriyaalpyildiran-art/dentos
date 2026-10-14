"use client";

import Link from "next/link";
import { useAuthStore } from "@/lib/store";

const ROLE_LABELS: Record<string, string> = {
  owner: "Sahip",
  admin: "Yönetici",
  doctor: "Hekim",
  assistant: "Asistan",
  reception: "Resepsiyon",
};

const MODULES = [
  { title: "📅 Ajanda", description: "Klinik randevularını yönetin", href: "/appointments" },
  { title: "👥 Hastalar", description: "Hasta dosyalarını inceleyin", href: "/patients" },
  { title: "💬 Mesajlar", description: "Hastalarla iletişim kurun", href: "/messages" },
  { title: "📊 CRM", description: "Danışmanları izleyin", href: "/crm/leads" },
  { title: "🧪 Lab", description: "Lab siparişlerini yönetin", href: "/lab" },
  { title: "📈 Raporlar", description: "Klinik istatistiklerini görün", href: "/reports" },
];

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold mb-8">Hoşgeldiniz</h1>

      {user && (
        <div className="bg-white rounded-lg shadow-md p-6 mb-8 border border-border">
          <h2 className="text-lg font-semibold mb-4">Kullanıcı Bilgisi</h2>
          <div className="space-y-2">
            <p>
              <span className="font-medium">E-posta:</span> {user.email}
            </p>
            <p>
              <span className="font-medium">Rol:</span> {ROLE_LABELS[user.role] || user.role}
            </p>
            <p>
              <span className="font-medium">Klinik ID:</span> {user.clinic_id}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {MODULES.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="block bg-white rounded-lg shadow-sm p-6 border border-border hover:shadow-md transition-shadow"
          >
            <h3 className="text-xl font-semibold mb-4">{item.title}</h3>
            <p className="text-foreground/60">{item.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
