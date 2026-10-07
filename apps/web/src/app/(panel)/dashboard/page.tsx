"use client";

import { useAuthStore } from "@/lib/store";

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
              <span className="font-medium">Email:</span> {user.email}
            </p>
            <p>
              <span className="font-medium">Rol:</span> {user.role}
            </p>
            <p>
              <span className="font-medium">Klinik ID:</span> {user.clinic_id}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow-md p-6 border border-border">
          <h3 className="text-xl font-semibold mb-4">📅 Ajanda</h3>
          <p className="text-foreground/60">Klinik randevularını yönetin</p>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6 border border-border">
          <h3 className="text-xl font-semibold mb-4">👥 Hastalar</h3>
          <p className="text-foreground/60">Hasta dosyalarını inceleyin</p>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6 border border-border">
          <h3 className="text-xl font-semibold mb-4">💬 Mesajlar</h3>
          <p className="text-foreground/60">Hastalarla iletişim kurun</p>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6 border border-border">
          <h3 className="text-xl font-semibold mb-4">📊 CRM</h3>
          <p className="text-foreground/60">Danışmanları izleyin</p>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6 border border-border">
          <h3 className="text-xl font-semibold mb-4">🧪 Lab</h3>
          <p className="text-foreground/60">Lab siparişlerini yönetin</p>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6 border border-border">
          <h3 className="text-xl font-semibold mb-4">📈 Raporlar</h3>
          <p className="text-foreground/60">Klinik istatistiklerini görün</p>
        </div>
      </div>
    </div>
  );
}
