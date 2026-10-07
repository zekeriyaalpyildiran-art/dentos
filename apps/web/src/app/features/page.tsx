'use client';

import Link from 'next/link';
import { useState } from 'react';

export default function FeaturesPage() {
  const [expandedCategory, setExpandedCategory] = useState<string | null>('appointments');

  const features = [
    {
      id: 'appointments',
      icon: '📅',
      name: 'Randevu Yönetimi',
      description: 'Hasta randevu takibi, çakışma tespiti, SMS/email hatırlatıcıları',
      link: '/appointments',
      capabilities: [
        { item: 'Randevu takvimi', status: 'full' },
        { item: 'Çoklu doktor desteği', status: 'full' },
        { item: 'İşlem prosedürleri', status: 'full' },
        { item: 'SMS hatırlatıcıları', status: 'demo' },
        { item: 'Çakışma tespiti', status: 'full' },
        { item: '24 saat iptal penceresi', status: 'full' },
      ],
    },
    {
      id: 'patients',
      icon: '👥',
      name: 'Hasta Yönetimi',
      description: 'Hasta profilleri, tıbbi geçmiş, KVKK onayları, tedavi kütüphanesi',
      link: '/patients',
      capabilities: [
        { item: 'Hasta profilleri', status: 'full' },
        { item: 'Tıbbi geçmiş ve notlar', status: 'full' },
        { item: 'KVKK onay takibi', status: 'full' },
        { item: 'Tedavi geçmişi', status: 'full' },
        { item: 'Alerjiler ve uyarılar', status: 'full' },
        { item: 'İletişim bilgileri', status: 'full' },
      ],
    },
    {
      id: 'treatment',
      icon: '💰',
      name: 'Tedavi Planları & Ödemeler',
      description: '1/3/6/12 ay taksitli ödeme planları, fiyatlandırma, ödeme takibi',
      link: '/treatment-plans',
      capabilities: [
        { item: 'Tedavi planı oluşturma', status: 'full' },
        { item: 'Dinamik fiyatlandırma', status: 'full' },
        { item: '1/3/6/12 ay taksitler', status: 'full' },
        { item: 'Ödeme takibi', status: 'full' },
        { item: 'Iyzico entegrasyonu', status: 'demo' },
        { item: 'Faturalama', status: 'full' },
      ],
    },
    {
      id: 'crm',
      icon: '🎯',
      name: 'CRM Kanban Tahtası',
      description: '6 aşamalı lead yönetimi: Yeni → İletişim → İlgilendiği → Nitelikli → Müşteri → Kaybedildi',
      link: '/crm/kanban',
      capabilities: [
        { item: 'Kanban tahtası', status: 'full' },
        { item: '6 özel kolona (Türkçe)', status: 'full' },
        { item: 'Sürükle-bırak işlevi', status: 'full' },
        { item: 'Lead detaylı bilgileri', status: 'full' },
        { item: 'Durum takibi', status: 'full' },
        { item: 'Yorum ve notlar', status: 'full' },
      ],
    },
    {
      id: 'inventory',
      icon: '📦',
      name: 'Envanter Yönetimi',
      description: 'Tıbbi malzeme stok takibi, son kullanma tarihleri, düşük stok uyarıları',
      link: '/inventory',
      capabilities: [
        { item: 'Malzeme envanteri', status: 'full' },
        { item: 'Stok seviyeleri', status: 'full' },
        { item: 'Düşük stok uyarıları', status: 'full' },
        { item: 'Son kullanma tarihleri', status: 'full' },
        { item: 'Satın alma geçmişi', status: 'full' },
        { item: 'Kategoriler ve etiketler', status: 'full' },
      ],
    },
    {
      id: 'lab',
      icon: '🧪',
      name: 'Lab Siparişleri',
      description: 'Protez ve dental laboratuvar işlerini takip et: sipariş → üretim → teslimat',
      link: '/lab',
      capabilities: [
        { item: 'Lab sipariş formu', status: 'full' },
        { item: 'Diş numaraları ve malzemeler', status: 'full' },
        { item: 'Durum takibi', status: 'full' },
        { item: 'Teslim tarihleri', status: 'full' },
        { item: 'Lab notları ve gereksinimler', status: 'full' },
        { item: 'Belge bağlama', status: 'full' },
      ],
    },
    {
      id: 'compliance',
      icon: '📊',
      name: 'Türkçe Uyum Raporları',
      description: 'e-Arşiv (vergi faturası), e-Nabız (sağlık sistemi), KVKK (gizlilik) denetim günlükleri',
      link: '/reports',
      capabilities: [
        { item: 'e-Arşiv desteği', status: 'demo' },
        { item: 'e-Nabız integrasyonu', status: 'demo' },
        { item: 'KVKK denetim günlükleri', status: 'full' },
        { item: 'Veri dışa aktarma', status: 'full' },
        { item: 'Uyum raporları', status: 'full' },
        { item: 'Yedekleme ve geri yükleme', status: 'full' },
      ],
    },
    {
      id: 'auth',
      icon: '🔐',
      name: 'Kimlik Doğrulama & Güvenlik',
      description: 'JWT tabanlı OTP giriş, rol tabanlı erişim, çok kiracılı mimari',
      link: '/login',
      capabilities: [
        { item: 'SMS OTP giriş', status: 'demo' },
        { item: 'Rol tabanlı erişim kontrolü', status: 'full' },
        { item: '3 rol türü (admin, doktor, resepsiyon)', status: 'full' },
        { item: 'Çok kiracılı izolasyon', status: 'full' },
        { item: 'JWT tokenler', status: 'full' },
        { item: 'Oturum yönetimi', status: 'full' },
      ],
    },
    {
      id: 'mobile',
      icon: '📱',
      name: 'Mobil Uygulama (Expo)',
      description: 'Hastalar randevu görebilir, rezervasyon yapabilir, push bildirimleri alabilir',
      link: '#',
      capabilities: [
        { item: 'OTP telefonla giriş', status: 'full' },
        { item: 'Randevu görüntüleme', status: 'full' },
        { item: 'Yeni randevu rezervasyonu', status: 'full' },
        { item: 'Profil yönetimi', status: 'full' },
        { item: 'Push bildirimleri', status: 'demo' },
        { item: 'iOS ve Android', status: 'full' },
      ],
    },
    {
      id: 'integrations',
      icon: '🔌',
      name: 'Entegrasyonlar',
      description: 'Harici hizmetlerle entegrasyon: SMS, ödeme, vergi, sağlık sistemi',
      link: '#',
      capabilities: [
        { item: 'Netgsm SMS gateway', status: 'demo' },
        { item: 'Iyzico ödemeleri', status: 'demo' },
        { item: 'e-Arşiv tax system', status: 'demo' },
        { item: 'e-Nabız health system', status: 'demo' },
        { item: 'REST API', status: 'full' },
        { item: 'Webhook desteği', status: 'full' },
      ],
    },
  ];

  const statusBadge = (status: string) => {
    switch (status) {
      case 'full':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-700">
            ✅ Tam
          </span>
        );
      case 'demo':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-yellow-100 text-yellow-700">
            ⚠️ Demo
          </span>
        );
      case 'planned':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-700">
            📋 Planlandı
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="text-6xl mb-4">✨</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">DentOS Özellikleri</h1>
          <p className="text-lg text-gray-600">8 Sprint - 10 Ana Modül - 50+ Bileşen - Tamamen Türkçe</p>
        </div>

        {/* Status Legend */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-900">Durum Açıklaması</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded text-sm font-medium bg-green-100 text-green-700">
                ✅ Tam
              </span>
              <span className="text-gray-600">Üretim hazır, tam işlevsel</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded text-sm font-medium bg-yellow-100 text-yellow-700">
                ⚠️ Demo
              </span>
              <span className="text-gray-600">Test modu, harici API gerekli</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded text-sm font-medium bg-gray-100 text-gray-700">
                📋 Planlandı
              </span>
              <span className="text-gray-600">Gelecek versiyonlar</span>
            </div>
          </div>
        </div>

        {/* Features Grid */}
        <div className="space-y-4">
          {features.map((feature) => (
            <div key={feature.id} className="bg-white rounded-lg shadow overflow-hidden">
              {/* Feature Header */}
              <button
                onClick={() =>
                  setExpandedCategory(expandedCategory === feature.id ? null : feature.id)
                }
                className="w-full flex items-start justify-between p-6 hover:bg-gray-50 transition-colors text-left"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-3xl">{feature.icon}</span>
                    <h3 className="text-xl font-bold text-gray-900">{feature.name}</h3>
                  </div>
                  <p className="text-gray-600">{feature.description}</p>
                </div>
                <span className="text-2xl ml-4 flex-shrink-0">
                  {expandedCategory === feature.id ? '▼' : '▶'}
                </span>
              </button>

              {/* Feature Details */}
              {expandedCategory === feature.id && (
                <div className="border-t border-gray-200 p-6 bg-gray-50">
                  <div className="space-y-3 mb-6">
                    {feature.capabilities.map((cap, idx) => (
                      <div key={idx} className="flex items-center justify-between">
                        <span className="text-gray-700">{cap.item}</span>
                        {statusBadge(cap.status)}
                      </div>
                    ))}
                  </div>

                  <Link
                    href={feature.link}
                    className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                  >
                    Dene →
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Statistics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-12">
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-blue-600">10</div>
            <div className="text-sm text-gray-600">Ana Modül</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-green-600">50+</div>
            <div className="text-sm text-gray-600">Bileşen</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-purple-600">24</div>
            <div className="text-sm text-gray-600">Veritabanı Tablosu</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-orange-600">100%</div>
            <div className="text-sm text-gray-600">Türkçe</div>
          </div>
        </div>

        {/* Call to Action */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg shadow-lg p-8 mt-12 text-white text-center">
          <h2 className="text-2xl font-bold mb-4">Hemen Başla</h2>
          <p className="mb-6">Setup sayfasından tercih ettiğin kurulum seçeneğini seç</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/setup"
              className="px-6 py-3 bg-white text-blue-600 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
            >
              ⚙️ Kurulum Seçeneği
            </Link>
            <Link
              href="/dashboard"
              className="px-6 py-3 border-2 border-white text-white rounded-lg font-semibold hover:bg-white hover:bg-opacity-10 transition-colors"
            >
              📊 Dashboard
            </Link>
          </div>
        </div>

        {/* Technology Stack */}
        <div className="bg-white rounded-lg shadow p-6 mt-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-900">🛠️ Teknoloji Stack</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <strong className="text-gray-900">Frontend</strong>
              <p className="text-gray-600">Next.js 14 + React 19 + TypeScript</p>
            </div>
            <div>
              <strong className="text-gray-900">Mobile</strong>
              <p className="text-gray-600">Expo + React Native</p>
            </div>
            <div>
              <strong className="text-gray-900">Backend</strong>
              <p className="text-gray-600">Supabase + PostgreSQL 15</p>
            </div>
            <div>
              <strong className="text-gray-900">ORM</strong>
              <p className="text-gray-600">Drizzle + TypeScript Migrations</p>
            </div>
            <div>
              <strong className="text-gray-900">State</strong>
              <p className="text-gray-600">Zustand + TypeScript</p>
            </div>
            <div>
              <strong className="text-gray-900">Styling</strong>
              <p className="text-gray-600">Tailwind CSS + Responsive</p>
            </div>
            <div>
              <strong className="text-gray-900">Deployment</strong>
              <p className="text-gray-600">Docker + Vercel + AWS ECS</p>
            </div>
            <div>
              <strong className="text-gray-900">CI/CD</strong>
              <p className="text-gray-600">GitHub Actions + Secrets Scanning</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
