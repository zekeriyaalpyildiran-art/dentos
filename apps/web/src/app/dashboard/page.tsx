'use client';

import Link from 'next/link';
import { useState } from 'react';

interface DashboardCard {
  icon: string;
  title: string;
  value: string | number;
  detail: string;
  link: string;
  color: string;
}

export default function DashboardPage() {
  // Simulating different roles - in production, get from auth context
  const [userRole] = useState<'admin' | 'doctor' | 'receptionist'>('admin');

  const adminCards: DashboardCard[] = [
    {
      icon: '📊',
      title: 'Aktif Randevular',
      value: 12,
      detail: 'Bugün',
      link: '/appointments',
      color: 'blue',
    },
    {
      icon: '👥',
      title: 'Hastalar',
      value: 156,
      detail: 'Kayıtlı',
      link: '/patients',
      color: 'green',
    },
    {
      icon: '💰',
      title: 'Ödeme Beklemede',
      value: '₺45,000',
      detail: '12 Plan',
      link: '/treatment-plans',
      color: 'purple',
    },
    {
      icon: '👨‍⚕️',
      title: 'Doktor',
      value: 2,
      detail: 'Aktif',
      link: '/admin/users',
      color: 'orange',
    },
    {
      icon: '🎯',
      title: 'Yeni Leads',
      value: 8,
      detail: 'Bu ay',
      link: '/crm/kanban',
      color: 'red',
    },
    {
      icon: '⚙️',
      title: 'Sistem Ayarları',
      value: '✓',
      detail: 'Yapılandırılmış',
      link: '/admin/settings',
      color: 'gray',
    },
  ];

  const doctorCards: DashboardCard[] = [
    {
      icon: '📅',
      title: 'Bugünkü Randevular',
      value: 5,
      detail: 'Saatler: 09:00-18:00',
      link: '/appointments',
      color: 'blue',
    },
    {
      icon: '👤',
      title: 'Hastalarım',
      value: 42,
      detail: 'Aktif tedavi',
      link: '/patients',
      color: 'green',
    },
    {
      icon: '💊',
      title: 'Tedavi Planları',
      value: 18,
      detail: 'Devam eden',
      link: '/treatment-plans',
      color: 'purple',
    },
    {
      icon: '🧪',
      title: 'Lab Siparişleri',
      value: 3,
      detail: 'Beklemede',
      link: '/lab',
      color: 'orange',
    },
  ];

  const receptionistCards: DashboardCard[] = [
    {
      icon: '📅',
      title: 'Randevular Bugün',
      value: 12,
      detail: 'Saatler: 09:00-18:00',
      link: '/appointments',
      color: 'blue',
    },
    {
      icon: '📞',
      title: 'İptal/Yeniden Planla',
      value: 2,
      detail: 'Yapılması gereken',
      link: '/appointments',
      color: 'red',
    },
    {
      icon: '👥',
      title: 'Yeni Hasta',
      value: 3,
      detail: 'Bu hafta',
      link: '/patients',
      color: 'green',
    },
    {
      icon: '💬',
      title: 'SMS Gönder',
      value: '→',
      detail: 'Hatırlatıcı',
      link: '/appointments',
      color: 'purple',
    },
  ];

  const cards =
    userRole === 'admin'
      ? adminCards
      : userRole === 'doctor'
      ? doctorCards
      : receptionistCards;

  const roleInfo = {
    admin: {
      greeting: '👨‍💼 Yönetici',
      subtitle: 'Tüm sistem yönetim gösterge paneli',
      icon: '🏢',
    },
    doctor: {
      greeting: '👨‍⚕️ Dr. Ece Kara',
      subtitle: 'Randevu ve hasta yönetimi',
      icon: '🩺',
    },
    receptionist: {
      greeting: '👩‍💼 Resepsiyonist',
      subtitle: 'Randevu ve hasta takibi',
      icon: '📞',
    },
  };

  const role = roleInfo[userRole];

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-4xl font-bold text-gray-900">
                {role.icon} Merhaba, {role.greeting}
              </h1>
              <p className="text-lg text-gray-600 mt-2">{role.subtitle}</p>
            </div>
            <div className="text-right">
              <div className="text-3xl">📅</div>
              <p className="text-gray-600 mt-2">
                {new Date().toLocaleDateString('tr-TR', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
          </div>
        </div>

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
          {cards.map((card, idx) => (
            <Link
              key={idx}
              href={card.link}
              className={`bg-white rounded-lg shadow hover:shadow-lg transition-all p-6 border-l-4 ${
                card.color === 'blue'
                  ? 'border-blue-600'
                  : card.color === 'green'
                  ? 'border-green-600'
                  : card.color === 'purple'
                  ? 'border-purple-600'
                  : card.color === 'orange'
                  ? 'border-orange-600'
                  : card.color === 'red'
                  ? 'border-red-600'
                  : 'border-gray-600'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-gray-600 text-sm">{card.title}</p>
                  <h2 className="text-3xl font-bold text-gray-900 mt-2">
                    {card.value}
                  </h2>
                  <p className="text-gray-500 text-xs mt-2">{card.detail}</p>
                </div>
                <span className="text-3xl">{card.icon}</span>
              </div>
            </Link>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">⚡ Hızlı İşlemler</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Link
              href="/appointments"
              className="p-4 bg-blue-50 hover:bg-blue-100 rounded-lg transition-all text-center"
            >
              <span className="text-3xl">📅</span>
              <p className="text-sm font-semibold text-gray-900 mt-2">
                Randevu Gör
              </p>
            </Link>

            <Link
              href="/patients"
              className="p-4 bg-green-50 hover:bg-green-100 rounded-lg transition-all text-center"
            >
              <span className="text-3xl">👥</span>
              <p className="text-sm font-semibold text-gray-900 mt-2">
                Hasta Ara
              </p>
            </Link>

            <Link
              href="/treatment-plans"
              className="p-4 bg-purple-50 hover:bg-purple-100 rounded-lg transition-all text-center"
            >
              <span className="text-3xl">💊</span>
              <p className="text-sm font-semibold text-gray-900 mt-2">
                Tedavi Planı
              </p>
            </Link>

            {userRole === 'admin' && (
              <Link
                href="/admin/users"
                className="p-4 bg-orange-50 hover:bg-orange-100 rounded-lg transition-all text-center"
              >
                <span className="text-3xl">👨‍💼</span>
                <p className="text-sm font-semibold text-gray-900 mt-2">
                  Kullanıcılar
                </p>
              </Link>
            )}

            {userRole === 'admin' && (
              <Link
                href="/crm/kanban"
                className="p-4 bg-red-50 hover:bg-red-100 rounded-lg transition-all text-center"
              >
                <span className="text-3xl">🎯</span>
                <p className="text-sm font-semibold text-gray-900 mt-2">
                  CRM/Leads
                </p>
              </Link>
            )}

            {userRole === 'admin' && (
              <Link
                href="/admin/settings"
                className="p-4 bg-gray-50 hover:bg-gray-100 rounded-lg transition-all text-center"
              >
                <span className="text-3xl">⚙️</span>
                <p className="text-sm font-semibold text-gray-900 mt-2">
                  Ayarlar
                </p>
              </Link>
            )}
          </div>
        </div>

        {/* Today's Overview */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Recent Activity */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-bold text-gray-900 mb-4">
              📋 Son Aktiviteler
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div>
                  <p className="font-semibold text-gray-900">
                    Randevu Oluşturuldu
                  </p>
                  <p className="text-sm text-gray-600">
                    Ahmet Yılmaz - Dr. Ece Kara
                  </p>
                </div>
                <span className="text-xs text-gray-500">10 dk önce</span>
              </div>

              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div>
                  <p className="font-semibold text-gray-900">
                    Tedavi Planı Oluşturuldu
                  </p>
                  <p className="text-sm text-gray-600">
                    Mehmet Şahin - ₺5,000
                  </p>
                </div>
                <span className="text-xs text-gray-500">2 saat önce</span>
              </div>

              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div>
                  <p className="font-semibold text-gray-900">Ödeme Alındı</p>
                  <p className="text-sm text-gray-600">
                    Selin Özkan - ₺2,500 Taksit
                  </p>
                </div>
                <span className="text-xs text-gray-500">5 saat önce</span>
              </div>
            </div>
          </div>

          {/* System Status */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-bold text-gray-900 mb-4">
              ✓ Sistem Durumu
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🟢</span>
                  <span className="font-semibold text-gray-900">
                    Veritabanı
                  </span>
                </div>
                <span className="text-green-600 font-semibold">Bağlı</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🟢</span>
                  <span className="font-semibold text-gray-900">API</span>
                </div>
                <span className="text-green-600 font-semibold">Aktif</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🟢</span>
                  <span className="font-semibold text-gray-900">
                    Netgsm SMS
                  </span>
                </div>
                <span className="text-green-600 font-semibold">Demo</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">🟢</span>
                  <span className="font-semibold text-gray-900">
                    Iyzico Ödeme
                  </span>
                </div>
                <span className="text-green-600 font-semibold">Demo</span>
              </div>

              <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700 font-semibold">
                  ✓ Tüm sistemler normal çalışıyor
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
