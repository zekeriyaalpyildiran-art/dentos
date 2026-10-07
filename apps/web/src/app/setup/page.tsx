'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function SetupPage() {
  const [activeStep, setActiveStep] = useState<number>(1);
  const [completed, setCompleted] = useState<boolean[]>([false, false, false, false]);

  const steps = [
    {
      number: 1,
      title: 'Supabase SQL Editor ile Database Oluşturma',
      description: 'Tüm tabloları Supabase console\'dan oluştur',
      instructions: [
        'https://supabase.com/dashboard/project/knzrcgqpzjbajfboqlhq adresine git',
        'Sol menüden "SQL Editor" seçeneğini aç',
        'Sol üstte "New Query" butonuna tıkla',
        'Aşağıdaki migration dosyalarını sırayla kopyala-yapıştır ve çalıştır:',
        '  1. packages/db/migrations/0001_init.sql',
        '  2. packages/db/migrations/0002_procedures_catalog.sql',
        '  3. packages/db/migrations/0003_patients.sql',
        '  4. packages/db/migrations/0004_appointments.sql',
        '  5. packages/db/migrations/0005_notifications.sql',
        '  6. packages/db/migrations/0006_device_tokens.sql',
        '  7. packages/db/migrations/0007_treatment_plans.sql',
        '  8. packages/db/migrations/0008_crm_leads.sql',
        '  9. packages/db/migrations/0009_lab_orders.sql',
        '  10. packages/db/migrations/0010_compliance.sql',
        'Her migration için "RUN" butonuna tıkla ve başarılı olmasını bekle',
      ],
      estimatedTime: '5-10 dakika',
    },
    {
      number: 2,
      title: 'Test Verilerini Yükleme',
      description: 'Örnek hasta, doktor ve randevu verilerini ekle',
      instructions: [
        'Terminal\'de şu komutu çalıştır:',
        'curl -X POST http://localhost:3000/api/seed',
        'Başarı mesajı alınması bekle',
        'Veya tarayıcıda bu URL\'yi ziyaret et:',
        'http://localhost:3000/api/seed',
      ],
      estimatedTime: '1 dakika',
    },
    {
      number: 3,
      title: 'Authentication Test',
      description: 'Giriş sayfasını test et',
      instructions: [
        'http://localhost:3000/login adresine git',
        'Test kullanıcısı bilgileri:',
        '  Email: admin@klinikmerkezi.com.tr',
        '  (SMS OTP ile doğrulama yapılır)',
        'Supabase Auth → Users kısmından OTP kodu görülebilir',
      ],
      estimatedTime: '2 dakika',
    },
    {
      number: 4,
      title: 'Dashboard\'u Test Etme',
      description: 'Tüm özellikleri göz at',
      instructions: [
        'Giriş yaptıktan sonra /dashboard adresine yönlendirileceksin',
        'Sol menüden bölümler arasında gezin:',
        '  - 📅 Randevular',
        '  - 👥 Hastalar',
        '  - 💰 Tedavi Planları',
        '  - 🎯 CRM Kanban',
        '  - 📦 Envanter',
        '  - 🧪 Lab Siparişleri',
        '  - 📊 Uyum Raporları',
        'Tüm sayfalar veritabanı bağlantısı olmadan demo verilerle çalışır',
      ],
      estimatedTime: '5 dakika',
    },
  ];

  const toggleComplete = (index: number) => {
    const newCompleted = [...completed];
    newCompleted[index] = !newCompleted[index];
    setCompleted(newCompleted);
  };

  const completedCount = completed.filter(Boolean).length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="text-4xl mb-4">🦷</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">DentOS Kurulum</h1>
          <p className="text-lg text-gray-600">8 Sprint - Türkçe Diş Kliniği Yönetim Sistemi</p>
        </div>

        {/* Progress */}
        <div className="mb-12">
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900">Kurulum İlerlemesi</h2>
            <div className="flex items-center justify-between">
              {[1, 2, 3, 4].map((step) => (
                <div key={step} className="flex flex-col items-center flex-1">
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg mb-2 ${
                      completed[step - 1]
                        ? 'bg-green-500 text-white'
                        : activeStep === step
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 text-gray-700'
                    }`}
                  >
                    {completed[step - 1] ? '✓' : step}
                  </div>
                  <span className="text-xs text-center text-gray-700">Adım {step}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 text-center">
              <p className="text-sm text-gray-600">
                {completedCount} / 4 adım tamamlandı ({Math.round((completedCount / 4) * 100)}%)
              </p>
              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all"
                  style={{ width: `${(completedCount / 4) * 100}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-6 mb-12">
          {steps.map((step, index) => (
            <div
              key={step.number}
              className={`bg-white rounded-lg shadow transition-all ${
                activeStep === step.number ? 'ring-2 ring-blue-600' : ''
              }`}
            >
              <div
                onClick={() => setActiveStep(step.number)}
                className="p-6 cursor-pointer hover:bg-gray-50"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="inline-flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-600 rounded-full font-semibold text-sm">
                        {step.number}
                      </span>
                      <h3 className="text-xl font-semibold text-gray-900">{step.title}</h3>
                    </div>
                    <p className="text-gray-600 ml-11 mb-2">{step.description}</p>
                    <p className="text-sm text-gray-500 ml-11">⏱️ Tahmini süre: {step.estimatedTime}</p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleComplete(index);
                    }}
                    className={`ml-4 px-4 py-2 rounded-lg font-medium transition-all ${
                      completed[index]
                        ? 'bg-green-100 text-green-700 hover:bg-green-200'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {completed[index] ? '✓ Tamamlandı' : 'Tamamla'}
                  </button>
                </div>

                {/* Instructions - Show when active or completed */}
                {(activeStep === step.number || completed[index]) && (
                  <div className="mt-6 ml-11 pt-6 border-t border-gray-200">
                    <div className="space-y-2">
                      {step.instructions.map((instruction, i) => (
                        <div
                          key={i}
                          className="flex gap-3 text-sm text-gray-700"
                        >
                          {instruction.startsWith('http') ? (
                            <>
                              <span className="text-blue-600 flex-shrink-0">🔗</span>
                              <a
                                href={instruction}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline break-all"
                              >
                                {instruction}
                              </a>
                            </>
                          ) : instruction.startsWith('curl') || instruction.startsWith('packages/db') || instruction.startsWith('http') ? (
                            <>
                              <span className="text-gray-400 flex-shrink-0 font-mono">$</span>
                              <code className="bg-gray-100 px-2 py-1 rounded font-mono text-xs break-all">
                                {instruction}
                              </code>
                            </>
                          ) : instruction.startsWith('  ') ? (
                            <>
                              <span className="w-0"></span>
                              <span className="ml-6">{instruction.trim()}</span>
                            </>
                          ) : (
                            <>
                              <span className="text-blue-600">•</span>
                              <span>{instruction}</span>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Quick Links */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h3 className="text-lg font-semibold mb-4 text-gray-900">Hızlı Linkler</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <a
              href="https://supabase.com/dashboard/project/knzrcgqpzjbajfboqlhq"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 bg-blue-50 hover:bg-blue-100 rounded-lg transition-all"
            >
              <span className="text-2xl">🔑</span>
              <div>
                <div className="font-semibold text-gray-900">Supabase Dashboard</div>
                <div className="text-sm text-gray-600">SQL Editor ve tabloları yönet</div>
              </div>
            </a>
            <a
              href="http://localhost:3000/api/seed"
              className="flex items-center gap-3 p-4 bg-green-50 hover:bg-green-100 rounded-lg transition-all"
            >
              <span className="text-2xl">🌱</span>
              <div>
                <div className="font-semibold text-gray-900">Seed Data API</div>
                <div className="text-sm text-gray-600">Test verilerini yükle</div>
              </div>
            </a>
            <Link
              href="/test-connection"
              className="flex items-center gap-3 p-4 bg-purple-50 hover:bg-purple-100 rounded-lg transition-all"
            >
              <span className="text-2xl">🔌</span>
              <div>
                <div className="font-semibold text-gray-900">Connection Test</div>
                <div className="text-sm text-gray-600">Supabase bağlantısını test et</div>
              </div>
            </Link>
            <Link
              href="/login"
              className="flex items-center gap-3 p-4 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-all"
            >
              <span className="text-2xl">🔐</span>
              <div>
                <div className="font-semibold text-gray-900">Giriş Sayfası</div>
                <div className="text-sm text-gray-600">Giriş yap ve deneme yap</div>
              </div>
            </Link>
          </div>
        </div>

        {/* Info Box */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <div className="flex gap-4">
            <span className="text-2xl flex-shrink-0">ℹ️</span>
            <div>
              <h4 className="font-semibold text-gray-900 mb-2">Bilgi</h4>
              <p className="text-sm text-gray-700 mb-2">
                Supabase veritabanı server'ına doğrudan bağlantı sorunu nedeniyle migrasyonları Supabase console\'dan manuel çalıştırmanız gereklidir.
              </p>
              <p className="text-sm text-gray-700">
                Alternatif olarak Docker PostgreSQL kullanarak yerel geliştirme yapabilirsiniz. Detaylar için <code className="bg-white px-1 rounded">DATABASE_SETUP.md</code> dosyasına bakın.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
