'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function SetupPage() {
  const [activeTab, setActiveTab] = useState<'quick' | 'docker' | 'supabase'>('quick');

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="text-6xl mb-4 animate-bounce">🦷</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">DentOS Kurulum</h1>
          <p className="text-lg text-gray-600">8 Sprint - Türkçe Diş Kliniği Yönetim Sistemi</p>
        </div>

        {/* Tab Selection */}
        <div className="bg-white rounded-lg shadow-lg mb-8 overflow-hidden">
          <div className="flex border-b">
            <button
              onClick={() => setActiveTab('quick')}
              className={`flex-1 py-4 px-6 font-semibold transition-all ${
                activeTab === 'quick'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
              }`}
            >
              ⚡ Hızlı Start (Demo)
            </button>
            <button
              onClick={() => setActiveTab('docker')}
              className={`flex-1 py-4 px-6 font-semibold transition-all ${
                activeTab === 'docker'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
              }`}
            >
              🐳 Docker Setup
            </button>
            <button
              onClick={() => setActiveTab('supabase')}
              className={`flex-1 py-4 px-6 font-semibold transition-all ${
                activeTab === 'supabase'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
              }`}
            >
              ☁️ Supabase Setup
            </button>
          </div>

          {/* Quick Start Tab */}
          {activeTab === 'quick' && (
            <div className="p-8">
              <h2 className="text-2xl font-bold mb-4 text-gray-900">⚡ Hızlı Start - Demo Mode</h2>
              <p className="text-gray-600 mb-6">
                DentOS'u hemen deneyim çalıştırabilirsiniz. Demo modu test verileri ile önceden yüklüdür.
              </p>

              <div className="space-y-4 mb-8">
                <div className="bg-green-50 border-l-4 border-green-500 p-4">
                  <h3 className="font-semibold text-gray-900 mb-2">✅ Hangi özellikler çalışır?</h3>
                  <ul className="space-y-1 text-gray-700 text-sm">
                    <li>✓ Dashboard ve tüm menüler</li>
                    <li>✓ Randevu takibi (3 test randevu)</li>
                    <li>✓ Hasta yönetimi (3 test hasta)</li>
                    <li>✓ Doktor ve işlem prosedürleri</li>
                    <li>✓ CRM Kanban tahtası</li>
                    <li>✓ Envanter ve Lab siparişleri</li>
                  </ul>
                </div>

                <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4">
                  <h3 className="font-semibold text-gray-900 mb-2">⚠️ Hangi özellikler çalışmaz?</h3>
                  <ul className="space-y-1 text-gray-700 text-sm">
                    <li>✗ Yeni hasta/doktor ekleme (database olmadan)</li>
                    <li>✗ Gerçek SMS gönderimi (Netgsm)</li>
                    <li>✗ Gerçek ödeme işlemi (Iyzico)</li>
                  </ul>
                </div>
              </div>

              <div className="space-y-3 mb-8">
                <Link
                  href="/dashboard"
                  className="block w-full p-4 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-all text-center"
                >
                  🚀 Dashboard'u Aç (Demo Verileriyle)
                </Link>

                <Link
                  href="/login"
                  className="block w-full p-4 bg-gray-600 text-white rounded-lg font-semibold hover:bg-gray-700 transition-all text-center"
                >
                  🔐 Login Sayfasını Aç
                </Link>
              </div>

              <p className="text-sm text-gray-500 text-center">
                Gerçek veritabanı için Docker veya Supabase kurulumunu seçin ↑
              </p>
            </div>
          )}

          {/* Docker Tab */}
          {activeTab === 'docker' && (
            <div className="p-8">
              <h2 className="text-2xl font-bold mb-4 text-gray-900">🐳 Docker ile Kurulum</h2>
              <p className="text-gray-600 mb-6">
                Lokal PostgreSQL ve Redis ile tam özellikli kurulum (En Kolay Seçenek)
              </p>

              <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
                <h3 className="font-semibold text-gray-900 mb-2">✅ Avantajları:</h3>
                <ul className="space-y-1 text-gray-700 text-sm">
                  <li>✓ Hiç internete bağlı değil (Offline çalışır)</li>
                  <li>✓ Hızlı ve güvenli</li>
                  <li>✓ Geliştirme için ideal</li>
                  <li>✓ Docker'ı kaldırırsan veritabanı sıfırlanır</li>
                </ul>
              </div>

              <div className="bg-white border border-gray-300 rounded-lg p-6 mb-6 font-mono text-sm space-y-3">
                <div>
                  <p className="text-gray-500 mb-2">1. Docker'ı başlat:</p>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
                    <code>docker-compose up -d</code>
                  </div>
                </div>

                <div>
                  <p className="text-gray-500 mb-2">2. Migrasyonları çalıştır (otomatik olur):</p>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
                    <code>sleep 10  # Docker başlamasını bekle</code>
                  </div>
                </div>

                <div>
                  <p className="text-gray-500 mb-2">3. Web uygulamasını başlat:</p>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
                    <code>pnpm -F web dev</code>
                  </div>
                </div>

                <div>
                  <p className="text-gray-500 mb-2">4. Test verilerini yükle:</p>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
                    <code>curl -X POST http://localhost:3000/api/seed</code>
                  </div>
                </div>

                <div>
                  <p className="text-gray-500 mb-2">5. Tarayıcıda açhttp://localhost:3000</p>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
                    <code>http://localhost:3000</code>
                  </div>
                </div>
              </div>

              <p className="text-sm text-gray-600 bg-gray-50 p-4 rounded-lg">
                <strong>Not:</strong> Docker masalüstü uygulamasının yüklü ve çalışıyor olması gerekir.
                <a
                  href="https://www.docker.com/products/docker-desktop"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline ml-1"
                >
                  Docker Desktop indir →
                </a>
              </p>
            </div>
          )}

          {/* Supabase Tab */}
          {activeTab === 'supabase' && (
            <div className="p-8">
              <h2 className="text-2xl font-bold mb-4 text-gray-900">☁️ Supabase Cloud Setup</h2>
              <p className="text-gray-600 mb-6">
                Prodüksiyona hazır bulut çözümü (Tim ile çalışmak için ideal)
              </p>

              <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
                <h3 className="font-semibold text-gray-900 mb-2">✅ Avantajları:</h3>
                <ul className="space-y-1 text-gray-700 text-sm">
                  <li>✓ Bulut tabanlı (Her yerden erişilebilir)</li>
                  <li>✓ Ekip ile işbirliği kolay</li>
                  <li>✓ Otomatik yedekleme</li>
                  <li>✓ Production'a kolay geçiş</li>
                </ul>
              </div>

              <div className="space-y-4 mb-8">
                <div className="bg-white border border-gray-300 rounded-lg p-6">
                  <h3 className="font-semibold text-gray-900 mb-3">Adım 1: Supabase Projesi Oluştur</h3>
                  <ol className="list-decimal list-inside space-y-2 text-gray-700 text-sm mb-4">
                    <li>
                      <a
                        href="https://supabase.com/dashboard"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        supabase.com/dashboard
                      </a>
                      {'  '}adresine git
                    </li>
                    <li>Yeni bir proje oluştur</li>
                    <li>Proje URL'si ve Anon Key'i kopyala</li>
                  </ol>

                  <div className="bg-gray-50 p-4 rounded border border-gray-300">
                    <p className="text-xs text-gray-600 mb-2">
                      <strong>apps/web/.env.local dosyasında şunları ekle:</strong>
                    </p>
                    <div className="bg-gray-900 text-gray-100 p-3 rounded font-mono text-xs overflow-x-auto">
                      <code>
                        NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
                        <br />
                        NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
                      </code>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-gray-300 rounded-lg p-6">
                  <h3 className="font-semibold text-gray-900 mb-3">Adım 2: Veritabanı Tablolarını Oluştur</h3>
                  <ol className="list-decimal list-inside space-y-2 text-gray-700 text-sm mb-4">
                    <li>Supabase Dashboardda "SQL Editor" açhttp://</li>
                    <li>
                      <code className="bg-gray-100 px-2 py-1 rounded text-xs">
                        packages/db/migrations/
                      </code>
                      {'  '}klasöründeki SQL dosyalarını açhttp://
                    </li>
                    <li>Dosyaları sırayla Supabase'e yapıştır ve çalıştırhttp://</li>
                    <li>
                      Başlangıç sırası:
                      <ul className="list-disc list-inside ml-4 mt-2 text-xs">
                        <li>0001_init.sql</li>
                        <li>0002_procedures_catalog.sql</li>
                        <li>0003_patients.sql</li>
                        <li>... (0010'a kadar devam ethttp://)</li>
                      </ul>
                    </li>
                  </ol>

                  <p className="text-xs text-gray-600 bg-yellow-50 p-3 rounded">
                    ⏱️ <strong>İpucu:</strong> Her migration 30 saniye kadar sürebilir
                  </p>
                </div>

                <div className="bg-white border border-gray-300 rounded-lg p-6">
                  <h3 className="font-semibold text-gray-900 mb-3">Adım 3: Test Verilerini Yükle</h3>
                  <p className="text-gray-700 text-sm mb-3">Migrations bitince şu komutu çalıştırhttp://:</p>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded font-mono text-sm overflow-x-auto">
                    <code>curl -X POST http://localhost:3000/api/seed</code>
                  </div>
                </div>
              </div>

              <p className="text-sm text-gray-600 bg-gray-50 p-4 rounded-lg">
                <strong>Not:</strong> İlk kez olduğu için biraz zaman alabilir. Tüm stepsları bitirip
                tarayıcı başladıktan sonra Supabase tabloları ve veriler otomatik oluşturulacak.
              </p>
            </div>
          )}
        </div>

        {/* Quick Links */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-8">
          <h3 className="text-lg font-semibold mb-4 text-gray-900">🔗 Hızlı Linkler</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <a
              href="/dashboard"
              className="flex items-center gap-3 p-4 bg-blue-50 hover:bg-blue-100 rounded-lg transition-all"
            >
              <span className="text-2xl">📊</span>
              <div>
                <div className="font-semibold text-gray-900">Dashboard</div>
                <div className="text-sm text-gray-600">Demo verilerle başla</div>
              </div>
            </a>

            <a
              href="/login"
              className="flex items-center gap-3 p-4 bg-green-50 hover:bg-green-100 rounded-lg transition-all"
            >
              <span className="text-2xl">🔐</span>
              <div>
                <div className="font-semibold text-gray-900">Login</div>
                <div className="text-sm text-gray-600">Giriş sayfasını aç</div>
              </div>
            </a>

            <a
              href="https://github.com/zekeriyaalpyildiran-art/dentos"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-purple-50 hover:bg-purple-100 rounded-lg transition-all"
            >
              <span className="text-2xl">🐙</span>
              <div>
                <div className="font-semibold text-gray-900">GitHub</div>
                <div className="text-sm text-gray-600">Kaynak kodunu görüntüle</div>
              </div>
            </a>

            <a
              href="https://supabase.com/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-all"
            >
              <span className="text-2xl">☁️</span>
              <div>
                <div className="font-semibold text-gray-900">Supabase</div>
                <div className="text-sm text-gray-600">Cloud console</div>
              </div>
            </a>
          </div>
        </div>

        {/* Documentation */}
        <div className="bg-gradient-to-r from-green-50 to-blue-50 rounded-lg shadow-lg p-6">
          <h3 className="text-lg font-semibold mb-4 text-gray-900">📚 Dokümantasyon</h3>
          <div className="space-y-2 text-sm">
            <p className="text-gray-700">
              Detaylı kurulum ve deployment rehberleri için git reposundaki dosyaları oku:
            </p>
            <ul className="space-y-1 text-gray-700">
              <li>
                <code className="bg-white px-2 py-1 rounded">GETTING_STARTED.md</code> - 10 dakikalık quick start
              </li>
              <li>
                <code className="bg-white px-2 py-1 rounded">DATABASE_SETUP.md</code> - Veritabanı seçenekleri
              </li>
              <li>
                <code className="bg-white px-2 py-1 rounded">DEPLOYMENT.md</code> - Production deployment
              </li>
              <li>
                <code className="bg-white px-2 py-1 rounded">README.md</code> - Proje özeti ve mimarisı
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
