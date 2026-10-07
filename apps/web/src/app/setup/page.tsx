'use client';

import { useState } from 'react';
import Link from 'next/link';

interface SetupStep {
  step: string;
  status: 'success' | 'error' | 'warning';
  message: string;
  timestamp: string;
}

interface SetupResult {
  success: boolean;
  message: string;
  steps: SetupStep[];
  summary?: {
    totalSteps: number;
    successCount: number;
    warningCount: number;
  };
  error?: string;
}

export default function SetupPage() {
  const [loading, setLoading] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [setupStarted, setSetupStarted] = useState(false);

  const handleAutoSetup = async () => {
    setLoading(true);
    setSetupStarted(true);
    setResult(null);

    try {
      const response = await fetch('/api/setup/auto-init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();
      setResult(data);
      setCompleted(data.success);
    } catch (error) {
      setResult({
        success: false,
        message: 'Kurulum başarısız',
        error: error instanceof Error ? error.message : 'Bilinmeyen hata',
        steps: [
          {
            step: 'error',
            status: 'error',
            message: error instanceof Error ? error.message : 'Bilinmeyen hata',
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="text-6xl mb-4 animate-bounce">🦷</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">DentOS Kurulum</h1>
          <p className="text-lg text-gray-600">8 Sprint - Türkçe Diş Kliniği Yönetim Sistemi</p>
        </div>

        {/* Main Setup Box */}
        {!setupStarted ? (
          <div className="bg-white rounded-lg shadow-lg p-12 text-center mb-8">
            <div className="mb-8">
              <div className="text-5xl mb-4">⚡</div>
              <h2 className="text-3xl font-bold mb-4 text-gray-900">
                Otomatik Kurulum
              </h2>
              <p className="text-lg text-gray-600 mb-6">
                Tek tıkla tüm database, tabloları ve test verilerini otomatik olarak oluştur
              </p>
              <div className="space-y-2 text-left max-w-md mx-auto mb-8">
                <div className="flex items-center gap-3 text-gray-700">
                  <span className="text-green-500 text-xl">✓</span>
                  <span>Database migrasyonlarını otomatik uygula</span>
                </div>
                <div className="flex items-center gap-3 text-gray-700">
                  <span className="text-green-500 text-xl">✓</span>
                  <span>Test klinik verisi oluştur</span>
                </div>
                <div className="flex items-center gap-3 text-gray-700">
                  <span className="text-green-500 text-xl">✓</span>
                  <span>3 doktor ve 3 hasta ekle</span>
                </div>
                <div className="flex items-center gap-3 text-gray-700">
                  <span className="text-green-500 text-xl">✓</span>
                  <span>İşlem prosedürleri ve randevuları yükle</span>
                </div>
              </div>
            </div>

            <button
              onClick={handleAutoSetup}
              disabled={loading}
              className={`px-8 py-4 rounded-lg font-semibold text-lg text-white transition-all ${
                loading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
              }`}
            >
              {loading ? (
                <span className="flex items-center gap-2 justify-center">
                  <span className="animate-spin">⏳</span>
                  Kurulum yapılıyor...
                </span>
              ) : (
                '🚀 Otomatik Kurulum Başlat'
              )}
            </button>

            <p className="text-sm text-gray-500 mt-6">
              Kurulum 1-2 dakika sürebilir
            </p>
          </div>
        ) : null}

        {/* Progress Steps */}
        {setupStarted && result && (
          <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
            <h3 className="text-2xl font-bold mb-6 text-gray-900">
              {loading ? '⏳ Kurulum Yapılıyor...' : completed ? '✅ Kurulum Tamamlandı!' : '❌ Kurulum Başarısız'}
            </h3>

            <div className="space-y-3 max-h-96 overflow-y-auto mb-6">
              {result.steps?.map((step, index) => (
                <div
                  key={index}
                  className={`flex items-start gap-3 p-3 rounded-lg ${
                    step.status === 'success'
                      ? 'bg-green-50'
                      : step.status === 'error'
                      ? 'bg-red-50'
                      : 'bg-yellow-50'
                  }`}
                >
                  <span className="text-xl flex-shrink-0 mt-0.5">
                    {step.status === 'success'
                      ? '✅'
                      : step.status === 'error'
                      ? '❌'
                      : '⚠️'}
                  </span>
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">{step.step}</p>
                    <p className="text-sm text-gray-600">{step.message}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(step.timestamp).toLocaleTimeString('tr-TR')}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {result.summary && (
              <div className="bg-blue-50 rounded-lg p-4 mb-6">
                <h4 className="font-semibold text-gray-900 mb-3">📊 Özet</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">
                      {result.summary.successCount}
                    </div>
                    <div className="text-sm text-gray-600">Başarılı</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-yellow-600">
                      {result.summary.warningCount}
                    </div>
                    <div className="text-sm text-gray-600">Uyarı</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">
                      {result.summary.successCount + result.summary.warningCount}
                    </div>
                    <div className="text-sm text-gray-600">Toplam</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Success Message & Next Steps */}
        {completed && (
          <div className="space-y-6">
            <div className="bg-green-50 border-2 border-green-200 rounded-lg p-6">
              <h3 className="text-2xl font-bold text-green-700 mb-3">
                🎉 Tebrikler! DentOS hazır
              </h3>
              <p className="text-green-700 mb-4">
                Tüm kurulum adımları başarıyla tamamlandı. Şimdi sistemi keşfetmeye başlayabilirsiniz.
              </p>
            </div>

            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-bold mb-4 text-gray-900">⏭️ Sırada Ne Var?</h3>
              <div className="space-y-3">
                <a
                  href="/login"
                  className="flex items-center gap-3 p-4 bg-blue-50 hover:bg-blue-100 rounded-lg transition-all"
                >
                  <span className="text-2xl">🔐</span>
                  <div>
                    <div className="font-semibold text-gray-900">Giriş Yap</div>
                    <div className="text-sm text-gray-600">
                      admin@klinikmerkezi.com.tr hesabı ile giriş yap
                    </div>
                  </div>
                </a>

                <a
                  href="/dashboard"
                  className="flex items-center gap-3 p-4 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-all"
                >
                  <span className="text-2xl">📊</span>
                  <div>
                    <div className="font-semibold text-gray-900">Dashboard</div>
                    <div className="text-sm text-gray-600">
                      Tüm özellikleri görmek için dashboard'u aç
                    </div>
                  </div>
                </a>

                <Link
                  href="/"
                  className="flex items-center gap-3 p-4 bg-purple-50 hover:bg-purple-100 rounded-lg transition-all"
                >
                  <span className="text-2xl">🏠</span>
                  <div>
                    <div className="font-semibold text-gray-900">Ana Sayfa</div>
                    <div className="text-sm text-gray-600">
                      Projeyi keşfet ve özellikleri öğren
                    </div>
                  </div>
                </Link>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
              <h4 className="font-semibold text-gray-900 mb-2">📝 Harita</h4>
              <ul className="space-y-2 text-sm text-gray-700">
                <li>
                  <strong>📅 Randevular:</strong> Hasta randevu takibi ve yönetimi
                </li>
                <li>
                  <strong>👥 Hastalar:</strong> Hasta profilleri ve tıbbi geçmiş
                </li>
                <li>
                  <strong>💰 Tedavi Planları:</strong> Taksitli ödeme planları
                </li>
                <li>
                  <strong>🎯 CRM Kanban:</strong> Potansiyel müşterileri takip et
                </li>
                <li>
                  <strong>📦 Envanter:</strong> Tıbbi malzemeleri yönet
                </li>
                <li>
                  <strong>🧪 Lab Siparişleri:</strong> Protez ve laboratuvar işleri
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Error Message */}
        {result && !completed && (
          <div className="bg-red-50 border-2 border-red-200 rounded-lg p-6 mb-6">
            <h3 className="text-2xl font-bold text-red-700 mb-3">
              ❌ Kurulum Başarısız
            </h3>
            <p className="text-red-700 mb-4">{result.error || result.message}</p>
            <button
              onClick={() => {
                setSetupStarted(false);
                setResult(null);
              }}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-all"
            >
              🔄 Yeniden Dene
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
