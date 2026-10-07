import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      {/* Navigation */}
      <nav className="bg-white shadow-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-8 py-4 flex items-center justify-between">
          <div className="text-2xl font-bold text-blue-600">🦷 DentOS</div>
          <div className="flex gap-4">
            <Link
              href="/setup"
              className="px-4 py-2 text-gray-700 hover:text-blue-600 transition-colors"
            >
              Kurulum
            </Link>
            <Link
              href="/features"
              className="px-4 py-2 text-gray-700 hover:text-blue-600 transition-colors"
            >
              Özellikler
            </Link>
            <Link
              href="/login"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Giriş
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="max-w-6xl mx-auto px-8 py-20">
        <div className="text-center mb-16">
          <div className="text-7xl mb-6 animate-bounce inline-block">🦷</div>
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            DentOS - Diş Kliniği Yönetim Sistemi
          </h1>
          <p className="text-2xl text-gray-600 mb-8">
            Türkçe, tamamen üretim hazır, 8 Sprint'te geliştirilmiş
          </p>
          <div className="flex gap-4 justify-center">
            <Link
              href="/dashboard"
              className="px-8 py-4 bg-blue-600 text-white rounded-lg text-lg font-semibold hover:bg-blue-700 transition-all transform hover:scale-105"
            >
              Dashboard'u Aç
            </Link>
            <Link
              href="/features"
              className="px-8 py-4 bg-white border-2 border-blue-600 text-blue-600 rounded-lg text-lg font-semibold hover:bg-blue-50 transition-all"
            >
              Özellikleri Gör
            </Link>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-16">
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-blue-600">10</div>
            <div className="text-sm text-gray-600 mt-2">Ana Modül</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-green-600">50+</div>
            <div className="text-sm text-gray-600 mt-2">Bileşen</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-purple-600">24</div>
            <div className="text-sm text-gray-600 mt-2">DB Tablosu</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-orange-600">100%</div>
            <div className="text-sm text-gray-600 mt-2">Türkçe</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <div className="text-3xl font-bold text-red-600">0</div>
            <div className="text-sm text-gray-600 mt-2">Setup Gerekli</div>
          </div>
        </div>

        {/* Quick Start */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8">⚡ Hızlı Başlangıç</h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="border-2 border-green-200 rounded-lg p-6">
              <div className="text-4xl mb-4">0️⃣</div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Demo Modu</h3>
              <p className="text-gray-600 mb-4">Setup gerekmez, hemen deneyim çalıştır</p>
              <Link
                href="/dashboard"
                className="inline-block px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              >
                Başla →
              </Link>
            </div>

            <div className="border-2 border-blue-200 rounded-lg p-6">
              <div className="text-4xl mb-4">🐳</div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Docker Setup</h3>
              <p className="text-gray-600 mb-4">Lokal PostgreSQL ile tam özellik</p>
              <Link
                href="/setup"
                className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Kurulum →
              </Link>
            </div>

            <div className="border-2 border-purple-200 rounded-lg p-6">
              <div className="text-4xl mb-4">☁️</div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Supabase Cloud</h3>
              <p className="text-gray-600 mb-4">Prodüksiyona hazır bulut çözümü</p>
              <Link
                href="/setup"
                className="inline-block px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700"
              >
                Kurulum →
              </Link>
            </div>
          </div>
        </div>

        {/* Features Grid */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-16">
          <h2 className="text-3xl font-bold text-gray-900 mb-8">✨ 10 Ana Modül</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <Link
              href="/appointments"
              className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-2">📅</div>
              <h3 className="font-bold text-gray-900 mb-2">Randevu Yönetimi</h3>
              <p className="text-sm text-gray-600">Takvim, çakışma tespiti, SMS/Email hatırlatıcıları</p>
            </Link>

            <Link
              href="/patients"
              className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-2">👥</div>
              <h3 className="font-bold text-gray-900 mb-2">Hasta Yönetimi</h3>
              <p className="text-sm text-gray-600">Profiller, tıbbi geçmiş, KVKK onayları</p>
            </Link>

            <Link
              href="/treatment-plans"
              className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-2">💰</div>
              <h3 className="font-bold text-gray-900 mb-2">Tedavi Planları & Ödeme</h3>
              <p className="text-sm text-gray-600">1/3/6/12 ay taksitler, Iyzico entegrasyonu</p>
            </Link>

            <Link
              href="/crm/kanban"
              className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-2">🎯</div>
              <h3 className="font-bold text-gray-900 mb-2">CRM Kanban</h3>
              <p className="text-sm text-gray-600">6 aşamalı lead tahtası, sürükle-bırak</p>
            </Link>

            <Link
              href="/inventory"
              className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-2">📦</div>
              <h3 className="font-bold text-gray-900 mb-2">Envanter Yönetimi</h3>
              <p className="text-sm text-gray-600">Stok takibi, son kullanma tarihleri, uyarılar</p>
            </Link>

            <Link
              href="/lab"
              className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-2">🧪</div>
              <h3 className="font-bold text-gray-900 mb-2">Lab Siparişleri</h3>
              <p className="text-sm text-gray-600">Protez takibi, durum yönetimi, teslim tarihler</p>
            </Link>

            <div className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all cursor-pointer">
              <div className="text-3xl mb-2">📊</div>
              <h3 className="font-bold text-gray-900 mb-2">Türkçe Uyum Raporları</h3>
              <p className="text-sm text-gray-600">e-Arşiv, e-Nabız, KVKK denetim günlükleri</p>
            </div>

            <div className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all cursor-pointer">
              <div className="text-3xl mb-2">🔐</div>
              <h3 className="font-bold text-gray-900 mb-2">Kimlik Doğrulama</h3>
              <p className="text-sm text-gray-600">JWT + OTP, RBAC, çok kiracılı</p>
            </div>

            <div className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all cursor-pointer">
              <div className="text-3xl mb-2">📱</div>
              <h3 className="font-bold text-gray-900 mb-2">Mobil Uygulama</h3>
              <p className="text-sm text-gray-600">Expo, randevu, push bildirimleri</p>
            </div>

            <div className="p-6 border border-gray-200 rounded-lg hover:border-blue-600 hover:shadow-lg transition-all cursor-pointer">
              <div className="text-3xl mb-2">🔌</div>
              <h3 className="font-bold text-gray-900 mb-2">Entegrasyonlar</h3>
              <p className="text-sm text-gray-600">Netgsm, Iyzico, e-Arşiv, e-Nabız</p>
            </div>
          </div>
        </div>

        {/* Documentation */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg shadow-lg p-8 mb-16">
          <h2 className="text-3xl font-bold mb-8">📚 Dokümantasyon</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-xl font-bold mb-4">🚀 Başlangıç</h3>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/setup" className="hover:underline">
                    ⚙️ Setup Sihirbazı
                  </Link>
                </li>
                <li>
                  <a href="./GETTING_STARTED.md" className="hover:underline">
                    🚀 10 Dakikalık Quick Start
                  </a>
                </li>
                <li>
                  <a href="./IMPLEMENTATION_CHECKLIST.md" className="hover:underline">
                    ✅ Setup Kontrol Listesi
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-xl font-bold mb-4">📖 Referans</h3>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/features" className="hover:underline">
                    ✨ Özellikler Kataloğu
                  </Link>
                </li>
                <li>
                  <a href="./QUICK_REFERENCE.md" className="hover:underline">
                    ⚡ Hızlı Referans Kartı
                  </a>
                </li>
                <li>
                  <a href="./FEATURES.md" className="hover:underline">
                    📊 Tam Özellikler Listesi
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-xl font-bold mb-4">⚙️ Teknik</h3>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href="./DATABASE_SETUP.md" className="hover:underline">
                    🗄️ Veritabanı Seçenekleri
                  </a>
                </li>
                <li>
                  <a href="./DEPLOYMENT.md" className="hover:underline">
                    🚀 Production Deployment
                  </a>
                </li>
                <li>
                  <a href="./README.md" className="hover:underline">
                    📘 Proje README
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-xl font-bold mb-4">🔗 Dış Bağlantılar</h3>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href="https://github.com/zekeriyaalpyildiran-art/dentos" className="hover:underline" target="_blank" rel="noopener noreferrer">
                    🐙 GitHub Repository
                  </a>
                </li>
                <li>
                  <a href="https://supabase.com/dashboard" className="hover:underline" target="_blank" rel="noopener noreferrer">
                    ☁️ Supabase Dashboard
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="text-center py-8">
          <p className="text-gray-600 mb-4">Hala başlamadın mı?</p>
          <Link
            href="/setup"
            className="inline-block px-8 py-4 bg-blue-600 text-white rounded-lg text-lg font-semibold hover:bg-blue-700 transition-all transform hover:scale-105"
          >
            🚀 Kuruluma Başla
          </Link>
        </div>
      </div>
    </div>
  );
}
